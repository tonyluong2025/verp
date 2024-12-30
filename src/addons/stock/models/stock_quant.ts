import { api } from "../../../core";
import { Fields, _Date, _Datetime } from "../../../core/fields";
import { MapKey } from "../../../core/helper";
import { UserError, ValidationError } from "../../../core/helper/errors";
import { MetaModel, Model, _super } from "../../../core/models";
import { expression } from "../../../core/osv";
import { bool } from "../../../core/tools/bool";
import { dateMin } from "../../../core/tools/date_utils";
import { floatCompare, floatIsZero } from "../../../core/tools/float_utils";
import { sum } from "../../../core/tools/iterable";
import { pop, update } from "../../../core/tools/misc";
import { f } from "../../../core/tools/utils";

@MetaModel.define()
class StockQuant extends Model {
  static _module = module;
  static _name = 'stock.quant';
  static _description = 'Quants';
  static _recName = 'productId';

  async _domainLocationId() {
    if (! await this._isInventoryMode()) {
      return;
    }
    return [['usage', 'in', ['internal', 'transit']]];
  }

  async _domainLotId() {
    if (! await this._isInventoryMode()) {
      return;
    }
    const domain = [
      "'|'",
      "['companyId', '=', companyId]",
      "['companyId', '=', false]"
    ]
    if (this.env.context['activeModel'] === 'product.product') {
      domain.unshift(f("['productId', '=', %s]", this.env.context['activeId']));
    }
    else if (this.env.context['activeModel'] === 'product.template') {
      const productTemplate = this.env.items('product.template').browse(this.env.context['activeId']);
      if (bool(productTemplate.exists())) {
        domain.unshift(f("['productId', 'in', %s]", (await productTemplate.productVariantIds).ids));
      }
    }
    else {
      domain.unshift("['productId', '=', productId]");
    }
    return '[' + domain.join(', ') + ']';
  }

  async _domainProductId() {
    if (! await this._isInventoryMode()) {
      return;
    }
    let domain = [['type', '=', 'product']];
    if (bool(this.env.context['productTemplateIds']) ?? this.env.context['productTemplateId']) {
      const products = (this.env.context['productTemplateIds'] ?? []).concat([this.env.context['productTemplateId'] || 0]);
      domain = expression.AND([domain, [['productTemplateId', 'in', products]]]);
    }
    return domain;
  }

  static productId = Fields.Many2one(
    'product.product', {
    string: 'Product',
    domain: (self) => self._domainProductId(),
    ondelete: 'RESTRICT', required: true, index: true, checkCompany: true
  });
  static productTemplateId = Fields.Many2one(
    'product.template', {
    string: 'Product Template',
    related: 'productId.productTemplateId'
  });
  static productUomId = Fields.Many2one(
    'uom.uom', {
    string: 'Unit of Measure',
    readonly: true, related: 'productId.uomId'
  });
  static companyId = Fields.Many2one({ related: 'locationId.companyId', string: 'Company', store: true, readonly: true });
  static locationId = Fields.Many2one(
    'stock.location', {
    string: 'Location',
    domain: (self) => self._domainLocationId(),
    autojoin: true, ondelete: 'RESTRICT', required: true, index: true, checkCompany: true
  });
  static lotId = Fields.Many2one(
    'stock.production.lot', {
    string: 'Lot/Serial Number', index: true, ondelete: 'RESTRICT', checkCompany: true,
    domain: (self) => self._domainLotId()
  });
  static packageId = Fields.Many2one(
    'stock.quant.package', {
    string: 'Package',
    domain: "[['locationId', '=', locationId]]",
    help: 'The package containing this quant', ondelete: 'RESTRICT', checkCompany: true
  });
  static ownerId = Fields.Many2one(
    'res.partner', {
    string: 'Owner',
    help: 'This is the owner of the quant', checkCompany: true
  });
  static quantity = Fields.Float(
    'Quantity',
    {
      help: 'Quantity of products in this quant, in the default unit of measure of the product',
      readonly: true
    })
  static reservedQuantity = Fields.Float(
    'Reserved Quantity', {
    default: 0.0,
    help: 'Quantity of reserved products in this quant, in the default unit of measure of the product',
    readonly: true, required: true
  });
  static availableQuantity = Fields.Float(
    'Available Quantity', {
    help: "On hand quantity which hasn't been reserved on a transfer, in the default unit of measure of the product",
    compute: '_computeAvailableQuantity'
  });
  static inDate = Fields.Datetime('Incoming Date', { readonly: true, required: true, default: () => _Datetime.now() });
  static tracking = Fields.Selection({ related: 'productId.tracking', readonly: true });
  static onHand = Fields.Boolean('On Hand', { store: false, search: '_searchOnHand' });
  static productCategId = Fields.Many2one({ related: 'productTemplateId.categId' });

  // Inventory Fields
  static inventoryQuantity = Fields.Float(
    'Counted Quantity', {
    digits: 'Product Unit of Measure',
    help: "The product's counted quantity."
  });
  static inventoryQuantityAutoApply = Fields.Float(
    'Inventoried Quantity', { compute: '_computeInventoryQuantityAutoApply', inverse: '_setInventoryQuantity', groups: 'stock.groupStockManager' });
  static inventoryDiffQuantity = Fields.Float(
    'Difference', {
    compute: '_computeInventoryDiffQuantity', store: true, help: "Indicates the gap between the product's theoretical quantity and its counted quantity.",
    readonly: true, digits: 'Product Unit of Measure'
  });
  static inventoryDate = Fields.Date(
    'Scheduled Date', { compute: '_computeInventoryDate', store: true, readonly: false, help: "Next date the On Hand Quantity should be counted." });
  static inventoryQuantitySet = Fields.Boolean()  // Only used for UI purposes in the Inventory Adjustment page
  static isOutdated = Fields.Boolean('Quantity has been moved since last count', { compute: '_computeIsOutdated' });
  static userId = Fields.Many2one(
    'res.users', { string: 'Assigned To', help: "User assigned to do product count." });

  @api.depends('quantity', 'reservedQuantity')
  async _computeAvailableQuantity() {
    for (const quant of this) {
      await quant.set('availableQuantity', await quant.quantity - await quant.reservedQuantity);
    }
  }

  @api.depends('locationId')
  async _computeInventoryDate() {
    const quants = await this.filtered(async (q) => !q.inventoryDate && ['internal', 'transit'].includes(await (await q.locationId).usage));
    const dateByLocation = {};
    for (const loc of await quants.locationId) {
      dateByLocation[loc] = await loc._getNextInventoryDate();
    }
    for (const quant of quants) {
      await quant.set('inventoryDate', dateByLocation[await quant.locationId]);
    }
  }

