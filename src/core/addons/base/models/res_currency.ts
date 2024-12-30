import assert from "assert";
import { DateTime } from "luxon";
import xpath from 'xpath';
import { api } from "../../..";
import { Fields, _Date } from "../../../fields";
import { ValueError } from "../../../helper/errors";
import { MetaModel, Model, _super } from "../../../models";
import { bool } from "../../../tools/bool";
import { floatCompare, floatIsZero, floatRound } from "../../../tools/float_utils";
import { isInstance, stringPart } from "../../../tools/func";
import { getLang } from "../../../tools/models";
import { _f, f, num2words, ustr } from "../../../tools/utils";
import { serializeXml } from "../../../tools/xml";

const CURRENCY_DISPLAY_PATTERN = /(\w+)\s*(?:\((.*)\))?'/;

@MetaModel.define()
class Currency extends Model {
  static _module = module;
  static _name = "res.currency";
  static _description = "Currency";
  static _order = 'active desc, label';

  static label = Fields.Char({ string: 'Currency', size: 3, required: true, help: "Currency Code (ISO 4217)" });
  static fullName = Fields.Char({ string: 'Label' });
  static symbol = Fields.Char({ help: "Currency sign, to be used when printing amounts.", required: true });
  static rate = Fields.Float({ compute: '_computeCurrentRate', string: 'Current Rate', digits: 0, help: 'The rate of the currency to the currency of rate 1.' });
  static inverseRate = Fields.Float({ compute: '_computeCurrentRate', digits: 0, readonly: true, help: 'The currency of rate 1 to the rate of the currency.' });
  static rateString = Fields.Char({ compute: '_computeCurrentRate' });
  static rateIds = Fields.One2many('res.currency.rate', 'currencyId', { string: 'Rates' });
  static rounding = Fields.Float({ string: 'Rounding Factor', digits: [12, 6], default: 0.01, help: 'Amounts in this currency are rounded off to the nearest multiple of the rounding factor.' });
  static decimalPlaces = Fields.Integer({ compute: '_computeDecimalPlaces', store: true, help: 'Decimal places taken into account for operations on amounts in this currency. It is determined by the rounding factor.' });
  static active = Fields.Boolean({ default: true });
  static position = Fields.Selection([['after', 'After Amount'], ['before', 'Before Amount']], { default: 'after', string: 'Symbol Position', help: "Determines where the currency symbol should be placed after or before the amount." });
  static date = Fields.Date({ compute: '_computeDate' });
  static currencyUnitLabel = Fields.Char({ string: "Currency Unit", help: "Currency Unit Name" });
  static currencySubunitLabel = Fields.Char({ string: "Currency Subunit", help: "Currency Subunit Name" });
  static isCurrentCompanyCurrency = Fields.Boolean({ compute: '_computeIsCurrentCompanyCurrency' });

  static _sqlConstraints = [
    ['unique_label', 'unique (label)', 'The currency code must be unique!'],
    ['rounding_gt_zero', 'check (rounding>0)', 'The rounding factor must be greater than 0!']
  ];


  @api.modelCreateMulti()
  async create(valsList) {
    const res = await _super(Currency, this).create(valsList);
    await this._toggleGroupMultiCurrency();
    return res;
  }

  async unlink() {
    const res = await _super(Currency, this).unlink();
    await this._toggleGroupMultiCurrency();
    return res;
  }

  async write(vals) {
    const res = await _super(Currency, this).write(vals);
    if (!('active' in vals)) {
      return res;
    }
    await this._toggleGroupMultiCurrency();
    return res;
  }

  /**
   * Automatically activate groupMultiCurrency if there is more than 1 active currency; deactivate it otherwise
   */
  @api.model()
  async _toggleGroupMultiCurrency() {
    const activeCurrencyCount = await this.searchCount([['active', '=', true]]);
    if (activeCurrencyCount > 1) {
      await this._activateGroupMultiCurrency();
    }
    else if (activeCurrencyCount <= 1) {
      await this._deactivateGroupMultiCurrency();
    }
  }

  @api.model()
  async _activateGroupMultiCurrency() {
    const groupUser = await this.env.ref('base.groupUser', false);
    const groupMc = await this.env.ref('base.groupMultiCurrency', false);
    if (bool(groupUser) && bool(groupMc)) {
      await (await groupUser.sudo())._applyGroup(groupMc);
    }
  }

