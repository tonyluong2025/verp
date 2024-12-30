import _ from "lodash";
import { api } from "../../../core";
import { hasattr, setdefault } from "../../../core/api/func";
import { Command, Fields, _Date } from "../../../core/fields";
import { Dict } from "../../../core/helper/collections";
import { NotImplementedError, UserError, ValidationError } from "../../../core/helper/errors";
import { MetaModel, Model, _super } from "../../../core/models";
import { expression } from "../../../core/osv";
import { bool, formatDate, formatLang, pop, update } from "../../../core/tools";
import { literalEval } from "../../../core/tools/ast";
import { dateMax } from "../../../core/tools/date_utils";
import { enumerate, extend, len, next, someAsync, sum } from "../../../core/tools/iterable";
import { _convert$, _f, f } from "../../../core/tools/utils";
import { escapeHtml } from "../../../core/tools/xml";
import { MAX_HASH_VERSION } from "./account_move";

//forbidden fields
export const INTEGRITY_HASH_LINE_FIELDS = ['debit', 'credit', 'accountId', 'partnerId'];

@MetaModel.define()
class AccountMoveLine extends Model {
  static _module = module;
  static _name = 'account.move.line';
  static _description = 'Journal Item';
  static _order = 'date desc, moveName desc, id';
  static _checkCompanyAuto = true;

  // ==== Business fields ====
  static moveId = Fields.Many2one('account.move', { string: 'Journal Entry', index: true, required: true, readonly: true, autojoin: true, ondelete: 'CASCADE', checkCompany: true, help: "The move of this entry line." });
  static moveName = Fields.Char({ string: 'Number', related: 'moveId.label', store: true, index: true });
  static date = Fields.Date({ related: 'moveId.date', store: true, readonly: true, index: true, copy: false, groupOperator: 'min' });
  static ref = Fields.Char({ related: 'moveId.ref', store: true, copy: false, index: true, readonly: false });
  static parentState = Fields.Selection({ related: 'moveId.state', store: true, readonly: true });
  static journalId = Fields.Many2one({ related: 'moveId.journalId', store: true, index: true, copy: false });
  static companyId = Fields.Many2one({ related: 'moveId.companyId', store: true, readonly: true });
  static companyCurrencyId = Fields.Many2one({ related: 'companyId.currencyId', string: 'Company Currency', readonly: true, store: true, help: 'Utility field to express amount currency' });
  static accountId = Fields.Many2one('account.account', { string: 'Account', index: true, ondelete: 'CASCADE', domain: "[['deprecated', '=', false], ['companyId', '=', 'companyId'], ['isOffBalance', '=', false]]", checkCompany: true, tracking: true });
  static accountInternalType = Fields.Selection({ related: 'accountId.userTypeId.type', string: "Internal Type", readonly: true });
  static accountInternalGroup = Fields.Selection({ related: 'accountId.userTypeId.internalGroup', string: "Internal Group", readonly: true });
  static accountRootId = Fields.Many2one({ related: 'accountId.rootId', string: "Account Root", store: true, readonly: true });
  static sequence = Fields.Integer({ default: 10 });
  static label = Fields.Char({ string: 'Label', tracking: true });
  static quantity = Fields.Float({ string: 'Quantity', default: 1.0, digits: 'Product Unit of Measure', help: "The optional quantity expressed by this line, eg: number of product sold. The quantity is not a legal requirement but is very useful for some reports." });
  static priceUnit = Fields.Float({ string: 'Unit Price', digits: 'Product Price' });
  static discount = Fields.Float({ string: 'Discount (%)', digits: 'Discount', default: 0.0 });
  static debit = Fields.Monetary({ string: 'Debit', default: 0.0, currencyField: 'companyCurrencyId' });
  static credit = Fields.Monetary({ string: 'Credit', default: 0.0, currencyField: 'companyCurrencyId' });
  static balance = Fields.Monetary({ string: 'Balance', store: true, currencyField: 'companyCurrencyId', compute: '_computeBalance', help: "Technical field holding the debit - credit in order to open meaningful graph views from reports" });
  static cumulatedBalance = Fields.Monetary({ string: 'Cumulated Balance', store: false, currencyField: 'companyCurrencyId', compute: '_computeCumulatedBalance', help: "Cumulated balance depending on the domain and the order chosen in the view." });
  static amountCurrency = Fields.Monetary({ string: 'Amount in Currency', store: true, copy: true, help: "The amount expressed in an optional other currency if it is a multi-currency entry." });
  static priceSubtotal = Fields.Monetary({ string: 'Subtotal', store: true, readonly: true, currencyField: 'currencyId' });
  static priceTotal = Fields.Monetary({ string: 'Total', store: true, readonly: true, currencyField: 'currencyId' });
  static reconciled = Fields.Boolean({ compute: '_computeAmountResidual', store: true });
  static blocked = Fields.Boolean({ string: 'No Follow-up', default: false, help: "You can check this box to mark this journal item as a litigation with the associated partner" });
  static dateMaturity = Fields.Date({ string: 'Due Date', index: true, tracking: true, help: "This field is used for payable and receivable journal entries. You can put the limit date for the payment of this line." });
  static currencyId = Fields.Many2one('res.currency', { string: 'Currency', required: true });
  static partnerId = Fields.Many2one('res.partner', { string: 'Partner', ondelete: 'RESTRICT' });
  static productUomId = Fields.Many2one('uom.uom', { string: 'Unit of Measure', domain: "[['categoryId', '=', productUomCategoryId]]", ondelete: "RESTRICT" });
  static productId = Fields.Many2one('product.product', { string: 'Product', ondelete: 'RESTRICT' });
  static productUomCategoryId = Fields.Many2one('uom.category', { related: 'productId.uomId.categoryId' });

  // ==== Origin fields ====
  static reconcileModelId = Fields.Many2one('account.reconcile.model', { string: "Reconciliation Model", copy: false, readonly: true, checkCompany: true });
  static paymentId = Fields.Many2one('account.payment', { index: true, store: true, string: "Originator Payment", related: 'moveId.paymentId', help: "The payment that created this entry" });
  static statementLineId = Fields.Many2one('account.bank.statement.line', { index: true, store: true, string: "Originator Statement Line", related: 'moveId.statementLineId', help: "The statement line that created this entry" });
  static statementId = Fields.Many2one({ related: 'statementLineId.statementId', store: true, index: true, copy: false, help: "The bank statement used for bank reconciliation" });

  // ==== Tax fields ====
  static taxIds = Fields.Many2many({ comodelName: 'account.tax', string: "Taxes", context: { 'activeTest': false }, checkCompany: true, help: "Taxes that apply on the base amount" });
  static groupTaxId = Fields.Many2one({ comodelName: 'account.tax', string: "Originator Group of Taxes", index: true, help: "The group of taxes generator of this tax line" });
  static taxLineId = Fields.Many2one('account.tax', { string: 'Originator Tax', ondelete: 'RESTRICT', store: true, compute: '_computeTaxLineId', help: "Indicates that this journal item is a tax line" });
  static taxGroupId = Fields.Many2one({ related: 'taxLineId.taxGroupId', string: 'Originator tax group', readonly: true, store: true, help: 'technical field for widget tax-group-custom-field' });
  static taxBaseAmount = Fields.Monetary({ string: "Base Amount", store: true, readonly: true, currencyField: 'companyCurrencyId' });
  static taxRepartitionLineId = Fields.Many2one({ comodelName: 'account.tax.repartition.line', string: "Originator Tax Distribution Line", ondelete: 'RESTRICT', readonly: true, checkCompany: true, help: "Tax distribution line that caused the creation of this move line, if any" });
  static taxTagIds = Fields.Many2many({ string: "Tags", comodelName: 'account.account.tag', ondelete: 'RESTRICT', help: "Tags assigned to this line by the tax creating it, if any. It determines its impact on financial reports.", tracking: true });
  static taxAudit = Fields.Char({ string: "Tax Audit String", compute: "_computeTaxAudit", store: true, help: "Computed field, listing the tax grids impacted by this line, and the amount it applies to each of them." });
  static taxTagInvert = Fields.Boolean({ string: "Invert Tags", compute: '_computeTaxTagInvert', store: true, readonly: false, help: "Technical field. true if the balance of this move line needs to be inverted when computing its total for each tag (for sales invoices, for example)." });

  // ==== Reconciliation fields ====
  static amountResidual = Fields.Monetary({ string: 'Residual Amount', store: true, currencyField: 'companyCurrencyId', compute: '_computeAmountResidual', help: "The residual amount on a journal item expressed in the company currency." });
  static amountResidualCurrency = Fields.Monetary({ string: 'Residual Amount in Currency', store: true, compute: '_computeAmountResidual', help: "The residual amount on a journal item expressed in its currency (possibly not the company currency)." });
  static fullReconcileId = Fields.Many2one('account.full.reconcile', { string: "Matching", copy: false, index: true, readonly: true });
  static matchedDebitIds = Fields.One2many('account.partial.reconcile', 'creditMoveId', { string: 'Matched Debits', help: 'Debit journal items that are matched with this journal item.', readonly: true });
  static matchedCreditIds = Fields.One2many('account.partial.reconcile', 'debitMoveId', { string: 'Matched Credits', help: 'Credit journal items that are matched with this journal item.', readonly: true });
  static matchingNumber = Fields.Char({ string: "Matching #", compute: '_computeMatchingNumber', store: true, help: "Matching number for this line, 'P' if it is only partially reconcile, or the name of the full reconcile if it exists." });

  // ==== Analytic fields ====
  static analyticLineIds = Fields.One2many('account.analytic.line', 'moveId', { string: 'Analytic lines' });
  static analyticAccountId = Fields.Many2one('account.analytic.account', { string: 'Analytic Account', index: true, compute: "_computeAnalyticAccountId", store: true, readonly: false, checkCompany: true, copy: true });
  static analyticTagIds = Fields.Many2many('account.analytic.tag', { string: 'Analytic Tags', compute: "_computeAnalyticAccountId", store: true, readonly: false, checkCompany: true, copy: true });

  // ==== Onchange / display purpose fields ====
  static recomputeTaxLine = Fields.Boolean({ store: false, readonly: true, help: "Technical field used to know on which lines the taxes must be recomputed." });
  static displayType = Fields.Selection([
    ['lineSection', 'Section'],
    ['lineNote', 'Note'],
  ], { default: false, help: "Technical field for UX purpose." });
  static isRoundingLine = Fields.Boolean({ help: "Technical field used to retrieve the cash rounding line." });
  static excludeFromInvoiceTab = Fields.Boolean({ help: "Technical field used to exclude some lines from the invoiceLineIds tab in the form view." });

  static _sqlConstraints = [
    [
      'check_credit_debit',
      'CHECK(credit + debit>=0 AND credit * debit=0)',
      'Wrong credit or debit value in accounting entry !'
    ],
    [
      'check_accountable_required_fields',
      `CHECK(COALESCE("displayType" IN ('lineSection', 'lineNote'), 'f') OR "accountId" IS NOT NULL)`,
      "Missing required account on accountable invoice line."
    ],
    [
      'check_non_accountable_fields_null',
      `CHECK("displayType" NOT IN ('lineSection', 'lineNote') OR ("amountCurrency" = 0 AND debit = 0 AND credit = 0 AND "accountId" IS NULL))`,
      "Forbidden unit price, account and quantity on non-accountable invoice line"
    ],
    [
      'check_amount_currency_balance_sign',
      `CHECK(
        (
            ("currencyId" != "companyCurrencyId")
            AND
            (
                (debit - credit <= 0 AND "amountCurrency" <= 0)
                OR
                (debit - credit >= 0 AND "amountCurrency" >= 0)
            )
        )
        OR
        (
            ("currencyId" = "companyCurrencyId")
            AND
            ROUND(debit - credit - "amountCurrency", 2) = 0
        )
      )`,
      `The amount expressed in the secondary currency must be positive when account is debited and negative when account is credited. If the currency is the same as the one from the company, this amount must strictly be equal to the balance.`
    ],
  ]

  // HELPERS

  /**
   * Helper to construct a default label to set on journal items.
 
      E.g. Vendor Reimbursement $ 1,555.00 - Azure Interior - 05/14/2020.
 
      :param document:    A string representing the type of the document.
      :param amount:      The document's amount.
      :param currency:    The document's currency.
      :param date:        The document's date.
      :param partner:     The optional partner.
      :return:            A string.
   * @param document 
   * @param amount 
   * @param currency 
   * @param date 
   * @param partner 
   * @returns 
   */
  @api.model()
  async _getDefaultLineName(document, amount, currency, date, partner?: any) {
    const values: any[] = [f('%s %s', document, await formatLang(this.env, amount, { currencyObj: currency }))];
    if (bool(partner)) {
      values.push(await partner.displayName);
    }
    values.push(await formatDate(this.env, _Date.toString(date)));
    return values.join(' - ');
  }

  @api.model()
  async _getDefaultTaxAccount(repartitionLine) {
    let tax = await repartitionLine.invoiceTaxId;
    tax = tax.ok ? tax : await repartitionLine.refundTaxId;
    if (await tax.taxExigibility === 'onPayment') {
      return tax.cashBasisTransitionAccountId;
    }
    else {
      return repartitionLine.accountId;
    }
    // return account
  }