  @api.depends('inventoryQuantity')
  async _computeInventoryDiffQuantity() {
    for (const quant of this) {
      // await Promise.all([
        await quant.set('inventoryQuantitySet', true),
        await quant.set('inventoryDiffQuantity', await quant.inventoryQuantity - await quant.quantity)
      // ]);
    }
  }

  @api.depends('inventoryQuantity', 'quantity', 'productId')
  async _computeIsOutdated() {
    await this.set('isOutdated', false);
    for (const quant of this) {
      if (await quant.productId && floatCompare(await quant.inventoryQuantity - await quant.inventoryDiffQuantity, await quant.quantity, { precisionRounding: await (await quant.productUomId).rounding }) && await quant.inventoryQuantitySet) {
        await quant.set('isOutdated', true);
      }
    }
  }

  @api.depends('quantity')
  async _computeInventoryQuantityAutoApply() {
    for (const quant of this) {
      await quant.set('inventoryQuantityAutoApply', await quant.quantity);
    }
  }

  /**
   * Inverse method to create stock move when `inventoryQuantity` is set (`inventoryQuantity` is only accessible in inventory mode).
   * @returns 
   */
  async _setInventoryQuantity() {
    if (! await this._isInventoryMode()) {
      return;
    }
    for (const quant of this) {
      await quant.set('inventoryQuantity', await quant.inventoryQuantityAutoApply);
    }
    await this.actionApplyInventory();
  }

  /**
   * Handle the "on_hand" filter, indirectly calling `_get_domain_locations`.
   * @param operator 
   * @param value 
   */
  async _searchOnHand(operator, value) {
    if (!['=', '!='].includes(operator) || typeof (value) !== 'boolean') {
      throw new UserError(await this._t('Operation not supported'));
    }
    const domainLoc = (await this.env.items('product.product')._getDomainLocations())[0];
    const quantIds = []
    for (const l of await this.env.items('stock.quant').searchRead(domainLoc, ['id'])) {
      quantIds.push(l['id']);
    }
    let domainOperator;
    if ((operator === '!=' && value === true) || (operator === '=' && value === false)) {
      domainOperator = 'not in';
    }
    else {
      domainOperator = 'in';
    }
    return [['id', domainOperator, quantIds]];
  }

  /**
   * Override to handle the "inventory mode" and create a quant as
      superuser the conditions are met.
   * @param vals 
   * @returns 
   */
  @api.model()
  async create(vals) {
    if (await this._isInventoryMode() && ['inventoryQuantity', 'inventoryQuantityAutoApply'].some(f => f in vals)) {
      const allowedFields = await this._getInventoryFieldsCreate();
      if (Object.keys(vals).some(field => !allowedFields.includes(field))) {
        throw new UserError(await this._t("Quant's creation is restricted, you can't do this operation."));
      }
      const inventoryQuantity = vals['inventoryQuantity'] || pop(vals, 'inventoryQuantityAutoApply', false) || 0;
      // Create an empty quant or write on a similar one.
      const product = this.env.items('product.product').browse(vals['productId']);
      const location = this.env.items('stock.location').browse(vals['locationId']);
      const lotId = this.env.items('stock.production.lot').browse(vals['lotId']);
      const packageId = this.env.items('stock.quant.package').browse(vals['packageId']);
      const ownerId = this.env.items('res.partner').browse(vals['ownerId']);
      let quant = await this._gather(product, location, { lotId: lotId, packageId: packageId, ownerId: ownerId, strict: true });

      if (bool(quant)) {
        quant = await quant(0).sudo();
      }
      else {
        quant = await (await this.sudo()).create(vals);
      }
      // Set the `inventoryQuantity` field to create the necessary move.
      // await Promise.all([
        await quant.set('inventoryQuantity', inventoryQuantity),
        await quant.set('userId', vals['userId'] ?? (await this.env.user()).id),
        await quant.set('inventoryDate', _Date.today())
      // ]);

      return quant;
    }
    const res = await _super(StockQuant, this).create(vals);
    if (await this._isInventoryMode()) {
      await res._checkCompany();
    }
    return res;
  }

  /**
   * Add default location if import file did not fill it
   * @param values 
   * @returns 
   */
  async _loadRecordsCreate(values) {
    const companyUser = await this.env.company();
    const warehouse = await this.env.items('stock.warehouse').search([['companyId', '=', companyUser.id]], { limit: 1 });
    for (const value of values) {
      if (!('locationId' in value)) {
        value['locationId'] = (await warehouse.lotStockId).id;
      }
    }
    return _super(StockQuant, this)._loadRecordsCreate(values);
  }

  /**
   * Override to set the `inventoryQuantity` field if we're in "inventory mode" as well as to compute the sum of the `available_quantity` field.
   * @param domain 
   * @param fields 
   * @param groupby 
   * @param options 
   * @returns 
   */
  @api.model()
  async readGroup(domain, fields, groupby, options: { offset?: any, limit?: any, orderby?: any, lazy?: any } = {}) {
    options.lazy = options.lazy ?? true;
    if (fields.includes('availableQuantity')) {
      if (!(fields.includes('quantity'))) {
        fields.push('quantity');
      }
      if (!(fields.includes('reservedQuantity'))) {
        fields.push('reservedQuantity');
      }
    }
    const result = await _super(StockQuant, this).readGroup(domain, fields, groupby, options);
    for (const group of result) {
      if (this.env.context['inventoryReportMode']) {
        group['inventoryQuantity'] = false;
      }
      if (fields.includes('availableQuantity')) {
        group['availableQuantity'] = group['quantity'] - group['reservedQuantity'];
      }
    }
    return result;
  }

  /**
   * Override to handle the "inventory mode" and create the inventory move.
   * @param vals 
   * @returns 
   */
  async write(vals) {
    const allowedFields = await this._getInventoryFieldsWrite();
    if (this._isInventoryMode() && allowedFields.some(field => field in vals)) {
      if (await this.some(async (quant) => await (await quant.locationId).usage === 'inventory')) {
        // Do nothing when user tries to modify manually a inventory loss
        return;
      }
      if (Object.keys(vals).some(field => !(allowedFields.includes(field)))) {
        throw new UserError(await this._t("Quant's editing is restricted, you can't do this operation."));
      }
      const self = await this.sudo();
      const res = await _super(StockQuant, self).write(vals);
      if (bool(res) && self.env.context['inventoryReportMode']) {
        // update context to prevent recursive write call
        await (await self.withContext({ 'inventoryReportMode': false })).actionApplyInventory();
      }
      return res;
    }
    return _super(StockQuant, this).write(vals);
  }

