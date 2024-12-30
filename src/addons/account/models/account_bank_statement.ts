import _ from "lodash";
import { api } from "../../../core";
import { Fields, _Date, _Datetime } from "../../../core/fields";
import { UserError, ValidationError } from "../../../core/helper/errors";
import { MetaModel, Model, NewId, TransientModel, _super } from "../../../core/models";
import { _f, copysign, enumerate, extend, f, floatIsZero, len, pop, sum, update } from "../../../core/tools";
import { bool } from "../../../core/tools/bool";
import { formatLang } from "../../../core/tools/models";

/**
 * Cash Box Details
 */
@MetaModel.define()
class AccountCashboxLine extends Model {
  static _module = module;
  static _name = 'account.cashbox.line';
  static _description = 'CashBox Line';
  static _recName = 'coinValue';
  static _order = 'coinValue';

  static coinValue = Fields.Float({ string: 'Coin/Bill Value', required: true, digits: 0 });
  static number = Fields.Integer({ string: '#Coins/Bills', help: 'Opening Unit Numbers' });
  static subtotal = Fields.Float({ compute: '_subTotal', string: 'Subtotal', digits: 0, readonly: true });
  static cashboxId = Fields.Many2one('account.bank.statement.cashbox', { string: "Cashbox" });
  static currencyId = Fields.Many2one('res.currency', { related: 'cashboxId.currencyId' });

  /**
   * Calculates Sub total
   */
  @api.depends('coinValue', 'number')
  async _subTotal() {
    for (const cashboxLine of this) {
      await cashboxLine.set('subtotal', (await cashboxLine.coinValue) * (await cashboxLine.number));
    }
  }
}

/**
 * Account Bank Statement popup that allows entering cash details.
 */
@MetaModel.define()
class AccountBankStmtCashWizard extends Model {
  static _module = module;
  static _name = 'account.bank.statement.cashbox';
  static _description = 'Bank Statement Cashbox';
  static _recName = 'id';

  static cashboxLinesIds = Fields.One2many('account.cashbox.line', 'cashboxId', { string: 'Cashbox Lines' });
  static startBankStmtIds = Fields.One2many('account.bank.statement', 'cashboxStartId');
  static endBankStmtIds = Fields.One2many('account.bank.statement', 'cashboxEndId');
  static total = Fields.Float({ compute: '_computeTotal' });
  static currencyId = Fields.Many2one('res.currency', { compute: '_computeCurrency' });

  @api.depends('startBankStmtIds', 'endBankStmtIds')
  async _computeCurrencyself() {
    for (const cashbox of this) {
      await cashbox.set('currencyId', false);
      const [startBankStmtIds, endBankStmtIds] = await cashbox('startBankStmtIds', 'endBankStmtIds');
      if (bool(endBankStmtIds)) {
        await cashbox.set('currencyId', await endBankStmtIds[0].currencyId);
      }
      if (bool(startBankStmtIds)) {
        await cashbox.set('currencyId', await startBankStmtIds[0].currencyId);
      }
    }
  }

  @api.depends('cashboxLinesIds', 'cashboxLinesIds.coinValue', 'cashboxLinesIds.number')
  async _computeTotal() {
    for (const cashbox of this) {
      await cashbox.set('total', await (await cashbox.cashboxLinesIds).sum(line => line.subtotal));
    }
  }

  @api.model()
  async defaultGet(fields) {
    const vals = await _super(AccountBankStmtCashWizard, this).defaultGet(fields);
    const balance = this.env.context['balance'];
    const statementId = this.env.context['statementId'];
    if (fields.includes('startBankStmtIds') && !vals['startBankStmtIds'] && bool(statementId) && balance === 'start') {
      vals['startBankStmtIds'] = [[6, 0, [statementId]]];
    }
    if (fields.includes('endBankStmtIds') && !vals['endBankStmtIds'] && bool(statementId) && balance === 'close') {
      vals['endBankStmtIds'] = [[6, 0, [statementId]]];
    }

    return vals;
  }

  async nameGet() {
    const result = [];
    for (const cashbox of this) {
      result.push([cashbox.id, String(await cashbox.total)]);
    }
    return result;
  }

  @api.modelCreateMulti()
  async create(vals) {
    const cashboxes = await _super(AccountBankStmtCashWizard, this).create(vals);
    await cashboxes._validateCashbox();
    return cashboxes;
  }

  async write(vals) {
    const res = await _super(AccountBankStmtCashWizard, this).write(vals);
    this._validateCashbox();
    return res;
  }

  async _validateCashbox() {
    for (const cashbox of this) {
      const [startBankStmtIds, endBankStmtIds, total] = await cashbox('startBankStmtIds', 'endBankStmtIds', 'total');
      if (startBankStmtIds.ok) {
        await startBankStmtIds.write({ 'balanceStart': total });
      }
      if (endBankStmtIds.ok) {
        await endBankStmtIds.write({ 'balanceEndReal': total });
      }
    }
  }
}

/**
 * Account Bank Statement wizard that check that closing balance is correct.
 */
@MetaModel.define()
class AccountBankStmtCloseCheck extends TransientModel {
  static _module = module;
  static _name = 'account.bank.statement.closebalance';
  static _description = 'Bank Statement Closing Balance';

  async validate() {
    const bnkStmtId = this.env.context['activeId'] || false;
    if (bool(bnkStmtId)) {
      await this.env.items('account.bank.statement').browse(bnkStmtId).buttonValidate();
    }
    return { 'type': 'ir.actions.actwindow.close' }
  }
}

@MetaModel.define()
class AccountBankStatement extends Model {
  static _module = module;
  static _name = "account.bank.statement";
  static _description = "Bank Statement";
  static _order = "date desc, label desc, id desc";
  static _parents = ['mail.thread', 'sequence.mixin'];
  static _checkCompanyAuto = true;
  
  static _sequenceIndex = "journalId";
  get _sequenceIndex() { return "journalId" };

  static label = Fields.Char({ string: 'Reference', states: { 'open': [['readonly', false]] }, copy: false, readonly: true });
  static reference = Fields.Char({ string: 'External Reference', states: { 'open': [['readonly', false]] }, copy: false, readonly: true, help: "Used to hold the reference of the external mean that created this statement (name of imported file, reference of online synchronization...)" });
  static date = Fields.Date({ required: true, states: { 'confirm': [['readonly', true]] }, index: true, copy: false, default: self => _Date.contextToday(self) });
  static dateDone = Fields.Datetime({ string: "Closed On" });
  static balanceStart = Fields.Monetary({ string: 'Starting Balance', states: { 'confirm': [['readonly', true]] }, compute: '_computeStartingBalance', readonly: false, store: true, tracking: true });
  static balanceEndReal = Fields.Monetary('Ending Balance', { states: { 'confirm': [['readonly', true]] }, compute: '_computeEndingBalance', recursive: true, readonly: false, store: true, tracking: true });
  static state = Fields.Selection({
    string: 'Status', required: true, readonly: true, copy: false, tracking: true, selection: [
      ['open', 'New'],
      ['posted', 'Processing'],
      ['confirm', 'Validated'],
    ], default: 'open',
    help: ["The current state of your bank statement:",
      "- New: Fully editable with draft Journal Entries.",
      "- Processing: No longer editable with posted Journal entries, ready for the reconciliation.",
      "- Validated: All lines are reconciled. There is nothing left to process."].join('\n')
  });
  static currencyId = Fields.Many2one('res.currency', { compute: '_computeCurrency', string: "Currency" });
  static journalId = Fields.Many2one('account.journal', { string: 'Journal', required: true, states: { 'confirm': [['readonly', true]] }, default: self => self._defaultJournal(), checkCompany: true });
  static journalType = Fields.Selection({ related: 'journalId.type', help: "Technical field used for usability purposes" });
  static companyId = Fields.Many2one('res.company', { related: 'journalId.companyId', string: 'Company', store: true, readonly: true });

  static totalEntryEncoding = Fields.Monetary('Transactions Subtotal', { compute: '_endBalance', store: true, help: "Total of transaction lines." });
  static balanceEnd = Fields.Monetary('Computed Balance', { compute: '_endBalance', store: true, help: 'Balance as calculated based on Opening Balance and transaction lines' });
  static difference = Fields.Monetary({ compute: '_endBalance', store: true, help: "Difference between the computed ending balance and the specified ending balance." });

