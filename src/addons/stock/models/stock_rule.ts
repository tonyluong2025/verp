import _ from "lodash";
import { DateTime } from "luxon";
import { Fields, _Date, _Datetime, api, registry } from "../../../core";
import { setdefault } from "../../../core/api/func";
import { DefaultDict } from "../../../core/helper/collections";
import { UserError } from "../../../core/helper/errors";
import { MetaModel, Model, _super } from "../../../core/models";
import { expression } from "../../../core/osv";
import { bool, extend, floatCompare, floatIsZero, len, sortedAsync, splitEvery, sum } from "../../../core/tools";

/**
 * An exception raised by ProcurementGroup `run` containing all the faulty procurements.
 */
export class ProcurementException extends Error {
  procurementExceptions: any;
  /**
   * param procurement_exceptions: a list of tuples containing the faulty
  procurement and their error messages
  :type procurement_exceptions: list
   * @param procurementExceptions 
   */
  constructor(procurementExceptions) {
    super();
    this.procurementExceptions = procurementExceptions;
  }
}

/**
 * A rule describe what a procurement should do; produce, buy, move, ...
 */
@MetaModel.define()
class StockRule extends Model {
  static _module = module;
  static _name = 'stock.rule';
  static _description = "Stock Rule";
  static _order = "sequence, id";
  static _checkCompanyAuto = true;

  @api.model()
  async defaultGet(fieldsList) {
    const res = await _super(StockRule, this).defaultGet(fieldsList);
    if (fieldsList.includes('companyId') && !res['companyId']) {
      res['companyId'] = (await this.env.company()).id;
    }
    return res;
  }

  static label = Fields.Char(
    'Name', {
    required: true, translate: true,
    help: "This field will fill the packing origin and the name of its moves"
  });
  static active = Fields.Boolean(
    'Active', {
    default: true,
    help: "If unchecked, it will allow you to hide the rule without removing it."
  });
  static groupPropagationOption = Fields.Selection([
    ['none', 'Leave Empty'],
    ['propagate', 'Propagate'],
    ['fixed', 'Fixed']], { string: "Propagation of Procurement Group", default: 'propagate' });
  static groupId = Fields.Many2one('procurement.group', { string: 'Fixed Procurement Group' });
  static action = Fields.Selection(
    [['pull', 'Pull From'], ['push', 'Push To'], ['pullPush', 'Pull & Push']], {
    string: 'Action',
    required: true
  });
  static sequence = Fields.Integer('Sequence', { default: 20 });
  static companyId = Fields.Many2one('res.company', {
    string: 'Company',
    default: self => self.env.company(),
    domain: "[['id', '=?', routeCompanyId]]"
  });
  static locationId = Fields.Many2one('stock.location', { string: 'Destination Location', required: true, checkCompany: true });
  static locationSrcId = Fields.Many2one('stock.location', { string: 'Source Location', checkCompany: true });
  static routeId = Fields.Many2one('stock.location.route', { string: 'Route', required: true, ondelete: 'CASCADE' });
  static routeCompanyId = Fields.Many2one({ related: 'routeId.companyId', string: 'Route Company' });
  static procureMethod = Fields.Selection([
    ['makeToStock', 'Take From Stock'],
    ['makeToOrder', 'Trigger Another Rule'],
    ['mtsElseMto', 'Take From Stock, if unavailable, Trigger Another Rule']], {
    string: 'Supply Method', default: 'makeToStock', required: true,
    help: ["Take From Stock: the products will be taken from the available stock of the source location.\n",
      "Trigger Another Rule: the system will try to find a stock rule to bring the products in the source location. The available stock will be ignored.\n",
      "Take From Stock, if Unavailable, Trigger Another Rule: the products will be taken from the available stock of the source location.",
      "If there is no stock available, the system will try to find a  rule to bring the products in the source location."].join('')
  });
  static routeSequence = Fields.Integer('Route Sequence', { related: 'routeId.sequence', store: true, computeSudo: true });
  static pickingTypeId = Fields.Many2one(
    'stock.picking.type', {
    string: 'Operation Type',
    required: true, checkCompany: true,
    domain: "[['code', '=?', pickingTypeCodeDomain]]"
  });
  static pickingTypeCodeDomain = Fields.Char({ compute: '_computePickingTypeCodeDomain' });
  static delay = Fields.Integer('Lead Time', { default: 0, help: "The expected date of the created transfer will be computed based on this lead time." });
  static partnerAddressId = Fields.Many2one(
    'res.partner', {
    string: 'Partner Address', checkCompany: true,
    help: "Address where goods should be delivered. Optional."
  });
  static propagateCancel = Fields.Boolean(
    'Cancel Next Move', { default: false, help: "When ticked, if the move created by this rule is cancelled, the next move will be cancelled too." });
  static propagateCarrier = Fields.Boolean(
    'Propagation of carrier', {
    default: false,
    help: "When ticked, carrier of shipment will be propgated."
  });
  static warehouseId = Fields.Many2one('stock.warehouse', { string: 'Warehouse', checkCompany: true });
  static propagateWarehouseId = Fields.Many2one(
    'stock.warehouse', { string: 'Warehouse to Propagate', help: "The warehouse to propagate on the created move/procurement, which can be different of the warehouse this rule is for (e.g for resupplying rules from another warehouse)" });
  static auto = Fields.Selection([
    ['manual', 'Manual Operation'],
    ['transparent', 'Automatic No Step Added']], {
    string: 'Automatic Move',
    default: 'manual', required: true, help: "The 'Manual Operation' value will create a stock move after the current one. With 'Automatic No Step Added', the location is replaced in the original move."
  });
  static ruleMessage = Fields.Html({ compute: '_computeActionMessage' });

