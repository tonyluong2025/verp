import _ from "lodash";
import { DateTime } from "luxon";
import { api, tools } from "../../../core";
import { Fields, _Date, _Datetime } from "../../../core/fields";
import { DefaultDict, DefaultDict2, Dict, MapKey, OrderedSet2 } from "../../../core/helper/collections";
import { UserError } from "../../../core/helper/errors";
import { MetaModel, Model, ModelRecords, _super } from "../../../core/models";
import { expression } from "../../../core/osv";
import { bool } from "../../../core/tools/bool";
import { dateMax, dateMin } from "../../../core/tools/date_utils";
import { floatCompare, floatIsZero, floatRound } from "../../../core/tools/float_utils";
import { equal, isInstance } from "../../../core/tools/func";
import { enumerate, extend, itemgetter, len, range, sortedAsync, sum } from "../../../core/tools/iterable";
import { cleanContext, groupby, groupbyAsync, setOptions, update } from "../../../core/tools/misc";
import { f } from "../../../core/tools/utils";

export const PROCUREMENT_PRIORITIES = [['0', 'Normal'], ['1', 'Urgent']];

@MetaModel.define()
class StockMove extends Model {
  static _module = module;
  static _name = "stock.move";
  static _description = "Stock Move";
  static _order = 'sequence, id';

  async _defaultGroupId() {
    if (this.env.context['default_pickingId']) {
      return (await this.env.items('stock.picking').browse(this.env.context['default_pickingId']).groupId).id
    }
    return false;
  }

  static label = Fields.Char('Description', { required: true });
  static sequence = Fields.Integer('Sequence', { default: 10 });
  static priority = Fields.Selection(
    PROCUREMENT_PRIORITIES, {
    string: 'Priority', default: '0',
    compute: "_computePriority", store: true
  });
  static date = Fields.Datetime(
    'Date Scheduled', { default: () => _Datetime.now(), index: true, required: true, help: "Scheduled date until move is done, then date of actual move processing" });
  static dateDeadline = Fields.Datetime(
    "Deadline", {
    readonly: true,
    help: "Date Promise to the customer on the top level document (SO/PO)"
  });
  static companyId = Fields.Many2one(
    'res.company', {
    string: 'Company',
    default: self => self.env.company(),
    index: true, required: true
  });
  static productId = Fields.Many2one(
    'product.product', {
    string: 'Product',
    checkCompany: true, domain: "[['type', 'in', ['product', 'consu']], '|', ['companyId', '=', false], ['companyId', '=', companyId]]", index: true, required: true,
    states: { 'done': [['readonly', true]] }
  });
  static descriptionPicking = Fields.Text('Description of Picking');
  static productQty = Fields.Float(
    'Real Quantity', {
    compute: '_computeProductQty', inverse: '_setProductQty', digits: 0, store: true, computeSudo: true,
    help: 'Quantity in the default UoM of the product'
  });
  static productUomQty = Fields.Float(
    'Demand', {
    digits: 'Product Unit of Measure',
    default: 1.0, required: true, states: { 'done': [['readonly', true]] },
    help: "This is the quantity of products from an inventory point of view. For moves in the state 'done', this is the quantity of products that were actually moved. For other moves, this is the quantity of product that is planned to be moved. Lowering this quantity does not generate a backorder. Changing this quantity on assigned moves affects the product reservation, and should be done with care."
  });
  static productUom = Fields.Many2one('uom.uom', { string: "UoM", required: true, domain: "[['categoryId', '=', productUomCategoryId]]" });
  static productUomCategoryId = Fields.Many2one({ related: 'productId.uomId.categoryId' });
  // TDE FIXME: make it stored, otherwise group will not work
  static productTemplateId = Fields.Many2one(
    'product.template', {
    string: 'Product Template',
    related: 'productId.productTemplateId', help: "Technical: used in views"
  });
  static locationId = Fields.Many2one(
    'stock.location', {
    string: 'Source Location',
    autojoin: true, index: true, required: true,
    checkCompany: true, help: "Sets a location if you produce at a fixed location. This can be a partner location if you subcontract the manufacturing operations."
  });
  static locationDestId = Fields.Many2one(
    'stock.location', {
    string: 'Destination Location',
    autojoin: true, index: true, required: true,
    checkCompany: true, help: "Location where the system will stock the finished products."
  });
  static partnerId = Fields.Many2one(
    'res.partner', {
    string: 'Destination Address ',
    states: { 'done': [['readonly', true]] },
    help: "Optional address where goods are to be delivered, specifically used for allotment"
  });
  static moveDestIds = Fields.Many2many(
    'stock.move', { relation: 'stockMoveMoveRel', column1: 'moveOrigId', column2: 'moveDestId', string: 'Destination Moves', copy: false, help: "Optional: next stock move when chaining them" });
  static moveOrigIds = Fields.Many2many(
    'stock.move', {
    relation: 'stockMoveMoveRel', column1: 'moveDestId', column2: 'moveOrigId', string: 'Original Move',
    copy: false, help: "Optional: previous stock move when chaining them"
  });
  static pickingId = Fields.Many2one('stock.picking', { string: 'Transfer', index: true, states: { 'done': [['readonly', true]] }, checkCompany: true });
  static state = Fields.Selection([
    ['draft', 'New'], ['cancel', 'Cancelled'],
    ['waiting', 'Waiting Another Move'],
    ['confirmed', 'Waiting Availability'],
    ['partially_available', 'Partially Available'],
    ['assigned', 'Available'],
    ['done', 'Done']], {
    string: 'Status', copy: false, default: 'draft', index: true, readonly: true, help: ["* New: When the stock move is created and not yet confirmed.\n",
      "* Waiting Another Move: This state can be seen when a move is waiting for another one, for example in a chained flow.\n",
      "* Waiting Availability: This state is reached when the procurement resolution is not straight forward. It may need the scheduler to run, a component to be manufactured...\n",
      "* Available: When products are reserved, it is set to \'Available\'.\n",
      "* Done: When the shipment is processed, the state is \'Done\'."].join('')
  });
  static priceUnit = Fields.Float(
    'Unit Price', { help: "Technical field used to record the product cost set by the user during a picking confirmation (when costing method used is 'average price' or 'real'). Value given in company currency and in product uom.", copy: false })  // as it's a technical field, we intentionally don't provide the digits attribute
  static origin = Fields.Char("Source Document")
  static procureMethod = Fields.Selection([
    ['makeToStock', 'Default: Take From Stock'],
    ['makeToOrder', 'Advanced: Apply Procurement Rules']], { string: 'Supply Method', default: 'makeToStock', required: true, copy: false, help: "By default, the system will take from the stock in the source location and passively wait for availability. The other possibility allows you to directly create a procurement on the source location (and thus ignore its current stock) to gather products. If we want to chain moves and have this one to wait for the previous, this second option should be chosen." });
  static scrapped = Fields.Boolean('Scrapped', { related: 'locationDestId.scrapLocation', readonly: true, store: true });
  static scrapIds = Fields.One2many('stock.scrap', 'moveId');
  static groupId = Fields.Many2one('procurement.group', { string: 'Procurement Group', default: self => self._defaultGroupId() });
  static ruleId = Fields.Many2one(
    'stock.rule', { string: 'Stock Rule', ondelete: 'RESTRICT', help: 'The stock rule that created this stock move', checkCompany: true });
  static propagateCancel = Fields.Boolean(
    'Propagate cancel and split', { default: true, help: 'If checked, when this move is cancelled, cancel the linked move too' });
  static delayAlertDate = Fields.Datetime('Delay Alert Date', { help: 'Process at this date to be on time', compute: "_computeDelayAlertDate", store: true });
  static pickingTypeId = Fields.Many2one('stock.picking.type', { string: 'Operation Type', compute: '_computePickingTypeId', store: true, checkCompany: true });
  static isInventory = Fields.Boolean('Inventory');
  static moveLineIds = Fields.One2many('stock.move.line', 'moveId');
  static moveLineNosuggestIds = Fields.One2many('stock.move.line', 'moveId', { domain: ['|', ['productQty', '=', 0.0], ['qtyDone', '!=', 0.0]] });
  static originReturnedMoveId = Fields.Many2one(
    'stock.move', { string: 'Origin return move', copy: false, index: true, help: 'Move that created the return move', checkCompany: true });
  static returnedMoveIds = Fields.One2many('stock.move', 'originReturnedMoveId', { string: 'All returned moves', help: 'Optional: all returned moves created from this move' });
  static reservedAvailability = Fields.Float(
    'Quantity Reserved', { compute: '_computeReservedAvailability', digits: 'Product Unit of Measure', readonly: true, help: 'Quantity that has already been reserved for this move' });
  static availability = Fields.Float(
    'Forecasted Quantity', { compute: '_computeProductAvailability', readonly: true, help: 'Quantity in stock that can still be reserved for this move' });
  static restrictPartnerId = Fields.Many2one(
    'res.partner', {
    string: 'Owner ', help: "Technical field used to depict a restriction on the ownership of quants to consider when marking this move as 'done'",
    checkCompany: true
  });
  static routeIds = Fields.Many2many(
    'stock.location.route', { relation: 'stockLocationRouteMove', column1: 'moveId', column2: 'routeId', string: 'Destination route', help: "Preferred route", checkCompany: true });
  static warehouseId = Fields.Many2one('stock.warehouse', { string: 'Warehouse', help: "Technical field depicting the warehouse to consider for the route selection on the next procurement (if any)." });
  static hasTracking = Fields.Selection({ related: 'productId.tracking', string: 'Product with Tracking' });
  static quantityDone = Fields.Float('Quantity Done', { compute: '_quantityDoneCompute', digits: 'Product Unit of Measure', inverse: '_quantityDoneSet' });
  static showOperations = Fields.Boolean({ related: 'pickingId.pickingTypeId.showOperations' });
  static pickingCode = Fields.Selection({ related: 'pickingId.pickingTypeId.code', readonly: true });
  static showDetailsVisible = Fields.Boolean('Details Visible', { compute: '_computeShowDetailsVisible' });
  static showReservedAvailability = Fields.Boolean('From Supplier', { compute: '_computeShowReservedAvailability' });
  static productType = Fields.Selection({ related: 'productId.detailedType', readonly: true });
  static additional = Fields.Boolean("Whether the move was added after the picking's confirmation", { default: false });
  static isLocked = Fields.Boolean({ compute: '_computeIsLocked', readonly: true });
  static isInitialDemandEditable = Fields.Boolean('Is initial demand editable', { compute: '_computeIsInitialDemandEditable' });
  static isQuantityDoneEditable = Fields.Boolean('Is quantity done editable', { compute: '_computeIsQuantityDoneEditable' });
  static reference = Fields.Char({ compute: '_computeReference', string: "Reference", store: true });
  static moveLinesCount = Fields.Integer({ compute: '_computeMoveLinesCount' });
  static packageLevelId = Fields.Many2one('stock.package.level', { string: 'Package Level', checkCompany: true, copy: false });
  static pickingTypeEntirePacks = Fields.Boolean({ related: 'pickingTypeId.showEntirePacks', readonly: true });
  static displayAssignSerial = Fields.Boolean({ compute: '_computeDisplayAssignSerial' });
  static nextSerial = Fields.Char('First SN');
  static nextSerialCount = Fields.Integer('Number of SN');
  static orderpointId = Fields.Many2one('stock.warehouse.orderpoint', { string: 'Original Reordering Rule', checkCompany: true, index: true });
  static forecastAvailability = Fields.Float('Forecast Availability', { compute: '_computeForecastInformation', digits: 'Product Unit of Measure', computeSudo: true });
  static forecastExpectedDate = Fields.Datetime('Forecasted Expected date', { compute: '_computeForecastInformation', computeSudo: true });
  static lotIds = Fields.Many2many('stock.production.lot', { compute: '_computeLotIds', inverse: '_setLotIds', string: 'Serial Numbers', readonly: false });
  static reservationDate = Fields.Date('Date to Reserve', { compute: '_computeReservationDate', store: true, help: "This is a technical field for calculating when a move should be reserved" });
  static productPackagingId = Fields.Many2one('product.packaging', { string: 'Packaging', domain: "[['productId', '=', productId]]", checkCompany: true });
  static fromImmediateTransfer = Fields.Boolean({ related: "pickingId.immediateTransfer" });

  @api.depends('hasTracking', 'pickingTypeId.useCreateLots', 'pickingTypeId.useExistingLots', 'state')
  async _computeDisplayAssignSerial() {
    for (const move of this) {
      await move.set('displayAssignSerial', (
        await move.hasTracking === 'serial' &&
        ['partiallyAvailable', 'assigned', 'confirmed'].includes(await move.state) &&
        await (await move.pickingTypeId).useCreateLots &&
        ! await (await move.pickingTypeId).useExistingLots &&
        !bool((await move.originReturnedMoveId).id)
      ));
    }
  }

  @api.depends('pickingId.priority')
  async _computePriority() {
    for (const move of this) {
      await move.set('priority', await (await move.pickingId).priority || '0');
    }
  }

  @api.depends('pickingId.pickingTypeId')
  async _computePickingTypeId() {
    for (const move of this) {
      const pickingId = await move.pickingId;
      if (pickingId.ok) {
        await move.set('pickingTypeId', await pickingId.pickingTypeId);
      }
    }
  }

  @api.depends('pickingId.isLocked')
  async _computeIsLocked() {
    for (const move of this) {
      const pickingId = await move.pickingId;
      if (pickingId.ok) {
        await move.set('isLocked', await pickingId.isLocked);
      }
      else {
        await move.set('isLocked', false);
      }
    }
  }

  /**
   * According to this field, the button that calls `actionShowDetails` will be displayed to work on a move from its picking form view, or not.
   */
  @api.depends('productId', 'hasTracking', 'moveLineIds')
  async _computeShowDetailsVisible() {
    const hasPackage = await this.userHasGroups('stock.groupTrackingLot');
    const multiLocationsEnabled = await this.userHasGroups('stock.groupStockMultiLocations');
    const consignmentEnabled = await this.userHasGroups('stock.groupTrackingOwner');

    const showDetailsVisible = multiLocationsEnabled || hasPackage;

    for (const move of this) {
      if (!(await move.productId).ok) {
        await move.set('showDetailsVisible', false);
      }
      else if (len(await move._getMoveLines()) > 1) {
        await move.set('showDetailsVisible', true);
      }
      else {
        await move.set('showDetailsVisible', (((consignmentEnabled && await move.pickingCode !== 'incoming') ||
          showDetailsVisible || await move.hasTracking !== 'none') &&
          await move._showDetailsInDraft() &&
          await move.showOperations === false));
      }
    }
  }

  /**
   * This field is only of use in an attrs in the picking view, in order to hide the
    "available" column if the move is coming from a supplier.
   */
  async _computeShowReservedAvailability() {
    for (const move of this) {
      await move.set('showReservedAvailability', await (await move.locationId).usage !== 'supplier');
    }
  }

