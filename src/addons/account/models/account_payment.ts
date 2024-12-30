import xpath from "xpath";
import { api } from "../../../core";
import { Command, Fields } from "../../../core/fields";
import { UserError, ValidationError } from "../../../core/helper/errors";
import { MetaModel, Model, _super } from "../../../core/models";
import { bool } from "../../../core/tools/bool";
import { enumerate, len, sum } from "../../../core/tools/iterable";
import { pop, update } from "../../../core/tools/misc";
import { _f, f } from "../../../core/tools/utils";
import { E, getrootXml, parseXml, serializeXml } from "../../../core/tools/xml";

@MetaModel.define()
class AccountPayment extends Model {
  static _module = module;
  static _name = "account.payment";
  static _parents = ['mail.thread', 'mail.activity.mixin'];
  static _inherits = { 'account.move': 'moveId' };
  static _description = "Payments";
  static _order = "date desc, label desc";
  static _checkCompanyAuto = true;

  /**
   * Retrieve the default journal for the account.payment.
      /!\ This method will not override the method in 'account.move' because the ORM
      doesn't allow overriding methods using _inherits. Then, this method will be called
      manually in 'create' and 'new'.
      :return: An account.journal record.
   * @returns 
   */
  async _getDefaultJournal() {
    return this.env.items('account.move')._searchDefaultJournal(['bank', 'cash']);
  }

  // == Business fields ==
  static moveId = Fields.Many2one({ comodelName: 'account.move', string: 'Journal Entry', required: true, readonly: true, ondelete: 'CASCADE', checkCompany: true });

  static isReconciled = Fields.Boolean({ string: "Is Reconciled", store: true, compute: '_computeReconciliationStatus', help: "Technical field indicating if the payment is already reconciled." });
  static isMatched = Fields.Boolean({ string: "Is Matched With a Bank Statement", store: true, compute: '_computeReconciliationStatus', help: "Technical field indicating if the payment has been matched with a statement line." });
  static availablePartnerBankIds = Fields.Many2many({ comodelName: 'res.partner.bank', compute: '_computeAvailablePartnerBankIds' });
  static partnerBankId = Fields.Many2one('res.partner.bank', { string: "Recipient Bank Account", readonly: false, store: true, tracking: true, compute: '_computePartnerBankId', domain: "[['id', 'in', availablePartnerBankIds]]", checkCompany: true });
  static isInternalTransfer = Fields.Boolean({ string: "Internal Transfer", readonly: false, store: true, tracking: true, compute: "_computeIsInternalTransfer" });
  static qrCode = Fields.Char({ string: "QR Code", compute: "_computeQrCode", help: "QR-code report URL to use to generate the QR-code to scan with a banking app to perform this payment." });
  static pairedInternalTransferPaymentId = Fields.Many2one('account.payment', { help: "When an internal transfer is posted, a paired payment is created. They are cross referenced trough this field", copy: false });

  // == Payment methods fields ==
  static paymentMethodLineId = Fields.Many2one('account.payment.method.line', {
    string: 'Payment Method', readonly: false, store: true, copy: false, compute: '_computePaymentMethodLineId', domain: "[['id', 'in', availablePaymentMethodLineIds]]", help: "Manual: Pay or Get paid by any method outside of Verp.\n \
      Payment Acquirers: Each payment acquirer has its own Payment Method. Request a transaction on/to a card thanks to a payment token saved by the partner when buying or subscribing online.\n \
      Check: Pay bills by check and print it from Verp.\n \
      Batch Deposit: Collect several customer checks at once generating and submitting a batch deposit to your bank. Module account_batch_payment is necessary.\n \
      SEPA Credit Transfer: Pay in the SEPA zone by submitting a SEPA Credit Transfer file to your bank. Module account_sepa is necessary.\n \
      SEPA Direct Debit: Get paid in the SEPA zone thanks to a mandate your partner will have granted to you. Module account_sepa is necessary."
  });
  static availablePaymentMethodLineIds = Fields.Many2many('account.payment.method.line', { compute: '_computePaymentMethodLineFields' });
  static hidePaymentMethodLine = Fields.Boolean({ compute: '_computePaymentMethodLineFields', help: "Technical field used to hide the payment method if the selected journal has only one available which is 'manual'" });
  static paymentMethodId = Fields.Many2one({ related: 'paymentMethodLineId.paymentMethodId', string: "Method", tracking: true, store: true });

  // == Synchronized fields with the account.move.lines ==
  static amount = Fields.Monetary({ currencyField: 'currencyId' });
  static paymentType = Fields.Selection([
    ['outbound', 'Send'],
    ['inbound', 'Receive'],
  ], { string: 'Payment Type', default: 'inbound', required: true, tracking: true });
  static partnerType = Fields.Selection([
    ['customer', 'Customer'],
    ['supplier', 'Vendor'],
  ], { default: 'customer', tracking: true, required: true });
  static paymentReference = Fields.Char({
    string: "Payment Reference", copy: false, tracking: true,
    help: "Reference of the document used to issue this payment. Eg. check number, file name, etc."
  });
  static currencyId = Fields.Many2one('res.currency', {
    string: 'Currency', store: true, readonly: false,
    compute: '_computeCurrencyId',
    help: "The payment's currency."
  })
  static partnerId = Fields.Many2one({
    comodelName: 'res.partner',
    string: "Customer/Vendor",
    store: true, readonly: false, ondelete: 'RESTRICT',
    compute: '_computePartnerId',
    domain: "['|', ['parentId','=', false], ['isCompany','=', true]]",
    tracking: true,
    checkCompany: true
  });
  static outstandingAccountId = Fields.Many2one({
    comodelName: 'account.account',
    string: "Outstanding Account",
    store: true,
    compute: '_computeOutstandingAccountId',
    checkCompany: true
  });
  static destinationAccountId = Fields.Many2one({
    comodelName: 'account.account',
    string: 'Destination Account',
    store: true, readonly: false,
    compute: '_computeDestinationAccountId',
    domain: "[['userTypeId.type', 'in', ['receivable', 'payable']], ['companyId', '=', companyId]]",
    checkCompany: true
  });
  static destinationJournalId = Fields.Many2one({
    comodelName: 'account.journal',
    string: 'Destination Journal',
    domain: "[['type', 'in', ['bank','cash']], ['companyId', '=', companyId], ['id', '!=', journalId]]",
    checkCompany: true
  });

