import { api } from "../../../core";
import { Fields } from "../../../core/fields";
import { MetaModel, TransientModel, _super } from "../../../core/models";
import { bool } from "../../../core/tools/bool";
import { f } from "../../../core/tools/utils";

@MetaModel.define()
class ResConfigSettings extends TransientModel {
  static _module = module;
  static _parents = 'res.config.settings';

  static hasAccountingEntries = Fields.Boolean({ compute: '_computeHasChartOfAccounts' });
  static currencyId = Fields.Many2one('res.currency', {
    related: "companyId.currencyId", required: true, readonly: false,
    string: 'Currency', help: "Main currency of the company."
  });
  static currencyExchangeJournalId = Fields.Many2one({
    comodelName: 'account.journal',
    related: 'companyId.currencyExchangeJournalId', readonly: false,
    string: "Currency Exchange Journal",
    domain: "[['companyId', '=', companyId], ['type', '=', 'general']]",
    help: 'The accounting journal where automatic exchange differences will be registered'
  });
  static incomeCurrencyExchangeAccountId = Fields.Many2one({
    comodelName: "account.account",
    related: "companyId.incomeCurrencyExchangeAccountId",
    string: "Gain Account",
    readonly: false,
    domain: async (self) => f("[['internalType', '=', 'other'], ['deprecated', '=', false], ['companyId', '=', companyId],['userTypeId', 'in', %s]]", [(await self.env.ref('account.dataAccountTypeRevenue')).id, (await self.env.ref('account.dataAccountTypeOtherIncome')).id])
  });
  static expenseCurrencyExchangeAccountId = Fields.Many2one({
    comodelName: "account.account",
    related: "companyId.expenseCurrencyExchangeAccountId",
    string: "Loss Account",
    readonly: false,
    domain: async (self) => f("[['internalType', '=', 'other'], ['deprecated', '=', false], ['companyId', '=', companyId], ['userTypeId', '=', %s]]", (await self.env.ref('account.dataAccountTypeExpenses')).id)
  });
  static hasChartOfAccounts = Fields.Boolean({ compute: '_computeHasChartOfAccounts', string: 'Company has a chart of accounts' });
  static chartTemplateId = Fields.Many2one('account.chart.template', { string: 'Template', default: async (self) => (await self.env.company()).chartTemplateId, domain: "[['visible','=', true]]" });
  static saleTaxId = Fields.Many2one('account.tax', { string: "Default Sale Tax", related: 'companyId.accountSaleTaxId', readonly: false });
  static purchaseTaxId = Fields.Many2one('account.tax', { string: "Default Purchase Tax", related: 'companyId.accountPurchaseTaxId', readonly: false });
  static taxCalculationRoundingMethod = Fields.Selection({
    related: 'companyId.taxCalculationRoundingMethod', string: 'Tax calculation rounding method', readonly: false
  });
  static accountJournalSuspenseAccountId = Fields.Many2one({
    comodelName: 'account.account',
    string: 'Bank Suspense Account',
    readonly: false,
    related: 'companyId.accountJournalSuspenseAccountId',
    domain: async (self) => f("[['deprecated', '=', false], ['companyId', '=', companyId], ['userTypeId.type', 'not in', ['receivable', 'payable']], ['userTypeId', 'in', %s]]", [(await self.env.ref('account.dataAccountTypeCurrentAssets')).id, (await self.env.ref('account.dataAccountTypeCurrentLiabilities')).id]),
    help: ['Bank Transactions are posted immediately after import or synchronization. ',
      'Their counterparty is the bank suspense account.\n',
      'Reconciliation replaces the latter by the definitive account(s).'].join('')
  });
  static accountJournalPaymentDebitAccountId = Fields.Many2one({
    comodelName: 'account.account',
    string: 'Outstanding Receipts Account',
    readonly: false,
    related: 'companyId.accountJournalPaymentDebitAccountId',
    domain: async (self) => f("[['deprecated', '=', false], ['companyId', '=', companyId], ['userTypeId.type', 'not in', ['receivable', 'payable']], ['user_type_id', '=', %s]]", (await self.env.ref('account.dataAccountTypeCurrentAssets')).id),
    help: ['Incoming payments are posted on an Outstanding Receipts Account. ',
      'In the bank reconciliation widget, they appear as blue lines.\n',
      'Bank transactions are then reconciled on the Outstanding Receipts Accounts rather than the Receivable ',
      'Account.'].join('')
  });
  static accountJournalPaymentCreditAccountId = Fields.Many2one({
    comodelName: 'account.account',
    string: 'Outstanding Payments Account',
    readonly: false,
    related: 'companyId.accountJournalPaymentCreditAccountId',
    domain: async (self) => f("[['deprecated', '=', false], ['companyId', '=', companyId], ['userTypeId.type', 'not in', ['receivable', 'payable']], ['userTypeId', '=', %s]]", (await self.env.ref('account.dataAccountTypeCurrentAssets')).id),
    help: ['Outgoing Payments are posted on an Outstanding Payments Account. ',
      'In the bank reconciliation widget, they appear as blue lines.\n',
      'Bank transactions are then reconciled on the Outstanding Payments Account rather the Payable Account.'].join('')
  });
  static transferAccountId = Fields.Many2one('account.account', {
    string: "Internal Transfer Account",
    related: 'companyId.transferAccountId', readonly: false,
    domain: async (self) => [
      ['reconcile', '=', true],
      ['userTypeId.id', '=', (await self.env.ref('account.dataAccountTypeCurrentAssets')).id],
      ['deprecated', '=', false]
    ],
    help: "Intermediary account used when moving from a liquidity account to another."
  });
  static moduleAccountAccountant = Fields.Boolean({ string: 'Accounting' });
  static groupAnalyticTags = Fields.Boolean({ string: 'Analytic Tags', impliedGroup: 'analytic.groupAnalyticTags' });
  static groupWarningAccount = Fields.Boolean({ string: "Warnings in Invoices", impliedGroup: 'account.groupWarningAccount' });
  static groupCashRounding = Fields.Boolean({ string: "Cash Rounding", impliedGroup: 'account.groupCashRounding' });
  // groupShowLineSubtotalsTaxExcluded and groupShowLineSubtotalsTaxIncluded are opposite,
  // so we can assume exactly one of them will be set, and not the other.
  // We need both of them to coexist so we can take advantage of automatic group assignation.
  static groupShowLineSubtotalsTaxExcluded = Fields.Boolean(
    "Show line subtotals without taxes (B2B)",
    {
      impliedGroup: 'account.groupShowLineSubtotalsTaxExcluded',
      groups: 'base.groupPortal,base.groupUser,base.groupPublic'
    });
  static groupShowLineSubtotalsTaxIncluded = Fields.Boolean(
    "Show line subtotals with taxes (B2C)",
    {
      impliedGroup: 'account.groupShowLineSubtotalsTaxIncluded',
      groups: 'base.groupPortal,base.groupUser,base.groupPublic'
    });
  static groupShowSaleReceipts = Fields.Boolean({
    string: 'Sale Receipt',
    impliedGroup: 'account.groupSaleReceipts'
  })
  static groupShowPurchaseReceipts = Fields.Boolean({
    string: 'Purchase Receipt',
    impliedGroup: 'account.groupPurchaseReceipts'
  });
  static showLineSubtotalsTaxSelection = Fields.Selection([
    ['taxExcluded', 'Tax-Excluded'],
    ['taxIncluded', 'Tax-Included']], {
      string: "Line Subtotals Tax Display",
    required: true, default: 'taxExcluded',
    configParameter: 'account.showLineSubtotalsTaxSelection'
  });
  static moduleAccountBudget = Fields.Boolean({ string: 'Budget Management' });
  static moduleAccountPayment = Fields.Boolean({ string: 'Invoice Online Payment' });
  static moduleAccountReports = Fields.Boolean("Dynamic Reports");
  static moduleAccountCheckPrinting = Fields.Boolean("Allow check printing and deposits");
  static moduleAccountBatchPayment = Fields.Boolean({
    string: 'Use batch payments',
    help: ['This allows you grouping payments into a single batch and eases the reconciliation process.\n',
      '-This installs the account_batch_payment module.'].join()
  });
  static moduleAccountSepa = Fields.Boolean({ string: 'SEPA Credit Transfer (SCT)' });
  static moduleAccountSepaDirectDebit = Fields.Boolean({ string: 'Use SEPA Direct Debit' });
  static moduleL10nFrFecImport = Fields.Boolean("Import FEC files",
    { help: 'Allows you to import FEC files.\n -This installs the l10n_fr_fec_import module.' });
  static moduleAccountBankStatementImportQif = Fields.Boolean("Import .qif files");
  static moduleAccountBankStatementImportOfx = Fields.Boolean("Import in .ofx format");
  static moduleAccountBankStatementImportCsv = Fields.Boolean("Import in .csv format");
  static moduleAccountBankStatementImportCamt = Fields.Boolean("Import in CAMT.053 format");
  static moduleCurrencyRateLive = Fields.Boolean({ string: "Automatic Currency Rates" });
  static moduleAccountIntrastat = Fields.Boolean({ string: 'Intrastat' });
  static moduleProductMargin = Fields.Boolean({ string: "Allow Product Margin" });
  static moduleL10nEuOss = Fields.Boolean({ string: "EU Intra-community Distance Selling" });
  static moduleAccountTaxcloud = Fields.Boolean({ string: "Account TaxCloud" });
  static moduleAccountInvoiceExtract = Fields.Boolean({ string: "Bill Digitalization" });
  static moduleSnailmailAccount = Fields.Boolean({ string: "Snailmail" });
  static taxExigibility = Fields.Boolean({ string: 'Cash Basis', related: 'companyId.taxExigibility', readonly: false });
  static taxCashBasisJournalId = Fields.Many2one('account.journal', { related: 'companyId.taxCashBasisJournalId', string: "Tax Cash Basis Journal", readonly: false });
  static accountCashBasisBaseAccountId = Fields.Many2one({
    comodelName: 'account.account',
    string: "Base Tax Received Account",
    readonly: false,
    related: 'companyId.accountCashBasisBaseAccountId',
    domain: [['deprecated', '=', false]]
  });
  static accountFiscalCountryId = Fields.Many2one({ string: "Fiscal Country Code", related: "companyId.accountFiscalCountryId", readonly: false, store: false });

