import { Fields, _Date, _Datetime, api } from "../../../core";
import { MetaModel, TransientModel } from "../../../core/models"
import { formatDate } from "../../../core/tools/models";
import { combine, getMonth, subDate } from "../../../core/tools/date_utils";
import { expression } from "../../../core/osv";
import { bool } from "../../../core/tools/bool";
import { stringify } from "../../../core/tools/json";

@MetaModel.define()
class StockReplenishmentInfo extends TransientModel {
  static _module = module;
  static _name = 'stock.replenishment.info';
  static _description = 'Stock supplier replenishment information';
  static _recName = 'orderpointId';

  static orderpointId = Fields.Many2one('stock.warehouse.orderpoint');
  static productId = Fields.Many2one('product.product', { related: 'orderpointId.productId' });
  static qtyToOrder = Fields.Float({ related: 'orderpointId.qtyToOrder' });
  static jsonLeadDays = Fields.Char({ compute: '_computeJsonLeadDays' });
  static jsonReplenishmentHistory = Fields.Char({ compute: '_computeJsonReplenishmentHistory' });

  @api.depends('orderpointId')
  async _computeJsonLeadDays() {
    await this.set('jsonLeadDays', false);
    for (const replenishmentReport of this) {
      const orderpointId = await replenishmentReport.orderpointId;
      const [productId, locationId] = await orderpointId('productId', 'locationId');
      if (!bool(productId) || !bool(locationId)) {
        continue;
      }
      // orderpoint = replenishmentReport.orderpointId;
      const [leadDaysDate, trigger, qtyForecast, qtyToOrder, productMinQty, productMaxQty, productUomName, createdUid] = await orderpointId('leadDaysDate', 'trigger', 'qtyForecast', 'qtyToOrder', 'productMinQty', 'productMaxQty', 'productUomName', 'createdUid');
      const orderpointsValues = await orderpointId._getLeadDaysValues();
      const [, leadDaysDescription] = await (await orderpointId.ruleIds)._getLeadDays(await orderpointId.productId, orderpointsValues);
      await replenishmentReport.set('jsonLeadDays', stringify({
        'template': 'stock.leadDaysPopOver',
        'leadDaysDate': await formatDate(this.env, leadDaysDate),
        'leadDaysDescription': leadDaysDescription,
        'today': await formatDate(this.env, _Date.today()),
        'trigger': trigger,
        'qtyForecast': this.env.items('ir.qweb.field.float').valueToHtml(qtyForecast, { 'decimalPrecision': 'Product Unit of Measure' }),
        'qtyToOrder': this.env.items('ir.qweb.field.float').valueToHtml(qtyToOrder, { 'decimalPrecision': 'Product Unit of Measure' }),
        'productMinQty': this.env.items('ir.qweb.field.float').valueToHtml(productMinQty, { 'decimalPrecision': 'Product Unit of Measure' }),
        'productMaxQty': this.env.items('ir.qweb.field.float').valueToHtml(productMaxQty, { 'decimalPrecision': 'Product Unit of Measure' }),
        'productUomName': productUomName,
        'virtual': trigger === 'manual' && createdUid.id == global.SUPERUSER_ID,
      }));
    }
  }

  @api.depends('orderpointId')
  async _computeJsonReplenishmentHistory() {
    for (const replenishmentReport of this) {
      const [productId, orderpointId] = await replenishmentReport('productId', 'orderpointId');
      const replenishmentHistory = [];
      const today = _Datetime.now();
      const firstMonth = subDate(today, { months: 2 });
      const [dateFrom,] = getMonth(firstMonth);
      const [, dateTo] = getMonth(today);
      const domain = [
        ['productId', '=', productId.id],
        ['date', '>=', dateFrom],
        ['date', '<=', combine(dateTo, 'max')],
        ['state', '=', 'done'],
        ['companyId', '=', (await orderpointId.companyId).id]
      ];
      const quantityByMonthOut = this.env.items('stock.move').readGroup(
        expression.AND([domain, [['locationDestId.usage', '=', 'customer']]]),
        ['date', 'productQty'], ['date:month']);
      let quantityByMonthReturned = this.env.items('stock.move').readGroup(
        expression.AND([domain, [['locationId.usage', '=', 'customer']]]),
        ['date', 'productQty'], ['date:month']);
      quantityByMonthReturned = Object.fromEntries(quantityByMonthReturned.map(g => [g['date:month'], g['productQty']]));
      for (const group of quantityByMonthOut) {
        const month = group['date:month'];
        replenishmentHistory.push({
          'label': month,
          'quantity': group['productQty'] - quantityByMonthReturned[month] || 0,
          'uomName': await (await productId.uomId).displayName,
        });
        await replenishmentReport.set('jsonReplenishmentHistory', stringify({
          'template': 'stock.replenishmentHistory',
          'replenishmentHistory': replenishmentHistory
        }));
      }
    }
  }
}