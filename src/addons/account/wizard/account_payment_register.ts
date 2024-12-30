import _ from "lodash";
import xpath from "xpath";
import { Fields, _Date, api } from "../../../core";
import { DefaultDict2 } from "../../../core/helper/collections";
import { UserError } from "../../../core/helper/errors";
import { MetaModel, TransientModel, _super } from "../../../core/models";
import { bool } from "../../../core/tools/bool";
import { len, sum } from "../../../core/tools/iterable";
import { update } from "../../../core/tools/misc";
import { E, getrootXml, parseXml, serializeXml } from "../../../core/tools/xml";

@MetaModel.define()
class AccountPaymentRegister extends TransientModel {
  static _module = module;
  static _name = 'account.payment.register';
  static _description = 'Register Payment';

  // == Business fields ==
  static paymentDate = Fields.Date({
    string: "Payment Date", required: true,
    default: self => _Date.contextToday(self)
  });
  static amount = Fields.Monetary({
    currencyField: 'currencyId', store: true, readonly: false,
    compute: '_computeAmount'
  });
  static communication = Fields.Char({
    string: "Memo", store: true, readonly: false,
    compute: '_computeCommunication'
  });
  static groupPayment = Fields.Boolean({
    string: "Group Payments", store: true, readonly: false,
    compute: '_computeGroupPayment',
    help: "Only one payment will be created by partner (bank)/ currency."
  });
  static currencyId = Fields.Many2one('res.currency', {
    string: 'Currency', store: true, readonly: false,
    compute: '_computeCurrencyId',
    help: "The payment's currency."
  })
  static journalId = Fields.Many2one('account.journal', {
    store: true, readonly: false,
    compute: '_computeJournalId',
    domain: "[['companyId', '=', companyId], ['type', 'in', ['bank', 'cash']]]"
  });
  static availablePartnerBankIds = Fields.Many2many({
    comodelName: 'res.partner.bank',
    compute: '_computeAvailablePartnerBankIds',
  });
  static partnerBankId = Fields.Many2one({
    comodelName: 'res.partner.bank',
    string: "Recipient Bank Account",
    readonly: false,
    store: true,
    compute: '_computePartnerBankId',
    domain: "[['id', 'in', availablePartnerBankIds]]",
  });
  static companyCurrencyId = Fields.Many2one('res.currency', {
    string: "Company Currency",
    related: 'companyId.currencyId'
  });

  // == Fields given through the context ==
  static lineIds = Fields.Many2many('account.move.line', {
    relation: 'accountPaymentRegisterMoveLineRel', column1: 'wizardId', column2: 'lineId',
    string: "Journal items", readonly: true, copy: false
  });
  static paymentType = Fields.Selection([
    ['outbound', 'Send Money'],
    ['inbound', 'Receive Money'],
  ], {
    string: 'Payment Type', store: true, copy: false,
    compute: '_computeFromLines'
  });
  static partnerType = Fields.Selection([
    ['customer', 'Customer'],
    ['supplier', 'Vendor'],
  ], {
    store: true, copy: false,
    compute: '_computeFromLines'
  });
  static sourceAmount = Fields.Monetary({
    string: "Amount to Pay (company currency)", store: true, copy: false,
    currencyField: 'companyCurrencyId',
    compute: '_computeFromLines'
  });
  static sourceAmountCurrency = Fields.Monetary({
    string: "Amount to Pay (foreign currency)", store: true, copy: false,
    currencyField: 'sourceCurrencyId',
    compute: '_computeFromLines'
  });
  static sourceCurrencyId = Fields.Many2one('res.currency', {
    string: 'Source Currency', store: true, copy: false,
    compute: '_computeFromLines',
    help: "The payment's currency."
  });
  static canEditWizard = Fields.Boolean({
    store: true, copy: false,
    compute: '_computeFromLines',
    help: "Technical field used to indicate the user can edit the wizard content such as the amount."
  });
  static canGroupPayments = Fields.Boolean({
    store: true, copy: false,
    compute: '_computeFromLines',
    help: "Technical field used to indicate the user can see the 'group_payments' box."
  });
  static companyId = Fields.Many2one('res.company', {
    store: true, copy: false,
    compute: '_computeFromLines'
  });
  static partnerId = Fields.Many2one('res.partner', {
    string: "Customer/Vendor", store: true, copy: false, ondelete: 'RESTRICT',
    compute: '_computeFromLines'
  });

