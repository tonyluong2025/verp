import { api } from "../../../core";
import { MetaModel, Model, _super } from "../../../core/models";
import { bool } from "../../../core/tools";

@MetaModel.define()
class ResCompany extends Model {
  static _module = module;
  static _parents = "res.company";

  @api.modelCreateMulti()
  async create(valsList) {
    const companies = await _super(ResCompany, this).create(valsList);
    const ProductPricelist = this.env.items('product.pricelist');
    for (const newCompany of companies) {
      const currency = await newCompany.currencyId;
      let pricelist = await ProductPricelist.search([
        ['currencyId', '=', currency.id],
        ['companyId', '=', false]
      ], {limit: 1})
      if (! bool(pricelist)) {
        const params = {'currency': await currency.label}
        pricelist = await ProductPricelist.create({
          'label': await this._t("Default {currency} pricelist", params),
          'currencyId': currency.id,
        })
      }
      await this.env.items('ir.property')._setDefault(
        'propertyProductPricelist',
        'res.partner',
        pricelist,
        newCompany,
      )
    }
    return companies;
  }

  async write(values) {
    // When we modify the currency of the company, we reflect the change on the list0 pricelist, if
    // that pricelist is not used by another company. Otherwise, we create a new pricelist for the
    // given currency.
    const ProductPricelist = this.env.items('product.pricelist');
    const currencyId = values['currencyId']
    const mainPricelist = await this.env.ref('product.list0', false);
    if (bool(currencyId) && mainPricelist) {
      const nbCompanies = await this.searchCount([]);
      for (const company of this) {
        const comCurrencyId = await company.currencyId;
        const existingPricelist = await ProductPricelist.search(
          [['companyId', 'in', [false, company.id]],
          ['currencyId', 'in', [currencyId, comCurrencyId.id]]]);
        if (existingPricelist.ok && await existingPricelist.some(async (x) => currencyId == (await x.currencyId).id)) {
          continue;
        }
        if (currencyId == comCurrencyId.id) {
          continue;
        }
        const currencyMatch = (await mainPricelist.currencyId).eq(comCurrencyId);
        const mainCompanyId = await mainPricelist.companyId;
        const companyMatch = mainCompanyId.eq(company) || (mainCompanyId.id === false && nbCompanies == 1);
        if (currencyMatch && companyMatch) {
          await mainPricelist.write({'currencyId': currencyId});
        }
        else {
          const params = {'currency': await this.env.items('res.currency').browse(currencyId).label}
          const pricelist = await ProductPricelist.create({
            'label': await this._t("Default {currency} pricelist", params),
            'currencyId': currencyId,
          })
          await this.env.items('ir.property')._setDefault(
            'propertyProductPricelist',
            'res.partner',
            pricelist,
            company,
          )
        }
      }
    }
    return _super(ResCompany, this).write(values);
  }
}