  /**
   * Modify locations to the default picking type's locations source and destination. 
     Enable the delay alert if the picking type is a delivery
   */
  @api.onchange('pickingTypeId')
  async _onchangePickingType() {
    const pickingTypeId = await this['pickingTypeId'];
    // await Promise.all([
      await this.set('locationSrcId', (await pickingTypeId.defaultLocationSrcId).id),
      await this.set('locationId', (await pickingTypeId.defaultLocationDestId).id)
    // ]);
  }

  /**
   * Ensure that the rule's company is the same than the route's company.
   */
  @api.onchange('routeId', 'companyId')
  async _onchangeRoute() {
    const [routeId, pickingTypeId] = await this('routeId', 'pickingTypeId');
    const companyId = await routeId.companyId;
    if (companyId.ok) {
      await this.set('companyId', companyId);
    }
    if (!(await (await pickingTypeId.warehouseId).companyId).eq(companyId)) {
      await this.set('pickingTypeId', false);
    }
  }

  /**
   * Return the source, destination and pickingType applied on a stock
      rule. The purpose of this function is to avoid code duplication in
      _get_message_dict functions since it often requires those data.
   * @returns 
   */
  async _getMessageValues() {
    const [locationId, locationSrcId, pickingTypeId] = await this('locationId', 'locationSrcId', 'pickingTypeId');
    const source = locationSrcId.ok && await locationSrcId.displayName || await this._t('Source Location');
    const destination = locationId.ok && await locationId.displayName || await this._t('Destination Location');
    const operation = pickingTypeId.ok && await pickingTypeId.label || await this._t('Operation Type');;
    return [source, destination, operation];
  }