  @api.depends('state', 'pickingId')
  async _computeIsInitialDemandEditable() {
    for (const move of this) {
      const pickingId = await move.pickingId;
      if (! await pickingId.immediateTransfer && await move.state === 'draft') {
        await move.set('isInitialDemandEditable', true);
      }
      else if (! await pickingId.isLocked && await move.state !== 'done' && bool(pickingId)) {
        await move.set('isInitialDemandEditable', true);
      }
      else {
        await move.set('isInitialDemandEditable', false);
      }
    }
  }

  @api.depends('state', 'pickingId', 'productId')
  async _computeIsQuantityDoneEditable() {
    for (const move of this) {
      const pickingId = await move.pickingId;
      if (!bool(await move.productId)) {
        await move.set('isQuantityDoneEditable', false);
      }
      else if (! await pickingId.immediateTransfer && await pickingId.state === 'draft') {
        await move.set('isQuantityDoneEditable', false);
      }
      else if (await pickingId.isLocked && ['done', 'cancel'].includes(await move.state)) {
        await move.set('isQuantityDoneEditable', false);
      }
      else if (await move.showDetailsVisible) {
        await move.set('isQuantityDoneEditable', false);
      }
      else if (await move.showOperations) {
        await move.set('isQuantityDoneEditable', false);
      }
      else {
        await move.set('isQuantityDoneEditable', true);
      }
    }
  }
  @api.depends('pickingId', 'label')
  async _computeReference() {
    for (const move of this) {
      const pickingId = await move.pickingId;
      await move.set('reference', pickingId.ok ? await pickingId.label : await move.label);
    }
  }

  @api.depends('moveLineIds')
  async _computeMoveLinesCount() {
    for (const move of this) {
      await move.set('moveLinesCount', (await move.moveLineIds)._length);
    }
  }

  @api.depends('productId', 'productUom', 'productUomQty')
  async _computeProductQty() {
    for (const move of this) {
      await move.set('productQty', await (await move.productUom)._computeQuantity(await move.productUomQty, await (await move.productId).uomId, { roundingMethod: 'HALF-UP' }));
    }
  }

  /**
   * This will return the move lines to consider when applying _quantity_done_compute on a stock.move.
      In some context, such as MRP, it is necessary to compute quantity_done on filtered sock.move.line.
   * @returns 
   */
  async _getMoveLines() {
    this.ensureOne();
    if (await (await this['pickingTypeId']).showReserved === false) {
      return this['moveLineNosuggestIds'];
    }
    return this['moveLineIds'];
  }

  @api.depends('moveOrigIds.date', 'moveOrigIds.state', 'state', 'date')
  async _computeDelayAlertDate() {
    for (const move of this) {
      if (['done', 'cancel'].includes(await move.state)) {
        await move.set('delayAlertDate', false);
        continue;
      }
      const prevMoves = await (await move.moveOrigIds).filtered(async (m) => !['done', 'cancel'].includes(await m.state) && await m.date);
      const prevMaxDate = Math.max(...(await prevMoves.mapped("date")));
      if (prevMaxDate && prevMaxDate > await move.date) {
        await move.set('delayAlertDate', prevMaxDate);
      }
      else {
        await move.set('delayAlertDate', false);
      }
    }
  }

  /**
   * This field represents the sum of the move lines `qty_done`. It allows the user to know
      if there is still work to do.

      We take care of rounding this value at the general decimal precision and not the rounding
      of the move's UOM to make sure this value is really close to the real sum, because this
      field will be used in `_action_done` in order to know if the move will need a backorder or
      an extra move.
   */
  @api.depends('moveLineIds.qtyDone', 'moveLineIds.productUomId', 'moveLineNosuggestIds.qtyDone', 'pickingTypeId.showReserved')
  async _quantityDoneCompute() {
    if (!this._ids.some(id => bool(id))) {
      // onchange
      for (const move of this) {
        let quantityDone = 0;
        for (const moveLine of await move._getMoveLines()) {
          quantityDone += await (await moveLine.productUomId)._computeQuantity(await moveLine.qtyDone, await move.productUom, { round: false });
        }
        await move.set('quantityDone', quantityDone);
      }
    }
    else {
      // compute
      let moveLinesIds = [];//new Set<any>();
      for (const move of this) {
        moveLinesIds = _.union(moveLinesIds, (await move._getMoveLines()).ids);
      }

      const data = await this.env.items('stock.move.line').readGroup(
        [['id', 'in', moveLinesIds]],
        ['moveId', 'productUomId', 'qtyDone'], ['moveId', 'productUomId'],
        { lazy: false }
      );

      const rec = new Dict();// DefaultDict(list)
      for (const d of data) {
        const key = d['moveId'][0];
        rec[key] = (rec[key] ?? []).concat([[d['productUomId'][0], d['qtyDone']]]);
      }

      for (const move of this) {
        const uom = await move.productUom;
        await move.set('quantityDone', sum(
          await Promise.all(
            (rec[len(move.ids) ? move.ids[0] : move.id] ?? []).map(async ([lineUomId, qty]) => this.env.items('uom.uom').browse(lineUomId)._computeQuantity(qty, uom, { round: false }))
          )
        ));
      }
    }
  }

  async _quantityDoneSet() {
    const quantityDone = await this(0).quantityDone;  // any call to create will invalidate `move.quantity_done`
    for (const move of this) {
      const moveLines = await move._getMoveLines();
      if (!bool(moveLines)) {
        if (quantityDone) {
          // do not impact reservation here
          const moveLine = await this.env.items('stock.move.line').create(Object.assign(await move._prepareMoveLineVals(), { qtyDone: quantityDone }));
          await move.write({ 'moveLineIds': [[4, moveLine.id]] });
        }
      }
      else if (len(moveLines) == 1) {
        await moveLines[0].set('qtyDone', quantityDone);
      }
      else {
        await move._multiLineQuantityDoneSet(quantityDone);
      }
    }
  }

  async _multiLineQuantityDoneSet(quantityDone) {
    const moveLines = await this._getMoveLines();
    // Bypass the error if we're trying to write the same value.
    const productUom = await this['productUom'];
    let mlQuantityDone = 0;
    for (const moveLine of moveLines) {
      mlQuantityDone += await (await moveLine.productUomId)._computeQuantity(await moveLine.qtyDone, productUom, { round: false });
    }
    if (floatCompare(quantityDone, mlQuantityDone, { precisionRounding: await productUom.rounding }) != 0) {
      throw new UserError(await this._t("Cannot set the done quantity from this stock move, work directly with the move lines."));
    }
  }

  /**
   * The meaning of productQty field changed lately and is now a functional field computing the quantity
      in the default product UoM. This code has been added to raise an error if a write is made given a value
      for `productQty`, where the same write should set the `productUomQty` field instead, in order to
      detect errors.
   */
  async _setProductQty() {
    throw new UserError(await this._t('The requested operation cannot be processed because of a programming error setting the `productQty` field instead of the `productUomQty`.'));
  }

  /**
   * Fill the `availability` field on a stock move, which is the actual reserved quantity
      and is represented by the aggregated `productQty` on the linked move lines. If the move
      is force assigned, the value will be 0.
   */
  @api.depends('moveLineIds.productQty')
  async _computeReservedAvailability() {
    if (!this._ids.some(id => bool(id))) {
      // onchange
      for (const move of this) {
        const reservedAvailability = sum(await (await move.moveLineIds).mapped('productQty'));
        await move.set('reservedAvailability', await (await (await move.productId).uomId)._computeQuantity(
          reservedAvailability, await move.productUom, { roundingMethod: 'HALF-UP' }));
      }
    }
    else {
      // compute
      const result = Object.fromEntries((await this.env.items('stock.move.line').readGroup([['moveId', 'in', this.ids]], ['moveId', 'productQty'], ['moveId'])).map(data => [data['moveId'][0], data['productQty']]));
      for (const move of this) {
        await move.set('reservedAvailability', await (await (await move.productId).uomId)._computeQuantity(result[move.id] || 0.0, await move.productUom, { roundingMethod: 'HALF-UP' }));
      }
    }
  }

  /**
   * Fill the `availability` field on a stock move, which is the quantity to potentially
      reserve. When the move is done, `availability` is set to the quantity the move did actually
      move.
   */
  @api.depends('state', 'productId', 'productQty', 'locationId')
  async _computeProductAvailability() {
    for (const move of this) {
      if (await move.state === 'done') {
        await move.set('availability', await move.productQty);
      }
      else {
        const [productId, locationId, productQty] = await move('productId', 'locationId', 'productQty');
        const totalAvailability = productId.ok ? await this.env.items('stock.quant')._getAvailableQuantity(productId, locationId) : 0.0;
        await move.set('availability', Math.min(productQty, totalAvailability));
      }
    }
  }

  /**
   * Compute forecasted information of the related product by warehouse.
   * @returns 
   */
  @api.depends('productId', 'productQty', 'pickingTypeId', 'reservedAvailability', 'priority', 'state', 'productUomQty', 'locationId')
  async _computeForecastInformation() {
    // await Promise.all([
    await this.set('forecastAvailability', false),
      await this.set('forecastExpectedDate', false)
    // ]);

    // Prefetch product info to avoid fetching all product fields
    await (await this['productId']).read(['type', 'uomId'], { load: false });

    const notProductMoves = await this.filtered(async (move) => await (await move.productId).type !== 'product');
    for (const move of notProductMoves) {
      await move.set('forecastAvailability', await move.productQty);
    }

    const productMoves = this.sub(notProductMoves);

    const outgoingUnreservedMovesPerWarehouse = new Map<any, any>(); //defaultdict(set)
    const now = _Datetime.now();

    async function keyVirtualAvailable(move, incoming = false) {
      const warehouseId = incoming ? (await (await move.locationDestId).warehouseId).id : (await (await move.locationId).warehouseId).id;
      const date = await move.date;
      return `${warehouseId}@${date > now ? date : now}`;
    }

    // Prefetch efficiently virtual_available for _consuming_picking_types draft move.
    const prefetchVirtualAvailable = new Dict(); //defaultdict(set)
    const virtualAvailableDict = {};
    for (const move of productMoves) {
      if (this._consumingPickingTypes().includes(await (await move.pickingTypeId).code) && await move.state === 'draft') {
        const key = await keyVirtualAvailable(move);
        prefetchVirtualAvailable[key] = prefetchVirtualAvailable[key] ?? new Set();
        prefetchVirtualAvailable[key].add((await move.productId).id);
      }
      else if (await (await move.pickingTypeId).code === 'incoming') {
        const key = await keyVirtualAvailable(move, true);
        prefetchVirtualAvailable[key] = prefetchVirtualAvailable[key] ?? new Set();
        prefetchVirtualAvailable[key].add((await move.productId).id);
      }
    }
    for (const [keyContext, productIds] of prefetchVirtualAvailable.items()) {
      const [warehouseId, date] = keyContext.split('@');
      const readRes = await (await this.env.items('product.product').browse(productIds).withContext({ warehouse: warehouseId, toDate: date })).read(['virtualAvailable']);
      virtualAvailableDict[keyContext] = Object.fromEntries(readRes.map(res => [res['id'], res['virtualAvailable']]));
    }

    for (const move of productMoves) {
      const [pickingTypeId, productId, productQty, state] = await move('pickingTypeId', 'productId', 'productQty', 'state');
      if (this._consumingPickingTypes().includes(await pickingTypeId.code)) {
        if (state === 'assigned') {
          await move.set('forecastAvailability', await (await move.productUom)._computeQuantity(await move.reservedAvailability, await productId.uomId, { roundingMethod: 'HALF-UP' }));
        }
        else if (state === 'draft') {
          // for move _consuming_picking_types and in draft -> the forecastAvailability > 0 if in stock
          await move.set('forecastAvailability', virtualAvailableDict[await keyVirtualAvailable(move)][productId.id] - productQty);
        }
        else if (['waiting', 'confirmed', 'partiallyAvailable'].includes(state)) {
          const key = await (await move.locationId).warehouseId;
          if (!outgoingUnreservedMovesPerWarehouse.has(key)) {
            outgoingUnreservedMovesPerWarehouse.set(key, new Set());
          }
          outgoingUnreservedMovesPerWarehouse.get(key).add(move.id);
        }
      }
      else if (await pickingTypeId.code === 'incoming') {
        let forecastAvailability = virtualAvailableDict[await keyVirtualAvailable(move, true)][productId.id];
        if (state === 'draft') {
          forecastAvailability += productQty;
        }
        await move.set('forecastAvailability', forecastAvailability);
      }
    }

    for (const [warehouse, movesIds] of outgoingUnreservedMovesPerWarehouse) {
      if (!bool(warehouse)) {  // No prediction possible if no warehouse.
        continue;
      }
      const moves = this.browse(movesIds);
      const forecastInfo: Map<any, any> = await moves._getForecastAvailabilityOutgoing(warehouse);
      for (const move of moves) {
        const [forecastAvailability, forecastExpectedDate] = forecastInfo.get(move);
        // await Promise.all([
        await move.set('forecastAvailability', forecastAvailability),
          await move.set('forecastExpectedDate', forecastExpectedDate)
        // ]);
      }
    }
  }

  async _setDateDeadline(newDeadline) {
    // Handle the propagation of `dateDeadline` fields (up and down stream - only update by up/downstream documents)
    const alreadyPropagateIds = _.union(this.env.context['dateDeadlinePropagateIds'] ?? [], this.ids);
    const self = await this.withContext({ dateDeadlinePropagateIds: alreadyPropagateIds });
    for (const move of self) {
      const movesToUpdate = _.union([...await move.moveDestIds], [...await move.moveOrigIds]);
      let delta;
      if (await move.dateDeadline) {
        delta = DateTime.fromJSDate(await move.dateDeadline).diff(DateTime.fromJSDate(_Datetime.toDatetime(newDeadline) as Date)).milliseconds;
      }
      else {
        delta = 0;
      }
      for (const moveUpdate of movesToUpdate) {
        if (['done', 'cancel'].includes(await moveUpdate.state)) {
          continue;
        }
        if (alreadyPropagateIds.includes(moveUpdate.id)) {
          continue;
        }
        const dateDeadline = await moveUpdate.dateDeadline;
        if (dateDeadline && delta) {
          await moveUpdate.set('dateDeadline', new Date(dateDeadline - delta));
        }
        else {
          await moveUpdate.set('dateDeadline', newDeadline);
        }
      }
    }
  }

  @api.depends('moveLineIds', 'moveLineIds.lotId', 'moveLineIds.qtyDone')
  async _computeLotIds() {
    const domainNosuggest = [['moveId', 'in', this.ids], ['lotId', '!=', false], '|', ['qtyDone', '!=', 0.0], ['productQty', '=', 0.0]];
    const domainSuggest = [['moveId', 'in', this.ids], ['lotId', '!=', false], ['qtyDone', '!=', 0.0]];
    const lotsByMoveIdList = [];
    for (const domain of [domainNosuggest, domainSuggest]) {
      const lotsByMoveId = await this.env.items('stock.move.line').readGroup(domain, ['moveId', 'lotIds:array_agg(lotId)'], ['moveId'],
      )
      lotsByMoveIdList.push(Dict.from(lotsByMoveId.map(byMove => [byMove['moveId'][0], byMove['lotIds']])));
    }
    for (const move of this) {
      await move.set('lotIds', lotsByMoveIdList[await (await move.pickingTypeId).showReserved ? 0 : 1].get(move._origin.id, []));
    }
  }

