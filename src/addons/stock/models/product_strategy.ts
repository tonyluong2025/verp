import { api } from "../../../core";
import { Fields } from "../../../core/fields";
import { UserError } from "../../../core/helper/errors";
import { MetaModel, Model, _super } from "../../../core/models";
import { bool } from "../../../core/tools/bool";
import { floatCompare } from "../../../core/tools/float_utils";

@MetaModel.define()
class RemovalStrategy extends Model {
  static _module = module;
  static _name = 'product.removal';
  static _description = 'Removal Strategy';

  static label = Fields.Char('Name', {required: true});
  static method = Fields.Char("Method", {required: true, help: "FIFO, LIFO..."});
}

@MetaModel.define()
class StockPutawayRule extends Model {
  static _module = module;
  static _name = 'stock.putaway.rule';
  static _order = 'sequence,productId';
  static _description = 'Putaway Rule';
  static _checkCompanyAuto = true;

  async _defaultCategoryId() {
    if (this.env.context['activeModel'] === 'product.category') {
      return this.env.context['activeId'];
    }
  }

  async _defaultLocationId() {
    if (this.env.context['activeModel'] === 'stock.location') {
      return this.env.context['activeId'];
    }
    if (!await (await this.env.user()).hasGroup('stock.groupStockMultiWarehouses')) {
      const wh = this.env.items('stock.warehouse').search([['companyId', '=', (await this.env.company()).id]], {limit: 1});
      const [inputLoc] = await wh._getInputOutputLocations(await wh('receptionSteps', 'deliverySteps'));
      return inputLoc;
    }
  }

  async _defaultProductId() {
    if (this.env.context['activeModel'] === 'product.template' && this.env.context['activeId']) {
      let productTemplate = this.env.items('product.template').browse(this.env.context['activeId']);
      productTemplate = await productTemplate.exists();
      if (await productTemplate.productVariantCount == 1) {
        return await productTemplate.productVariantId;
      }
    }
    else if (this.env.context['activeModel'] === 'product.product') {
      return this.env.context['activeId'];
    }
  }

  async _domainCategoryId() {
    const activeModel = this.env.context['activeModel'];
    if (['product.template', 'product.product'].includes(activeModel) && this.env.context['activeId']) {
      let product = this.env.items(activeModel).browse(this.env.context['activeId']);
      product = await product.exists();
      if (product.ok) {
        return [['id', '=', (await product.categId).id]];
      }
    }
    return [];
  }

  async _domainProductId() {
    const domain = "[['type', '!=', 'service'], '|', ['companyId', '=', false], ['companyId', '=', companyId]]";
    if (this.env.context['activeModel'] === 'product.template') {
      return [['productTemplateId', '=', this.env.context['activeId']]];
    }
    return domain;
  }

  static productId = Fields.Many2one(
      'product.product', {string: 'Product', checkCompany: true,
      default: (s) => s._defaultProductId(), domain: (s) => s._domainProductId(), ondelete: 'CASCADE'});
  static categoryId = Fields.Many2one('product.category', {string: 'Product Category', default: (s) => s._defaultCategoryId(), domain: (s) => s._domainCategoryId(), ondelete: 'CASCADE'});
  static locationInId = Fields.Many2one(
      'stock.location', {string: 'When product arrives in', checkCompany: true, domain: "[['childIds', '!=', false], '|', ['companyId', '=', false], ['companyId', '=', companyId]]",
      default: (s) => s._defaultLocationId(), required: true, ondelete: 'CASCADE', index: true});
  static locationOutId = Fields.Many2one(
      'stock.location', {string: 'Store to sublocation', checkCompany: true, domain: "[['id', 'childOf', locationInId], '|', ['companyId', '=', false], ['companyId', '=', companyId]]",
      required: true, ondelete: 'CASCADE'});
  static sequence = Fields.Integer('Priority', {help: "Give to the more specialized category, a higher priority to have them in top of the list."});
  static companyId = Fields.Many2one(
      'res.company', {string: 'Company', required: true,
      default: async (s) => (await s.env.company()).id, index: true})
  static packageTypeIds = Fields.Many2many('stock.package.type', {string: 'Package Type', checkCompany: true});
  static storageCategoryId = Fields.Many2one('stock.storage.category', {string: 'Storage Category', ondelete: 'CASCADE', checkCompany: true});
  static active = Fields.Boolean('Active', {default: true});

  @api.onchange('locationInId')
  async _onchangeLocationIn() {
    const [locationInId, locationOutId] = await this('locationInId', 'locationOutId');
    let childLocationCount = 0;
    if (locationOutId.ok) {
      childLocationCount = await this.env.items('stock.location').searchCount([
        ['id', '=', locationOutId.id],
        ['id', 'childOf', locationInId.id],
        ['id', '!=', locationInId.id],
      ]);
    }
    if (! childLocationCount || ! locationOutId.ok) {
      await this.set('locationOutId', locationInId);
    }
  }

  async write(vals) {
    if ('companyId' in vals) {
      for (const rule of this) {
        if ((await rule.companyId).id != vals['companyId']) {
          throw new UserError(await this._t("Changing the company of this record is forbidden at this point, you should rather archive it and create a new one."));
        }
      }
    }
    return _super(StockPutawayRule, this).write(vals);
  }

  async _getPutawayLocation(product, quantity: number=0, pack?: any, qtyByLocation?: any) {
    const packageType = bool(pack) ? await pack.packageTypeId : null;

    const checkedLocations = new Set<any>();
    for (const putawayRule of this) {
      const locationOut = await putawayRule.locationOutId;

      if (! putawayRule.storageCategoryId) {
        if (checkedLocations.has(locationOut.id)) {
          continue;
        }
        if (locationOut._checkCanBeUsed(product, quantity, pack, qtyByLocation[locationOut.id])) {
          return locationOut;
        }
        continue;
      }
      const childLocations = await locationOut.childInternalLocationIds;
      // check if already have the product/package type stored
      for (const location of childLocations) {
        if (checkedLocations.has(location.id)) {
          continue;
        }
        if (bool(packageType)) {
          if (await (await location.quantIds).filtered(async (q) => (await q.productId).eq(product) && bool(await q.packageId) && (await (await q.packageId).packageTypeId).eq(packageType))) {
            if (await location._checkCanBeUsed(product, {package: pack, location: qtyByLocation[location.id]})) {
              return location;
            }
            else {
              checkedLocations.add(location.id);
            }
          }
        }
        else if (floatCompare(qtyByLocation[location.id], 0, {precisionRounding: await (await product.uomId).rounding}) > 0) {
          if (await location._checkCanBeUsed(product, {quantity: quantity, location: qtyByLocation[location.id]})) {
            return location;
          }
          else {
            checkedLocations.add(location.id);
          }
        }
      }

      // check locations with matched storage category
      for (const location of await childLocations.filtered(async (l) => (await l.storageCategoryId).eq(await putawayRule.storageCategoryId))) {
        if (checkedLocations.has(location.id)) {
          continue;
        }
        if (await location._checkCanBeUsed(product, {quantity: quantity, package: pack, location: qtyByLocation[location.id]})) {
          return location;
        }
        checkedLocations.add(location.is);
      }
    }
    return null;
  }
}