  static qrCode = Fields.Boolean({ string: 'Display SEPA QR-code', related: 'companyId.qrCode', readonly: false });
  static invoiceIsPrint = Fields.Boolean({ string: 'Print', related: 'companyId.invoiceIsPrint', readonly: false });
  static invoiceIsEmail = Fields.Boolean({ string: 'Send Email', related: 'companyId.invoiceIsEmail', readonly: false });
  static incotermId = Fields.Many2one('account.incoterms', { string: 'Default incoterm', related: 'companyId.incotermId', help: 'International Commercial Terms are a series of predefined commercial terms used in international transactions.', readonly: false });
  static invoiceTerms = Fields.Html({ related: 'companyId.invoiceTerms', string: "Terms & Conditions", readonly: false });
  static invoiceTermsHtml = Fields.Html({ related: 'companyId.invoiceTermsHtml', string: "Terms & Conditions as a Web page", readonly: false });
  static termsType = Fields.Selection({ related: 'companyId.termsType', readonly: false });
  static previewReady = Fields.Boolean({ string: "Display preview button", compute: '_computeTermsPreview' });

  static useInvoiceTerms = Fields.Boolean(
    {
      string: 'Default Terms & Conditions',
      configParameter: 'account.useInvoiceTerms'
    });

  // Technical field to hide country specific fields from accounting configuration
  static countryCode = Fields.Char({ related: 'companyId.accountFiscalCountryId.code', readonly: true });

