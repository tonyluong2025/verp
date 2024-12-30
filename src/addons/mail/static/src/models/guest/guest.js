/** @verp-module **/

import { attr, one2many, one2one } from '@mail/model/model_field';
import { registerNewModel } from '@mail/model/model_core';

function factory(dependencies) {

    class Guest extends dependencies['mail.model'] {

        //----------------------------------------------------------------------
        // Public
        //----------------------------------------------------------------------

        /**
         * @static
         * @param {Object} param0
         * @param {number} param0.id The id of the guest to rename.
         * @param {string} param0.label The new name to use to rename the guest.
         */
        static async performRpcGuestUpdateName({ id, label }) {
            await this.env.services.rpc({
                route: '/mail/guest/updateName',
                params: {
                    guestId: id,
                    label,
                },
            });
        }

        //----------------------------------------------------------------------
        // Private
        //----------------------------------------------------------------------

        /**
         * @private
         * @returns {string}
         */
        _computeAvatarUrl() {
            return `/web/image/mail.guest/${this.id}/avatar128?unique=${this.label}`;
        }

    }

    Guest.fields = {
        authoredMessages: one2many('mail.message', {
            inverse: 'guestAuthor',
        }),
        avatarUrl: attr({
            compute: '_computeAvatarUrl',
        }),
        id: attr({
            required: true,
            readonly: true,
        }),
        label: attr(),
        rtcSessions: one2many('mail.rtcSession', {
            inverse: 'guest',
        }),
        volumeSetting: one2one('mail.volumeSetting', {
            inverse: 'guest',
        }),
    };
    Guest.identifyingFields = ['id'];
    Guest.modelName = 'mail.guest';

    return Guest;
}

registerNewModel('mail.guest', factory);
