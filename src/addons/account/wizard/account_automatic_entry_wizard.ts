import _ from "lodash";
import { Fields, _Date, api } from "../../../core";
import { Dict } from "../../../core/helper/collections";
import { UserError, ValidationError } from "../../../core/helper/errors";
import { MetaModel, TransientModel, _super } from "../../../core/models";
import { _f, bool, extend, f, formatDate, formatLang, groupbyAsync, len, remove, sum, update } from "../../../core/tools";
import { stringify } from "../../../core/tools/json";

@MetaModel.define()
class AutomaticEntryWizard extends TransientModel {
  static _module = module;
  static _name = 'account.automatic.entry.wizard';
  static _description = 'Create Automatic Entries';

  // General
  static action = Fields.Selection([['changePeriod', 'Change Period'], ['changeAccount', 'Change Account']], { required: true });
  static moveData = Fields.Text({ compute: "_computeMoveData", help: "JSON value of the moves to be created" });
  static previewMoveData = Fields.Text({ compute: "_computePreviewMoveData", help: "JSON value of the data to be displayed in the previewer" });
  static moveLineIds = Fields.Many2many('account.move.line');
  static date = Fields.Date({ required: true, default: self => _Date.contextToday(self) });
  static companyId = Fields.Many2one('res.company', { required: true, readonly: true });
  static companyCurrencyId = Fields.Many2one('res.currency', { related: 'companyId.currencyId' });
  static percentage = Fields.Float("Percentage", { compute: '_computePercentage', readonly: false, store: true, help: "Percentage of each line to execute the action on." });
  static totalAmount = Fields.Monetary({ compute: '_computeTotalAmount', store: true, readonly: false, currencyField: 'companyCurrencyId', help: "Total amount impacted by the automatic entry." });
  static journalId = Fields.Many2one('account.journal', {
    required: true, readonly: false, string: "Journal",
    domain: "[['companyId', '=', companyId], ['type', '=', 'general']]",
    compute: "_computeJournalId",
    inverse: "_inverseJournalId",
    help: "Journal where to create the entry."
  });

  // change period
  static accountType = Fields.Selection([['income', 'Revenue'], ['expense', 'Expense']], { compute: '_computeAccountType', store: true });
  static expenseAccrualAccount = Fields.Many2one('account.account', {
    readonly: false,
    domain: `[['companyId', '=', companyId],
               ['internalType', 'not in', ['receivable', 'payable']],
               ['isOffBalance', '=', false]]`,
    compute: "_computeExpenseAccrualAccount",
    inverse: "_inverseExpenseAccrualAccount",
  });
  static revenueAccrualAccount = Fields.Many2one('account.account', {
    readonly: false,
    domain: `[['companyId', '=', companyId],
               ['internalType', 'not in', ['receivable', 'payable']],
               ['isOffBalance', '=', false]]`,
    compute: "_computeRevenueAccrualAccount",
    inverse: "_inverseRevenueAccrualAccount",
  });

  // change account
  static destinationAccountId = Fields.Many2one({ string: "To", comodelName: 'account.account', help: "Account to transfer to." });
  static displayCurrencyHelper = Fields.Boolean({
    string: "Currency Conversion Helper", compute: '_computeDisplayCurrencyHelper',
    help: "Technical field. Used to indicate whether or not to display the currency conversion tooltip. The tooltip informs a currency conversion will be performed with the transfer."
  });

  @api.depends('companyId')
  async _computeExpenseAccrualAccount() {
    for (const record of this) {
      await record.set('expenseAccrualAccount', await (await record.companyId).expenseAccrualAccountId);
    }
  }

  async _inverseExpenseAccrualAccount() {
    for (const record of this) {
      await (await (await record.companyId).sudo()).set('expenseAccrualAccountId', await record.expenseAccrualAccount);
    }
  }

  @api.depends('companyId')
  async _computeRevenueAccrualAccount() {
    for (const record of this) {
      await record.set('revenueAccrualAccount', await (await record.companyId).revenueAccrualAccountId);
    }
  }

