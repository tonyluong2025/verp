import { Fields, api } from "../../../core";
import { MetaModel, Model, _super } from "../../../core/models"
import { bool } from "../../../core/tools";

@MetaModel.define()
class AccountPayment extends Model {
    static _module = module;
    static _parents = 'account.payment';

    static posPaymentMethodId = Fields.Many2one('pos.payment.method', {string: "POS Payment Method"});
    static forceOutstandingAccountId = Fields.Many2one("account.account", {string: "Forced Outstanding Account", checkCompany: true});
    static posSessionId = Fields.Many2one('pos.session', {string: "POS Session"});

    async _getValidLiquidityAccounts() {
        const res = await _super(AccountPayment, this)._getValidLiquidityAccounts();
        return res.concat([await (await this['posPaymentMethodId']).outstandingAccountId]);
    }

    /**
     * When forceOutstandingAccountId is set, we use it as the outstandingAccountId.
     */
    @api.depends("forceOutstandingAccountId")
    async _computeOutstandingAccountId() {
        await _super(AccountPayment, this)._computeOutstandingAccountId();
        for (const payment of this) {
            if (bool(await payment.forceOutstandingAccountId)) {
                await payment.set('outstandingAccountId', await payment.forceOutstandingAccountId);
            }
        }
    }
}