import _ from "lodash";
import { DateTime } from "luxon";
import { api, tools } from "../../../core";
import { setdefault } from "../../../core/api/func";
import { Field, Fields, _Date } from "../../../core/fields";
import { DefaultDict2 } from "../../../core/helper/collections";
import { AccessError, NotImplementedError, RedirectWarning, UserError, ValidationError } from "../../../core/helper/errors";
import { MetaModel, Model, ModelRecords, _super } from "../../../core/models";
import { bool, emailRe, emailSplit, equal, floatCompare, floatIsZero, formatDate, formatLang, getLang, isCallable, isHtmlEmpty, isInstance, pop, sha256, sorted, sortedAsync, update } from "../../../core/tools";
import { dateMin, getMonth } from "../../../core/tools/date_utils";
import { extend, iter, len, some, sum, zipLongest } from "../../../core/tools/iterable";
import { stringify } from "../../../core/tools/json";
import { _f, f } from "../../../core/tools/utils";
import { escapeHtml } from "../../../core/tools/xml";
import { INTEGRITY_HASH_LINE_FIELDS } from "./account_move_line";
import { contextmanager } from "../../../core/tools/context";

export const MAX_HASH_VERSION = 2;

//forbidden fields
const INTEGRITY_HASH_MOVE_FIELDS = ['date', 'journalId', 'companyId'];

/**
 * Calculate the extra digits that should be appended to the number to make it a valid number.
 */
function calcCheckDigits(numbers) {
  const numberBase10 = numbers.map(n => String(parseInt(n, 36))).join('');
  const checksum = parseInt(numberBase10) % 97;
  return f('%02d', (98 - 100 * checksum) % 97);
}

export const PAYMENT_STATE_SELECTION = [
  ['notPaid', 'Not Paid'],
  ['inPayment', 'In Payment'],
  ['paid', 'Paid'],
  ['partial', 'Partially Paid'],
  ['reversed', 'Reversed'],
  ['invoicingLegacy', 'Invoicing App Legacy'],
];

declare type TaxesMapEntry = {
  'taxLine': any,
  'amount': number,
  'taxBaseAmount': number,
  'groupingDict': Object,
}

@MetaModel.define()
class AccountMove extends Model {
  static _module = module;
  static _name = "account.move";
  static _parents = ['portal.mixin', 'mail.thread', 'mail.activity.mixin', 'sequence.mixin'];
  static _description = "Journal Entry";
  static _order = 'date desc, label desc, id desc';
  static _mailPostAccess = 'read';
  static _checkCompanyAuto = true;

  static _sequenceIndex = "journalId";
  get _sequenceIndex() { return "journalId" };

  // ==== Business fields ====
  static label = Fields.Char({ string: 'Number', copy: false, compute: '_computeName', readonly: false, store: true, index: true, tracking: true });
  static highestName = Fields.Char({ compute: '_computeHighestName' });
  static showNameWarning = Fields.Boolean({ store: false });
  static date = Fields.Date({
    string: 'Date',
    required: true,
    index: true,
    readonly: true,
    states: { 'draft': [['readonly', false]] },
    copy: false,
    tracking: true,
    default: self => _Date.contextToday(self)
  });
  static ref = Fields.Char({ string: 'Reference', copy: false, tracking: true });
  static narration = Fields.Html({ string: 'Terms and Conditions', compute: '_computeNarration', store: true, readonly: false });

  static state = Fields.Selection({
    selection: [
      ['draft', 'Draft'],
      ['posted', 'Posted'],
      ['cancel', 'Cancelled'],
    ], string: 'Status', required: true, readonly: true, copy: false, tracking: true,
    default: 'draft'
  });
  static postedBefore = Fields.Boolean({ help: "Technical field for knowing if the move has been posted before", copy: false });
  static moveType = Fields.Selection({
    selection: [
      ['entry', 'Journal Entry'],
      ['outInvoice', 'Customer Invoice'],
      ['outRefund', 'Customer Credit Note'],
      ['inInvoice', 'Vendor Bill'],
      ['inRefund', 'Vendor Credit Note'],
      ['outReceipt', 'Sales Receipt'],
      ['inReceipt', 'Purchase Receipt'],
    ], string: 'Type', required: true, store: true, index: true, readonly: true, tracking: true,
    default: "entry", changeDefault: true
  });
  static typeName = Fields.Char('Type Name', { compute: '_computeTypeName' });
  static toCheck = Fields.Boolean({
    string: 'To Check', default: false, tracking: true,
    help: 'If this checkbox is ticked, it means that the user was not sure of all the related information at the time of the creation of the move and that the move needs to be checked again.'
  });
  static journalId = Fields.Many2one('account.journal', {
    string: 'Journal', required: true, readonly: true,
    states: { 'draft': [['readonly', false]] },
    checkCompany: true, domain: "[['id', 'in', suitableJournalIds]]",
    default: self => self._getDefaultJournal()
  });
  static suitableJournalIds = Fields.Many2many('account.journal', { compute: '_computeSuitableJournalIds' });
  static companyId = Fields.Many2one({
    comodelName: 'res.company', string: 'Company',
    store: true, readonly: true,
    compute: '_computeCompanyId'
  });
  static companyCurrencyId = Fields.Many2one({
    string: 'Company Currency', readonly: true,
    related: 'companyId.currencyId'
  });
  static currencyId = Fields.Many2one('res.currency', {
    store: true, readonly: true, tracking: true, required: true,
    states: { 'draft': [['readonly', false]] },
    string: 'Currency',
    default: self => self._getDefaultCurrency()
  });
  static lineIds = Fields.One2many('account.move.line', 'moveId', { string: 'Journal Items', copy: true, readonly: true, states: { 'draft': [['readonly', false]] } });
  static partnerId = Fields.Many2one('res.partner', {
    readonly: true, tracking: true,
    states: { 'draft': [['readonly', false]] },
    checkCompany: true,
    string: 'Partner', changeDefault: true
  });
  static commercialPartnerId = Fields.Many2one('res.partner', {
    string: 'Commercial Entity', store: true, readonly: true,
    compute: '_computeCommercialPartnerId'
  });
  static countryCode = Fields.Char({ related: 'companyId.accountFiscalCountryId.code', readonly: true });
  static userId = Fields.Many2one({
    string: 'User', related: 'invoiceUserId',
    help: 'Technical field used to fit the generic behavior in mail templates.'
  });
  static isMoveSent = Fields.Boolean({
    readonly: true,
    default: false,
    copy: false,
    tracking: true,
    help: "It indicates that the invoice/payment has been sent.",
  })
  static partnerBankId = Fields.Many2one('res.partner.bank', {
    string: 'Recipient Bank',
    help: 'Bank Account Number to which the invoice will be paid. A Company bank account if this is a Customer Invoice or Vendor Credit Note, otherwise a Partner bank account number.',
    checkCompany: true
  });
  static paymentReference = Fields.Char({
    string: 'Payment Reference', index: true, copy: false,
    help: "The payment reference to set on journal items."
  });
  static paymentId = Fields.Many2one({
    index: true,
    comodelName: 'account.payment',
    string: "Payment", copy: false, checkCompany: true
  });
  static statementLineId = Fields.Many2one({
    comodelName: 'account.bank.statement.line',
    string: "Statement Line", copy: false, checkCompany: true
  });
  static statementId = Fields.Many2one({
    related: 'statementLineId.statementId',
    copy: false,
    readonly: true,
    help: "Technical field used to open the linked bank statement from the edit button in a group by view, or via the smart button on journal entries."
  });

  // === Amount fields ===
  static amountUntaxed = Fields.Monetary({
    string: 'Untaxed Amount', store: true, readonly: true, tracking: true,
    compute: '_computeAmount'
  });
  static amountTax = Fields.Monetary({
    string: 'Tax', store: true, readonly: true,
    compute: '_computeAmount'
  });
  static amountTotal = Fields.Monetary({
    string: 'Total', store: true, readonly: true,
    compute: '_computeAmount',
    inverse: '_inverseAmountTotal'
  });
  static amountResidual = Fields.Monetary({
    string: 'Amount Due', store: true,
    compute: '_computeAmount'
  });
  static amountUntaxedSigned = Fields.Monetary({
    string: 'Untaxed Amount Signed', store: true, readonly: true,
    compute: '_computeAmount', currencyField: 'companyCurrencyId'
  });
  static amountTaxSigned = Fields.Monetary({
    string: 'Tax Signed', store: true, readonly: true,
    compute: '_computeAmount', currencyField: 'companyCurrencyId'
  });
  static amountTotalSigned = Fields.Monetary({
    string: 'Total Signed', store: true, readonly: true,
    compute: '_computeAmount', currencyField: 'companyCurrencyId'
  });
  static amountTotalInCurrencySigned = Fields.Monetary({
    string: 'Total in Currency Signed', store: true, readonly: true,
    compute: '_computeAmount', currencyField: 'currencyId'
  });
  static amountResidualSigned = Fields.Monetary({
    string: 'Amount Due Signed', store: true,
    compute: '_computeAmount', currencyField: 'companyCurrencyId'
  });
  static taxTotalsJson = Fields.Char({
    string: "Invoice Totals JSON",
    compute: '_computeTaxTotalsJson',
    readonly: false,
    help: 'Edit Tax amounts if you encounter rounding issues.'
  });
  static paymentState = Fields.Selection(PAYMENT_STATE_SELECTION, {
    string: "Payment Status", store: true,
    readonly: true, copy: false, tracking: true, compute: '_computeAmount'
  });

  // ==== Cash basis feature fields ====
  static taxCashBasisRecId = Fields.Many2one(
    'account.partial.reconcile',
    {
      string: 'Tax Cash Basis Entry of',
      help: "Technical field used to keep track of the tax cash basis reconciliation. This is needed when cancelling the source: it will post the inverse journal entry to cancel that part too."
    });
  static taxCashBasisOriginMoveId = Fields.Many2one({
    comodelName: 'account.move',
    string: "Cash Basis Origin",
    readonly: 1,
    help: "The journal entry from which this tax cash basis journal entry has been created."
  });
  static taxCashBasisCreatedMoveIds = Fields.One2many({
    string: "Cash Basis Entries",
    comodelName: 'account.move',
    relationField: 'taxCashBasisOriginMoveId',
    help: "The cash basis entries created from the taxes on this entry, when reconciling its lines."
  });
  static alwaysTaxExigible = Fields.Boolean({
    compute: '_computeAlwaysTaxExigible',
    store: true,
    help: "Technical field used by cash basis taxes, telling the lines of the move are always exigible. This happens if the move contains no payable or receivable line."
  });

  // ==== Auto-post feature fields ====
  static autoPost = Fields.Boolean({
    string: 'Post Automatically', default: false, copy: false,
    help: 'If this checkbox is ticked, this entry will be automatically posted at its date.'
  });

  // ==== Reverse feature fields ====
  static reversedEntryId = Fields.Many2one('account.move', {
    string: "Reversal of", readonly: true, copy: false,
    checkCompany: true
  });
  static reversalMoveId = Fields.One2many('account.move', 'reversedEntryId');

  // =========================================================
  // Invoice related fields
  // =========================================================

  // ==== Business fields ====
  static fiscalPositionId = Fields.Many2one('account.fiscal.position', {
    string: 'Fiscal Position', readonly: true,
    states: { 'draft': [['readonly', false]] },
    checkCompany: true,
    domain: "[['companyId', '=', companyId]]", ondelete: "RESTRICT",
    help: "Fiscal positions are used to adapt taxes and accounts for particular customers or sales orders/invoices. The default value comes from the customer."
  });
  static invoiceUserId = Fields.Many2one('res.users', {
    copy: false, tracking: true,
    string: 'Salesperson',
    default: self => self.env.user()
  });
  static invoiceDate = Fields.Date({
    string: 'Invoice/Bill Date', readonly: true, index: true, copy: false,
    states: { 'draft': [['readonly', false]] }
  });
  static invoiceDateDue = Fields.Date({
    string: 'Due Date', readonly: true, index: true, copy: false,
    states: { 'draft': [['readonly', false]] }
  });
  static invoiceOrigin = Fields.Char({
    string: 'Origin', readonly: true, tracking: true,
    help: "The document(s) that generated the invoice."
  });
  static invoicePaymentTermId = Fields.Many2one('account.payment.term', {
    string: 'Payment Terms',
    checkCompany: true,
    readonly: true, states: { 'draft': [['readonly', false]] }
  });
  // /!\ invoiceLineIds is just a subset of lineIds.
  static invoiceLineIds = Fields.One2many('account.move.line', 'moveId', {
    string: 'Invoice lines',
    copy: false, readonly: true,
    domain: [['excludeFromInvoiceTab', '=', false]],
    states: { 'draft': [['readonly', false]] }
  });
  static invoiceIncotermId = Fields.Many2one('account.incoterms', {
    string: 'Incoterm',
    default: self => self._getDefaultInvoiceIncoterm(),
    help: 'International Commercial Terms are a series of predefined commercial terms used in international transactions.'
  })
  static displayQrCode = Fields.Boolean({ string: "Display QR-code", related: 'companyId.qrCode' });
  static qrCodeMethod = Fields.Selection({
    string: "Payment QR-code",
    selection: (self) => self.env.items('res.partner.bank').getAvailableQrMethodsInSequence(),
    help: "Type of QR-code to be generated for the payment of this invoice, when printing it. If left blank, the first available and usable method will be used."
  });

  // ==== Payment widget fields ====
  static invoiceOutstandingCreditsDebitsWidget = Fields.Text({
    groups: "account.groupAccountInvoice,account.groupAccountReadonly",
    compute: '_computePaymentsWidgetToReconcileInfo'
  });
  static invoiceHasOutstanding = Fields.Boolean({
    groups: "account.groupAccountInvoice,account.groupAccountReadonly",
    compute: '_computePaymentsWidgetToReconcileInfo'
  });
  static invoicePaymentsWidget = Fields.Text({
    groups: "account.groupAccountInvoice,account.groupAccountReadonly",
    compute: '_computePaymentsWidgetReconciledInfo'
  });

  // ==== Vendor bill fields ====
  static invoiceVendorBillId = Fields.Many2one('account.move', {
    store: false,
    checkCompany: true,
    string: 'Vendor Bill',
    help: "Auto-complete from a past bill."
  });
  static invoiceSourceEmail = Fields.Char({ string: 'Source Email', tracking: true });
  static invoicePartnerDisplayName = Fields.Char({ compute: '_computeInvoicePartnerDisplayInfo', store: true });

  // ==== Cash rounding fields ====
  static invoiceCashRoundingId = Fields.Many2one('account.cash.rounding', {
    string: 'Cash Rounding Method',
    readonly: true, states: { 'draft': [['readonly', false]] },
    help: 'Defines the smallest coinage of the currency that can be used to pay by cash.'
  });

  // ==== Display purpose fields ====
  static invoiceFilterTypeDomain = Fields.Char({
    compute: '_computeInvoiceFilterTypeDomain',
    help: "Technical field used to have a dynamic domain on journal / taxes in the form view."
  });
  static bankPartnerId = Fields.Many2one('res.partner', { help: 'Technical field to get the domain on the bank', compute: '_computeBankPartnerId' });
  static invoiceHasMatchingSuspenseAmount = Fields.Boolean({
    compute: '_computeHasMatchingSuspenseAmount',
    groups: 'account.groupAccountInvoice,account.groupAccountReadonly',
    help: "Technical field used to display an alert on invoices if there is at least a matching amount in any supsense account."
  });
  static taxLockDateMessage = Fields.Char({
    compute: '_computeTaxLockDateMessage',
    help: "Technical field used to display a message when the invoice's accounting date is prior of the tax lock date."
  });
  static displayInactiveCurrencyWarning = Fields.Boolean({
    compute: "_computeDisplayInactiveCurrencyWarning",
    help: "Technical field used for tracking the status of the currency"
  });
  static taxCountryId = Fields.Many2one({ comodelName: 'res.country', compute: '_computeTaxCountryId', help: "Technical field to filter the available taxes depending on the fiscal country and fiscal position." });
  static taxCountryCode = Fields.Char({ compute: "_computeTaxCountryCode" });
  //// Technical field to hide Reconciled Entries stat button
  static hasReconciledEntries = Fields.Boolean({ compute: "_computeHasReconciledEntries" });
  static showResetToDraftButton = Fields.Boolean({ compute: '_computeShowResetToDraftButton' });

  // ==== Hash Fields ====
  static restrictModeHashTable = Fields.Boolean({ related: 'journalId.restrictModeHashTable' });
  static secureSequenceNumber = Fields.Integer({ string: "Inalteralbility No Gap Sequence #", readonly: true, copy: false });
  static inalterableHash = Fields.Char({ string: "Inalterability Hash", readonly: true, copy: false });
  static stringToHash = Fields.Char({ compute: '_computeStringToHash', readonly: true });

  async init() {
    await _super(AccountMove, this).init();
    await this.env.cr.execute(`
      CREATE INDEX IF NOT EXISTS "accountMoveToCheckIdx"
      ON "accountMove"("journalId") WHERE "toCheck" = true;
      CREATE INDEX IF NOT EXISTS "accountMovePaymentIdx"
      ON "accountMove"("journalId", state, "paymentState", "moveType", date);
    `);
  }

  async _sequenceMonthlyRegex(): Promise<RegExp> {
    const sequenceOverrideRegex = await (await this['journalId']).sequenceOverrideRegex;
    return isCallable(sequenceOverrideRegex) ? await sequenceOverrideRegex() : await _super(AccountMove, this)._sequenceMonthlyRegex();
  }

  async _sequenceYearlyRegex(): Promise<RegExp> {
    const sequenceOverrideRegex = await (await this['journalId']).sequenceOverrideRegex;
    return isCallable(sequenceOverrideRegex) ? await sequenceOverrideRegex() : await _super(AccountMove, this)._sequenceYearlyRegex();
  }

  async _sequenceFixedRegex(): Promise<RegExp> {
    const sequenceOverrideRegex = await (await this['journalId']).sequenceOverrideRegex;
    return isCallable(sequenceOverrideRegex) ? await sequenceOverrideRegex() : await _super(AccountMove, this)._sequenceFixedRegex();
  }

  @api.model()
  async _searchDefaultJournal(journalTypes) {
    const companyId = this._context['default_companyId'] ?? (await this.env.company()).id;
    const domain = [['companyId', '=', companyId], ['type', 'in', journalTypes]];

    let journal;
    if (this._context['default_currencyId']) {
      const currencyDomain = domain.concat([['currencyId', '=', this._context['default_currencyId']]]);
      journal = await this.env.items('account.journal').search(currencyDomain, { limit: 1 });
    }

    if (!bool(journal)) {
      journal = await this.env.items('account.journal').search(domain, { limit: 1 });
    }

    if (!bool(journal)) {
      const company = this.env.items('res.company').browse(companyId);

      const errorMsg = _f(await this._t(
        "No journal could be found in company '{companyName}' for any of those types: {journalTypes}"), {
        companyName: await company.displayName,
        journalTypes: journalTypes.join(', '),
      });
      throw new UserError(errorMsg);
    }

    return journal;
  }

  /**
   * Get the default journal.
      It could either be passed through the context using the 'default_journalId' key containing its id,
      either be determined by the default type.
   */
  @api.model()
  async _getDefaultJournal() {
    const moveType = this._context['default_moveType'] ?? 'entry';
    let journalTypes;
    if (this.getSaleTypes(true).includes(moveType)) {
      journalTypes = ['sale'];
    }
    else if (this.getPurchaseTypes(true).includes(moveType)) {
      journalTypes = ['purchase'];
    }
    else {
      journalTypes = this._context['default_moveJournalTypes'] ?? ['general'];
    }

    let journal;
    if (this._context['default_journalId']) {
      journal = this.env.items('account.journal').browse(this._context['default_journalId']);
      const type = await journal.type;
      if (moveType !== 'entry' && !journalTypes.includes(type)) {
        throw new UserError(_f(await this._t(
          "Cannot create an invoice of type {moveType} with a journal having {journalType} as type."), {
          moveType: moveType,
          journalType: type,
        }));
      }
    }
    else {
      journal = await this._searchDefaultJournal(journalTypes);
    }

    return journal;
  }

  /**
   * Get the default currency from either the journal, either the default journal's company.
   */
  @api.model()
  async _getDefaultCurrency(): Promise<ModelRecords> {
    const journal = await this._getDefaultJournal();
    const [currencyId, companyId] = await journal('currencyId', 'companyId');
    return currencyId.ok ? currencyId : await companyId.currencyId;
  }

  /**
   * Get the default incoterm for invoice.
   */
  @api.model()
  async _getDefaultInvoiceIncoterm() {
    return (await this.env.company()).incotermId;
  }

  @api.model()
  async _fieldWillChange(record: ModelRecords, vals, fieldName) {
    if (!(fieldName in vals)) {
      return false;
    }
    const field: Field = record._fields[fieldName];
    const fieldValue = await record[fieldName];
    if (field.type === 'many2one') {
      return fieldValue.id !== vals[fieldName];
    }
    if (field.type === 'many2many') {
      const currentIds = fieldValue.ids;
      const afterWriteIds = (await (await record.new({ [fieldName]: vals[fieldName] }))[fieldName]).ids;
      return _.difference(currentIds, afterWriteIds).length
    }
    if (field.type === 'one2many') {
      return true;
    }
    if (field.type === 'monetary' && bool(await record[field.getCurrencyField(record)])) {
      return ! await (await record[field.getCurrencyField(record)]).isZero(fieldValue - vals[fieldName]);
    }
    if (field.type === 'float') {
      const recordValue = await field.convertToCache(fieldValue, record);
      const toWriteValue = await field.convertToCache(vals[fieldName], record);
      return recordValue != toWriteValue;
    }
    return fieldValue != vals[fieldName];
  }

  @api.model()
  async _cleanupWriteOrmValues(record, vals) {
    const cleanedVals = Object.assign({}, vals);
    for (const [fieldName, value] of Object.entries(vals)) {
      if (! await this._fieldWillChange(record, vals, fieldName)) {
        delete cleanedVals[fieldName];
      }
    }
    return cleanedVals;
  }

  // ONCHANGE METHODS