  _getIntegrityHashFields() {
    // Use the new hash version by default, but keep the old one for backward compatibility when generating the integrity report.
    const hashVersion = this._context['hashVersion'] ?? MAX_HASH_VERSION;
    if (hashVersion == 1) {
        return ['debit', 'credit', 'accountId', 'partnerId'];
    }
    else if (hashVersion == MAX_HASH_VERSION) {
        return ['label', 'debit', 'credit', 'accountId', 'partnerId'];
    }
    throw new NotImplementedError(`hashVersion=${hashVersion} doesn't exist`);
  }

  async _getComputedName() {
    this.ensureOne();
    const productId = await this['productId'];
    if (!productId.ok) {
      return '';
    }

    const partner = await this['partnerId'];
    let product;
    if (await partner.lang) {
      product = await productId.withContext({ lang: await partner.lang });
    }
    else {
      product = productId;
    }

    const values = [];
    const [partnerRef, descriptionSale, descriptionPurchase] = await product('partnerRef', 'descriptionSale', 'descriptionPurchase');
    if (partnerRef) {
      values.push(partnerRef);
    }
    const journal = await this['journalId'];
    if (await journal.type === 'sale') {
      if (descriptionSale) {
        values.push(descriptionSale);
      }
    }
    else if (await journal.type === 'purchase') {
      if (descriptionPurchase) {
        values.push(descriptionPurchase);
      }
    }
    return values.join('\n');
  }

  /**
   * Helper to get the default price unit based on the product by taking care of the taxes
      set on the product and the fiscal position.
      :return: The price unit.
   * @returns 
   */
  async _getComputedPriceUnit() {
    this.ensureOne();

    const productId = await this['productId'];
    if (!productId.ok) {
      return 0.0;
    }
    const moveId = await this['moveId'];

    const [company, currency, fiscalPosition, date, moveType] = await moveId('companyId', 'currencyId', 'fiscalPositionId', 'date', 'moveType');
    const companyCurrency = await company.currencyId;
    const productUom = await productId.uomId;
    const isRefundDocument = ['outRefund', 'inRefund'].includes(moveType);
    const moveDate = date || await _Date.contextToday(this);

    let productPriceUnit, productTaxes;
    if (await moveId.isSaleDocument(true)) {
      [productPriceUnit, productTaxes] = await productId('lstPrice', 'taxesId');
    }
    else if (await moveId.isPurchaseDocument(true)) {
      [productPriceUnit, productTaxes] = await productId('standardPrice', 'supplierTaxesId');
    }
    else {
      return 0.0;
    }
    productTaxes = await productTaxes.filtered(async (tax) => (await tax.companyId).eq(company));

    // Apply unit of measure.
    const [productUomId, partnerId] = await this('productUomId', 'partnerId');
    if (productUomId.ok && !productUomId.eq(productUom)) {
      productPriceUnit = await productUom._computePrice(productPriceUnit, productUomId);
    }

    // Apply fiscal position.
    if (productTaxes.ok && fiscalPosition.ok) {
      const productTaxesAfterFp = await fiscalPosition.mapTax(productTaxes);

      if (_.difference(productTaxes.ids, productTaxesAfterFp.ids).length) {
        const flattenedTaxesBeforeFp = await productTaxes._origin.flattenTaxesHierarchy();
        if (await flattenedTaxesBeforeFp.some(tax => tax.priceInclude)) {
          const taxesRes = await flattenedTaxesBeforeFp.computeAll(productPriceUnit, {
            quantity: 1.0,
            currency: companyCurrency,
            product: productId,
            partner: partnerId,
            isRefund: isRefundDocument,
          });
          productPriceUnit = await companyCurrency.round(taxesRes['totalExcluded']);
        }

        const flattenedTaxesAfterFp = await productTaxesAfterFp._origin.flattenTaxesHierarchy();
        if (await flattenedTaxesAfterFp.some(tax => tax.priceInclude)) {
          const taxesRes = await flattenedTaxesAfterFp.computeAll(productPriceUnit, {
            quantity: 1.0,
            currency: companyCurrency,
            product: productId,
            partner: partnerId,
            isRefund: isRefundDocument,
            handlePriceInclude: false,
          });
          for (const taxRes of taxesRes['taxes']) {
            const tax = this.env.items('account.tax').browse(taxRes['id']);
            if (await tax.priceInclude) {
              productPriceUnit += taxRes['amount'];
            }
          }
        }
      }
    }

    // Apply currency rate.
    if (bool(currency) && !currency.eq(companyCurrency)) {
      productPriceUnit = await companyCurrency._convert(productPriceUnit, currency, company, moveDate);
    }

    return productPriceUnit;
  }

  async _getComputedAccount() {
    this.ensureOne();
    const self = await this.withCompany(await (await (await this['moveId']).journalId).companyId);

    const productId = await self.productId;
    if (!productId.ok) {
      return;
    }
    const [accountId, moveId] = await self('accountId', 'moveId');

    const fiscalPosition = await moveId.fiscalPositionId;
    const accounts = await (await productId.productTemplateId).getProductAccounts(fiscalPosition);
    if (await moveId.isSaleDocument(true)) {
      // Out invoice.
      return bool(accounts['income']) ? accounts['income'] : accountId;
    }
    else if (await moveId.isPurchaseDocument(true)) {
      // In invoice.
      return bool(accounts['expense']) ? accounts['expense'] : accountId;
    }
  }

  async _getComputedTaxes() {
    this.ensureOne();
    const [moveId, productId, accountId] = await this('moveId', 'productId', 'accountId');
    const mcompanyId = await moveId.companyId;
    let taxIds;
    if (await moveId.isSaleDocument(true)) {
      // Out invoice.
      let [ptaxIds, ataxIds] = [await productId.taxesId, await accountId.taxIds];
      if (ptaxIds.ok) {
        taxIds = await ptaxIds.filtered(async (tax) => (await tax.companyId).eq(mcompanyId));
      }
      else if (ataxIds.ok) {
        taxIds = ataxIds;
      }
      else {
        taxIds = this.env.items('account.tax');
      }
      if (!taxIds.ok && ! await this['excludeFromInvoiceTab']) {
        taxIds = await mcompanyId.accountSaleTaxId;
      }
    }
    else if (await moveId.isPurchaseDocument(true)) {
      // In invoice.
      const psupplierTaxesId = await productId.supplierTaxesId;
      let ataxIds = await accountId.taxIds;
      if (psupplierTaxesId.ok) {
        taxIds = await psupplierTaxesId.filtered(async (tax) => (await tax.companyId).eq(mcompanyId));
      }
      else if (ataxIds.ok) {
        taxIds = ataxIds;
      }
      else {
        taxIds = this.env.items('account.tax');
      }
      if (!taxIds.ok && ! await this['excludeFromInvoiceTab']) {
        taxIds = await mcompanyId.accountPurchaseTaxId;
      }
    }
    else {
      // Miscellaneous operation.
      taxIds = await accountId.taxIds;
    }

    const companyId = await this['companyId'];
    if (companyId.ok && taxIds.ok) {
      taxIds = await taxIds.filtered(async (tax) => (await tax.companyId).eq(companyId));
    }
    return taxIds;
  }

  async _getComputedUom() {
    this.ensureOne();
    const productId = await this['productId'];
    if (productId.ok) {
      return productId.uomId;
    }
    return false;
  }

  async _setPriceAndTaxAfterFpos() {
    this.ensureOne();
    // Manage the fiscal position after that and adapt the priceUnit.
    // E.g. mapping a price-included-tax to a price-excluded-tax must
    // remove the tax amount from the priceUnit.
    // However, mapping a price-included tax to another price-included tax must preserve the balance but
    // adapt the priceUnit to the new tax.
    // E.g. mapping a 10% price-included tax to a 20% price-included tax for a priceUnit of 110 should preserve
    // 100 as balance but set 120 as priceUnit.
    const [taxIds, moveId] = await this('taxIds', 'moveId');
    const fiscalPositionId = await moveId.fiscalPositionId;
    if (taxIds.ok && fiscalPositionId.ok && (await fiscalPositionId.taxIds).ok) {
      const priceSubtotal = (await this._getPriceTotalAndSubtotal())['priceSubtotal'];
      await this.set('taxIds', await fiscalPositionId.mapTax(taxIds._origin));
      const accountingVals = await this._getFieldsOnchangeSubtotal({
        priceSubtotal,
        currency: await moveId.companyCurrencyId
      });
      const amountCurrency = accountingVals['amountCurrency'];
      const businessVals = await this._getFieldsOnchangeBalance({ amountCurrency });
      if ('priceUnit' in businessVals) {
        await this.set('priceUnit', businessVals['priceUnit']);
      }
    }
  }

  @api.depends('productId', 'accountId', 'partnerId', 'date')
  async _computeAnalyticAccountId() {
    for (const record of this) {
      const [move, excludeFromInvoiceTab] = await record('moveId', 'excludeFromInvoiceTab');
      if (! excludeFromInvoiceTab || ! await move.isInvoice(true)) {
        const [product, partner, account, date] = await record('productId', 'partnerId', 'accountId', 'date');
        const commercialPartner = await partner.commercialPartnerId;
        const rec = await this.env.items('account.analytic.default').accountGet({
          productId: product.id,
          partnerId: bool(commercialPartner.id) ? commercialPartner.id : (await (await move.partnerId).commercialPartnerId).id,
          accountId: account.id,
          userId: record.env.uid,
          date: date,
          companyId: (await move.companyId).id
        });
        if (bool(rec)) {
          // await Promise.all([
            await record.set('analyticAccountId', await rec.analyticId),
            await record.set('analyticTagIds', await rec.analyticTagIds)
          // ]);
        }
      }
    }
  }

  @api.depends('productId', 'accountId', 'partnerId', 'date')
  async _computeAnalyticTagIds() {
    for (const record of this) {
      const [move, excludeFromInvoiceTab] = await record('moveId', 'excludeFromInvoiceTab');
      if (!excludeFromInvoiceTab || ! await move.isInvoice(true)) {
        const [product, partner, account, date] = await record('productId', 'partnerId', 'accountId', 'date'); 
        const commercialPartner = await partner.commercialPartnerId;
        const rec = await this.env.items('account.analytic.default').accountGet({
          productId: product.id,
          partnerId: bool(commercialPartner.id) ? commercialPartner.id : (await (await move.partnerId).commercialPartnerId).id,
          accountId: account.id,
          userId: record.env.uid,
          date: date,
          companyId: (await move.companyId).id
        });
        if (bool(rec)) {
          await record.set('analyticTagIds', await rec.analyticTagIds);
        }
      }
    }
  }

  @api.depends('moveId.paymentReference')
  async _computeName() {
    for (const line of await this.filtered(async (l) => !l.label && ['receivable', 'payable'].includes(await (await (await l.accountId).userTypeId).type))) {
      await line.set('label', await (await line.moveId).paymentReference);
    }
  }

  async _getPriceTotalAndSubtotal(priceUnit?: any, quantity?: any, discount?: any, currency?: any, product?: any, partner?: any, taxes?: any, moveType?: any) {
    this.ensureOne();
    return this._getPriceTotalAndSubtotalModel(
      priceUnit || await this['priceUnit'],
      quantity || await this['quantity'],
      discount || await this['discount'],
      currency || await this['currencyId'],
      product || await this['productId'],
      partner || await this['partnerId'],
      taxes || await this['taxIds'],
      moveType || await (await this['moveId']).moveType,
    );
  }

  /**
   * This method is used to compute 'priceTotal' & 'priceSubtotal'.
 
      :param priceUnit:  The current price unit.
      :param quantity:    The current quantity.
      :param discount:    The current discount.
      :param currency:    The line's currency.
      :param product:     The line's product.
      :param partner:     The line's partner.
      :param taxes:       The applied taxes.
      :param moveType:   The type of the move.
      :return:            A dictionary containing 'priceSubtotal' & 'priceTotal'.
   * @param priceUnit 
   * @param quantity 
   * @param discount 
   * @param currency 
   * @param product 
   * @param partner 
   * @param taxes 
   * @param moveType 
   */
  @api.model()
  async _getPriceTotalAndSubtotalModel(priceUnit, quantity, discount, currency, product, partner, taxes, moveType) {
    let res = {};

    // Compute 'priceSubtotal'.
    const lineDiscountPriceUnit = priceUnit * (1 - (discount / 100.0));
    const subtotal = quantity * lineDiscountPriceUnit;

    // Compute 'priceTotal'.
    if (taxes) {
      const forceSign = ['outInvoice', 'inRefund', 'outReceipt'].includes(moveType) ? -1 : 1;
      const taxesRes = await (await taxes._origin.withContext({ forceSign: forceSign })).computeAll(lineDiscountPriceUnit, { quantity: quantity, currency: currency, product: product, partner: partner, isRefund: ['outRefund', 'inRefund'].includes(moveType) });
      res['priceSubtotal'] = taxesRes['totalExcluded'];
      res['priceTotal'] = taxesRes['totalIncluded'];
    }
    else {
      res['priceTotal'] = res['priceSubtotal'] = subtotal;
    }
    //In case of multi currency, round before it's use for computing debit credit
    if (bool(currency)) {
      res = Object.fromEntries(await Promise.all(Object.entries(res).map(async ([k, v]) => [k, await currency.round(v)])));
    }
    return res;
  }

