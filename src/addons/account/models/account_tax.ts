import _ from "lodash";
import { api, tools } from "../../../core";
import { Fields } from "../../../core/fields";
import { UserError, ValidationError } from "../../../core/helper/errors";
import { MetaModel, Model, ModelRecords, _super } from "../../../core/models";
import { expression } from "../../../core/osv";
import { bool, copysign, extend, f, floatRound, len, setOptions, sum } from "../../../core/tools";

export const TYPE_TAX_USE = [
  ['sale', 'Sales'],
  ['purchase', 'Purchases'],
  ['none', 'None'],
];

@MetaModel.define()
class AccountTaxGroup extends Model {
  static _module = module;
  static _name = 'account.tax.group';
  static _description = 'Tax Group';
  static _order = 'sequence asc';

  static label = Fields.Char({ required: true, translate: true });
  static sequence = Fields.Integer({ default: 10 });
  static propertyTaxPayableAccountId = Fields.Many2one('account.account', { companyDependent: true, string: 'Tax current account (payable)' });
  static propertyTaxReceivableAccountId = Fields.Many2one('account.account', { companyDependent: true, string: 'Tax current account (receivable)' });
  static propertyAdvanceTaxPaymentAccountId = Fields.Many2one('account.account', { companyDependent: true, string: 'Advance Tax payment account' });
  static countryId = Fields.Many2one({ string: "Country", comodelName: 'res.country', help: "The country for which this tax group is applicable." });
  static precedingSubtotal = Fields.Char({ string: "Preceding Subtotal", help: "If set, this value will be used on documents as the label of a subtotal excluding this tax group before displaying it.\nIf not set, the tax group will be displayed after the 'Untaxed amount' subtotal." });

  /**
   * Searches the tax groups used on the taxes from company in countries that don't have
      at least a tax payable account, a tax receivable account or an advance tax payment account.

   * @param company 
   * @param countries 
   * @returns A boolean telling whether or not there are misconfigured groups for any
               of these countries, in this company
   */
  @api.model()
  async _checkMisconfiguredTaxGroups(company, countries) {
    // This cannot be refactored to check for misconfigured groups instead
    // because of an ORM limitation with search on property fields:
    // searching on property = false also returns the properties using the default value,
    // even if it's non-empty.
    const allConfiguredGroupsIds = await (await this.withCompany(company))._search([
      ['propertyTaxPayableAccountId', '!=', false],
      ['propertyTaxReceivableAccountId', '!=', false],
    ]);

    return bool(await this.env.items('account.tax').search([
      ['companyId', '=', company.id],
      ['taxGroupId', 'not in', allConfiguredGroupsIds],
      ['countryId', 'in', countries.ids],
    ], { limit: 1 }));
  }
}

@MetaModel.define()
class AccountTax extends Model {
  static _module = module;
  static _name = 'account.tax';
  static _description = 'Tax';
  static _order = 'sequence,id';
  static _checkCompanyAuto = true;

  @api.model()
  async _defaultTaxGroup() {
    return this.env.ref('account.taxGroupTaxes');
  }

