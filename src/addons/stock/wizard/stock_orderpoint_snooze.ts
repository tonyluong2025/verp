import { api } from "../../../core";
import { Fields, _Date } from "../../../core/fields";
import { MetaModel, TransientModel } from "../../../core/models"
import { addDate } from "../../../core/tools/date_utils";

@MetaModel.define()
class StockOrderpointSnooze extends TransientModel {
  static _module = module;
  static _name = 'stock.orderpoint.snooze';
  static _description = 'Snooze Orderpoint';

  static orderpointIds = Fields.Many2many('stock.warehouse.orderpoint');
  static predefinedDate = Fields.Selection([
    ['day', '1 Day'],
    ['week', '1 Week'],
    ['month', '1 Month'],
    ['custom', 'Custom']
  ], { string: 'Snooze for', default: 'day' });
  static snoozedUntil = Fields.Date('Snooze Date');

  @api.onchange('predefinedDate')
  async _onchangePredefinedDate() {
    const predefinedDate = await this['predefinedDate'];
    const today = await _Date.contextToday(self);
    if (predefinedDate === 'day') {
      await this.set('snoozedUntil', addDate(today, { days: 1 }));
    }
    else if (predefinedDate === 'week') {
      await this.set('snoozedUntil', addDate(today, { weeks: 1 }));
    }
    else if (predefinedDate === 'month') {
      await this.set('snoozedUntil', addDate(today, { months: 1 }));
    }
  }

  async actionSnooze() {
    await (await this['orderpointIds']).write({
      'snoozedUntil': await this['snoozedUntil']
    })
  }
}