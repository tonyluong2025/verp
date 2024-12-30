import { Fields } from "../../../core";
import { MetaModel, TransientModel } from "../../../core/models"

@MetaModel.define()
class ResConfigSettings extends TransientModel {
    static _module = module;
    static _parents = 'res.config.settings';

    static partnerAutocompleteInsufficientCredit = Fields.Boolean('Insufficient credit', {compute: "_computePartnerAutocompleteInsufficientCredit"});

    async _computePartnerAutocompleteInsufficientCredit() {
        await this.set('partnerAutocompleteInsufficientCredit', await this.env.items('iap.account').getCredits('partner_autocomplete') <= 0);
    }

    async redirectToBuyAutocompleteCredit() {
        const account = this.env.items('iap.account');
        return {
            'type': 'ir.actions.acturl',
            'url': await account.getCreditsUrl('partner_autocomplete'),
            'target': '_new',
        }
    }
}