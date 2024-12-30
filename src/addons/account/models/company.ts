import { api } from "../../../core";
import { Fields, _Date, _Datetime } from "../../../core/fields";
import { RedirectWarning, UserError, ValidationError } from "../../../core/helper/errors";
import { MetaModel, Model, _super } from "../../../core/models";
import { bool, floatIsZero, floatRound, formatDate, isHtmlEmpty, len, parseInt, update } from "../../../core/tools";
import { monthrange } from "../../../core/tools/calendar";
import { dateMax, setDate, subDate } from "../../../core/tools/date_utils";
import { f } from "../../../core/tools/utils";
import { MAX_HASH_VERSION } from "./account_move";

const MONTH_SELECTION = [
  ['1', 'January'],
  ['2', 'February'],
  ['3', 'March'],
  ['4', 'April'],
  ['5', 'May'],
  ['6', 'June'],
  ['7', 'July'],
  ['8', 'August'],
  ['9', 'September'],
  ['10', 'October'],
  ['11', 'November'],
  ['12', 'December'],
]

const ONBOARDING_STEP_STATES = [
  ['notDone', "Not done"],
  ['justDone', "Just done"],
  ['done', "Done"],
]

const DASHBOARD_ONBOARDING_STATES = ONBOARDING_STEP_STATES.concat([['closed', 'Closed']]);

@MetaModel.define()
class ResCompany extends Model {
  static _module = module;
  static _parents = "res.company";

  //TODO check all the options/fields are in the views (settings + company form view)
  static fiscalyearLastDay = Fields.Integer({ default: 31, required: true });
  static fiscalyearLastMonth = Fields.Selection(MONTH_SELECTION, { default: '12', required: true });
  static periodLockDate = Fields.Date({ string: "Lock Date for Non-Advisers", help: "Only users with the 'Adviser' role can edit accounts prior to and inclusive of this date. Use it for period locking inside an open fiscal year, for example." });
  static fiscalyearLockDate = Fields.Date({ string: "Lock Date", help: "No users, including Advisers, can edit accounts prior to and inclusive of this date. Use it for fiscal year locking for example." });
  static taxLockDate = Fields.Date("Tax Lock Date", { help: "No users can edit journal entries related to a tax prior and inclusive of this date." });
  static transferAccountId = Fields.Many2one('account.account', {
    domain: async (self) => [['reconcile', '=', true], ['userTypeId.id', '=', (await self.env.ref('account.dataAccountTypeCurrentAssets')).id], ['deprecated', '=', false]], string: "Inter-Banks Transfer Account", help: "Intermediary account used when moving money from a liquidity account to another"
  });
  static expectsChartOfAccounts = Fields.Boolean({ string: 'Expects a Chart of Accounts', default: true });
  static chartTemplateId = Fields.Many2one('account.chart.template', { help: 'The chart template for the company (if any)' });
  static bankAccountCodePrefix = Fields.Char({ string: 'Prefix of the bank accounts' });
  static cashAccountCodePrefix = Fields.Char({ string: 'Prefix of the cash accounts' });
  static defaultCashDifferenceIncomeAccountId = Fields.Many2one('account.account', { string: "Cash Difference Income Account" });
  static defaultCashDifferenceExpenseAccountId = Fields.Many2one('account.account', { string: "Cash Difference Expense Account" });
  static accountJournalSuspenseAccountId = Fields.Many2one('account.account', { string: 'Journal Suspense Account' });
  static accountJournalPaymentDebitAccountId = Fields.Many2one('account.account', { string: 'Journal Outstanding Receipts Account' });
  static accountJournalPaymentCreditAccountId = Fields.Many2one('account.account', { string: 'Journal Outstanding Payments Account' });
  static transferAccountCodePrefix = Fields.Char({ string: 'Prefix of the transfer accounts' });
  static accountSaleTaxId = Fields.Many2one('account.tax', { string: "Default Sale Tax" });
  static accountPurchaseTaxId = Fields.Many2one('account.tax', { string: "Default Purchase Tax" });
  static taxCalculationRoundingMethod = Fields.Selection([
    ['roundPerLine', 'Round per Line'],
    ['roundGlobally', 'Round Globally'],
  ], { default: 'roundPerLine', string: 'Tax Calculation Rounding Method' });
  static currencyExchangeJournalId = Fields.Many2one('account.journal', { string: "Exchange Gain or Loss Journal", domain: [['type', '=', 'general']] });
  static incomeCurrencyExchangeAccountId = Fields.Many2one({
    comodelName: 'account.account',
    string: "Gain Exchange Rate Account",
    domain: async (self) => f(`[['internalType', '=', 'other'], ['deprecated', '=', false], ['companyId', '=', id], 
                           ['userTypeId', 'in', %s]]`, [(await self.env.ref('account.dataAccountTypeRevenue')).id,
    (await self.env.ref('account.dataAccountTypeOtherIncome')).id])
  });
  static expenseCurrencyExchangeAccountId = Fields.Many2one({
    comodelName: 'account.account',
    string: "Loss Exchange Rate Account",
    domain: async (self) => f(`[['internalType', '=', 'other'], ['deprecated', '=', false], ['companyId', '=', id],
                           ['userTypeId', '=', %s]]`, (await self.env.ref('account.dataAccountTypeExpenses')).id)
  });
  static angloSaxonAccounting = Fields.Boolean({ string: "Use anglo-saxon accounting" });
  static propertyStockAccountInputCategId = Fields.Many2one('account.account', { string: "Input Account for Stock Valuation" });
  static propertyStockAccountOutputCategId = Fields.Many2one('account.account', { string: "Output Account for Stock Valuation" });
  static propertyStockValuationAccountId = Fields.Many2one('account.account', { string: "Account Template for Stock Valuation" });
  static bankJournalIds = Fields.One2many('account.journal', 'companyId', { domain: [['type', '=', 'bank']], string: 'Bank Journals' });
  static incotermId = Fields.Many2one('account.incoterms', {
    string: 'Default incoterm',
    help: 'International Commercial Terms are a series of predefined commercial terms used in international transactions.'
  });

