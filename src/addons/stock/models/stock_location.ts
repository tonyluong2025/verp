import _ from "lodash";
import { DateTime } from "luxon";
import * as calendar from "node-calendar";
import { Fields, _Date, api, tools } from "../../../core";
import { Dict, OrderedDict } from "../../../core/helper/collections";
import { UserError } from "../../../core/helper/errors";
import { MetaModel, Model, _super } from "../../../core/models";
import { expression } from "../../../core/osv";
import { bool } from "../../../core/tools/bool";
import { floatCompare } from "../../../core/tools/float_utils";
import { len } from "../../../core/tools/iterable";
import { f } from "../../../core/tools/utils";

@MetaModel.define()
class Location extends Model {
  static _module = module;
  static _name = "stock.location";
  static _description = "Inventory Locations";
  static _parentName = "locationId";
  static _parentStore = true;
  static _order = 'completeName';
  static _recName = 'completeName';
  static _checkCompanyAuto = true;

  @api.model()
  async defaultGet(fields) {
    const res = await _super(Location, this).defaultGet(fields);
    if ('barcode' in fields && !('barcode' in res) && res.get('completeName')) {
      res['barcode'] = res['completeName'];
    }
    return res;
  }

  static label = Fields.Char('Location Name', { required: true });
  static completeName = Fields.Char("Full Location Name", { compute: '_computeCompleteName', recursive: true, store: true });
  static active = Fields.Boolean('Active', { default: true, help: "By unchecking the active field, you may hide a location without deleting it." });
  static usage = Fields.Selection([
    ['supplier', 'Vendor Location'],
    ['view', 'View'],
    ['internal', 'Internal Location'],
    ['customer', 'Customer Location'],
    ['inventory', 'Inventory Loss'],
    ['production', 'Production'],
    ['transit', 'Transit Location']], {
    string: 'Location Type',
    default: 'internal', index: true, required: true,
    help: ["* Vendor Location: Virtual location representing the source location for products coming from your vendors",
      "\n* View: Virtual location used to create a hierarchical structures for your warehouse, aggregating its child locations ; can't directly contain products",
      "\n* Internal Location: Physical locations inside your own warehouses,",
      "\n* Customer Location: Virtual location representing the destination location for products sent to your customers",
      "\n* Inventory Loss: Virtual location serving as counterpart for inventory operations used to correct stock levels (Physical inventories)",
      "\n* Production: Virtual counterpart location for production operations: this location consumes the components and produces finished products",
      "\n* Transit Location: Counterpart location that should be used in inter-company or inter-warehouses operations"].join('')
  });
  static locationId = Fields.Many2one(
    'stock.location', {
    string: 'Parent Location', index: true, ondelete: 'CASCADE', checkCompany: true,
    help: "The parent location that includes this location. Example : The 'Dispatch Zone' is the 'Gate 1' parent location."
  });
  static childIds = Fields.One2many('stock.location', 'locationId', { string: 'Contains' });
  static childInternalLocationIds = Fields.Many2many(
    'stock.location', { string: 'Internal locations amoung descendants', compute: '_computeChildInternalLocationIds', recursive: true, help: 'This location (if it\'s internal) and all its descendants filtered by type=Internal.' });
  static comment = Fields.Html('Additional Information');
  static posx = Fields.Integer('Corridor (X)', { default: 0, help: "Optional localization details, for information purpose only" });
  static posy = Fields.Integer('Shelves (Y)', { default: 0, help: "Optional localization details, for information purpose only" });
  static posz = Fields.Integer('Height (Z)', { default: 0, help: "Optional localization details, for information purpose only" });
  static parentPath = Fields.Char({ index: true });
  static companyId = Fields.Many2one(
    'res.company', { string: 'Company', default: self => self.env.company(), index: true, help: 'Let this field empty if this location is shared between companies' });
  static scrapLocation = Fields.Boolean('Is a Scrap Location?', { default: false, help: 'Check this box to allow using this location to put scrapped/damaged goods.' });
  static returnLocation = Fields.Boolean('Is a Return Location?', { help: 'Check this box to allow using this location as a return location.' });
  static removalStrategyId = Fields.Many2one('product.removal', { string: 'Removal Strategy', help: "Defines the default method used for suggesting the exact location (shelf) where to take the products from, which lot etc. for this location. This method can be enforced at the product category level, and a fallback is made on the parent locations if none is set here." });
  static putawayRuleIds = Fields.One2many('stock.putaway.rule', 'locationInId', { string: 'Putaway Rules' });
  static barcode = Fields.Char('Barcode', { copy: false });
  static quantIds = Fields.One2many('stock.quant', 'locationId');
  static cyclicInventoryFrequency = Fields.Integer("Inventory Frequency (Days)", { default: 0, help: " When different than 0, inventory count date for products stored at this location will be automatically set at the defined frequency." });
  static lastInventoryDate = Fields.Date("Last Effective Inventory", { readonly: true, help: "Date of the last inventory at this location." });
  static nextInventoryDate = Fields.Date("Next Expected Inventory", { compute: "_computeNextInventoryDate", store: true, help: "Date for next planned inventory based on cyclic schedule." });
  static warehouseViewIds = Fields.One2many('stock.warehouse', 'viewLocationId', { readonly: true });
  static warehouseId = Fields.Many2one('stock.warehouse', { compute: '_computeWarehouseId' });
  static storageCategoryId = Fields.Many2one('stock.storage.category', { string: 'Storage Category' });
  static outgoingMoveLineIds = Fields.One2many('stock.move.line', 'locationId', { help: 'Technical: used to compute weight.' });
  static incomingMoveLineIds = Fields.One2many('stock.move.line', 'locationDestId', { help: 'Technical: used to compute weight.' });
  static netWeight = Fields.Float('Net Weight', { compute: "_computeWeight" });
  static forecastWeight = Fields.Float('Forecasted Weight', { compute: "_computeWeight" });

