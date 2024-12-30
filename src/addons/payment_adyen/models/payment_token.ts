import { Fields } from "../../../core";
import { UserError, ValidationError } from "../../../core/helper";
import { _super, MetaModel, Model } from "../../../core/models"
import { isInstance } from "../../../core/tools";

@MetaModel.define()
class PaymentToken extends Model {
    static _module = module;
    static _parents = 'payment.token';

    static adyenShopperReference = Fields.Char({
        string: "Shopper Reference", help: "The unique reference of the partner owning this token",
        readonly: true});

    //=== BUSINESS METHODS ===#

    /**
     * Override of payment to request request Adyen to delete the token.

        Note: this.ensureOne()

        :return: void
     * @returns 
     */
    async _handleDeactivationRequest() {
        await _super(PaymentToken, this)._handleDeactivationRequest();
        if (await this['provider'] !== 'adyen') {
            return;
        }

        const data = {
            'merchantAccount': await (await this['acquirerId']).adyenMerchantAccount,
            'shopperReference': await this['adyenShopperReference'],
            'recurringDetailReference': await this['acquirerRef'],
        }
        try {
            await (await this['acquirerId'])._adyenMakeRequest('adyenRecurringApiUrl', '/disable', null, data, 'POST');
        } catch(e) {
            if (!isInstance(e, ValidationError)) {
                throw e; // Deactivating the token in Verp is more important than in Adyen
            }
        }
    }

    /**
     * Override of payment to raise an error informing that Adyen tokens cannot be restored.

        Note: this.ensureOne()

        :return: void
        :raise: UserError if the token is managed by Adyen
     * @returns 
     */
    async _handleReactivationRequest() {
        await _super(PaymentToken, this)._handleReactivationRequest();
        if (await this['provider'] !== 'adyen') {
            return;
        }

        throw new UserError(await this._t("Saved payment methods cannot be restored once they have been deleted."));
    }
}