  async _getFieldsOnchangeSubtotal(opts: { priceSubtotal?: any, moveType?: any, currency?: any, company?: any, date?: any } = {}) {
    this.ensureOne();
    const [priceSubtotal, moveId, currencyId] = await this('priceSubtotal', 'moveId', 'currencyId')
    return this._getFieldsOnchangeSubtotalModel(
      opts.priceSubtotal == null ? priceSubtotal : opts.priceSubtotal,
      opts.moveType == null ? await moveId.moveType : opts.moveType,
      opts.currency == null ? currencyId : opts.currency,
      opts.company == null ? await moveId.companyId : opts.company,
      opts.date == null ? await moveId.date : opts.date,
    )
  }

  /**
   * This method is used to recompute the values of 'amount_currency', 'debit', 'credit' due to a change made
      in some business fields (affecting the 'priceSubtotal' field).
 
      :param priceSubtotal:  The untaxed amount.
      :param moveType:       The type of the move.
      :param currency:        The line's currency.
      :param company:         The move's company.
      :param date:            The move's date.
      :return:                A dictionary containing 'debit', 'credit', 'amount_currency'.
   * @param priceSubtotal 
   * @param moveType 
   * @param currency 
   * @param company 
   * @param date 
   */
  @api.model()
  async _getFieldsOnchangeSubtotalModel(priceSubtotal, moveType, currency, company, date) {
    const moveId = await this['moveId'];
    let sign;
    if (moveId.getOutboundTypes().includes(moveType)) {
      sign = 1;
    }
    else if (moveId.getInboundTypes().includes(moveType)) {
      sign = -1;
    }
    else {
      sign = 1;
    }

    const amountCurrency = priceSubtotal * sign;
    const balance = await currency._convert(amountCurrency, await company.currencyId, company, date || await _Date.contextToday(this));
    return {
      'amountCurrency': amountCurrency,
      'currencyId': currency.id,
      'debit': balance > 0.0 && balance || 0.0,
      'credit': balance < 0.0 && -balance || 0.0,
    }
  }

  async _getFieldsOnchangeBalance(options: { quantity?: any, discount?: any, amountCurrency?: any, moveType?: any, currency?: any, taxes?: any, priceSubtotal?: any, forceComputation?: boolean } = {}) {
    this.ensureOne();
    const [moveId, currencyId] = await this('moveId', 'currencyId');
    return this._getFieldsOnchangeBalanceModel(
      options.quantity || await this['quantity'],
      options.discount || await this['discount'],
      options.amountCurrency || await this['amountCurrency'],
      options.moveType || await moveId.moveType,
      options.currency || currencyId.ok ? currencyId : await moveId.currencyId,
      options.taxes || await this['taxIds'],
      options.priceSubtotal || await this['priceSubtotal'],
      options.forceComputation,
    )
  }

  /**
   * This method is used to recompute the values of 'quantity', 'discount', 'priceUnit' due to a change made
      in some accounting fields such as 'balance'.
 
      This method is a bit complex as we need to handle some special cases.
      For example, setting a positive balance with a 100% discount.
 
      :param quantity:        The current quantity.
      :param discount:        The current discount.
      :param amount_currency: The new balance in line's currency.
      :param moveType:       The type of the move.
      :param currency:        The currency.
      :param taxes:           The applied taxes.
      :param priceSubtotal:  The priceSubtotal.
      :return:                A dictionary containing 'quantity', 'discount', 'priceUnit'.
   * @param quantity 
   * @param discount 
   * @param amountCurrency 
   * @param moveType 
   * @param currency 
   * @param taxes 
   * @param priceSubtotal 
   * @param forceComputation 
   */
  @api.model()
  async _getFieldsOnchangeBalanceModel(quantity, discount, amountCurrency, moveType, currency, taxes, priceSubtotal, forceComputation = false) {
    const moveId = await this['moveId'];
    let sign;
    if (moveId.getOutboundTypes().includes(moveType)) {
      sign = 1;
    }
    else if (moveId.getInboundTypes().includes(moveType)) {
      sign = -1;
    }
    else {
      sign = 1;
    }
    amountCurrency *= sign;

    // Avoid rounding issue when dealing with price included taxes. For example, when the priceUnit is 2300.0 and
    // a 5.5% price included tax is applied on it, a balance of 2300.0 / 1.055 = 2180.094 ~ 2180.09 is computed.
    // However, when triggering the inverse, 2180.09 + (2180.09 * 0.055) = 2180.09 + 119.90 = 2299.99 is computed.
    // To avoid that, set the priceSubtotal at the balance if the difference between them looks like a rounding
    // issue.
    if (!forceComputation && await currency.isZero(amountCurrency - priceSubtotal)) {
      return {};
    }

    taxes = await taxes.flattenTaxesHierarchy();
    if (bool(taxes) && await taxes.some(tax => tax.priceInclude)) {
      // Inverse taxes. E.g:
      //
      // Price Unit    | Taxes         | Originator Tax    |Price Subtotal     | Price Total
      // -----------------------------------------------------------------------------------
      // 110           | 10% incl, 5%  |                   | 100               | 115
      // 10            |               | 10% incl          | 10                | 10
      // 5             |               | 5%                | 5                 | 5
      //
      // When setting the balance to -200, the expected result is:
      //
      // Price Unit    | Taxes         | Originator Tax    |Price Subtotal     | Price Total
      // -----------------------------------------------------------------------------------
      // 220           | 10% incl, 5%  |                   | 200               | 230
      // 20            |               | 10% incl          | 20                | 20
      // 10            |               | 5%                | 10                | 10
      const forceSign = ['outInvoice', 'inRefund', 'outReceipt'].includes(moveType) ? -1 : 1;
      const taxesRes = await (await taxes._origin.withContext({ forceSign })).computeAll(amountCurrency, { currency: currency, handlePriceInclude: false });
      for (const taxRes of taxesRes['taxes']) {
        const tax = this.env.items('account.tax').browse(taxRes['id']);
        if (await tax.priceInclude) {
          amountCurrency += taxRes['amount'];
        }
      }
    }

    let vals;
    const discountFactor = 1 - (discount / 100.0);
    if (amountCurrency && discountFactor) {
      // discount != 100%
      vals = {
        'quantity': quantity || 1.0,
        'priceUnit': amountCurrency / discountFactor / (quantity || 1.0),
      }
    }
    else if (amountCurrency && !discountFactor) {
      // discount == 100%
      vals = {
        'quantity': quantity || 1.0,
        'discount': 0.0,
        'priceUnit': amountCurrency / (quantity || 1.0),
      }
    }
    else if (!discountFactor) {
      // balance of line is 0, but discount  == 100% so we display the normal unit_price
      vals = {}
    }
    else {
      // balance is 0, so unit price is 0 as well
      vals = { 'priceUnit': 0.0 };
    }
    return vals;
  }

  /**
   * Returns a domain to be used to identify the move lines that are allowed
              to be taken into account in the tax report.
   * @returns 
   */
  @api.model()
  _getTaxExigibleDomain() {
    return [
      // Lines on moves without any payable or receivable line are always exigible
      '|', ['moveId.alwaysTaxExigible', '=', true],

      // Lines with only tags are always exigible
      '|', '&', ['taxLineId', '=', false], ['taxIds', '=', false],

      // Lines from CABA entries are always exigible
      '|', ['moveId.taxCashBasisRecId', '!=', false],

      // Lines from non-CABA taxes are always exigible
      '|', ['taxLineId.taxExigibility', '!=', 'onPayment'],
      ['taxIds.taxExigibility', '!=', 'onPayment'], // So: exigible if at least one tax from taxIds isn't on_payment
    ]
  }

  /**
   * Tells whether or not this move line corresponds to a refund operation.
   * @returns 
   */
  async belongsToRefund() {
    this.ensureOne();
    const [taxRepartitionLineId, moveId, taxIds] = await this('taxRepartitionLineId', 'moveId', 'taxIds');
    if (taxRepartitionLineId.ok) {
      return taxRepartitionLineId.refundTaxId;
    }
    else if (await moveId.moveType === 'entry') {
      const taxType = taxIds.ok ? await taxIds[0].typeTaxUse : null;
      return (taxType === 'sale' && await this['debit']) || (taxType === 'purchase' && await this['credit']);
    }
    return ['inRefund', 'outRefund'].includes(await moveId.moveType);
  }


  async _getInvoicedQtyPerProduct() {
    const qties = {};//new DefaultDict<any, number>();//float
    for (const aml of this) {
      const productId = await aml.productId;
      const id = productId.id;
      const qty = await (await aml.productUomId)._computeQuantity(await aml.quantity, await productId.uomId);
      const moveType = await (await aml.moveId).moveType;
      if (moveType === 'outInvoice') {
        if (!(id in qties)) {
          qties[id] = 0.0;
        }
        qties[id] += qty;
      }
      else if (moveType === 'outRefund') {
        if (!(id in qties)) {
          qties[id] = 0.0;
        }
        qties[id] -= qty;
      }
    }
    return qties;
  }

  // ONCHANGE METHODS

  /**
   * Recompute the dynamic onchange based on taxes.
      If the edited line is a tax line, don't recompute anything as the user must be able to
      set a custom value.
   */
  @api.onchange('amountCurrency', 'currencyId', 'debit', 'credit', 'taxIds', 'accountId', 'priceUnit', 'quantity')
  async _onchangeMarkRecomputeTaxes() {
    for (const line of this) {
      if (!(await line.taxRepartitionLineId).ok) {
        await line.set('recomputeTaxLine', true);
      }
    }
  }

  /**
   * Trigger tax recomputation only when some taxes with analytics
   */
  @api.onchange('analyticAccountId', 'analyticTagIds')
  async _onchangeMarkRecomputeTaxesAnalytic() {
    for (const line of this) {
      if (!(await line.taxRepartitionLineId).ok && await (await line.taxIds).some(tax => tax.analytic)) {
        await line.set('recomputeTaxLine', true);
      }
    }
  }

  @api.onchange('productId')
  async _onchangeProductId() {
    for (const line of this) {
      if (!(await line.productId).ok || ['lineSection', 'lineNote'].includes(await line.displayType)) {
        continue;
      }

      await line.set('label', await line._getComputedName());
      await line.set('accountId', await line._getComputedAccount());
      const fiscalPositionId = await (await line.moveId).fiscalPositionId;
      let taxes = await line._getComputedTaxes();
      if (taxes.ok && fiscalPositionId.ok) {
        taxes = await fiscalPositionId.mapTax(taxes);
      }
      await line.set('taxIds', taxes);
      await line.set('productUomId', await line._getComputedUom());
      await line.set('priceUnit', await line._getComputedPriceUnit());
    }
  }

  /**
   * Recompute the 'priceUnit' depending of the unit of measure.
   * @returns 
   */
  @api.onchange('productUomId')
  async _onchangeUomId() {
    if (['lineSection', 'lineNote'].includes(await this['displayType'])) {
      return;
    }
    const fiscalPositionId = await (await this['moveId']).fiscalPositionId;
    let taxes = await this._getComputedTaxes();
    if (taxes.ok && fiscalPositionId.ok) {
      taxes = await fiscalPositionId.mapTax(taxes);
    }
    await this.set('taxIds', taxes);
    await this.set('priceUnit', await this._getComputedPriceUnit());
  }

  /**
   * Recompute 'taxIds' based on 'accountId'.
      /!\ Don't remove existing taxes if there is no explicit taxes set on the account.
   */
  @api.onchange('accountId')
  async _onchangeAccountId() {
    for (const line of this) {
      if (! await line.displayType && (bool(await (await line.accountId).taxIds) || !bool(await line.taxIds))) {
        const fiscalPositionId = await (await line.moveId).fiscalPositionId;
        let taxes = await line._getComputedTaxes();

        if (taxes.ok && fiscalPositionId.ok) {
          taxes = await fiscalPositionId.mapTax(taxes);
        }

        await line.set('taxIds', taxes);
      }
    }
  }

  async _onchangeBalance() {
    for (const line of this) {
      const [moveId, currencyId] = await line('moveId', 'currencyId');
      if (currencyId.eq(await (await moveId.companyId).currencyId)) {
        await line.set('amountCurrency', await line.balance);
      }
      else {
        continue;
      }
      if (! await moveId.isInvoice(true)) {
        continue;
      }
      await line.update(await line._getFieldsOnchangeBalance());
    }
  }

  @api.onchange('debit')
  async _onchangeDebit() {
    if (await this['debit']) {
      await this.set('credit', 0.0);
    }
    await this._onchangeBalance();
  }

  @api.onchange('credit')
  async _onchangeCredit() {
    if (await this['credit']) {
      await this.set('debit', 0.0);
    }
    await this._onchangeBalance();
  }

  @api.onchange('amountCurrency')
  async _onchangeAmountCurrency() {
    for (const line of this) {
      const [moveId, currencyId, amountCurrency] = await line('moveId', 'currencyId', 'amountCurrency');
      const [company, date] = await moveId('companyId', 'date');
      const balance = await currencyId._convert(amountCurrency, await company.currencyId, company, date || await _Date.contextToday(line));
      await line.set('debit', balance > 0.0 ? balance : 0.0);
      await line.set('credit', balance < 0.0 ? -balance : 0.0);

      if (! await moveId.isInvoice(true)) {
        continue;
      }

      await line.update(await line._getFieldsOnchangeBalance());
      await line.update(await line._getPriceTotalAndSubtotal());
    }
  }

  @api.onchange('quantity', 'discount', 'priceUnit', 'taxIds')
  async _onchangePriceSubtotal() {
    for (const line of this) {
      if (! await (await line.moveId).isInvoice(true)) {
        continue;
      }

      await line.update(await line._getPriceTotalAndSubtotal());
      await line.update(await line._getFieldsOnchangeSubtotal());
    }
  }