  static label = Fields.Char({ string: 'Tax Name', required: true });
  static typeTaxUse = Fields.Selection(TYPE_TAX_USE, { string: 'Tax Type', required: true, default: "sale", help: "Determines where the tax is selectable. Note : 'None' means a tax can't be used by itself, however it can still be used in a group. 'adjustment' is used to perform tax adjustment." });
  static taxScope = Fields.Selection([['service', 'Services'], ['consu', 'Goods']], { string: "Tax Scope", help: "Restrict the use of taxes to a type of product." });
  static amountType = Fields.Selection([['group', 'Group of Taxes'], ['fixed', 'Fixed'], ['percent', 'Percentage of Price'], ['division', 'Percentage of Price Tax Included']], {
    default: 'percent', string: "Tax Computation", required: true, help: `
  - Group of Taxes: The tax is a set of sub taxes.
  - Fixed: The tax amount stays the same whatever the price.
  - Percentage of Price: The tax amount is a % of the price:
      e.g 100 * (1 + 10%) = 110 (not price included)
      e.g 110 / (1 + 10%) = 100 (price included)
  - Percentage of Price Tax Included: The tax amount is a division of the price:
      e.g 180 / (1 - 10%) = 200 (not price included)
      e.g 200 * (1 - 10%) = 180 (price included)
  `});
  static active = Fields.Boolean({ default: true, help: "Set active to false to hide the tax without removing it." });
  static companyId = Fields.Many2one('res.company', { string: 'Company', required: true, readonly: true, default: self => self.env.company() });
  static childrenTaxIds = Fields.Many2many('account.tax', { relation: 'accountTaxFiliationRel', column1: 'parentTax', column2: 'childTax', checkCompany: true, string: 'Children Taxes' });
  static sequence = Fields.Integer({ required: true, default: 1, help: "The sequence field is used to define order in which the tax lines are applied." });
  static amount = Fields.Float({ required: true, digits: [16, 4], default: 0.0 });
  static description = Fields.Char({ string: 'Label on Invoices' });
  static priceInclude = Fields.Boolean({ string: 'Included in Price', default: false, help: "Check this if the price you use on the product and invoices includes this tax." });
  static includeBaseAmount = Fields.Boolean({ string: 'Affect Base of Subsequent Taxes', default: false, help: "If set, taxes with a higher sequence than this one will be affected by it, provided they accept it." });
  static isBaseAffected = Fields.Boolean({ string: "Base Affected by Previous Taxes", default: true, help: "If set, taxes with a lower sequence might affect this one, provided they try to do it." });
  static analytic = Fields.Boolean({ string: "Include in Analytic Cost", help: "If set, the amount computed by this tax will be assigned to the same analytic account as the invoice line (if any)" });
  static taxGroupId = Fields.Many2one('account.tax.group', { string: "Tax Group", default: self => self._defaultTaxGroup(), required: true, domain: "[['countryId', 'in', [countryId, false]]]" });
  // Technical field to make the 'taxExigibility' field invisible if the same named field is set to false in 'res.company' model
  static hideTaxExigibility = Fields.Boolean({ string: 'Hide Use Cash Basis Option', related: 'companyId.taxExigibility', readonly: true });
  static taxExigibility = Fields.Selection(
    [['onInvoice', 'Based on Invoice'],
    ['onPayment', 'Based on Payment'],
    ], {
    string: 'Tax Exigibility', default: 'onInvoice',
    help: "Based on Invoice: the tax is due as soon as the invoice is validated.\nBased on Payment: the tax is due as soon as the payment of the invoice is received."
  });
  static cashBasisTransitionAccountId = Fields.Many2one({
    string: "Cash Basis Transition Account",
    checkCompany: true,
    domain: "[['deprecated', '=', false], ['companyId', '=', companyId]]",
    comodelName: 'account.account',
    help: "Account used to transition the tax amount for cash basis taxes. It will contain the tax amount as long as the original invoice has not been reconciled ; at reconciliation, this amount cancelled on this account and put on the regular tax account."
  })
  static invoiceRepartitionLineIds = Fields.One2many("account.tax.repartition.line", "invoiceTaxId", { string: "Distribution for Invoices", copy: true, help: "Distribution when the tax is used on an invoice" });
  static refundRepartitionLineIds = Fields.One2many("account.tax.repartition.line", "refundTaxId", { string: "Distribution for Refund Invoices", copy: true, help: "Distribution when the tax is used on a refund" });
  static countryId = Fields.Many2one({ string: "Country", comodelName: 'res.country', required: true, help: "The country for which this tax is applicable." });
  static countryCode = Fields.Char({ related: 'countryId.code', readonly: true });

  static _sqlConstraints = [
    ['label_company_uniq', 'unique(label, "companyId", "typeTaxUse", "taxScope")', 'Tax names must be unique !'],
  ]

  @api.constrains('taxGroupId')
  async validateTaxGroupId() {
    for (const record of this) {
      const countryId = await (await record.taxGroupId).countryId;
      if (countryId.ok && !countryId.eq(await record.countryId)) {
        throw new ValidationError(await this._t("The tax group must have the same countryId as the tax using it."));
      }
    }
  }

  @api.model()
  async defaultGet(fieldsList) {
    // companyId is added so that we are sure to fetch a default value from it to use in repartition lines, below
    const rslt = await _super(AccountTax, this).defaultGet(fieldsList.concat(['companyId']));

    const companyId = rslt['companyId'];
    const company = this.env.items('res.company').browse(companyId);

    if (fieldsList.includes('countryId')) {
      rslt['countryId'] = (await company.accountFiscalCountryId).id;
    }
    if (fieldsList.includes('refundRepartitionLineIds')) {
      rslt['refundRepartitionLineIds'] = [
        [0, 0, { 'repartitionType': 'base', 'factorPercent': 100.0, 'tagIds': [], 'companyId': companyId }],
        [0, 0, { 'repartitionType': 'tax', 'factorPercent': 100.0, 'tagIds': [], 'companyId': companyId }],
      ];
    }

    if (fieldsList.includes('invoiceRepartitionLineIds')) {
      rslt['invoiceRepartitionLineIds'] = [
        [0, 0, { 'repartitionType': 'base', 'factorPercent': 100.0, 'tagIds': [], 'companyId': companyId }],
        [0, 0, { 'repartitionType': 'tax', 'factorPercent': 100.0, 'tagIds': [], 'companyId': companyId }],
      ];
    }

    return rslt;
  }

  async _checkRepartitionLines(lines) {
    this.ensureOne();

    const baseLine = await lines.filtered(async (x) => await x.repartitionType === 'base');
    if (len(baseLine) != 1) {
      throw new ValidationError(await this._t("Invoice and credit note distribution should each contain exactly one line for the base."));
    }
  }

  @api.constrains('invoiceRepartitionLineIds', 'refundRepartitionLineIds')
  async _validateRepartitionLines() {
    for (const record of this) {
      const invoiceRepartitionLineIds = await (await record.invoiceRepartitionLineIds).sorted();
      const refundRepartitionLineIds = await (await record.refundRepartitionLineIds).sorted();
      await record._checkRepartitionLines(invoiceRepartitionLineIds);
      await record._checkRepartitionLines(refundRepartitionLineIds);

      if (len(invoiceRepartitionLineIds) != len(refundRepartitionLineIds)) {
        throw new ValidationError(await this._t("Invoice and credit note distribution should have the same number of lines."));
      }
      let index = 0;
      while (index < len(invoiceRepartitionLineIds)) {
        const invRepLn = invoiceRepartitionLineIds[index];
        const refRepLn = refundRepartitionLineIds[index];
        if (await invRepLn.repartitionType != await refRepLn.repartitionType) {
          throw new ValidationError(await this._t("Invoice and credit note distribution should match same repartitionType (%s <> %s).", await invRepLn.repartitionType, await refRepLn.repartitionType));
        } 
        if (await invRepLn.factorPercent != await refRepLn.factorPercent) {
          throw new ValidationError(await this._t("Invoice and credit note distribution should match same factorPercent (%s <> %s).", await invRepLn.factorPercent, await refRepLn.factorPercent));
        }
        index += 1;
      }
    }
  }

