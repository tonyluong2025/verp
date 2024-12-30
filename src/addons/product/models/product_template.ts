import _ from "lodash";
import { api, tools } from "../../../core";
import { Fields, _Date } from "../../../core/fields";
import { Dict, MapKey } from "../../../core/helper/collections";
import { StopIteration, UserError, ValidationError } from "../../../core/helper/errors";
import { MetaModel, Model, _super } from "../../../core/models";
import { expression } from "../../../core/osv";
import { f } from "../../../core/tools";
import { bool } from "../../../core/tools/bool";
import { isImageSizeAbove } from "../../../core/tools/image";
import { extend, isList, len, nextAsync, product } from "../../../core/tools/iterable";

@MetaModel.define()
class ProductTemplate extends Model {
  static _module = module;
  static _name = "product.template";
  static _table = "productTemplate";
  static _parents = ['mail.thread', 'mail.activity.mixin', 'image.mixin'];
  static _description = "Product Template";
  static _order = "priority desc, label";

  @tools.ormcache()
  async _getDefaultCategoryId() {
    // Deletion forbidden (at least through unlink)
    return this.env.ref('product.productCategoryAll');
  }

  @tools.ormcache()
  async _getDefaultUomId() {
    // Deletion forbidden (at least through unlink)
    return this.env.ref('uom.productUomUnit');
  }

  async _readGroupCategId(categories, domain, order) {
    let categoryIds = this.env.context['default_categId'];
    if (!bool(categoryIds) && this.env.context['groupExpand']) {
      categoryIds = await categories._search([], { order: order, accessRightsUid: global.SUPERUSER_ID });
    }
    return categories.browse(categoryIds);
  }

  static label = Fields.Char('Name', { index: true, required: true, translate: true });
  static sequence = Fields.Integer('Sequence', { default: 1, help: 'Gives the sequence order when displaying a product list' });
  static description = Fields.Html(
    'Description', { translate: true });
  static descriptionPurchase = Fields.Text(
    'Purchase Description', { translate: true });
  static descriptionSale = Fields.Text(
    'Sales Description', {
      translate: true,
    help: "A description of the Product that you want to communicate to your customers. This description will be copied to every Sales Order, Delivery Order and Customer Invoice/Credit Note"
  });
  static detailedType = Fields.Selection([
    ['consu', 'Consumable'],
    ['service', 'Service']], {
      string: 'Product Type', default: 'consu', required: true,
    help: 'A storable product is a product for which you manage stock. The Inventory app has to be installed.\nA consumable product is a product for which stock is not managed.\nA service is a non-material product you provide.'
  });
  static type = Fields.Selection(
    [
      ['consu', 'Consumable'],
      ['service', 'Service']
    ],
    {
      default: 'consu',
      compute: '_computeType',
      store: true,
      readonly: false
    }
  );
  static categId = Fields.Many2one(
    'product.category', {
      string: 'Product Category',
    changeDefault: true, default: async (self) => self._getDefaultCategoryId(), groupExpand: '_readGroupCategId',
    required: true, help: "Select category for the current product"
  });
  static currencyId = Fields.Many2one(
    'res.currency', { string: 'Currency', compute: '_computeCurrencyId' });
  static costCurrencyId = Fields.Many2one(
    'res.currency', { string: 'Cost Currency', compute: '_computeCostCurrencyId' });

  // price fields
  // price: total template price, context dependent (partner, pricelist, quantity)
  static price = Fields.Float(
    'Price', {
      compute: '_computeTemplatePrice', inverse: '_setTemplatePrice',
    digits: 'Product Price'
  });
  // listPrice: catalog price, user defined
  static listPrice = Fields.Float(
    'Sales Price', {
      default: 1.0,
    digits: 'Product Price',
    help: "Price at which the product is sold to customers.",
  }
  );
  static standardPrice = Fields.Float(
    'Cost', {
      compute: '_computeStandardPrice',
    inverse: '_setStandardPrice', search: '_searchStandardPrice',
    digits: 'Product Price', groups: "base.groupUser",
    help: `In Standard Price & AVCO: value of the product (automatically computed in AVCO).
        In FIFO: value of the next unit that will leave the stock (automatically computed).
        Used to value the product when the purchase cost is not known (e.g. inventory adjustment).
        Used to compute margins on sale orders.`});

  static volume = Fields.Float(
    'Volume', { compute: '_computeVolume', inverse: '_setVolume', digits: 'Volume', store: true });
  static volumeUomName = Fields.Char({ string: 'Volume unit of measure label', compute: '_computeVolumeUomName' });
  static weight = Fields.Float(
    'Weight', {
      compute: '_computeWeight', digits: 'Stock Weight',
    inverse: '_setWeight', store: true
  });
  static weightUomName = Fields.Char({ string: 'Weight unit of measure label', compute: '_computeWeightUomName' });

  static saleOk = Fields.Boolean('Can be Sold', { default: true });
  static purchaseOk = Fields.Boolean('Can be Purchased', { default: true });
  static pricelistId = Fields.Many2one(
    'product.pricelist', {
      string: 'Pricelist', store: false,
    help: 'Technical field. Used for searching on pricelists, not stored in database.'
  });
  static uomId = Fields.Many2one(
    'uom.uom', {
      string: 'Unit of Measure',
    default: async (self) => self._getDefaultUomId(), required: true,
    help: "Default unit of measure used for all stock operations."
  });
  static uomName = Fields.Char({ string: 'Unit of Measure Name', related: 'uomId.label', readonly: true });
  static uomPoId = Fields.Many2one(
    'uom.uom', {
      string: 'Purchase UoM',
    default: async (self) => self._getDefaultUomId(), required: true,
    help: "Default unit of measure used for purchase orders. It must be in the same category as the default unit of measure."
  });
  static companyId = Fields.Many2one(
    'res.company', { string: 'Company', index: 1 });
  static packagingIds = Fields.One2many('product.packaging', { string: "Product Packages", compute: "_computePackagingIds", inverse: "_setPackagingIds", help: "Gives the different ways to package the same product."
  });
  static sellerIds = Fields.One2many('product.supplierinfo', 'productTemplateId', { string: 'Vendors', dependsContext: ['company',], help: "Define vendor pricelists." });
  static variantSellerIds = Fields.One2many('product.supplierinfo', 'productTemplateId');

  static active = Fields.Boolean('Active', { default: true, help: "If unchecked, it will allow you to hide the product without removing it." });
  static color = Fields.Integer('Color Index');

  static isProductVariant = Fields.Boolean({ string: 'Is a product variant', compute: '_computeIsProductVariant' });
  static attributeLineIds = Fields.One2many('product.template.attribute.line', 'productTemplateId', { string: 'Product Attributes', copy: true });

  static validProductTemplateAttributeLineIds = Fields.Many2many('product.template.attribute.line',
    { compute: "_computeValidProductTemplateAttributeLineIds", string: 'Valid Product Attribute Lines', help: "Technical compute" });

  static productVariantIds = Fields.One2many('product.product', 'productTemplateId', { string: 'Products', required: true });
  // performance: product_variant_id provides prefetching on the first product variant only
  static productVariantId = Fields.Many2one('product.product', { string: 'Product', compute: '_computeProductVariantId' });

  static productVariantCount = Fields.Integer(
    '# Product Variants', { compute: '_computeProductVariantCount' });

  // related to display product product information if is_product_variant
  static barcode = Fields.Char('Barcode', { compute: '_computeBarcode', inverse: '_setBarcode', search: '_searchBarcode' });
  static defaultCode = Fields.Char(
    'Internal Reference', {
      compute: '_computeDefaultCode',
    inverse: '_setDefaultCode', store: true
  });