  async _setLotIds() {
    for (const move of this) {
      const [lotIds, moveLineIds, productId] = await move('lotIds', 'moveLineIds', 'productId');
      const moveLinesCommands = [];
      let mls;
      if (await (await move.pickingTypeId).showReserved === false) {
        mls = await move.moveLineNosuggestIds;
      }
      else {
        mls = moveLineIds;
      }
      mls = await mls.filtered((ml) => ml.lotId);
      for (const ml of mls) {
        if (await ml.qtyDone && !lotIds.includes(await ml.lotId)) {
          moveLinesCommands.push([2, ml.id]);
        }
      }
      const ls = await moveLineIds.lotId;
      for (const lot of lotIds) {
        if (!ls.includes(lot)) {
          const moveLineVals = await this._prepareMoveLineVals(0);
          moveLineVals['lotId'] = lot.id
          moveLineVals['lotName'] = await lot.label
          moveLineVals['productUomId'] = (await productId.uomId).id
          moveLineVals['qtyDone'] = 1
          moveLinesCommands.push([0, 0, moveLineVals]);
        }
        else {
          const moveLine = await moveLineIds.filtered(async (line) => (await line.lotId).id == lot.id)
          await moveLine.set('qtyDone', 1);
        }
      }
      await move.write({ 'moveLineIds': moveLinesCommands });
    }
  }

  @api.depends('pickingTypeId', 'date', 'priority')
  async _computeReservationDate() {
    for (const move of this) {
      const pickingTypeId = await move.pickingTypeId;
      if (await pickingTypeId.reservationMethod === 'byDate' && ['draft', 'confirmed', 'waiting', 'partiallyAvailable'].includes(await move.state)) {
        let days = await pickingTypeId.reservationDaysBefore;
        if (await move.priority === '1') {
          days = await pickingTypeId.reservationDaysBeforePriority;
        }
        await move.set('reservationDate', DateTime.fromJSDate(_Date.toDate(await move.date) as Date).minus({ days: days }).toJSDate());
      }
    }
  }

  @api.constrains('productUom')
  async _checkUom() {
    const [productId, productUom] = await this('productId', 'productUom');
    const movesError = await this.filtered(async (move) => !(await (await productId.uomId).categoryId).eq(await productUom.categoryId));
    if (bool(movesError)) {
      let userWarning = await this._t('You cannot perform the move because the unit of measure has a different category as the product unit of measure.');
      for (const move of movesError) {
        userWarning += await this._t('\n\n%s --> Product UoM is %s (%s) - Move UoM is %s (%s)', await productId.displayName, await (await productId.uomId).label, await (await (await productId.uomId).categoryId).label, await productUom.label, await (await productUom.categoryId).label);
      }
      userWarning += await this._t('\n\nBlocking: %s', (await movesError.mapped('label')).join(', '));
      throw new UserError(userWarning);
    }
  }

  async init() {
    const res = await this._cr.execute(`SELECT indexname FROM pg_indexes WHERE indexname = '%s'`, ['stock_move_product_location_index']);
    if (!bool(res)) {
      this._cr.execute('CREATE INDEX stock_move_product_location_index ON "stockMove" ("productId", "locationId", "locationDestId", "companyId", state)');
    }
  }

  @api.model()
  async defaultGet(fieldsList) {
    // We override the defaultGet to make stock moves created after the picking was confirmed
    // directly as available in immediate transfer mode. This allows to create extra move lines
    // in the fp view. In planned transfer, the stock move are marked as `additional` and will be
    // auto-confirmed.
    const defaults = await _super(StockMove, this).defaultGet(fieldsList);
    if (this.env.context['default_pickingId']) {
      const pickingId = this.env.items('stock.picking').browse(this.env.context['default_pickingId']);
      const state = await pickingId.state;
      if (state === 'done') {
        defaults['state'] = 'done';
        defaults['productUomQty'] = 0.0;
        defaults['additional'] = true;
      }
      else if (!['cancel', 'draft', 'done'].includes(state)) {
        if (await pickingId.immediateTransfer) {
          defaults['state'] = 'assigned';
        }
        defaults['productUomQty'] = 0.0;
        defaults['additional'] = true  // to trigger `_autoconfirmPicking`
      }
    }
    return defaults;
  }

  async nameGet() {
    const res = [];
    for (const move of this) {
      const [pickingId, productId] = await move('pickingId', 'productId');
      res.push([move.id, f('%s%s%s>%s',
        await pickingId.origin ? f('%s/', await pickingId.origin) : '',
        await productId.code ? f('%s: ', await productId.code) : '',
        await (await move.locationId).label, await (await move.locationDestId).label)]);
    }
    return res;
  }

  async write(vals) {
    // Handle the write on the initial demand by updating the reserved quantity and logging
    // messages according to the state of the stock.move records.
    let receiptMovesToReassign = this.env.items('stock.move');
    let moveToRecomputeState = this.env.items('stock.move');

    if ('productUom' in vals) {
      for (const move of this) {
        if (await move.state === 'done') {
          throw new UserError(await this._t('You cannot change the UoM for a stock move that has been set to \'Done\'.'));
        }
      }
    }
    if ('productUomQty' in vals) {
      const moveToUnreserve = this.env.items('stock.move');
      for (const move of await this.filtered(async (m) => !['done', 'draft'].includes(await m.state) && (await m.pickingId).ok)) {
        if (floatCompare(vals['productUomQty'], await move.productUomQty, { precisionRounding: await (await move.productUom).rounding })) {
          await this.env.items('stock.move.line')._logMessage(await move.pickingId, move, 'stock.trackMoveTemplate', vals);
        }
      }
      if (this.env.context['doNotUnreserve'] == null) {
        const moveToUnreserve = await this.filtered(
          async (m) => !['draft', 'done', 'cancel'].includes(await m.state) && floatCompare(await m.reservedAvailability, vals['productUomQty'], { precisionRounding: await (await m.productUom).rounding }) == 1
        );
        await moveToUnreserve._doUnreserve();
        await (await this.sub(moveToUnreserve).filtered(async (m) => await m.state === 'assigned')).write({ 'state': 'partiallyAvailable' });
        // When editing the initial demand, directly run again action assign on receipt moves.
        receiptMovesToReassign = receiptMovesToReassign.or(await moveToUnreserve.filtered(async (m) => await (await m.locationId).usage === 'supplier'));
        receiptMovesToReassign = receiptMovesToReassign.or(await this.sub(moveToUnreserve).filtered(async (m) => await (await m.locationId).usage === 'supplier' && ['partiallyAvailable', 'assigned'].includes(await m.state)));
        moveToRecomputeState = moveToRecomputeState.or(this.sub(moveToUnreserve).sub(receiptMovesToReassign));
      }
    }
    if ('dateDeadline' in vals) {
      await this._setDateDeadline(vals['dateDeadline']);
    }
    const res = await _super(StockMove, this).write(vals);
    if (moveToRecomputeState.ok) {
      await moveToRecomputeState._recomputeState();
    }
    if (receiptMovesToReassign.ok) {
      await receiptMovesToReassign._actionAssign();
    }
    return res;
  }

  /**
   * Returns a list of recordset of the documents linked to the stock.move in `self` in order
      to post the delay alert next activity. These documents are deduplicated. This method is meant
      to be overridden by other modules, each of them adding an element by type of recordset on
      this list.

      :return: a list of recordset of the documents linked to `self`
      :rtype: list
   * @returns 
   */
  async _delayAlertGetDocuments() {
    return this.mapped('pickingId');
  }

  /**
   * Post a deadline change alert log note on the documents linked to `self`.
   * @param moveOrig 
   * @returns 
   */
  async _propagateDateLogNote(moveOrig) {
    // TODO : get the end document (PO/SO/MO)
    const docOrig = await moveOrig._delayAlertGetDocuments();
    const documents = await this._delayAlertGetDocuments();
    if (!bool(documents) || !bool(docOrig)) {
      return;
    }

    const msg = await this._t("The deadline has been automatically updated due to a delay on <a href='#' data-oe-model='%s' data-oe-id='%s'>%s</a>.", docOrig[0]._name, docOrig[0].id, await docOrig[0].label);
    const msgSubject = await this._t("Deadline updated due to delay on %s", await docOrig[0].label);
    // write the message on each document
    for (const doc of documents) {
      const lastMessage = (await doc.messageIds).slice(0, 1);
      // Avoids to write the exact same message multiple times.
      if (lastMessage.ok && await lastMessage.subject === msgSubject) {
        continue;
      }
      const verpbotId = await this.env.items('ir.model.data')._xmlidToResId("base.partnerRoot");
      await doc.messagePost({ body: msg, authorId: verpbotId, subject: msgSubject });
    }
  }

  /**
   * Returns an action that will open a form view (in a popup) allowing to work on all the
      move lines of a particular move. This form view is used when "show operations" is not
      checked on the picking type.
   * @returns 
   */
  async actionShowDetails() {
    this.ensureOne();
    const [pickingTypeId, productId, state, companyId, hasTracking, locationId] = await this('pickingTypeId', 'productId', 'state', 'companyId', 'hasTracking', 'locationId');
    // If "show suggestions" is not checked on the picking type, we have to filter out the
    // reserved move lines. We do this by displaying `move_line_nosuggest_ids`. We use
    // different views to display one field or another so that the webclient doesn't have to
    // fetch both.
    let view;
    if (await pickingTypeId.showReserved) {
      view = await this.env.ref('stock.viewStockMoveOperations');
    }
    else {
      view = await this.env.ref('stock.viewStockMoveNosuggestOperations');
    }

    if (await productId.tracking === "serial" && state === "assigned") {
      await this.set('nextSerial', this.env.items('stock.production.lot').getNextSerial(companyId, productId));
    }

    const code = await pickingTypeId.code;
    return {
      'label': await this._t('Detailed Operations'),
      'type': 'ir.actions.actwindow',
      'viewMode': 'form',
      'resModel': 'stock.move',
      'views': [[view.id, 'form']],
      'viewId': view.id,
      'target': 'new',
      'resId': this.id,
      'context': Object.assign({}, this.env.context, {
        showOwner: code !== 'incoming',
        showLotsM2o: hasTracking !== 'none' && (await pickingTypeId.useExistingLots || state === 'done' || (await this['originReturnedMoveId']).id),  // able to create lots, whatever the value of ` useCreateLots`.
        showLotsText: hasTracking !== 'none' && await pickingTypeId.useCreateLots && ! await pickingTypeId.useExistingLots && state !== 'done' && !(await this['originReturnedMoveId']).id,
        showSourceLocation: code !== 'incoming',
        showDestinationLocation: code !== 'outgoing',
        showPackage: await locationId.usage !== 'supplier',
        showReservedQuantity: state !== 'done' && !await (await this['pickingId']).immediateTransfer && code !== 'incoming'
      }),
    }
  }

  /**
   * On `this.moveLineIds`, assign `lotName` according to
      `this.nextSerial` before returning `this.actionShowDetails`.
   * @returns 
   */
  async actionAssignSerialShowDetails() {
    this.ensureOne();
    if (! await this['nextSerial']) {
      throw new UserError(await this._t("You need to set a Serial Number before generating more."));
    }
    await this._generateSerialNumbers();
    return this.actionShowDetails();
  }

  /**
   * Unlink `this.moveLineIds` before returning `this.actionShowDetails`.
      Useful for if a user creates too many SNs by accident via actionAssignSerialShowDetails
      since there's no way to undo the action.
   * @returns 
   */
  async actionClearLinesShowDetails() {
    this.ensureOne();
    let moveLines;
    if (await (await this['pickingTypeId']).showReserved) {
      moveLines = await this['moveLineIds'];
    }
    else {
      moveLines = await this['moveLineNosuggestIds'];
    }
    moveLines.unlink();
    return this.actionShowDetails();
  }

  /**
   * Opens a wizard to assign SN's name on each move lines.
   * @returns 
   */
  async actionAssignSerial() {
    this.ensureOne();
    const action = await this.env.items("ir.actions.actions")._forXmlid("stock.actAssignSerialNumbers");
    action['context'] = {
      'default_productId': (await this['productId']).id,
      'default_moveId': this.id,
    }
    return action;
  }

  async actionProductForecastReport() {
    this.ensureOne();
    const productId = await this['productId'];
    const action = await productId.actionProductForecastReport();
    action['context'] = {
      'activeId': productId.id,
      'activeModel': 'product.product',
      'moveToMatchIds': this.ids,
    }
    let warehouse;
    if (this._consumingPickingTypes().includes(await (await this['pickingTypeId']).code)) {
      warehouse = await (await this['locationId']).warehouseId;
    }
    else {
      warehouse = await (await this['locationDestId']).warehouseId;
    }
    if (warehouse.ok) {
      action['context']['warehouse'] = warehouse.id;
    }
    return action;
  }

  async _doUnreserve() {
    let movesToUnreserve: any = new OrderedSet2();
    for (const move of this) {
      const state = await move.state;
      if (state === 'cancel' || (state === 'done' && await move.scrapped)) {
        // We may have cancelled move in an open picking in a "propagate_cancel" scenario.
        // We may have done move in an open picking in a scrap scenario.
        continue;
      }
      else if (state === 'done') {
        throw new UserError(await this._t("You cannot unreserve a stock move that has been set to 'Done'."));
      }
      movesToUnreserve.add(move.id);
    }
    movesToUnreserve = this.env.items('stock.move').browse(movesToUnreserve);

    let [mlToUpdate, mlToUnlink]: [any, any] = [new OrderedSet2(), new OrderedSet2()];
    let movesNotToRecompute = new OrderedSet2();
    for (const ml of await movesToUnreserve.moveLineIds) {
      if (await ml.qtyDone) {
        mlToUpdate.add(ml.id);
      }
      else {
        mlToUnlink.add(ml.id);
        movesNotToRecompute.add((await ml.moveId).id);
      }
    }
    [mlToUpdate, mlToUnlink] = [this.env.items('stock.move.line').browse(mlToUpdate), this.env.items('stock.move.line').browse(mlToUnlink)];
    movesNotToRecompute = this.env.items('stock.move').browse(movesNotToRecompute);

    await mlToUpdate.write({ 'productUomQty': 0 });
    await mlToUnlink.unlink();
    // `write` on `stock.move.line` doesn't call `_recompute_state` (unlike to `unlink`),
    // so it must be called for each move where no move line has been deleted.
    await movesToUnreserve.sub(movesNotToRecompute)._recomputeState();
    return true;
  }

  /**
   * This method will generate `lotName` from a string (field
      `next_serial`) and create a move line for each generated `lotName`.
   * @param nextSerialCount 
   * @returns 
   */
  async _generateSerialNumbers(nextSerialCount = false) {
    this.ensureOne();
    const lotNames = await this.env.items('stock.production.lot').generateLotNames(await this['nextSerial'], nextSerialCount || await this['nextSerialCount']);
    const moveLinesCommands = await this._generateSerialMoveLineCommands(lotNames);
    await this.write({ 'moveLineIds': moveLinesCommands });
    return true;
  }