  @api.constrains('childrenTaxIds', 'typeTaxUse')
  async _checkChildrenScope() {
    for (const tax of this) {
      if (! await tax._checkM2mRecursion('childrenTaxIds')) {
        throw new ValidationError(await this._t("Recursion found for tax '%s'.", await tax.label,));
      }
      if (await (await tax.childrenTaxIds).some(async (child) => !['none', await tax.typeTaxUse].includes(await child.typeTaxUse) || await child.taxScope !== await tax.taxScope)) {
        throw new ValidationError(await this._t('The application scope of taxes in a group must be either the same as the group or left empty.'));
      }
    }
  }

  @api.constrains('companyId')
  async _checkCompanyConsistency() {
    if (!this.ok) {
      return;
    }

    await this.flush(['companyId']);
    const res = await this._cr.execute(`
              SELECT line.id
              FROM "accountMoveLine" line
              JOIN "accountTax" tax ON tax.id = line."taxLineId"
              WHERE line."taxLineId" IN (%s)
              AND line."companyId" != tax."companyId"
    
              UNION ALL
    
              SELECT line.id
              FROM "accountMoveLineAccountTaxRel" "taxrel"
              JOIN "accountTax" tax ON tax.id = taxrel."accountTaxId"
              JOIN "accountMoveLine" line ON line.id = taxrel."accountMoveLineId"
              WHERE taxrel."accountTaxId" IN (%s)
              AND line."companyId" != tax."companyId"
          `, [String(this.ids) || 'NULL', String(this.ids) || 'NULL']);
    if (res.length) {
      throw new UserError(await this._t("You can't change the company of your tax since there are some journal items linked to it."));
    }
  }

  @api.returns('self', (value) => value.id)
  async copy(defaultValue?: any) {
    defaultValue = Object.assign({}, defaultValue || {});
    if (!('label' in defaultValue)) {
      defaultValue['label'] = await this._t("%s (Copy)", await this['label']);
    }
    return _super(AccountTax, this).copy(defaultValue);
  }

  async nameGet() {
    const typeTaxUse = Object.fromEntries(await this._fields['typeTaxUse']._descriptionSelection(this._fields['typeTaxUse'], this.env));
    const taxScope = Object.fromEntries(await this._fields['taxScope']._descriptionSelection(this._fields['taxScope'], this.env));
    let nameList = [];
    for (const record of this) {
      let label = await record.label;
      if (this._context['appendTypeToTaxName']) {
        label += f(' (%s)', typeTaxUse[await record.typeTaxUse]);
      }
      if (await record.taxScope) {
        label += f(' (%s)', taxScope[await record.taxScope]);
      }
      extend(nameList, [[record.id, label]]);
    }
    return nameList;
  }

  /**
   * Returns a list of tuples containing id, name, as internally it is called {function nameGet}
          result format: {[[id, label], [id, label], ...]}
   * @param name 
   * @param args 
   * @param operator 
   * @param options 
   */
  @api.model()
  async _nameSearch(name, args?: any, operator = 'ilike', { limit=100, nameGetUid=false } = {}) {
    args = args || [];
    let domain;
    if (operator === 'ilike' && !(name || '').trim()) {
      domain = [];
    }
    else {
      const connector = expression.NEGATIVE_TERM_OPERATORS.includes(operator) ? '&' : '|';
      domain = [connector, ['description', operator, name], ['label', operator, name]];
    }
    return this._search(expression.AND([domain, args]), { limit, accessRightsUid: nameGetUid });
  }

  @api.model()
  async _search(args, options: { offset?: number, limit?: any, order?: any, count?: false, accessRightsUid?: any } = {}) {
    options.offset = options.offset || 0;
    const context = this._context || {};

    if (context['moveType']) {
      if (['outInvoice', 'outRefund'].includes(context['moveType'])) {
        args = args.concat([['typeTaxUse', '=', 'sale']]);
      }
      else if (['inInvoice', 'inRefund'].includes(context['moveType'])) {
        args = args.concat([['typeTaxUse', '=', 'purchase']]);
      }
    }
    if (context['journalId']) {
      const journal = this.env.items('account.journal').browse(context['journalId']);
      if (['sale', 'purchase'].includes(await journal.type)) {
        args = args.concat([['typeTaxUse', '=', await journal.type]]);
      }
    }
    return _super(AccountTax, this)._search(args, options);
  }

  @api.onchange('amount')
  async onchangeAmount() {
    if (['percent', 'division'].includes(await this['amountType']) && await this['amount'] !== 0.0 && ! await this['description']) {
      await this.set('description', (await this['amount']).toFixed(4));// {0.4g}
    }
  }