  /**
   * Return a dict with the different possible message used for the
      rule message. It should return one message for each stock.rule action
      (except push and pull). This function is override in mrp and
      purchase_stock in order to complete the dictionary.
   * @returns 
   */
  async _getMessageDict() {
    const messageDict = {};
    const [source, destination, operation] = await this._getMessageValues();
    if (['push', 'pull', 'pullPush'].includes(await this['action'])) {
      const [procureMethod, locationSrcId] = await this('procureMethod', 'locationSrcId');
      let suffix = "";
      if (procureMethod === 'makeToOrder' && locationSrcId.ok) {
        suffix = await this._t("<br>A need is created in <b>%s</b> and a rule will be triggered to fulfill it.", source);
      }
      if (procureMethod === 'mtsElseMto' && locationSrcId.ok) {
        suffix = await this._t("<br>If the products are not available in <b>%s</b>, a rule will be triggered to bring products in this location.", source);
      }
      const messageDict = {
        'pull': await this._t('When products are needed in <b>%s</b>, <br/> <b>%s</b> are created from <b>%s</b> to fulfill the need.', destination, operation, source) + suffix,
        'push': await this._t('When products arrive in <b>%s</b>, <br/> <b>%s</b> are created to send them in <b>%s</b>.', source, operation, destination)
      }
    }
    return messageDict;
  }

  /**
   * Generate dynamicaly a message that describe the rule purpose to the
      end user.
   */
  @api.depends('action', 'locationId', 'locationSrcId', 'pickingTypeId', 'procureMethod')
  async _computeActionMessage() {
    const actionRules = await this.filtered(async (rule) => await rule.action);
    for (const rule of actionRules) {
      const action = await rule.action;
      const messageDict = await rule._getMessageDict();
      let message = bool(messageDict) && messageDict[action] || "";
      if (action === 'pullPush') {
        message = messageDict['pull'] + "<br/><br/>" + messageDict['push'];
      }
      await rule.set('ruleMessage', message);
    }
    await this.sub(actionRules).set('ruleMessage', null);
  }

  @api.depends('action')
  async _computePickingTypeCodeDomain() {
    await this.set('pickingTypeCodeDomain', false);
  }

  /**
   * Apply a push rule on a move.
      If the rule is 'no step added' it will modify the destination location
      on the move.
      If the rule is 'manual operation' it will generate a new move in order
      to complete the section define by the rule.
      Care this function is not call by method run. It is called explicitely
      in stock_move.js inside the method _push_apply
   * @param move 
   * @returns 
   */
  async _runPush(move) {
    this.ensureOne();
    const newDate = _Datetime.toString(DateTime.fromJSDate(await move.date).plus({ days: await this['delay'] }));
    if (await this['auto'] === 'transparent') {
      const thisLocationId = await this['locationId'];
      const [oldDestLocation, moveLineIds, productId] = await move('locationDestId', 'moveLineIds', 'productId');
      await move.write({ 'date': newDate, 'locationDestId': (await this['locationId']).id });
      // make sure the locationDestId is consistent with the move line location dest
      if (moveLineIds.ok) {
        await moveLineIds.set('locationDestId', await oldDestLocation._getPutawayStrategy(productId) && oldDestLocation);
      }

      // avoid looping if a push rule is not well configured; otherwise call again push_apply to see if a next step is defined
      if (!thisLocationId.eq(oldDestLocation)) {
        // TDE FIXME: should probably be done in the move model IMO
        return (await move._pushApply()).slice(0, 1);
      }
    }
    else {
      const newMoveVals = await this._pushPrepareMoveCopyValues(move, newDate);
      const newMove = await (await move.sudo()).copy(newMoveVals);
      if (await newMove._shouldBypassReservation()) {
        await newMove.write({ 'procureMethod': 'makeToStock' });
      }
      if (!await (await newMove.locationId).shouldBypassReservation()) {
        await move.write({ 'moveDestIds': [[4, newMove.id]] });
      }
      return newMove;
    }
  }

  async _pushPrepareMoveCopyValues(moveToCopy, newDate) {
    let companyId = (await this['companyId']).id;
    if (!companyId) {
      const sudo = await this.sudo();
      const warehouseId = await sudo.warehouseId;
      companyId = warehouseId.ok && (await warehouseId.companyId).id || (await (await (await sudo.pickingTypeId).warehouseId).companyId).id;
    }
    const [origin, pickingId, locationDestId] = await moveToCopy('origin', 'pickingId', 'locationDestId');
    const newMoveVals = {
      'origin': origin || await pickingId.label || "/",
      'locationId': locationDestId.id,
      'locationDestId': (await this['locationId']).id,
      'date': newDate,
      'companyId': companyId,
      'pickingId': false,
      'pickingTypeId': (await this['pickingTypeId']).id,
      'propagateCancel': await this['propagateCancel'],
      'warehouseId': (await this['warehouseId']).id,
      'procureMethod': 'makeToOrder',
    }
    return newMoveVals;
  }

