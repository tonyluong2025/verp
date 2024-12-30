import _ from "lodash";
import { api } from "../../../core";
import { sanitizeAccountNumber } from "../../../core/addons/base/models/res_bank";
import { Command, Fields, _Date } from "../../../core/fields";
import { UserError, ValidationError } from "../../../core/helper/errors";
import { MetaModel, Model, _super } from "../../../core/models";
import { Query, expression } from "../../../core/osv";
import { _convert$, bool, f, len, quoteList, range, removeAccents, update } from "../../../core/tools";

@MetaModel.define()
class AccountJournalGroup extends Model {
  static _module = module;
  static _name = 'account.journal.group';
  static _description = "Account Journal Group";
  static _checkCompanyAuto = true;

  static label = Fields.Char("Journal Group", { required: true, translate: true });
  static companyId = Fields.Many2one('res.company', { required: true, default: self => self.env.company() });
  static excludedJournalIds = Fields.Many2many('account.journal', { string: "Excluded Journals", domain: "[['companyId', '=', companyId]]", checkCompany: true });
  static sequence = Fields.Integer({ default: 10 });
}

@MetaModel.define()
class AccountJournal extends Model {
  static _module = module;
  static _name = "account.journal";
  static _description = "Journal";
  static _order = 'sequence, type, code';
  static _parents = ['mail.thread', 'mail.activity.mixin'];
  static _checkCompanyAuto = true;

  async _defaultInboundPaymentMethods() {
    return this.env.ref('account.accountPaymentMethodManualIn');
  }

  async _defaultOutboundPaymentMethods() {
    return this.env.ref('account.accountPaymentMethodManualOut');
  }

  async __getBankStatementsAvailableSources() {
    return [['undefined', await this._t('Undefined Yet')]];
  }

  async _getBankStatementsAvailableSources() {
    return this.__getBankStatementsAvailableSources();
  }

  /**
   * Get the invoice reference model according to the company's country.
   * @returns 
   */
  async _defaultInvoiceReferenceModel() {
    let countryCode: string = await (await (await this.env.company()).countryId).code;
    countryCode = countryCode && countryCode.toLowerCase();
    if (countryCode) {
      for (const model of await this._fields['invoiceReferenceModel'].getValues(this.env)) {
        if (model.startsWith(countryCode)) {
          return model;
        }
      }
    }
    return 'verp';
  }

  static label = Fields.Char({ string: 'Journal Name', required: true });
  static code = Fields.Char({ string: 'Short Code', size: 5, required: true, help: "Shorter name used for display. The journal entries of this journal will also be named using this prefix by default." });
  static active = Fields.Boolean({ default: true, help: "Set active to false to hide the Journal without removing it." });
  static type = Fields.Selection([
    ['sale', 'Sales'],
    ['purchase', 'Purchase'],
    ['cash', 'Cash'],
    ['bank', 'Bank'],
    ['general', 'Miscellaneous'],
  ], {
    required: true, help: ["Select 'Sale' for customer invoices journals.",
      "Select 'Purchase' for vendor bills journals.",
      "Select 'Cash' or 'Bank' for journals that are used in customer or vendor payments.",
      "Select 'General' for miscellaneous operations journals."].join('\n')
  });
  static typeControlIds = Fields.Many2many('account.account.type', { relation: 'journalAccountTypeControlRel', column1: 'journalId', column2: 'typeId', string: 'Allowed account types' });
  static accountControlIds = Fields.Many2many('account.account', { relation: 'journalAccountControlRel', column1: 'journalId', column2: 'accountId', string: 'Allowed accounts', checkCompany: true, domain: "[['deprecated', '=', false], ['companyId', '=', companyId], ['isOffBalance', '=', false]]" });
  // Tony must check name 'default_xxx' in context
  static defaultAccountType = Fields.Many2one('account.account.type', { compute: "_computeDefaultAccountType" });
  static defaultAccountId = Fields.Many2one({ comodelName: 'account.account', checkCompany: true, copy: false, ondelete: 'RESTRICT', string: 'Default Account', domain: "[['deprecated', '=', false], ['companyId', '=', companyId], '|', ['userTypeId', '=', defaultAccountType], ['userTypeId', 'in', typeControlIds], ['userTypeId.type', 'not in', ['receivable', 'payable']]]" });
  static suspenseAccountId = Fields.Many2one({ comodelName: 'account.account', checkCompany: true, ondelete: 'RESTRICT', readonly: false, store: true, compute: '_computeSuspenseAccountId', help: "Bank statements transactions will be posted on the suspense account until the final reconciliation allowing finding the right account.", string: 'Suspense Account', domain: async (self) => f("[['deprecated', '=', false], ['companyId', '=', companyId], ['userTypeId.type', 'not in', ['receivable', 'payable']], ['userTypeId', '=', %s]]", (await self.env.ref('account.dataAccountTypeCurrentLiabilities')).id) })
  static restrictModeHashTable = Fields.Boolean({ string: "Lock Posted Entries with Hash", help: "If ticked, the accounting entry or invoice receives a hash as soon as it is posted and cannot be modified anymore." });
  static sequence = Fields.Integer({ help: 'Used to order Journals in the dashboard view', default: 10 });

  static invoiceReferenceType = Fields.Selection([['none', 'Open'], ['partner', 'Based on Customer'], ['invoice', 'Based on Invoice']], { string: 'Communication Type', required: true, default: 'invoice', help: 'You can set here the default communication that will appear on customer invoices, once validated, to help the customer to refer to that particular invoice when making the payment.' });
  static invoiceReferenceModel = Fields.Selection([['verp', 'Verp'], ['euro', 'European']], { string: 'Communication Standard', required: true, default: self => self._defaultInvoiceReferenceModel(), help: "You can choose different models for each type of reference. The default one is the Verp reference." });

  //groupsId = Fields.Many2many('res.groups', 'account_journal_group_rel', 'journalId', 'groupId', string: 'Groups')
  static currencyId = Fields.Many2one('res.currency', { help: 'The currency used to enter statement', string: "Currency" });
  static companyId = Fields.Many2one('res.company', { string: 'Company', required: true, readonly: true, index: true, default: self => self.env.company(), help: "Company related to this journal" });
  static countryCode = Fields.Char({ related: 'companyId.accountFiscalCountryId.code', readonly: true });

