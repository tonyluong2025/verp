/** @verp-module */

import { Activity } from '@mail/components/activity/activity';
import { patch } from 'web.utils';
import Dialog from 'web.Dialog';
import core from 'web.core';
const _t = core._t;

patch(Activity.prototype, 'calendar/static/src/components/activity/activity.js', {
    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * Small override that asks for confirmation in case there is a meeting linked to this activity.
     *
     * @override
     */
    _onClickCancel(ev) {
        const superMethod = this._super;
        if (!this.activity.calendarEventId){
            this._super(ev);
        } else {
            Dialog.confirm(
                this,
                _t("The activity is linked to a meeting. Deleting it will remove the meeting as well. Do you want to proceed ?"), {
                    confirmCallback: function () {
                        superMethod(ev);
                    },
                }
            );
        }
    }

});
