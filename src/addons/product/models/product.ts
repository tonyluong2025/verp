import _ from "lodash";
import { api } from "../../../core";
import { setdefault } from "../../../core/api/func";
import { Fields, _Date, _Datetime } from "../../../core/fields";
import { Dict } from "../../../core/helper/collections";
import { UserError, ValidationError } from "../../../core/helper/errors";
import { MetaModel, Model, _super } from "../../../core/models";
import { expression } from "../../../core/osv";
import { extend, floatCompare, floatRound, isImageSizeAbove, isList, len, sum } from "../../../core/tools";
import { bool } from "../../../core/tools/bool";
import { dateMax } from "../../../core/tools/date_utils";
import { _f, f } from "../../../core/tools/utils";

@MetaModel.define()
class ProductCategory extends Model {
  static _module = module;
  static _name = "product.category";
  static _description = "Product Category";
  static _parentName = "parentId";
  static _parentStore = true;
  static _recName = 'completeName';
  static _order = 'completeName';

  static label = Fields.Char('Label', { index: true, required: true });
  static completeName = Fields.Char(
    'Complete Name', { compute: '_computeCompleteName', recursive: true, store: true });
  static parentId = Fields.Many2one('product.category', { string: 'Parent Category', index: true, ondelete: 'CASCADE' });
  static parentPath = Fields.Char({ index: true });
  static childId = Fields.One2many('product.category', 'parentId', { string: 'Child Categories' });
  static productCount = Fields.Integer(
    '# Products', {
      compute: '_computeProductCount',
    help: "The number of products under this category (Does not consider the children categories)"
  });

  @api.depends('label', 'parentId.completeName')
  async _computeCompleteName() {
    for (const category of this) {
      const parentId = await category.parentId;
      if (bool(parentId)) {
        await category.set('completeName', f('%s / %s', await parentId.completeName, await category.label));
      }
      else {
        await category.set('completeName', category.label);
      }
    }
  }

  async _computeProductCount() {
    const readGroupRes = await this.env.items('product.template').readGroup([['categId', 'childOf', this.ids]], ['categId'], ['categId']);
    const groupData = Object.fromEntries(readGroupRes.map(data => [data['categId'][0], data['categId_count']]));
    for (const categ of this) {
      let productCount = 0;
      for (const subCategId of (await categ.search([['id', 'childOf', categ.ids]])).ids) {
        productCount += groupData[subCategId] || 0;
      }
      await categ.set('productCount', productCount);
    }
  }

  @api.constrains('parentId')
  async _checkCategoryRecursion() {
    if (! await this._checkRecursion()) {
      throw new ValidationError(await this._t('You cannot create recursive categories.'));
    }
  }

  @api.model()
  async nameCreate(name) {
    return (await (await this.create({ 'label': name })).nameGet())[0];
  }

  async nameGet() {
    if (!(this.env.context['hierarchicalNaming'] ?? true)) {
      const result = [];
      for (const record of this) {
        result.push([record.id, await record.label]);
      }
      return result;
    }
    return _super(ProductCategory, this).nameGet();
  }

  @api.ondelete(false)
  async _unlinkExceptDefaultCategory() {
    const mainCategory = await this.env.ref('product.productCategoryAll');
    if (this.includes(mainCategory)) {
      throw new UserError(await this._t("You cannot delete this product category, it is the default generic category."));
    }
    const expenseCategory = await this.env.ref('product.catExpense');
    if (this.includes(expenseCategory)) {
      throw new UserError(await this._t("You cannot delete the %s product category.", await expenseCategory.label));
    }
  }
}

@MetaModel.define()
class ProductProduct extends Model {
  static _module = module;
  static _name = "product.product";
  static _description = "Product";
  static _inherits = { 'product.template': 'productTemplateId' };
  static _parents = ['mail.thread', 'mail.activity.mixin'];
  static _order = 'priority desc, defaultCode, label, id';

  // price: total price, context dependent (partner, pricelist, quantity)
  static price = Fields.Float(
    'Price', {
      compute: '_computeProductPrice',
    digits: 'Product Price', inverse: '_setProductPrice'
  });
  // priceExtra: catalog extra value only, sum of variant extra attributes
  static priceExtra = Fields.Float(
    'Variant Price Extra', {
      compute: '_computeProductPriceExtra',
    digits: 'Product Price',
    help: "This is the sum of the extra price of all attributes"
  });
  // lstPrice: catalog value + extra, context dependent (uom)
  static lstPrice = Fields.Float(
    'Sales Price', {
      compute: '_computeProductLstPrice',
    digits: 'Product Price', inverse: '_setProductLstPrice',
    help: "The sale price is managed from the product template. Click on the 'Configure Variants' button to set the extra attribute prices."
  });

  static defaultCode = Fields.Char('Internal Reference', { index: true });
  static code = Fields.Char('Reference', { compute: '_computeProductCode' });
  static partnerRef = Fields.Char('Customer Ref', { compute: '_computePartnerRef' });