  async _pushApply() {
    const newMoves = [];
    for (const move of this) {
      const [moveDestIds, locationDestId, pickingId, routeIds, productPackagingId, productId, originReturnedMoveId] = await move('moveDestIds', 'locationDestId', 'pickingId', 'routeIds', 'productPackagingId', 'productId', 'originReturnedMoveId');
      // if the move is already chained, there is no need to check push rules
      if (moveDestIds.ok) {
        continue;
      }
      // if the move is a returned move, we don't want to check push rules, as returning a returned move is the only decent way
      // to receive goods without triggering the push rules again (which would duplicate chained operations)
      const domain = [['locationSrcId', '=', locationDestId.id], ['action', 'in', ['push', 'pullPush']]];
      // first priority goes to the preferred routes defined on the move itself (e.g. coming from a SO line)
      const warehouseId = (await move.warehouseId).ok ? await move.warehouseId : await (await pickingId.pickingTypeId).warehouseId;
      let rule;
      if ((await locationDestId.companyId).eq(await this.env.company())) {
        rule = await this.env.items('procurement.group')._searchRule(routeIds, productPackagingId, productId, warehouseId, domain);
      }
      else {
        rule = await (await this.sudo()).env.items('procurement.group')._searchRule(routeIds, productPackagingId, productId, warehouseId, domain);
      }
      // Make sure it is not returning the return
      if (bool(rule) && (!bool(originReturnedMoveId) || (await originReturnedMoveId.locationDestId).id != (await rule.locationId).id)) {
        const newMove = await rule._runPush(move);
        if (bool(newMove)) {
          newMoves.push(newMove);
        }
      }
    }
    return this.env.items('stock.move').concat([...newMoves]);
  }

  /**
   * This method will return a dict of stock move’s values that represent the values of all moves in `self` merged. 
   * @returns 
   */
  async _mergeMovesFields() {
    const state = await this._getRelevantStateAmongMoves();
    const origin = Array.from(new Set(await (await this.filtered((m) => m.origin)).mapped('origin'))).join('/');
    return {
      'productUomQty': sum(await this.mapped('productUomQty')),
      'date': (await this.mapped('pickingId')).moveType === 'direct' ? dateMin(await this.mapped('date')) : dateMax(await this.mapped('date')),
      'moveDestIds': (await this.mapped('moveDestIds')).map(m => [4, m.id]),
      'moveOrigIds': (await this.mapped('moveOrigIds')).map(m => [4, m.id]),
      'state': state,
      'origin': origin,
    }
  }

  @api.model()
  _prepareMergeMovesDistinctFields() {
    return [
      'productId', 'priceUnit', 'procureMethod', 'locationId', 'locationDestId',
      'productUom', 'restrictPartnerId', 'scrapped', 'originReturnedMoveId',
      'packageLevelId', 'propagateCancel', 'descriptionPicking', 'dateDeadline',
      'productPackagingId',
    ]
  }

  @api.model()
  _prepareMergeNegativeMovesExcludedDistinctFields(): string[] {
    return [];
  }

  /**
   * Cleanup hook used when merging moves
   * @returns 
   */
  async _cleanMerged() {
    await this.write({ 'propagateCancel': false });
  }

  async _updateCandidateMovesList(candidateMovesList: any[]) {
    for (const picking of await this.mapped('pickingId')) {
      candidateMovesList.push(await picking.moveLines);
    }
  }

  /**
   * This method will, for each move in `self`, go up in their linked picking and try to
      find in their existing moves a candidate into which we can merge the move.
      :return: Recordset of moves passed to this method. If some of the passed moves were merged
      into another existing one, return this one and not the (now unlinked) original.
   * @param mergeInto 
   * @returns 
   */
  async _mergeMoves(mergeInto?: any) {
    const distinctFields = this._prepareMergeMovesDistinctFields();

    const candidateMovesList = [];
    if (!bool(mergeInto)) {
      await this._updateCandidateMovesList(candidateMovesList);
    }
    else {
      candidateMovesList.push(mergeInto.or(this));
    }
    // Move removed after merge
    let movesToUnlink = this.env.items('stock.move');
    // Moves successfully merged
    let mergedMoves = this.env.items('stock.move');

    const movesByNegKey = new DefaultDict2(() => this.env.items('stock.move'));
    // Need to check less fields for negative moves as some might not be set.
    const negQtyMoves = await this.filtered(async (m) => floatCompare(await m.productQty, 0.0, { precisionRounding: await (await m.productUom).rounding }) < 0);
    const excludedFields = this._prepareMergeNegativeMovesExcludedDistinctFields();
    const negKey = itemgetter(distinctFields.filter(field => !excludedFields.includes(field)));

    for (let candidateMoves of candidateMovesList) {
      // First step find move to merge.
      candidateMoves = (await candidateMoves.filtered(async (m) => !['done', 'cancel', 'draft'].includes(await m.state))).sub(negQtyMoves);
      for (const [, g] of groupby(candidateMoves, itemgetter(distinctFields))) {
        const moves = this.env.items('stock.move').concat(g);
        // Merge all positive moves together
        if (len(moves) > 1) {
          // link all move lines to record 0 (the one we will keep).
          await (await moves.mapped('moveLineIds')).write({ 'moveId': moves(0).id });
          // merge move data
          await moves(0).write(await moves._mergeMovesFields());
          // update merged moves dicts
          movesToUnlink = movesToUnlink.or(moves.slice(1));
          mergedMoves = mergedMoves.or(moves(0));
        }
        // Add the now single positive move to its limited key record
        const key: any = negKey(moves(0));
        movesByNegKey[key] = movesByNegKey[key].or(moves(0));
      }
    }
    for (const negMove of negQtyMoves) {
      // Check all the candidates that matches the same limited key, and adjust their quantites to absorb negative moves
      const key: any = negKey(negMove);
      for (const posMove of (movesByNegKey[key] ?? [])) {
        // If quantity can be fully absorbed by a single move, update its quantity and remove the negative move
        if (floatCompare(await posMove.productUomQty, Math.abs(await negMove.productUomQty), { precisionRounding: await (await posMove.productUom).rounding }) >= 0) {
          await posMove.set('productUomQty', await posMove.productUomQty + await negMove.productUomQty);
          mergedMoves = mergedMoves.or(posMove);
          movesToUnlink = movesToUnlink.or(negMove);
          break;
        }
        await negMove.set('productUomQty', await negMove.productUomQty + await posMove.productUomQty);
        await posMove.set('productUomQty', 0);
      }
    }
    if (movesToUnlink.ok) {
      // We are using propagate to false in order to not cancel destination moves merged in moves[0]
      await movesToUnlink._cleanMerged();
      await movesToUnlink._actionCancel();
      await (await movesToUnlink.sudo()).unlink();
    }

    return this.or(mergedMoves).sub(movesToUnlink);
  }

  async _getRelevantStateAmongMoves() {
    // We sort our moves by importance of state:
    //     ------------- 0
    //     | Assigned  |
    //     -------------
    //     |  Waiting  |
    //     -------------
    //     |  Partial  |
    //     -------------
    //     |  Confirm  |
    //     ------------- len-1
    const sortMap = {
      'assigned': 4,
      'waiting': 3,
      'partiallyAvailable': 2,
      'confirmed': 1,
    }
    const movesTodo = await (await this
      .filtered(async (move) => {
        const state = await move.state;
        return !['cancel', 'done'].includes(state) && !(state === 'assigned' && ! await move.productUomQty)
      }))
      .sorted(async (move) => (sortMap[await move.state] || 0, await move.productUomQty));
    if (!bool(movesTodo)) {
      return 'assigned';
    }
    // The picking should be the same for all moves.
    if (await movesTodo.slice(0, 1).pickingId && await (await movesTodo.slice(0, 1).pickingId).moveType === 'one') {
      const mostImportantMove = movesTodo(0);
      if (await mostImportantMove.state === 'confirmed') {
        return await mostImportantMove.productUomQty ? 'confirmed' : 'assigned';
      }
      else if (await mostImportantMove.state === 'partiallyAvailable') {
        return 'confirmed';
      }
      else {
        return await movesTodo.slice(0, 1).state ?? 'draft';
      }
    }
    else if (await movesTodo.slice(0, 1).state !== 'assigned') {
      for (const move of movesTodo) {
        if (['assigned', 'partiallyAvailable'].includes(await move.state)) {
          return 'partiallyAvailable';
        }
      }
    }
    else {
      const leastImportantMove = movesTodo([-1]);
      if (await leastImportantMove.state === 'confirmed' && await leastImportantMove.productUomQty == 0) {
        return 'assigned';
      }
      else {
        return await movesTodo([-1]).state ?? 'draft';
      }
    }
  }

  @api.onchange('productId', 'pickingTypeId')
  async _onchangeProductId() {
    // const promises = [];
    const product = await (await this['productId']).withContext({ lang: await (this as any)._getLang() });
    await this.set('label', await product.partnerRef);
    await this.set('productUom', (await product.uomId).id);
    if (bool(product)) {
      await this.set('descriptionPicking', await product._getDescription(await this['pickingTypeId']));
    }
    // await Promise.all(promises);
  }

  @api.onchange('productId', 'productQty', 'productUom')
  async _onchangeSuggestPackaging() {
    const [productId, productPackagingId, productQty, productUom] = await this('productId', 'productPackagingId', 'productQty', 'productUom');
    // remove packaging if not match the product
    if (!(await productPackagingId.productId).eq(productId)) {
      await this.set('productPackagingId', false);
    }
    // suggest biggest suitable packaging
    if (productId.ok && productQty && productUom) {
      await this.set('productPackagingId', await (await productId.packagingIds)._findSuitableProductPackaging(productQty, productUom));
    }
  }

  @api.onchange('lotIds')
  async _onchangeLotIds() {
    const [productId, moveLineIds, lotIds, productUom, companyId] = await this('productId', 'moveLineIds', 'lotIds', 'productUom', 'companyId');
    let quantityDone = 0;
    for (const ml of await moveLineIds.filtered(async (ml) => !(await ml.lotId).ok && await ml.lotName)) {
      quantityDone += await (await ml.productUomId)._computeQuantity(await ml.qtyDone, productUom);
    }

    quantityDone += await (await productId.uomId)._computeQuantity(lotIds._length, productUom);
    await this.update({ 'quantityDone': quantityDone });

    const quants = await this.env.items('stock.quant').search([
      ['productId', '=', productId.id],
      ['lotId', 'in', lotIds.ids],
      ['quantity', '!=', 0],
      '|', ['locationId.usage', '=', 'customer'],
      '&', ['companyId', '=', companyId.id],
      ['locationId.usage', 'in', ['internal', 'transit']]
    ]);
    if (quants.ok) {
      let snToLocation = "";
      for (const quant of quants) {
        snToLocation += await this._t("\n(%s) exists in location %s", await (await quant.lotId).displayName, await (await quant.locationId).displayName);
      }
      return {
        'warning': { 'title': await this._t('Warning'), 'message': await this._t('Existing Serial numbers. Please correct the serial numbers encoded:') + snToLocation }
      }
    }
  }

  @api.onchange('moveLineIds', 'moveLineNosuggestIds', 'pickingTypeId')
  async _onchangeMoveLineIds() {
    const [companyId, productId, pickingTypeId, moveLineIds, moveLineNosuggestIds] = await this('companyId', 'productId', 'pickingTypeId', 'moveLineIds', 'moveLineNosuggestIds');
    if (! await pickingTypeId.useCreateLots) {
      // This onchange manages the creation of multiple lot name. We don't need that if the picking type disallows the creation of new lots.
      return;
    }
    let breakingChar = '\n';
    let moveLines;
    if (await pickingTypeId.showReserved) {
      moveLines = moveLineIds;
    }
    else {
      moveLines = moveLineNosuggestIds;
    }
    for (const moveLine of moveLines) {
      // Look if the `lotName` contains multiple values.
      const lotName = await moveLine.lotName || '';
      if (lotName.includes(breakingChar)) {
        let splitLines = lotName.split(breakingChar);
        splitLines = splitLines.filter(item => bool(item));
        await moveLine.set('lotName', splitLines[0]);
        const moveLinesCommands = await this._generateSerialMoveLineCommands(
          splitLines.slice(1),
          moveLine,
        )
        if (await pickingTypeId.showReserved) {
          await this.update({ 'moveLineIds': moveLinesCommands });
        }
        else {
          await this.update({ 'moveLineNosuggestIds': moveLinesCommands });
        }
        const existingLots = await this.env.items('stock.production.lot').search([
          ['companyId', '=', companyId.id],
          ['productId', '=', productId.id],
          ['label', 'in', splitLines],
        ]);
        if (existingLots.ok) {
          return {
            'warning': { 'title': await this._t('Warning'), 'message': await this._t('Existing Serial Numbers (%s). Please correct the serial numbers encoded.', (await existingLots.mapped('displayName')).join(',')) }
          }
        }
        break;
      }
    }
  }

  @api.onchange('productUom')
  async _onchangeProductUom() {
    if (await (await this['productUom']).factor > await (await (await this['productId']).uomId).factor) {
      return {
        'warning': {
          'title': "Unsafe unit of measure",
          'message': await this._t("You are using a unit of measure smaller than the one you are using in order to stock your product. This can lead to rounding problem on reserved quantity. You should use the smaller unit of measure possible in order to valuate your stock or change its rounding precision to a smaller value (example: 0.00001)."),
        }
      }
    }
  }

  async _keyAssignPicking() {
    this.ensureOne();
    let keys: any[] = await this('groupId', 'locationId', 'locationDestId', 'pickingTypeId', 'partnerId');
    if (bool(keys[4]) && (await keys[1].usage === 'transit' || await keys[2].usage === 'transit')) {
      keys = keys.pop();
    }
    return keys;
  }

  async _searchPickingForAssignationDomain() {
    const [groupId, locationId, locationDestId, pickingTypeId, partnerId] = await this('groupId', 'locationId', 'locationDestId', 'pickingTypeId', 'partnerId');
    let domain = [
      ['groupId', '=', groupId.id],
      ['locationId', '=', locationId.id],
      ['locationDestId', '=', locationDestId.id],
      ['pickingTypeId', '=', pickingTypeId.id],
      ['printed', '=', false],
      ['immediateTransfer', '=', false],
      ['state', 'in', ['draft', 'confirmed', 'waiting', 'partiallyAvailable', 'assigned']]];
    if (bool(partnerId) && (await locationId.usage === 'transit' || await locationDestId.usage === 'transit')) {
      domain = domain.concat(['partnerId', '=', partnerId.id]);
    }
    return domain;
  }

  async _searchPickingForAssignation() {
    this.ensureOne();
    const domain = await this._searchPickingForAssignationDomain();
    return this.env.items('stock.picking').search(domain, { limit: 1 });
  }