  /**
   * Get correct accounting date for previous periods, taking tax lock date into account.
 
      When registering an invoice in the past, we still want the sequence to be increasing.
      We then take the last day of the period, depending on the sequence format.
      If there is a tax lock date and there are taxes involved, we register the invoice at the
      last date of the first open period.
 
      :param invoice_date (datetime.date): The invoice date
      :param has_tax (bool): Iff any taxes are involved in the lines of the invoice
      :return (datetime.date):
   */
  async _getAccountingDate(invoiceDate, hasTax) {
    const lockDates = await this._getViolatedLockDates(invoiceDate, hasTax);
    const today = _Date.today();
    const highestName = await this['highestName'] ?? await (this as any)._getLastSequence(true, false);
    const numberReset = await (this as any)._deduceSequenceNumberReset(highestName);

    if (bool(lockDates)) {
      invoiceDate = DateTime.fromJSDate(lockDates.slice(0, -1)[0]).plus({ days: 1 }).toJSDate();
    }
    if (await this.isSaleDocument(true)) {
      if (bool(lockDates)) {
        if (!highestName || numberReset === 'month') {
          return Math.min(today.valueOf(), getMonth(invoiceDate)[1].valueOf());
        }
        else if (numberReset === 'year') {
          return Math.min(today.valueOf(), DateTime.fromJSDate(invoiceDate).endOf('year').valueOf());
        }
      }
    }
    else {
      if (!highestName || numberReset === 'month') {
        if (new Date(today.getFullYear(), today.getMonth()) > new Date(invoiceDate.getFullYear(), invoiceDate.getMonth())) {
          return getMonth(invoiceDate)[1];
        }
        else {
          return invoiceDate > today ? invoiceDate : today;
        }
      }
      else if (numberReset === 'year') {
        if (today.getFullYear() > invoiceDate.getFullYear()) {
          return new Date(invoiceDate.getFullYear, 11, 31);
        }
        else {
          return invoiceDate > today ? invoiceDate : today;
        }
      }
    }
    return invoiceDate;
  }

  /**
   * Get all the lock dates affecting the current invoice_date.

        :param invoice_date: The invoice date
        :param has_tax: If any taxes are involved in the lines of the invoice
        :return: a list of tuples containing the lock dates affecting this move, ordered chronologically.
   * @param invoiceDate 
   * @param hasTax 
   */
  async _getViolatedLockDates(invoiceDate: any, hasTax: any) {
    const locks = [];
    const userLockDate = await (await this['companyId'])._getUserFiscalLockDate();
    if (invoiceDate && userLockDate && invoiceDate <= userLockDate) {
      locks.push([userLockDate, await this._t('user')]);
    }
    const taxLockDate = await (await this['companyId']).taxLockDate;
    if (invoiceDate && taxLockDate && hasTax && invoiceDate <= taxLockDate) {
      locks.push([taxLockDate, await this._t('tax')]);
    }
    locks.sort();
    return locks;
  }

  @api.onchange('invoiceDate', 'highestName', 'companyId')
  async _onchangeInvoiceDate() {
    const invoiceDate = await this['invoiceDate'];
    if (invoiceDate) {
      const [invoiceDateDue, invoicePaymentTermId, lineIds, date] = await this('invoiceDateDue', 'invoicePaymentTermId', 'lineIds', 'date');
      if (!bool(invoicePaymentTermId) && (!invoiceDateDue || invoiceDateDue < invoiceDate)) {
        await this.set('invoiceDateDue', invoiceDate);
      }
      const [taxIds, taxTagIds] = await lineIds('taxIds', 'taxTagIds');
      const hasTax = taxIds.ok || taxTagIds.ok;
      const accountingDate = await this._getAccountingDate(invoiceDate, hasTax);
      if (accountingDate != date) {
        await this.set('date', accountingDate);
        await this._onchangeCurrency();
      }
      else {
        await this._onchangeRecomputeDynamicLines();
      }
    }
  }

  @api.onchange('journalId')
  async _onchangeJournal() {
    const [journalId, state, label] = await this('journalId', 'state', 'label');
    const currencyId = await journalId.currencyId;
    if (journalId.ok && currencyId.ok) {
      if (!currencyId.eq(await this['currencyId'])) {
        await this.set('currencyId', currencyId);
        await this._onchangeCurrency();
      }
    }
    if (state === 'draft' && await (this as any)._getLastSequence() && label && label !== '/') {
      await this.set('label', '/');
    }
  }

  @api.onchange('partnerId')
  async _onchangePartnerId() {
    const self = await this.withCompany(await (await this['journalId']).companyId);

    let warning = {}
    let partnerId = await self['partnerId'];
    if (partnerId.ok) {
      const [recAccount, payAccount] = await partnerId('propertyAccountReceivableId', 'propertyAccountPayableId');
      if (!bool(recAccount) && !bool(payAccount)) {
        const action = await self.env.ref('account.actionAccountConfig');
        const msg = await this._t('Cannot find a chart of accounts for this company, You should configure it. \nPlease go to Account Configuration.');
        throw new RedirectWarning(msg, action.id, await this._t('Go to the configuration panel'));
      }
      let partner = partnerId;
      if (await partner.invoiceWarn === 'no-message' && (await partner.parentId).ok) {
        partner = await partner.parentId;
      }
      const invoiceWarn = await partner.invoiceWarn;
      if (invoiceWarn && invoiceWarn !== 'no-message') {
        const partnerParentId = await partner('parentId');
        // Block if partner only has warning but parent company is blocked
        if (invoiceWarn !== 'block' && partnerParentId.ok && await partnerParentId.invoiceWarn === 'block') {
          partner = partnerParentId;
        }
        warning = {
          'title': await this._t("Warning for %s", await partner.label),
          'message': await partner.invoiceWarnMsg
        }
        if (await partner.invoiceWarn === 'block') {
          await self.set('partnerId', false);
          return { 'warning': warning };
        }
      }
    }
    let newTermAccount;
    partnerId = await self['partnerId'];
    if (await self.isSaleDocument(true) && partnerId.ok) {
      const [propertyPaymentTermId, commercialPartnerId] = await partnerId('propertyPaymentTermId', 'commercialPartnerId');
      await self.set('invoicePaymentTermId', propertyPaymentTermId.ok ? propertyPaymentTermId : await self.invoicePaymentTermId);
      newTermAccount = await commercialPartnerId.propertyAccountReceivableId;
    }
    else if (await self.isPurchaseDocument(true) && partnerId.ok) {
      const [propertySupplierPaymentTermId, commercialPartnerId] = await partnerId('propertySupplierPaymentTermId', 'commercialPartnerId');
      await self.set('invoicePaymentTermId', propertySupplierPaymentTermId.ok ? propertySupplierPaymentTermId : await self.invoicePaymentTermId);
      newTermAccount = await commercialPartnerId.propertyAccountPayableId;
    }
    else {
      newTermAccount = null;
    }

    for (const line of await self.lineIds) {
      await line.set('partnerId', await partnerId.commercialPartnerId);

      if (bool(newTermAccount) && ['receivable', 'payable'].includes(await (await (await line.accountId).userTypeId).type)) {
        await line.set('accountId', newTermAccount);
      }
    }
    await self._computeBankPartnerId();
    const bankIds = await (await (await self.bankPartnerId).bankIds).filtered(async (bank) => {
      const companyId = await bank.companyId;
      return companyId === false || companyId.eq(await self.companyId);
    });
    await self.set('partnerBankId', bankIds.ok && bankIds[0]);

    // Find the new fiscal position.
    const deliveryPartnerId = await self._getInvoiceDeliveryPartnerId();
    await self.set('fiscalPositionId', await self.env.items('account.fiscal.position').getFiscalPosition(partnerId.id, deliveryPartnerId));
    await self._recomputeDynamicLines();
    if (bool(warning)) {
      return { 'warning': warning }
    }
  }

  @api.onchange('date', 'currencyId')
  async _onchangeCurrency() {
    let currency = await this['currencyId'];
    currency = currency.ok ? currency : await (await this['companyId']).currencyId;

    if (await this.isInvoice(true)) {
      for (const line of await this._getLinesOnchangeCurrency()) {
        await line.set('currencyId', currency);
        await line._onchangeCurrency();
      }
    }
    else {
      for (const line of await this['lineIds']) {
        await line._onchangeCurrency();
      }
    }
    await this._recomputeDynamicLines(false, true);
  }

  @api.onchange('paymentReference')
  async _onchangePaymentReference() {
    for (const line of await (await this['lineIds']).filtered(async (line) => ['receivable', 'payable'].includes(await (await (await line.accountId).userTypeId).type))) {
      await line.set('label', await this['paymentReference'] || '');
    }
  }

  @api.onchange('invoiceVendorBillId')
  async _onchangeInvoiceVendorBill() {
    const [invoiceVendorBillId, currencyId] = await this('invoiceVendorBillId', 'currencyId');
    if (invoiceVendorBillId.ok) {
      // Copy invoice lines.
      for (const line of await invoiceVendorBillId.invoiceLineIds) {
        const copiedVals = (await line.copyData())[0];
        copiedVals['moveId'] = this.id;
        const newLine = await this.env.items('account.move.line').new(copiedVals);
        await newLine.set('recomputeTaxLine', true);
      }
      // Copy payment terms.
      await this.set('invoicePaymentTermId', await invoiceVendorBillId.invoicePaymentTermId);

      // Copy currency.
      const invoiceCurrencyId = await invoiceVendorBillId.currencyId;
      if (!currencyId.eq(invoiceCurrencyId)) {
        await this.set('currencyId', invoiceCurrencyId);
      }
      // Reset
      await this.set('invoiceVendorBillId', false);
      await this._recomputeDynamicLines();
    }
  }

  @api.onchange('invoiceLineIds')
  async _onchangeInvoiceLineIds() {
    const [lineIds, invoiceLineIds] = await this('lineIds', 'invoiceLineIds');
    const currentInvoiceLines = await lineIds.filtered(async (line) => !await line.excludeFromInvoiceTab);
    const othersLines = lineIds.sub(currentInvoiceLines);
    if (othersLines.ok && currentInvoiceLines.sub(invoiceLineIds).ok) {
      await othersLines[0].set('recomputeTaxLine', true);
    }
    await this.set('lineIds', othersLines.add(invoiceLineIds));
    await this._onchangeRecomputeDynamicLines();
  }

  @api.onchange('lineIds', 'invoicePaymentTermId', 'invoiceDateDue', 'invoiceCashRoundingId', 'invoiceVendorBillId')
  async _onchangeRecomputeDynamicLines() {
    await this._recomputeDynamicLines();
  }

  /**
    * This method is triggered by the tax group widget. It allows modifying the right
          move lines depending on the tax group whose amount got edited.
    */
  @api.onchange('taxTotalsJson')
  async _onchangeTaxTotalsJson() {
    for (const move of this) {
      if (! await move.isInvoice(true)) {
        continue;
      }

      const invoiceTotals = JSON.parse(await move.taxTotalsJson);
      for (const amountByGroupList of Object.values<any>(invoiceTotals['groupsBySubtotal'])) {
        for (const amountByGroup of amountByGroupList) {
          const taxLines = await (await move.lineIds).filtered(async (line) => (await line.taxGroupId).id == amountByGroup['taxGroupId']);

          if (taxLines.ok) {
            const firstTaxLine = taxLines[0];
            const taxGroupOldAmount = sum(await taxLines.mapped('amountCurrency'));
            const sign = await move.isInbound() ? -1 : 1;
            const deltaAmount = taxGroupOldAmount * sign - amountByGroup['taxGroupAmount'];

            if (! await (await move.currencyId).isZero(deltaAmount)) {
              await firstTaxLine.set('amountCurrency', await firstTaxLine.amountCurrency - deltaAmount * sign);
              // We have to trigger the on change manually because we don"t change the value of
              // amount_currency in the view.
              await firstTaxLine._onchangeAmountCurrency();
            }
          }
        }
      }
      await move._recomputeDynamicLines();
    }
  }

  @api.onchange('invoiceCashRoundingId')
  async _onchangeInvoiceCashRoundingId() {
    for (const move of this) {
      const invoiceCashRoundingId = await move.invoiceCashRoundingId;
      if (await invoiceCashRoundingId.strategy == 'addInvoiceLine' && !bool(await invoiceCashRoundingId.profitAccountId)) {
        return {
          'warning': {
            'title': await this._t("Warning for Cash Rounding Method: %s", await invoiceCashRoundingId.label),
            'message': await this._t("You must specify the Profit Account (company dependent)")
          }
        }
      }
    }
  }

  /**
    * Create the dictionary based on a tax line that will be used as key to group taxes together.
      /!\ Must be consistent with '_getTaxGroupingKeyFromBaseLine'.
      :param taxLine:    An account.move.line being a tax line (with 'taxRepartitionLineId' set then).
      :return:            A dictionary containing all fields on which the tax will be grouped.
    * @param taxLine 
    * @returns 
    */
  @api.model()
  async _getTaxGroupingKeyFromTaxLine(taxLine) {
    const [taxRepartitionLineId, groupTaxId, accountId, currencyId, taxLineId, analyticTagIds, analyticAccountId, taxTagIds, taxIds] = await taxLine('taxRepartitionLineId', 'groupTaxId', 'accountId', 'currencyId', 'taxLineId', 'analyticTagIds', 'analyticAccountId', 'taxTagIds', 'taxIds');
    return {
      'taxRepartitionLineId': taxRepartitionLineId.id,
      'groupTaxId': groupTaxId.id,
      'accountId': accountId.id,
      'currencyId': currencyId.id,
      'analyticTagIds': [[6, 0, await taxLineId.analytic && analyticTagIds.ids || []]],
      'analyticAccountId': await taxLineId.analytic && analyticAccountId.id,
      'taxIds': [[6, 0, taxIds.ids]],
      'taxTagIds': [[6, 0, taxTagIds.ids]],
    }
  }

  /**
    * Create the dictionary based on a base line that will be used as key to group taxes together.
      /!\ Must be consistent with '_get_tax_grouping_key_from_tax_line'.
      :param baseLine:   An account.move.line being a base line (that could contains something in 'taxIds').
      :param taxVals:    An element of computeAll(...)['taxes'].
      :return:            A dictionary containing all fields on which the tax will be grouped.
    * @param baseLine 
    * @param taxVals 
    * @returns 
    */
  @api.model()
  async _getTaxGroupingKeyFromBaseLine(baseLine, taxVals) {
    const taxRepartitionLine = this.env.items('account.tax.repartition.line').browse(taxVals['taxRepartitionLineId']);
    let account = await baseLine._getDefaultTaxAccount(taxRepartitionLine);
    account = account.ok ? account : await baseLine.accountId;
    const [currencyId, analyticTagIds, analyticAccountId] = await baseLine('currencyId', 'analyticTagIds', 'analyticAccountId');
    return {
      'taxRepartitionLineId': await taxVals['taxRepartitionLineId'],
      'groupTaxId': bool(await taxVals['group']) ? (await taxVals['group']).id : false,
      'accountId': account.id,
      'currencyId': currencyId.id,
      'analyticTagIds': [[6, 0, bool(await taxVals['analytic']) && analyticTagIds.ids || []]],
      'analyticAccountId': bool(await taxVals['analytic']) && analyticAccountId.id,
      'taxIds': [[6, 0, await taxVals['taxIds']]],
      'taxTagIds': [[6, 0, await taxVals['tagIds']]],
    }
  }

  /**
    * The sign must be forced to a negative sign in case the balance is on credit
      to avoid negatif taxes amount.
      Example - Customer Invoice :
      Fixed Tax  |  unit price  |   discount   |  amountTax  | amountTotal |
      -------------------------------------------------------------------------
          0.67   |      115     |     100%     |   - 0.67    |      0
      -------------------------------------------------------------------------
    * @returns 
    */
  async _getTaxForceSign() {
    this.ensureOne();
    return ['outInvoice', 'inRefund', 'outReceipt'].includes(await this['moveType']) ? -1 : 1;
  }

  /**
    * Useful in case we want to pre-process taxesMap
    * @param taxesMap 
    * @returns 
    */
  async _preprocessTaxesMap(taxesMap) {
    return taxesMap;
  }

  /**
   * Compute the dynamic tax lines of the journal entry.
 
    :param linesMap: The lineIds dispatched by type containing:
        * baseLines: The lines having a taxIds set.
        * taxLines: The lines having a taxLineId set.
        * termsLines: The lines generated by the payment terms of the invoice.
        * roundingLines: The cash rounding lines of the invoice.
    * @param recomputeTaxBaseAmount 
    * @returns 
    */
  async _recomputeTaxLines(recomputeTaxBaseAmount: boolean = false, taxRepLinesToRecompute?: any[]) {
    /**
     * Serialize the dictionary values to be used in the taxes_map.
     * d = {
        'id': 4,
        'label': "Value Added Tax (VAT) 10%",
        'amount': -32,
        'base': -320,
        'sequence': 1,
        'accountId': 108,
        'analytic': False,
        'priceInclude': False,
        'taxExigibility': "onInvoice",
        'taxRepartitionLineId': 8,
        'group': None,
        'tagIds': [
          26,
        ],
        'taxIds': [
        ],
      }

      r = Object.values(d).map(v => typeof v !== 'object' ? String(v) : JSON.stringify(v)).join('-')
      ==> 4-Value Added Tax (VAT) 10%--32--320-1-108-false-false-onInvoice-8-undefined-[26]-[]

      * @param dict The values returned by '_getTaxGroupingKeyFromTaxLine' or '_getTaxGroupingKeyFromBaseLine'.
      * @returns A string representing the values.
      */
    function _serializeTaxGroupingKey(dict) {
      return Object.values(dict).map(v => typeof v !== 'object' ? String(v) : JSON.stringify(v)).join('-');
    }

    /**
     * Compute taxes amounts both in company currency / foreign currency as the ratio between
        amount_currency & balance could not be the same as the expected currency rate.
        The 'amountCurrency' value will be set on computeAll(...)['taxes'] in multi-currency.
        :param baseLine:   The account.move.line owning the taxes.
        :return:           The result of the computeAll method.
      * @param baseLine 
      */
    async function _computeBaseLineTaxes(baseLine) {
      const [move, priceUnit, discount, taxIds, debit, credit, amountCurrency, currencyId, productId, partnerId] = await baseLine('moveId', 'priceUnit', 'discount', 'taxIds', 'debit', 'credit', 'amountCurrency', 'currencyId', 'productId', 'partnerId');
      let handlePriceInclude, priceUnitWoDiscount, isRefund, quantity;
      if (await move.isInvoice(true)) {
        handlePriceInclude = true;
        quantity = await baseLine.quantity;
        const sign = await move.isInbound() ? -1 : 1;
        isRefund = ['outRefund', 'inRefund'].includes(await move.moveType);
        priceUnitWoDiscount = sign * priceUnit * (1 - (discount / 100.0));
      }
      else {
        handlePriceInclude = false;
        quantity = 1.0;
        const taxType = taxIds.ok ? await taxIds[0].typeTaxUse : null;
        isRefund = (taxType === 'sale' && debit) || (taxType === 'purchase' && credit);
        priceUnitWoDiscount = amountCurrency;
      }

      return (await taxIds._origin.withContext({ forceSign: await move._getTaxForceSign() })).computeAll(
        priceUnitWoDiscount,
        {
          currency: currencyId,
          quantity: quantity,
          product: productId,
          partner: partnerId,
          isRefund: isRefund,
          handlePriceInclude: handlePriceInclude,
          includeCabaTags: await move.alwaysTaxExigible,
        }
      )
    }

    this.ensureOne();
    const inDraftMode = !this.eq(this._origin);
    let taxesMap = {};

    // ==== Add tax lines ====
    const lineIds = await this('lineIds');

    let toRemove = this.env.items('account.move.line');

    for (const line of await lineIds.filtered('taxRepartitionLineId')) {
      const groupingDict = await this._getTaxGroupingKeyFromTaxLine(line);
      const groupingKey = _serializeTaxGroupingKey(groupingDict);
      if (groupingKey in taxesMap) {
        // A line with the same key does already exist, we only need one
        // to modify it; we have to drop this one.
        toRemove = toRemove.add(line);
      }
      else {
        taxesMap[groupingKey] = {
          'taxLine': line,
          'amount': 0.0,
          'taxBaseAmount': 0.0,
          'groupingDict': false,
        }
      }
    }
    if (!recomputeTaxBaseAmount) {
      await this.set('lineIds', lineIds.sub(toRemove));
    }

    // ==== Mount base lines ====
    for (const line of await lineIds.filtered(async (line) => !bool(await line.taxRepartitionLineId))) {
      // Don't call computeAll if there is no tax.
      if (!(await line.taxIds).ok) {
        if (!recomputeTaxBaseAmount) {
          await line.set('taxTagIds', [[5, 0, 0]]);
        }
        continue;
      }

      const computeAllVals = await _computeBaseLineTaxes(line);

      // Assign tags on base line
      if (!recomputeTaxBaseAmount) {
        await line.set('taxTagIds', computeAllVals['baseTags'] ?? [[5, 0, 0]]);
      }
      for (const taxVals of computeAllVals['taxes']) {
        const groupingDict = await this._getTaxGroupingKeyFromBaseLine(line, taxVals);
        const groupingKey = _serializeTaxGroupingKey(groupingDict);

        const taxRepartitionLine = this.env.items('account.tax.repartition.line').browse(taxVals['taxRepartitionLineId']);
        let tax = await taxRepartitionLine.invoiceTaxId;
        tax = tax.ok ? tax : await taxRepartitionLine.refundTaxId;

        const taxesMapEntry = setdefault(taxesMap, groupingKey, {
          'taxLine': null,
          'amount': 0.0,
          'taxBaseAmount': 0.0,
          'groupingDict': false,
        });
        taxesMapEntry.amount += taxVals['amount'];
        taxesMapEntry.taxBaseAmount += await this._getBaseAmountToDisplay(taxVals['base'], taxRepartitionLine, taxVals['group']);
        taxesMapEntry.groupingDict = groupingDict;
      }
    }

    // ==== Pre-process taxes_map ====
    taxesMap = await this._preprocessTaxesMap(taxesMap);
    // ==== Process taxes_map ====
    for (const taxesMapEntry of Object.values<TaxesMapEntry>(taxesMap)) {
      // The tax line is no longer used in any base lines, drop it.
      if (bool(taxesMapEntry.taxLine) && !bool(taxesMapEntry.groupingDict)) {
        if (!recomputeTaxBaseAmount) {
          await this.set('lineIds', lineIds.sub(taxesMapEntry.taxLine));
        }
        continue;
      }
      const currency = this.env.items('res.currency').browse(taxesMapEntry.groupingDict['currencyId']);

      // Don't create tax lines with zero balance.
      if (await currency.isZero(taxesMapEntry.amount)) {
        if (bool(taxesMapEntry.taxLine) && !recomputeTaxBaseAmount) {
          await this.set('lineIds', lineIds.sub(taxesMapEntry.taxLine));
        }
        continue;
      }

      // taxBaseAmount field is expressed using the company currency.
      const [companyId, companyCurrencyId, date] = await this('companyId', 'companyCurrencyId', 'date');
      const taxBaseAmount = await currency._convert(taxesMapEntry.taxBaseAmount, companyCurrencyId, companyId, date || await _Date.contextToday(this));

      // Recompute only the taxBaseAmount.
      if (recomputeTaxBaseAmount) {
        if (bool(taxesMapEntry.taxLine)) {
          await taxesMapEntry.taxLine.set('taxBaseAmount', taxBaseAmount);
        }
        continue;
      }

      const balance = await currency._convert(
        taxesMapEntry.amount,
        companyCurrencyId,
        companyId,
        date || await _Date.contextToday(this),
      )
      const amountCurrency = await currency.round(taxesMapEntry.amount);
      const sign = await this.isInbound() ? -1 : 1
      const toWriteOnLine = {
        'amountCurrency': taxesMapEntry.amount,
        'currencyId': taxesMapEntry.groupingDict['currencyId'],
        'debit': balance > 0.0 && balance || 0.0,
        'credit': balance < 0.0 && -balance || 0.0,
        'taxBaseAmount': taxBaseAmount,
        'priceTotal': sign * amountCurrency,
        'priceSubtotal': sign * amountCurrency,
      }

      if (bool(taxesMapEntry.taxLine)) {
        // Update an existing tax line.
        if (bool(taxRepLinesToRecompute) && !taxRepLinesToRecompute.includes(await taxesMapEntry.taxLine.taxRepartitionLineId)) {
          continue;
        }

        await taxesMapEntry.taxLine.update(toWriteOnLine);
      }
      else {
        // Create a new tax line.
        const model = this.env.items('account.move.line');
        const createMethod = inDraftMode && model.new || model.create;
        const taxRepartitionLineId = taxesMapEntry.groupingDict['taxRepartitionLineId'];
        const taxRepartitionLine = this.env.items('account.tax.repartition.line').browse(taxRepartitionLineId);

        if (bool(taxRepLinesToRecompute) && !taxRepLinesToRecompute.includes(taxRepartitionLine)) {
          continue;
        }

        let tax = await taxRepartitionLine.invoiceTaxId;
        tax = tax.ok ? tax : await taxRepartitionLine.refundTaxId;
        taxesMapEntry.taxLine = await createMethod.call(model, {
          ...toWriteOnLine,
          'label': await tax.label,
          'moveId': this.id,
          'companyId': companyId.id,
          'companyCurrencyId': companyCurrencyId.id,
          'taxBaseAmount': taxBaseAmount,
          'excludeFromInvoiceTab': true,
          ...taxesMapEntry.groupingDict,
        })
      }
      if (inDraftMode) {
        await taxesMapEntry.taxLine.update(await taxesMapEntry.taxLine._getFieldsOnchangeBalance({ forceComputation: true }));
      }
    }
  }

