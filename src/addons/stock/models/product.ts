import _ from "lodash";
import { api } from "../../../core";
import { Fields, _Datetime } from "../../../core/fields";
import { DefaultDict2, Dict } from "../../../core/helper/collections";
import { UserError } from "../../../core/helper/errors";
import { MetaModel, Model, _super } from "../../../core/models";
import { expression } from "../../../core/osv";
import { _f, bool, floatIsZero, floatRound, len, sum } from "../../../core/tools";
import { literalEval } from "../../../core/tools/ast";
import { subDate } from "../../../core/tools/date_utils";
import { pop, update } from "../../../core/tools/misc";

const OPERATORS = {
  '<': _.lt,
  '>': _.gt,
  '<=': _.lte,
  '>=': _.gte,
  '=': _.eq,
  '!=': (a, b) => !_.eq(a, b)
}

@MetaModel.define()
class Product extends Model {
  static _module = module;
  static _parents = "product.product";

  static stockQuantIds = Fields.One2many('stock.quant', 'productId', { help: 'Technical: used to compute quantities.' });
  static stockMoveIds = Fields.One2many('stock.move', 'productId', { help: 'Technical: used to compute quantities.' });
  static qtyAvailable = Fields.Float(
    'Quantity On Hand', {
    compute: '_computeQuantities', search: '_searchQtyAvailable', digits: 'Product Unit of Measure', computeSudo: false, help: ["Current quantity of products.\n",
      "In a context with a single Stock Location, this includes goods stored at this Location, or any of its children.\n",
      "In a context with a single Warehouse, this includes goods stored in the Stock Location of this Warehouse, or any of its children.stored in the Stock Location of the Warehouse of this Shop, or any of its children.\n",
      "Otherwise, this includes goods stored in any Stock Location with 'internal' type."].join('')
  })
  static virtualAvailable = Fields.Float(
    'Forecasted Quantity', {
    compute: '_computeQuantities', search: '_searchVirtualAvailable', digits: 'Product Unit of Measure', computeSudo: false, help: ["Forecast quantity (computed as Quantity On Hand - Outgoing + Incoming)\n",
      "In a context with a single Stock Location, this includes goods stored in this location, or any of its children.\n",
      "In a context with a single Warehouse, this includes  goods stored in the Stock Location of this Warehouse, or any of its children.\n",
      "Otherwise, this includes goods stored in any Stock Location with 'internal' type."].join('')
  });
  static freeQty = Fields.Float(
    'Free To Use Quantity ', {
    compute: '_computeQuantities', search: '_searchFreeQty', digits: 'Product Unit of Measure', computeSudo: false, help: ["Forecast quantity (computed as Quantity On Hand - reserved quantity)\n",
      "In a context with a single Stock Location, this includes goods stored in this location, or any of its children.\n",
      "In a context with a single Warehouse, this includes goods stored in the Stock Location of this Warehouse, or any of its children.\n",
      "Otherwise, this includes goods stored in any Stock Location with 'internal' type."].join('')
  });
  static incomingQty = Fields.Float(
    'Incoming', {
    compute: '_computeQuantities', search: '_searchIncomingQty', digits: 'Product Unit of Measure', computeSudo: false, help: ["Quantity of planned incoming products.\n",
      "In a context with a single Stock Location, this includes goods arriving to this Location, or any of its children.\n",
      "In a context with a single Warehouse, this includes goods arriving to the Stock Location of this Warehouse, or any of its children.\n",
      "Otherwise, this includes goods arriving to any Stock Location with 'internal' type."].join('')
  });
  static outgoingQty = Fields.Float(
    'Outgoing', {
    compute: '_computeQuantities', search: '_searchOutgoingQty', digits: 'Product Unit of Measure', computeSudo: false, help: ["Quantity of planned outgoing products.\n",
      "In a context with a single Stock Location, this includes goods leaving this Location, or any of its children.\n",
      "In a context with a single Warehouse, this includes goods leaving the Stock Location of this Warehouse, or any of its children.\n",
      "Otherwise, this includes goods leaving any Stock Location with 'internal' type."].join('')
  });

  static orderpointIds = Fields.One2many('stock.warehouse.orderpoint', 'productId', { string: 'Minimum Stock Rules' });
  static nbrMovesIn = Fields.Integer({ compute: '_computeNbrMoves', computeSudo: false, help: "Number of incoming stock moves in the past 12 months" });
  static nbrMovesOut = Fields.Integer({ compute: '_computeNbrMoves', computeSudo: false, help: "Number of outgoing stock moves in the past 12 months" });
  static nbrReorderingRules = Fields.Integer('Reordering Rules',
    { compute: '_computeNbrReorderingRules', computeSudo: false });
  static reorderingMinQty = Fields.Float(
    { compute: '_computeNbrReorderingRules', computeSudo: false });
  static reorderingMaxQty = Fields.Float(
    { compute: '_computeNbrReorderingRules', computeSudo: false });
  static putawayRuleIds = Fields.One2many('stock.putaway.rule', 'productId', { string: 'Putaway Rules' });
  static storageCategoryCapacityIds = Fields.One2many('stock.storage.category.capacity', 'productId', { string: 'Storage Category Capacity' });
  static showOnHandQtyStatusButton = Fields.Boolean({ compute: '_computeShowQtyStatusButton' });
  static showForecastedQtyStatusButton = Fields.Boolean({ compute: '_computeShowQtyStatusButton' });

  async _computeShowQtyStatusButton() {
    for (const product of this) {
      const productTemplateId = await product.productTemplateId;
      // await Promise.all([
        await product.set('showOnHandQtyStatusButton', await productTemplateId.showOnHandQtyStatusButton),
        await product.set('showForecastedQtyStatusButton', await productTemplateId.showForecastedQtyStatusButton)
      // ]);
    }
  }

  @api.depends('stockMoveIds.productQty', 'stockMoveIds.state')
  @api.dependsContext('lotId', 'ownerId', 'packageId', 'fromDate', 'toDate', 'location', 'warehouse')
  async _computeQuantities() {
    const products = await this.filtered(async (p) => await p.type !== 'service');
    const res = await products._computeQuantitiesDict(this._context['lotId'], this._context['ownerId'], this._context['packageId'], this._context['fromDate'], this._context['toDate']);
    for (const product of products) {
      // await Promise.all([
        await product.set('qtyAvailable', res[product.id]['qtyAvailable']),
        await product.set('incomingQty', res[product.id]['incomingQty']),
        await product.set('outgoingQty', res[product.id]['outgoingQty']),
        await product.set('virtualAvailable', res[product.id]['virtualAvailable']),
        await product.set('freeQty', res[product.id]['freeQty'])
      // ]);
    }
    // Services need to be set with 0.0 for all quantities
    const services = this.sub(products);
    // await Promise.all([
      await services.set('qtyAvailable', 0.0),
      await services.set('incomingQty', 0.0),
      await services.set('outgoingQty', 0.0),
      await services.set('virtualAvailable', 0.0),
      await services.set('freeQty', 0.0)
    // ]);
  }