  static qrCode = Fields.Boolean({ string: 'Display QR-code on invoices' });

  static invoiceIsEmail = Fields.Boolean('Email by default', { default: true });
  static invoiceIsPrint = Fields.Boolean('Print by default', { default: true });

  //Fields of the setup step for opening move
  static accountOpeningMoveId = Fields.Many2one({ string: 'Opening Journal Entry', comodelName: 'account.move', help: "The journal entry containing the initial balance of all this company's accounts." });
  static accountOpeningJournalId = Fields.Many2one({ string: 'Opening Journal', comodelName: 'account.journal', related: 'accountOpeningMoveId.journalId', help: "Journal where the opening entry of this company's accounting has been posted.", readonly: false });
  static accountOpeningDate = Fields.Date({ string: 'Opening Entry', default: async (self) => setDate(await _Date.contextToday(self), { month: 1, day: 1 }), required: true, help: "That is the date of the opening entry." });

  // Fields marking the completion of a setup step
  static accountSetupBankDataState = Fields.Selection(ONBOARDING_STEP_STATES, { string: "State of the onboarding bank data step", default: 'notDone' });
  static accountSetupFyDataState = Fields.Selection(ONBOARDING_STEP_STATES, { string: "State of the onboarding fiscal year step", default: 'notDone' });
  static accountSetupCoaState = Fields.Selection(ONBOARDING_STEP_STATES, { string: "State of the onboarding charts of account step", default: 'notDone' });
  static accountSetupTaxesState = Fields.Selection(ONBOARDING_STEP_STATES, { string: "State of the onboarding Taxes step", default: 'notDone' });
  static accountOnboardingInvoiceLayoutState = Fields.Selection(ONBOARDING_STEP_STATES, { string: "State of the onboarding invoice layout step", default: 'notDone' });
  static accountOnboardingCreateInvoiceState = Fields.Selection(ONBOARDING_STEP_STATES, { string: "State of the onboarding create invoice step", default: 'notDone' });
  static accountOnboardingSaleTaxState = Fields.Selection(ONBOARDING_STEP_STATES, { string: "State of the onboarding sale tax step", default: 'notDone' });

  // account dashboard onboarding
  static accountInvoiceOnboardingState = Fields.Selection(DASHBOARD_ONBOARDING_STATES, { string: "State of the account invoice onboarding panel", default: 'notDone' });
  static accountDashboardOnboardingState = Fields.Selection(DASHBOARD_ONBOARDING_STATES, { string: "State of the account dashboard onboarding panel", default: 'notDone' });
  static invoiceTerms = Fields.Html({ string: 'Default Terms and Conditions', translate: true });
  static termsType = Fields.Selection([['plain', 'Add a Note'], ['html', 'Add a link to a Web Page']],
    { string: 'Terms & Conditions format', default: 'plain' });
  static invoiceTermsHtml = Fields.Html({
    string: 'Default Terms and Conditions as a Web page', translate: true,
    sanitizeAttributes: false,
    compute: '_computeInvoiceTermsHtml', store: true, readonly: false
  });

