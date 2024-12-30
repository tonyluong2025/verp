import { UserError } from "../../../core/helper/errors";
import { AbstractModel, MetaModel } from "../../../core/models";

@MetaModel.define()
class ReportProductLabel extends AbstractModel {
  static _module = module;
  static _name = 'report.stock.label.productproductview';
  static _description = 'Product Label Report';

  async _getReportValues(docids, data) {
    if (data['activeModel'] === 'product.template') {
      data['quantity'] = new Map<any, any>();
      for (const [p, q] of Object.entries(data['quantityByProduct'])) {
        data['quantity'].set(this.env.items('product.template').browse(parseInt(p)), q);
      }
    }
    else if (data['activeModel'] === 'product.product') {
      data['quantity'] = {}
      for (const [p, q] of Object.entries(data['quantityByProduct'])) {
        data['quantity'].set(this.env.items('product.product').browse(parseInt(p)), q);
      }
    }
    else {
      throw new UserError(await this._t('Product model not defined, Please contact your administrator.'))
    }
    return data;
  }
}