  // == Stat buttons ==
  static reconciledInvoiceIds = Fields.Many2many('account.move', {
    string: "Reconciled Invoices",
    compute: '_computeStatButtonsFromReconciliation',
    help: "Invoices whose journal items have been reconciled with these payments."
  });
  static reconciledInvoicesCount = Fields.Integer({
    string: "# Reconciled Invoices",
    compute: "_computeStatButtonsFromReconciliation"
  });
  static reconciledInvoicesType = Fields.Selection(
    [['creditNote', 'Credit Note'], ['invoice', 'Invoice']], {
    compute: '_computeStatButtonsFromReconciliation',
    help: "Technical field used to determine label 'invoice' or 'credit note' in view"
  });
  static reconciledBillIds = Fields.Many2many('account.move', {
    string: "Reconciled Bills",
    compute: '_computeStatButtonsFromReconciliation',
    help: "Invoices whose journal items have been reconciled with these payments."
  });
  static reconciledBillsCount = Fields.Integer({
    string: "# Reconciled Bills",
    compute: "_computeStatButtonsFromReconciliation"
  });
  static reconciledStatementIds = Fields.Many2many('account.bank.statement', {
    string: "Reconciled Statements",
    compute: '_computeStatButtonsFromReconciliation',
    help: "Statements matched to this payment"
  });
  static reconciledStatementsCount = Fields.Integer({
    string: "# Reconciled Statements",
    compute: "_computeStatButtonsFromReconciliation"
  });

  // == Display purpose fields ==
  static paymentMethodCode = Fields.Char({
    related: 'paymentMethodLineId.code',
    help: "Technical field used to adapt the interface to the payment type selected."
  });
  static showPartnerBankAccount = Fields.Boolean({
    compute: '_computeShowRequirePartnerBank',
    help: "Technical field used to know whether the field `partner_bank_id` needs to be displayed or not in the payments form views"
  });
  static requirePartnerBankAccount = Fields.Boolean({
    compute: '_computeShowRequirePartnerBank',
    help: "Technical field used to know whether the field `partner_bank_id` needs to be required or not in the payments form views"
  });
  static countryCode = Fields.Char({ related: 'companyId.accountFiscalCountryId.code' });
  static amountSigned = Fields.Monetary({
    currencyField: 'currencyId', compute: '_computeAmountSigned', tracking: true,
    help: 'Negative value of amount field if payment_type is outbound'
  });
  static amountCompanyCurrencySigned = Fields.Monetary({
    currencyField: 'companyCurrencyId', compute: '_computeAmountCompanyCurrencySigned'
  });

  static _sqlConstraints = [
    [
      'checkAmountNotNegative',
      'CHECK(amount >= 0.0)',
      "The payment amount cannot be negative.",
    ],
  ]

  // HELPERS

  /**
   * Helper used to dispatch the journal items between:
      - The lines using the temporary liquidity account.
      - The lines using the counterpart account.
      - The lines being the write-off lines.
      :return: (liquidity_lines, counterpart_lines, writeoff_lines)
   */
  async _seekForLines() {
    this.ensureOne();

    let liquidityLines = this.env.items('account.move.line');
    let counterpartLines = this.env.items('account.move.line');
    let writeoffLines = this.env.items('account.move.line');

    for (const line of await (await this['moveId']).lineIds) {
      if ((await this._getValidLiquidityAccounts()).includes(await line.accountId)) {
        liquidityLines = liquidityLines.add(line);
      }
      else if (['receivable', 'payable'].includes(await (await line.accountId).internalType) || (await line.accountId).eq(await (await line.companyId).transferAccountId)) {
        counterpartLines = counterpartLines.add(line);
      }
      else {
        writeoffLines = writeoffLines.add(line);
      }
    }
    return [liquidityLines, counterpartLines, writeoffLines];
  }

  async _getValidLiquidityAccounts() {
    const [journalId, paymentMethodLineId] = await this('journalId', 'paymentMethodLineId');
    const companyId = await journalId.companyId;
    return [
      await journalId.defaultAccountId,
      await paymentMethodLineId.paymentAccountId,
      await companyId.accountJournalPaymentDebitAccountId,
      await companyId.accountJournalPaymentCreditAccountId,
      await (await journalId.inboundPaymentMethodLineIds).paymentAccountId,
      await (await journalId.outboundPaymentMethodLineIds).paymentAccountId,
    ];
  }

  /**
   * Hook method for inherit
      When you want to set a new name for payment, you can extend this method
   * @returns 
   */
  async _preparePaymentDisplayName() {
    return {
      'outbound-customer': await this._t("Customer Reimbursement"),
      'inbound-customer': await this._t("Customer Payment"),
      'outbound-supplier': await this._t("Vendor Payment"),
      'inbound-supplier': await this._t("Vendor Reimbursement"),
    }
  }