  static refundSequence = Fields.Boolean({ string: 'Dedicated Credit Note Sequence', help: "Check this box if you don't want to share the same sequence for invoices and credit notes made from this journal", default: false });
  static sequenceOverrideRegex = Fields.Text({
    help: ["Technical field used to enforce complex sequence composition that the system would normally misunderstand.",
      "This is a regex that can include all the following capture groups: prefix1, year, prefix2, month, prefix3, seq, suffix.",
      "The prefix* groups are the separators between the year, month and the actual increasing sequence number (seq).",
      "e.g: /^(?<prefix1>.*?)(?<year>\d{4})(?<prefix2>\D*?)(?<month>\d{2})(?<prefix3>\D+?)(?<seq>\d+)(?<suffix>\D*?)$/"].join('\n')
  });

  static inboundPaymentMethodLineIds = Fields.One2many('account.payment.method.line', 'journalId', { domain: [['paymentType', '=', 'inbound']], compute: '_computeInboundPaymentMethodLineIds', store: true, readonly: false, string: 'Inbound Payment Methods', copy: false, checkCompany: true, help: ["Manual: Get paid by any method outside of Verp.",
      "Payment Acquirers: Each payment acquirer has its own Payment Method. Request a transaction on/to a card thanks to a payment token saved by the partner when buying or subscribing online.",
      "Batch Deposit: Collect several customer checks at once generating and submitting a batch deposit to your bank. Module account_batch_payment is necessary.",
      "SEPA Direct Debit: Get paid in the SEPA zone thanks to a mandate your partner will have granted to you. Module account_sepa is necessary."].join('\n')
  });
  static outboundPaymentMethodLineIds = Fields.One2many('account.payment.method.line', 'journalId', { domain: [['paymentType', '=', 'outbound']], compute: '_computeOutboundPaymentMethodLineIds', store: true, readonly: false, string: 'Outbound Payment Methods', copy: false, checkCompany: true, help: ["Manual: Pay by any method outside of Verp.",
      "Check: Pay bills by check and print it from Verp.",
      "SEPA Credit Transfer: Pay in the SEPA zone by submitting a SEPA Credit Transfer file to your bank. Module account_sepa is necessary."].join('\n')
  });
  static profitAccountId = Fields.Many2one({ comodelName: 'account.account', checkCompany: true, help: "Used to register a profit when the ending balance of a cash register differs from what the system computes", string: 'Profit Account', domain: async (self) => f("[['deprecated', '=', false], ['companyId', '=', companyId], ['userTypeId.type', 'not in', ['receivable', 'payable']], ['userTypeId', 'in', %s]]", [(await self.env.ref('account.dataAccountTypeRevenue')).id, (await self.env.ref('account.dataAccountTypeOtherIncome')).id]) });
  static lossAccountId = Fields.Many2one({ comodelName: 'account.account', checkCompany: true, help: "Used to register a loss when the ending balance of a cash register differs from what the system computes", string: 'Loss Account', domain: async (self) => f("[['deprecated', '=', false], ['companyId', '=', companyId], ['userTypeId.type', 'not in', ['receivable', 'payable']], ['userTypeId', '=', %s]]", (await self.env.ref('account.dataAccountTypeExpenses')).id) });

  // Bank journals fields
  static companyPartnerId = Fields.Many2one('res.partner', { related: 'companyId.partnerId', string: 'Account Holder', readonly: true, store: false });
  static bankAccountId = Fields.Many2one('res.partner.bank', { string: "Bank Account", ondelete: 'RESTRICT', copy: false, checkCompany: true, domain: "[['partnerId','=', companyPartnerId], '|', ['companyId', '=', false], ['companyId', '=', companyId]]" });
  static bankStatementsSource = Fields.Selection('_getBankStatementsAvailableSources', { string: 'Bank Feeds', default: 'undefined', help: "Defines how the bank statements will be registered" });
  static bankAccNumber = Fields.Char({ related: 'bankAccountId.accNumber', readonly: false });
  static bankId = Fields.Many2one('res.bank', { related: 'bankAccountId.bankId', readonly: false });

  // Sale journals fields
  static saleActivityTypeId = Fields.Many2one('mail.activity.type', { string: 'Schedule Activity', default: false, help: "Activity will be automatically scheduled on payment due date, improving collection process." });
  static saleActivityUserId = Fields.Many2one('res.users', { string: "Activity User", help: "Leave empty to assign the Salesperson of the invoice." });
  static saleActivityNote = Fields.Text('Activity Summary');

  // alias configuration for journals
  static aliasId = Fields.Many2one('mail.alias', {
    string: 'Email Alias', help: ["Send one separate email for each invoice.",
      "Any file extension will be accepted.",
      "Only PDF and XML files will be interpreted by Verp"].join('\n\n'), copy: false
  });
  static aliasDomain = Fields.Char('Alias domain', { compute: '_computeAliasDomain' });
  static aliasName = Fields.Char('Alias Name', { copy: false, related: 'aliasId.aliasName', help: "It creates draft invoices and bills by sending an email.", readonly: false });

  static journalGroupIds = Fields.Many2many('account.journal.group', { domain: "[['companyId', '=', companyId]]", checkCompany: true, string: "Journal Groups" });

  static secureSequenceId = Fields.Many2one('ir.sequence', { help: 'Sequence to use to ensure the securisation of data', checkCompany: true, readonly: true, copy: false });

  static availablePaymentMethodIds = Fields.Many2many({ comodelName: 'account.payment.method', compute: '_computeAvailablePaymentMethodIds' });

  static selectedPaymentMethodCodes = Fields.Char({ compute: '_computeSelectedPaymentMethodCodes', help: 'Technical field used to hide or show payment method options if needed.' });

  static _sqlConstraints = [
    ['code_company_uniq', 'unique (code, "companyId")', 'Journal codes must be unique per company.'],
  ];