  @api.model()
  async _runPull(procurements) {
    const movesValuesByCompany = new DefaultDict<any, any>();//list)
    const mtsoProductsByLocations = new DefaultDict<any, any>()// list

    // To handle the `mts_else_mto` procure method, we do a preliminary loop to
    // isolate the products we would need to read the forecasted quantity,
    // in order to to batch the read. We also make a sanitary check on the
    // `locationSrcId` field.
    for (const [procurement, rule] of procurements) {
      const [label, locationSrcId, procureMethod] = await rule('label', 'locationSrcId', 'procureMethod');
      if (locationSrcId.nok) {
        const msg = await this._t('No source location defined on stock rule: %s!', label);
        throw new ProcurementException([[procurement, msg]]);
      }
      if (procureMethod === 'mtsElseMto') {
        if (!mtsoProductsByLocations.has(locationSrcId)) {
          mtsoProductsByLocations.set(locationSrcId, []);
        }
        mtsoProductsByLocations.get(locationSrcId).push((await procurement.productId).id);
      }
    }

    // Get the forecasted quantity for the `mts_else_mto` procurement.
    const forecastedQtiesByLoc = {};
    for (const [location, productIds] of mtsoProductsByLocations.items()) {
      const products = await this.env.items('product.product').browse(productIds).withContext({ location: location.id });
      forecastedQtiesByLoc[location] = {}
      for (const product of products) {
        forecastedQtiesByLoc[location][product.id] = await product.freeQty;
      }
    }

    // Prepare the move values, adapt the `procure_method` if needed.
    procurements = await sortedAsync(procurements, async (proc) => floatCompare(await proc(0).productQty, 0.0, { precisionRounding: await (await proc(0).productUom).rounding }) > 0);
    for (const [procurement, rule] of procurements) {
      let [locationSrcId, procureMethod] = await rule('locationSrcId', 'procureMethod');
      if (procureMethod === 'mtsElseMto') {
        const [productUom, productQty, productId] = await procurement('productUom', 'productQty', 'productId');
        const uomId = await productId.uomId;
        const qtyNeeded = await productUom._computeQuantity(productQty, uomId);
        if (floatCompare(qtyNeeded, 0, { precisionRounding: await uomId.rounding }) <= 0) {
          forecastedQtiesByLoc[locationSrcId][productId.id] -= qtyNeeded;
          procureMethod = 'makeToOrder';
        }
        else if (floatCompare(qtyNeeded, forecastedQtiesByLoc[locationSrcId][productId.id], { precisionRounding: uomId.rounding }) > 0) {
          procureMethod = 'makeToOrder';
        }
        else {
          forecastedQtiesByLoc[locationSrcId][productId.id] -= qtyNeeded;
          procureMethod = 'makeToStock';
        }
      }
      const moveValues = await rule._getStockMoveValues(procurement);
      moveValues['procureMethod'] = procureMethod;
      movesValuesByCompany[(await procurement.companyId).id].push(moveValues);
    }
    for (const [companyId, movesValues] of movesValuesByCompany.items()) {
      // create the move as SUPERUSER because the current user may not have the rights to do it (mto product launched by a sale for example)
      const moves = await (await (await (await this.env.items('stock.move').withUser(global.SUPERUSER_ID)).sudo()).withCompany(companyId)).create(movesValues);
      // Since action_confirm launch following procurement_group we should activate it.
      await moves._actionConfirm();
    }
    return true;
  }

  /**
   * The purpose of this method is to be override in order to easily add
      fields from procurement 'values' argument to move data.
   * @returns 
   */
  async _getCustomMoveFields() {
    return [];
  }