  /**
   * The base amount returned for taxes by computeAll has is the balance
      of the base line. For inbound operations, positive sign is on credit, so
      we need to invert the sign of this amount before displaying it.
    * @param baseAmount 
    * @param taxRepLn 
    * @param parentTaxGroup 
    * @returns 
    */
  @api.model()
  async _getBaseAmountToDisplay(baseAmount, taxRepLn, parentTaxGroup?: any) {
    const [invoiceTaxId, refundTaxId] = await taxRepLn('invoiceTaxId', 'refundTaxId');
    let sourceTax = parentTaxGroup;
    sourceTax = bool(sourceTax) ? sourceTax : invoiceTaxId;
    sourceTax = bool(sourceTax) ? sourceTax : refundTaxId;
    if ((invoiceTaxId.ok && await sourceTax.typeTaxUse === 'sale')
      || (refundTaxId.ok && await sourceTax.typeTaxUse === 'purchase')) {
      return -baseAmount;
    }
    return baseAmount;
  }

  /**
   * Handle the cash rounding feature on invoices.
        
      In some countries, the smallest coins do not exist. For example, in Switzerland, there is no coin for 0.01 CHF.
      For this reason, if invoices are paid in cash, you have to round their total amount to the smallest coin that
      exists in the currency. For the CHF, the smallest coin is 0.05 CHF.

      There are two strategies for the rounding:

      1) Add a line on the invoice for the rounding: The cash rounding line is added as a new invoice line.
      2) Add the rounding in the biggest tax amount: The cash rounding line is added as a new tax line on the tax
      having the biggest balance.
   * @returns 
   */
  async _recomputeCashRoundingLines() {
    this.ensureOne();
    let inDraftMode = !this.eq(this._origin);
    const [lineIds, invoiceCashRoundingId, partnerId, currencyId, companyId, date] = await this('lineIds', 'invoiceCashRoundingId', 'partnerId', 'currencyId', 'companyId', 'date');
    /**
     * Compute the amount differences due to the cash rounding.
        :param self:                    The current account.move record.
        :param total_amount_currency:   The invoice's total in invoice's currency.
        :return:                        The amount differences both in company's currency & invoice's currency.
     * @param totalAmountCurrency 
     * @returns 
     */
    async function _computeCashRounding(totalAmountCurrency) {
      let difference = await invoiceCashRoundingId.computeDifference(currencyId, totalAmountCurrency);
      let diffAmountCurrency, diffBalance;
      if (currencyId.eq(await companyId.currencyId)) {
        diffAmountCurrency = diffBalance = difference;
      }
      else {
        diffAmountCurrency = difference;
        diffBalance = await currencyId._convert(diffAmountCurrency, await companyId.currencyId, companyId, date)
      }
      return [diffBalance, diffAmountCurrency];
    }

    /**
     * Apply the cash rounding.
        :param self:                    The current account.move record.
        :param diff_balance:            The computed balance to set on the new rounding line.
        :param diff_amount_currency:    The computed amount in invoice's currency to set on the new rounding line.
        :param cash_rounding_line:      The existing cash rounding line.
        :return:                        The newly created rounding line.
     * @param self 
     * @param diffBalance 
     * @param diffAmountCurrency 
     * @param cashRoundingLine 
     */
    async function _applyCashRounding(diffBalance, diffAmountCurrency, cashRoundingLine) {
      const roundingLineVals = {
        'debit': diffBalance > 0.0 && diffBalance || 0.0,
        'credit': diffBalance < 0.0 && -diffBalance || 0.0,
        'quantity': 1.0,
        'amountCurrency': diffAmountCurrency,
        'partnerId': partnerId.id,
        'moveId': this.id,
        'currencyId': currencyId.id,
        'companyId': companyId.id,
        'companyCurrencyId': (await companyId.currencyId).id,
        'isRoundingLine': true,
        'sequence': 9999,
      }

      const strategy = await invoiceCashRoundingId.strategy;
      if (strategy === 'biggestTax') {
        let biggestTaxLine;// = None
        for (const taxLine of await lineIds.filtered('taxRepartitionLineId')) {
          if (!bool(biggestTaxLine) || await taxLine.priceSubtotal > await biggestTaxLine.priceSubtotal) {
            biggestTaxLine = taxLine;
          }
        }
        // No tax found.
        if (!bool(biggestTaxLine)) {
          return;
        }

        const [label, accountId, taxRepartitionLineId] = await biggestTaxLine('label', 'accountId', 'taxRepartitionLineId');
        update(roundingLineVals, {
          'label': await this._t('%s (rounding)', label),
          'accountId': accountId.id,
          'taxRepartitionLineId': taxRepartitionLineId.id,
          'excludeFromInvoiceTab': true,
        })
      }
      else if (strategy === 'addInvoiceLine') {
        let accountId;
        if (diffBalance > 0.0 && bool(await invoiceCashRoundingId.lossAccountId)) {
          accountId = (await invoiceCashRoundingId.lossAccountId).id;
        }
        else {
          accountId = (await invoiceCashRoundingId.profitAccountId).id;
        }
        update(roundingLineVals, {
          'label': await invoiceCashRoundingId.label,
          'accountId': accountId,
        })
      }
      // Create or update the cash rounding line.
      if (bool(cashRoundingLine)) {
        update(cashRoundingLine, {
          'amountCurrency': roundingLineVals['amountCurrency'],
          'debit': roundingLineVals['debit'],
          'credit': roundingLineVals['credit'],
          'accountId': roundingLineVals['accountId'],
        })
      }
      else {
        const model = this.env.items('account.move.line');
        const createMethod = inDraftMode && model.new || model.create;
        cashRoundingLine = await createMethod.call(model, roundingLineVals);
      }

      if (inDraftMode) {
        await cashRoundingLine.update(await cashRoundingLine._getFieldsOnchangeBalance({ forceComputation: true }));
      }
    }

    let existingCashRoundingLine = await lineIds.filtered((line) => line.isRoundingLine);

    // The cash rounding has been removed.
    if (!invoiceCashRoundingId.ok) {
      await this.set('lineIds', lineIds.sub(existingCashRoundingLine));
      return;
    }

    // The cash rounding strategy has changed.
    if (invoiceCashRoundingId.ok && existingCashRoundingLine.ok) {
      const strategy = await invoiceCashRoundingId.strategy;
      const oldStrategy = (await existingCashRoundingLine.taxLineId).ok ? 'biggestTax' : 'addInvoiceLine';
      if (strategy !== oldStrategy) {
        await this.set('lineIds', lineIds.sub(existingCashRoundingLine));
        existingCashRoundingLine = this.env.items('account.move.line');
      }
    }

    let othersLines = await lineIds.filtered(async (line) => ['receivable', 'payable'].includes(await (await (await line.accountId).userTypeId).type));
    othersLines = othersLines.sub(existingCashRoundingLine);
    const totalAmountCurrency = sum(await othersLines.mapped('amountCurrency'));

    const [diffBalance, diffAmountCurrency] = await _computeCashRounding(totalAmountCurrency);

    /// The invoice is already rounded.
    if (await currencyId.isZero(diffBalance) && await currencyId.isZero(diffAmountCurrency)) {
      await this.set('lineIds', lineIds.sub(existingCashRoundingLine));
      return;
    }

    await _applyCashRounding(diffBalance, diffAmountCurrency, existingCashRoundingLine);
  }

  /**
   * Compute the dynamic payment term lines of the journal entry.
   * @returns 
   */
  async _recomputePaymentTermsLines() {
    this.ensureOne();
    let self: any = this;
    self = await self.withCompany(await self['companyId']);
    const inDraftMode = !self.eq(self._origin);
    const today = await _Date.contextToday(self);
    self = await self.withCompany(await (await self['journalId']).companyId);

    /**
     * Get the date from invoice that will be used to compute the payment terms.
        :param self:    The current account.move record.
        :return:        A datetime.date object.
     * @returns 
     */
    async function _getPaymentTermsComputationDate(self) {
      if (await self.invoicePaymentTermId) {
        return await self.invoiceDate || today;
      }
      else {
        return await self.invoiceDateDue || await self.invoiceDate || today;
      }
    }

    /**
     * Get the account from invoice that will be set as receivable / payable account.
        :param self:                    The current account.move record.
        :param payment_terms_lines:     The current payment terms lines.
        :return:                        An account.account record.
     * @param paymentTermsLines 
     * @returns 
     */
    async function _getPaymentTermsAccount(self, paymentTermsLines) {
      const partnerId = await self.partnerId;
      if (bool(paymentTermsLines)) {
        // Retrieve account from previous payment terms lines in order to allow the user to set a custom one.
        return paymentTermsLines[0].accountId;
      }
      else if (partnerId.ok) {
        // Retrieve account from partner.
        if (await self.isSaleDocument(true)) {
          return partnerId.propertyAccountReceivableId;
        }
        else {
          return partnerId.propertyAccountPayableId;
        }
      }
      else {
        // Search new account.
        const domain = [
          ['companyId', '=', (await self.companyId).id],
          ['internalType', '=', ['outInvoice', 'outRefund', 'outReceipt'].includes(await self.moveType) ? 'receivable' : 'payable'],
        ]
        return self.env.items('account.account').search(domain, { limit: 1 });
      }
    }

    /**
     * Compute the payment terms.
        :param self:                    The current account.move record.
        :param date:                    The date computed by '_get_payment_terms_computation_date'.
        :param total_balance:           The invoice's total in company's currency.
        :param total_amount_currency:   The invoice's total in invoice's currency.
        :return:                        A list <to_pay_company_currency, to_pay_invoice_currency, due_date>.
     * @param date 
     * @param totalBalance 
     * @param totalAmountCurrency 
     */
    async function _computePaymentTerms(self, date, totalBalance, totalAmountCurrency) {
      const invoicePaymentTermId = await self.invoicePaymentTermId;
      if (bool(invoicePaymentTermId)) {
        const [companyId, currencyId] = await self('companyId', 'currencyId')
        const toCompute = await invoicePaymentTermId.compute(totalBalance, date, await companyId.currencyId);
        if (currencyId.eq(await companyId.currencyId)) {
          // Single-currency.
          return toCompute.map(b => [b[0], b[1], b[1]]);
        }
        else {
          // Multi-currencies.
          const toComputeCurrency = await invoicePaymentTermId.compute(totalAmountCurrency, date, currencyId);
          return _.zip<any, any>(toCompute, toComputeCurrency).map(([b, ac]) => [b[0], b[1], ac[1]]);
        }
      }
      else {
        return [[_Date.toString(date), totalBalance, totalAmountCurrency]];
      }
    }

    /**
     * Process the result of the '_computePaymentTerms' method and creates/updates corresponding invoice lines.
        :param self:                    The current account.move record.
        :param existing_terms_lines:    The current payment terms lines.
        :param account:                 The account.account record returned by '_get_payment_terms_account'.
        :param to_compute:              The list returned by '_computePaymentTerms'.
     * @param existingTermsLines 
     * @param account 
     * @param toCompute 
     */
    async function _computeDiffPaymentTermsLines(self, existingTermsLines, account, toCompute) {
      // As we try to update existing lines, sort them by due date.
      existingTermsLines = await existingTermsLines.sorted(async (line) => await line.dateMaturity || today)
      let existingTermsLinesIndex = 0;

      // Recompute amls: update existing line or create new one for each payment term.
      let newTermsLines = self.env.items('account.move.line');
      for (const [dateMaturity, balance, amountCurrency] of toCompute) {
        const currency = await (await (await self['journalId']).companyId).currencyId;
        if (currency.ok && await currency.isZero(balance) && len(toCompute) > 1) {
          continue;
        }
        let candidate;
        if (existingTermsLinesIndex < len(existingTermsLines)) {
          // Update existing line.
          candidate = existingTermsLines[existingTermsLinesIndex];
          existingTermsLinesIndex += 1;
          await candidate.update({
            'dateMaturity': dateMaturity,
            'amountCurrency': -amountCurrency,
            'debit': balance < 0.0 && -balance || 0.0,
            'credit': balance > 0.0 && balance || 0.0,
          });
        }
        else {
          // Create new line.
          const [paymentReference, currencyId, commercialPartnerId] = await self('paymentReference', 'currencyId', 'commercialPartnerId');
          const model = self.env.items('account.move.line');
          const createMethod = inDraftMode && model.new || model.create;
          candidate = await createMethod.call(model, {
            'label': paymentReference || '',
            'debit': balance < 0.0 && -balance || 0.0,
            'credit': balance > 0.0 && balance || 0.0,
            'quantity': 1.0,
            'amountCurrency': -amountCurrency,
            'dateMaturity': dateMaturity,
            'moveId': self.id,
            'currencyId': currencyId.id,
            'accountId': account.id,
            'partnerId': commercialPartnerId.id,
            'excludeFromInvoiceTab': true,
          })
        }
        newTermsLines = newTermsLines.add(candidate);
        if (inDraftMode) {
          await candidate.update(await candidate._getFieldsOnchangeBalance({ forceComputation: true }));
        }
      }

      return newTermsLines;
    }

    let [lineIds, companyId] = await self('lineIds', 'companyId');
    const existingTermsLines = await lineIds.filtered(async (line) => ['receivable', 'payable'].includes(await (await (await line.accountId).userTypeId).type));
    const othersLines = await lineIds.filtered(async (line) => !['receivable', 'payable'].includes(await (await (await line.accountId).userTypeId).type));
    const companyCurrencyId = await (companyId.ok ? companyId : await self.env.company()).currencyId;
    const totalBalance = sum(await othersLines.mapped(async (l) => await companyCurrencyId.round(await l.balance)));
    const totalAmountCurrency = sum(await othersLines.mapped('amountCurrency'));

    if (!bool(othersLines)) {
      await self.set('lineIds', lineIds.sub(existingTermsLines));
      return;
    }

    const computationDate = await _getPaymentTermsComputationDate(self);
    const account = await _getPaymentTermsAccount(self, existingTermsLines);
    const toCompute = await _computePaymentTerms(self, computationDate, totalBalance, totalAmountCurrency);
    const newTermsLines = await _computeDiffPaymentTermsLines(self, existingTermsLines, account, toCompute);

    // Remove old terms lines that are no longer needed.
    lineIds = await self.lineIds;
    await self.set('lineIds', lineIds.sub(existingTermsLines.sub(newTermsLines)));

    if (bool(newTermsLines)) {
      const lastNewTermsLines = newTermsLines[newTermsLines._length - 1];
      await self.set('paymentReference', await lastNewTermsLines.label || '');
      await self.set('invoiceDateDue', await lastNewTermsLines.dateMaturity);
    }
  }

  /**
   * Recompute all lines that depend of others.
 
      For example, tax lines depends of base lines (lines having taxIds set). This is also the case of cash rounding
      lines that depend of base lines or tax lines depending the cash rounding strategy. When a payment term is set,
      this method will auto-balance the move with payment term lines.
 
      :param recompute_all_taxes: Force the computation of taxes. If set to false, the computation will be done
                                  or not depending of the field 'recompute_tax_line' in lines.
    * @param recomputeAllTaxes 
    * @param recomputeTaxBaseAmount 
    */
  async _recomputeDynamicLines(recomputeAllTaxes = false, recomputeTaxBaseAmount = false) {
    for (const invoice of this) {
      // Dispatch lines and pre-compute some aggregated values like taxes.
      const expectedTaxRepLines = []; // Tony check change to items('account.tax.repartition.line)
      const currentTaxRepLines = [];
      let invRecomputeAllTaxes = recomputeAllTaxes;
      let hasTaxes = false;
      for (const line of await invoice.lineIds) {
        const [recomputeTaxLine, taxRepartitionLineId, taxIds] = await line('recomputeTaxLine', 'taxRepartitionLineId', 'taxIds');
        if (recomputeTaxLine) {
          invRecomputeAllTaxes = true;
          await line.set('recomputeTaxLine', false);
        }
        if (taxRepartitionLineId.ok) {
          currentTaxRepLines.push(taxRepartitionLineId._origin); // Tony todo check duplicate
        }
        else if (taxIds.ok) {
          hasTaxes = true;
          let isRefund;
          if (await invoice.isInvoice(true)) {
            isRefund = ['outRefund', 'inRefund'].includes(await invoice.moveType);
          }
          else {
            const taxType = await taxIds[0].typeTaxUse;
            isRefund = (taxType === 'sale' && await line.debit) || (taxType === 'purchase' && await line.debit);
          }
          const taxes = await (await taxIds._origin.flattenTaxesHierarchy()).filtered(
            async (tax) => {
              const [amountType, amount] = await tax('amountType', 'amount');
              return (
                amountType === 'fixed' && ! await (await (await invoice.companyId).currencyId).isZero(amount)
                || !floatIsZero(amount, { precisionDigits: 4 })
              );
            }
          )
          let taxRepLines;
          if (isRefund) {
            taxRepLines = await (await taxes.refundRepartitionLineIds)._origin.filtered(async (x) => await x.repartitionType === "tax");
          }
          else {
            taxRepLines = await (await taxes.invoiceRepartitionLineIds)._origin.filtered(async (x) => await x.repartitionType === "tax");
          }
          for (const taxRepLine of taxRepLines) {
            expectedTaxRepLines.push(taxRepLine);// Tony todo check duplicate
          }
        }
      }

      const deltaTaxRepLines = _.difference(expectedTaxRepLines, currentTaxRepLines); // Tony must check

      // Compute taxes.
      if (hasTaxes || currentTaxRepLines.length) {
        if (invRecomputeAllTaxes) {
          await invoice._recomputeTaxLines();
        }
        else if (recomputeTaxBaseAmount) {
          await invoice._recomputeTaxLines(true);
        }
        else if (deltaTaxRepLines.length && !this._context['moveReverseCancel']) {
          await invoice._recomputeTaxLines(false, deltaTaxRepLines);
        }
      }

      if (await invoice.isInvoice(true)) {
        // Compute cash rounding.
        await invoice._recomputeCashRoundingLines();

        // Compute payment terms.
        await invoice._recomputePaymentTermsLines();

        // Only synchronize one2many in onchange.
        if (!invoice.eq(invoice._origin)) {
          await invoice.set('invoiceLineIds', await (await invoice.lineIds).filtered(async (line) => ! await line.excludeFromInvoiceTab));
        }
      }
    }
  }

  @api.depends('journalId')
  async _computeCompanyId() {
    for (const move of this) {
      let company = await (await move.journalId).companyId;
      company = company.ok ? company : await move.companyId;
      company = company.ok ? company : await this.env.company();
      await move.set('companyId', company);
    }
  }

  async _getLinesOnchangeCurrency() {
    // Override needed for COGS
    return this['lineIds']
  }

  async onchange(values, fieldName, fieldOnchange) {
    // OVERRIDE
    // As the dynamic lines in this model are quite complex, we need to ensure some computations are done exactly
    // at the beginning / at the end of the onchange mechanism. So, the onchange recursivity is disabled.
    return _super(AccountMove, await this.withContext({ recursiveOnchanges: false })).onchange(values, fieldName, fieldOnchange);
  }
  // COMPUTE METHODS

  @api.depends('companyId', 'invoiceFilterTypeDomain')
  async _computeSuitableJournalIds() {
    for (const m of this) {
      const journalType = await m.invoiceFilterTypeDomain || 'general';
      const companyId = (await m.companyId).id || (await this.env.company()).id;
      const domain = [['companyId', '=', companyId], ['type', '=', journalType]];
      await m.set('suitableJournalIds', await this.env.items('account.journal').search(domain));
    }
  }