  async _computeQuantitiesDict(lotId, ownerId, packageId, fromDate?: Date, toDate?: Date) {
    const [domainQuantLoc, domainMoveInLoc, domainMoveOutLoc] = await this._getDomainLocations();
    let domainQuant = [['productId', 'in', this.ids]].concat(domainQuantLoc);
    let datesInThePast = false;
    // only toDate as toDate will correspond to qtyAvailable
    toDate = _Datetime.toDatetime(toDate) as Date;
    if (toDate && toDate < _Datetime.now()) {
      datesInThePast = true;
    }

    let domainMoveIn: any[] = [['productId', 'in', this.ids]].concat(domainMoveInLoc);
    let domainMoveOut: any[] = [['productId', 'in', this.ids]].concat(domainMoveOutLoc);
    if (lotId != null) {
      domainQuant = domainQuant.concat([['lotId', '=', lotId]]);
    }
    if (ownerId != null) {
      domainQuant = domainQuant.concat([['ownerId', '=', ownerId]]);
      domainMoveIn = domainMoveIn.concat([['restrictPartnerId', '=', ownerId]]);
      domainMoveOut = domainMoveOut.concat([['restrictPartnerId', '=', ownerId]]);
    }
    if (packageId != null) {
      domainQuant = domainQuant.concat([['packageId', '=', packageId]]);
    }
    let domainMoveInDone, domainMoveOutDone;
    if (datesInThePast) {
      domainMoveInDone = Array.from(domainMoveIn);
      domainMoveOutDone = Array.from(domainMoveOut);
    }
    if (fromDate) {
      const dateDateExpectedDomainFrom = [['date', '>=', fromDate]];
      domainMoveIn = domainMoveIn.concat(dateDateExpectedDomainFrom);
      domainMoveOut = domainMoveOut.concat(dateDateExpectedDomainFrom);
    }
    if (toDate) {
      const dateDateExpectedDomainTo = [['date', '<=', toDate]];
      domainMoveIn = domainMoveIn.concat(dateDateExpectedDomainTo);
      domainMoveOut = domainMoveOut.concat(dateDateExpectedDomainTo);
    }

    const Move = await this.env.items('stock.move').withContext({ activeTest: false });
    const Quant = await this.env.items('stock.quant').withContext({ activeTest: false });
    const domainMoveInTodo = [['state', 'in', ['waiting', 'confirmed', 'assigned', 'partiallyAvailable']]].concat(domainMoveIn);
    const domainMoveOutTodo = [['state', 'in', ['waiting', 'confirmed', 'assigned', 'partiallyAvailable']]].concat(domainMoveOut);
    const movesInRes = new Dict();
    for (const item of await Move.readGroup(domainMoveInTodo, ['productId', 'productQty'], ['productId'], { orderby: 'id' })) {
      movesInRes[item['productId'][0]] = item['productQty'];
    }
    const movesOutRes = new Dict();
    for (const item of await Move.readGroup(domainMoveOutTodo, ['productId', 'productQty'], ['productId'], { orderby: 'id' })) {
      movesOutRes[item['productId'][0]] = item['productQty'];
    }
    const quantsRes = new Dict();
    for (const item of await Quant.readGroup(domainQuant, ['productId', 'quantity', 'reservedQuantity'], ['productId'], { orderby: 'id' })) {
      quantsRes[item['productId'][0]] = [item['quantity'], item['reservedQuantity']];
    }
    const movesInResPast = new Dict<any>();
    const movesOutResPast = new Dict<any>();
    if (datesInThePast) {
      // Calculate the moves that were done before now to calculate back in time (as most questions will be recent ones)
      domainMoveInDone = [['state', '=', 'done'], ['date', '>', toDate]].concat(domainMoveInDone);
      domainMoveOutDone = [['state', '=', 'done'], ['date', '>', toDate]].concat(domainMoveOutDone);
      for (const item of await Move.readGroup(domainMoveInDone, ['productId', 'productQty'], ['productId'], { orderby: 'id' })) {
        movesInResPast[item['productId'][0]] = item['productQty'];
      }
      for (const item of await Move.readGroup(domainMoveOutDone, ['productId', 'productQty'], ['productId'], { orderby: 'id' })) {
        movesOutResPast[item['productId'][0]] = item['productQty'];
      }
    }
    const res = new Dict();
    for (const product of await this.withContext({ prefetchFields: false })) {
      const originProductId = product._origin.id;
      const productId = product.id
      if (!originProductId.ok) {
        res[productId] = Dict.fromKeys(
          ['qtyAvailable', 'freeQty', 'incomingQty', 'outgoingQty', 'virtualAvailable'], 0.0,
        )
        continue;
      }
      const rounding = await (await product.uomId).rounding;
      res[productId] = new Dict();
      let qtyAvailable;
      if (datesInThePast) {
        qtyAvailable = quantsRes.get(originProductId, [0.0])[0] - movesInResPast.get(originProductId, 0.0) + movesOutResPast.get(originProductId, 0.0);
      }
      else {
        qtyAvailable = quantsRes.get(originProductId, [0.0])[0];
      }
      const reservedQuantity = quantsRes.get(originProductId, [false, 0.0])[1];
      res[productId]['qtyAvailable'] = floatRound(qtyAvailable, { precisionRounding: rounding });
      res[productId]['freeQty'] = floatRound(qtyAvailable - reservedQuantity, { precisionRounding: rounding });
      res[productId]['incomingQty'] = floatRound(movesInRes.get(originProductId, 0.0), { precisionRounding: rounding });
      res[productId]['outgoingQty'] = floatRound(movesOutRes.get(originProductId, 0.0), { precisionRounding: rounding });
      res[productId]['virtualAvailable'] = floatRound(qtyAvailable + res[productId]['incomingQty'] - res[productId]['outgoingQty'], { precisionRounding: rounding });
    }
    return res;
  }

  async _computeNbrMoves() {
    const res = new DefaultDict2(() => {});
    const date = subDate(_Datetime.now(), { years: 1 });
    const incomingMoves = await this.env.items('stock.move.line').readGroup([
      ['productId', 'in', this.ids],
      ['state', '=', 'done'],
      ['pickingCode', '=', 'incoming'],
      ['date', '>=', date]
    ], ['productId'], ['productId']);
    const outgoingMoves = await this.env.items('stock.move.line').readGroup([
      ['productId', 'in', this.ids],
      ['state', '=', 'done'],
      ['picking_code', '=', 'outgoing'],
      ['date', '>=', date]
    ], ['productId'], ['productId']);
    for (const move of incomingMoves) {
      const key = move['productId'][0];
      // res[key] = res[key] ?? new Dict<any>();
      res[key]['movesIn'] = parseInt(move['productId_count']);
    }
    for (const move of outgoingMoves) {
      const key = move['productId'][0];
      // res[key] = res[key] ?? new Dict<any>();
      res[key]['movesOut'] = parseInt(move['productId_count']);
    }
    for (const product of this) {
      const productRes = res.get(product.id) ?? {};
      await product.set('nbrMovesIn', productRes['movesIn'] ?? 0);
      await product.set('nbrMovesOut', productRes['movesOut'] ?? 0);
    }
  }

  async getComponents() {
    this.ensureOne()
    return this.ids;
  }