  async actionViewStockMoves() {
    this.ensureOne();
    const action = await this.env.items("ir.actions.actions")._forXmlid("stock.stockMoveLineAction");
    const [productId, locationId, lotId, packageId] = await this('productId', 'locationId', 'lotId', 'packageId');
    action['domain'] = [
      ['productId', '=', productId.id],
      '|',
      ['locationId', '=', locationId.id],
      ['locationDestId', '=', locationId.id],
      ['lotId', '=', lotId.id],
      '|',
      ['packageId', '=', packageId.id],
      ['resultPackageId', '=', packageId.id],
    ]
    return action;
  }

  @api.model()
  async actionViewQuants() {
    let self = await this.withContext({ searchDefault_internalLoc: 1 });
    self = await self._setViewContext();
    return self._getQuantsAction({ extend: true });
  }

  /**
   * Similar to _get_quants_action except specific for inventory adjustments (i.e. inventory counts).
   */
  @api.model()
  async actionViewInventory() {
    const self = await this._setViewContext();
    await self._quantTasks();

    const ctx = Object.assign(self.env.context ?? {});
    ctx['noAtDate'] = true;
    if (await self.userHasGroups('stock.groupStockUser') && !await self.userHasGroups('stock.groupStockManager')) {
      ctx['searchDefault_myCount'] = true;
    }
    const action = {
      'label': await this._t('Inventory Adjustments'),
      'viewMode': 'list',
      'viewId': (await self.env.ref('stock.viewStockQuantTreeInventoryEditable')).id,
      'resModel': 'stock.quant',
      'type': 'ir.actions.actwindow',
      'context': ctx,
      'domain': [['locationId.usage', 'in', ['internal', 'transit']]],
      'help': `
                <p class="o-view-nocontent-smiling-face">
                    Your stock is currently empty
                </p><p>
                    Press the CREATE button to define quantity for each product in your stock or import them from a spreadsheet throughout Favorites <span class="fa fa-long-arrow-right"/> Import</p>
                `
    }
    return action;
  }

  async actionApplyInventory() {
    const productsTrackedWithoutLot = [];
    for (const quant of this) {
      const rounding = await (await quant.productUomId).rounding;
      if (floatIsZero(await quant.inventoryDiffQuantity, { precisionRounding: rounding }) && floatIsZero(await quant.inventoryQuantity, { precisionRounding: rounding }) && floatIsZero(await quant.quantity, { precisionRounding: rounding })) {
        continue;
      }
      if (['lot', 'serial'].includes(await (await quant.productId).tracking) && !(await quant.lotId).ok && await quant.inventoryQuantity != await quant.quantity) {
        productsTrackedWithoutLot.push((await quant.productId).id);
      }
    }
    // for some reason if multi-record, env.context doesn't pass to wizards...
    const ctx = Object.assign(this.env.context ?? {});
    ctx['default_quantIds'] = this.ids;
    const quantsOutdated = await this.filtered(async (quant) => await quant.isOutdated);
    if (bool(quantsOutdated)) {
      ctx['default_quantToFixIds'] = quantsOutdated.ids;
      return {
        'label': await this._t('Conflict in Inventory Adjustment'),
        'type': 'ir.actions.actwindow',
        'viewMode': 'form',
        'views': [[false, 'form']],
        'resModel': 'stock.inventory.conflict',
        'target': 'new',
        'context': ctx,
      }
    }
    if (productsTrackedWithoutLot.length) {
      ctx['default_productIds'] = productsTrackedWithoutLot;
      return {
        'label': await this._t('Tracked Products in Inventory Adjustment'),
        'type': 'ir.actions.actwindow',
        'viewMode': 'form',
        'views': [[false, 'form']],
        'resModel': 'stock.track.confirmation',
        'target': 'new',
        'context': ctx,
      }
    }
    await this._applyInventory();
    await this.set('inventoryQuantitySet', false);
  }

  async actionInventoryHistory() {
    this.ensureOne();
    const [productId, companyId, locationId, lotId, packageId, ownerId] = await this('productId', 'companyId', 'locationId', 'lotId', 'packageId', 'ownerId');
    const action = {
      'label': await this._t('History'),
      'viewMode': 'list,form',
      'resModel': 'stock.move.line',
      'views': [[(await this.env.ref('stock.viewMoveLineTree')).id, 'list'], [false, 'form']],
      'type': 'ir.actions.actwindow',
      'context': {
        'searchDefault_inventory': 1,
        'searchDefault_done': 1,
      },
      'domain': [
        ['productId', '=', productId.id],
        ['companyId', '=', companyId.id],
        '|',
        ['locationId', '=', locationId.id],
        ['locationDestId', '=', locationId.id],
      ],
    }
    if (lotId.ok) {
      action['context']['searchDefault_lotId'] = lotId.id;
    }
    if (packageId.ok) {
      action['context']['searchDefault_packageId'] = packageId.id;
      action['context']['searchDefault_resultPackageId'] = packageId.id;
    }
    if (ownerId.ok) {
      action['context']['searchDefault_ownerId'] = ownerId.id;
    }
    return action;
  }

  async actionSetInventoryQuantity() {
    const quantsAlreadySet = await this.filtered(async (quant) => await quant.inventoryQuantitySet);
    if (bool(quantsAlreadySet)) {
      const ctx = Object.assign(this.env.context ?? {}, { default_quantIds: this.ids });
      const view = await this.env.ref('stock.inventoryWarningSetView', false);
      return {
        'label': await this._t('Quantities Already Set'),
        'type': 'ir.actions.actwindow',
        'viewMode': 'form',
        'views': [[view.id, 'form']],
        'viewId': view.id,
        'resModel': 'stock.inventory.warning',
        'target': 'new',
        'context': ctx,
      }
    }
    for (const quant of this) {
      await quant.set('inventoryQuantity', await quant.quantity);
    }
    // await Promise.all([
      await this.set('userId', (await this.env.user()).id),
      await this.set('inventoryQuantitySet', true)
    // ]);
  }

  async actionReset() {
    const ctx = Object.assign(this.env.context ?? {}, { default_quantIds: this.ids });
    const view = await this.env.ref('stock.inventoryWarningResetView', false);
    return {
      'label': await this._t('Quantities To Reset'),
      'type': 'ir.actions.actwindow',
      'viewMode': 'form',
      'views': [[view.id, 'form']],
      'viewId': view.id,
      'resModel': 'stock.inventory.warning',
      'target': 'new',
      'context': ctx,
    }
  }

