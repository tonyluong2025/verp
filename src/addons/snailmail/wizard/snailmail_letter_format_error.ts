import { Fields } from "../../../core";
import { MetaModel, TransientModel } from "../../../core/models"

@MetaModel.define()
class SnailmailLetterFormatError extends TransientModel {
    static _module = module;
    static _name = 'snailmail.letter.format.error';
    static _description = 'Format Error Sending a Snailmail Letter';

    static messageId = Fields.Many2one(
        'mail.message',
        {default: self => self.env.context['messageId'] ?? null}
    );
    static snailmailCover = Fields.Boolean({
        string: 'Add a Cover Page',
        default: async (self) => (await self.env.company()).snailmailCover,
    });

    async updateResendAction() {
        await (await this.env.company()).write({'snailmailCover': await this['snailmailCover']});
        const lettersToResend = await this.env.items('snailmail.letter').search([
            ['errorCode', '=', 'FORMAT_ERROR'],
        ]);
        for (const letter of lettersToResend) {
            const oldAttachment = await letter.attachmentId;
            await letter.set('attachmentId', false);
            await oldAttachment.unlink();
            await letter.write({'cover': await this['snailmailCover']})
            await letter.snailmailPrint();
        }
    }

    async cancelLetterAction() {
        await (await this['messageId']).cancelLetter();
    }
}