  /**
   * Compute the available payment methods id by respecting the following rules:
          Methods of mode 'unique' cannot be used twice on the same company
          Methods of mode 'multi' cannot be used twice on the same journal
   */
  @api.depends('outboundPaymentMethodLineIds', 'inboundPaymentMethodLineIds')
  async _computeAvailablePaymentMethodIds() {
    const methodInformation = this.env.items('account.payment.method')._getPaymentMethodInformation();
    const payMethods = await this.env.items('account.payment.method').search([['code', 'in', Object.keys(methodInformation)]]);
    const payMethodByCode = {};
    for (const method of payMethods) {
      const [code, paymentType] = await method('code', 'paymentType');
      payMethodByCode[code + paymentType] = method;
    }
    const uniquePayMethods = Object.keys(Object.entries(methodInformation).filter(([, v]) => v['mode'] === 'unique'));

    const payMethodsByCompany = {};
    const payMethodsByJournal = {};
    if (uniquePayMethods.length) {
      const rows = await this._cr.execute(`
          SELECT
              journal.id AS jid,
              journal."companyId" AS cid,
              ARRAY_AGG(DISTINCT apm.id) AS pids
          FROM "accountPaymentMethodLine" apml
          JOIN "accountJournal" journal ON journal.id = apml."journalId"
          JOIN "accountPaymentMethod" apm ON apm.id = apml."paymentMethodId"
          WHERE apm.code IN (%s)
          GROUP BY
              journal.id,
              journal."companyId"
      `, [quoteList(uniquePayMethods)]);
      for (const { jid, cid, pids } of rows) {
        payMethodsByCompany[cid] = new Set(pids);
        payMethodsByJournal[jid] = new Set(pids);
      }
    }

    const payMethodIdsCommandsXJournal = {};
    for (const journal of this) {
      payMethodIdsCommandsXJournal[journal.id] = [journal, [Command.clear()]];
    }
    for (const paymentType of ['inbound', 'outbound']) {
      for (const [code, vals] of Object.entries(methodInformation)) {
        const paymentMethod = payMethodByCode[code + paymentType];

        if (!bool(paymentMethod)) {
          continue;
        }

        // Get the domain of the journals on which the current method is usable.
        const methodDomain = await paymentMethod._getPaymentMethodDomain();

        for (const journal of await this.filteredDomain(methodDomain)) {
          const protectedPayMethodIds = _.difference(Array.from(payMethodsByCompany[(await journal.companyId)._origin.id] ?? []), Array.from(payMethodsByJournal[journal._origin.id] ?? []));

          let lines;
          if (paymentType === 'inbound') {
            lines = await journal.inboundPaymentMethodLineIds;
          }
          else {
            lines = await journal.outboundPaymentMethodLineIds;
          }

          const alreadyUsed = (await lines.paymentMethodId).includes(paymentMethod);
          const isProtected = protectedPayMethodIds.includes(paymentMethod.id);
          if (vals['mode'] === 'unique' && (alreadyUsed || isProtected)) {
            continue;
          }

          // Only the manual payment method can be used multiple time on a single journal.
          if (await paymentMethod.code !== "manual" && alreadyUsed) {
            continue;
          }

          payMethodIdsCommandsXJournal[journal.id][1].push(Command.link(paymentMethod.id));
        }
      }
      for (const [journal, payMethodIdsCommands] of Object.values<any>(payMethodIdsCommandsXJournal)) {
        await journal.set('availablePaymentMethodIds', payMethodIdsCommands);
      }
    }
  }

  @api.depends('type')
  async _computeDefaultAccountType() {
    const defaultAccountIdTypes = {
      'bank': 'account.dataAccountTypeLiquidity',
      'cash': 'account.dataAccountTypeLiquidity',
      'sale': 'account.dataAccountTypeRevenue',
      'purchase': 'account.dataAccountTypeExpenses'
    }

    for (const journal of this) {
      const type = await journal.type;
      if (type in defaultAccountIdTypes) {
        await journal.set('defaultAccountType', (await this.env.ref(defaultAccountIdTypes[type])).id);
      }
      else {
        await journal.set('defaultAccountType', false);
      }
    }
  }

  @api.depends('type')
  async _computeInboundPaymentMethodLineIds() {
    for (const journal of this) {
      let payMethodLineIdsCommands = [Command.clear()];
      if (['bank', 'cash'].includes(await journal.type)) {
        const defaultMethods = await journal._defaultInboundPaymentMethods();
        payMethodLineIdsCommands = payMethodLineIdsCommands.concat(await defaultMethods.map(async (payMethod) =>
          Command.create({
            'label': await payMethod.label,
            'paymentMethodId': payMethod.id,
          })
        ));
      }
      await journal.set('inboundPaymentMethodLineIds', payMethodLineIdsCommands);
    }
  }

  @api.depends('type')
  async _computeOutboundPaymentMethodLineIds() {
    for (const journal of this) {
      let payMethodLineIdsCommands = [Command.clear()];
      if (['bank', 'cash'].includes(journal.type)) {
        const defaultMethods = await journal._defaultOutboundPaymentMethods();
        payMethodLineIdsCommands = payMethodLineIdsCommands.concat(await defaultMethods.map(async (payMethod) =>
          Command.create({
            'label': await payMethod.label,
            'paymentMethodId': payMethod.id,
          })
        ));
      }
      await journal.set('outboundPaymentMethodLineIds', payMethodLineIdsCommands);
    }
  }

  /**
   * Set the selected payment method as a list of comma separated codes like: ,manual,check_printing,...
      These will be then used to display or not payment method specific fields in the view.
   */
  @api.depends('outboundPaymentMethodLineIds', 'inboundPaymentMethodLineIds')
  async _computeSelectedPaymentMethodCodes() {
    for (const journal of this) {
      const [inboundPaymentMethodLineIds, outboundPaymentMethodLineIds] = await journal('inboundPaymentMethodLineIds', 'outboundPaymentMethodLineIds');
      const codes = [];
      for (const line of [...inboundPaymentMethodLineIds, ...outboundPaymentMethodLineIds]) {
        codes.push(await line.code);
      }
      await journal.set('selectedPaymentMethodCodes', ',' + codes.join(',') + ',');
    }
  }

