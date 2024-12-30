import { api } from "../../../core";
import { Fields } from "../../../core/fields";
import { MetaModel, TransientModel, _super } from "../../../core/models"

@MetaModel.define()
class ResConfigSettings extends TransientModel {
  static _module = module;
  static _parents = 'res.config.settings';

  static groupDiscountPerSoLine = Fields.Boolean("Discounts", {impliedGroup: 'product.groupDiscountPerSoLine'});
  static groupUom = Fields.Boolean("Units of Measure", {impliedGroup: 'uom.groupUom'});
  static groupProductVariant = Fields.Boolean("Variants", {impliedGroup: 'product.groupProductVariant'});
  static moduleSaleProductConfigurator = Fields.Boolean("Product Configurator");
  static moduleSaleProductMatrix = Fields.Boolean("Sales Grid Entry");
  static groupStockPackaging = Fields.Boolean('Product Packagings',
    {impliedGroup: 'product.groupStockPackaging'});
  static groupProductPricelist = Fields.Boolean("Pricelists",
    {impliedGroup: 'product.groupProductPricelist'});
  static groupSalePricelist = Fields.Boolean("Advanced Pricelists",
    {impliedGroup: 'product.groupSalePricelist',
    help: "Allows to manage different prices based on rules per category of customers. \nExample: 10% for retailers, promotion of 5 EUR on this product, etc."});
  static productPricelistSetting = Fields.Selection([
    ['basic', 'Multiple prices per product'],
    ['advanced', 'Advanced price rules (discounts, formulas)']
    ], {default: 'basic', string: "Pricelists Method", configParameter: 'product.productPricelistSetting',
    help: "Multiple prices: Pricelists with fixed price rules by product,\nAdvanced rules: enables advanced price rules for pricelists."});
  static productWeightInLbs = Fields.Selection([
    ['0', 'Kilograms'],
    ['1', 'Pounds'],
  ], {string: 'Weight unit of measure', configParameter: 'product.weightInLbs', default: '0'});
  static productVolumeVolumeInCubicFeet = Fields.Selection([
    ['0', 'Cubic Meters'],
    ['1', 'Cubic Feet'],
  ], {string: 'Volume unit of measure', configParameter: 'product.volumeInCubicFeet', default: '0'});

  /**
   * The product Configurator requires the product variants activated.
    If the user disables the product variants -> disable the product configurator as well
   */
  @api.onchange('groupProductVariant')
  async _onchangeGroupProductVariant() {
    const self: any = this;
    const groupProductVariant = await self.groupProductVariant;
    if (await self.moduleSaleProductConfigurator && ! groupProductVariant) {
      await self.set('moduleSaleProductConfigurator', false);
    }
    if (await self.moduleSaleProductMatrix && ! groupProductVariant) {
      await self.set('moduleSaleProductMatrix', false);
    }
  }

  /**
   * The product Configurator requires the product variants activated
    If the user enables the product configurator -> enable the product variants as well
   */
  @api.onchange('moduleSaleProductConfigurator')
  async _onchangeModuleSaleProductConfigurator() {
    const self: any = this;
    if (await self.moduleSaleProductConfigurator && ! await self.groupProductVariant) {
      await self.set('groupProductVariant', true);
    }
  }

  @api.onchange('groupProductPricelist')
  async _onchangeGroupSalePricelist() {
    const self: any = this;
    if (! await self.groupProductPricelist && await self.groupSalePricelist) {
      await self.set('groupSalePricelist', false);
    }
  }

  @api.onchange('productPricelistSetting')
  async _onchangeProductPricelistSetting() {
    const self: any = this;
    if (await self.productPricelistSetting === 'basic') {
      await self.set('groupSalePricelist', false);
    }
    else {
      await self.set('groupSalePricelist', true);
    }
  }

  async setValues() {
    const self: any = this;
    await _super(ResConfigSettings, self).setValues();
    if (! await self.groupDiscountPerSoLine) {
      const pl = await self.env.items('product.pricelist').search([['discountPolicy', '=', 'withoutDiscount']]);
      await pl.write({'discountPolicy': 'withDiscount'});
    }
  }

  /**
   * The product Grid Configurator requires the product Configurator activated
      If the user enables the Grid Configurator -> enable the product Configurator as well
   */
  @api.onchange('moduleSaleProductMatrix')
  async _onchangeModuleModuleSaleProductMatrix() {
    const self: any = this;
    if (await self.moduleSaleProductMatrix && ! await self.moduleSaleProductConfigurator) {
      await self.set('moduleSaleProductConfigurator', true);
    }
  }
}