  // == Payment methods fields ==
  static paymentMethodLineId = Fields.Many2one('account.payment.method.line', {
    string: 'Payment Method',
    readonly: false, store: true,
    compute: '_computePaymentMethodLineId',
    domain: "[['id', 'in', availablePaymentMethodLineIds]]",
    help: ["Manual: Pay or Get paid by any method outside of Verp.",
      "Payment Acquirers: Each payment acquirer has its own Payment Method. Request a transaction on/to a card thanks to a payment token saved by the partner when buying or subscribing online.",
      "Check: Pay bills by check and print it from Verp.",
      "Batch Deposit: Collect several customer checks at once generating and submitting a batch deposit to your bank. Module account_batch_payment is necessary.",
      "SEPA Credit Transfer: Pay in the SEPA zone by submitting a SEPA Credit Transfer file to your bank. Module account_sepa is necessary.",
      "SEPA Direct Debit: Get paid in the SEPA zone thanks to a mandate your partner will have granted to you. Module account_sepa is necessary."].join('\n')
  });
  static availablePaymentMethodLineIds = Fields.Many2many('account.payment.method.line', { compute: '_computePaymentMethodLineFields' });
  static hidePaymentMethodLine = Fields.Boolean({
    compute: '_computePaymentMethodLineFields',
    help: "Technical field used to hide the payment method if the selected journal has only one available which is 'manual'"
  });

  // == Payment difference fields ==
  static paymentDifference = Fields.Monetary({
    compute: '_computePaymentDifference'
  })
  static paymentDifferenceHandling = Fields.Selection([
    ['open', 'Keep open'],
    ['reconcile', 'Mark as fully paid'],
  ], { default: 'open', string: "Payment Difference Handling" });
  static writeoffAccountId = Fields.Many2one('account.account', {
    string: "Difference Account", copy: false,
    domain: "[['deprecated', '=', false], ['companyId', '=', companyId]]"
  });
  static writeoffLabel = Fields.Char({
    string: 'Journal Item Label', default: 'Write-Off',
    help: 'Change label of the counterpart that will hold the payment difference'
  });

  // == Display purpose fields ==
  static showPartnerBankAccount = Fields.Boolean({
    compute: '_computeShowRequirePartnerBank',
    help: "Technical field used to know whether the field `partner_bank_id` needs to be displayed or not in the payments form views"
  });
  static requirePartnerBankAccount = Fields.Boolean({
    compute: '_computeShowRequirePartnerBank',
    help: "Technical field used to know whether the field `partner_bank_id` needs to be required or not in the payments form views"
  });
  static countryCode = Fields.Char({ related: 'companyId.accountFiscalCountryId.code', readonly: true });

  // HELPERS

  /**
   * Helper to compute the communication based on the batch.
          :param batch_result:    A batch returned by '_get_batches'.
          :return:                A string representing a communication to be set on payment.
   * @param batchResult 
   * @returns 
   */
  @api.model()
  async _getBatchCommunication(batchResult) {
    const labels = new Set(await batchResult['lines'].map(async (line) => await line.label || await (await line.moveId).ref || await (await line.moveId).label));
    return Array.from(labels).sort().join(' ');
  }

  /**
   * Helper to compute the journal based on the batch.
      
              :param batch_result:    A batch returned by '_get_batches'.
              :return:                An account.journal record.
   * @param batchResult 
   * @returns 
   */
  @api.model()
  async _getBatchJournal(batchResult) {
    const paymentValues = batchResult['paymentValues'];
    const foreignCurrencyId = paymentValues['currencyId'];
    const partnerBankId = paymentValues['partnerBankId'];

    const currencyDomain = [['currencyId', '=', foreignCurrencyId]];
    const partnerBankDomain = [['bankAccountId', '=', partnerBankId]];

    const defaultDomain = [
      ['type', 'in', ['bank', 'cash']],
      ['companyId', '=', (await batchResult['lines'].companyId).id],
    ];

    let extraDomains;
    if (bool(partnerBankId)) {
      extraDomains = [
        currencyDomain.concat(partnerBankDomain),
        partnerBankDomain,
        currencyDomain,
        [],
      ];
    }
    else {
      extraDomains = [
        currencyDomain,
        [],
      ];
    }

    for (const extraDomain of extraDomains) {
      const journal = await this.env.items('account.journal').search(defaultDomain.concat(extraDomain), { limit: 1 });
      if (journal.ok) {
        return journal;
      }
    }

    return this.env.items('account.journal');
  }