  /**
   * return product receipt/delivery/picking description depending on picking type passed as argument.
   * @param pickingTypeId 
   * @returns 
   */
  async _getDescription(pickingTypeId) {
    this.ensureOne();
    const pickingCode = await pickingTypeId.code;
    const description = await this['description'] || await this['label'];
    if (pickingCode === 'incoming') {
      return await this['descriptionPickingin'] || description;
    }
    if (pickingCode === 'outgoing') {
      return await this['descriptionPickingout'] || await this['label'];
    }
    if (pickingCode === 'internal') {
      return await this['descriptionPicking'] || description;
    }
  }

  /**
   * Parses the context and returns a list of location_ids based on it.
      It will return all stock locations when no parameters are given
      Possible parameters are shop, warehouse, location, compute_child
   * @returns 
   */
  async _getDomainLocations() {
    const Warehouse = this.env.items('stock.warehouse');

    const self = this;
    async function _searchIds(model, values) {
      let ids = [];
      let domain = [];
      for (const item of values) {
        if (typeof (item) === 'number') {
          ids.push(item);
        }
        else {
          domain = expression.OR([[['label', 'ilike', item]], domain]);
        }
      }
      if (domain.length) {
        ids = _.union(ids, (await self.env.items(model).search(domain)).ids);
      }
      return ids;
    }

    // We may receive a location or warehouse from the context, either by explicit
    // code or by the use of dummy fields in the search view.
    // Normalize them into a list.
    let location = this.env.context['location'];
    if (bool(location) && !Array.isArray(location)) {
      location = [location];
    }
    let warehouse = this.env.context['warehouse'];
    if (bool(warehouse) && !Array.isArray(warehouse)) {
      warehouse = [warehouse];
    }
    let locationIds;
    // filter by location and/or warehouse
    if (bool(warehouse)) {
      const wIds = (await Warehouse.browse(await _searchIds('stock.warehouse', warehouse)).mapped('viewLocationId')).ids;
      if (bool(location)) {
        const lIds = await _searchIds('stock.location', location);
        locationIds = _.intersection(wIds, lIds);
      }
      else {
        locationIds = wIds;
      }
    }
    else {
      if (location) {
        locationIds = await _searchIds('stock.location', location);
      }
      else {
        locationIds = (await (await Warehouse.search([])).mapped('viewLocationId')).ids;
      }
    }

    return this._getDomainLocationsNew(locationIds, false, this.env.context['computeChild'] ?? true);
  }

  async _getDomainLocationsNew(locationIds, companyId?: any, computeChild: any = true) {
    const operator = computeChild ? 'childOf' : 'in';
    const domain = bool(companyId) ? ['&', ['companyId', '=', companyId]] : [];
    const locations = this.env.items('stock.location').browse(locationIds);
    // TDE FIXME: should move the support of childOf + auto_join directly in expression
    const hierarchicalLocations = operator === 'childOf' ? locations : locations.browse();
    const otherLocations = locations.sub(hierarchicalLocations);
    let locDomain = [];
    let destLocDomain = [];
    // this optimizes [['locationId', 'childOf', hierarchicalLocations.ids]]
    // by avoiding the ORM to search for children locations and injecting a
    // lot of location ids into the main query
    for (const location of hierarchicalLocations) {
      locDomain = locDomain.length ? ['|'].concat(locDomain) : locDomain;
      locDomain.push(['locationId.parentPath', '=like', location.parentPath + '%']);
      destLocDomain = destLocDomain.length ? ['|'].concat(destLocDomain) : destLocDomain;
      destLocDomain.push(['locationDestId.parentPath', '=like', location.parentPath + '%']);
    }
    if (otherLocations) {
      locDomain = locDomain.length ? ['|'].concat(locDomain) : locDomain;
      locDomain = locDomain.concat([['locationId', operator, otherLocations.ids]]);
      destLocDomain = destLocDomain.length ? ['|'].concat(destLocDomain) : destLocDomain;
      destLocDomain = destLocDomain.concat([['locationDestId', operator, otherLocations.ids]]);
    }
    return [
      domain.concat(locDomain),
      domain.concat(destLocDomain).concat(['!']).concat(locDomain.length ? locDomain : domain).concat(destLocDomain),
      domain.concat(locDomain).concat(['!']).concat(destLocDomain.length ? destLocDomain : domain).concat(locDomain)
    ];
  }

  async _searchQtyAvailable(operator, value) {
    // In the very specific case we want to retrieve products with stock available, we only need
    // to use the quants, not the stock moves. Therefore, we bypass the usual
    // '_search_product_quantity' method and call '_search_qty_available_new' instead. This
    // allows better performances.
    if (!_.intersection(['fromDate', 'toDate'], Object.keys(this.env.context)).length) {
      const productIds = await this._searchQtyAvailableNew(
        operator, value, this.env.context['lotId'], this.env.context['ownerId'], this.env.context['packageId']
      )
      return [['id', 'in', productIds]];
    }
    return this._searchProductQuantity(operator, value, 'qtyAvailable');
  }

  async _searchVirtualAvailable(operator, value) {
    // TDE FIXME: should probably clean the search methods
    return this._searchProductQuantity(operator, value, 'virtualAvailable');
  }

  async _searchIncomingQty(operator, value) {
    // TDE FIXME: should probably clean the search methods
    return this._searchProductQuantity(operator, value, 'incomingQty');
  }

  async _searchOutgoingQty(operator, value) {
    // TDE FIXME: should probably clean the search methods
    return this._searchProductQuantity(operator, value, 'outgoingQty');
  }

  async _searchFreeQty(operator, value) {
    return this._searchProductQuantity(operator, value, 'freeQty');
  }

  async _searchProductQuantity(operator, value, field) {
    // TDE FIXME: should probably clean the search methods
    // to prevent sql injections
    if (!['qtyAvailable', 'virtualAvailable', 'incomingQty', 'outgoingQty', 'freeQty'].includes(field)) {
      throw new UserError(await this._t('Invalid domain left operand %s', field));
    }
    if (!['<', '>', '=', '!=', '<=', '>='].includes(operator)) {
      throw new UserError(await this._t('Invalid domain operator %s', operator));
    }
    if (typeof (value) !== 'number') {
      throw new UserError(await this._t('Invalid domain right operand %s', value));
    }
    // TODO: Still optimization possible when searching virtual quantities
    const ids = [];
    // Order the search on `id` to prevent the default order on the product name which slows
    // down the search because of the join on the translation table to get the translated names.
    for (const product of await (await this.withContext({ prefetchFields: false })).search([], { order: 'id' })) {
      if (OPERATORS[operator](product[field], value)) {
        ids.push(product.id);
      }
    }
    return [['id', 'in', ids]];
  }

