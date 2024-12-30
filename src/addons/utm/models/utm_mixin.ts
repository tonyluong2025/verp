import { Fields, api } from "../../../core";
import { MetaModel, AbstractModel, _super } from "../../../core/models"
import { bool } from "../../../core/tools";

/**
 * Mixin class for objects which can be tracked by marketing.
 */
@MetaModel.define()
class UtmMixin extends AbstractModel {
    static _module = module;
    static _name = 'utm.mixin';
    static _description = 'UTM Mixin';

    static campaignId = Fields.Many2one('utm.campaign', {string: 'Campaign', help: "This is a name that helps you keep track of your different campaign efforts, e.g. Fall_Drive, Christmas_Special"});
    static sourceId = Fields.Many2one('utm.source', {string: 'Source', help: "This is the source of the link, e.g. Search Engine, another domain, or name of email list"});
    static mediumId = Fields.Many2one('utm.medium', {string: 'Medium', help: "This is the method of delivery, e.g. Postcard, Email, or Banner Ad"});

    @api.model()
    async defaultGet(fields) {
        const values = await _super(UtmMixin, this).defaultGet(fields);

        // We ignore UTM for salesmen, except some requests that could be done as superuser_id to bypass access rights.
        if (! await this.env.isSuperuser() && await (await this.env.user()).hasGroup('sales_team.groupSaleSalesman')) {
            return values;
        }

        for (const [urlParam, fieldName, cookieName] of this.env.items('utm.mixin').trackingFields()) {
            if (fields.includes(fieldName)) {
                const field = this._fields[fieldName];
                let value = false;
                const req = this.env.req;
                if (this.env.req) {
                    // ir_http dispatch saves the url params in a cookie
                    value = req.httpRequest.cookie[cookieName];
                }
                // if we receive a string for a many2one, we search/create the id
                if (field.type === 'many2one' && typeof(value) === 'string' && value) {
                    const model = this.env.items(field.comodelName);
                    let records = await model.search([['label', '=', value]], {limit: 1});
                    if (! records.ok) {
                        if ('isAutoCampaign' in records._fields) {
                            records = await model.create({'label': value, 'isAutoCampaign': true});
                        }
                        else {
                            records = await model.create({'label': value});
                        }
                    }
                    value = records.id;
                }
                if (bool(value)) {
                    values[fieldName] = value;
                }
            }
        }
        return values;
    }

    trackingFields() {
        // This function cannot be overridden in a model which inherit utm.mixin
        // Limitation by the heritage on AbstractModel
        // record_crm_lead.tracking_fields() will call tracking_fields() from module utm.mixin (if not overridden on crm.lead)
        // instead of the overridden method from utm.mixin.
        // To force the call of overridden method, we use this.env.items('utm.mixin'].tracking_fields() which respects overridden
        // methods of utm.mixin, but will ignore overridden method on crm.lead
        return [
            // ("URL_PARAMETER", "FIELD_NAME_MIXIN", "NAME_IN_COOKIES")
            ['utmCampaign', 'campaignId', 'verp_utm_campaign'],
            ['utmSource', 'sourceId', 'verp_utm_source'],
            ['utmMedium', 'mediumId', 'verp_utm_medium'],
        ]
    }
}