  @api.model()
  async _getBatchAvailablePartnerBanks(batchResult, journal) {
    const paymentValues = batchResult['paymentValues'];
    const company = await batchResult['lines'].companyId;

    // A specific bank account is set on the journal. The user must use this one.
    if (paymentValues['paymentType'] === 'inbound') {
      // Receiving money on a bank account linked to the journal.
      return journal.bankAccountId
    }
    else {
      // Sending money to a bank account owned by a partner.
      return (await (await batchResult['lines'].partnerId).bankIds).filtered(async (x) => [false, company.id].includes((await x.companyId).id))._origin;
    }
  }

  /**
   * Turn the line passed as parameter to a dictionary defining on which way the lines
will be grouped together.
:return: A dictionary.
   * @param line 
   * @returns 
   */
  @api.model()
  async _getLineBatchKey(line) {
    const [move, partner, account, currency, accountInternalType] = await line('moveId', 'partnerId', 'accountId', 'currencyId', 'accountInternalType');

    let partnerBankAccount = this.env.items('res.partner.bank');
    if (await move.isInvoice(true)) {
      partnerBankAccount = (await move.partnerBankId)._origin;
    }
    return {
      'partnerId': partner.id,
      'accountId': account.id,
      'currencyId': currency.id,
      'partnerBankId': partnerBankAccount.id,
      'partnerType': accountInternalType == 'receivable' ? 'customer' : 'supplier',
    }
  }
  /**
   * Group the account.move.line linked to the wizard together.
  Lines are grouped if they share 'partnerId','accountId','currencyId' & 'partner_type' and if
  0 or 1 partner_bank_id can be determined for the group.
  :return: A list of batches, each one containing:
      * payment_values:   A dictionary of payment values.
      * moves:        An account.move recordset.
   * @returns 
   */
  async _getBatches() {
    this.ensureOne();

    const lines = (await this['lineIds'])._origin;

    if (len(await lines.companyId) > 1) {
      throw new UserError(await this._t("You can't create payments for entries belonging to different companies."));
    }
    if (!bool(lines)) {
      throw new UserError(await this._t("You can't open the register payment wizard without at least one receivable/payable line."));
    }

    const batches = new DefaultDict2(() => { return { 'lines': this.env.items('account.move.line') } });
    let vals;
    for (const line of lines) {
      const batchKey = await this._getLineBatchKey(line);
      const serializedKey = Object.values(batchKey).map(v => String(v)).join('-');
      vals = batches[serializedKey];
      vals['paymentValues'] = batchKey;
      vals['lines'] = vals['lines'].add(line);
    }

    // Compute 'payment_type'.
    for (const vals of batches.values()) {
      const lines = vals['lines'];
      const balance = sum(await lines.mapped('balance'));
      vals['paymentValues']['paymentType'] = balance > 0.0 ? 'inbound' : 'outbound';
    }

    return Array.from(batches.values());
  }

  /**
   * Extract values from the batch passed as parameter (see '_get_batches')
      to be mounted in the wizard view.
      :param batch_result:    A batch returned by '_get_batches'.
      :return:                A dictionary containing valid fields
   * @param batchResult 
   * @returns 
   */
  @api.model()
  async _getWizardValuesFromBatch(batchResult) {
    const paymentValues = batchResult['paymentValues'];
    const lines = batchResult['lines'];
    const company = await lines[0].companyId;

    const sourceAmount = Math.abs(sum(await lines.mapped('amountResidual')));
    let sourceAmountCurrency;
    if (paymentValues['currencyId'] === (await company.currencyId).id) {
      sourceAmountCurrency = sourceAmount;
    }
    else {
      sourceAmountCurrency = Math.abs(sum(await lines.mapped('amountResidualCurrency')));
    }
    return {
      'companyId': company.id,
      'partnerId': paymentValues['partnerId'],
      'partnerType': paymentValues['partnerType'],
      'paymentType': paymentValues['paymentType'],
      'sourceCurrencyId': paymentValues['currencyId'],
      'sourceAmount': sourceAmount,
      'sourceAmountCurrency': sourceAmountCurrency,
    }
  }