  /**
   * Prepare the dictionary to create the default account.move.lines for the current payment.
      :param write_off_line_vals: Optional dictionary to create a write-off account.move.line easily containing:
          * amount:       The amount to be added to the counterpart amount.
          * name:         The label to set on the line.
          * accountId:   The account on which create the write-off.
      :return: A list of dictionary to be passed to the account.move.line's 'create' method.
   * @param writeOffLineVals 
   */
  async _prepareMoveLineDefaultVals(writeOffLineVals?: any) {
    this.ensureOne();
    writeOffLineVals = writeOffLineVals ?? {};
    const outstandingAccount = await this['outstandingAccountId'];
    if (!bool(outstandingAccount)) {
      throw new UserError(await this._t(
        "You can't create a new payment without an outstanding payments/receipts account set either on the company or the %s payment method in the %s journal.",
        await (await this['paymentMethodLineId']).label, await (await this['journalId']).displayName));
    }
    // Compute amounts.
    let writeOffAmountCurrency = writeOffLineVals['amount'] || 0.0;
    let liquidityAmountCurrency;
    const [date, paymentType, amount, currency, company, isInternalTransfer, journal, partner, destinationAccount, partnerType, paymentReference] = await this('date', 'paymentType', 'amount', 'currencyId', 'companyId', 'isInternalTransfer', 'journalId', 'partnerId', 'destinationAccountId', 'partnerType', 'paymentReference');
    if (paymentType === 'inbound') {
      // Receive money.
      liquidityAmountCurrency = amount;
    }
    else if (paymentType === 'outbound') {
      // Send money.
      liquidityAmountCurrency = -amount;
      writeOffAmountCurrency *= -1;
    }
    else {
      liquidityAmountCurrency = writeOffAmountCurrency = 0.0;
    }
    const writeOffBalance = await currency._convert(
      writeOffAmountCurrency,
      await company.currencyId,
      company,
      date,
    );
    const liquidityBalance = await currency._convert(
      liquidityAmountCurrency,
      await company.currencyId,
      company,
      date,
    );
    const counterpartAmountCurrency = -liquidityAmountCurrency - writeOffAmountCurrency;
    const counterpartBalance = -liquidityBalance - writeOffBalance;
    const currencyId = currency.id;

    let liquidityLineName;
    if (isInternalTransfer) {
      if (paymentType === 'inbound') {
        liquidityLineName = await this._t('Transfer to %s', await journal.label);
      }
      else { // payment.paymentType == 'outbound':
        liquidityLineName = await this._t('Transfer from %s', await journal.label);
      }
    }
    else {
      liquidityLineName = paymentReference;
    }
    // Compute a default label to set on the journal items.

    const paymentDisplayName = await this._preparePaymentDisplayName();

    const defaultLineName = await this.env.items('account.move.line')._getDefaultLineName(
      isInternalTransfer ? await this._t("Internal Transfer") : paymentDisplayName[f('%s-%s', paymentType, partnerType)],
      amount,
      currency,
      date,
      partner,
    )

    const lineValsList: {}[] = [
      // Liquidity line.
      {
        'label': liquidityLineName || defaultLineName,
        'dateMaturity': date,
        'amountCurrency': liquidityAmountCurrency,
        'currencyId': currencyId,
        'debit': liquidityBalance > 0.0 ? liquidityBalance : 0.0,
        'credit': liquidityBalance < 0.0 ? -liquidityBalance : 0.0,
        'partnerId': partner.id,
        'accountId': outstandingAccount.id,
      },
      // Receivable / Payable.
      {
        'label': paymentReference || defaultLineName,
        'dateMaturity': date,
        'amountCurrency': counterpartAmountCurrency,
        'currencyId': currencyId,
        'debit': counterpartBalance > 0.0 ? counterpartBalance : 0.0,
        'credit': counterpartBalance < 0.0 ? -counterpartBalance : 0.0,
        'partnerId': partner.id,
        'accountId': destinationAccount.id,
      },
    ]
    if (! await currency.isZero(writeOffAmountCurrency)) {
      // Write-off line.
      lineValsList.push({
        'label': writeOffLineVals['label'] || defaultLineName,
        'amountCurrency': writeOffAmountCurrency,
        'currencyId': currencyId,
        'debit': writeOffBalance > 0.0 ? writeOffBalance : 0.0,
        'credit': writeOffBalance < 0.0 ? -writeOffBalance : 0.0,
        'partnerId': partner.id,
        'accountId': writeOffLineVals['accountId'],
      });
    }
    return lineValsList;
  }

  // COMPUTE METHODS

  /**
   * Compute the field indicating if the payments are already reconciled with something.
      This field is used for display purpose (e.g. display the 'reconcile' button redirecting to the reconciliation
      widget).
   */
  @api.depends('moveId.lineIds.amountResidual', 'moveId.lineIds.amountResidualCurrency', 'moveId.lineIds.accountId')
  async _computeReconciliationStatus() {
    for (const pay of this) {
      const [liquidityLines, counterpartLines, writeoffLines] = await pay._seekForLines();
      const [companyId, currencyId, journalId, amount] = await pay('companyId', 'currencyId', 'journalId', 'amount');
      if (!bool(await pay.currencyId) || !bool(pay.id)) {
        // await Promise.all([
        await pay.set('isReconciled', false),
          await pay.set('isMatched', false)
        // ]);
      }
      else if (await currencyId.isZero(amount)) {
        // await Promise.all([
        await pay.set('isReconciled', true),
          await pay.set('isMatched', true)
        // ]);
      }
      else {
        const residualField = currencyId.eq(await companyId.currencyId) ? 'amountResidual' : 'amountResidualCurrency';
        const defaultAccountId = await journalId.defaultAccountId;
        if (bool(defaultAccountId) && (await liquidityLines.accountId).includes(defaultAccountId)) {
          // Allow user managing payments without any statement lines by using the bank account directly.
          // In that case, the user manages transactions only using the register payment wizard.
          await pay.set('isMatched', true);
        }
        else {
          await pay.set('isMatched', await currencyId.isZero(sum(await liquidityLines.mapped(residualField))));
        }
        const reconcileLines = await counterpartLines.add(writeoffLines).filtered(async (line) => (await line.accountId).reconcile);
        await pay.set('isReconciled', await currencyId.isZero(sum(await reconcileLines.mapped(residualField))));
      }
    }
  }

  @api.model()
  _getMethodCodesUsingBankAccount() {
    return ['manual'];
  }

  @api.model()
  _getMethodCodesNeedingBankAccount() {
    return [];
  }

  /**
   * Computes if the destination bank account must be displayed in the payment form view. By default, it
      won't be displayed but some modules might change that, depending on the payment type.
   */
  @api.depends('paymentMethodCode')
  async _computeShowRequirePartnerBank() {
    for (const payment of this) {
      const [paymentMethodCode, state] = await payment('paymentMethodCode', 'state');
      await payment.set('showPartnerBankAccount', (await this._getMethodCodesUsingBankAccount()).includes(paymentMethodCode));
      await payment.set('requirePartnerBankAccount', state === 'draft' && (await this._getMethodCodesNeedingBankAccount()).includes(paymentMethodCode));
    }
  }