  static lineIds = Fields.One2many('account.bank.statement.line', 'statementId', { string: 'Statement lines', states: { 'confirm': [['readonly', true]] }, copy: true });
  static moveLineIds = Fields.One2many('account.move.line', 'statementId', { string: 'Entry lines', states: { 'confirm': [['readonly', true]] } });
  static moveLineCount = Fields.Integer({ compute: "_getMoveLineCount" });

  static allLinesReconciled = Fields.Boolean({
    compute: '_computeAllLinesReconciled',
    help: "Technical field indicating if all statement lines are fully reconciled."
  });
  static userId = Fields.Many2one('res.users', { string: 'Responsible', required: false, default: self => self.env.user() });
  static cashboxStartId = Fields.Many2one('account.bank.statement.cashbox', { string: "Starting Cashbox" });
  static cashboxEndId = Fields.Many2one('account.bank.statement.cashbox', { string: "Ending Cashbox" });
  static isDifferenceZero = Fields.Boolean({ compute: '_isDifferenceZero', string: 'Is zero', help: "Check if difference is zero." });
  static previousStatementId = Fields.Many2one('account.bank.statement', { help: 'technical field to compute starting balance correctly', compute: '_getPreviousStatement', store: true });
  static isValidBalanceStart = Fields.Boolean({
    string: "Is Valid Balance Start", store: true,
    compute: "_computeIsValidBalanceStart",
    help: "Technical field to display a warning message in case starting balance is different than previous ending balance"
  });
  static countryCode = Fields.Char({ related: 'companyId.accountFiscalCountryId.code' });

  // Note: the reason why we did 2 separate function with the same dependencies (one for balanceStart and one for balanceEndReal)
  // is because if we create a bank statement with a default value for one of the field but not the other, the compute method
  // won't be called and therefore the other field will have a value of 0 and we don't want that.
  @api.depends('previousStatementId', 'previousStatementId.balanceEndReal')
  async _computeStartingBalance() {
    // When a bank statement is inserted out-of-order several fields needs to be recomputed.
    // As the records to recompute are ordered by id, it may occur that the first record
    // to recompute start a recursive recomputation of field balanceEndReal
    // To avoid this we sort the records by date
    for (const statement of await this.sorted(async (s) => s.date)) {
      const previousStatementId = await statement.previousStatementId;
      if (await previousStatementId.balanceEndReal != await statement.balanceStart) {
        await statement.set('balanceStart', await previousStatementId.balanceEndReal);
      }
      else {
        // Need default value
        await statement.set('balanceStart', await statement.balanceStart || 0.0);
      }
    }
  }

  @api.depends('previousStatementId', 'previousStatementId.balanceEndReal')
  async _computeEndingBalance() {
    const latestStatement = await this.env.items('account.bank.statement').search([['journalId', '=', (await this[0].journalId).id]], { limit: 1 });
    for (const statement of this) {
      // recompute balanceEndReal in case we are in a bank journal and if we change the
      // balanceEndReal of previous statement as we don't want
      // holes in case we add a statement in between 2 others statements.
      // We only do this for the bank journal as we use the balanceEndReal in cash
      // journal for verification and creating cash difference entries so we don't want
      // to recompute the value in that case
      const [journalType, balanceEndReal] = await statement('journalType', 'balanceEndReal');
      if (journalType === 'bank') {
        // If we are on last statement and that statement already has a balanceEndReal, don't change the balanceEndReal
        // Otherwise, recompute balanceEndReal to prevent holes between statement.
        if (latestStatement.id && statement.id == latestStatement.id && !floatIsZero(balanceEndReal, { precisionDigits: await (await statement.currencyId).decimalPlaces })) {
          await statement.set('balanceEndReal', balanceEndReal || 0.0);
        }
        else {
          const totalEntryEncoding = await (await statement.lineIds).sum(line => line.amount);
          await statement.set('balanceEndReal', await (await statement.previousStatementId).balanceEndReal + totalEntryEncoding);
        }
      }
      else {
        // Need default value
        await statement.set('balanceEndReal', balanceEndReal || 0.0);
      }
    }
  }

  @api.depends('lineIds', 'balanceStart', 'lineIds.amount', 'balanceEndReal')
  async _endBalance() {
    for (const statement of this) {
      await statement.set('totalEntryEncoding', await (await statement.lineIds).sum(line => line.amount));
      await statement.set('balanceEnd', await statement.balanceStart + await statement.totalEntryEncoding);
      await statement.set('difference', await statement.balanceEndReal - await statement.balanceEnd);
    }
  }

  async _isDifferenceZero() {
    for (const bankStmt of this) {
      await bankStmt.set('isDifferenceZero', floatIsZero(await bankStmt.difference, { precisionDigits: await (await bankStmt.currencyId).decimalPlaces }));
    }
  }

  @api.depends('journalId')
  async _computeCurrency() {
    for (const statement of this) {
      let currencyId = await (await statement.journalId).currencyId;
      await statement.set('currencyId', currencyId.ok ? currencyId : await (await statement.companyId).currencyId);
    }
  }

  @api.depends('moveLineIds')
  async _getMoveLineCount() {
    for (const statement of this) {
      await statement.set('moveLineCount', len(await statement.moveLineIds));
    }
  }

  @api.model()
  async _defaultJournal() {
    const journalType = this.env.context['journalType'] || false;
    const companyId = (await this.env.company()).id;
    if (journalType) {
      return this.env.items('account.journal').search([
        ['type', '=', journalType],
        ['companyId', '=', companyId]
      ], { limit: 1 });
    }
    return this.env.items('account.journal');
  }

  @api.depends('balanceStart', 'previousStatementId')
  async _computeIsValidBalanceStart() {
    for (const bnk of this) {
      const [previousStatementId, currencyId, balanceStart] = await bnk('previousStatementId', 'currencyId', 'balanceStart');
      await bnk.set('isValidBalanceStart', (
        previousStatementId.ok ? await currencyId.isZero(balanceStart - await previousStatementId.balanceEndReal)
          : true
      ));
    }
  }

  @api.depends('date', 'journalId')
  async _getPreviousStatement() {
    for (const st of this) {
      const [date, journalId] = await st('date', 'journalId');
      // Search for the previous statement
      const domain = [['date', '<=', date], ['journalId', '=', journalId.id]];
      // The reason why we have to perform this test is because we have two use case here:
      // First one is in case we are creating a new record, in that case that new record does
      // not have any id yet. However if we are updating an existing record, the domain date <= st.date
      // will find the record itself, so we have to add a condition in the search to ignore self.id
      if (!(st.id instanceof NewId)) {
        extend(domain, ['|', '&', ['id', '<', st.id], ['date', '=', date], '&', ['id', '!=', st.id], ['date', '!=', date]]);
      }
      const previousStatement = await this.search(domain, { limit: 1, order: 'date desc, id desc' });
      await st.set('previousStatementId', previousStatement.id);
    }
  }

  async write(values) {
    const res = await _super(AccountBankStatement, this).write(values);
    if (values['date'] || values['journal']) {
      // If we are changing the date or journal of a bank statement, we have to change its previous_statement_id. This is done
      // automatically using the compute function, but we also have to change the previous_statement_id of records that were
      // previously pointing toward us and records that were pointing towards our new previous_statement_id. This is done here
      // by marking those record as needing to be recomputed.
      // Note that marking the field is not enough as we also have to recompute all its other fields that are depending on 'previous_statement_id'
      // hence the need to call modified afterwards.
      const toRecompute = await this.search([['previousStatementId', 'in', this.ids], ['id', 'not in', this.ids], ['journalId', 'in', (await this.mapped('journalId')).ids]]);
      if (bool(toRecompute)) {
        this.env.addToCompute(this._fields['previousStatementId'], toRecompute);
        await toRecompute.modified(['previousStatementId']);
      }
      const nextStatementsToRecompute = await this.search([['previousStatementId', 'in', await this.map(async (st) => (await st.previousStatementId).id)], ['id', 'not in', this.ids], ['journalId', 'in', (await this.mapped('journalId')).ids]]);
      if (bool(nextStatementsToRecompute)) {
        this.env.addToCompute(this._fields['previousStatementId'], nextStatementsToRecompute);
        await nextStatementsToRecompute.modified(['previousStatementId']);
      }
    }
    return res;
  }

