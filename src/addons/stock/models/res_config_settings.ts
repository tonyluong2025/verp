import { api } from "../../../core";
import { Fields } from "../../../core/fields";
import { UserError } from "../../../core/helper/errors";
import { MetaModel, TransientModel, _super } from "../../../core/models";

@MetaModel.define()
class ResConfigSettings extends TransientModel {
  static _module = module;
  static _parents = 'res.config.settings';

  static moduleProductExpiry = Fields.Boolean("Expiration Dates",
    { help: "Track following dates on lots & serial numbers: best before, removal, end of life, alert. \n Such dates are set automatically at lot/serial number creation based on values set on the product (in days)." });
  static groupStockProductionLot = Fields.Boolean("Lots & Serial Numbers", { impliedGroup: 'stock.groupProductionLot' });
  static groupLotOnDeliverySlip = Fields.Boolean("Display Lots & Serial Numbers on Delivery Slips", { impliedGroup: 'stock.groupLotOnDeliverySlip', groups: "base.groupUser,base.groupPortal" });
  static groupStockTrackingLot = Fields.Boolean("Packages", { impliedGroup: 'stock.groupTrackingLot' });
  static groupStockTrackingOwner = Fields.Boolean("Consignment", { impliedGroup: 'stock.groupTrackingOwner' });
  static groupStockAdvLocation = Fields.Boolean("Multi-Step Routes", {
    impliedGroup: 'stock.groupAdvLocation',
    help: "Add and customize route operations to process product moves in your warehouse(s): e.g. unload > quality control > stock for incoming products, pick > pack > ship for outgoing products. \n You can also set putaway strategies on warehouse locations in order to send incoming products into specific child locations straight away (e.g. specific bins, racks)."
  });
  static groupWarningStock = Fields.Boolean("Warnings for Stock", { impliedGroup: 'stock.groupWarningStock' });
  static groupStockSignDelivery = Fields.Boolean("Signature", { impliedGroup: 'stock.groupStockSignDelivery' });
  static moduleStockPickingBatch = Fields.Boolean("Batch Transfers");
  static groupStockPickingWave = Fields.Boolean('Wave Transfers', {
    impliedGroup: 'stock.groupStockPickingWave',
    help: "Group your move operations in wave transfer to process them together"
  });
  static moduleStockBarcode = Fields.Boolean("Barcode Scanner");
  static stockMoveEmailValidation = Fields.Boolean({ related: 'companyId.stockMoveEmailValidation', readonly: false });
  static stockMailConfirmationTemplateId = Fields.Many2one({ related: 'companyId.stockMailConfirmationTemplateId', readonly: false });
  static moduleStockSms = Fields.Boolean("SMS Confirmation");
  static moduleDelivery = Fields.Boolean("Delivery Methods");
  static moduleDeliveryDhl = Fields.Boolean("DHL USA Connector");
  static moduleDeliveryFedex = Fields.Boolean("FedEx Connector");
  static moduleDeliveryUps = Fields.Boolean("UPS Connector");
  static moduleDeliveryUsps = Fields.Boolean("USPS Connector");
  static moduleDeliveryEms = Fields.Boolean("Ems Connector");
  static moduleDeliveryEasypost = Fields.Boolean("Easypost Connector");
  static moduleQualityControl = Fields.Boolean("Quality");
  static moduleQualityControlWorksheet = Fields.Boolean("Quality Worksheet");
  static groupStockMultiLocations = Fields.Boolean('Storage Locations', {
    impliedGroup: 'stock.groupStockMultiLocations',
    help: "Store products in specific locations of your warehouse (e.g. bins, racks) and to track inventory accordingly."
  });
  static groupStockStorageCategories = Fields.Boolean(
    'Storage Categories', { impliedGroup: 'stock.groupStockStorageCategories' });
  static annualInventoryMonth = Fields.Selection({ related: 'companyId.annualInventoryMonth', readonly: false });
  static annualInventoryDay = Fields.Integer({ related: 'companyId.annualInventoryDay', readonly: false });
  static groupStockReceptionReport = Fields.Boolean("Reception Report", { impliedGroup: 'stock.groupReceptionReport' });
  static groupStockAutoReceptionReport = Fields.Boolean("Show Reception Report at Validation", { impliedGroup: 'stock.groupAutoReceptionReport' });

