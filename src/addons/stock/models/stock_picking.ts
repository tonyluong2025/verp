import { DateTime } from "luxon";
import { api } from "../../../core";
import { attrgetter, getattr, setdefault } from "../../../core/api/func";
import { Fields, _Date, _Datetime } from "../../../core/fields";
import { DefaultDict, Dict } from "../../../core/helper";
import { UserError } from "../../../core/helper/errors";
import { MetaModel, Model, _super } from "../../../core/models";
import { expression } from "../../../core/osv";
import { literalEval } from "../../../core/tools/ast";
import { bool } from "../../../core/tools/bool";
import { dateMax, dateMin } from "../../../core/tools/date_utils";
import { floatCompare, floatIsZero, floatRound } from "../../../core/tools/float_utils";
import { all, itemgetter, len, sortedAsync, sum } from "../../../core/tools/iterable";
import { stringify } from "../../../core/tools/json";
import { DEFAULT_SERVER_DATETIME_FORMAT, groupby, groupbyAsync, pop } from "../../../core/tools/misc";
import { formatDate, formatDatetime } from "../../../core/tools/models";
import { f } from "../../../core/tools/utils";
import { PROCUREMENT_PRIORITIES } from "./stock_move";

@MetaModel.define()
class PickingType extends Model {
  static _module = module;
  static _name = "stock.picking.type";
  static _description = "Picking Type";
  static _order = 'sequence, id';
  static _checkCompanyAuto = true;

  async _defaultShowOperations() {
    return this.userHasGroups('stock.groupProductionLot, stock.groupStockMultiLocations, stock.groupTrackingLot');
  }

  static label = Fields.Char('Operation Type', { required: true, translate: true });
  static color = Fields.Integer('Color');
  static sequence = Fields.Integer('Sequence', { help: "Used to order the 'All Operations' kanban view" });
  static sequenceId = Fields.Many2one(
    'ir.sequence', {
    string: 'Reference Sequence',
    checkCompany: true, copy: false
  });
  static sequenceCode = Fields.Char('Code', { required: true });
  static defaultLocationSrcId = Fields.Many2one(
    'stock.location', {
    string: 'Default Source Location',
    checkCompany: true,
    help: "This is the default source location when you create a picking manually with this operation type. It is possible however to change it or that the routes put another location. If it is empty, it will check for the supplier location on the partner."
  });
  static defaultLocationDestId = Fields.Many2one(
    'stock.location', {
    string: 'Default Destination Location',
    checkCompany: true, help: "This is the default destination location when you create a picking manually with this operation type. It is possible however to change it or that the routes put another location. If it is empty, it will check for the customer location on the partner."
  });
  static code = Fields.Selection([['incoming', 'Receipt'], ['outgoing', 'Delivery'], ['internal', 'Internal Transfer']], { string: 'Type of Operation', required: true });
  static returnPickingTypeId = Fields.Many2one(
    'stock.picking.type', {
    string: 'Operation Type for Returns',
    checkCompany: true
  });
  static showEntirePacks = Fields.Boolean('Move Entire Packages', { help: "If ticked, you will be able to select entire packages to move" });
  static warehouseId = Fields.Many2one(
    'stock.warehouse', {
    string: 'Warehouse', ondelete: 'CASCADE',
    checkCompany: true
  });
  static active = Fields.Boolean('Active', { default: true });
  static useCreateLots = Fields.Boolean(
    'Create New Lots/Serial Numbers', {
    default: true,
    help: "If this is checked only, it will suppose you want to create new Lots/Serial Numbers, so you can provide them in a text field."
  });
  static useExistingLots = Fields.Boolean('Use Existing Lots/Serial Numbers', {
    default: true, help: "If this is checked, you will be able to choose the Lots/Serial Numbers. You can also decide to not put lots in this operation type.  This means it will create stock with no lot or not put a restriction on the lot taken."
  });
  static printLabel = Fields.Boolean(
    'Print Label', { help: "If this checkbox is ticked, label will be print in this operation." });
  static showOperations = Fields.Boolean(
    'Show Detailed Operations', {
    default: self => self._defaultShowOperations(),
    help: "If this checkbox is ticked, the pickings lines will represent detailed stock operations. If not, the picking lines will represent an aggregate of detailed stock operations."
  });
  static showReserved = Fields.Boolean(
    'Pre-fill Detailed Operations', {
    default: true,
    help: "If this checkbox is ticked, Verp will automatically pre-fill the detailed operations with the corresponding products, locations and lot/serial numbers."
  });
  static reservationMethod = Fields.Selection(
    [['atConfirm', 'At Confirmation'], ['manual', 'Manually'], ['by_date', 'Before scheduled date']],
    {
      string: 'Reservation Method', required: true, default: 'atConfirm',
      help: "How products in transfers of this operation type should be reserved."
    });
  static reservationDaysBefore = Fields.Integer('Days', { help: "Maximum number of days before scheduled date that products should be reserved." });
  static reservationDaysBeforePriority = Fields.Integer('Days when starred', { help: "Maximum number of days before scheduled date that priority picking products should be reserved." });

  static countPickingDraft = Fields.Integer({ compute: '_computePickingCount' });
  static countPickingReady = Fields.Integer({ compute: '_computePickingCount' });
  static countPicking = Fields.Integer({ compute: '_computePickingCount' });
  static countPickingWaiting = Fields.Integer({ compute: '_computePickingCount' });
  static countPickingLate = Fields.Integer({ compute: '_computePickingCount' });
  static countPickingBackorders = Fields.Integer({ compute: '_computePickingCount' });
  static barcode = Fields.Char('Barcode', { copy: false });
  static companyId = Fields.Many2one(
    'res.company', {
    string: 'Company', required: true,
    default: async (s) => (await s.env.company()).id, index: true
  });

  @api.model()
  async create(vals) {
    if (!('sequenceId' in vals) || !vals['sequenceId']) {
      if (vals['warehouseId']) {
        const wh = this.env.items('stock.warehouse').browse(vals['warehouseId']);
        const [label, code, companyId] = await wh('label', 'code', 'companyId');
        vals['sequenceId'] = await (await this.env.items('ir.sequence').sudo()).create({
          'label': label + ' ' + await this._t('Sequence') + ' ' + vals['sequenceCode'],
          'prefix': code + '/' + vals['sequenceCode'] + '/', 'padding': 5,
          'companyId': companyId.id,
        }).id
      }
      else {
        vals['sequenceId'] = await (await this.env.items('ir.sequence').sudo()).create({
          'label': await this._t('Sequence') + ' ' + vals['sequenceCode'],
          'prefix': vals['sequenceCode'], 'padding': 5,
          'companyId': vals.get('companyId') ?? (await this.env.company()).id,
        }).id
      }
    }
    const pickingType = await _super(PickingType, this).create(vals);
    return pickingType;
  }

  async write(vals) {
    if ('companyId' in vals) {
      for (const pickingType of this) {
        if ((await pickingType.companyId).id != vals['companyId']) {
          throw new UserError(await this._t("Changing the company of this record is forbidden at this point, you should rather archive it and create a new one."));
        }
      }
    }
    if ('sequenceCode' in vals) {
      for (const pickingType of this) {
        const [warehouseId, sequenceId] = await pickingType('warehouseId', 'sequenceId');
        if (warehouseId.ok) {
          const [label, code, companyId] = await warehouseId('label', 'code', 'companyId');
          await (await sequenceId.sudo()).write({
            'label': label + ' ' + await this._t('Sequence') + ' ' + vals['sequenceCode'],
            'prefix': code + '/' + vals['sequenceCode'] + '/', 'padding': 5,
            'companyId': companyId.id,
          });
        }
        else {
          await (await sequenceId.sudo()).write({
            'label': await this._t('Sequence') + ' ' + vals['sequenceCode'],
            'prefix': vals['sequenceCode'], 'padding': 5,
            'companyId': (await pickingType.env.company()).id,
          })
        }
      }
    }
    return _super(PickingType, this).write(vals);
  }

  async _computePickingCount() {
    const domains = {
      'countPickingDraft': [['state', '=', 'draft']],
      'countPickingWaiting': [['state', 'in', ['confirmed', 'waiting']]],
      'countPickingReady': [['state', '=', 'assigned']],
      'countPicking': [['state', 'in', ['assigned', 'waiting', 'confirmed']]],
      'countPickingLate': [['scheduledDate', '<', DateTime.now().toFormat(DEFAULT_SERVER_DATETIME_FORMAT)], ['state', 'in', ['assigned', 'waiting', 'confirmed']]],
      'countPickingBackorders': [['backorderId', '!=', false], ['state', 'in', ['confirmed', 'assigned', 'waiting']]],
    }
    for (const field of Object.keys(domains)) {
      const data = await this.env.items('stock.picking').readGroup(domains[field].concat(
        [['state', 'not in', ['done', 'cancel']], ['pickingTypeId', 'in', this.ids]]),
        ['pickingTypeId'], ['pickingTypeId']);
      const count = Object.fromEntries(data.filter(x => x['pickingTypeId']).map(x => [x['pickingTypeId'][0], x['pickingTypeId_count']]));
      for (const record of this) {
        await record.set(field, count[record.id] || 0);
      }
    }
  }

  /**
   * Display 'Warehouse_name: PickingType_name'
   * @returns 
   */
  async nameGet() {
    const res = [];
    for (const pickingType of this) {
      let [label, warehouseId] = await pickingType('label', 'warehouseId');
      if (warehouseId.ok) {
        label = await warehouseId.label + ': ' + label
      }
      res.push([pickingType.id, label]);
    }
    return res;
  }

  @api.model()
  async _nameSearch(name?: string, args?: any, operator = 'ilike', { limit=100, nameGetUid=false } = {}) {
    args = args ?? []
    let domain = [];
    if (name) {
      domain = ['|', ['label', operator, name], ['warehouseId.label', operator, name]];
    }
    return this._search(expression.AND([domain, args]), { limit, accessRightsUid: nameGetUid });
  }