  /**
   * Try to assign the moves to an existing picking that has not been
        reserved yet and has the same procurement group, locations and picking
        type (moves should already have them identical). Otherwise, create a new
        picking to assign them to.
   */
  async _assignPicking() {
    const Picking = this.env.items('stock.picking');
    const keys = await this.sorted(async (m) => (await m._keyAssignPicking()).map(f => f.id).join(','));
    const groupedMoves = await groupbyAsync(keys, async (m) => [await m._keyAssignPicking()]);
    for (let [, moves] of groupedMoves) {
      moves = this.env.items('stock.move').concat(moves);
      let newPicking = false;
      // Could pass the arguments contained in group but they are the same for each move that why moves[0] is acceptable
      let picking = await moves[0]._searchPickingForAssignation();
      if (bool(picking)) {
        for (const m of moves) {
          if ((await picking.partnerId).id != (await m.partnerId).id || !(await picking.origin).eq(await m.origin)) {
            // If a picking is found, we'll append `move` to its move list and thus its `partnerId` and `ref` field will refer to multiple records. In this case, we chose to  wipe them.
            await picking.write({
              'partnerId': false,
              'origin': false,
            });
          }
        }
      }
      else {
        // Don't create picking for negative moves since they will be reverse and assign to another picking
        moves = await moves.filtered(async (m) => floatCompare(await m.productUomQty, 0.0, { precisionRounding: await (await m.productUom).rounding }) >= 0);
        if (!bool(moves)) {
          continue;
        }
        newPicking = true;
        picking = await Picking.create(await moves._getNewPickingValues());
      }
      await moves.write({ 'pickingId': picking.id });
      await moves._assignPickingPostProcess(newPicking);
    }
    return true;
  }

  async _assignPickingPostProcess(newPicking = false) {
    // pass
  }

  /**
   * Return a list of commands to update the move lines (write on
      existing ones or create new ones).
      Called when user want to create and assign multiple serial numbers in
      one time (using the button/wizard or copy-paste a list in the field).

      :param lot_names: A list containing all serial number to assign.
      :type lot_names: list
      :param origin_move_line: A move line to duplicate the value from, default to None
      :type origin_move_line: record of :class:`stock.move.line`
      :return: A list of commands to create/update :class:`stock.move.line`
      :rtype: list
   * @param lotNames 
   * @param originMoveLine 
   * @returns 
   */
  async _generateSerialMoveLineCommands(lotNames, originMoveLine?: any) {
    this.ensureOne();
    const [productId, productPackagingId, pickingId, pickingTypeId, moveLineIds, moveLineNosuggestIds, locationId, locationDestId] = await this('productId', 'productPackagingId', 'pickingId', 'pickingTypeId', 'moveLineIds', 'moveLineNosuggestIds', 'locationId', 'locationDestId');
    // Select the right move lines depending of the picking type configuration.
    let moveLines = this.env.items('stock.move.line');
    if (await pickingTypeId.showReserved) {
      moveLines = await moveLineIds.filtered(async (ml) => !bool(await ml.lotId) && !await ml.lotName);
    }
    else {
      moveLines = await moveLineNosuggestIds.filtered(async (ml) => !bool(await ml.lotId) && !await ml.lotName);
    }

    let locationDest;
    if (bool(originMoveLine)) {
      locationDest = await originMoveLine.locationDestId;
    }
    else {
      locationDest = await locationDestId._getPutawayStrategy(productId, { quantity: 1, packaging: productPackagingId })
    }
    const moveLineVals = {
      'pickingId': pickingId.id,
      'locationDestId': locationDest.id,
      'locationId': locationId.id,
      'productId': productId.id,
      'productUomId': (await productId.uomId).id,
      'qtyDone': 1,
    }
    if (bool(originMoveLine)) {
      // `ownerId` and `packageId` are taken only in the case we create
      // new move lines from an existing move line. Also, updates the
      // `qtyDone` because it could be usefull for products tracked by lot.
      setOptions(moveLineVals, {
        'ownerId': (await originMoveLine.ownerId).id,
        'packageId': (await originMoveLine.packageId).id,
        'qtyDone': await originMoveLine.qtyDone ?? 1,
      })
    }

    const moveLinesCommands = [];
    for (const lotName of lotNames) {
      // We write the lot name on an existing move line (if we have still one)...
      if (bool(moveLines)) {
        moveLinesCommands.push([1, moveLines(0).id, {
          'lotName': lotName,
          'qtyDone': 1,
        }])
        moveLines = moveLines.slice(1);
      }
      // ... or create a new move line with the serial name.
      else {
        const moveLineCmd = Object.assign({}, moveLineVals, { lotName: lotName });
        moveLinesCommands.push([0, 0, moveLineCmd]);
      }
    }
    return moveLinesCommands;
  }

  /**
   * return create values for new picking that will be linked with group of moves in self.
   * @returns 
   */
  async _getNewPickingValues() {
    let origins = await (await this.filtered(async (m) => await m.origin)).mapped('origin');
    origins = Object.keys(origins); // create a list of unique items
    // Will display source document if any, when multiple different origins are found display a maximum of 5
    let origin
    if (origins.length == 0) {
      origin = false;
    }
    else {
      origin = origins.slice(0, 5).join(',');
      if (origins.length > 5) {
        origin += "...";
      }
    }
    const partners = await this.mapped('partnerId');
    const partner = len(partners) == 1 && bool(partners.id) && partners.id || false;
    return {
      'origin': origin,
      'companyId': (await this.mapped('companyId')).id,
      'userId': false,
      'moveType': await (await this.mapped('groupId')).moveType || 'direct',
      'partnerId': partner,
      'pickingTypeId': (await this.mapped('pickingTypeId')).id,
      'locationId': (await this.mapped('locationId')).id,
      'locationDestId': (await this.mapped('locationDestId')).id,
    }
  }

  async _shouldBeAssigned() {
    this.ensureOne();
    return !(await this['pickingId']).ok && (await this['pickingTypeId']).ok;
  }

  /**
   * Confirms stock move or put it in waiting if it's linked to another move.
      :param: merge: According to this boolean, a newly confirmed move will be merged
      in another move of the same picking sharing its characteristics.
   * @param merge 
   * @param mergeInto 
   * @returns 
   */
  async _actionConfirm(merge = true, mergeInto: any = false) {
    // Use OrderedSet of id (instead of recordset + |= ) for performance 
    let moveCreateProc, moveToConfirm, moveWaiting;
    [moveCreateProc, moveToConfirm, moveWaiting] = [new OrderedSet2(), new OrderedSet2(), new OrderedSet2()];
    const toAssign = new DefaultDict();//OrderedSet);
    for (const move of this) {
      if (await move.state !== 'draft') {
        continue;
      }
      // if the move is preceded, then it's waiting (if preceding move is done, then actionAssign has been called already and its state is already available)
      if ((await move.moveOrigIds).ok) {
        moveWaiting.add(move.id);
      }
      else {
        if (await move.procureMethod === 'makeToOrder') {
          moveCreateProc.add(move.id);
        }
        else {
          moveToConfirm.add(move.id);
        }
      }
      if (await move._shouldBeAssigned()) {
        const key = [(await move.groupId).id, (await move.locationId).id, (await move.locationDestId).id].join(',')
        toAssign[key] = toAssign[key] ?? new OrderedSet2();
        toAssign[key].add(move.id)
      }
    }

    [moveCreateProc, moveToConfirm, moveWaiting] = [this.browse(moveCreateProc), this.browse(moveToConfirm), this.browse(moveWaiting)];

    // create procurements for make to order moves
    const procurementRequests = [];
    for (const move of moveCreateProc) {
      const values = await move._prepareProcurementValues();
      origin = await move._prepareProcurementOrigin()
      procurementRequests.push(await this.env.items('procurement.group').Procurement(
        await move.productId, await move.productUomQty, await move.productUom, await move.locationId, bool(await move.ruleId) && await (await move.ruleId).label || "/",
        origin, await move.companyId, values))
    }
    await this.env.items('procurement.group').run(procurementRequests, !this.env.context['fromOrderpoint']);

    await moveToConfirm.write({ 'state': 'confirmed' });
    await moveWaiting.or(moveCreateProc).write({ 'state': 'waiting' });
    // procure_method sometimes changes with certain workflows so just in case, apply to all moves
    await (await moveToConfirm.or(moveWaiting).or(moveCreateProc).filtered(async (m) => await (await m.pickingTypeId).reservationMethod === 'atConfirm')).write({ 'reservationDate': _Date.today() });

    // assign picking in batch for all confirmed move that share the same details
    for (const movesIds of toAssign.values()) {
      await (await this.browse(movesIds).withContext(cleanContext(this.env.context)))._assignPicking();
    }
    const newPushMoves = await (await this.filtered(async (m) => ! await (await m.pickingId).immediateTransfer))._pushApply();
    await this._checkCompany();
    let moves = this;
    if (merge) {
      moves = await this._mergeMoves(mergeInto);
    }
    // Transform remaining move in return in case of negative initial demand
    const negRMoves = await moves.filtered(async (move) => floatCompare(await move.productUomQty, 0, { precisionRounding: await (await move.productUom).rounding }) < 0);
    for (const move of negRMoves) {
      // const promise = [];
      const locationId = await move.locationId;
      await move.set('locationId', await move.locationDestId);
      await move.set('locationDestId', locationId);
      await move.set('productUomQty', await move.productUomQty * -1);
      if ((await (await move.pickingTypeId).returnPickingTypeId).ok) {
        await move.set('pickingTypeId', await (await move.pickingTypeId).returnPickingTypeId);
      }
      // await Promise.all(promise);
    }
    // detach their picking as we inverted the location and potentially picking type
    await negRMoves.set('pickingId', false);
    await negRMoves._assignPicking();

    // call `_action_assign` on every confirmed move which locationId bypasses the reservation + those expected to be auto-assigned
    await (await moves.filtered(async (move) => ! await (await move.pickingId).immediateTransfer && ['confirmed', 'partiallyAvailable'].includes(await move.state) && (await move._shouldBypassReservation() || await (await move.pickingTypeId).reservationMethod === 'atConfirm' || (await move.reservationDate && await move.reservationDate <= _Date.today()))))._actionAssign();
    if (bool(newPushMoves)) {
      await newPushMoves._actionConfirm();
    }
    return moves;
  }

  async _prepareProcurementOrigin() {
    this.ensureOne();
    return bool(await this['groupId']) && await (await this['groupId']).label || (bool(await this['origin']) || await (await this['pickingId']).label || "/");
  }

  /**
   * Prepare specific key for moves or other componenets that will be created from a stock rule comming from a stock move. This method could be override in order to add other custom key that could be used in move/po creation.
   * @returns 
   */
  async _prepareProcurementValues() {
    this.ensureOne();
    let [ruleId, groupId, descriptionPicking, pickingTypeId, date, dateDeadline, routeIds, warehouseId, priority, orderpointId, productPackagingId] = await this('ruleId', 'groupId', 'descriptionPicking', 'pickingTypeId', 'date', 'dateDeadline', 'routeIds', 'warehouseId', 'priority', 'orderpointId', 'productPackagingId');
    groupId = bool(groupId) ? groupId : false;
    if (bool(ruleId)) {
      if (await ruleId.groupPropagationOption === 'fixed' && await ruleId['groupId']) {
        groupId = await ruleId['groupId'];
      }
      else if (await ruleId.groupPropagationOption === 'none') {
        groupId = false;
      }
    }
    const productId = await (await this['productId']).withContext({ lang: await (this as any)._getLang() });
    return {
      'productDescriptionVariants': descriptionPicking && descriptionPicking.replace(await productId._getDescription(pickingTypeId), ''),
      'datePlanned': date,
      'dateDeadline': dateDeadline,
      'moveDestIds': this,
      'groupId': groupId,
      'routeIds': routeIds,
      'warehouseId': warehouseId || await pickingTypeId.warehouseId,
      'priority': priority,
      'orderpointId': orderpointId,
      'productPackagingId': productPackagingId,
    }
  }

  async _prepareMoveLineVals(quantity?: any, reservedQuant?: any) {
    this.ensureOne();
    // apply putaway
    const [productId, productUom, locationId, pickingId, companyId] = await this('productId', 'productUom', 'locationId', 'pickingId', 'companyId');
    const locationDestId = (await (await this['locationDestId'])._getPutawayStrategy(productId, { quantity: quantity || 0, packaging: await this['productPackagingId'] })).id;
    let vals = {
      'moveId': this.id,
      'productId': productId.id,
      'productUomId': productUom.id,
      'locationId': locationId.id,
      'locationDestId': locationDestId,
      'pickingId': pickingId.id,
      'companyId': companyId.id,
    }
    if (quantity) {
      const rounding = await this.env.items('decimal.precision').precisionGet('Product Unit of Measure');
      let uomQuantity = await (await productId.uomId)._computeQuantity(quantity, productUom, { roundingMethod: 'HALF-UP' });
      uomQuantity = floatRound(uomQuantity, { precisionDigits: rounding });
      const uomQuantityBackToProductUom = await productUom._computeQuantity(uomQuantity, await productId.uomId, { roundingMethod: 'HALF-UP' });
      if (floatCompare(quantity, uomQuantityBackToProductUom, { precisionDigits: rounding }) == 0) {
        vals = Object.assign(vals, { productUomQty: uomQuantity });
      }
      else {
        vals = Object.assign(vals, { productUomQty: quantity, productUomId: (await productId.uomId).id });
      }
    }
    if (bool(reservedQuant)) {
      const [locationId, lotId, packageId, ownerId] = await reservedQuant('locationId', 'lotId', 'packageId', 'ownerId');
      vals = Object.assign(vals, {
        locationId: locationId.id,
        lotId: lotId.id || false,
        packageId: packageId.id || false,
        ownerId: ownerId.id || false,
      });
    }
    return vals;
  }

