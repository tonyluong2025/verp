/** @verp-module **/

import {
    registerInstancePatchModel,
} from '@mail/model/model_core';

registerInstancePatchModel('mail.notification_group', 'snailmail/static/src/models/notification_group/notification_group.js', {

    //--------------------------------------------------------------------------
    // Public
    //--------------------------------------------------------------------------

    /**
     * @override
     */
    openCancelAction() {
        if (this.notificationType !== 'snail') {
            return this._super(...arguments);
        }
        this.env.bus.trigger('do-action', {
            action: 'snailmail.snailmailLetterCancelAction',
            options: {
                additionalContext: {
                    default_model: this.resModel,
                    unreadCounter: this.notifications.length,
                },
            },
        });
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * @override
     */
    _openDocuments() {
        if (this.notificationType !== 'snail') {
            return this._super(...arguments);
        }
        this.env.bus.trigger('do-action', {
            action: {
                label: this.env._t("Snailmail Failures"),
                type: 'ir.actions.actwindow',
                viewMode: 'kanban,list,form',
                views: [[false, 'kanban'], [false, 'list'], [false, 'form']],
                target: 'current',
                resModel: this.resModel,
                domain: [['messageIds.snailmailError', '=', true]],
            },
        });
        if (this.messaging.device.isMobile) {
            // messaging menu has a higher z-index than views so it must
            // be closed to ensure the visibility of the view
            this.messaging.messagingMenu.close();
        }
    },
});
