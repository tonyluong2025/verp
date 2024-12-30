import { api } from "../../../core";
import { Fields } from "../../../core/fields";
import { UserError } from "../../../core/helper/errors";
import { MetaModel, Model, _super } from "../../../core/models";
import { _f, bool, extend, f, len, range, update } from "../../../core/tools";
import { _lt } from "../../../core/tools/translate";

async function ROUTE_NAMES() {
  return {
    'oneStep': await _lt('Receive in 1 step (stock)'),
    'twoSteps': await _lt('Receive in 2 steps (input + stock)'),
    'threeSteps': await _lt('Receive in 3 steps (input + quality + stock)'),
    'crossdock': await _lt('Cross-Dock'),
    'shipOnly': await _lt('Deliver in 1 step (ship)'),
    'pickShip': await _lt('Deliver in 2 steps (pick + ship)'),
    'pickPackShip': await _lt('Deliver in 3 steps (pick + pack + ship)'),
  }
}

function Routing(fromLoc: any, destLoc: any, pickingType: any, action: any) {
  return {
    fromLoc: fromLoc,
    destLoc: destLoc,
    pickingType: pickingType,
    action: action
  }
}

@MetaModel.define()
class Warehouse extends Model {
  static _module = module;
  static _name = "stock.warehouse";
  static _description = "Warehouse";
  static _order = 'sequence,id';
  static _checkCompanyAuto = true;

  async _defaultName() {
    const count = await (await this.env.items('stock.warehouse').withContext({ activeTest: false })).searchCount([['companyId', '=', (await this.env.company()).id]]);
    return f("%s - warehouse # %s", count ? ((await this.env.company()).label, count + 1) : (await this.env.company()).label);
  }

  static label = Fields.Char('Warehouse', { index: true, required: true, default: self => self._defaultName() });
  static active = Fields.Boolean('Active', { default: true });
  static companyId = Fields.Many2one(
    'res.company', {
    string: 'Company', default: self => self.env.company(), index: true, readonly: true, required: true,
    help: 'The company is automatically set from your user preferences.'
  });
  static partnerId = Fields.Many2one('res.partner', { string: 'Address', default: async (self) => (await self.env.company()).partnerId, checkCompany: true });
  static viewLocationId = Fields.Many2one(
    'stock.location', {
    string: 'View Location',
    domain: "[['usage', '=', 'view'], ['companyId', '=', companyId]]", required: true, checkCompany: true
  });
  static lotStockId = Fields.Many2one(
    'stock.location', {
    string: 'Location Stock',
    domain: "[['usage', '=', 'internal'], ['companyId', '=', companyId]]", required: true, checkCompany: true
  });
  static code = Fields.Char('Short Name', { required: true, size: 5, help: "Short name used to identify your warehouse" });
  static routeIds = Fields.Many2many(
    'stock.location.route', {
    relation: 'stockRouteWarehouse', column1: 'warehouseId', column2: 'routeId', string: 'Routes',
    domain: "[['warehouseSelectable', '=', true], '|', ['companyId', '=', false], ['companyId', '=', companyId]]",
    help: 'Defaults routes through the warehouse', checkCompany: true
  });
  static receptionSteps = Fields.Selection([
    ['oneStep', 'Receive goods directly (1 step)'],
    ['twoSteps', 'Receive goods in input and then stock (2 steps)'],
    ['threeSteps', 'Receive goods in input, then quality and then stock (3 steps)']], { string: 'Incoming Shipments', default: 'oneStep', required: true, help: "Default incoming route to follow" });
  static deliverySteps = Fields.Selection([
    ['shipOnly', 'Deliver goods directly (1 step)'],
    ['pickShip', 'Send goods in output and then deliver (2 steps)'],
    ['pickPackShip', 'Pack goods, send goods in output and then deliver (3 steps)']], { string: 'Outgoing Shipments', default: 'shipOnly', required: true, help: "Default outgoing route to follow" });
  static whInputStockLocId = Fields.Many2one('stock.location', { string: 'Input Location', checkCompany: true });
  static whQcStockLocId = Fields.Many2one('stock.location', { string: 'Quality Control Location', checkCompany: true });
  static whOutputStockLocId = Fields.Many2one('stock.location', { string: 'Output Location', checkCompany: true });
  static whPackStockLocId = Fields.Many2one('stock.location', { string: 'Packing Location', checkCompany: true });
  static mtoPullId = Fields.Many2one('stock.rule', { string: 'MTO rule' });
  static pickTypeId = Fields.Many2one('stock.picking.type', { string: 'Pick Type', checkCompany: true });
  static packTypeId = Fields.Many2one('stock.picking.type', { string: 'Pack Type', checkCompany: true });
  static outTypeId = Fields.Many2one('stock.picking.type', { string: 'Out Type', checkCompany: true });
  static inTypeId = Fields.Many2one('stock.picking.type', { string: 'In Type', checkCompany: true });
  static intTypeId = Fields.Many2one('stock.picking.type', { string: 'Internal Type', checkCompany: true });
  static returnTypeId = Fields.Many2one('stock.picking.type', { string: 'Return Type', checkCompany: true });
  static crossdockRouteId = Fields.Many2one('stock.location.route', { string: 'Crossdock Route', ondelete: 'RESTRICT' });
  static receptionRouteId = Fields.Many2one('stock.location.route', { string: 'Receipt Route', ondelete: 'RESTRICT' });
  static deliveryRouteId = Fields.Many2one('stock.location.route', { string: 'Delivery Route', ondelete: 'RESTRICT' });
  static resupplyWhIds = Fields.Many2many(
    'stock.warehouse', { relation: 'stockWhResupplyTable', column1: 'suppliedWhId', column2: 'supplierWhId', string: 'Resupply From', help: "Routes will be created automatically to resupply this warehouse from the warehouses ticked" });
  static resupplyRouteIds = Fields.One2many(
    'stock.location.route', 'suppliedWhId', { string: 'Resupply Routes', help: "Routes will be created for these resupply warehouses and you can select them on products and product categories" });
  static sequence = Fields.Integer({
    default: 10,
    help: "Gives the sequence of this line when displaying the warehouses."
  });
  static _sqlConstraints = [
    ['warehouse_name_uniq', 'unique(label, "companyId")', 'The name of the warehouse must be unique per company!'],
    ['warehouse_code_uniq', 'unique(code, "companyId")', 'The short name of the warehouse must be unique per company!'],
  ];

  @api.onchange('companyId')
  async _onchangeCompanyId() {
    const [groupUser, groupStockMultiWarehouses, groupStockMultiLocation] =
      [
        await this.env.ref('base.groupUser'),
        await this.env.ref('stock.groupStockMultiWarehouses'),
        await this.env.ref('stock.groupStockMultiLocations')
      ];
    const impliedIds = await groupUser.impliedIds;
    if (!(impliedIds.includes(groupStockMultiWarehouses)) && !(impliedIds.includes(groupStockMultiLocation))) {
      return {
        'warning': {
          'title': await this._t('Warning'),
          'message': await this._t('Creating a new warehouse will automatically activate the Storage Locations setting')
        }
      }
    }
  }