  @api.modelCreateMulti()
  async create(values) {
    const res = await _super(AccountBankStatement, this).create(values);
    // Upon bank stmt creation, it is possible that the statement is inserted between two other statements and not at the end
    // In that case, we have to search for statement that are pointing to the same previous_statement_id as ourselve in order to
    // change their previous_statement_id to us. This is done by marking the field 'previous_statement_id' to be recomputed for such records.
    // Note that marking the field is not enough as we also have to recompute all its other fields that are depending on 'previous_statement_id'
    // hence the need to call modified afterwards.
    // The reason we are doing this here and not in a compute field is that it is not easy to write dependencies for such field.
    const nextStatementsToRecompute = await this.search([['previousStatementId', 'in', await res.map(async (st) => (await st.previousStatementId).id)], ['id', 'not in', res.ids], ['journalId', 'in', (await res.journalId).ids]]);
    if (bool(nextStatementsToRecompute)) {
      this.env.addToCompute(this._fields['previousStatementId'], nextStatementsToRecompute);
      await nextStatementsToRecompute.modified(['previousStatementId']);
    }
    return res;
  }

  @api.depends('lineIds.isReconciled')
  async _computeAllLinesReconciled() {
    for (const statement of this) {
      await statement.set('allLinesReconciled', await (await statement.lineIds).all(stLine => stLine.is_reconciled));
    }
  }

  @api.onchange('journalId')
  async onchangeJournalId() {
    for (const stLine of await this['lineIds']) {
      const journalId = await this['journalId'];
      const currencyId = await journalId.currencyId;
      await stLine.set('journalId', journalId);
      await stLine.set('currencyId', currencyId.ok ? currencyId : await (await this['companyId']).currencyId);
    }
  }

  /**
   * Check the balanceEndReal (encoded manually by the user) is equals to the balance_end (computed by verp).
   * @returns 
   */
  async _checkBalanceEndRealSameAsComputed() {
    return await this._checkCashBalanceEndRealSameAsComputed() && await this._checkBankBalanceEndRealSameAsComputed();
  }

  /**
   * Check the balanceEndReal (encoded manually by the user) is equals to the balance_end (computed by verp).
          For a cash statement, if there is a difference, the different is set automatically to a profit/loss account.
   */
  async _checkCashBalanceEndRealSameAsComputed() {
    for (const statement of await this.filtered(async (stmt) => await stmt.journalType === 'cash')) {
      const [currencyId, difference] = await statement('currencyId', 'difference');
      if (! await currencyId.isZero(difference)) {
        const [journalId, date] = await statement('journalId', 'date');
        const stLineVals = {
          'statementId': statement.id,
          'journalId': journalId.id,
          'amount': difference,
          'date': date,
        }

        if (await currencyId.compareAmounts(difference, 0.0) < 0.0) {
          const lossAccountId = await journalId.lossAccountId;
          if (!bool(lossAccountId)) {
            throw new UserError(await this._t(
              "Please go on the %s journal and define a Loss Account. This account will be used to record cash difference.", await journalId.label
            ));
          }

          stLineVals['paymentRef'] = await this._t("Cash difference observed during the counting (Loss)");
          stLineVals['counterpartAccountId'] = lossAccountId.id
        }
        else {
          // statement.difference > 0.0
          const profitAccountId = await journalId.profitAccountId;
          if (!bool(profitAccountId))
            throw new UserError(await this._t(
              "Please go on the %s journal and define a Profit Account. This account will be used to record cash difference.", await journalId.label
            ))

          stLineVals['paymentRef'] = await this._t("Cash difference observed during the counting (Profit)");
          stLineVals['counterpartAccountId'] = profitAccountId.id;
        }
        await this.env.items('account.bank.statement.line').create(stLineVals);
      }
    }
    return true;
  }

  /**
   * Check the balanceEndReal (encoded manually by the user) is equals to the balance_end (computed by verp).
   * @returns 
   */
  async _checkBankBalanceEndRealSameAsComputed() {
    for (const statement of await this.filtered(async (stmt) => await stmt.journalType === 'bank')) {
      const [currencyId, difference] = await statement('currencyId', 'difference');
      if (! await currencyId.isZero(difference)) {
        const balanceEndReal = await formatLang(this.env, await statement.balanceEndReal, { currencyObj: currencyId });
        const balanceEnd = await formatLang(this.env, await statement.balanceEnd, { currencyObj: currencyId });
        throw new UserError(_f(await this._t(
          'The ending balance is incorrect !\nThe expected balance ({realBalance}) is different from the computed one ({computedBalance}).'), {
          realBalance: balanceEndReal,
          computedBalance: balanceEnd
        }));
      }
    }
    return true;
  }

  @api.ondelete(false)
  async _unlinkOnlyIfOpen() {
    for (const statement of this) {
      if (await statement.state !== 'open') {
        throw new UserError(await this._t('In order to delete a bank statement, you must first cancel it to delete related journal items.'));
      }
    }
  }

  async unlink() {
    for (const statement of this) {
      // Explicitly unlink bank statement lines so it will check that the related journal entries have been deleted first
      await (await statement.lineIds).unlink();
      // Some other bank statements might be link to this one, so in that case we have to switch the previous_statement_id
      // from that statement to the one linked to this statement
      const nextStatement = await this.search([['previousStatementId', '=', statement.id], ['journalId', '=', (await statement.journalId).id]]);
      if (bool(nextStatement)) {
        await nextStatement.set('previousStatementId', await statement.previousStatementId);
      }
    }
    return _super(AccountBankStatement, self).unlink();
  }

  // CONSTRAINT METHODS

  @api.constrains('journalId')
  async _checkJournal() {
    for (const statement of this) {
      const journalId = await statement.journalId;
      if (await (await statement.lineIds).some(async (stLine) => !(await stLine.journalId).eq(journalId))) {
        throw new ValidationError(await this._t('The journal of a bank statement line must always be the same as the bank statement one.'));
      }
    }
  }

  async _constrainsDateSequence() {
    // Multiple import methods set the name to things that are not sequences:
    // i.e. Statement from {date1} to {date2}
    // It makes this constraint not applicable, and it is less needed on bank statements as it
    // is only an indication and not some thing legal.
    return;
  }

  // BUSINESS METHODS

  async openCashboxId() {
    this.ensureOne();
    const context = Object.assign({}, this.env.context);
    if (context['balance']) {
      context['statementId'] = this.id;
      let cashboxId;
      if (context['balance'] === 'start') {
        cashboxId = (await this['cashboxStartId']).id;
      }
      else if (context['balance'] === 'close') {
        cashboxId = (await this['cashboxEndId']).id;
      }
      else {
        cashboxId = false;
      }

      const action = {
        'label': await this._t('Cash Control'),
        'viewMode': 'form',
        'resModel': 'account.bank.statement.cashbox',
        'viewId': (await this.env.ref('account.viewAccountBnkStmtCashboxFooter')).id,
        'type': 'ir.actions.actwindow',
        'resId': cashboxId,
        'context': context,
        'target': 'new'
      }

      return action;
    }
  }

  /**
   * Move the bank statements from 'draft' to 'posted'.
   * @returns 
   */
  async buttonPost() {
    if (await this.some(async (statement) => await statement.state !== 'open')) {
      throw new UserError(await this._t("Only new statements can be posted."));
    }

    await this._checkCashBalanceEndRealSameAsComputed();

    for (const statement of this) {
      if (! await statement.label) {
        await statement._setNextSequence();
      }
    }
    await this.write({ 'state': 'posted' });
    const linesOfMovesToPost = await (await this['lineIds']).filtered(async (line) => await (await line.moveId).state !== 'posted');
    if (bool(linesOfMovesToPost)) {
      await (await linesOfMovesToPost.moveId)._post(false);
    }
  }

  async buttonValidate() {
    if (await this.some(async (statement) => await statement.state !== 'posted' || ! await statement.allLinesReconciled)) {
      throw new UserError(await this._t('All the account entries lines must be processed in order to validate the statement.'));
    }

    for (const statement of this) {
      const [label, journalId] = await statement('label', 'journalId');
      // Chatter.
      await statement.messagePost(await this._t('Statement %s confirmed.', label));

      // Bank statement report.
      if (await journalId.type === 'bank') {
        const [content, contentType] = await (await this.env.ref('account.actionReportAccountStatement'))._render(statement.id);
        await this.env.items('ir.attachment').create({
          'label': label && await this._t("Bank Statement %s.pdf", name) || await this._t("Bank Statement.pdf"),
          'type': 'binary',
          'raw': content,
          'resModel': statement._name,
          'resId': statement.id
        });
      }
    }

    await this._checkBalanceEndRealSameAsComputed();
    await this.write({ 'state': 'confirm', 'dateDone': _Datetime.now() });
  }