  @api.model()
  async _deactivateGroupMultiCurrency() {
    const groupUser = await this.env.ref('base.groupUser', false);
    const groupMc = await this.env.ref('base.groupMultiCurrency', false);
    if (bool(groupUser) && bool(groupMc)) {
      await (await groupUser.sudo())._removeGroup(await groupMc.sudo());
    }
  }

  async _getRates(company, date: Date) {
    if (!bool(this.ids)) {
      return {};
    }
    await this.env.items('res.currency.rate').flush(['rate', 'currencyId', 'companyId', 'label']);
    const query = `SELECT c.id,
                          COALESCE((SELECT r.rate FROM "resCurrencyRate" r
                                  WHERE r."currencyId" = c.id AND r.label <= '%s'
                                    AND (r."companyId" IS NULL OR r."companyId" = %s)
                               ORDER BY r."companyId", r.label DESC
                                  LIMIT 1), 1.0) AS rate
                   FROM "resCurrency" c
                   WHERE c.id IN (%s)`;
    const res = await this._cr.execute(query, [date.toISOString(), company.id, String(this.ids) || 'NULL']);
    return Object.fromEntries(res.map(i => Object.values(i)));
  }

  @api.dependsContext('company')
  async _computeIsCurrentCompanyCurrency() {
    for (const currency of this) {
      await currency.set('isCurrentCompanyCurrency', (await (await this.env.company()).currencyId).eq(currency));
    }
  }

  @api.depends('rateIds.rate')
  async _computeCurrentRate() {
    const date = this._context['date'] ?? _Date.today();
    let company = this.env.items('res.company').browse(this._context['companyId']);
    company = company.ok ? company : await this.env.company();
    // the subquery selects the last rate before 'date' for the given currency/company
    const currencyRates = await this._getRates(company, date);
    const lastRate = await this.env.items('res.currency.rate')._getLastRatesForCompanies(company);
    for (const currency of this) {
      await currency.set('rate', (currencyRates[currency.id] ?? 1.0) / lastRate.get(company));
      await currency.set('inverseRate', 1 / await currency.rate);
      if (!currency.eq(await company.currencyId)) {
        await currency.set('rateString', f('1 %s = %s %s', await (await company.currencyId).label, (await currency.rate).toFixed(6), await currency.label));
      }
      else {
        await currency.set('rateString', '');
      }
    }
  }

  @api.depends('rounding')
  async _computeDecimalPlaces() {
    for (const currency of this) {
      const rounding = await currency.rounding;
      if (0 < rounding && rounding < 1) {
        await currency.set('decimalPlaces', (Math.ceil(Math.log10(1 / rounding))).toFixed(0));
      }
      else {
        await currency.set('decimalPlaces', 0);
      }
    }
  }

  @api.depends('rateIds.label')
  async _computeDate() {
    for (const currency of this) {
      await currency.set('date', await (await currency.rateIds).slice(0, 1).label);
    }
  }

  @api.model()
  async _nameSearch(name, args?: any, operator = 'ilike', { limit=100, nameGetUid=false } = {}) {
    let results = await _super(Currency, this)._nameSearch(name, args, operator, {limit, nameGetUid});
    if (!results.ok) {
      const nameMatch = name.match(CURRENCY_DISPLAY_PATTERN);
      if (nameMatch) {
        results = await _super(Currency, this)._nameSearch(nameMatch[1], args, operator, {limit, nameGetUid});
      }
    }
    return results;
  }

  async nameGet() {
    const res = [];
    for (const currency of this) {
      res.push([currency.id, ustr(await currency.label)]);
    }
    return res;
  }

  async amountToText(amount) {
    this.ensureOne();

    async function _num2words(num: number, lang: string) {
      try {
        return num2words(num, lang = lang);
      } catch (e) {
        return num2words(num, lang = 'en');
      }
    }

    if (num2words == null) {
      console.log("The library 'num2words' is missing, cannot render textual amounts.");
      return "";
    }

    const formatted = (await this['decimalPlaces']).toFixed(amount);
    const parts = stringPart(formatted, '.');
    const integerValue = parseInt(parts[0]);
    const fractionalValue = parseInt(parts[2] || '0');

    const lang = await getLang(this.env);
    let amountWords = ustr(_f(`{amtValue} {amtWord}`, {
      amtValue: _num2words(integerValue, await lang.isoCode),
      amtWord: await this['currencyUnitLabel'],
    }));
    if (! await this.isZero(amount - integerValue)) {
      amountWords += ' ' + await this._t('and') + ustr(_f(' {amtValue} {amtWord}', {
        amtValue: _num2words(fractionalValue, await lang.isoCode),
        amtWord: await this['currencySubunitLabel'],
      }));
    }
    return amountWords;
  }

