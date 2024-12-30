import { Fields } from "../../../core/fields";
import { MetaModel, TransientModel } from "../../../core/models"

@MetaModel.define()
class StockInventoryConflict extends TransientModel {
  static _module = module;
  static _name = 'stock.inventory.conflict';
  static _description = 'Conflict in Inventory';

  static quantIds = Fields.Many2many('stock.quant', { relation: 'stockConflictQuantRel', string: 'Quants' });
  static quantToFixIds = Fields.Many2many('stock.quant', { string: 'Conflicts' });

  async actionKeepCountedQuantity() {
    const quantIds = await this['quantIds'];
    for (const quant of quantIds) {
      await quant.set('inventoryDiffQuantity', await quant.inventoryQuantity - await quant.quantity);
    }
    return quantIds.actionApplyInventory();
  }

  async actionKeepDifference() {
    const quantIds = await this['quantIds'];
    for (const quant of quantIds) {
      await quant.set('inventoryQuantity', await quant.quantity + await quant.inventoryDiffQuantity);
    }
    return quantIds.actionApplyInventory();
  }
}