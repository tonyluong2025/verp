import { api } from "../../../core";
import { setdefault } from "../../../core/api/func";
import { Fields } from "../../../core/fields";
import { UserError, ValidationError, ValueError } from "../../../core/helper/errors";
import { MetaModel, Model, ModelRecords, _super } from "../../../core/models";
import { expression } from "../../../core/osv";
import { dbFactory } from "../../../core/service/db";
import { _f, bool, dropViewIfExists, f, isInstance, len, range, sum } from "../../../core/tools";

@MetaModel.define()
class AccountAccountType extends Model {
  static _module = module;
  static _name = "account.account.type";
  static _description = "Account Type";

  static label = Fields.Char({ string: 'Account Type', required: true, translate: true });
  static includeInitialBalance = Fields.Boolean({ string: "Bring Accounts Balance Forward", help: "Used in reports to know if we should consider journal items from the beginning of time instead of from the fiscal year only. Account types that should be reset to zero at each new fiscal year (like expenses, revenue..) should not have this option set." });
  static type = Fields.Selection([
    ['other', 'Regular'],
    ['receivable', 'Receivable'],
    ['payable', 'Payable'],
    ['liquidity', 'Liquidity'],
  ], {
    required: true, default: 'other',
    help: "The 'Internal Type' is used for features available on different types of accounts: liquidity type is for cash or bank accounts, payable/receivable is for vendor/customer accounts."
  });
  static internalGroup = Fields.Selection([
    ['equity', 'Equity'],
    ['asset', 'Asset'],
    ['liability', 'Liability'],
    ['income', 'Income'],
    ['expense', 'Expense'],
    ['offBalance', 'Off Balance'],
  ], { string: "Internal Group", required: true, help: "The 'Internal Group' is used to filter accounts based on the internal group set on the account type." });
  static note = Fields.Text({ string: 'Description' });
}

@MetaModel.define()
class AccountAccount extends Model {
  static _module = module;
  static _name = "account.account";
  static _parents = ['mail.thread'];
  static _description = "Account";
  static _order = "isOffBalance, code, companyId";
  static _checkCompanyAuto = true;

  @api.constrains('internalType', 'reconcile')
  async _checkReconcile() {
    for (const account of this) {
      if (['receivable', 'payable'].includes(account.internalType) && await account.reconcile === false) {
        throw new ValidationError(await this._t('You cannot have a receivable/payable account that is not reconcilable. (account code: %s)', await account.code));
      }
    }
  }

  @api.constrains('userTypeId')
  async _checkUserTypeIdUniqueCurrentYearEarning() {
    const dataUnaffectedEarnings = await this.env.ref('account.dataUnaffectedEarnings');
    const result = await this.readGroup([['userTypeId', '=', dataUnaffectedEarnings.id]], ['companyId'], ['companyId']);
    for (const res of result) {
      if ((res['companyId_count'] || 0) >= 2) {
        const accountUnaffectedEarnings = await this.search([['companyId', '=', res['companyId'][0]], ['userTypeId', '=', dataUnaffectedEarnings.id]]);
        throw new ValidationError(await this._t('You cannot have more than one account with "Current Year Earnings" as type. (accounts: [%s])', accountUnaffectedEarnings.map(a => a.code)));
      }
    }
  }

  static label = Fields.Char({ string: "Account Name", required: true, index: true, tracking: true });
  static currencyId = Fields.Many2one('res.currency', { string: 'Account Currency', help: "Forces all moves for this account to have this account currency.", tracking: true });
  static code = Fields.Char({ size: 64, required: true, index: true, tracking: true });
  static deprecated = Fields.Boolean({ index: true, default: false, tracking: true });
  static used = Fields.Boolean({ compute: '_computeUsed', search: '_searchUsed' });
  static userTypeId = Fields.Many2one('account.account.type', { string: 'Type', required: true, tracking: true, help: "Account Type is used for information purpose, to generate country-specific legal reports, and set the rules to close a fiscal year and generate opening entries." });
  static internalType = Fields.Selection({ related: 'userTypeId.type', string: "Internal Type", store: true, readonly: true });
  static internalGroup = Fields.Selection({ related: 'userTypeId.internalGroup', string: "Internal Group", store: true, readonly: true });
  //has_unreconciled_entries = Fields.Boolean(compute: '_computeHasUnreconciledEntries', help: "The account has at least one unreconciled debit and credit since last time the invoices & payments matching was performed.")
  static reconcile = Fields.Boolean({ string: 'Allow Reconciliation', default: false, tracking: true, help: "Check this box if this account allows invoices & payments matching of journal items." });
  static taxIds = Fields.Many2many('account.tax', { relation: 'accountAccountTaxDefaultRel', column1: 'accountId', column2: 'taxId', string: 'Default Taxes', checkCompany: true, context: { 'appendTypeToTaxName': true } });
  static note = Fields.Text('Internal Notes', { tracking: true });
  static companyId = Fields.Many2one('res.company', { string: 'Company', required: true, readonly: true, default: self => self.env.company() });
  static tagIds = Fields.Many2many('account.account.tag', { relation: 'accountAccountAccountTag', string: 'Tags', help: "Optional tags you may want to assign for custom reporting" });
  static groupId = Fields.Many2one('account.group', { compute: '_computeAccountGroup', store: true, readonly: true, help: "Account prefixes can determine account groups." });
  static rootId = Fields.Many2one('account.root', { compute: '_computeAccountRoot', store: true });
  static allowedJournalIds = Fields.Many2many('account.journal', { string: "Allowed Journals", help: "Define in which journals this account can be used. If empty, can be used in all journals." });

