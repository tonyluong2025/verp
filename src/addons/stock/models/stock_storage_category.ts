import { api } from "../../../core"
import { Fields } from "../../../core/fields"
import { Dict } from "../../../core/helper/collections"
import { MetaModel, Model, _super } from "../../../core/models"

@MetaModel.define()
class StorageCategory extends Model {
  static _module = module;
  static _name = 'stock.storage.category';
  static _description = "Storage Category";
  static _order = "label";

  static label = Fields.Char('Storage Category', {required: true});
  static maxWeight = Fields.Float('Max Weight', {digits: 'Stock Weight'});
  static capacityIds = Fields.One2many('stock.storage.category.capacity', 'storageCategoryId', { copy: true});
  static productCapacityIds = Fields.One2many('stock.storage.category.capacity', {compute: "_computeStorageCapacityIds", inverse: "_setStorageCapacityIds"});
  static packageCapacityIds = Fields.One2many('stock.storage.category.capacity', {compute: "_computeStorageCapacityIds", inverse: "_setStorageCapacityIds"});
  static allowNewProduct = Fields.Selection([
      ['empty', 'If the location is empty'],
      ['same', 'If all products are same'],
      ['mixed', 'Allow mixed products']], {default: 'mixed', required: true});
  static locationIds = Fields.One2many('stock.location', 'storageCategoryId');
  static companyId = Fields.Many2one('res.company', {string: 'Company'});

  static _sqlConstraints = [
      ['positiveMaxWeight', 'CHECK("maxWeight" >= 0)', 'Max weight should be a positive number.'],
  ];

  @api.depends('capacityIds')
  async _computeStorageCapacityIds() {
    for (const storageCategory of this) {
      const capacityIds = await storageCategory.capacityIds;
      // await Promise.all([
        await storageCategory.set('productCapacityIds', await capacityIds.filtered((c) => c.productId)),            await storageCategory.set('packageCapacityIds', await capacityIds.filtered((c) => c.packageTypeId))
      // ]);
    }
  }

  async _setStorageCapacityIds() {
    for (const storageCategory of this) {
      await storageCategory.set('capacityIds', (await storageCategory.productCapacityIds).or(await storageCategory.packageCapacityIds));
    }
  }

  async copy(defaultValue?: any) {
    defaultValue = new Dict(defaultValue ?? {});
    defaultValue.update({label: await this._t("%s (copy)", await this['label'])});
    return _super(StorageCategory, this).copy(defaultValue);
  }
}

@MetaModel.define()
class StorageCategoryProductCapacity extends Model {
  static _module = module;
  static _name = 'stock.storage.category.capacity';
  static _description = "Storage Category Capacity";
  static _checkCompanyAuto = true;
  static _order = "storageCategoryId";

  @api.model()
  async _domainProductId() {
    let domain = "['type', '=', 'product']";
    if (this.env.context['activeModel'] === 'product.template') {
      const productTemplateId = this.env.context['activeId'] ?? false;
      domain = `['productTemplateId', '=', ${productTemplateId}]`;
    }
    else if (this.env.context['default_productId']) {
      const productId = this.env.context['default_productId'] ?? false;
      domain = `['id', '=', ${productId}]`;
    }
    return `[${domain}, '|', ['companyId', '=', false], ['companyId', '=', companyId]]`;
  }

  static storageCategoryId = Fields.Many2one('stock.storage.category', {ondelete: 'CASCADE', required: true, index: true});
  static productId = Fields.Many2one('product.product', {string: 'Product', domain: (self) => self._domainProductId(), ondelete: 'CASCADE', checkCompany: true});
  static packageTypeId = Fields.Many2one('stock.package.type', {string: 'Package Type', ondelete: 'CASCADE', checkCompany: true});
  static quantity = Fields.Float('Quantity', {required: true});
  static productUomId = Fields.Many2one({related: 'productId.uomId'});
  static companyId = Fields.Many2one('res.company', {string: 'Company', related: "storageCategoryId.companyId"});

  static _sqlConstraints = [
    ['positiveQuantity', 'CHECK(quantity > 0)', 'Quantity should be a positive number.'],
    ['uniqueProduct', 'UNIQUE("productId", "storageCategoryId")', 'Multiple capacity rules for one product.'],
    ['uniquePackageType', 'UNIQUE("packageTypeId", "storageCategoryId")', 'Multiple capacity rules for one package type.'],
  ];
}