  static accountSetupBillState = Fields.Selection(ONBOARDING_STEP_STATES, { string: "State of the onboarding bill step", default: 'notDone' });

  // Needed in the Point of Sale
  static accountDefaultPosReceivableAccountId = Fields.Many2one('account.account', { string: "Default PoS Receivable Account" });

  // Accrual Accounting
  static expenseAccrualAccountId = Fields.Many2one('account.account', {
    help: "Account used to move the period of an expense",
    domain: "[['internalGroup', '=', 'liability'], ['internalType', 'not in', ['receivable', 'payable']], ['companyId', '=', id]]"
  });
  static revenueAccrualAccountId = Fields.Many2one('account.account', {
    help: "Account used to move the period of a revenue",
    domain: "[['internalGroup', '=', 'asset'], ['internalType', 'not in', ['receivable', 'payable']], ['companyId', '=', id]]"
  });
  static automaticEntryDefaultJournalId = Fields.Many2one('account.journal', { help: "Journal used by default for moving the period of an entry", domain: "[['type', '=', 'general']]" });

  // Technical field to hide country specific fields in company form view
  static countryCode = Fields.Char({ related: 'countryId.code' });

  // Taxes
  static accountFiscalCountryId = Fields.Many2one({
    string: "Fiscal Country",
    comodelName: 'res.country',
    compute: '_computeAccountTaxFiscalCountry',
    store: true,
    readonly: false,
    help: "The country to use the tax reports from for this company"
  });

  static accountEnabledTaxCountryIds = Fields.Many2many({
    string: "l10n-used countries",
    comodelName: 'res.country',
    compute: '_computeAccountEnabledTaxCountryIds',
    help: "Technical field containing the countries for which this company is using tax-related features (hence the ones for which l10n modules need to show tax-related fields)."
  });

  // Cash basis taxes
  static taxExigibility = Fields.Boolean({ string: 'Use Cash Basis' });
  static taxCashBasisJournalId = Fields.Many2one({
    comodelName: 'account.journal',
    string: "Cash Basis Journal"
  });
  static accountCashBasisBaseAccountId = Fields.Many2one({
    comodelName: 'account.account',
    domain: [['deprecated', '=', false]],
    string: "Base Tax Received Account",
    help: "Account that will be set on lines created in cash basis journal entry and used to keep track of the tax base amount."
  });

  // Multivat
  static fiscalPositionIds = Fields.One2many("account.fiscal.position", "companyId");
  static multiVatForeignCountryIds = Fields.Many2many({
    string: "Foreign VAT countries",
    help: "Countries for which the company has a VAT number",
    comodelName: 'res.country',
    compute: '_computeMultiVatForeignCountry',
  });

  @api.constrains('accountOpeningMoveId', 'fiscalyearLastDay', 'fiscalyearLastMonth')
  async _checkFiscalyearLastDay() {
    // if the user explicitly chooses the 29th of February we allow it:
    // there is no "fiscalyearLastYear" so we do not know his intentions.
    for (const rec of this) {
      const [fiscalyearLastDay, fiscalyearLastMonth, accountOpeningDate] = await rec('fiscalyearLastDay', 'fiscalyearLastMonth', 'accountOpeningDate');
      if (fiscalyearLastDay == 29 && fiscalyearLastMonth == '2') {
        continue;
      }
      let year;
      if (bool(accountOpeningDate)) {
        year = await accountOpeningDate.year;
      }
      else {
        year = _Datetime.now().getFullYear();
      }
      const maxDay = monthrange(year, parseInt(fiscalyearLastMonth))[1];
      if (fiscalyearLastDay > maxDay) {
        throw new ValidationError(await this._t("Invalid fiscal year last day"));
      }
    }
  }

  @api.depends('fiscalPositionIds.foreignVat')
  async _computeMultiVatForeignCountry() {
    const companyToForeignVatCountry = Object.fromEntries(await this.env.items('account.fiscal.position').readGroup(
      [['companyId', 'in', this.ids], ['foreignVat', '!=', false]],
      ['countryIds:array_agg(countryId)'],
      'companyId',
    )).map(val => [val['companyId'][0], val['countryIds']]);
    for (const company of this) {
      await company.set('multiVatForeignCountryIds', this.env.items('res.country').browse(companyToForeignVatCountry[company.id]));
    }
  }