  static _sqlConstraints = [['barcodeCompanyUniq', 'unique (barcode,"companyId")', 'The barcode for a location must be unique per company !'], ['inventoryFreqNonneg', 'check("cyclicInventoryFrequency" >= 0)', 'The inventory frequency (days) for a location must be non-negative']];

  @api.depends('outgoingMoveLineIds.productQty', 'incomingMoveLineIds.productQty', 'outgoingMoveLineIds.state', 'incomingMoveLineIds.state', 'outgoingMoveLineIds.productId.weight', 'outgoingMoveLineIds.productId.weight', 'quantIds.quantity', 'quantIds.productId.weight')
  async _computeWeight() {
    for (const location of this) {
      await location.set('netWeight', 0);
      const quants = await (await location.quantIds).filtered(async (q) => await (await q.productId).type !== 'service');
      const incomingMoveLines = await (await location.incomingMoveLineIds).filtered(async (ml) => await (await ml.productId).type !== 'service' && !['draft', 'done', 'cancel'].includes(await ml.state));
      const outgoingMoveLines = await (await location.outgoingMoveLineIds).filtered(async (ml) => await (await ml.productId).type !== 'service' && !['draft', 'done', 'cancel'].includes(await ml.state));
      for (const quant of quants) {
        await location.set('netWeight', await location.netWeight + (await (await quant.productId).weight) * (await quant.quantity));
      }
      await location.set('forecastWeight', await location.netWeight)
      for (const line of incomingMoveLines) {
        await location.set('forecastWeight', await location.forecastWeight + (await (await line.productId).weight) * (await line.productQty));
      }
      for (const line of outgoingMoveLines) {
        await location.set('forecastWeight', await location.forecastWeight - (await (await line.productId).weight) * (await line.productQty));
      }
    }
  }

  @api.depends('label', 'locationId.completeName', 'usage')
  async _computeCompleteName() {
    for (const location of this) {
      if (bool(await location.locationId) && await location.usage !== 'view') {
        await location.set('completeName', f('%s/%s', await (await location.locationId).completeName, await location.label));
      }
      else {
        await location.set('completeName', await location.label);
      }
    }
  }

  @api.depends('cyclicInventoryFrequency', 'lastInventoryDate', 'usage', 'companyId')
  async _computeNextInventoryDate() {
    for (const location of this) {
      const cyclicInventoryFrequency = await location.cyclicInventoryFrequency;
      if (bool(await location.companyId) && ['internal', 'transit'].includes(await location.usage) && cyclicInventoryFrequency > 0) {
        try {
          const today = _Date.today();
          const lastInventoryDate = await location.lastInventoryDate;
          if (lastInventoryDate) {
            const daysUntilNextInventory = cyclicInventoryFrequency - DateTime.fromJSDate(today).diff(DateTime.fromJSDate(lastInventoryDate), 'days').days;
            if (daysUntilNextInventory <= 0) {
              await location.set('nextInventoryDate', DateTime.fromJSDate(today).plus({ days: 1 }).toJSDate());
            }
            else {
              await location.set('nextInventoryDate', DateTime.fromJSDate(lastInventoryDate).plus({ days: daysUntilNextInventory }));
            }
          }
          else {
            await location.set('nextInventoryDate', DateTime.fromJSDate(today).plus({ days: cyclicInventoryFrequency }));
          }
        } catch (e) {
          // except OverflowError:
          throw new UserError(await this._t("The selected Inventory Frequency (Days) creates a date too far into the future."));
        }
      }
      else {
        await location.set('nextInventoryDate', false);
      }
    }
  }

