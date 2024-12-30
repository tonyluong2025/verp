import { api } from "../../../core";
import { MetaModel, Model } from "../../../core/models"

@MetaModel.define()
class AccountMove extends Model {
    static _module = module;
    static _parents = "account.move";

    @api.model()
    async _getInvoiceInPaymentState() {
        return 'inPayment';
    }
}
