import { api } from "../../../core";
import { AbstractModel, MetaModel } from "../../../core/models"
import { iapJsonrpc } from "../tools/iap_tools";

@MetaModel.define()
class IapEnrichAPI extends AbstractModel {
    static _module = module;
    static _name = 'iap.enrich.api';
    static _description = 'IAP Lead Enrichment API';
    
    _DEFAULT_ENDPOINT = 'https://iap-services.theverp.com';

    @api.model()
    async _contactIap(localEndpoint: string, params: {}) {
        const account = await this.env.items('iap.account').get('reveal');
        const sudo = await this.env.items('ir.config.parameter').sudo();
        const dbuuid = await sudo.getParam('database.uuid');
        params['accountToken'] = await account.accountToken;
        params['dbuuid'] = dbuuid;
        const baseUrl = await sudo.getParam('enrich.endpoint', this._DEFAULT_ENDPOINT);
        return iapJsonrpc(this.env, baseUrl + localEndpoint, {method: 'call', params: params, timeout: 300});
    }

    /**
     * Contact endpoint to get enrichment data.

        :param leadEmails: dict{leadId: email}
        :return: dict{leadId: company data or false}
        :raise: several errors, notably
          * InsufficientCreditError: {
                "credit": 4.0,
                "serviceName": "reveal",
                "baseUrl": "https://iap.theverp.com/iap/1/credit",
                "message": "You don't have enough credits on your account to use this service."
            }
     * @param leadEmails 
     * @returns 
     */
    @api.model()
    async _requestEnrich(leadEmails: {}) {
        const params = {
            'domains': leadEmails,
        }
        return this._contactIap('/iap/clearbit/1/lead_enrichment_email', params);
    }
}