  @api.depends('postedBefore', 'state', 'journalId', 'date')
  async _computeName() {
    async function journalKey(move) {
      const [journal, moveType] = await move('journalId', 'moveType');
      return [journal.id, await journal.refundSequence && moveType].join('/');
    }

    async function dateKey(move) {
      const date: Date = new Date(await move.date);
      return [date.getFullYear(), date.getMonth() + 1].join('/');
    }

    const grouped = new DefaultDict2(  // key: journalId, moveType
      () => new DefaultDict2(  // key: first adjacent (date.year, date.month)
        () => {
          return {
            'records': this.env.items('account.move'),
            'format': false,
            'formatValues': false,
            'reset': false
          }
        }
      )
    )
    let self = await this.sorted(async (m) => [await m.date, await m.ref || '', m.id]);
    const highestName = self.ok ? await self[0]._getLastSequence() : false;

    // Group the moves by journal and month
    for (const move of this) {
      const [label, date, state, postedBefore] = await move('label', 'date', 'state', 'postedBefore');
      if (!highestName && move.eq(self[0]) && !postedBefore && date) {
        // In the form view, we need to compute a default sequence so that the user can edit
        // it. We only check the first move as an approximation (enough for new in form view)
        // pass
      }
      else if ((label && label !== '/') || state !== 'posted') {
        try {
          if (!postedBefore) {
            await move._constrainsDateSequence();
          }
          // Has already a name or is not posted, we don't add to a batch
          continue;
        } catch (e) {
          if (isInstance(e, ValidationError)) {
            // Has never been posted and the name doesn't match the date: recompute it
            // pass
          }
          else {
            throw e;
          }
        }
      }
      const group = grouped[await journalKey(move)][await dateKey(move)];
      if (!bool(group['records'])) {
        // Compute all the values needed to sequence this whole group
        await move._setNextSequence();
        [group['format'], group['formatValues']] = await move._getSequenceFormatParam(await move.label);
        group['reset'] = await move._deduceSequenceNumberReset(await move.label);
      }
      group['records'] = group['records'].add(move);
    }

    // Fusion the groups depending on the sequence reset and the format used because `seq` is
    // the same counter for multiple groups that might be spread in multiple months.
    let finalBatches = [];
    for (const journalGroup of grouped.values()) {
      let journalGroupChanged = true;
      for (const dateGroup of journalGroup.values()) {
        if (
          journalGroupChanged
          || finalBatches[finalBatches.length - 1]['format'] != dateGroup['format']
          || !equal(Object.assign(finalBatches[finalBatches.length - 1]['formatValues'], { seq: 0 }), Object.assign(dateGroup['formatValues'], { seq: 0 }))
        ) {
          finalBatches = finalBatches.concat([dateGroup]);
          journalGroupChanged = false;
        }
        else if (dateGroup['reset'] === 'never') {
          finalBatches[finalBatches.length - 1]['records'] = finalBatches[finalBatches.length - 1]['records'].add(dateGroup['records']);
        }
        else if (
          dateGroup['reset'] === 'year'
          && (await finalBatches[finalBatches.length - 1]['records'][0].date).getFullYear == (await dateGroup['records'][0].date).getFullYear
        ) {
          finalBatches[finalBatches.length - 1]['records'] = finalBatches[finalBatches.length - 1]['records'].add(dateGroup['records']);
        }
        else {
          finalBatches = finalBatches.concat([dateGroup]);
        }
      }
    }
    // Give the name based on previously computed values
    for (const batch of finalBatches) {
      for (const move of batch['records']) {
        await move.set('label', _f(batch['format'], batch['formatValues']));
        batch['formatValues']['seq'] += 1;
      }
      await batch['records']._computeSplitSequence();
    }
    await (await this.filtered(async (m) => !await m.label)).set('label', '/');
  }

  @api.depends('journalId', 'date')
  async _computeHighestName() {
    for (const record of this) {
      await record.set('highestName', await record._getLastSequence());
    }
  }

  @api.onchange('label', 'highestName')
  async _onchangeNameWarning() {
    const label = await this['label'];
    if (label && label !== '/' && label <= (await this['highestName'] || '')) {
      await this.set('showNameWarning', true);
    }
    else {
      await this.set('showNameWarning', false);
    }

    let originName = await this._origin['label'];
    if (!originName || originName === '/') {
      originName = await this['highestName'];
    }
    if (label && label !== '/' && originName && originName !== '/') {
      const [newFormat, newFormatValues] = await (this as any)._getSequenceFormatParam(label);
      const [originFormat, originFormatValues] = await (this as any)._getSequenceFormatParam(originName);

      if (
        newFormat !== originFormat
        || !equal(Object.assign(newFormatValues, { seq: 0 }), Object.assign(originFormatValues, { seq: 0 }))
      ) {
        const changed = _f(await this._t(
          "It was previously '{previous}' and it is now '{current}'."), {
          previous: originName,
          current: label,
        })
        const reset = await (this as any)._deduceSequenceNumberReset(label);
        let detected;
        if (reset === 'month') {
          detected = await this._t(
            `The sequence will restart at 1 at the start of every month.\n
            The year detected here is '{year}' and the month is '{month}'.\n
            The incrementing number in this case is '{formattedSeq}'.`
          )
        }
        else if (reset === 'year') {
          detected = await this._t(
            `The sequence will restart at 1 at the start of every year.\n
            The year detected here is '{year}'.\n
            The incrementing number in this case is '{formattedSeq}'.`
          )
        }
        else {
          detected = await this._t(
            `The sequence will never restart.\n
            The incrementing number in this case is '{formattedSeq}'.`
          )
        }
        newFormatValues['formattedSeq'] = `${newFormatValues['seq']}`.padStart(newFormatValues['seqLength'], '0');
        detected = _f(detected, newFormatValues);
        return {
          'warning': {
            'title': await this._t("The sequence format has changed."),
            'message': f("%s\n\n%s", changed, detected)
          }
        }
      }
    }
  }

  async _getLastSequenceDomain(relaxed: false) {
    this.ensureOne();
    const [date, journalId, moveType] = await this('date', 'journalId', 'moveType');
    if (!date || !journalId.ok) {
      return ["WHERE FALSE", {}];
    }
    let whereString = `WHERE "journalId" = {journalId} AND label != '/'`;
    const param = { 'journalId': journalId.id };

    if (relaxed) {
      let domain = [['journalId', '=', journalId.id], ['id', '!=', bool(this.id) ? this.id : this._origin.id], ['label', 'not in', ['/', '', false]]];
      if (await journalId.refundSequence) {
        const refundTypes = ['outRefund', 'inRefund'];
        extend(domain, [['moveType', refundTypes.includes(moveType) ? 'in' : 'not in', refundTypes]]);
      }
      let referenceMoveName = await (await this.search(domain.concat([['date', '<=', date]]), { order: 'date desc', limit: 1 })).label;
      if (!referenceMoveName) {
        referenceMoveName = await (await this.search(domain, { order: 'date asc', limit: 1 })).label;
      }
      const sequenceNumberReset = await (this as any)._deduceSequenceNumberReset(referenceMoveName);
      if (sequenceNumberReset === 'year') {
        whereString += " AND date_trunc('year', date::timestamp without time zone) = date_trunc('year', '{date}'::timestamp) ";
        param['date'] = date.toISOString();
        param['antiRegex'] = (await this._sequenceMonthlyRegex()).source.split('(?<seq>')[0].replace(/\?<\w+>/g, "?:") + '$';
      }
      else if (sequenceNumberReset === 'month') {
        whereString += " AND date_trunc('month', date::timestamp without time zone) = date_trunc('month', '{date}'::timestamp) ";
        param['date'] = date.toISOString();
      }
      else {
        param['antiRegex'] = (await this._sequenceYearlyRegex()).source.split('(?<seq>')[0].replace(/\?<\w+>/g, "?:") + '$';
      }

      if (param['antiRegex'] && ! await journalId.sequenceOverrideRegex) {
        whereString += ` AND "sequencePrefix" !~ '{antiRegex}' `;
      }
    }

    if (await journalId.refundSequence) {
      if (['outRefund', 'inRefund'].includes(moveType)) {
        whereString += ` AND "moveType" IN ('outRefund', 'inRefund') `;
      }
      else {
        whereString += ` AND "moveType" NOT IN ('outRefund', 'inRefund') `;
      }
    }

    return [whereString, param];
  }

  async _getStartingSequence() {
    this.ensureOne();
    let [journalId, date, moveType] = await this('journalId', 'date', 'moveType');
    date = new Date(date);
    let startingSequence;
    if (await journalId.type === 'sale') {
      startingSequence = f("%s/%s/00000", await journalId.code, String(date.getFullYear()).padStart(4, '0'));
    }
    else {
      startingSequence = f("%s/%s/%s/0000", await journalId.code, String(date.getFullYear()).padStart(4, '0'), String(date.getMonth()+1).padStart(2, '0'));
    }
    if (await journalId.refundSequence && ['outRefund', 'inRefund'].includes(moveType)) {
      startingSequence = "R" + startingSequence;
    }
    return startingSequence;
  }

  @api.depends('moveType')
  async _computeTypeName() {
    const field = this._fields['moveType'];
    const typeNameMapping = Object.fromEntries(await field._descriptionSelection(field, this.env));
    const replacements = { 'outInvoice': await this._t('Invoice'), 'outRefund': await this._t('Credit Note') }

    for (const record of this) {
      const name = typeNameMapping[await record.moveType];
      await record.set('typeName', replacements[await record.moveType] ?? name);
    }
  }

  @api.depends('moveType')
  async _computeInvoiceFilterTypeDomain() {
    for (const move of this) {
      if (await move.isSaleDocument(true)) {
        await move.set('invoiceFilterTypeDomain', 'sale');
      }
      else if (await move.isPurchaseDocument(true)) {
        await move.set('invoiceFilterTypeDomain', 'purchase');
      }
      else {
        await move.set('invoiceFilterTypeDomain', false);
      }
    }
  }

  @api.depends('partnerId')
  async _computeCommercialPartnerId() {
    for (const move of this) {
      await move.set('commercialPartnerId', await (await move.partnerId).commercialPartnerId);
    }
  }

  @api.depends('commercialPartnerId')
  async _computeBankPartnerId() {
    for (const move of this) {
      if (await move.isOutbound()) {
        await move.set('bankPartnerId', await move.commercialPartnerId);
      }
      else {
        await move.set('bankPartnerId', await (await move.companyId).partnerId);
      }
    }
  }

  /**
   * Hook to give the state when the invoice becomes fully paid. This is necessary because the users working
      with only invoicing don't want to see the 'in_payment' state. Then, this method will be overridden in the
      accountant module to enable the 'in_payment' state.
   * @returns 
   */
  @api.model()
  async _getInvoiceInPaymentState() {
    return 'paid';
  }

  @api.depends(
    'lineIds.matchedDebitIds.debitMoveId.moveId.paymentId.isMatched',
    'lineIds.matchedDebitIds.debitMoveId.moveId.lineIds.amountResidual',
    'lineIds.matchedDebitIds.debitMoveId.moveId.lineIds.amountResidualCurrency',
    'lineIds.matchedCreditIds.creditMoveId.moveId.paymentId.isMatched',
    'lineIds.matchedCreditIds.creditMoveId.moveId.lineIds.amountResidual',
    'lineIds.matchedCreditIds.creditMoveId.moveId.lineIds.amountResidualCurrency',
    'lineIds.debit',
    'lineIds.credit',
    'lineIds.currencyId',
    'lineIds.amountCurrency',
    'lineIds.amountResidual',
    'lineIds.amountResidualCurrency',
    'lineIds.paymentId.state',
    'lineIds.fullReconcileId')
  async _computeAmount() {
    for (const move of this) {
      const paymentState = await move['paymentState'];
      if (paymentState === 'invoicingLegacy') {
        // invoicing_legacy state is set via SQL when setting setting field
        // invoicing_switch_threshold (defined in account_accountant).
        // The only way of going out of this state is through this setting,
        // so we don't recompute it here.
        await move.set('paymentState', paymentState);
        continue;
      }
      let totalUntaxed = 0.0;
      let totalUntaxedCurrency = 0.0;
      let totalTax = 0.0;
      let totalTaxCurrency = 0.0;
      let totalToPay = 0.0;
      let totalResidual = 0.0;
      let totalResidualCurrency = 0.0;
      let total = 0.0;
      let totalCurrency = 0.0;
      const currencies = await (await move._getLinesOnchangeCurrency()).currencyId;

      for (const line of await move.lineIds) {
        const [balance, amountCurrency, amountResidual, amountResidualCurrency, debit] = await line('balance', 'amountCurrency', 'amountResidual', 'amountResidualCurrency', 'debit');
        if (await move._paymentStateMatters()) {
          // === Invoices ===

          if (! await line.excludeFromInvoiceTab) {
            // Untaxed amount.
            totalUntaxed += balance;
            totalUntaxedCurrency += amountCurrency;
            total += balance;
            totalCurrency += amountCurrency;
          }
          else if ((await line.taxLineId).ok) {
            // Tax amount.
            totalTax += balance;
            totalTaxCurrency += amountCurrency;
            total += balance;
            totalCurrency += amountCurrency;
          }
          else if (['receivable', 'payable'].includes(await (await (await line.accountId).userTypeId).type)) {
            // Residual amount.
            totalToPay += balance;
            totalResidual += amountResidual;
            totalResidualCurrency += amountResidualCurrency;
          }
        }
        else {
          // === Miscellaneous journal entry ===
          if (debit) {
            total += balance;
            totalCurrency += amountCurrency;
          }
        }
      }
      let sign;
      const moveType = await move['moveType'];
      if (moveType === 'entry' || await move.isOutbound()) {
        sign = 1;
      }
      else {
        sign = -1;
      }
      const oneCurrency = len(currencies) == 1;
      // const promises = [
      await move.set('amountUntaxed', sign * (oneCurrency ? totalUntaxedCurrency : totalUntaxed)),
        await move.set('amountTax', sign * (oneCurrency ? totalTaxCurrency : totalTax)),
        await move.set('amountTotal', sign * (oneCurrency ? totalCurrency : total)),
        await move.set('amountResidual', -sign * (oneCurrency ? totalResidualCurrency : totalResidual)),
        await move.set('amountUntaxedSigned', -totalUntaxed),
        await move.set('amountTaxSigned', -totalTax),
        await move.set('amountTotalSigned', moveType === 'entry' ? Math.abs(total) : -total),
        await move.set('amountResidualSigned', totalResidual)
      // ];
      // await Promise.all(promises);

      await move.set('amountTotalInCurrencySigned', moveType === 'entry' ? Math.abs(await move.amountTotal) : -(sign * await move.amountTotal));

      const currency = oneCurrency ? currencies : await (await move.companyId).currencyId;

      // Compute 'paymentState'.
      let newPmtState = moveType !== 'entry' ? 'notPaid' : false;

      if (await move._paymentStateMatters() && await move.state === 'posted') {
        if (await currency.isZero(await move.amountResidual)) {
          const reconciledPayments = await move._getReconciledPayments();
          if (!bool(reconciledPayments) || await reconciledPayments.all(payment => payment.isMatched)) {
            newPmtState = 'paid';
          }
          else {
            newPmtState = await move._getInvoiceInPaymentState();
          }
        }
        else if (await currency.compareAmounts(totalToPay, totalResidual) != 0) {
          newPmtState = 'partial';
        }
      }

      if (newPmtState === 'paid' && ['inInvoice', 'outInvoice', 'entry'].includes(moveType)) {
        const reverseType = moveType === 'inInvoice' && 'inRefund' || moveType === 'outInvoice' && 'outRefund' || 'entry';
        const reverseMoves = await this.env.items('account.move').search([['reversedEntryId', '=', move.id], ['state', '=', 'posted'], ['moveType', '=', reverseType]]);

        // We only set 'reversed' state in cas of 1 to 1 full reconciliation with a reverse entry; otherwise, we use the regular 'paid' state
        const reverseMovesFullRecs = await reverseMoves.mapped('lineIds.fullReconcileId');
        if ((await (await reverseMovesFullRecs.mapped('reconciledLineIds.moveId')).filtered(async (x) => !reverseMoves.add(await reverseMovesFullRecs.mapped('exchangeMoveId')).includes(x))).eq(move)) {
          newPmtState = 'reversed';
        }
      }

      await move.set('paymentState', newPmtState);
    }
  }

  async _inverseAmountTotal() {
    for (const move of this) {
      if (len(await move.lineIds) != 2 || await move.isInvoice(true)) {
        continue;
      }

      const toWrite = [];

      const [amountTotal, currencyId, companyCurrencyId, companyId, date, lineIds] = await move('amountTotal', 'currencyId', 'companyCurrencyId', 'companyId', 'date', 'lineIds');
      const amountCurrency = Math.abs(amountTotal);
      const balance = await currencyId._convert(amountCurrency, companyCurrencyId, companyId, date);

      for (const line of lineIds) {
        const lBalance = await line.balance;
        if (! await (await line.currencyId).isZero(balance - Math.abs(lBalance))) {
          toWrite.push([1, line.id, {
            'debit': lBalance > 0.0 && balance || 0.0,
            'credit': lBalance < 0.0 && balance || 0.0,
            'amountCurrency': lBalance > 0.0 && amountCurrency || -amountCurrency,
          }]);
        }
      }

      await move.write({ 'lineIds': toWrite });
    }
  }

  async _getDomainMatchingSuspenseMoves() {
    this.ensureOne();
    let domain = await this.env.items('account.move.line')._getSuspenseMovesDomain();
    domain = domain.concat(['|', ['partnerId', '=?', (await this['partnerId']).id], ['partnerId', '=', false]]);
    if (await this.isInbound()) {
      domain.push(['balance', '=', -await this['amountResidual']]);
    }
    else {
      domain.push(['balance', '=', await this['amountResidual']]);
    }
    return domain;
  }

  async _computeHasMatchingSuspenseAmount() {
    for (const r of this) {
      let res = false;
      if (await r.state === 'posted' && await r.isInvoice() && await r.paymentState === 'notPaid') {
        const domain = await r._getDomainMatchingSuspenseMoves();
        const count = await this.env.items('account.move.line').searchCount(domain);
        // there are more than one but less than 5 suspense moves matching the residual amount
        if (0 < count && count < 5) {
          const domain2 = [
            ['paymentState', '=', 'notPaid'],
            ['state', '=', 'posted'],
            ['amountResidual', '=', await r.amountResidual],
            ['moveType', '=', await r.moveType]];
          // there are less than 5 other open invoices of the same type with the same residual
          if (await this.env.items('account.move').searchCount(domain2) < 5) {
            res = true;
          }
        }
      }
      await r.set('invoiceHasMatchingSuspenseAmount', res);
    }
  }

  @api.depends('partnerId', 'invoiceSourceEmail', 'partnerId.label')
  async _computeInvoicePartnerDisplayInfo() {
    for (const move of this) {
      let vendorDisplayName = await (await move.partnerId).displayName;
      if (!vendorDisplayName) {
        const email = await move.invoiceSourceEmail;
        if (email) {
          vendorDisplayName = _f(await this._t('@From: {email}'), { email: email });
        }
        else {
          vendorDisplayName = await this._t('#Created by: %s', await (await (await move.sudo()).createdUid).label || await (await this.env.user()).label);
        }
      }
      await move.set('invoicePartnerDisplayName', vendorDisplayName);
    }
  }

  @api.depends('currencyId')
  async _computeDisplayInactiveCurrencyWarning() {
    for (const move of await this.withContext({ activeTest: false })) {
      await move.set('displayInactiveCurrencyWarning', ! await (await move.currencyId).active);
    }
  }

  async _computePaymentsWidgetToReconcileInfo() {
    for (const move of this) {
      // await Promise.all([
      await move.set('invoiceOutstandingCreditsDebitsWidget', stringify(false)),
        await move.set('invoiceHasOutstanding', false)
      // ]);
      if (await move.state !== 'posted'
        || !['notPaid', 'partial'].includes(await move.paymentState)
        || ! await move.isInvoice(true)) {
        continue;
      }

      const payTermLines = await (await move.lineIds).filtered(async (line) => ['receivable', 'payable'].includes(await (await (await line.accountId).userTypeId).type));

      const domain = [
        ['accountId', 'in', (await payTermLines.accountId).ids],
        ['moveId.state', '=', 'posted'],
        ['partnerId', '=', (await move.commercialPartnerId).id],
        ['reconciled', '=', false],
        '|', ['amountResidual', '!=', 0.0], ['amountResidualCurrency', '!=', 0.0],
      ];

      const paymentsWidgetVals = { 'outstanding': true, 'content': [], 'moveId': move.id };

      if (await move.isInbound()) {
        domain.push(['balance', '<', 0.0]);
        paymentsWidgetVals['title'] = await this._t('Outstanding credits');
      }
      else {
        domain.push(['balance', '>', 0.0]);
        paymentsWidgetVals['title'] = await this._t('Outstanding debits');
      }

      for (const line of await this.env.items('account.move.line').search(domain)) {
        const [currencyId, companyId] = await move('currencyId', 'companyId');
        let amount;
        if ((await line.currencyId).eq(currencyId)) {
          // Same foreign currency.
          amount = Math.abs(await line.amountResidualCurrency);
        }
        else {
          // Different foreign currencies.
          amount = await (await move.companyCurrencyId)._convert(
            Math.abs(await line.amountResidual),
            await currencyId,
            await companyId,
            await line.date,
          )
        }

        if (await (await move.currencyId).isZero(amount)) {
          continue;
        }

        paymentsWidgetVals['content'].push({
          'journalName': await line.ref || await (await line.moveId).label,
          'amount': amount,
          'currency': await currencyId.symbol,
          'id': line.id,
          'moveId': (await line.moveId).id,
          'position': await currencyId.position,
          'digits': [69, await currencyId.decimalPlaces],
          'paymentDate': _Date.toString(await line.date),
        })
      }
      if (!bool(paymentsWidgetVals['content'])) {
        continue;
      }
      // await Promise.all([
      await move.set('invoiceOutstandingCreditsDebitsWidget', stringify(paymentsWidgetVals)),
        await move.set('invoiceHasOutstanding', true)
      // ]);
    }
  }

  async _getReconciledInfoJSONValues() {
    this.ensureOne();
    const reconciledVals = [];
    for (const [partial, amount, counterpartLine] of await this._getReconciledInvoicesPartials()) {
      reconciledVals.push(await this._getReconciledVals(partial, amount, counterpartLine));
    }
    return reconciledVals;
  }

  async _getReconciledVals(partial, amount, counterpartLine) {
    const [moveId, journalId, paymentId] = await counterpartLine('moveId', 'journalId', 'paymentId');
    let reconciliationRef;
    if (await moveId.ref) {
      reconciliationRef = f('%s (%s)', await moveId.label, await moveId.ref);
    }
    else {
      reconciliationRef = await moveId.label;
    }
    const currencyId = await this['currencyId'];
    return {
      'label': await counterpartLine.label,
      'journalName': await journalId.label,
      'amount': amount,
      'currency': await currencyId.symbol,
      'digits': [69, await currencyId.decimalPlaces],
      'position': await currencyId.position,
      'date': await counterpartLine.date,
      'paymentId': counterpartLine.id,
      'partialId': partial.id,
      'accountPaymentId': paymentId.id,
      'paymentMethodName': await (await paymentId.paymentMethodLineId).label,
      'moveId': moveId.id,
      'ref': reconciliationRef,
    }
  }