  static pricelistItemCount = Fields.Integer("Number of price rules", { compute: "_computeItemCount" });

  static canImage1024BeZoomed = Fields.Boolean("Can Image 1024 be zoomed", { compute: '_computeCanImage1024BeZoomed', store: true });
  static hasConfigurableAttributes = Fields.Boolean("Is a configurable product", { compute: '_computeHasConfigurableAttributes', store: true });

  static productTooltip = Fields.Char({ compute: '_computeProductTooltip' });

  static priority = Fields.Selection([
    ['0', 'Normal'],
    ['1', 'Favorite'],
  ], { default: '0', string: "Favorite" });

  async _computeItemCount() {
    for (const template of this) {
      // Pricelist item count counts the rules applicable on current template or on its variants.
      await template.set('pricelistItemCount', await template.env.items('product.pricelist.item').searchCount(
        ['|', ['productTemplateId', '=', template.id], ['productId', 'in', (await template.productVariantIds).ids]]
      ));
    }
  }

  @api.depends('image1920', 'image1024')
  async _computeCanImage1024BeZoomed() {
    for (const template of this) {
      await template.set('canImage1024BeZoomed', await template.image1920 && await isImageSizeAbove(await template.image1920, await template.image1024));
    }
  }

  /**
   * A product is considered configurable if:
      - It has dynamic attributes
      - It has any attribute line with at least 2 attribute values configured
   */
  @api.depends('attributeLineIds', 'attributeLineIds.valueIds', 'attributeLineIds.attributeId.createVariant')
  async _computeHasConfigurableAttributes() {
    for (const product of this) {
      let some = false;
      for (const ptal of await product.attributeLineIds) {
        if (len(await ptal.valueIds) >= 2) {
          some = true;
          break;
        }
      }
      await product.set('hasConfigurableAttributes', await product.hasDynamicAttributes() || some);
    }
  }

  @api.depends('productVariantIds')
  async _computeProductVariantId() {
    for (const p of this) {
      await p.set('productVariantId', (await p.productVariantIds)([0, 1]).id);
    }
  }

  @api.depends('companyId')
  async _computeCurrencyId() {
    const mainCompany = await this.env.items('res.company')._getMainCompany();
    for (const template of this) {
      let currencyId = (await (await (await template.companyId).sudo()).currencyId).id;
      currencyId = bool(currencyId) ? currencyId : (await mainCompany.currencyId).id;
      await template.set('currencyId', currencyId);

    }
  }

  @api.dependsContext('company')
  async _computeCostCurrencyId() {
    await this.set('costCurrencyId', (await (await this.env.company()).currencyId).id);
  }

  async _computeTemplatePrice() {
    const prices = await this._computeTemplatePriceNoInverse();
    for (const template of this) {
      await template.set('price', prices[template.id] || 0.0);
    }
  }

  /**
   * The _computeTemplatePrice writes the 'listPrice' field with an inverse method
      This method allows computing the price without writing the 'listPrice'
   * @returns 
   */
  async _computeTemplatePriceNoInverse() {
    let prices = {};
    let pricelistIdOrName = this._context['pricelist'];
    if (bool(pricelistIdOrName)) {
      let pricelist;
      const partner = this.env.context['partner'];
      const quantity = this.env.context['quantity'] ?? 1.0;

      // Support context pricelists specified as list, displayName or ID for compatibility
      if (isList(pricelistIdOrName)) {
        pricelistIdOrName = pricelistIdOrName[0];
      }
      if (typeof (pricelistIdOrName) === 'string') {
        const pricelistData = await this.env.items('product.pricelist').nameSearch(pricelistIdOrName, { operator: '=', limit: 1 });
        if (bool(pricelistData)) {
          pricelist = this.env.items('product.pricelist').browse(pricelistData[0][0]);
        }
      }
      else if (typeof (pricelistIdOrName) === 'number') {
        pricelist = this.env.items('product.pricelist').browse(pricelistIdOrName);
      }

      if (pricelist.ok) {
        const quantities = _.fill(Array(this._length), quantity);
        const partners = _.fill(Array(this._length), partner);
        prices = await pricelist.getProductsPrice(this, quantities, partners);
      }
    }
    return prices;
  }

  async _setTemplatePrice() {
    if (this._context['uom']) {
      for (const template of this) {
        const value = await this.env.items('uom.uom').browse(this._context['uom'])._computePrice(await template.price, await template.uomId);
        await template.write({ 'listPrice': value });
      }
    }
    else {
      await this.write({ 'listPrice': await this['price'] });
    }
  }

  @api.dependsContext('company')
  @api.depends('productVariantIds', 'productVariantIds.standardPrice')
  async _computeStandardPrice() {
    // Depends on force_company context because standardPrice is companyDependent on the product_product
    const uniqueVariants = await this.filtered(async (template) => len(await template.productVariantIds) == 1);
    for (const template of uniqueVariants) {
      await template.set('standardPrice', await (await template.productVariantIds).standardPrice);
    }
    for (const template of this.sub(uniqueVariants)) {
      await template.set('standardPrice', 0.0);
    }
  }

  async _setStandardPrice() {
    for (const template of this) {
      const productVariantIds = await template.productVariantIds;
      if (len(productVariantIds) == 1) {
        await productVariantIds.set('standardPrice', await template.standardPrice);
      }
    }
  }

  async _searchStandardPrice(operator, value) {
    const products = await this.env.items('product.product').search([['standardPrice', operator, value]], { limit: null });
    return [['id', 'in', (await products.mapped('productTemplateId')).ids]];
  }

  @api.depends('productVariantIds', 'productVariantIds.volume')
  async _computeVolume() {
    const uniqueVariants = await this.filtered(async (template) => len(await template.productVariantIds) == 1);
    for (const template of uniqueVariants) {
      await template.set('volume', await (await template.productVariantIds).volume);
    }
    for (const template of this.sub(uniqueVariants)) {
      await template.set('volume', 0.0);
    }
  }

  async _setVolume() {
    for (const template of this) {
      const productVariantIds = await template.productVariantIds;
      if (len(productVariantIds) == 1) {
        await productVariantIds.set('volume', await template.volume);
      }
    }
  }

  @api.depends('productVariantIds', 'productVariantIds.weight')
  async _computeWeight() {
    const uniqueVariants = await this.filtered(async (template) => len(await template.productVariantIds) == 1);
    for (const template of uniqueVariants) {
      await template.set('weight', await (await template.productVariantIds).weight);
    }
    for (const template of this.sub(uniqueVariants)) {
      await template.set('weight', 0.0);
    }
  }

  async _computeIsProductVariant() {
    await this.set('isProductVariant', false);
  }

  @api.depends('productVariantIds.barcode')
  async _computeBarcode() {
    await this.set('barcode', false);
    for (const template of this) {
      // TODO master: update product_variant_count depends and use it instead
      const productVariantIds = await template.productVariantIds;
      const variantCount = len(productVariantIds)
      if (variantCount == 1) {
        await template.set('barcode', await productVariantIds.barcode);
      }
      else if (variantCount == 0) {
        const archivedVariants = await (await template.withContext({ activeTest: false })).productVariantIds;
        if (len(archivedVariants) == 1) {
          await template.set('barcode', await archivedVariants.barcode);
        }
      }
    }
  }

  async _searchBarcode(operator, value) {
    const templates = await (await this.withContext({ activeTest: false })).search([['productVariantIds.barcode', operator, value]]);
    return [['id', 'in', templates.ids]];
  }

  async _setBarcode() {
    const productVariantIds = await (this as any).productVariantIds;
    if (len(productVariantIds) == 1) {
      await productVariantIds.set('barcode', await (this as any).barcode);
    }
  }

