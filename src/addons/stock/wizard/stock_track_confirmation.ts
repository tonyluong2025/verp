import { api } from "../../../core";
import { Fields } from "../../../core/fields";
import { MetaModel, TransientModel } from "../../../core/models"

@MetaModel.define()
class StockTrackConfirmation extends TransientModel {
  static _module = module;
  static _name = 'stock.track.confirmation';
  static _description = 'Stock Track Confirmation';

  static trackingLineIds = Fields.One2many('stock.track.line', 'wizardId');
  static quantIds = Fields.Many2many('stock.quant', { string: 'Quants' });
  static productIds = Fields.Many2many('product.product', { string: 'Products' });

  async actionConfirm() {
    for (const confirmation of this) {
      await (await confirmation.quantIds)._applyInventory();
    }
  }

  @api.onchange('productIds')
  async _onchangeQuants() {
    await this.set('trackingLineIds',
      (await this['productIds']).map(product => [0, 0, { 'productId': product }]));
  }
}

@MetaModel.define()
class StockTrackingLines extends TransientModel {
  static _module = module;
  static _name = 'stock.track.line';
  static _description = 'Stock Track Line';

  static productDisplayName = Fields.Char('Name', { compute: '_computeDisplayName', readonly: true });
  static productId = Fields.Many2one('product.product', { string: 'Product', readonly: true });
  static tracking = Fields.Selection({ related: 'productId.tracking' });
  static wizardId = Fields.Many2one('stock.track.confirmation', { readonly: true });

  /**
   * Onchange results in product.displayName not being directly accessible
   */
  async _computeDisplayName() {
    for (const line of this) {
      await line.set('productDisplayName', await (await line.productId)._origin.displayName);
    }
  }
}