  async buttonValidateOrAction() {
    if (await this['journalType'] === 'cash' && ! await (await this['currencyId']).isZero(await this['difference'])) {
      return this.env.items('ir.actions.actions')._forXmlid('account.actionViewAccountBnkStmtCheck');
    }

    return this.buttonValidate();
  }

  /**
   * Move the bank statements back to the 'open' state.
   */
  async buttonReopen() {
    if (await this.some(async (statement) => await statement.state === 'draft')) {
      throw new UserError(await this._t("Only validated statements can be reset to new."));
    }

    await this.write({ 'state': 'open' });
    const lineIds = await this['lineIds'];
    await (await lineIds.moveId).buttonDraft();
    await lineIds.buttonUndoReconciliation();
  }

  /**
   * Move the bank statements back to the 'posted' state.
   */
  async buttonReprocess() {
    if (await this.some(async (statement) => await statement.state === 'confirm')) {
      throw new UserError(await this._t("Only Validated statements can be reset to new."));
    }

    await this.write({ 'state': 'posted', 'dateDone': false });
  }

  async buttonJournalEntries() {
    return {
      'label': await this._t('Journal Entries'),
      'viewMode': 'tree',
      'resModel': 'account.move.line',
      'viewId': (await this.env.ref('account.viewMoveLineTreeGroupedBankCash')).id,
      'type': 'ir.actions.actwindow',
      'domain': [['moveId', 'in', (await (this['lineIds']).moveId).ids]],
      'context': {
        'journalId': (await this['journalId']).id,
        'groupby': 'moveId',
        'expand': true
      }
    }
  }

  async _getLastSequenceDomain(relaxed: boolean = false) {
    this.ensureOne();
    const journalId = await this['journalId'];
    let whereString = `WHERE "journalId" = {journalId} AND label != '/'`;
    const param = { 'journalId': journalId.id }

    if (!relaxed) {
      const [date] = await this('date');
      const domain = [['journalId', '=', journalId.id], ['id', '!=', bool(this.id) ? this.id : this._origin.id], ['label', '!=', false]];
      let previousName = await (await this.search(domain.concat([['date', '<', date]]), { order: 'date desc', limit: 1 })).label;
      if (!previousName) {
        previousName = await (await this.search(domain, { order: 'date desc', limit: 1 })).label;
      }
      const sequenceNumberReset = await (this as any)._deduceSequenceNumberReset(previousName);
      if (sequenceNumberReset === 'year') {
        whereString += " AND date_trunc('year', date::timestamp) = date_trunc('year', '{date}'::timestamp) ";
        param['date'] = date.toISOString();
      }
      else if (sequenceNumberReset === 'month') {
        whereString += " AND date_trunc('month', date::timestamp) = date_trunc('month', '{date}'::timestamp) ";
        param['date'] = date.toISOString();
      }
    }
    return [whereString, param];
  }

  async _getStartingSequence() {
    this.ensureOne();
    const date: Date = new Date(await this['date']);
    return f('%s %s %s/%s/00000', await (await this['journalId']).code, await this._t('Statement'), date.getFullYear().toString().padStart(4, '0'), (date.getMonth()+1).toString().padStart(2, '0'));
  }
}

@MetaModel.define()
class AccountBankStatementLine extends Model {
  static _module = module;
  static _name = "account.bank.statement.line";
  static _inherits = { 'account.move': 'moveId' };
  static _description = "Bank Statement Line";
  static _order = "statementId desc, date, sequence, id desc";
  static _checkCompanyAuto = true;

  // FIXME: Fields having the same name in both tables are confusing (partnerId & state). We don't change it because:
  // - It's a mess to track/fix.
  // - Some fields here could be simplified when the onchanges will be gone in account.move.
  // Should be improved in the future.

  // == Business fields ==
  static moveId = Fields.Many2one({
    comodelName: 'account.move',
    autojoin: true,
    string: 'Journal Entry', required: true, readonly: true, ondelete: 'CASCADE',
    checkCompany: true
  });
  static statementId = Fields.Many2one({
    comodelName: 'account.bank.statement',
    string: 'Statement', index: true, required: true, ondelete: 'CASCADE',
    checkCompany: true
  });

  static sequence = Fields.Integer({ index: true, help: "Gives the sequence order when displaying a list of bank statement lines.", default: 1 });
  static accountNumber = Fields.Char({ string: 'Bank Account Number', help: "Technical field used to store the bank account number before its creation, upon the line's processing" });
  static partnerName = Fields.Char({
    help: "This field is used to record the third party name when importing bank statement in electronic format, when the partner doesn't exist yet in the database (or cannot be found)."
  });
  static transactionType = Fields.Char({ string: 'Transaction Type' });
  static paymentRef = Fields.Char({ string: 'Label', required: true });
  static amount = Fields.Monetary({ currencyField: 'currencyId' });
  static amountCurrency = Fields.Monetary({
    currencyField: 'foreignCurrencyId',
    help: "The amount expressed in an optional other currency if it is a multi-currency entry."
  });
  static foreignCurrencyId = Fields.Many2one('res.currency', {
    string: 'Foreign Currency',
    help: "The optional other currency if it is a multi-currency entry."
  });
  static amountResidual = Fields.Float({
    string: "Residual Amount",
    compute: "_computeIsReconciled",
    store: true,
    help: "The amount left to be reconciled on this statement line (signed according to its move lines' balance), expressed in its currency. This is a technical field use to speedup the application of reconciliation models."
  });
  static currencyId = Fields.Many2one('res.currency', { string: 'Journal Currency' });
  static partnerId = Fields.Many2one({
    comodelName: 'res.partner',
    string: 'Partner', ondelete: 'RESTRICT',
    domain: "['|', ['parentId','=', false], ['isCompany','=',true]]",
    checkCompany: true
  });
  static paymentIds = Fields.Many2many({
    comodelName: 'account.payment',
    relation: 'accountPaymentAccountBankStatementLineRel',
    string: 'Auto-generated Payments',
    help: "Payments generated during the reconciliation of this bank statement lines."
  });

  // == Display purpose fields ==
  static isReconciled = Fields.Boolean({
    string: 'Is Reconciled', store: true,
    compute: '_computeIsReconciled',
    help: "Technical field indicating if the statement line is already reconciled."
  });
  static state = Fields.Selection({ related: 'statementId.state', string: 'Status', readonly: true });
  static countryCode = Fields.Char({ related: 'companyId.accountFiscalCountryId.code' });

  // HELPERS

  /**
   * Helper used to dispatch the journal items between:
      - The lines using the liquidity account.
      - The lines using the transfer account.
      - The lines being not in one of the two previous categories.
      :return: (liquidity_lines, suspense_lines, other_lines)
   */
  async _seekForLines() {
    const env = this.env;
    let liquidityLines = env.items('account.move.line');
    let suspenseLines = env.items('account.move.line');
    let otherLines = env.items('account.move.line');
    const [journalId, moveId] = await this('journalId', 'moveId');
    for (const line of await moveId.lineIds) {
      const accountId = await line.accountId;
      if (accountId.eq(await journalId.defaultAccountId)) {
        liquidityLines = liquidityLines.add(line);
      }
      else if (accountId.eq(await journalId.suspenseAccountId)) {
        suspenseLines = suspenseLines.add(line);
      }
      else {
        otherLines = otherLines.add(line);
      }
    }
    return [liquidityLines, suspenseLines, otherLines];
  }

