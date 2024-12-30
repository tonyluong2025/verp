import { api } from "../../../core";
import { Fields, _Datetime } from "../../../core/fields";
import { UserError } from "../../../core/helper/errors";
import { MetaModel, Model } from "../../../core/models";
import { bool } from "../../../core/tools/bool";
import { floatCompare } from "../../../core/tools/float_utils";
import { sum } from "../../../core/tools/iterable";

@MetaModel.define()
class StockScrap extends Model {
  static _module = module;
  static _name = 'stock.scrap';
  static _parents = ['mail.thread'];
  static _order = 'id desc';
  static _description = 'Scrap';

  async _getDefaultScrapLocationId() {
    const companyId = this.env.context['default_companyId'] ?? (await this.env.company()).id;
    return (await this.env.items('stock.location').search([['scrapLocation', '=', true], ['companyId', 'in', [companyId, false]]], { limit: 1 })).id;
  }

  async _getDefaultLocationId() {
    const companyId = this.env.context['default_companyId'] ?? (await this.env.company()).id;
    const warehouse = await this.env.items('stock.warehouse').search([['companyId', '=', companyId]], { limit: 1 });
    if (warehouse.ok) {
      return (await warehouse.lotStockId).id;
    }
    return null;
  }

  static label = Fields.Char(
    'Reference', { default: self => self._t('New'), copy: false, readonly: true, required: true, states: { 'done': [['readonly', true]] } });
  static companyId = Fields.Many2one('res.company', { string: 'Company', default: self => self.env.company(), required: true, states: { 'done': [['readonly', true]] } });
  static origin = Fields.Char({ string: 'Source Document' });
  static productId = Fields.Many2one(
    'product.product', { string: 'Product', domain: "[['type', 'in', ['product', 'consu']], '|', ['companyId', '=', false], ['companyId', '=', companyId]]", required: true, states: { 'done': [['readonly', true]] }, checkCompany: true });
  static productUomId = Fields.Many2one(
    'uom.uom', { string: 'Unit of Measure', required: true, states: { 'done': [['readonly', true]] }, domain: "[['categoryId', '=', productUomCategoryId]]" });
  static productUomCategoryId = Fields.Many2one({ related: 'productId.uomId.categoryId' });
  static tracking = Fields.Selection({ string: 'Product Tracking', readonly: true, related: "productId.tracking" });
  static lotId = Fields.Many2one(
    'stock.production.lot', { string: 'Lot/Serial', states: { 'done': [['readonly', true]] }, domain: "[['productId', '=', productId], ['companyId', '=', companyId]]", checkCompany: true });
  static packageId = Fields.Many2one(
    'stock.quant.package', { string: 'Package', states: { 'done': [['readonly', true]] }, checkCompany: true });
  static ownerId = Fields.Many2one('res.partner', { string: 'Owner', states: { 'done': [['readonly', true]] }, checkCompany: true });
  static moveId = Fields.Many2one('stock.move', { string: 'Scrap Move', readonly: true, checkCompany: true, copy: false });
  static pickingId = Fields.Many2one('stock.picking', { string: 'Picking', states: { 'done': [['readonly', true]] }, checkCompany: true });
  static locationId = Fields.Many2one(
    'stock.location', { string: 'Source Location', domain: "[['usage', '=', 'internal'], ['companyId', 'in', [companyId, false]]]", required: true, states: { 'done': [['readonly', true]] }, default: self => self._getDefaultLocationId(), checkCompany: true });
  static scrapLocationId = Fields.Many2one(
    'stock.location', { string: 'Scrap Location', default: self => self._getDefaultScrapLocationId(), domain: "[['scrapLocation', '=', true], ['companyId', 'in', [companyId, false]]]", required: true, states: { 'done': [['readonly', true]] }, checkCompany: true });
  static scrapQty = Fields.Float('Quantity', { default: 1.0, required: true, states: { 'done': [['readonly', true]] } });
  static state = Fields.Selection([
    ['draft', 'Draft'],
    ['done', 'Done']],
    { string: 'Status', default: "draft", readonly: true, tracking: true });
  static dateDone = Fields.Datetime('Date', { readonly: true });

  @api.onchange('pickingId')
  async _onchangePickingId() {
    const pickingId = await this['pickingId'];
    if (pickingId.ok) {
      const locationDestId = (await pickingId.locationDestId).id;
      await this.set('locationId', (await pickingId.state === 'done') && bool(locationDestId) && locationDestId || (await pickingId.locationId).id);
    }
  }

  @api.onchange('productId')
  async _onchangeProductId() {
    const productId = await this['productId'];
    if (productId.ok) {
      if (await this['tracking'] === 'serial') {
        await this.set('scrapQty', 1);
      }
      await this.set('productUomId', (await productId.uomId).id);
      // Check if we can get a more precise location instead of
      // the default location (a location corresponding to where the
      // reserved product is stored)
      const pickingId = await this['pickingId'];
      if (pickingId.ok) {
        for (const moveLine of await pickingId.moveLineIds) {
          if ((await moveLine.productId).eq(productId)) {
            await this.set('locationId', await moveLine.state !== 'done' ? await moveLine.locationId : await moveLine.locationDestId);
            break;
          }
        }
      }
    }
  }