  @api.onchange('amountType')
  async onchangeAmountType() {
    const amountType = await this['amountType'];
    if (amountType !== 'group') {
      await this.set('childrenTaxIds', [[5,]]);
    }
    if (amountType === 'group') {
      await this.set('description', null);
    }
  }

  @api.onchange('priceInclude')
  async onchangePriceInclude() {
    if (await this['priceInclude']) {
      await this.set('includeBaseAmount', true);
    }
  }

  /**
   * Returns the amount of a single tax. baseAmount is the actual amount on which the tax is applied, which is
          priceUnit * quantity eventually affected by previous taxes (if tax is includeBaseAmount XOR priceInclude)
   * @param baseAmount 
   * @param priceUnit 
   * @param quantity 
   * @param product 
   * @param partner 
   * @returns 
   */
  async _computeAmount(baseAmount, priceUnit, quantity = 1.0, product?: any, partner?: any) {
    this.ensureOne();
    const [amountType, amount] = await this('amountType', 'amount');
    if (amountType === 'fixed') {
      // Use copysign to take into account the sign of the base amount which includes the sign
      // of the quantity and the sign of the priceUnit
      // Amount is the fixed price for the tax, it can be negative
      // Base amount included the sign of the quantity and the sign of the unit price and when
      // a product is returned, it can be done either by changing the sign of quantity or by changing the
      // sign of the price unit.
      // When the price unit is equal to 0, the sign of the quantity is absorbed in baseAmount then
      // a "else" case is needed.
      if (baseAmount) {
        return copysign(quantity, baseAmount) * await amount;
      }
      else {
        return quantity * amount;
      }
    }
    const priceInclude = this._context['forcePriceInclude'] ?? await this['priceInclude'];

    // base * (1 + taxAmount) = newBase
    if (amountType === 'percent' && !priceInclude) {
      return baseAmount * amount / 100;
    }
    // <=> newBase = base / (1 + taxAmount)
    if (amountType === 'percent' && priceInclude) {
      return baseAmount - (baseAmount / (1 + amount / 100));
    }
    // base / (1 - taxAmount) = newBase
    if (amountType === 'division' && !priceInclude) {
      return baseAmount / (1 - amount / 100) - (1 - amount / 100) ? baseAmount : 0.0;
    }
    // <=> newBase * (1 - taxAmount) = base
    if (amountType === 'division' && priceInclude) {
      return baseAmount - (baseAmount * (amount / 100));
    }
  }

  /**
   * Called by the reconciliation to compute taxes on writeoff during bank reconciliation
   * @param priceUnit 
   * @param currencyId 
   * @param quantity 
   * @param productId 
   * @param partnerId 
   * @param isRefund 
   * @returns 
   */
  async jsonFriendlyComputeAll(priceUnit, options: { currencyId?: any, quantity?: number, productId?: any, partnerId?: any, isRefund?: boolean } = {}) {
    options.quantity = options.quantity ?? 1.0;
    if (options.currencyId) {
      options.currencyId = this.env.items('res.currency').browse(options.currencyId);
    }
    if (options.productId) {
      options.productId = this.env.items('product.product').browse(options.productId);
    }
    if (options.partnerId) {
      options.partnerId = this.env.items('res.partner').browse(options.partnerId);
    }
    // We first need to find out whether this tax computation is made for a refund
    const taxType = this.ok && await this[0].typeTaxUse;
    options.isRefund = options.isRefund || (taxType === 'sale' && priceUnit < 0) || (taxType === 'purchase' && priceUnit > 0);

    return this.computeAll(priceUnit, options);
  }

  async flattenTaxesHierarchy(createMap = false): Promise<[any, Map<any, any>]> {
    // Flattens the taxes contained in this recordset, returning all the
    // children at the bottom of the hierarchy, in a recordset, ordered by sequence.
    //   Eg. considering letters as taxes and alphabetic order as sequence :
    //   [G, B([A, D, F]), E, C] will be computed as [A, D, F, C, E, G]
    // If createMap is true, an additional value is returned, a dictionary
    // mapping each child tax to its parent group
    let allTaxes = this.env.items('account.tax');
    const groupsMap = new Map<ModelRecords, ModelRecords>();
    for (const tax of await this.sorted((r) => r.sequence)) {
      if (await tax.amountType === 'group') {
        const flattenedChildren = await (await tax['childrenTaxIds']).flattenTaxesHierarchy();
        allTaxes = allTaxes.add(flattenedChildren);
        for (const flatChild of flattenedChildren) {
          groupsMap.set(flatChild, tax);
        }
      }
      else {
        allTaxes = allTaxes.add(tax);
      }
    }
    if (createMap) {
      return [allTaxes, groupsMap];
    }
    return allTaxes;
  }

  async getTaxTags(isRefund, repartitionType) {
    const repLines = await this.mapped(isRefund && 'refundRepartitionLineIds' || 'invoiceRepartitionLineIds');
    return (await repLines.filtered(async (x) => await x.repartitionType === repartitionType)).mapped('tagIds');
  }