  /**
   * Prepare values to create a new account.move.line record corresponding to the
      liquidity line (having the bank/cash account).
      :return:        The values to create a new account.move.line record.
   */
  @api.model()
  async _prepareLiquidityMoveLineVals() {
    this.ensureOne();

    const [statement, foreignCurrencyId, amount, paymentRef, moveId, partnerId] = await this('statementId', 'foreignCurrencyId', 'amount', 'paymentRef', 'moveId', 'partnerId');
    const journal = await statement.journalId;
    const companyCurrency = await (await journal.companyId).currencyId;
    let [journalCurrency, journalCompany] = await journal('currencyId', 'companyId');
    journalCurrency = journalCurrency.ok ? journalCurrency : companyCurrency;

    let amountCurrency, balance, currencyId;
    if (bool(foreignCurrencyId) && bool(journalCurrency)) {
      const currencyId = await journalCurrency.id;
      if (foreignCurrencyId.eq(companyCurrency)) {
        amountCurrency = amount;
        balance = await this['amountCurrency'];
      }
      else {
        amountCurrency = amount;
        balance = await journalCurrency._convert(amountCurrency, companyCurrency, journalCompany, await this['date']);
      }
    }
    else if (bool(foreignCurrencyId) && !bool(journalCurrency)) {
      amountCurrency = await this['amountCurrency'];
      balance = amount;
      currencyId = await this['foreignCurrencyId'].id;
    }
    else if (!bool(foreignCurrencyId) && bool(journalCurrency)) {
      currencyId = journalCurrency.id
      amountCurrency = amount;
      balance = await journalCurrency._convert(amountCurrency, await journalCompany.currencyId, journalCompany, await this['date']);
    }
    else {
      currencyId = companyCurrency.id;
      amountCurrency = amount;
      balance = amount;
    }

    return {
      'label': paymentRef,
      'moveId': moveId.id,
      'partnerId': partnerId.id,
      'currencyId': currencyId,
      'accountId': (await journal.defaultAccountId).id,
      'debit': balance > 0 ? balance : 0.0,
      'credit': balance < 0 ? -balance : 0.0,
      'amountCurrency': amountCurrency,
    }
  }

  /**
   * Prepare values to create a new account.move.line move_line.
      By default, without specified 'counterpart_vals' or 'move_line', the counterpart line is
      created using the suspense account. Otherwise, this method is also called during the
      reconciliation to prepare the statement line's journal entry. In that case,
      'counterpart_vals' will be used to create a custom account.move.line (from the reconciliation widget)
      and 'move_line' will be used to create the counterpart of an existing account.move.line to which
      the newly created journal item will be reconciled.
      @param counterpartVals:    A dictionary containing:
          'balance':                  Optional amount to consider during the reconciliation. If a foreign currency is set on the
                                      counterpart line in the same foreign currency as the statement line, then this amount is
                                      considered as the amount in foreign currency. If not specified, the full balance is took.
                                      This value must be provided if move_line is not.
          'amountResidual':          The residual amount to reconcile expressed in the company's currency.
                                      /!\ This value should be equivalent to move_line.amount_residual except we want
                                      to avoid browsing the record when the only thing we need in an overview of the
                                      reconciliation, for example in the reconciliation widget.
          'amountResidualCurrency': The residual amount to reconcile expressed in the foreign's currency.
                                      Using this key doesn't make sense without passing 'currencyId' in vals.
                                      /!\ This value should be equivalent to move_line.amount_residual_currency except
                                      we want to avoid browsing the record when the only thing we need in an overview
                                      of the reconciliation, for example in the reconciliation widget.
          **kwargs:                   Additional values that need to land on the account.move.line to create.
      @param moveLine:           An optional account.move.line move_line representing the counterpart line to reconcile.
      @return:                    The values to create a new account.move.line move_line.
   * @param counterpartVals 
   * @param moveLine 
   */
  @api.model()
  async _prepareCounterpartMoveLineVals(counterpartVals, moveLine?: any) {
    this.ensureOne();

    const [statement, amount, date, foreignCurrencyId, move, partner] = await this('statementId', 'amount', 'date', 'foreignCurrencyId', 'move', 'partner');
    const journal = await statement.journalId;
    const companyCurrency = await (await journal.companyId).currencyId;
    let [journalCurrency, journalCompany] = await journal('currencyId', 'companyId');
    journalCurrency = journalCurrency.ok ? journalCurrency : companyCurrency;
    let foreignCurrency = foreignCurrencyId;
    foreignCurrency = foreignCurrency.ok ? foreignCurrency : journalCurrency;// or companyCurrency
    const statementLineRate = amount ? (await this['amountCurrency'] / amount) : 0.0;

    const balanceToReconcile = pop(counterpartVals, 'balance', null);
    const amountResidual = balanceToReconcile == null
      ? - pop(counterpartVals, 'amountResidual', bool(moveLine) ? await moveLine.amountResidual : 0.0)
      : balanceToReconcile;
    let amountResidualCurrency = balanceToReconcile == null
      ? - pop(counterpartVals, 'amountResidualCurrency', bool(moveLine) ? await moveLine.amountResidualCurrency : 0.0)
      : balanceToReconcile;

    let currencyId;
    if ('currencyId' in counterpartVals) {
      currencyId = counterpartVals['currencyId'] || foreignCurrency.id;
    }
    else if (bool(moveLine)) {
      currencyId = (await moveLine.currencyId).id || companyCurrency.id;
    }
    else {
      currencyId = foreignCurrency.id;
    }

    if (![foreignCurrency.id, journalCurrency.id].includes(currencyId)) {
      currencyId = companyCurrency.id;
      amountResidualCurrency = 0.0;
    }

    const amounts = {
      [companyCurrency.id]: 0.0,
      [journalCurrency.id]: 0.0,
      [foreignCurrency.id]: 0.0,
    }

    amounts[currencyId] = amountResidualCurrency;
    amounts[companyCurrency.id] = amountResidual;

    if (currencyId == journalCurrency.id && !journalCurrency.eq(companyCurrency)) {
      if (!foreignCurrency.eq(companyCurrency)) {
        amounts[companyCurrency.id] = await journalCurrency._convert(amounts[currencyId], companyCurrency, journalCompany, date);
      }
      if (statementLineRate) {
        amounts[foreignCurrency.id] = amounts[currencyId] * statementLineRate;
      }
    }
    else if (currencyId == foreignCurrency.id && foreignCurrencyId.ok) {
      if (statementLineRate) {
        amounts[journalCurrency.id] = amounts[foreignCurrency.id] / statementLineRate;
        if (!foreignCurrency.eq(companyCurrency)) {
          amounts[companyCurrency.id] = journalCurrency._convert(amounts[journalCurrency.id], companyCurrency, journalCompany, date);
        }
      }
    }
    else {
      amounts[journalCurrency.id] = await companyCurrency._convert(amounts[companyCurrency.id], journalCurrency, journalCompany, date);
      if (statementLineRate) {
        amounts[foreignCurrency.id] = amounts[journalCurrency.id] * statementLineRate;
      }
    }
    let balance, amountCurrency;
    if (foreignCurrency.eq(companyCurrency) && !journalCurrency.eq(companyCurrency) && foreignCurrencyId.ok) {
      balance = amounts[foreignCurrency.id];
    }
    else {
      balance = amounts[companyCurrency.id];
    }

    if (!foreignCurrency.eq(companyCurrency) && foreignCurrencyId.ok) {
      amountCurrency = amounts[foreignCurrency.id];
      currencyId = foreignCurrency.id;
    }
    else if (!journalCurrency.eq(companyCurrency) && !foreignCurrencyId.ok) {
      amountCurrency = amounts[journalCurrency.id];
      currencyId = journalCurrency.id;
    }
    else {
      amountCurrency = amounts[companyCurrency.id];
      currencyId = companyCurrency.id;
    }
    return {
      ...counterpartVals,
      'label': counterpartVals['label'] ?? moveLine.ok ? await moveLine.label : '',
      'moveId': move.id,
      'partnerId': bool(partner.id)
        ? partner.id
        : counterpartVals['partnerId'] ?? moveLine.ok ? (await moveLine.partnerId).id : false,
      'currencyId': currencyId,
      'accountId': counterpartVals['accountId'] ?? moveLine.ok ? (await moveLine.accountId).id : false,
      'debit': balance > 0.0 ? balance : 0.0,
      'credit': balance < 0.0 ? -balance : 0.0,
      'amountCurrency': amountCurrency,
    }
  }