  @api.model()
  async create(vals) {
    // create view location for warehouse then create all locations
    const locVals = { 'label': vals['code'], 'usage': 'view', 'locationId': (await this.env.ref('stock.stockLocationLocations')).id }
    if (vals['companyId']) {
      locVals['companyId'] = vals['companyId'];
    }
    vals['viewLocationId'] = (await this.env.items('stock.location').create(locVals)).id;
    const subLocations = await this._getLocationsValues(vals);

    for (const [fieldName, values] of Object.entries(subLocations)) {
      values['locationId'] = vals['viewLocationId'];
      if (vals['companyId']) {
        values['companyId'] = vals['companyId'];
      }
      vals[fieldName] = (await (await this.env.items('stock.location').withContext({ activeTest: false })).create(values)).id;
    }

    // actually create WH
    const warehouse = await _super(Warehouse, this).create(vals);
    // create sequences and operation types
    const newVals = await warehouse._createOrUpdateSequencesAndPickingTypes();
    await warehouse.write(newVals)  // TDE FIXME: use super ?
    // create routes and push/stock rules
    const routeVals = await warehouse._createOrUpdateRoute();
    await warehouse.write(routeVals);

    // Update global route with specific warehouse rule.
    await warehouse._createOrUpdateGlobalRoutesRules();

    // create route selectable on the product to resupply the warehouse from another one
    await warehouse.createResupplyRoutes(await warehouse.resupplyWhIds);

    // update partner data if partner assigned
    if (vals['partnerId']) {
      await this._updatePartnerData(vals['partnerId'], vals['companyId']);
    }

    await this._checkMultiwarehouseGroup();

    return warehouse;
  }

  async write(vals) {
    if ('companyId' in vals) {
      for (const warehouse of this) {
        if ((await warehouse.companyId).id != vals['companyId']) {
          throw new UserError(await this._t("Changing the company of this record is forbidden at this point, you should rather archive it and create a new one."));
        }
      }
    }
    const Route = this.env.items('stock.location.route');
    const warehouses = await this.withContext({ activeTest: false });
    await warehouses._createMissingLocations(vals);

    if (vals['receptionSteps']) {
      await warehouses._updateLocationReception(vals['receptionSteps']);
    }
    if (vals['deliverySteps']) {
      await warehouses._updateLocationDelivery(vals['deliverySteps']);
    }
    if (vals['receptionSteps'] || vals['deliverySteps']) {
      await warehouses._updateReceptionDeliveryResupply(vals['receptionSteps'], vals['deliverySteps']);
    }
    let oldResupplyWhs, newResupplyWhs;
    if (vals['resupplyWhIds'] && !vals['resupplyRouteIds']) {
      newResupplyWhs = (await (await this.new({
        'resupplyWhIds': vals['resupplyWhIds']
      })).resupplyWhIds)._origin;
      oldResupplyWhs = {}
      for (const warehouse of warehouses) {
        oldResupplyWhs[warehouse.id] = await warehouse.resupplyWhIds;
      }
    }
    // If another partner assigned
    if (vals['partnerId']) {
      await warehouses._updatePartnerData(vals['partnerId'], vals['companyId']);
    }

    const res = await _super(Warehouse, this).write(vals);

    if (vals['code'] || vals['label']) {
      await warehouses._updateNameAndCode(vals['label'], vals['code']);
    }

    for (const warehouse of warehouses) {
      // check if we need to delete and recreate route
      let depends = [];
      for (const value of Object.values(await warehouse._getRoutesValues())) {
        for (const deps of value['depends'] ?? []) {
          depends.push(deps);
        }
      }
      let some = depends.some(deps => deps in vals);
      if ('code' in vals || some) {
        const pickingTypeVals = await warehouse._createOrUpdateSequencesAndPickingTypes();
        if (bool(pickingTypeVals)) {
          await warehouse.write(pickingTypeVals);
        }
      }
      if (some) {
        const routeVals = warehouse._createOrUpdateRoute();
        if (routeVals) {
          await warehouse.write(routeVals);
        }
      }
      // Check if a global rule(mto, buy, ...) need to be modify.
      // The field that impact those rules are listed in the
      // _getGlobalRouteRulesValues method under the key named 'depends'.
      const globalRules = await warehouse._getGlobalRouteRulesValues();
      depends = [];
      for (const value of Object.values(globalRules)) {
        for (const deps of value['depends'] ?? []) {
          depends.push(deps);
        }
      }
      if (Object.keys(globalRules).some(rule => rule in vals) || depends.some(deps => deps in vals)) {
        await warehouse._createOrUpdateGlobalRoutesRules();
      }
      if ('active' in vals) {
        const pickingTypeIds = await (await this.env.items('stock.picking.type').withContext({ activeTest: false })).search([['warehouseId', '=', warehouse.id]]);
        const moveIds = await this.env.items('stock.move').search([
          ['pickingTypeId', 'in', pickingTypeIds.ids],
          ['state', 'not in', ['done', 'cancel']],
        ])
        if (bool(moveIds)) {
          throw new UserError(await this._t('You still have ongoing operations for picking types %s in warehouse %s', (await moveIds.mapped('pickingTypeId.label')).join(', '), await warehouse.label));
        }
        else {
          await pickingTypeIds.write({ 'active': vals['active'] });
        }
        const viewLocationId = await warehouse.viewLocationIdl;
        const locationIds = await (await this.env.items('stock.location').withContext({ activeTest: false })).search([['locationId', 'childOf', viewLocationId.id]]);
        const pickingTypeUsingLocations = this.env.items('stock.picking.type').search([
          ['defaultLocationSrcId', 'in', locationIds.ids],
          ['defaultLocationDestId', 'in', locationIds.ids],
          ['id', 'not in', pickingTypeIds.ids],
        ]);
        if (bool(pickingTypeUsingLocations)) {
          throw new UserError(await this._t('%s use default source or destination locations from warehouse %s that will be archived.', (await pickingTypeUsingLocations.mapped('label')).join(', '), await warehouse.label));
        }
        await viewLocationId.write({ 'active': vals['active'] });

        const ruleIds = await (await this.env.items('stock.rule').withContext({ activeTest: false })).search([['warehouseId', '=', warehouse.id]]);
        // Only modify route that apply on this warehouse.
        await (await (await warehouse.routeIds).filtered(async (r) => len(await r.warehouseIds) == 1)).write({ 'active': vals['active'] });
        await ruleIds.write({ 'active': vals['active'] });

        if (await warehouse.active) {
          // Catch all warehouse fields that trigger a modfication on routes, rules, picking types and locations (e.g the reception steps). The purpose is to write on it in order to let the write method set the correct field to active or archive.
          const depends = new Set<any>();
          for (const ruleItem of Object.values(await warehouse._getGlobalRouteRulesValues())) {
            for (const depend of (ruleItem['depends'] ?? [])) {
              depends.add(depend);
            }
          }
          for (const ruleItem of Object.values(await warehouse._getRoutesValues())) {
            for (const depend of (ruleItem['depends'] ?? [])) {
              depends.add(depend);
            }
          }
          const routes = [];
          for (const route of await warehouse.resupplyRouteIds) {
            routes.push([4, route.id]);
          }
          const values = { 'resupplyRouteIds': routes }
          for (const depend of depends) {
            update(values, { depend: warehouse[depend] });
          }
          await warehouse.write(values);
        }
      }
    }

    if (vals['resupplyWhIds'] && !vals['resupplyRouteIds']) {
      for (const warehouse of warehouses) {
        const toAdd = newResupplyWhs.sub(oldResupplyWhs[warehouse.id]);
        const toRemove = oldResupplyWhs[warehouse.id].sub(newResupplyWhs);
        if (toAdd) {
          const existingRoute = await Route.search([
            ['suppliedWhId', '=', warehouse.id],
            ['supplierWhId', 'in', toRemove.ids],
            ['active', '=', false]
          ]);
          if (bool(existingRoute)) {
            await existingRoute.toggleActive();
          }
          else {
            await warehouse.createResupplyRoutes(toAdd);
          }
        }
        if (bool(toRemove)) {
          const toDisableRouteIds = Route.search([
            ['suppliedWhId', '=', warehouse.id],
            ['supplierWhId', 'in', toRemove.ids],
            ['active', '=', true]
          ]);
          await toDisableRouteIds.toggleActive();
        }
      }
    }
    if ('active' in vals) {
      await this._checkMultiwarehouseGroup();
    }
    return res;
  }