  async setValues() {
    await _super(ResConfigSettings, this).setValues();
    // install a chart of accounts for the given company (if required)
    const [chartTemplateId, companyId] = await this('chartTemplateId', 'companyId');
    if ((await this.env.company()).eq(companyId) && chartTemplateId.ok && !chartTemplateId.eq(await companyId.chartTemplateId)) {
      await chartTemplateId._load(15.0, 15.0, await this.env.company());
    }
  }

  @api.depends('companyId')
  async _computeHasChartOfAccounts() {
    const companyId = await this['companyId'];
    await this.update({
      'hasChartOfAccounts': bool(await companyId.chartTemplateId),
      'hasAccountingEntries': await this.env.items('account.chart.template').existingAccounting(companyId)
    });
  }

  @api.onchange('showLineSubtotalsTaxSelection')
  async _onchangeSaleTax() {
    if (await this['showLineSubtotalsTaxSelection'] === "taxExcluded") {
      await this.update({
        'groupShowLineSubtotalsTaxIncluded': false,
        'groupShowLineSubtotalsTaxExcluded': true,
      })
    }
    else {
      await this.update({
        'groupShowLineSubtotalsTaxIncluded': true,
        'groupShowLineSubtotalsTaxExcluded': false,
      });
    }
  }

  @api.onchange('groupAnalyticAccounting')
  async onchangeAnalyticAccounting() {
    if (await this['groupAnalyticAccounting']) {
      await this.set('moduleAccountAccountant', true);
    }
  }

  @api.onchange('moduleAccountBudget')
  async onchangeModuleAccountBudget() {
    if (await this['moduleAccountBudget']) {
      await this.set('groupAnalyticAccounting', true);
    }
  }

  @api.onchange('taxExigibility')
  async _onchangeTaxExigibility() {
    const res = {};
    const tax = await this.env.items('account.tax').search([
      ['companyId', '=', (await this.env.company()).id], ['taxExigibility', '=', 'onPayment']
    ], { limit: 1 });
    if (! await this['taxExigibility'] && tax.ok) {
      await this.set('taxExigibility', true);
      res['warning'] = {
        'title': await this._t('Error!'),
        'message': await this._t('You cannot disable this setting because some of your taxes are cash basis. Modify your taxes first before disabling this setting.')
      }
    }
    return res;
  }

  @api.depends('termsType')
  async _computeTermsPreview() {
    for (const setting of this) {
      // We display the preview button only if the terms_type is html in the setting but also on the company
      // to avoid landing on an error page (see terms.js controller)
      await setting.set('previewReady', await (await this.env.company()).termsType === 'html' && await setting.termsType === 'html');
    }
  }

  async actionUpdateTerms() {
    this.ensureOne();
    return {
      'label': await this._t('Update Terms & Conditions'),
      'type': 'ir.actions.actwindow',
      'viewMode': 'form',
      'resModel': 'res.company',
      'viewId': (await this.env.ref("account.resCompanyViewFormTerms", false)).id,
      'target': 'new',
      'resId': (await this['companyId']).id,
    }
  }
}