  /**
   * Create or update move lines.
   * @param need 
   * @param availableQuantity 
   * @param locationId 
   * @param options 
   */
  async _updateReservedQuantity(need, availableQuantity, locationId, options: { lotId?: any, packageId?: any, ownerId?: any, strict?: boolean } = {}) {
    const strict = options.strict ?? true;
    this.ensureOne();
    let lotId = options.lotId;
    if (!bool(lotId)) {
      lotId = this.env.items('stock.production.lot');
    }
    let packageId = options.packageId;
    if (!bool(packageId)) {
      packageId = this.env.items('stock.quant.package');
    }
    let ownerId = options.ownerId;
    if (!bool(ownerId)) {
      ownerId = this.env.items('res.partner');
    }

    const [productId, productPackagingId, productUom, moveLineIds] = await this('productId', 'productPackagingId', 'productUom', 'moveLineIds');
    // do full packaging reservation when it's needed
    if (productPackagingId.ok && productId.productTemplateId.categId.packagingReserveMethod === "full") {
      availableQuantity = await productPackagingId._checkQty(availableQuantity, await productId.uomId, "DOWN");
    }

    let takenQuantity = Math.min(availableQuantity, need);

    // `taken_quantity` is in the quants unit of measure. There's a possibility that the move's
    // unit of measure won't be respected if we blindly reserve this quantity, a common usecase
    // is if the move's unit of measure's rounding does not allow fractional reservation. We chose
    // to convert `taken_quantity` to the move's unit of measure with a down rounding method and
    // then get it back in the quants unit of measure with an half-up roundingMethod. This
    // way, we'll never reserve more than allowed. We do not apply this logic if
    // `available_quantity` is brought by a chained move line. In this case, `_prepare_move_line_vals`
    // will take care of changing the UOM to the UOM of the product.
    const uomId = await productId.uomId;
    if (!strict && !uomId.eq(productUom)) {
      const takenQuantityMoveUom = await uomId._computeQuantity(takenQuantity, productUom, { roundingMethod: 'DOWN' });
      takenQuantity = await productUom._computeQuantity(takenQuantityMoveUom, uomId, { roundingMethod: 'HALF-UP' });
    }

    let quants = [];
    const rounding = await this.env.items('decimal.precision').precisionGet('Product Unit of Measure');

    if (await productId.tracking === 'serial') {
      if (floatCompare(takenQuantity, tools.parseInt(takenQuantity), { precisionDigits: rounding }) != 0) {
        takenQuantity = 0;
      }
    }
    try {
      await this.env.cr.savepoint(async () => {
        if (!floatIsZero(takenQuantity, { precisionRounding: await uomId.rounding })) {
          quants = await this.env.items('stock.quant')._updateReservedQuantity(
            productId, locationId, takenQuantity, {
              lotId: lotId, packageId: packageId, ownerId: ownerId, strict: strict
          });
        }
      });
    } catch (e) {
      if (isInstance(e, UserError)) {
        takenQuantity = 0;
      } else {
        throw e;
      }
    }
    // Find a candidate move line to update or create a new one.
    for (const [reservedQuant, quantity] of quants) {
      const toUpdate = await moveLineIds.filtered(async (ml) => ml._reservationIsUpdatable(quantity, reservedQuant));
      let uomQuantity, uomQuantityBackToProductUom;
      if (toUpdate.ok) {
        uomQuantity = await uomId._computeQuantity(quantity, await toUpdate[0].productUomId, { roundingMethod: 'HALF-UP' });
        uomQuantity = floatRound(uomQuantity, { precisionDigits: rounding });
        uomQuantityBackToProductUom = await toUpdate[0].productUomId._computeQuantity(uomQuantity, productId.uomId, { roundingMethod: 'HALF-UP' });
      }
      if (toUpdate.ok && floatCompare(quantity, uomQuantityBackToProductUom, { precisionDigits: rounding }) == 0) {
        const toUpdate0 = await toUpdate[0].withContext({ bypassReservationUpdate: true });
        await toUpdate0.set('productUomQty', await toUpdate0.productUomQty + uomQuantity);
      }
      else {
        if (await productId.tracking === 'serial') {
          for (const i of range(0, tools.parseInt(quantity))) {
            await this.env.items('stock.move.line').create(await this._prepareMoveLineVals(1, reservedQuant));
          }
        }
        else {
          await this.env.items('stock.move.line').create(await this._prepareMoveLineVals(quantity, reservedQuant));
        }
      }
    }

    return takenQuantity;
  }

  async _shouldBypassReservation(forcedLocation?: any) {
    this.ensureOne();
    const location = bool(forcedLocation) ? forcedLocation : await this['locationId'];
    return await location.shouldBypassReservation() || await (await this['productId']).type !== 'product';
  }

  // necessary hook to be able to override move reservation to a restrict lot, owner, pack, location...
  async _getAvailableQuantity(locationId, options: { lotId?: any, packageId?: any, ownerId?: any, strict?: boolean, allowNegative?: boolean } = {}) {
    this.ensureOne();
    if (await locationId.shouldBypassReservation()) {
      return this['productQty'];
    }
    return this.env.items('stock.quant')._getAvailableQuantity(await this['productId'], locationId, options);
  }

  /**
   * Reserve stock moves by creating their stock move lines. A stock move is
            considered reserved once the sum of `productQty` for all its move lines is
            equal to its `productQty`. If it is less, the stock move is considered
            partially available.
   * @returns 
  */
  async _getAvailableMoveLinesIn() {
    const keys = ['locationDestId', 'lotId', 'resultPackageId', 'ownerId'];
    async function keysInGroupby(ml) {
      return ml(...keys);
    }
    async function keysInSorted(ml) {
      return (await keysInGroupby(ml)).map(key => key.id);
    }

    const moveLinesIn = await (await (await this['moveOrigIds']).filtered(async (m) => await m.state === 'done')).mapped('moveLineIds');

    const groupedMoveLinesIn = new Map();
    for (const [k, g] of await groupbyAsync(await sortedAsync(moveLinesIn, keysInSorted), keysInGroupby, keysInSorted)) {
      let qtyDone = 0;
      for (const ml of g) {
        const [mlProductUom, mlQtyDone, mlProduct] = await ml('productUomId', 'qtyDone', 'productId');
        qtyDone += await mlProductUom._computeQuantity(mlQtyDone, await mlProduct.uomId);
      }
      groupedMoveLinesIn.set(k, qtyDone);
    }
    return groupedMoveLinesIn;
  }

  async _getAvailableMoveLinesOut(assignedMovesIds, partiallyAvailableMovesIds) {
    const moveOrigIds = await this['moveOrigIds'];
    const moveLinesOutDone = await (await (await moveOrigIds.mapped('moveDestIds')).sub(this)
      .filtered(async (m) => await m.state === 'done'))
      .mapped('moveLineIds');
    // As we defer the write on the stock.move's state at the end of the loop, there
    // could be moves to consider in what our siblings already took.
    const stockMove = this.env.items('stock.move');
    const movesOutSiblings = (await moveOrigIds.mapped('moveDestIds')).sub(this);
    const movesOutSiblingsToConsider = movesOutSiblings.and(stockMove.browse(assignedMovesIds).add(stockMove.browse(partiallyAvailableMovesIds)));
    const reservedMovesOutSiblings = await movesOutSiblings.filtered(async (m) => ['partiallyAvailable', 'assigned'].includes(await m.state));
    const moveLinesOutReserved = await reservedMovesOutSiblings.or(movesOutSiblingsToConsider).mapped('moveLineIds');

    const keys = ['locationId', 'lotId', 'packageId', 'ownerId'];
    async function keysInGroupby(ml) {
      return ml(...keys);
    }
    async function keysOutSorted(ml) {
      return (await keysInGroupby(ml)).map(key => key.id);
    }

    const groupedMoveLinesOut = new Map();
    for (const [k, g] of await groupbyAsync(await sortedAsync(moveLinesOutDone, keysOutSorted), keysInGroupby, keysOutSorted)) {
      let qtyDone = 0;
      for (const ml of g) {
        const [mlProductUom, mlQtyDone, mlProduct] = await ml('productUom', 'qtyDone', 'product');
        qtyDone += await mlProductUom._computeQuantity(mlQtyDone, await mlProduct.uomId);
      }
      groupedMoveLinesOut.set(k, qtyDone);
    }

    for (const [k, g] of await groupbyAsync(await sortedAsync(moveLinesOutReserved, keysOutSorted), keysInGroupby, keysOutSorted)) {
      groupedMoveLinesOut.set(k, sum(await this.env.items('stock.move.line').concat(g).mapped('productQty')));
    }
    return groupedMoveLinesOut;
  }

  async _getAvailableMoveLines(assignedMovesIds, partiallyAvailableMovesIds) {
    const groupedMoveLinesIn = await this._getAvailableMoveLinesIn();
    const groupedMoveLinesOut = await this._getAvailableMoveLinesOut(assignedMovesIds, partiallyAvailableMovesIds);
    const availableMoveLines = new MapKey(item => item.map(o => o.id));
    for (const key of groupedMoveLinesIn.keys()) {
      const val = groupedMoveLinesIn.get(key) - (groupedMoveLinesOut.get(key) ?? 0);
      if (val) {
        availableMoveLines.set(key, val);
      }
    }
    // pop key if the quantity available amount to 0
    const rounding = await (await (await this['productId']).uomId).rounding;
    return MapKey.fromEntries(Array.from(availableMoveLines.entries()).filter(([k, v]) => floatCompare(v, 0, { precisionRounding: rounding }) > 0), item => item.map(o => o.id));
  }

  /**
   * Reserve stock moves by creating their stock move lines. A stock move is
  considered reserved once the sum of `productQty` for all its move lines is
  equal to its `productQty`. If it is less, the stock move is considered
  partially available.
   * @returns 
   */
  async _actionAssign() {
    const stockMove = this.env.items('stock.move');
    const assignedMovesIds = new OrderedSet2();
    const partiallyAvailableMovesIds = new OrderedSet2();
    // Read the `reservedAvailability` field of the moves out of the loop to prevent unwanted
    // cache invalidation when actually reserving the move.
    const reservedAvailability = new MapKey();
    const roundings = new MapKey();
    for (const move of this) {
      reservedAvailability.set(move, await move.reservedAvailability);
      roundings.set(move, await (await (await move.productId).uomId).rounding);
    }
    const moveLineValsList = [];
    for (const move of await this.filtered(async (m) => ['confirmed', 'waiting', 'partiallyAvailable'].includes(await m.state))) {
      const [productId, productUom, productUomQty, moveOrigIds] = await move('productId', 'productUom', 'productUomQty', 'moveOrigIds');
      const rounding = roundings.get(move);
      const missingReservedUomQuantity = productUomQty - reservedAvailability.get(move);
      let missingReservedQuantity = await productUom._computeQuantity(missingReservedUomQuantity, await productId.uomId, { roundingMethod: 'HALF-UP' });
      if (await move._shouldBypassReservation()) {
        // create the move line(s) but do not impact quants
        if (bool(moveOrigIds)) {
          const availableMoveLines = await move._getAvailableMoveLines();
          for (const [[locationId, lotId, packageId, ownerId], quantity] of availableMoveLines) {
            const qtyAdded = Math.min(missingReservedQuantity, quantity);
            const moveLineVals = await move._prepareMoveLineVals(qtyAdded);
            update(moveLineVals, {
              'locationId': locationId.id,
              'lotId': lotId.id,
              'lotName': await lotId.label,
              'ownerId': ownerId.id,
            })
            moveLineValsList.push(moveLineVals);
            missingReservedQuantity -= qtyAdded;
            if (floatIsZero(missingReservedQuantity, { precisionRounding: move.productId.uomId.rounding })) {
              break;
            }
          }
        }
        if (missingReservedQuantity && move.productId.tracking === 'serial' && (move.pickingTypeId.useCreateLots || move.pickingTypeId.useExistingLots)) {
          for (const i of range(0, tools.parseInt(missingReservedQuantity))) {
            moveLineValsList.push(await move._prepareMoveLineVals(1));
          }
        }
        else if (missingReservedQuantity) {
          const toUpdate = await (await move.moveLineIds).filtered(async (ml) =>
            (await ml.productUomId).eq(await move.productUom) &&
            (await ml.locationId).eq(await move.locationId) &&
            (await ml.locationDestId).eq(await move.locationDestId) &&
            (await ml.pickingId).eq(await move.pickingId) &&
            !(await ml.lotId).ok &&
            !(await ml.packageId).ok &&
            !(await ml.ownerId).ok)
          if (toUpdate.ok) {
            const toUpdate0 = toUpdate[0];
            await toUpdate0.set('productUomQty', await toUpdate0.productUomQty + (await await (await move.productId).uomId)._computeQuantity(missingReservedQuantity, await move.productUom, { roundingMethod: 'HALF-UP' }));
          }
          else {
            moveLineValsList.push(await move._prepareMoveLineVals(missingReservedQuantity));
          }
        }
        assignedMovesIds.add(move.id);
      }
      else {
        if (floatIsZero(await move.productUomQty, { precisionRounding: await (await move.productUom).rounding })) {
          assignedMovesIds.add(move.id);
        }
        else if (!(await move.moveOrigIds).ok) {
          if (await move.procureMethod === 'makeToOrder') {
            continue;
          }
          // If we don't need any quantity, consider the move assigned.
          let need = missingReservedQuantity;
          if (floatIsZero(need, { precisionRounding: rounding })) {
            assignedMovesIds.add(move.id);
            continue;
          }
          // Reserve new quants and create move lines accordingly.
          let forcedPackageId = await (await move.packageLevelId).packageId;
          forcedPackageId = forcedPackageId.ok ? forcedPackageId : null;
          const availableQuantity = await move._getAvailableQuantity(await move.locationId, { packageId: forcedPackageId });
          if (availableQuantity <= 0) {
            continue;
          }
          const takenQuantity = await move._updateReservedQuantity(need, availableQuantity, await move.locationId, { packageId: forcedPackageId, strict: false });
          if (floatIsZero(takenQuantity, { precisionRounding: rounding })) {
            continue;
          }
          if (floatCompare(need, takenQuantity, { precisionRounding: rounding }) == 0) {
            assignedMovesIds.add(move.id);
          }
          else {
            partiallyAvailableMovesIds.add(move.id);
          }
        }
        else {
          // Check what our parents brought and what our siblings took in order to
          // determine what we can distribute.
          // `qty_done` is in `ml.productUomId` and, as we will later increase
          // the reserved quantity on the quants, convert it here in
          // `productId.uomId` (the UOM of the quants is the UOM of the product).
          const availableMoveLines = await move._getAvailableMoveLines();
          if (!len(availableMoveLines)) {
            continue;
          }
          for (const moveLine of await (await move.moveLineIds).filtered(async (m) => await m.productQty)) {
            const key = await moveLine('locationId', 'lotId', 'resultPackageId', 'ownerId');
            const val = availableMoveLines.get(key);
            if (val != null) {
              availableMoveLines.set(key, val - await moveLine.productQty);
            }
          }
          for (const [[locationId, lotId, packageId, ownerId], quantity] of availableMoveLines.items()) {
            const need = await move.productQty - sum(await (await move.moveLineIds).mapped('productQty'));
            // `quantity` is what is brought by chained done move lines. We double check
            // here this quantity is available on the quants themselves. If not, this
            // could be the result of an inventory adjustment that removed totally of
            // partially `quantity`. When this happens, we chose to reserve the maximum
            // still available. This situation could not happen on MTS move, because in
            // this case `quantity` is directly the quantity on the quants themselves.
            const availableQuantity = await move._getAvailableQuantity(locationId, { lotId, packageId, ownerId, strict: true });
            if (floatIsZero(availableQuantity, { precisionRounding: rounding })) {
              continue;
            }
            const takenQuantity = await move._updateReservedQuantity(need, Math.min(quantity, availableQuantity), locationId, { lotId, packageId, ownerId });
            if (floatIsZero(takenQuantity, { precisionRounding: rounding })) {
              continue;
            }
            if (floatIsZero(need - takenQuantity, { precisionRounding: rounding })) {
              assignedMovesIds.add(move.id);
              break;
            }
            partiallyAvailableMovesIds.add(move.id);
          }
        }
      }
      if (await (await move.productId).tracking === 'serial') {
        await move.set('nextSerialCount', await move.productUomQty);
      }
    }

    await this.env.items('stock.move.line').create(moveLineValsList);
    await stockMove.browse(partiallyAvailableMovesIds).write({ 'state': 'partiallyAvailable' });
    await stockMove.browse(assignedMovesIds).write({ 'state': 'assigned' });
    if (this.env.context['bypassEntirePack']) {
      return;
    }
    await (await this.mapped('pickingId'))._checkEntirePack();
  }

