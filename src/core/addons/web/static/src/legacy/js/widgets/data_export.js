verp.define('web.DataExport', function (require) {
"use strict";

var config = require('web.config');
var core = require('web.core');
var Dialog = require('web.Dialog');
var data = require('web.data');
var framework = require('web.framework');
var vjUtils = require('web.vjUtils');

var QWeb = core.qweb;
var _t = core._t;

var DataExport = Dialog.extend({
    template: 'ExportDialog',
    events: {
        'change .o-exported-lists-select': '_onchangeExportList',
        'change .o-import-compat input': '_onchangeCompatibleInput',
        'click .o-add-field': '_onClickAddField',
        'click .o-delete-exported-list': '_onClickDeleteExportListBtn',
        'click .o-expand': '_onClickExpand',
        'click .o-remove-field': '_onClickRemoveField',
        'click .o-save-list .o-save-list-btn': '_onClickSaveListBtn',
        'click .o-save-list .o-cancel-list-btn': '_resetTemplateField',
        'click .o-export-tree-item': '_onClickTreeItem',
        'dblclick .o-export-tree-item:not(.haschild)': '_onDblclickTreeItem',
        'keydown .o-export-tree-item': '_onKeydownTreeItem',
        'keydown .o-save-list-name': '_onKeydownSaveList',
        'input .o-export-search-input': '_onSearchInput',
    },
    /**
     * @constructor
     * @param {Widget} parent
     * @param {Object} record
     * @param {string[]} defaultExportFields
     */
    init: function (parent, record, defaultExportFields, groupedBy, activeDomain, idsToExport) {
        var options = {
            title: _t("Export Data"),
            buttons: [
                {text: _t("Export"), click: this._onExportData, classes: 'btn-primary'},
                {text: _t("Close"), close: true},
            ],
            fullscreen: config.device.isMobile,
        };
        this._super(parent, options);
        this.records = {};
        this.record = record;
        this.defaultExportFields = defaultExportFields;
        this.groupby = groupedBy;
        this.exports = new data.DataSetSearch(this, 'ir.exports', this.record.getContext());
        this.rowIndex = 0;
        this.rowIndexLevel = 0;
        this.isCompatibleMode = false;
        this.domain = activeDomain || this.record.domain;
        this.idsToExport = activeDomain ? false: idsToExport;
    },
    /**
     * @override
     */
    start: function () {
        var self = this;
        var proms = [this._super.apply(this, arguments)];

        // The default for the ".modal-content" element is "max-height: 100%;"
        // but we want it to always expand to "height: 100%;" for this modal.
        // This can be achieved thanks to CSS modification without touching
        // the ".modal-content" rules... but not with Internet explorer (11).
        this.$modal.find('.modal-content').css('height', '100%');

        this.$fieldsList = this.$('.o-fields-list');

        proms.push(this._rpc({route: '/web/export/formats'}).then(doSetupExportFormats));
        proms.push(this._onchangeCompatibleInput().then(function () {
            _.each(self.defaultExportFields, function (field) {
                var record = self.records[field];
                self._addField(record.id, record.string);
            });
        }));

        proms.push(this._showExportsList());

        // Bind sortable events after Dialog is open
        this.opened().then(function () {
            self.$('.o-fields-list').sortable({
                axis: 'y',
                cursor: 'grabbing',
                handle: '.o-short-field',
                forcePlaceholderSize: true,
                placeholder: 'o-field-placeholder',
                update: self.proxy('_resetTemplateField'),
            });
        });
        return Promise.all(proms);

        function doSetupExportFormats(formats) {
            var $fmts = self.$('.o-export-format');

            _.each(formats, function (format) {
                var $radio = $('<input/>', {type: 'radio', value: format.tag, name: 'o-export-format-name', class: 'form-check-input', id: 'o-radio' + format.label});
                var $label = $('<label/>', {html: format.label, class: 'form-check-label', for: 'o-radio' + format.label});

                if (format.error) {
                    $radio.prop('disabled', true);
                    $label.html(_.str.sprintf("%s — %s", format.label, format.error));
                }

                $fmts.append($("<div class='radio form-check form-check-inline pl-4'></div>").append($radio, $label));
            });

            self.$exportFormatInputs = $fmts.find('input');
            self.$exportFormatInputs.filter(':enabled').first().prop('checked', true);
        }
    },

    /**
     * Export all data with default values (fields, domain)
     */
    export() {
        let exportedFields = this.defaultExportFields.map(field => ({
            name: field,
            label: this.record.fields[field].string,
            store: this.record.fields[field].store,
            type: this.record.fields[field].type,
        }));
        this._exportData(exportedFields, 'xlsx', false);
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * Add the field in the export list
     *
     * @private
     * @param {string} fieldID
     * @param {string} label
     */
    _addField: function (fieldID, label) {
        var $fieldList = this.$('.o-fields-list');
        if (!$fieldList.find(".o-export-field[data-fieldId='" + fieldID + "']").length) {
            $fieldList.append(
                $('<li>', {'class': 'o-export-field', 'data-fieldId': fieldID}).append(
                    $('<span>', {'class': "fa fa-sort o-short-field mx-1"}),
                    label.trim(),
                    $('<span>', {'class': 'fa fa-trash m-1 pull-right o-remove-field', 'title': _t("Remove field")})
                )
            );
        }
    },

    /**
     * Submit the user data and export the file
     *
     * @private
     */
    _exportData(exportedFields, exportFormat, idsToExport) {

        if (_.isEmpty(exportedFields)) {
            Dialog.alert(this, _t("Please select fields to export..."));
            return;
        }
        if (this.isCompatibleMode) {
            exportedFields.unshift({ name: 'id', label: _t('External ID') });
        }

        framework.blockUI();
        this.getSession().getFile({
            url: '/web/export/' + exportFormat,
            data: {
                data: JSON.stringify({
                    model: this.record.model,
                    fields: exportedFields,
                    ids: idsToExport,
                    domain: this.domain,
                    groupby: this.groupby,
                    context: vjUtils.eval('contexts', [this.record.getContext()]),
                    importCompat: this.isCompatibleMode,
                })
            },
            complete: framework.unblockUI,
            error: (error) => this.call('crashManager', 'rpcError', error),
        });
    },
    /**
     * @private
     * @returns {string[]} exportFields
     */
    _getFields: function () {
        var exportFields = this.$('.o-export-field').map(function () {
            return $(this).data('fieldId');
        }).get();
        if (exportFields.length === 0) {
            Dialog.alert(this, _t("Please select fields to save export list..."));
        }
        return exportFields;
    },
    /**
     * Fetch the field info for the relational field. This method will be
     * invoked when the user expands the relational field from keyboard/mouse.
     *
     * @private
     * @param {Object} record
     */
    _onExpandAction: function (record) {
        var self = this;
        if (!record.children) {
            return;
        }

        var model = record.params.model;
        var prefix = record.params.prefix;
        var name = record.params.name;
        var excludeFields = [];
        if (record.relationField) {
            excludeFields.push(record.relationField);
        }

        if (!record.loaded) {
            this._rpc({
                route: '/web/export/getFields',
                params: {
                    model: model,
                    prefix: prefix,
                    parentName: name,
                    importCompat: this.isCompatibleMode,
                    parentFieldType: record.fieldType,
                    parentField: record.params.parentField,
                    exclude: excludeFields,
                },
            }).then(function (results) {
                record.loaded = true;
                self._onShowData(results, record.id);
            });
        } else {
            this._showContent(record.id);
        }
    },
    /**
     * After the fetching the fields info for the relational field, this method
     * will render a list of a field for expanded relational field.
     *
     * @private
     * @param {Object[]} records
     * @param {string} expansion
     */
    _onShowData: function (records, expansion) {
        var self = this;
        if (expansion) {
            this.$('.o-export-tree-item[data-id="' + expansion + '"]')
                .addClass('show')
                .find('.o-expand-parent')
                .toggleClass('fa-chevron-right fa-chevron-down')
                .next()
                .after(QWeb.render('Export.TreeItems', {fields: records, debug: config.isDebug()}));
        } else {
            this.$('.o-left-field-panel').empty().append(
                $('<div/>').addClass('o-field-tree-structure')
                           .append(QWeb.render('Export.TreeItems', {fields: records, debug: config.isDebug()}))
            );
        }

        _.extend(this.records, _.object(_.pluck(records, 'id'), records));
        this.$records = this.$('.o-export-tree-item');
        this.$records.each(function (i, el) {
            var $el = $(el);
            $el.find('.o-tree-column').first().toggleClass('o-required', !!self.records[$el.data('id')].required);
        });
    },
    /**
     * @private
     */
    _addNewTemplate: function () {
        this.$('.o-exported-lists').addClass('d-none');

        this.$(".o-save-list")
            .show()
            .find(".o-save-list-name")
                .val("")
                .focus();
    },
    /**
     * @private
     */
    _resetTemplateField: function () {
        this.$('.o-exported-lists-select').val("");
        this.$('.o-delete-exported-list').addClass('d-none');
        this.$('.o-exported-lists').removeClass('d-none');

        this.$(".o-save-list")
            .hide()
            .find(".o-save-list-name").val("");
    },
    /**
     * If relational fields info is already fetched then this method is
     * used to display fields.
     *
     * @private
     * @param {string} fieldID
     */
    _showContent: function (fieldID) {
        var $item = this.$('.o-export-tree-item[data-id="' + fieldID + '"]');
        $item.toggleClass('show');
        var isOpen = $item.hasClass('show');

        $item.children('.o-expand-parent').toggleClass('fa-chevron-down', !!isOpen).toggleClass('fa-chevron-right', !isOpen);

        var $childField = $item.find('.o-export-tree-item');
        var childLength = (fieldID.split('/')).length + 1;
        for (var i = 0 ; i < $childField.length ; i++) {
            var $child = $childField.eq(i);
            if (!isOpen) {
                $child.hide();
            } else if (childLength === $childField.eq(i).data('id').split('/').length) {
                if ($child.hasClass('show')) {
                    $child.removeClass('show');
                    $child.children('.o-expand-parent').removeClass('fa-chevron-down').addClass('fa-chevron-right');
                }
                $child.show();
            }
        }
    },
    /**
     * Fetches the saved export list for the current model
     *
     * @private
     * @returns {Deferred}
     */
    _showExportsList: function () {
        var self = this;
        if (this.$('.o-exported-lists-select').is(':hidden')) {
            this.$('.o-exported-lists').show();
            return Promise.resolve();
        }

        return this._rpc({
            model: 'ir.exports',
            method: 'searchRead',
            fields: ['name'],
            domain: [['resource', '=', this.record.model]]
        }).then(function (exportList) {
            self.$('.o-exported-lists').append(QWeb.render('Export.SavedList', {
                existingExports: exportList,
            }));
        });
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * This method will fill fields to export when user change exported field list
     *
     * @private
     */
    _onchangeExportList: function () {
        var self = this;
        var exportID = this.$('.o-exported-lists-select option:selected').val();
        this.$('.o-delete-exported-list').toggleClass('d-none', !exportID);
        if (exportID && exportID !== 'newTemplate') {
            this.$('.o-fields-list').empty();
            this._rpc({
                route: '/web/export/namelist',
                params: {
                    model: this.record.model,
                    exportId: parseInt(exportID, 10),
                },
            }).then(function (fieldList) {
                _.each(fieldList, function (field) {
                    self._addField(field.name, field.label);
                });
            });
        } else if (exportID === 'newTemplate') {
            self._addNewTemplate();
        }
    },
    /**
     * @private
     * @returns {Deferred}
     */
    _onchangeCompatibleInput: function () {
        var self = this;
        this.isCompatibleMode = this.$('.o-import-compat input').is(':checked');

        this.$('.o-field-tree-structure').remove();
        this._resetTemplateField();
        return this._rpc({
            route: '/web/export/getFields',
            params: {
                model: this.record.model,
                importCompat: this.isCompatibleMode,
            },
        }).then(function (records) {
            var compatibleFields = _.map(records, function (record) { return record.id; });
            self._onShowData(records);
            self.$('.o-fields-list').empty();

            _.chain(self.$fieldsList.find('.o-export-field'))
            .map(function (field) { return $(field).data('fieldId'); })
            .union(self.defaultExportFields)
            .intersection(compatibleFields)
            .each(function (field) {
                var record = _.find(records, function (rec) {
                    return rec.id === field;
                });
                self._addField(record.id, record.string);
            });
            self.$('#oExportSearchFilter').val('');
        });
    },
    /**
     * Add a field to export list
     *
     * @private
     * @param {Event} ev
     */
    _onClickAddField: function(ev) {
        ev.stopPropagation();
        var $field = $(ev.currentTarget);
        this._resetTemplateField();
        this._addField($field.closest('.o-export-tree-item').data('id'), $field.closest('.o-tree-column').text());
    },
    /**
     * Delete selected export list item from the saved export list
     *
     * @private
     */
    _onClickDeleteExportListBtn: function () {
        var self = this;
        var selectExp = this.$('.o-exported-lists-select option:selected');
        var options = {
            confirmCallback: function () {
                if (selectExp.val()) {
                    self.exports.unlink([parseInt(selectExp.val(), 10)]);
                    selectExp.remove();
                    if (self.$('.o-exported-lists-select option').length <= 1) {
                        self.$('.o-exported-lists').hide();
                    }
                }
            }
        };
        Dialog.confirm(this, _t("Do you really want to delete this export template?"), options);
    },
    /**
     * @private
     * @param {Event} ev
     */
    _onClickExpand: function (ev) {
        this._onExpandAction(this.records[$(ev.target).closest('.o-export-tree-item').data('id')]);
    },
    /**
     * Remove selected field from export field list
     *
     * @private
     * @param {Event} ev
     */
    _onClickRemoveField: function (ev) {
        $(ev.currentTarget).closest('.o-export-field').remove();
        this._resetTemplateField();
    },
    /**
     * This method will create a record in 'ir.exports' model with list of
     * selected fields.
     *
     * @private
     */
    _onClickSaveListBtn: function () {
        var self = this;
        var $saveList = this.$('.o-save-list');

        var value = $saveList.find('input').val();
        if (!value) {
            Dialog.alert(this, _t("Please enter save field list name"));
            return;
        }

        var fields = this._getFields();
        if (fields.length === 0) {
            return;
        }

        $saveList.hide();

        this.exports.create({
            name: value,
            resource: this.record.model,
            exportFields: _.map(fields, function (field) {
                return [0, 0, { name: field }];
            }),
        }).then(function (exportListID) {
            if (!exportListID) {
                return;
            }
            var $select = self.$('.o-exported-lists-select');
            if ($select.length === 0 || $select.is(':hidden')) {
                self._showExportsList();
            }
            $select.append(new Option(value, exportListID));
            self.$('.o-exported-lists').removeClass('d-none');
            $select.val(exportListID);
        });
    },
    /**
     * @private
     * @param ev
     */
    _onClickTreeItem: function (ev) {
        ev.stopPropagation();
        var $elem = $(ev.currentTarget);

        var rowIndex = $elem.prevAll('.o-export-tree-item').length;
        var rowIndexLevel = $elem.parents('.o-export-tree-item').length;

        if (ev.shiftKey && rowIndexLevel === this.rowIndexLevel) {
            var minIndex = Math.min(rowIndex, this.rowIndex);
            var maxIndex = Math.max(rowIndex, this.rowIndex);

            this.$records.filter(function () { return ($elem.parent()[0] === $(this).parent()[0]); })
                .slice(minIndex, maxIndex + 1)
                .addClass('o-selected')
                .filter(':not(:last)')
                .each(processChildren);
        }

        this.rowIndex = rowIndex;
        this.rowIndexLevel = rowIndexLevel;

        if (ev.ctrlKey) {
            $elem.toggleClass('o-selected').focus();
        } else if (ev.shiftKey) {
            $elem.addClass('o-selected').focus();
        } else {
            this.$('.o-selected').removeClass('o-selected');
            $elem.addClass('o-selected').focus();
        }

        function processChildren() {
            var $child = $(this);
            if ($child.hasClass('show')) {
                $child.children('.o-export-tree-item')
                    .addClass('o-selected')
                    .each(processChildren);
            }
        }
    },
    /**
     * Submit the user data and export the file
     *
     * @private
     */
    _onExportData() {
        let exportedFields = this.$('.o-export-field').map((i, field) => ({
                name: $(field).data('fieldId'),
                label: field.textContent,
            }
        )).get();
        let exportFormat = this.$exportFormatInputs.filter(':checked').val();
        this._exportData(exportedFields, exportFormat, this.idsToExport);
    },
    /**
     * Add a field to export field list on double click
     *
     * @private
     * @param {Event} ev
     */
    _onDblclickTreeItem: function (ev) {
        var self = this;
        this._resetTemplateField();
        function addElement(el) {
            self._addField(el.getAttribute('data-id'), el.querySelector('.o-tree-column').textContent);
        }
        var target = ev.currentTarget;
        target.classList.remove('o-selected');
        // Add parent fields to export
        [].reverse.call($(target).parents('.o-export-tree-item')).each(function () {
            addElement(this);
        });
        // add field itself
        addElement(target);
    },
    /**
     * @private
     * @param ev
     */
    _onKeydownSaveList: function (ev) {
        if (ev.keyCode === $.ui.keyCode.ENTER) {
            this._onClickSaveListBtn();
        }
    },
    /**
     * Handles the keyboard navigation for the fields
     *
     * @private
     * @param ev
     */
    _onKeydownTreeItem: function (ev) {
        ev.stopPropagation();
        var $el = $(ev.currentTarget);
        var record = this.records[$el.data('id')];

        switch (ev.keyCode || ev.which) {
            case $.ui.keyCode.LEFT:
                if ($el.hasClass('show')) {
                    this._onExpandAction(record);
                }
                break;
            case $.ui.keyCode.RIGHT:
                if (!$el.hasClass('show')) {
                    this._onExpandAction(record);
                }
                break;
            case $.ui.keyCode.UP:
                var $prev = $el.prev('.o-export-tree-item');
                if ($prev.length === 1) {
                    while ($prev.hasClass('show')) {
                        $prev = $prev.children('.o-export-tree-item').last();
                    }
                } else {
                    $prev = $el.parent('.o-export-tree-item');
                    if ($prev.length === 0) {
                        break;
                    }
                }

                $el.removeClass('o-selected').blur();
                $prev.addClass("o-selected").focus();
                break;
            case $.ui.keyCode.DOWN:
                var $next;
                if ($el.hasClass('show')) {
                    $next = $el.children('.o-export-tree-item').first();
                } else {
                    $next = $el.next('.o-export-tree-item');
                    if ($next.length === 0) {
                        $next = $el.parent('.o-export-tree-item').next('.o-export-tree-item');
                        if ($next.length === 0) {
                            break;
                        }
                    }
                }

                $el.removeClass('o-selected').blur();
                $next.addClass('o-selected').focus();
                break;
        }
    },
    /**
     * Search fields from a field list.
     *
     * @private
     */
    _onSearchInput: function (ev) {
        var searchText = $(ev.currentTarget).val().trim().toUpperCase();
        if (!searchText) {
            this.$('.o-no-match').remove();
            this.$(".o-export-tree-item").show();
            this.$(".o-export-tree-item.haschild:not(.show) .o-export-tree-item").hide();
            return;
        }

        var matchItems = this.$(".o-tree-column").filter(function () {
            var title = this.getAttribute('title');
            return this.innerText.toUpperCase().indexOf(searchText) >= 0
                || title && title.toUpperCase().indexOf(searchText) >= 0;
        }).parent();
        this.$(".o-export-tree-item").hide();
        if (matchItems.length) {
            this.$('.o-no-match').remove();
            _.each(matchItems, function (col) {
                var $col = $(col);
                $col.show();
                $col.parents('.haschild.show').show();
                if (!$col.parent().hasClass('show') && !$col.parent().hasClass('o-field-tree-structure')) {
                    $col.hide();
                }
            });
        } else if (!this.$('.o-no-match').length) {
            this.$(".o-field-tree-structure").append($("<h3/>", {
                class: 'text-center text-muted mt-5 o-no-match',
                text: _t("No match found.")
            }));
        }
    },
});

return DataExport;

});