  @api.onchange('groupStockMultiLocations')
  async _onchangeGroupStockMultiLocations() {
    if (! await this['groupStockMultiLocations']) {
      await this.set('groupStockAdvLocation', false),
      await this.set('groupStockStorageCategories', false)
    }
  }

  @api.onchange('groupStockProductionLot')
  async _onchangeGroupStockProductionLot() {
    if (! await this['groupStockProductionLot']) {
      await this.set('groupLotOnDeliverySlip', false);
    }
  }

  @api.onchange('groupStockAdvLocation')
  async onchangeAdvLocation() {
    if (this['groupStockAdvLocation'] && ! await this['groupStockMultiLocations']) {
      await this.set('groupStockMultiLocations', true);
    }
  }

  async setValues() {
    const warehouseGrp = await this.env.ref('stock.groupStockMultiWarehouses');
    const locationGrp = await this.env.ref('stock.groupStockMultiLocations');
    const baseUser = await this.env.ref('base.groupUser');
    const impliedIds = await baseUser.impliedIds;
    if (! await this['groupStockMultiLocations'] && impliedIds.includes(locationGrp) && impliedIds.includes(warehouseGrp)) {
      throw new UserError(await this._t("You can't desactivate the multi-location if you have more than once warehouse by company"));
    }

    // Deactivate putaway rules with storage category when not in storage category
    // group. Otherwise, active them.
    const storageCateGrp = await this.env.ref('stock.groupStockStorageCategories');
    const PutawayRule = this.env.items('stock.putaway.rule');
    if (await this['groupStockStorageCategories'] && !impliedIds.includes(storageCateGrp)) {
      const putawayRules = await PutawayRule.search([
        ['active', '=', false],
        ['storageCategoryId', '!=', false]
      ]);
      await putawayRules.write({ 'active': true });
    }
    else if (! await this['groupStockStorageCategories'] && impliedIds.includes(storageCateGrp)) {
      const putawayRules = await PutawayRule.search([['storageCategoryId', '!=', false]]);
      await putawayRules.write({ 'active': false });
    }

    const previousGroup = await this.defaultGet(['groupStockMultiLocations', 'groupStockProductionLot', 'groupStockTrackingLot']);
    const res = await _super(ResConfigSettings, this).setValues();

    if (! await this.userHasGroups('stock.groupStockManager')) {
      return;
    }

    // If we just enabled multiple locations with this settings change, we can deactivate
    // the internal operation types of the warehouses, so they won't appear in the dashboard.
    // Otherwise (if we just disabled multiple locations with this settings change), activate them
    const warehouseObj = this.env.items('stock.warehouse');
    if (await this['groupStockMultiLocations'] && !previousGroup['groupStockMultiLocations']) {
      // override activeTest that is false in set_values
      await (await (await (await warehouseObj.withContext({ activeTest: true })).search([])).mapped('intTypeId')).write({ 'active': true });
    }
    else if (! await this['groupStockMultiLocations'] && previousGroup['groupStockMultiLocations']) {
      await (await (await warehouseObj.search([
        ['receptionSteps', '=', 'oneStep'],
        ['deliverySteps', '=', 'shipOnly']]
      )).mapped('intTypeId')).write({ 'active': false });
    }
    let some = false;
    for (const [group, prevValue] of previousGroup.items()) {
      if (await this[group] && !prevValue) {
        some = true;
        break;
      }
    }
    if (some) {
      const pickingTypes = await (await this.env.items('stock.picking.type').withContext({ activeTest: false })).search([
        ['code', '!=', 'incoming'],
        ['showOperations', '=', false]
      ]);
      await (await pickingTypes.sudo()).write({ 'showOperations': true });
    }
    return res;
  }
}