  async _inverseRevenueAccrualAccount() {
    for (const record of this) {
      await (await (await record.companyId).sudo()).set('revenueAccrualAccountId', await record.revenueAccrualAccount);
    }
  }

  @api.depends('companyId')
  async _computeJournalId() {
    for (const record of this) {
      await record.set('journalId', await (await record.companyId).automaticEntryDefaultJournalId);
    }
  }

  async _inverseJournalId() {
    for (const record of this) {
      await (await (await record.companyId).sudo()).set('automaticEntryDefaultJournalId', await record.journalId);
    }
  }

  @api.constrains('percentage', 'action')
  async _constraintPercentage() {
    for (const record of this) {
      const [percentage, action] = await record('percentage', 'action');
      if (!(0.0 < percentage && percentage <= 100.0) && action === 'changePeriod') {
        throw new UserError(await this._t("Percentage must be between 0 and 100"));
      }
    }
  }

  @api.depends('percentage', 'moveLineIds')
  async _computeTotalAmount() {
    for (const record of this) {
      await record.set('totalAmount', (await record.percentage || 100) * sum(await (await record.moveLineIds).mapped('balance')) / 100);
    }
  }

  @api.depends('totalAmount', 'moveLineIds')
  async _computePercentage() {
    for (const record of this) {
      const total = (sum(await (await record.moveLineIds).mapped('balance')) || await record.totalAmount);
      if (total != 0) {
        await record.set('percentage', Math.min((await record.totalAmount / total) * 100, 100));  // min() to avoid value being slightly over 100 due to rounding error;
      }
      else {
        await record.set('percentage', 100);
      }
    }
  }

  @api.depends('moveLineIds')
  async _computeAccountType() {
    for (const record of this) {
      await record.set('accountType', sum(await (await record.moveLineIds).mapped('balance')) < 0 ? 'income' : 'expense');
    }
  }

  @api.depends('destinationAccountId')
  async _computeDisplayCurrencyHelper() {
    for (const record of this) {
      await record.set('displayCurrencyHelper', bool(await (await record.destinationAccountId).currencyId));
    }
  }

  @api.constrains('date', 'moveLineIds')
  async _checkDate() {
    for (const wizard of this) {
      const moveId = await (await wizard.moveLineIds).moveId;
      if (bool(await moveId._getViolatedLockDates(await wizard.date, false))) {
        throw new ValidationError(await this._t("The date selected is protected by a lock date"));
      }

      if (await wizard.action === 'changePeriod') {
        for (const m of moveId) {
          if (bool(await m._getViolatedLockDates(await m.date, false))) {
            throw new ValidationError(await this._t("The date of some related entries is protected by a lock date"));
          }
        }
      }
    }
  }

  @api.model()
  async defaultGet(fields) {
    const res = await _super(AutomaticEntryWizard, this).defaultGet(fields);
    if (!_.intersection(fields, ['moveLineIds', 'companyId']).length) {
      return res;
    }

    if (this.env.context['activeModel'] !== 'account.move.line' || !this.env.context['activeIds']) {
      throw new UserError(await this._t('This can only be used on journal items'));
    }
    const moveLineIds = this.env.items('account.move.line').browse(this.env.context['activeIds']);
    res['moveLineIds'] = [[6, 0, moveLineIds.ids]];

    if (await (await moveLineIds.mapped('moveId')).some(async (move) => await move.state !== 'posted')) {
      throw new UserError(await this._t('You can only change the period/account for posted journal items.'));
    }
    if (await (await moveLineIds.mapped('moveId')).some(async (move) => move.reconciled)) {
      throw new UserError(await this._t('You can only change the period/account for items that are not yet reconciled.'));
    }
    if (await (await moveLineIds.mapped('moveId')).some(async (move) => !(await move.companyId).eq(await moveLineIds[0].companyId))) {
      throw new UserError(await this._t('You cannot use this wizard on journal entries belonging to different companies.'));
    }
    res['companyId'] = (await moveLineIds[0].companyId).id;

    let allowedActions = Object.keys(this._fields['action'].selection);
    if (this.env.context['default_action']) {
      allowedActions = Array.from(this.env.context['default_action']);
    }
    if (await moveLineIds.some(async (line) => !(await (await line.accountId).userTypeId).eq(await (await moveLineIds[0].accountId).userTypeId))) {
      remove(allowedActions, 'changePeriod');
    }
    if (!bool(allowedActions)) {
      throw new UserError(await this._t('No possible action found with the selected lines.'));
    }
    res['action'] = allowedActions.pop();
    return res;
  }