  /**
   * Return ``amount`` rounded  according to ``this``'s rounding rules.
   * @param amount the amount to round
   * @returns rounded float
   */
  async round(amount) {
    this.ensureOne();
    return floatRound(amount, { precisionRounding: await this['rounding'] });
  }

  /**
   * Compare ``amount1`` and ``amount2`` after rounding them according to the
         given currency's precision..
      An amount is considered lower/greater than another amount if their rounded
      value is different. This is not the same as having a non-zero difference!

      For example 1.432 and 1.431 are equal at 2 digits precision,
      so this method would return 0.
      However 0.006 and 0.002 are considered different (returns 1) because
      they respectively round to 0.01 and 0.0, even though
      0.006-0.002 = 0.004 which would be considered zero at 2 digits precision.

      @param amount1 first amount to compare
      @param amount2 second amount to compare
      @returns (resp.) -1, 0 or 1, if ``amount1`` is (resp.) lower than,
            equal to, or greater than ``amount2``, according to
            ``currency``'s rounding.

      With the new API, call it like: ``currency.compareAmounts(amount1, amount2)``.
   */
  async compareAmounts(amount1, amount2) {
    this.ensureOne();
    return floatCompare(amount1, amount2, { precisionRounding: await this['rounding'] });
  }

  /**
   * Returns true if ``amount`` is small enough to be treated as
      zero according to current currency's rounding rules.
      Warning: ``isZero(amount1-amount2)`` is not always equivalent to
      ``compareAmounts(amount1,amount2) == 0``, as the former will round after
      computing the difference, while the latter will round before, giving
      different results for e.g. 0.006 and 0.002 at 2 digits precision.

      @param amount amount to compare with currency's zero

      With the new API, call it like: ``currency.isZero(amount)``.
   */
  async isZero(amount) {
    this.ensureOne();
    return floatIsZero(amount, { precisionRounding: await this['rounding'] });
  }

  @api.model()
  async _getConversionRate(fromCurrency, toCurrency, company, date) {
    const currencyRates = await fromCurrency.add(toCurrency)._getRates(company, date);
    const res = currencyRates[toCurrency.id] / currencyRates[fromCurrency.id];
    return res;
  }

  /**
   * Returns the converted amount of ``fromAmount``` from the currency
         ``this`` to the currency ``toCurrency`` for the given ``date`` and
         company.

    * @param amount 
    * @param currency 
    * @param company The company from which we retrieve the convertion rate
    * @param date The nearest date from which we retriev the conversion rate.
    * @param round Round the result or not
   */
  async _convert(amount, currency, company, date, round = true) {
    const self = this.ok ? this : currency;
    currency = currency.ok ? currency : self;
    assert(self.ok, "convert amount from unknown currency")
    assert(currency.ok, "convert amount to unknown currency");
    assert(company.ok, "convert amount from unknown company");
    assert(date, "convert amount from unknown date");
    // apply conversion rate
    let toAmount;
    if (self.eq(currency)) {
      toAmount = amount;
    }
    else {
      toAmount = amount * (await self._getConversionRate(self, currency, company, date));
    }
    // apply rounding
    return round ? await currency.round(toAmount) : toAmount;
  }

  @api.model()
  async _compute(fromCurrency, toCurrency, fromAmount, round = true) {
    console.warn('The `_compute` method is deprecated. Use `_convert` instead');
    const date = this._context['date'] ?? _Date.today();
    let company = this.env.items('res.company').browse(this._context['companyId']);
    company = company.ok ? company : await this.env.company();
    return fromCurrency._convert(fromAmount, toCurrency, company, date);
  }

  async compute(fromAmount, toCurrency, round = true) {
    console.warn('The `compute` method is deprecated. Use `_convert` instead');
    const date = this._context['date'] ?? _Date.today();
    let company = this.env.items('res.company').browse(this._context['companyId']);
    company = company.ok ? company : await this.env.company();
    return this._convert(fromAmount, toCurrency, company, date);
  }