  @api.depends('warehouseViewIds')
  async _computeWarehouseId() {
    const warehouses = await this.env.items('stock.warehouse').search([['viewLocationId', 'parentOf', this.ids]]);
    const viewByWh = new OrderedDict<any>();
    for (const wh of warehouses) {
      viewByWh[(await wh.viewLocationId).id] = wh.id;
    }
    await this.set('warehouseId', false);
    for (const loc of this) {
      const path = new Set((await loc.parentPath).split('/').slice(0, -1).map(locId => tools.parseInt(locId)));
      for (const viewLocationId of viewByWh.keys()) {
        if (path.has(viewLocationId)) {
          await loc.set('warehouseId', viewByWh[viewLocationId]);
          break
        }
      }
    }
  }

  @api.depends('childIds.usage', 'childIds.childInternalLocationIds')
  async _computeChildInternalLocationIds() {
    // batch reading optimization is not possible because the field has recursive: true
    for (const loc of this) {
      await loc.set('childInternalLocationIds', await this.search([['id', 'childOf', loc.id], ['usage', '=', 'internal']]));
    }
  }

  @api.onchange('usage')
  async _onchangeUsage() {
    if (!['internal', 'inventory'].includes(await this['usage'])) {
      await this.set('scrapLocation', false);
    }
  }

  async write(values) {
    if ('companyId' in values) {
      for (const location of this) {
        if ((await location.companyId).id != values['companyId']) {
          throw new UserError(await this._t("Changing the company of this record is forbidden at this point, you should rather archive it and create a new one."))
        }
      }
    }
    if ('usage' in values && values['usage'] === 'view') {
      if (bool(await this.mapped('quantIds'))) {
        throw new UserError(await this._t("This location's usage cannot be changed to view as it contains products."))
      }
    }
    if ('usage' in values || 'scrapLocation' in values) {
      const modifiedLocations = await this.filtered(async (l) => ['usage', 'scrapLocation'].some(async (f) => await l[f] !== f in values ? values[f] : false));
      const reservedQuantities = await this.env.items('stock.move.line').searchCount([
        ['locationId', 'in', modifiedLocations.ids],
        ['productQty', '>', 0],
      ]);
      if (bool(reservedQuantities)) {
        throw new UserError(await this._t(
          "You cannot change the location type or its use as a scrap location as there are products reserved in this location. Please unreserve the products first."
        ));
      }
    }
    if ('active' in values) {
      if (values['active'] == false) {
        for (const location of this) {
          const warehouses = await this.env.items('stock.warehouse').search([['active', '=', true], '|', ['lotStockId', '=', location.id], ['viewLocationId', '=', location.id]]);
          if (bool(warehouses)) {
            throw new UserError(await this._t("You cannot archive the location %s as it is used by your warehouse %s", await location.displayName, await warehouses(0).displayName));
          }
        }
      }
      if (!this.env.context['doNotCheckQuant']) {
        const childrenLocation = await (await this.env.items('stock.location').withContext({ activeTest: false })).search([['id', 'childOf', this.ids]]);
        const internalChildrenLocations = await childrenLocation.filtered(async (l) => await l.usage === 'internal');
        const childrenQuants = await this.env.items('stock.quant').search(['&', '|', ['quantity', '!=', 0], ['reservedQuantity', '!=', 0], ['locationId', 'in', internalChildrenLocations.ids]]);
        if (bool(childrenQuants) && values['active'] === false) {
          throw new UserError(await this._t('You still have some product in locations %s', (await childrenQuants.mapped('locationId.displayName')).join(', ')));
        }
        else {
          await (await _super(Location, childrenLocation.sub(this)).withContext({ doNotCheckQuant: true })).write({
            'active': values['active'],
          });
        }
      }
    }
    const res = await _super(Location, this).write(values);
    this.invalidateCache(['warehouseId']);
    return res;
  }