  static openingDebit = Fields.Monetary({ string: "Opening Debit", compute: '_computeOpeningDebitCredit', inverse: '_setOpeningDebit', help: "Opening debit value for this account." });
  static openingCredit = Fields.Monetary({ string: "Opening Credit", compute: '_computeOpeningDebitCredit', inverse: '_setOpeningCredit', help: "Opening credit value for this account." });
  static openingBalance = Fields.Monetary({ string: "Opening Balance", compute: '_computeOpeningDebitCredit', help: "Opening balance value for this account." });

  static isOffBalance = Fields.Boolean({ compute: '_computeIsOffBalance', default: false, store: true, readonly: true });

  static currentBalance = Fields.Float({ compute: '_computeCurrentBalance' });
  static relatedTaxesAmount = Fields.Integer({ compute: '_computeRelatedTaxesAmount' });

  static _sqlConstraints = [
    ['code_company_uniq', 'unique (code,"companyId")', 'The code of the account must be unique per company !']
  ];

  @api.constrains('reconcile', 'internalGroup', 'taxIds')
  async _constrainsReconcile() {
    for (const record of this) {
      if (await record.internalGroup === 'offBalance') {
        if (await record.reconcile) {
          throw new UserError(await this._t('An Off-Balance account can not be reconcilable'));
        }
        if (bool(await record.taxIds)) {
          throw new UserError(await this._t('An Off-Balance account can not have taxes'));
        }
      }
    }
  }

  @api.constrains('allowedJournalIds')
  async _constrainsAllowedJournalIds() {
    await this.env.items('account.move.line').flush(['accountId', 'journalId']);
    await this.flush(['allowedJournalIds']);
    const ids = await this._cr.execute(`
            SELECT aml.id
            FROM ${dbFactory.quotes("accountMoveLine")} aml
            WHERE ${dbFactory.quotes("aml.accountId")} in (%s)
            AND EXISTS (SELECT 1 FROM ${dbFactory.quotes("accountAccountAccountJournalRel")} WHERE ${dbFactory.quotes("accountAccountId")} = ${dbFactory.quotes("aml.accountId")})
            AND NOT EXISTS (SELECT 1 FROM ${dbFactory.quotes("accountAccountAccountJournalRel")} WHERE ${dbFactory.quotes("accountAccountId")} = ${dbFactory.quotes("aml.accountId")} AND ${dbFactory.quotes("accountJournalId")} = ${dbFactory.quotes("aml.journalId")})
        `, [String(this.ids) || 'NULL']);
    if (ids.length) {
      throw new ValidationError(await this._t('Some journal items already exist with this account but in other journals than the allowed ones.'));
    }
  }