  async actionSetInventoryQuantityToZero() {
    // await Promise.all([
      await this.set('inventoryQuantity', 0),
      await this.set('inventoryDiffQuantity', 0),
      await this.set('inventoryQuantitySet', false)
    // ]);
  }

  @api.constrains('productId')
  async checkProductId() {
    if (await this.some(async (elem) => await (await elem.productId).type !== 'product')) {
      throw new ValidationError(await this._t('Quants cannot be created for consumables or services.'));
    }
  }

  @api.constrains('quantity')
  async checkQuantity() {
    for (const quant of this) {
      if (await (await quant.locationId).usage !== 'inventory' && (await quant.lotId).ok && await (await quant.productId).tracking === 'serial' && floatCompare(Math.abs(await quant.quantity), 1, { precisionRounding: await (await quant.productUomId).rounding }) > 0) {
        throw new ValidationError(await this._t('The serial number has already been assigned: \n Product: %s, Serial Number: %s', await (await quant.productId).displayName, await (await quant.lotId).label));
      }
    }
  }

  @api.constrains('locationId')
  async checkLocationId() {
    for (const quant of this) {
      if (await (await quant.locationId).usage === 'view') {
        throw new ValidationError(await this._t('You cannot take products from or deliver products to a location of type "view" (%s).', await (await quant.locationId).label))
      }
    }
  }

  @api.model()
  async _getRemovalStrategy(productId, locationId) {
    const categId = await productId.categId;
    if ((await categId.removalStrategyId).ok) {
      return (await categId.removalStrategyId).method;
    }
    let loc = locationId;
    while (loc.ok) {
      const removalStrategyId = await loc.removalStrategyId;
      if (removalStrategyId.ok) {
        return removalStrategyId.method;
      }
      loc = await loc.locationId;
    }
    return 'fifo';
  }

  @api.model()
  async _getRemovalStrategyOrder(removalStrategy) {
    if (removalStrategy === 'fifo') {
      return 'inDate ASC, id';
    }
    else if (removalStrategy === 'lifo') {
      return 'inDate DESC, id DESC';
    }
    else if (removalStrategy === 'closest') {
      return 'locationId ASC, id DESC';
    }
    throw new UserError(await this._t('Removal strategy %s not implemented.', removalStrategy,));
  }

  async _gather(productId, locationId, options: { lotId?: any, packageId?: any, ownerId?: any, strict?: boolean } = {}) {
    const removalStrategy = await this._getRemovalStrategy(productId, locationId);
    const removalStrategyOrder = await this._getRemovalStrategyOrder(removalStrategy);

    let domain = [['productId', '=', productId.id]];
    if (!options.strict) {
      if (bool(options.lotId)) {
        domain = expression.AND([[['lotId', '=', options.lotId.id]], domain]);
      }
      if (bool(options.packageId)) {
        if (bool(options.packageId)) {
          domain = expression.AND([[['packageId', '=', options.packageId.id]], domain]);
        }
        if (bool(options.ownerId)) {
          domain = expression.AND([[['ownerId', '=', options.ownerId.id]], domain]);
        }
        domain = expression.AND([[['locationId', 'childOf', locationId.id]], domain]);
      }
      else {
        domain = expression.AND([[['lotId', '=', bool(options.lotId) && bool(options.lotId.id) && options.lotId.id || false]], domain]);
        domain = expression.AND([[['packageId', '=', bool(options.packageId) && bool(options.packageId.id) && options.packageId.id || false]], domain]);
        domain = expression.AND([[['ownerId', '=', bool(options.ownerId) && bool(options.ownerId.id) && options.ownerId.id || false]], domain]);
        domain = expression.AND([[['locationId', '=', locationId.id]], domain]);
      }

      return this.search(domain, { order: removalStrategyOrder });
    }
  }

  /**
   * Return the available quantity, i.e. the sum of `quantity` minus the sum of
          `reserved_quantity`, for the set of quants sharing the combination of `productId,
          locationId` if `strict` is set to false or sharing the *exact same characteristics*
          otherwise.
          This method is called in the following usecases:
              - when a stock move checks its availability
              - when a stock move actually assign
              - when editing a move line, to check if the new value is forced or not
              - when validating a move line with some forced values and have to potentially unlink an
                equivalent move line in another picking
          In the two first usecases, `strict` should be set to `false`, as we don't know what exact
          quants we'll reserve, and the characteristics are meaningless in this context.
          In the last ones, `strict` should be set to `true`, as we work on a specific set of
          characteristics.
  
          :return: available quantity as a float
   * @param productId 
   * @param locationId 
   * @param options 
   * @returns 
   */
  @api.model()
  async _getAvailableQuantity(productId, locationId, options: { lotId?: any, packageId?: any, ownerId?: any, strict?: boolean, allowNegative?: boolean } = {}) {
    const self = await this.sudo();
    const quants = await self._gather(productId, locationId, options);
    const rounding = await (await productId.uomId).rounding;
    if (await productId.tracking === 'none') {
      const availableQuantity = sum(await quants.mapped('quantity')) - sum(await quants.mapped('reservedQuantity'));
      if (options.allowNegative) {
        return availableQuantity;
      }
      else {
        return floatCompare(availableQuantity, 0.0, { precisionRounding: rounding }) >= 0.0 ? availableQuantity : 0.0;
      }
    }
    else {
      const availaibleQuantities = new Map(Array.from(new Set(await quants.mapped('lotId'))).concat(['untracked']).map(lotId => [lotId, 0.0]));
      for (const quant of quants) {
        const [lotId, quantity, reservedQuantity] = await quant('lotId', 'quantity', 'reservedQuantity');
        if (!bool(lotId)) {
          const untrackedQuantity = availaibleQuantities.get('untracked');
          availaibleQuantities.set('untracked', untrackedQuantity + quantity - reservedQuantity);
        }
        else {
          const quantity = availaibleQuantities.get(lotId);
          availaibleQuantities.set(lotId, quantity + await quant.quantity - await quant.reservedQuantity);
        }
      }
      if (options.allowNegative) {
        return sum(availaibleQuantities.values());
      }
      else {
        return sum(Array.from(availaibleQuantities.values()).filter(availableQuantity => floatCompare(availableQuantity, 0, { precisionRounding: rounding }) > 0));
      }
    }
  }


