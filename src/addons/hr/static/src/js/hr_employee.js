verp.define('hr.employeeChat', function (require) {
'use strict';
    var viewRegistry = require('web.viewRegistry');

    var FormController = require('web.FormController');
    var FormView = require('web.FormView');
    var FormRenderer = require('web.FormRenderer');

    const ListController = require('web.ListController');
    const ListView = require('web.ListView');

    var KanbanController = require('web.KanbanController');
    var KanbanView = require('web.KanbanView');
    var KanbanRenderer = require('web.KanbanRenderer');
    var KanbanRecord = require('web.KanbanRecord');

    const ChatMixin = require('hr.chatMixin');


    const core = require('web.core');
    const _t = core._t;

    // USAGE OF CHAT MIXIN IN FORM VIEWS
    var EmployeeFormRenderer = FormRenderer.extend(ChatMixin);

    const EmployeeArchiveMixin = {
        _getArchiveAction: function (id) {
            return {
                type: 'ir.actions.actwindow',
                label: _t('Employee Termination'),
                resModel: 'hr.departure.wizard',
                views: [[false, 'form']],
                viewMode: 'form',
                target: 'new',
                context: {
                    'activeId': id,
                    'toggleActive': true,
                }
            }
        }
    };

    const EmployeeFormController = FormController.extend(EmployeeArchiveMixin, {
        /**
         * Override the archive action to directly open the departure wizard
         * @override
         * @private
         */
        _getActionMenuItems: function (state) {
            let self = this;
            let actionMenuItems = this._super(...arguments);
            const activeField = this.model.getActiveField(state);
            if (actionMenuItems != null && this.archiveEnabled && activeField in state.data) {
                //This might break in future version, don't see a better way however
                let archiveString = _t("Archive");
                let archiveMenuItem = actionMenuItems.items.other.find(item => {return (item.description === archiveString)});
                if (archiveMenuItem) {
                    archiveMenuItem.callback = () => {self.doAction(
                        self._getArchiveAction(self.model.localIdsToResIds([this.handle])[0]), {
                        onClose: function () {
                            self.update({}, {reload: true});
                        }
                    })}
                }
            }
            return actionMenuItems;
        }
    })

    var EmployeeFormView = FormView.extend({
        config: _.extend({}, FormView.prototype.config, {
            Controller: EmployeeFormController,
            Renderer: EmployeeFormRenderer
        }),
    });

    viewRegistry.add('hrEmployeeForm', EmployeeFormView);

    const EmployeeListController = ListController.extend(EmployeeArchiveMixin, {
        /**
         * Override the archive action to directly open the departure wizard
         * @override
         * @private
         */
        _getActionMenuItems: function (state) {
            let self = this;
            let actionMenuItems = this._super(...arguments);
            if (actionMenuItems != null && this.archiveEnabled) {
                //This might break in future version, don't see a better way however
                let archiveString = _t("Archive");
                let archiveMenuItem = actionMenuItems.items.other.find(item => {return (item.description === archiveString)});
                if (archiveMenuItem) {
                    //On this one we want the default action when multiple are selected
                    let originalCallback = archiveMenuItem.callback;
                    archiveMenuItem.callback = () => {
                        let records = self.getSelectedRecords()
                        if (records.length == 1 && records[0].data.active === true) {
                            self.doAction(
                                self._getArchiveAction(records[0].resId), {
                                onClose: function () {
                                    self.update({}, {reload: true});
                                }
                            })
                        } else {
                            originalCallback();
                        }
                    };
                }
            }
            return actionMenuItems;
        }
    });

    const EmployeeListView = ListView.extend({
        config: _.extend({}, ListView.prototype.config, {
            Controller: EmployeeListController,
        })
    })

    viewRegistry.add('hrEmployeeList', EmployeeListView);

    // USAGE OF CHAT MIXIN IN KANBAN VIEWS
    var EmployeeKanbanRecord = KanbanRecord.extend(ChatMixin);

    var EmployeeKanbanRenderer = KanbanRenderer.extend({
        config: Object.assign({}, KanbanRenderer.prototype.config, {
            KanbanRecord: EmployeeKanbanRecord,
        }),
    });

    var EmployeeKanbanView = KanbanView.extend({
        config: _.extend({}, KanbanView.prototype.config, {
            Controller: KanbanController,
            Renderer: EmployeeKanbanRenderer
        }),
    });

    viewRegistry.add('hrEmployeeKanban', EmployeeKanbanView);
});