  @api.depends('moveType', 'lineIds.amountResidual')
  async _computePaymentsWidgetReconciledInfo() {
    for (const move of this) {
      const paymentsWidgetVals = { 'title': await this._t('Less Payment'), 'outstanding': false, 'content': [] };

      if (await move.state === 'posted' && await move.isInvoice(true)) {
        paymentsWidgetVals['content'] = await move._getReconciledInfoJSONValues();
      }
      if (bool(paymentsWidgetVals['content'])) {
        await move.set('invoicePaymentsWidget', stringify(paymentsWidgetVals));//, {default: date_utils.jsonDefault}));
      }
      else {
        await move.set('invoicePaymentsWidget', stringify(false));
      }
    }
  }

  /**
   * Computed field used for custom widget's rendering. Only set on invoices.
   */
  @api.depends('lineIds.amountCurrency', 'lineIds.taxBaseAmount', 'lineIds.taxLineId', 'partnerId', 'currencyId', 'amountTotal', 'amountUntaxed')
  async _computeTaxTotalsJson() {
    for (const move of this) {
      if (! await move.isInvoice(true)) {
        // Non-invoice moves don't support that field (because of multicurrency: all lines of the invoice share the same currency)
        await move.set('taxTotalsJson', null);
        continue;
      }
      const taxLinesData = await move._prepareTaxLinesDataForTotalsFromInvoice();

      const taxTotalsJson = stringify({
        ...await this._getTaxTotals(
          await move.partnerId,
          taxLinesData,
          await move.amountTotal,
          await move.amountUntaxed,
          await move.currencyId),
        'allowTaxEdition': await move.isPurchaseDocument(false) && await move.state === 'draft',
      });
      await move.set('taxTotalsJson', taxTotalsJson);
    }
  }

  /**
   * Prepares data to be passed as taxLinesData parameter of _getTaxTotals() from an invoice.
 
      NOTE: taxLineIdFilter and taxIdsFilter are used in l10n_latam to restrict the taxes with consider
            in the totals.
 
      :param taxLineIdFilter: a function(aml, tax) returning true if tax should be considered on tax move line aml.
      :param taxIdsFilter: a function(aml, taxes) returning true if taxes should be considered on base move line aml.
 
      :return: A list of dict in the format described in _getTaxTotals's taxLinesData's docstring.
   * @param taxLineIdFilter 
   * @param taxIdsFilter 
   * @returns 
   */
  async _prepareTaxLinesDataForTotalsFromInvoice(taxLineIdFilter?: any, taxIdsFilter?: any) {
    this.ensureOne();

    taxLineIdFilter = taxLineIdFilter || (([aml, tax]) => true);
    taxIdsFilter = taxIdsFilter || (([aml, tax]) => true);

    const balanceMultiplicator = await this.isInbound() ? -1 : 1;
    const taxLinesData = [];

    for (const line of await this['lineIds']) {
      if (bool(await line.taxLineId) && await taxLineIdFilter(line, await line.taxLineId)) {
        taxLinesData.push({
          'lineKey': f('taxLine_%s', line.id),
          'taxAmount': await line.amountCurrency * balanceMultiplicator,
          'tax': await line.taxLineId,
        })
      }

      if (bool(await line.taxIds)) {
        for (const baseTax of await (await line.taxIds).flattenTaxesHierarchy()) {
          if (await taxIdsFilter(line, baseTax)) {
            taxLinesData.push({
              'lineKey': f('baseLine_%s', line.id),
              'baseAmount': await line.amountCurrency * balanceMultiplicator,
              'tax': baseTax,
              'taxAffectingBase': await line.taxLineId,
            })
          }
        }
      }
    }

    return taxLinesData;
  }

  /**
   * Prepares data to be passed as tax_lines_data parameter of _get_tax_totals() from any
      object using taxes. This helper is intended for purchase.order and sale.order, as a common
      function centralizing their behavior.
 
      :param object_lines: A list of records corresponding to the sub-objects generating the tax totals
                            (sale.order.line or purchase.order.line, for example)
 
      :param tax_results_function: A function to be called to get the results of the tax computation for a
                                    line in object_lines. It takes the object line as its only parameter
                                    and returns a dict in the same format as account.tax's computeAll
                                    (most probably after calling it with the right parameters).
 
      :return: A list of dict in the format described in _get_tax_totals's tax_lines_data's docstring.
   * @param objectLines 
   * @param taxResultsFunction 
   * @returns 
   */
  @api.model()
  async _prepareTaxLinesDataForTotalsFromObject(objectLines, taxResultsFunction) {
    const taxLinesData = [];

    for (const line of objectLines) {
      const taxResults = await taxResultsFunction(line);

      for (const taxResult of taxResults['taxes']) {
        const currentTax = this.env.items('account.tax').browse(taxResult['id']);

        // Tax line
        taxLinesData.push({
          'lineKey': `taxLine_${line.id}_${taxResult['id']}`,
          'taxAmount': taxResult['amount'],
          'tax': currentTax,
        });

        // Base for this tax line
        taxLinesData.push({
          'lineKey': `baseLine_${line.id}`,
          'baseAmount': taxResults['totalExcluded'],
          'tax': currentTax,
        });

        // Base for the taxes whose base is affected by this tax line
        if (taxResult['taxIds']) {
          const affectedTaxes = this.env.items('account.tax').browse(taxResult['taxIds']);
          for (const affectedTax of affectedTaxes) {
            taxLinesData.push({
              'lineKey': f('affectingBaseLine_%s_%s', line.id, taxResult['id']),
              'baseAmount': taxResult['amount'],
              'tax': affectedTax,
              'taxAffectingBase': currentTax,
            });
          }
        }
      }
    }

    return taxLinesData;
  }

  /**
   * Compute the tax totals for the provided data.
 
    :param partner:        The partner to compute totals for
    :param taxLinesData: All the data about the base and tax lines as a list of dictionaries.
                        Each dictionary represents an amount that needs to be added to either a tax base or amount.
    A tax amount looks like:
      {
        'lineKey':             unique identifier,
        'taxAmount':           the amount computed for this tax
        'tax':                 the account.tax object this tax line was made from
      }
    For base amounts:
      {
        'lineKey':             unique identifier,
        'baseAmount':          the amount to add to the base of the tax
        'tax':                 the tax basing itself on this amount
        'taxAffectingBase':   (optional key) the tax whose tax line is having the impact
                                denoted by 'baseAmount' on the base of the tax, in case of taxes
                                affecting the base of subsequent ones.
      }
    :param amountTotal:   Total amount, with taxes.
    :param amountUntaxed: Total amount without taxes.
    :param currency:      The currency in which the amounts are computed.

    :return: A dictionary in the following form:
    {
      'amountTotal':                              The total amount to be displayed on the document, including every total types.
      'amountUntaxed':                            The untaxed amount to be displayed on the document.
      'formattedAmountTotal':                    Same as amountTotal, but as a string formatted accordingly with partner's locale.
      'formattedAmountUntaxed':                  Same as amountUntaxed, but as a string formatted accordingly with partner's locale.
      'allowTaxEdition':                         true if the user should have the ability to manually edit the tax amounts by group
                                                    to fix rounding errors.
      'groupsBySubtotals':                       A dictionary formed liked {'subtotal': groups_data}
                                                    Where total_type is a subtotal name defined on a tax group, or the default one: 'Untaxed Amount'.
                                                    And groups_data is a list of dict in the following form:
        {
          'taxGroupName':                  The name of the tax groups this total is made for.
          'taxGroupAmount':                The total tax amount in this tax group.
          'taxGroupBaseAmount':           The base amount for this tax group.
          'formattedTaxGroupAmount':      Same as tax_group_amount, but as a string
                                              formatted accordingly with partner's locale.
          'formattedTaxGroupBaseAmount': Same as tax_group_base_amount, but as a string
                                              formatted accordingly with partner's locale.
          'taxGroupId':                    The id of the tax group corresponding to this dict.
          'groupKey':                       A unique key identifying this total dict,
        }
      'subtotals':                                 A list of dictionaries in the following form, one for each subtotal in groupsBySubtotals' keys
        {
          'label':                            The name of the subtotal
          'amount':                          The total amount for this subtotal, summing all
                                              the tax groups belonging to preceding subtotals and the base amount
          'formattedAmount':                Same as amount, but as a string
                                              formatted accordingly with partner's locale.
        }
    }
   * @param partner 
   * @param taxLinesData 
   * @param amountTotal 
   * @param amountUntaxed 
   * @param currency 
   */
  @api.model()
  async _getTaxTotals(partner, taxLinesData, amountTotal, amountUntaxed, currency) {
    const langEnv = (await this.withContext({ lang: await partner.lang })).env;
    const accountTax = this.env.items('account.tax');

    const groupedTaxes = new DefaultDict2(() => new DefaultDict2(() => { return { 'baseAmount': 0.0, 'taxAmount': 0.0, 'baseLineKeys': new Set() } }));
    const subtotalPriorities = {};
    for (const lineData of taxLinesData) {
      const taxGroup = await lineData['tax'].taxGroupId;

      // Update subtotals priorities
      let subtotalTitle, newPriority;
      if (await taxGroup.precedingSubtotal) {
        subtotalTitle = await taxGroup.precedingSubtotal;
        newPriority = await taxGroup.sequence;
      }
      else {
        // When needed, the default subtotal is always the most prioritary
        subtotalTitle = await this._t("Untaxed Amount");
        newPriority = 0;
      }

      if (!(subtotalTitle in subtotalPriorities) || newPriority < subtotalPriorities[subtotalTitle]) {
        subtotalPriorities[subtotalTitle] = newPriority;
      }

      // Update tax data
      if (!groupedTaxes[subtotalTitle].has(taxGroup)) {
        groupedTaxes[subtotalTitle].set(taxGroup, { 'baseAmount': 0.0, 'taxAmount': 0.0, 'baseLineKeys': new Set() });
      }
      const taxGroupVals = groupedTaxes[subtotalTitle].get(taxGroup);

      if ('baseAmount' in lineData) {
        // Base line
        const taxAffectingBase = lineData['taxAffectingBase'];
        if (taxGroup.eq(await (bool(taxAffectingBase) ? taxAffectingBase : accountTax).taxGroupId)) {
          // In case the base has a taxLineId belonging to the same group as the base tax,
          // the base for the group will be computed by the base tax's original line (the one with taxIds and no taxLineId)
          continue;
        }

        if (!taxGroupVals['baseLineKeys'].has(lineData['lineKey'])) {
          // If the base line hasn't been taken into account yet, at its amount to the base total.
          taxGroupVals['baseLineKeys'].add(lineData['lineKey']);
          taxGroupVals['baseAmount'] += lineData['baseAmount'];
        }
      }
      else {
        // Tax line
        taxGroupVals['taxAmount'] += lineData['taxAmount'];
      }
    }

    // Compute groupsBySubtotal
    const groupsBySubtotal = {};
    for (const [subtotalTitle, groups] of groupedTaxes) {
      const groupsVals = await Promise.all((await sortedAsync(groups.entries(), (l) => l[0].sequence)).map(async ([group, amounts]) => {
        return {
          'taxGroupName': await group.label,
          'taxGroupAmount': amounts['taxAmount'],
          'taxGroupBaseAmount': amounts['baseAmount'],
          'formattedTaxGroupAmount': await formatLang(langEnv, amounts['taxAmount'], { currencyObj: currency }),
          'formattedTaxGroupBaseAmount': await formatLang(langEnv, amounts['baseAmount'], { currencyObj: currency }),
          'taxGroupId': group.id,
          'groupKey': f('%s-%s', subtotalTitle, group.id),
        }
      }));

      groupsBySubtotal[subtotalTitle] = groupsVals;
    }

    // Compute subtotals
    const subtotalsList = [] // List, so that we preserve their order
    let previousSubtotalsTaxAmount = 0;
    for (const subtotalTitle of sorted(Object.keys(subtotalPriorities), (x) => subtotalPriorities[x])) {
      const subtotalValue = amountUntaxed + previousSubtotalsTaxAmount;
      subtotalsList.push({
        'label': subtotalTitle,
        'amount': subtotalValue,
        'formattedAmount': await formatLang(langEnv, subtotalValue, { currencyObj: currency }),
      })

      const subtotalTaxAmount = sum(groupsBySubtotal[subtotalTitle].map(groupVal => groupVal['taxGroupAmount']));
      previousSubtotalsTaxAmount += subtotalTaxAmount;
    }

    // Assign json-formatted result to the field
    return {
      amountTotal: amountTotal,
      amountUntaxed: amountUntaxed,
      formattedAmountTotal: await formatLang(langEnv, amountTotal, {currencyObj: currency}),
      formattedAmountUntaxed: await formatLang(langEnv, amountUntaxed, {currencyObj: currency}),
      groupsBySubtotal: groupsBySubtotal,
      subtotals: subtotalsList,
      allowTaxEdition: false,
    }
  }

  @api.depends('date', 'lineIds.debit', 'lineIds.credit', 'lineIds.taxLineId', 'lineIds.taxIds', 'lineIds.taxTagIds')
  async _computeTaxLockDateMessage() {
    for (const move of this) {
      const [companyId, date] = await move('companyId', 'date');
      const taxLockDate = await companyId.taxLockDate;
      if (await move._affectTaxReport() && taxLockDate && date && date <= taxLockDate) {
        await move.set('taxLockDateMessage', await this._t(
          `The accounting date is set prior to the tax lock date which is set on %s.
                                    Hence, the accounting date will be changed to %s.`,
          await formatDate(this.env, taxLockDate), await formatDate(this.env, await _Date.contextToday(this))));
      }
      else {
        await move.set('taxLockDateMessage', false);
      }
    }
  }

  @api.depends('lineIds.accountId.internalType')
  async _computeAlwaysTaxExigible() {
    for (const record of this) {
      // We need to check is_invoice as well because always_tax_exigible is used to
      // set the tags as well, during the encoding. So, if no receivable/payable
      // line has been created yet, the invoice would be detected as always exigible,
      // and set the tags on some lines ; which would be wrong.
      await record.set('alwaysTaxExigible', ! await record.isInvoice(true) && ! await record._collectTaxCashBasisValues());
    }
  }

  @api.depends('restrictModeHashTable', 'state')
  async _computeShowResetToDraftButton() {
    for (const move of this) {
      await move.set('showResetToDraftButton', ! await move.restrictModeHashTable && ['posted', 'cancel'].includes(await move.state));
    }
  }

  @api.depends('companyId.accountFiscalCountryId', 'fiscalPositionId.countryId', 'fiscalPositionId.foreignVat')
  async _computeTaxCountryId() {
    for (const record of this) {
      const fiscalPositionId = await record.fiscalPositionId;
      if (await fiscalPositionId.foreignVat) {
        await record.set('taxCountryId', await fiscalPositionId.countryId);
      }
      else {
        await record.set('taxCountryId', await (await record.companyId).accountFiscalCountryId);
      }
    }
  }

  @api.depends('taxCountryId.code')
  async _computeTaxCountryCode() {
    for (const record of this) {
      await record.set('taxCountryCode', await (await record.taxCountryId).code);
    }
  }

  // BUSINESS MODELS SYNCHRONIZATION

  /**
   * Ensure the consistency between:
      account.payment & account.move
      account.bank.statement.line & account.move
 
      The idea is to call the method performing the synchronization of the business
      models regarding their related journal entries. To avoid cycling, the
      'skip_account_move_synchronization' key is used through the context.
 
      :param changed_fields: A set containing all modified fields on account.move.
   * @param changedFields 
   * @returns 
   */
  async _synchronizeBusinessModels(changedFields) {
    if (this._context['skipAccountMoveSynchronization']) {
      return;
    }

    const selfSudo = await this.sudo();
    await (await selfSudo.paymentId)._synchronizeFromMoves(changedFields);
    await (await selfSudo.statementLineId)._synchronizeFromMoves(changedFields);
  }

  // CONSTRAINT METHODS

  @api.constrains('label', 'journalId', 'state')
  async _checkUniqueSequenceNumber() {
    const moves = await this.filtered(async (move) => await move.state === 'posted');
    if (!moves.ok) {
      return;
    }

    await this.flush(['label', 'journalId', 'moveType', 'state']);

    // /!\ Computed stored fields are not yet inside the database.
    const res = await this._cr.execute(`
                                SELECT move2.id, move2.label
                                FROM "accountMove" move
                                INNER JOIN "accountMove" move2 ON
                                    move2.label = move.label
                                    AND move2."journalId" = move."journalId"
                                    AND move2."moveType" = move."moveType"
                                    AND move2.id != move.id
                                WHERE move.id IN (%s) AND move2.state = 'posted'
                            `, [String(moves.ids)]);
    if (res.length) {
      throw new ValidationError(await this._t('Posted journal entry must have an unique sequence number per company.\nProblematic numbers: %s\n', res.map(r => r['label']).join(', ')));
    }
  }

  @api.constrains('ref', 'moveType', 'partnerId', 'journalId', 'invoiceDate')
  async _checkDuplicateSupplierReference() {
    const moves = await this.filtered(async (move) => await move.isPurchaseDocument() && await move.ref);
    if (!moves.ok) {
      return;
    }

    await this.env.items("account.move").flush([
      "ref", "moveType", "invoiceDate", "journalId",
      "companyId", "partnerId", "commercialPartnerId",
    ]);
    await this.env.items("account.journal").flush(["companyId"]);
    await this.env.items("res.partner").flush(["commercialPartnerId"]);

    // /!\ Computed stored fields are not yet inside the database.
    const res = await this._cr.execute(`
                                SELECT move2.id
                                FROM "accountMove" move
                                JOIN "accountJournal" journal ON journal.id = move."journalId"
                                JOIN "resPartner" partner ON partner.id = move."partnerId"
                                INNER JOIN "accountMove" move2 ON
                                    move2.ref = move.ref
                                    AND move2."companyId" = journal."companyId"
                                    AND move2."commercialPartnerId" = partner."commercialPartnerId"
                                    AND move2."moveType" = move."moveType"
                                    AND (move."invoiceDate" is NULL OR move2."invoiceDate" = move."invoiceDate")
                                    AND move2.id != move.id
                                WHERE move.id IN (%s)
                            `, [String(moves.ids)]);
    const duplicatedMoves = this.browse(res.map(r => r['id']));
    if (duplicatedMoves.ok) {
      throw new ValidationError(await this._t('Duplicated vendor reference detected. You probably encoded twice the same vendor bill/credit note:\n%s',
        (await duplicatedMoves.mapped(async (m) => _f("{partner} - {ref} - {date}", {
          'ref': await m.ref,
          'partner': await (await m.partnerId).displayName,
          'date': await formatDate(this.env, await m.invoiceDate),
        })
        )).join('\n')));
    }
  }

  /**
   * Assert the move is fully balanced debit = credit.
      An error is raised if it's not the case.
   * @returns 
   */
  async _checkBalanced() {
    const moves = await this.filtered(async (move) => (await move.lineIds).ok);
    if (!moves.ok) {
      return;
    }

    // /!\ As this method is called in create / write, we can't make the assumption the computed stored fields
    // are already done. Then, this query MUST NOT depend of computed stored fields (e.g. balance).
    // It happens as the ORM makes the create with the 'no_recompute' statement.
    await this.env.items('account.move.line').flush(this.env.models['account.move.line']._fields.keys());
    await this.env.items('account.move').flush(['journalId']);
    const res = await this._cr.execute(`
                                SELECT line."moveId" AS id, ROUND(SUM(line.debit - line.credit), currency."decimalPlaces") AS sums
                                FROM "accountMoveLine" line
                                JOIN "accountMove" move ON move.id = line."moveId"
                                JOIN "accountJournal" journal ON journal.id = move."journalId"
                                JOIN "resCompany" company ON company.id = journal."companyId"
                                JOIN "resCurrency" currency ON currency.id = company."currencyId"
                                WHERE line."moveId" IN (%s)
                                GROUP BY line."moveId", currency."decimalPlaces"
                                HAVING ROUND(SUM(line.debit - line.credit), currency."decimalPlaces") != 0.0;
                            `, [String(this.ids) || 'NULL'])

    if (res.length) {
      const ids = res.map(r => r['id']);
      const sums = res.map(r => parseFloat(r['sums']));
      throw new UserError(await this._t("Cannot create unbalanced journal entry. Ids: %s\nDifferences debit - credit: %s", ids, sums));
    }
  }

  async _checkFiscalyearLockDate() {
    for (const move of this) {
      const lockDate = await (await move.companyId)._getUserFiscalLockDate();
      if (await move.date <= lockDate) {
        let message;
        if (await this.userHasGroups('account.groupAccountManager')) {
          message = await this._t("You cannot add/modify entries prior to and inclusive of the lock date %s.", await formatDate(this.env, lockDate));
        }
        else {
          message = await this._t("You cannot add/modify entries prior to and inclusive of the lock date %s. Check the company settings or ask someone with the 'Adviser' role", await formatDate(this.env, lockDate));
        }
        throw new UserError(message);
      }
    }
    return true;
  }

  @api.constrains('moveType', 'journalId')
  async _checkJournalType() {
    for (const record of this) {
      const journalType = await (await record.journalId).type;

      if (await record.isSaleDocument() && journalType !== 'sale' || await record.isPurchaseDocument() && journalType !== 'purchase') {
        throw new ValidationError(await this._t("The chosen journal has a type that is not compatible with your invoice type. Sales operations should go to 'sale' journals, and purchase operations to 'purchase' ones."));
      }
    }
  }

  /**
   * By playing with the fiscal position in the form view, it is possible to keep taxes on the invoices from
      a different country than the one allowed by the fiscal country or the fiscal position.
      This contrains ensure such account.move cannot be kept, as they could generate inconsistencies in the reports.
   * @returns 
   */
  @api.constrains('lineIds', 'fiscalPositionId', 'companyId')
  async _validateTaxesCountry() {
    await this._computeTaxCountryId(); // We need to ensure this field has been computed, as we use it in our check
    for (const record of this) {
      const amls = await record.lineIds;
      const [taxIds, taxLineId] = await amls('taxIds', 'taxLineId');
      const impactedCountries = (await taxIds.countryId).or(await taxLineId.countryId);
      if (impactedCountries.ok && !impactedCountries.eq(await record.taxCountryId)) {
        throw new ValidationError(await this._t("This entry contains some tax from an unallowed country. Please check its fiscal position and your tax configuration."));
      }
    }
  }

  // LOW-LEVEL METHODS

