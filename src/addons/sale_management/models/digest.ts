import { Fields } from "../../../core";
import { AccessError } from "../../../core/helper";
import { _super, MetaModel, Model } from "../../../core/models"
import { f, sum } from "../../../core/tools";

@MetaModel.define()
class Digest extends Model {
    static _module = module;
    static _parents = 'digest.digest';

    static kpiAllSaleTotal = Fields.Boolean('All Sales');
    static kpiAllSaleTotalValue = Fields.Monetary({compute: '_computeKpiSaleTotalValue'});

    async _computeKpiSaleTotalValue() {
        if (! await (await this.env.user()).hasGroup('sales_team.groupSaleSalesmanAllLeads')) {
            throw new AccessError(await this._t("Do not have access, skip this data for user's digest email"));
        }
        for (const record of this) {
            const [start, end, company] = await record._getKpiComputeParameters();
            const allChannelsSales = await this.env.items('sale.report').readGroup([
                ['date', '>=', start],
                ['date', '<', end],
                ['state', 'not in', ['draft', 'cancel', 'sent']],
                ['companyId', '=', company.id]], ['priceTotal'], ['companyId']);
            await record.set('kpiAllSaleTotalValue', sum(allChannelsSales.map(channel => channel['priceTotal'])));
        }
    }

    async _computeKpisActions(company, user) {
        const res = await _super(Digest, this)._computeKpisActions(company, user);
        res['kpiAllSaleTotal'] = f('sale.reportAllChannelsSalesAction&menuId=%s', (await this.env.ref('sale.saleMenuRoot')).id);
        return res;
    }
}