  async unlink() {
    const res = await _super(Warehouse, this).unlink();
    await this._checkMultiwarehouseGroup();
    return res;
  }

  async _checkMultiwarehouseGroup() {
    const cntByCompany = await (await this.env.items('stock.warehouse').sudo()).readGroup([['active', '=', true]], ['companyId'], ['companyId']);
    if (bool(cntByCompany)) {
      const maxCnt = Math.max(cntByCompany.map((k) => k['companyId_count']));
      const groupUser = await this.env.ref('base.groupUser');
      const groupStockMultiWarehouses = await this.env.ref('stock.groupStockMultiWarehouses');
      if (maxCnt['companyId_count'] <= 1 && (await groupUser.impliedIds).includes(groupStockMultiWarehouses)) {
        await groupUser.write({ 'impliedIds': [[3, groupStockMultiWarehouses.id]] });
        const users = [];
        for (const user of await groupUser.users) {
          users.push([3, user.id]);
        }
        await groupStockMultiWarehouses.write({ 'users': users });
      }
      if (maxCnt['companyId_count'] > 1 && !(await groupUser.impliedIds).includes(groupStockMultiWarehouses)) {
        await groupUser.write({ 'impliedIds': [[4, groupStockMultiWarehouses.id], [4, (await this.env.ref('stock.groupStockMultiLocations')).id]] })
      }
    }
  }

  @api.model()
  async _updatePartnerData(partnerId, companyId) {
    if (!bool(partnerId)) {
      return;
    }
    const ResCompany = this.env.items('res.company');
    if (bool(companyId)) {
      const transitLoc = (await ResCompany.browse(companyId).internalTransitLocationId).id;
      await (await this.env.items('res.partner').browse(partnerId).withCompany(companyId)).write({ 'propertyStockCustomer': transitLoc, 'propertyStockSupplier': transitLoc });
    }
    else {
      const transitLoc = (await (await this.env.company()).internalTransitLocationId).id;
      await this.env.items('res.partner').browse(partnerId).write({ 'propertyStockCustomer': transitLoc, 'propertyStockSupplier': transitLoc });
    }
  }

  /**
   * Create or update existing picking types for a warehouse.
    Pikcing types are stored on the warehouse in a many2one. If the picking type exist this method will update it. The update values can be found in the method _getPickingTypeUpdateValues. If the picking type does not exist it will be created with a new sequence associated to it.
   * @returns 
   */
  async _createOrUpdateSequencesAndPickingTypes() {
    this.ensureOne();
    const IrSequenceSudo = await this.env.items('ir.sequence').sudo();
    const PickingType = this.env.items('stock.picking.type');

    // choose the next available color for the operation types of this warehouse
    const allUsedColors = (await PickingType.searchRead([['warehouseId', '!=', false], ['color', '!=', false]], ['color'], { order: 'color' })).map(res => res['color']);
    const availableColors = Array.from(range(0, 12)).filter(zef => !allUsedColors.includes(zef));
    const color = availableColors.length ? availableColors[0] : 0;

    const warehouseData = {};
    const sequenceData = await this._getSequenceValues();

    // suit for each warehouse: reception, internal, pick, pack, ship
    let maxSequence = await this.env.items('stock.picking.type').searchRead([['sequence', '!=', false]], ['sequence'], { limit: 1, order: 'sequence desc' });
    maxSequence = maxSequence.length && maxSequence[0]['sequence'] || 0;

    const data = await this._getPickingTypeUpdateValues();
    let createData;
    [createData, maxSequence] = await this._getPickingTypeCreateValues(maxSequence);

    for (const [pickingType, values] of Object.entries(data)) {
      const thisPickingType = await this[pickingType];
      if (thisPickingType.ok) {
        await thisPickingType.update(values);
      }
      else {
        update(data[pickingType], createData[pickingType]);
        const sequence = await IrSequenceSudo.create(sequenceData[pickingType]);
        update(values, { warehouseId: this.id, color: color, sequenceId: sequence.id });
        warehouseData[pickingType] = (await PickingType.create(values)).id;
      }
    }
    if ('outTypeId' in warehouseData) {
      await PickingType.browse(warehouseData['outTypeId']).write({ 'returnPickingTypeId': warehouseData['returnTypeId'] ?? false });
    }
    if ('inTypeId' in warehouseData) {
      await PickingType.browse(warehouseData['inTypeId']).write({ 'returnPickingTypeId': warehouseData['outTypeId'] ?? false });
    }
    return warehouseData;
  }

  /**
   * Some rules are not specific to a warehouse(e.g MTO, Buy, ...)
    however they contain rule(s) for a specific warehouse. This method will
    update the rules contained in global routes in order to make them match
    with the wanted reception, delivery,... steps.
   * @returns 
   */
  async _createOrUpdateGlobalRoutesRules() {
    for (const [ruleField, ruleDetails] of Object.entries(await this._getGlobalRouteRulesValues())) {
      const values = ruleDetails['updateValues'] ?? {};
      const thisRuleField = await this[ruleField];
      if (bool(thisRuleField)) {
        await thisRuleField.write(values);
      }
      else {
        update(values, ruleDetails['createValues']);
        update(values, { 'warehouseId': this.id });
        await this.set(ruleField, await this.env.items('stock.rule').create(values));
      }
    }
    return true;
  }