  /**
   * Optimized method which doesn't search on stock.moves, only on stock.quants.
   * @param operator 
   * @param value 
   * @param lotId 
   * @param ownerId 
   * @param packageId 
   * @returns 
   */
  async _searchQtyAvailableNew(operator, value, lotId?: any, ownerId?: any, packageId?: any) {
    const productIds = new Set();
    const domainQuant = (await this._getDomainLocations())[0];
    if (lotId) {
      domainQuant.push(['lotId', '=', lotId]);
    }
    if (ownerId) {
      domainQuant.push(['ownerId', '=', ownerId]);
    }
    if (packageId) {
      domainQuant.push(['packageId', '=', packageId]);
    }
    const quantsGroupby = await this.env.items('stock.quant').readGroup(domainQuant, ['productId', 'quantity'], ['productId'], { orderby: 'id' });

    // check if we need include zero values in result
    const includeZero = (
      value < 0.0 && ['>', '>='].includes(operator) ||
      value > 0.0 && ['<', '<='].includes(operator) ||
      value == 0.0 && ['>=', '<=', '='].includes(operator)
    );

    const processedProductIds = new Set();
    for (const quant of quantsGroupby) {
      const productId = quant['productId'][0];
      if (includeZero) {
        processedProductIds.add(productId);
      }
      if (OPERATORS[operator](quant['quantity'], value)) {
        productIds.add(productId);
      }
    }

    let ids = Array.from(productIds);
    if (includeZero) {
      const productsWithoutQuantsInDomain = await this.env.items('product.product').search([
        ['type', '=', 'product'],
        ['id', 'not in', Array.from(processedProductIds)]]
      );
      ids = _.union(ids, productsWithoutQuantsInDomain.ids);
    }
    return ids;
  }

  async _computeNbrReorderingRules() {
    const readGroupRes = await this.env.items('stock.warehouse.orderpoint').readGroup(
      [['productId', 'in', this.ids]],
      ['productId', 'productMinQty', 'productMaxQty'],
      ['productId']);
    const res = Object.fromEntries(this.ids.map(i => [i, {}]));
    for (const data of readGroupRes) {
      res[data['productId'][0]]['nbrReorderingRules'] = parseInt(data['productId_count'])
      res[data['productId'][0]]['reorderingMinQty'] = data['productMinQty']
      res[data['productId'][0]]['reorderingMaxQty'] = data['productMaxQty']
    }
    for (const product of this) {
      const productRes = res[product.id] ?? {};
      // await Promise.all([
        await product.set('nbrReorderingRules', productRes['nbrReorderingRules'] || 0),
        await product.set('reorderingMinQty', productRes['reorderingMinQty'] || 0),
        await product.set('reorderingMaxQty', productRes['reorderingMaxQty'] || 0)
      // ]);
    }
  }

  @api.onchange('tracking')
  async onchangeTracking() {
    if (await this.some(async (product) => await product.tracking !== 'none' && await product.qtyAvailable > 0)) {
      return {
        'warning': {
          'title': await this._t('Warning!'),
          'message': await this._t("You have product(s) in stock that have no lot/serial number. You can assign lot/serial numbers by doing an inventory adjustment.")
        }
      }
    }
  }

  @api.model()
  async viewHeaderGet(viewId, viewType) {
    const res = await _super(Product, this).viewHeaderGet(viewId, viewType);
    if (!bool(res) && this._context['activeId'] && this._context['activeModel'] === 'stock.location') {
      return await _f(await this._t(
        'Products: {location}'), {
        location: await this.env.items('stock.location').browse(this._context['activeId']).label,
      })
    }
    return res;
  }

  @api.model()
  async fieldsViewGet(viewId?: any, viewType: string = 'form', toolbar: boolean = false, submenu: boolean = false) {
    const res = await _super(Product, this).fieldsViewGet(viewId, viewType, toolbar, submenu);
    if (this._context['location'] && typeof (this._context['location']) === 'number') {
      const location = this.env.items('stock.location').browse(this._context['location']);
      const usage = await location.usage;
      const fields = res['fields'];
      if (fields) {
        if (usage === 'supplier') {
          if (fields['virtualAvailable']) {
            res['fields']['virtualAvailable']['string'] = await this._t('Future Receipts');
          }
          if (fields['qtyAvailable']) {
            res['fields']['qtyAvailable']['string'] = await this._t('Received Qty');
          }
        }
        else if (usage === 'internal') {
          if (fields['virtualAvailable']) {
            res['fields']['virtualAvailable']['string'] = await this._t('Forecasted Quantity');
          }
        }
        else if (usage === 'customer') {
          if (fields['virtualAvailable']) {
            res['fields']['virtualAvailable']['string'] = await this._t('Future Deliveries');
          }
          if (fields['qtyAvailable']) {
            res['fields']['qtyAvailable']['string'] = await this._t('Delivered Qty');
          }
        }
        else if (usage === 'inventory') {
          if (fields['virtualAvailable']) {
            res['fields']['virtualAvailable']['string'] = await this._t('Future P&L');
          }
          if (fields['qtyAvailable']) {
            res['fields']['qtyAvailable']['string'] = await this._t('P&L Qty');
          }
        }
        else if (usage === 'production') {
          if (fields['virtualAvailable']) {
            res['fields']['virtualAvailable']['string'] = await this._t('Future Productions');
          }
          if (fields['qtyAvailable']) {
            res['fields']['qtyAvailable']['string'] = await this._t('Produced Qty');
          }
        }
      }
    }
    return res;
  }

  async actionViewOrderpoints() {
    const action = await this.env.items("ir.actions.actions")._forXmlid("stock.actionOrderpoint");
    action['context'] = literalEval(action['context']);
    pop(action['context'], 'searchDefault_trigger', false);
    update(action['context'], {
      'searchDefault_filterNotSnoozed': true,
    })
    if (this.ok && this._length == 1) {
      action['context'].update({
        'default_productId': this.ids[0],
        'searchDefault_productId': this.ids[0]
      });
    }
    else {
      action['domain'] = expression.AND([action['domain'] ?? [], [['productId', 'in', this.ids]]]);
    }
    return action;
  }

  async actionViewRoutes() {
    return (await this.mapped('productTemplateId')).actionViewRoutes();
  }

  async actionViewStockMoveLines() {
    this.ensureOne();
    const action = await this.env.items("ir.actions.actions")._forXmlid("stock.stockMoveLineAction");
    action['domain'] = [['productId', '=', this.id]];
    return action;
  }

  async actionViewRelatedPutawayRules() {
    this.ensureOne();
    const domain = [
      '|',
      ['productId', '=', this.id],
      ['categoryId', '=', (await (await this['productTemplateId']).categId).id],
    ];
    return this.env.items('product.template')._getActionViewRelatedPutawayRules(domain);
  }

  async actionViewStorageCategoryCapacity() {
    const action = await this.env.items("ir.actions.actions")._forXmlid("stock.actionStorageCategoryCapacity");
    action['context'] = {
      'hidePackageType': true,
    }
    if (this._length == 1) {
      update(action['context'], {
        'default_productId': this.id,
      });
    }
    action['domain'] = [['productId', 'in', this.ids]];
    return action;
  }

  async actionOpenProductLot() {
    this.ensureOne();
    const action = await this.env.items("ir.actions.actions")._forXmlid("stock.actionProductionLotForm");
    const companyId = await this['companyId'];
    action['domain'] = [['productId', '=', this.id]];
    action['context'] = {
      'default_productId': this.id,
      'setProductReadonly': true,
      'default_companyId': (companyId.ok ? companyId : await this.env.company()).id,
    }
    return action;
  }

