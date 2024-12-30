import { _super, MetaModel, TransientModel } from "../../../core/models"

@MetaModel.define()
class MailComposeMessage extends TransientModel {
    static _module = module;
    static _parents = 'mail.compose.message';

    async _actionSendMail(autoCommit=false) {
        const context = this._context;
        // TODO TDE: clean that brole one day
        if (context['websiteSaleSendRecoveryEmail'] && await this['model'] === 'sale.order' && context['activeIds']) {
            await (await this.env.items('sale.order').search([
                ['id', 'in', context['activeIds']],
                ['cartRecoveryEmailSent', '=', false],
                ['isAbandonedCart', '=', true]
            ])).write({'cartRecoveryEmailSent': true});
        }
        return _super(MailComposeMessage, this)._actionSendMail({autoCommit});
    }
}
