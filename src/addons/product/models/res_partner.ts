import { Fields, api } from "../../../core";
import { MetaModel, Model, _super } from "../../../core/models"
import { bool } from "../../../core/tools/bool";
import { f } from "../../../core/tools/utils";

@MetaModel.define()
class Partner extends Model {
  static _module = module;
  static _name = 'res.partner';
  static _parents = 'res.partner';

  // NOT A REAL PROPERTY !!!!
  static propertyProductPricelist = Fields.Many2one(
    'product.pricelist', {string: 'Pricelist', compute: '_computeProductPricelist', inverse: "_inverseProductPricelist", companyDependent: false, domain: async (self) => [['companyId', 'in', [(await self.env.company()).id, false]]], help: "This pricelist will be used, instead of the default one, for sales to the current partner"});

  @api.depends('countryId')
  @api.dependsContext('company')
  async _computeProductPricelist(req) {
    const company = (await this.env.company()).id;
    const res = await this.env.items('product.pricelist')._getPartnerPricelistMulti(req, this.ids, company);
    for (const p of this) {
      await p.set('propertyProductPricelist', res[p.id]);
    }
  }

  async _inverseProductPricelist() {
    for (const partner of this) {
      const countryId = await partner.countryId;
      const pls = await this.env.items('product.pricelist').search(
        [['countryGroupIds.countryIds.code', '=', bool(countryId) && await countryId.code || false]], {limit: 1}
      );
      const defaultForCountry = bool(pls) && pls[0];
      const actual = await this.env.items('ir.property')._get('propertyProductPricelist', 'res.partner', f('res.partner,%s', partner.id));
      // update at each change country, and so erase old pricelist
      if (bool(await partner.propertyProductPricelist) || (bool(actual) && bool(defaultForCountry) && defaultForCountry.id != actual.id)) {
        // keep the company of the current user before sudo
        await this.env.items('ir.property')._setMulti(
          'propertyProductPricelist',
          partner._name,
          {[partner.id]: await partner.propertyProductPricelist ?? defaultForCountry.id},
          defaultForCountry.id
        );
      }
    }
  }
  
  @api.model()
  _commercialFields() {
    return _super(Partner, this)._commercialFields().concat( ['propertyProductPricelist']);
  }
}