  /**
   * Returns all information required to apply taxes (in self + their children in case of a tax group).
          We consider the sequence of the parent for group of taxes.
              Eg. considering letters as taxes and alphabetic order as sequence :
              [G, B([A, D, F]), E, C] will be computed as [A, D, F, C, E, G]
 
          'handlePriceInclude' is used when we need to ignore all tax included in price. If false, it means the
          amount passed to this method will be considered as the base of all computations.
 
      RETURN: {
          'totalExcluded': 0.0,    // Total without taxes
          'totalIncluded': 0.0,    // Total with taxes
          'totalVoid'    : 0.0,    // Total with those taxes, that don't have an account set
          'taxes': [{               // One dict for each tax in self and their children
              'id': int,
              'label': str,
              'amount': float,
              'sequence': int,
              'accountId': int,
              'refundAccountId': int,
              'analytic': boolean,
          }],
      }
   * @param priceUnit 
   * @param options 
   * @returns 
   */
  async computeAll(priceUnit, options: { currency?: any, quantity?: number, product?: any, partner?: any, isRefund?: boolean, handlePriceInclude?: boolean, includeCabaTags?: boolean } = {}) {
    setOptions(options, { quantity: 1.0, handlePriceInclude: true });
    let company;
    if (!this.ok) {
      company = await this.env.company();
    }
    else {
      company = await this[0].companyId;
    }
    // 1) Flatten the taxes.
    const [taxes, groupsMap] = await this.flattenTaxesHierarchy(true);

    // 2) Deal with the rounding methods
    let currency = options.currency;
    if (!currency) {
      currency = await company.currencyId;
    }
    // By default, for each tax, tax amount will first be computed
    // and rounded at the 'Account' decimal precision for each
    // PO/SO/invoice line and then these rounded amounts will be
    // summed, leading to the total amount for that tax. But, if the
    // company has taxCalculationRoundingMethod = roundGlobally,
    // we still follow the same method, but we use a much larger
    // precision when we round the tax amount for each line (we use
    // the 'Account' decimal precision + 5), and that way it's like
    // rounding after the sum of the tax amounts of each line
    let prec = await currency.rounding;

    // In some cases, it is necessary to force/prevent the rounding of the tax and the total
    // amounts. For example, in SO/PO line, we don't want to round the price unit at the
    // precision of the currency.
    // The context key 'round' allows to force the standard behavior.
    let roundTax = await company.taxCalculationRoundingMethod === 'roundGlobally' ? false : true;
    if ('round' in this.env.context) {
      roundTax = bool(this.env.context['round']);
    }
    if (!roundTax) {
      prec *= 1e-5;
    }

    // 3) Iterate the taxes in the reversed sequence order to retrieve the initial base of the computation.
    //     tax  |  base  |  amount  |
    // /\ ----------------------------
    // || tax_1 |  XXXX  |          | <- we are looking for that, it's the totalExcluded
    // || tax_2 |   ..   |          |
    // || tax_3 |   ..   |          |
    // ||  ...  |   ..   |    ..    |
    //    ----------------------------
    function recomputeBase(baseAmount, fixedAmount, percentAmount, divisionAmount) {
      // Recompute the new base amount based on included fixed/percent amounts and the current base amount.
      // Example:
      //  tax  |  amount  |   type   |  priceInclude  |
      // ----------------------------------------------
      // tax_1 |   10%    | percent  |  t
      // tax_2 |   15     |   fix    |  t
      // tax_3 |   20%    | percent  |  t
      // tax_4 |   10%    | division |  t
      // -----------------------------------------------

      // if baseAmount = 145, the new base is computed as:
      // (145 - 15) / (1.0 + 30%) * 90% = 130 / 1.3 * 90% = 90
      return (baseAmount - fixedAmount) / (1.0 + percentAmount / 100.0) * (100 - divisionAmount) / 100;
    }
    // The first/last base must absolutely be rounded to work in round globally.
    // Indeed, the sum of all taxes ('taxes' key in the result dictionary) must be strictly equals to
    // 'priceIncluded' - 'priceExcluded' whatever the rounding method.
    //
    // Example using the global rounding without any decimals:
    // Suppose two invoice lines: 27000 and 10920, both having a 19% price included tax.
    //
    //                  Line 1                      Line 2
    // -----------------------------------------------------------------------
    // totalIncluded:   27000                       10920
    // tax:             27000 / 1.19 = 4310.924     10920 / 1.19 = 1743.529
    // totalExcluded:   22689.076                   9176.471
    //
    // If the rounding of the totalExcluded isn't made at the end, it could lead to some rounding issues
    // when summing the tax amounts, e.g. on invoices.
    // In that case:
    //  - amountUntaxed will be 22689 + 9176 = 31865
    //  - amountTax will be 4310.924 + 1743.529 = 6054.453 ~ 6054
    //  - amountTotal will be 31865 + 6054 = 37919 != 37920 = 27000 + 10920
    //
    // By performing a rounding at the end to compute the priceExcluded amount, the amountTax will be strictly
    // equals to 'priceIncluded' - 'priceExcluded' after rounding and then:
    //   Line 1: sum(taxes) = 27000 - 22689 = 4311
    //   Line 2: sum(taxes) = 10920 - 2176 = 8744
    //   amountTax = 4311 + 8744 = 13055
    //   amountTotal = 31865 + 13055 = 37920
    let base = await currency.round(priceUnit * options.quantity);

    // For the computation of move lines, we could have a negative base value.
    // In this case, compute all with positive values and negate them at the end.
    let sign = 1;
    if (await currency.isZero(base)) {
      sign = this._context['forceSign'] || 1;
    }
    else if (base < 0) {
      sign = -1;
    }
    if (base < 0) {
      base = -base;
    }

    // Store the totals to reach when using priceInclude taxes (only the last price included in row)
    const totalIncludedCheckpoints = {};
    let i = len(taxes) - 1;
    let storeIncludedTaxTotal = true;
    // Keep track of the accumulated included fixed/percent amount.
    let [inclFixedAmount, inclPercentAmount, inclDivisionAmount] = [0, 0, 0];
    // Store the tax amounts we compute while searching for the totalExcluded
    const cachedTaxAmounts = {};
    if (options.handlePriceInclude) {
      for (const tax of await taxes.reversed()) {
        const [refundRepartitionLineIds, invoiceRepartitionLineIds, amountType, includeBaseAmount, priceInclude, amount] = await tax('refundRepartitionLineIds', 'invoiceRepartitionLineIds', 'amountType', 'includeBaseAmount', 'priceInclude', 'amount');

        let taxRepartitionLines = await (
          options.isRefund && refundRepartitionLineIds.ok
            ? refundRepartitionLineIds
            : invoiceRepartitionLineIds
        ).filtered(async (x) => await x.repartitionType === "tax");
        const sumRepartitionFactor = sum(await taxRepartitionLines.mapped("factor"));

        if (includeBaseAmount) {
          base = recomputeBase(base, inclFixedAmount, inclPercentAmount, inclDivisionAmount);
          inclFixedAmount = inclPercentAmount = inclDivisionAmount = 0;
          storeIncludedTaxTotal = true;
        }
        if (priceInclude || this._context['forcePriceInclude']) {
          if (amountType === 'percent') {
            inclPercentAmount += amount * sumRepartitionFactor;
          }
          else if (amountType === 'division') {
            inclDivisionAmount += amount * sumRepartitionFactor;
          }
          else if (amountType === 'fixed') {
            inclFixedAmount += Math.abs(options.quantity) * amount * sumRepartitionFactor;
          }
          else {
            // tax.amountType == other (javascript)
            const taxAmount = await tax._computeAmount(base, sign * priceUnit, options.quantity, options.product, options.partner) * sumRepartitionFactor;
            inclFixedAmount += taxAmount;
            // Avoid unecessary re-computation
            cachedTaxAmounts[i] = taxAmount;
          }
          // In case of a zero tax, do not store the base amount since the tax amount will
          // be zero anyway. Group and Javascript taxes have an amount of zero, so do not take
          // them into account.
          if (storeIncludedTaxTotal && (
            amount || !["percent", "division", "fixed"].includes(amountType))
          ) {
            totalIncludedCheckpoints[i] = base;
            storeIncludedTaxTotal = false;
          }
        }
        i -= 1
      }
    }

    const totalExcluded = await currency.round(recomputeBase(base, inclFixedAmount, inclPercentAmount, inclDivisionAmount));

    // 4) Iterate the taxes in the sequence order to compute missing tax amounts.
    // Start the computation of accumulated amounts at the totalExcluded value.
    let totalIncluded, totalVoid;
    base = totalIncluded = totalVoid = totalExcluded;

    // Flag indicating the checkpoint used in priceInclude to avoid rounding issue must be skipped since the base
    // amount has changed because we are currently mixing price-included and price-excluded includeBaseAmount
    // taxes.
    let skipCheckpoint = false;

    // Get product tags, account.account.tag objects that need to be injected in all
    // the taxTagIds of all the move lines created by the compute all for this product.
    const productTagIds = bool(options.product) ? (await options.product['accountTagIds']).ids : [];

    const taxesVals = [];
    i = 0;
    let cumulatedTaxIncludedAmount = 0;
    for (const tax of taxes) {
      const [refundRepartitionLineIds, invoiceRepartitionLineIds, taxExigibility, includeBaseAmount, isBaseAffected] = await tax('refundRepartitionLineIds', 'invoiceRepartitionLineIds', 'taxExigibility', 'includeBaseAmount', 'isBaseAffected');
      const priceInclude = this._context['forcePriceInclude'] ?? await tax.priceInclude;
      let taxBaseAmount;
      if (priceInclude || isBaseAffected) {
        taxBaseAmount = base;
      }
      else {
        taxBaseAmount = totalExcluded;
      }

      const taxRepartitionLines = await (options.isRefund && refundRepartitionLineIds.ok ? refundRepartitionLineIds : invoiceRepartitionLineIds).filtered(async (x) => await x.repartitionType === 'tax');
      const sumRepartitionFactor = sum(await taxRepartitionLines.mapped('factor'));

      //compute the taxAmount
      let taxAmount;
      if (!skipCheckpoint && priceInclude && totalIncludedCheckpoints[i]) {
        // We know the total to reach for that tax, so we make a substraction to avoid any rounding issues
        taxAmount = totalIncludedCheckpoints[i] - (base + cumulatedTaxIncludedAmount);
        cumulatedTaxIncludedAmount = 0;
      }
      else {
        taxAmount = await (await tax.withContext({ forcePriceInclude: false }))._computeAmount(
          taxBaseAmount, sign * priceUnit, options.quantity, options.product, options.partner);
      }

      // Round the taxAmount multiplied by the computed repartition lines factor.
      taxAmount = floatRound(taxAmount, { precisionRounding: prec });
      const factorizedTaxAmount = floatRound(taxAmount * sumRepartitionFactor, { precisionRounding: prec });

      if (priceInclude && !totalIncludedCheckpoints[i]) {
        cumulatedTaxIncludedAmount += factorizedTaxAmount;
      }
      // If the tax affects the base of subsequent taxes, its tax move lines must
      // receive the base tags and tagIds of these taxes, so that the tax report computes
      // the right total
      let subsequentTaxes = this.env.items('account.tax');
      let subsequentTags = this.env.items('account.account.tag');
      if (includeBaseAmount) {
        subsequentTaxes = await taxes.slice(i + 1).filtered('isBaseAffected');

        let taxesForSubsequentTags = subsequentTaxes;

        if (!options.includeCabaTags) {
          taxesForSubsequentTags = await subsequentTaxes.filtered(async (x) => await x.taxExigibility !== 'onPayment');
        }
        subsequentTags = await taxesForSubsequentTags.getTaxTags(options.isRefund, 'base');
      }
      // Compute the tax line amounts by multiplying each factor with the tax amount.
      // Then, spread the tax rounding to ensure the consistency of each line independently with the factorized
      // amount. E.g:
      //
      // Suppose a tax having 4 x 50% repartition line applied on a tax amount of 0.03 with 2 decimal places.
      // The factorizedTaxAmount will be 0.06 (200% x 0.03). However, each line taken independently will compute
      // 50% * 0.03 = 0.01 with rounding. It means there is 0.06 - 0.04 = 0.02 as totalRoundingError to dispatch
      // in lines as 2 x 0.01.
      const repartitionLineAmounts = await taxRepartitionLines.map(async (line) => floatRound(taxAmount * await line.factor, { precisionRounding: prec }));
      const totalRoundingError = floatRound(factorizedTaxAmount - sum(repartitionLineAmounts), { precisionRounding: prec });
      let nberRoundingSteps = tools.parseInt(Math.abs(totalRoundingError / await currency.rounding));
      const roundingError = floatRound(nberRoundingSteps && totalRoundingError / nberRoundingSteps || 0.0, { precisionRounding: prec });

      for (let [repartitionLine, lineAmount] of _.zip<any, number>([...taxRepartitionLines], repartitionLineAmounts)) {

        if (nberRoundingSteps) {
          lineAmount += roundingError;
          nberRoundingSteps -= 1;
        }
        let repartitionLineTags;
        if (!options.includeCabaTags && taxExigibility === 'onPayment') {
          repartitionLineTags = this.env.items('account.account.tag');
        }
        else {
          repartitionLineTags = await repartitionLine.tagIds;
        }

        taxesVals.push({
          'id': tax.id,
          'label': bool(options.partner) && await tax.withContext({ lang: await options.partner.lang }).label || await tax.label,
          'amount': sign * lineAmount,
          'base': floatRound(sign * taxBaseAmount, { precisionRounding: prec }),
          'sequence': await tax.sequence,
          'accountId': taxExigibility === 'onPayment' ? (await tax.cashBasisTransitionAccountId).id : (await repartitionLine.accountId).id,
          'analytic': await tax.analytic,
          'priceInclude': priceInclude,
          'taxExigibility': taxExigibility,
          'taxRepartitionLineId': repartitionLine.id,
          'group': groupsMap.get(tax),
          'tagIds': repartitionLineTags.add(subsequentTags).ids.concat(productTagIds),
          'taxIds': subsequentTaxes.ids,
        })

        if (!(await repartitionLine.accountId).ok) {
          totalVoid += lineAmount;
        }
      }
      // Affect subsequent taxes
      if (includeBaseAmount) {
        base += factorizedTaxAmount;
        if (!priceInclude) {
          skipCheckpoint = true;
        }
      }

      totalIncluded += factorizedTaxAmount;
      i += 1;
    }

    let baseTaxesForTags = taxes;
    if (!options.includeCabaTags) {
      baseTaxesForTags = await baseTaxesForTags.filtered(async (x) => await x.taxExigibility !== 'onPayment');
    }

    const baseRepLines = await (await baseTaxesForTags.mapped(options.isRefund && 'refundRepartitionLineIds' || 'invoiceRepartitionLineIds')).filtered(async (x) => await x.repartitionType === 'base')

    return {
      'baseTags': (await baseRepLines.tagIds).ids.concat(productTagIds),
      'taxes': taxesVals,
      'totalExcluded': sign * totalExcluded,
      'totalIncluded': sign * await currency.round(totalIncluded),
      'totalVoid': sign * await currency.round(totalVoid),
    }
  }