  @api.onchange('currencyId')
  async _onchangeCurrency() {
    for (const line of this) {
      const moveId = await line('moveId');
      const company = await moveId.companyId;

      if (await moveId.isInvoice(true)) {
        await line._onchangePriceSubtotal();
      }
      else if (!(await moveId.reversedEntryId).ok) {
        const balance = await (await line.currencyId)._convert(await line.amountCurrency, await company.currencyId, company, await moveId.date || await _Date.contextToday(line));
        await line.set('debit', balance > 0.0 ? balance : 0.0);
        await line.set('credit', balance < 0.0 ? -balance : 0.0);
      }
    }
  }

  // COMPUTE METHODS

  @api.depends('fullReconcileId.label', 'matchedDebitIds', 'matchedCreditIds')
  async _computeMatchingNumber() {
    for (const record of this) {
      const fullReconcileId = await record.fullReconcileId;
      if (fullReconcileId.ok) {
        await record.set('matchingNumber', await fullReconcileId.label);
      }
      else if ((await record.matchedDebitIds).ok || (await record.matchedCreditIds).ok) {
        await record.set('matchingNumber', 'P');
      }
      else {
        await record.set('matchingNumber', null);
      }
    }
  }

  @api.depends('debit', 'credit')
  async _computeBalance() {
    for (const line of this) {
      await line.set('balance', await line.debit - await line.credit);
    }
  }

  @api.model()
  async searchRead(domain?: any, fields?: any[], options: {offset?: any, limit?: any, order?: any } = {}): Promise<Dict<any>[]> {
    if (!Array.isArray(domain)) {
      options = domain ?? {};
      domain = pop(options, 'domain');
      fields = pop(options, 'fields');
    }
    // Make an explicit order because we will need to reverse it
    options.order = (options.order || this.cls._order) + ', id';
    // Add the domain and order by in order to compute the cumulated balance in _computeCumulatedBalance
    return _super(AccountMoveLine, await this.withContext({ domainCumulatedBalance: domain || [], orderCumulatedBalance: options.order })).searchRead(domain, fields, options);
  }

  @api.model()
  async fieldsGet(allfields?: any, attributes?: any) {
    const res = await _super(AccountMoveLine, this).fieldsGet(allfields, attributes);
    if (res['cumulatedBalance']) {
      res['cumulatedBalance']['exportable'] = false;
    }
    return res;
  }

  @api.dependsContext('orderCumulatedBalance', 'domainCumulatedBalance')
  async _computeCumulatedBalance() {
    if (!this.env.context['orderCumulatedBalance']) {
      // We do not come from searchRead, so we are not in a list view, so it doesn't make any sense to compute the cumulated balance
      await this.set('cumulatedBalance', 0);
      return;
    }
    // get the where clause
    const query = await this._whereCalc(Array.from(this.env.context['domainCumulatedBalance'] || []));
    const orderString = (await this._generateOrderByInner(this.cls._table, this.env.context['orderCumulatedBalance'], query, true)).join(', ');
    const [fromClause, whereClause, whereClauseParams] = query.getSql();
    const sql = _f(`
                    SELECT "accountMoveLine".id, SUM("accountMoveLine".balance) OVER (
                        ORDER BY {orderby}
                        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                    ) AS sums
                    FROM {from}
                    WHERE {where}
                `, { 'from': fromClause, 'where': whereClause || 'TRUE', 'orderby': orderString });
    const res = await this.env.cr.execute(_convert$(sql), {bind: whereClauseParams});
    const result = Object.fromEntries(res.map(r => [r['id'], r['sums']]));
    for (const record of this) {
      await record.set('cumulatedBalance', result[record.id]);
    }
  }

  @api.depends('debit', 'credit', 'amountCurrency', 'accountId', 'currencyId', 'moveId.state', 'companyId', 'matchedDebitIds', 'matchedCreditIds')
  async _computeAmountResidual() {
    for (const line of this) {
      if (bool(line.id) && (await (await line.accountId).reconcile || await (await line.accountId).internalType === 'liquidity')) {
        const [matchedCreditIds, matchedDebitIds, currencyId, balance, amountCurrency, companyCurrencyId] = await line('matchedCreditIds', 'matchedDebitIds', 'currencyId', 'balance', 'amountCurrency', 'companyCurrencyId');
        const reconciledBalance = sum(await matchedCreditIds.mapped('amount'))
          - sum(await matchedDebitIds.mapped('amount'));
        const reconciledAmountCurrency = sum(await matchedCreditIds.mapped('debitAmountCurrency'))
          - sum(await matchedDebitIds.mapped('creditAmountCurrency'));

        await line.set('amountResidual', balance - reconciledBalance);

        if (currencyId.ok) {
          await line.set('amountResidualCurrency', amountCurrency - reconciledAmountCurrency);
        }
        else {
          await line.set('amountResidualCurrency', 0.0);
        }

        await line.set('reconciled', await companyCurrencyId.isZero(await line.amountResidual) && (currencyId.nok || await currencyId.isZero(await line.amountResidualCurrency)));
      }
      else {
        await line.set('amountResidual', 0.0),
        await line.set('amountResidualCurrency', 0.0),
        await line.set('reconciled', false)
      }
    }
  }

  /**
   * taxLineId is computed as the tax linked to the repartition line creating
      the move.
   */
  @api.depends('taxRepartitionLineId.invoiceTaxId', 'taxRepartitionLineId.refundTaxId')
  async _computeTaxLineId() {
    for (const record of this) {
      const repLine = await record.taxRepartitionLineId;
      const [invoiceTaxId, refundTaxId] = await repLine('invoiceTaxId', 'refundTaxId');
      // A constraint on account.tax.repartition.line ensures both those fields are mutually exclusive
      await record.set('taxLineId', invoiceTaxId.ok ? invoiceTaxId : refundTaxId);
    }
  }

  @api.depends('moveId.moveType', 'taxIds', 'taxRepartitionLineId', 'debit', 'credit', 'taxTagIds')
  async _computeTaxTagInvert() {
    for (const record of this) {
      const [moveId, repLine, taxIds] = await record('moveId', 'taxRepartitionLineId', 'taxIds');
      if (!repLine.ok && !taxIds.ok) {
        // Invoices imported from other softwares might only have kept the tags, not the taxes.
        await record.set('taxTagInvert', (await record.taxTagIds).ok && await moveId.isInbound());
      }

      else if (await moveId.moveType === 'entry') {
        // For misc operations, cash basis entries and write-offs from the bank reconciliation widget
        let isRefund, taxType;
        if (repLine.ok) {
          const [refundTaxId, invoiceTaxId] = await repLine('refundTaxId', 'invoiceTaxId');
          taxType = await (refundTaxId.ok ? refundTaxId : invoiceTaxId).typeTaxUse;
          isRefund = bool(refundTaxId);
        }
        else if (taxIds.ok) {
          taxType = await record.taxIds[0].typeTaxUse;
          isRefund = (taxType === 'sale' && await record.debit) || (taxType === 'purchase' && await record.credit);
        }
        await record.set('taxTagInvert', (taxType === 'purchase' && isRefund) || (taxType === 'sale' && !isRefund));
      }
      else {
        // For invoices with taxes
        await record.set('taxTagInvert', await moveId.isInbound());
      }
    }
  }

  @api.depends('taxTagIds', 'debit', 'credit', 'journalId', 'taxTagInvert')
  async _computeTaxAudit() {
    const separator = '        ';

    for (const record of this) {
      const currency = await (await record.companyId).currencyId;
      let auditStr = '';
      for (const tag of await record.taxTagIds) {
        const tagAmount = ((await record.taxTagInvert) && -1 || 1) * ((await tag.taxNegate) && -1 || 1) * await record.balance;

        if ((await tag.taxReportLineIds).ok) {
          //Then, the tag comes from a report line, and hence has a + or - sign (also in its name)
          for (const reportLine of await tag.taxReportLineIds) {
            auditStr += auditStr ? separator : '';
            auditStr += await reportLine.tagName + ': ' + await formatLang(this.env, tagAmount, { currencyObj: currency });
          }
        }
        else {
          // Then, it's a financial tag (sign is always +, and never shown in tag name)
          auditStr += auditStr ? separator : '';
          auditStr += await tag.label + ': ' + await formatLang(this.env, tagAmount, { currencyObj: currency });
        }
      }
      await record.set('taxAudit', auditStr);
    }
  }

  // CONSTRAINT METHODS

  @api.constrains('accountId', 'journalId')
  async _checkConstrainsAccountIdJournalId() {
    for (const line of await this.filtered(async (x) => !['lineSection', 'lineNote'].includes(await x.displayType))) {
      const account = await line.accountId;
      const [label, code, displayName, deprecated] = await account('label', 'code', 'displayName', 'deprecated');
      const journal = await (await line.moveId).journalId;

      if (deprecated) {
        throw new UserError(await this._t('The account %s (%s) is deprecated.', label, code));
      }

      const [accountCurrency, allowedJournalIds] = await account('currencyId', 'allowedJournalIds');
      if (accountCurrency.ok && !accountCurrency.eq(await line.companyCurrencyId) && !accountCurrency.eq(await line.currencyId)) {
        throw new UserError(await this._t('The account selected on your journal entry forces to provide a secondary currency. You should remove the secondary currency on the account.'));
      }

      if (allowedJournalIds.ok && !allowedJournalIds.includes(journal)) {
        throw new UserError(await this._t('You cannot use this account (%s) in this journal, check the field \'Allowed Journals\' on the related account.', displayName));
      }

      let failedCheck = false;
      const [typeControlIds, defaultAccountId, accountControlIds] = await journal('typeControlIds', 'defaultAccountId', 'accountControlIds');
      if (typeControlIds.sub(await defaultAccountId.userTypeId).ok || (await journal.accountControlIds).ok) {
        failedCheck = true;
        if (typeControlIds.ok) {
          failedCheck = !(typeControlIds.sub(await defaultAccountId.userTypeId).includes(await account.userTypeId));
        }
        if (failedCheck && accountControlIds.ok) {
          failedCheck = !accountControlIds.includes(account);
        }
      }
      if (failedCheck) {
        throw new UserError(await this._t('You cannot use this account (%s) in this journal, check the section \'Control-Access\' under tab \'Advanced Settings\' on the related journal.', displayName));
      }
    }
  }

  @api.constrains('accountId', 'taxIds', 'taxLineId', 'reconciled')
  async _checkOffBalance() {
    for (const line of this) {
      const [accountId, moveId] = await line('accountId', 'moveId');
      if (await accountId.internalGroup === 'offBalance') {
        if (await (await (await moveId.lineIds).accountId).some(async (a) => await a.internalGroup != await accountId.internalGroup)) {
          throw new UserError(await this._t('If you want to use "Off-Balance Sheet" accounts, all the accounts of the journal entry must be of this type'));
        }
        if ((await line.taxIds).ok || (await line.taxLineId).ok) {
          throw new UserError(await this._t('You cannot use taxes on lines with an Off-Balance account'));
        }
        if (await line.reconciled) {
          throw new UserError(await this._t('Lines from "Off-Balance Sheet" accounts cannot be reconciled'));
        }
      }
    }
  }

  async _affectTaxReport() {
    this.ensureOne();
    const [taxIds, taxLineId, taxTagIds] = await this('taxIds', 'taxLineId', 'taxTagIds');
    let res = taxIds.ok ? taxIds : taxLineId;
    return res.ok ? res : await taxTagIds.filtered(async (x) => await x.applicability === "taxes");
  }

  async _checkTaxLockDate() {
    for (const line of await this.filtered(async (l) => await (await l.moveId).state === 'posted')) {
      const move = await line.moveId;
      const [companyId, date] = await move('companyId', 'date');
      if (await companyId.taxLockDate && date <= await companyId.taxLockDate && await line._affectTaxReport()) {
        throw new UserError(await this._t("The operation is refused as it would impact an already issued tax statement. Please change the journal entry date or the tax lock date set in the settings (%s) to proceed.", await formatDate(this.env, await companyId.taxLockDate)));
      }
    }
  }

  async _checkReconciliation() {
    for (const line of this) {
      if ((await line.matchedDebitIds).ok || (await line.matchedCreditIds).ok) {
        const moveId = await line.moveId;
        throw new UserError(await this._t("You cannot do this modification on a reconciled journal entry. You can just change some non legal fields or you must unreconcile first.\n Journal Entry (id): %s (%s)", await moveId.label, moveId.id));
      }
    }
  }