  /**
   * Returns a dictionary of values that will be used to create a stock move from a procurement.
      This function assumes that the given procurement has a rule (action == 'pull' or 'pull_push') set on it.

      :param procurement: browse record
      :rtype: dictionary
   * @param productId 
   * @param productQty 
   * @param productUom 
   * @param locationId 
   * @param label 
   * @param origin 
   * @param companyId 
   * @param values 
   * @returns 
   */
  async _getStockMoveValues(productId, productQty, productUom, locationId, label, origin, companyId, values) {
    const [groupPropagationOption, partnerAddressId, pickingTypeId, locationSrcId] = await this('groupPropagationOption', 'partnerAddressId', 'pickingTypeId', 'locationSrcId');
    let groupId = false;
    if (groupPropagationOption === 'propagate') {
      groupId = values['groupId'] && values['groupId'].id;
    }
    else if (groupPropagationOption === 'fixed') {
      groupId = (await this['groupId']).id;
    }

    const dateScheduled = _Datetime.toString(
      DateTime.fromJSDate(_Datetime.toDatetime(values['datePlanned']) as Date).minus({ days: await this['delay'] || 0 })
    )
    const dateDeadline = values['dateDeadline'] && DateTime.fromJSDate(_Datetime.toDatetime(values['dateDeadline']) as Date).minus({ days: await this['delay'] || 0 }) || false;
    const partner = bool(partnerAddressId) ? partnerAddressId : (values['groupId'] && await values['groupId'].partnerId);
    if (partner.ok) {
      productId = await productId.withContext({ lang: await partner.lang || await (await this.env.user()).lang });
    }
    let pickingDescription = await productId._getDescription(pickingTypeId);
    if (values['productDescriptionVariants']) {
      pickingDescription += values['productDescriptionVariants'];
    }
    // it is possible that we've already got some move done, so check for the done qty and create
    // a new move with the correct qty
    let qtyLeft = productQty;

    let moveDestIds = [];
    if (! await (await this['locationId']).shouldBypassReservation()) {
      moveDestIds = (values['moveDestIds'] ?? false) && values['moveDestIds'].map(x => [4, x.id]) || [];
    }

    // when create chained moves for inter-warehouse transfers, set the warehouses as partners
    if (!bool(partner) && bool(moveDestIds)) {
      const moveDest = values['moveDestIds'];
      if (locationId.eq(await companyId.internalTransitLocationId)) {
        const partners = await (await (await moveDest.locationDestId).warehouseId).partnerId;
        if (len(partners) == 1) {
          const partner = partners;
          await moveDest.set('partnerId', partner);
        }
      }
    }

    let comId = (await this['companyId']).id;
    comId = bool(comId) ? comId : (await locationSrcId.companyId).id;
    comId = bool(comId) ? comId : (await (await this['locationId']).companyId).id;
    comId = bool(comId) ? comId : companyId.id;

    const whId = (await this['propagateWarehouseId']).id;

    const moveValues = {
      'label': label.slice(0, 2000),
      'companyId': comId,
      'productId': productId.id,
      'productUom': productUom.id,
      'productUomQty': qtyLeft,
      'partnerId': bool(partner) ? partner.id : false,
      'locationId': locationSrcId.id,
      'locationDestId': locationId.id,
      'moveDestIds': moveDestIds,
      'ruleId': this.id,
      'procureMethod': await this['procureMethod'],
      'origin': origin,
      'pickingTypeId': (await this['pickingTypeId']).id,
      'groupId': groupId,
      'routeIds': (values['routeIds'] ?? []).map(route => [4, route.id]),
      'warehouseId': bool(whId) ? whId : (await this['warehouseId']).id,
      'date': dateScheduled,
      'dateDeadline': await this['groupPropagationOption'] === 'fixed' ? false : dateDeadline,
      'propagateCancel': await this['propagateCancel'],
      'descriptionPicking': pickingDescription,
      'priority': values['priority'] ?? "0",
      'orderpointId': values['orderpointId'] && values['orderpointId'].id,
      'productPackagingId': values['productPackagingId'] && values['productPackagingId'].id,
    }
    for (const field of await this._getCustomMoveFields()) {
      if (field in values) {
        moveValues[field] = values[field];
      }
    }
    return moveValues;
  }

