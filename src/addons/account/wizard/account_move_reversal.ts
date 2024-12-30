import _ from "lodash";
import { Fields, _Date, api } from "../../../core";
import { UserError } from "../../../core/helper/errors";
import { MetaModel, TransientModel, _super } from "../../../core/models";
import { bool } from "../../../core/tools/bool";
import { len } from "../../../core/tools/iterable";
import { update } from "../../../core/tools/misc";
import { _f } from "../../../core/tools/utils";

/**
 * Account move reversal wizard, it cancel an account move by reversing it.
 */
@MetaModel.define()
class AccountMoveReversal extends TransientModel {
  static _module = module;
  static _name = 'account.move.reversal';
  static _description = 'Account Move Reversal';
  static _checkCompanyAuto = true;

  static moveIds = Fields.Many2many('account.move', { relation: 'accountMoveReversalMove', column1: 'reversalId', column2: 'moveId', domain: [['state', '=', 'posted']] });
  static newMoveIds = Fields.Many2many('account.move', { relation: 'accountMoveReversalNewMove', column1: 'reversalId', column2: 'newMoveId' });
  static dateMode = Fields.Selection({
    selection: [
      ['custom', 'Specific'],
      ['entry', 'Journal Entry Date']
    ], required: true, default: 'custom'
  });
  static date = Fields.Date({ string: 'Reversal date', default: self => _Date.contextToday(self) });
  static reason = Fields.Char({ string: 'Reason' });
  static refundMethod = Fields.Selection({
    selection: [
      ['refund', 'Partial Refund'],
      ['cancel', 'Full Refund'],
      ['modify', 'Full refund and new draft invoice']
    ], string: 'Credit Method', required: true,
    help: 'Choose how you want to credit this invoice. You cannot "modify" nor "cancel" if the invoice is already reconciled.'
  });
  static journalId = Fields.Many2one({
    comodelName: 'account.journal',
    string: 'Use Specific Journal',
    required: true,
    compute: '_computeJournalId',
    readonly: false,
    store: true,
    checkCompany: true,
    help: 'If empty, uses the journal of the journal entry to be reversed.',
  });
  static companyId = Fields.Many2one('res.company', { required: true, readonly: true });
  static availableJournalIds = Fields.Many2many('account.journal', { compute: '_computeAvailableJournalIds' });
  static countryCode = Fields.Char({ related: 'companyId.countryId.code' });

  // computed fields
  static residual = Fields.Monetary({ compute: "_computeFromMoves" });
  static currencyId = Fields.Many2one('res.currency', { compute: "_computeFromMoves" });
  static moveType = Fields.Char({ compute: "_computeFromMoves" });

  @api.depends('moveIds')
  async _computeJournalId() {
    for (const record of this) {
      if (bool(await record.journalId)) {
        await record.set('journalId', await record.journalId);
      }
      else {
        const journals = await (await (await record.moveIds).journalId).filtered((x) => x.active)
        await record.set('journalId', journals.ok ? journals[0] : null);
      }
    }
  }

  @api.depends('moveIds')
  async _computeAvailableJournalIds() {
    for (const record of this) {
      if (bool(await record.moveIds)) {
        await record.set('availableJournalIds', await this.env.items('account.journal').search([
          ['companyId', '=', (await record.companyId).id],
          ['type', 'in', await (await (await record.moveIds).journalId).mapped('type')],
        ]));
      }
      else {
        await record.set('availableJournalIds', await this.env.items('account.journal').search([['companyId', '=', (await record.companyId).id]]));
      }
    }
  }

  @api.constrains('journalId', 'moveIds')
  async _checkJournalType() {
    for (const record of this) {
      if (!(await (await (await record.moveIds).journalId).mapped('type')).includes(await (await record.journalId).type)) {
        throw new UserError(await this._t('Journal should be the same type as the reversed entry.'));
      }
    }
  }