  @api.onchange('code')
  async _onchangePickingCode() {
    const [companyId, code] = await this('companyId', 'code');
    const warehouse = await this.env.items('stock.warehouse').search([['companyId', '=', companyId.id]], { limit: 1 });
    const stockLocation = await warehouse.lotStockId;
    await this.set('showOperations', code !== 'incoming' && await this.userHasGroups('stock.groupProductionLot, stock.groupStockMultiLocations, stock.groupTrackingLot'));
    if (code === 'incoming') {
      // await Promise.all([
      await this.set('defaultLocationSrcId', (await this.env.ref('stock.stockLocationSuppliers')).id),
        await this.set('defaultLocationDestId', stockLocation.id),
        await this.set('printLabel', false)
      // ]);
    }
    else if (code === 'outgoing') {
      // await Promise.all([
      await this.set('defaultLocationSrcId', stockLocation.id),
        await this.set('defaultLocationDestId', (await this.env.ref('stock.stockLocationCustomers')).id),
        await this.set('printLabel', true)
      // ]);
    }
    else if (code === 'internal') {
      await this.set('printLabel', false);
      if (! await this.userHasGroups('stock.groupStockMultiLocations')) {
        return {
          'warning': {
            'message': await this._t('You need to activate storage locations to be able to do internal operation types.')
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
      await this.set('warehouseId', warehouse);
    }
    else {
      await this.set('warehouseId', false);
    }
  }

  @api.onchange('showOperations')
  async _onchangeShowOperations() {
    const [showOperations, code] = await this('showOperations', 'code');
    if (showOperations && code !== 'incoming') {
      await this.set('showReserved', true);
    }
  }

  async _getAction(actionXmlid) {
    const action = await this.env.items("ir.actions.actions")._forXmlid(actionXmlid);
    if (this.ok) {
      action['displayName'] = await this['displayName']
    }

    let defaultImmediateTranfer = true;
    if (await (await this.env.items('ir.config.parameter').sudo()).getParam('stock.noDefaultImmediateTranfer')) {
      defaultImmediateTranfer = false;
    }

    let context = {
      'searchDefault_pickingTypeId': [this.id],
      'default_pickingTypeId': this.id,
      'default_immediateTransfer': defaultImmediateTranfer,
      'default_companyId': (await this['companyId']).id,
    }

    const actionContext = literalEval(action['context']);
    context = { ...actionContext, ...context }
    action['context'] = context;
    return action;
  }

  async getActionPickingTreeLate() {
    return this._getAction('stock.actionPickingTreeLate');
  }

  async getActionPickingTreeBackorder() {
    return this._getAction('stock.actionPickingTreeBackorder');
  }

  async getActionPickingTreeWaiting() {
    return this._getAction('stock.actionPickingTreeWaiting');
  }

  async getActionPickingTreeReady() {
    return this._getAction('stock.actionPickingTreeReady');
  }

  async getActionPickingTypeOperations() {
    return this._getAction('stock.actionGetPickingTypeOperations');
  }

  async getStockPickingActionPickingType() {
    return this._getAction('stock.stockPickingActionPickingType');
  }
}

@MetaModel.define()
class Picking extends Model {
  static _module = module;
  static _name = "stock.picking";
  static _parents = ['mail.thread', 'mail.activity.mixin'];
  static _description = "Transfer";
  static _order = "priority desc, scheduledDate asc, id desc"

  static label = Fields.Char(
    'Reference', {
    default: '/',
    copy: false, index: true, readonly: true
  });
  static origin = Fields.Char(
    'Source Document', {
    index: true,
    states: { 'done': [['readonly', true]], 'cancel': [['readonly', true]] },
    help: "Reference of the document"
  });
  static note = Fields.Html('Notes');
  static backorderId = Fields.Many2one(
    'stock.picking', {
    string: 'Back Order of',
    copy: false, index: true, readonly: true,
    checkCompany: true,
    help: "If this shipment was split, then this field links to the shipment which contains the already processed part."
  });
  static backorderIds = Fields.One2many('stock.picking', 'backorderId', { string: 'Back Orders' });
  static moveType = Fields.Selection([
    ['direct', 'As soon as possible'], ['one', 'When all products are ready']], {
    string: 'Shipping Policy',
    default: 'direct', required: true,
    states: { 'done': [['readonly', true]], 'cancel': [['readonly', true]] },
    help: "It specifies goods to be deliver partially or all at once"
  })
  static state = Fields.Selection([
    ['draft', 'Draft'],
    ['waiting', 'Waiting Another Operation'],
    ['confirmed', 'Waiting'],
    ['assigned', 'Ready'],
    ['done', 'Done'],
    ['cancel', 'Cancelled'],
  ], {
    string: 'Status', compute: '_computeState',
    copy: false, index: true, readonly: true, store: true, tracking: true,
    help: [" * Draft: The transfer is not confirmed yet. Reservation doesn't apply.\n",
      " * Waiting another operation: This transfer is waiting for another operation before being ready.\n",
      " * Waiting: The transfer is waiting for the availability of some products.\n(a) The shipping policy is \"As soon as possible\": no product could be reserved.\n(b) The shipping policy is \"When all products are ready\": not all the products could be reserved.\n",
      " * Ready: The transfer is ready to be processed.\n(a) The shipping policy is \"As soon as possible\": at least one product has been reserved.\n(b) The shipping policy is \"When all products are ready\": all product have been reserved.\n",
      " * Done: The transfer has been processed.\n",
      " * Cancelled: The transfer has been cancelled."].join('')
  });
  static groupId = Fields.Many2one(
    'procurement.group', {
    string: 'Procurement Group',
    readonly: true, related: 'moveLines.groupId', store: true
  });
  static priority = Fields.Selection(
    PROCUREMENT_PRIORITIES, {
    string: 'Priority', default: '0',
    help: "Products will be reserved first for the transfers with the highest priorities."
  });
  static scheduledDate = Fields.Datetime(
    'Scheduled Date', {
    compute: '_computeScheduledDate', inverse: '_setScheduledDate', store: true,
    index: true, default: () => _Datetime.now(), tracking: true,
    states: { 'done': [['readonly', true]], 'cancel': [['readonly', true]] },
    help: "Scheduled time for the first part of the shipment to be processed. Setting manually a value here would set it as expected date for all the stock moves."
  });
  static dateDeadline = Fields.Datetime(
    "Deadline", {
    compute: '_computeDateDeadline', store: true,
    help: "Date Promise to the customer on the top level document (SO/PO)"
  });
  static hasDeadlineIssue = Fields.Boolean(
    "Is late", {
    compute: '_computeHasDeadlineIssue', store: true, default: false,
    help: "Is late or will be late depending on the deadline and scheduled date"
  });
  static date = Fields.Datetime('Creation Date', {
    default: () => _Datetime.now(), tracking: true,
    states: { 'done': [['readonly', true]], 'cancel': [['readonly', true]] },
    help: "Creation Date, usually the time of the order"
  });
  static dateDone = Fields.Datetime('Date of Transfer', { copy: false, readonly: true, help: "Date at which the transfer has been processed or cancelled." });
  static delayAlertDate = Fields.Datetime('Delay Alert Date', { compute: '_computeDelayAlertDate', search: '_searchDelayAlertDate' });
  static jsonPopover = Fields.Char('JSON data for the popover widget', { compute: '_computeJsonPopover' });
  static locationId = Fields.Many2one(
    'stock.location', {
    string: "Source Location",
    default: self => self.env.items('stock.picking.type').browse(self._context['default_pickingTypeId']).defaultLocationSrcId, checkCompany: true, readonly: true, required: true,
    states: { 'draft': [['readonly', false]] }
  });
  static locationDestId = Fields.Many2one(
    'stock.location', {
    string: "Destination Location",
    default: self => self.env.items('stock.picking.type').browse(self._context['default_pickingTypeId']).defaultLocationDestId, checkCompany: true, readonly: true, required: true,
    states: { 'draft': [['readonly', false]] }
  });
  static moveLines = Fields.One2many('stock.move', 'pickingId', { string: "Stock Moves", copy: true });
  static moveIdsWithoutPackage = Fields.One2many('stock.move', 'pickingId', { string: "Stock moves not in package", compute: '_computeMoveWithoutPackage', inverse: '_setMoveWithoutPackage' });
  static hasScrapMove = Fields.Boolean(
    'Has Scrap Moves', { compute: '_hasScrapMove' });
  static pickingTypeId = Fields.Many2one(
    'stock.picking.type', {
    string: 'Operation Type',
    required: true, readonly: true,
    states: { 'draft': [['readonly', false]] }
  });
  static pickingTypeCode = Fields.Selection({ related: 'pickingTypeId.code', readonly: true });
  static pickingTypeEntirePacks = Fields.Boolean({ related: 'pickingTypeId.showEntirePacks' });
  static useCreateLots = Fields.Boolean({ related: 'pickingTypeId.useCreateLots' });
  static useExistingLots = Fields.Boolean({ related: 'pickingTypeId.useExistingLots' });
  static hidePickingType = Fields.Boolean({ compute: '_computeHidePickignType' });
  static partnerId = Fields.Many2one(
    'res.partner', {
    string: 'Contact',
    checkCompany: true,
    states: { 'done': [['readonly', true]], 'cancel': [['readonly', true]] }
  });
  static companyId = Fields.Many2one(
    'res.company', {
    string: 'Company', related: 'pickingTypeId.companyId',
    readonly: true, store: true, index: true
  });
  static userId = Fields.Many2one(
    'res.users', {
    string: 'Responsible', tracking: true,
    domain: async (self) => [['groupsId', 'in', (await self.env.ref('stock.groupStockUser')).id]],
    states: { 'done': [['readonly', true]], 'cancel': [['readonly', true]] },
    default: self => self.env.user()
  });
  static moveLineIds = Fields.One2many('stock.move.line', 'pickingId', { string: 'Operations' });
  static moveLineIdsWithoutPackage = Fields.One2many('stock.move.line', 'pickingId', { string: 'Operations without package', domain: ['|', ['packageLevelId', '=', false], ['pickingTypeEntirePacks', '=', false]] });
  static moveLineNosuggestIds = Fields.One2many('stock.move.line', 'pickingId', { domain: [['productQty', '=', 0.0]] });
  static moveLineExist = Fields.Boolean(
    'Has Pack Operations', {
    compute: '_computeMoveLineExist',
    help: 'Check the existence of pack operation on the picking'
  });
  static hasPackages = Fields.Boolean(
    'Has Packages', {
    compute: '_computeHasPackages',
    help: 'Check the existence of destination packages on move lines'
  });
  static showCheckAvailability = Fields.Boolean({
    compute: '_computeShowCheckAvailability',
    help: 'Technical field used to compute whether the button "Check Availability" should be displayed.'
  });
  static showMarkAsTodo = Fields.Boolean({
    compute: '_computeShowMarkAsTodo',
    help: 'Technical field used to compute whether the button "Mark as Todo" should be displayed.'
  });
  static showValidate = Fields.Boolean({
    compute: '_computeShowValidate',
    help: 'Technical field used to decide whether the button "Validate" should be displayed.'
  });
  static ownerId = Fields.Many2one(
    'res.partner', {
    string: 'Assign Owner',
    states: { 'done': [['readonly', true]], 'cancel': [['readonly', true]] },
    checkCompany: true,
    help: "When validating the transfer, the products will be assigned to this owner."
  });
  static printed = Fields.Boolean('Printed', { copy: false });
  static signature = Fields.Image('Signature', { help: 'Signature', copy: false, attachment: true });
  static isSigned = Fields.Boolean('Is Signed', { compute: "_computeIsSigned" });
  static isLocked = Fields.Boolean({ default: true, help: 'When the picking is not done this allows changing the initial demand. When the picking is done this allows changing the done quantities.' });
  // Used to search on pickings
  static productId = Fields.Many2one('product.product', { string: 'Product', related: 'moveLines.productId', readonly: true });
  static showOperations = Fields.Boolean({ compute: '_computeShowOperations' });
  static showReserved = Fields.Boolean({ related: 'pickingTypeId.showReserved' });
  static showLotsText = Fields.Boolean({ compute: '_computeShowLotsText' });
  static hasTracking = Fields.Boolean({ compute: '_computeHasTracking' });
  static immediateTransfer = Fields.Boolean({ default: false });
  static packageLevelIds = Fields.One2many('stock.package.level', 'pickingId');
  static packageLevelIdsDetails = Fields.One2many('stock.package.level', 'pickingId');
  static productsAvailability = Fields.Char({ string: "Product Availability", compute: '_computeProductsAvailability' });
  static productsAvailabilityState = Fields.Selection([
    ['available', 'Available'],
    ['expected', 'Expected'],
    ['late', 'Late']], { compute: '_computeProductsAvailability' });

  static _sqlConstraints = [
    ['label_uniq', 'unique(label, "companyId")', 'Reference must be unique per company!'],
  ];

  async _computeHasTracking() {
    for (const picking of this) {
      let some;
      for (const m of await picking.moveLines) {
        if (await m.hasTracking !== 'none') {
          some = true;
          break;
        }
      }
      await picking.set('hasTracking', some);
    }
  }

  @api.depends('dateDeadline', 'scheduledDate')
  async _computeHasDeadlineIssue() {
    for (const picking of this) {
      const [dateDeadline, scheduledDate] = await picking('dateDeadline', 'scheduledDate');
      await picking.set('hasDeadlineIssue', dateDeadline && dateDeadline < scheduledDate || false);
    }
  }

  async _computeHidePickignType() {
    await this.set('hidePickingType', await this.env.context['default_pickingTypeId'] ?? false);
  }

  @api.depends('moveLines.delayAlertDate')
  async _computeDelayAlertDate() {
    const delayAlertDateData = await this.env.items('stock.move').readGroup([['id', 'in', (await this['moveLines']).ids], ['delayAlertDate', '!=', false]], ['delayAlertDate:max'], 'pickingId');
    const _delayAlertDateData = {};
    for (const data of delayAlertDateData) {
      _delayAlertDateData[data['pickingId'][0]] = data['delayAlertDate'];
    }
    for (const picking of this) {
      await picking.set('delayAlertDate', _delayAlertDateData[picking.id] ?? false);
    }
  }

  @api.depends('signature')
  async _computeIsSigned() {
    for (const picking of this) {
      await picking.set('isSigned', await picking.signature);
    }
  }

  @api.depends('state', 'pickingTypeCode', 'scheduledDate', 'moveLines', 'moveLines.forecastAvailability', 'moveLines.forecastExpectedDate')
  async _computeProductsAvailability() {
    const pickings = await this.filtered(async (picking) => ['waiting', 'confirmed', 'assigned'].includes(await picking.state) && picking.pickingTypeCode === 'outgoing');
    await pickings.set('productsAvailabilityState', 'available');
    const otherPickings = this.sub(pickings);
    await otherPickings.set('productsAvailability', false);
    await otherPickings.set('productsAvailabilityState', false);

    const pickingsReady = await pickings.filtered(async (picking) => await picking.state === 'assigned');
    await otherPickings.set('productsAvailability', await this._t('Ready'));
    const pickingsNotReady = pickings.sub(pickingsReady);
    await pickingsNotReady.set('productsAvailability', await this._t('Available'));

    const allMoves = await pickingsNotReady.moveLines;
    // Force to prefetch more than 1000 by 1000
    await allMoves._fields['forecastAvailability'].computeValue(allMoves);
    for (const picking of pickings) {
      // In case of draft the behavior of forecast_availability is different : if forecast_availability < 0 then there is a issue else not.
      const [moveLines, scheduledDate] = await picking('moveLines', 'scheduledDate');
      let some;
      for (const move of moveLines) {
        const [state, forecastAvailability, productId, productQty] = await move('state', 'forecastAvailability', 'productId', 'productQty');
        if (floatCompare(forecastAvailability, state === 'draft' ? 0 : productQty, { precisionRounding: await (await productId.uomId).rounding }) == -1) {
          some = true;
          break;
        }
      }
      if (some) {
        // await Promise.all([
        await picking.set('productsAvailability', await this._t('Not Available')),
          await picking.set('productsAvailabilityState', 'late')
        // ]);
      }
      else {
        const list = await (await moveLines.filtered('forecastExpectedDate')).mapped('forecastExpectedDate');
        const forecastDate = bool(list) ? dateMax(list) : false;
        if (forecastDate) {
          // await Promise.all([
          await picking.set('productsAvailability', await this._t('Exp %s', await formatDate(this.env, forecastDate))),
            await picking.set('productsAvailabilityState', scheduledDate && scheduledDate < forecastDate ? 'late' : 'expected')
          // ]);
        }
      }
    }
  }

  @api.depends('pickingTypeId.showOperations')
  async _computeShowOperations() {
    for (const picking of this) {
      if (this.env.context['forceDetailedView']) {
        await picking.set('showOperations', true);
        continue;
      }
      const [pickingTypeId, state, immediateTransfer] = await picking('pickingTypeId', 'state', 'immediateTransfer');
      if (await pickingTypeId.showOperations) {
        if ((state === 'draft' && immediateTransfer) || state !== 'draft') {
          await picking.set('showOperations', true);
        }
        else {
          await picking.set('showOperations', false);
        }
      }
      else {
        await picking.set('showOperations', false);
      }
    }
  }

  @api.depends('moveLineIds', 'pickingTypeId.useCreateLots', 'pickingTypeId.useExistingLots', 'state')
  async _computeShowLotsText() {
    const groupProductionLotEnabled = await this.userHasGroups('stock.groupProductionLot');
    for (const picking of this) {
      const [pickingTypeId, moveLineIds, state] = await picking('pickingTypeId', 'moveLineIds', 'state');
      if (!moveLineIds.ok && !await pickingTypeId.useCreateLots) {
        await picking.set('showLotsText', false);
      }
      else if (groupProductionLotEnabled && await pickingTypeId.useCreateLots && !await pickingTypeId.useExistingLots && picking.state !== 'done') {
        await picking.set('showLotsText', true);
      }
      else {
        await picking.set('showLotsText', false);
      }
    }
  }

  async _computeJsonPopover() {
    const pickingNoAlert = await this.filtered(async (p) => ['done', 'cancel'].includes(await p.state) || ! await p.delayAlertDate);
    await pickingNoAlert.set('jsonPopover', false);
    for (const picking of this.sub(pickingNoAlert)) {
      const lateElements = [];
      const moveOrigIds = await (await (await picking.moveLines).filtered(async (m) => await m.delayAlertDate)).moveOrigIds;
      for (const lateMove of await moveOrigIds._delayAlertGetDocuments()) {
        lateElements.push({
          'id': lateMove.id,
          'label': await lateMove.displayName,
          'model': lateMove._name,
        });
      }

      await picking.set('jsonPopover', stringify({
        'popoverTemplate': 'stock.PopoverStockRescheduling',
        'delayAlertDate': await formatDatetime(this.env, await picking.delayAlertDate), //, dt_format=false),
        'lateElements': lateElements
      }));
    }
  }

  /**
   * State of a picking depends on the state of its related stock.move
      - Draft: only used for "planned pickings"
      - Waiting: if the picking is not ready to be sent so if
        - (a) no quantity could be reserved at all or if
        - (b) some quantities could be reserved and the shipping policy is "deliver all at once"
      - Waiting another move: if the picking is waiting for another move
      - Ready: if the picking is ready to be sent so if:
        - (a) all quantities are reserved or if
        - (b) some quantities could be reserved and the shipping policy is "as soon as possible"
      - Done: if the picking is done.
      - Cancelled: if the picking is cancelled
   */
  @api.depends('moveType', 'immediateTransfer', 'moveLines.state', 'moveLines.pickingId')
  async _computeState() {
    const pickingMovesStateMap = new DefaultDict();
    const pickingMoveLines = new DefaultDict();
    for (const move of await this.env.items('stock.move').search([['pickingId', 'in', this.ids]])) {
      const [pickingId, moveState] = await move('pickingId', 'state');
      const id = pickingId.id;
      pickingMovesStateMap[id] = pickingMovesStateMap[id] ?? new Dict();
      pickingMovesStateMap[id].updateFrom({
        'anyDraft': pickingMovesStateMap[id].get('anyDraft', false) || moveState === 'draft',
        'allCancel': pickingMovesStateMap[id].get('allCancel', true) && moveState === 'cancel',
        'allCancelDone': pickingMovesStateMap[id].get('allCancelDone', true) && ['cancel', 'done'].includes(moveState),
      });
      pickingMoveLines[id] = pickingMoveLines[id] ?? new Set();
      pickingMoveLines[id].add(move.id);
    }
    for (const picking of this) {
      const id = picking.id;
      let state;
      if (!pickingMovesStateMap[id]) {
        state = 'draft';
      }
      else if (pickingMovesStateMap[id]['anyDraft']) {
        state = 'draft';
      }
      else if (pickingMovesStateMap[id]['allCancel']) {
        state = 'cancel';
      }
      else if (pickingMovesStateMap[id]['allCancelDone']) {
        state = 'done';
      }
      else {
        const relevantMoveState = await this.env.items('stock.move').browse(pickingMoveLines[id])._getRelevantStateAmongMoves();
        if (await picking.immediateTransfer && !['draft', 'cancel', 'done'].includes(relevantMoveState)) {
          state = 'assigned';
        }
        else if (relevantMoveState === 'partiallyAvailable') {
          state = 'assigned';
        }
        else {
          state = relevantMoveState;
        }
      }
      await picking.set('state', state);
    }
  }

  @api.depends('moveLines.state', 'moveLines.date', 'moveType')
  async _computeScheduledDate() {
    for (const picking of this) {
      const [moveLines, moveType, scheduledDate] = await picking('moveLines', 'moveType', 'scheduledDate');
      const movesDates = await (await moveLines.filtered(async (move) => !['done', 'cancel'].includes(move.state))).mapped('date');
      if (moveType === 'direct') {
        await picking.set('scheduledDate', bool(movesDates) ? dateMin(movesDates) : scheduledDate ?? _Datetime.now());
      }
      else {
        await picking.set('scheduledDate', bool(movesDates) ? dateMax(movesDates) : scheduledDate ?? _Datetime.now());
      }
    }
  }

  @api.depends('moveLines.dateDeadline', 'moveType')
  async _computeDateDeadline() {
    for (const picking of this) {
      const dateDeadlines = await (await (await picking.moveLines).filtered('dateDeadline')).mapped('dateDeadline');
      if (await picking.moveType === 'direct') {
        await picking.set('dateDeadline', bool(dateDeadlines) ? dateMin(dateDeadlines) : false);
      }
      else {
        await picking.set('dateDeadline', bool(dateDeadlines) ? dateMax(dateDeadlines) : false);
      }
    }
  }

  async _setScheduledDate() {
    for (const picking of this) {
      const [moveLines, state, scheduledDate] = await picking('moveLines', 'state', 'scheduledDate');
      if (['done', 'cancel'].includes(state)) {
        throw new UserError(await this._t("You cannot change the Scheduled Date on a done or cancelled transfer."));
      }
      await moveLines.write({ 'date': scheduledDate });
    }
  }

  async _hasScrapMove() {
    for (const picking of this) {
      // TDE FIXME: better implementation
      await picking.set('hasScrapMove', bool(await this.env.items('stock.move').searchCount([['pickingId', '=', picking.id], ['scrapped', '=', true]])));
    }
  }

  async _computeMoveLineExist() {
    for (const picking of this) {
      await picking.set('moveLineExist', bool(await picking.moveLineIds));
    }
  }

  async _computeHasPackages() {
    const domain = [['pickingId', 'in', this.ids], ['resultPackageId', '!=', false]];
    let cntByPicking = await this.env.items('stock.move.line').readGroup(domain, ['pickingId'], ['pickingId']);
    cntByPicking = Object.fromEntries(cntByPicking.map(d => [d['pickingId'][0], d['pickingId_count']]));
    for (const picking of this) {
      await picking.set('hasPackages', bool(cntByPicking[picking.id] ?? false));
    }
  }

  /**
   * According to `picking.showCheckAvailability`, the "check availability" button will be displayed in the form view of a picking.
   */
  @api.depends('immediateTransfer', 'state')
  async _computeShowCheckAvailability() {
    for (const picking of this) {
      const [state, immediateTransfer, moveLines] = await picking('state', 'immediateTransfer', 'moveLines');
      if (immediateTransfer || !['confirmed', 'waiting', 'assigned'].includes(state)) {
        await picking.set('showCheckAvailability', false);
        continue;
      }
      let some;
      for (const move of moveLines) {
        const [moveState, productUomQty, productUom] = await move('state', 'productUomQty', 'productUom');
        if (['waiting', 'confirmed', 'partiallyAvailable'].includes(moveState) && floatCompare(productUomQty, 0, { precisionRounding: await productUom.rounding })) {
          some = true;
          break;
        }
      }
      await picking.set('showCheckAvailability', some);
    }
  }

  @api.depends('state', 'moveLines')
  async _computeShowMarkAsTodo() {
    for (const picking of this) {
      const [state, moveLines, packageLevelIds, immediateTransfer] = await picking('state', 'moveLines', 'packageLevelIds', 'immediateTransfer');
      let showMarkAsTodo;
      if (!bool(moveLines) && !bool(packageLevelIds)) {
        showMarkAsTodo = false;
      }
      else if (!immediateTransfer && state === 'draft') {
        showMarkAsTodo = true;
      }
      else if (state !== 'draft' || !bool(picking.id)) {
        showMarkAsTodo = false;
      }
      else {
        showMarkAsTodo = true;
      }
      await picking.set('showMarkAsTodo', showMarkAsTodo);
    }
  }

  @api.depends('state')
  async _computeShowValidate() {
    for (const picking of this) {
      const [state, immediateTransfer] = await picking('state', 'immediateTransfer');
      let showValidate;
      if (!immediateTransfer && state === 'draft') {
        showValidate = false;
      }
      else if (!['draft', 'waiting', 'confirmed', 'assigned'].includes(state)) {
        showValidate = false;
      }
      else {
        showValidate = true;
      }
      await picking.set('showValidate', showValidate);
    }
  }

  @api.model()
  async _searchDelayAlertDate(operator, value) {
    const lateStockMoves = await this.env.items('stock.move').search([['delayAlertDate', operator, value]]);
    return [['moveLines', 'in', lateStockMoves.ids]];
  }

  @api.onchange('partnerId')
  async onchangePartnerId() {
    for (const picking of this) {
      const pickingId = bool(picking.id) && picking.id || getattr(picking, '_origin', false) && picking._origin.id;
      if (pickingId) {
        const moves = await this.env.items('stock.move').search([['pickingId', '=', pickingId]]);
        for (const move of moves) {
          await move.write({ 'partnerId': (await picking.partnerId).id });
        }
      }
    }
  }

  @api.onchange('pickingTypeId', 'partnerId')
  async _onchangePickingType() {
    const [pickingTypeId, state, companyId, partnerId] = await this('pickingTypeId', 'state', 'companyId', 'partnerId');
    if (pickingTypeId.ok && state === 'draft') {
      const self = await this.withCompany(companyId);
      const [pickingTypeId, partnerId, moveLines, productId] = await self('pickingTypeId', 'partnerId', 'moveLines', 'productId');
      const [defaultLocationSrcId, defaultLocationDestId] = await pickingTypeId('defaultLocationSrcId', 'defaultLocationDestId');
      let customerloc, locationId, locationDestId, supplierloc;
      if (defaultLocationSrcId.ok) {
        locationId = defaultLocationSrcId.id;
      }
      else if (partnerId.ok) {
        locationId = (await partnerId.propertyStockSupplier).id;
      }
      else {
        [customerloc, locationId] = await self.env.items('stock.warehouse')._getPartnerLocations();
      }

      if (defaultLocationDestId.ok) {
        locationDestId = defaultLocationDestId.id;
      }
      else if (partnerId.ok) {
        locationDestId = (await partnerId.propertyStockCustomer).id;
      }
      else {
        [locationDestId, supplierloc] = await self.env.items('stock.warehouse')._getPartnerLocations();
      }
      // await Promise.all([
      await self.set('locationId', locationId),
        await self.set('locationDestId', locationDestId)
      // ]);
      await moveLines.or(await self.moveIdsWithoutPackage).update({
        "pickingTypeId": pickingTypeId,  // The compute store doesn't work in case of One2many inverse (moveIdsWithoutPackage)
        "companyId": await self.companyId,
      })
      for (const move of moveLines.or(await self.moveIdsWithoutPackage)) {
        await move.set('descriptionPicking', await productId._getDescription(await move.pickingTypeId));
      }
    }
    const [pickingWarn, parentId] = await partnerId('pickingWarn', 'parentId');
    if (partnerId.ok && pickingWarn) {
      let partner;
      if (pickingWarn === 'no-message' && parentId.ok) {
        partner = parentId;
      }
      else if (!['no-message', 'block'].includes(pickingWarn) && await parentId.pickingWarn === 'block') {
        partner = parentId;
      }
      else {
        partner = partnerId;
      }
      const [partnerPickingWarn, partnerPickingWarnMsg, partnerLabel] = await partner('pickingWarn', 'partnerPickingWarnMsg', 'label');
      if (partnerPickingWarn !== 'no-message') {
        if (partnerPickingWarn === 'block') {
          await this.set('partnerId', false);
        }
        return {
          'warning': {
            'title': f("Warning for %s", partnerLabel),
            'message': partnerPickingWarnMsg
          }
        }
      }
    }
  }

  @api.onchange('locationId', 'locationDestId')
  async _onchangeLocations() {
    const [moveLines, moveIdsWithoutPackage, locationId, locationDestId] = await this('moveLines', 'moveIdsWithoutPackage', 'locationId', 'locationDestId');
    await moveLines.or(moveIdsWithoutPackage).update({
      "locationId": locationId,
      "locationDestId": locationDestId
    });
  }

  @api.model()
  async create(vals) {
    const defaults = await this.defaultGet(['label', 'pickingTypeId']);
    const pickingType = this.env.items('stock.picking.type').browse(vals['pickingTypeId'] ?? defaults['pickingTypeId']);
    if ((vals['label'] ?? '/') === '/' && (defaults['label'] ?? '/') === '/' && (vals['pickingTypeId'] ?? defaults['pickingTypeId'])) {
      const sequenceId = await pickingType.sequenceId;
      if (sequenceId.ok) {
        vals['label'] = await sequenceId.nextById();
      }
    }

    // make sure to write `scheduleDate` *after* the `stock.move` creation in
    // order to get a determinist execution of `_setScheduledDate`
    const scheduledDate = pop(vals, 'scheduledDate', false);
    const res = await _super(Picking, this).create(vals);
    if (scheduledDate) {
      await (await res.withContext({ mailNotrack: true })).write({ 'scheduledDate': scheduledDate });
    }
    await res._autoconfirmPicking();

    // set partner as follower
    if (vals['partnerId']) {
      for (const picking of await res.filtered(async (p) => await (await p.locationId).usage === 'supplier' || await (await p.locationDestId).usage === 'customer')) {
        await picking.messageSubscribe([vals['partnerId']]);
      }
    }
    if (vals['pickingTypeId']) {
      for (const move of await res.moveLines) {
        if (! await move.descriptionPicking) {
          await move.set('descriptionPicking', await (await (await move.productId).withContext({ lang: move._getLang() }))._getDescription(await (await move.pickingId).pickingTypeId));
        }
      }
    }
    return res;
  }

  async write(vals) {
    if (vals['pickingTypeId'] && await this.some(async (picking) => await picking.state !== 'draft')) {
      throw new UserError(await this._t("Changing the operation type of this record is forbidden at this point."));
    }
    // set partner as a follower and unfollow old partner
    if (vals['partnerId']) {
      for (const picking of this) {
        const [partnerId, locationId, locationDestId] = await picking('partnerId', 'locationId', 'locationDestId');
        if (await locationId.usage === 'supplier' || await locationDestId.usage === 'customer') {
          if (partnerId.ok) {
            await picking.messageUnsubscribe(partnerId.ids);
          }
          await picking.messageSubscribe([vals['partnerId']]);
        }
      }
    }
    const res = await _super(Picking, this).write(vals);
    if (vals['signature']) {
      for (const picking of this) {
        await picking._attachSign();
      }
    }
    // Change locations of moves if those of the picking change
    const afterVals = {};
    if (vals['locationId']) {
      afterVals['locationId'] = vals['locationId'];
    }
    if (vals['locationDestId']) {
      afterVals['locationDestId'] = vals['locationDestId'];
    }
    if (bool(afterVals)) {
      await (await (await this.mapped('moveLines')).filtered(async (move) => ! await move.scrapped)).write(afterVals);
    }
    if (vals['moveLines']) {
      await this._autoconfirmPicking();
    }

    return res;
  }

  async unlink() {
    await (await this.mapped('moveLines'))._actionCancel();
    await (await (await this.withContext({ prefetchFields: false })).mapped('moveLines')).unlink()  // Checks if moves are not done
    return _super(Picking, this).unlink();
  }

  async doPrintPicking() {
    await this.write({ 'printed': true });
    return (await this.env.ref('stock.actionReportPicking')).reportAction(this);
  }

  async actionConfirm() {
    await this._checkCompany();
    await (await (await this.mapped('packageLevelIds')).filtered(async (pl) => await pl.state === 'draft' && !bool(await pl.moveIds)))._generateMoves();
    // call `_actionConfirm` on every draft move
    await (await (await this.mapped('moveLines')).filtered(async (move) => await move.state === 'draft'))._actionConfirm();

    // run scheduler for moves forecasted to not have enough in stock
    await (await (await this.mapped('moveLines')).filtered(async (move) => !['draft', 'cancel', 'done'].includes(await move.state)))._triggerScheduler();
    return true;
  }

  /**
   * Check availability of picking moves.
    This has the effect of changing the state and reserve quants on available moves, and may
    also impact the state of the picking as it is computed based on move's states.
    @return: true
   * @returns 
   */
  async actionAssign() {
    await (await this.filtered(async (picking) => await picking.state === 'draft')).actionConfirm();
    const moves = await (await this.mapped('moveLines')).filtered(async (move) => !['draft', 'cancel', 'done'].includes(await move.state));
    if (!bool(moves)) {
      throw new UserError(await this._t('Nothing to check the availability for.'));
    }
    // If a package level is done when confirmed its location can be different than where it will be reserved.
    // So we remove the move lines created when confirmed to set quantity done to the new reserved ones.
    const packageLevelDone = await (await this.mapped('packageLevelIds')).filtered(async (pl) => await pl.isDone && await pl.state === 'confirmed');
    await packageLevelDone.write({ 'isDone': false });
    await moves._actionAssign();
    await packageLevelDone.write({ 'isDone': true });

    return true;
  }

  async actionCancel() {
    await (await this.mapped('moveLines'))._actionCancel();
    await this.write({ 'isLocked': true });
    return true;
  }

  /**
   * Call `_action_done` on the `stock.move` of the `stock.picking` in `self`.
    This method makes sure every `stock.move.line` is linked to a `stock.move` by either
    linking them to an existing one or a newly created one.

    If the context key `cancel_backorder` is present, backorders won't be created.

    :return: true
    :rtype: bool
   * @returns 
   */
  async _actionDone() {
    await this._checkCompany();

    const todoMoves = await (await this.mapped('moveLines')).filtered(async (self) => ['draft', 'waiting', 'partiallyAvailable', 'assigned', 'confirmed'].includes(await self['state']));
    for (const picking of this) {
      const [moveLines, moveLineIds, ownerId] = await picking('moveLines', 'moveLineIds', 'ownerId');
      if (ownerId.ok) {
        await moveLines.write({ 'restrictPartnerId': ownerId.id })
        await moveLineIds.write({ 'ownerId': ownerId.id })
      }
    }
    await todoMoves._actionDone({ cancelBackorder: this.env.context['cancelBackorder'] });
    await this.write({ 'dateDone': _Datetime.now(), 'priority': '0' });

    // if incoming moves make other confirmed/partially_available moves available, assign them
    const doneIncomingMoves = await (await (await this.filtered(async (p) => await (await p.pickingTypeId).code === 'incoming')).moveLines).filtered(async (m) => await m.state === 'done');
    await doneIncomingMoves._triggerAssign();

    await this._sendConfirmationEmail();
    return true;
  }

  async _sendConfirmationEmail() {
    for (const stockPick of await this.filtered(async (p) => await (await p.companyId).stockMoveEmailValidation && await (await p.pickingTypeId).code === 'outgoing')) {
      const deliveryTemplateId = (await (await stockPick.companyId).stockMailConfirmationTemplateId).id;
      await (await stockPick.withContext({ forceSend: true })).messagePostWithTemplate(deliveryTemplateId, 'mail.mailNotificationLight');
    }
  }

  @api.depends('state', 'moveLines', 'moveLines.state', 'moveLines.packageLevelId', 'moveLines.moveLineIds.packageLevelId')
  async _computeMoveWithoutPackage() {
    for (const picking of this) {
      await picking.set('moveIdsWithoutPackage', await picking._getMoveIdsWithoutPackage());
    }
  }

  async _setMoveWithoutPackage() {
    const newMwp = await this(0).moveIdsWithoutPackage;
    for (const picking of this) {
      const oldMwp = await picking._getMoveIdsWithoutPackage();
      await picking.set('moveLines', (await picking.moveLines).sub(oldMwp).or(newMwp));
      const movesToUnlink = oldMwp.sub(newMwp);
      if (movesToUnlink.ok) {
        await movesToUnlink.unlink();
      }
    }
  }

  async _getMoveIdsWithoutPackage() {
    this.ensureOne();
    let moveIdsWithoutPackage = this.env.items('stock.move');
    if (! await this['pickingTypeEntirePacks']) {
      moveIdsWithoutPackage = await this['moveLines'];
    }
    else {
      for (const move of await this['moveLines']) {
        const [packageLevelId, state, pickingId, moveLineIds] = await move('packageLevelId', 'state', 'pickingId', 'moveLineIds');
        if (!packageLevelId.ok) {
          if (state === 'assigned' && bool(pickingId) && !await pickingId.immediateTransfer || state === 'done') {
            if (await moveLineIds.some(async (ml) => (await ml.packageLevelId).nok)) {
              moveIdsWithoutPackage = moveIdsWithoutPackage.or(move);
            }
          }
          else {
            moveIdsWithoutPackage = moveIdsWithoutPackage.or(move);
          }
        }
      }
    }
    return moveIdsWithoutPackage.filtered(async (move) => !bool(await move.scrapIds));
  }

  /**
   * This method checks that all product of the package (quant) are well present in the move_line_ids of the picking.
   * @param pack 
   * @returns 
   */
  async _checkMoveLinesMapQuantPackage(pack) {
    let allIn = true;
    const packMoveLines = await (await this['moveLineIds']).filtered(async (ml) => (await ml.packageId).eq(pack));
    const keys = ['productId', 'lotId'];
    const keysIds = keys.map(fname => `${fname}.id`);
    const precisionDigits = await this.env.items('decimal.precision').precisionGet('Product Unit of Measure');

    const groupedQuants = {};
    const quantIds = await pack.quantIds;
    for (const [k, g] of groupby(await sortedAsync([...quantIds], attrgetter(...keysIds)), itemgetter(keys))) {
      groupedQuants[k] = sum(await this.env.items('stock.quant').concat(Array.from(g)).mapped('quantity'));
    }

    const groupedOps = {};
    for (const [k, g] of groupby(await sortedAsync([...packMoveLines], attrgetter(...keysIds)), itemgetter(keys))) {
      groupedOps[k] = sum(await this.env.items('stock.move.line').concat(Array.from(g)).mapped('productQty'));
    }
    if (Object.keys(groupedQuants).some(key => !floatIsZero((groupedQuants[key] || 0) - (groupedOps[key] || 0), { precisionDigits: precisionDigits }))
      || Object.keys(groupedOps).some(key => !floatIsZero((groupedOps[key] || 0) - (groupedQuants[key] || 0), { precisionDigits: precisionDigits }))) {
      allIn = false;
    }
    return allIn;
  }

  async _getEntirePackLocationDest(moveLineIds) {
    const locationDestIds = await moveLineIds.mapped('locationDestId');
    if (len(locationDestIds) > 1) {
      return false;
    }
    return locationDestIds.id;
  }

  /**
   * This function check if entire packs are moved in the picking
   */
  async _checkEntirePack() {
    for (const picking of this) {
      const originPackages = await (await picking.moveLineIds).mapped("packageId");
      for (const pack of originPackages) {
        if (await picking._checkMoveLinesMapQuantPackage(pack)) {
          const packageLevelIds = await (await picking.packageLevelIds).filtered(async (pl) => (await pl.packageId).eq(pack));
          const moveLinesToPack = await (await picking.moveLineIds).filtered(async (ml) => (await ml.packageId).eq(pack) && !(await ml.resultPackageId).ok);
          if (!packageLevelIds.ok) {
            await this.env.items('stock.package.level').create({
              'pickingId': picking.id,
              'packageId': pack.id,
              'locationId': (await pack.locationId).id,
              'locationDestId': await this._getEntirePackLocationDest(moveLinesToPack) || (await picking.locationDestId).id,
              'moveLineIds': [[6, 0, moveLinesToPack.ids]],
              'companyId': (await picking.companyId).id,
            })
            // Propagate the result package in the next move for disposable packages only.
            if (await pack.packageUse === 'disposable') {
              await moveLinesToPack.write({
                'resultPackageId': pack.id,
              });
            }
          }
          else {
            const moveLinesInPackageLevel = await moveLinesToPack.filtered(async (ml) => bool(await (await ml.moveId).packageLevelId));
            const moveLinesWithoutPackageLevel = moveLinesToPack.sub(moveLinesInPackageLevel);
            for (const ml of moveLinesInPackageLevel) {
              await ml.write({
                'resultPackageId': pack.id,
                'packageLevelId': (await (await ml.moveId).packageLevelId).id,
              })
            }
            await moveLinesWithoutPackageLevel.write({
              'resultPackageId': pack.id,
              'packageLevelId': packageLevelIds(0).id,
            })
            for (const pl of packageLevelIds) {
              await pl.set('locationDestId', this._getEntirePackLocationDest(await pl.moveLineIds) || (await picking.locationDestId).id);
            }
          }
        }
      }
    }
  }

  async doUnreserve() {
    await (await this['moveLines'])._doUnreserve();
    await (await (await this['packageLevelIds']).filtered(async (p) => !bool(await p.moveIds))).unlink();
  }

  async buttonValidate() {
    // Clean-up the context key at validation to avoid forcing the creation of immediate transfers.
    const ctx = new Dict(this.env.context);
    ctx.pop('default_immediateTransfer', null);
    let self = await this.withContext(ctx);

    // Sanity checks.
    let pickingsWithoutMoves = self.browse();
    let pickingsWithoutQuantities = self.browse();
    let pickingsWithoutLots = self.browse();
    let productsWithoutLots = self.env.items('product.product');
    for (const picking of self) {
      if (!bool(await picking.moveLines) && !bool(await picking.moveLineIds)) {
        pickingsWithoutMoves = pickingsWithoutMoves.or(picking);
      }
      await picking.messageSubscribe([(await (await self.env.user()).partnerId).id]);
      const pickingType = await picking.pickingTypeId;
      const precisionDigits = await this.env.items('decimal.precision').precisionGet('Product Unit of Measure');
      const noQuantitiesDone = await all(await (await picking.moveLineIds).filtered(async (m) => !['done', 'cancel'].includes(await m.state)), async (moveLine) => floatIsZero((await moveLine.qtyDone), { precisionDigits: precisionDigits }));
      const noReservedQuantities = all(picking.moveLineIds, async (moveLine) => floatIsZero(moveLine.productQty, { precisionRounding: await (await moveLine.productUomId).rounding }));
      if (bool(noReservedQuantities) && bool(noQuantitiesDone)) {
        pickingsWithoutQuantities = pickingsWithoutQuantities.or(picking);
      }

      if (await pickingType.useCreateLots || await pickingType.useExistingLots) {
        let linesToCheck = await picking.moveLineIds;
        if (!noQuantitiesDone) {
          linesToCheck = await linesToCheck.filtered(async (line) => floatCompare(line.qtyDone, 0, { precisionRounding: await (await line.productUomId).rounding }));
        }
        for (const line of linesToCheck) {
          const product = await line.productId;
          if (product.ok && await product.tracking !== 'none') {
            if (! await line.lotName && ! await line.lotId) {
              pickingsWithoutLots = pickingsWithoutLots.or(picking);
              productsWithoutLots = pickingsWithoutLots.or(product);
            }
          }
        }
      }
    }

    if (! await self._shouldShowTransfers()) {
      if (pickingsWithoutMoves.ok) {
        throw new UserError(await this._t('Please add some items to move.'));
      }
      if (pickingsWithoutQuantities.ok) {
        throw new UserError(self._getWithoutQuantitiesErrorMessage());
      }
      if (pickingsWithoutLots.ok) {
        throw new UserError(await this._t('You need to supply a Lot/Serial number for products %s.', (await productsWithoutLots.mapped('displayName')).join(', ')));
      }
    }
    else {
      let message = "";
      if (pickingsWithoutMoves.ok) {
        message += await this._t('Transfers %s: Please add some items to move.', (await pickingsWithoutMoves.mapped('label')).join(', '));
      }
      if (pickingsWithoutQuantities.ok) {
        message += await this._t('\n\nTransfers %s: You cannot validate these transfers if no quantities are reserved nor done. To force these transfers, switch in edit more and encode the done quantities.', (await pickingsWithoutQuantities.mapped('label')).join(', '));
      }
      if (pickingsWithoutLots.ok) {
        message += await this._t('\n\nTransfers %s: You need to supply a Lot/Serial number for products %s.', (await pickingsWithoutLots.mapped('label')).join(', '), (await productsWithoutLots.mapped('displayName')).join(', '));
      }
      if (message) {
        throw new UserError(message.trim());
      }
    }
    // Run the pre-validation wizards. Processing a pre-validation wizard should work on the moves and/or the context and never call `_action_done`.
    if (!self.env.context['buttonValidatePickingIds']) {
      self = await self.withContext({ buttonValidatePickingIds: self.ids });
    }
    const res = await self._preActionDoneHook();
    if (res != true) {
      return res;
    }

    // Call `_action_done`.
    let pickingsNotToBackorder, pickingsToBackorder;
    if (self.env.context['pickingIdsNotToBackorder']) {
      pickingsNotToBackorder = self.browse(self.env.context['pickingIdsNotToBackorder']);
      pickingsToBackorder = self.sub(pickingsNotToBackorder);
    }
    else {
      pickingsNotToBackorder = self.env.items('stock.picking');
      pickingsToBackorder = self;
    }
    await (await pickingsNotToBackorder.withContext({ cancelBackorder: true }))._actionDone();
    await (await pickingsToBackorder.withContext({ cancelBackorder: false }))._actionDone();

    if (await self.userHasGroups('stock.groupReceptionReport') && await self.userHasGroups('stock.groupAutoReceptionReport') && bool(await self.filtered(async (p) => await (await p.pickingTypeId).code !== 'outgoing'))) {
      const lines = await (await self.moveLines).filtered(async (m) => await (await m.productId).type === 'product' && await m.state !== 'cancel' && await m.quantityDone && !bool(await m.moveDestIds));
      if (lines.ok) {
        // don't show reception report if all already assigned/nothing to assign
        const whLocationIds = (await self.env.items('stock.location').search([['id', 'childOf', (await (await (await self.pickingTypeId).warehouseId).viewLocationId).id], ['locationId.usage', '!=', 'supplier']])).ids;
        if (bool(await self.env.items('stock.move').search([
          ['state', 'in', ['confirmed', 'partiallyAvailable', 'waiting', 'assigned']],
          ['productQty', '>', 0],
          ['locationId', 'in', whLocationIds],
          ['moveOrigIds', '=', false],
          ['pickingId', 'not in', self.ids],
          ['productId', 'in', (await lines.productId).ids]], { limit: 1 }))) {
          const action = await self.actionViewReceptionReport();
          action['context'] = { 'default_pickingIds': self.ids }
          return action;
        }
      }
    }
    return true;
  }

  async actionSetQuantitiesToReservation() {
    await (await this['moveLines'])._setQuantitiesToReservation();
  }

  async _preActionDoneHook() {
    if (!this.env.context['skipImmediate']) {
      const pickingsToImmediate = await this._checkImmediate();
      if (pickingsToImmediate.ok) {
        return pickingsToImmediate._actionGenerateImmediateWizard(await this._shouldShowTransfers());
      }
    }

    if (!this.env.context['skipBackorder']) {
      const pickingsToBackorder = await this._checkBackorder();
      if (pickingsToBackorder.ok) {
        return pickingsToBackorder._actionGenerateBackorderWizard(await this._shouldShowTransfers());
      }
    }
    return true;
  }

  /**
   * Whether the different transfers should be displayed on the pre action done wizards.
   * @returns 
   */
  async _shouldShowTransfers() {
    return len(this) > 1;
  }

  /**
   * Returns the error message raised in validation if no quantities are reserved or done.
    The purpose of this method is to be overridden in case we want to adapt this message.
 
    :return: Translated error message
    :rtype: str
   * @returns 
   */
  async _getWithoutQuantitiesErrorMessage() {
    return this._t(
      'You cannot validate a transfer if no quantities are reserved nor done. To force the transfer, switch in edit mode and encode the done quantities.'
    )
  }

  async _actionGenerateBackorderWizard(showTransfers: any = false) {
    const view = await this.env.ref('stock.viewBackorderConfirmation');
    const pickIds = [];
    for (const p of this) {
      pickIds.push([4, p.id]);
    }
    return {
      'label': await this._t('Create Backorder?'),
      'type': 'ir.actions.actwindow',
      'viewMode': 'form',
      'resModel ': 'stock.backorder.confirmation',
      'views': [[view.id, 'form']],
      'viewId': view.id,
      'target': 'new',
      'context': Object.assign({}, this.env.context, { default_showTransfers: showTransfers, default_pickIds: pickIds }),
    }
  }

  async _actionGenerateImmediateWizard(showTransfers: any = false) {
    const view = await this.env.ref('stock.viewImmediateTransfer');
    const pickIds = [];
    for (const p of this) {
      pickIds.push([4, p.id]);
    }
    return {
      'label': await this._t('Immediate Transfer?'),
      'type': 'ir.actions.actwindow',
      'viewMode': 'form',
      'resModel ': 'stock.immediate.transfer',
      'views': [(view.id, 'form')],
      'viewId': view.id,
      'target': 'new',
      'context': Object.assign({}, this.env.context, { default_showTransfers: showTransfers, default_pickIds: pickIds }),
    }
  }

  async actionToggleIsLocked() {
    this.ensureOne();
    await this.set('isLocked', ! await this['isLocked']);
    return true;
  }

  async _checkBackorder() {
    const prec = await this.env.items("decimal.precision").precisionGet("Product Unit of Measure");
    let backorderPickings = this.browse();
    for (const picking of this) {
      const quantityTodo = {};
      const quantityDone = {};
      for (const move of await (await picking.mapped('moveLines')).filtered(async (m) => await m.state !== "cancel")) {
        const [productId, productUom] = await move('productId', 'productUom');
        setdefault(quantityTodo, productId.id, 0)
        setdefault(quantityDone, productId.id, 0);
        quantityTodo[productId.id] += await productUom._computeQuantity(await move.productUomQty, await productId.uomId, { roundingMethod: 'HALF-UP' });
        quantityDone[productId.id] += await productUom._computeQuantity(await move.quantityDone, await productId.uomId, { roundingMethod: 'HALF-UP' });
      }
      // FIXME: the next block doesn't seem nor should be used.
      for (const ops of await (await picking.mapped('moveLineIds')).filtered(async (x) => (await x.packageId).ok && !(await x.productId).ok && !(await x.moveId).ok)) {
        for (const quant of await (await ops.packageId).quantIds) {
          setdefault(quantityDone, (await quant.productId).id, 0);
          quantityDone[(await quant.productId).id] += quant.qty;
        }
      }
      for (const pack of await (await picking.mapped('moveLineIds')).filtered(async (x) => bool(await x.productId) && !bool(await x.moveId))) {
        setdefault(quantityDone, (await pack.productId).id, 0);
        quantityDone[(await pack.productId).id] += await (await pack.productUomId)._computeQuantity(await pack.qtyDone, await (await pack.productId).uomId);
      }
      if (Object.keys(quantityDone).some(x =>
        floatCompare(quantityDone[x], quantityTodo[x] || 0, { precisionDigits: prec }) == -1)) {
        backorderPickings = backorderPickings.or(picking);
      }
    }
    return backorderPickings;
  }

  async _checkImmediate() {
    let immediatePickings = this.browse();
    const precisionDigits = await this.env.items('decimal.precision').precisionGet('Product Unit of Measure');
    for (const picking of this) {
      if (await (await (await picking.moveLineIds).filtered(async (m) => !['done', 'cancel'].includes(await m.state))).some(async (moveLine) => floatIsZero(await moveLine.qtyDone, { precisionDigits: precisionDigits }))) {
        immediatePickings = immediatePickings.or(picking);
      }
    }
    return immediatePickings;
  }

  /**
   * Automatically run `action_confirm` on `self` if the picking is an immediate transfer or
   * if the picking is a planned transfer and one of its move was added after the initial
   * call to `action_confirm`. Note that `action_confirm` will only work on draft moves.
 */
  async _autoconfirmPicking() {
    // Clean-up the context key to avoid forcing the creation of immediate transfers.
    const ctx = Object.assign({}, this.env.context);
    pop(ctx, 'defaultImmediateTransfer', null);
    let self = await this.withContext(ctx);
    for (const picking of this) {
      const [state, moveLines, packageLevelIds, immediateTransfer] = await picking('state', 'moveLines', 'packageLevelIds', 'immediateTransfer');
      if (['done', 'cancel'].includes(state)) {
        continue;
      }
      if (!moveLines.ok && !packageLevelIds.ok) {
        continue;
      }
      if (immediateTransfer || await moveLines.some(async (move) => move.additional)) {
        await picking.actionConfirm();
        // Make sure the reservation is bypassed in immediate transfer mode.
        if (immediateTransfer) {
          await moveLines.write({ 'state': 'assigned' });
        }
      }
    }
  }

  /**
   * This method is called when the user chose to create a backorder. It will create a new
          picking, the backorder, and move the stock.moves that are not `done` or `cancel` into it.
   * @returns 
   */
  async _createBackorder() {
    let backorders = this.env.items('stock.picking');
    for (const picking of this) {
      const movesToBackorder = await (await picking.moveLines).filtered(async (x) => !['done', 'cancel'].includes(await x.state));
      if (movesToBackorder.ok) {
        const backorderPicking = await picking.copy({
          'label': '/',
          'moveLines': [],
          'moveLineIds': [],
          'backorderId': picking.id
        });
        await picking.messagePost(await this._t('The backorder <a href=# data-oe-model=stock.picking data-oe-id=%s>%s</a> has been created.', backorderPicking.id, await backorderPicking.label));
        await movesToBackorder.write({ 'pickingId': backorderPicking.id });
        await (await movesToBackorder.mapped('packageLevelId')).write({ 'pickingId': backorderPicking.id });
        await (await movesToBackorder.mapped('moveLineIds')).write({ 'pickingId': backorderPicking.id });
        backorders = backorders.or(backorderPicking);
      }
    }
    return backorders;
  }

  /**
   * Generic method to log activity. To use with
      _logActivity method. It either log on uppermost
      ongoing documents or following documents. This method
      find all the documents and responsible for which a note
      has to be log. It also generate a rendering_context in
      order to render a specific note by documents containing
      only the information relative to the document it. For example
      we don't want to notify a picking on move that it doesn't
      contain.
 
      :param orig_obj_changes dict: contain a record as key and the
      change on this record as value.
      eg: {'moveId': (new productUomQty, old productUomQty)}
      :param stream_field string: It has to be a field of the
      records that are register in the key of 'orig_obj_changes'
      eg: 'move_dest_ids' if we use move as record (previous example)
          - 'UP' if we want to log on the upper most ongoing
          documents.
          - 'DOWN' if we want to log on following documents.
      :param sorted_method method, groupby_method: Only need when
      stream is 'DOWN', it should sort/group by tuple(object on
      which the activity is log, the responsible for this object)
   * @param origObjChanges 
   * @param streamField 
   * @param stream 
   * @param sortedMethod 
   * @param groupbyMethod 
   * @returns 
   */

  async _logActivityGetDocuments(origObjChanges: Map<any, any>, streamField, stream, sortedMethod?: Function, groupbyMethod?: Function) {
    console.warn('Must check!!!');
    if (this.env.context['skipActivity']) {
      return {};
    }
    const moveToOrigObjectRel = {}
    for (const ooc of origObjChanges.keys()) {
      for (const co of ooc[streamField]) {
        moveToOrigObjectRel[co] = ooc;
      }
    }
    const originObjects = this.env.items((origObjChanges.keys())[0]._name).concat(origObjChanges.keys());
    // The purpose here is to group each destination object by
    // (document to log, responsible) no matter the stream direction.
    // example:
    // {'(delivery_picking_1, admin)': stock.move(1, 2)
    //  '(delivery_picking_2, admin)': stock.move(3)}
    const visitedDocuments = {};
    let groupedMoves;
    if (stream === 'DOWN') {
      if (sortedMethod && groupbyMethod) {
        groupedMoves = await groupbyAsync(await sortedAsync(await originObjects.mapped(streamField), sortedMethod), groupbyMethod);
      }
      else {
        throw new UserError(await this._t('You have to define a groupby and sorted method and pass them as arguments.'));
      }
    }
    else if (stream === 'UP') {
      // When using upstream document it is required to define
      // _get_upstream_documents_and_responsibles on
      // destination objects in order to ascend documents.
      groupedMoves = {};
      for (const visitedMove of await originObjects.mapped(streamField)) {
        for (const [document, responsible, visited] of await visitedMove._getUpstreamDocumentsAndResponsibles(this.env.items(visitedMove._name))) {
          const key = `${document}${responsible}`;
          if (groupedMoves[key]) {
            groupedMoves[key][0] = [document, responsible];
            groupedMoves[key][1] = groupedMoves[key][1].or(visitedMove);
            visitedDocuments[key] = visitedDocuments[key].or(visited);
          }
          else {
            groupedMoves[key] = [];
            groupedMoves[key][0] = [document, responsible];
            groupedMoves[key][1] = visitedMove
            visitedDocuments[key] = visited;
          }
        }
      }
      groupedMoves = Object.values(groupedMoves);
    }
    else {
      throw new UserError(await this._t('Unknown stream.'));
    }

    const documents = {};
    for (let [[parent, responsible], moves] of groupedMoves) {
      if (!bool(parent)) {
        continue;
      }
      moves = this.env.items(moves[0]._name).concat(moves);
      // Get the note
      const renderingContext = new Map<any, any>();
      for (const move of moves) {
        for (const origObject of moveToOrigObjectRel[move]) {
          renderingContext.set(move, [origObject, origObjChanges[origObject]]);
        }
      }
      const key = `${parent}@${responsible}`;
      if (bool(visitedDocuments)) {
        documents[key] = [];
        documents[key][0] = [parent, responsible];
        documents[key][1] = [renderingContext, Object.values(visitedDocuments)];
      }
      else {
        documents[key] = [];
        documents[key][0] = [parent, responsible];
        documents[key][1] = renderingContext;
      }
    }
    return documents;
  }

  /**
   * Log a note for each documents, responsible pair in
      documents passed as argument. The render_method is then
      call in order to use a template and render it with a
      rendering_context.

      :param documents dict: A tuple (document, responsible) as key.
      An activity will be log by key. A rendering_context as value.
      If used with _log_activity_get_documents. In 'DOWN' stream
      cases the rendering_context will be a dict with format:
      {'stream_object': ('orig_object', new_qty, old_qty)}
      'UP' stream will add all the documents browsed in order to
      get the final/upstream document present in the key.
      :param renderMethod method: a static function that will generate
      the html note to log on the activity. The render_method should
      use the args:
          - rendering_context dict: value of the documents argument
      the render_method should return a string with an html format
      :param stream string:
    * @param renderMethod 
    * @param documents 
    */
  async _logActivity(renderMethod, documents) {
    for (const [[parent, responsible], renderingContext] of Object.values<any>(documents)) {
      const note = await renderMethod(renderingContext);
      await parent.activitySchedule({
        actTypeXmlid: 'mail.mailActivityDataWarning',
        dateDeadline: _Date.today(),
        note: note,
        userId: bool(responsible.id) ? responsible.id : global.SUPERUSER_ID
      });
    }
  }

  /**
   * Log an activity on picking that follow moves. The note
      contains the moves changes and all the impacted picking.

      :param dict moves: a dict with a move as key and tuple with
      new and old quantity as value. eg: {move_1 : (4, 5)}
    * @param moves 
    * @returns 
    */
  async _logLessQuantitiesThanExpected(moves: Map<any, any>) {
    const self = this;

    /**
     * sort by picking and the responsible for the product the move.
     * @param move 
     * @returns 
     */
    async function _keysInSorted(move) {
      return [(await move.pickingId).id, (await (await move.productId).responsibleId).id];
    }

    /**
     * group by picking and the responsible for the product the move.
     * @param move 
     * @returns 
     */
    async function _keysInGroupby(move) {
      return [await move.pickingId, await (await move.productId).responsibleId];
    }

    /**
      * :param rendering_context:
        {'move_dest': (move_orig, (new_qty, old_qty))}
      * @param renderingContext 
      * @returns 
      */
    async function _renderNoteExceptionQuantity(renderingContext: Map<any, any>) {
      const ids = [];
      for (const moveOrig of renderingContext.values()) {
        for (const move of moveOrig[0]) {
          ids.push(move.id);
        }
      }
      const originMoves = self.env.items('stock.move').browse(ids);
      const originPicking = await originMoves.mapped('pickingId');
      const moveDestIds = self.env.items('stock.move').concat(...renderingContext.keys());
      const impactedPickings = (await originPicking._getImpactedPickings(moveDestIds)).sub(await moveDestIds.mapped('pickingId'));
      const values = {
        'originPicking': originPicking,
        'movesInformation': renderingContext.values(),
        'impactedPickings': impactedPickings,
      }
      return (await self.env.ref('stock.exceptionOnPicking'))._render(values);
    }

    let documents = await self._logActivityGetDocuments(moves, 'moveDestIds', 'DOWN', _keysInSorted, _keysInGroupby);
    documents = await self._lessQuantitiesThanExpectedAddDocuments(moves, documents);
    await self._logActivity(_renderNoteExceptionQuantity, documents);
  }

  async _lessQuantitiesThanExpectedAddDocuments(moves, documents) {
    return documents;
  }

  /**
    * This function is used in _log_less_quantities_than_expected
      the purpose is to notify a user with all the pickings that are
      impacted by an action on a chained move.
      param: 'moves' contain moves that belong to a common picking.
      return: all the pickings that contain a destination moves
      (direct and indirect) from the moves given as arguments.
    * @param moves 
    * @returns 
    */
  async _getImpactedPickings(moves) {

    async function _explore(impactedPickings, exploredMoves, movesToExplore) {
      for (const move of movesToExplore) {
        if (!exploredMoves.includes(move)) {
          impactedPickings = impactedPickings.or(await move.pickingId);
          exploredMoves = exploredMoves.or(move);
          movesToExplore = movesToExplore.or(await move.moveDestIds);
        }
      }
      movesToExplore = movesToExplore.sub(exploredMoves);
      if (movesToExplore.ok) {
        return _explore(impactedPickings, exploredMoves, movesToExplore);
      }
      else {
        return impactedPickings;
      }
    }

    return _explore(this.env.items('stock.picking'), this.env.items('stock.move'), moves);
  }

  async _prePutInPackHook(moveLineIds) {
    return this._checkDestinations(moveLineIds);
  }

  async _checkDestinations(moveLineIds) {
    if (len(await moveLineIds.mapped('locationDestId')) > 1) {
      const viewId = (await this.env.ref('stock.stockPackageDestinationFormView')).id;
      const wiz = await this.env.items('stock.package.destination').create({
        'pickingId': this.id,
        'locationDestId': (await moveLineIds[0].locationDestId).id,
      });
      return {
        'label': await this._t('Choose destination location'),
        'viewMode': 'form',
        'resModel ': 'stock.package.destination',
        'viewId': viewId,
        'views': [[viewId, 'form']],
        'type': 'ir.actions.actwindow',
        'resId': wiz.id,
        'target': 'new'
      }
    }
    else {
      return {};
    }
  }

  async _putInPack(moveLineIds, createPackageLevel: boolean = true) {
    let pack;
    console.log('>>> Must check');
    for (const pick of this) {
      let moveLinesToPack = this.env.items('stock.move.line');
      pack = await this.env.items('stock.quant.package').create({});

      const precisionDigits = await this.env.items('decimal.precision').precisionGet('Product Unit of Measure');
      if (floatIsZero(await moveLineIds[0].qtyDone, { precisionDigits: precisionDigits })) {
        for (const line of moveLineIds) {
          await line.set('qtyDone', await line.productUomQty);
        }
      }
      for (const ml of moveLineIds) {
        const [qtyDone, productUomQty, productUomId] = await ml('qtyDone', 'productUomQty', 'productUomId', 'lotId');
        if (floatCompare(qtyDone, productUomQty, { precisionRounding: productUomId.rounding }) >= 0) {
          moveLinesToPack = moveLinesToPack.or(ml);
        }
        else {
          const [lotName, lotId] = await ml('lotName', 'lotId');
          const quantityLeftTodo = floatRound(
            productUomQty - qtyDone,
            {
              precisionRounding: await productUomId.rounding,
              roundingMethod: 'UP'
            });
          let doneToKeep = qtyDone;
          const newMoveLine = await ml.copy({ 'productUomQty': 0, 'qtyDone': qtyDone });
          const vals = { 'productUomQty': quantityLeftTodo, 'qtyDone': 0.0 };
          if (await (await pick.pickingTypeId).code === 'incoming') {
            if (lotId.ok) {
              vals['lotId'] = false;
            }
            if (lotName) {
              vals['lotName'] = false;
            }
          }
          await ml.write(vals);
          await newMoveLine.write({ 'productUomQty': doneToKeep });
          moveLinesToPack = moveLinesToPack.or(newMoveLine);
        }
      }
      if (createPackageLevel) {
        await this.env.items('stock.package.level').create({
          'packageId': pack.id,
          'pickingId': pick.id,
          'locationId': false,
          'locationDestId': (await moveLineIds.mapped('locationDestId')).id,
          'moveLineIds': [[6, 0, moveLinesToPack.ids]],
          'companyId': (await pick.companyId).id,
        })
      }
      await moveLinesToPack.write({
        'resultPackageId': pack.id,
      })
    }
    return pack;
  }

  async actionPutInPack() {
    this.ensureOne();
    if (!['done', 'cancel'].includes(await this['state'])) {
      let [pickingMoveLines, pickingTypeId] = await this('moveLineIds', 'pickingTypeId');
      if (
        ! await pickingTypeId.showReserved
        && ! await this['immediateTransfer']
        && !this.env.context['barcodeView']
      ) {
        pickingMoveLines = await this['moveLineNosuggestIds'];
      }

      let moveLineIds = await pickingMoveLines.filtered(async (ml) =>
        floatCompare(await ml.qtyDone, 0.0, { precisionRounding: await (await ml.productUomId).rounding }) > 0
        && !(await ml.resultPackageId).ok
      )
      if (!moveLineIds.ok) {
        moveLineIds = await pickingMoveLines.filtered(async (ml) => {
          const [productUomQty, qtyDone, productUomId] = await ml('productUomQty', 'qtyDone', 'productUomId');
          const rounding = await productUomId.rounding;
          return floatCompare(productUomQty, 0.0, { precisionRounding: rounding }) > 0
            && floatCompare(qtyDone, 0.0, { precisionRounding: rounding }) == 0
        });
      }
      if (moveLineIds.ok) {
        let res = await this._prePutInPackHook(moveLineIds);
        if (!bool(res)) {
          res = await this._putInPack(moveLineIds);
        }
        return res;
      }
      else {
        throw new UserError(await this._t("Please add 'Done' quantities to the picking to create a new pack."));
      }
    }
  }

  async buttonScrap() {
    this.ensureOne();
    const view = await this.env.ref('stock.stockScrapFormView2');
    let products = this.env.items('product.product');
    for (const move of await this['moveLines']) {
      const [state, productId] = await move('state', 'productId');
      if (!['draft', 'cancel'].includes(await move.state) && ['product', 'consu'].includes((await move.productId).type)) {
        products = products.or(await move.productId);
      }
    }
    return {
      'label': await this._t('Scrap'),
      'viewMode': 'form',
      'resModel ': 'stock.scrap',
      'viewId': view.id,
      'views': [[view.id, 'form']],
      'type': 'ir.actions.actwindow',
      'context': { 'default_pickingId': this.id, 'productIds': products.ids, 'default_companyId': (await this['companyId']).id },
      'target': 'new',
    }
  }

  async actionSeeMoveScrap() {
    this.ensureOne();
    const action = await this.env.items("ir.actions.actions")._forXmlid("stock.actionStockScrap");
    const scraps = await this.env.items('stock.scrap').search([['pickingId', '=', this.id]]);
    action['domain'] = [['id', 'in', scraps.ids]];
    action['context'] = Object.assign({}, this._context, { create: false });
    return action;
  }

  async actionSeePackages() {
    this.ensureOne();
    const action = await this.env.items("ir.actions.actions")._forXmlid("stock.actionPackageView");
    const packages = await (await this['moveLineIds']).mapped('resultPackageId');
    action['domain'] = [['id', 'in', packages.ids]];
    action['context'] = { 'pickingId': this.id };
    return action;
  }

  async actionPickingMoveTree() {
    const action = await this.env.items("ir.actions.actions")._forXmlid("stock.stockMoveAction");
    action['views'] = [
      [(await this.env.ref('stock.viewPickingMoveTree')).id, 'tree'],
    ];
    action['context'] = this.env.context;
    action['domain'] = [['picking_id', 'in', this.ids]];
    return action;
  }

  async actionViewReceptionReport() {
    return this.env.items("ir.actions.actions")._forXmlid("stock.stockReceptionAction");
  }

  async actionOpenLabelLayout() {
    const view = await this.env.ref('stock.productLabelLayoutFormPicking');
    return {
      'label': await this._t('Choose Labels Layout'),
      'type': 'ir.actions.actwindow',
      'resModel ': 'product.label.layout',
      'views': [[view.id, 'form']],
      'target': 'new',
      'context': {
        'default_productIds': (await (await this['moveLines']).productId).ids,
        'default_moveLineIds': (await this['moveLineIds']).ids,
        'default_pickingQuantity': 'picking'
      },
    }
  }

  /**
   * Render the delivery report in pdf and attach it to the picking in `self`.
   * @returns 
   */
  async _attachSign() {
    this.ensureOne();
    const report = await (await this.env.ref('stock.actionReportDelivery'))._renderQwebPdf(this.id);
    const filename = f("%s_signed_delivery_slip", await this['label']);
    const partnerId = this['partnerId'];
    let message;
    if (partnerId.ok) {
      message = await this._t('Order signed by %s', await partnerId.label);
    }
    else {
      message = await this._t('Order signed');
    }
    await (this as any).messagePost({
      attachments: [[f('%s.pdf', filename), report[0]]],
      body: message,
    })
    return true;
  }

  async _getReportLang() {
    const [moveLines, partnerId] = await this('moveLines', 'partnerId');
    return bool(moveLines) && await (await moveLines[0].partnerId).lang || await partnerId.lang || this.env.lang;
  }
}