  /**
   * Returns the cumulative delay and its description encountered by a
      procurement going through the rules in `self`.

      :param product: the product of the procurement
      :type product: :class:`~verp.addons.product.models.product.ProductProduct`
      :return: the cumulative delay and cumulative delay's description
      :rtype: tuple[int, list[str, str]]
   * @param product 
   * @param values 
   * @returns 
   */
  async _getLeadDays(product, values) {
    const delay = sum(await (await this.filtered(async (r) => ['pull', 'pullPush'].includes(await r.action))).mapped('delay'));
    const delayDescription = [];
    if (!this.env.context['bypassDelayDescription']) {
      for (const rule of this) {
        const [label, action, delay] = await rule('label', 'action', 'delay');
        if (['pull', 'pullPush'].includes(action) && delay) {
          delayDescription.push([await this._t('Delay on %s', label), await this._t('+ %s day(s)', delay)]);
        }
      }
    }
    return [delay, delayDescription];
  }
}

export function Procurement(
  productId: any,
  productQty: any,
  productUom: any,
  locationId: any,
  label: any,
  origin: any,
  companyId: any,
  values: any
) {
  return { 
    productId,
    productQty,
    productUom,
    locationId,
    label,
    origin,
    companyId,
    values
  }
}

/**
 * The procurement group class is used to group products together
    when computing procurements. (tasks, physical products, ...)

    The goal is that when you have one sales order of several products
    and the products are pulled from the same or several location(s), to keep
    having the moves grouped into pickings that represent the sales order.

    Used in: sales order (to group delivery order lines like the so), pull/push
    rules (to pack like the delivery order), on orderpoints (e.g. for wave picking
    all the similar products together).

    Grouping is made only if the source and the destination is the same.
    Suppose you have 4 lines on a picking from Output where 2 lines will need
    to come from Input (crossdock) and 2 lines coming from Stock -> Output As
    the four will have the same group ids from the SO, the move from input will
    have a stock.picking with 2 grouped lines and the move from stock will have
    2 grouped lines also.

    The name is usually the name of the original document (sales order) or a
    sequence computed if created manually.
 */
@MetaModel.define()
class ProcurementGroup extends Model {
  static _module = module;
  static _name = 'procurement.group';
  static _description = 'Procurement Group';
  static _order = "id desc";

  static partnerId = Fields.Many2one('res.partner', { string: 'Partner' });
  static label = Fields.Char(
    'Reference',
    {
      default: async (self) => await self.env.items('ir.sequence').nextByCode('procurement.group') || '',
      required: true
    });
  static moveType = Fields.Selection([
    ['direct', 'Partial'],
    ['one', 'All at once']], {
    string: 'Delivery Type', default: 'direct',
    required: true
  });
  static stockMoveIds = Fields.One2many('stock.move', 'groupId', { string: "Related Stock Moves" });

