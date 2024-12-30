/** @verp-module **/

import { registerNewModel } from '@mail/model/model_core';
import { attr, many2one } from '@mail/model/model_field';
import { insert, unlinkAll } from '@mail/model/model_field_command';

function factory(dependencies) {

    class Notification extends dependencies['mail.model'] {

        //----------------------------------------------------------------------
        // Public
        //----------------------------------------------------------------------

        /**
         * @static
         * @param {Object} data
         * @return {Object}
         */
        static convertData(data) {
            const data2 = {};
            if ('failureType' in data) {
                data2.failureType = data.failureType;
            }
            if ('id' in data) {
                data2.id = data.id;
            }
            if ('notificationStatus' in data) {
                data2.notificationStatus = data.notificationStatus;
            }
            if ('notificationType' in data) {
                data2.notificationType = data.notificationType;
            }
            if ('resPartnerId' in data) {
                if (!data.resPartnerId) {
                    data2.partner = unlinkAll();
                } else {
                    data2.partner = insert({
                        displayName: data.resPartnerId[1],
                        id: data.resPartnerId[0],
                    });
                }
            }
            return data2;
        }

    }

    Notification.fields = {
        failureType: attr(),
        id: attr({
            readonly: true,
            required: true,
        }),
        message: many2one('mail.message', {
            inverse: 'notifications',
        }),
        notificationStatus: attr(),
        notificationType: attr(),
        partner: many2one('mail.partner'),
    };
    Notification.identifyingFields = ['id'];
    Notification.modelName = 'mail.notification';

    return Notification;
}

registerNewModel('mail.notification', factory);