  /**
   * Get the unit of measure to interpret the `weight` field. By default, we considerer
      that weights are expressed in kilograms. Users can configure to express them in pounds
      by adding an ir.config_parameter record with "product.product_weight_in_lbs" as key
      and "1" as value.
   * @returns 
   */
  @api.model()
  async _getWeightUomIdFromIrConfigParameter() {
    const productWeightInLbsParam = await (await this.env.items('ir.config.parameter').sudo()).getParam('product.weightInLbs');
    if (productWeightInLbsParam === '1') {
      return this.env.ref('uom.productUomLb');
    }
    else {
      return this.env.ref('uom.productUomKgm');
    }
  }

  /**
   * Get the unit of measure to interpret the `length`, 'width', 'height' field.
      By default, we considerer that length are expressed in millimeters. Users can configure
      to express them in feet by adding an ir.config_parameter record with "product.volume_in_cubic_feet"
      as key and "1" as value.
   * @returns 
   */
  @api.model()
  async _getLengthUomIdFromIrConfigParameter() {
    const productLengthInFeetParam = await (await this.env.items('ir.config.parameter').sudo()).getParam('product.volumeInCubicFeet');
    if (productLengthInFeetParam === '1') {
      return this.env.ref('uom.productUomFoot');
    }
    else {
      return this.env.ref('uom.productUomMillimeter');
    }
  }

  /**
   * Get the unit of measure to interpret the `volume` field. By default, we consider
      that volumes are expressed in cubic meters. Users can configure to express them in cubic feet
      by adding an ir.config_parameter record with "product.volume_in_cubic_feet" as key
      and "1" as value.
   * @returns 
   */
  @api.model()
  async _getVolumeUomIdFromIrConfigParameter() {
    const productLengthInFeetParam = await (await this.env.items('ir.config.parameter').sudo()).getParam('product.volumeInCubicFeet');
    if (productLengthInFeetParam === '1') {
      return this.env.ref('uom.productUomCubicFoot');
    }
    else {
      return this.env.ref('uom.productUomCubicMeter');
    }
  }

  @api.model()
  async _getWeightUomNameFromIrConfigParameter() {
    return (await this._getWeightUomIdFromIrConfigParameter()).displayName;
  }

  @api.model()
  async _getLengthUomNameFromIrConfigParameter() {
    return (await this._getLengthUomIdFromIrConfigParameter()).displayName;
  }

  @api.model()
  async _getVolumeUomNameFromIrConfigParameter() {
    return (await this._getVolumeUomIdFromIrConfigParameter()).displayName;
  }

  async _computeWeightUomName() {
    await this.set('weightUomName', await this._getWeightUomNameFromIrConfigParameter());
  }

  async _computeVolumeUomName() {
    await this.set('volumeUomName', await this._getVolumeUomNameFromIrConfigParameter());
  }

  async _setWeight() {
    for (const template of this) {
      const productVariantIds = await template.productVariantIds;
      if (len(productVariantIds) == 1) {
        await productVariantIds.set('weight', await template.weight);
      }
    }
  }

  @api.depends('productVariantIds.productTemplateId')
  async _computeProductVariantCount() {
    for (const template of this) {
      await template.set('productVariantCount', len(await template.productVariantIds));
    }
  }

  @api.onchange('defaultCode')
  async _onchangeDefaultCode() {
    const defaultCode = await (this as any).defaultCode;
    if (!defaultCode) {
      return;
    }

    const domain = [['defaultCode', '=', defaultCode]];
    const _id = this.id as any;
    if (_id.origin) {
      domain.push(['id', '!=', _id.origin]);
    }

    if (bool(await this.env.items('product.template').search(domain, { limit: 1 }))) {
      return {
        'warning': {
          'title': await this._t("Note:"),
          'message': await this._t("The Internal Reference '%s' already exists.", defaultCode),
        }
      }
    }
  }

  @api.depends('productVariantIds', 'productVariantIds.defaultCode')
  async _computeDefaultCode() {
    const uniqueVariants = await this.filtered(async (template) => len(await template.productVariantIds) == 1);
    for (const template of uniqueVariants) {
      await template.set('defaultCode', await (await template.productVariantIds).defaultCode);
    }
    for (const template of this.sub(uniqueVariants)) {
      await template.set('defaultCode', false);
    }
  }

  async _setDefaultCode() {
    for (const template of this) {
      const productVariantIds = await template.productVariantIds;
      if (len(productVariantIds) == 1) {
        await productVariantIds.set('defaultCode', await template.defaultCode);
      }
    }
  }

  @api.depends('productVariantIds', 'productVariantIds.packagingIds')
  async _computePackagingIds() {
    for (const p of this) {
      const productVariantIds = await p.productVariantIds;
      if (len(productVariantIds) == 1) {
        await p.set('packagingIds', await productVariantIds.packagingIds);
      }
      else {
        await p.set('packagingIds', false);
      }
    }
  }

  async _setPackagingIds() {
    for (const p of this) {
      const productVariantIds = await p.productVariantIds;
      if (len(productVariantIds) == 1) {
        await p.set('packagingIds', await p.packagingIds);
      }
    }
  }

  @api.depends('type')
  async _computeProductTooltip() {
    for (const record of this) {
      if (await record.type === 'consu') {
        await record.set('productTooltip', await this._t(
          "Consumables are physical products for which you don't manage the inventory level: they are always available."
        ));
      }
      else {
        await record.set('productTooltip', "");
      }
    }
  }

  _detailedTypeMapping() {
    return {};
  }

  @api.depends('detailedType')
  async _computeType() {
    const typeMapping = this._detailedTypeMapping();
    for (const record of this) {
      const detailedType = await record.detailedType;
      await record.set('type', typeMapping[detailedType] || detailedType);
    }
  }

  @api.constrains('uomId', 'uomPoId')
  async _checkUom() {
    for (const template of this) {
      const uomId = await template.uomId;
      const uomPoId = await template.uomPoId;
      if (bool(uomId) && bool(uomPoId) && !(await uomId.categoryId).eq(await uomPoId.categoryId)) {
        throw new ValidationError(await this._t('The default Unit of Measure and the purchase Unit of Measure must be in the same category.'));
      }
    }
  }

  @api.onchange('uomId')
  async _onchangeUomId() {
    const uomId = await (this as any).uomId;
    if (bool(uomId)) {
      await this.set('uomPoId', uomId.id);
    }
  }

  @api.onchange('uomPoId')
  async _onchangeUom() {
    const self: any = this;
    const uomId = await self.uomId;
    const uomPoId = await self.uomPoId;
    if (bool(uomId) && bool(uomPoId) && !(await uomId.categoryId).eq(await uomPoId.categoryId)) {
      await self.set('uomPoId', uomId);
    }
  }

  @api.onchange('type')
  _onchangeType() {
    // Do nothing but needed for inheritance
    return {}
  }

  /**
   * Sanitize vales for writing/creating product templates and variants.

      Values need to be sanitized to keep values synchronized, and to be able to preprocess the
      vals in extensions of create/write.
      :param vals: create/write values dictionary
   * @param vals 
   */
  async _sanitizeVals(vals) {
    if ('type' in vals && !('detailedType' in vals)) {
      if (!(vals['type'] in await this.mapped('type'))) {
        vals['detailedType'] = vals['type'];
      }
    }
    if ('detailedType' in vals && !('type' in vals)) {
      const typeMapping = this._detailedTypeMapping();
      vals['type'] = typeMapping[vals['detailedType']] || vals['detailedType'];
    }
  }