  async _getMoveDictValsChangeAccount() {
    const lineVals = [];

    // Group data from selected move lines
    const counterpartBalances = new Map<any, any>();
    const groupedSourceLines = new Map<any, any>();// DefaultDict(() => self.env.items('account.move.line']))

    for (const line of await (await this['moveLineIds']).filtered(async (x) => !(await x.accountId).eq(await this['destinationAccountId']))) {
      const counterpartCurrency = await line.currencyId;
      let counterpartAmountCurrency = await line.amountCurrency;

      if ((await (await this['destinationAccountId']).currencyId).ok && !(await (await this['destinationAccountId']).currencyId).eq(await (await this['companyId']).currencyId)) {
        const counterpartCurrency = await (await this['destinationAccountId']).currencyId;
        counterpartAmountCurrency = await (await (await this['companyId']).currencyId)._convert(await line.balance, await (await this['destinationAccountId']).currencyId, await this['companyId'], await line.date);
      }
      const linePartner = await line.partnerId;
      const key = [linePartner.id, counterpartCurrency.id].join('-');
      if (!counterpartBalances.has(key)) {
        counterpartBalances.set(key, [[linePartner, counterpartCurrency], {}]);
      }
      const counterpartBalancesByKey = counterpartBalances.get(key)[1];
      counterpartBalancesByKey['amountCurrency'] += counterpartAmountCurrency;
      counterpartBalancesByKey['balance'] += await line.balance;
      const keys = await line('partnerId', 'currencyId', 'accountId');
      const strId = keys.map(k => k.id).join('-');
      if (!groupedSourceLines.has(strId)) {
        groupedSourceLines.set(strId, [keys, this.env.items('account.move.line')]);
      }
      groupedSourceLines[strId][1] = groupedSourceLines[strId][1].add(line);
    }

    // Generate counterpart lines' vals
    const currencyId = await (await this['companyId']).currencyId;
    for (const [[counterpartPartner, counterpartCurrency], counterpartVals] of counterpartBalances.values()) {
      const sourceAccounts = await (await this['moveLineIds']).mapped('accountId');
      const counterpartLabel = len(sourceAccounts) == 1 ? await this._t("Transfer from %s", await sourceAccounts.displayName) : await this._t("Transfer counterpart");

      if (! await counterpartCurrency.isZero(counterpartVals['amountCurrency'])) {
        lineVals.push({
          'label': counterpartLabel,
          'debit': counterpartVals['balance'] > 0 ? await currencyId.round(counterpartVals['balance']) : 0,
          'credit': counterpartVals['balance'] < 0 ? await currencyId.round(-counterpartVals['balance']) : 0,
          'accountId': (await this['destinationAccountId']).id,
          'partnerId': bool(counterpartPartner.id) ? counterpartPartner.id : null,
          'amountCurrency': await counterpartCurrency.round((counterpartVals['balance'] < 0 ? -1 : 1) * Math.abs(counterpartVals['amountCurrency'])) || 0,
          'currencyId': counterpartCurrency.id,
        });
      }
    }

    // Generate change_account lines' vals
    for (const [[partner, currency, account], lines] of groupedSourceLines.values()) {
      const accountBalance = await lines.sum((line) => line.balance);
      if (! await currencyId.isZero(accountBalance)) {
        const accountAmountCurrency = await currency.round(await lines.sum(line => line.amountCurrency));
        lineVals.push({
          'label': await this._t('Transfer to %s', await (await this['destinationAccountId']).displayName || await this._t('[Not set]')),
          'debit': accountBalance < 0 ? await currencyId.round(-accountBalance) : 0,
          'credit': accountBalance > 0 ? await currencyId.round(accountBalance) : 0,
          'accountId': account.id,
          'partnerId': bool(partner.id) ? partner.id : null,
          'currencyId': currency.id,
          'amountCurrency': (accountBalance > 0 ? -1 : 1) * Math.abs(accountAmountCurrency),
        });
      }
    }

    const [journalId, destinationAccountId] = await this('journalId', 'destinationAccountId');
    return [{
      'currencyId': bool((await journalId.currencyId).id) ? (await journalId.currencyId).id : (await (await journalId.companyId).currencyId).id,
      'moveType': 'entry',
      'journalId': journalId.id,
      'date': _Date.toString(await this['date']),
      'ref': await destinationAccountId.displayName ? await this._t("Transfer entry to %s", await destinationAccountId.displayName) : '',
      'lineIds': lineVals.map(line => [0, 0, line]),
    }]
  }