  @api.onchange('locationId', 'productId', 'lotId', 'packageId', 'ownerId')
  async _onchangeLocationOrProductId() {
    const vals = {};

    // Once the new line is complete, fetch the new theoretical values.
    const [productId, locationId] = await this('productId', 'locationId');
    if (productId.ok && locationId.ok) {
      const [packageId, lotId, tracking, ownerId] = await this('packageId', 'lotId', 'tracking', 'ownerId');
      // Sanity check if a lot has been set.
      if (lotId) {
        if (tracking === 'none' || !productId.eq(await lotId.productId)) {
          vals['lotId'] = null;
        }
      }
      const quant = await this._gather(productId, locationId, { lotId: lotId, packageId: packageId, ownerId: ownerId, strict: true });
      if (quant.ok) {
        await this.set('quantity', await quant.quantity);
      }

      // Special case: directly set the quantity to one for serial numbers,
      // it'll trigger `inventoryQuantity` compute.
      if (lotId.ok && tracking === 'serial') {
        vals['inventoryQuantity'] = 1;
        vals['inventoryQuantityAutoApply'] = 1;
      }
    }
    if (bool(vals)) {
      await this.update(vals);
    }
  }

  @api.onchange('inventoryQuantity')
  async _onchangeInventoryQuantity() {
    const locationId = await this('locationId');
    if (locationId.ok && await locationId.usage === 'inventory') {
      const warning = {
        'title': await this._t('You cannot modify inventory loss quantity'),
        'message': await this._t(
          `Editing quantities in an Inventory Adjustment location is forbidden,
                      those locations are used as counterpart when correcting the quantities.`
        )
      }
      return { 'warning': warning }
    }
  }

  @api.onchange('lotId')
  async _onchangeSerialNumber() {
    const [lotId, productId] = await this('lotId', 'productId');
    if (lotId.ok && await productId.tracking === 'serial') {
      const [message] = await this.env.items('stock.quant')._checkSerialNumber(productId, lotId, await this['companyId'])
      if (message) {
        return { 'warning': { 'title': await this._t('Warning'), 'message': message } };
      }
    }
  }

  @api.onchange('productId', 'companyId')
  async _onchangeProductId() {
    const locationId = await this['locationId'];
    if (locationId.ok) {
      return;
    }
    let [productId, companyId] = await this('productId', 'companyId');
    if (['lot', 'serial'].includes(await productId.tracking)) {
      const previousQuants = await this.env.items('stock.quant').search(
        [['productId', '=', productId.id]], { limit: 1, order: 'createdAt desc' });
      if (previousQuants.ok) {
        await this.set('locationId', await previousQuants.locationId);
      }
    }
    if (!locationId.ok) {
      companyId = companyId.ok && bool(companyId.id) && companyId.id || (await this.env.company()).id;
      await this.set('locationId', await (await (await this.env.items('stock.warehouse').search(
        [['companyId', '=', companyId]], { limit: 1 })).inTypeId).defaultLocationDestId);
    }
  }

  async _applyInventory() {
    const moveVals = [];
    if (! await this.userHasGroups('stock.groupStockManager')) {
      throw new UserError(await this._t('Only a stock manager can validate an inventory adjustment.'));
    }
    for (const quant of this) {
      const [inventoryDiffQuantity, productUomId, productId, companyId, locationId] = await quant('inventoryDiffQuantity', 'productUomId', 'productId', 'companyId', 'locationId');
      // Create and validate a move so that the quant matches its `inventoryQuantity`.
      if (floatCompare(inventoryDiffQuantity, 0, { precisionRounding: await productUomId.rounding }) > 0) {
        moveVals.push(await quant._getInventoryMoveValues(inventoryDiffQuantity, await (await productId.withCompany(companyId)).propertyStockInventory, locationId));
      }
      else {
        moveVals.push(await quant._getInventoryMoveValues(-inventoryDiffQuantity, locationId, await (await productId.withCompany(companyId)).propertyStockInventory, { out: true }));
      }
    }

    const moves = await (await this.env.items('stock.move').withContext({ inventoryMode: false })).create(moveVals);
    await moves._actionDone();
    await (await this['locationId']).write({ 'lastInventoryDate': _Date.today() });
    const dateByLocation = MapKey.fromEntries(
      await (await this.mapped('locationId')).map(async (loc) => [loc, await loc._getNextInventoryDate()])
    );
    for (const quant of this) {
      await quant.set('inventoryDate', dateByLocation.get(await quant.locationId));
    }
    await this.write({ 'inventoryQuantity': 0, 'userId': false });
    await this.write({ 'inventoryDiffQuantity': 0 });
  }

  /**
   * Increase or decrease `reserved_quantity` of a set of quants for a given set of
      productId/locationId/lot_id/package_id/owner_id.
 
      :param productId:
      :param locationId:
      :param quantity:
      :param lot_id:
      :param package_id:
      :param owner_id:
      :param datetime in_date: Should only be passed when calls to this method are done in
                               order to move a quant. When creating a tracked quant, the
                               current datetime will be used.
      :return: tuple (available_quantity, in_date as a datetime)
   * @param productId 
   * @param locationId 
   * @param quantity 
   * @param options 
   * @returns 
   */
  @api.model()
  async _updateAvailableQuantity(productId, locationId, quantity, options: { lotId?: any, packageId?: any, ownerId?: any, inDate?: any } = {}) {
    const self = await this.sudo();
    const quants = await self._gather(productId, locationId, { lotId: options.lotId, packageId: options.packageId, ownerId: options.ownerId, strict: true });

    let incomingDates = (await quants.mapped('in_date')).filter(d => bool(d));
    if (options.inDate) {
      incomingDates = incomingDates.conat([options.inDate]);
    }
    // If multiple incoming dates are available for a given lot_id/package_id/owner_id, we
    // consider only the oldest one as being relevant.
    if (incomingDates.length) {
      options.inDate = dateMin(incomingDates);
    }
    else {
      options.inDate = _Datetime.now();
    }

    let quant;// = None
    if (bool(quants)) {
      // see _acquire_one_job for explanations
      const stockQuantResult = await self._cr.execute(`SELECT id FROM "stockQuant" WHERE id IN (%s) LIMIT 1 FOR NO KEY UPDATE SKIP LOCKED`, [String(quants.ids)]);
      if (stockQuantResult.length) {
        quant = self.browse(stockQuantResult[0]['id']);
      }
    }
    if (bool(quant)) {
      await quant.write({
        'quantity': await quant.quantity + quantity,
        'inDate': options.inDate,
      });
    }
    else {
      await this.create({
        'productId': productId.id,
        'locationId': locationId.id,
        'quantity': quantity,
        'lotId': bool(options.lotId) && options.lotId.id,
        'packageId': bool(options.packageId) && options.packageId.id,
        'ownerId': bool(options.ownerId) && options.ownerId.id,
        'inDate': options.inDate,
      });
    }
    return [this._getAvailableQuantity(productId, locationId, { lotId: options.lotId, packageId: options.packageId, ownerId: options.ownerId, strict: false, allowNegative: true }), options.inDate];
  }