  /**
   * Fulfil `procurements` with the help of stock rules.

      Procurements are needs of products at a certain location. To fulfil
      these needs, we need to create some sort of documents (`stock.move`
      by default, but extensions of `_run_` methods allow to create every
      type of documents).

      :param procurements: the description of the procurement
      :type list: list of `~verp.addons.stock.models.stock_rule.ProcurementGroup.Procurement`
      :param raise_user_error: will raise either an UserError or a ProcurementException
      :type raise_user_error: boolan, optional
      :raises UserError: if `raise_user_error` is true and a procurement isn't fulfillable
      :raises ProcurementException: if `raise_user_error` is false and a procurement isn't fulfillable
   * @param procurements 
   * @param raiseUserError 
   */
  @api.model()
  async run(procurements, raiseUserError = true) {
    function raiseException(procurementErrors) {
      if (raiseUserError) {
        const [, errors] = _.zip(...procurementErrors);
        throw new UserError(errors.join('\n'));
      }
      else {
        throw new ProcurementException(procurementErrors);
      }
    }

    const actionsToRun = new DefaultDict(); //list)
    const procurementErrors = [];
    for (const procurement of procurements) {
      const [values, locationId, productId, productQty, productUom] = await procurement('values', 'locationId', 'productId', 'productQty', 'productUom');
      setdefault(values, 'companyId', await locationId.companyId);
      setdefault(values, 'priority', '0');
      setdefault(values, 'datePlanned', _Datetime.now());
      if (
        !['consu', 'product'].includes(await productId.type) ||
        floatIsZero(productQty, { precisionRounding: await productUom.rounding })
      ) {
        continue;
      }
      const rule = await this._getRule(productId, locationId, values);
      if (!rule) {
        const error = await this._t('No rule has been found to replenish "%s" in "%s".\nVerify the routes configuration on the product.', await productId.displayName, await locationId.displayName);
        procurementErrors.push([procurement, error]);
      }
      else {
        const action = await rule.action === 'pullPush' ? 'pull' : await rule.action;
        actionsToRun[action].push([procurement, rule]);
      }
    }

    if (procurementErrors.length) {
      raiseException(procurementErrors);
    }
    for (const [action, procurements] of Object.entries(actionsToRun)) {
      const func = `_run${_.upperFirst(action)}`;
      const Rule = this.env.items['stock.rule'];
      if (func in Rule) {
        try {
          await Rule[func](procurements);
        } catch (e) {
          // except ProcurementException as e:
          extend(procurementErrors, e.procurementExceptions);
        }
      }
      else {
        console.error("The method _run_%s doesn't exist on the procurement rules", action);
      }
    }
    if (procurementErrors.length) {
      raiseException(procurementErrors);
    }
    return true;
  }

  /**
   * First find a rule among the ones defined on the procurement
        group, then try on the routes defined for the product, finally fallback
        on the default behavior
   * @param routeIds 
   * @param packagingId 
   * @param productId 
   * @param warehouseId 
   * @param domain 
   * @returns 
   */
  @api.model()
  async _searchRule(routeIds, packagingId, productId, warehouseId, domain) {
    if (bool(warehouseId)) {
      domain = expression.AND([['|', ['warehouseId', '=', warehouseId.id], ['warehouseId', '=', false]], domain]);
    }
    const Rule = this.env.items('stock.rule');
    let res = this.env.items('stock.rule');
    if (bool(routeIds)) {
      res = await Rule.search(expression.AND([[['routeId', 'in', routeIds.ids]], domain]), { order: 'routeSequence, sequence', limit: 1 });
    }
    if (!res.ok && bool(packagingId)) {
      const packagingRoutes = await packagingId.routeIds;
      if (packagingRoutes.ok) {
        res = await Rule.search(expression.AND([[['routeId', 'in', packagingRoutes.ids]], domain]), { order: 'routeSequence, sequence', limit: 1 });
      }
    }
    if (!res.ok) {
      const productRoutes = (await productId.routeIds).or(await (await productId.categId).totalRouteIds);
      if (productRoutes.ok) {
        res = await Rule.search(expression.AND([[['routeId', 'in', productRoutes.ids]], domain]), { order: 'routeSequence, sequence', limit: 1 });
      }
    }
    if (!res.ok && bool(warehouseId)) {
      const warehouseRoutes = await warehouseId.routeIds;
      if (warehouseRoutes.ok) {
        res = await Rule.search(expression.AND([[['routeId', 'in', warehouseRoutes.ids]], domain]), { order: 'routeSequence, sequence', limit: 1 });
      }
    }
    return res;
  }

