/** @verp-module **/

import ActivityMenu from '@mail/js/systray/systray_activity_menu';
import fieldUtils from 'web.fieldUtils';

ActivityMenu.include({

    //-----------------------------------------
    // Private
    //-----------------------------------------

    /**
     * parse date to server value
     *
     * @private
     * @override
     */
    _getActivityData: function () {
        var self = this;
        return this._super.apply(this, arguments).then(function () {
            var meeting = _.find(self._activities, {type: 'meeting'});
            if (meeting && meeting.meetings)  {
                _.each(meeting.meetings, function (res) {
                    res.start = fieldUtils.parse.datetime(res.start, false, {isUTC: true});
                });
            }
        });
    },

    //-----------------------------------------
    // Handlers
    //-----------------------------------------

    /**
     * @private
     * @override
     */
    _onActivityFilterClick: function (ev) {
        var $el = $(ev.currentTarget);
        var data = _.extend({}, $el.data());
        if (data.resModel === "calendar.event" && data.filter === "my") {
            this.doAction('calendar.actionCalendarEvent', {
                additionalContext: {
                    default_mode: 'day',
                    searchDefault_mymeetings: 1,
                },
               clearBreadcrumbs: true,
            });
        } else {
            this._super.apply(this, arguments);
        }
    },
});
