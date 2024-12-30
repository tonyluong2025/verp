import { Fields, api } from "../../../core";
import { MetaModel, Model, _super } from "../../../core/models";
import { bool, len } from "../../../core/tools";

@MetaModel.define()
class Partner extends Model {
    static _module = module;
    static _name = 'res.partner';
    static _parents = 'res.partner';

    static teamId = Fields.Many2one('crm.team', { string: 'Sales Team', ondelete: "SET NULL" });
    static opportunityIds = Fields.One2many('crm.lead', 'partnerId', { string: 'Opportunities', domain: [['type', '=', 'opportunity']] });
    static opportunityCount = Fields.Integer("Opportunity", { compute: '_computeOpportunityCount' });

    @api.model()
    async defaultGet(fields) {
        const rec = await _super(Partner, this).defaultGet(fields);
        const activeModel = this.env.context['activeModel'];
        if (activeModel === 'crm.lead' && len(this.env.context['activeIds'] ?? []) <= 1) {
            let lead = await this.env.items(activeModel).browse(this.env.context['activeId']).exists();
            if (bool(lead)) {
                lead = await lead.getDict(['phone', 'mobile', 'method', 'title', 'website', 'street', 'street2', 'city', 'stateId', 'countryId', 'zip']);
                rec.update({
                    phone: lead.phone,
                    mobile: lead.mobile,
                    position: lead.position,
                    title: lead.title.id,
                    website: lead.website,
                    street: lead.street,
                    street2: lead.street2,
                    city: lead.city,
                    stateId: lead.stateId.id,
                    countryId: lead.countryId.id,
                    zip: lead.zip,
                });
            }
        }
        return rec;
    }

    async _computeOpportunityCount() {
        // retrieve all children partners and prefetch 'parentId' on them
        const allPartners = await (await this.withContext({ activeTest: false })).search([['id', 'childOf', this.ids]]);
        await allPartners.read(['parentId']);

        const opportunityData = await (await this.env.items('crm.lead').withContext({ activeTest: false })).readGroup(
            [['partnerId', 'in', allPartners.ids]], ['partnerId'], ['partnerId']
        )

        await this.set('opportunityCount', 0);
        for (const group of opportunityData) {
            let partner = this.browse(group['partnerId'][0]);
            while (bool(partner)) {
                if (this.includes(partner)) {
                    await partner.set('opportunityCount', await partner.opportunityCount + group['partnerId_count']);
                }
                partner = await partner.parentId;
            }
        }
    }

    /**
     * This method returns an action that displays the opportunities from partner.
     * @returns 
     */
    async actionViewOpportunity() {
        const action = await this.env.items('ir.actions.actions')._forXmlid('crm.crmLeadOpportunities');
        action['context'] = { 'activeTest': false }
        if (await this['isCompany']) {
            action['domain'] = [['partnerId.commercialPartnerId.id', '=', this.id]];
        }
        else {
            action['domain'] = [['partnerId.id', '=', this.id]];
        }
        return action;
    }
}