  @api.depends('companyId', 'type')
  async _computeSuspenseAccountId() {
    for (const journal of this) {
      const [type, suspenseAccountId, companyId] = await journal('type', 'suspenseAccountId', 'companyId');
      const accountJournalSuspenseAccountId = await companyId.accountJournalSuspenseAccountId;
      let _suspenseAccountId;
      if (!['bank', 'cash'].includes(type)) {
        _suspenseAccountId = false;
      }
      else if (suspenseAccountId) {
        _suspenseAccountId = suspenseAccountId;
      }
      else if (bool(accountJournalSuspenseAccountId)) {
        _suspenseAccountId = accountJournalSuspenseAccountId;
      }
      else {
        _suspenseAccountId = false;
      }
      await journal.set('suspenseAccountId', _suspenseAccountId);
    }
  }

  @api.depends('label')
  async _computeAliasDomain() {
    await this.set('aliasDomain', await (await this.env.items("ir.config.parameter").sudo()).getParam("mail.catchall.domain"));
  }

  @api.constrains('typeControlIds')
  async _constrainsTypeControlIds() {
    await this.env.items('account.move.line').flush(['accountId', 'journalId']);
    await this.flush(['typeControlIds']);
    const res = await this._cr.execute(`
              SELECT aml.id
              FROM "accountMoveLine" aml
              WHERE aml."journalId" IN (%s)
              AND EXISTS (SELECT 1 FROM "journalAccountTypeControlRel" rel WHERE rel."journalId" = aml."journalId")
              AND NOT EXISTS (SELECT 1 FROM "accountAccount" acc
                              JOIN "journalAccountTypeControlRel" rel ON acc."userTypeId" = rel."typeId"
                              WHERE acc.id = aml."accountId" AND rel."journalId" = aml."journalId")
          `, [String(this.ids) || 'NULL']);
    if (res.length) {
      throw new ValidationError(await this._t('Some journal items already exist in this journal but with accounts from different types than the allowed ones.'));
    }
  }

  @api.constrains('accountControlIds')
  async _constrainsAccountControlIds() {
    await this.env.items('account.move.line').flush(['accountId', 'journalId']);
    await this.flush(['accountControlIds']);
    const res = await this._cr.execute(`
              SELECT aml.id
              FROM "accountMoveLine" aml
              WHERE aml."journalId" IN (%s)
              AND EXISTS (SELECT 1 FROM "journalAccountControlRel" rel WHERE rel."journalId" = aml."journalId")
              AND NOT EXISTS (SELECT 1 FROM "journalAccountControlRel" rel WHERE rel."accountId" = aml."accountId" AND rel."journalId" = aml."journalId")
          `, [String(this.ids) || 'NULL']);
    if (res.length) {
      throw new ValidationError(await this._t('Some journal items already exist in this journal but with other accounts than the allowed ones.'));
    }
  }

