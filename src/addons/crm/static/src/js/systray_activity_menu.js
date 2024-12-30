/** @verp-module **/

import ActivityMenu from '@mail/js/systray/systray_activity_menu';

ActivityMenu.include({

    //--------------------------------------------------
    // Private
    //--------------------------------------------------

    /**
     * @override
     */
    _getViewsList(model) {
        if (model === "crm.lead") {
                return [[false, 'list'], [false, 'kanban'],
                        [false, 'form'], [false, 'calendar'],
                        [false, 'pivot'], [false, 'graph'],
                        [false, 'activity']
                    ];
        }
        return this._super(...arguments);
    },

    //-----------------------------------------
    // Handlers
    //-----------------------------------------

    /**
     * @private
     * @override
     */
    _onActivityFilterClick: function (event) {
        // fetch the data from the button otherwise fetch the ones from the parent (.o-mail-preview).
        var data = _.extend({}, $(event.currentTarget).data(), $(event.target).data());
        var context = {};
        if (data.resModel === "crm.lead") {
            if (data.filter === 'my') {
                context['searchDefault_activitiesOverdue'] = 1;
                context['searchDefault_activitiesToday'] = 1;
            } else {
                context['searchDefault_activities' + _.upperFirst(data.filter)] = 1;
            }
            // Necessary because activityIds of mail.activity.mixin has autojoin
            // So, duplicates are faking the count and "Load more" doesn't show up
            context['forceSearchCount'] = 1;
            this.doAction('crm.crmLeadActionMyActivities', {
                additionalContext: context,
                clearBreadcrumbs: true,
            });
        } else {
            this._super.apply(this, arguments);
        }
    },
});
