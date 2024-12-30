import { _super, MetaModel, TransientModel } from "../../../core/models"

@MetaModel.define()
class MailComposeMessage extends TransientModel {
    static _module = module;
    static _parents = 'mail.compose.message';

    async _actionSendMail(autoCommit=false) {
        if (await this['model'] === 'sale.order') {
            let self = await this.withContext({mailingDocumentBased: true});
            if (self.env.context['markSoAsSent']) {
                self = await self.withContext({mailNotifyAuthor: (await self.partnerIds).includes(await (await self.env.user()).partnerId)});
            }
        }
        return _super(MailComposeMessage, self)._actionSendMail({autoCommit});
    }
}