  /**
   * return a route record set from an xmlid or its name.
   * @param xmlid 
   * @param routeName 
   * @returns 
   */
  async _findGlobalRoute(xmlid, routeName) {
    let route = await this.env.ref(xmlid, false);
    if (!bool(route)) {
      route = await this.env.items('stock.location.route').search([['label', 'like', routeName]], { limit: 1 });
    }
    if (!bool(route)) {
      throw new UserError(await this._t('Can\'t find any generic route %s.', routeName));
    }
    return route;
  }

  /**
   * Method used by _create_or_update_global_routes_rules. It's
    purpose is to return a dict with this format.
    key: The rule contained in a global route that have to be create/update
    entry a dict with the following values:
        -depends: Field that impact the rule. When a field in depends is
        write on the warehouse the rule set as key have to be update.
        -create_values: values used in order to create the rule if it does
        not exist.
        -update_values: values used to update the route when a field in
        depends is modify on the warehouse.
   * @returns 
   */
  async _getGlobalRouteRulesValues() {
    // We use 0 since routing are order from stock to cust. If the routing
    // order is modify, the mto rule will be wrong.
    const [companyId, lotStockId, deliverySteps] = await this('companyId', 'lotStockId', 'deliverySteps');
    let rule = (await this.getRulesDict())[this.id][deliverySteps];
    // rule = rule.filter(r => r.fromLoc === lotStockId)[0];
    rule = (await Promise.all(rule.map(async (item) => ({
      data: item,
      filter: (await item.fromLoc).eq(lotStockId)
    })))).filter(item => item.filter).map(item => item.data)[0];
    const [locationId, locationDestId, pickingTypeId] = [rule.fromLoc, rule.destLoc, rule.pickingType];
    return {
      'mtoPullId': {
        'depends': ['deliverySteps'],
        'createValues': {
          'active': true,
          'procureMethod': 'mtsElseMto',
          'companyId': companyId.id,
          'action': 'pull',
          'auto': 'manual',
          'routeId': (await this._findGlobalRoute('stock.routeWarehouse0Mto', await this._t('Make To Order'))).id
        },
        'updateValues': {
          'label': await this._formatRulename(locationId, locationDestId, 'MTO'),
          'locationId': locationDestId.id,
          'locationSrcId': locationId.id,
          'pickingTypeId': pickingTypeId.id,
        }
      }
    }
  }

  /**
   * Create or update the warehouse's routes.
    _get_routes_values method return a dict with:
        - route field name (e.g: crossdock_route_id).
        - field that trigger an update on the route (key 'depends').
        - routing_key used in order to find rules contained in the route.
        - create values.
        - update values when a field in depends is modified.
        - rules default values.
    This method do an iteration on each route returned and update/create
    them. In order to update the rules contained in the route it will
    use the get_rules_dict that return a dict:
        - a receptions/delivery,... step value as key (e.g  'pick_ship')
        - a list of routing object that represents the rules needed to
        fullfil the pupose of the route.
    The routing_key from _get_routes_values is match with the get_rules_dict
    key in order to create/update the rules in the route
    (_find_existing_rule_or_create method is responsible for this part).
   */
  async _createOrUpdateRoute() {
    // Create routes and active/create their related rules.
    const routes = [];
    const rulesDict = await this.getRulesDict();
    for (const [routeField, routeData] of Object.entries(this._getRoutesValues())) {
      const thisRouteField = await this[routeField];
      let route;
      // If the route exists update it
      if (thisRouteField.ok) {
        route = thisRouteField;
        if ('routeUpdateValues' in routeData) {
          await route.write(routeData['routeUpdateValues']);
        }
        await (await route.ruleIds).write({ 'active': false });
      }
      // Create the route
      else {
        if ('routeUpdateValues' in routeData) {
          update(routeData['routeCreateValues'], routeData['routeUpdateValues']);
        }
        route = await this.env.items('stock.location.route').create(routeData['routeCreateValues']);
        await this.set(routeField, route);
      }
      // Get rules needed for the route
      const routingKey = routeData['routingKey'];
      const rules = rulesDict[this.id][routingKey];
      if ('rulesValues' in routeData) {
        update(routeData['rulesValues'], { 'routeId': route.id });
      }
      else {
        routeData['rulesValues'] = { 'routeId': route.id };
      }
      const rulesList = await this._getRuleValues(rules, routeData['rulesValues']);
      // Create/Active rules
      this._findExistingRuleOrCreate(rulesList);
      if (routeData['routeCreateValues']['warehouseSelectable'] || routeData['routeUpdateValues']['warehouseSelectable']) {
        routes.push(await this[routeField]);
      }
    }
    return {
      'routeIds': routes.map(route => [4, route.id])
    }
  }

  /**
   * Return information in order to update warehouse routes.
    - The key is a route field sotred as a Many2one on the warehouse
    - This key contains a dict with route values:
        - routing_key: a key used in order to match rules from
        get_rules_dict function. It would be usefull in order to generate
        the route's rules.
        - route_create_values: When the Many2one does not exist the route
        is created based on values contained in this dict.
        - route_update_values: When a field contained in 'depends' key is
        modified and the Many2one exist on the warehouse, the route will be
        update with the values contained in this dict.
        - rules_values: values added to the routing in order to create the
        route's rules.
   * @returns 
   */
  async _getRoutesValues() {
    const [active, receptionSteps, deliverySteps, companyId] = await this('active', 'receptionSteps', 'deliverySteps', 'companyId');
    return {
      'receptionRouteId': {
        'routingKey': receptionSteps,
        'depends': ['receptionSteps'],
        'routeUpdateValues': {
          'label': this._formatRoutename(null, receptionSteps),
          'active': active,
        },
        'routeCreateValues': {
          'productCategSelectable': true,
          'warehouseSelectable': true,
          'product_selectable': false,
          'companyId': companyId.id,
          'sequence': 9,
        },
        'rulesValues': {
          'active': true,
          'propagateCancel': true,
        }
      },
      'deliveryRouteId': {
        'routingKey': deliverySteps,
        'depends': ['deliverySteps'],
        'routeUpdateValues': {
          'label': this._formatRoutename(null, deliverySteps),
          'active': active,
        },
        'routeCreateValues': {
          'productCategSelectable': true,
          'warehouseSelectable': true,
          'productSelectable': false,
          'companyId': companyId.id,
          'sequence': 10,
        },
        'rulesValues': {
          'active': true,
          'propagateCarrier': true
        }
      },
      'crossdockRouteId': {
        'routingKey': 'crossdock',
        'depends': ['deliverySteps', 'receptionSteps'],
        'routeUpdateValues': {
          'label': this._formatRoutename(null, 'crossdock'),
          'active': receptionSteps !== 'oneStep' && deliverySteps !== 'shipOnly'
        },
        'routeCreateValues': {
          'productSelectable': true,
          'productCategSelectable': true,
          'active': deliverySteps !== 'shipOnly' && receptionSteps !== 'oneStep',
          'companyId': companyId.id,
          'sequence': 20,
        },
        'rulesValues': {
          'active': true,
          'procureMethod': 'makeToOrder'
        }
      }
    }
  }