  @api.depends('amountTotalSigned', 'paymentType')
  async _computeAmountCompanyCurrencySigned() {
    for (const payment of this) {
      const liquidityLines = (await payment._seekForLines())[0];
      await payment.set('amountCompanyCurrencySigned', sum(await liquidityLines.mapped('balance')));
    }
  }

  @api.depends('amount', 'paymentType')
  async _computeAmountSigned() {
    for (const payment of this) {
      const [paymentType, amount] = await payment('paymentType', 'amount');
      if (paymentType === 'outbound') {
        await payment.set('amountSigned', -amount);
      }
      else {
        await payment.set('amountSigned', amount);
      }
    }
  }

  @api.depends('partnerId', 'companyId', 'paymentType', 'destinationJournalId', 'isInternalTransfer')
  async _computeAvailablePartnerBankIds() {
    for (const pay of this) {
      if (await pay.paymentType === 'inbound') {
        await pay.set('availablePartnerBankIds', await (await pay.journalId).bankAccountId);
      }
      else if (await pay.isInternalTransfer) {
        await pay.set('availablePartnerBankIds', await (await pay.destinationJournalId).bankAccountId);
      }
      else {
        await pay.set('availablePartnerBankIds', (await (await (await pay.partnerId).bankIds).filtered(async (x) => [false, (await pay.companyId).id].includes((await x.companyId).id.valueOf())))._origin);
      }
    }
  }

  /**
   * The default partner_bank_id will be the first available on the partner.
   */
  @api.depends('availablePartnerBankIds', 'journalId')
  async _computePartnerBankId() {
    for (const pay of this) {
      await pay.set('partnerBankId', (await pay.availablePartnerBankIds)(0, 1)._origin);
    }
  }

  @api.depends('partnerId', 'journalId', 'destinationJournalId')
  async _computeIsInternalTransfer() {
    for (const payment of this) {
      const partnerId = await payment.partnerId;
      await payment.set('isInternalTransfer', partnerId.ok
        && partnerId.eq(await (await (await payment.journalId).companyId).partnerId)
        && bool(await payment.destinationJournalId));
    }
  }

  /**
   * Compute the 'payment_method_line_id' field.
      This field is not computed in '_computePaymentMethodLineFields' because it's a stored editable one.
   */
  @api.depends('availablePaymentMethodLineIds')
  async _computePaymentMethodLineId() {
    for (const pay of this) {
      const [paymentMethodLineId, availablePaymentMethodLines] = await pay('paymentMethodLineId', 'availablePaymentMethodLineIds');

      // Select the first available one by default.
      if (availablePaymentMethodLines.includes(paymentMethodLineId)) {
        await pay.set('paymentMethodLineId', paymentMethodLineId);
      }
      else if (availablePaymentMethodLines) {
        await pay.set('paymentMethodLineId', availablePaymentMethodLines[0]._origin);
      }
      else {
        await pay.set('paymentMethodLineId', false);
      }
    }
  }

  @api.depends('paymentType', 'journalId', 'currencyId')
  async _computePaymentMethodLineFields() {
    for (const pay of this) {
      await pay.set('availablePaymentMethodLineIds', await (await pay.journalId)._getAvailablePaymentMethodLines(await pay.paymentType));
      const toExclude = pay._getPaymentMethodCodesToExclude();
      if (bool(toExclude)) {
        await pay.set('availablePaymentMethodLineIds', await (await pay.availablePaymentMethodLineIds).filtered(async (x) => !toExclude.includes(await x.code)));
      }
      const availablePaymentMethodLineIds = await pay.availablePaymentMethodLineIds;
      if (!availablePaymentMethodLineIds.ids.includes((await pay.paymentMethodLineId).id)) {
        // In some cases, we could be linked to a payment method line that has been unlinked from the journal.
        // In such cases, we want to show it on the payment.
        await pay.set('hidePaymentMethodLine', false);
      }
      else {
        await pay.set('hidePaymentMethodLine', len(availablePaymentMethodLineIds) == 1 && await availablePaymentMethodLineIds.code === 'manual');
      }
    }
  }

  _getPaymentMethodCodesToExclude() {
    // can be overriden to exclude payment methods based on the payment characteristics
    this.ensureOne();
    return [];
  }

  @api.depends('journalId')
  async _computeCurrencyId() {
    for (const pay of this) {
      const [journalId, companyId] = await pay('journalId', 'companyId');
      const currencyId = await journalId.currencyId;
      await pay.set('currencyId', currencyId.ok ? currencyId : await companyId.currencyId);
    }
  }

  @api.depends('isInternalTransfer')
  async _computePartnerId() {
    for (const pay of this) {
      const journalId = await pay.journalId;
      const companyId = await journalId.companyId;
      if (await pay.isInternalTransfer) {
        await pay.set('partnerId', await companyId.partnerId);
      }
      else if ((await pay.partnerId).eq(await companyId.partnerId)) {
        await pay.set('partnerId', false);
      }
      else {
        await pay.set('partnerId', await pay.partnerId);
      }
    }
  }

  @api.depends('journalId', 'paymentType', 'paymentMethodLineId')
  async _computeOutstandingAccountId() {
    for (const pay of this) {
      const paymentAccountId = await (await pay.paymentMethodLineId).paymentAccountId;
      if (await pay.paymentType === 'inbound') {
        await pay.set('outstandingAccountId', paymentAccountId.ok ? paymentAccountId
          : await (await (await pay.journalId).companyId).accountJournalPaymentDebitAccountId);
      }
      else if (await pay.paymentType === 'outbound') {
        await pay.set('outstandingAccountId', paymentAccountId.ok ? paymentAccountId
          : await (await (await pay.journalId).companyId).accountJournalPaymentCreditAccountId);
      }
      else {
        await pay.set('outstandingAccountId', false);
      }
    }
  }