  @api.modelCreateMulti()
  async create(valsList) {
    const res = await _super(Location, this).create(valsList);
    this.invalidateCache(['warehouseId']);
    return res;
  }

  /**
   * search full name and barcode
   * @param name 
   * @param args 
   * @param operator 
   * @param options 
   */
  @api.model()
  async _nameSearch(name, args?: any, operator: string = 'ilike', { limit=100, nameGetUid=false } = {}) {
    args = args ?? [];
    let domain;
    if (operator === 'ilike' && !(name || '').trim()) {
      domain = [];
    }
    else if (expression.NEGATIVE_TERM_OPERATORS.includes(operator)) {
      domain = [['barcode', operator, name], ['complete_name', operator, name]];
    }
    else {
      domain = ['|', ['barcode', operator, name], ['completeName', operator, name]];
    }
    return this._search(expression.AND([domain, args]), { limit, accessRightsUid: nameGetUid });
  }

  /**
   * Returns the location where the product has to be put, if any compliant putaway strategy is found. Otherwise returns self.
      The quantity should be in the default UOM of the product, it is used when no package is specified.
   * @param product 
   * @param quantity 
   * @param pack 
   * @param packaging 
   * @returns 
   */
  async _getPutawayStrategy(product, quantity: number = 0, pack?: any, packaging?: any) {
    // find package type on package or packaging
    let packageType = this.env.items('stock.package.type');
    if (pack) {
      packageType = await pack.packageTypeId;
    }
    else if (packaging) {
      packageType = await packaging.packageTypeId;
    }
    let putawayRules = this.env.items('stock.putaway.rule');
    putawayRules = putawayRules.or(await (await this['putawayRuleIds']).filtered(async (x) => (await x.productId).eq(product) && ((await x.packageTypeIds).includes(packageType) || packageType.eq(x.packageTypeIds))));
    let categ = await product.categId;
    while (bool(categ)) {
      putawayRules = putawayRules.or(await (await this['putawayRuleIds']).filtered(async (x) => (await x.categoryId).eq(categ) && ((await x.packageTypeIds).includes(packageType) || packageType.eq(await x.packageTypeIds))));
      categ = await categ.parentId;
    }
    if (bool(packageType)) {
      putawayRules = putawayRules.or(await (await this['putawayRuleIds']).filtered(async (x) => !bool(await x.productId) && ((await x.packageTypeIds).includes(packageType) || packageType.eq(await x.packageTypeIds))));
    }

    // get current product qty (qty in current quants and future qty on assigned ml) of all child locations
    const qtyByLocation = new Dict<any>();// defaultdict(() => 0)
    const locations = await this['childInternalLocationIds'];
    if (bool(await locations.storageCategoryId)) {
      const moveLineData = await this.env.items('stock.move.line').readGroup([
        ['productId', '=', product.id],
        ['locationDestId', 'in', locations.ids],
        ['state', 'not in', ['draft', 'done', 'cancel']]
      ], ['locationDestId', 'productId', 'productQty:array_agg', 'qtyDone:array_agg', 'productUomId:array_agg'], ['locationDestId']);
      const quantData = await this.env.items('stock.quant').readGroup([
        ['productId', '=', product.id],
        ['locationId', 'in', locations.ids],
      ], ['locationId', 'productId', 'quantity:sum'], ['locationId']);

      for (const values of moveLineData) {
        const uoms = this.env.items('uom.uom').browse(values['productUomId']);
        let qtyDone = 0.0;
        for (const [qtyReserved, qty, mlUom] of _.zip<any>(values['productQty'], values['qtyDone'], [...uoms])) {
          qtyDone += Math.max(await mlUom._computeQuantity(parseFloat(qty), await product.uomId), parseFloat(qtyReserved));
        }
        qtyByLocation[values['locationDestId'][0]] = qtyDone;
      }
      for (const values of quantData) {
        qtyByLocation[values['locationId'][0]] += values['quantity'];
      }
    }
    let putawayLocation = await putawayRules._getPutawayLocation(product, quantity, pack, qtyByLocation);
    if (!bool(putawayLocation)) {
      putawayLocation = locations && await this['usage'] === 'view' ? locations[0] : this;
    }

    return putawayLocation;
  }