  /**
   * Return receive route values with 'procure_method': 'make_to_order' in order to update warehouse routes.

    This function has the same receive route values as _get_routes_values with the addition of
    'procure_method': 'make_to_order' to the 'rules_values'. This is expected to be used by
    modules that extend stock and add actions that can trigger receive 'make_to_order' rules (i.e.
    we don't want any of the generated rules by get_rules_dict to default to 'make_to_stock').
    Additionally this is expected to be used in conjunction with _get_receive_rules_dict().

    args:
    installed_depends - string value of installed (warehouse) boolean to trigger updating of reception route.
   * @param installedDepends 
   */
  async _getReceiveRoutesValues(installedDepends) {
    return {
      'receptionRouteId': {
        'routingKey': await this['receptionSteps'],
        'depends': ['receptionSteps', installedDepends],
        'routeUpdateValues': {
          'label': await this._formatRoutename(null, await this['receptionSteps']),
          'active': await this['active'],
        },
        'routeCreateValues': {
          'productCategSelectable': true,
          'warehouseSelectable': true,
          'productSelectable': false,
          'companyId': (await this['companyId']).id,
          'sequence': 9,
        },
        'rulesValues': {
          'active': true,
          'propagateCancel': true,
          'procureMethod': 'makeToOrder',
        }
      }
    }
  }

  /**
   * This method will find existing rules or create new one.
   * @param rulesList 
   */
  async _findExistingRuleOrCreate(rulesList) {
    for (const ruleVals of rulesList) {
      const existingRule = await this.env.items('stock.rule').search([
        ['pickingTypeId', '=', ruleVals['pickingTypeId']],
        ['locationSrcId', '=', ruleVals['locationSrcId']],
        ['locationId', '=', ruleVals['locationId']],
        ['routeId', '=', ruleVals['routeId']],
        ['action', '=', ruleVals['action']],
        ['active', '=', false],
      ])
      if (!bool(existingRule)) {
        await this.env.items('stock.rule').create(ruleVals);
      }
      else {
        await existingRule.write({ 'active': true });
      }
    }
  }

  /**
   *  Update the warehouse locations.
   * @param vals 
   * @param code 
   */
  async _getLocationsValues(vals, code?: string) {
    const defValues = await this.defaultGet(['receptionSteps', 'deliverySteps']);
    const receptionSteps = vals['receptionSteps'] ?? defValues['receptionSteps'];
    const deliverySteps = vals['deliverySteps'] ?? defValues['deliverySteps'];
    code = vals['code'] || code || '';
    code = code.replace(' ', '').toUpperCase();
    const companyId = vals['companyId'] ?? (await this.defaultGet(['companyId']))['companyId'];
    const subLocations = {
      'lotStockId': {
        'label': await this._t('Stock'),
        'active': true,
        'usage': 'internal',
        'barcode': await this._validBarcode(code + '-STOCK', companyId)
      },
      'whInputStockLocId': {
        'label': await this._t('Input'),
        'active': receptionSteps !== 'oneStep',
        'usage': 'internal',
        'barcode': await this._validBarcode(code + '-INPUT', companyId)
      },
      'whQcStockLocId': {
        'label': await this._t('Quality Control'),
        'active': receptionSteps === 'threeSteps',
        'usage': 'internal',
        'barcode': await this._validBarcode(code + '-QUALITY', companyId)
      },
      'whOutputStockLocId': {
        'label': await this._t('Output'),
        'active': deliverySteps !== 'shipOnly',
        'usage': 'internal',
        'barcode': await this._validBarcode(code + '-OUTPUT', companyId)
      },
      'whPackStockLocId': {
        'label': await this._t('Packing Zone'),
        'active': deliverySteps === 'pickPackShip',
        'usage': 'internal',
        'barcode': await this._validBarcode(code + '-PACKING', companyId)
      },
    }
    return subLocations;
  }

  async _validBarcode(barcode, companyId) {
    const location = await (await this.env.items('stock.location').withContext({ activeTest: false })).search([
      ['barcode', '=', barcode],
      ['companyId', '=', companyId]
    ])
    return !bool(location) && barcode;
  }

  /**
   * It could happen that the user delete a mandatory location or a
    module with new locations was installed after some warehouses creation.
    In this case, this function will create missing locations in order to
    avoid mistakes during picking types and rules creation.
   * @param vals 
   */
  async _createMissingLocations(vals) {
    for (const warehouse of this) {
      const companyId = vals['companyId'] ?? (await warehouse.companyId).id;
      const subLocations = await warehouse._getLocationsValues(Object.assign({}, vals, { companyId: companyId }), await warehouse.code);
      const missingLocation = {};
      for (const [location, locationValues] of Object.entries(subLocations)) {
        if (! await warehouse[location] && !(location in vals)) {
          locationValues['locationId'] = vals['viewLocationId'] ?? (await warehouse.viewLocationId).id;
          locationValues['companyId'] = companyId;
          missingLocation[location] = (await this.env.items('stock.location').create(locationValues)).id;
        }
      }
      if (bool(missingLocation)) {
        await warehouse.write(missingLocation);
      }
    }
  }

  async createResupplyRoutes(supplierWarehouses) {
    const Route = this.env.items('stock.location.route');
    const Rule = this.env.items('stock.rule');

    let [inputLocation, outputLocation] = await this._getInputOutputLocations(await this['receptionSteps'], await this['deliverySteps']);
    const [internalTransitLocation, externalTransitLocation] = await this._getTransitLocations();

    for (const supplierWh of supplierWarehouses) {
      const transitLocation = (await supplierWh.companyId).eq(await this['companyId']) ? internalTransitLocation : externalTransitLocation;
      if (!bool(transitLocation)) {
        continue;
      }
      await transitLocation.set('active', true);
      const deliverySteps = await supplierWh.deliverySteps;
      outputLocation = deliverySteps === 'shipOnly' ? await supplierWh.lotStockId : await supplierWh.whOutputStockLocId;
      // Create extra MTO rule (only for 'ship only' because in the other cases MTO rules already exists)
      if (deliverySteps === 'shipOnly') {
        const routing = [Routing(outputLocation, transitLocation, await supplierWh.outTypeId, 'pull')];
        const mtoVals = (await supplierWh._getGlobalRouteRulesValues())['mtoPullId'];
        const values = mtoVals['createValues'];
        const mtoRuleVal = await supplierWh._getRuleValues(routing, values, 'MTO');
        await Rule.create(mtoRuleVal[0]);
      }

      const interWhRoute = await Route.create(this._getInterWarehouseRouteValues(supplierWh));

      let pullRulesList = await supplierWh._getSupplyPullRulesValues(
        [Routing(outputLocation, transitLocation, await supplierWh.outTypeId, 'pull')],
        { 'routeId': interWhRoute.id });
      extend(pullRulesList, await this._getSupplyPullRulesValues(
        [Routing(transitLocation, inputLocation, await this['inTypeId'], 'pull')],
        { 'routeId': interWhRoute.id, 'propagateWarehouseId': supplierWh.id }));
      // const promises = [];
      for (const pullRuleVals of pullRulesList) {
        await Rule.create(pullRuleVals);
      }
      // await Promise.all(promises);
    }
  }