  _selectCompaniesRates() {
    return `
            SELECT
                r."currencyId",
                COALESCE(r."companyId", c.id) as "companyId",
                r.rate,
                r.label AS "dateStart",
                (SELECT label FROM "resCurrencyRate" r2
                 WHERE r2.label > r.label AND
                       r2."currencyId" = r."currencyId" AND
                       (r2."companyId" is null OR r2."companyId" = c.id)
                 ORDER BY r2.label ASC
                 LIMIT 1) AS "dateEnd"
            FROM "resCurrencyRate" r
            JOIN "resCompany" c ON (r."companyId" is null OR r."companyId" = c.id)
        `;
  }

  @api.model()
  async _fieldsViewGet(viewId?: any, viewType = 'form', toolbar = false, submenu = false) {
    const result = await _super(Currency, this)._fieldsViewGet(viewId, viewType, toolbar, submenu);
    if (['tree', 'form'].includes(viewType)) {
      let company = this.env.items('res.company').browse(this._context['companyId']);
      company = company.ok ? company : await this.env.company();
      const currencyName = await (await company.currencyId).label;
      const doc = result['dom'];
      for (const field of [['companyRate', await this._t('Unit per %s', currencyName)],
      ['inverseCompanyRate', await this._t('%s per Unit', currencyName)]]) {
        const node: any = xpath.select1(f('//tree//field[@name="%s"]', field[0]), doc);
        if (node) {
          node.setAttribute('string', field[1]);
        }
      }
      result['arch'] = serializeXml(doc, 'unicode');
    }
    return result;
  }
}

@MetaModel.define()
class CurrencyRate extends Model {
  static _module = module;
  static _name = "res.currency.rate";
  static _description = "Currency Rate";
  static _order = "label desc";

  static label = Fields.Date({ string: 'Date', required: true, index: true, default: self => _Date.contextToday(self) });
  static rate = Fields.Float({
    digits: 0,
    groupOperator: "avg",
    help: 'The rate of the currency to the currency of rate 1',
    string: 'Technical Rate'
  });
  static companyRate = Fields.Float({
    digits: 0,
    compute: "_computeCompanyRate",
    inverse: "_inverseCompanyRate",
    groupOperator: "avg",
    help: "The currency of rate 1 to the rate of the currency.",
  });
  static inverseCompanyRate = Fields.Float({
    digits: 0,
    compute: "_computeInverseCompanyRate",
    inverse: "_inverseInverseCompanyRate",
    groupOperator: "avg",
    help: "The currency of rate 1 to the rate of the currency.",
  });
  static currencyId = Fields.Many2one('res.currency', { string: 'Currency', readonly: true, required: true, ondelete: "CASCADE" });
  static companyId = Fields.Many2one('res.company', { string: 'Company', default: async (self) => await self.env.company() });

  static _sqlConstraints = [
    ['unique_label_per_day', 'unique (label,"currencyId","companyId")', 'Only one currency rate per day allowed!'],
    ['currency_rate_check', 'check (rate>0)', 'The currency rate must be strictly positive.'],
  ];

  _sanitizeVals(vals) {
    if ('inverseCompanyRate' in vals && ('companyRate' in vals || 'rate' in vals)) {
      delete vals['inverseCompanyRate'];
    }
    if ('companyRate' in vals && 'rate' in vals) {
      delete vals['companyRate'];
    }
    return vals;
  }

  async write(vals) {
    return _super(CurrencyRate, this).write(this._sanitizeVals(vals));
  }

  @api.modelCreateMulti()
  async create(valsList) {
    return _super(CurrencyRate, this).create(valsList.map(vals => this._sanitizeVals(vals)));
  }

  async _getLatestRate() {
    let [company, label, currencyId] = await this('companyId', 'label', 'currencyId');
    company = company.ok ? company : await this.env.company();
    return (await (await (await currencyId.rateIds).filtered(async (x) => (
      await x.rate
      && (await x.companyId).eq(company)
      && (await x.label) < (label ?? _Date.today())
    ))).sorted('label'))([-1]);
  }

  async _getLastRatesForCompanies(companies) {
    const res = new Map<any, any>();
    for (const company of companies) {
      res.set(company, await (await (await (await (await company.currencyId).rateIds).filtered(async (x) => {
        const companyId = await x.companyId;
        return (
          await x.rate
          && companyId.eq(company) || !companyId.ok
        )
      })).sorted('label'))([-1]).rate ?? 1);
    }
    return res;
  }