  /**
   * When mixing cash basis and non cash basis taxes, it is important
      that those taxes don't share tags on the repartition creating
      a single account.move.line.
 
      Shared tags in this context cannot work, as the tags would need to
      be present on both the invoice and cash basis move, leading to the same
      base amount to be taken into account twice; which is wrong.This is
      why we don't support that. A workaround may be provided by the use of
      a group of taxes, whose children are type_tax_use=None, and only one
      of them uses the common tag.
 
      Note that taxes of the same exigibility are allowed to share tags.
   * @returns 
   */
  @api.constrains('taxIds', 'taxRepartitionLineId')
  async _checkCabaNonCabaSharedTags() {
    const self = this;
    async function getBaseRepartition(baseAml, taxes) {
      if (!bool(taxes)) {
        return self.env.items('account.tax.repartition.line');
      }

      const isRefund = await baseAml.belongsToRefund();
      const repartitionField = isRefund && 'refundRepartitionLineIds' || 'invoiceRepartitionLineIds';
      return taxes.mapped(repartitionField);
    }

    for (const aml of this) {
      const [taxIds, taxRepartitionLine] = await aml('taxIds', 'taxRepartitionLineId');
      const cabaTaxes = await taxIds.filtered(async (x) => await x.taxExigibility === 'onPayment');
      const nonCabaTaxes = taxIds.sub(cabaTaxes);

      const cabaBaseTags = await (await (await getBaseRepartition(aml, cabaTaxes)).filtered(async (x) => await x.repartitionType === 'base')).tagIds;
      const nonCabaBaseTags = await (await (await getBaseRepartition(aml, nonCabaTaxes)).filtered(async (x) => await x.repartitionType === 'base')).tagIds;

      let commonTags = cabaBaseTags.and(nonCabaBaseTags);

      if (!commonTags.ok) {
        // When a tax is affecting another one with different tax exigibility, tags cannot be shared either.
        const [taxId, taxTags] = await taxRepartitionLine('taxId', 'tagIds');
        const comparisonTags = await taxId.taxExigibility === 'onPayment' ? nonCabaBaseTags : cabaBaseTags;
        commonTags = taxTags.and(comparisonTags);
      }

      if (commonTags.ok) {
        throw new ValidationError(await this._t("Taxes exigible on payment and on invoice cannot be mixed on the same journal item if they share some tag."));
      }
    }
  }

  // LOW-LEVEL METHODS

  /**
   * change index on partnerId to a multi-column index on (partnerId, ref), the new index will behave in the
    same way when we search on partnerId, with the addition of being optimal when having a query that will
    search on partnerId and ref at the same time (which is the case when we open the bank reconciliation widget)
   */
  async init() {
    const cr = this._cr;
    await cr.execute('DROP INDEX IF EXISTS "accountMoveLinePartnerIdIndex"');
    const res = await cr.execute(`SELECT indexname FROM pg_indexes WHERE indexname = 'accountMoveLinePartnerIdRefIdx'`);
    if (res.length) {
      await cr.execute('CREATE INDEX "accountMoveLinePartnerIdRefIdx" ON "accountMoveLine" ("partnerId", ref)');
    }
  }

  @api.modelCreateMulti()
  async create(valsList) {
    // OVERRIDE
    const ACCOUNTING_FIELDS = ['debit', 'credit', 'amountCurrency'];
    const BUSINESS_FIELDS = ['priceUnit', 'quantity', 'discount', 'taxIds'];

    for (const vals of valsList) {
      const move = this.env.items('account.move').browse(vals['moveId']);
      const company = await move.companyId;
      const currency = await company.currencyId;
      setdefault(vals, 'companyCurrencyId', currency.id); // important to bypass the ORM limitation where monetary fields are not rounded; more info in the commit message

      // Ensure balance == amountCurrency in case of missing currency or same currency as the one from the
      // company.
      const currencyId = vals['currencyId'] || currency.id;
      if (currencyId == currency.id) {
        const balance = (vals['debit'] || 0.0) - (vals['credit'] || 0.0);
        update(vals, {
          'currencyId': currencyId,
          'amountCurrency': balance,
        });
      }
      else {
        vals['amountCurrency'] = vals['amountCurrency'] || 0.0;
      }

      if (await move.isInvoice(true)) {
        const partner = this.env.items('res.partner').browse(vals['partnerId']);
        let taxes = await (await this.new({ 'taxIds': vals['taxIds'] || [] })).taxIds;
        const taxIds = new Set(taxes.ids);
        taxes = this.env.items('account.tax').browse(taxIds);

        // Ensure consistency between accounting & business Fields.
        // As we can't express such synchronization as computed fields without cycling, we need to do it both
        // in onchange and in create/write. So, if something changed in accounting [resp. business] fields,
        // business [resp. accounting] fields are recomputed.
        if (ACCOUNTING_FIELDS.some(field => vals[field])) {
          const priceSubtotal = (await this._getPriceTotalAndSubtotalModel(
            vals['priceUnit'] || 0.0,
            vals['quantity'] || 0.0,
            vals['discount'] || 0.0,
            currency,
            this.env.items('product.product').browse(vals['productId']),
            partner,
            taxes,
            await move.moveType,
          ))['priceSubtotal'] || 0.0;
          update(vals, await this._getFieldsOnchangeBalanceModel(
            vals['quantity'] || 0.0,
            vals['discount'] || 0.0,
            vals['amountCurrency'],
            await move.moveType,
            currency,
            taxes,
            priceSubtotal
          ));
          update(vals, await this._getPriceTotalAndSubtotalModel(
            vals['priceUnit'] || 0.0,
            vals['quantity'] || 0.0,
            vals['discount'] || 0.0,
            currency,
            this.env.items('product.product').browse(vals['productId']),
            partner,
            taxes,
            await move.moveType,
          ));
        }

        else if (BUSINESS_FIELDS.some(field => vals[field])) {
          update(vals, await this._getPriceTotalAndSubtotalModel(
            vals['priceUnit'] || 0.0,
            vals['quantity'] || 0.0,
            vals['discount'] || 0.0,
            currency,
            this.env.items('product.product').browse(vals['productId']),
            partner,
            taxes,
            await move.moveType,
          ))
          update(vals, await this._getFieldsOnchangeSubtotalModel(
            vals['priceSubtotal'],
            await move.moveType,
            currency,
            await move.companyId,
            await move.date,
          ))
        }
      }
    }

    const lines = await _super(AccountMoveLine, this).create(valsList);

    const moves = await lines.mapped('moveId');
    if (this._context['checkMoveValidity'] || true) {
      await moves._checkBalanced();
    }
    await moves._checkFiscalyearLockDate();
    await lines._checkTaxLockDate();
    await moves._synchronizeBusinessModels(['lineIds']);

    return lines;
  }

  async write(vals) {
    // OVERRIDE
    const ACCOUNTING_FIELDS = ['debit', 'credit', 'amountCurrency'];
    const BUSINESS_FIELDS = ['priceUnit', 'quantity', 'discount', 'taxIds'];
    const PROTECTED_FIELDS_TAX_LOCK_DATE = ['debit', 'credit', 'taxLineId', 'taxIds', 'taxTagIds'];
    const PROTECTED_FIELDS_LOCK_DATE = PROTECTED_FIELDS_TAX_LOCK_DATE.concat(['accountId', 'journalId', 'amountCurrency', 'currencyId', 'partnerId']);
    const PROTECTED_FIELDS_RECONCILIATION = ['accountId', 'date', 'debit', 'credit', 'amountCurrency', 'currencyId'];

    const accountToWrite = 'accountId' in vals ? this.env.items('account.account').browse(vals['accountId']) : null;

    // Check writing a deprecated account.
    if (bool(accountToWrite) && await accountToWrite.deprecated) {
      throw new UserError(await this._t('You cannot use a deprecated account.'));
    }

    for (const line of this) {
      if (await line.parentState === 'posted') {
        if (await (await line.moveId).restrictModeHashTable && _.intersection(Object.keys(vals), INTEGRITY_HASH_LINE_FIELDS)) {
          throw new UserError(await this._t("You cannot edit the following fields due to restrict mode being activated on the journal: %s.", INTEGRITY_HASH_LINE_FIELDS.join(', ')));
        }
        if (['taxIds', 'taxLineIds'].some(key => key in vals)) {
          throw new UserError(await this._t('You cannot modify the taxes related to a posted journal item, you should reset the journal entry to draft to do so.'));
        }
      }
      // Check the lock date.
      if (await someAsync(PROTECTED_FIELDS_LOCK_DATE, fieldName => this.env.items('account.move')._fieldWillChange(line, vals, fieldName))) {
        await (await line.moveId)._checkFiscalyearLockDate();
      }

      // Check the tax lock date.
      if (await someAsync(PROTECTED_FIELDS_TAX_LOCK_DATE, fieldName => this.env.items('account.move')._fieldWillChange(line, vals, fieldName))) {
        await line._checkTaxLockDate();
      }

      // Check the reconciliation.
      if (await someAsync(PROTECTED_FIELDS_RECONCILIATION, fieldName => this.env.items('account.move')._fieldWillChange(line, vals, fieldName))) {
        await line._checkReconciliation();
      }

      // Check switching receivable / payable accounts.
      if (bool(accountToWrite)) {
        const [moveId, accountId] = await line('moveId', 'accountId');
        const accountType = await (await accountId.userTypeId).type;
        const type = await (await accountToWrite.userTypeId).type;
        if (await moveId.isSaleDocument(true)) {
          if ((accountType === 'receivable' && type !== accountType) || (accountType !== 'receivable' && type == 'receivable')) {
            throw new UserError(await this._t("You can only set an account having the receivable type on payment terms lines for customer invoice."));
          }
        }
        if (await moveId.isPurchaseDocument(true)) {
          if ((accountType === 'payable' && type != accountType) || (accountType !== 'payable' && type === 'payable')) {
            throw new UserError(await this._t("You can only set an account having the payable type on payment terms lines for vendor bill."));
          }
        }
      }
    }

    // Tracking stuff can be skipped for perfs using tracking_disable context key
    let refFields, moveInitialValues;
    if (!this.env.context['trackingDisable'] || false) {
      // Get all tracked fields (without related fields because these fields must be manage on their own model)
      const trackingFields = [];
      for (const fieldName of Object.keys(vals)) {
        const field = this._fields[fieldName];
        if (hasattr(field, 'related') && field.related) {
          continue; // We don't want to track related field.
        }
        if (hasattr(field, 'tracking') && field.tracking) {
          trackingFields.push(fieldName);
        }
      }
      refFields = await this.env.items('account.move.line').fieldsGet(trackingFields);

      // Get initial values for each line
      moveInitialValues = {};
      for (const line of await this.filtered(async (l) => await (await l.moveId).postedBefore)) {// Only lines with posted once move.
        for (const fieldName of trackingFields) {
          // Group initial values by moveId
          const id = (await line.moveId).id;
          if (!(id in moveInitialValues)) {
            moveInitialValues[id] = {};
          }
          update(moveInitialValues[id], { [fieldName]: await line[fieldName] });
        }
      }
    }

    let result = true;
    for (const line of this) {
      const [moveId, currencyId, companyCurrencyId] = await line('moveId', 'currencyId', 'companyCurrencyId');
      const cleanedVals = await moveId._cleanupWriteOrmValues(line, vals);
      if (bool(cleanedVals)) {
        continue;
      }

      // Auto-fill amount_currency if working in single-currency.
      if (!('currencyId' in cleanedVals)
        && currencyId.eq(companyCurrencyId)
        && (['debit', 'credit'].some(fieldName => fieldName in cleanedVals))) {
        update(cleanedVals, {
          'amountCurrency': (vals['debit'] || 0.0) - (vals['credit'] || 0.0),
        });
      }

      result = result || await _super(AccountMoveLine, line).write(cleanedVals);

      if (! await moveId.isInvoice(true)) {
        continue;
      }

      // Ensure consistency between accounting & business Fields.
      // As we can't express such synchronization as computed fields without cycling, we need to do it both
      // in onchange and in create/write. So, if something changed in accounting [resp. business] fields,
      // business [resp. accounting] fields are recomputed.
      if (ACCOUNTING_FIELDS.some(field => field in cleanedVals)) {
        const priceSubtotal = (await line._getPriceTotalAndSubtotal())['priceSubtotal'] || 0.0;
        const toWrite = await line._getFieldsOnchangeBalance({ priceSubtotal });
        update(toWrite, await line._getPriceTotalAndSubtotal({
          priceUnit: toWrite['priceUnit'] || await line.priceUnit,
          quantity: toWrite['quantity'] || await line.quantity,
          discount: toWrite['discount'] || await line.discount,
        }));
        result = result || await _super(AccountMoveLine, line).write(toWrite);
      }
      else if (BUSINESS_FIELDS.some(field => field in cleanedVals)) {
        const toWrite = await line._getPriceTotalAndSubtotal();
        update(toWrite, await line._getFieldsOnchangeSubtotal({
          priceSubtotal: toWrite['priceSubtotal'],
        }))
        result = result || await _super(AccountMoveLine, line).write(toWrite);
      }
    }

    // Check total_debit == total_credit in the related moves.
    if (this._context['checkMoveValidity'] || true) {
      await (await this.mapped('moveId'))._checkBalanced();
    }

    await (await this.mapped('moveId'))._synchronizeBusinessModels(['lineIds']);

    if (!(this.env.context['trackingDisable'] || false)) {
      // Log changes to move lines on each move
      for (const [moveId, modifiedLines] of Object.entries(moveInitialValues)) {
        for (const line of await this.filtered(async (l) => (await l.moveId).id == moveId)) {
          const trackingValueIds = (await line._mailTrack(refFields, modifiedLines))[1];
          if (bool(trackingValueIds)) {
            const msg = `${escapeHtml(await this._t('Journal Item'))} <a href=// data-oe-model=account.move.line data-oe-id=${line.id}>#${line.id}</a> ${escapeHtml(await this._t('updated'))}`;
            await (await line.moveId)._messageLog({
              body: msg,
              trackingValueIds: trackingValueIds
            });
          }
        }
      }
    }
    return result;
  }

  _validFieldParameter(field, name) {
    // I can't even
    return name === 'tracking' || _super(AccountMoveLine, this)._validFieldParameter(field, name);
  }