  /**
   * Increase the reserved quantity, i.e. increase `reserved_quantity` for the set of quants
      sharing the combination of `productId, locationId` if `strict` is set to false or sharing
      the *exact same characteristics* otherwise. Typically, this method is called when reserving
      a move or updating a reserved move line. When reserving a chained move, the strict flag
      should be enabled (to reserve exactly what was brought). When the move is MTS,it could take
      anything from the stock, so we disable the flag. When editing a move line, we naturally
      enable the flag, to reflect the reservation according to the edition.
 
      :return: a list of tuples (quant, quantity_reserved) showing on which quant the reservation
          was done and how much the system was able to reserve on it
   * @param productId 
   * @param locationId 
   * @param quantity 
   * @param options 
   */
  @api.model()
  async _updateReservedQuantity(productId, locationId, quantity, options: { lotId?: any, packageId?: any, ownerId?: any, strict: false }) {
    const self = await this.sudo();
    const rounding = await (await productId.uomId).rounding;
    const quants = await this._gather(productId, locationId, options);
    const reservedQuants = [];

    let availableQuantity;
    if (floatCompare(quantity, 0, { precisionRounding: rounding }) > 0) {
      // if we want to reserve
      availableQuantity = await this._getAvailableQuantity(productId, locationId, options);
      if (floatCompare(quantity, availableQuantity, { precisionRounding: rounding }) > 0) {
        throw new UserError(await this._t('It is not possible to reserve more products of %s than you have in stock.', await productId.displayName));
      }
    }
    else if (floatCompare(quantity, 0, { precisionRounding: rounding }) < 0) {
      // if we want to unreserve
      availableQuantity = sum(await quants.mapped('reservedQuantity'));
      if (floatCompare(Math.abs(quantity), availableQuantity, { precisionRounding: rounding }) > 0) {
        throw new UserError(await this._t('It is not possible to unreserve more products of %s than you have in stock.', await productId.displayName));
      }
    }
    else {
      return reservedQuants;
    }
    for (const quant of quants) {
      const reservedQuantity = await quant.reservedQuantity;
      if (floatCompare(quantity, 0, { precisionRounding: rounding }) > 0) {
        let maxQuantityOnQuant = await quant.quantity - reservedQuantity;
        if (floatCompare(maxQuantityOnQuant, 0, { precisionRounding: rounding }) <= 0) {
          continue;
        }
        maxQuantityOnQuant = Math.min(maxQuantityOnQuant, quantity);
        await quant.set('reservedQuantity', reservedQuantity + maxQuantityOnQuant);
        reservedQuants.push([quant, maxQuantityOnQuant]);
        quantity -= maxQuantityOnQuant
        availableQuantity -= maxQuantityOnQuant;
      }
      else {
        let maxQuantityOnQuant = Math.min(reservedQuantity, Math.abs(quantity));
        await quant.set('reservedQuantity', reservedQuantity - maxQuantityOnQuant);
        reservedQuants.push([quant, -maxQuantityOnQuant]);
        quantity += maxQuantityOnQuant;
        availableQuantity += maxQuantityOnQuant;
      }

      if (floatIsZero(quantity, { precisionRounding: rounding }) || floatIsZero(availableQuantity, { precisionRounding: rounding })) {
        break;
      }
    }
    return reservedQuants;
  }

  @api.model()
  async _quantTasks() {
    await this._mergeQuants();
    await this._unlinkZeroQuants();
  }

  /**
   * update_available_quantity may leave quants with no
        quantity and no reserved_quantity. It used to directly unlink
        these zero quants but this proved to hurt the performance as
        this method is often called in batch and each unlink invalidate
        the cache. We defer the calls to unlink in this method.
   */
  @api.model()
  async _unlinkZeroQuants() {
    const precisionDigits = Math.max(6, (await (await (await this.sudo()).env.ref('product.decimalProductUom')).digits) * 2);
    // Use a select instead of ORM search for UoM robustness.
    const query = `SELECT id FROM "stockQuant" WHERE (round(quantity::numeric, %s) = 0 OR quantity IS NULL)
                                                       AND round("reservedQuantity"::numeric, %s) = 0
                                                       AND (round("inventoryQuantity"::numeric, %s) = 0 OR "inventoryQuantity" IS NULL)
                                                       AND "userId" IS NULL;`
    const params = [precisionDigits, precisionDigits, precisionDigits];
    const res = await this.env.cr.execute(query, params);
    const quantIds = this.env.items('stock.quant').browse(res.map(quant => quant['id']));
    await (await quantIds.sudo()).unlink();
  }

  /**
   * In a situation where one transaction is updating a quant via
      `_update_available_quantity` and another concurrent one calls this function with the same
      argument, we’ll create a new quant in order for these transactions to not rollback. This
      method will find and deduplicate these quants.
   */
  @api.model()
  async _mergeQuants() {
    const query = `WITH
                          dupes AS (
                              SELECT min(id) as "toUpdateQuantId",
                                  (array_agg(id ORDER BY id))[2:array_length(array_agg(id), 1)] as "toDeleteQuantIds",
                                  SUM("reservedQuantity") as "reservedQuantity",
                                  SUM("inventoryQuantity") as "inventoryQuantity",
                                  SUM(quantity) as quantity,
                                  MIN("inDate") as "inDate"
                              FROM "stockQuant"
                              GROUP BY "productId", "companyId", "locationId", "lotId", "packageId", "ownerId"
                              HAVING COUNT(id) > 1
                          ),
                          _up AS (
                              UPDATE "stockQuant" q
                                  SET quantity = d.quantity,
                                      "reservedQuantity" = d."reservedQuantity",
                                      "inventoryQuantity" = d."inventoryQuantity",
                                      "inDate" = d."inDate"
                              FROM dupes d
                              WHERE d."toUpdateQuantId" = q.id
                          )
                     DELETE FROM "stockQuant" WHERE id in (SELECT unnest("toDeleteQuantIds") from dupes)
          `;
    try {
      await this.env.cr.savepoint(false, async () => {
        await this.env.cr.execute(query);
        this.invalidateCache();
      });
    } catch (e) {
      // except Error as e:
      console.info('an error occured while merging quants: %s', e);
    }
  }

  /**
   * Used to control whether a quant was written on or created during an "inventory session", meaning a mode where we need to create the stock.move record necessary to be consistent with the `inventoryQuantity` field.
   * @returns 
   */
  @api.model()
  async _isInventoryMode() {
    if (this.env.context['inventoryMode']) {
      return this.userHasGroups('stock.groupStockUser');
    } else {
      return false;
    }
  }