  async _getMoveDictValsChangePeriod() {
    // set the change_period account on the selected journal items
    const accrualAccount = await this['accountType'] == 'income' ? await this['revenueAccrualAccount'] : await (this['expenseAccrualAccount']);
    const [journalId, destinationAccountId] = await this('journalId', 'destinationAccountId');
    const moveData = {
      'newDate': {
        'currencyId': bool((await journalId.currencyId).id) ? (await journalId.currencyId).id : (await (journalId.companyId).currencyId).id,
        'moveType': 'entry',
        'lineIds': [],
        'ref': await this._t('Adjusting Entry'),
        'date': _Date.toString(await this['date']),
        'journalId': journalId.id,
      }
    }
    // complete the account.move data
    for (let [date, groupedLines] of await groupbyAsync(await this['moveLineIds'], async (m) => (await m.moveId).date)) {
      groupedLines = Array.from(groupedLines);
      const amount = await groupedLines.reduce(async (sum, line) => {
        sum += await line.balance;
      }, 0);
      moveData[date] = {
        'currencyId': bool((await journalId.currencyId).id) ? (await journalId.currencyId).id : (await (await journalId.companyId).currencyId).id,
        'moveType': 'entry',
        'lineIds': [],
        'ref': await this._formatStrings(await this._t('Adjusting Entry of {date} ({percent}% recognized on {newDate})'), await groupedLines[0].moveId, amount),
        'date': _Date.toString(date),
        'journalId': journalId.id,
      }
    }

    // compute the account.move.lines and the total amount per move
    for (const aml of await this['moveLineIds']) {
      // account.move.line data
      const percentage = await this['percentage']
      const currencyId = await (await aml.companyId).currencyId;
      const reportedDebit = await currencyId.round((percentage / 100) * await aml.debit);
      const reportedCredit = await currencyId.round((percentage / 100) * await aml.credit);
      const reportedAmountCurrency = await (await aml.currencyId).round((percentage / 100) * await aml.amountCurrency);

      extend(moveData['newDate']['lineIds'], [
        [0, 0, {
          'label': await aml.label || '',
          'debit': reportedDebit,
          'credit': reportedCredit,
          'amountCurrency': reportedAmountCurrency,
          'currencyId': (await aml.currencyId).id,
          'accountId': (await aml.accountId).id,
          'partnerId': (await aml.partnerId).id,
        }],
        [0, 0, {
          'label': await this._t('Adjusting Entry'),
          'debit': reportedCredit,
          'credit': reportedDebit,
          'amountCurrency': -reportedAmountCurrency,
          'currencyId': (await aml.currencyId).id,
          'accountId': accrualAccount.id,
          'partnerId': (await aml.partnerId).id,
        }],
      ]);
      extend(moveData[await (await aml.moveId).date]['lineIds'], [
        [0, 0, {
          'label': await aml.label || '',
          'debit': reportedCredit,
          'credit': reportedDebit,
          'amountCurrency': -reportedAmountCurrency,
          'currencyId': (await aml.currencyId).id,
          'accountId': (await aml.accountId).id,
          'partnerId': (await aml.partnerId).id,
        }],
        [0, 0, {
          'label': await this._t('Adjusting Entry'),
          'debit': reportedDebit,
          'credit': reportedCredit,
          'amountCurrency': reportedAmountCurrency,
          'currencyId': (await aml.currencyId).id,
          'accountId': accrualAccount.id,
          'partnerId': (await aml.partnerId).id,
        }],
      ]);
    }

    return Object.values(moveData);
  }

