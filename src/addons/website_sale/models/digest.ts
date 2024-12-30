import { Fields } from "../../../core";
import { AccessError } from "../../../core/helper";
import { _super } from "../../../core/models";
import { MetaModel, Model } from "../../../core/models"
import { f, sum } from "../../../core/tools";

@MetaModel.define()
class Digest extends Model {
    static _module = module;
    static _parents = 'digest.digest';

    static kpiWebsiteSaleTotal = Fields.Boolean('eCommerce Sales');
    static kpiWebsiteSaleTotalValue = Fields.Monetary({compute: '_computeKpiWebsiteSaleTotalValue'});

    async _computeKpiWebsiteSaleTotalValue() {
        if (! await (await this.env.user()).hasGroup('sales_team.groupSaleSalesmanAllLeads')) {
            throw new AccessError(await this._t("Do not have access, skip this data for user's digest email"));
        }
        for (const record of this) {
            const [start, end, company] = await record._getKpiComputeParameters();
            const confirmedWebsiteSales = await this.env.items('sale.order').search([
                ['dateOrder', '>=', start],
                ['dateOrder', '<', end],
                ['state', 'not in', ['draft', 'cancel', 'sent']],
                ['websiteId', '!=', false],
                ['companyId', '=', company.id]
            ]);
            await record.set('kpiWebsiteSaleTotalValue', sum(await confirmedWebsiteSales.mapped('amountTotal')));
        }
    }

    async _computeKpisActions(company, user) {
        const res = await _super(Digest, this)._computeKpisActions(company, user);
        res['kpiWebsiteSaleTotal'] = f('website.backendDashboard&menuId=%s', (await this.env.ref('website.menuWebsiteConfiguration')).id);
        return res;
    }
}