  @api.depends('countryId')
  async _computeAccountTaxFiscalCountry() {
    for (const record of this) {
      await record.set('accountFiscalCountryId', await record.countryId);
    }
  }

  @api.depends('accountFiscalCountryId')
  async _computeAccountEnabledTaxCountryIds() {
    for (const record of this) {
      const foreignVatFpos = await this.env.items('account.fiscal.position').search([['companyId', '=', record.id], ['foreignVat', '!=', false]]);
      await record.set('accountEnabledTaxCountryIds', (await foreignVatFpos.countryId).add(await record.accountFiscalCountryId));
    }
  }

  @api.depends('termsType')
  async _computeInvoiceTermsHtml() {
    const termTemplate = await this.env.ref("account.accountDefaultTermsAndConditions", false);
    if (!bool(termTemplate)) {
      return;
    }

    for (const company of await this.filtered(async (company) => isHtmlEmpty(await company.invoiceTermsHtml) && await company.termsType === 'html')) {
      await company.set('invoiceTermsHtml', await termTemplate._render({ 'companyName': await company.label, 'companyCountry': await (await company.countryId).label }, 'ir.qweb'));
    }
  }

  /**
   * This method is called on the controller rendering method and ensures that the animations
          are displayed only one time.
   * @returns 
   */
  getAndUpdateAccountInvoiceOnboardingState() {
    return (this as any).getAndUpdateOnbardingState(
      'accountInvoiceOnboardingState',
      this.getAccountInvoiceOnboardingStepsStatesNames()
    );
  }

  // YTI FIXME: Define only one method that returns {'account': [], 'sale': [], ...}
  /**
   * Necessary to add/edit steps from other modules (payment acquirer in this case).
   * @returns 
   */
  getAccountInvoiceOnboardingStepsStatesNames() {
    return [
      'baseOnboardingCompanyState',
      'accountOnboardingInvoiceLayoutState',
      'accountOnboardingCreateInvoiceState',
    ]
  }

  /**
   * This method is called on the controller rendering method and ensures that the animations
          are displayed only one time.
   * @returns 
   */
  async getAndUpdateAccountDashboardOnboardingState() {
    return (this as any).getAndUpdateOnbardingState(
      'accountDashboardOnboardingState',
      this.getAccountDashboardOnboardingStepsStatesNames()
    );
  }

  getAccountDashboardOnboardingStepsStatesNames() {
    return [
      'accountSetupBankDataState',
      'accountSetupFyDataState',
      'accountSetupCoaState',
      'accountSetupTaxesState',
    ]
  }

  getNewAccountCode(currentCode: string, oldPrefix: string, newPrefix: string) {
    const digits = len(currentCode);
    return newPrefix + currentCode.replace(new RegExp(oldPrefix), '').replace(/^0*/, '').padStart(digits - newPrefix.length, '0');
  }

  async reflectCodePrefixChange(oldCode, newCode) {
    const accounts = await this.env.items('account.account').search([['code', 'like', oldCode], ['internalType', '=', 'liquidity'], ['companyId', '=', this.id]], { order: 'code asc' });
    for (const account of accounts) {
      if ((await account.code).startsWith(oldCode)) {
        await account.write({ 'code': await this.getNewAccountCode(await account.code, oldCode, newCode) });
      }
    }
  }

