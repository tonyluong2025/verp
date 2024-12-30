import { Fields, _Datetime } from "../../../core";
import { MetaModel, TransientModel } from "../../../core/models"
import { bool } from "../../../core/tools/bool";

@MetaModel.define()
class StockRequestCount extends TransientModel {
  static _module = module;
  static _name = 'stock.request.count';
  static _description = 'Stock Request an Inventory Count';

  static inventoryDate = Fields.Date(
    'Inventory Date', {
      required: true,
    help: "Choose a date to get the inventory at that date",
    default: () => _Datetime.now()
  });
  static userId = Fields.Many2one('res.users', { string: "User" });
  static quantIds = Fields.Many2many('stock.quant');
  static setCount = Fields.Selection([['empty', 'Leave Empty'], ['set', 'Set Current Value']], { default: 'empty', string: 'Count' });

  async actionRequestCount() {
    for (const countRequest of this) {
      const quantIds = await countRequest.quantIds;
      await (await quantIds.withContext({ inventoryMode: true })).write(
        await countRequest._getValuesToWrite());;
      if (await countRequest.setCount === 'set') {
        await (await quantIds.filtered(async (q) => !bool(await q.inventoryQuantitySet))).actionSetInventoryQuantity();
      }
    }
  }

  async _getValuesToWrite() {
    const [userId, inventoryDate] = await this('userId', 'inventoryDate');
    const values = {
      'inventoryDate': inventoryDate,
    }
    if (bool(userId)) {
      values['userId'] = userId.id;
    }
    return values;
  }
}