  /**
   * Find a pull rule for the locationId, fallback on the parent
      locations if it could not be found.
   * @param productId 
   * @param locationId 
   * @param values 
   * @returns 
   */
  @api.model()
  async _getRule(productId, locationId, values) {
    let result;
    let location = locationId;
    while (!result && bool(location)) {
      const domain = await this._getRuleDomain(location, values);
      const result = await this._searchRule(values['routeIds'] ?? false, values['productPackagingId'] ?? false, productId, values['warehouseId'] ?? false, domain);
      location = await location.locationId;
    }
    return result;
  }

  @api.model()
  async _getRuleDomain(location, values) {
    let domain = ['&', ['locationId', '=', location.id], ['action', '!=', 'push']];
    // In case the method is called by the superuser, we need to restrict the rules to the
    // ones of the company. This is not useful as a regular user since there is a record
    // rule to filter out the rules based on the company.
    if (this.env.su && values['companyId']) {
      const domainCompany = ['|', ['companyId', '=', false], ['companyId', 'childOf', values['companyId'].ids]];
      domain = expression.AND([domain, domainCompany]);
    }
    return domain;
  }

  @api.model()
  async _getMovesToAssignDomain(companyId) {
    let movesDomain = [
      ['state', 'in', ['confirmed', 'partiallyAvailable']],
      ['productUomQty', '!=', 0.0],
      ['reservationDate', '<=', _Date.today()]
    ]
    if (bool(companyId)) {
      movesDomain = expression.AND([[['companyId', '=', companyId]], movesDomain]);
    }
    return movesDomain;
  }

  @api.model()
  async _runSchedulerTasks(useNewCursor = false, companyId?: any) {
    // Minimum stock rules
    let domain: any[] = await this._getOrderpointDomain(companyId);
    const orderpoints = await this.env.items('stock.warehouse.orderpoint').search(domain);
    // ensure that qty_* which depends on datetime.now() are correctly
    // recomputed
    const sudo = await orderpoints.sudo();
    await sudo._computeQtyToOrder();
    if (useNewCursor) {
      await this._cr.commit();
      await this._cr.reset();
    }
    await sudo._procureOrderpointConfirm(useNewCursor, companyId, false);

    // Search all confirmed stock_moves and try to assign them
    domain = await this._getMovesToAssignDomain(companyId);
    const movesToAssign = await this.env.items('stock.move').search(domain, { limit: null, order: 'reservationDate, priority desc, date asc' });
    for (const movesChunk of splitEvery(1000, movesToAssign.ids)) {
      await (await this.env.items('stock.move').browse(movesChunk).sudo())._actionAssign();
      if (useNewCursor) {
        await this._cr.commit();
        await this._cr.reset();
        console.info("A batch of %d moves are assigned and committed", len(movesChunk));
      }
    }
    // Merge duplicated quants
    await this.env.items('stock.quant')._quantTasks();

    if (useNewCursor) {
      await this._cr.commit();
      await this._cr.reset();
      console.info("_runSchedulerTasks is finished and committed");
    }
  }

  /**
   * Call the scheduler in order to check the running procurements (super method), to check the minimum stock rules
      and the availability of moves. This function is intended to be run for all the companies at the same time, so
      we run functions as SUPERUSER to avoid intercompanies and access rights issues.
   * @param useNewCursor 
   * @param companyId 
   * @returns 
   */
  @api.model()
  async runScheduler(useNewCursor = false, companyId?: any) {
    let self = this;
    try {
      if (useNewCursor) {
        const cr = (await registry(this._cr.dbName)).cursor();
        self = self.withEnv(await self.env.change({ cr: cr }));  // TDE FIXME
      }
      await this._runSchedulerTasks(useNewCursor, companyId);
    }
    finally {
      if (useNewCursor) {
        try {
          self._cr.close();
        } catch (e) {
          // pass
        }
      }
    }
    return {}
  }

  @api.model()
  async _getOrderpointDomain(companyId?: any) {
    let domain = [['trigger', '=', 'auto'], ['productId.active', '=', true]];
    if (bool(companyId)) {
      domain = domain.concat([['companyId', '=', companyId]]);
    }
    return domain;
  }
}