  /**
   * Used to get the next inventory date for a quant located in this location. It is
      based on:
      1. Does the location have a cyclic inventory set?
      2. If not 1, then is there an annual inventory date set (for its company)?
      3. If not 1 and 2, then quants have no next inventory date.
   * @returns 
   */
  async _getNextInventoryDate() {
    if (!['internal', 'transit'].includes(await this['usage'])) {
      return false;
    }
    let nextInventoryDate;
    const thisNextInventoryDate = await this['nextInventoryDate'];
    if (thisNextInventoryDate) {
      nextInventoryDate = thisNextInventoryDate;
    }
    else {
      const companyId = await this['companyId'];
      if (await companyId.annualInventoryMonth) {
        const today = _Date.today();
        const annualInventoryMonth = tools.parseInt(await companyId.annualInventoryMonth);
        // Manage 0 and negative annual_inventory_day
        let annualInventoryDay = Math.max(await companyId.annualInventoryDay, 1);
        let maxDay = calendar.monthrange(today.getFullYear(), annualInventoryMonth)[1];
        // Manage annual_inventory_day bigger than last_day
        annualInventoryDay = Math.min(annualInventoryDay, maxDay);
        nextInventoryDate = DateTime.fromJSDate(today).set({ month: annualInventoryMonth, day: annualInventoryDay }).toISODate();
        if (nextInventoryDate <= today) {
          // Manage leap year with the february
          maxDay = calendar.monthrange(today.getFullYear() + 1, annualInventoryMonth)[1];
          annualInventoryDay = Math.min(annualInventoryDay, maxDay);
          nextInventoryDate = DateTime.fromJSDate(nextInventoryDate).set({ day: annualInventoryDay, year: today.getFullYear() + 1 });
        }
      }
    }
    return nextInventoryDate;
  }

  async shouldBypassReservation() {
    this.ensureOne();
    return ['supplier', 'customer', 'inventory', 'production'].includes(await this['usage']) || await this['scrapLocation'] || (await this['usage'] === 'transit' && !bool(await this['companyId']));
  }

  /**
   * Check if product/package can be stored in the location. Quantity
      should in the default uom of product, it's only used when no package is
      specified.
   * @param product 
   * @param quantity 
   * @param pack 
   * @param locationQty 
   * @returns 
   */
  async _checkCanBeUsed(product, quantity: number = 0, pack?: any, locationQty: number = 0) {
    this.ensureOne();
    if (pack && bool(await pack.packageTypeId)) {
      return this._checkPackageStorage(product, pack);
    }
    return this._checkProductStorage(product, quantity, locationQty);
  }

  /**
   * Check if a number of product can be stored in the location. Quantity
      should in the default uom of product.
   * @param product 
   * @param quantity 
   * @param locationQty 
   * @returns 
   */
  async _checkProductStorage(product, quantity, locationQty) {
    this.ensureOne();
    const storageCategoryId = await this['storageCategoryId'];
    if (bool(storageCategoryId)) {
      // check weight
      if (await storageCategoryId.maxWeight < (await this['forecastWeight']) + (await product.weight) * quantity) {
        return false;
      }
      // check if only allow new product when empty
      let some;
      for (const q of await this['quantIds']) {
        if (floatCompare(q.quantity, 0, { precisionRounding: await (await (await q.productId).uomId).rounding }) > 0) {
          some = true;
          break;
        }
      }
      if (await storageCategoryId.allowNewProduct === "empty" && some) {
        return false;
      }
      // check if only allow same product
      const quantIds = await this['quantIds'];
      if (await storageCategoryId.allowNewProduct === "same" && quantIds && !(await quantIds.productId).eq(product)) {
        return false;
      }

      // check if enough space
      const productCapacity = await (await storageCategoryId.productCapacityIds).filtered(async (pc) => (await pc.productId).eq(product));
      // To handle new line without quantity in order to avoid suggesting a location already full
      if (bool(productCapacity) && locationQty >= await productCapacity.quantity) {
        return false;
      }
      if (bool(productCapacity) && quantity + locationQty > await productCapacity.quantity) {
        return false;
      }
    }
    return true;
  }