  // Be aware that the exact same function exists in product.template
  async actionOpenQuants() {
    const domain = [['productId', 'in', this.ids]];
    const hideLocation = ! await this.userHasGroups('stock.groupStockMultiLocations');
    const hideLot = await this.all(async (product) => await product.tracking === 'none');
    let self = await this.withContext({
      hideLocation: hideLocation, hideLot: hideLot,
      noAtDate: true, searchDefault_onHand: true,
    });

    // If user have rights to write on quant, we define the view as editable.
    if (await self.userHasGroups('stock.groupStockManager')) {
      self = await self.withContext({ inventoryMode: true });
      // Set default location id if multilocations is inactive
      if (! await self.userHasGroups('stock.groupStockMultiLocations')) {
        const userCompany = await self.env.company();
        const warehouse = await self.env.items('stock.warehouse').search(
          [['companyId', '=', userCompany.id]], { limit: 1 }
        );
        if (bool(warehouse)) {
          self = await self.withContext({ default_locationId: (await warehouse.lotStockId).id });
        }
      }
    }
    // Set default product id if quants concern only one product
    if (self._length == 1) {
      self = await self.withContext({
        default_productId: self.id,
        singleProduct: true
      })
    }
    else {
      self = await self.withContext({ productTemplateIds: (await self.productTemplateId).ids });
    }
    const action = await self.env.items('stock.quant').actionViewInventory();
    action['domain'] = domain;
    action["label"] = await this._t('Update Quantity');
    return action;
  }

  async actionUpdateQuantityOnHand() {
    return (await (await this['productTemplateId']).withContext({ default_productId: this.id, create: true })).actionUpdateQuantityOnHand();
  }

  async actionProductForecastReport() {
    this.ensureOne();
    const action = await this.env.items("ir.actions.actions")._forXmlid("stock.stockReplenishmentProductProductAction");
    return action;
  }

  @api.model()
  async getTheoreticalQuantity(productId, locationId, lotId?: any, packageId?: any, ownerId?: any, toUom?: any) {
    productId = this.env.items('product.product').browse(productId);
    await productId.checkAccessRights('read');
    await productId.checkAccessRule('read');

    locationId = this.env.items('stock.location').browse(locationId);
    lotId = this.env.items('stock.production.lot').browse(lotId);
    packageId = this.env.items('stock.quant.package').browse(packageId);
    ownerId = this.env.items('res.partner').browse(ownerId);
    toUom = this.env.items('uom.uom').browse(toUom);
    const quants = this.env.items('stock.quant')._gather(productId, locationId, lotId, packageId, ownerId, true);
    let theoreticalQuantity = 0;
    for (const quant of quants) {
      theoreticalQuantity += await quant.quantity;
    }
    const uomId = await productId.uomId;
    if (toUom.ok && !uomId.eq(toUom)) {
      theoreticalQuantity = await uomId._computeQuantity(theoreticalQuantity, toUom);
    }
    return theoreticalQuantity;
  }

  async write(values) {
    if ('active' in values) {
      await (await (await (await this.filtered(async (p) => await p.active != values['active'])).withContext({ activeTest: false })).orderpointIds).write({
        'active': values['active']
      })
    }
    return _super(Product, this).write(values);
  }

  async _getQuantityInProgress(locationIds: any = false, warehouseIds: any = false) {
    return [new Dict(), new Dict()]; // float
  }

  async _getRulesFromLocation(location, routeIds: any = false, seenRules: any = false) {
    if (!bool(seenRules)) {
      seenRules = this.env.items('stock.rule');
    }
    const rule = await this.env.items('procurement.group')._getRule(this, location, {
      'routeIds': routeIds,
      'warehouseId': await location.warehouseId
    });
    if (!bool(rule)) {
      return seenRules;
    }
    if (await rule.procureMethod === 'makeToStock' || !['pullPush', 'pull'].includes(await rule.action)) {
      return seenRules.or(rule);
    }
    else {
      return this._getRulesFromLocation(await rule.locationSrcId, false, seenRules.or(rule));
    }
  }

  /**
   * Get only quantities available, it is equivalent to read qtyAvailable 
      but avoid fetching other qty fields (avoid costly read group on moves)
 
      :rtype: defaultdict(float)
   * @returns 
   */
  async _getOnlyQtyAvailable() {
    const domainQuant = expression.AND([(await this._getDomainLocations())[0], [['productId', 'in', this.ids]]]);
    const quantsGroupby = await this.env.items('stock.quant').readGroup(domainQuant, ['productId', 'quantity'], ['productId'], { orderby: 'id' });
    const currents = new Dict();//(float)
    for (const c of quantsGroupby) {
      // const k = c['productId'][0];
      currents[c['productId'][0]] = c['quantity'];
    }
    return currents;
  }

  async _filterToUnlink() {
    const domain = [['productId', 'in', this.ids]];
    const lines = await this.env.items('stock.production.lot').readGroup(domain, ['productId'], ['productId']);
    const linkedProductIds = [];
    for (const group of lines) {
      linkedProductIds.push(group['productId'][0]);
    }
    return _super(Product, this.sub(this.browse(linkedProductIds)))._filterToUnlink();
  }
}

@MetaModel.define()
class ProductTemplate extends Model {
  static _module = module;
  static _parents = 'product.template';
  static _checkCompanyAuto = true;

