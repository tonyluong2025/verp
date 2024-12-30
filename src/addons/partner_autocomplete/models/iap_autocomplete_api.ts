import { api } from "../../../core";
import { AccessError, UserError, ValidationError, ValueError } from "../../../core/helper/errors";
import { AbstractModel, MetaModel } from "../../../core/models";
import { isInstance } from "../../../core/tools";
import { update } from "../../../core/tools/misc";
import { InsufficientCreditError, iapJsonrpc } from "../../iap/tools/iap_tools";

@MetaModel.define()
class IapAutocompleteEnrichAPI extends AbstractModel {
    static _module = module;
    static _name = 'iap.autocomplete.api';
    static _description = 'IAP Partner Autocomplete API';
    
    _DEFAULT_ENDPOINT = 'https://partner-autocomplete.theverp.com';

    @api.model()
    async _contactIap(localEndpoint, action, params, timeout: number=15) {
        if (this.env.registry.inTestMode()) {
            throw new ValidationError(await this._t('Test mode'));
        }
        const account = await this.env.items('iap.account').get('partner_autocomplete');
        if (! await account.accountToken) {
            throw new ValueError(await this._t('No account token'));
        }
        const sudo = await this.env.items('ir.config.parameter').sudo();
        const company = await this.env.company();
        update(params, {
            'dbuuid': await sudo.getParam('database.uuid'),
            'accountToken': await account.accountToken,
            'countryCode': await (await company.countryId).code,
            'zip': await company.zip,
        });
        const baseUrl = await sudo.getParam('iap.partner_autocomplete.endpoint', this._DEFAULT_ENDPOINT);
        return iapJsonrpc(this.env, baseUrl + localEndpoint + '/' + action, {method: 'call', params: params, timeout: timeout});
    }

    /**
     * Contact endpoint to get autocomplete data.

        :return tuple: results, error code
     * @param action 
     * @param params 
     * @param timeout 
     * @returns 
     */
    @api.model()
    async _requestPartnerAutocomplete(action, params, timeout: number=15) {
        let results;
        try {
            results = await this._contactIap('/iap/partner_autocomplete', action, params, timeout);
        } catch(e) {
            if (isInstance(e, ValidationError)) {
                return [false, 'Insufficient Credit'];
            }
            if (isInstance(e, AccessError, UserError) || ['ERR_HTTP_REQUEST_TIMEOUT'].includes(e.code)) {
                console.warn('Autocomplete API error: %s', e);
                return [false, String(e)];
            }
            if (isInstance(e, InsufficientCreditError)) {
                console.warn('Insufficient Credits for Autocomplete Service: %s', e);
                return [false, 'Insufficient Credit'];
            }
            if (isInstance(e, ValueError)) {
                return [false, 'No account token'];
            }
            throw e;
        }
        return [results, false];
    }
}