  @api.onchange('companyId')
  async _onchangeCompanyId() {
    const companyId = await this['companyId'];
    if (companyId.ok) {
      const warehouse = await this.env.items('stock.warehouse').search([['companyId', '=', companyId.id]], { limit: 1 });
      // Change the locations only if their company doesn't match the company set, otherwise
      // user defaults are overridden.
      const locationId = await this['locationId'];
      if (!(await locationId.companyId).eq(companyId)) {
        await this.set('locationId', await warehouse.lotStockId);
      }
      const scrapLocationId = await this['scrapLocationId'];
      if (!(await scrapLocationId.companyId).eq(companyId)) {
        await this.set(scrapLocationId, await this.env.items('stock.location').search([
          ['scrapLocation', '=', true],
          ['companyId', 'in', [companyId.id, false]],
        ], { limit: 1 }));
      }
    }
    else {
      // await Promise.all([
      await this.set('locationId', false),
        await this.set('scrapLocationId', false)
      // ]);
    }
  }

  @api.onchange('lotId')
  async _onchangeSerialNumber() {
    const [productId, lotId, companyId, locationId, pickingId] = await this('productId', 'lotId', 'companyId', 'locationId', 'pickingId');
    if (await productId.tracking === 'serial' && bool(lotId)) {
      const [message, recommendedLocation] = await this.env.items('stock.quant')._checkSerialNumber(productId, lotId, companyId, locationId, await pickingId.locationDestId);
      if (message) {
        if (bool(recommendedLocation)) {
          await this.set('locationId', recommendedLocation);
        }
        return { 'warning': { 'title': await this._t('Warning'), 'message': message } }
      }
    }
  }

  @api.ondelete(false)
  async _unlinkExceptDone() {
    if ('done' in await this.mapped('state')) {
      throw new UserError(await this._t('You cannot delete a scrap which is done.'));
    }
  }

  async _prepareMoveValues() {
    this.ensureOne();
    const [label, productId, lotId, companyId, locationId, pickingId, productUomId, scrapQty, scrapLocationId, packageId, ownerId] = await this('label', 'productId', 'lotId', 'companyId', 'locationId', 'pickingId', 'productUomId', 'scrapQty', 'scrapLocationId', 'packageId', 'ownerId');
    return {
      'label': label,
      'origin': origin ? await pickingId.label : label,
      'companyId': companyId.id,
      'productId': productId.id,
      'productUom': productUomId.id,
      'state': 'draft',
      'productUomQty': scrapQty,
      'locationId': locationId.id,
      'scrapped': true,
      'locationDestId': scrapLocationId.id,
      'moveLineIds': [[0, 0, {
        'productId': productId.id,
        'productUomId': productUomId.id,
        'qtyDone': scrapQty,
        'locationId': locationId.id,
        'locationDestId': scrapLocationId.id,
        'packageId': packageId.id,
        'ownerId': ownerId.id,
        'lotId': lotId.id
      }]],
      //             'restrict_partner_id': self.owner_id.id,
      'pickingId': pickingId.id
    }
  }

  async doScrap() {
    await this._checkCompany();
    for (const scrap of this) {
      await scrap.set('label', await this.env.items('ir.sequence').nextByCode('stock.scrap') || await this._t('New'));
      const move = await this.env.items('stock.move').create(scrap._prepareMoveValues());
      // master: replace context by cancel_backorder
      await (await move.withContext({ isScrap: true }))._actionDone();
      await scrap.write({ 'moveId': move.id, 'state': 'done' });
      await scrap.set('dateDone', _Datetime.now());
    }
    return true;
  }

  async actionGetStockPicking() {
    const action = await this.env.items("ir.actions.actions")._forXmlid('stock.actionPickingTreeAll');
    action['domain'] = [['id', '=', (await this['pickingId']).id]];
    return action;
  }

  async actionGetStockMoveLines() {
    const action = await this.env.items("ir.actions.actions")._forXmlid('stock.stockMoveLineAction');
    action['domain'] = [['moveId', '=', (await this['moveId']).id]];
    return action;
  }

  async actionValidate() {
    this.ensureOne();
    const [productId, lotId, locationId, productUomId, packageId, ownerId] = await this('productId', 'lotId', 'locationId', 'productUomId', 'packageId', 'ownerId');
    if (await productId.type !== 'product') {
      return this.doScrap();
    }
    const precision = await this.env.items('decimal.precision').precisionGet('Product Unit of Measure');
    const availableQty = sum(await (await this.env.items('stock.quant')._gather(productId, locationId, lotId, packageId, ownerId, { strict: true })).mapped('quantity'));
    const scrapQty = await productUomId._computeQuantity(await this['scrapQty'], await productId.uomId);
    if (floatCompare(availableQty, scrapQty, { precisionDigits: precision }) >= 0) {
      return this.doScrap();
    }
    else {
      const ctx = Object.assign({}, this.env.context, {
        'default_productId': productId.id,
        'default_locationId': locationId.id,
        'default_scrapId': this.id,
        'default_quantity': scrapQty,
        'default_productUomName': await productId.uomName
      })
      return {
        'label': await productId.displayName + await this._t(': Insufficient Quantity To Scrap'),
        'viewMode': 'form',
        'resModel': 'stock.warn.insufficient.qty.scrap',
        'viewId': (await this.env.ref('stock.stockWarnInsufficientQtyScrapFormView')).id,
        'type': 'ir.actions.actwindow',
        'context': ctx,
        'target': 'new'
      }
    }
  }
}