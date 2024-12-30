import { Fields } from "../../../core";
import { MetaModel, TransientModel } from "../../../core/models"

@MetaModel.define()
class StockInventoryWarning extends TransientModel {
  static _module = module;
  static _name = 'stock.inventory.warning';
  static _description = 'Inventory Adjustment Warning';

  static quantIds = Fields.Many2many('stock.quant');

  async actionReset() {
    return (await this['quantIds']).actionSetInventoryQuantityToZero();
  }

  async actionSet() {
    const validQuants = await (await this['quantIds']).filtered(async (quant) => ! await quant.inventoryQuantitySet);
    return validQuants.actionSetInventoryQuantity();
  }
}