  /**
   * Store the initial standard price in order to be able to retrieve the cost of a product template for a given date
   * @param valsList 
   * @returns 
   */
  @api.modelCreateMulti()
  async create(valsList) {
    for (const vals of valsList) {
      await this._sanitizeVals(vals);
    }
    const templates = await _super(ProductTemplate, this).create(valsList);
    if (!("createProductProduct" in this._context)) {
      await templates._createVariantIds();
    }

    // This is needed to set given values to first variant after creation
    for (const [template, vals] of _.zip([...templates], valsList)) {
      const relatedVals = {}
      if (vals['barcode']) {
        relatedVals['barcode'] = vals['barcode'];
      }
      if (vals['defaultCode']) {
        relatedVals['defaultCode'] = vals['defaultCode'];
      }
      if (vals['standardPrice']) {
        relatedVals['standardPrice'] = vals['standardPrice'];
      }
      if (vals['volume']) {
        relatedVals['volume'] = vals['volume'];
      }
      if (vals['weight']) {
        relatedVals['weight'] = vals['weight'];
      }
      // Please do forward port
      if (bool(vals['packagingIds'])) {
        relatedVals['packagingIds'] = vals['packagingIds'];
      }
      if (bool(relatedVals)) {
        await template.write(relatedVals);
      }
    }
    return templates;
  }

  async write(vals) {
    await this._sanitizeVals(vals);
    if ('uomId' in vals || 'uomPoId' in vals) {
      let uomId = this.env.items('uom.uom').browse(vals['uomId']);
      if (!bool(uomId)) {
        uomId = await this['uomId'];
      }
      let uomPoId = this.env.items('uom.uom').browse(vals['uomPoId']);
      if (!bool(uomPoId)) {
        uomPoId = await this['uomPoId'];
      }
      if (bool(uomId) && bool(uomPoId) && !(await uomId.categoryId).eq(await uomPoId.categoryId)) {
        vals['uomPoId'] = uomId.id;
      }
    }
    const res = await _super(ProductTemplate, this).write(vals);
    const productVariantIds = await (this as any).productVariantIds;
    if ('attributeLineIds' in vals || (vals['active'] && len(productVariantIds) == 0)) {
      await this._createVariantIds();
    }
    if ('active' in vals && !vals['active']) {
      await (await (await this.withContext({ activeTest: false })).mapped('productVariantIds')).write({ 'active': vals['active'] });
    }
    if ('image1920' in vals) {
      await this.env.items('product.product').invalidateCache([
        'image1920',
        'image1024',
        'image512',
        'image256',
        'image128',
        'canImage1024BeZoomed',
      ])
      // Touch all products that will fall back on the template field
      // This is done because __last_update is used to compute the 'unique' SHA in image URLs
      // for making sure that images are not retrieved from the browser cache after a change
      // Performance discussion outcome:
      // Actually touch all variants to avoid using filtered on the image_variant_1920 field
      await productVariantIds.write({});
    }
    return res;
  }

  @api.returns('self', (value) => value.id)
  async copy(defaultValue: {} = {}) {
    // TDE FIXME: should probably be copyData
    this.ensureOne();
    if (!('label' in defaultValue)) {
      defaultValue['label'] = await this._t("%s (copy)", await this['label']);
    }
    return _super(ProductTemplate, this).copy(defaultValue);
  }

  async nameGet() {
    // Prefetch the fields used by the `nameGet`, so `browse` doesn't fetch other fields
    await this.browse(this.ids).read(['label', 'defaultCode']);
    const res = [];
    for (const template of this) {
      const defaultCode = await template.defaultCode;
      res.push([template.id, f('%s%s', defaultCode ? f('[%s] ', defaultCode) : '', await template.label)]);
    }
    return res;
  }

  @api.model()
  async _nameSearch(name, args: any[], operator: string = 'ilike', { limit=100, nameGetUid=false } = {}) {
    // Only use the product.product heuristics if there is a search term and the domain does not specify a match on `product.template` IDs.
    if (!name || args.some(term => term[0] === 'id')) {
      return _super(ProductTemplate, this)._nameSearch(name, args, operator, {limit, nameGetUid});
    }

    const Product = this.env.items('product.product');
    let templates = this.browse([]);
    while (true) {
      const domain = templates.ok ? [['productTemplateId', 'not in', templates.ids]] : [];
      args = args != null ? args : [];
      // Product._nameSearch has default value limit=100
      // So, we either use that value or override it to None to fetch all products at once
      const kwargs = limit ? {} : { 'limit': null };
      const productsIds = await Product._nameSearch(name, args.concat(domain), operator, { nameGetUid, ...kwargs });
      const products = Product.browse(productsIds);
      const newTemplates = await products.mapped('productTemplateId');
      if (newTemplates.ok & templates.ok) {
        // """Product._name_search can bypass the domain we passed (search on supplier info). If this happens, an infinite loop will occur."""
        break;
      }
      templates = templates.or(newTemplates);
      if ((!products.ok) || (limit && (len(templates) > limit))) {
        break;
      }
    }

    let searchedIds = templates.ids;
    // some product.templates do not have product.products yet (dynamic variants configuration),
    // we need to add the base _name_search to the results
    // FIXME awa: this is really not performant at all but after discussing with the team
    // we don't see another way to do it
    let tmplWithoutVariantIds;
    if (!limit || len(searchedIds) < limit) {
      tmplWithoutVariantIds = await this.env.items('product.template').search(
        [['id', 'not in', await this.env.items('product.template')._search([['productVariantIds.active', '=', true]])]]
      );
    }
    if (len(tmplWithoutVariantIds)) {
      const domain = expression.AND([args ?? [], [['id', 'in', tmplWithoutVariantIds.ids]]]);
      searchedIds = _.union(searchedIds, await _super(ProductTemplate, this)._nameSearch(
        name,
        domain,
        operator,
        {
          limit,
          nameGetUid
        })
      );
    }
    // re-apply product.template order + nameGet
    return _super(ProductTemplate, this)._nameSearch(
      '', [['id', 'in', searchedIds]],
      'ilike', { limit, nameGetUid });
  }

  async actionOpenLabelLayout() {
    const action = await this.env.items('ir.actions.actions')._forXmlid('product.actionOpenLabelLayout');
    action['context'] = { 'default_productTemplateIds': this.ids };
    return action;
  }

  async openPricelistRules() {
    this.ensureOne();
    const domain = ['|',
      ['productTemplateId', '=', this.id],
      ['productId', 'in', (await (this as any).productVariantIds).ids]];
    return {
      'label': await this._t('Price Rules'),
      'viewMode': 'tree,form',
      'views': [[(await this.env.ref('product.productPricelistItemTreeViewFromProduct')).id, 'tree'], [false, 'form']],
      'resModel': 'product.pricelist.item',
      'type': 'ir.actions.actwindow',
      'target': 'current',
      'domain': domain,
      'context': {
        'default_productTemplateId': this.id,
        'default_appliedOn': '1_product',
        'productWithoutVariants': await this['productVariantCount'] == 1,
      },
    }
  }