  /**
   * Subtract tax amount from price when corresponding "price included" taxes do not apply
   * @param price 
   * @param prodTaxes 
   * @param lineTaxes 
   * @returns 
   */
  @api.model()
  async _fixTaxIncludedPrice(price, prodTaxes, lineTaxes) {
    // FIXME get currency in param?
    prodTaxes = prodTaxes._origin;
    lineTaxes = lineTaxes._origin;
    const inclTax = await prodTaxes.filtered(async (tax) => !lineTaxes.includes(tax) && await tax.priceInclude)
    if (bool(inclTax)) {
      return (await inclTax.computeAll(price))['totalExcluded'];
    }
    return price;
  }

  @api.model()
  async _fixTaxIncludedPriceCompany(price, prodTaxes, lineTaxes, companyId) {
    if (bool(companyId)) {
      //To keep the same behavior as in _computeTaxId
      prodTaxes = await prodTaxes.filtered(async (tax) => (await tax.companyId).eq(companyId));
      lineTaxes = await lineTaxes.filtered(async (tax) => (await tax.companyId).eq(companyId));
    }
    return this._fixTaxIncludedPrice(price, prodTaxes, lineTaxes);
  }
}

@MetaModel.define()
class AccountTaxRepartitionLine extends Model {
  static _module = module;
  static _name = "account.tax.repartition.line";
  static _description = "Tax Repartition Line";
  static _order = 'sequence, repartitionType, id';
  static _checkCompanyAuto = true;