  async _actionCancel() {
    if (await this.some(async (move) => await move.state === 'done' && ! await move.scrapped)) {
      throw new UserError(await this._t('You cannot cancel a stock move that has been set to \'Done\'. Create a return in order to reverse the moves which took place.'));
    }
    const movesToCancel = await this.filtered(async (m) => await m.state !== 'cancel');
    // self cannot contain moves that are either cancelled or done, therefore we can safely
    // unlink all associated move_line_ids
    await movesToCancel._doUnreserve();

    for (const move of movesToCancel) {
      const moveDestIds = await move.moveDestIds;
      const siblingsStates = await (await moveDestIds.mapped('moveOrigIds')).sub(move).mapped('state');
      if (await move.propagateCancel) {
        // only cancel the next move if all my siblings are also cancelled
        if (siblingsStates.every(state => state === 'cancel')) {
          await (await moveDestIds.filtered(async (m) => await m.state !== 'done'))._actionCancel();
        }
      }
      else {
        if (siblingsStates.every(state => ['done', 'cancel'].includes(state))) {
          await moveDestIds.write({ 'procureMethod': 'makeToStock' });
          await moveDestIds.write({ 'moveOrigIds': [[3, move.id, 0]] });
        }
      }
    }
    await this.write({
      'state': 'cancel',
      'moveOrigIds': [[5, 0, 0]],
      'procureMethod': 'makeToStock',
    })
    return true;
  }

  async _prepareExtraMoveVals(qty) {
    const vals = {
      'procureMethod': 'makeToStock',
      'originReturnedMoveId': (await this['originReturnedMoveId']).id,
      'productUomQty': qty,
      'pickingId': (await this['pickingId']).id,
      'priceUnit': await this['priceUnit'],
    }
    return vals;
  }

  /**
   * If the quantity done on a move exceeds its quantity todo, this method will create an
      extra move attached to a (potentially split) move line. If the previous condition is not
      met, it'll return an empty recordset.
 
      The rationale for the creation of an extra move is the application of a potential push
      rule that will handle the extra quantities.
   */
  async _createExtraMove() {
    let extraMove = this;
    const [productUom, productUomQty, quantityDone] = await await this('productUom', 'productUomQty', 'quantityDone');
    const rounding = await productUom.rounding;
    // moves created after the picking is assigned do not have `productUomQty`, but we shouldn't create extra moves for them
    if (floatCompare(quantityDone, productUomQty, { precisionRounding: rounding }) > 0) {
      // create the extra moves
      const extraMoveQuantity = floatRound(
        quantityDone - productUomQty,
        {
          precisionRounding: rounding,
          roundingMethod: 'HALF-UP'
        });
      const extraMoveVals = await this._prepareExtraMoveVals(extraMoveQuantity);
      extraMove = await this.copy(extraMoveVals);

      let mergeIntoSelf = true;
      for (const field of this._prepareMergeMovesDistinctFields()) {
        if (!equal(await this[field], await extraMove[field])) {
          mergeIntoSelf = false;
          break;
        }
      }
      if (mergeIntoSelf) {
        extraMove = await extraMove._actionConfirm(true, this);
        return extraMove;
      }
      else {
        extraMove = await extraMove._actionConfirm();
      }
    }
    return extraMove.or(this);
  }

  async _actionDone(cancelBackorder = false) {
    await (await this.filtered(async (move) => await move.state === 'draft'))._actionConfirm();  // MRP allows scrapping draft moves
    const moves = await (await this.exists()).filtered(async (x) => !['done', 'cancel'].includes(await x.state));
    let movesIdsTodo = [];

    // Cancel moves where necessary ; we should do it before creating the extra moves because
    // this operation could trigger a merge of moves.
    for (const move of moves) {
      if (await move.quantityDone <= 0 && ! await move.isInventory) {
        if (floatCompare(await move.productUomQty, 0.0, { precisionRounding: await (await move.productUom).rounding }) == 0 || cancelBackorder) {
          await move._actionCancel();
        }
      }
    }
    // Create extra moves where necessary
    for (const move of moves) {
      if (await move.state === 'cancel' || (await move.quantityDone <= 0 && ! await move.isInventory)) {
        continue;
      }

      movesIdsTodo = _.union(movesIdsTodo, (await move._createExtraMove()).ids);
    }
    const movesTodo = this.browse(movesIdsTodo);
    await movesTodo._checkCompany();
    // Split moves where necessary and move quants
    const backorderMovesVals = [];
    for (const move of movesTodo) {
      // To know whether we need to create a backorder or not, round to the general product's
      // decimal precision and not the product's UOM.
      const rounding = await this.env.items('decimal.precision').precisionGet('Product Unit of Measure');
      if (floatCompare(await move.quantityDone, await move.productUomQty, { precisionDigits: rounding }) < 0) {
        // Need to do some kind of conversion here
        const qtySplit = await (await move.productUom)._computeQuantity(await move.productUomQty - await move.quantityDone, move.productId.uomId, { roundingMethod: 'HALF-UP' });
        const newMoveVals = await move._split(qtySplit);
        extend(backorderMovesVals, newMoveVals);
      }
    }
    const backorderMoves = await this.env.items('stock.move').create(backorderMovesVals);
    // The backorder moves are not yet in their own picking. We do not want to check entire packs for those
    // ones as it could messed up the result_package_id of the moves being currently validated
    await (await backorderMoves.withContext({ bypassEntirePack: true }))._actionConfirm(false);
    if (cancelBackorder) {
      await (await backorderMoves.withContext({ movesTodo }))._actionCancel();
    }
    await (await (await movesTodo.mapped('moveLineIds')).sorted())._actionDone();
    // Check the consistency of the result packages; there should be an unique location across
    // the contained quants.
    for (const resultPackage of await (await movesTodo.mapped('moveLineIds.resultPackageId')).filtered(async (p) => bool(await p.quantIds) && len(await p.quantIds) > 1)) {
      if (len(await (await (await resultPackage.quantIds).filtered(async (q) => !floatIsZero(Math.abs(await q.quantity) + Math.abs(await q.reservedQuantity), { precisionRounding: await (await q.productUomId).rounding }))).mapped('locationId')) > 1) {
        throw new UserError(await this._t('You cannot move the same package content more than once in the same transfer or split the same package into two location.'));
      }
    }
    const picking = await movesTodo.mapped('pickingId');
    await movesTodo.write({ 'state': 'done', 'date': _Datetime.now() });

    const newPushMoves = await (await movesTodo.filtered(async (m) => await (await m.pickingId).immediateTransfer))._pushApply();
    if (bool(newPushMoves)) {
      await newPushMoves._actionConfirm();
    }
    const moveDestsPerCompany = new DefaultDict2(() => this.env.items('stock.move'));
    for (const moveDest of await movesTodo.moveDestIds) {
      moveDestsPerCompany[(await moveDest.companyId).id].or(moveDest);
    }
    for (const [companyId, moveDests] of moveDestsPerCompany) {
      await (await (await moveDests.sudo()).withCompany(companyId))._actionAssign();
    }
    // We don't want to create back order for scrap moves
    // Replace by a kwarg in master
    if (this.env.context['isScrap']) {
      return movesTodo;
    }

    if (bool(picking) && !cancelBackorder) {
      const backorder = await picking._createBackorder();
      if (await (await backorder.moveLines).some(async (m) => await m.state === 'assigned')) {
        await backorder._checkEntirePack();
      }
    }
    return movesTodo;
  }

  @api.ondelete(false)
  async _unlinkIfDraftOrCancel() {
    if (await this.some(async (move) => !['draft', 'cancel'].includes(await move.state))) {
      throw new UserError(await this._t('You can only delete draft moves.'));
    }
  }

  async unlink() {
    // With the non plannified picking, draft moves could have some move lines.
    await (await (await this.withContext({ prefetchFields: false })).mapped('moveLineIds')).unlink();
    return _super(StockMove, this).unlink();
  }

  async _prepareMoveSplitVals(qty) {
    const vals = {
      'productUomQty': qty,
      'procureMethod': 'makeToStock',
      'moveDestIds': await (await (await this['moveDestIds']).filter(async (x) => !['done', 'cancel'].includes(await x.state))).map(x => [4, x.id]),
      'moveOrigIds': await (await this['moveOrigIds']).map(x => [4, x.id]),
      'originReturnedMoveId': (await this['originReturnedMoveId']).id,
      'priceUnit': await this['priceUnit'],
    }
    if (this.env.context['forceSplitUomId']) {
      vals['productUom'] = this.env.context['forceSplitUomId'];
    }
    return vals;
  }

  /**
   * Splits `self` quantity and return values for a new moves to be created afterwards
 
      :param qty: float. quantity to split (given in product UoM)
      :param restrictPartnerId: optional partner that can be given in order to force the new move to restrict its choice of quants to the ones belonging to this partner.
      :returns: list of dict. stock move values
   * @param qty 
   * @param restrictPartnerId 
   * @returns 
   */
  async _split(qty, restrictPartnerId = false) {
    this.ensureOne();
    if (['done', 'cancel'].includes(await this['state'])) {
      throw new UserError(await this._t("You cannot split a stock move that has been set to 'Done'."));
    }
    else if (await this['state'] === 'draft') {
      // we restrict the split of a draft move because if not confirmed yet, it may be replaced by several other moves in
      // case of phantom bom (with mrp module). And we don't want to deal with this complexity by copying the product that will explode.
      throw new UserError(await this._t('You cannot split a draft move. It needs to be confirmed first.'));
    }
    const [product, productQty] = await this('productId', 'productQty');
    if (floatIsZero(qty, { precisionRounding: await (await product.uomId).rounding }) || productQty <= qty) {
      return [];
    }

    const decimalPrecision = await this.env.items('decimal.precision').precisionGet('Product Unit of Measure');

    // `qty` passed as argument is the quantity to backorder and is always expressed in the
    // quants UOM. If we're able to convert back and forth this quantity in the move's and the
    // quants UOM, the backordered move can keep the UOM of the move. Else, we'll create is in
    // the UOM of the quants.
    const [productUom] = await this('productUom');
    const uomQty = await (await product.uomId)._computeQuantity(qty, productUom, { roundingMethod: 'HALF-UP' });
    let defaults;
    if (floatCompare(qty, await productUom._computeQuantity(uomQty, await product.uomId, { roundingMethod: 'HALF-UP' }), { precisionDigits: decimalPrecision }) == 0) {
      defaults = await this._prepareMoveSplitVals(uomQty);
    }
    else {
      defaults = await (await this.withContext({ forceSplitUomId: (await product.uomId).id }))._prepareMoveSplitVals(qty);
    }

    if (bool(restrictPartnerId)) {
      defaults['restrictPartnerId'] = restrictPartnerId;
    }
    // TDE CLEANME: remove context key + add as parameter
    if (this.env.context['sourceLocationId']) {
      defaults['locationId'] = this.env.context['sourceLocationId'];
    }
    const newMoveVals = await this.copyData(defaults);

    // Update the original `productQty` of the move. Use the general product's decimal
    // precision and not the move's UOM to handle case where the `quantity_done` is not
    // compatible with the move's UOM.
    let newProductQty = await (await product.uomId)._computeQuantity(productQty - qty, productUom, { round: false });
    newProductQty = floatRound(newProductQty, { precisionDigits: await this.env.items('decimal.precision').precisionGet('Product Unit of Measure') });
    await (await this.withContext({ doNotUnreserve: true })).write({ 'productUomQty': newProductQty });
    return newMoveVals
  }

  async _recomputeState() {
    const movesStateToWrite = new DefaultDict2(() => new Set());
    for (const move of this) {
      if (['cancel', 'done', 'draft'].includes(await move.state)) {
        continue;
      }
      else if (await move.reservedAvailability === await move.productUomQty) {
        movesStateToWrite['assigned'].add(move.id);
      }
      else if (await move.reservedAvailability && await move.reservedAvailability <= await move.productUomQty) {
        movesStateToWrite['partiallyAvailable'].add(move.id);
      }
      else if (await move.procureMethod == 'makeToOrder' && !bool(await move.moveOrigIds)) {
        movesStateToWrite['waiting'].add(move.id);
      }
      else if (bool(await move.moveOrigIds) && await (await move.moveOrigIds).some(async (orig) => !['done', 'cancel'].includes(await orig.state))) {
        movesStateToWrite['waiting'].add(move.id);
      }
      else {
        movesStateToWrite['confirmed'].add(move.id);
      }
    }
    for (const [state, movesIds] of movesStateToWrite) {
      await this.browse(movesIds).write({ 'state': state });
    }
  }


  @api.model()
  _consumingPickingTypes() {
    return ['outgoing'];
  }

  /**
   * Determine language to use for translated description
   * @returns 
   */
  async _getLang() {
    return await (await (await this['pickingId']).partnerId).lang || await (await this['partnerId']).lang || await (await this.env.user()).lang;
  }

  /**
   * Return the move's document, used by `stock.report.productproductreplenishment`
      and must be overrided to add more document type in the report.
   * @returns 
   */
  async _getSourceDocument() {
    this.ensureOne();
    const pickingId = await this['pickingId'];
    return pickingId.ok ? pickingId : false
  }

  async _getUpstreamDocumentsAndResponsibles(visited: ModelRecords): Promise<[any, any, any][]> {
    const moveOrigIds = await this['moveOrigIds'];
    if (moveOrigIds.ok && await moveOrigIds.some(async (m) => !['done', 'cancel'].includes(await m.state))) {
      const result = {};
      visited = visited.or(this);
      for (const move of moveOrigIds) {
        if (!['done', 'cancel'].includes(await move.state)) {
          let document, responsible;
          for ([document, responsible, visited] of await move._getUpstreamDocumentsAndResponsibles(visited)) {
            const list = [document, responsible, visited];
            const key = `${list}`;
            result[key] = list;
          }
        }
      }
      return Object.values(result);
    }
    else {
      return [];
    }
  }