  async priceCompute(priceType, uom?: any, currency?: any, company?: any) {
    // TDE FIXME: delegate to template or not ? fields are reencoded here ...
    // compatibility about context keys used a bit everywhere in the code
    if (!bool(uom) && this._context['uom']) {
      uom = this.env.items('uom.uom').browse(this._context['uom']);
    }
    if (!bool(currency) && this._context['currency']) {
      currency = this.env.items('res.currency').browse(this._context['currency']);
    }

    let templates: any = this;
    if (priceType === 'standardPrice') {
      // standardPrice field can only be seen by users in base.groupUser.Thus, in order to compute the sale price from the cost for users not in this group. We fetch the standard price as the superuser
      templates = await (await templates.withCompany(company)).sudo();
    }
    if (!bool(company)) {
      company = await this.env.company();
    }
    const date = this.env.context['date'] ?? _Date.today();

    const prices = Dict.fromKeys(this.ids, 0.0);
    for (const template of templates) {
      const id = template.id;
      prices[id] = await template[priceType] || 0.0;
      // yes, there can be attribute values for product template if it's not a variant YET
      // (see field product.attribute createVariant)
      if (priceType === 'listPrice' && len(this._context['currentAttributesPriceExtra'])) {
        /// we have a list of priceExtra that comes from the attribute values, we need to sum all that
        prices[id] += this._context['currentAttributesPriceExtra'].reduce((pre, cur) => pre + cur, 0.0);
      }
      if (bool(uom)) {
        prices[id] = await (await template.uomId)._computePrice(prices[id], uom);
      }

      // Convert from current user company currency to asked one
      // This is right cause a field cannot be in more than one currency
      if (bool(currency)) {
        prices[id] = await (await template.currencyId)._convert(prices[id], currency, company, date);
      }
    }
    return prices;
  }

  async _createVariantIds() {
    await this.flush();
    const Product = this.env.items("product.product");

    const variantsToCreate = [];
    let variantsToActivate = Product;
    let variantsToUnlink = Product;

    for (const tmplId of this) {
      const linesWithoutNoVariants = await (await tmplId.validProductTemplateAttributeLineIds)._withoutNoVariantAttributes();

      const allVariants = await (await (await tmplId.withContext({ activeTest: false })).productVariantIds).sorted(async (p) => String([await p.active, -p.id]));

      const currentVariantsToCreate = [];
      let currentVariantsToActivate = Product;
      
      // adding an attribute with only one value should not recreate product
      // write this attribute on every product to make sure we don't lose them
      const singleValueLines = await linesWithoutNoVariants.filtered(async (ptal) => len(await (await ptal.productTemplateValueIds)._onlyActive()) == 1);
      if (singleValueLines.ok) {
        for (const variant of allVariants) {
          const combination = (await variant.productTemplateAttributeValueIds).or(await (await singleValueLines.productTemplateValueIds)._onlyActive());
          // Do not add single value if the resulting combination would
          // be invalid anyway.
          if (
            len(combination) == len(linesWithoutNoVariants) &&
            (await combination.attributeLineId).eq(linesWithoutNoVariants)
          ) {
            await variant.set('productTemplateAttributeValueIds', combination);
          }
        }
      }
      // Set containing existing `product.template.attribute.value` combination
      const existingVariants = new MapKey();
      for (const variant of allVariants) {
        existingVariants.set(await variant.productTemplateAttributeValueIds, variant);
      }

      // Determine which product variants need to be created based on the attribute configuration. If any attribute is set to generate variants dynamically, skip the process.
      // Technical note: if there is no attribute, a variant is still created because
      // 'not any([])' and 'set([]) not in set([])' are true.
      if (! await tmplId.hasDynamicAttributes()) {
        // Iterator containing all possible `product.template.attribute.value` combination
        // The iterator is used to avoid MemoryError in case of a huge number of combination.
        const _products = [];
        for (const ptal of linesWithoutNoVariants) {
          _products.push(await (await ptal.productTemplateValueIds)._onlyActive());
        }
        const allCombinations = product(_products);
        // For each possible variant, create if it doesn't exist yet.
        for (const combinationList of allCombinations) {
          const combination = this.env.items('product.template.attribute.value').concat(combinationList);
          const isCombinationPossible = await tmplId._isCombinationPossibleByConfig(combination, true);
          if (!isCombinationPossible) {
            continue;
          }
          if (existingVariants.has(combination)) {
            currentVariantsToActivate = currentVariantsToActivate.add(existingVariants.get(combination));
          }
          else {
            currentVariantsToCreate.push(await tmplId._prepareVariantValues(combination));
            if (len(currentVariantsToCreate) > 1000) {
              throw new UserError(await this._t(
                `The number of variants to generate is too high. 
                                You should either not generate variants for each combination or generate them on demand from the sales order. 
                                To do so, open the form view of attributes and change the mode of *Create Variants*.`
              ));
            }
          }
        }
        extend(variantsToCreate, currentVariantsToCreate);
        variantsToActivate = variantsToActivate.add(currentVariantsToActivate);
      }
      else {
        for (const variant of existingVariants) {
          const isCombinationPossible = await this._isCombinationPossibleByConfig(
            await variant.productTemplateAttributeValueIds,
            true,
          )
          if (isCombinationPossible) {
            currentVariantsToActivate = currentVariantsToActivate.add(variant);
          }
        }
        variantsToActivate = variantsToActivate.add(currentVariantsToActivate);
      }
      variantsToUnlink = variantsToUnlink.add(allVariants).sub(currentVariantsToActivate);
    }

    if (bool(variantsToActivate)) {
      await variantsToActivate.write({ 'active': true });
    }
    if (bool(variantsToCreate)) {
      await Product.create(variantsToCreate);
    }
    if (bool(variantsToUnlink)) {
      await variantsToUnlink._unlinkOrArchive();
      // prevent change if exclusion deleted template by deleting last variant
      if (!(await this.exists()).eq(this)) {
        throw new UserError(await this._t("This configuration of product attributes, values, and exclusions would lead to no possible variant. Please archive or delete your product directly if intended."));
      }
    }

    // prefetched o2m have to be reloaded (because of activeTest)
    // (eg. product.template: productVariantIds)
    // We can't rely on existing invalidateCache because of the savepoint
    // in _unlinkOrArchive.
    await this.flush();
    this.invalidateCache();
    return true;
  }

  async _prepareVariantValues(combination) {
    this.ensureOne();
    return {
      'productTemplateId': this.id,
      'productTemplateAttributeValueIds': [[6, 0, combination.ids]],
      'active': await this['active']
    }
  }

  /**
   * Return whether this `product.template` has at least one dynamic
      attribute.

      :return: true if at least one dynamic attribute, false otherwise
      :rtype: bool
   * @returns 
   */
  async hasDynamicAttributes() {
    this.ensureOne();
    for (const a of await (await this['validProductTemplateAttributeLineIds']).attributeId) {
      if (await a.createVariant === 'dynamic') {
        return true;
      }
    }
    return false;
  }

  /**
   * A product template attribute line is considered valid if it has at least one possible value.

      Those with only one value are considered valid, even though they should not appear on the configurator itself (unless they have an isCustom value to input), indeed single value attributes can be used to filter products among others based on that attribute/value.
   */
  @api.depends('attributeLineIds.valueIds')
  async _computeValidProductTemplateAttributeLineIds() {
    for (const record of this) {
      await record.set('validProductTemplateAttributeLineIds', await (await record.attributeLineIds).filtered(ptal => ptal.valueIds));
    }
  }

  /**
   * Return the existing variants that are possible.

      For dynamic attributes, it will only return the variants that have been
      created already.

      If there are a lot of variants, this method might be slow. Even if there
      aren't too many variants, for performance reasons, do not call this
      method in a loop over the product templates.

      Therefore this method has a very restricted reasonable use case and you
      should strongly consider doing things differently if you consider using
      this method.

      :param parentCombination: combination from which `self` is an
          optional or accessory product.
      :type parentCombination: recordset `product.template.attribute.value`

      :return: the existing variants that are possible.
      :rtype: recordset of `product.product`
   * @param parentCombination 
   * @returns 
   */
  async _getPossibleVariants(parentCombination: any) {
    this.ensureOne();
    return (await (this as any).productVariantIds).filtered(async (p) => p._isVariantPossible(parentCombination));
  }