  static responsibleId = Fields.Many2one(
    'res.users', {
    string: 'Responsible', default: self => self.env.uid, companyDependent: true, checkCompany: true,
    help: "This user will be responsible of the next activities related to logistic operations for this product."
  });
  static detailedType = Fields.Selection({
    selectionAdd: [
      ['product', 'Storable Product']
    ], tracking: true, ondelete: { 'product': 'SET DEFAULT' }
  });
  static type = Fields.Selection({
    selectionAdd: [
      ['product', 'Storable Product']
    ], tracking: true, ondelete: { 'product': 'SET DEFAULT' }
  });
  static propertyStockProduction = Fields.Many2one(
    'stock.location', {
    string: "Production Location",
    companyDependent: true, checkCompany: true, domain: "[['usage', '=', 'production'], '|', ['companyId', '=', false], ['companyId', '=', allowedCompanyIds[0]]]",
    help: "This stock location will be used, instead of the default one, as the source location for stock moves generated by manufacturing orders."
  });
  static propertyStockInventory = Fields.Many2one(
    'stock.location', {
    string: "Inventory Location",
    companyDependent: true, checkCompany: true, domain: "[['usage', '=', 'inventory'], '|', ['companyId', '=', false], ['companyId', '=', allowedCompanyIds[0]]]",
    help: "This stock location will be used, instead of the default one, as the source location for stock moves generated when you do an inventory."
  });
  static saleDelay = Fields.Float(
    'Customer Lead Time', {
    default: 0,
    help: "Delivery lead time, in days. It's the number of days, promised to the customer, between the confirmation of the sales order and the delivery."
  });
  static tracking = Fields.Selection([
    ['serial', 'By Unique Serial Number'],
    ['lot', 'By Lots'],
    ['none', 'No Tracking']], { string: "Tracking", help: "Ensure the traceability of a storable product in your warehouse.", default: 'none', required: true });
  static descriptionPicking = Fields.Text('Description on Picking', { translate: true });
  static descriptionPickingout = Fields.Text('Description on Delivery Orders', { translate: true });
  static descriptionPickingin = Fields.Text('Description on Receptions', { translate: true });
  static qtyAvailable = Fields.Float(
    'Quantity On Hand', {
    compute: '_computeQuantities', search: '_searchQtyAvailable',
    computeSudo: false, digits: 'Product Unit of Measure'
  });
  static virtualAvailable = Fields.Float(
    'Forecasted Quantity', {
    compute: '_computeQuantities', search: '_searchVirtualAvailable',
    computeSudo: false, digits: 'Product Unit of Measure'
  });
  static incomingQty = Fields.Float(
    'Incoming', {
    compute: '_computeQuantities', search: '_searchIncomingQty',
    computeSudo: false, digits: 'Product Unit of Measure'
  });
  static outgoingQty = Fields.Float(
    'Outgoing', {
    compute: '_computeQuantities', search: '_searchOutgoingQty',
    computeSudo: false, digits: 'Product Unit of Measure'
  });
  // The goal of these fields is to be able to put some keys in context from search view in order
  // to influence computed field.
  static locationId = Fields.Many2one('stock.location', { string: 'Location', store: false });
  static warehouseId = Fields.Many2one('stock.warehouse', { string: 'Warehouse', store: false });
  static hasAvailableRouteIds = Fields.Boolean(
    'Routes can be selected on this product', {
    compute: '_computeHasAvailableRouteIds',
    default: self => self.env.items('stock.location.route').searchCount([['productSelectable', '=', true]])
  });
  static routeIds = Fields.Many2many(
    'stock.location.route', {
    relation: 'stockRouteProduct', column1: 'productId', column2: 'routeId', string: 'Routes', domain: [['productSelectable', '=', true]],
    help: "Depending on the modules installed, this will allow you to define the route of the product: whether it will be bought, manufactured, replenished on order, etc."
  });
  static nbrMovesIn = Fields.Integer({ compute: '_computeNbrMoves', computeSudo: false, help: "Number of incoming stock moves in the past 12 months" });
  static nbrMovesOut = Fields.Integer({ compute: '_computeNbrMoves', computeSudo: false, help: "Number of outgoing stock moves in the past 12 months" });
  static nbrReorderingRules = Fields.Integer('Reordering Rules',
    { compute: '_computeNbrReorderingRules', computeSudo: false });
  static reorderingMinQty = Fields.Float(
    { compute: '_computeNbrReorderingRules', computeSudo: false });
  static reorderingMaxQty = Fields.Float(
    { compute: '_computeNbrReorderingRules', computeSudo: false });
  // TDE FIXME: seems only visible in a view - remove me ?
  static routeFromCategIds = Fields.Many2many(
    {
      relation: "stock.location.route", string: "Category Routes",
      related: 'categId.totalRouteIds', relatedSudo: false
    });
  static showOnHandQtyStatusButton = Fields.Boolean({ compute: '_computeShowQtyStatusButton' });
  static showForecastedQtyStatusButton = Fields.Boolean({ compute: '_computeShowQtyStatusButton' });

  async _computeShowQtyStatusButton() {
    for (const template of this) {
      // await Promise.all([
        await template.set('showOnHandQtyStatusButton', await template.type === 'product'),
        await template.set('showForecastedQtyStatusButton', await template.type === 'product')
      // ]);
    }
  }

  @api.depends('type')
  async _computeHasAvailableRouteIds() {
    await this.set('hasAvailableRouteIds', await this.env.items('stock.location.route').searchCount([['productSelectable', '=', true]]));
  }

  @api.depends(
    'productVariantIds.qtyAvailable',
    'productVariantIds.virtualAvailable',
    'productVariantIds.incomingQty',
    'productVariantIds.outgoingQty',
  )
  async _computeQuantities() {
    const res = await this._computeQuantitiesDict();
    for (const template of this) {
      const templateId = res[template.id];
      // await Promise.all([
        await template.set('qtyAvailable', templateId['qtyAvailable']),
        await template.set('virtualAvailable', templateId['virtualAvailable']),
        await template.set('incomingQty', templateId['incomingQty']),
        await template.set('outgoingQty', templateId['outgoingQty'])
      // ]);
    }
  }

  async _computeQuantitiesDict() {
    const variantsAvailable = {};
    for (const p of await (await this['productVariantIds'])._origin.read(['qtyAvailable', 'virtualAvailable', 'incomingQty', 'outgoingQty'])) {
      variantsAvailable[p['id']] = p;
    }
    const prodAvailable = {};
    for (const template of this) {
      let qtyAvailable = 0;
      let virtualAvailable = 0;
      let incomingQty = 0;
      let outgoingQty = 0;
      for (const p of (await template.productVariantIds)._origin) {
        const pId = variantsAvailable[p.id];
        qtyAvailable += pId["qtyAvailable"];
        virtualAvailable += pId["virtualAvailable"];
        incomingQty += pId["incomingQty"];
        outgoingQty += pId["outgoingQty"];
      }
      prodAvailable[template.id] = {
        "qtyAvailable": qtyAvailable,
        "virtualAvailable": virtualAvailable,
        "incomingQty": incomingQty,
        "outgoingQty": outgoingQty,
      }
    }
    return prodAvailable;
  }

  async _computeNbrMoves() {
    const res = new DefaultDict2(() => { return { 'movesIn': 0, 'movesOut': 0 } });
    const date = subDate(_Datetime.now(), { years: 1 });
    const incomingMoves = await this.env.items('stock.move.line').readGroup([
      ['productId.productTemplateId', 'in', this.ids],
      ['state', '=', 'done'],
      ['pickingCode', '=', 'incoming'],
      ['date', '>=', date]
    ], ['productId'], ['productId']);
    const outgoingMoves = await this.env.items('stock.move.line').readGroup([
      ['productId.productTemplateId', 'in', this.ids],
      ['state', '=', 'done'],
      ['pickingCode', '=', 'outgoing'],
      ['date', '>=', date]
    ], ['productId'], ['productId']);
    for (const move of incomingMoves) {
      const product = this.env.items('product.product').browse([move['productId'][0]]);
      const productTemplateId = (await product.productTemplateId).id;
      // res[productTemplateId] = res[productTemplateId] ?? { 'movesIn': 0, 'movesOut': 0 };
      res[productTemplateId]['movesIn'] += parseInt(move['productId_count'])
    }
    for (const move of outgoingMoves) {
      const product = this.env.items('product.product').browse([move['productId'][0]]);
      const productTemplateId = (await product.productTemplateId).id;
      // res[productTemplateId] = res[productTemplateId] ?? { 'movesIn': 0, 'movesOut': 0 };
      res[productTemplateId]['movesOut'] += parseInt(move['productId_count']);
    }
    for (const template of this) {
      await template.set('nbrMovesIn', parseInt(res[template.id]['movesIn'])),
      await template.set('nbrMovesOut', parseInt(res[template.id]['movesOut']))
    }
  }

  @api.model()
  async _getActionViewRelatedPutawayRules(domain) {
    return {
      'label': await this._t('Putaway Rules'),
      'type': 'ir.actions.actwindow',
      'resModel': 'stock.putaway.rule',
      'viewMode': 'list',
      'domain': domain,
    }
  }

  async _searchQtyAvailable(operator, value) {
    const domain = [['qtyAvailable', operator, value]];
    const productVariantIds = await this.env.items('product.product').search(domain);
    return [['productVariantIds', 'in', productVariantIds.ids]];
  }

