import { Fields } from "../../../core/fields";
import { AccessError } from "../../../core/helper";
import { MetaModel, Model, _super } from "../../../core/models";
import { f } from "../../../core/tools";

@MetaModel.define()
class Digest extends Model {
  static _module = module;
  static _parents = 'digest.digest';

  static kpiAccountTotalRevenue = Fields.Boolean('Revenue');
  static kpiAccountTotalRevenueValue = Fields.Monetary({ compute: '_computeKpiAccountTotalRevenueValue' });

  async _computeKpiAccountTotalRevenueValue() {
    if (! await (await this.env.user()).hasGroup('account.groupAccountInvoice')) {
      throw new AccessError(await this._t("Do not have access, skip this data for user's digest email"));
    }
    for (const record of this) {
      const [start, end, company] = await record._getKpiComputeParameters();
      const res = await this._cr.execute(`
          SELECT -SUM(line.balance) AS total
          FROM "accountMoveLine" line
          JOIN "accountMove" move ON move.id = line."moveId"
          JOIN "accountAccount" account ON account.id = line."accountId"
          WHERE line."companyId" = $1 AND line.date > $2::DATE AND line.date <= $3::DATE
          AND account."internalGroup" = 'income'
          AND move.state = 'posted'
      `, { bind: [company.id, start, end] });
      await record.set('kpiAccountTotalRevenueValue', res.length && res[0]['total'] || 0.0);
    }
  }

  async _computeKpisActions(company, user) {
    const res = await _super(Digest, this)._computeKpisActions(company, user);
    res['kpiAccountTotalRevenue'] = f('account.actionMoveOutInvoiceType&menuId=%s', (await this.env.ref('account.menuFinance')).id);
    return res;
  }
}