  /**
   * Return the list of attribute exclusions of a product.

      :param parentCombination: the combination from which
          `self` is an optional or accessory product. Indeed exclusions
          rules on one product can concern another product.
      :type parentCombination: recordset `product.template.attribute.value`
      :param parent_name: the name of the parent product combination.
      :type parent_name: str

      :return: dict of exclusions
          - exclusions: from this product itself
          - parentCombination: ids of the given parentCombination
          - parentExclusions: from the parentCombination
         - parent_product_name: the name of the parent product if any, used in the interface
             to explain why some combinations are not available.
             (e.g: Not available with Customizable Desk (Legs: Steel))
         - mapped_attribute_names: the name of every attribute values based on their id,
             used to explain in the interface why that combination is not available
             (e.g: Not available with Color: Black)
   * @param parentCombination 
   * @param parentName 
   * @returns 
   */
  async _getAttributeExclusions(parentCombination: any, parentName: any) {
    const self: any = this;
    self.ensureOne();
    parentCombination = parentCombination ?? self.env.items('product.template.attribute.value');
    return {
      'exclusions': await self._completeInverseExclusions(await self._getOwnAttributeExclusions()),
      'parentExclusions': await self._getParentAttributeExclusions(parentCombination),
      'parentCombination': parentCombination.ids,
      'parentProductName': parentName,
      'mappedAttributeNames': await self._getMappedAttributeNames(parentCombination),
    }
  }

  /**
   * Will complete the dictionnary of exclusions with their respective inverse
      e.g: Black excludes XL and L
      -> XL excludes Black
      -> L excludes Black
   * @param exclusions 
   */
  @api.model()
  async _completeInverseExclusions(exclusions: any) {
    const result = new Dict(exclusions);
    for (const [key, value] of Object.entries<any>(exclusions)) {
      for (const exclusion of value) {
        if (exclusion in result && !(key in result[exclusion])) {
          result[exclusion].push(key);
        }
        else {
          result[exclusion] = [key];
        }
      }
    }

    return result;
  }

  /**
   * Get exclusions coming from the current template.

      Dictionnary, each product template attribute value is a key, and for each of them
      the value is an array with the other ptav that they exclude (empty if no exclusion).
   * @returns 
   */
  async _getOwnAttributeExclusions() {
    const self: any = this;
    this.ensureOne();
    const productTemplateAttributeValues = await (await self.validProductTemplateAttributeLineIds).productTemplateValueIds;
    const result = {}
    for (const ptav of productTemplateAttributeValues) {
      result[ptav.id] = [];
      for (const filterLine of await (await ptav.excludeFor).filtered(async (filterLine) => (await filterLine.productTemplateId).eq(self))
      ) {
        for (const valueId of (await filterLine.valueIds).ids) {
          result[ptav.id].push(valueId);
        }
      }
    }
    return result;
  }

  /**
   * Get exclusions coming from the parent combination.

      Dictionnary, each parent's ptav is a key, and for each of them the value is
      an array with the other ptav that are excluded because of the parent.
   * @param parentCombination 
   * @returns 
   */
  async _getParentAttributeExclusions(parentCombination: any) {
    this.ensureOne();
    if (!bool(parentCombination)) {
      return {}
    }

    const result = {}
    for (const productAttributeValue of parentCombination) {
      for (const filterLine of await (await productAttributeValue.excludeFor).filtered(
        async (filterLine) => (await filterLine.productTemplateId).eq(this))
      ) {
        // Some exclusions don't have attribute value. This means that the template is not
        // compatible with the parent combination. If such an exclusion is found, it means that all
        // attribute values are excluded.
        const valueIds = await filterLine.valueIds;
        if (bool(valueIds)) {
          result[productAttributeValue.id] = valueIds.ids;
        }
        else {
          result[productAttributeValue.id] = await (await filterLine.productTemplateId).mapped('attributeLineIds.productTemplateValueIds').ids;
        }
      }
    }

    return result;
  }

  /**
   * The name of every attribute values based on their id,
      used to explain in the interface why that combination is not available
      (e.g: Not available with Color: Black).

      It contains both attribute value names from this product and from
      the parent combination if provided.
   * @param parentCombination 
   * @returns 
   */
  async _getMappedAttributeNames(parentCombination: any) {
    const self: any = this;
    this.ensureOne();
    let allProductAttributeValues = await (await self.validProductTemplateAttributeLineIds).productTemplateValueIds;
    if (bool(parentCombination)) {
      allProductAttributeValues = allProductAttributeValues.or(parentCombination);
    }
    const result = {};
    for (const attributeValue of allProductAttributeValues) {
      result[attributeValue.id] = await attributeValue.displayName;
    }
    return result;
  }

  /**
   * Return whether the given combination is possible according to the config of attributes on the template

      :param combination: the combination to check for possibility
      :type combination: recordset `product.template.attribute.value`

      :param ignore_no_variant: whether noVariant attributes should be ignored
      :type ignore_no_variant: bool

      :return: wether the given combination is possible according to the config of attributes on the template
      :rtype: bool
   * @param combination 
   * @param ignoreNoVariant 
   * @returns 
   */
  async _isCombinationPossibleByConfig(combination, ignoreNoVariant: boolean = false) {
    const self: any = this;
    self.ensureOne();

    let attributeLines = await self.validProductTemplateAttributeLineIds;

    if (ignoreNoVariant) {
      attributeLines = await attributeLines._withoutNoVariantAttributes();
    }
    if (len(combination) != len(attributeLines)) {
      // number of attribute values passed is different than the
      // configuration of attributes on the template
      return false;
    }

    if (!attributeLines.eq(await combination.attributeLineId)) {
      // combination has different attributes than the ones configured on the template
      return false;
    }

    if (!(await (await attributeLines.productTemplateValueIds)._onlyActive()).ge(combination)) {
      // combination has different values than the ones configured on the template
      return false;
    }

    const exclusions = await self._getOwnAttributeExclusions();
    if (bool(exclusions)) {
      // exclude if the current value is in an exclusion,
      // and the value excluding it is also in the combination
      for (const ptav of combination) {
        for (const exclusion of exclusions[ptav.id]) {
          if (combination.ids.includes(exclusion)) {
            return false;
          }
        }
      }
    }
    return true;
  }

  /**
   * The combination is possible if it is not excluded by any rule
      coming from the current template, not excluded by any rule from the
      parentCombination (if given), and there should not be any archived
      variant with the exact same combination.

      If the template does not have any dynamic attribute, the combination
      is also not possible if the matching variant has been deleted.

      Moreover the attributes of the combination must excatly match the
      attributes allowed on the template.

      :param combination: the combination to check for possibility
      :type combination: recordset `product.template.attribute.value`

      :param ignoreNoVariant: whether noVariant attributes should be ignored
      :type ignoreNoVariant: bool

      :param parentCombination: combination from which `self` is an
          optional or accessory product.
      :type parentCombination: recordset `product.template.attribute.value`

      :return: whether the combination is possible
      :rtype: bool
   * @param combination 
   * @param parentCombination 
   * @param ignoreNoVariant 
   * @returns 
   */
  async _isCombinationPossible(combination, parentCombination?: any, ignoreNoVariant = false) {
    this.ensureOne();

    if (! await this._isCombinationPossibleByConfig(combination, ignoreNoVariant)) {
      return false;
    }

    const variant = await this._getVariantForCombination(combination);

    if (await this.hasDynamicAttributes()) {
      if (bool(variant) && ! await variant.active) {
        // dynamic and the variant has been archived
        return false;
      }
    }
    else {
      if (!bool(variant) || ! await variant.active) {
        // not dynamic, the variant has been archived or deleted
        return false;
      }
    }

    const parentExclusions = await this._getParentAttributeExclusions(parentCombination);
    if (bool(parentExclusions)) {
      // parent_exclusion are mapped by ptav but here we don't need to know  where the exclusion comes from so we loop directly on the dict values
      for (const exclusionsValues of Object.values<any>(parentExclusions)) {
        for (const exclusion of exclusionsValues) {
          if (combination.ids.includes(exclusion)) {
            return false;
          }
        }
      }
    }
    return true;
  }

