import { Fields, _Datetime } from "../../../core";
import { MetaModel, TransientModel } from "../../../core/models";
import { expression } from "../../../core/osv";
import { bool } from "../../../core/tools/bool";

@MetaModel.define()
class StockQuantityHistory extends TransientModel {
  static _module = module;
  static _name = 'stock.quantity.history'
  static _description = 'Stock Quantity History'

  static inventoryDatetime = Fields.Datetime('Inventory at Date',
    {
      help: "Choose a date to get the inventory at that date",
      default: () => _Datetime.now()
    });

  async openAtDate() {
    const treeViewId = (await this.env.ref('stock.viewStockProductTree')).id;
    const formViewId = (await this.env.ref('stock.productFormViewProcurementButton')).id;
    let domain: [['type', '=', 'product']];
    const productId = this.env.context['productId'] ?? false;
    const productTemplateId = this.env.context['productTemplateId'] ?? false;
    if (bool(productId)) {
      domain = expression.AND([domain, [['id', '=', productId]]]);
    }
    else if (bool(productTemplateId)) {
      domain = expression.AND([domain, [['productTemplateId', '=', productTemplateId]]]);
    }
    // We pass `to_date` in the context so that `qtyAvailable` will be computed across moves until date.
    const action = {
      'type': 'ir.actions.actwindow',
      'views': [[treeViewId, 'tree'], [formViewId, 'form']],
      'viewMode': 'tree,form',
      'label': await this._t('Products'),
      'resModel': 'product.product',
      'domain': domain,
      'context': Object.assign({}, this.env.context, { toDate: await this['inventoryDatetime'] }),
    }
    return action;
  }
}