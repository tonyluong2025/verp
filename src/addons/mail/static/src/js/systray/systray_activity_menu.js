/** @verp-module **/

import { qweb as QWeb } from 'web.core';
import session  from 'web.session';
import SystrayMenu from 'web.SystrayMenu';
import Widget from 'web.Widget';
import Time from 'web.time';

const { Component } = owl;

/**
 * Menu item appended in the systray part of the navbar, redirects to the next
 * activities of all app
 */
var ActivityMenu = Widget.extend({
    name: 'activityMenu',
    template:'mail.systray.ActivityMenu',
    events: {
        'click .o-mail-activity-action': '_onActivityActionClick',
        'click .o-mail-preview': '_onActivityFilterClick',
        'show.bs.dropdown': '_onActivityMenuShow',
        'hide.bs.dropdown': '_onActivityMenuHide',
    },
    start: function () {
        this._$activitiesPreview = this.$('.o-mail-systray-dropdown-items');
        Component.env.bus.on('activityUpdated', this, this._updateCounter);
        this._updateCounter();
        this._updateActivityPreview();
        return this._super();
    },
    //--------------------------------------------------
    // Private
    //--------------------------------------------------
    /**
     * Make RPC and get current user's activity details
     * @private
     */
    _getActivityData: function () {
        var self = this;

        return self._rpc({
            model: 'res.users',
            method: 'systrayGetActivities',
            args: [],
            kwargs: {context: session.userContext},
        }).then(function (data) {
            self._activities = data;
            self.activityCounter = _.reduce(data, function (totalCount, pData) { return totalCount + pData.totalCount || 0; }, 0);
            self.$('.o-notification-counter').text(self.activityCounter);
            self.$el.toggleClass('o-no-notification', !self.activityCounter);
        });
    },
    /**
     * Get particular model view to redirect on click of activity scheduled on that model.
     * @private
     * @param {string} model
     */
    _getActivityModelViewID: function (model) {
        return this._rpc({
            model: model,
            method: 'getActivityViewId'
        });
    },
    /**
     * Return views to display when coming from systray depending on the model.
     *
     * @private
     * @param {string} model
     * @returns {Array[]} output the list of views to display.
     */
    _getViewsList(model) {
        return [[false, 'kanban'], [false, 'list'], [false, 'form']];
    },
    /**
     * Update(render) activity system tray view on activity updation.
     * @private
     */
    _updateActivityPreview: function () {
        var self = this;
        self._getActivityData().then(function (){
            self._$activitiesPreview.html(QWeb.render('mail.systray.ActivityMenu.Previews', {
                widget: self,
                Time: Time
            }));
        });
    },
    /**
     * update counter based on activity status(created or Done)
     * @private
     * @param {Object} [data] key, value to decide activity created or deleted
     * @param {String} [data.type] notification type
     * @param {Boolean} [data.activityDeleted] when activity deleted
     * @param {Boolean} [data.activityCreated] when activity created
     */
    _updateCounter: function (data) {
        if (data) {
            if (data.activityCreated) {
                this.activityCounter ++;
            }
            if (data.activityDeleted && this.activityCounter > 0) {
                this.activityCounter --;
            }
            this.$('.o-notification-counter').text(this.activityCounter);
            this.$el.toggleClass('o-no-notification', !this.activityCounter);
        }
    },

    //------------------------------------------------------------
    // Handlers
    //------------------------------------------------------------

    /**
     * Redirect to specific action given its xml id or to the activity
     * view of the current model if no xml id is provided
     *
     * @private
     * @param {MouseEvent} ev
     */
    _onActivityActionClick: function (ev) {
        ev.stopPropagation();
        this.$('.dropdown-toggle').dropdown('toggle');
        var targetAction = $(ev.currentTarget);
        var actionXmlid = targetAction.data('actionXmlid');
        if (actionXmlid) {
            this.doAction(actionXmlid);
        } else {
            var domain = [['activityIds.userId', '=', session.uid]]
            if (targetAction.data('domain')) {
                domain = domain.concat(targetAction.data('domain'))
            }

            this.doAction({
                type: 'ir.actions.actwindow',
                name: targetAction.data('modelName'),
                views: [[false, 'activity'], [false, 'kanban'], [false, 'list'], [false, 'form']],
                viewMode: 'activity',
                resModel: targetAction.data('resModel'),
                domain: domain,
            }, {
                clearBreadcrumbs: true,
            });
        }
    },

    /**
     * Redirect to particular model view
     * @private
     * @param {MouseEvent} event
     */
    _onActivityFilterClick: function (event) {
        // fetch the data from the button otherwise fetch the ones from the parent (.o-mail-preview).
        var data = _.extend({}, $(event.currentTarget).data(), $(event.target).data());
        var context = {};
        if (data.filter === 'my') {
            context['searchDefault_activitiesOverdue'] = 1;
            context['searchDefault_activitiesToday'] = 1;
        } else {
            context['searchDefault_activities' + _.upperFirst(data.filter)] = 1;
        }
        // Necessary because activityIds of mail.activity.mixin has autojoin
        // So, duplicates are faking the count and "Load more" doesn't show up
        context['forceSearchCount'] = 1;

        var domain = [['activityIds.userId', '=', session.uid]]
        if (data.domain) {
            domain = domain.concat(data.domain)
        }

        this.doAction({
            type: 'ir.actions.actwindow',
            name: data.modelName,
            resModel:  data.resModel,
            views: this._getViewsList(data.resModel),
            searchViewId: [false],
            domain: domain,
            context: context,
        }, {
            clearBreadcrumbs: true,
        });
    },
    /**
     * @private
     */
    _onActivityMenuShow: function () {
        document.body.classList.add('modal-open');
         this._updateActivityPreview();
    },
    /**
     * @private
     */
    _onActivityMenuHide: function () {
        document.body.classList.remove('modal-open');
    },
});

SystrayMenu.Items.push(ActivityMenu);

export default ActivityMenu;
