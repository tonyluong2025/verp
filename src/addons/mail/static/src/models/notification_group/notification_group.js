/** @verp-module **/

import { registerNewModel } from '@mail/model/model_core';
import { attr, many2one, one2many } from '@mail/model/model_field';
import { clear, insert, unlink } from '@mail/model/model_field_command';

function factory(dependencies) {

    class NotificationGroup extends dependencies['mail.model'] {

        //----------------------------------------------------------------------
        // Public
        //----------------------------------------------------------------------

        /**
         * Opens the view that allows to cancel all notifications of the group.
         */
        openCancelAction() {
            if (this.notificationType !== 'email') {
                return;
            }
            this.env.bus.trigger('do-action', {
                action: 'mail.mailResendCancelAction',
                options: {
                    additionalContext: {
                        default_model: this.resModel,
                        unreadCounter: this.notifications.length,
                    },
                },
            });
        }

        /**
         * Opens the view that displays either the single record of the group or
         * all the records in the group.
         */
        openDocuments() {
            if (this.thread) {
                this.thread.open();
            } else {
                this._openDocuments();
            }
        }

        //----------------------------------------------------------------------
        // Private
        //----------------------------------------------------------------------

        /**
         * @private
         * @returns {mail.thread|undefined}
         */
        _computeThread() {
            const notificationsThreadIds = this.notifications
                  .filter(notification => notification.message && notification.message.originThread)
                  .map(notification => notification.message.originThread.id);
            const threadIds = new Set(notificationsThreadIds);
            if (threadIds.size !== 1) {
                return unlink();
            }
            return insert({
                id: notificationsThreadIds[0],
                model: this.resModel,
            });
        }

        /**
         * Compute the most recent date inside the notification messages.
         *
         * @private
         * @returns {moment|undefined}
         */
        _computeDate() {
            const dates = this.notifications
                  .filter(notification => notification.message && notification.message.date)
                  .map(notification => notification.message.date);
            if (dates.length === 0) {
                return clear();
            }
            return moment.max(dates);
        }

        /**
         * Compute the position of the group inside the notification list.
         *
         * @private
         * @returns {number}
         */
        _computeSequence() {
            return -Math.max(...this.notifications.map(notification => notification.message.id));
        }

        /**
         * Opens the view that displays all the records of the group.
         *
         * @private
         */
        _openDocuments() {
            if (this.notificationType !== 'email') {
                return;
            }
            this.env.bus.trigger('do-action', {
                action: {
                    label: this.env._t("Mail Failures"),
                    type: 'ir.actions.actwindow',
                    viewMode: 'kanban,list,form',
                    views: [[false, 'kanban'], [false, 'list'], [false, 'form']],
                    target: 'current',
                    resModel: this.resModel,
                    domain: [['messageHasError', '=', true]],
                },
            });
            if (this.messaging.device.isMobile) {
                // messaging menu has a higher z-index than views so it must
                // be closed to ensure the visibility of the view
                this.messaging.messagingMenu.close();
            }
        }

    }

    NotificationGroup.fields = {
        /**
         * States the most recent date of all the notification message.
         */
        date: attr({
            compute: '_computeDate',
        }),
        id: attr({
            readonly: true,
            required: true,
        }),
        notificationType: attr(),
        notifications: one2many('mail.notification'),
        resModel: attr(),
        resModelName: attr(),
        /**
         * States the position of the group inside the notification list.
         */
        sequence: attr({
            compute: '_computeSequence',
            default: 0,
        }),
        /**
         * Related thread when the notification group concerns a single thread.
         */
        thread: many2one('mail.thread', {
            compute: '_computeThread',
        })
    };
    NotificationGroup.identifyingFields = ['id'];
    NotificationGroup.modelName = 'mail.notificationGroup';

    return NotificationGroup;
}

registerNewModel('mail.notificationGroup', factory);