  @api.depends('journalId', 'partnerId', 'partnerType', 'isInternalTransfer')
  async _computeDestinationAccountId() {
    await this.set('destinationAccountId', false);
    for (const pay of this) {
      const [isInternalTransfer, partnerType, partnerId, companyId] = await pay('isInternalTransfer', 'partnerType', 'partnerId', 'companyId');
      if (isInternalTransfer) {
        await pay.set('destinationAccountId', await (await (await pay.journalId).companyId).transferAccountId);
      }
      else if (partnerType === 'customer') {
        // Receive money from invoice or send money to refund it.
        if (partnerId.ok) {
          await pay.set('destinationAccountId', await (await partnerId.withCompany(companyId)).propertyAccountReceivableId);
        }
        else {
          await pay.set('destinationAccountId', await this.env.items('account.account').search([
            ['companyId', '=', companyId.id],
            ['internalType', '=', 'receivable'],
            ['deprecated', '=', false],
          ], { limit: 1 }));
        }
      }
      else if (partnerType === 'supplier') {
        // Send money to pay a bill or receive money to refund it.
        if (partnerId.ok) {
          await pay.set('destinationAccountId', await (await partnerId.withCompany(companyId)).propertyAccountPayableId);
        }
        else {
          await pay.set('destinationAccountId', await this.env.items('account.account').search([
            ['companyId', '=', companyId.id],
            ['internalType', '=', 'payable'],
            ['deprecated', '=', false],
          ], { limit: 1 }));
        }
      }
    }
  }

  @api.depends('partnerBankId', 'amount', 'ref', 'currencyId', 'journalId', 'moveId.state',
    'paymentMethodLineId', 'paymentType')
  async _computeQrCode() {
    for (const pay of this) {
      const [state, partnerBankId, paymentMethodLineId, paymentType, currencyId, amount, ref, partnerId] = await pay('state', 'partnerBankId', 'paymentMethodLineId', 'paymentType', 'currencyId', 'amount', 'ref', 'partnerId');
      if (['draft', 'posted'].includes(state)
        && partnerBankId.ok
        && await paymentMethodLineId.code === 'manual'
        && paymentType === 'outbound'
        && currencyId.ok) {
        let qrCode;
        if (partnerBankId.ok) {
          qrCode = await partnerBankId.buildQrCodeBase64(amount, ref, ref, currencyId, partnerId);
        }
        if (qrCode) {
          await pay.set('qrCode', _f(`
                        <br/>
                        <img class="border border-dark rounded" src="{qrCode}"/>
                        <br/>
                        <strong class="text-center">{txt}</strong>
                        `, { txt: await this._t('Scan me with your banking app.'), qrCode: qrCode })
          );
          continue;
        }
      }
      await pay.set('qrCode', null);
    }
  }

  /**
   * Retrieve the invoices reconciled to the payments through the reconciliation (account.partial.reconcile).
   * @returns 
   */
  @api.depends('moveId.lineIds.matchedDebitIds', 'moveId.lineIds.matchedCreditIds')
  async _computeStatButtonsFromReconciliation() {
    const storedPayments = await this.filtered('id');
    if (!bool(storedPayments)) {
      await this.update({
        reconciledInvoiceIds: false,
        reconciledInvoicesCount: 0,
        reconciledInvoicesType: '',
        reconciledBillIds: false,
        reconciledBillsCount: 0,
        reconciledStatementIds: false,
        reconciledStatementsCount: 0
      });
      return;
    }
    await this.env.items('account.payment').flush(['moveId', 'outstandingAccountId']);
    await this.env.items('account.move').flush(['moveType', 'paymentId', 'statementLineId']);
    await this.env.items('account.move.line').flush(['moveId', 'accountId', 'statementLineId']);
    await this.env.items('account.partial.reconcile').flush(['debitMoveId', 'creditMoveId']);

    let result = await this._cr.execute(_f(`
            SELECT
                payment.id,
                ARRAY_AGG(DISTINCT invoice.id) AS "invoiceIds",
                invoice."moveType"
            FROM "accountPayment" payment
            JOIN "accountMove" move ON move.id = payment."moveId"
            JOIN "accountMoveLine" line ON line."moveId" = move.id
            JOIN "accountPartialReconcile" part ON
                part."debitMoveId" = line.id
                OR
                part."creditMoveId" = line.id
            JOIN "accountMoveLine" partline ON
                part."debitMoveId" = partline.id
                OR
                part."creditMoveId" = partline.id
            JOIN "accountMove" invoice ON invoice.id = partline."moveId"
            JOIN "accountAccount" account ON account.id = line."accountId"
            WHERE account."internalType" IN ('receivable', 'payable')
                AND payment.id IN ({paymentIds})
                AND line.id != partline.id
                AND invoice."moveType" in ('outInvoice', 'outRefund', 'inInvoice', 'inRefund', 'outReceipt', 'inReceipt')
            GROUP BY payment.id, invoice."moveType"
        `, {
      'paymentIds': String(storedPayments.ids)
    }));
    await this.update({
      reconciledInvoiceIds: false,
      reconciledInvoicesCount: false,
      reconciledBillIds: false,
      reconciledBillsCount: false
    });
    for (const row of result) {
      const pay = this.browse(row['id']);
      if ((await this.env.items('account.move').getSaleTypes(true)).includes(row['moveType'])) {
        await pay.set('reconciledInvoiceIds', (await pay.reconciledInvoiceIds).add(this.env.items('account.move').browse(row['invoiceIds'] ?? [])));
        await pay.set('reconciledInvoicesCount', len(row['invoiceIds'] ?? []));
      }
      else {
        await pay.set('reconciledBillIds', (await pay.reconciledBillIds).add(this.env.items('account.move').browse(row['invoiceIds'] ?? [])));
        await pay.set('reconciledBillsCount', len(row['invoiceIds'] ?? []));
      }
    }
    result = await this._cr.execute(_f(`
            SELECT
                payment.id,
                ARRAY_AGG(DISTINCT partline."statementId") AS "statementIds"
            FROM "accountPayment" payment
            JOIN "accountMove" move ON move.id = payment."moveId"
            JOIN "accountMoveLine" line ON line."moveId" = move.id
            JOIN "accountAccount" account ON account.id = line."accountId"
            JOIN "accountPartialReconcile" part ON
                part."debitMoveId" = line.id
                OR
                part."creditMoveId" = line.id
            JOIN "accountMoveLine" partline ON
                part."debitMoveId" = partline.id
                OR
                part."creditMoveId" = partline.id
            WHERE account.id = payment."outstandingAccountId"
                AND payment.id IN ({paymentIds})
                AND line.id != partline.id
                AND partline."statementId" IS NOT NULL
            GROUP BY payment.id
        `, {
      'paymentIds': String(storedPayments.ids)
    }));
    result = Object.fromEntries(result.map(row => [row['id'], row['statementIds']]));

    for (const pay of this) {
      const statementIds = result[pay.id] ?? [];
      await pay.set('reconciledStatementIds', [[6, 0, statementIds]]);
      await pay.set('reconciledStatementsCount', len(statementIds));
      const reconciledInvoiceIds = await pay.reconciledInvoiceIds;
      if (len(await reconciledInvoiceIds.mapped('moveType')) == 1 && await reconciledInvoiceIds[0].moveType === 'outRefund') {
        await pay.set('reconciledInvoicesType', 'creditNote');
      }
      else {
        await pay.set('reconciledInvoicesType', 'invoice');
      }
    }
  }

