import { api } from "../../../core";
import { Fields } from "../../../core/fields";
import { UserError } from "../../../core/helper/errors";
import { MetaModel, TransientModel, _super } from "../../../core/models";
import { cleanContext } from "../../../core/tools";
import { len } from "../../../core/tools/iterable";

@MetaModel.define()
class ProductReplenish extends TransientModel {
  static _module = module;
  static _name = 'product.replenish';
  static _description = 'Product Replenish';

  static productId = Fields.Many2one('product.product', { string: 'Product', required: true });
  static productTemplateId = Fields.Many2one('product.template', { string: 'Product Template', required: true });
  static productHasVariants = Fields.Boolean('Has variants', { default: false, required: true });
  static productUomCategoryId = Fields.Many2one('uom.category', { related: 'productId.uomId.categoryId', readonly: true, required: true });
  static productUomId = Fields.Many2one('uom.uom', { string: 'Unity of measure', required: true });
  static quantity = Fields.Float('Quantity', { default: 1, required: true });
  static datePlanned = Fields.Datetime('Scheduled Date', { required: true, help: "Date at which the replenishment should take place." });
  static warehouseId = Fields.Many2one(
    'stock.warehouse', {
      string: 'Warehouse', required: true,
    domain: "[['companyId', '=', companyId]]"
  });
  static routeIds = Fields.Many2many(
    'stock.location.route', {
      string: 'Preferred Routes',
    help: "Apply specific route(s) for the replenishment instead of product's default routes.",
    domain: "['|', ['companyId', '=', false], ['companyId', '=', companyId]]"
  });
  static companyId = Fields.Many2one('res.company');

  @api.model()
  async defaultGet(fields) {
    const res = await _super(ProductReplenish, this).defaultGet(fields);
    let productTemplateId = this.env.items('product.template');
    if (fields.includes('productId')) {
      if (this.env.context['default_productId']) {
        const productId = this.env.items('product.product').browse(this.env.context['default_productId']);
        productTemplateId = await productId.productTemplateId;
        res['productTemplateId'] = productTemplateId.id
        res['productId'] = productId.id
      }
      else if (this.env.context['default_productTemplateId']) {
        productTemplateId = this.env.items('product.template').browse(this.env.context['default_productTemplateId']);
        res['productTemplateId'] = productTemplateId.id;
        res['productId'] = (await productTemplateId.productVariantId).id
        if (len(await productTemplateId.productVariantIds) > 1) {
          res['productHasVariants'] = true;
        }
      }
    }
    let company = await productTemplateId.companyId;
    company = company.ok ? company : await this.env.company();
    if (fields.includes('productUomId')) {
      res['productUomId'] = (await productTemplateId.uomId).id;
    }
    if (fields.includes('companyId')) {
      res['companyId'] = company.id;
    }
    if (fields.includes('warehouseId') && !('warehouseId' in res)) {
      const warehouse = await this.env.items('stock.warehouse').search([['companyId', '=', company.id]], { limit: 1 });
      res['warehouseId'] = warehouse.id
    }
    if (fields.includes('datePlanned')) {
      res['datePlanned'] = Date.now();
    }
    return res;
  }

  async launchReplenishment() {
    const [productId, productUomId, quantity, warehouseId] = await this('productId', 'productUomId', 'quantity', 'warehouseId');
    const uomReference = await productId.uomId;
    await this.set('quantity', await productUomId._computeQuantity(quantity, uomReference));
    try {
      await (await this.env.items('procurement.group').withContext(cleanContext(this.env.context))).run([
        await this.env.items('procurement.group').Procurement(
          productId,
          quantity,
          uomReference,
          await warehouseId.lotStockId,  // Location
          await this._t("Manual Replenishment"),  // Name
          await this._t("Manual Replenishment"),  // Origin
          await warehouseId.companyId,
          this._prepareRunValues()  // Values
        )
      ])
    } catch (e) {
      throw new UserError(e.mssage);
    }
  }

  async _prepareRunValues() {
    const replenishment = await this.env.items('procurement.group').create({});
    const [warehouseId, routeIds, datePlanned] = await this('warehouseId', 'routeIds', 'datePlanned');
    const values = {
      'warehouseId': warehouseId,
      'routeIds': routeIds,
      'datePlanned': datePlanned,
      'groupId': replenishment,
    }
    return values;
  }
}