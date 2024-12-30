import { Fields } from "../../../core";
import { AccessError } from "../../../core/helper";
import { MetaModel, Model, _super } from "../../../core/models";
import { f } from "../../../core/tools";

@MetaModel.define()
class Digest extends Model {
    static _module = module;
    static _parents = 'digest.digest';

    static kpiCrmLeadCreated = Fields.Boolean('New Leads/Opportunities');
    static kpiCrmLeadCreatedValue = Fields.Integer({ compute: '_computeKpiCrmLeadCreatedValue' });
    static kpiCrmOpportunitiesWon = Fields.Boolean('Opportunities Won');
    static kpiCrmOpportunitiesWonValue = Fields.Integer({ compute: '_computeKpiCrmOpportunitiesWonValue' });

    async _computeKpiCrmLeadCreatedValue() {
        if (! await (await this.env.user()).hasGroup('sales_team.groupSaleSalesman')) {
            throw new AccessError(await this._t("Do not have access, skip this data for user's digest email"));
        }
        for (const record of this) {
            const [start, end, company] = await record._getKpiComputeParameters();
            await record.set('kpiCrmLeadCreatedValue', await this.env.items('crm.lead').searchCount([
                ['createdAt', '>=', start],
                ['createdAt', '<', end],
                ['companyId', '=', company.id]
            ]));
        }
    }

    async _computeKpiCrmOpportunitiesWonValue() {
        if (! await (await this.env.user()).hasGroup('sales_team.groupSaleSalesman')) {
            throw new AccessError(await this._t("Do not have access, skip this data for user's digest email"));
        }
        for (const record of this) {
            const [start, end, company] = await record._getKpiComputeParameters();
            await record.set('kpiCrmOpportunitiesWonValue', this.env.items('crm.lead').searchCount([
                ['type', '=', 'opportunity'],
                ['probability', '=', '100'],
                ['dateClosed', '>=', start],
                ['dateClosed', '<', end],
                ['companyId', '=', company.id]
            ]));
        }
    }

    async _computeKpisActions(company, user) {
        const res = await _super(Digest, this)._computeKpisActions(company, user);
        res['kpiCrmLeadCreated'] = f('crm.crmLeadActionPipeline&menuId=%s', (await this.env.ref('crm.crmMenuRoot')).id);
        res['kpiCrmOpportunitiesWon'] = f('crm.crmLeadActionPipeline&menuId=%s', (await this.env.ref('crm.crmMenuRoot')).id);
        if (await user.hasGroup('crm.groupUseLead')) {
            res['kpiCrmLeadCreated'] = f('crm.crmLeadAllLeads&menuId=%s', (await this.env.ref('crm.crmMenuRoot')).id);
        }
        return res;
    }
}