  // ONCHANGE METHODS

  @api.onchange('postedBefore', 'state', 'journalId', 'date')
  async _onchangeJournalDate() {
    // Before the record is created, the moveId doesn't exist yet, and the name will not be
    // recomputed correctly if we change the journal or the date, leading to inconsitencies
    if (!bool(await this['moveId'])) {
      await this.set('label', false);
    }
  }

  @api.onchange('journalId')
  async _onchangeJournal() {
    await (await this['moveId'])._onchangeJournal();
  }

  // CONSTRAINT METHODS

  /**
   * Ensure the 'payment_method_line_id' field is not null.
      Can't be done using the regular 'required: true' because the field is a computed editable stored one.
   */
  @api.constrains('paymentMethodLineId')
  async _checkPaymentMethodLineId() {
    for (const pay of this) {
      if (!bool(await pay.paymentMethodLineId)) {
        throw new ValidationError(await this._t("Please define a payment method line on your payment."));
      }
    }

  }

  // LOW-LEVEL METHODS

  @api.model()
  async fieldsViewGet(viewId?: any, viewType: string = 'form', toolbar: boolean = false, submenu: boolean = false) {
    // OVERRIDE to add the 'available_partner_bank_ids' field dynamically inside the view.
    // TO BE REMOVED IN MASTER
    const res = await _super(AccountPayment, this).fieldsViewGet(viewId, viewType, toolbar, submenu);
    if (viewType === 'form') {
      const formViewId = await this.env.items('ir.model.data')._xmlidToResId('account.viewAccountPaymentForm');
      if (res['viewId'] === formViewId) {
        const tree = res['dom'];
        if (len(xpath.select('//field[@name="availablePartnerBankIds"]', tree)) == 0) {
          // Don't force people to update the account module.
          const formView = await this.env.ref('account.viewAccountPaymentForm');
          const archTree = getrootXml(parseXml(await formView.arch));
          if (archTree.tagName === 'form') {
            const newNode = E.withType('field', {
              'name': 'availablePartnerBankIds',
              'invisible': '1',
            })
            if (archTree.firstChild) {
              archTree.insertBefore(newNode, archTree.firstChild);
            }
            else {
              archTree.appendChild(newNode);
            }
            await (await formView.sudo()).write({ 'arch': serializeXml(archTree, 'unicode') });
            return _super(AccountPayment, this).fieldsViewGet(viewId, viewType, toolbar, submenu);
          }
        }
      }
    }
    return res;
  }

  @api.modelCreateMulti()
  async create(valsList) {
    // OVERRIDE
    const writeOffLineValsList = [];

    for (const vals of valsList) {

      // Hack to add a custom write-off line.
      writeOffLineValsList.push(pop(vals, 'writeOffLineVals', null));

      // Force the moveType to avoid inconsistency with residual 'default_moveType' inside the context.
      vals['moveType'] = 'entry';

      // Force the computation of 'journalId' since this field is set on account.move but must have the
      // bank/cash type.
      if (!('journalId' in vals)) {
        vals['journalId'] = (await this._getDefaultJournal()).id;
      }

      // Since 'currencyId' is a computed editable field, it will be computed later.
      // Prevent the account.move to call the _get_default_currency method that could throw new
      // the 'Please define an accounting miscellaneous journal in your company' error.
      if (!('currencyId' in vals)) {
        const journal = this.env.items('account.journal').browse(vals['journalId']);
        let id = (await journal.currencyId).id;
        if (!bool(id)) {
          id = (await (await journal.companyId).currencyId).id;
        }
        vals['currencyId'] = id;
      }
    }
    const payments = await _super(AccountPayment, this).create(valsList);

    for (const [i, pay] of enumerate(payments)) {
      const writeOffLineVals = writeOffLineValsList[i];

      // Write payment_id on the journal entry plus the fields being stored in both models but having the same
      // name, e.g. partner_bank_id. The ORM is currently not able to perform such synchronization and make things
      // more difficult by creating related fields on the fly to handle the _inherits.
      // Then, when partner_bank_id is in vals, the key is consumed by account.payment but is never written on
      // account.move.
      const toWrite = { 'paymentId': pay.id };
      const moveId = await pay.moveId;
      for (const [k, v] of Object.entries(valsList[i])) {
        if (k in this._fields && this._fields[k].store && k in moveId._fields && moveId._fields[k].store) {
          toWrite[k] = v;
        }
      }
      if (!('lineIds' in valsList[i])) {
        toWrite['lineIds'] = (await pay._prepareMoveLineDefaultVals(writeOffLineVals)).map(lineVals => [0, 0, lineVals]);
      }

      await moveId.write(toWrite);
    }

    return payments;
  }

  async write(vals) {
    // OVERRIDE
    const res = await _super(AccountPayment, this).write(vals);
    await this._synchronizeToMoves(Object.keys(vals));
    return res;
  }