  static active = Fields.Boolean(
    'Active', {
      default: true,
    help: "If unchecked, it will allow you to hide the product without removing it."
  });
  static productTemplateId = Fields.Many2one(
    'product.template', {
      string: 'Product Template',
    autojoin: true, index: true, ondelete: "CASCADE", required: true
  });
  static barcode = Fields.Char(
    'Barcode', {
      copy: false,
    help: "International Article Number used for product identification."
  });
  static productTemplateAttributeValueIds = Fields.Many2many('product.template.attribute.value', { relation: 'productVariantCombination', string: "Attribute Values", ondelete: 'RESTRICT' });
  static productTemplateVariantValueIds = Fields.Many2many('product.template.attribute.value', { relation: 'productVariantCombination', domain: [['attributeLineId.valueCount', '>', 1]], string: "Variant Values", ondelete: 'RESTRICT' });
  static combinationIndices = Fields.Char({ compute: '_computeCombinationIndices', store: true, index: true });
  static isProductVariant = Fields.Boolean({ compute: '_computeIsProductVariant' });

  static standardPrice = Fields.Float(
    'Cost', {
      companyDependent: true,
    digits: 'Product Price',
    groups: "base.groupUser",
    help: `In Standard Price & AVCO: value of the product (automatically computed in AVCO).
      In FIFO: value of the next unit that will leave the stock (automatically computed).
      Used to value the product when the purchase cost is not known (e.g. inventory adjustment).
      Used to compute margins on sale orders.`});
  static volume = Fields.Float('Volume', { digits: 'Volume' });
  static weight = Fields.Float('Weight', { digits: 'Stock Weight' });

  static pricelistItemCount = Fields.Integer("Number of price rules", { compute: "_computeVariantItemCount" })

  static packagingIds = Fields.One2many('product.packaging', 'productId', { string: 'Product Packages',
    help: "Gives the different ways to package the same product."
  });

  // all image fields are base64 encoded and PIL-supported

  // all image_variant fields are technical and should not be displayed to the user
  static imageVariant1920 = Fields.Image("Variant Image", { maxWidth: 1920, maxHeight: 1920 });

  // resized fields stored (as attachment) for performance
  static imageVariant1024 = Fields.Image("Variant Image 1024", { related: "imageVariant1920", maxWidth: 1024, maxHeight: 1024, store: true })
  static imageVariant512 = Fields.Image("Variant Image 512", { related: "imageVariant1920", maxWidth: 512, maxHeight: 512, store: true });
  static imageVariant256 = Fields.Image("Variant Image 256", { related: "imageVariant1920", maxWidth: 256, maxHeight: 256, store: true });
  static imageVariant128 = Fields.Image("Variant Image 128", { related: "imageVariant1920", maxWidth: 128, maxHeight: 128, store: true });
  static canImageVariant1024BeZoomed = Fields.Boolean("Can Variant Image 1024 be zoomed", { compute: '_computeCanImageVariant1024BeZoomed', store: true });

  // Computed fields that are used to create a fallback to the template if
  // necessary, it's recommended to display those fields to the user.
  static image1920 = Fields.Image("Image", { compute: '_computeImage1920', inverse: '_setImage1920' })
  static image1024 = Fields.Image("Image 1024", { compute: '_computeImage1024' });
  static image512 = Fields.Image("Image 512", { compute: '_computeImage512' });
  static image256 = Fields.Image("Image 256", { compute: '_computeImage256' });
  static image128 = Fields.Image("Image 128", { compute: '_computeImage128' });
  static canImage1024BeZoomed = Fields.Boolean("Can Image 1024 be zoomed", { compute: '_computeCanImage1024BeZoomed' });

  static _sqlConstraints = [
    ['barcode_uniq', 'unique(barcode)', "A barcode can only be assigned to one product !"],
  ]

  @api.depends('imageVariant1920', 'imageVariant1024')
  async _computeCanImageVariant1024BeZoomed() {
    for (const record of this) {
      const imageVariant1920 = await record.imageVariant1920;
      await record.set('canImageVariant1024BeZoomed', bool(imageVariant1920) && await isImageSizeAbove(imageVariant1920, await record.imageVariant1024));
    }
  }

  async _setTemplateField(templateField: string, variantField: string) {
    for (const record of this) {
      const productTemplateId = await record.productTemplateId;
      const recordTemplateField = await record[templateField];
      if (
        // We are trying to remove a field from the variant even though it is already
        // not set on the variant, remove it from the template instead.
        (!recordTemplateField.ok && !(await record[variantField]).ok)
        // We are trying to add a field to the variant, but the template field is
        // not set, write on the template instead.
        || (recordTemplateField.ok && !(await productTemplateId[templateField]).ok)
        // There is only one variant, always write on the template.
        || (await this.searchCount([
          ['productTemplateId', '=', productTemplateId.id],
          ['active', '=', true],
        ]) <= 1)
      ) {
        // await Promise.all([
          await record.set(variantField, false),
          await productTemplateId.set(templateField, recordTemplateField)
        // ]);
      }
      else {
        await record.set(variantField, recordTemplateField);
      }
    }
  }

  /**
   * Get the image from the template if no image is set on the variant.
   */
  async _computeImage1920() {
    for (const record of this) {
      await record.set('image1920', await record.imageVariant1920 || await (await record.productTemplateId).image1920);
    }
  }

  async _setImage1920() {
    return this._setTemplateField('image1920', 'imageVariant1920');
  }

  @api.depends("createdAt", "updatedAt", "productTemplateId.createdAt", "productTemplateId.updatedAt")
  async computeConcurrencyFieldWithAccess() {
    // Intentionally not calling super() to involve all fields explicitly
    for (const record of this) {
      const productTemplateId = await record.productTemplateId;
      await record.set(this.cls.CONCURRENCY_CHECK_FIELD, dateMax(
        await productTemplateId.updatedAt || await productTemplateId.createdAt,
        await record.updatedAt || await record.createdAt || _Datetime.now(),
      ));
    }
  }

