import { Fields, api } from "../../../core";
import { MetaModel, Model } from "../../../core/models"
import { bool } from "../../../core/tools/bool";

@MetaModel.define()
class ResPartnerAutocompleteSync extends Model {
    static _module = module;
    static _name = 'res.partner.autocomplete.sync';
    static _description = 'Partner Autocomplete Sync';

    static partnerId = Fields.Many2one('res.partner', {string: "Partner", ondelete: 'CASCADE'});
    static synched = Fields.Boolean('Is synched', {default: false});

    @api.model()
    async startSync() {
        const toSyncItems = await this.search([['synched', '=', false]]);
        for (const toSyncItem of toSyncItems) {
            const partner = await toSyncItem.partnerId;

            const params = {
                'partnerGid': await partner.partnerGid,
            }

            if (partner.vat && await partner._isVatSyncable(await partner.vat)) {
                params['vat'] = await partner.vat;
                const [_, error] = await this.env.items('iap.autocomplete.api')._requestPartnerAutocomplete('update', params);
                if (error) {
                    console.warn('Send Partner to sync failed: %s', error);
                }
            }
            await toSyncItem.write({'synched': true});
        }
    }

    async addToQueue(partnerId) {
        let toSync = await this.search([['partnerId', '=', partnerId]]);
        if (! bool(toSync)) {
            toSync = await this.create({'partnerId': partnerId});
        }
        return toSync;
    }
}