  /**
   * Prepare the dictionary to create the default account.move.lines for the current account.bank.statement.line
      record.
    @param counterpartAccountId 
    @return: A list of dictionary to be passed to the account.move.line's 'create' method.
   */
  @api.model()
  async _prepareMoveLineDefaultVals(counterpartAccountId?: any) {
    this.ensureOne();

    const [journalId, paymentRef, foreignCurrencyId, companyCurrencyId] = await this('journalId', 'paymentRef', 'foreignCurrencyId', 'companyCurrencyId');
    if (!bool(counterpartAccountId)) {
      counterpartAccountId = (await journalId.suspenseAccountId).id;
    }
    if (!bool(counterpartAccountId)) {
      throw new UserError(await this._t(
        "You can't create a new statement line without a suspense account set on the %s journal."
        , await journalId.displayName));
    }
    const liquidityLineVals = await this._prepareLiquidityMoveLineVals();

    // Ensure the counterpart will have a balance exactly equals to the amount in journal currency.
    // This avoid some rounding issues when the currency rate between two currencies is not symmetrical.
    // E.g:
    // A.convert(amount_a, B) = amount_b
    // B.convert(amount_b, A) = amount_c != amount_a

    const counterpartVals = {
      'label': paymentRef,
      'accountId': counterpartAccountId,
      'amountResidual': liquidityLineVals['debit'] - liquidityLineVals['credit'],
    }

    if (bool(foreignCurrencyId) && !foreignCurrencyId.eq(companyCurrencyId)) {
      // Ensure the counterpart will have exactly the same amount in foreign currency as the amount set in the
      // statement line to avoid some rounding issues when making a currency conversion.

      update(counterpartVals, {
        'currencyId': foreignCurrencyId.id,
        'amountResidualCurrency': await this['amountCurrency'],
      })
    }
    else if (liquidityLineVals['currencyId']) {
      // Ensure the counterpart will have a balance exactly equals to the amount in journal currency.
      // This avoid some rounding issues when the currency rate between two currencies is not symmetrical.
      // E.g:
      // A.convert(amount_a, B) = amount_b
      // B.convert(amount_b, A) = amount_c != amount_a

      update(counterpartVals, {
        'currencyId': liquidityLineVals['currencyId'],
        'amountResidualCurrency': liquidityLineVals['amountCurrency'],
      });
    }

    const counterpartLineVals = await this._prepareCounterpartMoveLineVals(counterpartVals);
    return [liquidityLineVals, counterpartLineVals];
  }

  // COMPUTE METHODS

  /**
   * Compute the field indicating if the statement lines are already reconciled with something.
      This field is used for display purpose (e.g. display the 'cancel' button on the statement lines).
      Also computes the residual amount of the statement line.
   */
  @api.depends('journalId', 'currencyId', 'amount', 'foreignCurrencyId', 'amountCurrency',
    'moveId.toCheck', 'moveId.lineIds.accountId', 'moveId.lineIds.amountCurrency',
    'moveId.lineIds.amountResidualCurrency', 'moveId.lineIds.currencyId',
    'moveId.lineIds.matchedDebitIds', 'moveId.lineIds.matchedCreditIds')
  async _computeIsReconciled() {
    for (const stLine of this) {
      const [liquidityLines, suspenseLines, otherLines] = await stLine._seekForLines();

      // Compute residual amount
      if (await stLine.toCheck) {
        await stLine.set('amountResidual', bool(await stLine.foreignCurrencyId) ? - await stLine.amountCurrency : - await stLine.amount);
      }
      else if (await (await suspenseLines.accountId).reconcile) {
        await stLine.set('amountResidual', sum(await suspenseLines.mapped('amountResidualCurrency')));
      }
      else {
        await stLine.set('amountResidual', sum(await suspenseLines.mapped('amountCurrency')));
      }

      // Compute isReconciled
      if (!bool(stLine.id)) {
        // New record: The journal items are not yet there.
        await stLine.set('isReconciled', false);
      }
      else if (suspenseLines) {
        // In case of the statement line comes from an older version, it could have a residual amount of zero.
        await stLine.set('isReconciled', await (await suspenseLines.currencyId).isZero(await stLine.amountResidual));
      }
      else if (await (await stLine.currencyId).isZero(await stLine.amount)) {
        await stLine.set('isReconciled', true);
      }
      else {
        // The journal entry seems reconciled.
        await stLine.set('isReconciled', true);
      }
    }
  }

  // CONSTRAINT METHODS

  /**
   * Ensure the consistency the specified amounts and the currencies.
   */
  @api.constrains('amount', 'amountCurrency', 'currencyId', 'foreignCurrencyId', 'journalId')
  async _checkAmountsCurrencies() {
    for (const stLine of this) {
      if (!(await stLine.journalId).eq(await (await stLine.statementId).journalId)) {
        throw new ValidationError(await this._t('The journal of a statement line must always be the same as the bank statement one.'));
      }
      if ((await stLine.foreignCurrencyId).eq(await stLine.currencyId)) {
        throw new ValidationError(await this._t("The foreign currency must be different than the journal one: %s", await (await stLine.currencyId).label));
      }
      if (!bool(await stLine.foreignCurrencyId) && bool(stLine.amountCurrency)) {
        throw new ValidationError(await this._t("You can't provide an amount in foreign currency without specifying a foreign currency."));
      }
    }
  }

  // LOW-LEVEL METHODS

  @api.modelCreateMulti()
  async create(valsList) {
    // OVERRIDE
    const counterpartAccountIds = [];

    for (const vals of valsList) {
      const statement = await this.env.items('account.bank.statement').browse(vals['statementId']);
      if (await statement.state !== 'open' && (this._context['checkMoveValidity'] ?? true)) {
        throw new UserError(await this._t("You can only create statement line in open bank statements."));
      }
      // Force the moveType to avoid inconsistency with residual 'default_moveType' inside the context.
      vals['moveType'] = 'entry';

      const journal = await statement.journalId;
      // Ensure the journal is the same as the statement one.
      let [journalCurrency, journalCompany] = await journal('currencyId', 'companyId');
      journalCurrency = journalCurrency.ok ? journalCurrency : await journalCompany.currencyId;
      vals['journalId'] = journal.id
      vals['currencyId'] = journalCurrency.id
      if (!('date' in vals)) {
        vals['date'] = await statement.date;
      }
      // Avoid having the same foreign_currency_id as currencyId.
      if (vals['foreignCurrencyId'] == journalCurrency.id) {
        vals['foreignCurrencyId'] = null;
        vals['amountCurrency'] = 0.0;
      }

      // Hack to force different account instead of the suspense account.
      counterpartAccountIds.push(pop(vals, 'counterpartAccountId', null));
    }

    const stLines = await _super(AccountBankStatementLine, this).create(valsList);
    const moveId = await stLines.moveId;
    for (const [i, stLine] of enumerate(stLines)) {
      const counterpartAccountId = counterpartAccountIds[i];

      const toWrite = { 'statementLineId': stLine.id, 'narration': await stLine.narration }
      if (!('lineIds' in valsList[i])) {
        toWrite['lineIds'] = await (await stLine._prepareMoveLineDefaultVals(counterpartAccountId)).map(lineVals => [0, 0, lineVals]);
      }
      await moveId.write(toWrite);

      // Otherwise field narration will be recomputed silently (at next flush) when writing on partnerId
      this.env.removeToCompute(moveId._fields['narration'], moveId);
    }
    return stLines;
  }

  async write(vals) {
    // OVERRIDE
    const res = await _super(AccountBankStatementLine, this).write(vals);
    await this._synchronizeToMoves(Object.keys(vals));
    return res;
  }

  async unlink() {
    // OVERRIDE to unlink the inherited account.move (moveId field) as well.
    const moves = await (await this.withContext({ forceDelete: true })).mapped('moveId');
    const res = await _super(AccountBankStatementLine, this).unlink();
    await moves.unlink();
    return res;
  }

  // SYNCHRONIZATION account.bank.statement.line <-> account.move