  @api.depends('currencyId', 'companyId', 'label')
  async _computeRate() {
    for (const currencyRate of this) {
      await currencyRate.set('rate', await currencyRate.rate || await (await this._getLatestRate()).rate || 1.0);
    }
  }

  @api.depends('rate', 'label', 'currencyId', 'companyId', 'currencyId.rateIds.rate')
  @api.dependsContext('company')
  async _computeCompanyRate() {
    let company = await this['companyId'];
    const lastRate = await this.env.items('res.currency.rate')._getLastRatesForCompanies(company.or(await this.env.company()));
    for (const currencyRate of this) {
      company = await currencyRate.companyId;
      company = company.ok ? company : this.env.company();
      await currencyRate.set('companyRate', (await currencyRate.rate || await (await this._getLatestRate()).rate || 1.0) / lastRate.get(company));
    }
  }

  @api.onchange('companyRate')
  async _inverseCompanyRate() {
    let company = await this['companyId'];
    const lastRate = await this.env.items('res.currency.rate')._getLastRatesForCompanies(company.or(await this.env.company()));
    for (const currencyRate of this) {
      company = await currencyRate.companyId;
      company = company.ok ? company : this.env.company();
      await currencyRate.set('rate', (await currencyRate.companyRate) * lastRate.get(company));
    }
  }

  @api.depends('companyRate')
  async _computeInverseCompanyRate() {
    for (const currencyRate of this) {
      await currencyRate.set('inverseCompanyRate', 1.0 / await currencyRate.companyRate);
    }
  }

  @api.onchange('inverseCompanyRate')
  async _inverseInverseCompanyRate() {
    for (const currencyRate of this) {
      await currencyRate.set('companyRate', 1.0 / await currencyRate.inverseCompanyRate);
    }
  }

  @api.onchange('companyRate')
  async _onchangeRateWarning() {
    const latestRate = await this._getLatestRate();
    if (latestRate) {
      const diff = (await latestRate.rate - await this['rate']) / await latestRate.rate;
      if (Math.abs(diff) > 0.2) {
        return {
          'warning': {
            'title': await this._t("Warning for %s", await (await this['currencyId']).label),
            'message': await this._t(
              `The new rate is quite far from the previous rate.\n
                            Incorrect currency rates may cause critical problems, make sure the rate is correct !`
            )
          }
        }
      }
    }
  }

  @api.model()
  async _nameSearch(name, args?: any, operator = 'ilike', { limit=100, nameGetUid=false } = {}) {
    if (['=', '!='].includes(operator)) {
      try {
        let dateFormat = 'yyyy-MM-dd';
        if (this._context['lang']) {
          const langId = await this.env.items('res.lang')._search([['code', '=', this._context['lang']]], { accessRightsUid: nameGetUid });
          if (bool(langId)) {
            dateFormat = this.browse(langId).dateFormat;
          }
        }
        name = DateTime.fromFormat(name, dateFormat).toFormat('yyyy-MM-dd');
      } catch (e) {
        if (isInstance(e, ValueError)) {
          try {
            args.push(['rate', operator, parseFloat(name)]);
          } catch (e) {
            if (isInstance(e, ValueError)) {
              return [];
            }
          }
          name = '';
          operator = 'ilike';
        } else {
          throw e;
        }
      }
    }
    return _super(CurrencyRate, this)._nameSearch(name, args, operator, {limit, nameGetUid});
  }

  @api.model()
  async _fieldsViewGet(viewId?: any, viewType = 'form', toolbar = false, submenu = false) {
    const result = await _super(CurrencyRate, this)._fieldsViewGet(viewId, viewType, toolbar, submenu);
    if (['tree'].includes(viewType)) {
      let company = this.env.items('res.company').browse(this._context['companyId']);
      company = company.ok ? company : await this.env.company();
      const names = {
        'companyCurrencyName': await (await company.currencyId).label,
        'rateCurrencyName': await this.env.items('res.currency').browse(this._context['activeId']).label ?? 'Unit',
      }
      const doc = result['dom'];
      for (const field of [['companyRate', _f(await this._t('{rateCurrencyName} per {companyCurrencyName}'), names)],
      ['inverseCompanyRate', _f(await this._t('{companyCurrencyName} per {rateCurrencyName}'), names)]]) {
        const node: any = xpath.select1(f('//tree//field[@name="%s"]', field[0]), doc);
        if (node) {
          node.setAttrbute('string', field[1]);
        }
      }
      result['arch'] = serializeXml(doc, 'unicode');
    }
    return result;
  }
}