  /**
   * Get the variant matching the combination.

      All of the values in combination must be present in the variant, and the
      variant should not have more attributes. Ignore the attributes that are
      not supposed to create variants.

      :param combination: recordset of `product.template.attribute.value`

      :return: the variant if found, else empty
      :rtype: recordset `product.product`
   * @param combination 
   * @returns 
   */
  async _getVariantForCombination(combination) {
    this.ensureOne();
    const filteredCombination = await combination._withoutNoVariantAttributes();
    return this.env.items('product.product').browse(await this._getVariantIdForCombination(filteredCombination));
  }

  /**
   * Create if necessary and possible and return the product variant
      matching the given combination for this template.

      It is possible to create only if the template has dynamic attributes
      and the combination itself is possible.
      If we are in this case and the variant already exists but it is
      archived, it is activated instead of being created again.

      :param combination: the combination for which to get or create variant.
          The combination must contain all necessary attributes, including
          those of type noVariant. Indeed even though those attributes won't
          be included in the variant if newly created, they are needed when
          checking if the combination is possible.
      :type combination: recordset of `product.template.attribute.value`

      :param log_warning: whether a warning should be logged on fail
      :type log_warning: bool

      :return: the product variant matching the combination or none
      :rtype: recordset of `product.product`
   * @param combination 
   * @param logWarning 
   * @returns 
   */
  async _createProductVariant(combination, logWarning = false) {
    this.ensureOne();

    const Product = this.env.items('product.product');

    const productVariant = await this._getVariantForCombination(combination);
    if (bool(productVariant)) {
      if (! await productVariant.active && await this.hasDynamicAttributes() && await this._isCombinationPossible(combination)) {
        await productVariant.set('active', true);
      }
      return productVariant;
    }

    if (! await this.hasDynamicAttributes()) {
      if (logWarning) {
        console.warn(f('The user #%s tried to create a variant for the non-dynamic product %s.', (await this.env.user()).id, this.id));
      }
      return Product;
    }

    if (! await this._isCombinationPossible(combination)) {
      if (logWarning) {
        console.warn(f('The user #%s tried to create an invalid variant for the product %s.', (await this.env.user()).id, this.id));
      }
      return Product;
    }

    return (await Product.sudo()).create({
      'productTemplateId': this.id,
      'productTemplateAttributeValueIds': [[6, 0, (await combination._withoutNoVariantAttributes()).ids]]
    });
  }

  /**
   * Create if necessary and possible and return the first product
      variant for this template.

      :param log_warning: whether a warning should be logged on fail
      :type log_warning: bool

      :return: the first product variant or none
      :rtype: recordset of `product.product`
   * @param logWarning 
   * @returns 
   */
  async _createFirstProductVariant(logWarning = false) {
    return this._createProductVariant(await this._getFirstPossibleCombination(), logWarning);
  }

  /**
   * See `_get_variant_for_combination`. This method returns an ID
      so it can be cached.

      Use sudo because the same result should be cached for all users.
   * @param filteredCombination 
   * @returns 
   */
  @tools.ormcache('self.id', 'filteredCombination.ids')
  async _getVariantIdForCombination(filteredCombination) {
    this.ensureOne();
    let domain = [['productTemplateId', '=', this.id]];
    const combinationIndicesIds = filteredCombination._ids2str();

    if (bool(combinationIndicesIds)) {
      domain = expression.AND([domain, [['combinationIndices', '=', combinationIndicesIds]]]);
    }
    else {
      domain = expression.AND([domain, [['combinationIndices', 'in', ['', false]]]]);
    }

    return (await (await (await this.env.items('product.product').sudo()).withContext({ activeTest: false })).search(domain, { order: 'active DESC', limit: 1 })).id;
  }

  /**
   * See `_createFirstProductVariant`. This method returns an ID
      so it can be cached.
   * @returns 
   */
  @tools.ormcache('self.id')
  async _getFirstPossibleVariantId() {
    this.ensureOne();
    return (await this._createFirstProductVariant()).id;
  }

  /**
   * See `_get_possible_combinations` (one iteration).

      This method return the same result (empty recordset) if no
      combination is possible at all which would be considered a negative
      result, or if there are no attribute lines on the template in which
      case the "empty combination" is actually a possible combination.
      Therefore the result of this method when empty should be tested
      with `_is_combination_possible` if it's important to know if the
      resulting empty combination is actually possible or not.
   * @param parentCombination 
   * @param necessaryValues 
   * @returns 
   */
  async _getFirstPossibleCombination(parentCombination?: any, necessaryValues?: any) {
    return nextAsync(this._getPossibleCombinations(parentCombination, necessaryValues), this.env.items('product.template.attribute.value'));
  }

  /**
   *         Generate all possible combination for attributes values (aka cartesian product).
      It is equivalent to itertools.product except it skips invalid partial combinations before they are complete.

      Imagine the cartesian product of 'A', 'CD' and range(1_000_000) and let's say that 'A' and 'C' are incompatible.
      If you use itertools.product or any normal cartesian product, you'll need to filter out of the final result
      the 1_000_000 combinations that start with 'A' and 'C' . Instead, This implementation will test if 'A' and 'C' are
      compatible before even considering range(1_000_000), skip it and and continue with combinations that start
      with 'A' and 'D'.

      It's necessary for performance reason because filtering out invalid combinations from standard Cartesian product
      can be extremely slow

      :param product_template_attribute_values_per_line: the values we want all the possibles combinations of.
      One list of values by attribute line
      :return: a generator of product template attribute value
   * @param productTemplateAttributeValuesPerLine 
   * @param parentCombination 
   * @returns 
   */
  async * _cartesianProduct(productTemplateAttributeValuesPerLine, parentCombination) {
    if (!bool(productTemplateAttributeValuesPerLine)) {
      return;
    }

    const allExclusions = new MapKey();
    for (const [k, v] of Object.entries<any>(await this._getOwnAttributeExclusions())) {
      allExclusions.set(this.env.items('product.template.attribute.value').browse(k), this.env.items('product.template.attribute.value').browse(v));
    }
    // The following dict uses product template attribute values as keys
    // 0 means the value is acceptable, greater than 0 means it's rejected, it cannot be negative
    // Bear in mind that several values can reject the same value and the latter can only be included in the
    //  considered combination if no value rejects it.
    // This dictionary counts how many times each value is rejected.
    // Each time a value is included in the considered combination, the values it rejects are incremented
    // When a value is discarded from the considered combination, the values it rejects are decremented
    const currentExclusions = new MapKey();
    for (const exclusion of Object.keys(await this._getParentAttributeExclusions(parentCombination))) {
      const k = this.env.items('product.template.attribute.value').browse(exclusion);
      currentExclusions.set(k, currentExclusions.get(k, 0));
      currentExclusions.set(k, currentExclusions.get(k) + 1);
    }
    let partialCombination = this.env.items('product.template.attribute.value');

    // The following list reflects product_template_attribute_values_per_line
    // For each line, instead of a list of values, it contains the index of the selected value
    // -1 means no value has been picked for the line in the current (partial) combination
    const valueIndexPerLine = _.fill(Array(len(productTemplateAttributeValuesPerLine)), -1);
    // determines which line line we're working on
    let lineIndex = 0;

    while (true) {
      let currentLineValues = productTemplateAttributeValuesPerLine[lineIndex];
      let currentPtavIndex = valueIndexPerLine[lineIndex];
      let currentPtav = currentLineValues.slice(currentPtavIndex)[0];

      // removing exclusions from current_ptav as we're removing it from partial_combination
      if (currentPtavIndex >= 0) {
        for (const ptavToIncludeBack of allExclusions.get(currentPtav)) {
          currentExclusions.set(ptavToIncludeBack, currentExclusions.get(ptavToIncludeBack) - 1);
        }
        partialCombination = partialCombination.sub(currentPtav);
      }

      if (currentPtavIndex < len(currentLineValues) - 1) {
        // go to next value of current line
        valueIndexPerLine[lineIndex] += 1;
        currentLineValues = productTemplateAttributeValuesPerLine[lineIndex];
        currentPtavIndex = valueIndexPerLine[lineIndex];
        currentPtav = currentLineValues.slice(currentPtavIndex)[0];
      }
      else if (lineIndex != 0) {
        // reset current line, and then go to previous line
        valueIndexPerLine[lineIndex] = - 1;
        lineIndex -= 1;
        continue;
      }
      else {
        // we're done if we must reset first line
        break;
      }

      // adding exclusions from current_ptav as we're incorporating it in partial_combination
      for (const ptavToExclude of allExclusions.get(currentPtav)) {
        currentExclusions.set(ptavToExclude, currentExclusions.get(ptavToExclude) + 1);
      }
      partialCombination = partialCombination.add(currentPtav);

      // test if included values excludes current value or if current value exclude included values

      if (currentExclusions.get(currentPtav)) {
        continue;
      } else {
        let some;
        for (const intersection of allExclusions.get(currentPtav)) {
          if (partialCombination.includes(intersection)) {
            some = true;
            break;
          }
        }
        if (some) {
          continue;
        }
      }

      if (lineIndex == len(productTemplateAttributeValuesPerLine) - 1) {
        // submit combination if we're on the last line
        yield partialCombination;
      }
      else {
        // else we go to the next line
        lineIndex += 1;
      }
    }
  }

