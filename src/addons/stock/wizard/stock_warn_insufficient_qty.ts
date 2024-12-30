import { api } from "../../../core";
import { Fields } from "../../../core/fields";
import { NotImplementedError } from "../../../core/helper/errors";
import { MetaModel, AbstractModel, TransientModel } from "../../../core/models"

@MetaModel.define()
class StockWarnInsufficientQty extends AbstractModel {
  static _module = module;
  static _name = 'stock.warn.insufficient.qty';
  static _description = 'Warn Insufficient Quantity';

  static productId = Fields.Many2one('product.product', { string: 'Product', required: true });
  static locationId = Fields.Many2one('stock.location', { string: 'Location', domain: "[['usage', '=', 'internal']]", required: true });
  static quantIds = Fields.Many2many('stock.quant', { compute: '_computeQuantIds' });
  static quantity = Fields.Float({ string: "Quantity", required: true });
  static productUomName = Fields.Char("Unit of Measure", { required: true });

  _getReferenceDocumentCompanyId() {
    throw new NotImplementedError();
  }

  @api.depends('productId')
  async _computeQuantIds() {
    for (const quantity of this) {
      await quantity.set('quantIds', await this.env.items('stock.quant').search([
        ['productId', '=', (await quantity.productId).id],
        ['locationId.usage', '=', 'internal'],
        ['companyId', '=', (await quantity._getReferenceDocumentCompanyId()).id]
      ]));
    }
  }

  actionDone() {
    throw new NotImplementedError();
  }
}

@MetaModel.define()
class StockWarnInsufficientQtyScrap extends TransientModel {
  static _module = module;
  static _name = 'stock.warn.insufficient.qty.scrap';
  static _parents = 'stock.warn.insufficient.qty';
  static _description = 'Warn Insufficient Scrap Quantity';

  static scrapId = Fields.Many2one('stock.scrap', { string: 'Scrap' });

  async _getReferenceDocumentCompanyId() {
    return (await this['scrapId']).companyId;
  }

  async actionDone() {
    return (await this['scrapId']).doScrap();
  }

  async actionCancel() {
    // FIXME in master: we should not have created the scrap in a first place
    if (this.env.context['notUnlinkOnDiscard']) {
      return true;
    }
    else {
      return (await (await this['scrapId']).sudo()).unlink();
    }
  }
}