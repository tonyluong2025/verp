import { _super, MetaModel, TransientModel } from "../../../core/models"
import { update } from "../../../core/tools";

@MetaModel.define()
class AccountPaymentRegister extends TransientModel {
    static _module = module;
    static _parents = 'account.payment.register';

    async _createPaymentValsFromWizard() {
        const vals = await _super(AccountPaymentRegister, this)._createPaymentValsFromWizard();
        // Make sure the account move linked to generated payment
        // belongs to the expected sales team
        // teamId field on account.payment comes from the `_inherits` on account.move model
        update(vals, {'teamId': (await (await (await this['lineIds']).moveId)[0].teamId).id});
        return vals;
    }
}