  // COMPUTE METHODS

  /**
   * Load initial values from the account.moves passed through the context.
   */
  @api.depends('lineIds')
  async _computeFromLines() {
    for (const wizard of this) {
      const batches = await wizard._getBatches();
      const batchResult = batches[0];
      const wizardValuesFromBatch = await wizard._getWizardValuesFromBatch(batchResult);

      if (len(batches) == 1) {
        // == Single batch to be mounted on the view ==
        await wizard.update(wizardValuesFromBatch);

        await wizard.set('canEditWizard', true);
        await wizard.set('canGroupPayments', len(batchResult['lines']) != 1);
      }
      else {
        // == Multiple batches: The wizard is not editable  ==
        await wizard.update({
          'companyId': (await batches[0]['lines'][0].companyId).id,
          'partnerId': false,
          'partnerType': false,
          'paymentType': wizardValuesFromBatch['paymentType'],
          'sourceCurrencyId': false,
          'sourceAmount': false,
          'sourceAmountCurrency': false,
        })

        await wizard.set('canEditWizard', false);
        await wizard.set('canGroupPayments', batches.some(batchResult => len(batchResult['lines']) != 1));
      }
    }
  }

  @api.depends('canEditWizard')
  async _computeCommunication() {
    // The communication can't be computed in '_computeFromLines' because
    // it's a compute editable field and then, should be computed in a separated method.
    for (const wizard of this) {
      if (await wizard.canEditWizard) {
        const batches = await wizard._getBatches();
        await wizard.set('communication', await wizard._getBatchCommunication(batches[0]));
      }
      else {
        await wizard.set('communication', false);
      }
    }
  }

  @api.depends('canEditWizard')
  async _computeGroupPayment() {
    for (const wizard of this) {
      if (await wizard.canEditWizard) {
        const batches = await wizard._getBatches();
        await wizard.set('groupPayment', len(await batches[0]['lines'].moveId) == 1);
      }
      else {
        await wizard.set('groupPayment', false);
      }
    }
  }

  @api.depends('journalId')
  async _computeCurrencyId() {
    for (const wizard of this) {
      let currency = await (await wizard.journalId).currencyId;
      currency = currency.ok ? currency : await wizard.sourceCurrencyId;
      currency = currency.ok ? currency : await (await wizard.companyId).currencyId;
      await wizard.set('currencyId', currency);
    }
  }

  @api.depends('canEditWizard', 'companyId')
  async _computeJournalId() {
    for (const wizard of this) {
      if (await wizard.canEditWizard) {
        const batch = (await wizard._getBatches())[0];
        await wizard.set('journalId', await wizard._getBatchJournal(batch));
      }
      else {
        await wizard.set('journalId', await this.env.items('account.journal').search([
          ['type', 'in', ['bank', 'cash']],
          ['companyId', '=', (await wizard.companyId).id],
        ], { limit: 1 }));
      }
    }
  }

  @api.depends('canEditWizard', 'journalId')
  async _computeAvailablePartnerBankIds() {
    for (const wizard of this) {
      if (await wizard.canEditWizard) {
        const batch = (await wizard._getBatches())[0];
        await wizard.set('availablePartnerBankIds', await wizard._getBatchAvailablePartnerBanks(batch, await wizard.journalId));
      }
      else {
        await wizard.set('availablePartnerBankIds', null);
      }
    }
  }

  @api.depends('journalId', 'availablePartnerBankIds')
  async _computePartnerBankId() {
    for (const wizard of this) {
      if (await wizard.canEditWizard) {
        const batch = (await wizard._getBatches())[0];
        const partnerBankId = batch['paymentValues']['partnerBankId'];
        const availablePartnerBanks = (await wizard.availablePartnerBankIds)._origin;
        if (bool(partnerBankId) && availablePartnerBanks.ids.includes(partnerBankId)) {
          await wizard.set('partnerBankId', this.env.items('res.partner.bank').browse(partnerBankId));
        }
        else {
          await wizard.set('partnerBankId', availablePartnerBanks.slice(0, 1));
        }
      }
      else {
        await wizard.set('partnerBankId', null);
      }
    }
  }