  async unlink() {
    // OVERRIDE to unlink the inherited account.move (moveId field) as well.
    const moves = await (await this.withContext({ forceDelete: true })).moveId;
    const res = await _super(AccountPayment, this).unlink();
    await moves.unlink();
    return res;
  }

  @api.depends('moveId.label')
  async nameGet() {
    return this.map(async (payment) => {
      const label = await (await payment.moveId).label;
      return [payment.id, label !== '/' && label || await this._t('Draft Payment')];
    });
  }

  // SYNCHRONIZATION account.payment <-> account.move

  /**
   * Update the account.payment regarding its related account.move.
      Also, check both models are still consistent.
      :param changed_fields: A set containing all modified fields on account.move.
   * @param changedFields 
   * @returns 
   */
  async _synchronizeFromMoves(changedFields) {
    if (this._context['skipAccountMoveSynchronization']) {
      return;
    }

    for (const pay of await this.withContext({ skipAccountMoveSynchronization: true })) {

      // After the migration to 14.0, the journal entry could be shared between the account.payment and the
      // account.bank.statement.line. In that case, the synchronization will only be made with the statement line.
      const move = await pay.moveId
      if (bool(await move.statementLineId)) {
        continue;
      }

      const moveValsToWrite = {};
      const paymentValsToWrite = {};

      if ('journalId' in changedFields) {
        if (!['bank', 'cash'].includes(await (await pay.journalId).type)) {
          throw new UserError(await this._t("A payment must always belongs to a bank or cash journal."));
        }
      }
      if ('lineIds' in changedFields) {
        const [allLines, displayName] = await move('lineIds', 'displayName');
        const [liquidityLines, counterpartLines, writeoffLines] = await pay._seekForLines();

        if (len(liquidityLines) != 1) {
          throw new UserError(await this._t(
            "Journal Entry %s is not valid. In order to proceed, the journal items must include one and only one outstanding payments/receipts account.",
            displayName,
          ));
        }

        if (len(counterpartLines) != 1) {
          throw new UserError(await this._t(
            "Journal Entry %s is not valid. In order to proceed, the journal items must include one and only one receivable/payable account (with an exception of internal transfers).",
            displayName,
          ));
        }

        if (bool(writeoffLines) && len(await writeoffLines.accountId) != 1) {
          throw new UserError(await this._t(
            "Journal Entry %s is not valid. In order to proceed, all optional journal items must share the same account.", displayName,
          ));
        }

        if (await allLines.some(async (line) => !(await line.currencyId).eq(await allLines[0].currencyId))) {
          throw new UserError(await this._t(
            "Journal Entry %s is not valid. In order to proceed, the journal items must share the same currency.", displayName,
          ));
        }

        if (await allLines.soem(async (line) => !(await line.partnerId).eq(await allLines[0].partnerId))) {
          throw new UserError(await this._t(
            "Journal Entry %s is not valid. In order to proceed, the journal items must share the same partner.", displayName,
          ));
        }

        let partnerType;
        if (await (await (await counterpartLines.accountId).userTypeId).type === 'receivable') {
          partnerType = 'customer';
        }
        else {
          partnerType = 'supplier';
        }

        const liquidityAmount = await liquidityLines.amountCurrency;

        update(moveValsToWrite, {
          'currencyId': (await liquidityLines.currencyId).id,
          'partnerId': (await liquidityLines.partnerId).id,
        })
        update(paymentValsToWrite, {
          'amount': Math.abs(liquidityAmount),
          'partnerType': partnerType,
          'currencyId': (await liquidityLines.currencyId).id,
          'destinationAccountId': (await counterpartLines.accountId).id,
          'partnerId': (await liquidityLines.partnerId).id,
        })
        if (liquidityAmount > 0.0) {
          update(paymentValsToWrite, { 'paymentType': 'inbound' });
        }
        else if (liquidityAmount < 0.0) {
          update(paymentValsToWrite, { 'paymentType': 'outbound' });
        }
      }

      await move.write(await move._cleanupWriteOrmValues(move, moveValsToWrite));
      await pay.write(await move._cleanupWriteOrmValues(pay, paymentValsToWrite));
    }
  }

  /**
   * Update the account.move regarding the modified account.payment.
      :param changed_fields: A list containing all modified fields on account.payment.
   * @param changedFields 
   * @returns 
   */
  async _synchronizeToMoves(changedFields) {
    if (this._context['skipAccountMoveSynchronization']) {
      return;
    }

    if (!['date', 'amount', 'paymentType', 'partnerType', 'paymentReference', 'isInternalTransfer',
      'currencyId', 'partnerId', 'destinationAccountId', 'partnerBankId', 'journalId'].some(name => changedFields.includes(name))) {
      return;
    }

    for (const pay of await this.withContext({ skipAccountMoveSynchronization: true })) {
      const [liquidityLines, counterpartLines, writeoffLines] = await pay._seekForLines();

      // Make sure to preserve the write-off amount.
      // This allows to create a new payment with custom 'lineIds'.
      let writeOffLineVals;
      if (bool(liquidityLines) && bool(counterpartLines) && bool(writeoffLines)) {
        const counterpartAmount = sum(await counterpartLines.mapped('amountCurrency'));
        let writeoffAmount = sum(await writeoffLines.mapped('amountCurrency'));

        // To be consistent with the payment_difference made in account.payment.register,
        // 'writeoff_amount' needs to be signed regarding the 'amount' field before the write.
        // Since the write is already done at this point, we need to base the computation on accounting values.
        let sign;
        if ((counterpartAmount > 0.0) == (writeoffAmount > 0.0)) {
          sign = -1;
        }
        else {
          sign = 1;
        }
        writeoffAmount = Math.abs(writeoffAmount) * sign;

        writeOffLineVals = {
          'label': await writeoffLines[0].label,
          'amount': writeoffAmount,
          'accountId': (await writeoffLines[0].accountId).id,
        }
      }
      else {
        writeOffLineVals = {};
      }

      const lineValsList = await pay._prepareMoveLineDefaultVals(writeOffLineVals);

      const lineIdsCommands: any[] = [
        bool(liquidityLines) ? Command.update(liquidityLines.id, lineValsList[0]) : Command.create(lineValsList[0]),
        bool(counterpartLines) ? Command.update(counterpartLines.id, lineValsList[1]) : Command.create(lineValsList[1])
      ]

      for (const line of writeoffLines) {
        lineIdsCommands.push([2, line.id]);
      }
      for (const extraLineVals of lineValsList.slice(2)) {
        lineIdsCommands.push([0, 0, extraLineVals]);
      }

      // Update the existing journal items.
      // If dealing with multiple write-off lines, they are dropped and a new one is generated.

      await (await pay.moveId).write({
        'partnerId': (await pay.partnerId).id,
        'currencyId': (await pay.currencyId).id,
        'partnerBankId': (await pay.partnerBankId).id,
        'lineIds': lineIdsCommands,
      });
    }
  }

