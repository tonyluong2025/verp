/** @verp-module **/

import { registerNewModel } from '@mail/model/model_core';
import { one2many } from '@mail/model/model_field';
import { link } from '@mail/model/model_field_command';

function factory(dependencies) {

    class NotificationGroupManager extends dependencies['mail.model'] {

        //----------------------------------------------------------------------
        // Public
        //----------------------------------------------------------------------

        computeGroups() {
            // not supported for guests
            if (this.messaging.isCurrentUserGuest) {
                return;
            }
            for (const group of this.groups) {
                group.delete();
            }
            const groups = [];
            // TODO batch insert, better logic task-2258605
            this.messaging.currentPartner.failureNotifications.forEach(notification => {
                const thread = notification.message.originThread;
                // Notifications are grouped by model and notificationType.
                // Except for channel where they are also grouped by id because
                // we want to open the actual channel in discuss or chat window
                // and not its kanban/list/form view.
                const channelId = thread.model === 'mail.channel' ? thread.id : null;
                const id = `${thread.model}/${channelId}/${notification.notificationType}`;
                const group = this.messaging.models['mail.notificationGroup'].insert({
                    id,
                    notificationType: notification.notificationType,
                    resModel: thread.model,
                    resModelName: thread.modelName,
                });
                group.update({ notifications: link(notification) });
                // avoid linking the same group twice when adding a notification
                // to an existing group
                if (!groups.includes(group)) {
                    groups.push(group);
                }
            });
            this.update({ groups: link(groups) });
        }

    }

    NotificationGroupManager.fields = {
        groups: one2many('mail.notificationGroup'),
    };
    NotificationGroupManager.identifyingFields = ['messaging'];
    NotificationGroupManager.modelName = 'mail.notificationGroupManager';

    return NotificationGroupManager;
}

registerNewModel('mail.notificationGroupManager', factory);