  // Routing tools

  async _getInputOutputLocations(receptionSteps, deliverySteps) {
    return [receptionSteps === 'oneStep' ? await this['lotStockId'] : await this['whInputStockLocId'], deliverySteps === 'shipOnly' ? await this['lotStockId'] : await this['whOutputStockLocId']];
  }

  async _getTransitLocations() {
    const stockLocationInterWh = await this.env.ref('stock.stockLocationInterWh', false);
    return [await (await this['companyId']).internalTransitLocationId, bool(stockLocationInterWh) ? stockLocationInterWh : this.env.items('stock.location')];
  }

  /**
   * returns a tuple made of the browse record of customer location and the browse record of supplier location
   * @returns 
   */
  @api.model()
  async _getPartnerLocations() {
    const Location = this.env.items('stock.location');
    let customerLoc = await this.env.ref('stock.stockLocationCustomers', false);
    let supplierLoc = await this.env.ref('stock.stockLocationSuppliers', false);
    if (customerLoc.nok) {
      customerLoc = await Location.search([['usage', '=', 'customer']], { limit: 1 });
    }
    if (supplierLoc.nok) {
      supplierLoc = await Location.search([['usage', '=', 'supplier']], { limit: 1 });
    }
    if (customerLoc.nok && supplierLoc.nok) {
      throw new UserError(await this._t('Can\'t find any customer or supplier location.'));
    }
    return [customerLoc, supplierLoc];
  }

  async _getRouteName(routeType) {
    return String(await ROUTE_NAMES[routeType]);
  }

  /**
   * Define the rules source/destination locations, pickingType and
    action needed for each warehouse route configuration.
   * @returns 
   */
  async getRulesDict() {
    const [customerLoc, supplierLoc] = await this._getPartnerLocations();
    const res = {}
    for (const warehouse of this) {
      const [companyId, pickTypeId, lotStockId, inTypeId, intTypeId, whInputStockLocId, whQcStockLocId, whOutputStockLocId, outTypeId, whPackStockLocId, packTypeId] = await warehouse('companyId', 'pickTypeId', 'lotStockId', 'inTypeId', 'intTypeId', 'whInputStockLocId', 'whQcStockLocId', 'whOutputStockLocId', 'outTypeId', 'whPackStockLocId', 'packTypeId');
      res[warehouse.id] = {
        'oneStep': [Routing(supplierLoc, lotStockId, inTypeId, 'pull')],
        'twoSteps': [
          Routing(supplierLoc, whInputStockLocId, inTypeId, 'pull'),
          Routing(whInputStockLocId, lotStockId, intTypeId, 'pullPush')],
        'threeSteps': [
          Routing(supplierLoc, whInputStockLocId, inTypeId, 'pull'),
          Routing(whInputStockLocId, whQcStockLocId, intTypeId, 'pullPush'),
          Routing(whQcStockLocId, lotStockId, intTypeId, 'pullPush')],
        'crossdock': [
          Routing(whInputStockLocId, whOutputStockLocId, intTypeId, 'pull'),
          Routing(whOutputStockLocId, customerLoc, outTypeId, 'pull')],
        'shipOnly': [Routing(lotStockId, customerLoc, outTypeId, 'pull')],
        'pickShip': [
          Routing(lotStockId, whOutputStockLocId, pickTypeId, 'pull'),
          Routing(whOutputStockLocId, customerLoc, outTypeId, 'pull')],
        'pickPackShip': [
          Routing(lotStockId, whPackStockLocId, pickTypeId, 'pull'),
          Routing(whPackStockLocId, whOutputStockLocId, packTypeId, 'pull'),
          Routing(whOutputStockLocId, customerLoc, outTypeId, 'pull')],
        'companyId': companyId.id,
      }
    }
    return res;
  }

  /**
   * Return receive route rules without initial pull rule in order to update warehouse routes.

    This function has the same receive route rules as get_rules_dict without an initial pull rule.
    This is expected to be used by modules that extend stock and add actions that can trigger receive
    'make_to_order' rules (i.e. we don't expect the receive route to be able to pull on its own anymore).
    This is also expected to be used in conjuction with _get_receive_routes_values()
   * @returns 
   */
  async _getReceiveRulesDict() {
    const [intTypeId, lotStockId, whInputStockLocId, whQcStockLocId] = await this('intTypeId', 'lotStockId', 'whInputStockLocId', 'whQcStockLocId');
    return {
      'oneStep': [],
      'twoSteps': [Routing(whInputStockLocId, lotStockId, intTypeId, 'pullPush')],
      'threeSteps': [
        Routing(whInputStockLocId, whQcStockLocId, intTypeId, 'pullPush'),
        Routing(whQcStockLocId, lotStockId, intTypeId, 'pullPush')],
    }
  }

  async _getInterWarehouseRouteValues(supplierWarehouse) {
    return {
      'label': _f(await this._t('{warehouse}: Supply Product from {supplier}'), { warehouse: await this['label'], supplier: await supplierWarehouse.label }),
      'warehouseSelectable': true,
      'productSelectable': true,
      'productCategSelectable': true,
      'suppliedWhId': this.id,
      'supplierWhId': supplierWarehouse.id,
      'companyId': (await this['companyId']).id,
    }
  }

  // Pull / Push tools

  async _getRuleValues(routeValues, values?: any, nameSuffix = '') {
    let firstRule = true;
    const rulesList = [];
    for (const routing of routeValues) {
      const [fromLoc, destLoc, action, pickingType] = await routing('fromLoc', 'destLoc', 'action', 'pickingType');
      const routeRuleValues = {
        'label': await this._formatRulename(fromLoc, destLoc, nameSuffix),
        'locationSrcId': fromLoc.id,
        'locationId': destLoc.id,
        'action': action,
        'auto': 'manual',
        'pickingTypeId': pickingType.id,
        'procureMethod': firstRule ? 'makeToStock' : 'makeToOrder',
        'warehouseId': this.id,
        'companyId': (await this['companyId']).id,
      }
      update(routeRuleValues, values ?? {});
      rulesList.push(routeRuleValues);
      firstRule = false;
    }
    if (values && values['propagateCancel'] && rulesList.length) {
      // In case of rules chain with cancel propagation set, we need to stop
      // the cancellation for the last step in order to avoid cancelling
      // any other move after the chain.
      // Example: In the following flow:
      // Input -> Quality check -> Stock -> Customer
      // We want that cancelling I->GC cancel QC -> S but not S -> C
      // which means:
      // Input -> Quality check should have propagate_cancel = true
      // Quality check -> Stock should have propagate_cancel = false
      rulesList[rulesList.length - 1]['propagateCancel'] = false;
    }
    return rulesList;
  }

