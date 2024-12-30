import { Fields, _Date } from "../../../core";
import { MetaModel, TransientModel, _super } from "../../../core/models";

@MetaModel.define()
class StockInventoryAdjustmentName extends TransientModel {
  static _module = module;
  static _name = 'stock.inventory.adjustment.name';
  static _description = 'Inventory Adjustment Reference / Reason';

  async defaultGet(fieldsList) {
    const res = await _super(StockInventoryAdjustmentName, this).defaultGet(fieldsList);
    if (this.env.context['default_quantIds']) {
      const quants = this.env.items('stock.quant').browse(this.env.context['default_quantIds']);
      let some;
      for (const quant of quants) {
        if (! await quant.inventoryQuantitySet) {
          some = true;
          break;
        }
      }
      res['showInfo'] = some;
    }
    return res
  }

  async _defaultInventoryAdjustmentName() {
    return await this._t("Inventory Adjustment") + " - " + _Date.toString(_Date.today());
  }

  static quantIds = Fields.Many2many('stock.quant');
  static inventoryAdjustmentName = Fields.Char({ default: self => self._defaultInventoryAdjustmentName() });
  static showInfo = Fields.Boolean('Show warning');

  async actionApply() {
    return (await (await this['quantIds']).withContext(
      { inventoryName: await this['inventoryAdjustmentName'] })).actionApplyInventory();
  }
}