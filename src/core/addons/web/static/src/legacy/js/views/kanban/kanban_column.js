verp.define('web.KanbanColumn', function (require) {
"use strict";

var config = require('web.config');
var core = require('web.core');
var session = require('web.session');
var Dialog = require('web.Dialog');
var KanbanRecord = require('web.KanbanRecord');
var RecordQuickCreate = require('web.kanbanRecordQuickCreate');
var viewDialogs = require('web.viewDialogs');
var viewUtils = require('web.viewUtils');
var Widget = require('web.Widget');
var KanbanColumnProgressBar = require('web.KanbanColumnProgressBar');

var _t = core._t;
var QWeb = core.qweb;

var KanbanColumn = Widget.extend({
    template: 'KanbanView.Group',
    customEvents: {
        cancelQuickCreate: '_onCancelQuickCreate',
        quickCreateAddRecord: '_onQuickCreateAddRecord',
        tweakColumn: '_onTweakColumn',
        tweakColumnRecords: '_onTweakColumnRecords',
    },
    events: {
        'click .o-column-edit': '_onEditColumn',
        'click .o-column-delete': '_ondeleteColumn',
        'click .o-kanban-quick-add': '_onAddQuickCreate',
        'click .o-kanban-load-more': '_onLoadMore',
        'click .o-kanban-toggle-fold': '_onToggleFold',
        'click .o-column-archive-records': '_onArchiveRecords',
        'click .o-column-unarchive-records': '_onUnarchiveRecords',
        'click .o-kanban-config .dropdown-menu': '_onConfigDropdownClicked',
    },
    /**
     * @override
     */
    init: function (parent, data, options, recordOptions) {
        this._super(parent);
        this.dbId = data.id;
        this.dataRecords = data.data;
        this.data = data;

        var value = data.value;
        this.id = data.resId;
        this.folded = !data.isOpen;
        this.hasActiveField = 'active' in data.fields;
        this.fields = data.fields;
        this.records = [];
        this.modelName = data.model;

        this.quickCreate = options.quickCreate;
        this.quickCreateView = options.quickCreateView;
        this.groupedBy = options.groupedBy;
        this.groupedByM2o = options.groupedByM2o;
        this.groupedByM2m = options.groupedByM2m;
        this.editable = options.editable;
        this.deletable = options.deletable;
        this.archivable = options.archivable;
        this.draggable = options.draggable;
        this.KanbanRecord = options.KanbanRecord || KanbanRecord; // the KanbanRecord class to use
        this.recordsEditable = options.recordsEditable;
        this.recordsDeletable = options.recordsDeletable;
        this.recordsDraggable = options.recordsDraggable;
        this.relation = options.relation;
        this.offset = 0;
        this.loadMoreCount = data.loadMoreCount;
        this.loadMoreOffset = data.loadMoreOffset;
        this.canBeFolded = this.folded;

        if (options.hasProgressBar) {
            this.barOptions = {
                columnID: this.dbId,
                progressBarStates: options.progressBarStates,
            };
        }

        this.recordOptions = _.clone(recordOptions);

        if (options.groupedByM2o || options.groupedByDate || options.groupedByM2m) {
            // For many2x and datetime, a false value means that the field is not set.
            this.title = value ? value : _t('Undefined');
        } else {
            // false and 0 might be valid values for these fields.
            this.title = value === undefined ? _t('Undefined') : value;
        }

        if (options.groupByTooltip) {
            this.tooltipInfo = _.compact(_.map(options.groupByTooltip, function (help, field) {
                help = help ? help + "</br>" : '';
                return (data.tooltipData && data.tooltipData[field] && "<div>" + help + data.tooltipData[field] + "</div>") || '';
            }));
            this.tooltipInfo = this.tooltipInfo.join("<div class='dropdown-divider' role='separator' />");
        }
    },
    /**
     * @override
     */
    start: function () {
        var self = this;
        var defs = [this._super.apply(this, arguments)];
        this.$header = this.$('.o-kanban-header');

        for (var i = 0; i < this.dataRecords.length; i++) {
            defs.push(this._addRecord(this.dataRecords[i]));
        }

        if (this.recordsDraggable) {
            this.$el.sortable({
                connectWith: '.o-kanban-group',
                containment: this.draggable ? false : 'parent',
                revert: 0,
                delay: 0,
                items: '> .o-kanban-record:not(.o-updating)',
                cursor: 'move',
                over: function () {
                    self.$el.addClass('o-kanban-hover');
                },
                out: function () {
                    self.$el.removeClass('o-kanban-hover');
                },
                start: function (event, ui) {
                    ui.item.addClass('o-currently-dragged');
                },
                stop: function (event, ui) {
                    var item = ui.item;
                    setTimeout(function () {
                        item.removeClass('o-currently-dragged');
                    });
                },
                update: function (event, ui) {
                    var record = ui.item.data('record');
                    var index = self.records.indexOf(record);
                    record.$el.removeAttr('style');  // jqueryui sortable add display:block inline
                    if (index >= 0) {
                        if ($.contains(self.$el[0], record.$el[0])) {
                            // resequencing records
                            self.triggerUp('kanbanColumnResequence', {ids: self._getIDs()});
                        }
                    } else {
                        // adding record to this column
                        ui.item.addClass('o-updating');
                        self.triggerUp('kanbanColumnAddRecord', {record: record, ids: self._getIDs()});
                    }
                }
            });
        }
        this.$el.click(function (event) {
            if (self.folded) {
                self._onToggleFold(event);
            }
        });
        if (this.barOptions) {
            this.$el.addClass('o-kanban-has-progressbar');
            this.progressBar = new KanbanColumnProgressBar(this, this.barOptions, this.data);
            defs.push(this.progressBar.appendTo(this.$header));
        }

        var title = this.folded ? this.title + ' (' + this.data.count + ')' : this.title;
        this.$header.find('.o-column-title').text(title);

        this.$el.toggleClass('o-column-folded', this.canBeFolded);
        if (this.tooltipInfo) {
            this.$header.find('.o-kanban-header-title').tooltip({}).attr('data-original-title', this.tooltipInfo);
        }
        if (!this.loadMoreCount) {
            this.$('.o-kanban-load-more').remove();
        } else {
            this.$('.o-kanban-load-more').html(QWeb.render('KanbanView.LoadMore', {widget: this}));
        }

        return Promise.all(defs);
    },
    /**
     * Called when a record has been quick created, as a new column is rendered
     * and appended into a fragment, before replacing the old column in the DOM.
     * When this happens, the quick create widget is inserted into the new
     * column directly, and it should be focused. However, as it is rendered
     * into a fragment, the focus has to be set manually once in the DOM.
     */
    onAttachCallback: function () {
        _.invoke(this.records, 'onAttachCallback');
        if (this.quickCreateWidget) {
            this.quickCreateWidget.onAttachCallback();
        }
    },

    //--------------------------------------------------------------------------
    // Public
    //--------------------------------------------------------------------------

    /**
     * Adds the quick create record to the top of the column.
     *
     * @returns {Promise}
     */
    addQuickCreate: async function () {
        if (this.folded) {
            // first open the column, and then add the quick create
            this.triggerUp('columnToggleFold', {
                openQuickCreate: true,
            });
            return;
        }

        if (this.quickCreateWidget) {
            return Promise.reject();
        }
        this.triggerUp('closeQuickCreate'); // close other quick create widgets
        var context = this.data.getContext();
        var groupByField = viewUtils.getGroupByField(this.groupedBy);
        context['default_' + groupByField] = viewUtils.getGroupValue(this.data, groupByField);
        this.quickCreateWidget = new RecordQuickCreate(this, {
            context: context,
            formViewRef: this.quickCreateView,
            model: this.modelName,
        });
        await this.quickCreateWidget.appendTo(document.createDocumentFragment());
        this.triggerUp('startQuickCreate');
        this.quickCreateWidget.$el.insertAfter(this.$header);
        this.quickCreateWidget.onAttachCallback();
    },
    /**
     * Closes the quick create widget if it isn't dirty.
     */
    cancelQuickCreate: function () {
        if (this.quickCreateWidget) {
            this.quickCreateWidget.cancel();
        }
    },
    /**
     * @returns {Boolean} true iff the column is empty
     */
    isEmpty: function () {
        return !this.records.length;
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * Adds a record in the column.
     *
     * @private
     * @param {Object} recordState
     * @param {Object} [options]
     * @param {string} [options.position]
     *        'before' to add at the top, add at the bottom by default
     * @return {Promise}
     */
    _addRecord: function (recordState, options) {
        if (this.groupedByM2m) {
            this.recordOptions.deletable = false;
        }
        var record = new this.KanbanRecord(this, recordState, this.recordOptions);
        this.records.push(record);
        if (options && options.position === 'before') {
            return record.insertAfter(this.quickCreateWidget ? this.quickCreateWidget.$el : this.$header);
        } else {
            var $loadMore = this.$('.o-kanban-load-more');
            if ($loadMore.length) {
                return record.insertBefore($loadMore);
            } else {
                return record.appendTo(this.$el);
            }
        }
    },
    /**
     * Destroys the QuickCreate widget.
     *
     * @private
     */
    _cancelQuickCreate: function () {
        this.quickCreateWidget.destroy();
        this.quickCreateWidget = undefined;
    },
    /**
     * @returns {integer[]} the resIds of the records in the column
     */
    _getIDs: function () {
        var ids = [];
        this.$('.o-kanban-record').each(function (index, r) {
            ids.push($(r).data('record').id);
        });
        return ids;
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * @private
     */
    _onAddQuickCreate: function () {
        this.triggerUp('addQuickCreate', { groupId: this.dbId });
    },
    /**
     * @private
     */
    _onCancelQuickCreate: function () {
        this._cancelQuickCreate();
    },
    /**
     * Prevent from closing the config dropdown when the user clicks on a
     * disabled item (e.g. 'Fold' in sample mode).
     *
     * @private
     */
    _onConfigDropdownClicked(ev) {
        ev.stopPropagation();
    },
    /**
     * @private
     * @param {MouseEvent} event
     */
    _ondeleteColumn: function (event) {
        event.preventDefault();
        var buttons = [
            {
                text: _t("Ok"),
                classes: 'btn-primary',
                close: true,
                click: this.triggerUp.bind(this, 'kanbanColumnDelete'),
            },
            {text: _t("Cancel"), close: true}
        ];
        new Dialog(this, {
            size: 'medium',
            buttons: buttons,
            $content: $('<div>', {
                text: _t("Are you sure that you want to remove this column ?")
            }),
        }).open();
    },
    /**
     * @private
     * @param {MouseEvent} event
     */
    _onEditColumn: function (event) {
        event.preventDefault();
        new viewDialogs.FormViewDialog(this, {
            resModel: this.relation,
            resId: this.id,
            context: session.userContext,
            title: _t("Edit Column"),
            onSaved: this.triggerUp.bind(this, 'reload'),
        }).open();
    },
    /**
     * @private
     * @param {MouseEvent} event
     */
    _onLoadMore: function (event) {
        event.preventDefault();
        this.triggerUp('kanbanLoadColumnRecords', { loadMoreOffset: this.loadMoreOffset });
    },
    /**
     * @private
     * @param {VerpEvent} event
     */
    _onQuickCreateAddRecord: function (event) {
        this.triggerUp('quickCreateRecord', event.data);
    },
    /**
     * @private
     * @param {MouseEvent} event
     */
    _onToggleFold: function (event) {
        event.preventDefault();
        this.triggerUp('columnToggleFold');
    },
    /**
     * @private
     * @param {VerpEvent} ev
     */
    _onTweakColumn: function (ev) {
        ev.data.callback(this.$el);
    },
    /**
     * @private
     * @param {VerpEvent} ev
     */
    _onTweakColumnRecords: function (ev) {
        _.each(this.records, function (record) {
            ev.data.callback(record.$el, record.state.data);
        });
    },
    /**
     * @private
     * @param {MouseEvent} event
     */
    _onArchiveRecords: function (event) {
        event.preventDefault();
        Dialog.confirm(this, _t("Are you sure that you want to archive all the records from this column?"), {
            confirmCallback: this.triggerUp.bind(this, 'kanbanColumnRecordsToggleActive', {
                archive: true,
            }),
        });
    },
    /**
     * @private
     * @param {MouseEvent} event
     */
    _onUnarchiveRecords: function (event) {
        event.preventDefault();
        this.triggerUp('kanbanColumnRecordsToggleActive', {
            archive: false,
        });
    }
});

return KanbanColumn;

});