  async _validateFiscalyearLock(values) {
    if (values['fiscalyearLockDate']) {

      const draftEntries = await this.env.items('account.move').search([
        ['companyId', 'in', this.ids],
        ['state', '=', 'draft'],
        ['date', '<=', values['fiscalyearLockDate']]]);
      if (bool(draftEntries)) {
        const errorMsg = await this._t('There are still unposted entries in the period you want to lock. You should either post or delete them.');
        const actionError = {
          'viewMode': 'tree',
          'label': await this._t('Unposted Entries'),
          'resModel': 'account.move',
          'type': 'ir.actions.actwindow',
          'domain': [['id', 'in', draftEntries.ids]],
          'searchViewId': [(await this.env.ref('account.viewAccountMoveFilter')).id, 'search'],
          'views': [[(await this.env.ref('account.viewMoveTree')).id, 'list'], [(await this.env.ref('account.viewMoveForm')).id, 'form']],
        }
        throw new RedirectWarning(errorMsg, actionError, await this._t('Show unposted entries'));
      }
      const unreconciledStatementLines = await this.env.items('account.bank.statement.line').search([
        ['companyId', 'in', this.ids],
        ['isReconciled', '=', false],
        ['date', '<=', values['fiscalyearLockDate']],
        ['moveId.state', 'in', ['draft', 'posted']],
      ])
      if (bool(unreconciledStatementLines)) {
        const errorMsg = await this._t("There are still unreconciled bank statement lines in the period you want to lock. You should either reconcile or delete them.");
        const actionError = {
          'type': 'ir.actions.client',
          'tag': 'bankStatementReconciliationView',
          'context': { 'statementLineIds': unreconciledStatementLines.ids, 'companyIds': this.ids },
        }
        throw new RedirectWarning(errorMsg, actionError, await this._t('Show Unreconciled Bank Statement Line'));
      }
    }
  }

  /**
   * Get the fiscal lock date for this company depending on the user
   * @returns 
   */
  async _getUserFiscalLockDate() {
    this.ensureOne();
    let lockDate = dateMax(await this['periodLockDate'] || _Date.min, await this['fiscalyearLockDate'] || _Date.min);
    if (await this.userHasGroups('account.groupAccountManager')) {
      lockDate = await this['fiscalyearLockDate'] || _Date.min;
    }
    return lockDate;
  }

  async write(values) {
    //restrict the closing of FY if there are still unposted entries
    await this._validateFiscalyearLock(values);

    // Reflect the change on accounts
    for (const company of this) {
      if (values['bankAccountCodePrefix']) {
        const newBankCode = values['bankAccountCodePrefix'] || await company.bankAccountCodePrefix;
        await company.reflectCodePrefixChange(await company.bankAccountCodePrefix, newBankCode);
      }
      if (values['cashAccountCodePrefix']) {
        const newCashCode = values['cashAccountCodePrefix'] || await company.cashAccountCodePrefix;
        await company.reflectCodePrefixChange(await company.cashAccountCodePrefix, newCashCode);
      }
      //forbid the change of currencyId if there are already some accounting entries existing
      if ('currencyId' in values && values['currencyId'] != (await company.currencyId).id) {
        if ((await this.env.items('account.move.line').search([['companyId', '=', company.id]])).ok) {
          throw new UserError(await this._t('You cannot change the currency of the company since some journal items already exist'));
        }
      }
    }

    return _super(ResCompany, this).write(values);
  }

  @api.model()
  async settingInitBankAccountAction() {
    const viewId = (await this.env.ref('account.setupBankAccountWizard')).id;
    return {
      'type': 'ir.actions.actwindow',
      'label': await this._t('Create a Bank Account'),
      'resModel': 'account.setup.bank.manual.config',
      'target': 'new',
      'viewMode': 'form',
      'views': [[viewId, 'form']],
    }
  }

  /**
   * Called by the 'Fiscal Year Opening' button of the setup bar.
   * @returns 
   */
  @api.model()
  async settingInitFiscalYearAction() {
    const company = await this.env.company();
    await company.createOpMoveIfNonExistant();
    const newWizard = await this.env.items('account.financial.year.op').create({ 'companyId': company.id });
    const viewId = (await this.env.ref('account.setupFinancialYearOpeningForm')).id;

    return {
      'type': 'ir.actions.actwindow',
      'label': await this._t('Accounting Periods'),
      'viewMode': 'form',
      'resModel': 'account.financial.year.op',
      'target': 'new',
      'resId': newWizard.id,
      'views': [[viewId, 'form']],
    }
  }

  /**
   * Called by the 'Chart of Accounts' button of the setup bar.
   * @returns 
   */
  @api.model()
  async settingChartOfAccountsAction() {
    const company = await this.env.company();
    await (await company.sudo()).setOnboardingStepDone('accountSetupCoaState');

    /// If an opening move has already been posted, we open the tree view showing all the accounts
    if (await company.openingMovePosted()) {
      return 'account.actionAccountForm';
    }

    // Otherwise, we create the opening move
    await company.createOpMoveIfNonExistant();

    // Then, we open will open a custom tree view allowing to edit opening balances of the account
    const viewId = (await this.env.ref('account.initAccountsTree')).id;
    // Hide the current year earnings account as it is automatically computed
    const domain = [['userTypeId', '!=', (await this.env.ref('account.dataUnaffectedEarnings')).id], ['companyId', '=', company.id]];
    return {
      'type': 'ir.actions.actwindow',
      'label': await this._t('Chart of Accounts'),
      'resModel': 'account.account',
      'viewMode': 'tree',
      'limit': 99999999,
      'searchViewId': [(await this.env.ref('account.viewAccountSearch')).id],
      'views': [[viewId, 'list']],
      'domain': domain,
    }
  }

