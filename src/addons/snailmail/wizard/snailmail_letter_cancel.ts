import { Fields, api } from "../../../core";
import { MetaModel, TransientModel } from "../../../core/models";

@MetaModel.define()
class SnailmailLetterCancel extends TransientModel {
    static _module = module;
    static _name = 'snailmail.letter.cancel';
    static _description = 'Dismiss notification for resend by model';

    static model = Fields.Char({string: 'Model'});
    static helpMessage = Fields.Char({string: 'Help message', compute: '_computeHelpMessage'});

    @api.depends('model')
    async _computeHelpMessage() {
        for (const wizard of this) {
            await wizard.set('helpMessage', await this._t("Are you sure you want to discard %s snailmail delivery failures? You won't be able to re-send these letters later!", wizard._context['unreadCounter']));
        }
    }

    async cancelResendAction() {
        const authorId = (await this.env.user()).id;
        for (const wizard of this) {
            const letters = await this.env.items('snailmail.letter').search([
                ['state', 'not in', ['sent', 'canceled', 'pending']],
                ['userId', '=', authorId],
                ['model', '=', await wizard.model]
            ]);
            for (const letter of letters) {
                await letter.cancel();
            }
        }
        return {'type': 'ir.actions.actwindow.close'}
    }
}