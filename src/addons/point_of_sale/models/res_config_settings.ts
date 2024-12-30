import { Fields } from "../../../core";
import { MetaModel, TransientModel, _super } from "../../../core/models"

@MetaModel.define()
class ResConfigSettings extends TransientModel {
    static _module = module;
    static _parents = 'res.config.settings';

    static saleTaxId = Fields.Many2one('account.tax', {string: "Default Sale Tax", related: 'companyId.accountSaleTaxId', readonly: false});
    static modulePosMercury = Fields.Boolean({string: "Vantiv Payment Terminal", help: "The transactions are processed by Vantiv. Set your Vantiv credentials on the related payment method."});
    static modulePosAdyen = Fields.Boolean({string: "Adyen Payment Terminal", help: "The transactions are processed by Adyen. Set your Adyen credentials on the related payment method."});
    static modulePosSix = Fields.Boolean({string: "Six Payment Terminal", help: "The transactions are processed by Six. Set the IP address of the terminal on the related payment method."});
    static updateStockQuantities = Fields.Selection({related: "companyId.pointOfSaleUpdateStockQuantities", readonly: false});
    static modulePosCoupon = Fields.Boolean("Coupon and Promotion Programs", {help: "Allow the use of coupon and promotion programs in PoS."});
    static accountDefaultPosReceivableAccountId = Fields.Many2one({string: 'Default Account Receivable (PoS)', related: 'companyId.accountDefaultPosReceivableAccountId', readonly: false});
    static modulePosGiftCard = Fields.Boolean("Gift Cards", {help: "Allow the use of gift card"});

    async setValues() {
        await _super(ResConfigSettings, this).setValues();
        if (! await this['groupProductPricelist']) {
            const configs = await this.env.items('pos.config').search([['usePricelist', '=', true]]);
            for (const config of configs) {
                await config.set('usePricelist', false);
            }
        }
    }
}