  @api.constrains('type', 'bankAccountId')
  async _checkBankAccount() {
    for (const journal of this) {
      const [type, companyId, bankAccountId] = await journal('type', 'companyId', 'bankAccountId');
      if (type === 'bank' && bankAccountId.ok) {
        const [bankCompanyId, bankPartnerId] = await bankAccountId('companyId', 'partnerId');
        if (bankCompanyId.ok && !bankCompanyId.eq(companyId)) {
          throw new ValidationError(await this._t('The bank account of a bank journal must belong to the same company (%s).', await companyId.label));
        }
        // A bank account can belong to a customer/supplier, in which case their partnerId is the customer/supplier.
        // Or they are part of a bank journal and their partnerId must be the company's partnerId.
        if (!bankPartnerId.eq(await companyId.partnerId)) {
          throw new ValidationError(await this._t('The holder of a journal\'s bank account must be the company (%s).', await companyId.label));
        }
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
              SELECT move.id
              FROM "accountMove" move
              JOIN "accountJournal" journal ON journal.id = move."journalId"
              WHERE move."journalId" IN (%s)
              AND move."companyId" != journal."companyId"
          `, [String(this.ids) || 'NULL']);
    if (res.length) {
      throw new UserError(await this._t("You can't change the company of your journal since there are some journal entries linked to it."));
    }
  }

  @api.constrains('type', 'defaultAccountId')
  async _checkTypeDefaultAccountIdType() {
    for (const journal of this) {
      const [type, defaultAccountId] = await journal('type', 'defaultAccountId');
      if (['sale', 'purchase'].includes(type) && ['receivable', 'payable'].includes(await (await defaultAccountId.userTypeId).type)) {
        throw new ValidationError(await this._t("The type of the journal's default credit/debit account shouldn't be 'receivable' or 'payable'."));
      }
    }
  }

  /**
   * Check and ensure that the payment method lines multiplicity is respected.
   * @returns 
   */
  @api.constrains('inboundPaymentMethodLineIds', 'outboundPaymentMethodLineIds')
  async _checkPaymentMethodLineIdsMultiplicity() {
    const methodInfo = this.env.items('account.payment.method')._getPaymentMethodInformation();
    const uniqueCodes = Object.keys(Object.entries(methodInfo).filter(([, info]) => info['mode'] === 'unique'));

    if (!uniqueCodes.length) {
      return;
    }

    // await Promise.all([
      await this.flush(['inboundPaymentMethodLineIds', 'outboundPaymentMethodLineIds', 'companyId']),
      await this.env.items('account.payment.method.line').flush(['paymentMethodId', 'journalId']),
      await this.env.items('account.payment.method').flush(['code'])
    // ]);

    let methodIds;
    if (uniqueCodes.length) {
      const rows = await this._cr.execute(`
          SELECT apm.id
          FROM "accountPaymentMethod" apm
          JOIN "accountPaymentMethodLine" apml on apm.id = apml."paymentMethodId"
          JOIN "accountJournal" journal on journal.id = apml."journalId"
          JOIN "resCompany" company on journal."companyId" = company.id
          WHERE apm.code IN (%s)
          GROUP BY 
              company.id, 
              apm.id
          HAVING array_length(array_agg(journal.id), 1) > 1;
      `, [quoteList(uniqueCodes)]);
      methodIds = rows.map(r => r['id']);
    }
    if (bool(methodIds)) {
      const methods = await this.env.items('account.payment.method').browse(methodIds);
      throw new ValidationError(await this._t("Some payment methods supposed to be unique already exists somewhere else.\n(%s)", (await methods.map(method => method.displayName)).join(', ')));
    }
  }

  @api.constrains('active')
  async _checkAutoPostDraftEntries() {
    // constraint should be tested just after archiving a journal, but shouldn't be raised when unarchiving a journal containing draft entries
    for (const journal of await this.filtered(async (j) => ! await j.active)) {
      const pendingMoves = await this.env.items('account.move').search([
        ['journalId', '=', journal.id],
        ['state', '=', 'draft']
      ], { limit: 1 });

      if (bool(pendingMoves)) {
        throw new ValidationError(await this._t(`You can not archive a journal containing draft journal entries.
                                          To proceed:
                                          1/ click on the top-right button 'Journal Entries' from this journal form
                                          2/ then filter on 'Draft' entries
                                          3/ select them all and post or delete them through the action menu`));
      }
    }
  }

  @api.onchange('type')
  async _onchangeType() {
    await this.set('refundSequence', ['sale', 'purchase'].includes(await this['type']));
  }

  async _getAliasValues(type, aliasName?: any) {
    const companyId = await this['companyId'];
    if (!aliasName) {
      aliasName = await this['label'];
      if (!companyId.eq(await this.env.ref('base.mainCompany'))) {
        aliasName += '-' + String(await companyId.label);
      }
    }
    try {
      Buffer.from(removeAccents(aliasName)).toString('ascii');
    } catch (e) {
      // except UnicodeEncodeError:
      let safeAliasName;
      try {
        const code = await this['code'];
        Buffer.from(removeAccents(code)).toString('ascii');
        safeAliasName = code;
      } catch (e) {
        // except UnicodeEncodeError:
        safeAliasName = await this['type'];
      }
      console.warn("Cannot use '%s' as email alias, fallback to '%s'", aliasName, safeAliasName);
      aliasName = safeAliasName;
    }
    return {
      'aliasDefaults': { 'moveType': type === 'purchase' ? 'inInvoice' : 'outInvoice', 'companyId': companyId.id, 'journalId': this.id },
      'aliasParentThreadId': this.id,
      'aliasName': aliasName,
    }
  }

  async unlink() {
    let bankAccounts = this.env.items('res.partner.bank').browse();
    for (const bankAccount of await this.mapped('bankAccountId')) {
      const accounts = await this.search([['bankAccountId', '=', bankAccount.id]]);
      if (accounts.le(this)) {
        bankAccounts = bankAccounts.add(bankAccount);
      }
    }
    await (await (await this.mapped('aliasId')).sudo()).unlink();
    const ret = await _super(AccountJournal, this).unlink();
    await bankAccounts.unlink();
    return ret;
  }

  @api.returns('self', (value) => value.id)
  async copy(defaultValue?: any) {
    defaultValue = defaultValue ?? {};

    const [companyId, code, label] = await this('companyId', 'code', 'label');
    // Find a unique code for the copied journal
    const readCodes = await (await this.env.items('account.journal').withContext({ activeTest: false })).searchRead([['companyId', '=', companyId.id]], ['code']);
    const allJournalCodes = readCodes.map(codeData => codeData['code']);

    let copyCode = code;
    let codePrefix = code.replace(/\d+/, '').trim();
    let counter = 1;
    while (counter <= allJournalCodes.length && allJournalCodes.includes(copyCode)) {
      const counterStr = String(counter);
      const copyPrefix = codePrefix.slice(0, this._fields['code'].length - counterStr.length);
      copyCode = f("%s%s", copyPrefix, counterStr);

      counter += 1;
    }
    if (counter > allJournalCodes.length) {
      // Should never happen, but put there just in case.
      throw new UserError(await this._t("Could not compute any code for the copy automatically. Please create it manually."));
    }
    update(defaultValue, {
      code: copyCode,
      label: await this._t("%s (copy)", label || '')
    });

    return _super(AccountJournal, this).copy(defaultValue);
  }

  async _updateMailAlias(vals) {
    this.ensureOne();
    const aliasValues = await this._getAliasValues(vals['type'] ?? await this['type'], vals['aliasName']);
    const aliasId = await this['aliasId'];
    if (aliasId.ok) {
      await (await aliasId.sudo()).write(aliasValues);
    }
    else {
      aliasValues['aliasModelId'] = (await this.env.items('ir.model')._get('account.move')).id;
      aliasValues['aliasParentModelId'] = (await this.env.items('ir.model')._get('account.journal')).id;
      await this.set('aliasId', await (await this.env.items('mail.alias').sudo()).create(aliasValues));
    }

    if (vals['aliasName']) {
      // remove alias_name to avoid useless write on alias
      delete (vals['aliasName']);
    }
  }

  async write(vals) {
    for (const journal of this) {
      const [jcompany, jbankAccount] = await journal('companyId', 'bankAccountId');
      let company = jcompany;
      if ('companyId' in vals && jcompany.id != vals['companyId']) {
        if ((await this.env.items('account.move').search([['journalId', '=', journal.id]], { limit: 1 })).ok) {
          throw new UserError(await this._t('This journal already contains items, therefore you cannot modify its company.'))
        }
        company = this.env.items('res.company').browse(vals['companyId']);
        const jbankAccountCompanyId = await jbankAccount.companyId;
        if (jbankAccountCompanyId.ok && !jbankAccountCompanyId.eq(company)) {
          await jbankAccount.write({
            'companyId': company.id,
            'partnerId': (await company.partnerId).id,
          })
        }
      }
      if ('currencyId' in vals) {
        if (jbankAccount.ok) {
          await jbankAccount.set('currencyId', vals['currencyId']);
        }
      }
      if ('bankAccountId' in vals) {
        if (!vals['bankAccountId']) {
          throw new UserError(await this._t('You cannot remove the bank account from the journal once set.'));
        }
        else {
          const bankAccount = this.env.items('res.partner.bank').browse(vals['bankAccountId']);
          if (!(await bankAccount.partnerId).eq(await company.partnerId)) {
            throw new UserError(await this._t("The partners of the journal's company and the related bank account mismatch."));
          }
        }
      }
      if ('aliasName' in vals) {
        await journal._updateMailAlias(vals);
      }
      if ('restrictModeHashTable' in vals && !vals['restrictModeHashTable']) {
        const journalEntry = await this.env.items('account.move').search([['journalId', '=', this.id], ['state', '=', 'posted'], ['secureSequenceNumber', '!=', 0]], { limit: 1 });
        if (len(journalEntry) > 0) {
          const fieldString = (await this._fields['restrictModeHashTable'].getDescription(this.env))['string'];
          throw new UserError(await this._t("You cannot modify the field %s of a journal that already has accounting entries.", fieldString));
        }
      }
    }
    const result = await _super(AccountJournal, this).write(vals);

    // Ensure the liquidity accounts are sharing the same foreign currency.
    if ('currencyId' in vals) {
      for (const journal of await this.filtered(async (journal) => ['bank', 'cash'].includes(journal.type))) {
        await (await journal.defaultAccountId).set('currencyId', await journal.currencyId);
      }
    }

    // Create the bank_account_id if necessary
    if ('bankAccNumber' in vals) {
      for (const journal of await this.filtered(async (r) => await r.type === 'bank' && !bool(await r.bankAccountId))) {
        await journal.setBankAccount(vals['bankAccNumber'], vals['bankId']);
      }
    }
    for (const record of this) {
      if (await record.restrictModeHashTable && !bool(await record.secureSequenceId)) {
        await record._createSecureSequence(['secureSequenceId']);
      }
    }

    return result;
  }

  @api.model()
  async getNextBankCashDefaultCode(journalType, company) {
    const journalCodeBase = journalType === 'cash' ? 'CSH' : 'BNK';
    const journals = await this.env.items('account.journal').search([['code', 'like', journalCodeBase + '%'], ['companyId', '=', company.id]]);
    for (const num of range(1, 100)) {
      // journal_code has a maximal size of 5, hence we can enforce the boundary num < 100
      const journalCode = journalCodeBase + String(num);
      if (!(await journals.mapped('code')).includes(journalCode)) {
        return journalCode;
      }
    }
  }

  @api.model()
  async _prepareLiquidityAccountVals(company, code, vals) {
    return {
      'label': vals['label'],
      'code': code,
      'userTypeId': (await this.env.ref('account.dataAccountTypeLiquidity')).id,
      'currencyId': vals['currencyId'],
      'companyId': company.id,
    }
  }

  @api.model()
  async _fillMissingValues(vals) {
    const journalType = vals['type'];

    // 'type' field is required.
    if (!journalType) {
      return;
    }

    // === Fill missing company ===
    const company = vals['companyId'] ? this.env.items('res.company').browse(vals['companyId']) : await this.env.company();
    vals['companyId'] = company.id;

    // Don't get the digits on 'chart_template_id' since the chart template could be a custom one.
    const randomAccount = await this.env.items('account.account').search([['companyId', '=', company.id]], { limit: 1 });
    const digits = randomAccount ? len(await randomAccount.code) : 6;

    const liquidityType = await this.env.ref('account.dataAccountTypeLiquidity');
    const currentAssetsType = await this.env.ref('account.dataAccountTypeCurrentAssets');

    if (['bank', 'cash'].includes(journalType)) {
      const hasLiquidityAccounts = vals['defaultAccountId'];
      const hasProfitAccount = vals['profitAccountId'];
      const hasLossAccount = vals['lossAccountId'];
      let liquidityAccountPrefix;
      if (journalType === 'bank') {
        liquidityAccountPrefix = await company.bankAccountCodePrefix || '';
      }
      else {
        liquidityAccountPrefix = await company.cashAccountCodePrefix || await company.bankAccountCodePrefix || '';
      }

      // === Fill missing name ===
      vals['label'] = vals['label'] ?? vals['bankAccNumber'];

      // === Fill missing code ===
      if (!('code' in vals)) {
        vals['code'] = await this.getNextBankCashDefaultCode(journalType, company);
        if (!vals['code']) {
          throw new UserError(await this._t("Cannot generate an unused journal code. Please fill the 'Shortcode' field."));
        }
      }
      // === Fill missing accounts ===
      if (!hasLiquidityAccounts) {
        const defaultAccountCode = await this.env.items('account.account')._searchNewAccountCode(company, digits, liquidityAccountPrefix);
        const defaultAccountVals = await this._prepareLiquidityAccountVals(company, defaultAccountCode, vals);
        vals['defaultAccountId'] = (await this.env.items('account.account').create(defaultAccountVals)).id
      }
      if (['cash', 'bank'].includes(journalType) && !hasProfitAccount) {
        vals['profitAccountId'] = (await company.defaultCashDifferenceIncomeAccountId).id;
      }
      if (['cash', 'bank'].includes(journalType) && !hasLossAccount) {
        vals['lossAccountId'] = (await company.defaultCashDifferenceExpenseAccountId).id;
      }
    }
    // === Fill missing refund_sequence ===
    if (!('refundSequence' in vals)) {
      vals['refundSequence'] = ['sale', 'purchase'].includes(vals['type']);
    }
  }

  @api.model()
  async create(vals) {
    // OVERRIDE
    await this._fillMissingValues(vals);

    const journal = await _super(AccountJournal, await this.withContext({ mailCreateNolog: true })).create(vals);

    if ('aliasName' in vals) {
      await journal._updateMailAlias(vals);
    }

    // Create the bank_account_id if necessary
    if (await journal.type === 'bank' && !(await journal.bankAccountId).ok && vals['bankAccNumber']) {
      await journal.setBankAccount(vals['bankAccNumber'], vals['bankId']);
    }

    return journal;
  }

  /**
   * Create a res.partner.bank (if not exists) and set it as value of the field bankAccountId
   * @param accNumber 
   * @param bankId 
   */
  async setBankAccount(accNumber, bankId?: any) {
    this.ensureOne();
    const companyId = await this['companyId'];
    const resPartnerBank = await this.env.items('res.partner.bank').search([['sanitizedAccNumber', '=', sanitizeAccountNumber(accNumber)], ['companyId', '=', companyId.id]], { limit: 1 });
    if (resPartnerBank.ok) {
      await this.set('bankAccountId', resPartnerBank.id);
    }
    else {
      await this.set('bankAccountId', (await this.env.items('res.partner.bank').create({
        'accNumber': accNumber,
        'bankId': bankId,
        'companyId': companyId.id,
        'currencyId': (await this['currencyId']).id,
        'partnerId': (await companyId.partnerId).id,
      })).id);
    }
  }

  async nameGet() {
    let res = [];
    for (const journal of this) {
      let [label, currencyId, companyId] = await journal('label', 'currencyId', 'companyId');
      if (currencyId.ok && !currencyId.eq(await companyId.currencyId)) {
        label = f("%s (%s)", label, await currencyId.label);
      }
      res = res.concat([[journal.id, label]]);
    }
    return res;
  }

  @api.model()
  async _nameSearch(name, args?: any[], operator = 'ilike', { limit=100, nameGetUid=false } = {}) {
    args = args ?? [];
    let domain;
    if (operator === 'ilike' && !(name || '').trim()) {
      domain = [];
    }
    else {
      const connector = expression.NEGATIVE_TERM_OPERATORS.includes(operator) ? '&' : '|';
      domain = [connector, ['code', operator, name], ['label', operator, name]];
    }
    return this._search(expression.AND([domain, args]), { limit, accessRightsUid: nameGetUid });
  }

  /**
   * This function is called by the "configure" button of bank journals,
      visible on dashboard if no bank statement source has been defined yet
   * @returns 
   */
  async actionConfigureBankJournal() {
    // We simply call the setup bar function.
    return this.env.items('res.company').settingInitBankAccountAction();
  }

  /**
   * Create the invoices from files.
       :return: A action redirecting to account.move tree/form view.
   * @param attachmentIds 
   * @returns 
   */
  async createInvoiceFromAttachment(attachmentIds = []) {
    const attachments = this.env.items('ir.attachment').browse(attachmentIds);
    if (!attachments.ok) {
      throw new UserError(await this._t("No attachment was provided"));
    }

    let invoices = this.env.items('account.move');
    for (const attachment of attachments) {
      await attachment.write({ 'resModel': 'mail.compose.message' });
      const decoders: any[] = this.env.items('account.move')._getCreateInvoiceFromAttachmentDecoders();
      let invoice;
      for (const decoder of decoders.sort((a, b) => a[0] - b[0])) {
        invoice = await decoder[1](attachment);
        if (bool(invoice)) {
          break;
        }
      }
      if (!bool(invoice)) {
        invoice = await this.env.items('account.move').create({});
      }
      await (await invoice.withContext({ noNewInvoice: true })).messagePost([attachment.id]);
      invoices = invoices.add(invoice);
    }
    const actionVals = {
      'label': await this._t('Generated Documents'),
      'domain': [['id', 'in', invoices.ids]],
      'resModel': 'account.move',
      'type': 'ir.actions.actwindow',
      'context': this._context
    }
    if (len(invoices) == 1) {
      update(actionVals, {
        'views': [[false, "form"]],
        'viewMode': 'form',
        'resId': invoices(0).id,
      });
    }
    else {
      update(actionVals, {
        'views': [[false, "tree"], [false, "kanban"], [false, "form"]],
        'viewMode': 'tree, kanban, form',
      });
    }
    return actionVals;
  }

  /**
   * This function creates a no_gap sequence on each journal in self that will ensure
      a unique number is given to all posted account.move in such a way that we can always
      find the previous move of a journal entry on a specific journal.
   * @param sequenceFields 
   * @returns 
   */
  async _createSecureSequence(sequenceFields) {
    for (const journal of this) {
      const valsWrite = {};
      for (const seqField of sequenceFields) {
        if (!journal.cls[seqField]) {
          const vals = {
            'label': await this._t('Securisation of %s - %s', seqField, await journal.label),
            'code': f('SECUR%s-%s', journal.id, seqField),
            'implementation': 'noGap',
            'prefix': '',
            'suffix': '',
            'padding': 0,
            'companyId': (await journal.companyId).id
          }
          const seq = await this.env.items('ir.sequence').create(vals);
          valsWrite[seqField] = seq.id;
        }
      }
      if (bool(valsWrite)) {
        await journal.write(valsWrite);
      }
    }
  }

  // -------------------------------------------------------------------------
  // REPORTING METHODS
  // -------------------------------------------------------------------------

  /**
   * Get the bank balance of the current journal by filtering the journal items using the journal's accounts.
 
      /!\ The current journal is not part of the applied domain. This is the expected behavior since we only want
      a logic based on accounts.
 
      :param domain:  An additional domain to be applied on the account.move.line model.
      :return:        Tuple having balance expressed in journal's currency
                      along with the total number of move lines having the same account as of the journal's default account.
   */
  async _getJournalBankAccountBalance(domain?: any[]) {
    this.ensureOne();
    await this.env.items('account.move.line').checkAccessRights('read');
    const [defaultAccountId, companyId, currencyId] = await this('defaultAccountId', 'companyId', 'currencyId');
    if (!defaultAccountId.ok) {
      return [0.0, 0];
    }

    domain = (domain ?? []).concat([
      ['accountId', 'in', Array.from(defaultAccountId.ids)],
      ['displayType', 'not in', ['lineSection', 'lineNote']],
      ['moveId.state', '!=', 'cancel'],
    ]);
    let query: Query = await this.env.items('account.move.line')._whereCalc(domain);
    const [tables, whereClause, whereParams] = query.getSql();

    const sql = `
                  SELECT
                      COUNT("accountMoveLine".id)::int AS "nbLines",
                      COALESCE(SUM("accountMoveLine".balance), 0.0) AS balance,
                      COALESCE(SUM("accountMoveLine"."amountCurrency"), 0.0) AS amountCurrency
                  FROM ` + tables + `
                  WHERE ` + whereClause + `
              `

    const companyCurrency = await companyId.currencyId;
    const journalCurrency = currencyId.ok && !currencyId.eq(companyCurrency) ? currencyId : false;

    const res = await this._cr.execute(_convert$(sql), {bind: whereParams});
    const { nbLines, balance, amountCurrency } = res[0];
    return [bool(journalCurrency) ? amountCurrency : balance, nbLines];
  }

  /**
   * :return: A recordset with all the account.account used by this journal for inbound transactions.
   * @returns 
   */
  async _getJournalInboundOutstandingPaymentAccounts() {
    this.ensureOne();
    const accountIds = new Set<number>();
    for (const line of await this['inboundPaymentMethodLineIds']) {
      const id = (await line.paymentAccountId).id;
      accountIds.add(bool(id) ? id : (await (await this['companyId']).accountJournalPaymentDebitAccountId).id);
    }
    return this.env.items('account.account').browse(accountIds);
  }

  /**
   * :return: A recordset with all the account.account used by this journal for outbound transactions.
   * @returns 
   */
  async _getJournalOutboundOutstandingPaymentAccounts() {
    this.ensureOne();
    const accountIds = new Set<number>();
    for (const line of await this['outboundPaymentMethodLineIds']) {
      const id = (await line.paymentAccountId).id;
      accountIds.add(bool(id) ? id : (await (await this['companyId']).accountJournalPaymentCreditAccountId).id);
    }
    return this.env.items('account.account').browse(accountIds);
  }

  /**
   * Get the outstanding payments balance of the current journal by filtering the journal items using the
      journal's accounts.
 
      :param domain:  An additional domain to be applied on the account.move.line model.
      :param date:    The date to be used when performing the currency conversions.
      :return:        The balance expressed in the journal's currency.
   * @param domain 
   * @param date 
   * @returns 
   */
  async _getJournalOutstandingPaymentsAccountBalance(domain?: any[], date?: Date) {
    this.ensureOne();
    await this.env.items('account.move.line').checkAccessRights('read');
    const conversionDate: Date = date ?? await _Date.contextToday(this);

    const accounts = (await this._getJournalInboundOutstandingPaymentAccounts()).union(await this._getJournalOutboundOutstandingPaymentAccounts());
    if (!accounts.ok) {
      return [0.0, 0];
    }
    const [defaultAccountId, companyId, currencyId] = await this('defaultAccountId', 'companyId', 'currencyId');
    // Allow user managing payments without any statement lines.
    // In that case, the user manages transactions only using the register payment wizard.
    if (accounts.includes(defaultAccountId)) {
      return [0.0, 0];
    }

    domain = (domain ?? []).concat([
      ['accountId', 'in', Array.from(accounts.ids)],
      ['displayType', 'not in', ['lineSection', 'lineNote']],
      ['moveId.state', '!=', 'cancel'],
      ['reconciled', '=', false],
      ['journalId', '=', this.id],
    ]);
    const query: Query = await this.env.items('account.move.line')._whereCalc(domain);
    const [tables, whereClause, whereParams] = query.getSql();

    const rows = await this._cr.execute(_convert$(`
                  SELECT
                      COUNT("accountMoveLine".id)::int AS "nbLines",
                      "accountMoveLine"."currencyId",
                      account.reconcile AS "isAccountReconcile",
                      SUM("accountMoveLine"."amountResidual") AS "amountResidual",
                      SUM("accountMoveLine".balance) AS balance,
                      SUM("accountMoveLine"."amountResidualCurrency") AS "amountResidualCurrency",
                      SUM("accountMoveLine"."amountCurrency") AS "amountCurrency"
                  FROM ` + tables + `
                  JOIN "accountAccount" account ON account.id = "accountMoveLine"."accountId"
                  WHERE ` + whereClause + `
                  GROUP BY "accountMoveLine"."currencyId", account.reconcile
              `), {bind: whereParams});

    const companyCurrency = await companyId.currencyId;
    const journalCurrency = currencyId.ok && !currencyId.eq(companyCurrency) ? currencyId : false;
    const balanceCurrency = bool(journalCurrency) ? journalCurrency : companyCurrency;

    let totalBalance = 0.0;
    let nbLines = 0;
    for (const res of rows) {
      nbLines += res['nbLines'];

      const amountCurrency = res['isAccountReconcile'] ? res['amountResidualCurrency'] : res['amountCurrency'];
      const balance = res['isAccountReconcile'] ? res['amountResidual'] : res['balance'];

      if (res['currencyId'] && bool(journalCurrency) && res['currencyId'] === journalCurrency.id) {
        totalBalance += amountCurrency;
      }
      else if (bool(journalCurrency)) {
        totalBalance += await companyCurrency._convert(balance, balanceCurrency, companyId, conversionDate);
      }
      else {
        totalBalance += balance;
      }
    }
    return [totalBalance, nbLines];
  }

  /**
   * Retrieve the last bank statement created using this journal.
      :param domain:  An additional domain to be applied on the account.bank.statement model.
      :return:        An account.bank.statement record or an empty recordset.
   * @param domain 
   * @returns 
   */
  async _getLastBankStatement(domain?: any[]) {
    this.ensureOne();
    const lastStatementDomain = (domain ?? []).concat([['journalId', '=', this.id]]);
    const lastStLine = await this.env.items('account.bank.statement.line').search(lastStatementDomain, { order: 'date desc, id desc', limit: 1 });
    return lastStLine.statementId;
  }

  /**
   * This getter is here to allow filtering the payment method lines if needed in other modules.
      It does NOT serve as a general getter to get the lines.
 
      For example, it'll be extended to filter out lines from inactive payment acquirers in the payment module.
      :param payment_type: either inbound or outbound, used to know which lines to return
      :return: Either the inbound or outbound payment method lines
   * @param paymentType 
   * @returns 
   */
  async _getAvailablePaymentMethodLines(paymentType?: string) {
    if (!this.ok) {
      return this.env.items('account.payment.method.line');
    }
    this.ensureOne();
    if (paymentType === 'inbound') {
      return this['inboundPaymentMethodLineIds'];
    }
    else {
      return this['outboundPaymentMethodLineIds'];
    }
  }
}