  /**
   * Creates an empty opening move in 'draft' state for the current company
      if there wasn't already one defined. For this, the function needs at least
      one journal of type 'general' to exist (required by account.move).
   */
  @api.model()
  async createOpMoveIfNonExistant() {
    this.ensureOne();
    if (!bool(await this['accountOpeningMoveId'])) {
      const defaultJournal = await this.env.items('account.journal').search([['type', '=', 'general'], ['companyId', '=', this.id]], { limit: 1 });

      if (!bool(defaultJournal)) {
        throw new UserError(await this._t("Please install a chart of accounts or create a miscellaneous journal before proceeding."));
      }

      const openingDate = subDate(await this['accountOpeningDate'], { days: 1 });

      await this.set('accountOpeningMoveId', await this.env.items('account.move').create({
        'ref': await this._t('Opening Journal Entry'),
        'companyId': this.id,
        'journalId': defaultJournal.id,
        'date': openingDate,
      }));
    }
  }

  /**
   * Returns true if this company has an opening account move and this move is posted.
   * @returns 
   */
  async openingMovePosted() {
    return bool(await this['accountOpeningMoveId']) && await (await this['accountOpeningMoveId']).state === 'posted';
  }

  /**
   * Returns the unaffected earnings account for this company, creating one
      if none has yet been defined.
   * @returns 
   */
  async getUnaffectedEarningsAccount() {
    const unaffectedEarningsType = await this.env.ref("account.dataUnaffectedEarnings");
    const account = await this.env.items('account.account').search([['companyId', '=', this.id],
    ['userTypeId', '=', unaffectedEarningsType.id]]);
    if (account.ok) {
      return account[0];
    }
    // Do not assume '999999' doesn't exist since the user might have created such an account
    // manually.
    let code = 999999;
    while ((await this.env.items('account.account').search([['code', '=', String(code)], ['companyId', '=', this.id]])).ok) {
      code -= 1;
    }
    return this.env.items('account.account').create({
      'code': String(code),
      'label': await this._t('Undistributed Profits/Losses'),
      'userTypeId': unaffectedEarningsType.id,
      'companyId': this.id,
    });
  }

  async getOpeningMoveDifferences(openingMoveLines) {
    const currency = await this['currencyId'];
    const balancingMoveLine = await openingMoveLines.filtered(async (x) => (await x.accountId).eq(await this.getUnaffectedEarningsAccount()));

    let debitsSum = 0.0;
    let creditsSum = 0.0;
    for (const line of openingMoveLines) {
      if (line != balancingMoveLine) {
        //skip the autobalancing move line
        debitsSum += await line.debit;
        creditsSum += await line.credit;
      }
    }

    const difference = Math.abs(debitsSum - creditsSum);
    const debitDiff = (debitsSum > creditsSum) ? floatRound(difference, { precisionRounding: await currency.rounding }) : 0.0;
    const creditDiff = (debitsSum < creditsSum) ? floatRound(difference, { precisionRounding: await currency.rounding }) : 0.0;
    return [debitDiff, creditDiff];
  }