  /**
   * This method recomputes dynamic lines on the current journal entry that include taxes, cash rounding and payment terms lines.
   * @returns 
   */
  async _moveAutocompleteInvoiceLinesValues() {
    this.ensureOne();
    const [date, partnerId, journalId, currencyId, lineIds] = await this('date', 'partnerId', 'journalId', 'currencyId', 'lineIds');
    for (const line of lineIds) {
      // Do something only on invoice lines.
      if (await line.excludeFromInvoiceTab) {
        continue;
      }

      // Shortcut to load the demo data.
      // Doing line.accountId triggers a defaultGet(['accountId']) that could returns a result.
      // A section / note must not have an accountId set.
      if (!bool(line._cache.get('accountId')) && ! await line.displayType && !bool(line._origin)) {
        const account = await line._getComputedAccount();
        await line.set('accountId', bool(account) ? account : await journalId.defaultAccountId);
      }
      if ((await line.productId).ok && !line._cache.get('label')) {
        await line.set('label', await line._getComputedName());
      }

      // Compute the account before the partnerId
      // In case account_followup is installed
      // Setting the partner will get the accountId in cache
      // If the accountId is not in cache, it will trigger the default value
      // Which is wrong in some case
      // It's better to set the accountId before the partnerId
      // Ensure related fields are well copied.
      if (!(await line.partnerId).eq(await partnerId.commercialPartnerId)) {
        await line.set('partnerId', await partnerId.commercialPartnerId);
      }
      await line.set('date', date);
      await line.set('recomputeTaxLine', true);
      await line.set('currencyId', currencyId);
    }

    await lineIds._onchangePriceSubtotal();
    await this._recomputeDynamicLines(true);

    const values = await this._convertToWrite(this._cache);
    pop(values, 'invoiceLineIds', null);
    return values;
  }

  /**
   * During the create of an account.move with only 'invoiceLineIds' set and not 'lineIds', this method is called to auto compute accounting lines of the invoice. In that case, accounts will be retrieved and taxes, cash rounding and payment terms will be computed. At the end, the values will contains all accounting lines in 'lineIds' and the moves should be balanced.
 
      :param vals_list:   The list of values passed to the 'create' method.
      :return:            Modified list of values.
   * @param valsList 
   * @returns 
   */
  @api.model()
  async _moveAutocompleteInvoiceLinesCreate(valsList) {
    const newValsList = [];
    for (let vals of valsList) {
      vals = Object.assign({}, vals);

      if (vals['invoiceDate'] && !vals['date']) {
        vals['date'] = vals['invoiceDate'];
      }

      const defaultMoveType = vals['moveType'] || this._context['default_moveType'];
      const ctxVals = {};
      if (defaultMoveType) {
        ctxVals['default_moveType'] = defaultMoveType;
      }
      if (vals['journalId']) {
        ctxVals['default_journalId'] = vals['journalId'];
        // reorder the companies in the context so that the company of the journal
        // (which will be the company of the move) is the main one, ensuring all
        // property fields are read with the correct company
        const journalCompany = await this.env.items('account.journal').browse(vals['journalId']).companyId;
        const allowedCompanies = this._context['allowedCompanyIds'] ?? journalCompany.ids;
        const reorderedCompanies = sorted(allowedCompanies, (cid) => cid != journalCompany.id);
        ctxVals['allowedCompanyIds'] = reorderedCompanies;
      }
      const selfCtx = await this.withContext(ctxVals);
      vals = await selfCtx._addMissingDefaultValues(vals);

      const isInvoice = this.getInvoiceTypes().includes(vals['moveType']);

      if ('lineIds' in vals) {
        pop(vals, 'invoiceLineIds', null);
        newValsList.push(vals);
        continue;
      }

      if (isInvoice && 'invoiceLineIds' in vals) {
        vals['lineIds'] = vals['invoiceLineIds'];
      }
      pop(vals, 'invoiceLineIds', null);

      const move = await selfCtx.new(vals);
      newValsList.push(await move._moveAutocompleteInvoiceLinesValues());
    }

    return newValsList;
  }

  /**
   * During the write of an account.move with only 'invoiceLineIds' set and not 'lineIds', this method is called to auto compute accounting lines of the invoice. In that case, accounts will be retrieved and taxes, cash rounding and payment terms will be computed. At the end, the values will contains all accounting lines in 'lineIds' and the moves should be balanced.
 
      @param vals:   A dict representing the values to write.
      @return:           true if the auto-completion did something, false otherwise.
   */
  async _moveAutocompleteInvoiceLinesWrite(vals) {
    const enableAutocomplete = 'invoiceLineIds' in vals && !('lineIds' in vals) && true || false;

    if (!enableAutocomplete) {
      return false;
    }

    vals['lineIds'] = pop(vals, 'invoiceLineIds');
    for (const invoice of this) {
      const invoiceNew = await (await invoice.withContext({ default_moveType: await invoice.moveType, default_journalId: (await invoice.journalId).id })).new({}, { origin: invoice });
      await invoiceNew.update(vals);
      const values = await invoiceNew._moveAutocompleteInvoiceLinesValues();
      pop(values, 'invoiceLineIds', null);
      await invoice.write(values);
    }
    return true;
  }

  @api.returns('self', (value) => value.id)
  async copy(defaultValue?: any) {
    const [date, companyId, moveType, journalId, displayName] = await this('date', 'companyId', 'moveType', 'journalId', 'displayName');
    defaultValue = Object.assign({}, defaultValue || {});
    if ((_Date.toDate(defaultValue['date']) || date) <= await companyId._getUserFiscalLockDate()) {
      defaultValue['date'] = DateTime.fromJSDate(await companyId._getUserFiscalLockDate()).plus({ days: 1 }).toJSDate();
    }
    if (moveType === 'entry') {
      defaultValue['partnerId'] = false;
    }
    if (! await journalId.active) {
      defaultValue['journalId'] = (await (await this.withContext({
        default_companyId: companyId.id,
        default_moveType: moveType,
      }))._getDefaultJournal()).id;
    }
    const copiedAm = await _super(AccountMove, this).copy(defaultValue);
    await copiedAm._messageLog({
      body: _f(await this._t(
        'This entry has been duplicated from <a href=// data-oe-model=account.move data-oe-id={id}>{title}</a>'), { id: this.id, title: escapeHtml(displayName) })
    });

    if (await copiedAm.isInvoice(true)) {
      // Make sure to recompute payment terms. This could be necessary if the date is different for example.
      // Also, this is necessary when creating a credit note because the current invoice is copied.
      await copiedAm._recomputePaymentTermsLines();
    }

    return copiedAm;
  }

  @api.modelCreateMulti()
  async create(valsList) {
    // OVERRIDE
    if (some(valsList, (vals) => 'state' in vals && vals['state'] === 'posted')) {
      throw new UserError(await this._t('You cannot create a move already in the posted state. Please create a draft move and post it after.'));
    }

    valsList = await this._moveAutocompleteInvoiceLinesCreate(valsList);
    return _super(AccountMove, this).create(valsList);
  }

  async write(vals) {
    for (const move of this) {
      const [restrictModeHashTable, state, inalterableHash, secureSequenceNumber, postedBefore, journalId, label, date, lineIds] = await move('restrictModeHashTable', 'state', 'inalterableHash', 'secureSequenceNumber', 'postedBefore', 'journalId', 'label', 'date', 'lineIds');
      if (restrictModeHashTable && state === "posted" && _.intersection(vals, INTEGRITY_HASH_MOVE_FIELDS)) {
        throw new UserError(await this._t("You cannot edit the following fields due to restrict mode being activated on the journal: %s.", INTEGRITY_HASH_MOVE_FIELDS.join(', ')));
      }
      if ((restrictModeHashTable && inalterableHash && 'inalterableHash' in vals) || (secureSequenceNumber && 'secureSequenceNumber' in vals)) {
        throw new UserError(await this._t('You cannot overwrite the values ensuring the inalterability of the accounting.'));
      }
      if (postedBefore && 'journalId' in vals && journalId.id != vals['journalId']) {
        throw new UserError(await this._t('You cannot edit the journal of an account move if it has been posted once.'));
      }
      if (label && label !== '/' && 'journalId' in vals && journalId.id != vals['journalId']) {
        throw new UserError(await this._t('You cannot edit the journal of an account move if it already has a sequence number assigned.'));
      }

      // You can't change the date of a move being inside a locked period.
      if ('date' in vals && date != vals['date']) {
        await move._checkFiscalyearLockDate();
        await lineIds._checkTaxLockDate();
      }

      // You can't post subtract a move to a locked period.
      if ('state' in vals && state === 'posted' && vals['state'] !== 'posted') {
        await move._checkFiscalyearLockDate();
        await lineIds._checkTaxLockDate();
      }

      const sequenceOverrideRegex = await journalId.sequenceOverrideRegex;
      if (sequenceOverrideRegex && vals['label'] && vals['label'] !== '/' && !vals['label'].match(sequenceOverrideRegex)) {
        if (! await (await this.env.user()).hasGroup('account.groupAccountManager')) {
          throw new UserError(await this._t('The Journal Entry sequence is not conform to the current format. Only the Advisor can change it.'));
        }
        await journalId.set('sequenceOverrideRegex', false);
      }
    }
    let res;
    if (await this._moveAutocompleteInvoiceLinesWrite(vals)) {
      res = true;
    }
    else {
      pop(vals, 'invoiceLineIds', null);
      res = await _super(AccountMove, await this.withContext({ checkMoveValidity: false, skipAccountMoveSynchronization: true })).write(vals);
    }

    // You can't change the date of a not-locked move to a locked period.
    // You can't post a new journal entry inside a locked period.
    if ('date' in vals || 'state' in vals) {
      await this._checkFiscalyearLockDate();
      await (await this.mapped('lineIds'))._checkTaxLockDate();
    }

    if ('state' in vals && vals['state'] === 'posted') {
      for (const move of await (await this.filtered(async (m) => await m.restrictModeHashTable && !(await m.secureSequenceNumber || await m.inalterableHash))).sorted(async (m) => [await m.date, await m.ref || '', m.id].join(''))) {
        const newNumber = await (await (await move.journalId).secureSequenceId).nextById();
        const valsHashing = { 'secureSequenceNumber': newNumber, 'inalterableHash': await move._getNewHash(newNumber) };
        res = res.or(await _super(AccountMove, move).write(valsHashing));
      }
    }
    // Ensure the move is still well balanced.
    if ('lineIds' in vals && (this._context['checkMoveValidity'] ?? true)) {
      await this._checkBalanced();
    }

    await this._synchronizeBusinessModels(Object.keys(vals));

    return res;
  }

  /**
   * Moves with a sequence number can only be deleted if they are the last element of a chain of sequence.
      If they are not, deleting them would create a gap. If the user really wants to do this, he still can explicitly empty the 'name' field of the move; but we discourage that practice.
   */
  @api.ondelete(false)
  async _unlinkForbidPartsOfChain() {
    if (!this._context['forceDelete'] && !(await this.filtered(async (move) => await move.label !== '/'))._isEndOfSeqChain()) {
      throw new UserError(await this._t("You cannot delete this entry, as it has already consumed a sequence number and is not the last one in the chain. Probably you should revert it instead."));
    }
  }

  async unlink() {
    await (await this['lineIds']).unlink();
    return _super(AccountMove, this).unlink();
  }

  @api.depends('label', 'state')
  async nameGet() {
    const result = [];
    for (const move of this) {
      let label;
      if (this._context['nameGroupby']) {
        const [date, ref, partnerId] = await move('date', 'ref', 'partnerId');
        label = f('**%s**, %s', await formatDate(this.env, date), await move._getMoveDisplayName());
        if (ref) {
          label += f('     (%s)', ref);
        }
        if (await partnerId.label) {
          label += f(' - %s', await partnerId.label);
        }
      }
      else {
        label = await move._getMoveDisplayName(true);
      }
      result.push([move.id, label]);
    }
    return result;
  }

  async _creationSubtype() {
    // OVERRIDE
    if (['outInvoice', 'outRefund', 'outReceipt'].includes(await this['moveType'])) {
      return this.env.ref('account.mtInvoiceCreated');
    }
    else {
      return _super(AccountMove, this)._creationSubtype();
    }
  }

  async _trackSubtype(initValues) {
    // OVERRIDE to add custom subtype depending of the state.
    this.ensureOne();
    const payment = await this('paymentId');
    if (! await this.isInvoice()) {
      if (payment.ok && 'state' in initValues) {
        await payment.messageTrack(['state'], { [payment.id]: initValues });
      }
      return _super(AccountMove, this)._trackSubtype(initValues);
    }

    if ('paymentState' in initValues && await this['paymentState'] === 'paid') {
      return this.env.ref('account.mtInvoicePaid');
    }
    else if ('state' in initValues && await this['state'] === 'posted' && await this.isSaleDocument()) {
      return this.env.ref('account.mtInvoiceValidated');
    }
    return _super(AccountMove, this)._trackSubtype(initValues);
  }

  async _creationMessage() {
    // OVERRIDE
    if (! await this.isInvoice()) {
      return _super(AccountMove, this)._creationMessage();
    }
    return {
      'outInvoice': await this._t('Invoice Created'),
      'outRefund': await this._t('Credit Note Created'),
      'inInvoice': await this._t('Vendor Bill Created'),
      'inRefund': await this._t('Refund Created'),
      'outReceipt': await this._t('Sales Receipt Created'),
      'inReceipt': await this._t('Purchase Receipt Created'),
    }[await this['moveType']]
  }

  // RECONCILIATION METHODS

  /**
   * Collect all information needed to create the tax cash basis journal entries:
      - Determine if a tax cash basis journal entry is needed.
      - Compute the lines to be processed and the amounts needed to compute a percentage.
      @return: A dictionary:
          * move:                     The current account.move record passed as parameter.
          * to_process_lines:         A tuple (caba_treatment, line) where:
                                          - caba_treatment is either 'tax' or 'base', depending on what should
                                            be considered on the line when generating the caba entry.
                                            For example, a line with taxIds=caba and tax_line_id=non_caba
                                            will have a 'base' caba treatment, as we only want to treat its base
                                            part in the caba entry (the tax part is already exigible on the invoice)
 
                                          - line is an account.move.line record being not exigible on the tax report.
          * currency:                 The currency on which the percentage has been computed.
          * totalBalance:            sum(payment_term_lines.mapped('balance').
          * totalResidual:           sum(payment_term_lines.mapped('amount_residual').
          * totalAmountCurrency:    sum(payment_term_lines.mapped('amount_currency').
          * totalResidualCurrency:  sum(payment_term_lines.mapped('amount_residual_currency').
          * isFullyPaid:            A flag indicating the current move is now fully paid.
   * @returns 
   */
  async _collectTaxCashBasisValues() {
    this.ensureOne();

    const values = {
      'move': this,
      'toProcessLines': [],
      'totalBalance': 0.0,
      'totalResidual': 0.0,
      'totalAmountCurrency': 0.0,
      'totalResidualCurrency': 0.0,
    }

    const currencies = {};
    let hasTermLines = false;
    for (const line of await this['lineIds']) {
      const [accountInternalType, balance, taxLineId, currencyId] = await line('accountInternalType', 'balance', 'taxLineId', 'currencyId');
      if (['receivable', 'payable'].includes(accountInternalType)) {
        const [amountResidual, amountCurrency, amountResidualCurrency] = await line('amountResidual', 'amountCurrency', 'amountResidualCurrency');
        const sign = balance > 0.0 ? 1 : -1;

        currencies[currencyId.id] = currencyId;
        hasTermLines = true;
        values['totalBalance'] += sign * balance
        values['totalResidual'] += sign * amountResidual
        values['totalAmountCurrency'] += sign * amountCurrency
        values['totalResidualCurrency'] += sign * amountResidualCurrency
      }
      else if (await taxLineId.taxExigibility === 'onPayment') {
        values['toProcessLines'].push(['tax', line]);
        currencies[currencyId.id] = currencyId;
      }
      else if ((await (await line.taxIds).mapped('taxExigibility')).includes('onPayment')) {
        values['toProcessLines'].push(['base', line]);
        currencies[currencyId.id] = currencyId;;
      }
    }

    if (!bool(values['toProcessLines']) || !hasTermLines) {
      return null;
    }

    // Compute the currency on which made the percentage.
    if (len(currencies) == 1) {
      values['currency'] = Object.values(currencies)[0];
    }
    else {
      // Don't support the case where there is multiple involved currencies.
      return null;
    }

    // Determine whether the move is now fully paid.
    values['isFullyPaid'] = await (await (await this['companyId']).currencyId).isZero(values['totalResidual']) || await values['currency'].isZero(values['totalResidualCurrency']);

    return values;
  }

  // BUSINESS METHODS

  @api.model()
  getInvoiceTypes(includeReceipts: boolean = false) {
    return ['outInvoice', 'outRefund', 'inRefund', 'inInvoice'].concat(includeReceipts && ['outReceipt', 'inReceipt'] || []);
  }

  /**
   * Determines when new_pmt_state must be upated.
      Method created to allow overrides.
      :return: Boolean
    * @returns 
    */
  async _paymentStateMatters() {
    this.ensureOne();
    return this.isInvoice(true);
  }

  async isInvoice(includeReceipts: boolean = false) {
    return this.getInvoiceTypes(includeReceipts).includes(await this['moveType']);
  }

  @api.model()
  getSaleTypes(includeReceipts: boolean = false) {
    return ['outInvoice', 'outRefund'].concat(includeReceipts ? ['outReceipt'] : []);
  }

  async isSaleDocument(includeReceipts: boolean = false) {
    return (this.getSaleTypes(includeReceipts)).includes(await this['moveType']);
  }

  @api.model()
  getPurchaseTypes(includeReceipts: boolean = false) {
    return ['inInvoice', 'inRefund'].concat(includeReceipts ? ['inReceipt'] : []);
  }

  async isPurchaseDocument(includeReceipts: boolean = false) {
    return this.getPurchaseTypes(includeReceipts).includes(await this['moveType']);
  }

  @api.model()
  getInboundTypes(includeReceipts: boolean = true) {
    return ['outInvoice', 'inRefund'].concat(includeReceipts && ['outReceipt'] || []);
  }

  async isInbound(includeReceipts: boolean = true) {
    return this.getInboundTypes(includeReceipts).includes(await this['moveType']);
  }

  @api.model()
  getOutboundTypes(includeReceipts: boolean = true) {
    return ['inInvoice', 'outRefund'].concat(includeReceipts && ['inReceipt'] || []);
  }

  async isOutbound(includeReceipts: boolean = true) {
    return this.getOutboundTypes(includeReceipts).includes(await this['moveType']);
  }

  async _affectTaxReport() {
    return (await this['lineIds']).some((line) => line._affectTaxReport());
  }

  /**
   * This computes the reference based on the RF Creditor Reference.
       The data of the reference is the database id number of the invoice.
       For instance, if an invoice is issued with id 43, the check number
       is 07 so the reference will be 'RF07 43'.
   * @returns 
   */
  async _getInvoiceReferenceEuroInvoice() {
    this.ensureOne();
    const base = this.id;
    const checkDigits = calcCheckDigits(`${base}RF`);
    const reference = f('RF%s %s', checkDigits, Array.from(zipLongest(_.fill(Array(4), iter(String(base))), "")).map(x => x.join(" ")));
    return reference;
  }

  /**
   * This computes the reference based on the RF Creditor Reference.
       The data of the reference is the user defined reference of the
       partner or the database id number of the parter.
       For instance, if an invoice is issued for the partner with internal
       reference 'food buyer 654', the digits will be extracted and used as
       the data. This will lead to a check number equal to 00 and the
       reference will be 'RF00 654'.
       If no reference is set for the partner, its id in the database will
       be used.
   * @returns 
   */
  async _getInvoiceReferenceEuroPartner() {
    this.ensureOne();
    const partnerId = await this['partnerId'];
    const partnerRef = await partnerId.ref;
    let partnerRefNr = (partnerRef || '').replace(/\D/, '').slice(-21) || String(partnerId.id).slice(-21);
    partnerRefNr = partnerRefNr.slice(-21);
    const checkDigits = calcCheckDigits(`${partnerRefNr}RF`);
    const reference = f('RF%s %s', checkDigits, Array.from(zipLongest(_.fill(Array(4), iter(String(partnerRefNr))), "")).map(x => x.join(" ")));
    return reference;
  }

  /**
   * This computes the reference based on the Verp format.
     We simply return the number of the invoice, defined on the journal sequence.
   * @returns 
   */
  async _getInvoiceReferenceVerpInvoice() {
    this.ensureOne();
    return this['label'];
  }

  /**
   * This computes the reference based on the Verp format.
    The data used is the reference set on the partner or its database
    id otherwise. For instance if the reference of the customer is
    'dumb customer 97', the reference will be 'CUST/dumb customer 97'.
   * @returns 
   */
  async _getInvoiceReferenceVerpPartner() {
    const partnerId = await this['partnerId'];
    const ref = await partnerId.ref || String(partnerId.id);
    const prefix = await this._t('CUST');
    return f('%s/%s', prefix, ref);
  }

  async _getInvoiceComputedReference() {
    this.ensureOne();
    const journalId = await this['journalId'];
    if (await journalId.invoiceReferenceType === 'none') {
      return '';
    }
    else {
      const refFunction = this[f('_getInvoiceReference%s%s', _.upperFirst(await journalId.invoiceReferenceModel), _.upperFirst(await journalId.invoiceReferenceType))];
      if (refFunction) {
        return refFunction.call(this);
      }
      else {
        throw new UserError(await this._t('The combination of reference model and reference type on the journal is not implemented'));
      }
    }
  }

  /**
   * Helper to get the display name of an invoice depending of its type.
      :param showRef:    A flag indicating of the display name must include or not the journal entry reference.
      :return:           A string representing the invoice.
   * @param showRef 
   */
  async _getMoveDisplayName(showRef = false) {
    this.ensureOne();
    const [state, label, moveType, ref] = await this('state', 'label', 'moveType', 'ref');
    let name = '';
    if (state === 'draft') {
      name += {
        'outInvoice': await this._t('Draft Invoice'),
        'outRefund': await this._t('Draft Credit Note'),
        'inInvoice': await this._t('Draft Bill'),
        'inRefund': await this._t('Draft Vendor Credit Note'),
        'outReceipt': await this._t('Draft Sales Receipt'),
        'inReceipt': await this._t('Draft Purchase Receipt'),
        'entry': await this._t('Draft Entry'),
      }[moveType];
      name += ' ';
    }
    if (!label || label === '/') {
      name += f('(* %s)', String(this.id));
    }
    else {
      name += label;
    }
    return name + (showRef && ref && ref.length > 50 ? f(' (%s%s)', ref.slice(0, 50), '...') : '') || '';
  }

