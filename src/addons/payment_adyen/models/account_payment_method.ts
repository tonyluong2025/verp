import { api } from "../../../core";
import { _super, MetaModel, Model } from "../../../core/models"

@MetaModel.define()
class AccountPaymentMethod extends Model {
    static _module = module;
    static _parents = 'account.payment.method';

    @api.model()
    async _getPaymentMethodInformation() {
        const res = await _super(AccountPaymentMethod, this)._getPaymentMethodInformation();
        res['adyen'] = {'mode': 'unique', 'domain': [['type', '=', 'bank']]}
        return res;
    }
}