  /**
   * Checks the opening_move of this company. If it has not been posted yet
      and is unbalanced, balances it with a automatic account.move.line in the
      current year earnings account.
   */
  async _autoBalanceOpeningMove() {
    const [accountOpeningMoveId] = await this('accountOpeningMoveId');
    if (accountOpeningMoveId.ok && await accountOpeningMoveId.state === 'draft') {
      const balancingAccount = await this.getUnaffectedEarningsAccount();
      let currency = await this('currencyId');
      let balancingMoveLine = await (await accountOpeningMoveId.lineIds).filtered(async (x) => (await x.accountId).eq(balancingAccount));
      // There could be multiple lines if we imported the balance from unaffected earnings account too
      if (len(balancingMoveLine) > 1) {
        let lineIds = await (await (await this.withContext({ checkMoveValidity: false })).accountOpeningMoveId).lineIds;
        lineIds = lineIds.sub(balancingMoveLine.slice(1));
        balancingMoveLine = balancingMoveLine[0];
      }
      const [debitDiff, creditDiff] = await this.getOpeningMoveDifferences(await accountOpeningMoveId.lineIds);

      if (floatIsZero(debitDiff + creditDiff, { precisionRounding: await currency.rounding })) {
        if (balancingMoveLine.ok) {
          // zero difference and existing line : delete the line
          accountOpeningMoveId.set('lineIds', (await accountOpeningMoveId.lineIds).sub(balancingMoveLine));
        }
      }
      else {
        if (balancingMoveLine.ok) {
          // Non-zero difference and existing line : edit the line
          await balancingMoveLine.write({ 'debit': creditDiff, 'credit': debitDiff });
        }
        else {
          // Non-zero difference and no existing line : create a new line
          await this.env.items('account.move.line').create({
            'label': await this._t('Automatic Balancing Line'),
            'moveId': accountOpeningMoveId.id,
            'accountId': balancingAccount.id,
            'debit': creditDiff,
            'credit': debitDiff,
          });
        }
      }
    }
  }

  /**
   * Mark the invoice onboarding panel as closed.
   * @returns 
   */
  @api.model()
  async actionCloseAccountInvoiceOnboarding() {
    await (await this.env.company()).set('accountInvoiceOnboardingState', 'closed');
  }

  /**
   * Mark the dashboard onboarding panel as closed.
   * @returns 
   */
  @api.model()
  async actionCloseAccountDashboardOnboarding() {
    await (await this.env.company()).set('accountDashboardOnboardingState', 'closed');
  }

  /**
   * Onboarding step for the invoice layout.
   * @returns 
   */
  @api.model()
  async actionOpenAccountOnboardingSaleTax() {
    const action = await this.env.items("ir.actions.actions")._forXmlid("account.actionOpenAccountOnboardingSaleTax");
    action['resId'] = (await this.env.company()).id;
    return action;
  }

  @api.model()
  async actionOpenAccountOnboardingCreateInvoice() {
    const action = await this.env.items("ir.actions.actions")._forXmlid("account.actionOpenAccountOnboardingCreateInvoice");
    return action;
  }

  /**
   * Called by the 'Taxes' button of the setup bar.
   * @returns 
   */
  @api.model()
  async actionOpenTaxesOnboarding() {
    const company = await this.env.company();
    await (await company.sudo()).setOnboardingStepDone('accountSetupTaxesState');
    const viewIdList = (await this.env.ref('account.viewTaxTree')).id;
    const viewIdForm = (await this.env.ref('account.viewTaxForm')).id;

    return {
      'type': 'ir.actions.actwindow',
      'label': await this._t('Taxes'),
      'resModel': 'account.tax',
      'target': 'current',
      'views': [[viewIdList, 'list'], [viewIdForm, 'form']],
      'context': { 'searchDefault_sale': true, 'searchFefault_purchase': true, 'activeTest': false },
    }
  }

  /**
   * Set the onboarding step as done
   * @returns 
   */
  async actionSaveOnboardingInvoiceLayout() {
    if (bool(await this['externalReportLayoutId'])) {
      await (this as any).setOnboardingStepDone('accountOnboardingInvoiceLayoutState');
    }
  }

  /**
   * Set the onboarding step as done
   * @returns 
   */
  async actionSaveOnboardingSaleTax() {
    await (this as any).setOnboardingStepDone('accountOnboardingSaleTaxState');
  }

  async getChartOfAccountsOrFail() {
    const account = await this.env.items('account.account').search([['companyId', '=', this.id]], { limit: 1 });
    if (len(account) == 0) {
      const action = await this.env.ref('account.actionAccountConfig');
      const msg = await this._t(
        `We cannot find a chart of accounts for this company, you should configure it. \n
                Please go to Account Configuration and select or install a fiscal localization.`);
      throw new RedirectWarning(msg, action.id, await this._t("Go to the configuration panel"));
    }
    return account;
  }

  @api.model()
  async _actionCheckHashIntegrity() {
    return (await this.env.ref('account.actionReportAccountHashIntegrity')).reportAction(this.id);
  }