  /**
   * Hook allowing to retrieve the right delivery address depending of installed modules.
       :return: A res.partner record's id representing the delivery address.
   * @returns 
   */
  async _getInvoiceDeliveryPartnerId() {
    this.ensureOne();
    return (await (await this['partnerId']).addressGet(['delivery']))['delivery'];
  }

  /**
   * Helper used to retrieve the reconciled payments on this journal entry
   * @returns 
   */
  async _getReconciledPayments() {
    const reconciledLines = await (await this['lineIds']).filtered(async (line) => ['receivable', 'payable'].includes(await (await (await line.accountId).userTypeId).type));
    const reconciledAmls = (await reconciledLines.mapped('matchedDebitIds.debitMoveId')).concat(await reconciledLines.mapped('matchedCreditIds.creditMoveId'));
    return (await reconciledAmls.moveId).paymentId;
  }

  /**
   * Helper used to retrieve the reconciled payments on this journal entry
   * @returns 
   */
  async _getReconciledStatementLines() {
    const reconciledLines = await (await this['lineIds']).filtered(async (line) => ['receivable', 'payable'].includes(await (await (await line.accountId).userTypeId).type));
    const reconciledAmls = (await reconciledLines.mapped('matchedDebitIds.debitMoveId')).concat(await reconciledLines.mapped('matchedCreditIds.creditMoveId'));
    return (await reconciledAmls.moveId).statementLineId;
  }

  /**
   * Helper used to retrieve the reconciled payments on this journal entry
   * @returns 
   */
  async _getReconciledInvoices() {
    const reconciledLines = (await this['lineIds']).filtered(async (line) => ['receivable', 'payable'].includes(await (await (await line.accountId).userTypeId).type));
    const reconciledAmls = (await reconciledLines.mapped('matchedDebitIds.debitMoveId')).concat(await reconciledLines.mapped('matchedCreditIds.creditMoveId'));
    return (await reconciledAmls.moveId).filtered((move) => move.isInvoice());
  }

  /**
   * Helper to retrieve the details about reconciled invoices.
       :return A list of tuple (partial, amount, invoice_line).
   * @returns 
   */
  async _getReconciledInvoicesPartials() {
    this.ensureOne();
    const payTermLines = await (await this['lineIds'])
      .filtered(async (line) => ['receivable', 'payable'].includes(await line.accountInternalType));
    const invoicePartials = [];

    for (const partial of await payTermLines.matchedDebitIds) {
      invoicePartials.push([partial, await partial.creditAmountCurrency, await partial.debitMoveId]);
    }
    for (const partial of await payTermLines.matchedCreditIds) {
      invoicePartials.push([partial, await partial.debitAmountCurrency, await partial.creditMoveId]);
    }
    return invoicePartials;
  }

  /**
   * Reverse values passed as parameter being the copied values of the original journal entry.
       For example, debit / credit must be switched. The tax lines must be edited in case of refunds.
 
       :param default_values:  A copy_date of the original journal entry.
       :param cancel:          A flag indicating the reverse is made to cancel the original journal entry.
       :return:                The updated default_values.
   * @param defaultValues 
   * @param cancel 
   * @returns 
   */
  async _reverseMoveVals(defaultValues, cancel: boolean = true) {
    this.ensureOne();

    /**
     * Computes and returns a mapping between the current repartition lines to the new expected one.
        :param move_vals:   The newly created invoice as a dictionary to be passed to the 'create' method.
        :return:            A map invoice_repartition_line => refund_repartition_line.
     * @param moveVals 
     * @returns 
     */
    async function computeTaxRepartitionLinesMapping(moveVals) {
      // invoice_repartition_line => refund_repartition_line
      const mapping = new Map<any, any>();

      // Do nothing if the move is not a credit note.
      if (!['outRefund', 'inRefund'].includes(moveVals['moveType'])) {
        return mapping;
      }

      for (const lineCommand of (moveVals['lineIds'] ?? [])) {
        const lineVals = lineCommand[2]  // [0, 0, {...}]

        let taxIds;
        if (bool(lineVals['taxLineId'])) {
          // Tax line.
          taxIds = [lineVals['taxLineId']];
        }
        else if (bool(lineVals['taxIds']) && bool(lineVals['taxIds'][0][2])) {
          // Base line.
          taxIds = lineVals['taxIds'][0][2];
        }
        else {
          continue;
        }
        for (const tax of await this.env.items('account.tax').browse(taxIds).flattenTaxesHierarchy()) {
          for (const [invRepLine, refRepLine] of _.zip([...await tax.invoiceRepartitionLineIds], [...await tax.refundRepartitionLineIds])) {
            mapping.set(invRepLine, refRepLine);
          }
        }
      }

      return mapping;
    }

    const moveVals = (await (await this.withContext({ includeBusinessFields: true })).copyData(defaultValues))[0];

    const taxRepartitionLinesMapping = await computeTaxRepartitionLinesMapping(moveVals);

    for (const lineCommand of (moveVals['lineIds'] ?? [])) {
      const lineVals = lineCommand[2]  // [0, 0, {...}]

      // ==== Inverse debit / credit / amountCurrency ====
      const amountCurrency = -(lineVals['amountCurrency'] || 0.0);
      const balance = lineVals['credit'] - lineVals['debit'];

      if ('taxTagInvert' in lineVals) {
        // This is an editable computed field; we want to it recompute itself
        delete lineVals['taxTagInvert'];
      }

      update(lineVals, {
        'amountCurrency': amountCurrency,
        'debit': balance > 0.0 ? balance : 0.0,
        'credit': balance < 0.0 ? -balance : 0.0,
      })

      if (!['outRefund', 'inRefund'].includes(moveVals['moveType'])) {
        continue;
      }

      // ==== Map tax repartition lines ====
      if (lineVals['taxRepartitionLineId']) {
        // Tax line.
        const invoiceRepartitionLine = this.env.items('account.tax.repartition.line').browse(lineVals['taxRepartitionLineId']);
        if (!(taxRepartitionLinesMapping.has(invoiceRepartitionLine))) {
          throw new UserError(await this._t("It seems that the taxes have been modified since the creation of the journal entry. You should create the credit note manually instead."));
        }
        const refundRepartitionLine = taxRepartitionLinesMapping.get(invoiceRepartitionLine);

        // Find the right account.
        let accountId = (await this.env.items('account.move.line')._getDefaultTaxAccount(refundRepartitionLine)).id;
        if (!accountId) {
          if (!(await invoiceRepartitionLine.accountId).ok) {
            // Keep the current account as the current one comes from the base line.
            accountId = lineVals['accountId'];
          }
          else {
            const tax = await invoiceRepartitionLine.invoiceTaxId;
            const baseLine = (await (await this['lineIds']).filtered(async (line) => (await (await line.taxIds).flattenTaxesHierarchy()).includes(tax)))[0];
            accountId = (await baseLine.accountId).id
          }
        }

        let tags = await refundRepartitionLine.tagIds;
        if (bool(lineVals['taxIds'])) {
          const subsequentTaxes = this.env.items('account.tax').browse(lineVals['taxIds'][0][2]);
          tags = tags.add((await (await subsequentTaxes.refundRepartitionLineIds).filtered(async (x) => x.repartitionType === 'base')).tagIds);
        }

        update(lineVals, {
          'taxRepartitionLineId': refundRepartitionLine.id,
          'accountId': accountId,
          'taxTagIds': [[6, 0, tags.ids]],
        });
      }
      else if (bool(lineVals['taxIds']) && bool(lineVals['taxIds'][0][2])) {
        // Base line.
        const taxes = await this.env.items('account.tax').browse(lineVals['taxIds'][0][2]).flattenTaxesHierarchy();
        const invoiceRepartitionLines = await (await taxes
          .mapped('invoiceRepartitionLineIds'))
          .filtered(async (line) => await line.repartitionType === 'base');
        const refundRepartitionLines = await invoiceRepartitionLines
          .mapped(async (line) => taxRepartitionLinesMapping.get(line));

        lineVals['taxTagIds'] = [[6, 0, (await refundRepartitionLines.mapped('tagIds')).ids]];
      }
    }

    return moveVals;
  }

  /**
   * Reverse a recordset of account.move.
     If cancel parameter is true, the reconcilable or liquidity lines
     of each original move will be reconciled with its reverse's.
 
     :param default_values_list: A list of default values to consider per move.
                                 ('type' & 'reversed_entry_id' are computed in the method).
     :return:                    An account.move recordset, reverse of the current this.
   * @param defaultValuesList 
   * @param cancel 
   * @returns 
   */
  async _reverseMoves(defaultValuesList?: any, cancel: boolean = false) {
    if (!bool(defaultValuesList)) {
      defaultValuesList = await this.map(move => { });
    }
    if (cancel) {
      const lines = await this.mapped('lineIds');
      // Avoid maximum recursion depth.
      if (bool(lines)) {
        await lines.removeMoveReconcile();
      }
    }
    const reverseTypeMap = {
      'entry': 'entry',
      'outInvoice': 'outRefund',
      'outRefund': 'entry',
      'inInvoice': 'inRefund',
      'inRefund': 'entry',
      'outReceipt': 'entry',
      'inReceipt': 'entry',
    }

    const moveValsList = [];
    for (const [move, defaultValues] of _.zip([...this], defaultValuesList)) {
      update(defaultValues, {
        'moveType': reverseTypeMap[await move.moveType],
        'reversedEntryId': move.id,
      });
      moveValsList.push(await (await move.withContext({ moveReverseCancel: cancel }))._reverseMoveVals(defaultValues, cancel));
    }
    const reverseMoves = await this.env.items('account.move').create(moveValsList);
    for (const [move, reverseMove] of _.zip([...this], [...await reverseMoves.withContext({ checkMoveValidity: false })])) {
      // Update amount_currency if the date has changed.
      if (await move.date != await reverseMove.date) {
        for (const line of await reverseMove.lineIds) {
          if (bool(await line.currencyId)) {
            await line._onchangeCurrency();
          }
        }
      }
      await reverseMove._recomputeDynamicLines(false);
    }
    await reverseMoves._checkBalanced();

    // Reconcile moves together to cancel the previous one.
    if (cancel) {
      await (await reverseMoves.withContext({ moveReverseCancel: cancel }))._post(false);
      for (const [move, reverseMove] of _.zip([...this], [...reverseMoves])) {
        const lines = await (await move.lineIds).filtered(
          async (x) => {
            const accountId = await x.accountId;
            return (await accountId.reconcile || await accountId.internalType === 'liquidity') && !x.reconciled;
          }
        )
        for (const line of lines) {
          const [accountId, currencyId] = await line('accountId', 'currencyId');
          const counterpartLines = await (await reverseMove.lineIds).filtered(
            async (x) => {
              return (await x.accountId).eq(accountId) && (await x.currencyId).eq(currencyId) && ! await x.reconciled;
            }
          )
          await (await line.add(counterpartLines).withContext({ moveReverseCancel: cancel })).reconcile();
        }
      }
    }

    return reverseMoves;
  }


  /**
   * Hook allowing custom code when an invoice becomes ready to be sent by mail to the customer.
          For example, when an EDI document must be sent to the government and be signed by it.
   */
  async _actionInvoiceReadyToBeSent() {
    //pass
  }

  /**
   * Helper telling if a journal entry is ready to be sent by mail to the customer.
      :return: true if the invoice is ready, false otherwise.
   * @returns 
   */
  _isReadyToBeSent() {
    this.ensureOne();
    return true;
  }

  @contextmanager()
  async* _sendOnlyWhenReady() {
    let movesNotReady = await this.filtered((x) => !x._isReadyToBeSent());

    try {
      yield;
    }
    finally {
      const movesNowReady = await movesNotReady.filtered((x) => x._isReadyToBeSent());
      if (bool(movesNowReady)) {
        await movesNowReady._actionInvoiceReadyToBeSent();
      }
    }

  }

  async openReconcileView() {
    return (await this['lineIds']).openReconcileView();
  }

  async openBankStatementView() {
    return {
      'type': 'ir.actions.actwindow',
      'resModel': 'account.bank.statement',
      'viewMode': 'form',
      'resId': (await this['statementId']).id,
      'views': [[false, 'form']],
    }
  }

  async openPaymentView() {
    return {
      'type': 'ir.actions.actwindow',
      'resModel': 'account.payment',
      'viewMode': 'form',
      'resId': (await this['paymentId']).id,
      'views': [[false, 'form']],
    }
  }

  async openCreatedCabaEntries() {
    this.ensureOne();
    return {
      'type': 'ir.actions.actwindow',
      'label': await this._t("Cash Basis Entries"),
      'resModel': 'account.move',
      'viewMode': 'form',
      'domain': [['id', 'in', (await this['taxCashBasisCreatedMoveIds']).ids]],
      'views': [[(await this.env.ref('account.viewMoveTree')).id, 'tree'], [false, 'form']],
    }
  }

  @api.model()
  async messageNew(msgDict, customValues?: any) {
    // OVERRIDE
    // Add custom behavior when receiving a new invoice through the mail's gateway.
    if (!['outInvoice', 'inInvoice'].includes((customValues ?? {})['moveType'] ?? 'entry')) {
      return _super(AccountMove, this).messageNew(msgDict, customValues);
    }

    async function isInternalPartner(partner) {
      // Helper to know if the partner is an internal one.
      const userIds = await partner.userIds;
      return userIds.ok && await userIds.all(user => user.hasGroup('base.groupUser'));
    }

    let extraDomain;// = false;
    if (customValues['companyId']) {
      extraDomain = ['|', ['companyId', '=', customValues['companyId']], ['companyId', '=', false]];
    }

    // Search for partners in copy.
    const ccMailAddresses = emailSplit(msgDict['cc'] || '');
    const followers = await (await (this as any)._mailFindPartnerFromEmails(ccMailAddresses, { extraDomain: extraDomain })).filter(partner => bool(partner));

    // Search for partner that sent the mail.
    const fromMailAddresses = emailSplit(msgDict['from'] || '');
    let senders, partners;
    senders = partners = await (await (this as any)._mailFindPartnerFromEmails(fromMailAddresses, { extraDomain: extraDomain })).filter(partner => bool(partner));

    // Search for partners using the user.
    if (!bool(senders)) {
      senders = partners = Array.from(await (this as any)._mailSearchOnUser(fromMailAddresses));
    }

    if (bool(partners)) {
      // Check we are not in the case when an internal user forwarded the mail manually.
      if (await isInternalPartner(partners[0])) {
        // Search for partners in the mail's body.
        const bodyMailAddresses = Array.from(msgDict['body'].matchAll(emailRe));
        partners = await (await (this as any)._mailFindPartnerFromEmails(bodyMailAddresses, { extraDomain: extraDomain })).filter(async (partner) => ! await isInternalPartner(partner));
      }
    }

    // Little hack: Inject the mail's subject in the body.
    if (msgDict['subject'] && msgDict['body']) {
      msgDict['body'] = f('<div><div><h3>%s</h3></div>%s</div>', msgDict['subject'], msgDict['body']);
    }
    // Create the invoice.
    const values = {
      'label': '/',  // we have to give the name otherwise it will be set to the mail's subject
      'invoiceSourceEmail': fromMailAddresses[0],
      'partnerId': bool(partners) && bool(partners[0].id) ? partners[0].id : false,
    }
    const moveCtx = await this.withContext({ default_moveType: customValues['moveType'], default_journalId: customValues['journalId'] });
    const move = await _super(AccountMove, moveCtx).messageNew(msgDict, values);
    await move._computeName();  // because the name is given, we need to recompute in case it is the first invoice of the journal

    // Assign followers.
    const allFollowersIds = new Set(await (await followers.concat(senders).concat(partners).filter(partner => isInternalPartner(partner))).map(partner => partner.id));
    await move.messageSubscribe(Array.from(allFollowersIds));
    return move;
  }

  async post() {
    return this.actionPost();
  }

  /**
   * Post/Validate the documents.
 
    Posting the documents will give it a number, and check that the document is
    complete (some fields might not be required if not posted but are required
    otherwise).
    If the journal is locked with a hash table, it will be impossible to change
    some fields afterwards.
 
    :param soft (bool): if true, future documents are not immediately posted,
        but are set to be auto posted automatically at the set accounting date.
        Nothing will be performed on those documents before the accounting date.
    :return Model<account.move>: the documents that have been posted
   * @param soft 
   */
  async _post(soft = true) {
    let toPost;
    if (soft) {
      const futureMoves = await this.filtered(async (move) => await move.date > await _Date.contextToday(this));
      await futureMoves.set('autoPost', true);
      for (const move of futureMoves) {
        const msg = _f(await this._t('This move will be posted at the accounting date: {date}'), { date: await formatDate(this.env, await move.date) });
        await move.messagePost({ body: msg });
      }
      toPost = this.sub(futureMoves);
    }
    else {
      toPost = this;
    }
    // `user_has_group` won't be bypassed by `sudo()` since it doesn't change the user anymore.
    if (!this.env.su && ! await (await this.env.user()).hasGroup('account.groupAccountInvoice')) {
      throw new AccessError(await this._t("You don't have the access rights to post an invoice."));
    }
    for (const move of toPost) {
      if ((await move.partnerBankId).ok && !await (await move.partnerBankId).active) {
        throw new UserError(await this._t("The recipient bank account link to this invoice is archived.\nSo you cannot confirm the invoice."));
      }
      if (await move.state === 'posted') {
        throw new UserError(await this._t('The entry %s (id %s) is already posted.', await move.label, move.id));
      }
      if ((await (await move.lineIds).filtered(async (line) => !await line.displayType)).nok) {
        throw new UserError(await this._t('You need to add a line before posting.'));
      }
      const [date, journalId] = await move('date', 'journalId');
      if (await move.autoPost && date > await _Date.contextToday(this)) {
        const dateMsg = DateTime.fromJSDate(date).toFormat(await (await getLang(this.env)).dateFormat);
        throw new UserError(await this._t("This move is configured to be auto-posted on %s", dateMsg));
      }
      if (! await journalId.active) {
        throw new UserError(_f(await this._t(
          "You cannot post an entry in an archived journal ({journal})"),
          { journal: await journalId.displayName },
        ));
      }
      if (!(await move.partnerId).ok) {
        if (await move.isSaleDocument()) {
          throw new UserError(await this._t("The field 'Customer' is required, please complete it to validate the Customer Invoice."));
        }
        else if (await move.isPurchaseDocument()) {
          throw new UserError(await this._t("The field 'Vendor' is required, please complete it to validate the Vendor Bill."));
        }
      }
      if (await move.isInvoice(true) && floatCompare(await move.amountTotal, 0.0, { precisionRounding: await (await move.currencyId).rounding }) < 0) {
        throw new UserError(await this._t("You cannot validate an invoice with a negative total amount. You should create a credit note instead. Use the action menu to transform it into a credit note or refund."));
      }

      if (await move.displayInactiveCurrencyWarning) {
        throw new UserError(await this._t("You cannot validate an invoice with an inactive currency: %s", await (await move.currencyId).label));
      }
      // Handle case when the invoiceDate is not set. In that case, the invoiceDate is set at today and then, lines are recomputed accordingly.
      // /!\ 'checkMoveValidity' must be there since the dynamic lines will be recomputed outside the 'onchange'  environment.
      if (! await move.invoiceDate) {
        if (await move.isSaleDocument(true)) {
          await move.set('invoiceDate', await _Date.contextToday(this));
          await (await move.withContext({ checkMoveValidity: false }))._onchangeInvoiceDate();
        }
        else if (await move.isPurchaseDocument(true)) {
          throw new UserError(await this._t("The Bill/Refund date is required to validate this document."));
        }
      }
      // When the accounting date is prior to the tax lock date, move it automatically to today.
      // /!\ 'check_move_validity' must be there since the dynamic lines will be recomputed outside the 'onchange'
      // environment.
      const [companyId, lineIds, invoiceDate] = await move('companyId', 'lineIds', 'invoiceDate');
      if ((await companyId.taxLockDate && date <= await companyId.taxLockDate) && ((await lineIds.taxIds).ok || (await lineIds.taxTagIds).ok)) {
        await move.set('date', await move._getAccountingDate(invoiceDate || date, true));
        await (await move.withContext({ checkMoveValidity: false }))._onchangeCurrency();
      }
    }
    // Create the analytic lines in batch is faster as it leads to less cache invalidation.
    await (await toPost.mapped('lineIds')).createAnalyticLines();
    await toPost.write({
      'state': 'posted',
      'postedBefore': true,
    })

    for (const move of toPost) {
      await move.messageSubscribe(await (await (await move.partnerId).filter(async (p) => !(await (await move.sudo()).messagePartnerIds).includes(p))).map(p => p.id));
      // [p.id for p in [move.partnerId] if p not in move.sudo().message_partner_ids])

      // Compute 'ref' for 'outInvoice'.
      if (await move._autoComputeInvoiceReference()) {
        const toWrite = {
          'paymentReference': await move._getInvoiceComputedReference(),
          'lineIds': []
        }
        for (const line of await (await move.lineIds).filtered(async (line) => ['receivable', 'payable'].includes(await (await (await line.accountId).userTypeId).type))) {
          toWrite['lineIds'].push([1, line.id, { 'label': toWrite['paymentReference'] }]);
        }
        await move.write(toWrite);
      }
    }

    for (const move of toPost) {
      const [journalId, invoiceUserId] = await move('journalId', 'invoiceUserId');
      const [saleActivityTypeId, saleActivityUserId, saleActivityNote] = await journalId('saleActivityTypeId', 'saleActivityUserId', 'saleActivityNote');
      if (await move.isSaleDocument() && saleActivityTypeId.ok
        && ![(await this.env.ref('base.userRoot')).id, false].includes((saleActivityUserId.ok ? saleActivityUserId : invoiceUserId).id)) {
        const dateMaturity = await (await (await move.lineIds).mapped('dateMaturity')).filter(date => bool(date));
        await move.activitySchedule({
          dateDeadline: len(dateMaturity) ? dateMin(dateMaturity) : await move.date,
          activityTypeId: saleActivityTypeId.id,
          summary: saleActivityNote,
          userId: saleActivityUserId.id || invoiceUserId.id,
        });
      }
    }

    const [customerCount, supplierCount] = [new Map(), new Map()];//defaultdict(int), defaultdict(int)
    for (const move of toPost) {
      const partnerId = await move.partnerId;
      if (await move.isSaleDocument()) {
        if (!customerCount.has(partnerId)) {
          customerCount.set(partnerId, 0);
        }
        customerCount.set(partnerId, customerCount.get(partnerId) + 1);
      }
      else if (await move.isPurchaseDocument()) {
        if (!supplierCount.has(partnerId)) {
          supplierCount.set(partnerId, 0);
        }
        supplierCount.set(partnerId, supplierCount.get(partnerId) + 1);
      }
    }
    for (const [partner, count] of customerCount) {
      await partner.or(await partner.commercialPartnerId)._increaseRank('customerRank', count);
    }
    for (const [partner, count] of supplierCount) {
      await partner.or(await partner.commercialPartnerId)._increaseRank('supplierRank', count);
    }

    // Trigger action for paid invoices in amount is zero
    await (await toPost.filtered(
      async (m) => await m.isInvoice(true) && await (await m.currencyId).isZero(await m.amountTotal)
    )).actionInvoicePaid();

    // Force balance check since nothing prevents another module to create an incorrect entry.
    // This is performed at the very end to avoid flushing fields before the whole processing.
    await toPost._checkBalanced();
    return toPost;
  }