  @api.depends('paymentType', 'journalId', 'currencyId')
  async _computePaymentMethodLineFields() {
    for (const wizard of this) {
      await wizard.set('availablePaymentMethodLineIds', await (await wizard.journalId)._getAvailablePaymentMethodLines(await wizard.paymentType));
      if (!(await wizard.availablePaymentMethodLineIds).ids.includes((await wizard.paymentMethodLineId).id)) {
        // In some cases, we could be linked to a payment method line that has been unlinked from the journal.
        // In such cases, we want to show it on the payment.
        await wizard.set('hidePaymentMethodLine', false);
      }
      else {
        await wizard.set('hidePaymentMethodLine', len(await wizard.availablePaymentMethodLineIds) == 1
          && await (await wizard.availablePaymentMethodLineIds).code === 'manual');
      }
    }
  }

  @api.depends('paymentType', 'journalId')
  async _computePaymentMethodLineId() {
    for (const wizard of this) {
      const availablePaymentMethodLines = await (await wizard.journalId)._getAvailablePaymentMethodLines(await wizard.paymentType);

      // Select the first available one by default.
      if (bool(availablePaymentMethodLines)) {
        await wizard.set('paymentMethodLineId', availablePaymentMethodLines[0]._origin);
      }
      else {
        await wizard.set('paymentMethodLineId', false);
      }
    }
  }

  /**
   * Computes if the destination bank account must be displayed in the payment form view. By default, it
    won't be displayed but some modules might change that, depending on the payment type.
   */
  @api.depends('paymentMethodLineId')
  async _computeShowRequirePartnerBank() {
    for (const wizard of this) {
      const code = await (await wizard.paymentMethodLineId).code;
      await wizard.set('showPartnerBankAccount', (await this.env.items('account.payment')._getMethodCodesUsingBankAccount()).includes(code));
      await wizard.set('requirePartnerBankAccount', (await this.env.items('account.payment')._getMethodCodesNeedingBankAccount()).includes(code));
    }
  }

  @api.depends('sourceAmount', 'sourceAmountCurrency', 'sourceCurrencyId', 'companyId', 'currencyId', 'paymentDate')
  async _computeAmount() {
    for (const wizard of this) {
      if ((await wizard.sourceCurrencyId).eq(await wizard.currencyId)) {
        // Same currency.
        await wizard.set('amount', await wizard.sourceAmountCurrency);
      }
      else {
        await wizard.set('amount', await (await wizard.sourceCurrencyId)._convert(await wizard.sourceAmountCurrency, await wizard.currencyId, await wizard.companyId, wizard.paymentDate || _Date.today()));
      }
    }
  }

  @api.depends('amount')
  async _computePaymentDifference() {
    for (const wizard of this) {
      if ((await wizard.sourceCurrencyId).eq(await wizard.currencyId)) {
        // Same currency.
        await wizard.set('paymentDifference', await wizard.sourceAmountCurrency - await wizard.amount);
      }
      else if ((await wizard.currencyId).eq(await (await wizard.companyId).currencyId)) {
        // Payment expressed on the company's currency.
        await wizard.set('paymentDifference', await wizard.sourceAmount - await wizard.amount);
      }
      else {
        // Foreign currency on payment different than the one set on the journal entries.
        const amountPaymentCurrency = await (await (await wizard.companyId).currencyId)._convert(await wizard.sourceAmount, await wizard.currencyId, await wizard.companyId, await wizard.paymentDate || _Date.today());
        await wizard.set('paymentDifference', amountPaymentCurrency - await wizard.amount);
      }
    }
  }

  // LOW-LEVEL METHODS