  /**
   * When an internal transfer is posted, a paired payment is created
      with opposite payment_type and swapped journalId & destination_journal_id.
      Both payments liquidity transfer lines are then reconciled.
   * @returns 
   */
  async _createPairedInternalTransferPayment() {
    for (const payment of this) {
      const pairedPayment = await payment.copy({
        'journalId': (await payment.destinationJournalId).id,
        'destinationJournalId': (await payment.journalId).id,
        'paymentType': await payment.paymentType === 'outbound' ? 'inbound' : 'outbound',
        'moveId': null,
        'ref': await payment.ref,
        'pairedInternalTransferPaymentId': payment.id,
        'date': await payment.date,
      })
      await (await pairedPayment.moveId)._post(false);
      await payment.set('pairedInternalTransferPaymentId', pairedPayment);

      let body = await this._t('This payment has been created from <a href=# data-oe-model=account.payment data-oe-id=%s>%s</a>', payment.id, await payment.label);
      await pairedPayment.messagePost(body);
      body = await this._t('A second payment has been created: <a href=# data-oe-model=account.payment data-oe-id=%s>%s</a>', pairedPayment.id, await pairedPayment.label);
      await payment.messagePost(body);

      const lines = await (await (await payment.moveId).lineIds).add(await (await pairedPayment.moveId).lineIds).filtered(async (l) => (await l.accountId).eq(await payment.destinationAccountId) && ! await l.reconciled);
      await lines.reconcile();
    }
  }

  // BUSINESS METHODS

  async markAsSent() {
    await this.write({ 'isMoveSent': true });
  }

  async unmarkAsSent() {
    await this.write({ 'isMoveSent': false });
  }

  /**
   * draft -> posted
   */
  async actionPost() {
    await (await this['moveId'])._post(false);

    await (await this.filtered(
      async (pay) => await pay.isInternalTransfer && !bool(await pay.pairedInternalTransferPaymentId)
    ))._createPairedInternalTransferPayment();
  }

  /**
   * draft -> cancelled
   */
  async actionCancel() {
    await (await this['moveId']).buttonCancel();
  }

  /**
   * posted -> draft
   */
  async actionDraft() {
    await (await this['moveId']).buttonDraft();
  }

  /**
   * Redirect the user to the invoice(s) paid by this payment.
      :return:    An action on account.move.
   * @returns 
   */
  async buttonOpenInvoices() {
    this.ensureOne();

    const action = {
      'label': await this._t("Paid Invoices"),
      'type': 'ir.actions.actwindow',
      'resModel': 'account.move',
      'context': { 'create': false },
    }
    const reconciledInvoiceIds = await this['reconciledInvoiceIds'];
    if (len(reconciledInvoiceIds) === 1) {
      update(action, {
        'viewMode': 'form',
        'resId': reconciledInvoiceIds.id,
      });
    }
    else {
      update(action, {
        'viewMode': 'list,form',
        'domain': [['id', 'in', reconciledInvoiceIds.ids]],
      });
    }
    return action;
  }

  /**
   * Redirect the user to the bill(s) paid by this payment.
      :return:    An action on account.move.
   * @returns 
   */
  async buttonOpenBills() {
    this.ensureOne();

    const action = {
      'label': await this._t("Paid Bills"),
      'type': 'ir.actions.actwindow',
      'resModel': 'account.move',
      'context': { 'create': false },
    }
    const reconciledBillIds = await this['reconciledBillIds'];
    if (len(reconciledBillIds) == 1) {
      update(action, {
        'viewMode': 'form',
        'resId': reconciledBillIds.id,
      });
    }
    else {
      update(action, {
        'viewMode': 'list,form',
        'domain': [['id', 'in', reconciledBillIds.ids]],
      })
    }
    return action;
  }

  /**
   * Redirect the user to the statement line(s) reconciled to this payment.
      :return:    An action on account.move.
   * @returns 
   */
  async buttonOpenStatements() {
    this.ensureOne();

    const action = {
      'label': await this._t("Matched Statements"),
      'type': 'ir.actions.actwindow',
      'resModel': 'account.bank.statement',
      'context': { 'create': false },
    }
    const reconciledStatementIds = await this['reconciledStatementIds'];
    if (len(reconciledStatementIds) == 1) {
      update(action, {
        'viewMode': 'form',
        'resId': reconciledStatementIds.id,
      });
    }
    else {
      update(action, {
        'viewMode': 'list,form',
        'domain': [['id', 'in', reconciledStatementIds.ids]],
      });
    }
    return action;
  }

  /**
   * Redirect the user to this payment journal.
      :return:    An action on account.move.
   * @returns 
   */
  async buttonOpenJournalEntry() {
    this.ensureOne();
    return {
      'label': await this._t("Journal Entry"),
      'type': 'ir.actions.actwindow',
      'resModel': 'account.move',
      'context': { 'create': false },
      'viewMode': 'form',
      'resId': (await this['moveId']).id,
    }
  }

  /**
   * Redirect the user to this destination journal.
      :return:    An action on account.move.
   */
  async actionOpenDestinationJournal() {
    this.ensureOne();

    const action = {
      'label': await this._t("Destination journal"),
      'type': 'ir.actions.actwindow',
      'resModel': 'account.journal',
      'context': { 'create': false },
      'viewMode': 'form',
      'target': 'new',
      'resId': (await this['destinationJournalId']).id,
    }
    return action;
  }
}