  async _setQuantityDonePrepareVals(qty: number) {
    const res = [];
    const [productId, moveLineIds, productUom] = await this('productId', 'moveLineIds', 'productUom');
    for (const ml of moveLineIds) {
      const [productUomId, productUomQty, qtyDone] = await ml('productUomId', 'productUomQty', 'qtyDone');
      const rounding = await productUomId.rounding;
      const isDiffUom = !productUomId.eq(productUom);

      let mlQty = productUomQty - qtyDone;
      if (floatCompare(mlQty, 0, { precisionRounding: rounding }) <= 0) {
        continue;
      }
      // Convert move line qty into move uom
      if (isDiffUom) {
        mlQty = await productUomId._computeQuantity(mlQty, productUom, { round: false });
      }
      let takenQty = Math.min(qty, mlQty);
      // Convert taken qty into move line uom
      if (isDiffUom) {
        takenQty = await productUom._computeQuantity(mlQty, productUomId, { round: false });
      }

      // Assign qty_done and explicitly round to make sure there is no inconsistency between
      // ml.qty_done and qty.
      takenQty = floatRound(takenQty, { precisionRounding: rounding });
      res.push([1, ml.id, { 'qtyDone': qtyDone + takenQty }]);
      if (isDiffUom) {
        takenQty = await productUomId._computeQuantity(mlQty, productUom, { round: false });
      }
      qty -= takenQty;

      if (floatCompare(qty, 0.0, { precisionRounding: rounding }) <= 0) {
        break;
      }
    }
    for (const ml of moveLineIds) {
      const [productUomId, productUomQty, qtyDone] = await ml('productUomId', 'productUomQty', 'qtyDone');
      const rounding = await productUomId.rounding;
      if (floatIsZero(productUomQty, { precisionRounding: rounding }) && floatIsZero(qtyDone, { precisionRounding: rounding })) {
        res.push([2, ml.id]);
      }
    }

    if (floatCompare(qty, 0.0, { precisionRounding: await productUom.rounding }) > 0) {
      if (await productId.tracking !== 'serial') {
        const vals = await this._prepareMoveLineVals(0);
        vals['qtyDone'] = qty;
        res.push([0, 0, vals]);
      }
      else {
        const uomId = await productId.uomId;
        const uomQty = await productUom._computeQuantity(qty, uomId);
        for (const i of range(0, tools.parseInt(uomQty))) {
          const vals = await this._prepareMoveLineVals(0);
          vals['qtyDone'] = 1;
          vals['productUomId'] = uomId.id;
          res.push([0, 0, vals]);
        }
      }
    }
    return res;
  }

  /**
   * Set the given quantity as quantity done on the move through the move lines. The method is able to handle move lines with a different UoM than the move (but honestly, this would be looking for trouble...).
          @param qty: quantity in the UoM of move.productUom
   * @param qty 
   */
  async _setQuantityDone(qty) {
    await this.set('moveLineIds', await this._setQuantityDonePrepareVals(qty));
  }

  async _setQuantitiesToReservation() {
    for (const move of this) {
      if (!['partiallyAvailable', 'assigned'].includes(await move.state)) {
        continue;
      }
      for (const moveLine of await move.moveLineIds) {
        if (await move.hasTracking !== 'none' && !((await moveLine.lotId).ok || await moveLine.lotName)) {
          continue;
        }
        await moveLine.set('qtyDone', await moveLine.productUomQty);
      }
    }
  }

  /**
   * This method will try to apply the procure method MTO on some moves if
    a compatible MTO route is found. Else the procure method will be set to MTS
   */
  async _adjustProcureMethod() {
    // Prepare the MTSO variables. They are needed since MTSO moves are handled separately.
    // We need 2 dicts:
    // - needed quantity per location per product
    // - forecasted quantity per location per product
    const mtsoProductsByLocations = new DefaultDict<any, any>();//(list)
    const mtsoNeededQtiesByLoc = new DefaultDict(); //dict)
    const mtsoFreeQtiesByLoc = new Map<any, any>();
    let mtsoMoves = this.env.items('stock.move');

    for (const move of this) {
      const [productId, locationId, locationDestId, productPackagingId, warehouseId] = await move('productId', 'locationId', 'locationDestId', 'productPackagingId', 'warehouseId');;
      const domain = [
        ['locationSrcId', '=', locationId.id],
        ['locationId', '=', locationDestId.id],
        ['action', '!=', 'push']
      ];
      const rules = await this.env.items('procurement.group')._searchRule(false, productPackagingId, productId, warehouseId, domain);
      if (bool(rules)) {
        const procureMethod = await rules.procureMethod;
        if (['makeToOrder', 'makeToStock'].includes(procureMethod)) {
          await move.set('procureMethod', procureMethod);
        }
        else {
          const locationSrcId = await rules.locationSrcId;
          // Get the needed quantity for the `mts_else_mto` moves.
          if (!mtsoNeededQtiesByLoc.has(locationSrcId)) {
            mtsoNeededQtiesByLoc.set(locationSrcId, new Dict<any>());
          }
          mtsoNeededQtiesByLoc.get(locationSrcId).setdefault(productId.id, 0);
          mtsoNeededQtiesByLoc.get(locationSrcId)[productId.id] += await move.productQty;

          // This allow us to get the forecasted quantity in batch later on
          if (!mtsoProductsByLocations.has(locationSrcId)) {
            mtsoProductsByLocations.set(locationSrcId, []);
          }
          mtsoProductsByLocations.get(locationSrcId).push(productId.id);
          mtsoMoves = mtsoMoves.or(move);
        }
      }
      else {
        await move.set('procureMethod', 'makeToStock');
      }
    }
    // Get the forecasted quantity for the `mts_else_mto` moves.
    for (const [location, productIds] of mtsoProductsByLocations.items()) {
      const products = await this.env.items('product.product').browse(productIds).withContext({ location: location.id });
      const lots = {};
      for (const product of products) {
        lots[product.id] = await product.freeQty;
      }
      mtsoFreeQtiesByLoc.set(location, lots);
    }

    // Now that we have the needed and forecasted quantity per location and per product, we can
    // choose whether the mtso_moves need to be MTO or MTS.
    for (const move of mtsoMoves) {
      const [productId, neededQty, locationId] = await move('productId', 'productQty', 'locationId');
      const forecastedQty = mtsoFreeQtiesByLoc.get(locationId)[productId.id];
      if (floatCompare(neededQty, forecastedQty, { precisionRounding: await (await productId.uomId).rounding }) <= 0) {
        await move.set('procureMethod', 'makeToStock');
        mtsoFreeQtiesByLoc.get(locationId)[productId.id] -= neededQty;
      }
      else {
        await move.set('procureMethod', 'makeToOrder');
      }
    }
  }

  async _showDetailsInDraft() {
    this.ensureOne();
    return (await this['state'] !== 'draft' || (await (await this['pickingId']).immediateTransfer && await this['state'] === 'draft'));
  }

  /**
   * Check for auto-triggered orderpoints and trigger them.
   * @returns 
   */
  async _triggerScheduler() {
    if (!this.ok || await (await this.env.items('ir.config.parameter').sudo()).getParam('stock.noAutoScheduler')) {
      return;
    }

    const orderpointsByCompany = new DefaultDict2(() => this.env.items('stock.warehouse.orderpoint'));
    const orderpointsContextByCompany = new DefaultDict();//(dict)
    for (const move of this) {
      const [productId, productQty, locationId, companyId, origin] = await move('productId', 'productQty', 'locationId', 'companyId', 'origin');
      const orderpoint = await this.env.items('stock.warehouse.orderpoint').search([
        ['productId', '=', productId.id],
        ['trigger', '=', 'auto'],
        ['locationId', 'parentOf', locationId.id],
        ['companyId', '=', companyId.id]
      ], { limit: 1 });
      if (orderpoint.ok) {
        const companyId = await orderpoint.companyId;
        orderpointsByCompany[companyId] = orderpointsByCompany[companyId].or(orderpoint);
      }
      if (orderpoint.ok && productQty > await orderpoint.productMinQty && origin) {
        const orderpointCompanyId = await orderpoint.companyId;
        if (!orderpointsContextByCompany.has(orderpointCompanyId)) {
          orderpointsContextByCompany.set(orderpointCompanyId, new Dict());
        }
        orderpointsContextByCompany.get(orderpointCompanyId).setdefault(orderpoint.id, []);
        orderpointsContextByCompany.get(orderpointCompanyId)[orderpoint.id].push(origin);
      }
    }
    for (const [company, orderpoints] of orderpointsByCompany.items()) {
      await (await orderpoints.withContext({ origins: orderpointsContextByCompany.get(company) }))._procureOrderpointConfirm(false, company, false);
    }
  }

  /**
   * Check for and trigger actionAssign for confirmed/partially_available moves related to done moves.
                  Disable auto reservation if user configured to do so.
   * @returns 
   */
  async _triggerAssign() {
    if (!this.ok || await (await this.env.items('ir.config.parameter').sudo()).getParam('stock.pickingNoAutoReserve')) {
      return;
    }

    const domains = [];
    for (const move of this) {
      domains.push([['productId', '=', (await move.productId).id], ['locationId', '=', (await move.locationDestId).id]]);
    }
    const staticDomain = [['state', 'in', ['confirmed', 'partiallyAvailable']],
    ['procureMethod', '=', 'makeToStock'],
    ['reservationDate', '<=', _Date.today()]];
    const movesToReserve = await this.env.items('stock.move').search(expression.AND([staticDomain, expression.OR(domains)]), { order: 'reservationDate, priority desc, date asc' });
    movesToReserve._actionAssign();
  }

  async _rollupMoveDests(seen: Set<number>) {
    for (const dst of await this['moveDestIds']) {
      if (!seen.has(dst.id)) {
        seen.add(dst.id)
        dst._rollupMoveDests(seen);
      }
    }
    return seen;
  }

  /**
   * Get forcasted information (sum_qty_expected, max_date_expected) of self for in_locations_ids as the in locations.
      It differ from _get_report_lines because it computes only the necessary information and return a
      dict by move, which is making faster to use and compute.
      :param qty: ids list/tuple of locations to consider as interne
      :return: a defaultdict of moves in self, values are tuple(sum_qty_expected, max_date_expected)
      :rtype: defaultdict
   * @param warehouse 
   * @returns 
   */
  async _getForecastAvailabilityOutgoing(warehouse) {
    async function _reconcileOutWithIns(result, out, ins, demand, productRounding, onlyMatchingMoveDest = true) {
      const indexToRemove = [];
      for (const [index, in_] of enumerate(ins)) {
        if (floatIsZero(in_['qty'], { precisionRounding: productRounding })) {
          indexToRemove.push(index);
          continue;
        }
        if (onlyMatchingMoveDest && in_['moveDests'] && !in_['moveDests'].includes(out.id)) {
          continue;
        }
        const takenFromIn = Math.min(demand, in_['qty']);
        demand -= takenFromIn;

        if (idsInSelf.has(out.id)) {
          result[out] = [result[out][0] + takenFromIn, dateMax(...[in_['moveDate'], result[out][1]].filter(d => d))];
        }

        in_['qty'] -= takenFromIn;
        if (in_['qty'] <= 0) {
          indexToRemove.push(index);
        }
        if (floatIsZero(demand, { precisionRounding: productRounding })) {
          break;
        }
      }
      for (const index of indexToRemove.reverse()) {
        // TODO: avoid this O(n²), maybe we shouldn't "clean" the in list
        delete ins[index];
      }
      return demand;
    }

    const idsInSelf = new Set(this.ids);
    const productIds = await this['productId'];
    const whLocationQuery = await this.env.items('stock.location')._search([['id', 'childOf', (await warehouse.viewLocationId).id]]);

    const [inDomain, outDomain] = await this.env.items('stock.report.productproductreplenishment')._moveConfirmedDomain(null, productIds.ids, whLocationQuery);
    const outs = await this.env.items('stock.move').search(outDomain, { order: 'reservationDate, priority desc, date, id' });
    const reservedOuts = await this.env.items('stock.move').search(
      outDomain.concat([['state', 'in', ['partiallyAvailable', 'assigned']]]),
      { order: 'priority desc, date, id' });
    const ins = await this.env.items('stock.move').search(inDomain, { order: 'priority desc, date, id' });
    // Prefetch data to avoid future request
    // await Promise.all([
    await outs.sub(this).read(['productId', 'productUom', 'productQty', 'state'], false),  // remove self because data is already fetch
      await ins.read(['productId', 'productQty', 'date', 'moveDestIds'], false)
    // ]);
    const currents = await (await productIds.withContext({ warehouse: warehouse.id }))._getOnlyQtyAvailable();

    const outsPerProduct = new DefaultDict2(() => []);
    const reservedOutsPerProduct = new DefaultDict2(() => []);
    const insPerProduct = new DefaultDict2(() => []);
    for (const out of outs) {
      const id = (await out.productId).id;
      // outsPerProduct[id] = outsPerProduct[id] ?? [];
      outsPerProduct[id].push(out);
    }
    for (const out of reservedOuts) {
      const id = (await out.productId).id;
      // reservedOutsPerProduct[id] = reservedOutsPerProduct[id] ?? [];
      reservedOutsPerProduct[id].push(out);
    }
    for (const in_ of ins) {
      const id = (await in_.productId).id;
      // insPerProduct[id] = insPerProduct[id] ?? [];
      insPerProduct[id].push({
        'qty': await in_.productQty,
        'moveDate': await in_.date,
        'moveDests': await in_._rollupMoveDests(new Set())
      });
    }

    const result = new Map<any, any>();//DefaultDict2(() => [0.0, false]);
    for (const product of productIds) {
      const productRounding = await (await product.uomId).rounding;
      for (const out of reservedOutsPerProduct[product.id]) {
        // Reconcile with reserved stock.
        // const current = currents[product.id];
        const reserved = await (await out.productUom)._computeQuantity(await out.reservedAvailability, await product.uomId);
        currents[product.id] -= reserved;
        if (idsInSelf.has(out.id)) {
          if (!result.has(out)) {
            result.set(out, [0.0, false]);
          }
          result.set(out, [result.get(out)[0] + reserved, false]);
        }
      }
      const unreconciledOuts = [];
      for (const out of outsPerProduct[product.id]) {
        // Reconcile with the current stock.
        let reserved = 0.0;
        if (['partiallyAvailable', 'assigned'].includes(await out.state)) {
          reserved = await (await out.productUom)._computeQuantity(await out.reservedAvailability, await product.uomId);
        }
        let demand = await out.productQty - reserved;

        if (floatIsZero(demand, { precisionRounding: productRounding })) {
          continue;
        }
        const current = currents[product.id];
        const takenFromStock = Math.min(demand, current);
        if (!floatIsZero(takenFromStock, { precisionRounding: productRounding })) {
          currents[product.id] -= takenFromStock;
          demand -= takenFromStock;
          if (idsInSelf.has(out.id)) {
            if (!result.has(out)) {
              result.set(out, [0.0, false]);
            }
            result.set(out, [result.get(out)[0] + takenFromStock, false]);
          }
        }
        // Reconcile with the ins.
        // The while loop will finish because it will pop from ins_per_product or decrease the demand until zero
        if (!floatIsZero(demand, { precisionRounding: productRounding })) {
          demand = await _reconcileOutWithIns(result, out, insPerProduct[product.id], demand, productRounding, true);
        }
        if (!floatIsZero(demand, { precisionRounding: productRounding })) {
          unreconciledOuts.push([demand, out]);
        }
      }
      for (const [demand, out] of unreconciledOuts) {
        await _reconcileOutWithIns(result, out, insPerProduct[product.id], demand, productRounding, false);
      }
    }
    return result;
  }
}