  @api.model()
  async fieldsViewGet(viewId?: any, viewType: string = 'form', toolbar: boolean = false, submenu: boolean = false) {
    // OVERRIDE to add the 'available_partner_bank_ids' field dynamically inside the view.
    // TO BE REMOVED IN MASTER
    const res = await _super(AccountPaymentRegister, this).fieldsViewGet(viewId, viewType, toolbar, submenu);
    if (viewType == 'form') {
      const formView = await this.env.ref('account.viewAccountPaymentRegisterForm');
      const tree = res['dom'];
      if (res['viewId'] == formView.id && len(xpath.select('//field[@name="availablePartnerBankIds"]', tree)) == 0) {
        // Don't force people to update the account module.
        const archTree = getrootXml(parseXml(await formView.arch));
        if (archTree.tagName == 'form') {
          archTree.insertBefore(E.withType('field', {
            'name': 'availablePartnerBankIds',
            'invisible': '1',
          }), archTree.firstChild);
          await (await formView.sudo()).write({ 'arch': serializeXml(archTree, 'unicode') });
          return _super(AccountPaymentRegister, this).fieldsViewGet(viewId, viewType, toolbar, submenu);
        }
      }
    }

    return res;
  }

  @api.model()
  async defaultGet(fieldsList) {
    // OVERRIDE
    const res = await _super(AccountPaymentRegister, this).defaultGet(fieldsList);

    if (fieldsList.includes('lineIds') && !('lineIds' in res)) {

      // Retrieve moves to pay from the context.

      let lines;
      if (this._context['activeModel'] === 'account.move') {
        lines = await this.env.items('account.move').browse(this._context['activeIds'] ?? []).lineIds;
      }
      else if (this._context['activeModel'] === 'account.move.line') {
        lines = this.env.items('account.move.line').browse(this._context['activeIds'] ?? []);
      }
      else {
        throw new UserError(await this._t(
          "The register payment wizard should only be called on account.move or account.move.line records."
        ));
      }

      if ('journalId' in res && !bool(await this.env.items('account.journal').browse(res['journalId'])
        .filteredDomain([['companyId', '=', (await lines.companyId).id], ['type', 'in', ['bank', 'cash']]]))) {
        // default can be inherited from the list view, should be computed instead
        delete res['journalId'];
      }

      // Keep lines having a residual amount to pay.
      let availableLines = this.env.items('account.move.line');
      for (const line of lines) {
        if (await (await line.moveId).state !== 'posted') {
          throw new UserError(await this._t("You can only register payment for posted journal entries."));
        }

        if (!['receivable', 'payable'].includes(await line.accountInternalType)) {
          continue;
        }
        if (bool(await line.currencyId)) {
          if (await (await line.currencyId).isZero(await line.amountResidualCurrency)) {
            continue;
          }
        }
        else {
          if (await (await line.companyCurrencyId).isZero(await line.amountResidual)) {
            continue;
          }
        }
        availableLines = availableLines.or(line);
      }
      // Check.
      if (!bool(availableLines)) {
        throw new UserError(await this._t("You can't register a payment because there is nothing left to pay on the selected journal items."));
      }
      if (len(await lines.companyId) > 1) {
        throw new UserError(await this._t("You can't create payments for entries belonging to different companies."));
      }
      if (len(new Set(await availableLines.mapped('accountInternalType'))) > 1) {
        throw new UserError(await this._t("You can't register payments for journal items being either all inbound, either all outbound."));
      }

      res['lineIds'] = [[6, 0, availableLines.ids]]
    }

    return res;
  }
  // BUSINESS METHODS

  async _createPaymentValsFromWizard() {
    const [paymentDate, amount, paymentType, partnerType, communication, journal, currency, partner, partnerBank, paymentMethodLine, lines, paymentDifference, paymentDifferenceHandling, writeoffLabel, writeoffAccount] = await this('paymentDate', 'amount', 'paymentType', 'partnerType', 'communication', 'journalId', 'currencyId', 'partnerId', 'partnerBankId', 'paymentMethodLineId', 'lineIds', 'paymentDifference', 'paymentDifferenceHandling', 'writeoffLabel', 'writeoffAccountId');
    const paymentVals = {
      'date': paymentDate,
      'amount': amount,
      'paymentType': paymentType,
      'partnerType': partnerType,
      'ref': communication,
      'journalId': journal.id,
      'currencyId': currency.id,
      'partnerId': partner.id,
      'partnerBankId': partnerBank.id,
      'paymentMethodLineId': paymentMethodLine.id,
      'destinationAccountId': (await lines[0].accountId).id
    }

    if (! await currency.isZero(paymentDifference) && paymentDifferenceHandling === 'reconcile') {
      paymentVals['writeOffLineVals'] = {
        'label': writeoffLabel,
        'amount': paymentDifference,
        'accountId': writeoffAccount.id,
      }
    }
    return paymentVals;
  }