  @api.ondelete(false)
  async _unlinkExceptPosted() {
    // Prevent deleting lines on posted entries
    if (!this._context['forceDelete'] && await (await this['moveId']).some(async (m) => await m.state === 'posted')) {
      throw new UserError(await this._t('You cannot delete an item linked to a posted entry.'));
    }
  }

  async unlink() {
    const moves = await this.mapped('moveId');

    // Check the lines are not reconciled (partially or not).
    await this._checkReconciliation();

    // Check the lock date.
    await moves._checkFiscalyearLockDate();

    // Check the tax lock date.
    await this._checkTaxLockDate();

    const res = await _super(AccountMoveLine, this).unlink();

    // Check total_debit == total_credit in the related moves.
    if (this._context['checkMoveValidity'] || true) {
      await moves._checkBalanced();
    }

    return res;
  }

  @api.model()
  async defaultGet(defaultFields) {
    // OVERRIDE
    const values = await _super(AccountMoveLine, this).defaultGet(defaultFields);

    if (defaultFields.includes('accountId') && !values['accountId']
      && (this._context['journalId'] || this._context['default_journalId'])
      && ['outInvoice', 'outRefund', 'inInvoice', 'inRefund', 'outReceipt', 'inReceipt'].includes(this._context['default_moveType'])) {
      // Fill missing 'accountId'.
      const journal = this.env.items('account.journal').browse(this._context['default_journalId'] || this._context['journalId']);
      values['accountId'] = (await journal.defaultAccountId).id;
    }
    else if (this._context['lineIds'] && ['debit', 'credit', 'accountId', 'partnerId'].some(fieldName => defaultFields.includes(fieldName))) {
      const move = await this.env.items('account.move').new({ 'lineIds': this._context['lineIds'] });

      // Suggest default value for debit / credit to balance the journal entry.
      let balance = await (await move.lineIds).sum(async (line) => await line['debit'] - await line['credit']);
      // if we are here, lineIds is in context, so journalId should also be.
      const journal = this.env.items('account.journal').browse(this._context['default_journalId'] || this._context['journalId']);
      const currency = bool(await journal.exists()) && await (await journal.companyId).currencyId;
      if (bool(currency)) {
        balance = await currency.round(balance);
      }
      if (balance < 0.0) {
        update(values, { 'debit': -balance });
      }
      if (balance > 0.0) {
        update(values, { 'credit': balance });
      }
      // Suggest default value for 'partnerId'.
      const lineIds = await move.lineIds;
      if (defaultFields.includes('partnerId') && !values['partnerId']) {
        if (len(lineIds([-2])) == 2 && ((await lineIds([-1]).partnerId).eq(await lineIds([-2]).partnerId)) != false) {
          values['partnerId'] = (await lineIds([-2]).mapped('partnerId')).id;
        }
      }

      // Suggest default value for 'accountId'.
      if (defaultFields.includes('accountId') && !values['accountId']) {
        if (len(lineIds([-2])) == 2 && ((await lineIds([-1]).accountId).eq(await lineIds([-2]).accountId)) != false) {
          values['accountId'] = (await lineIds([-2]).mapped('accountId')).id;
        }
      }
    }

    if (values['displayType'] || await this['displayType']) {
      pop(values, 'accountId', null);
    }
    return values;
  }

  @api.depends('ref', 'moveId')
  async nameGet() {
    const result = [];
    for (const line of this) {
      const [moveId, productId, ref, label] = await line('moveId', 'productId', 'ref', 'label');
      let name = await moveId.label || '';
      if (ref) {
        name += f(" (%s)", ref);
      }
      const displayName = await productId.displayName;
      name += (label || displayName) && (' ' + (label || displayName)) || '';
      result.push([line.id, name]);
    }
    return result;
  }

  @api.model()
  async _nameSearch(name?: string, args?: any[], operator: string = 'ilike', { limit=100, nameGetUid=false } = {}): Promise<any> {
    if (operator === 'ilike') {
      const domain = ['|', '|',
        ['label', 'ilike', name],
        ['moveId', 'ilike', name],
        ['productId', 'ilike', name]]
      return this._search(expression.AND([domain, args]), { limit, accessRightsUid: nameGetUid });
    }
    return _super(AccountMoveLine, this)._nameSearch(name, args, operator, { limit, nameGetUid });
  }

  @api.model()
  invalidateCache(fnames?: any[], ids?: any[]) {
    // Invalidate cache of related moves
    if (fnames == null || fnames.includes('moveId')) {
      const field = this._fields['moveId'];
      const lines = ids == null ? this.env.cache.getRecords(this as any, field) : this.browse(ids);
      const moveIds = this.env.cache.getValues(lines, field).filter(id => bool(id));
      if (moveIds.length) {
        this.env.items['account.move'].invalidateCache(null, moveIds);
      }
    }
    return _super(AccountMoveLine, this).invalidateCache(fnames, ids);
  }

  // TRACKING METHODS

  async _mailTrack(trackedFields: {}, initial: {}) {
    const [changes, trackingValueIds] = await _super(AccountMoveLine, this)._mailTrack(trackedFields, initial);
    if (len(changes) > len(trackingValueIds)) {
      for (const [i, changedField] of enumerate(changes)) {
        if (['one2many', 'many2many'].includes(trackedFields[changedField]['type'])) {
          const field = this.env.items('ir.model.fields')._get(this._name, changedField);
          const vals = {
            'field': field.id,
            'fieldDesc': await field.fieldDescription,
            'fieldType': await field.ttype,
            'trackingSequence': await field.tracking,
            'oldValueChar': (await (await initial[changedField]).mapped('label')).join(', '),
            'newValueChar': (await (await this[changedField]).mapped('label')).join(', '),
          }
          await trackingValueIds.insert(i, Command.create(vals));
        }
      }
    }

    return [changes, trackingValueIds];
  }

  // RECONCILIATION

  /**
   * Prepare the partials on the current journal items to perform the reconciliation.
      /!\ The order of records in self is important because the journal items will be reconciled using this order.

      :return: A recordset of account.partial.reconcile.
   */
  async _prepareReconciliationPartials() {
    const debitLines = (await this.filtered(async (line) => await line.balance > 0.0 || await line.amountCurrency > 0.0))[Symbol.iterator]();
    const creditLines = (await this.filtered(async (line) => await line.balance < 0.0 || await line.amountCurrency < 0.0))[Symbol.iterator]();
    let debitLine = null;
    let creditLine = null;

    let debitAmountResidual = 0.0;
    let debitAmountResidualCurrency = 0.0;
    let creditAmountResidual = 0.0;
    let creditAmountResidualCurrency = 0.0;
    let debitLineCurrency = null;
    let creditLineCurrency = null;

    let partialsValsList = [];

    while (true) {

      // Move to the next available debit line.
      if (!bool(debitLine)) {
        debitLine = next(debitLines, null);
        if (!bool(debitLine)) {
          break;
        }
        debitAmountResidual = await debitLine.amountResidual;

        if (bool(await debitLine.currencyId)) {
          debitAmountResidualCurrency = await debitLine.amountResidualCurrency;
          debitLineCurrency = await debitLine.currencyId
        }
        else {
          debitAmountResidualCurrency = debitAmountResidual;
          debitLineCurrency = await debitLine.companyCurrencyId;
        }
      }
      // Move to the next available credit line.
      if (!bool(creditLine)) {
        creditLine = next(creditLines, null);
        if (!bool(creditLine)) {
          break;
        }
        creditAmountResidual = await creditLine.amountResidual;

        if (bool(await creditLine.currencyId)) {
          creditAmountResidualCurrency = await creditLine.amountResidualCurrency;
          creditLineCurrency = await creditLine.currencyId;
        }
        else {
          creditAmountResidualCurrency = creditAmountResidual;
          creditLineCurrency = await creditLine.companyCurrencyId;
        }
      }
      const minAmountResidual = Math.min(debitAmountResidual, -creditAmountResidual);
      const hasDebitResidualLeft = ! await (await debitLine.companyCurrencyId).isZero(debitAmountResidual) && debitAmountResidual > 0.0;
      const hasCreditResidualLeft = ! await (await creditLine.companyCurrencyId).isZero(creditAmountResidual) && creditAmountResidual < 0.0;
      const hasDebitResidualCurrLeft = ! await debitLineCurrency.isZero(debitAmountResidualCurrency) && debitAmountResidualCurrency > 0.0;
      const hasCreditResidualCurrLeft = ! await creditLineCurrency.isZero(creditAmountResidualCurrency) && creditAmountResidualCurrency < 0.0;

      let minDebitAmountResidualCurrency, minCreditAmountResidualCurrency;

      if (debitLineCurrency.eq(creditLineCurrency)) {
        // Reconcile on the same currency.

        // The debit line is now fully reconciled because:
        // - either amount_residual & amount_residual_currency are at 0.
        // - either the credit_line is not an exchange difference one.
        if (!hasDebitResidualCurrLeft && (hasCreditResidualCurrLeft || !hasDebitResidualLeft)) {
          debitLine = null;
          continue;
        }
        // The credit line is now fully reconciled because:
        // - either amount_residual & amount_residual_currency are at 0.
        // - either the debit is not an exchange difference one.
        if (!hasCreditResidualCurrLeft && (hasDebitResidualCurrLeft || !hasCreditResidualLeft)) {
          creditLine = null;
          continue;
        }

        const minAmountResidualCurrency = Math.min(debitAmountResidualCurrency, -creditAmountResidualCurrency);
        minDebitAmountResidualCurrency = minAmountResidualCurrency;
        minCreditAmountResidualCurrency = minAmountResidualCurrency;
      }
      else {
        // Reconcile on the company's currency.

        // The debit line is now fully reconciled since amount_residual is 0.
        if (!hasDebitResidualLeft) {
          debitLine = null;
          continue;
        }

        // The credit line is now fully reconciled since amount_residual is 0.
        if (!hasCreditResidualLeft) {
          creditLine = null;
          continue;
        }

        minDebitAmountResidualCurrency = await (await creditLine.companyCurrencyId)._convert(
          minAmountResidual,
          await debitLine.currencyId,
          await creditLine.companyId,
          await creditLine.date,
        )
        minCreditAmountResidualCurrency = await (await debitLine.companyCurrencyId)._convert(
          minAmountResidual,
          await creditLine.currencyId,
          await debitLine.companyId,
          await debitLine.date,
        )
      }
      debitAmountResidual -= minAmountResidual;
      debitAmountResidualCurrency -= minDebitAmountResidualCurrency;
      creditAmountResidual += minAmountResidual;
      creditAmountResidualCurrency += minCreditAmountResidualCurrency;

      partialsValsList.push({
        'amount': minAmountResidual,
        'debitAmountCurrency': minDebitAmountResidualCurrency,
        'creditAmountCurrency': minCreditAmountResidualCurrency,
        'debitMoveId': debitLine.id,
        'creditMoveId': creditLine.id,
      });
    }

    return partialsValsList;
  }

