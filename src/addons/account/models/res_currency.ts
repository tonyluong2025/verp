import { api } from "../../../core";
import { Fields } from "../../../core/fields";
import { UserError } from "../../../core/helper/errors";
import { MetaModel, Model, _super } from "../../../core/models";
import { extend, f } from "../../../core/tools";
import { bool } from "../../../core/tools/bool";

@MetaModel.define()
class ResCurrency extends Model {
  static _module = module;
  static _parents = 'res.currency';

  static displayRoundingWarning = Fields.Boolean({ string: "Display Rounding Warning", compute: '_computeDisplayRoundingWarning', help: "Technical field. Used to tell whether or not to display the rounding warning. The warning informs a rounding factor change might be dangerous on res.currency's form view." });

  @api.depends('rounding')
  async _computeDisplayRoundingWarning() {
    for (const record of this) {
      await record.set('displayRoundingWarning', bool(record.id) && await record._origin.rounding != await record.rounding && await record._origin._hasAccountingEntries());
    }
  }

  async write(vals) {
    if ('rounding' in vals) {
      const roundingVal = vals['rounding'];
      for (const record of this) {
        if ((roundingVal > await record.rounding || roundingVal == 0) && await record._hasAccountingEntries()) {
          throw new UserError(await this._t("You cannot reduce the number of decimal places of a currency which has already been used to make accounting entries."));
        }
      }
    }
    return _super(ResCurrency, this).write(vals);
  }

  /**
   * Returns true iff this currency has been used to generate (hence, round)
      some move lines (either as their foreign currency, or as the main currency
      of their company).
   * @returns 
   */
  async _hasAccountingEntries() {
    this.ensureOne();
    return bool(await this.env.items('account.move.line').searchCount(['|', ['currencyId', '=', this.id], ['companyCurrencyId', '=', this.id]]));
  }

  /**
   * Construct the currency table as a mapping company -> rate to convert the amount to the user's company
      currency in a multi-company/multi-currency environment.
      The currency_table is a small postgresql table construct with VALUES.
      :param options: The report options.
      :return:        The query representing the currency table.
   * @param options 
   */
  @api.model()
  async _getQueryCurrencyTable(options) {
    const userCompany = await this.env.company();
    const userCurrency = await userCompany.currencyId;
    let companies, currencyRates;
    if (options['multiCompany'] ?? false) {
      companies = await this.env.companies();
      const conversionDate = options['date']['dateTo'];
      currencyRates = await (await companies.mapped('currencyId'))._getRates(userCompany, conversionDate);
    }
    else {
      companies = userCompany;
      currencyRates = { [userCurrency.id]: 1.0 };
    }

    const conversionRates = [];
    for (const company of companies) {
      extend(conversionRates, [
        company.id,
        currencyRates[userCurrency.id] / currencyRates[(await company.currencyId).id],
        await userCurrency.decimalPlaces,
      ]);
    }
    const query = f('(VALUES %s) AS "currencyTable"("companyId", rate, precision)', ((await companies.map(c => '(%s, %s, %s)')).join(',')));
    return f(query, ...conversionRates);
  }
}