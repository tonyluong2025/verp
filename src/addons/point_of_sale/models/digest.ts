import { Fields } from "../../../core";
import { AccessError } from "../../../core/helper";
import { MetaModel, Model, _super } from "../../../core/models"
import { f, sum } from "../../../core/tools";

@MetaModel.define()
class Digest extends Model {
    static _module = module;
    static _parents = 'digest.digest';

    static kpiPosTotal = Fields.Boolean('POS Sales');
    static kpiPosTotalValue = Fields.Monetary({compute: '_computeKpiPosTotalValue'});

    async _computeKpiPosTotalValue() {
        if (! await (await this.env.user()).hasGroup('point_of_sale.groupPosUser')) {
            throw new AccessError(await this._t("Do not have access, skip this data for user's digest email"));
        }
        for (const record of this) {
            const [start, end, company] = await record._getKpiComputeParameters();
            await record.set('kpiPosTotalValue', sum(await (await this.env.items('pos.order').search([
                ['dateOrder', '>=', start],
                ['dateOrder', '<', end],
                ['state', 'not in', ['draft', 'cancel', 'invoiced']],
                ['companyId', '=', company.id]
            ])).mapped('amountTotal')));
        }
    }

    async _computeKpisActions(company, user) {
        const res = await _super(Digest, this)._computeKpisActions(company, user);
        res['kpiPosTotal'] = f('point_of_sale.actionPosSaleGraph&menuId=%s', (await this.env.ref('point_of_sale.menuPointRoot')).id);
        return res;
    }
}