  /**
   * Hook to be overridden to set custom conditions for auto-computed invoice references.
         :return true if the move should get a auto-computed reference else false
         :rtype bool
   * @returns 
   */
  async _autoComputeInvoiceReference() {
    this.ensureOne();
    return await this['moveType'] === 'outInvoice' && ! await this['paymentReference'];
  }

  async actionReverse() {
    const action = await this.env.items("ir.actions.actions")._forXmlid("account.actionViewAccountMoveReversal");

    if (await this.isInvoice()) {
      action['label'] = await this._t('Credit Note')
    }

    return action;
  }

  async actionPost() {
    const paymentId = await this['paymentId'];
    if (paymentId.ok) {
      await paymentId.actionPost();
    }
    else {
      await this._post(false);
    }
    return false;
  }

  /**
   * Called by the 'payment' widget to reconcile a suggested journal item to the present
      invoice.
 
      :param lineId: The id of the line to reconcile with the current invoice.
   * @param lineId 
   * @returns 
   */
  async jsAssignOutstandingLine(lineId: number) {
    this.ensureOne();
    let lines = this.env.items('account.move.line').browse(lineId);
    lines = lines.add(await (await this['lineIds']).filtered(async (line) => (await line.accountId).eq(await lines[0].accountId) && ! await line.reconciled));
    return lines.reconcile();
  }

  /**
   * Called by the 'payment' widget to remove a reconciled entry to the present invoice.
 
      :param partial_id: The id of an existing partial reconciled with the current invoice.
   * @param partialId 
   * @returns 
   */
  async jsRemoveOutstandingPartial(partialId: number) {
    this.ensureOne();
    const partial = this.env.items('account.partial.reconcile').browse(partialId);
    return partial.unlink();
  }

  async buttonSetChecked() {
    for (const move of this) {
      await move.set('toCheck', false);
    }
  }

  async buttonDraft() {
    let accountMoveLine = this.env.items('account.move.line');
    let excludedMoveIds = [];

    if (this._context['suspenseMovesMode']) {
      excludedMoveIds = (await (await accountMoveLine.search(
        (await accountMoveLine._getSuspenseMovesDomain()).conact([['moveId', 'in', this.ids]])
      )).mapped('moveId')).ids;
    }

    for (const move of this) {
      if ((await (await move.lineIds).mapped('fullReconcileId.exchangeMoveId')).includes(move)) {
        throw new UserError(await this._t('You cannot reset to draft an exchange difference journal entry.'));
      }
      if (bool(await move.taxCashBasisRecId) || bool(await move.taxCashBasisOriginMoveId)) {
        // If the reconciliation was undone, move.tax_cash_basis_rec_id will be empty;
        // but we still don't want to allow setting the caba entry to draft
        // (it'll have been reversed automatically, so no manual intervention is required),
        // so we also check tax_cash_basis_origin_move_id, which stays unchanged
        // (we need both, as tax_cash_basis_origin_move_id did not exist in older versions).
        throw new UserError(await this._t('You cannot reset to draft a tax cash basis journal entry.'));
      }
      if (await move.restrictModeHashTable && await move.state === 'posted' && !excludedMoveIds.includes(move.id)) {
        throw new UserError(await this._t('You cannot modify a posted entry of this journal because it is in strict mode.'));
      }
      // We remove all the analytics entries for this journal
      await (await move.mapped('lineIds.analyticLineIds')).unlink();
    }
    await (await this.mapped('lineIds')).removeMoveReconcile();
    await this.write({ 'state': 'draft', 'isMoveSent': false });
  }

  async buttonCancel() {
    await this.write({ 'autoPost': false, 'state': 'cancel' });
  }

  /**
   * :return: the correct mail template based on the current move type
   * @returns 
   */
  async _getMailTemplate(): Promise<string> {
    return await this.all(async (move) => await move.moveType === 'outRefund')
      ? 'account.emailTemplateEdiCreditNote'
      : 'account.emailTemplateEdiInvoice';
  }

  async actionSendAndPrint() {
    return {
      'label': await this._t('Send Invoice'),
      'resModel': 'account.invoice.send',
      'viewMode': 'form',
      'context': {
        'default_templateId': (await this.env.ref(await this._getMailTemplate())).id,
        'markInvoiceAsSent': true,
        'activeModel': 'account.move',
        // Setting both activeId and activeIds is required, mimicking how direct call to
        // ir.actions.actwindow works
        'activeId': this.ids[0],
        'activeIds': this.ids,
        'customLayout': 'mail.mailNotificationPaynow',
      },
      'target': 'new',
      'type': 'ir.actions.actwindow',
    }
  }

  /**
   * Open a window to compose an email, with the edi invoice template
                     message loaded by default
   * @returns 
   */
  async actionInvoiceSent() {
    this.ensureOne();
    const template = await this.env.ref(await this._getMailTemplate(), false);
    let lang;// = false
    if (template) {
      lang = (await template._renderLang(this.ids))[this.id];
    }
    if (!bool(lang)) {
      lang = await (await getLang(this.env)).code;
    }
    const composeForm = await this.env.ref('account.accountInvoiceSendWizardForm', false);
    const ctx = {
      default_model: 'account.move',
      default_resId: this.id,
      // For the sake of consistency we need a default_resModel if
      // default_resId is set. Not renaming default_model as it can
      // create many side-effects.
      default_resModel: 'account.move',
      default_useTemplate: bool(template),
      default_templateId: template.ok && bool(template.id) ? template.id : false,
      default_compositionMode: 'comment',
      markInvoiceAsSent: true,
      customLayout: "mail.mailNotificationPaynow",
      modelDescription: await (await this.withContext({ lang: lang })).typeName,
      forceEmail: true,
      wizardOpened: true
    }
    return {
      'label': await this._t('Send Invoice'),
      'type': 'ir.actions.actwindow',
      'viewType': 'form',
      'viewMode': 'form',
      'resModel': 'account.invoice.send',
      'views': [[composeForm.id, 'form']],
      'viewId': composeForm.id,
      'target': 'new',
      'context': ctx,
    }
  }


  _getIntegrityHashFields() {
    // Use the latest hash version by default, but keep the old one for backward compatibility when generating the integrity report.
    const hashVersion = this._context['hashVersion'] ?? MAX_HASH_VERSION;
    if (hashVersion == 1) {
      return ['date', 'journalId', 'companyId'];
    }
    else if (hashVersion == MAX_HASH_VERSION) {
      return ['label', 'date', 'journalId', 'companyId'];
    }
    throw new NotImplementedError(`hashVersion=${hashVersion} doesn't exist`);
  }

  async _getIntegrityHashFieldsAndSubfields() {
    return this._getIntegrityHashFields().concat((await this['lineIds'])._getIntegrityHashFields().map(subfield => `lineIds.${subfield}`));
  }

  /**
   * Returns the hash to write on journal entries when they get posted
   * @param secureSeqNumber 
   * @returns 
   */
  async _getNewHash(secureSeqNumber) {
    this.ensureOne();
    //get the only one exact previous move in the securisation sequence
    const prevMove = await this.search([
      ['state', '=', 'posted'],
      ['companyId', '=', (await this['companyId']).id],
      ['journalId', '=', (await this['journalId']).id],
      ['secureSequenceNumber', '!=', 0],
      ['secureSequenceNumber', '=', tools.parseInt(secureSeqNumber) - 1]
    ]);
    if (prevMove.ok && prevMove._length != 1) {
      throw new UserError(await this._t('An error occured when computing the inalterability. Impossible to get the unique previous posted journal entry.'));
    }

    //build and return the hash
    return this._computeHash(prevMove.ok ? await prevMove.inalterableHash : '');
  }

  /**
   * Computes the hash of the browse_record given as self, based on the hash
     of the previous record in the company's securisation sequence given as parameter
   * @param previousHash 
   * @returns 
   */
  async _computeHash(previousHash) {
    this.ensureOne();
    return sha256(Buffer.from(previousHash + await this['stringToHash']).toString('utf-8'));
  }

  @api.depends((self) => self._getIntegrityHashFieldsAndSubfields())
  @api.dependsContext('hashVersion')
  async _computeStringToHash() {
    function _getattrstring(obj, fieldStr) {
      let fieldValue = obj[fieldStr];
      if (obj._fields[fieldStr].type === 'many2one') {
        fieldValue = fieldValue.id;
      }
      return String(fieldValue);
    }

    for (const move of this) {
      const values = {};
      for (const field of INTEGRITY_HASH_MOVE_FIELDS) {
        values[field] = _getattrstring(move, field);
      }

      for (const line of await move.lineIds) {
        for (const field of INTEGRITY_HASH_LINE_FIELDS) {
          const k = f('line_%s_%s', line.id, field);
          values[k] = _getattrstring(line, field)
        }
      }
      //make the json serialization canonical
      //  (https://tools.ietf.org/html/draft-staykov-hu-json-canonical-form-00)
      await move.set('stringToHash', stringify(values));
      // sort_keys: true, ensure_ascii: true, indent=None, separators=(',',':'))
    }
  }

  /**
   * Print the invoice and mark it as sent, so that we can see more
         easily the next step of the workflow
   * @returns 
   */
  async actionInvoicePrint() {
    if (await this.some(async (move) => ! await move.isInvoice())) {
      throw new UserError(await this._t("Only invoices could be printed."));
    }

    await (await this.filtered(async (inv) => ! await inv.isMoveSent)).write({ 'isMoveSent': true });
    if (await this.userHasGroups('account.groupAccountInvoice')) {
      return (await this.env.ref('account.accountInvoices')).reportAction(this);
    }
    else {
      return (await this.env.ref('account.accountInvoicesWithoutPayment')).reportAction(this);
    }
  }

  /**
   * Hook to be overrided called when the invoice moves to the paid state.
   */
  async actionInvoicePaid() {
    //  pass
  }

  /**
   * Open the account.payment.register wizard to pay the selected journal entries.
      :return: An action opening the account.payment.register wizard.
   * @returns 
   */
  async actionRegisterPayment() {
    return {
      'label': await this._t('Register Payment'),
      'resModel': 'account.payment.register',
      'viewMode': 'form',
      'context': {
        'activeModel': 'account.move',
        'activeIds': this.ids,
      },
      'target': 'new',
      'type': 'ir.actions.actwindow',
    }
  }

  async actionSwitchInvoiceIntoRefundCreditNote() {
    if (await this.some(async (move) => !['inInvoice', 'outInvoice'].includes(await move.moveType))) {
      throw new ValidationError(await this._t("This action isn't available for this document."));
    }

    for (const move of this) {
      const reversedMove = await move._reverseMoveVals({}, false);
      const newInvoiceLineIds = [];
      for (const [cmd, virtualid, lineVals] of reversedMove['lineIds']) {
        if (!lineVals['excludeFromInvoiceTab']) {
          newInvoiceLineIds.push([0, 0, lineVals]);
        }
      }

      if (await move.amountTotal < 0) {
        // Inverse all invoiceLineIds
        for (const [cmd, virtualid, lineVals] of newInvoiceLineIds) {
          update(lineVals, {
            'quantity': -lineVals['quantity'],
            'amountCurrency': -lineVals['amountCurrency'],
            'debit': lineVals['credit'],
            'credit': lineVals['debit']
          });
        }
      }
      await move.write({
        'moveType': (await move.moveType).replace('Invoice', 'Refund'),
        'invoiceLineIds': [[5, 0, 0]],
        'partnerBankId': false,
      })
      await move.write({ 'invoiceLineIds': newInvoiceLineIds });
    }
  }

  async _getReportBaseFilename() {
    return this._getMoveDisplayName();
  }

  /**
   * This method need to be inherit by the localizations if they want to print a custom invoice report instead of the default one. For example please review the l10n_ar module
   * @returns 
   */
  async _getNameInvoiceReport() {
    this.ensureOne();
    return 'account.reportInvoiceDocument';
  }

  async previewInvoice() {
    this.ensureOne();
    return {
      'type': 'ir.actions.acturl',
      'target': 'self',
      'url': await (this as any).getPortalUrl(),
    }
  }

  async _computeAccessUrl() {
    await _super(AccountMove, this)._computeAccessUrl();
    for (const move of await this.filtered((move) => move.isInvoice())) {
      await move.set('accessUrl', f('/my/invoices/%s', move.id));
    }
  }

  @api.depends('lineIds')
  async _computeHasReconciledEntries() {
    for (const move of this) {
      await move.set('hasReconciledEntries', len(await (await move.lineIds)._reconciledLines()) > 1);
    }
  }

  @api.depends('companyId')
  async _computeDisplayQrCode() {
    for (const record of this) {
      await record.set('displayQrCode', (
        ['outInvoice', 'outReceipt', 'inInvoice', 'inReceipt'].includes(await record.moveType))
        && await (await record.companyId).qrCode
      )
    }
  }

  async actionViewReverseEntry() {
    this.ensureOne();

    // Create action.
    const action = {
      'label': await this._t('Reverse Moves'),
      'type': 'ir.actions.actwindow',
      'resModel': 'account.move',
    }
    const reverseEntries = await this.env.items('account.move').search([['reversedEntryId', '=', this.id]]);
    if (len(reverseEntries) == 1) {
      update(action, {
        'viewMode': 'form',
        'resId': reverseEntries.id,
      });
    }
    else {
      update(action, {
        'viewMode': 'tree',
        'domain': [['id', 'in', reverseEntries.ids]],
      });
    }
    return action;
  }

  /**
   * This method is called from a cron job.
     It is used to post entries such as those created by the module
     account_asset.
   */
  @api.model()
  async _autopostDraftEntries() {
    const records = await this.search([
      ['state', '=', 'draft'],
      ['date', '<=', await _Date.contextToday(this)],
      ['autoPost', '=', true],
    ]);
    for (const ids of this._cr.splitForInConditions(records.ids, 1000)) {
      await this.browse(ids)._post();
      if (!this.env.registry.inTestMode()) {
        await this._cr.commit();
        await this._cr.reset();
      }
    }
  }

  // offer the possibility to duplicate thanks to a button instead of a hidden menu, which is more visible
  async actionDuplicate() {
    this.ensureOne();
    const action = await this.env.items("ir.actions.actions")._forXmlid("account.actionMoveJournalLine");
    action['context'] = Object.assign({}, this.env.context);
    action['context']['formViewInitialMode'] = 'edit';
    action['context']['viewNoMaturity'] = false;
    action['views'] = [[(await this.env.ref('account.viewMoveForm')).id, 'form']];
    action['resId'] = (await this.copy()).id;
    return action;
  }

  async actionActivateCurrency() {
    await (await (await this['currencyId']).filtered(async (currency) => ! await currency.active)).write({ 'active': true });
  }

  @api.model()
  async _moveDictToPreviewVals(moveVals, currencyId?: any) {
    const previewVals = {
      'groupName': f("%s, %s", await formatDate(this.env, moveVals['date']) || await this._t('[Not set]'), moveVals['ref']),
      'itemsVals': moveVals['lineIds'],
    };
    for (const line of previewVals['itemsVals']) {
      if ('partnerId' in line[2]) {
        // sudo is needed to compute displayName in a multi companies environment
        line[2]['partnerId'] = await (await this.env.items('res.partner').browse(line[2]['partnerId']).sudo()).displayName;
      }
      line[2]['accountId'] = await this.env.items('account.account').browse(line[2]['accountId']).displayName || await this._t('Destination Account');
      line[2]['debit'] = bool(currencyId) && await formatLang(this.env, line[2]['debit'], { currencyObj: currencyId }) || line[2]['debit'];
      line[2]['credit'] = bool(currencyId) && await formatLang(this.env, line[2]['credit'], { currencyObj: currencyId }) || line[2]['debit'];
    }

    return previewVals;
  }

  /**
   * Generates and returns a QR-code generation URL for this invoice,
       raising an error message if something is misconfigured.
 
       The chosen QR generation method is the one set in qr_method field if there is one,
       or the first eligible one found. If this search had to be performed and
       and eligible method was found, qr_method field is set to this method before
       returning the URL. If no eligible QR method could be found, we return None.
   */
  async generateQrCode() {
    this.ensureOne();

    if (! await this.isInvoice()) {
      throw new UserError(await this._t("QR-codes can only be generated for invoice entries."));
    }

    let [qrCodeMethod, partnerBankId, ref, label, partnerId, currencyId, amountResidual, paymentReference] = await this('qrCodeMethod', 'partnerBankId', 'ref', 'label', 'partnerId', 'currencyId', 'amountResidual', 'paymentReference');
    if (qrCodeMethod) {
      // If the user set a qr code generator manually, we check that we can use it
      if (! await partnerBankId._eligibleForQrCode(qrCodeMethod, partnerId, currencyId)) {
        throw new UserError(await this._t("The chosen QR-code type is not eligible for this invoice."));
      }
    }
    else {
      // Else we find one that's eligible and assign it to the invoice
      for (const [candidateMethod, candidateName] of await this.env.items('res.partner.bank').getAvailableQrMethodsInSequence()) {
        if (await partnerBankId._eligibleForQrCode(candidateMethod, partnerId, currencyId)) {
          qrCodeMethod = candidateMethod;
          break;
        }
      }
    }
    if (!qrCodeMethod) {
      // No eligible method could be found; we can't generate the QR-code
      return null;
    }

    const unstructRef = ref ? ref : label;
    const rslt = await partnerBankId.buildQrCodeUrl(amountResidual, unstructRef, paymentReference, currencyId, partnerId, qrCodeMethod, { silentErrors: false });

    // We only set qr_code_method after generating the url; otherwise, it
    // could be set even in case of a failure in the QR code generation
    // (which would change the field, but not refresh UI, making the displayed data inconsistent with db)
    await this.set('qrCodeMethod', qrCodeMethod);

    return rslt;
  }

  async _messagePostAfterHook(newMessage, messageValues) {
    // OVERRIDE
    // When posting a message, check the attachment to see if it's an invoice and update with the imported data.
    const res = await _super(AccountMove, this)._messagePostAfterHook(newMessage, messageValues);

    const attachments = await newMessage.attachmentIds;
    if (len(this) != 1 || !bool(attachments) || this.env.context['noNewInvoice'] || ! await this.isInvoice(true)) {
      return res;
    }

    const verpbot = await this.env.ref('base.partnerRoot');
    if (bool(attachments) && await this['state'] !== 'draft') {
      await (this as any).messagePost({
        body: await this._t('The invoice is not a draft, it was not updated from the attachment.'),
        messageType: 'comment',
        subtypeXmlid: 'mail.mtNote',
        authorId: verpbot.id
      });
      return res;
    }
    if (bool(attachments) && bool(await this['lineIds'])) {
      await (this as any).messagePost({
        body: await this._t('The invoice already contains lines, it was not updated from the attachment.'),
        messageType: 'comment',
        subtypeXmlid: 'mail.mtNote',
        authorId: verpbot.id
      });
      return res;
    }

    const decoders = await this.env.items('account.move')._getUpdateInvoiceFromAttachmentDecoders(this);
    const messageMainAttachmentId = await this['messageMainAttachmentId'];
    for (const decoder of await decoders.sorted(d => d[0])) {
      // start with message_main_attachmentId, that way if OCR is installed, only that one will be parsed.
      // this is based on the fact that the ocr will be the last decoder.
      for (const attachment of await attachments.sorted((x) => !x.eq(messageMainAttachmentId))) {
        const invoice = await decoder[1].call(attachment, this);
        if (bool(invoice)) {
          return res;
        }
      }
    }
    return res;
  }

  /**
   * Returns a list of method that are able to create an invoice from an attachment and a priority.
 
      :returns:   A list of tuples (priority, method) where method takes an attachment as parameter.
   * @returns 
   */
  async _getCreateInvoiceFromAttachmentDecoders() {
    return [];
  }

  /**
   * Returns a list of method that are able to create an invoice from an attachment and a priority.
 
      :param invoice: The invoice on which to update the data.
      :returns:       A list of tuples (priority, method) where method takes an attachment as parameter.
   * @param invoice 
   * @returns 
   */
  async _getUpdateInvoiceFromAttachmentDecoders(invoice) {
    return [];
  }

  @api.depends('moveType', 'partnerId', 'companyId')
  async _computeNarration() {
    const useInvoiceTerms = await (await this.env.items('ir.config.parameter').sudo()).getParam('account.useInvoiceTerms');
    for (const move of await this.filtered(async (am) => ! await am.narration)) {
      if (!useInvoiceTerms || ! await move.isSaleDocument(true)) {
        await move.set('narration', false);
      }
      else {
        let narration;
        const companyId = await move.companyId;
        if (await companyId.termsType !== 'html') {
          const invoiceTerms = await companyId.invoiceTerms;
          narration = !isHtmlEmpty(invoiceTerms) ? invoiceTerms : '';
        }
        else {
          const baseurl = await (await this.env.company()).getBaseUrl() + '/terms';
          narration = await this._t('Terms & Conditions: %s', baseurl);
        }
        await move.set('narration', narration || false);
      }
    }
  }

  /**
   * Give access button to users and portal customer as portal is integrated
    in account. Customer and portal group have probably no right to see
    the document so they don't have the access button.
   * @param msgVals 
   * @returns 
   */
  async _notifyGetGroups(msgVals?: any) {
    const groups = await _super(AccountMove, this)._notifyGetGroups(msgVals);

    this.ensureOne();
    if (await this['moveType'] !== 'entry') {
      for (const [groupName, , groupData] of groups) {
        if (['portalCustomer', 'customer'].includes(groupName)) {
          groupData['hasButtonAccess'] = true;

          // 'notification_is_customer' is used to determine whether the group should be sent the accessToken
          groupData['notificationIsCustomer'] = true;
        }
      }
    }
    return groups;
  }

  /**
   * Return true if the invoice is a downpayment.
    Down-payments can be created from a sale order. This method is overridden in the sale order module.
   * @returns 
   */
  async _isDownpayment() {
    return false;
  }
}