  /**
   * Create the exchange difference journal entry on the current journal items.
      :return: An account.move record.
   */
  async _createExchangeDifferenceMove() {
    const env = this.env;
    /**
     * Generate the exchange difference values used to create the journal items
          in order to fix the residual amounts and add them into 'exchangeDiffMoveVals'.
 
          1) When reconciled on the same foreign currency, the journal items are
          fully reconciled regarding this currency but it could be not the case
          of the balance that is expressed using the company's currency. In that
          case, we need to create exchange difference journal items to ensure this
          residual amount reaches zero.
 
          2) When reconciled on the company currency but having different foreign
          currencies, the journal items are fully reconciled regarding the company
          currency but it's not always the case for the foreign currencies. In that
          case, the exchange difference journal items are created to ensure this
          residual amount in foreign currency reaches zero.
 
          :param lines:                   The account.move.lines to which fix the residual amounts.
          :param exchangeDiffMoveVals:    The current vals of the exchange difference journal entry.
          :return:                        A list of pair <line, sequence> to perform the reconciliation
                                          at the creation of the exchange difference move where 'line'
                                          is the account.move.line to which the 'sequence'-th exchange
                                          difference line will be reconciled with.
     * @param lines 
     * @param exchangeDiffMoveVals 
     */
    async function _addLinesToExchangeDifferenceVals(lines, exchangeDiffMoveVals) {
      const journal = env.items('account.journal').browse(exchangeDiffMoveVals['journalId']);
      const toReconcile = [];

      for (const line of lines) {
        const [date, companyCurrencyId, amountResidual, amountResidualCurrency, currencyId] = await line('date', 'companyCurrencyId', 'amountResidual', 'amountResidualCurrency', 'currencyId');
        const [expenseCurrencyExchangeAccountId, incomeCurrencyExchangeAccountId] = await (await journal.companyId)('expenseCurrencyExchangeAccountId', 'incomeCurrencyExchangeAccountId');
        exchangeDiffMoveVals['date'] = dateMax(exchangeDiffMoveVals['date'], new Date(date));
        let exchangeLineAccount;
        if (! await companyCurrencyId.isZero(amountResidual)) {
          // amountResidualCurrency == 0 and amountResidual has to be fixed.

          if (amountResidual > 0.0) {
            exchangeLineAccount = expenseCurrencyExchangeAccountId;
          }
          else {
            exchangeLineAccount = incomeCurrencyExchangeAccountId;
          }
        }
        else if (currencyId.ok && ! await currencyId.isZero(amountResidualCurrency)) {
          // amountResidual == 0 and amountResidualCurrency has to be fixed.

          if (amountResidualCurrency > 0.0) {
            exchangeLineAccount = expenseCurrencyExchangeAccountId;
          }
          else {
            exchangeLineAccount = incomeCurrencyExchangeAccountId;
          }
        }
        else {
          continue;
        }
        const [partnerId, accountId] = await line('partnerId', 'accountId');
        const sequence = len(exchangeDiffMoveVals['lineIds']);
        extend(exchangeDiffMoveVals['lineIds'], [
          [0, 0, {
            'label': await line._t('Currency exchange rate difference'),
            'debit': amountResidual < 0.0 ? -amountResidual : 0.0,
            'credit': amountResidual > 0.0 ? amountResidual : 0.0,
            'amountCurrency': -amountResidualCurrency,
            'accountId': accountId.id,
            'currencyId': currencyId.id,
            'partnerId': partnerId.id,
            'sequence': sequence,
          }],
          [0, 0, {
            'label': await line._t('Currency exchange rate difference'),
            'debit': amountResidual > 0.0 ? amountResidual : 0.0,
            'credit': amountResidual < 0.0 ? -amountResidual : 0.0,
            'amountCurrency': amountResidualCurrency,
            'accountId': exchangeLineAccount.id,
            'currencyId': currencyId.id,
            'partnerId': partnerId.id,
            'sequence': sequence + 1,
          }],
        ])

        toReconcile.push([line, sequence]);
      }
      return toReconcile;
    }

    async function _addCashBasisLinesToExchangeDifferenceVals(lines, exchangeDiffMoveVals) {
      for (const move of await lines.moveId) {
        const accountValsToFix = {};

        const moveValues = await move._collectTaxCashBasisValues();

        // The cash basis doesn't need to be handle for this move because there is another payment term
        // line that is not yet fully paid.
        if (!bool(moveValues) || !moveValues['isFullyPaid']) {
          continue;
        }

        // ==========================================================================
        // Add the balance of all tax lines of the current move in order in order
        // to compute the residual amount for each of them.
        // ==========================================================================

        for (const [cabaTreatment, line] of moveValues['toProcessLines']) {

          const vals = {
            'currencyId': (await line.currencyId).id,
            'partnerId': (await line.partnerId).id,
            'taxIds': [[6, 0, (await line.taxIds).ids]],
            'taxTagIds': [[6, 0, (await line.taxTagIds).ids]],
            'debit': await line.debit,
            'credit': await line.credit,
          }

          if (cabaTreatment === 'tax') {
            // Tax line.
            const groupingKey = await env.items('account.partial.reconcile')._getCashBasisTaxLineGroupingKeyFromRecord(line);
            if (groupingKey in accountValsToFix) {
              const debit = accountValsToFix[groupingKey]['debit'] + vals['debit'];
              const credit = accountValsToFix[groupingKey]['credit'] + vals['credit'];
              const balance = debit - credit;

              update(accountValsToFix[groupingKey], {
                'debit': balance > 0 ? balance : 0,
                'credit': balance < 0 ? -balance : 0,
                'taxBaseAmount': accountValsToFix[groupingKey]['taxBaseAmount'] + await line.taxBaseAmount,
              });
            }
            else {
              accountValsToFix[groupingKey] = {
                ...vals,
                'accountId': (await line.accountId).id,
                'taxBaseAmount': await line.taxBaseAmount,
                'taxRepartitionLineId': (await line.taxRepartitionLineId).id,
              }
            }
          }
          else if (cabaTreatment === 'base') {
            // Base line.
            const accountToFix = await (await line.companyId).accountCashBasisBaseAccountId;
            if (!bool(accountToFix)) {
              continue;
            }

            const groupingKey = await env.items('account.partial.reconcile')._getCashBasisBaseLineGroupingKeyFromRecord(line, accountToFix);

            if (!(groupingKey in accountValsToFix)) {
              accountValsToFix[groupingKey] = {
                ...vals,
                'accountId': accountToFix.id,
              }
            }
            else {
              // Multiple base lines could share the same key, if the same
              // cash basis tax is used alone on several lines of the invoices
              accountValsToFix[groupingKey]['debit'] += vals['debit'];
              accountValsToFix[groupingKey]['credit'] += vals['credit'];
            }
          }
        }

        // ==========================================================================
        // Subtract the balance of all previously generated cash basis journal entries
        // in order to retrieve the residual balance of each involved transfer account.
        // ==========================================================================

        const cashBasisMoves = await env.items('account.move').search([['taxCashBasisOriginMoveId', '=', move.id]]);
        for (const line of await cashBasisMoves.lineIds) {
          let groupingKey;// = None
          if (bool(await line.taxRepartitionLineId)) {
            // Tax line.
            groupingKey = await env.items('account.partial.reconcile')._getCashBasisTaxLineGroupingKeyFromRecord(
              line, await (await line.taxLineId).cashBasisTransitionAccountId,
            );
          }
          else if (bool(await line.taxIds)) {
            // Base line.
            groupingKey = await env.items('account.partial.reconcile')._getCashBasisBaseLineGroupingKeyFromRecord(
              line, await (await line.companyId).accountCashBasisBaseAccountId,
            );
          }
          if (!(groupingKey in accountValsToFix)) {
            continue;
          }

          accountValsToFix[groupingKey]['debit'] -= line.debit;
          accountValsToFix[groupingKey]['credit'] -= line.credit;
        }
        // ==========================================================================
        // Generate the exchange difference journal items:
        // - to reset the balance of all transfer account to zero.
        // - fix rounding issues on the tax account/base tax account.
        // ==========================================================================

        for (const values of Object.values<any>(accountValsToFix)) {
          const balance = values['debit'] - values['credit'];

          if (await (await move.companyCurrencyId).isZero(balance)) {
            continue;
          }

          if (bool(values['taxRepartitionLineId'])) {
            // Tax line.
            const taxRepartitionLine = env.items('account.tax.repartition.line').browse(values['taxRepartitionLineId']);
            let account = taxRepartitionLine.accountId;
            account = account.ok ? account : env.items('account.account').browse(values['accountId']);

            const sequence = len(exchangeDiffMoveVals['lineIds']);
            extend(exchangeDiffMoveVals['lineIds'], [
              [0, 0, {
                ...values,
                'label': await this._t('Currency exchange rate difference (cash basis)'),
                'debit': balance > 0.0 ? balance : 0.0,
                'credit': balance < 0.0 ? -balance : 0.0,
                'accountId': account.id,
                'sequence': sequence,
              }],
              [0, 0, {
                ...values,
                'label': await this._t('Currency exchange rate difference (cash basis)'),
                'debit': balance < 0.0 ? -balance : 0.0,
                'credit': balance > 0.0 ? balance : 0.0,
                'accountId': values['accountId'],
                'taxIds': [],
                'taxTagIds': [],
                'taxRepartitionLineId': false,
                'sequence': sequence + 1,
              }],
            ]);
          }
          else {
            // Base line.
            const sequence = len(exchangeDiffMoveVals['lineIds']);
            extend(exchangeDiffMoveVals['lineIds'], [
              [0, 0, {
                ...values,
                'label': await this._t('Currency exchange rate difference (cash basis)'),
                'debit': balance > 0.0 ? balance : 0.0,
                'credit': balance < 0.0 ? -balance : 0.0,
                'sequence': sequence,
              }],
              [0, 0, {
                ...values,
                'label': await this._t('Currency exchange rate difference (cash basis)'),
                'debit': balance < 0.0 ? -balance : 0.0,
                'credit': balance > 0.0 ? balance : 0.0,
                'taxIds': [],
                'taxTagIds': [],
                'sequence': sequence + 1,
              }],
            ]);
          }
        }
      }
    }

    if (!this.ok) {
      return env.items('account.move');
    }
    const company = await this[0].companyId;
    const journal = await company.currencyExchangeJournalId;

    const exchangeDiffMoveVals = {
      'moveType': 'entry',
      'date': _Date.min,
      'journalId': journal.id,
      'lineIds': [],
    }

    // Fix residual amounts.
    const toReconcile = await _addLinesToExchangeDifferenceVals(this, exchangeDiffMoveVals);

    // Fix cash basis entries.
    const isCashBasisNeeded = ['receivable', 'payable'].includes(await this[0].accountInternalType);
    if (isCashBasisNeeded) {
      await _addCashBasisLinesToExchangeDifferenceVals(this, exchangeDiffMoveVals);
    }
    // ==========================================================================
    // Create move and reconcile.
    // ==========================================================================

    let exchangeMove;
    if (bool(exchangeDiffMoveVals['lineIds'])) {
      // Check the configuration of the exchange difference journal.
      if (!bool(journal)) {
        throw new UserError(await this._t("You should configure the 'Exchange Gain or Loss Journal' in your company settings, to manage automatically the booking of accounting entries related to differences between exchange rates."));
      }
      const company = await journal.companyId;
      if (!bool(await company.expenseCurrencyExchangeAccountId)) {
        throw new UserError(await this._t("You should configure the 'Loss Exchange Rate Account' in your company settings, to manage automatically the booking of accounting entries related to differences between exchange rates."));
      }
      if (!bool((await company.incomeCurrencyExchangeAccountId).id)) {
        throw new UserError(await this._t("You should configure the 'Gain Exchange Rate Account' in your company settings, to manage automatically the booking of accounting entries related to differences between exchange rates."));
      }
      exchangeDiffMoveVals['date'] = dateMax(exchangeDiffMoveVals['date'], await company._getUserFiscalLockDate());

      exchangeMove = await env.items('account.move').create(exchangeDiffMoveVals);
    }
    else {
      return null;
    }
    // Reconcile lines to the newly created exchange difference journal entry by creating more partials.
    const partialsValsList = [];
    for (const [sourceLine, sequence] of toReconcile) {
      const exchangeDiffLine = (await exchangeMove.lineIds)[sequence];

      let exchangeField, debitLine, creditLine;
      if (await (await sourceLine.companyCurrencyId).isZero(await sourceLine.amountResidual)) {
        exchangeField = 'amountResidualCurrency';
      }
      else {
        exchangeField = 'amountResidual';
      }
      if (exchangeDiffLine[exchangeField] > 0.0) {
        debitLine = exchangeDiffLine;
        creditLine = sourceLine;
      }
      else {
        debitLine = sourceLine;
        creditLine = exchangeDiffLine;
      }
      partialsValsList.push({
        'amount': Math.abs(await sourceLine.amountResidual),
        'debitAmountCurrency': Math.abs(await debitLine.amountResidualCurrency),
        'creditAmountCurrency': Math.abs(await creditLine.amountResidualCurrency),
        'debitMoveId': debitLine.id,
        'creditMoveId': creditLine.id,
      });
    }
    await env.items('account.partial.reconcile').create(partialsValsList);

    return exchangeMove;
  }

  /**
   * Reconcile the current move lines all together.
      :return: A dictionary representing a summary of what has been done during the reconciliation:
              * partials:             A recorset of all account.partial.reconcile created during the reconciliation.
              * full_reconcile:       An account.full.reconcile record created when there is nothing left to reconcile
                                      in the involved lines.
              * tax_cash_basis_moves: An account.move recordset representing the tax cash basis journal entries.
   * @returns 
   */
  async reconcile() {
    const results = {};

    if (!this.ok) {
      return results;
    }

    // List unpaid invoices
    const notPaidInvoices = await (await this['moveId']).filtered(
      async (move) => await move.isInvoice(true) && !['paid', 'inPayment'].includes(await move.paymentState)
    );


    // ==== Check the lines can be reconciled together ====
    let company;
    let account;
    for (const line of this) {
      if (await line.reconciled) {
        throw new UserError(await this._t("You are trying to reconcile some entries that are already reconciled."));
      }
      const accountId = await line.accountId;
      if (! await accountId.reconcile && await accountId.internalType !== 'liquidity') {
        throw new UserError(await this._t("Account %s does not allow reconciliation. First change the configuration of this account to allow it.", await accountId.displayName));
      }
      if (await (await line.moveId).state !== 'posted') {
        throw new UserError(await this._t('You can only reconcile posted entries.'));
      }
      if (company == null) {
        company = await line.companyId;
      }
      else if (!(await line.companyId).eq(company)) {
        throw new UserError(await this._t("Entries doesn't belong to the same company: %s != %s", await company.displayName, await (await line.companyId).displayName));
      }
      if (account == null) {
        account = accountId;
      }
      else if (!accountId.eq(account)) {
        throw new UserError(await this._t("Entries are not from the same account: %s != %s", await account.displayName, await accountId.displayName));
      }
    }

    const sortedLines = await this.sorted(async (line) => [await line.dateMaturity || await line.date, (await line.currencyId).id]);

    // ==== Collect all involved lines through the existing reconciliation ====

    let involvedLines = sortedLines;
    let involvedPartials = this.env.items('account.partial.reconcile');
    let currentLines = involvedLines;
    let currentPartials = involvedPartials;
    while (bool(currentLines)) {
      currentPartials = (await currentLines.matchedDebitIds).add(await currentLines.matchedCreditIds).sub(currentPartials);
      involvedPartials = involvedPartials.add(currentPartials);
      currentLines = (await currentPartials.debitMoveId).add(await currentPartials.creditMoveId).sub(currentLines);
      involvedLines = involvedLines.add(currentLines);
    }

    // ==== Create partials ====

    const partials = await this.env.items('account.partial.reconcile').create(await sortedLines._prepareReconciliationPartials());

    // Track newly created partials.
    results['partials'] = partials;
    involvedPartials = involvedPartials.add(partials);

    // ==== Create entries for cash basis taxes ====

    const isCashBasisNeeded = await (await account.companyId).taxExigibility && ['receivable', 'payable'].includes(await (await account.userTypeId).type);
    if (isCashBasisNeeded && !this._context['moveReverseCancel'] && !this._context['noCashBasis']) {
      const taxCashBasisMoves = await partials._createTaxCashBasisMoves();
      results['taxCashBasisMoves'] = taxCashBasisMoves;
    }

    // ==== Check if a full reconcile is needed ====
    let isFullNeeded;
    if (bool(await involvedLines[0].currencyId) && await involvedLines.all(async (line) => (await line.currencyId).eq(await involvedLines[0].currencyId))) {
      isFullNeeded = await involvedLines.all(async (line) => (await line.currencyId).isZero(await line.amountResidualCurrency));
    }
    else {
      isFullNeeded = await involvedLines.all(async (line) => (await line.companyCurrencyId).isZero(await line.amountResidual));
    }
    if (isFullNeeded) {

      // ==== Create the exchange difference move ====
      let exchangeMove;
      if (this._context['noExchangeDifference']) {
        exchangeMove = null;
      }
      else {
        exchangeMove = await involvedLines._createExchangeDifferenceMove();
        if (bool(exchangeMove)) {
          const exchangeMoveLines = await (await exchangeMove.lineIds).filtered(async (line) => (await line.accountId).eq(account));

          // Track newly created lines.
          involvedLines = involvedLines.add(exchangeMoveLines);

          // Track newly created partials.
          const exchangeDiffPartials = (await exchangeMoveLines.matchedDebitIds).add(await exchangeMoveLines.matchedCreditIds);
          involvedPartials = involvedPartials.add(exchangeDiffPartials);
          results['partials'] = results['partials'].add(exchangeDiffPartials);

          await exchangeMove._post(false);
        }
      }
      // ==== Create the full reconcile ====

      results['fullReconcile'] = await this.env.items('account.full.reconcile').create({
        'exchangeMoveId': bool(exchangeMove) && exchangeMove.id,
        'partialReconcileIds': [[6, 0, involvedPartials.ids]],
        'reconciledLineIds': [[6, 0, involvedLines.ids]],
      });
    }
    // Trigger action for paid invoices
    await (await notPaidInvoices.filtered(async (move) => ['paid', 'inPayment'].includes(await move.paymentState))).actionInvoicePaid();

    return results;
  }

