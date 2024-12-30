verp.define('web.KanbanController', function (require) {
"use strict";

/**
 * The KanbanController is the class that coordinates the kanban model and the
 * kanban renderer.  It also makes sure that update from the search view are
 * properly interpreted.
 */

var BasicController = require('web.BasicController');
var Context = require('web.Context');
var core = require('web.core');
var Dialog = require('web.Dialog');
var Domain = require('web.Domain');
var viewDialogs = require('web.viewDialogs');
var viewUtils = require('web.viewUtils');

var _t = core._t;
var qweb = core.qweb;

var KanbanController = BasicController.extend({
    buttonsTemplate: 'KanbanView.buttons',
    customEvents: _.extend({}, BasicController.prototype.customEvents, {
        addQuickCreate: '_onAddQuickCreate',
        quickCreateAddColumn: '_onAddColumn',
        quickCreateRecord: '_onQuickCreateRecord',
        resequenceColumns: '_onResequenceColumn',
        buttonclicked: '_onButtonClicked',
        kanbanRecordDelete: '_onRecordDelete',
        kanbanRecordUpdate: '_onupdateRecord',
        kanbanColumnDelete: '_ondeleteColumn',
        kanbanColumnAddRecord: '_onAddRecordToColumn',
        kanbanColumnResequence: '_onColumnResequence',
        kanbanLoadColumnRecords: '_onLoadColumnRecords',
        columnToggleFold: '_onToggleColumn',
        kanbanColumnRecordsToggleActive: '_onToggleActiveRecords',
    }),
    /**
     * @override
     * @param {Object} params
     * @param {boolean} params.quickCreateEnabled set to false to disable the
     *   quick create feature
     * @param {SearchPanel} [params.searchpanel]
     * @param {Array[]} [params.controlPanelDomain=[]] initial domain coming
     *   from the controlPanel
     */
    init: function (parent, model, renderer, params) {
        this._super.apply(this, arguments);
        this.onCreate = params.onCreate;
        this.hasButtons = params.hasButtons;
        this.quickCreateEnabled = params.quickCreateEnabled;
    },

    //--------------------------------------------------------------------------
    // Public
    //--------------------------------------------------------------------------

    /**
     * @param {jQuery} [$node]
     */
    renderButtons: function ($node) {
        if (!this.hasButtons || !this.isActionEnabled('create')) {
            return;
        }
        this.$buttons = $(qweb.render(this.buttonsTemplate, {
            btnClass: 'btn-primary',
            widget: this,
        }));
        this.$buttons.on('click', 'button.o-kanban-button-new', this._onButtonNew.bind(this));
        this.$buttons.on('keydown', this._onButtonsKeyDown.bind(this));
        if ($node) {
            this.$buttons.appendTo($node);
        }
    },
    /**
     * In grouped mode, set 'Create' button as btn-secondary if there is no column
     * (except if we can't create new columns)
     *
     * @override
     */
    updateButtons: function () {
        if (!this.$buttons) {
            return;
        }
        var state = this.model.get(this.handle, {raw: true});
        var createHidden = this.isActionEnabled('groupCreate') && state.isGroupedByM2ONoColumn;
        this.$buttons.find('.o-kanban-button-new').toggleClass('o-hidden', createHidden);
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * Displays the record quick create widget in the requested column, given its
     * id (in the first column by default). Ensures that we removed sample data
     * if any, before displaying the quick create.
     *
     * @private
     * @param {string} [groupId]
     */
    _addQuickCreate(groupId) {
        this._removeSampleData(async () => {
            await this.update({ shouldUpdateSearchComponents: false }, { reload: false });
            return this.renderer.addQuickCreate(groupId);
        });
    },
    /**
     * @override method comes from field manager mixin
     * @private
     * @param {string} id local id from the basic record data
     * @returns {Promise}
     */
    _confirmSave: function (id) {
        var data = this.model.get(this.handle, {raw: true});
        var grouped = data.groupedBy.length;
        if (grouped) {
            var columnState = this.model.getColumn(id);
            return this.renderer.updateColumn(columnState.id, columnState);
        }
        return this.renderer.updateRecord(this.model.get(id));
    },
    /**
     * Only display the pager in the ungrouped case, with data.
     *
     * @override
     * @private
     */
    _getPagingInfo: function (state) {
        if (!(state.count && !state.groupedBy.length)) {
            return null;
        }
        return this._super(...arguments);
    },
    /**
     * @private
     * @param {Widget} kanbanRecord
     * @param {Object} params
     */
    _reloadAfterButtonClick: function (kanbanRecord, params) {
        var self = this;
        var recordModel = this.model.localData[params.record.id];
        var group = this.model.localData[recordModel.parentId];
        var parent = this.model.localData[group.parentId];

        this.model.reload(params.record.id).then(function (dbId) {
            var data = self.model.get(dbId);
            kanbanRecord.update(data);

            // Check if we still need to display the record. Some fields of the domain are
            // not guaranteed to be in data. This is for example the case if the action
            // contains a domain on a field which is not in the Kanban view. Therefore,
            // we need to handle multiple cases based on 3 variables:
            // domInData: all domain fields are in the data
            // activeInDomain: 'active' is already in the domain
            // activeInData: 'active' is available in the data

            var domain = (parent ? parent.domain : group.domain) || [];
            var domInData = _.every(domain, function (d) {
                return d[0] in data.data;
            });
            var activeInDomain = _.pluck(domain, 0).indexOf('active') !== -1;
            var activeInData = 'active' in data.data;

            // Case # | domInData | activeInDomain | activeInData
            //   1    |   true    |      true      |      true     => no domain change
            //   2    |   true    |      true      |      false    => not possible
            //   3    |   true    |      false     |      true     => add active in domain
            //   4    |   true    |      false     |      false    => no domain change
            //   5    |   false   |      true      |      true     => no evaluation
            //   6    |   false   |      true      |      false    => no evaluation
            //   7    |   false   |      false     |      true     => replace domain
            //   8    |   false   |      false     |      false    => no evaluation

            // There are 3 cases which cannot be evaluated since we don't have all the
            // necessary information. The complete solution would be to perform a RPC in
            // these cases, but this is out of scope. A simpler one is to do a try / catch.

            if (domInData && !activeInDomain && activeInData) {
                domain = domain.concat([['active', '=', true]]);
            } else if (!domInData && !activeInDomain && activeInData) {
                domain = [['active', '=', true]];
            }
            try {
                var visible = new Domain(domain).compute(data.evalContext);
            } catch (e) {
                return;
            }
            if (!visible) {
                kanbanRecord.destroy();
            }
        });
    },
    /**
     * @param {number[]} ids
     * @private
     * @returns {Promise}
     */
    _resequenceColumns: function (ids) {
        var state = this.model.get(this.handle, {raw: true});
        var model = state.fields[state.groupedBy[0]].relation;
        return this.model.resequence(model, ids, this.handle);
    },
    /**
     * This method calls the server to ask for a resequence.  Note that this
     * does not rerender the user interface, because in most case, the
     * resequencing operation has already been displayed by the renderer.
     *
     * @private
     * @param {string} columnId
     * @param {string[]} ids
     * @returns {Promise}
     */
    _resequenceRecords: function (columnId, ids) {
        var self = this;
        return this.model.resequence(this.modelName, ids, columnId);
    },
    /**
     * @override
     */
    _shouldBounceOnClick(element) {
        const state = this.model.get(this.handle, {raw: true});
        if (!state.count || state.isSample) {
            const classesList = [
                'o-kanban-view',
                'o-kanban-group',
                'o-kanban-header',
                'o-column-quick-create',
                'o-view-nocontent-smiling-face',
            ];
            return classesList.some(c => element.classList.contains(c));
        }
        return false;
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * This handler is called when an event (from the quick create add column)
     * event bubbles up. When that happens, we need to ask the model to create
     * a group and to update the renderer
     *
     * @private
     * @param {VerpEvent} ev
     */
    _onAddColumn: function (ev) {
        var self = this;
        this.mutex.exec(function () {
            return self.model.createGroup(ev.data.value, self.handle).then(function () {
                var state = self.model.get(self.handle, {raw: true});
                var ids = _.pluck(state.data, 'resId').filter(_.isNumber);
                return self._resequenceColumns(ids);
            }).then(function () {
                return self.update({}, {reload: false});
            }).then(function () {
                let quickCreateFolded = self.renderer.quickCreate.folded;
                if (ev.data.foldQuickCreate ? !quickCreateFolded : quickCreateFolded) {
                    self.renderer.quickCreateToggleFold();
                }
                self.renderer.triggerUp("quickCreateColumnCreated");
            });
        });
    },
    /**
     * @private
     * @param {VerpEvent} ev
     */
    _onAddRecordToColumn: function (ev) {
        var self = this;
        var record = ev.data.record;
        var column = ev.target;
        this.alive(this.model.moveRecord(record.dbId, column.dbId, this.handle))
            .then(function (columnDbIds) {
                return self._resequenceRecords(column.dbId, ev.data.ids)
                    .then(function () {
                        _.each(columnDbIds, function (dbId) {
                            var data = self.model.get(dbId);
                            self.renderer.updateColumn(dbId, data);
                        });
                    });
            }).guardedCatch(this.reload.bind(this));
    },
    /**
     * @private
     * @param {VerpEvent} ev
     * @returns {string} ev.data.groupId
     */
    _onAddQuickCreate(ev) {
        ev.stopPropagation();
        this._addQuickCreate(ev.data.groupId);
    },
    /**
     * @private
     * @param {VerpEvent} ev
     */
    _onButtonClicked: function (ev) {
        var self = this;
        ev.stopPropagation();
        var attrs = ev.data.attrs;
        var record = ev.data.record;
        var def = Promise.resolve();
        if (attrs.context) {
            attrs.context = new Context(attrs.context)
                .setEvalContext({
                    activeId: record.resId,
                    activeIds: [record.resId],
                    activeModel: record.model,
                });
        }
        if (attrs.confirm) {
            def = new Promise(function (resolve, reject) {
                Dialog.confirm(this, attrs.confirm, {
                    confirmCallback: resolve,
                    cancelCallback: reject,
                }).on("closed", null, reject);
            });
        }
        def.then(function () {
            self.triggerUp('executeAction', {
                actionData: attrs,
                env: {
                    context: record.getContext(),
                    currentId: record.resId,
                    model: record.model,
                    resIds: record.resIds,
                },
                onClosed: self._reloadAfterButtonClick.bind(self, ev.target, ev.data),
            });
        });
    },
    /**
     * @private
     */
    _onButtonNew: function () {
        var state = this.model.get(this.handle, {raw: true});
        var quickCreateEnabled = this.quickCreateEnabled && viewUtils.isQuickCreateEnabled(state);
        if (this.onCreate === 'quickCreate' && quickCreateEnabled && state.data.length) {
            // activate the quick create in the first column when the mutex is
            // unlocked, to ensure that there is no pending re-rendering that
            // would remove it (e.g. if we are currently adding a new column)
            this.mutex.getUnlockedDef().then(this._addQuickCreate.bind(this, null));
        } else if (this.onCreate && this.onCreate !== 'quickCreate') {
            // Execute the given action
            this.doAction(this.onCreate, {
                onClose: this.reload.bind(this, {}),
                additionalContext: state.context,
            });
        } else {
            // Open the form view
            this.triggerUp('switchView', {
                viewType: 'form',
                resId: undefined
            });
        }
    },
    /**
     * Moves the focus from the controller buttons to the first kanban record
     *
     * @private
     * @param {jQueryEvent} ev
     */
    _onButtonsKeyDown: function (ev) {
        switch(ev.keyCode) {
            case $.ui.keyCode.DOWN:
                this._giveFocus();
        }
    },
    /**
     * @private
     * @param {VerpEvent} ev
     */
    _onColumnResequence: function (ev) {
        this._resequenceRecords(ev.target.dbId, ev.data.ids);
    },
    /**
     * @private
     * @param {VerpEvent} ev
     */
    _ondeleteColumn: function (ev) {
        var column = ev.target;
        var state = this.model.get(this.handle, {raw: true});
        var relatedModelName = state.fields[state.groupedBy[0]].relation;
        this.model
            .deleteRecords([column.dbId], relatedModelName)
            .then(this.update.bind(this, {}, {}));
    },
    /**
     * @private
     * @param {VerpEvent} ev
     * @param {Object} ev.data see model.reload options
     */
    async _onLoadColumnRecords(ev) {
        const column = ev.target;
        const id = column.columnID || column.dbId;
        const options = ev.data;
        const dbID = await this.model.reload(id, options);
        const data = this.model.get(dbID);
        return this.renderer.updateColumn(dbID, data);
    },
    /**
     * @private
     * @param {VerpEvent} ev
     * @param {KanbanColumn} ev.target the column in which the record should
     *   be added
     * @param {Object} ev.data.values the field values of the record to
     *   create; if values only contains the value of the 'displayName', a
     *   'nameCreate' is performed instead of 'create'
     * @param {function} [ev.data.onFailure] called when the quick creation
     *   failed
     */
    _onQuickCreateRecord: function (ev) {
        var self = this;
        var values = ev.data.values;
        var column = ev.target;
        var onFailure = ev.data.onFailure || function () {};

        // function that updates the kanban view once the record has been added
        // it receives the local id of the created record in arguments
        var update = function (dbId) {

            var columnState = self.model.getColumn(dbId);
            var state = self.model.get(self.handle);
            return self.renderer
                .updateColumn(columnState.id, columnState, {openQuickCreate: true, state: state})
                .then(function () {
                    if (ev.data.openRecord) {
                        self.triggerUp('openRecord', {id: dbId, mode: 'edit'});
                    }
                });
        };

        this.model.createRecordInGroup(column.dbId, values)
            .then(update)
            .guardedCatch(function (reason) {
                reason.event.preventDefault();
                var columnState = self.model.get(column.dbId, {raw: true});
                var context = columnState.getContext();
                var state = self.model.get(self.handle, {raw: true});
                var groupByField = viewUtils.getGroupByField(state.groupedBy[0]);
                context['default_' + groupByField] = viewUtils.getGroupValue(columnState, groupByField);
                new viewDialogs.FormViewDialog(self, {
                    resModel: state.model,
                    context: _.extend({default_label: values.name || values.displayName}, context),
                    title: _t("Create"),
                    disableMultipleSelection: true,
                    onSaved: function (record) {
                        self.model.addRecordToGroup(column.dbId, record.resId)
                            .then(update);
                    },
                }).open().opened(onFailure);
            });
    },
    /**
     * @private
     * @param {VerpEvent} ev
     */
    _onRecordDelete: function (ev) {
        this._deleteRecords([ev.data.id]);
    },
    /**
     * @private
     * @param {VerpEvent} ev
     */
    _onResequenceColumn: function (ev) {
        var self = this;
        this._resequenceColumns(ev.data.ids);
    },
    /**
     * @private
     * @param {VerpEvent} ev
     * @param {boolean} [ev.data.openQuickCreate=false] if true, opens the
     *   QuickCreate in the toggled column (it assumes that we are opening it)
     */
    _onToggleColumn: function (ev) {
        var self = this;
        const columnID = ev.target.dbId || ev.data.dbId;
        this.model.toggleGroup(columnID)
            .then(function (dbId) {
                var data = self.model.get(dbId);
                var options = {
                    openQuickCreate: !!ev.data.openQuickCreate,
                };
                return self.renderer.updateColumn(dbId, data, options);
            })
            .then(function () {
                if (ev.data.onSuccess) {
                    ev.data.onSuccess();
                }
            });
    },
    /**
     * @todo should simply use fieldChanged event...
     *
     * @private
     * @param {VerpEvent} ev
     * @param {function} [ev.data.onSuccess] callback to execute after applying
     *   changes
     */
    _onupdateRecord: function (ev) {
        var onSuccess = ev.data.onSuccess;
        delete ev.data.onSuccess;
        var changes = _.clone(ev.data);
        ev.data.forceSave = true;
        this._applyChanges(ev.target.dbId, changes, ev).then(onSuccess);
    },
    /**
     * Allow the user to archive/restore all the records of a column.
     *
     * @private
     * @param {VerpEvent} ev
     */
    _onToggleActiveRecords: function (ev) {
        var self = this;
        var archive = ev.data.archive;
        var column = ev.target;
        var recordIds = _.pluck(column.records, 'id');
        if (recordIds.length) {
            var prom = archive ?
              this.model.actionArchive(recordIds, column.dbId) :
              this.model.actionUnarchive(recordIds, column.dbId);
            prom.then(function (dbID) {
                let data = self.model.get(dbID);
                if (data) {  // Could be null if a wizard is returned for example
                    self.model.reload(self.handle).then(function () {
                        // Retrieve fresher data as the reload may have changed it.
                        data = self.model.get(dbID);
                        const state = self.model.get(self.handle);
                        self.renderer.updateColumn(dbID, data, { state });
                    });
                }
            });
        }
    },
});

return KanbanController;

});