  @api.depends('moveLineIds', 'journalId', 'revenueAccrualAccount', 'expenseAccrualAccount', 'percentage', 'date', 'accountType', 'action', 'destinationAccountId')
  async _computeMoveData() {
    for (const record of this) {
      const action = await record.action;
      if (action === 'changePeriod') {
        if (await (await record.moveLineIds).some(async (line) => !(await (await line.accountId).userTypeId).eq(await (await (await record.moveLineIds)[0].accountId).userTypeId))) {
          throw new UserError(await this._t('All accounts on the lines must be of the same type.'));
        }
      }
      if (action === 'changePeriod') {
        await record.set('moveData', stringify(await record._getMoveDictValsChangePeriod()));
      }
      else if (action === 'changeAccount') {
        await record.set('moveData', stringify(await record._getMoveDictValsChangeAccount()));
      }
    }
  }

  @api.depends('moveData')
  async _computePreviewMoveData() {
    for (const record of this) {
      const previewColumns = [
        { 'field': 'accountId', 'label': await this._t('Account') },
        { 'field': 'label', 'label': await this._t('Label') },
        { 'field': 'debit', 'label': await this._t('Debit'), 'class': 'text-right text-nowrap' },
        { 'field': 'credit', 'label': await this._t('Credit'), 'class': 'text-right text-nowrap' },
      ]
      if (await record.action === 'changeAccount') {
        previewColumns.splice(2, 0, { 'field': 'partnerId', 'label': await this._t('Partner') });
      }

      const moveVals = JSON.parse(await record.moveData);
      let previewVals = [];
      for (const move of moveVals.slic(0, 4)) {
        extend(previewVals, await this.env.items('account.move')._moveDictToPreviewVals(move, await (await record.companyId).currencyId));
      }
      const previewDiscarded = Math.max(0, len(moveVals) - len(previewVals));

      await record.set('previewMoveData', stringify({
        'groupsVals': previewVals,
        'options': {
          'discardedNumber': previewDiscarded ? await this._t("%d moves", previewDiscarded) : false,
          'columns': previewColumns,
        },
      }));
    }
  }

  async doAction() {
    const moveVals = JSON.parse(await this['moveData']);
    if (await this['action'] === 'changePeriod') {
      return this._doActionChangePeriod(moveVals);
    }
    else if (await this['action'] === 'changeAccount') {
      return this._doActionChangeAccount(moveVals);
    }
  }