  /**
   * Checks that all posted moves have still the same data as when they were posted
      and raises an error with the result.
   * @returns 
   */
  async _checkHashIntegrity() {
    if (! await (await this.env.user()).hasGroup('account.groupAccountUser')) {
      throw new UserError(await this._t('Please contact your accountant to print the Hash integrity result.'));
    }

    async function buildMoveInfo(move) {
      return [await move.label, await move.inalterableHash, _Date.toString(await move.date)];
    }

    const journals = await this.env.items('account.journal').search([['companyId', '=', this.id]]);
    const resultsByJournal = {
      'results': [],
      'printingDate': await formatDate(this.env, _Date.toString(await _Date.contextToday(this)))
    }

    for (const journal of journals) {
      const rslt = {
        'journalName': await journal.label,
        'journalCode': await journal.code,
        'restrictedByHashTable': await journal.restrictModeHashTable ? 'V' : 'X',
        'msgCover': '',
        'firstHash': 'null',
        'firstMoveName': 'null',
        'firstMoveDate': 'null',
        'lastHash': 'null',
        'lastMoveName': 'null',
        'lastMoveDate': 'null',
      }
      if (! await journal.restrictModeHashTable) {
        update(rslt, { 'msgCover': await this._t('This journal is not in strict mode.') });
        resultsByJournal['results'].push(rslt);
        continue;
      }
      // We need the `sudo()` to ensure that all the moves are searched, no matter the user's access rights.
      // This is required in order to generate consistent hashs.
      // It is not an issue, since the data is only used to compute a hash and not to return the actual values.
      const sudo = await this.env.items('account.move').sudo();
      const allMovesCount = await sudo.searchCount([['state', '=', 'posted'], ['journalId', '=', journal.id]]);
      const moves = await sudo.search([['state', '=', 'posted'], ['journalId', '=', journal.id], ['secureSequenceNumber', '!=', 0]], { order: "secureSequenceNumber ASC" });
      if (!moves.ok) {
        update(rslt, {
          'msgCover': await this._t("There isn't any journal entry flagged for data inalterability yet for this journal."),
        });
        resultsByJournal['results'].push(rslt);
        continue;
      }
      let previousHash = '';
      let startMoveInfo = [];
      let hashCorrupted = false;
      let currentHashVersion = 1;
      let move;
      for (move of moves) {
        const inalterableHash = await move.inalterableHash;
        let computedHash = await (await move.withContext({ hashVersion: currentHashVersion }))._computeHash(previousHash);
        while (inalterableHash != computedHash && currentHashVersion < MAX_HASH_VERSION) {
          currentHashVersion += 1;
          computedHash = await (await move.withContext({ hashVersion: currentHashVersion }))._computeHash(previousHash);
        }
        if (inalterableHash != computedHash) {
          update(rslt, { 'msgCover': await this._t('Corrupted data on journal entry with id %s.', move.id) });
          resultsByJournal['results'].push(rslt);
          hashCorrupted = true;
          break;
        }
        if (!previousHash) {
          //save the date and sequence number of the first move hashed
          startMoveInfo = await buildMoveInfo(move);
        }
        previousHash = inalterableHash;
      }
      const endMoveInfo = await buildMoveInfo(move);

      if (hashCorrupted) {
        continue;
      }

      update(rslt, {
        'firstMoveName': startMoveInfo[0],
        'firstHash': startMoveInfo[1],
        'firstMoveDate': await formatDate(this.env, startMoveInfo[2]),
        'lastMoveName': endMoveInfo[0],
        'lastHash': endMoveInfo[1],
        'lastMoveDate': await formatDate(this.env, endMoveInfo[2]),
      });
      if (len(moves) == allMovesCount) {
        update(rslt, { 'msgCover': await this._t('All entries are hashed.') });
      }
      else {
        update(rslt, { 'msgCover': await this._t('Entries are hashed from %s (%s)', startMoveInfo[0], await formatDate(this.env, startMoveInfo[2])) });
      }
      resultsByJournal['results'].push(rslt);
    }

    return resultsByJournal;
  }

  /**
   * The role of this method is to provide a fallback when account_accounting is not installed.
      As the fiscal year is irrelevant when account_accounting is not installed, this method returns the calendar year.
      :param current_date: A datetime.date/datetime.datetime object.
      :return: A dictionary containing:
          * dateFrom
          * dateTo
   * @param currentDate 
   * @returns 
   */
  computeFiscalyearDates(currentDate: Date) {
    return {
      'dateFrom': new Date(currentDate.getFullYear(), 0, 1),
      'dateTo': new Date(currentDate.getFullYear(), 11, 31)
    }
  }
}