  /**
   * Get the image from the template if no image is set on the variant.
   */
  async _computeImage1024() {
    for (const record of this) {
      await record.set('image1024', await record.imageVariant1024 || await (await record.productTemplateId).image1024);
    }
  }

  async _computeImage512() {
    for (const record of this) {
      await record.set('image512', await record.imageVariant512 || await (await record.productTemplateId).image512);
    }
  }

  async _computeImage256() {
    for (const record of this) {
      await record.set('image256', await record.imageVariant256 || await (await record.productTemplateId).image256);
    }
  }

  async _computeImage128() {
    for (const record of this) {
      await record.set('image128', await record.imageVariant128 || await (await record.productTemplateId).image128);
    }
  }

  async _computeCanImage1024BeZoomed() {
    for (const record of this) {
      await record.set('canImage1024BeZoomed', await record.imageVariant1920 ? await record.canImageVariant1024BeZoomed : await (await record.productTemplateId).canImage1024BeZoomed);
    }
  }

  async _getPlaceholderFilename(field) {
    const imageFields = [1920, 1024, 512, 256, 128].map(size => f('image%s', size));
    if (imageFields.includes(field)) {
      return 'product/static/img/placeholder.png';
    }
    return _super(ProductProduct, this)._getPlaceholderFilename(field);
  }

  /**
   * Ensure there is at most one active variant for each combination.

    There could be no variant for a combination if using dynamic attributes.
   * @param self 
   */
  async init() {
    await this.env.cr.execute(`CREATE UNIQUE INDEX IF NOT EXISTS product_product_combination_unique ON "%s" ("productTemplateId", "combinationIndices") WHERE active is true`, [this.cls._table]);
  }

  async _getInvoicePolicy() {
    return false;
  }

  @api.depends('productTemplateAttributeValueIds')
  async _computeCombinationIndices() {
    for (const product of this) {
      await product.set('combinationIndices', (await product.productTemplateAttributeValueIds)._ids2str());
    }
  }

  async _computeIsProductVariant() {
    await this.set('isProductVariant', true);
  }

  @api.dependsContext('pricelist', 'partner', 'quantity', 'uom', 'date', 'noVariantAttributesPriceExtra')
  async _computeProductPrice() {
    let prices = {};
    let pricelistIdOrName = this._context['pricelist'];
    if (bool(pricelistIdOrName)) {
      let pricelist;
      const partner = this.env.context['partner'] ?? false;
      const quantity = this.env.context['quantity'] ?? 1.0;

      // Support context pricelists specified as list, displayName or ID for compatibility
      if (isList(pricelistIdOrName)) {
        pricelistIdOrName = pricelistIdOrName[0];
      }
      if (typeof (pricelistIdOrName) === 'string') {
        const pricelistNameSearch = await this.env.items('product.pricelist').nameSearch(pricelistIdOrName, '=', { limit: 1 });
        if (pricelistNameSearch.ok) {
          pricelist = this.env.items('product.pricelist').browse([pricelistNameSearch[0][0]]);
        }
      }
      else if (typeof (pricelistIdOrName) === 'number') {
        pricelist = this.env.items('product.pricelist').browse(pricelistIdOrName);
      }

      if (bool(pricelist)) {
        const quantities = _.fill(Array(this._length), quantity);
        const partners = _.fill(Array(this._length), partner);
        prices = await pricelist.getProductsPrice(this, quantities, partners);
      }
    }
    for (const product of this) {
      await product.set('price', prices[product.id] || 0.0);
    }
  }

  async _setProductPrice() {
    for (const product of this) {
      let value;
      if (this._context['uom']) {
        const value = await this.env.items('uom.uom').browse(this._context['uom'])._computePrice(await product.price, await product.uomId);
      }
      else {
        value = await product.price;
      }
      value -= await product.priceExtra;
      await product.write({ 'listPrice': value });
    }
  }

  @api.onchange('lstPrice')
  async _setProductLstPrice() {
    for (const product of this) {
      let value;
      if (this._context['uom']) {
        value = await this.env.items('uom.uom').browse(this._context['uom'])._computePrice(await product.lstPrice, await product.uomId);
      }
      else {
        value = await product.lstPrice;
      }
      value -= await product.priceExtra;
      await product.write({ 'listPrice': value });
    }
  }

  async _computeProductPriceExtra() {
    for (const product of this) {
      await product.set('priceExtra', sum(await (await product.productTemplateAttributeValueIds).mapped('priceExtra')));
    }
  }

  @api.depends('listPrice', 'priceExtra')
  @api.dependsContext('uom')
  async _computeProductLstPrice() {
    let toUom;// = None
    if ('uom' in this._context) {
      toUom = this.env.items('uom.uom').browse(this._context['uom']);
    }

    for (const product of this) {
      let listPrice;
      if (bool(toUom)) {
        listPrice = await (await product.uomId)._computePrice(await product.listPrice, toUom);
      }
      else {
        listPrice = await product.listPrice;
      }
      await product.set('lstPrice', listPrice + await product.priceExtra);
    }
  }

  @api.dependsContext('partnerId')
  async _computeProductCode() {
    for (const product of this) {
      let finished;
      for (const supplierInfo of await product.sellerIds) {
        if ((await supplierInfo.label).id == product._context['partnerId']) {
          await product.set('code', await supplierInfo.productCode || await product.defaultCode);
          finished = true;
          break;
        }
      }
      if (!finished) {
        await product.set('code', await product.defaultCode);
      }
    }
  }