  async _doActionChangePeriod(moveVals) {
    const accrualAccount = await this['accountType'] === 'income' ? await this['revenueAccrualAccount'] : await this['expenseAccrualAccount'];

    const createdMoves = await this.env.items('account.move').create(moveVals);
    await createdMoves._post();

    const destinationMove = createdMoves[0];
    let destinationMoveOffset = 0;
    const destinationMessages = [];
    const accrualMoveMessages = new Map<any, any>();
    const accrualMoveOffsets = new Map<any, any>();
    const [moveLineIds] = await this('moveLineIds');
    for (const move of await (await this['moveLineIds']).moveId) {
      const amount = sum(await moveLineIds._origin.and(await move.lineIds).mapped('balance'));
      const accrualMove = await createdMoves([1,]).filtered(async (m) => await m.date == await move.date);

      if (await accrualAccount.reconcile && await accrualMove.state === 'posted' && await destinationMove.state === 'posted') {
        const destinationMoveLines = (await (await destinationMove.mapped('lineIds')).filtered(async (line) => (await line.accountId).eq(accrualAccount))).slice(destinationMoveOffset, destinationMoveOffset + 2);
        destinationMoveOffset += 2;
        if (!accrualMoveOffsets.has(accrualMove)) {
          accrualMoveOffsets.set(accrualMove, 0);
        }
        const accrualMoveLines = (await (await accrualMove.mapped('lineIds')).filtered(async (line) => (await line.accountId).eq(accrualAccount))).slice(accrualMoveOffsets.get(accrualMove), accrualMoveOffsets.get(accrualMove) + 2);
        accrualMoveOffsets.set(accrualMove, accrualMoveOffsets.get(accrualMove) + 2);
        await (await accrualMoveLines.add(destinationMoveLines).filtered(async (line) => ! await (await line.currencyId).isZero(await line.balance))).reconcile();
      }
      await move.messagePost({ body: await this._formatStrings(await this._t('Adjusting Entries have been created for this invoice:<ul><li>{link1} cancelling {percent}% of {amount}</li><li>{link0} postponing it to {newDate}</li></ul>', { link0: await this._formatMoveLink(destinationMove), link1: await this._formatMoveLink(accrualMove) }), move, amount) });
      extend(destinationMessages, [await this._formatStrings(await this._t('Adjusting Entry {link}: {percent}% of {amount} recognized from {date}'), move, amount)]);
      if (!accrualMoveMessages.has(accrualMove)) {
        accrualMoveMessages.set(accrualMove, []);
      }
      extend(accrualMoveMessages.get(accrualMove), [await this._formatStrings(await this._t('Adjusting Entry for {link}: {percent}% of {amount} recognized on {newDate}'), move, amount)]);
    }

    await destinationMove.messagePost({ body: destinationMessages.join('<br/>\n') });
    for (const [accrualMove, messages] of accrualMoveMessages) {
      await accrualMove.messagePost({ body: messages.join('<br/>\n') });
    }

    // open the generated entries
    const action = {
      'label': await this._t('Generated Entries'),
      'domain': [['id', 'in', createdMoves.ids]],
      'resModel': 'account.move',
      'viewMode': 'tree,form',
      'type': 'ir.actions.actwindow',
      'views': [[(await this.env.ref('account.viewMoveTree')).id, 'tree'], [false, 'form']],
    }
    if (len(createdMoves) == 1) {
      update(action, { 'viewMode': 'form', 'resId': createdMoves.id });
    }
    return action;
  }