  /**
   * Generator returning combinations that are possible, following the
      sequence of attributes and values.

      See `_isCombinationPossible` for what is a possible combination.

      When encountering an impossible combination, try to change the value
      of attributes by starting with the further regarding their sequences.

      Ignore attributes that have no values.

      :param parentCombination: combination from which `self` is an
          optional or accessory product.
      :type parentCombination: recordset `product.template.attribute.value`

      :param necessary_values: values that must be in the returned combination
      :type necessary_values: recordset of `product.template.attribute.value`

      :return: the possible combinations
      :rtype: generator of recordset of `product.template.attribute.value`
   * @param parentCombination 
   * @param necessaryValues 
   * @returns 
   */
  async* _getPossibleCombinations(parentCombination: any, necessaryValues: any) {
    const self: any = this;
    self.ensureOne();

    if (! await self.active) {
      throw new StopIteration(await this._t("The product template is archived so no combination is possible."));
    }

    necessaryValues = bool(necessaryValues) ? necessaryValues : self.env.items('product.template.attribute.value');
    const necessaryAttributeLines = await necessaryValues.mapped('attributeLineId');
    const attributeLines = await (await self.validProductTemplateAttributeLineIds).filtered(ptal => !necessaryAttributeLines.includes(ptal));

    if (!bool(attributeLines) && await this._isCombinationPossible(necessaryValues, parentCombination)) {
      yield necessaryValues;
    }

    const productTemplateAttributeValuesPerLine = [];
    for (const ptal of attributeLines) {
      productTemplateAttributeValuesPerLine.push(await (await ptal.productTemplateValueIds)._onlyActive());
    }

    for await (const partialCombination of this._cartesianProduct(productTemplateAttributeValuesPerLine, parentCombination)) {
      const combination = partialCombination.add(necessaryValues);
      if (await this._isCombinationPossible(combination, parentCombination)) {
        yield combination;
      }
    }

    throw new StopIteration(await this._t("There are no remaining possible combination."));
  }

  /**
   * See `_getClosestPossibleCombinations` (one iteration).

      This method return the same result (empty recordset) if no
      combination is possible at all which would be considered a negative
      result, or if there are no attribute lines on the template in which
      case the "empty combination" is actually a possible combination.
      Therefore the result of this method when empty should be tested
      with `_isCombinationPossible` if it's important to know if the
      resulting empty combination is actually possible or not.
   * @param combination 
   * @returns 
   */
  async _getClosestPossibleCombination(combination) {
    return nextAsync(this._getClosestPossibleCombinations(combination), this.env.items('product.template.attribute.value'));
  }

  /**
   * Generator returning the possible combinations that are the closest to
      the given combination.

      If the given combination is incomplete, try to complete it.

      If the given combination is invalid, try to remove values from it before
      completing it.

      :param combination: the values to include if they are possible
      :type combination: recordset `product.template.attribute.value`

      :return: the possible combinations that are including as much
          elements as possible from the given combination.
      :rtype: generator of recordset of product.template.attribute.value
   * @param combination 
   * @returns 
   */
  async* _getClosestPossibleCombinations(combination) {
    while (true) {
      const res = this._getPossibleCombinations(null, combination);
      try {
        // If there is at least one result for the given combination
        // we consider that combination set, and we yield all the
        // possible combinations for it.
        yield (nextAsync(res));
        for await (const cur of res) {
          yield (cur);
        }
        throw new StopIteration(await this._t("There are no remaining closest combination."));
      } catch (e) {
        // except StopIteration:
        // There are no results for the given combination, we try to
        // progressively remove values from it.
        if (!bool(combination)) {
          throw new StopIteration(await this._t("There are no possible combination."));
        }
        combination = combination.slice(0, -1);
      }
    }
  }

  /**
   * Get the most appropriate company for this product.

      If the company is set on the product, directly return it. Otherwise,
      fallback to a contextual company.

      :param kwargs: kwargs forwarded to the fallback method.

      :return: the most appropriate company for this product
      :rtype: recordset of one `res.company`
   */
  async _getCurrentCompany(kwargs: {} = {}) {
    this.ensureOne();
    const company = await this['companyId'];
    return bool(company) ? company : await this._getCurrentCompanyFallback(kwargs);
  }

  /**
   * Fallback to get the most appropriate company for this product.

      This should only be called from `_get_current_company` but is defined
      separately to allow override.

      The final fallback will be the current user's company.

      :return: the fallback company for this product
      :rtype: recordset of one `res.company`
   * @param kwargs 
   * @returns 
   */
  async _getCurrentCompanyFallback(kwargs: {} = {}) {
    this.ensureOne();
    return this.env.company();
  }

  async _getPlaceholderFilename(field) {
    const imageFields = [1920, 1024, 512, 256, 128].map(size => f('image%s', size));
    if (imageFields.includes(field)) {
      return 'product/static/img/placeholder.png';
    }
    return _super(ProductTemplate, this)._getPlaceholderFilename(field);
  }

  /**
   * Method used by the product configurator to check if the product is configurable or not.

      We need to open the product configurator if the product:
      - is configurable (see has_configurable_attributes)
      - has optional products (method is extended in sale to return optional products info)
   * @returns 
   */
  async getSingleProductVariant() {
    const self: any = this;
    this.ensureOne();
    if (await self.productVariantCount == 1 && ! await self.hasConfigurableAttributes) {
      return {
        'productId': (await self.productVariantId).id,
      }
    }
    return {};
  }

  @api.model()
  async getEmptyListHelp(help) {
    const self = await this.withContext({ emptyListHelpDocumentName: await this._t("product") });
    return _super(ProductTemplate, self).getEmptyListHelp(help);
  }

  @api.model()
  async getImportTemplates() {
    return [{
      'label': await this._t('Import Template for Products'),
      'template': '/product/static/xls/product_template.xls'
    }]
  }
}