  /**
   * Check if the given package can be stored in the location.
   * @param product 
   * @param package 
   * @returns 
   */
  async _checkPackageStorage(product, pack) {
    this.ensureOne();
    const storageCategoryId = await this['storageCategoryId'];
    if (bool(storageCategoryId)) {
      // check weight
      if (await storageCategoryId.maxWeight < (await this['forecastWeight']) + await (await pack.packageTypeId).maxWeight) {
        return false;
      }
      // check if only allow new product when empty
      const quantIds = await this['quantIds'];
      let some;
      for (const q of quantIds) {
        if (floatCompare(q.quantity, 0, { precisionRounding: await (await (await q.productId).uomId).rounding }) > 0) {
          some = true;
          break;
        }
      }
      if (await storageCategoryId.allowNewProduct === "empty" && some) {
        return false;
      }
      // check if only allow same product
      if (await storageCategoryId.allowNewProduct === "same" && bool(quantIds) && !(await quantIds.productId).eq(product)) {
        return false;
      }
      // check if enough space
      const packageCapacity = await (await storageCategoryId.packageCapacityIds).filtered(async (pc) => (await pc.packageTypeId).eq(await pack.packageTypeId));
      if (bool(packageCapacity)) {
        const packageNumber = len(await (await quantIds.packageId).filtered(async (q) => (await q.packageTypeId).eq(await pack.packageTypeId)));
        if (packageNumber >= await packageCapacity.quantity) {
          return false;
        }
      }
    }
    return true;
  }
}

@MetaModel.define()
class Route extends Model {
  static _module = module;
  static _name = 'stock.location.route';
  static _description = "Inventory Routes";
  static _order = 'sequence';
  static _checkCompanyAuto = true;

  static label = Fields.Char('Route', { required: true, translate: true });
  static active = Fields.Boolean('Active', { default: true, help: "If the active field is set to false, it will allow you to hide the route without removing it." });
  static sequence = Fields.Integer('Sequence', { default: 0 });
  static ruleIds = Fields.One2many('stock.rule', 'routeId', { string: 'Rules', copy: true });
  static productSelectable = Fields.Boolean('Applicable on Product', { default: true, help: "When checked, the route will be selectable in the Inventory tab of the Product form." });
  static productCategSelectable = Fields.Boolean('Applicable on Product Category', { help: "When checked, the route will be selectable on the Product Category." });
  static warehouseSelectable = Fields.Boolean('Applicable on Warehouse', { help: "When a warehouse is selected for this route, this route should be seen as the default route when products pass through this warehouse." });
  static packagingSelectable = Fields.Boolean('Applicable on Packaging', { help: "When checked, the route will be selectable on the Product Packaging." });
  static suppliedWhId = Fields.Many2one('stock.warehouse', { string: 'Supplied Warehouse' });
  static supplierWhId = Fields.Many2one('stock.warehouse', { string: 'Supplying Warehouse' });
  static companyId = Fields.Many2one(
    'res.company', {
      string: 'Company',
    default: self => self.env.company(), index: true,
    help: 'Leave this field empty if this route is shared between all companies'
  });
  static productIds = Fields.Many2many(
    'product.template', { relation: 'stockRouteProduct', column1: 'routeId', column2: 'productId', string: 'Products', copy: false, checkCompany: true });
  static categIds = Fields.Many2many('product.category', { relation: 'stockLocationRouteCateg', column1: 'routeId', column2: 'categId', string: 'Product Categories', copy: false });
  static packagingIds = Fields.Many2many('product.packaging', { relation: 'stockLocationRoutePackaging', column1: 'routeId', column2: 'packagingId', string: 'Packagings', copy: false, checkCompany: true });
  static warehouseDomainIds = Fields.One2many('stock.warehouse', { compute: '_computeWarehouses' });
  static warehouseIds = Fields.Many2many(
    'stock.warehouse', { relation: 'stockRouteWarehouse', column1: 'routeId', column2: 'warehouseId', string: 'Warehouses', copy: false, domain: "[['id', 'in', warehouseDomainIds]]" });

  @api.depends('companyId')
  async _computeWarehouses() {
    for (const loc of this) {
      const companyId = await loc.companyId;
      const domain = companyId.ok ? [['companyId', '=', companyId.id]] : [];
      await loc.set('warehouseDomainIds', await this.env.items('stock.warehouse').search(domain));
    }
  }

  @api.onchange('companyId')
  async _onchangeCompany() {
    const companyId = await this['companyId'];
    if (bool(companyId)) {
      await this.set('warehouseIds', await (await this['warehouseIds']).filtered(async (w) => (await w.companyId).eq(companyId)));
    }
  }

  @api.onchange('warehouseSelectable')
  async _onchangeWarehouseSelectable() {
    if (! await this['warehouseSelectable']) {
      await this.set('warehouseIds', [[5, 0, 0]]);
    }
  }

  async toggleActive() {
    for (const route of this) {
      await (await (await (await route.withContext({ activeTest: false })).ruleIds).filtered(async (ru) => await ru.active == await route.active)).toggleActive();
    }
    await _super(Route, this).toggleActive();
  }
}