  /**
   * Returns a list of fields user can edit when he want to create a quant in `inventory_mode`.
   * @returns 
   */
  @api.model()
  async _getInventoryFieldsCreate() {
    return ['productId', 'locationId', 'lotId', 'packageId', 'ownerId'].concat(await this._getInventoryFieldsWrite());
  }

  /**
   * Returns a list of fields user can edit when he want to edit a quant in `inventory_mode`.
   * @returns 
   */
  @api.model()
  async _getInventoryFieldsWrite() {
    const fields = ['inventoryQuantity', 'inventoryQuantityAutoApply', 'inventoryDiffQuantity', 'inventoryDate', 'userId', 'inventoryQuantitySet', 'isOutdated']
    return fields;
  }

  /**
   * Called when user manually set a new quantity (via `inventoryQuantity`)
      just before creating the corresponding stock move.

      :param locationId: `stock.location`
      :param locationDestId: `stock.location`
      :param out: boolean to set on true when the move go to inventory adjustment location.
      :return: dict with all values needed to create a new `stock.move` with its move line.
   * @param qty 
   * @param locationId 
   * @param locationDestId 
   * @param param3 
   * @returns 
   */
  async _getInventoryMoveValues(qty, locationId, locationDestId, options: { out?: any } = {}) {
    this.ensureOne();
    const [productId, productUomId, companyId, lotId, packageId, ownerId] = await this('productId', 'productUomId', 'companyId', 'lotId', 'packageId', 'ownerId');
    let label;
    if (floatIsZero(qty, { precisionDigits: 0, precisionRounding: await (await productUomId.rounding) })) {
      label = await this._t('Product Quantity Confirmed');
    }
    else {
      label = await this._t('Product Quantity Updated');
    }
    const cid = bool(companyId.id) ? companyId.id : (await this.env.company()).id;
    return {
      'label': this.env.context['inventoryName'] ?? label,
      'productId': this['productId'].id,
      'productUom': productUomId.id,
      'productUomQty': qty,
      'companyId': cid,
      'state': 'confirmed',
      'locationId': locationId.id,
      'locationDestId': locationDestId.id,
      'isInventory': true,
      'moveLineIds': [[0, 0, {
        'productId': productId.id,
        'productUomId': productUomId.id,
        'qtyDone': qty,
        'locationId': locationId.id,
        'locationDestId': locationDestId.id,
        'companyId': cid,
        'lotId': lotId.id,
        'packageId': options.out && bool(packageId.id) && packageId.id || false,
        'resultPackageId': (!options.out) && bool(packageId.id) && packageId.id || false,
        'ownerId': ownerId.id,
      }]]
    }
  }

  /**
   * Adds context when opening quants related views.
   * @returns 
   */
  async _setViewContext() {
    let self = this;
    if (! await self.userHasGroups('stock.groupStockMultiLocations')) {
      const companyUser = await self.env.company();
      const warehouse = await self.env.items('stock.warehouse').search([['companyId', '=', companyUser.id]], { limit: 1 });
      if (bool(warehouse)) {
        self = await self.withContext({ default_locationId: (await warehouse.lotStockId).id, hideLocation: true });
      }
    }
    // If user have rights to write on quant, we set quants in inventory mode.
    if (await self.userHasGroups('stock.groupStockUser')) {
      self = await self.withContext({ inventoryMode: true });
    }
    return self;
  }

  /**
   * Returns an action to open (non-inventory adjustment) quant view.
      Depending of the context (user have right to be inventory mode or not),
      the list view will be editable or readonly.
 
      :param domain: List for the domain, empty by default.
      :param extend: If true, enables form, graph and pivot views. false by default.
   * @param domain 
   * @param extend 
   */
  @api.model()
  async _getQuantsAction(domain?: any, extend = false) {
    await this._quantTasks();
    const ctx = Object.assign({}, this.env.context);
    ctx['inventoryReportMode'] = true;
    pop(ctx, 'groupby', null);
    const action = {
      'label': await this._t('Stock On Hand'),
      'viewType': 'tree',
      'viewMode': 'list,form',
      'resModel': 'stock.quant',
      'type': 'ir.actions.actwindow',
      'context': ctx,
      'domain': domain ?? [],
      'help': `
                <p class="o-view-nocontent-empty-folder">No Stock On Hand</p>
                <p>This analysis gives you an overview of the current stock level of your products.</p>
                `
    }

    const targetAction = await this.env.ref('stock.dashboardOpenQuants', false);
    if (bool(targetAction)) {
      action['id'] = targetAction.id
    }
    const formView = (await this.env.ref('stock.viewStockQuantFormEditable')).id;
    if (this.env.context['inventoryMode'] && await this.userHasGroups('stock.groupStockManager')) {
      action['viewId'] = (await this.env.ref('stock.viewStockQuantTreeEditable')).id;
    }
    else {
      action['viewId'] = (await this.env.ref('stock.viewStockQuantTree')).id;
    }
    update(action, {
      'views': [
        [action['viewId'], 'list'],
        [formView, 'form'],
      ],
    });
    if (bool(extend)) {
      update(action, {
        'viewMode': 'tree,form,pivot,graph',
        'views': [
          [action['viewId'], 'list'],
          [formView, 'form'],
          [(await this.env.ref('stock.viewStockQuantPivot')).id, 'pivot'],
          [(await this.env.ref('stock.stockQuantViewGraph')).id, 'graph'],
        ],
      })
    }
    return action;
  }

