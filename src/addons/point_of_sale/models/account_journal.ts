import { Fields, api } from "../../../core";
import { ValidationError } from "../../../core/helper";
import { MetaModel, Model, _super } from "../../../core/models"
import { bool } from "../../../core/tools";

@MetaModel.define()
class AccountJournal extends Model {
    static _module = module;
    static _parents = 'account.journal';

    static posPaymentMethodIds = Fields.One2many('pos.payment.method', 'journalId', {string: 'Point of Sale Payment Methods'});

    @api.constrains('type')
    async _checkType() {
        const methods = await (await this.env.items('pos.payment.method').sudo()).search([["journalId", "in", this.ids]]);
        if (bool(methods)) {
            throw new ValidationError(await this._t("This journal is associated with a payment method. You cannot modify its type"));
        }
    }

    async _getJournalInboundOutstandingPaymentAccounts() {
        const res = await _super(AccountJournal, this)._getJournalInboundOutstandingPaymentAccounts();
        const accountIds = new Set(res.ids);
        for (const paymentMethod of await (await this.sudo()).posPaymentMethodIds) {
            accountIds.add((await (await paymentMethod.outstandingAccountId)).id || (await (await this['companyId']).accountJournalPaymentDebitAccountId).id);
        }
        return this.env.items('account.account').browse(accountIds);
    }
}