  async _getSupplyPullRulesValues(routeValues, values?: any) {
    const pullValues = {};
    update(pullValues, values);
    update(pullValues, { 'active': true });
    const rulesList = await this._getRuleValues(routeValues, pullValues);
    for (const pullRules of rulesList) {
      pullRules['procureMethod'] = (await this['lotStockId']).id !== pullRules['locationSrcId'] && 'makeToOrder' || 'makeToStock'  // first part of the resuply route is MTS
    }
    return rulesList;
  }

  /**
   * Check if we need to change something to resupply warehouses and associated MTO rules
   * @param receptionNew 
   * @param deliveryNew 
   */
  async _updateReceptionDeliveryResupply(receptionNew, deliveryNew) {
    for (const warehouse of this) {
      const [inputLoc, outputLoc] = await warehouse._getInputOutputLocations(receptionNew, deliveryNew);
      if (receptionNew && await warehouse.receptionSteps !== receptionNew && (await warehouse.receptionSteps === 'oneStep' || receptionNew === 'oneStep')) {
        await warehouse._checkReceptionResupply(inputLoc);
      }
      if (deliveryNew && await warehouse.deliverySteps !== deliveryNew && (await warehouse.deliverySteps === 'shipOnly' || deliveryNew === 'shipOnly')) {
        const changeToMultiple = await warehouse.deliverySteps === 'shipOnly';
        await warehouse._checkDeliveryResupply(outputLoc, changeToMultiple);
      }
    }
  }

  /**
   * Check if the resupply routes from this warehouse follow the changes of number of delivery steps
    Check routes being delivery bu this warehouse and change the rule going to transit location
   * @param newLocation 
   * @param changeToMultiple 
   */
  async _checkDeliveryResupply(newLocation, changeToMultiple) {
    const rule = this.env.items("stock.rule");
    const routes = await this.env.items('stock.location.route').search([['supplierWhId', '=', this.id]]);
    const rules = await rule.search(['&', '&', ['routeId', 'in', routes.ids], ['action', '!=', 'push'], ['locationId.usage', '=', 'transit']]);
    await rules.write({
      'locationSrcId': newLocation.id,
      'procureMethod': changeToMultiple && "makeToOrder" || "makeToStock"
    });
    if (!changeToMultiple) {
      // If single delivery we should create the necessary MTO rules for the resupply
      const routings = await (await rules.mapped('locationId')).map(async (location) => Routing(await this['lotStockId'], location, await this['outTypeId'], 'pull'));
      const mtoVals = (await this._getGlobalRouteRulesValues())['mtoPullId'];
      const values = mtoVals['createValues'];
      const mtoRuleVals = await this._getRuleValues(routings, values, 'MTO');

      for (const mtoRuleVal of mtoRuleVals) {
        await rule.create(mtoRuleVal);
      }
    }
    else {
      // We need to delete all the MTO stock rules, otherwise they risk to be used in the system
      await (await rule.search([
        '&', ['routeId', '=', (await this._findGlobalRoute('stock.routeWarehouse0Mto', await this._t('Make To Order'))).id],
        ['locationId.usage', '=', 'transit'],
        ['action', '!=', 'push'],
        ['locationSrcId', '=', (await this['lotStockId']).id]])).write({ 'active': false });
    }
  }

  /**
   * Check routes being delivered by the warehouses (resupply routes) and change their rule coming from the transit location
   * @param newLocation 
   */
  async _checkReceptionResupply(newLocation) {
    const routes = await this.env.items('stock.location.route').search([['suppliedWhId', 'in', this.ids]]);
    await (await this.env.items('stock.rule').search([
      '&',
      ['routeId', 'in', routes.ids],
      '&',
      ['action', '!=', 'push'],
      ['locationSrcId.usage', '=', 'transit']
    ])).write({ 'locationId': newLocation.id });
  }

  async _updateNameAndCode(newName?: string, newCode?: string) {
    if (newCode) {
      await (await (await this.mapped('lotStockId')).mapped('locationId')).write({ 'label': newCode });
    }
    if (newName) {
      // TDE FIXME: replacing the route name ? not better to re-generate the route naming ?
      for (const warehouse of this) {
        const routes = await warehouse.routeIds;
        for (const route of routes) {
          await route.write({ 'label': (await route.label).replace(await warehouse.label, newName, 1) });
          for (const pull of await route.ruleIds) {
            await pull.write({ 'label': (await pull.label).replace(await warehouse.label, newName, 1) });
          }
        }
        const mtoPullId = await warehouse.mtoPullId;
        if (mtoPullId.ok) {
          await mtoPullId.write({ 'label': (await mtoPullId.label).replace(await warehouse.label, newName, 1) });
        }
      }
    }
    for (let warehouse of this) {
      const sequenceData = await warehouse._getSequenceValues();
      // `ir.sequence` write access is limited to system user
      if (await this.userHasGroups('stock.groupStockManager')) {
        warehouse = await warehouse.sudo();
      }
      const [inTypeId, outTypeId, packTypeId, pickTypeId, intTypeId] = await warehouse('inTypeId', 'outTypeId', 'packTypeId', 'pickTypeId', 'intTypeId');
      await (await inTypeId.sequenceId).write(sequenceData['inTypeId']),
      await (await outTypeId.sequenceId).write(sequenceData['outTypeId']),
      await (await packTypeId.sequenceId).write(sequenceData['packTypeId']),
      await (await pickTypeId.sequenceId).write(sequenceData['pickTypeId']),
      await (await intTypeId.sequenceId).write(sequenceData['intTypeId'])
    }
  }

  async _updateLocationReception(newReceptionStep) {
    await (await this.mapped('whQcStockLocId')).write({ 'active': newReceptionStep === 'threeSteps' }),
    await (await this.mapped('whInputStockLocId')).write({ 'active': newReceptionStep !== 'oneStep' })
  }

  async _updateLocationDelivery(newDeliveryStep) {
    await (await this.mapped('whPackStockLocId')).write({ 'active': newDeliveryStep === 'pickPackShip' }),
    await (await this.mapped('whOutputStockLocId')).write({ 'active': newDeliveryStep !== 'shipOnly' })
  }

  // Misc