  /**
   * Undo a reconciliation
   */
  async removeMoveReconcile() {
    await (await this['matchedDebitIds']).add(await this['matchedCreditIds']).unlink();
  }

  /**
   * Hook allowing copying business fields under certain conditions.
      E.g. The link to the sale order lines must be preserved in case of a refund.
   * @param values 
   */
  async _copyDataExtendBusinessFields(values) {
    this.ensureOne();
  }

  async copyData(defaultValue?: any) {
    const res = await _super(AccountMoveLine, this).copyData(defaultValue);

    for (const [line, values] of _.zip([...this], res)) {
      // Don't copy the name of a payment term line.
      if (await (await line.moveId).isInvoice() && ['receivable', 'payable'].includes(await (await (await line.accountId).userTypeId).type)) {
        values['label'] = '';
      }
      // Don't copy restricted fields of notes
      if (['lineSection', 'lineNote'].includes(await line.displayType)) {
        values['amountCurrency'] = 0;
        values['debit'] = 0;
        values['credit'] = 0;
        values['accountId'] = false;
      }
      if (this._context['includeBusinessFields']) {
        await line._copyDataExtendBusinessFields(values);
      }
    }
    return res;
  }

  // -------------------------------------------------------------------------
  // MISC
  // -------------------------------------------------------------------------

  async _getAnalyticTagIds() {
    this.ensureOne();
    return (await (await this['analyticTagIds']).filtered(async (r) => !(await r.activeAnalyticDistribution))).ids;
  }

  /**
   * Create analytic items upon validation of an account.move.line having an analytic account or an analytic distribution.
   * @returns 
   */
  async createAnalyticLines() {
    let linesToCreateAnalyticEntries = this.env.items('account.move.line');
    let analyticLineVals = [];
    for (const objLine of this) {
      for (const tag of await (await objLine.analyticTagIds).filtered('activeAnalyticDistribution')) {
        for (const distribution of (await tag.analyticDistributionIds)) {
          analyticLineVals.push(await objLine._prepareAnalyticDistributionLine(distribution));
        }
      }
      if (bool(await objLine.analyticAccountId)) {
        linesToCreateAnalyticEntries = linesToCreateAnalyticEntries.or(objLine);
      }
    }

    // create analytic entries in batch
    if (linesToCreateAnalyticEntries.ok) {
      extend(analyticLineVals, await linesToCreateAnalyticEntries._prepareAnalyticLine());
    }

    await this.env.items('account.analytic.line').create(analyticLineVals);
  }

  /**
   * Prepare the values used to create() an account.analytic.line upon validation of an account.move.line having
          an analytic account. This method is intended to be extended in other modules.
          :return list of values to create analytic.line
          :rtype list
   * @returns 
   */
  async _prepareAnalyticLine() {
    const result = [];
    for (const moveLine of this) {
      const [credit, debit, label, ref, partnerId, moveId, date, analyticAccountId, quantity, productId, productUomId, accountId] = await moveLine('credit', 'debit', 'label', 'ref', 'partnerId', 'moveId', 'date', 'analyticAccountId', 'quantity', 'productId', 'productUomId', 'accountId');
      const amount = (credit || 0.0) - (debit || 0.0);
      const defaultName = label || (ref || '/' + ' -- ' + (partnerId.ok && await partnerId.label || '/'));
      let category = 'other';
      if (moveId.isSaleDocument()) {
        category = 'invoice';
      }
      else if (moveId.isPurchaseDocument()) {
        category = 'vendorBill';
      }
      result.push({
        'label': defaultName,
        'date': date,
        'accountId': analyticAccountId.id,
        'groupId': (await analyticAccountId.groupId).id,
        'tagIds': [[6, 0, await moveLine._getAnalyticTagIds()]],
        'unitAmount': quantity,
        'productId': productId.ok && bool(productId.id) ? productId.id : false,
        'productUomId': productUomId.ok && bool(productUomId.id) ? productUomId.id : false,
        'amount': amount,
        'generalAccountId': accountId.id,
        'ref': ref,
        'moveId': moveLine.id,
        'userId': bool((await moveId.invoiceUserId).id) ? (await moveId.invoiceUserId).id : this._uid,
        'partnerId': partnerId.id,
        'companyId': bool((await analyticAccountId.companyId).id) ? (await analyticAccountId.companyId).id : (await moveId.companyId).id,
        'category': category,
      });
    }
    return result;
  }

  /**
   * Prepare the values used to create() an account.analytic.line upon validation of an account.move.line having
          analytic tags with analytic distribution.
   * @param distribution 
   * @returns 
   */
  async _prepareAnalyticDistributionLine(distribution) {
    this.ensureOne();
    const [balance, label, ref, partnerId, moveId, date, quantity, productId, productUomId, accountId] = await this('balance', 'label', 'ref', 'partnerId', 'moveId', 'date', 'quantity', 'productId', 'productUomId', 'accountId');
    const [disAccountId, disPercentage, disTagId] = await distribution('accountId', 'percentage', 'tagId');
    const amount = -balance * disPercentage / 100.0;
    const defaultName = label || (ref || '/' + ' -- ' + (partnerId.ok && await partnerId.label || '/'));
    return {
      'label': defaultName,
      'date': date,
      'accountId': disAccountId.id,
      'groupId': (await disAccountId.groupId).id,
      'partnerId': partnerId.id,
      'tagIds': [[6, 0, [disTagId.id] + await this._getAnalyticTagIds()]],
      'unit_amount': quantity,
      'productId': productId.ok && bool(productId.id) ? productId.id : false,
      'productUomId': productUomId.ok && bool(productUomId.id) ? productUomId.id : false,
      'amount': amount,
      'generalAccountId': accountId.id,
      'ref': ref,
      'moveId': this.id,
      'userId': bool((await moveId.invoiceUserId).id) ? (await moveId.invoiceUserId).id : this._uid,
      'companyId': bool((await disAccountId.companyId).id) ? (await disAccountId.companyId).id : (await this.env.company()).id,
    }
  }

  @api.model()
  async _queryGet(domain?: any) {
    await this.checkAccessRights('read');

    const context = Object.assign({}, this._context);
    domain = domain ?? [];
    if (!Array.isArray(domain)) {
      domain = literalEval(domain);
    }
    let dateField = 'date';
    if (context['agedBalance']) {
      dateField = 'dateMaturity';
    }
    if (context['dateTo']) {
      extend(domain, [[dateField, '<=', context['dateTo']]]);
    }
    if (context['dateFrom']) {
      if (!context['strictRange']) {
        extend(domain, ['|', [dateField, '>=', context['dateFrom']], ['accountId.userTypeId.includeInitialBalance', '=', true]]);
      }
      else if (context['initialBal']) {
        extend(domain, [[dateField, '<', context['dateFrom']]]);
      }
      else {
        extend(domain, [[dateField, '>=', context['dateFrom']]]);
      }
    }
    if (context['journalIds']) {
      extend(domain, [['journalId', 'in', context['journalIds']]]);
    }
    const state = context['state'];
    if (state && state.toLowerCase() !== 'all') {
      extend(domain, [['moveId.state', '=', state]]);
    }

    if (context['companyId']) {
      extend(domain, [['companyId', '=', context['companyId']]]);
    }
    else if (context['allowedCompanyIds']) {
      extend(domain, [['companyId', 'in', (await this.env.companies()).ids]]);
    }
    else {
      extend(domain, [['companyId', '=', (await this.env.company()).id]]);
    }
    if (context['reconcileDate']) {
      extend(domain, ['|', ['reconciled', '=', false], '|', ['matchedDebitIds.maxDate', '>', context['reconcileDate']], ['matchedCreditIds.maxDate', '>', context['reconcileDate']]]);
    }
    if (context['accountTagIds']) {
      extend(domain, [['accountId.tagIds', 'in', context['accountTagIds'].ids]]);
    }
    if (context['accountIds']) {
      extend(domain, [['accountId', 'in', context['accountIds'].ids]]);
    }
    if (context['analyticTagIds']) {
      extend(domain, [['analyticTagIds', 'in', context['analyticTagIds'].ids]]);
    }
    if (context['analyticAccountIds']) {
      extend(domain, [['analyticAccountId', 'in', context['analyticAccountIds'].ids]]);
    }
    if (context['partnerIds']) {
      extend(domain, [['partnerId', 'in', context['partnerIds'].ids]]);
    }
    if (context['partnerCategories']) {
      extend(domain, [['partnerId.categoryId', 'in', context['partnerCategories'].ids]]);
    }
    let whereClause = "";
    let whereClauseParams = [];
    let tables = '';
    if (domain.length) {
      domain.push(['displayType', 'not in', ['lineSection', 'lineNote']]);
      domain.push(['moveId.state', '!=', 'cancel']);

      const query = await this._whereCalc(domain);

      // Wrap the query with 'companyId IN (...)' to avoid bypassing company access rights.
      await this._applyIrRules(query);

      [tables, whereClause, whereClauseParams] = query.getSql();
    }
    return [tables, whereClause, whereClauseParams];
  }

  async _reconciledLines() {
    const ids = [];
    for (const aml of await this.filtered('accountId.reconcile')) {
      extend(ids, await aml.credit > 0
        ? await (await aml.matchedDebitIds).map(async (r) => (await r.debitMoveId).id)
        : await (await aml.matchedCreditIds).map(async (r) => (await r.creditMoveId).id)
      );
      ids.push(aml.id);
    }
    return ids;
  }

  async openReconcileView() {
    const action = await this.env.items('ir.actions.actions')._forXmlid('account.actionAccountMovesAllA');
    const ids = await (this as any)._reconciledLines();
    action['domain'] = [['id', 'in', ids]]
    return action;
  }

  async actionAutomaticEntry() {
    const action = this.env.items('ir.actions.actions')._forXmlid('account.accountAutomaticEntryWizardAction');
    // Force the values of the move line in the context to avoid issues
    const ctx = Object.assign({}, this.env.context);
    pop(ctx, 'activeId', null);
    ctx['activeIds'] = this.ids;
    ctx['activeModel'] = 'account.move.line';
    action['context'] = ctx;
    return action;
  }

  @api.model()
  async _getSuspenseMovesDomain() {
    return [
      ['moveId.toCheck', '=', true],
      ['fullReconcileId', '=', false],
      ['statementLineId', '!=', false],
    ];
  }

  async _getAttachmentDomains() {
    this.ensureOne();
    const domains = [[['resModel', '=', 'account.move'], ['resId', '=', (await this['moveId']).id]]];
    if (bool(await this['statementId'])) {
      domains.push([['resModel', '=', 'account.bank.statement'], ['resId', '=', (await this['statementId']).id]]);
    }
    if (bool(await this['paymentId'])) {
      domains.push([['resModel', '=', 'account.payment'], ['resId', '=', (await this['paymentId']).id]]);
    }
    return domains;
  }

  /**
   * Return the downpayment move lines associated with the move line.
    This method is overridden in the sale order module.
   * @returns 
   */
  async _getDownpaymentLines() {
    return this.env.items('account.move.line');
  }
}