  @api.model()
  async defaultGet(fields) {
    const res = await _super(AccountMoveReversal, this).defaultGet(fields);
    const moveIds = this.env.context['activeModel'] === 'account.move' ? this.env.items('account.move').browse(this.env.context['activeIds']) : this.env.items('account.move');

    if (await moveIds.some(async (move) => await move.state != "posted")) {
      throw new UserError(await this._t('You can only reverse posted moves.'));
    }
    if ('companyId' in fields) {
      res['companyId'] = (await moveIds.companyId).id || (await this.env.company()).id;
    }
    if ('moveIds' in fields) {
      res['moveIds'] = [[6, 0, moveIds.ids]];
    }
    if ('refundMethod' in fields) {
      res['refundMethod'] = (len(moveIds) > 1 || await moveIds.moveType === 'entry') ? 'cancel' : 'refund';
    }
    return res;
  }

  @api.depends('moveIds')
  async _computeFromMoves() {
    for (const record of this) {
      const moveIds = (await record.moveIds)._origin;
      await record.set('residual', len(moveIds) == 1 && await moveIds.amountResidual || 0);
      await record.set('currencyId', len(await moveIds.currencyId) == 1 && await moveIds.currencyId || false);
      await record.set('moveType', len(moveIds) == 1 ? await moveIds.moveType : (await moveIds.some(async (move) => ['inInvoice', 'outInvoice'].includes(await move.moveType)) && 'someInvoice' || false));
    }
  }

  async _prepareDefaultReversal(move) {
    const reverseDate = await this['dateMode'] === 'custom' ? await this['date'] : await move.date;
    return {
      'ref': await this['reason'] ? _f(await this._t('Reversal of: {moveName}, {reason}'), { moveName: await move.name, reason: await this['reason'] })
        : await this._t('Reversal of: %s', await move.name),
      'date': reverseDate,
      'invoiceDate': await move.isInvoice(true) && (await this['date'] || await move.date) || false,
      'journalId': (await this['journalId']).id,
      'invoicePaymentTermId': null,
      'invoiceUserId': (await move.invoiceUserId).id,
      'autoPost': reverseDate > await _Date.contextToday(self) ? true : false,
    }
  }

  async reverseMoves() {
    this.ensureOne();
    const moves = await this['moveIds'];

    // Create default values.
    const defaultValuesList = [];
    for (const move of moves) {
      defaultValuesList.push(await this._prepareDefaultReversal(move));
    }
    const batches = [
      [this.env.items('account.move'), [], true],   // Moves to be cancelled by the reverses.
      [this.env.items('account.move'), [], false],  // Others.
    ];
    for (const [move, defaultVals] of _.zip([...moves], defaultValuesList)) {
      const isAutoPost = bool(defaultVals['autoPost']);
      const isCancelNeeded = !isAutoPost && ['cancel', 'modify'].includes(await this['refundMethod']);
      const batchIndex = isCancelNeeded ? 0 : 1;
      batches[batchIndex][0] = batches[batchIndex][0].or(move);
      batches[batchIndex][1].push(defaultVals);
    }

    // Handle reverse method.
    let movesToRedirect = this.env.items('account.move');
    for (const [moves, defaultValuesList, isCancelNeeded] of batches) {
      let newMoves = await moves._reverseMoves(defaultValuesList, isCancelNeeded);

      if (await this['refundMethod'] === 'modify') {
        const movesValsList = [];
        for (const move of await moves.withContext({ includeBusinessFields: true })) {
          movesValsList.push(await move.copyData({ 'date': this['dateMode'] == 'custom' ? await this['date'] : await move.date })[0]);
        }
        newMoves = await this.env.items('account.move').create(movesValsList);
      }
      movesToRedirect = movesToRedirect.or(newMoves);
    }

    await this.set('newMoveIds', movesToRedirect);

    // Create action.
    const action = {
      'label': await this._t('Reverse Moves'),
      'type': 'ir.actions.actwindow',
      'resModel': 'account.move',
    }
    if (len(movesToRedirect) == 1) {
      update(action, {
        'viewMode': 'form',
        'resId': movesToRedirect.id,
        'context': { 'default_moveType': await movesToRedirect.moveType },
      })
    }
    else {
      update(action, {
        'viewMode': 'tree,form',
        'domain': [['id', 'in', movesToRedirect.ids]],
      })
      if (len(new Set(await movesToRedirect.mapped('moveType'))) == 1) {
        action['context'] = { 'default_moveType': (await movesToRedirect.mapped('moveType')).pop() };
      }
    }
    return action
  }
}