  static factorPercent = Fields.Float({ string: "%", required: true, help: "Factor to apply on the account move lines generated from this distribution line, in percents" });
  static factor = Fields.Float({ string: "Factor Ratio", compute: "_computeFactor", help: "Factor to apply on the account move lines generated from this distribution line" });
  static repartitionType = Fields.Selection({ string: "Based On", selection: [['base', 'Base'], ['tax', 'of tax']], required: true, default: 'tax', help: "Base on which the factor will be applied." });

  static accountId = Fields.Many2one({
    string: "Account",
    comodelName: 'account.account',
    domain: "[['deprecated', '=', false], ['companyId', '=', companyId], ['internalType', 'not in', ['receivable', 'payable']]]",
    checkCompany: true,
    help: "Account on which to post the tax amount"
  });
  static tagIds = Fields.Many2many({ string: "Tax Grids", comodelName: 'account.account.tag', domain: [['applicability', '=', 'taxes']], copy: true });
  static invoiceTaxId = Fields.Many2one({
    comodelName: 'account.tax',
    ondelete: 'CASCADE',
    checkCompany: true,
    help: "The tax set to apply this distribution on invoices. Mutually exclusive with refundTaxId"
  });
  static refundTaxId = Fields.Many2one({
    comodelName: 'account.tax',
    ondelete: 'CASCADE',
    checkCompany: true,
    help: "The tax set to apply this distribution on refund invoices. Mutually exclusive with invoiceTaxId"
  });
  static taxId = Fields.Many2one({ comodelName: 'account.tax', compute: '_computeTaxId' });
  static companyId = Fields.Many2one({ string: "Company", comodelName: 'res.company', compute: "_computeCompany", store: true, help: "The company this distribution line belongs to." });
  static sequence = Fields.Integer({
    string: "Sequence", default: 1,
    help: "The order in which distribution lines are displayed and matched. For refunds to work properly, invoice distribution lines should be arranged in the same order as the credit note distribution lines they correspond to."
  });
  static useInTaxClosing = Fields.Boolean({ string: "Tax Closing Entry", default: true });

