import { api } from "../../../core";
import { Fields } from "../../../core/fields";
import { ValidationError } from "../../../core/helper";
import { MetaModel, Model } from "../../../core/models";
import { floatRound } from "../../../core/tools";

/**
 *  In some countries, we need to be able to make appear on an invoice a rounding line, appearing there only because the
    smallest coinage has been removed from the circulation. For example, in Switzerland invoices have to be rounded to
    0.05 CHF because coins of 0.01 CHF and 0.02 CHF aren't used anymore.
    see https://en.wikipedia.org/wiki/Cash_rounding for more details.

 */
@MetaModel.define()
class AccountCashRounding extends Model {
  static _module = module;
  static _name = 'account.cash.rounding';
  static _description = 'Account Cash Rounding';

  static label = Fields.Char({ string: 'Name', translate: true, required: true });
  static rounding = Fields.Float({ string: 'Rounding Precision', required: true, default: 0.01, help: 'Represent the non-zero value smallest coinage (for example, 0.05).' });
  static strategy = Fields.Selection([['biggestTax', 'Modify tax amount'], ['addInvoiceLine', 'Add a rounding line']], { string: 'Rounding Strategy', default: 'addInvoiceLine', required: true, help: 'Specify which way will be used to round the invoice amount to the rounding precision' });
  static profitAccountId = Fields.Many2one('account.account', { string: 'Profit Account', companyDependent: true, domain: "[['deprecated', '=', false], ['companyId', '=', currentCompanyId]]" });
  static lossAccountId = Fields.Many2one('account.account', { string: 'Loss Account', companyDependent: true, domain: "[['deprecated', '=', false], ['companyId', '=', currentCompanyId]]" });
  static roundingMethod = Fields.Selection([['UP', 'UP'], ['DOWN', 'DOWN'], ['HALF-UP', 'HALF-UP']], { string: 'Rounding Method', required: true, default: 'HALF-UP', help: 'The tie-breaking rule used for float rounding operations' });
  static companyId = Fields.Many2one('res.company', { related: 'profitAccountId.companyId' });

  @api.constrains('rounding')
  async validateRounding() {
    for (const record of this) {
      if (await record.rounding <= 0) {
        throw new ValidationError(await this._t("Please set a strictly positive rounding value."));
      }
    }
  }

  /**
   * Compute the rounding on the amount passed as parameter.

      :param amount: the amount to round
      :return: the rounded amount depending the rounding value and the rounding method
   * @param amount 
   * @returns 
   */
  async round(amount) {
    return floatRound(amount, { precisionRounding: await this['rounding'], roundingMethod: await this['roundingMethod'] });
  }

  /**
   * Compute the difference between the baseAmount and the amount after rounding.
      For example, baseAmount=23.91, after rounding=24.00, the result will be 0.09.

      :param currency: The currency.
      :param amount: The amount
      :return: round(difference)
   * @param currency 
   * @param amount 
   * @returns 
   */
  async computeDifference(currency, amount) {
    const difference = await this.round(amount) - amount;
    return currency.round(difference);
  }
}