  async _createPaymentValsFromBatch(batchResult) {
    const batchValues = await this._getWizardValuesFromBatch(batchResult);
    const [journalId, paymentDate] = await this('journalId', 'paymentDate');
    let partnerBankId;
    if (batchValues['paymentType'] === 'inbound') {
      partnerBankId = (await journalId.bankAccountId).id;
    }
    else {
      partnerBankId = batchResult['paymentValues']['partnerBankId']
    }

    let paymentMethodLine = await this['paymentMethodLineId'];
    if (batchValues['paymentType'] !== await paymentMethodLine.paymentType) {
      paymentMethodLine = (await journalId._getAvailablePaymentMethodLines(batchValues['paymentType'])).slice(0, 1);
    }

    return {
      'date': paymentDate,
      'amount': batchValues['sourceAmountCurrency'],
      'paymentType': batchValues['paymentType'],
      'partnerType': batchValues['partnerType'],
      'ref': await this._getBatchCommunication(batchResult),
      'journalId': journalId.id,
      'currencyId': batchValues['sourceCurrencyId'],
      'partnerId': batchValues['partnerId'],
      'partnerBankId': partnerBankId,
      'paymentMethodLineId': paymentMethodLine.id,
      'destinationAccountId': (await batchResult['lines'][0].accountId).id
    }
  }

  /**
   * Create the payments.
 
      :param to_process:  A list of dictionary, one for each payment to create, containing:
                          * create_vals:  The values used for the 'create' method.
                          * to_reconcile: The journal items to perform the reconciliation.
                          * batch:        A dict containing everything you want about the source journal items
                                          to which a payment will be created (see '_get_batches').
      :param editMode:   Is the wizard in edition mode.
   * @param toProcess 
   * @param editMode 
   * @returns 
   */
  async _initPayments(toProcess, editMode: boolean = false) {
    const payments = await this.env.items('account.payment').create(toProcess.map(x => x['createVals']));

    for (const [payment, vals] of _.zip([...payments], toProcess)) {
      vals['payment'] = payment;

      // If payments are made using a currency different than the source one, ensure the balance match exactly in
      // order to fully paid the source journal items.
      // For example, suppose a new currency B having a rate 100:1 regarding the company currency A.
      // If you try to pay 12.15A using 0.12B, the computed balance will be 12.00A for the payment instead of 12.15A.
      if (editMode) {
        const lines = vals['toReconcile'];

        // Batches are made using the same currency so making 'lines.currencyId' is ok.
        if (!(await payment.currencyId).eq(await lines.currencyId)) {
          const [liquidityLines, counterpartLines, writeoffLines] = await payment._seekForLines();
          const sourceBalance = Math.abs(sum(await lines.mapped('amountResidual')));
          let paymentRate;
          if (await liquidityLines[0].balance) {
            paymentRate = await liquidityLines[0].amountCurrency / await liquidityLines[0].balance;
          }
          else {
            paymentRate = 0.0;
          }
          const sourceBalanceConverted = Math.abs(sourceBalance) * paymentRate;

          // Translate the balance into the payment currency is order to be able to compare them.
          // In case in both have the same value (12.15 * 0.01 ~= 0.12 in our example), it means the user
          // attempt to fully paid the source lines and then, we need to manually fix them to get a perfect
          // match.
          const paymentBalance = Math.abs(sum(await counterpartLines.mapped('balance')));
          const paymentAmountCurrency = Math.abs(sum(await counterpartLines.mapped('amountCurrency')));
          if (! await (await payment.currencyId).isZero(sourceBalanceConverted - paymentAmountCurrency)) {
            continue;
          }

          const deltaBalance = sourceBalance - paymentBalance;

          // Balance are already the same.
          if (await (await this['companyCurrencyId']).isZero(deltaBalance)) {
            continue;
          }

          // Fix the balance but make sure to peek the liquidity and counterpart lines first.
          const debitLines = await liquidityLines.add(counterpartLines).filtered('debit');
          const creditLines = await liquidityLines.add(counterpartLines).filtered('credit');

          if (debitLines.ok && creditLines.ok) {
            await (await payment.moveId).write({
              'lineIds': [
                [1, debitLines[0].id, { 'debit': await debitLines[0].debit + deltaBalance }],
                [1, creditLines[0].id, { 'credit': await creditLines[0].credit + deltaBalance }],
              ]
            });
          }
        }
      }
    }

    return payments;
  }