  @api.dependsContext('partnerId')
  async _computePartnerRef() {
    for (const product of this) {
      let finished;
      for (const supplierInfo of await product.sellerIds) {
        if ((await supplierInfo.label).id == product._context['partnerId']) {
          const productName = await supplierInfo.productName || await product.defaultCode || await product.label;
          const productCode = await product.code;
          await product.set('partnerRef', f('%s%s', productCode ? f('[%s] ', productCode) : '', productName));
          finished = true;
          break;
        }
      }
      if (!finished) {
        await product.set('partnerRef', await product.displayName);
      }
    }
  }

  async _computeVariantItemCount() {
    for (const product of this) {
      const domain = ['|',
        '&', ['productTemplateId', '=', (await product.productTemplateId).id], ['appliedOn', '=', '1_product'],
        '&', ['productId', '=', product.id], ['appliedOn', '=', '0_productVariant']]
      await product.set('pricelistItemCount', await this.env.items('product.pricelist.item').searchCount(domain));
    }
  }

  @api.onchange('uomId')
  async _onchangeUomId() {
    const uomId = await (this as any).uomId;
    if (uomId.ok) {
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

  @api.onchange('defaultCode')
  async _onchangeDefaultCode() {
    const defaultCode = await (this as any).defaultCode;
    if (!defaultCode) {
      return;
    }

    const domain = [['defaultCode', '=', defaultCode]];
    if (this.id.origin) {
      domain.push(['id', '!=', this.id.origin]);
    }

    if ((await this.env.items('product.product').search(domain, { limit: 1 })).ok) {
      return {
        'warning': {
          'title': await this._t("Note:"),
          'message': await this._t("The Internal Reference '%s' already exists.", defaultCode),
        }
      }
    }
  }

  @api.modelCreateMulti()
  async create(valsList) {
    for (const vals of valsList) {
      await (await this['productTemplateId'])._sanitizeVals(vals);
    }
    const products = await _super(ProductProduct, await this.withContext({ createProductProduct: true })).create(valsList);
    // `_getVariantIdForCombination` depends on existing variants
    this.clearCaches();
    return products;
  }

  async write(values) {
    await (await this['productTemplateId'])._sanitizeVals(values);
    const res = await _super(ProductProduct, this).write(values);
    if ('productTemplateAttributeValueIds' in values) {
      // `_getVariantIdForCombination` depends on `productTemplateAttributeValueIds`
      this.clearCaches();
    }
    else if ('active' in values) {
      // `_getFirstPossibleVariantId` depends on variants active state
      this.clearCaches();
    }
    return res;
  }

  async unlink() {
    let unlinkProducts = this.env.items('product.product');
    let unlinkTemplates = this.env.items('product.template');
    for (const product of this) {
      // If there is an image set on the variant and no image set on the template, move the image to the template.
      const productTemplateId = await product.productTemplateId;
      const imageVariant1920 = await product.imageVariant1920;
      if (imageVariant1920 && ! await productTemplateId.image1920) {
        await productTemplateId.set('image1920', imageVariant1920);
      }
      // Check if product still exists, in case it has been unlinked by unlinking its template
      if (!bool(await product.exists())) {
        continue;
      }
      // Check if the product is last product of this template...
      const otherProducts = await this.search([['productTemplateId', '=', productTemplateId.id], ['id', '!=', product.id]]);
      // ... and do not delete product template if it's configured to be created "on demand"
      if (!bool(otherProducts) && ! await productTemplateId.hasDynamicAttributes()) {
        unlinkTemplates = unlinkTemplates.or(productTemplateId);
      }
      unlinkProducts = unlinkProducts.or(product);
    }
    const res = await _super(ProductProduct, unlinkProducts).unlink();
    // delete templates after calling super, as deleting template could lead to deleting
    // products due to ondelete='CASCADE'
    await unlinkTemplates.unlink();
    // `_getVariantIdForCombination` depends on existing variants
    this.clearCaches();
    return res;
  }

  _filterToUnlink(checkAccess = true) {
    return this;
  }

  /**
   * Unlink or archive products.
    Try in batch as much as possible because it is much faster.
    Use dichotomy when an exception occurs.
   * @param checkAccess 
   */
  async _unlinkOrArchive(checkAccess = true) {
    // Avoid access errors in case the products is shared amongst companies but the underlying objects are not. If unlink fails because of an
    // AccessError (e.g. while recomputing fields), the 'write' call will fail as well for the same reason since the field has been set to recompute.
    let self: any = this;
    if (checkAccess) {

      await self.checkAccessRights('unlink'),
      await self.checkAccessRule('unlink'),
      await self.checkAccessRights('write'),
      await self.checkAccessRule('write'),

      self = await self.sudo();
      const toUnlink = await self._filterToUnlink();
      const toArchive = self.sub(toUnlink);
      await toArchive.write({ 'active': false });
      self = toUnlink;
    }
    try {
      await self.env.cr.savepoint(async () => { //muteLogger('core.sqlDb'):
        await self.unlink();
      });
    } catch (e) {
      // We catch all kind of exceptions to be sure that the operation
      // doesn't fail.
      if (len(self) > 1) {
        await self([0, Math.round(len(self) / 2)])._unlinkOrArchive(false),
        await self([Math.round(len(self) / 2)])._unlinkOrArchive(false)
      }
      else {
        if (await self.active) {
          // Note: this can still fail if something is preventing
          // from archiving.
          // This is the case from existing stock reordering rules.
          await self.write({ 'active': false });
        }
      }
    }
  }

  /**
   * Variants are generated depending on the configuration of attributes and values on the template, so copying them does not make sense.

    For convenience the template is copied instead and its first variant is returned.
   * @param defaultValue 
   * @returns 
   */
  @api.returns('self', (value) => value.id)
  async copy(defaultValue?: any) {
    // copy variant is disabled in https://github.com/verp/verp/pull/38303 this returns the first possible combination of variant to make it works for now, need to be fixed to return product_variant_id if it's
    // possible in the future
    const template = await (await (this as any).productTemplateId).copy(defaultValue);
    const productVariantId = await template.productVariantId;
    return productVariantId.ok ? productVariantId : await template._createFirstProductVariant();
  }

  @api.model()
  async _search(args: any[], options: { offset?: number, limit?: number, order?: string, count?: boolean, accessRightsUid?: any } = {}) {
    // TDE FIXME: strange
    if (this._context['searchDefault_categId']) {
      args.push([['categId', 'childOf', this._context['searchDefault_categId']]]);
    }
    return _super(ProductProduct, this)._search(args, options);
  }

  @api.dependsContext('displayDefaultCode', 'sellerId')
  async _computeDisplayName() {
    // `displayName` is calling `nameGet()`` which is overidden on product to depend on `displayDefaultCode` and `sellerId`
    return _super(ProductProduct, this)._computeDisplayName();
  }

  async nameGet() {
    // TDE: this could be cleaned a bit I think
    const self = this;
    const sudo = await self.sudo();
    async function _nameGet(d: Dict<any>) {
      let name = d.get('label', '');
      const code = (self._context['displayDefaultCode'] ?? true) && d.get('defaultCode', false) || false;
      if (code) {
        name = f('[%s] %s', code, name);
      }
      return [d['id'], name];
    }

    const partnerId = self._context['partnerId'];
    let partnerIds;
    if (bool(partnerId)) {
      partnerIds = [partnerId, (await self.env.items('res.partner').browse(partnerId).commercialPartnerId).id];
    }
    else {
      partnerIds = [];
    }
    const companyId = self.env.context['companyId'];

    // all user don't have access to seller and partner
    // check access and use superuser

    await self.checkAccessRights("read"),
    await self.checkAccessRule("read")

    const result = [];

    // Prefetch the fields used by the `nameGet`, so `browse` doesn't fetch other fields  Use `load=false` to not call `nameGet` for the `productTemplateId`
    await sudo.read(['label', 'defaultCode', 'productTemplateId'], false);

    const productTemplateIds = (await sudo.mapped('productTemplateId')).ids;

    let supplierInfoByTemplate;
    if (bool(partnerIds)) {
      const supplierInfo = await (await self.env.items('product.supplierinfo').sudo()).search([
        ['productTemplateId', 'in', productTemplateIds],
        ['label', 'in', partnerIds],
      ]);
      // Prefetch the fields used by the `nameGet`, so `browse` doesn't fetch other fields Use `load=false` to not call `nameGet` for the `productTemplateId` and `productId`
      await (await supplierInfo.sudo()).read(['productTemplateId', 'productId', 'productName', 'productCode'], false);
      supplierInfoByTemplate = {};
      for (const r of supplierInfo) {
        setdefault(supplierInfoByTemplate, await r.productTemplateId, []).push(r);
      }
    }
    for (const product of sudo) {
      const variant = await (await product.productTemplateAttributeValueIds)._getCombinationName();

      const name = variant ? f("%s (%s)", await product.label, variant) : await product.label;
      let sellers = (await self.env.items('product.supplierinfo').sudo()).browse(self.env.context['sellerId']);
      if (!sellers.ok) {
        sellers = [];
      }
      if (!bool(sellers) && bool(partnerIds)) {
        const productSupplierInfo = supplierInfoByTemplate[await product.productTemplateId] ?? [];
        sellers = [];
        for (const x of productSupplierInfo) {
          const productId = await x.productId;
          if (productId.ok && productId.eq(product)) {
            sellers.push(x);
          }
        }
        if (!sellers.length) {
          for (const x of productSupplierInfo) {
            if (!bool(await x.productId)) {
              sellers.push(x);
            }
          }
        }
        // Filter out sellers based on the company. This is done afterwards for a better code readability. At this point, only a few sellers should remain, so it should not be a performance issue.
        if (bool(companyId)) {
          const _sellers = [];
          for (const x of sellers) {
            if ([companyId, false].includes((await x.companyId).id)) {
              _sellers.push(x);
            }
          }
          sellers = _sellers;
        }
      }
      if (bool(sellers)) {
        for (const s of sellers) {
          const productName = await s.productName;
          const sellerVariant = productName ? (
            variant.ok ? f("%s (%s)", productName, variant) : productName
          ) : false;
          const mydict = new Dict({
            'id': product.id,
            'label': sellerVariant ?? name,
            'defaultCode': await s.productCode || await product.defaultCode,
          });
          const temp = await _nameGet(mydict);
          if (!result.includes(temp)) {
            result.push(temp);
          }
        }
      }
      else {
        const mydict = new Dict({
          'id': product.id,
          'label': name,
          'defaultCode': await product.defaultCode,
        });
        result.push(await _nameGet(mydict));
      }
    }
    return result;
  }

  @api.model()
  async _nameSearch(name, args?: any[], operator = 'ilike', { limit=100, nameGetUid=false } = {}) {
    if (args) {
      args = []
    }
    let productIds;
    if (name) {
      const positiveOperators = ['=', 'ilike', '=ilike', 'like', '=like'];
      productIds = [];
      if (positiveOperators.includes(operator)) {
        productIds = await this._search([['defaultCode', '=', name]].concat(args), {limit, accessRightsUid: nameGetUid});
        if (!bool(productIds)) {
          productIds = await this._search([['barcode', '=', name]].concat(args), {limit, accessRightsUid: nameGetUid});
        }
      }
      if (!bool(productIds) && !expression.NEGATIVE_TERM_OPERATORS.includes(operator)) {
        // Do not merge the 2 next lines into one single search, SQL search performance would be abysmal
        // on a database with thousands of matching products, due to the huge merge+unique needed for the
        // OR operator (and given the fact that the 'label' lookup results come from the ir.translation table
        // Performing a quick memory merge of ids in Javascript will give much better performance
        productIds = await this._search(args.concat([['defaultCode', operator, name]]), { limit: limit });
        if (!limit || len(productIds) < limit) {
          // we may underrun the limit because of dupes in the results, that's fine
          const limit2 = limit ? (limit - len(productIds)) : null;
          const product2Ids = await this._search(args.concat([['label', operator, name], ['id', 'not in', productIds]]), { limit: limit2, accessRightsUid: nameGetUid });
          extend(productIds, product2Ids);
        }
      }
      else if (!bool(productIds) && expression.NEGATIVE_TERM_OPERATORS.includes(operator)) {
        let domain = expression.OR([
          ['&', ['defaultCode', operator, name], ['label', operator, name]],
          ['&', ['defaultCode', '=', false], ['label', operator, name]],
        ]);
        domain = expression.AND([args, domain]);
        productIds = await this._search(domain, {limit, accessRightsUid: nameGetUid});
      }
      if (!bool(productIds) && positiveOperators.includes(operator)) {
        const ptrn = /(\[(.*?)\])/;
        const res = name.match(ptrn);
        if (res) {
          productIds = await this._search([['defaultCode', '=', res[2]]].concat(args), {limit, accessRightsUid: nameGetUid});
        }
      }
      // still no results, partner in context: search on supplier info as last hope to find something
      if (!bool(productIds) && this._context['partnerId']) {
        const suppliersIds = await this.env.items('product.supplierinfo')._search([
          ['label', '=', this._context['partnerId']],
          '|',
          ['productCode', operator, name],
          ['productName', operator, name]], { accessRightsUid: nameGetUid });
        if (bool(suppliersIds)) {
          productIds = await this._search([['productTemplateId.sellerIds', 'in', suppliersIds]], {limit, accessRightsUid: nameGetUid});
        }
      }
    }
    else {
      productIds = await this._search(args, {limit, accessRightsUid: nameGetUid});
    }
    return productIds;
  }

  @api.model()
  async viewHeaderGet(viewId, viewType) {
    if (this._context['categId']) {
      return _f(await this._t('Products: {category}'),
        { category: (await this.env.items('product.category').browse(this.env.context['categId'])).label },
      );
    }
    return _super(ProductProduct, this).viewHeaderGet(viewId, viewType);
  }

  async actionOpenLabelLayout() {
    const action = await this.env.items('ir.actions.actions')._forXmlid('product.actionOpenLabelLayout');
    action['context'] = { 'default_productIds': this.ids }
    return action;
  }

  async openPricelistRules() {
    this.ensureOne();
    const domain = ['|',
      '&', ['productTemplateId', '=', (await (this as any).productTemplateId).id], ['appliedOn', '=', '1_product'],
      '&', ['productId', '=', this.id], ['appliedOn', '=', '0_productVariant']];
    return {
      'label': await this._t('Price Rules'),
      'viewMode': 'tree,form',
      'views': [[(await this.env.ref('product.productPricelistItemTreeViewFromProduct')).id, 'tree'], [false, 'form']],
      'resModel': 'product.pricelist.item',
      'type': 'ir.actions.actwindow',
      'target': 'current',
      'domain': domain,
      'context': {
        'default_productId': this.id,
        'default_appliedOn': '0_productVariant',
      }
    }
  }

  /**
   * Utility method used to add an "Open Template" button in product views
   * @returns 
   */
  async openProductTemplate() {
    this.ensureOne();
    return {
      'type': 'ir.actions.actwindow',
      'resModel': 'product.template',
      'viewMode': 'form',
      'resId': (await (this as any).productTemplateId).id,
      'target': 'new'
    }
  }

  async _buildCompareKey(seller) {
    // s.sequence, -s.minQty, s.price, s.id
    const [sequence, minQty, price, id] = await seller('sequence', 'minQty', 'price', 'id');
    let result = `${sequence.toString().padStart(6, '0')}`;
    result += `${(Number.MAX_SAFE_INTEGER - minQty).toString().padStart(16, '0')}`
    result += `${Math.round(price * 100).toString().padStart(10, '0')}`;
    result += `${id.toString().padStart(10, '0')}`;
    return result;
  }

  async _prepareSellers(params = false) {
    return (await (this as any).sellerIds).filtered(async (s) => await (await s.label).active).sorted(this._buildCompareKey);
  }

  async _selectSeller(partnerId: any = null, quantity: number = 0.0, date?: any, uomId?: any, params?: any) {
    this.ensureOne();
    if (date == null) {
      date = await _Date.contextToday(self);
    }
    const precision = await this.env.items('decimal.precision').precisionGet('Product Unit of Measure');

    let res = this.env.items('product.supplierinfo');
    let sellers = await this._prepareSellers(params);
    sellers = await sellers.filtered(async (s) => {
      const companyId = await s.companyId;
      return !bool(companyId) || companyId.id == (await this.env.company()).id;
    })
    for (const seller of sellers) {
      // Set quantity in UoM of seller
      const productUom = await seller.productUom;
      let quantityUomSeller = quantity;
      if (quantityUomSeller && uomId && !uomId.eq(productUom)) {
        quantityUomSeller = await uomId._computeQuantity(quantityUomSeller, productUom);
      }

      const dateStart = await seller.dateStart;
      if (dateStart && dateStart > date) {
        continue;
      }
      const dateEnd = await seller.dateEnd;
      if (dateEnd && dateEnd < date) {
        continue;
      }
      const label = await seller.label;
      if (partnerId && ![await partnerId.label, await (await partnerId).parentId].includes(label)) {
        continue;
      }
      if (quantity != null && floatCompare(quantityUomSeller, await seller.minQty, { precisionDigits: precision }) == -1) {
        continue;
      }
      const productId = await seller.productId;
      if (bool(productId) && !productId.eq(this)) {
        continue;
      }
      if (!bool(res) && await res.label === label) {
        res = res.or(seller);
      }
    }
    return (await res.sorted('price'))([0, 1]);
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

    let products: any = this;
    if (priceType === 'standardPrice') {
      // standardPrice field can only be seen by users in base.groupUser
      // Thus, in order to compute the sale price from the cost for users not in this group
      // We fetch the standard price as the superuser
      products = await (await products.withCompany(bool(company) ? company : await this.env.company())).sudo();
    }

    const prices = Dict.fromKeys(this.ids, 0.0);
    for (const product of products) {
      prices[product.id] = await product[priceType] || 0.0;
      if (priceType === 'listPrice') {
        prices[product.id] += await product.priceExtra;
        // we need to add the price from the attributes that do not generate variants
        // (see field product.attribute createVariant)
        if (this._context['noVariantAttributesPriceExtra']) {
          // we have a list of priceExtra that comes from the attribute values, we need to sum all that
          prices[product.id] += sum(this._context['noVariantAttributesPriceExtra']);
        }
      }
      if (bool(uom)) {
        prices[product.id] = await (await product.uomId)._computePrice(prices[product.id], uom);
      }

      // Convert from current user company currency to asked one
      // This is right cause a field cannot be in more than one currency
      if (currency) {
        prices[product.id] = await (await product.currencyId)._convert(prices[product.id], currency, await product.companyId, _Date.today());
      }
    }
    return prices;
  }

  @api.model()
  async getEmptyListHelp(help) {
    const self = await this.withContext({
      emptyListHelpDocumentName: await this._t("product")
    });
    return _super(ProductProduct, self).getEmptyListHelp(help);
  }

  /**
   * Compute a multiline description of this product, in the context of sales (do not use for purchases or other display reasons that don't intend to use "descriptionSale").
      It will often be used as the default description of a sale order line referencing this product.
   * @returns 
   */
  async getProductMultilineDescriptionSale() {
    const self: any = this;
    const descriptionSale = await self.descriptionSale;
    let name = await self.displayName;
    if (descriptionSale) {
      name += '\n' + descriptionSale;
    }
    return name;
  }

  /**
   * Return whether the variant is possible based on its own combination,
    and optionally a parent combination.

    See `_is_combination_possible` for more information.

    :param parentCombination: combination from which `self` is an
        optional or accessory product.
    :type parentCombination: recordset `product.template.attribute.value`

    :return: ẁhether the variant is possible based on its own combination
    :rtype: bool
   * @param parentCombination 
   * @returns 
   */
  async _isVariantPossible(parentCombination?: any) {
    const self: any = this;
    self.ensureOne();
    return (await self.productTemplateId)._isCombinationPossible(await self.productTemplateAttributeValueIds, parentCombination, true);
  }

  /**
   * Archiving related product.template if there is not any more active product.product
    (and vice versa, unarchiving the related product template if there is now an active product.product)
   * @returns 
   */
  async toggleActive() {
    const result = await _super(ProductProduct, this).toggleActive();
    // We deactivate product templates which are active with no active variants.
    const tmplToDeactivate = await (await this.filtered(async (product) => {
      const productTemplateId = await product.productTemplateId;
      return await productTemplateId.active && !bool(await productTemplateId.productVariantIds);
    })).mapped('productTemplateId');
    // We activate product templates which are inactive with active variants.
    const tmplToActivate = await (await this.filtered(async (product) => {
      const productTemplateId = await product.productTemplateId;
      return !bool(await productTemplateId.active) && bool(await productTemplateId.productVariantIds)
    })).mapped('productTemplateId');
    await tmplToDeactivate.add(tmplToActivate).toggleActive();
    return result;
  }
}

@MetaModel.define()
class ProductPackaging extends Model {
  static _module = module;
  static _name = "product.packaging";
  static _description = "Product Packaging";
  static _order = 'productId, sequence, id';
  static _checkCompanyAuto = true;

  static label = Fields.Char('Product Packaging', { required: true });
  static sequence = Fields.Integer('Sequence', { default: 1, help: "The first in the sequence is the default one." });
  static productId = Fields.Many2one('product.product', { string: 'Product', checkCompany: true });
  static qty = Fields.Float('Contained Quantity', { default: 1, digits: 'Product Unit of Measure', help: "Quantity of products contained in the packaging." });
  static barcode = Fields.Char('Barcode', { copy: false, help: "Barcode used for packaging identification. Scan this packaging barcode from a transfer in the Barcode app to move all the contained units" });
  static productUomId = Fields.Many2one('uom.uom', { related: 'productId.uomId', readonly: true });
  static companyId = Fields.Many2one('res.company', { string: 'Company', index: true });

  static _sqlConstraints = [
    ['positive_qty', 'CHECK(qty > 0)', 'Contained Quantity should be positive.']
  ]

  /**
   * Check if productQty in given uom is a multiple of the packaging qty. If not, rounding the productQty to closest multiple of the packaging qty according to the roundingMethod "UP", "HALF-UP or "DOWN".
   * @param productQty 
   * @param uomId 
   * @param roundingMethod 
   * @returns 
   */
  async _checkQty(productQty, uomId, roundingMethod = "HALF-UP") {
    this.ensureOne();
    const self: any = this;
    const defaultUom = await (await self.productId).uomId;
    const packagingQty = await defaultUom._computeQuantity(await self.qty, uomId);
    // We do not use the modulo operator to check if qty is a mltiple of q. Indeed the quantity per package might be a float, leading to incorrect results. For example:
    // 8 % 1.6 = 1.5999999999999996
    // 5.4 % 1.8 = 2.220446049250313e-16
    if (productQty && packagingQty) {
      const roundedQty = floatRound(productQty / packagingQty, { precisionRounding: 1.0, roundingMethod: roundingMethod }) * packagingQty;
      return floatCompare(roundedQty, productQty, { precisionRounding: await defaultUom.rounding }) ? roundedQty : productQty;
    }
    return productQty;
  }

  /**
   * try find in `self` if a packaging's qty in given uom is a divisor of
    the given productQty. If so, return the one with greatest divisor.
   * @param productQty 
   * @param uomId 
   * @returns 
   */
  async _findSuitableProductPackaging(productQty, uomId) {
    const packagings = await this.sorted(async (p) => p.qty, true);
    for (const packaging of packagings) {
      const newQty = await packaging._checkQty(productQty, uomId);
      if (newQty == productQty) {
        return packaging;
      }
    }
    return this.env.items('product.packaging');
  }
}

@MetaModel.define()
class SupplierInfo extends Model {
  static _module = module;
  static _name = "product.supplierinfo";
  static _description = "Supplier Pricelist";
  static _order = 'sequence, minQty DESC, price, id';

  static label = Fields.Many2one(
    'res.partner', {
      string: 'Vendor',
    ondelete: 'CASCADE', required: true,
    help: "Vendor of this product", checkCompany: true
  });
  static productName = Fields.Char(
    'Vendor Product Name',
    { help: "This vendor's product name will be used when printing a request for quotation. Keep empty to use the internal one." });
  static productCode = Fields.Char(
    'Vendor Product Code',
    { help: "This vendor's product code will be used when printing a request for quotation. Keep empty to use the internal one." });
  static sequence = Fields.Integer(
    'Sequence', { default: 1, help: "Assigns the priority to the list of product vendor." });
  static productUom = Fields.Many2one(
    'uom.uom', {
      string: 'Unit of Measure',
    related: 'productTemplateId.uomPoId',
    help: "This comes from the product form."
  })
  static minQty = Fields.Float(
    'Quantity', {
      default: 0.0, required: true, digits: "Product Unit Of Measure",
    help: "The quantity to purchase from this vendor to benefit from the price, expressed in the vendor Product Unit of Measure if not any, in the default unit of measure of the product otherwise."
  });
  static price = Fields.Float(
    'Price', {
      default: 0.0, digits: 'Product Price',
    required: true, help: "The price to purchase a product"
  });
  static companyId = Fields.Many2one(
    'res.company', {
      string: 'Company',
    default: async (self) => (await self.env.company()).id, index: 1
  });
  static currencyId = Fields.Many2one(
    'res.currency', {
      string: 'Currency',
    default: async (self) => (await (await self.env.company()).currencyId).id,
    required: true
  })
  static dateStart = Fields.Date('Start Date', { help: "Start date for this vendor price" });
  static dateEnd = Fields.Date('End Date', { help: "End date for this vendor price" });
  static productId = Fields.Many2one(
    'product.product', {
      string: 'Product Variant', checkCompany: true,
    help: "If not set, the vendor price will apply to all variants of this product."
  });
  static productTemplateId = Fields.Many2one(
    'product.template', {
      string: 'Product Template', checkCompany: true,
    index: true, ondelete: 'CASCADE'
  });
  static productVariantCount = Fields.Integer('Variant Count', { related: 'productTemplateId.productVariantCount' });
  static delay = Fields.Integer(
    'Delivery Lead Time', {
      default: 1, required: true,
    help: "Lead time in days between the confirmation of the purchase order and the receipt of the products in your warehouse. Used by the scheduler for automatic computation of the purchase order planning."
  });

  @api.model()
  async getImportTemplates() {
    return [{
      'label': await this._t('Import Template for Vendor Pricelists'),
      'template': '/product/static/xls/product_supplierinfo.xls'
    }]
  }

  @api.constrains('productId', 'productTemplateId')
  async _checkProductVariant() {
    for (const supplier of this) {
      const [productId, productTemplateId] = await supplier('productId', 'productTemplateId');
      if (bool(productId) && bool(productTemplateId) && !(await productId.productTemplateId).eq(productTemplateId)) {
        throw new ValidationError(await this._t('The product variant must be a variant of the product template.'));
      }
    }
  }
}