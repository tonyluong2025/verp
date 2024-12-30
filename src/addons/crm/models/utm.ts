import { Fields } from "../../../core";
import { MetaModel, Model } from "../../../core/models";

@MetaModel.define()
class UtmCampaign extends Model {
    static _module = module;
    static _parents = 'utm.campaign';

    static useLeads = Fields.Boolean('Use Leads', { compute: '_computeUseLeads' });
    static crmLeadCount = Fields.Integer('Leads/Opportunities count', { groups: 'sales_team.groupSaleSalesman', compute: "_computeCrmLeadCount" });

    async _computeUseLeads() {
        await this.set('useLeads', await (await this.env.user()).hasGroup('crm.groupUseLead'));
    }

    async _computeCrmLeadCount() {
        const leadData = await (await this.env.items('crm.lead').withContext({ activeTest: false })).readGroup([
            ['campaignId', 'in', this.ids]],
            ['campaignId'], ['campaignId']);
        const mappedData = Object.fromEntries(leadData.map(datum => [datum['campaignId'][0], datum['campaignId_count']]));
        for (const campaign of this) {
            await campaign.set('crmLeadCount', mappedData[campaign.id] ?? 0);
        }
    }

    async actionRedirectToLeadsOpportunities() {
        const view = await this['useLeads'] ? 'crm.crmLeadAllLeads' : 'crm.crmLeadOpportunities';
        const action = await this.env.items('ir.actions.actions')._forXmlid(view);
        action['viewMode'] = 'tree,kanban,graph,pivot,form,calendar';
        action['domain'] = [['campaignId', 'in', this.ids]];
        action['context'] = { 'activeTest': false, 'create': false }
        return action;
    }
}
