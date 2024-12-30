/** @verp-module **/

import '@mail/js/activity';

import BasicController from 'web.BasicController';
import core from 'web.core';
import fieldRegistry from 'web.fieldRegistry';
import ViewDialogs from 'web.viewDialogs';

var KanbanActivity = fieldRegistry.get('kanbanActivity');
var _t = core._t;

var ActivityController = BasicController.extend({
    customEvents: _.extend({}, BasicController.prototype.customEvents, {
        emptyCellClicked: '_onEmptyCell',
        sendMailTemplate: '_onSendMailTemplate',
        scheduleActivity: '_onScheduleActivity',
    }),

    //--------------------------------------------------------------------------
    // Public
    //--------------------------------------------------------------------------

    /**
     * @override
     * @param parent
     * @param model
     * @param renderer
     * @param {Object} params
     * @param {String} params.title The title used in schedule activity dialog
     */
    init: function (parent, model, renderer, params) {
        this._super.apply(this, arguments);
        this.title = params.title;
        this.searchViewId = params.searchViewId;
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * Overridden to remove the pager as it makes no sense in this view.
     *
     * @override
     */
    _getPagingInfo: function () {
        return null;
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * @private
     */
    _onScheduleActivity: function () {
        var self = this;
        var state = this.model.get(this.handle);
        new ViewDialogs.SelectCreateDialog(this, {
            resModel: state.model,
            searchViewId: this.searchViewId,
            domain: this.model.originalDomain,
            title: _.str.sprintf(_t("Search: %s"), this.title),
            noCreate: !this.activeActions.create,
            disableMultipleSelection: true,
            context: state.context,
            onSelected: function (record) {
                var fakeRecord = state.getKanbanActivityData({}, record[0]);
                var widget = new KanbanActivity(self, 'activityIds', fakeRecord, {});
                widget.scheduleActivity();
            },
        }).open();
    },
    /**
     * @private
     * @param {VerpEvent} ev
     */
    _onEmptyCell: function (ev) {
        var state = this.model.get(this.handle);
        this.doAction({
            type: 'ir.actions.actwindow',
            resModel: 'mail.activity',
            viewMode: 'form',
            viewType: 'form',
            views: [[false, 'form']],
            target: 'new',
            context: {
                default_resId: ev.data.resId,
                default_resModel: state.model,
                default_activityTypeId: ev.data.activityTypeId,
            },
            resId: false,
        }, {
            onClose: this.reload.bind(this),
        });
    },
    /**
     * @private
     * @param {CustomEvent} ev
     */
    _onSendMailTemplate: function (ev) {
        var templateID = ev.data.templateID;
        var activityTypeID = ev.data.activityTypeID;
        var state = this.model.get(this.handle);
        var groupedActivities = state.groupedActivities;
        var resIDS = [];
        Object.keys(groupedActivities).forEach(function (resID) {
            var activityByType = groupedActivities[resID];
            var activity = activityByType[activityTypeID];
            if (activity) {
                resIDS.push(parseInt(resID));
            }
        });
        this._rpc({
            model: this.model.modelName,
            method: 'activitySendMail',
            args: [resIDS, templateID],
        });
    },
});

export default ActivityController;