  /**
   * Checks for duplicate serial numbers (SN) when assigning a SN (i.e. no source_location_id)
        and checks for potential incorrect location selection of a SN when using a SN (i.e.
        source_location_id). Returns warning message of all locations the SN is located at and
        (optionally) a recommended source location of the SN (when using SN from incorrect location).
        This function is designed to be used by onchange functions across differing situations including,
        but not limited to scrap, incoming picking SN encoding, and outgoing picking SN selection.
 
        :param productId: `product.product` product to check SN for
        :param lot_id: `stock.production.lot` SN to check
        :param companyId: `res.company` company to check against (i.e. we ignore duplicate SNs across
            different companies)
        :param source_location_id: `stock.location` optional source location if using the SN rather
            than assigning it
        :param ref_doc_location_id: `stock.location` optional reference document location for
            determining recommended location. This is param expected to only be used when a
            `source_location_id` is provided.
        :return: tuple(message, recommended_location) If not None, message is a string expected to be
            used in warning message dict and recommended_location is a `locationId`
   * @param productId 
   * @param lotId 
   * @param companyId 
   * @param sourceLocationId 
   * @param refDocLocationId 
   */
  @api.model()
  async _checkSerialNumber(productId, lotId, companyId, sourceLocationId?: any, refDocLocationId?: any) {
    let message;// = None
    let recommendedLocation;// = None
    if (await productId.tracking === 'serial') {
      const quants = await this.env.items('stock.quant').search([
        ['productId', '=', productId.id],
        ['lotId', '=', lotId.id],
        ['quantity', '!=', 0],
        '|', ['locationId.usage', '=', 'customer'],
        '&', ['companyId', '=', companyId.id],
        ['locationId.usage', 'in', ['internal', 'transit']]
      ]);
      const snLocations = await quants.mapped('locationId');
      if (quants.ok) {
        if (!bool(sourceLocationId)) {
          // trying to assign an already existing SN
          message = await this._t(['The Serial Number (%s) is already used in these location(s): %s.',
            'Is this expected? For example this can occur if a delivery operation is validated before its corresponding receipt operation is validated. In this case the issue will be solved  automatically once all steps are completed. Otherwise, the serial numbershould be corrected to  prevent inconsistent data.'].join('\n\n'),
            await lotId.label, (await snLocations.mapped('displayName')).join(', '));
        }
        else if (bool(sourceLocationId) && !snLocations.includes(sourceLocationId)) {
          // using an existing SN in the wrong location
          let recommendedLocation = this.env.items('stock.location');
          if (bool(refDocLocationId)) {
            for (const location of snLocations) {
              if ((await location.parentPath).includes(await refDocLocationId.parentPath)) {
                recommendedLocation = location;
                break;
              }
            }
          }
          else {
            for (const location of snLocations) {
              if (await location.usage !== 'customer') {
                recommendedLocation = location;
                break;
              }
            }
          }
          if (bool(recommendedLocation)) {
            message = await this._t('Serial number (%s) is not located in %s, but is located in location(s): %s. Source location for this move will be changed to %s',
              await lotId.label, await sourceLocationId.displayName, (await snLocations.mapped('displayName')).join(', '), await recommendedLocation.displayName);
          }
          else {
            message = await this._t('Serial number (%s) is not located in %s, but is located in location(s): %s. Please correct this to prevent inconsistent data.',
              await lotId.label, await sourceLocationId.displayName, (await snLocations.mapped('displayName')).join(', '));
          }
        }
      }
    }
    return [message, recommendedLocation];
  }
}

/**
 * Packages containing quants and/or other packages
 */
@MetaModel.define()
class QuantPackage extends Model {
  static _module = module;
  static _name = "stock.quant.package";
  static _description = "Packages";
  static _order = 'label';

  static label = Fields.Char(
    'Package Reference', {
    copy: false, index: true,
    default: async (self) => await self.env.items('ir.sequence').nextByCode('stock.quant.package') || await self._t('Unknown Pack')
  });
  static quantIds = Fields.One2many('stock.quant', 'packageId', { string: 'Bulk Content', readonly: true,
    domain: ['|', ['quantity', '!=', 0], ['reservedQuantity', '!=', 0]]
  });
  static packageTypeId = Fields.Many2one(
    'stock.package.type', { string: 'Package Type', index: true, checkCompany: true });
  static locationId = Fields.Many2one(
    'stock.location', {
    string: 'Location', compute: '_computePackageInfo',
    index: true, readonly: true, store: true
  });
  static companyId = Fields.Many2one(
    'res.company', {
    string: 'Company', compute: '_computePackageInfo',
    index: true, readonly: true, store: true
  });
  static ownerId = Fields.Many2one(
    'res.partner', {
    string: 'Owner', compute: '_computePackageInfo', search: '_searchOwner',
    index: true, readonly: true, computeSudo: true
  });
  static packageUse = Fields.Selection([
    ['disposable', 'Disposable Box'],
    ['reusable', 'Reusable Box'],
  ], {
    string: 'Package Use', default: 'disposable', required: true,
    help: "Reusable boxes are used for batch picking and emptied afterwards to be reused. In the barcode application, scanning a reusable box will add the products in this box. Disposable boxes aren't reused, when scanning a disposable box in the barcode application, the contained products are added to the transfer."
  });

  @api.depends('quantIds.packageId', 'quantIds.locationId', 'quantIds.companyId', 'quantIds.ownerId', 'quantIds.quantity', 'quantIds.reservedQuantity')
  async _computePackageInfo() {
    for (const pack of this) {
      const values = { 'locationId': false, 'ownerId': false };
      const quantIds = await pack.quantIds;
      if (quantIds.ok) {
        const quantId = await quantIds(0);
        values['locationId'] = await quantIds.locationId;
        if (await quantIds.all(async (q) => (await q.ownerId).eq(await quantId.ownerId))) {
          values['ownerId'] = await quantId.ownerId;
        }
        if (await quantIds.all(async (q) => (await q.companyId).eq(await quantId.companyId))) {
          values['companyId'] = await quantId.companyId;
        }
      }
      // await Promise.all([
        await pack.set('locationId', values['locationId']),
        await pack.set('companyId', values['companyId']),
        await pack.set('ownerId', values['ownerId'])
      // ]);
    }
  }

  async _searchOwner(operator, value) {
    let packs;
    if (value) {
      packs = await this.search([['quantIds.ownerId', operator, value]]);
    }
    else {
      packs = await this.search([['quantIds', operator, value]]);
    }
    if (packs) {
      return [['id', 'parentOf', packs.ids]];
    }
    else {
      return [['id', '=', false]];
    }
  }

  async unpack() {
    for (const pack of this) {
      const moveLineToModify = await this.env.items('stock.move.line').search([
        ['packageId', '=', pack.id],
        ['state', 'in', ['assigned', 'partiallyAvailable']],
        ['productQty', '!=', 0],
      ])
      await moveLineToModify.write({ 'packageId': false });
      await (await (await pack.mapped('quant_ids')).sudo()).write({ 'packageId': false });
    }
    // Quant clean-up, mostly to avoid multiple quants of the same product. For example, unpack 2 packages of 50, then reserve 100 => a quant of -50 is created at transfer validation.
    await this.env.items('stock.quant')._quantTasks();
  }

  async actionViewPicking() {
    const action = await this.env.items("ir.actions.actions")._forXmlid("stock.actionPickingTreeAll");
    const domain = ['|', ['resultPackageId', 'in', this.ids], ['packageId', 'in', this.ids]];
    const pickings = await (await this.env.items('stock.move.line').search(domain)).mapped('pickingId');
    action['domain'] = [['id', 'in', pickings.ids]];
    return action;
  }

  async _getContainedQuants() {
    return this.env.items('stock.quant').search([['packageId', 'in', this.ids]]);
  }
}
