/** @verp-module **/

import { registerInstancePatchModel } from '@mail/model/model_core';

registerInstancePatchModel('mail.message', 'snailmail/static/src/models/message.message.js', {

    //----------------------------------------------------------------------
    // Public
    //----------------------------------------------------------------------

    /**
     * Cancels the 'snailmail.letter' corresponding to this message.
     *
     * @returns {Deferred}
     */
    async cancelLetter() {
        // the result will come from longpolling: message_notification_update
        await this.async(() => this.env.services.rpc({
            model: 'mail.message',
            method: 'cancelLetter',
            args: [[this.id]],
        }));
    },
    /**
     * Opens the action about 'snailmail.letter' format error.
     */
    openFormatLetterAction() {
        this.env.bus.trigger('do-action', {
            action: 'snailmail.snailmailLetterFormatErrorAction',
            options: {
                additionalContext: {
                    messageId: this.id,
                },
            },
        });
    },
    /**
     * Opens the action about 'snailmail.letter' missing fields.
     */
    async openMissingFieldsLetterAction() {
        const letterIds = await this.async(() => this.env.services.rpc({
            model: 'snailmail.letter',
            method: 'search',
            args: [[['messageId', '=', this.id]]],
        }));
        this.env.bus.trigger('do-action', {
            action: 'snailmail.snailmailLetterMissingRequiredFieldsAction',
            options: {
                additionalContext: {
                    default_letterId: letterIds[0],
                },
            },
        });
    },
    /**
     * Retries to send the 'snailmail.letter' corresponding to this message.
     */
    async resendLetter() {
        // the result will come from longpolling: message_notification_update
        await this.async(() => this.env.services.rpc({
            model: 'mail.message',
            method: 'sendLetter',
            args: [[this.id]],
        }));
    },
});