  /**
   * Update the account.bank.statement.line regarding its related account.move.
      Also, check both models are still consistent.
      :param changed_fields: A set containing all modified fields on account.move.
   * @param changedFields 
   * @returns 
   */
  async _synchronizeFromMoves(changedFields) {
    if (this._context['skipAccountMoveSynchronization']) {
      return;
    }

    for (const stLine of await this.withContext({ skipAccountMoveSynchronization: true })) {
      const [move, state] = await stLine('moveId', 'state');
      const moveValsToWrite = {};
      const stLineValsToWrite = {};

      if (changedFields.includes('state')) {
        if ((state === 'open' && await move.state !== 'draft') || (['posted', 'confirm'].includes(state) && await move.state !== 'posted')) {
          throw new UserError(await this._t(
            "You can't manually change the state of journal entry %s, as it has been created by bank  statement %s.", await move.displayName, await (await stLine.statementId).displayName));
        }
      }

      if (changedFields.includes('lineIds')) {
        const [liquidityLines, suspenseLines, otherLines] = await stLine._seekForLines();
        const [journalId] = await stLine('journalId');
        const companyCurrency = await (await journalId.companyId).currencyId;
        const journalCurrency = !(await journalId.currencyId).eq(companyCurrency) ? await journalId.currencyId : false;

        if (len(liquidityLines) != 1) {
          throw new UserError(await this._t(`
                        The journal entry %s reached an invalid state regarding its related statement line.
                        To be consistent, the journal entry must always have exactly one journal item involving the bank/cash account.`, await (await stLine.moveId).displayName));
        }
        update(stLineValsToWrite, {
          'paymentRef': await liquidityLines.label,
          'partnerId': (await liquidityLines.partnerId).id,
        });

        // Update 'amount' according to the liquidity line.

        if (bool(journalCurrency)) {
          update(stLineValsToWrite, {
            'amount': await liquidityLines.amountCurrency,
          });
        }
        else {
          update(stLineValsToWrite, {
            'amount': await liquidityLines.balance,
          });
        }
        if (len(suspenseLines) == 1) {

          if (bool(journalCurrency) && (await suspenseLines.currencyId).eq(journalCurrency)) {

            // The suspense line is expressed in the journal's currency meaning the foreign currency
            // set on the statement line is no longer needed.

            update(stLineValsToWrite, {
              'amountCurrency': 0.0,
              'foreignCurrencyId': false,
            });
          }

          else if (!bool(journalCurrency) && (await suspenseLines.currencyId).eq(companyCurrency)) {

            // Don't set a specific foreign currency on the statement line.

            update(stLineValsToWrite, {
              'amountCurrency': 0.0,
              'foreignCurrencyId': false,
            });
          }
          else {

            // Update the statement line regarding the foreign currency of the suspense line.

            update(stLineValsToWrite, {
              'amountCurrency': - await suspenseLines.amountCurrency,
              'foreignCurrencyId': (await suspenseLines.currencyId).id,
            });
          }
        }
        let currency = await stLine.foreignCurrencyId;
        currency = bool(currency) ? currency : journalCurrency;
        currency = bool(currency) ? currency : companyCurrency;
        update(moveValsToWrite, {
          'partnerId': (await liquidityLines.partnerId).id,
          'currencyId': currency.id,
        });
      }
      await move.write(await move._cleanupWriteOrmValues(move, moveValsToWrite));
      await stLine.write(await move._cleanupWriteOrmValues(stLine, stLineValsToWrite));
    }
  }

  /**
   * Update the account.move regarding the modified account.bank.statement.line.
      :param changed_fields: A list containing all modified fields on account.bank.statement.line.
   * @param changedFields 
   * @returns 
   */
  async _synchronizeToMoves(changedFields) {
    if (this._context['skipAccountMoveSynchronization']) {
      return;
    }

    if (!['paymentRef', 'amount', 'amountCurrency', 'foreignCurrencyId', 'currencyId', 'partnerId'].some(name => changedFields.includes(name))) {
      return;
    }

    for (const stLine of await this.withContext({ skipAccountMoveSynchronization: true })) {
      const [liquidityLines, suspenseLines, otherLines] = await stLine._seekForLines();
      const [journal, move, partner] = await stLine('journalId', 'moveId', 'partnerId');
      const companyCurrency = await (await journal.companyId).currencyId;
      const journalCurrency = !(await journal.currencyId).eq(companyCurrency) ? await journal.currencyId : false;

      const lineValsList = await stLine._prepareMoveLineDefaultVals();
      const lineIdsCommands = [[1, liquidityLines.id, lineValsList[0]]];

      if (bool(suspenseLines)) {
        lineIdsCommands.push([1, suspenseLines.id, lineValsList[1]]);
      }
      else {
        lineIdsCommands.push([0, 0, lineValsList[1]]);
      }

      for (const line of otherLines) {
        lineIdsCommands.push([2, line.id]);
      }

      let currency = await stLine.foreignCurrencyId;
      currency = bool(currency) ? currency : journalCurrency;
      currency = bool(currency) ? currency : companyCurrency;
      const stLineVals = {
        'currencyId': currency.id,
        'lineIds': lineIdsCommands,
      }
      if (!(await move.partnerId).eq(partner)) {
        stLineVals['partnerId'] = partner.id;
      }
      await move.write(stLineVals);
    }
  }

  // RECONCILIATION METHODS

  /**
   * Helper for the "reconcile" method used to get a full preview of the reconciliation result. This method is
      quite useful to deal with reconcile models or the reconciliation widget because it ensures the values seen by
      the user are exactly the values you get after reconciling.

      :param lines_vals_list: See the 'reconcile' method.
      :param allow_partial:   In case of matching a line having an higher amount, allow creating a partial instead
                              an open balance on the statement line.
      :return: The diff to be applied on the statement line as a tuple
      (
          lines_to_create:    The values to create the account.move.line on the statement line.
          payments_to_create: The values to create the account.payments.
          open_balance_vals:  A dictionary to create the open-balance line or None if the reconciliation is full.
          existing_lines:     The counterpart lines to which the reconciliation will be done.
      )
   * @param linesValsList 
   * @param allowPartial 
   */
  async _prepareReconciliation(linesValsList, allowPartial: boolean = false) {
    this.ensureOne();
    let [journal, foreignCurrency, move] = await this('journalId', 'foreignCurrencyId', 'moveId');
    const [company, currency] = await journal('companyId', 'currencyId');
    const companyCurrency = await company.currencyId;
    foreignCurrency = foreignCurrency.ok ? foreignCurrency : currency;
    foreignCurrency = foreignCurrency.ok ? foreignCurrency : companyCurrency;

    const [liquidityLines, suspenseLines, otherLines] = await this._seekForLines();

    // Ensure the statement line has not yet been already reconciled.
    // If the move has 'to_check' enabled, it means the statement line has created some lines that
    // need to be checked later and replaced by the real ones.
    if (! await move.toCheck && bool(otherLines)) {
      throw new UserError(await this._t("The statement line has already been reconciled."));
    }
    // A list of dictionary containing:
    // - line_vals:          The values to create the account.move.line on the statement line.
    // - payment_vals:       The optional values to create a bridge account.payment
    // - counterpart_line:   The optional counterpart line to reconcile with 'line'.
    const reconciliationOverview = [];

    let totalBalance = await liquidityLines.balance;
    let totalAmountCurrency = - (await this._prepareMoveLineDefaultVals())[1]['amountCurrency'];
    const sign = await liquidityLines.balance > 0.0 ? 1 : -1

    // Step 1: Split 'lines_vals_list' into two batches:
    // - The existing account.move.lines that need to be reconciled with the statement line.
    //       => Will be managed at step 2.
    // - The account.move.lines to be created from scratch.
    //       => Will be managed directly.

    // In case of the payment is matched directly with an higher amount, don't create an open
    // balance but a partial reconciliation.
    let partialRecNeeded = allowPartial;

    const toBrowseIds = [];
    const toProcessVals = [];
    for (let vals of linesValsList) {
      // Don't modify the params directly.
      vals = Object.assign({}, vals);

      if ('id' in vals) {
        // Existing account.move.line.
        toBrowseIds.push(pop(vals, 'id'));
        toProcessVals.push(vals);
        if (['balance', 'amountResidual', 'amountResidualCurrency'].some(x => x in vals)) {
          partialRecNeeded = false;
        }
      }
      else {
        // Newly created account.move.line from scratch.
        const lineVals = await this._prepareCounterpartMoveLineVals(vals);
        totalBalance += lineVals['debit'] - lineVals['credit'];
        totalAmountCurrency += lineVals['amountCurrency'];
        reconciliationOverview.push({ 'lineVals': lineVals });
        partialRecNeeded = false;
      }
    }

    // Step 2: Browse counterpart lines all in one and process them.

    const existingLines = this.env.items('account.move.line').browse(toBrowseIds);

    let i = 0;
    for (const [line, counterpartVals] of _.zip(existingLines, toProcessVals)) {
      let lineVals = await this._prepareCounterpartMoveLineVals(counterpartVals, line);
      let balance = lineVals['debit'] - lineVals['credit'];
      let amountCurrency = lineVals['amountCurrency'];
      i += 1;

      if (i == len(existingLines)) {
        // Last line.

        if (partialRecNeeded && sign * (totalAmountCurrency + amountCurrency) < 0.0) {

          // On the last aml, when the total matched amount becomes higher than the residual amount of the
          // statement line, make sure to not create an open balance later.
          lineVals = await this._prepareCounterpartMoveLineVals(
            {
              ...counterpartVals,
              'amountResidual': - copysign(totalBalance, balance),
              'amountResidualCurrency': - copysign(totalAmountCurrency, amountCurrency),
              'currencyId': foreignCurrency.id,
            },
            line,
          )
          balance = lineVals['debit'] - lineVals['credit'];
          amountCurrency = lineVals['amountCurrency'];
        }
      }

      else if (sign * totalAmountCurrency < 0.0) {
        // The partial reconciliation is no longer an option since the total matched amount is now higher than
        // the residual amount of the statement line but this is not the last line to process. Then, since we
        // don't want to create zero balance lines, do nothing and let the open-balance be created like it
        // should.
        partialRecNeeded = false;
      }
      totalBalance += balance;
      totalAmountCurrency += amountCurrency;

      reconciliationOverview.push({
        'lineVals': lineVals,
        'counterpartLine': line,
      })
    }

    // Step 3: Fix rounding issue due to currency conversions.
    // Add the remaining balance on the first encountered line starting with the custom ones.

    if (await foreignCurrency.isZero(totalAmountCurrency) && ! await companyCurrency.isZero(totalBalance)) {
      const vals = reconciliationOverview[0]['lineVals'];
      const newBalance = vals['debit'] - vals['credit'] - totalBalance;
      update(vals, {
        'debit': newBalance > 0.0 ? newBalance : 0.0,
        'credit': newBalance < 0.0 ? -newBalance : 0.0,
      });
      totalBalance = 0.0;
    }

    // Step 4: If the journal entry is not yet balanced, create an open balance.
    const companyCurrencyId = await this['companyCurrencyId'];
    let openBalanceVals;
    if (await companyCurrencyId.round(totalBalance)) {
      const counterpartVals = {
        'label': f('%s: %s', await this['paymentRef'], await this._t('Open Balance')),
        'balance': -totalBalance,
        'currencyId': this['companyCurrencyId'].id,
      }

      let [partnerId, companyId, amount] = await this('partnerId', 'companyId', 'amount');
      partnerId = partnerId.ok ? partnerId : (await existingLines.mapped('partnerId')).slice(0, 1);
      let openBalanceAccount;
      if (partnerId.ok) {
        if (amount > 0) {
          openBalanceAccount = await (await partnerId.withCompany(companyId)).propertyAccountReceivableId;
        }
        else {
          openBalanceAccount = await (await partnerId.withCompany(companyId)).propertyAccountPayableId;
        }

        counterpartVals['accountId'] = openBalanceAccount.id;
        counterpartVals['partnerId'] = partnerId.id;
      }
      else {
        if (amount > 0) {
          openBalanceAccount = await (await (await companyId.partnerId).withCompany(companyId)).propertyAccountReceivableId;
        }
        else {
          openBalanceAccount = await (await (await companyId.partnerId).withCompany(companyId)).propertyAccountPayableId;
        }
        counterpartVals['accountId'] = openBalanceAccount.id;
      }
      openBalanceVals = await this._prepareCounterpartMoveLineVals(counterpartVals);
    }
    else {
      openBalanceVals = null;
    }

    return [reconciliationOverview, openBalanceVals];
  }