  /**
   * Ensure the currency set on the journal is the same as the currency set on the linked accounts.
   * @returns 
   */
  @api.constrains('currencyId')
  async _checkJournalConsistency() {
    if (!this.ok) {
      return;
    }

    await this.env.items('account.account').flush(['currencyId']);
    await this.env.items('account.journal').flush([
      'currencyId',
      'defaultAccountId',
      'suspenseAccountId',
    ]);
    await this.env.items('account.payment.method').flush(['paymentType']);
    await this.env.items('account.payment.method.line').flush(['paymentMethodId', 'paymentAccountId']);

    const res = await this._cr.execute(_f(`
            SELECT 
                account.id AS aid, 
                journal.id AS jid
            FROM "accountJournal" journal
            JOIN "resCompany" company ON company.id = journal."companyId"
            JOIN "accountAccount" account ON account.id = journal."defaultAccountId"
            WHERE journal."currencyId" IS NOT NULL
            AND journal."currencyId" != company."currencyId"
            AND account."currencyId" != journal."currencyId"
            AND account.id IN ({accounts})
            
            UNION ALL
            
            SELECT 
                account.id AS aid, 
                journal.id AS jid
            FROM "accountJournal" journal
            JOIN "resCompany" company ON company.id = journal."companyId"
            JOIN "accountPaymentMethodLine" apml ON apml."journalId" = journal.id
            JOIN "accountPaymentMethod" apm ON apm.id = apml."paymentMethodId"
            JOIN "accountAccount" account ON account.id = COALESCE(apml."paymentAccountId", company."accountJournalPaymentDebitAccountId")
            WHERE journal."currencyId" IS NOT NULL
            AND journal."currencyId" != company."currencyId"
            AND account."currencyId" != journal."currencyId"
            AND apm."paymentType" = 'inbound'
            AND account.id IN ({accounts})
            
            UNION ALL
            
            SELECT 
                account.id AS aid, 
                journal.id AS jid
            FROM "accountJournal" journal
            JOIN "resCompany" company ON company.id = journal."companyId"
            JOIN "accountPaymentMethodLine" apml ON apml."journalId" = journal.id
            JOIN "accountPaymentMethod" apm ON apm.id = apml."paymentMethodId"
            JOIN "accountAccount" account ON account.id = COALESCE(apml."paymentAccountId", company."accountJournalPaymentCreditAccountId")
            WHERE journal."currencyId" IS NOT NULL
            AND journal."currencyId" != company."currencyId"
            AND account."currencyId" != journal."currencyId"
            AND apm."paymentType" = 'outbound'
            AND account.id IN ({accounts})
        `, {
      'accounts': this.ids
    }));
    if (res.length) {
      const account = this.env.items('account.account').browse(res[0]['aid']);
      const journal = this.env.items('account.journal').browse(res[0]['jid']);
      throw new ValidationError(_f(await this._t(
        "The foreign currency set on the journal '%(journal)s' and the account '%(account)s' must be the same.",
        {
          journal: await journal.displayName,
          account: await account.displayName
        }
      )));
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
            JOIN "accountAccount" account ON account.id = line."accountId"
            WHERE line."accountId" IN (%s)
            AND line."companyId" != account."companyId"
        `, [String(this.ids) || 'NULL']);
    if (res.length) {
      throw new UserError(await this._t("You can't change the company of your account since there are some journal items linked to it."));
    }
  }

  @api.constrains('userTypeId')
  async _checkUserTypeIdSalesPurchaseJournal() {
    if (!this.ok) {
      return;
    }

    await this.flush(['userTypeId']);
    const res = await this._cr.execute(`
            SELECT account.id
            FROM "accountAccount" account
            JOIN "accountAccountType" "accType" ON account."userTypeId" = "accType".id
            JOIN "accountJournal" journal ON journal."defaultAccountId" = account.id
            WHERE account.id IN (%s)
            AND "accType".type IN ('receivable', 'payable')
            AND journal.type IN ('sale', 'purchase')
            LIMIT 1;
        `, [String(this.ids) || 'NULL']);

    if (res.length) {
      throw new ValidationError(await this._t("The account is already in use in a 'sale' or 'purchase' journal. This means that the account's type couldn't be 'receivable' or 'payable'."));
    }
  }

  @api.constrains('reconcile')
  async _checkUsedAsJournalDefaultDebitCreditAccount() {
    const accounts = await this.filtered(async (a) => !(await a.reconcile));
    if (!accounts.ok) {
      return;
    }

    await this.flush(['reconcile']);
    await this.env.items('account.payment.method.line').flush(['journalId', 'paymentAccountId']);

    const rows = await this._cr.execute(_f(`
            SELECT journal.id
            FROM "accountJournal" journal
            JOIN "resCompany" company on journal."companyId" = company.id
            LEFT JOIN "accountPaymentMethodLine" apml ON journal.id = apml."journalId"
            WHERE company."accountJournalPaymentCreditAccountId" IN ({accounts})
            OR company."accountJournalPaymentDebitAccountId" IN ({accounts})
            OR apml."paymentAccountId" in ({accounts})
        `, {
      'accounts': accounts.ids,
    }));
    if (rows.length) {
      const journals = this.env.items('account.journal').browse(rows.map(r => r['id']));
      throw new ValidationError(_f(await this._t(
        "This account is configured in {journalNames} journal(s) (ids {journalIds}) as payment debit or credit account. This means that this account's type should be reconcilable."), {
        journalNames: await journals.mapped('displayName'),
        journalIds: journals.ids
      }))
    }
  }

  @api.depends('code')
  async _computeAccountRoot() {
    // this computes the first 2 digits of the account.
    // This field should have been a char, but the aim is to use it in a side panel view with hierarchy, and it's only supported by many2one fields so far.
    // So instead, we make it a many2one to a psql view with what we need as records.
    for (const record of this) {
      const code: string = await record.code;
      await record.set('rootId', code ? (code.charCodeAt(0) * 1000 + (code.slice(1, 2) ?? '\x00').charCodeAt(0)) : false);
    }
  }

  @api.depends('code')
  async _computeAccountGroup() {
    if (bool(this.ids)) {
      await this.env.items('account.group')._adaptAccountsForAccountGroups(this);
    }
    else {
      await this.set('groupId', false);
    }
  }

  async _searchUsed(operator, value) {
    if (!['=', '!='].includes(operator) || typeof (value) !== 'boolean') {
      throw new UserError(await this._t('Operation not supported'));
    }
    if (operator !== '=') {
      value = !value;
    }
    const rows = await this._cr.execute(`
            SELECT id FROM "accountAccount" account
            WHERE EXISTS (SELECT * FROM "accountMoveLine" aml WHERE aml."accountId" = account.id LIMIT 1)
        `)
    return [['id', value ? 'in' : 'not in', rows.map(r => r['id'])]];
  }

  async _computeUsed() {
    const ids = new Set((await this._searchUsed('=', true))[0][2]);
    for (const record of this) {
      await record.set('used', ids.has(record.id));
    }
  }

  @api.model()
  async _searchNewAccountCode(company: ModelRecords, digits: number, prefix: string) {
    for (const num of range(1, 10000)) {
      const newCode = String(prefix.padEnd(digits - 1, '0')) + String(num);
      const rec = await this.search([['code', '=', newCode], ['companyId', '=', company.id]], { limit: 1 });
      if (!rec.ok) {
        return newCode;
      }
    }
    throw new UserError(await this._t('Cannot generate an unused account code.'));
  }

  async _computeCurrentBalance() {
    const balances = {};
    for (const read of await this.env.items('account.move.line').readGroup([['accountId', 'in', this.ids]], ['balance', 'accountId'], ['accountId'])) {
      balances[read['accountId']['id']] = read['balance'];
    }
    for (const record of this) {
      await record.set('currentBalance', balances[record.id] || 0);
    }
  }

  async _computeRelatedTaxesAmount() {
    for (const record of this) {
      await record.set('relatedTaxesAmount', await this.env.items('account.tax').searchCount([
        '|',
        ['invoiceRepartitionLineIds.accountId', '=', record.id],
        ['refundRepartitionLineIds.accountId', '=', record.id],
      ]));
    }
  }

  async _computeOpeningDebitCredit() {
    // await Promise.all([
    await this.set("openingDebit", 0),
      await this.set("openingCredit", 0),
      await this.set("openingBalance", 0)
    // ]);
    if (!bool(this.ids)) {
      return;
    }
    const rows = await this.env.cr.execute(`
            SELECT line.'accountId',
                   SUM(line.balance) AS balance,
                   SUM(line.debit) AS debit,
                   SUM(line.credit) AS credit
              FROM "accountMoveLine" line
              JOIN "resCompany" comp ON comp.id = line."companyId"
             WHERE line."moveId" = comp."accountOpeningMoveId"
               AND line."accountId" IN (%s)
             GROUP BY line."accountId"
        `, [String(this.ids) || 'NULL']);
    const result = Object.fromEntries(rows.map(r => [r['accountId'], r]));
    for (const record of this) {
      const res = result[record.id] ?? { 'debit': 0, 'credit': 0, 'balance': 0 };
      // await Promise.all([
      await record.set('openingDebit', res['debit']),
        await record.set('openingCredit', res['credit']),
        await record.set('openingBalance', res['balance'])
      // ]);
    }
  }

  @api.depends('internalGroup')
  async _computeIsOffBalance() {
    for (const account of this) {
      await account.set('isOffBalance', await account.internalGroup === "offBalance");
    }
  }

  async _setOpeningDebit() {
    for (const record of this) {
      await record._setOpeningDebitCredit(await record.openingDebit, 'debit');
    }
  }

  async _setOpeningCredit() {
    for (const record of this) {
      await record._setOpeningDebitCredit(await record.openingCredit, 'credit');
    }
  }

  /**
   * Generic function called by both opening_debit and opening_credit's
      inverse function. 'Amount' parameter is the value to be set, and field
      either 'debit' or 'credit', depending on which one of these two fields
      got assigned.
   * @param amount 
   * @param field 
   */
  async _setOpeningDebitCredit(amount, field) {
    const companyId = await this['companyId'];
    await (await this['companyId']).createOpMoveIfNonExistant();
    const openingMove = await companyId.accountOpeningMoveId;

    if (await openingMove.state === 'draft') {
      // check whether we should create a new move line or modify an existing one
      const accountOpLines = await this.env.items('account.move.line').search([['accountId', '=', this.id],
      ['moveId', '=', openingMove.id],
      [field, '!=', false],
      [field, '!=', 0.0]]) // 0.0 condition important for import

      if (accountOpLines.ok) {
        const opAmlDebit = sum(await accountOpLines.mapped('debit'));
        const opAmlCredit = sum(await accountOpLines.mapped('credit'));

        // There might be more than one line on this account if the opening entry was manually edited
        // If so, we need to merge all those lines into one before modifying its balance
        const openingMoveLine = accountOpLines[0];
        if (len(accountOpLines) > 1) {
          const mergeWriteCmd = [[1, openingMoveLine.id, { 'debit': opAmlDebit, 'credit': opAmlCredit, 'partnerId': null, 'label': await this._t("Opening balance") }]];
          const unlinkWriteCmd = await accountOpLines.slice(1).map(line => [2, line.id]);
          await openingMove.write({ 'lineIds': mergeWriteCmd.concat(unlinkWriteCmd) });
        }
        if (bool(amount)) {
          // modify the line
          await (await openingMoveLine.withContext({ checkMoveValidity: false })).set(field, amount);
        }
        else {
          // delete the line (no need to keep a line with value = 0)
          await (await openingMoveLine.withContext({ checkMoveValidity: false })).unlink();
        }
      }
      else if (bool(amount)) {
        // create a new line, as none existed before
        await (await this.env.items('account.move.line').withContext({ checkMoveValidity: false })).create({
          'label': await this._t('Opening balance'),
          field: amount,
          'moveId': openingMove.id,
          'accountId': this.id,
        });
      }
      // Then, we automatically balance the opening move, to make sure it stays valid
      if (!('importFile' in this.env.context)) {
        // When importing a file, avoid recomputing the opening move for each account and do it at the end, for better performances
        await companyId._autoBalanceOpeningMove();
      }
    }
  }

  /**
   * If we're creating a new account through a many2one, there are chances that we typed the account code
      instead of its name. In that case, switch both fields values.
   * @param defaultFields 
   * @returns 
   */
  @api.model()
  async defaultGet(defaultFields) {
    if (!defaultFields.includes('label') && !defaultFields.includes('code')) {
      return _super(AccountAccount, this).defaultGet(defaultFields);
    }
    let defaultName = this._context['default_label'];
    let defaultCode = this._context['default_code'];
    if (defaultName && !defaultCode) {
      try {
        defaultCode = parseInt(defaultName);
      } catch (e) {
        if (!isInstance(e, ValueError)) {
          throw e;
        }
      }
      if (defaultCode) {
        defaultName = false;
      }
    }
    const contextualSelf = await this.withContext({ default_label: defaultName, default_code: defaultCode });
    return _super(AccountAccount, contextualSelf).defaultGet(defaultFields);
  }

  @api.model()
  async _nameSearch(name: string, args?: any, operator = 'ilike', { limit = 100, nameGetUid = false } = {}) {
    args = args ?? [];
    let domain = [];
    if (name) {
      domain = ['|', ['code', '=ilike', name.trim().split(' ')[0] + '%'], ['label', operator, name]];
      if (expression.NEGATIVE_TERM_OPERATORS.includes(operator)) {
        domain = ['&', '!'].concat(domain.slice(1));
      }
    }
    return this._search(expression.AND([domain, args]), { limit, accessRightsUid: nameGetUid });
  }

  @api.onchange('userTypeId')
  async _onchangeUserTypeId() {
    const [internalType, internalGroup, taxIds, companyId] = await this('internalType', 'internalGroup', 'taxIds', 'companyId');
    await this.set('reconcile', ['receivable', 'payable'].includes(internalType));
    if (internalType === 'liquidity') {
      await this.set('reconcile', false);
    }
    else if (internalGroup === 'offBalance') {
      await this.set('reconcile', false);
      await this.set('taxIds', false);
    }
    else if (internalGroup === 'income' && !taxIds.ok) {
      await this.set('taxIds', await companyId.accountSaleTaxId);
    }
    else if (internalGroup === 'expense' && !taxIds.ok) {
      await this.set('taxIds', await companyId.accountPurchaseTaxId);
    }
  }

  async nameGet() {
    const result = [];
    for (const account of this) {
      const label = await account.code + ' ' + await account.label
      result.push([account.id, label]);
    }
    return result;
  }

  @api.returns('self', (value) => value.id)
  async copy(defaultValue?: any) {
    defaultValue = defaultValue ?? {};
    if (defaultValue['code']) {
      return _super(AccountAccount, this).copy(defaultValue);
    }
    const [code, label, companyId] = await this('code', 'label', 'companyId');
    try {
      defaultValue['code'] = String(parseInt(code) + 10).padStart(len(code), '0');
      setdefault(defaultValue, 'label', await this._t("%s (copy)", label || ''));
      while (true) {
        const result = await this.env.items('account.account').search([['code', '=', defaultValue['code']],
        ['companyId', '=', defaultValue['companyId'] || companyId.id]], { limit: 1 });
        if (!result.ok) {
          break;
        }
        defaultValue['code'] = String(parseInt(defaultValue['code']) + 10);
        defaultValue['label'] = await this._t("%s (copy)", label || '');
      }
    } catch (e) {
      if (isInstance(e, ValueError)) {
        defaultValue['code'] = await this._t("%s (copy)", code || '');
        defaultValue['label'] = label;
      } else {
        throw e;
      }
    }
    return _super(AccountAccount, this).copy(defaultValue);
  }

  /**
   * Overridden for better performances when importing a list of account
      with opening debit/credit. In that case, the auto-balance is postpone
      until the whole file has been imported.
   * @param fields 
   * @param data 
   * @returns 
   */
  @api.model()
  async load(fields, data) {
    const rslt = await _super(AccountAccount, this).load(fields, data);

    if ('importFile' in this.env.context) {
      const companies = await (await this.search([['id', 'in', rslt['ids']]])).mapped('companyId');
      for (const company of companies) {
        await company._autoBalanceOpeningMove();
      }
    }
    return rslt;
  }

  /**
   * Toggle the `reconcile´ boolean from false -> true

      Note that: lines with debit = credit = amount_currency = 0 are set to `reconciled´ = true
   * @returns 
   */
  async _toggleReconcileToTrue() {
    if (!bool(this.ids)) {
      return null;
    }
    const query = `
            UPDATE "accountMoveLine" SET
                reconciled = CASE WHEN debit = 0 AND credit = 0 AND "amountCurrency" = 0
                    THEN true ELSE false END,
                "amountResidual" = (debit-credit),
                "amountResidualCurrency" = "amountCurrency"
            WHERE "fullReconcileId" IS NULL and "accountId" IN (%s)
        `;
    await this.env.cr.execute(query, [String(this.ids) || 'NULL']);
  }

  /**
   * Toggle the `reconcile´ boolean from true -> false

      Note that it is disallowed if some lines are partially reconciled.
   * @returns 
   */
  async _toggleReconcileToFalse() {
    if (!bool(this.ids)) {
      return null;
    }
    const partialLinesCount = await this.env.items('account.move.line').searchCount([
      ['accountId', 'in', this.ids],
      ['fullReconcileId', '=', false],
      ['|'],
      ['matchedDebitIds', '!=', false],
      ['matchedCreditIds', '!=', false],
    ]);
    if (partialLinesCount > 0) {
      throw new UserError(await this._t('You cannot switch an account to prevent the reconciliation if some partial reconciliations are still pending.'));
    }
    const query = `
            UPDATE "accountMoveLine"
                SET "amountResidual" = 0, "amountResidualCurrency" = 0
            WHERE "fullReconcileId" IS NULL AND "accountId" IN (%s)
        `;
    await this.env.cr.execute(query, [String(this.ids) || 'NULL']);
  }

  async write(vals) {
    // Do not allow changing the companyId when account_move_line already exist
    if (vals['companyId']) {
      const moveLines = await this.env.items('account.move.line').search([['accountId', 'in', this.ids]], { limit: 1 });
      for (const account of this) {
        if ((await account.companyId).id !== vals['companyId'] && bool(moveLines)) {
          throw new UserError(await this._t('You cannot change the owner company of an account that already contains journal items.'));
        }
      }
    }
    if ('reconcile' in vals) {
      if (vals['reconcile']) {
        await (await this.filtered(async (r) => ! await r.reconcile))._toggleReconcileToTrue();
      }
      else {
        await (await this.filtered((r) => r.reconcile))._toggleReconcileToFalse();
      }
    }

    if (vals['currencyId']) {
      for (const account of this) {
        if (await this.env.items('account.move.line').searchCount([['accountId', '=', account.id], ['currencyId', 'not in', [false, vals['currencyId']]]])) {
          throw new UserError(await this._t('You cannot set a currency on this account as it already has some journal entries having a different foreign currency.'));
        }
      }
    }
    return _super(AccountAccount, this).write(vals);
  }

  @api.ondelete(false)
  async _unlinkExceptContainsJournalItems() {
    if (bool(await this.env.items('account.move.line').search([['accountId', 'in', this.ids]], { limit: 1 }))) {
      throw new UserError(await this._t('You cannot perform this action on an account that contains journal items.'));
    }
  }

  @api.ondelete(false)
  async _unlinkExceptAccountSetOnCustomer() {
    //Checking whether the account is set as a property to any Partner or not
    const values = this.ids.map(accountId => `account.account,${accountId}`);
    const partnerPropAcc = await (await this.env.items('ir.property').sudo()).search([['valueReference', 'in', values]], { limit: 1 });
    if (bool(partnerPropAcc)) {
      const accountName = await (await partnerPropAcc.getByRecord()).displayName;
      throw new UserError(
        await this._t('You cannot remove/deactivate the account %s which is set on a customer or vendor.', accountName)
      )
    }
  }

  async actionReadAccount() {
    this.ensureOne()
    return {
      'label': await this['displayName'],
      'type': 'ir.actions.actwindow',
      'viewType': 'form',
      'viewMode': 'form',
      'resModel': 'account.account',
      'resId': this.id,
    }
  }

  async actionDuplicateAccounts() {
    for (const account of this.browse(this.env.context['activeIds'])) {
      await account.copy();
    }
  }

  async actionOpenRelatedTaxes() {
    const relatedTaxesIds = (await this.env.items('account.tax').search([
      '|',
      ['invoiceRepartitionLineIds.accountId', '=', this.id],
      ['refundRepartitionLineIds.accountId', '=', this.id],
    ])).ids;
    return {
      'type': 'ir.actions.actwindow',
      'label': await this._t('Taxes'),
      'resModel': 'account.tax',
      'viewType': 'list',
      'viewMode': 'list',
      'views': [[false, 'list'], [false, 'form']],
      'domain': [['id', 'in', relatedTaxesIds]],
    }
  }
}

@MetaModel.define()
class AccountGroup extends Model {
  static _module = module;
  static _name = "account.group";
  static _description = 'Account Group';
  static _parentStore = true;
  static _order = 'codePrefixStart';

  static parentId = Fields.Many2one('account.group', { index: true, ondelete: 'CASCADE', readonly: true });
  static parentPath = Fields.Char({ index: true });
  static label = Fields.Char({ required: true });
  static codePrefixStart = Fields.Char();
  static codePrefixEnd = Fields.Char();
  static companyId = Fields.Many2one('res.company', { required: true, readonly: true, default: self => self.env.company() });

  static _sqlConstraints = [
    [
      'check_length_prefix',
      'CHECK(char_length(COALESCE("codePrefixStart", \'\')) = char_length(COALESCE("codePrefixEnd", \'\')))',
      'The length of the starting and the ending code prefix must be the same'
    ],
  ]

  @api.onchange('codePrefixStart')
  async _onchangeCodePrefixStart() {
    const [codePrefixEnd, codePrefixStart] = await this('codePrefixEnd', 'codePrefixStart');
    if (!codePrefixEnd || codePrefixEnd < codePrefixStart) {
      await this.set('codePrefixEnd', codePrefixStart);
    }
  }

  @api.onchange('codePrefixEnd')
  async _onchangeCodePrefixEnd() {
    const [codePrefixEnd, codePrefixStart] = await this('codePrefixEnd', 'codePrefixStart');
    if (!codePrefixStart || codePrefixStart > codePrefixEnd) {
      await this.set('codePrefixStart', codePrefixEnd);
    }
  }

  async nameGet() {
    const result = [];
    for (const group of this) {
      let [label, codePrefixEnd, codePrefixStart] = await group('label', 'codePrefixEnd', 'codePrefixStart');
      let prefix = codePrefixStart && String(codePrefixStart);
      if (prefix && codePrefixEnd != codePrefixStart) {
        prefix += '-' + String(codePrefixEnd);
      }
      label = (prefix && (prefix + ' ') || '') + label;
      result.push([group.id, label]);
    }
    return result;
  }

  @api.model()
  async _nameSearch(name, args?: any, operator = 'ilike', { limit = 100, nameGetUid = false } = {}) {
    args = args || [];
    let domain: any[];
    if (operator === 'ilike' && !(name || '').trim()) {
      domain = [];
    }
    else {
      const criteriaOperator: any[] = !expression.NEGATIVE_TERM_OPERATORS.includes(operator) ? ['|'] : ['&', '!'];
      domain = criteriaOperator.concat([['codePrefixStart', '=ilike', name + '%'], ['label', operator, name]]);
    }
    return this._search(expression.AND([domain, args]), { limit, accessRightsUid: nameGetUid });
  }

  @api.constrains('codePrefixStart', 'codePrefixEnd')
  async _constraintPrefixOverlap() {
    await this.env.items('account.group').flush();
    const query = `
            SELECT other.id FROM "accountGroup" this
            JOIN "accountGroup" other
              ON char_length(other."codePrefixStart") = char_length(this."codePrefixStart")
             AND other.id != this.id
             AND other."companyId" = this."companyId"
             AND (
                other."codePrefixStart" <= this."codePrefixStart" AND this."codePrefixStart" <= other."codePrefixEnd"
                OR
                other."codePrefixStart" >= this."codePrefixStart" AND this."codePrefixEnd" >= other."codePrefixStart"
            )
            WHERE this.id IN (%s)
        `;
    const res = await this.env.cr.execute(query, [String(this.ids) || 'NULL']);
    if (res.length) {
      throw new ValidationError(await this._t('Account Groups with the same granularity can\'t overlap'));
    }
  }

  @api.modelCreateMulti()
  async create(valsList) {
    for (const vals of valsList) {
      if ('codePrefixStart' in vals && !vals['codePrefixEnd']) {
        vals['codePrefixEnd'] = vals['codePrefixStart'];
      }
    }
    const resIds = await _super(AccountGroup, this).create(valsList);
    await resIds._adaptAccountsForAccountGroups();
    await resIds._adaptParentAccountGroup();
    return resIds;
  }

  async write(vals) {
    const res = await _super(AccountGroup, this).write(vals);
    if ('codePrefixStart' in vals || 'codePrefixEnd' in vals) {
      await this._adaptAccountsForAccountGroups();
      await this._adaptParentAccountGroup();
    }
    return res
  }

  async unlink() {
    for (const record of this) {
      const parentId = await record.parentId;
      const accountIds = await this.env.items('account.account').search([['groupId', '=', record.id]]);
      await accountIds.write({ 'groupId': parentId.id });

      const childrenIds = await this.env.items('account.group').search([['parentId', '=', record.id]]);
      await childrenIds.write({ 'parentId': parentId.id });
    }
    return _super(AccountGroup, this).unlink();
  }

  /**
   * Ensure consistency between accounts and account groups.

      Find and set the most specific group matching the code of the account.
      The most specific is the one with the longest prefixes and with the starting
      prefix being smaller than the account code and the ending prefix being greater.
   * @param accountIds 
   * @returns 
   */
  async _adaptAccountsForAccountGroups(accountIds?: any) {
    if (!this.ok && !bool(accountIds)) {
      return;
    }
    // await Promise.all([
    await this.env.items('account.group').flush(this.env.models['account.group']._fields.keys()),
      await this.env.items('account.account').flush(this.env.models['account.account']._fields.keys())
    // ]);
    const query = _f(`
            WITH relation AS (
       SELECT DISTINCT FIRST_VALUE(agroup.id) OVER (PARTITION BY account.id ORDER BY char_length(agroup."codePrefixStart") DESC, agroup.id) AS "groupId",
                       account.id AS "accountId"
                  FROM "accountGroup" agroup
                  JOIN "accountAccount" account
                    ON agroup."codePrefixStart" <= LEFT(account.code, char_length(agroup."codePrefixStart"))
                   AND agroup."codePrefixEnd" >= LEFT(account.code, char_length(agroup."codePrefixEnd"))
                   AND agroup."companyId" = account."companyId"
                 WHERE account."companyId" IN ({companyIds}) {whereAccount}
            )
            UPDATE "accountAccount" account
               SET "groupId" = relation."groupId"
              FROM relation
             WHERE relation."accountId" = account.id;
        `, {
      whereAccount: bool(accountIds) ? 'AND account.id IN ({accountIds})' : ''
    });
    const companyId = await this['companyId'];
    await this.env.cr.execute(_f(query, { 'companyIds': String((bool(companyId) ? companyId : await accountIds.companyId).ids), 'accountIds': bool(accountIds) && String(accountIds.ids) }));
    this.env.items('account.account').invalidateCache(['groupId']);
  }

  /**
   * Ensure consistency of the hierarchy of account groups.

      Find and set the most specific parent for each group.
      The most specific is the one with the longest prefixes and with the starting
      prefix being smaller than the child prefixes and the ending prefix being greater.
   * @returns 
   */
  async _adaptParentAccountGroup() {
    if (!this.ok) {
      return;
    }
    await this.env.items('account.group').flush(this.env.models['account.group']._fields.keys());
    const query = `
            WITH relation AS (
       SELECT DISTINCT FIRST_VALUE(parent.id) OVER (PARTITION BY child.id ORDER BY child.id, char_length(parent."codePrefixStart") DESC) AS "parentId",
                       child.id AS "childId"
                  FROM "accountGroup" parent
                  JOIN "accountGroup" child
                    ON char_length(parent."codePrefixStart") < char_length(child."codePrefixStart")
                   AND parent."codePrefixStart" <= LEFT(child."codePrefixStart", char_length(parent."codePrefixStart"))
                   AND parent."codePrefixEnd" >= LEFT(child."codePrefixEnd", char_length(parent."codePrefixEnd"))
                   AND parent.id != child.id
                   AND parent."companyId" = child."companyId"
                 WHERE child."companyId" IN ({companyIds})
            )
            UPDATE "accountGroup" child
               SET "parentId" = relation."parentId"
              FROM relation
             WHERE child.id = relation."childId";
        `;
    const companyId = await this['companyId'];
    await this.env.cr.execute(_f(query, { 'companyIds': String(companyId.ids) }));
    this.env.items('account.group').invalidateCache(['parentId']);
    await (await this.env.items('account.group').search([['companyId', 'in', companyId.ids]]))._parentStoreUpdate();
  }
}

@MetaModel.define()
class AccountRoot extends Model {
  static _module = module;
  static _name = 'account.root';
  static _description = 'Account codes first 2 digits';
  static _auto = false;

  static label = Fields.Char();
  static parentId = Fields.Many2one('account.root');
  static companyId = Fields.Many2one('res.company');

  async init() {
    await dropViewIfExists(this._cr, this.cls._table);
    await this._cr.execute(f(`
            CREATE OR REPLACE VIEW "${this.cls._table}" AS (
            SELECT DISTINCT ASCII(code) * 1000 + ASCII(SUBSTRING(code,2,1)) AS id,
                   LEFT(code,2) AS label,
                   ASCII(code) AS "parentId",
                   "companyId"
            FROM "accountAccount" WHERE code IS NOT NULL
            UNION ALL
            SELECT DISTINCT ASCII(code) AS id,
                   LEFT(code,1) AS label,
                   NULL::int AS "parentId",
                   "companyId"
            FROM "accountAccount" WHERE code IS NOT NULL
            )`)
    );
  }
}