  async _searchVirtualAvailable(operator, value) {
    const domain = [['virtualAvailable', operator, value]];
    const productVariantIds = await this.env.items('product.product').search(domain);
    return [['productVariantIds', 'in', productVariantIds.ids]];
  }

  async _searchIncomingQty(operator, value) {
    const domain = [['incomingQty', operator, value]];
    const productVariantIds = await this.env.items('product.product').search(domain);
    return [['productVariantIds', 'in', productVariantIds.ids]];
  }

  async _searchOutgoingQty(operator, value) {
    const domain = [['outgoingQty', operator, value]];
    const productVariantIds = await this.env.items('product.product').search(domain);
    return [['productVariantIds', 'in', productVariantIds.ids]];
  }

  async _computeNbrReorderingRules() {
    const res = Object.fromEntries(this.ids.map(k => [k, { 'nbrReorderingRules': 0, 'reorderingMinQty': 0, 'reorderingMaxQty': 0 }]));
    const productData = await this.env.items('stock.warehouse.orderpoint').readGroup([['productId.productTemplateId', 'in', this.ids]], ['productId', 'productMinQty', 'productMaxQty'], ['productId']);
    for (const data of productData) {
      const product = this.env.items('product.product').browse([data['productId'][0]]);
      const productTemplateId = (await product.productTemplateId).id;
      res[productTemplateId]['nbrReorderingRules'] += parseInt(data['productId_count']);
      res[productTemplateId]['reorderingMinQty'] = data['productMinQty'];
      res[productTemplateId]['reorderingMaxQty'] = data['productMaxQty'];
    }
    for (const template of this) {
      if (!bool(template.id)) {
        await template.update({
          nbrReorderingRules: 0,
          reorderingMinQty: 0,
          reorderingMaxQty: 0
        });
        continue;
      }
      await template.update({
        nbrReorderingRules: res[template.id]['nbrReorderingRules'],
        reorderingMinQty: res[template.id]['reorderingMinQty'],
        reorderingMaxQty: res[template.id]['reorderingMaxQty']
      });
    }
  }

  async _computeProductTooltip() {
    await _super(ProductTemplate, this)._computeProductTooltip();
    for (const record of this) {
      const [type, productTooltip] = await record('type', 'productTooltip');
      if (type === 'product') {
        await record.set('productTooltip', productTooltip + await this._t(
          "Storable products are physical items for which you manage the inventory level."
        ));
      }
    }
  }

  @api.onchange('type')
  async _onchangeType() {
    let res = await _super(ProductTemplate, this)._onchangeType();
    res = bool(res) ? res : {};
    if (await this['type'] === 'consu' && await this['tracking'] !== 'none') {
      await this.set('tracking', 'none');
    }

    // Return a warning when trying to change the product type
    const productVariantIds = await this['productVariantIds'];
    if (len(this.ids) && len(productVariantIds.ids) && await this.env.items('stock.move.line').sudo().searchCount([
      ['productId', 'in', productVariantIds.ids], ['state', '!=', 'cancel']
    ])) {
      res['warning'] = {
        'title': await this._t('Warning!'),
        'message': await this._t(
          'This product has been used in at least one inventory movement. It is not advised to change the Product Type since it can lead to inconsistencies. A better solution could be to archive the product and create a new one instead.'
        )
      }
    }
    return res;
  }

  async write(vals) {
    await (this as any)._sanitizeVals(vals);
    if ('uomId' in vals) {
      const newUom = this.env.items('uom.uom').browse(vals['uomId']);
      const updated = await this.filtered(async (template) => (await template.uomId).ne(newUom));
      const doneMoves = await this.env.items('stock.move').search([['productId', 'in', (await (await updated.withContext({ activeTest: false })).mapped('productVariantIds')).ids]], { limit: 1 });
      if (bool(doneMoves)) {
        throw new UserError(await this._t("You cannot change the unit of measure as there are already stock moves for this product. If you want to change the unit of measure, you should rather archive this product and create a new one."))
      }
    }
    if ('type' in vals && vals['type'] !== 'product' && sum(await this.mapped('nbrReorderingRules')) != 0) {
      throw new UserError(await this._t('You still have some active reordering rules on this product. Please archive or delete them first.'));
    }
    let some;
    for (const prodTmpl of this) {
      if ('type' in vals && vals['type'] !== await prodTmpl.type) {
        some = true;
        break;
      }
    }
    if (await this.some(async (prodTmpl) => 'type' in vals && vals['type'] !== await prodTmpl.type)) {
      const existingMoveLines = await this.env.items('stock.move.line').search([
        ['productId', 'in', (await this.mapped('productVariantIds')).ids],
        ['state', 'in', ['partiallyAvailable', 'assigned']],
      ]);
      if (existingMoveLines.ok) {
        throw new UserError(await this._t("You can not change the type of a product that is currently reserved on a stock move. If you need to change the type, you should first unreserve the stock move."));
      }
    }
    if ('type' in vals && vals['type'] !== 'product' && await this.some(async (p) => await p.type === 'product' && !floatIsZero(await p.qtyAvailable, { precisionRounding: await (await p.uomId).rounding }))) {
      throw new UserError(await this._t("Available quantity should be set to zero before changing type"));
    }
    return _super(ProductTemplate, this).write(vals);
  }

  async copy(defaultValue?: any) {
    const res = await _super(ProductTemplate, this).copy(defaultValue);
    // Since we don't copy product variants directly, we need to match the newly created product variants with the old one, and copy the storage category capacity from them.
    const newProductDict = new Map<any, any>();
    for (const product of await res.productVariantIds) {
      const productAttributeValue = await (await product.productTemplateAttributeValueIds).productAttributeValueId;
      newProductDict.set(productAttributeValue, product.id);
    }
    const storageCategoryCapacityVals = [];
    for (const storageCategoryCapacity of await (await this['productVariantIds']).storageCategoryCapacityIds) {
      const productAttributeValue = await (await (await storageCategoryCapacity.productId).productTemplateAttributeValueIds).productAttributeValueId;
      storageCategoryCapacityVals.push((await storageCategoryCapacity.copyData({ 'productId': newProductDict[productAttributeValue] }))[0]);
    }
    await this.env.items('stock.storage.category.capacity').create(storageCategoryCapacityVals);
    return res;
  }

  // Be aware that the exact same function exists in product.product
  async actionOpenQuants() {
    return (await (await this['productVariantIds']).filtered(async (p) => await p.active || await p.qtyAvailable != 0)).actionOpenQuants();
  }

  async actionUpdateQuantityOnHand() {
    const advancedOptionGroups = [
      'stock.groupStockMultiLocations',
      'stock.groupProductionLot',
      'stock.groupTrackingOwner',
      'product.groupTrackingLot'
    ];
    if (await (await this.env.user()).userHasGroups(advancedOptionGroups.join(','))) {
      return this.actionOpenQuants();
    }
    else {
      const [productVariantId, productVariantIds] = await this('productVariantId', 'productVariantIds');
      const defaultProductId = await this.env.context['default_productId'] ?? (productVariantIds._length == 1 && productVariantId.id);
      const action = await this.env.items("ir.actions.actions")._forXmlid("stock.actionChangeProductQuantity")
      action['context'] = Object.assign({},
        this.env.context, {
        default_productId: defaultProductId,
        default_productTemplateId: this.id
      })
      return action;
    }
  }