  /**
   * Perform a reconciliation on the current account.bank.statement.line with some
      counterpart account.move.line.
      If the statement line entry is not fully balanced after the reconciliation, an open balance will be created
      using the partner.

      @param linesValsList: A list of dictionary containing:
          'id':               Optional id of an existing account.move.line.
                              For each line having an 'id', a new line will be created in the current statement line.
          'balance':          Optional amount to consider during the reconciliation. If a foreign currency is set on the
                              counterpart line in the same foreign currency as the statement line, then this amount is
                              considered as the amount in foreign currency. If not specified, the full balance is taken.
                              This value must be provided if 'id' is not.
          **kwargs:           Custom values to be set on the newly created account.move.line.
      @param toCheck:        Mark the current statement line as "to_check" (see field for more details).
      @param allowPartial:   In case of matching a line having an higher amount, allow creating a partial instead
                              of an open balance on the statement line.
   */
  async reconcile(linesValsList, toCheck: boolean = false, allowPartial: boolean = false) {
    this.ensureOne();
    const [liquidityLines, suspenseLines, otherLines] = await this._seekForLines();

    const [reconciliationOverview, openBalanceVals] = await this._prepareReconciliation(
      linesValsList,
      allowPartial,
    );

    // ==== Manage res.partner.bank ====
    const [partnerId, accountNumber, moveId] = await this('partnerId', 'accountNumber', 'moveId');
    if (accountNumber && partnerId.ok && !(this['partnerBankId']).ok) {
      await this.set('partnerBankId', await this._findOrCreateBankAccount());
    }

    // ==== Check open balance ====

    if (bool(openBalanceVals)) {
      if (!openBalanceVals['partnerId']) {
        throw new UserError(await this._t("Unable to create an open balance for a statement line without a partner set."));
      }
      if (!openBalanceVals['accountId']) {
        throw new UserError(await this._t("Unable to create an open balance for a statement line because the receivable / payable accounts are missing on the partner."));
      }
    }
    // ==== Create & reconcile lines on the bank statement line ====

    const toCreateCommands = bool(openBalanceVals) ? [[0, 0, openBalanceVals]] : [];
    const toDeleteCommands = suspenseLines.map(line => [2, line.id]).concat(otherLines);

    // Cleanup previous lines.
    await (await moveId.withContext({ checkMoveValidity: false, skipAccountMoveSynchronization: true, forceDelete: true })).write({
      'lineIds': toDeleteCommands.concat(toCreateCommands),
      'toCheck': toCheck,
    })

    const lineValsList = reconciliationOverview.map(reconciliationVals => reconciliationVals['lineVals']);
    let newLines = await this.env.items('account.move.line').create(lineValsList);
    newLines = await newLines.withContext({ skipAccountMoveSynchronization: true });
    for (const [reconciliationVals, line] of _.zip<any, any>(reconciliationOverview, [...newLines])) {
      let counterpartLine;
      if (reconciliationVals['counterpartLine']) {
        counterpartLine = reconciliationVals['counterpart_line'];
      }
      else {
        continue;
      }

      await line.add(counterpartLine).reconcile();
    }

    // Assign partner if needed (for example, when reconciling a statement
    // line with no partner, with an invoice; assign the partner of this invoice)
    if (!partnerId.ok) {
      const recOverviewPartners = Array.from(new Set(await Promise.all(reconciliationOverview.filter(overview => overview['counterpartLine']).map(async (overview) => (await overview['counterpartLine'].partnerId).id))));
      if (len(recOverviewPartners) == 1 && !recOverviewPartners.includes(false)) {
        await (await this['lineIds']).write({ 'partnerId': recOverviewPartners.pop() });
      }
    }

    // Refresh analytic lines.
    const moveLineIds = await moveId.lineIds;
    await (await moveLineIds.analyticLineIds).unlink();
    await moveLineIds.createAnalyticLines();
  }

  // BUSINESS METHODS

  async _findOrCreateBankAccount() {
    let bankAccount = await this.env.items('res.partner.bank').search(
      [['companyId', '=', (await this['companyId']).id], ['accNumber', '=', await this['accountNumber']]]);
    if (!bool(bankAccount)) {
      bankAccount = await this.env.items('res.partner.bank').create({
        'accNumber': await this['accountNumber'],
        'partnerId': (await this['partnerId']).id,
        'companyId': (await this['companyId']).id,
      });
    }
    return bankAccount;
  }

  /**
   * Undo the reconciliation mades on the statement line and reset their journal items
      to their original states.
   */
  async buttonUndoReconciliation() {
    await (await this['lineIds']).removeMoveReconcile();
    await (await this['paymentIds']).unlink();

    for (const stLine of this) {
      await (await stLine.withContext({ forceDelete: true })).write({
        'toCheck': false,
        'lineIds': [[5, 0]].concat(await (await stLine._prepareMoveLineDefaultVals()).map(lineVals => [0, 0, lineVals])),
      })
    }
  }
}