  async _doActionChangeAccount(moveVals) {
    const newMove = await this.env.items('account.move').create(moveVals);
    await newMove._post();

    // Group lines
    const groupedLines = new Dict<any>();//(() => this.env.items('account.move.line'));
    const destinationLines = await (await this['moveLineIds']).filtered(async (x) => (await x.accountId).eq(await this['destinationAccountId']));
    for (const line of (await this['moveLineIds']).sub(destinationLines)) {
      const keys = await line('partnerId', 'currencyId', 'accountId');
      const strId = keys.map(k => k.id).join('-');
      if (!groupedLines.has(strId)) {
        groupedLines[strId] = [keys, this.env.items('account.move.line')];
      }
      groupedLines[strId][1] = groupedLines[strId][1].add(line);
    }
    // Reconcile
    for (const [[partner, currency, account], lines] of groupedLines.values()) {
      if (await account.reconcile) {
        const toReconcile = lines.add(await (await newMove.lineIds).filtered(async (x) => {
          const [xPartner, xCurrency, xAccount] = await x('partnerId', 'currencyId', 'accountId');
          return xAccount.eq(account) && xPartner.eq(partner) && xCurrency.eq(currency);
        }));
        await toReconcile.reconcile();
      }
      if (destinationLines.ok && await (await this['destinationAccountId']).reconcile) {
        const toReconcile = destinationLines.add(await (await newMove.lineIds).filtered(async (x) => {
          const [xPartner, xCurrency, xAccount] = await x('partnerId', 'currencyId', 'accountId');
          return xAccount.eq(await this['destinationAccountId']) && xPartner.eq(partner) && xCurrency.eq(currency);
        }));
        await toReconcile.reconcile();
      }
    }

    // Log the operation on source moves
    const accTransferPerMove = new Map<any, any>();
    for (const line of await this['moveLineIds']) {
      const [moveId, accountId, balance] = await line('moveId', 'accountId', 'balance');
      if (!accTransferPerMove.has(moveId)) {
        accTransferPerMove.set(moveId, new Map<any, any>());
      }
      const accTransferPerMoveAcc = accTransferPerMove.get(moveId);
      if (!accTransferPerMoveAcc.has(accountId)) {
        accTransferPerMoveAcc.set(accountId, 0);
      }
      accTransferPerMoveAcc.set(accountId, accTransferPerMoveAcc.get(accountId) + balance);
    }

    for (const [move, balancesPerAccount] of accTransferPerMove) {
      const messageToLog = await this._formatTransferSourceLog(balancesPerAccount, newMove);
      if (messageToLog) {
        await move.messagePost({ body: messageToLog });
      }
    }

    // Log on target move as well
    await newMove.messagePost({ body: await this._formatNewTransferMoveLog(accTransferPerMove) });

    return {
      'label': await this._t("Transfer"),
      'type': 'ir.actions.actwindow',
      'viewType': 'form',
      'viewMode': 'form',
      'resModel': 'account.move',
      'resId': newMove.id,
    }
  }

  // Transfer utils
  async _formatNewTransferMoveLog(accTransferPerMove: Map<any, any>) {
    const format = await this._t("<li>{amount} ({debitCredit}) from {link}, <strong>{accountSourceName}</strong></li>");
    let rslt = _f(await this._t("This entry transfers the following amounts to <strong>{destination}</strong> <ul>", { destination: await (await this['destinationAccountId']).displayName }));
    for (const [move, balancesPerAccount] of accTransferPerMove) {
      for (const [account, balance] of balancesPerAccount) {
        if (!account.eq(await this['destinationAccountId'])) {  // Otherwise, logging it here is confusing for the user
          rslt += _f(await this._formatStrings(format, move, balance), { 'accountSourceName': await account.displayName });
        }
      }
    }
    rslt += '</ul>';
    return rslt;
  }

  async _formatTransferSourceLog(balancesPerAccount: Map<any, any>, transferMove) {
    const transferFormat = await this._t("<li>{amount} ({debitCredit}) from <strong>%s</strong> were transferred to <strong>{accountTargetName}</strong> by {link}</li>")
    let content = '';
    for (const [account, balance] of balancesPerAccount) {
      if (!account.eq(await this['destinationAccountId'])) {
        content += f(await this._formatStrings(transferFormat, transferMove, balance), await account.displayName);
      }
    }
    return content ? '<ul>' + content + '</ul>' : null;
  }

  async _formatMoveLink(move) {
    const moveLinkFormat = "<a href=# data-oe-model=account.move data-oe-id={moveId}>{moveName}</a>";
    return _f(moveLinkFormat, { moveId: move.id, moveName: await move.name });
  }

  async _formatStrings(string, move, amount) {
    return _f(string, {
      percent: Number(await this['percentage']).toFixed(2),
      label: await move.label,
      id: move.id,
      amount: await formatLang(this.env, Math.abs(amount), { currencyObj: await (await this['companyId']).currencyId }),
      debitCredit: amount < 0 ? await this._t('C') : await this._t('D'),
      link: await this._formatMoveLink(move),
      date: await formatDate(this.env, await move.date),
      newDate: await this['date'] ? await formatDate(this.env, await this['date']) : await this._t('[Not set]'),
      accountTargetName: await (await this['destinationAccountId']).displayName,
    });
  }
}