  async actionViewRelatedPutawayRules() {
    this.ensureOne();
    const domain = [
      '|',
      ['productId.productTemplateId', '=', this.id],
      ['categoryId', '=', (await this['categId']).id],
    ];
    return this._getActionViewRelatedPutawayRules(domain);
  }

  async actionViewStorageCategoryCapacity() {
    this.ensureOne();
    return (await this['productVariantIds']).actionViewStorageCategoryCapacity();
  }

  async actionViewOrderpoints() {
    return (await this['productVariantIds']).actionViewOrderpoints();
  }

  async actionViewStockMoveLines() {
    this.ensureOne();
    const action = await this.env.items("ir.actions.actions")._forXmlid("stock.stockMoveLineAction");
    action['domain'] = [['productId.productTemplateId', 'in', this.ids]];
    return action;
  }

  async actionOpenProductLot() {
    this.ensureOne();
    const companyId = await this['companyId'];
    const action = this.env.items("ir.actions.actions")._forXmlid("stock.actionProductionLotForm")
    action['domain'] = [['productId.productTemplateId', '=', this.id]];
    action['context'] = {
      'default_productTemplateId': this.id,
      'default_companyId': (bool(companyId) ? companyId : await this.env.company()).id,
    }
    if (await this['productVariantCount'] == 1) {
      update(action['context'], {
        'default_productId': (await this['productVariantId']).id,
      });
    }
    return action;
  }

  async actionOpenRoutesDiagram() {
    let products;// = false
    if (this.env.context['default_productId']) {
      products = this.env.items('product.product').browse(this.env.context['default_productId']);
    }
    if (!bool(products) && this.env.context['default_productTemplateId']) {
      products = await this.env.items('product.template').browse(this.env.context['default_productTemplateId']).productVariantIds;
    }
    if (! await this.userHasGroups('stock.groupStockMultiWarehouses') && len(products) == 1) {
      let company = await products.companyId;
      company = bool(company) ? company : await this.env.company();
      const warehouse = await this.env.items('stock.warehouse').search([['companyId', '=', company.id]], { limit: 1 });
      return (await this.env.ref('stock.actionReportStockRule')).reportAction(null, {
        'productId': products.id,
        'warehouseIds': warehouse.ids,
      }, { config: false });
    }
    const action = await this.env.items("ir.actions.actions")._forXmlid("stock.actionStockRulesReport");
    action['context'] = this.env.context;
    return action;
  }

  async actionProductTemplateForecastReport() {
    this.ensureOne();
    const action = await this.env.items("ir.actions.actions")._forXmlid('stock.stockReplenishmentProductProductAction');
    return action;
  }
}

@MetaModel.define()
class ProductCategory extends Model {
  static _module = module;
  static _parents = 'product.category';

  static routeIds = Fields.Many2many(
    'stock.location.route', { relation: 'stockLocationRouteCateg', column1: 'categId', column2: 'routeId', string: 'Routes', domain: [['productCategSelectable', '=', true]] });
  static removalStrategyId = Fields.Many2one(
    'product.removal', {
    string: 'Force Removal Strategy',
    help: "Set a specific removal strategy that will be used regardless of the source location for this product category"
  });
  static totalRouteIds = Fields.Many2many(
    'stock.location.route', {
    string: 'Total routes', compute: '_computeTotalRouteIds',
    readonly: true
  });
  static putawayRuleIds = Fields.One2many('stock.putaway.rule', 'categoryId', { string: 'Putaway Rules' });
  static packagingReserveMethod = Fields.Selection([
    ['full', 'Reserve Only Full Packagings'],
    ['partial', 'Reserve Partial Packagings'],], {
    string: "Reserve Packagings", default: 'partial',
    help: "Reserve Only Full Packagings: will not reserve partial packagings. If customer orders 2 pallets of 1000 units each and you only have 1600 in stock, then only 1000 will be reserved.\nReserve Partial Packagings: allow reserving partial packagings. If customer orders 2 pallets of 1000 units each and you only have 1600 in stock, then 1600 will be reserved"
  });

  async _computeTotalRouteIds() {
    for (const category of this) {
      let baseCat = category;
      let routes = await category.routeIds
      while ((await baseCat.parentId).ok) {
        baseCat = await baseCat.parentId;
        routes = routes.or(await baseCat.routeIds);
      }
      await category.set('totalRouteIds', routes);
    }
  }
}

@MetaModel.define()
class ProductPackaging extends Model {
  static _module = module;
  static _parents = "product.packaging";

  static packageTypeId = Fields.Many2one('stock.package.type', { string: 'Package Type' });
  static routeIds = Fields.Many2many(
    'stock.location.route', {
    relation: 'stockLocationRoutePackaging', column1: 'packagingId', column2: 'routeId', string: 'Routes', domain: [['packagingSelectable', '=', true]],
    help: "Depending on the modules installed, this will allow you to define the route of the product in this packaging: whether it will be bought, manufactured, replenished on order, etc."
  });
}

@MetaModel.define()
class UoM extends Model {
  static _module = module;
  static _parents = 'uom.uom';

  async write(values) {
    // Users can not update the factor if open stock moves are based on it
    if ('factor' in values || 'factorInv' in values || 'categoryId' in values) {
      const changed = (await this.filtered((u) => ['factor', 'factorInv'].some((f) => f in values ? u[f] != values[f] : false))).add(
        await this.filtered((u) => ['categoryId'].some(f => f in values ? u[f].id != parseInt(values[f]) : false))
      );
      if (changed.ok) {
        const errorMsg = await this._t(
          "You cannot change the ratio of this unit of measure as some products with this UoM have already been moved or are currently reserved."
        )
        if (await (await this.env.items('stock.move').sudo()).searchCount([
          ['productUom', 'in', changed.ids],
          ['state', 'not in', ['cancel', 'done']]
        ])) {
          throw new UserError(errorMsg);
        }
        if (await (await this.env.items('stock.move.line').sudo()).searchCount([
          ['productUomId', 'in', changed.ids],
          ['state', 'not in', ['cancel', 'done']],
        ])) {
          throw new UserError(errorMsg);
        }
        if (await (await this.env.items('stock.quant').sudo()).searchCount([
          ['productId.productTemplateId.uomId', 'in', changed.ids],
          ['quantity', '!=', 0],
        ])) {
          throw new UserError(errorMsg);
        }
      }
    }
    return _super(UoM, this).write(values);
  }

  /**
   * This method adjust the quantities of a procurement if its UoM isn't the same
    as the one of the quant and the parameter 'propagate_uom' is not set.
   * @param qty 
   * @param quantUom 
   */
  async _adjustUomQuantities(qty, quantUom) {
    let procurementUom = this;
    let computedQty = qty;
    if (await (await this.env.items('ir.config.parameter').sudo()).getParam('stock.propagateUom') !== '1') {
      computedQty = await (this as any)._computeQuantity(qty, quantUom, { roundingMethod: 'HALF-UP' })
      procurementUom = quantUom;
    }
    else {
      computedQty = await (this as any)._computeQuantity(qty, procurementUom, { roundingMethod: 'HALF-UP' });
    }
    return [computedQty, procurementUom];
  }
}
