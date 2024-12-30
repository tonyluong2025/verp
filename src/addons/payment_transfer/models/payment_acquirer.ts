import { api, Fields } from "../../../core";
import { _super, MetaModel, Model } from "../../../core/models"
import { len } from "../../../core/tools";

@MetaModel.define()
class PaymentAcquirer extends Model {
    static _module = module;
    static _parents = 'payment.acquirer';

    static provider = Fields.Selection({
        selectionAdd: [['transfer', "Wire Transfer"]], default: 'transfer',
        ondelete: {'transfer': 'SET DEFAULT'}});
    static qrCode = Fields.Boolean(
        {string: "Enable QR Codes", help: "Enable the use of QR-codes when paying by wire transfer."});

    /**
     * Override of payment to hide the credentials page.

        :return: void
     */
    @api.depends('provider')
    async _computeViewConfigurationFields() {
        await _super(PaymentAcquirer, this)._computeViewConfigurationFields();
        await (await this.filtered(async (acq) => await acq.provider === 'transfer')).write({
            'showCredentialsPage': false,
            'showPaymentIconIds': false,
            'showPreMsg': false,
            'showDoneMsg': false,
            'showCancelMsg': false,
        });
    }

    /**
     * Make sure to have a pending_msg set.
     * @param valuesList 
     */
    @api.modelCreateMulti()
    async create(valuesList) {
        // This is done here and not in a default to have access to all required values.
        const acquirers = await _super(PaymentAcquirer, this).create(valuesList);
        await acquirers._transferEnsurePendingMsgIsSet();
        return acquirers;
    }

    /**
     * Make sure to have a pendingMsg set.
     * @param values 
     */
    async write(values) {
        // This is done here and not in a default to have access to all required values.
        const res = await _super(PaymentAcquirer, this).write(values);
        await this._transferEnsurePendingMsgIsSet();
        return res;
    }

    async _transferEnsurePendingMsgIsSet() {
        for (const acquirer of await this.filtered(async (a) => await a.provider === 'transfer' && ! await a.pendingMsg)) {
            const companyId = (await acquirer.companyId).id;
            // filter only bank accounts marked as visible
            const accounts = await (await this.env.items('account.journal').search([
                ['type', '=', 'bank'], ['companyId', '=', companyId]
            ])).bankAccountId;
            await acquirer.set('pendingMsg', `<div>
                <h3>${await this._t("Please use the following transfer details")}</h3>
                <h4>${len(accounts) == 1 ? await this._t("Bank Account") : await this._t("Bank Accounts")}</h4>
                <ul>${(await accounts.map(async (account) => `<li>${await account.displayName}</li>`)).join('')}</ul>
                <h4>${await this._t("Communication")}</h4>
                <p>${await this._t("Please use the order name as communication reference.")}</p>
                </div>`);
        }
    }
}
