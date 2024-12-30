import { Fields } from "../../../core";
import { MetaModel, Model } from "../../../core/models";
import { dropViewIfExists } from "../../../core/tools";

@MetaModel.define()
class AccountAssetReport extends Model {
  static _module = module;
  static _name = "report.account.asset";
  static _description = "Assets Analysis";
  static _auto = false;

  static label = Fields.Char({ string: 'Year', required: false, readonly: true });
  static date = Fields.Date({ readonly: true });
  static depreciationDate = Fields.Date({ string: 'Depreciation Date', readonly: true });
  static assetId = Fields.Many2one('account.asset.asset', { string: 'Asset', readonly: true });
  static assetCategoryId = Fields.Many2one('account.asset.category', { string: 'Asset category', readonly: true });
  static partnerId = Fields.Many2one('res.partner', { string: 'Partner', readonly: true });
  static state = Fields.Selection([['draft', 'Draft'], ['open', 'Running'], ['close', 'Close']], { string: 'Status', readonly: true });
  static depreciationValue = Fields.Float({ string: 'Amount of Depreciation Lines', readonly: true });
  static installmentValue = Fields.Float({ string: 'Amount of Installment Lines', readonly: true });
  static moveCheck = Fields.Boolean({ string: 'Posted', readonly: true });
  static installmentNbr = Fields.Integer({ string: 'Installment Count', readonly: true });
  static depreciationNbr = Fields.Integer({ string: 'Depreciation Count', readonly: true });
  static grossValue = Fields.Float({ string: 'Gross Amount', readonly: true });
  static postedValue = Fields.Float({ string: 'Posted Amount', readonly: true });
  static unpostedValue = Fields.Float({ string: 'Unposted Amount', readonly: true });
  static companyId = Fields.Many2one('res.company', { string: 'Company', readonly: true });

  async init() {
    await dropViewIfExists(this._cr, this.cls._table);
    await this._cr.execute(`
            create or replace view "${this.cls._table}" as (
                select
                    min(dl.id) as id,
                    dl.label as label,
                    dl."depreciationDate" as "depreciationDate",
                    a.date as date,
                    (CASE WHEN dlmin.id = min(dl.id)
                      THEN a.value
                      ELSE 0
                      END) as "grossValue",
                    dl.amount as "depreciationValue",
                    dl.amount as "installmentValue",
                    (CASE WHEN dl."moveCheck"
                      THEN dl.amount
                      ELSE 0
                      END) as "postedValue",
                    (CASE WHEN NOT dl."moveCheck"
                      THEN dl.amount
                      ELSE 0
                      END) as "unpostedValue",
                    dl."assetId" as "assetId",
                    dl."moveCheck" as "moveCheck",
                    a."categoryId" as "assetCategoryId",
                    a."partnerId" as "partnerId",
                    a.state as state,
                    COUNT(dl.*)::int as "installmentNbr",
                    COUNT(dl.*)::int as "depreciationNbr",
                    a."companyId" as "companyId"
                from "accountAssetDepreciationLine" dl
                    left join "accountAssetAsset" a on (dl."assetId"=a.id)
                    left join (select min(d.id) as id,ac.id as "acId" from "accountAssetDepreciationLine" as d inner join "accountAssetAsset" as ac ON (ac.id=d."assetId") group by "acId") as dlmin on dlmin."acId"=a.id
                where a.active is true 
                group by
                    dl.amount,dl."assetId",dl."depreciationDate",dl.label,
                    a.date, dl."moveCheck", a.state, a."categoryId", a."partnerId", a."companyId",
                    a.value, a.id, a."salvageValue", dlmin.id
        )`);
  }
}