  @api.onchange('accountId', 'repartitionType')
  async _onchangeAccountId() {
    const accountId = await this['accountId'];
    if (!accountId.ok || await this['repartitionType'] === 'base') {
      await this.set('useInTaxClosing', false);
    }
    else {
      await this.set('useInTaxClosing', !['income', 'expense'].includes(await accountId.internalGroup));
    }
  }

  @api.constrains('invoiceTaxId', 'refundTaxId')
  async validateTaxTemplateLink() {
    for (const record of this) {
      if ((await record.invoiceTaxId).ok && (await record.refundTaxId).ok) {
        throw new ValidationError(await this._t("Tax distribution lines should apply to either invoices or refunds, not both at the same time. invoiceTaxId and refundTaxId should not be set together."));
      }
    }
  }

  @api.constrains('invoiceTaxId', 'refundTaxId', 'tagIds')
  async validateTagsCountry() {
    for (const record of this) {
      const [taxId, tagIds] = await record('taxId', 'tagIds');
      const countryId = await tagIds.countryId;
      if (countryId.ok && !(await taxId.countryId).eq(countryId)) {
        throw new ValidationError(await this._t("A tax should only use tags from its country. You should use another tax and a fiscal position if you wish to uses the tags from foreign tax reports."));
      }
    }
  }

  @api.depends('factorPercent')
  async _computeFactor() {
    for (const record of this) {
      await record.set('factor', await record.factorPercent / 100.0);
    }
  }

  @api.depends('invoiceTaxId.companyId', 'refundTaxId.companyId')
  async _computeCompany() {
    for (const record of this) {
      const [invoiceTaxId, refundTaxId] = await record('invoiceTaxId', 'refundTaxId');
      let companyId = invoiceTaxId.ok && (await invoiceTaxId.companyId).id;
      await record.set('companyId', bool(companyId) ? companyId  : (await refundTaxId.companyId).id);
    }
  }

  @api.depends('invoiceTaxId', 'refundTaxId')
  async _computeTaxId() {
    for (const record of this) {
      const [invoiceTaxId, refundTaxId] = await record('invoiceTaxId', 'refundTaxId');
      await record.set('taxId', invoiceTaxId.ok ? invoiceTaxId : refundTaxId);
    }
  }

  @api.onchange('repartitionType')
  async _onchangeRepartitionType() {
    if (await this['repartitionType'] === 'base') {
      await this.set('accountId', null);
    }
  }
}