  /**
   * Post the newly created payments.
 
      :param to_process:  A list of dictionary, one for each payment to create, containing:
                          * create_vals:  The values used for the 'create' method.
                          * to_reconcile: The journal items to perform the reconciliation.
                          * batch:        A dict containing everything you want about the source journal items
                                          to which a payment will be created (see '_get_batches').
      :param editMode:   Is the wizard in edition mode.
   * @param toProcess 
   * @param editMode 
   */
  async _postPayments(toProcess, editMode: boolean = false) {
    let payments = this.env.items('account.payment');
    for (const vals of toProcess) {
      payments = payments.or(vals['payment']);
    }
    await payments.actionPost();
  }

  /**
   * Reconcile the payments.
 
      :param to_process:  A list of dictionary, one for each payment to create, containing:
                          * create_vals:  The values used for the 'create' method.
                          * to_reconcile: The journal items to perform the reconciliation.
                          * batch:        A dict containing everything you want about the source journal items
                                          to which a payment will be created (see '_get_batches').
      :param editMode:   Is the wizard in edition mode.
   * @param toProcess 
   * @param editMode 
   */
  async _reconcilePayments(toProcess, editMode: boolean = false) {
    const domain = [
      ['parentState', '=', 'posted'],
      ['accountInternalType', 'in', ['receivable', 'payable']],
      ['reconciled', '=', false],
    ];
    for (const vals of toProcess) {
      const paymentLines = await (await vals['payment'].lineIds).filteredDomain(domain);
      const lines = vals['toReconcile'];

      for (const account of await paymentLines.accountId) {
        await (await paymentLines.add(lines)
          .filteredDomain([['accountId', '=', account.id], ['reconciled', '=', false]]))
          .reconcile();
      }
    }
  }

  async _createPayments() {
    this.ensureOne();
    let batches = await this._getBatches();
    const editMode = await this['canEditWizard'] && (len(batches[0]['lines']) == 1 || await this['groupPayment']);
    const toProcess = [];

    if (editMode) {
      const paymentVals = await this._createPaymentValsFromWizard();
      toProcess.push({
        'createVals': paymentVals,
        'toReconcile': batches[0]['lines'],
        'batch': batches[0],
      });
    }
    else {
      // Don't group payments: Create one batch per move.
      if (! await this['groupPayment']) {
        const newBatches = [];
        for (const batchResult of batches) {
          for (const line of batchResult['lines']) {
            newBatches.push({
              ...batchResult,
              'paymentValues': {
                ...batchResult['paymentValues'],
                'paymentType': await line.balance > 0 ? 'inbound' : 'outbound'
              },
              'lines': line,
            });
          }
        }
        batches = newBatches;
      }
      for (const batchResult of batches) {
        toProcess.push({
          'createVals': await this._createPaymentValsFromBatch(batchResult),
          'toReconcile': batchResult['lines'],
          'batch': batchResult,
        });
      }
    }

    const payments = await this._initPayments(toProcess, editMode);
    await this._postPayments(toProcess, editMode);
    await this._reconcilePayments(toProcess, editMode);
    return payments;
  }

  async actionCreatePayments() {
    const payments = await this._createPayments();

    if (this._context['dontRedirectToPayments']) {
      return true;
    }

    const action = {
      'label': await this._t('Payments'),
      'type': 'ir.actions.actwindow',
      'resModel': 'account.payment',
      'context': { 'create': false },
    }
    if (len(payments) == 1) {
      update(action, {
        'viewMode': 'form',
        'resId': payments.id,
      });
    }
    else {
      update(action, {
        'viewMode': 'tree,form',
        'domain': [['id', 'in', payments.ids]],
      });
    }
    return action;
  }
}