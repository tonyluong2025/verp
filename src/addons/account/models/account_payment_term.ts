import { DateTime } from "luxon";
import { api } from "../../../core";
import { Fields, _Date } from "../../../core/fields";
import { UserError, ValidationError } from "../../../core/helper/errors";
import { MetaModel, Model, _super } from "../../../core/models";
import { bool, f } from "../../../core/tools";
import { len } from "../../../core/tools/iterable";

@MetaModel.define()
class AccountPaymentTerm extends Model {
  static _module = module;
  static _name = "account.payment.term";
  static _description = "Payment Terms";
  static _order = "sequence, id";

  _defaultLineIds() {
    return [[0, 0, { 'value': 'balance', 'valueAmount': 0.0, 'sequence': 9, 'days': 0, 'option': 'dayAfterInvoiceDate' }]];
  }

  static label = Fields.Char({ string: 'Payment Terms', translate: true, required: true });
  static active = Fields.Boolean({ default: true, help: "If the active field is set to false, it will allow you to hide the payment terms without removing it." });
  static note = Fields.Html({ string: 'Description on the Invoice', translate: true });
  static lineIds = Fields.One2many('account.payment.term.line', 'paymentId', { string: 'Terms', copy: true, default: self => self._defaultLineIds() });
  static companyId = Fields.Many2one('res.company', { string: 'Company' });
  static sequence = Fields.Integer({ required: true, default: 10 });

  @api.constrains('lineIds')
  async _checkLines() {
    for (const terms of this) {
      const lineIds = await terms.lineIds;
      const paymentTermLines = await lineIds.sorted();
      if (paymentTermLines.ok && await paymentTermLines([-1]).value !== 'balance') {
        throw new ValidationError(await this._t('The last line of a Payment Term should have the Balance type.'));;
      }
      const lines = await lineIds.filtered(async (r) => await r.value === 'balance');
      if (len(lines) > 1) {
        throw new ValidationError(await this._t('A Payment Term should have only one line of type Balance.'));
      }
    }
  }

  async compute(value, dateRef?: any, currency?: any) {
    this.ensureOne();
    dateRef = dateRef ?? await _Date.contextToday(this);
    let amount = value;
    let sign = value < 0 ? -1 : 1;
    const result = [];
    if (!currency && this.env.context['currencyId']) {
      currency = this.env.items('res.currency').browse(this.env.context['currencyId']);
    }
    else if (!currency) {
      currency = await (await this.env.company()).currencyId;
    }
    for (const line of await this['lineIds']) {
      let amt;
      const [value, valueAmount, option, days, dayOfTheMonth] = await line('value', 'valueAmount', 'option', 'days', 'dayOfTheMonth');
      if (value === 'fixed') {
        amt = sign * await currency.round(valueAmount);
      }
      else if (value === 'percent') {
        amt = await currency.round(value * (valueAmount / 100.0));
      }
      else if (value === 'balance') {
        amt = await currency.round(amount);
      }
      let nextDate = _Date.toDate(dateRef, false) as DateTime;
      if (option === 'dayAfterInvoiceDate') {
        nextDate = nextDate.plus({ days: days });
        if (dayOfTheMonth > 0) {
          const monthsDelta = (dayOfTheMonth < nextDate.day) ? 1 : 0;
          nextDate = nextDate.plus({ day: dayOfTheMonth, months: monthsDelta });
        }
      }
      else if (option === 'afterInvoiceMonth') {
        const nextFirstDate = nextDate.plus({ day: 1, months: 1 })  // Getting 1st of next month
        nextDate = nextFirstDate.plus({ days: days - 1 });
      }
      else if (option === 'dayFollowingMonth') {
        nextDate = nextDate.plus({ day: days, months: 1 });
      }
      else if (option === 'dayCurrentMonth') {
        nextDate = nextDate.plus({ day: days, months: 0 });
      }
      result.push([_Date.toString(nextDate.toJSDate()), amt]);
      amount -= amt;
    }
    amount = result.reduce((pre, cur) => pre + cur[1], 0);
    const dist = await currency.round(value - amount);
    if (dist) {
      const lastDate = result.length && result[result.length-1][0] || await _Date.contextToday(this);
      result.push([lastDate, dist]);
    }
    return result;
  }

  @api.ondelete(false)
  async _unlinkExceptReferencedTerms() {
    if (bool(this.env.items('account.move').search([['invoicePaymentTermId', 'in', this.ids]]))) {
      throw new UserError(await this._t('You can not delete payment terms as other records still reference it. However, you can archive it.'));
    }
  }

  async unlink() {
    for (const terms of this) {
      await (await (await this.env.items('ir.property').sudo()).search(
        [['valueReference', 'in', await terms.map(paymentTerm => f('account.payment.term,%s', paymentTerm.id))]]
      )).unlink();
    }
    return _super(AccountPaymentTerm, this).unlink();
  }
}

@MetaModel.define()
class AccountPaymentTermLine extends Model {
  static _module = module;
  static _name = "account.payment.term.line";
  static _description = "Payment Terms Line";
  static _order = "sequence, id";

  static value = Fields.Selection([
    ['balance', 'Balance'],
    ['percent', 'Percent'],
    ['fixed', 'Fixed Amount']
  ], {
    string: 'Type', required: true, default: 'balance',
    help: "Select here the kind of valuation related to this payment terms line."
  });
  static valueAmount = Fields.Float({ string: 'Value', digits: 'Payment Terms', help: "For percent enter a ratio between 0-100." });
  static days = Fields.Integer({ string: 'Number of Days', required: true, default: 0 });
  static dayOfTheMonth = Fields.Integer({ string: 'Day of the month', help: "Day of the month on which the invoice must come to its term. If zero or negative, this value will be ignored, and no specific day will be set. If greater than the last day of a month, this number will instead select the last day of this month." });
  static option = Fields.Selection([
    ['dayAfterInvoiceDate', "days after the invoice date"],
    ['afterInvoiceMonth', "days after the end of the invoice month"],
    ['dayFollowingMonth', "of the following month"],
    ['dayCurrentMonth', "of the current month"],
  ],
    { default: 'dayAfterInvoiceDate', required: true, string: 'Options' });
  static paymentId = Fields.Many2one('account.payment.term', { string: 'Payment Terms', required: true, index: true, ondelete: 'CASCADE' });
  static sequence = Fields.Integer({ default: 10, help: "Gives the sequence order when displaying a list of payment terms lines." })

  @api.constrains('value', 'valueAmount')
  async _checkPercent() {
    for (const termLine of this) {
      const [value, valueAmount] = await termLine('value', 'valueAmount');
      if (value === 'percent' && (valueAmount < 0.0 || valueAmount > 100.0)) {
        throw new ValidationError(await this._t('Percentages on the Payment Terms lines must be between 0 and 100.'));
      }
    }
  }

  @api.constrains('days')
  async _checkDays() {
    for (const termLine of this) {
      const [option, days] = await termLine('option', 'days');
      if (['dayFollowingMonth', 'dayCurrentMonth'].includes(option) && days <= 0) {
        throw new ValidationError(await this._t("The day of the month used for this term must be strictly positive."));
      }
      else if (days < 0) {
        throw new ValidationError(await this._t("The number of days used for a payment term cannot be negative."));
      }
    }
  }

  @api.onchange('option')
  async _onchangeOption() {
    if (['dayCurrentMonth', 'dayFollowingMonth'].includes(await this['option'])) {
      await this.set('days', 0);
    }
  }
}