  /**
   * When a warehouse is created this method return the values needed in order to create the new picking types for this warehouse. Every picking type are created at the same time than the warehouse howver they are activated or archived depending the delivery_steps or reception_steps.
   * @param maxSequence 
   * @returns 
   */
  async _getPickingTypeCreateValues(maxSequence) {
    const [companyId, receptionSteps, deliverySteps, whPackStockLocId, lotStockId] = await this('companyId', 'receptionSteps', 'deliverySteps', 'whPackStockLocId', 'lotStockId');
    const [inputLoc, outputLoc] = await this._getInputOutputLocations(receptionSteps, deliverySteps);
    return [{
      'inTypeId': {
        'label': await this._t('Receipts'),
        'code': 'incoming',
        'useCreateLots': true,
        'useExistingLots': false,
        'defaultLocationSrcId': false,
        'sequence': maxSequence + 1,
        'showReserved': false,
        'showOperations': false,
        'sequenceCode': 'IN',
        'companyId': companyId.id,
      }, 'outTypeId': {
        'label': await this._t('Delivery Orders'),
        'code': 'outgoing',
        'useCreateLots': false,
        'useExistingLots': true,
        'defaultLocationDestId': false,
        'sequence': maxSequence + 5,
        'sequenceCode': 'OUT',
        'printLabel': true,
        'companyId': companyId.id,
      }, 'packTypeId': {
        'label': await this._t('Pack'),
        'code': 'internal',
        'useCreateLots': false,
        'useExistingLots': true,
        'defaultLocationSrcId': whPackStockLocId.id,
        'defaultLocationDestId': outputLoc.id,
        'sequence': maxSequence + 4,
        'sequenceCode': 'PACK',
        'companyId': companyId.id,
      }, 'pickTypeId': {
        'label': await this._t('Pick'),
        'code': 'internal',
        'useCreateLots': false,
        'useExistingLots': true,
        'defaultLocationSrcId': lotStockId.id,
        'sequence': maxSequence + 3,
        'sequenceCode': 'PICK',
        'companyId': companyId.id,
      }, 'intTypeId': {
        'label': await this._t('Internal Transfers'),
        'code': 'internal',
        'useCreateLots': false,
        'useExistingLots': true,
        'defaultLocationSrcId': lotStockId.id,
        'defaultLocationDestId': lotStockId.id,
        'active': receptionSteps !== 'oneStep' || deliverySteps !== 'shipOnly' || await this.userHasGroups('stock.groupStockMultiLocations'),
        'sequence': maxSequence + 2,
        'sequenceCode': 'INT',
        'companyId': companyId.id,
      }, 'returnTypeId': {
        'label': await this._t('Returns'),
        'code': 'incoming',
        'useCreateLots': false,
        'useExistingLots': true,
        'defaultLocationSrcId': false,
        'sequence': maxSequence + 6,
        'showReserved': true,
        'sequenceCode': 'IN',
        'companyId': companyId.id,
      },
    }, maxSequence + 6];
  }

  /**
   * Return values in order to update the existing picking type when the warehouse's delivery_steps or reception_steps are modify.
   * @returns 
   */
  async _getPickingTypeUpdateValues() {
    const [code, active, receptionSteps, deliverySteps, whPackStockLocId] = await this('code', 'active', 'receptionSteps', 'deliverySteps', 'whPackStockLocId');
    const [inputLoc, outputLoc] = await this._getInputOutputLocations(receptionSteps, deliverySteps)
    return {
      'inTypeId': {
        'defaultLocationDestId': inputLoc.id,
        'barcode': code.replace(" ", "").toUpperCase() + "-RECEIPTS",
      },
      'outTypeId': {
        'defaultLocationSrcId': outputLoc.id,
        'barcode': code.replace(" ", "").toUpperCase() + "-DELIVERY",
      },
      'pickTypeId': {
        'active': deliverySteps !== 'shipOnly' && active,
        'defaultLocationDestId': deliverySteps === 'pickShip' ? outputLoc.id : whPackStockLocId.id,
        'barcode': code.replace(" ", "").toUpperCase() + "-PICK",
      },
      'packTypeId': {
        'active': deliverySteps === 'pickPackShip' && active,
        'barcode': code.replace(" ", "").toUpperCase() + "-PACK",
      },
      'intTypeId': {
        'barcode': code.replace(" ", "").toUpperCase() + "-INTERNAL",
      },
      'returnTypeId': {
        'defaultLocationDestId': outputLoc.id,
        'barcode': code.replace(" ", "").toUpperCase() + "-RETURNS",
      },
    }
  }

  /**
   * Each picking type is created with a sequence. This method returns
    the sequence values associated to each picking type.
   * @returns 
   */
  async _getSequenceValues() {
    const [companyId, label, code] = await this('companyId', 'label', 'code');
    return {
      'inTypeId': {
        'label': label + ' ' + await this._t('Sequence in'),
        'prefix': code + '/IN/', 'padding': 5,
        'companyId': companyId.id,
      },
      'outTypeId': {
        'label': label + ' ' + await this._t('Sequence out'),
        'prefix': code + '/OUT/', 'padding': 5,
        'companyId': companyId.id,
      },
      'packTypeId': {
        'label': label + ' ' + await this._t('Sequence packing'),
        'prefix': code + '/PACK/', 'padding': 5,
        'companyId': companyId.id,
      },
      'pickTypeId': {
        'label': label + ' ' + await this._t('Sequence picking'),
        'prefix': code + '/PICK/', 'padding': 5,
        'companyId': companyId.id,
      },
      'intTypeId': {
        'label': label + ' ' + await this._t('Sequence internal'),
        'prefix': code + '/INT/', 'padding': 5,
        'companyId': companyId.id,
      },
      'returnTypeId': {
        'label': label + ' ' + await this._t('Sequence return'),
        'prefix': code + '/RET/', 'padding': 5,
        'companyId': companyId.id,
      },
    }
  }

  async _formatRulename(fromLoc, destLoc, suffix) {
    let rulename = f('%s: %s', await this['code'], await fromLoc['label']);
    if (bool(destLoc)) {
      rulename += f(' → %s', await destLoc['label']);
    }
    if (suffix) {
      rulename += ' (' + suffix + ')';
    }
    return rulename;
  }

  async _formatRoutename(name?: any, routeType?: any) {
    if (routeType) {
      name = await this._getRouteName(routeType);
    }
    return f('%s: %s', await this['label'], name);
  }

  @api.returns('self')
  async _getAllRoutes() {
    let routes = (await this.mapped('routeIds')).or(await (await this.mapped('mtoPullId')).mapped('routeId'));
    routes = routes.or(await this.env.items("stock.location.route").search([['suppliedWhId', 'in', this.ids]]));
    return routes;
  }

  async actionViewAllRoutes() {
    const routes = await this._getAllRoutes();
    return {
      'label': await this._t('Warehouse\'s Routes'),
      'domain': [['id', 'in', routes.ids]],
      'resModel': 'stock.location.route',
      'type': 'ir.actions.actwindow',
      'viewId': false,
      'viewMode': 'tree,form',
      'limit': 20,
      'context': Object.assign({}, this._context, { default_warehouseSelectable: true, default_warehouseIds: this.ids })
    }
  }
}