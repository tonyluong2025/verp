import { api } from "../../../core";
import { setdefault } from "../../../core/api/func";
import { Command, Fields, _Date } from "../../../core/fields";
import { UserError, ValidationError } from "../../../core/helper/errors";
import { MetaModel, Model, _super } from "../../../core/models";
import { bool, update } from "../../../core/tools";
import { dateMax } from "../../../core/tools/date_utils";
import { len } from "../../../core/tools/iterable";
import { stringify } from "../../../core/tools/json";

@MetaModel.define()
class AccountPartialReconcile extends Model {
  static _module = module;
  static _name = "account.partial.reconcile";
  static _description = "Partial Reconcile";
  static _recName = "id";

  // ==== Reconciliation fields ====
  static debitMoveId = Fields.Many2one({ comodelName: 'account.move.line', index: true, required: true });
  static creditMoveId = Fields.Many2one({ comodelName: 'account.move.line', index: true, required: true });
  static fullReconcileId = Fields.Many2one({ comodelName: 'account.full.reconcile', string: "Full Reconcile", copy: false });

  // ==== Currency fields ====
  static companyCurrencyId = Fields.Many2one({ comodelName: 'res.currency', string: "Company Currency", related: 'companyId.currencyId', help: "Utility field to express amount currency" });
  static debitCurrencyId = Fields.Many2one({ comodelName: 'res.currency', store: true, compute: '_computeDebitCurrencyId', string: "Currency of the debit journal item." });
  static creditCurrencyId = Fields.Many2one({ comodelName: 'res.currency', store: true, compute: '_computeCreditCurrencyId', string: "Currency of the credit journal item." });

  // ==== Amount fields ====
  static amount = Fields.Monetary({ currencyField: 'companyCurrencyId', help: "Always positive amount concerned by this matching expressed in the company currency." });
  static debitAmountCurrency = Fields.Monetary({ currencyField: 'debitCurrencyId', help: "Always positive amount concerned by this matching expressed in the debit line foreign currency." });
  static creditAmountCurrency = Fields.Monetary({ currencyField: 'creditCurrencyId', help: "Always positive amount concerned by this matching expressed in the credit line foreign currency." });

  // ==== Other fields ====
  static companyId = Fields.Many2one({ comodelName: 'res.company', string: "Company", store: true, readonly: false, related: 'debitMoveId.companyId' });
  static maxDate = Fields.Date({ string: "Max Date of Matched Lines", store: true, compute: '_computeMaxDate', help: "Technical field used to determine at which date this reconciliation needs to be shown on the aged receivable/payable reports." });

  // CONSTRAINT METHODS

  @api.constrains('debitCurrencyId', 'creditCurrencyId')
  async _checkRequiredComputedCurrencies() {
    const badPartials = await this.filtered(async (partial) => !bool(await partial.debitCurrencyId) || !bool(await partial.creditCurrencyId));
    if (badPartials.ok) {
      throw new ValidationError(await this._t("Missing foreign currencies on partials having ids: %s", badPartials.ids));
    }
  }

  // COMPUTE METHODS

  @api.depends('debitMoveId.date', 'creditMoveId.date')
  async _computeMaxDate() {
    for (const partial of this) {
      await partial.set('maxDate', dateMax(
        await (await partial.debitMoveId).date,
        await (await partial.creditMoveId).date
      ));
    }
  }

  @api.depends('debitMoveId')
  async _computeDebitCurrencyId() {
    for (const partial of this) {
      const debitMoveId = await partial.debitMoveId;
      const currencyId = await debitMoveId.currencyId;
      await partial.set('debitCurrencyId', currencyId.ok ? currencyId : await debitMoveId.companyCurrencyId);
    }
  }

  @api.depends('creditMoveId')
  async _computeCreditCurrencyId() {
    for (const partial of this) {
      const creditMoveId = await partial.creditMoveId;
      const currencyId = await creditMoveId.currencyId;
      await partial.set('creditCurrencyId', currencyId.ok ? currencyId : await creditMoveId.companyCurrencyId);
    }
  }

  // LOW-LEVEL METHODS

  async unlink() {
    // OVERRIDE to unlink full reconcile linked to the current partials
    // and reverse the tax cash basis journal entries.

    // Avoid cyclic unlink calls when removing the partials that could remove some full reconcile
    // and then, loop again and again.
    if (!this.ok) {
      return true;
    }

    // Retrieve the matching number to unlink.
    const fullToUnlink = await this['fullReconcileId'];

    // Retrieve the CABA entries to reverse.
    const movesToReverse = await this.env.items('account.move').search([['taxCashBasisRecId', 'in', this.ids]]);

    // Unlink partials before doing anything else to avoid 'Record has already been deleted' due to the recursion.
    const res = await _super(AccountPartialReconcile, this).unlink();

    // Reverse CABA entries.
    const today = await _Date.contextToday(this);
    const defaultValuesList = await movesToReverse.map(async (move) => {
      const [label, date, companyId] = await move('label', 'date', 'companyId');
      return {
        'date': date > (await companyId.periodLockDate || _Date.min) ? date : today,
        'ref': await this._t('Reversal of: %s', label),
      }
    });
    await movesToReverse._reverseMoves(defaultValuesList, true);

    // Remove the matching numbers.
    await fullToUnlink.unlink();

    return res;
  }

  // RECONCILIATION METHODS

  /**
   * Collect all information needed to create the tax cash basis journal entries on the current partials.
      :return:    A dictionary mapping each moveId to the result of 'account_move._collect_tax_cash_basis_values'.
                  Also, add the 'partials' keys being a list of dictionary, one for each partial to process:
                      * partial:          The account.partial.reconcile record.
                      * percentage:       The reconciled percentage represented by the partial.
                      * payment_rate:     The applied rate of this partial.
   * @returns 
   */
  async _collectTaxCashBasisValues() {
    const taxCashBasisValuesPerMove = {};

    if (!this.ok) {
      return {};
    }

    for (const partial of this) {
      const [debitMoveId, creditMoveId, companyId, amount, debitAmountCurrency, creditAmountCurrency] = await partial('debitMoveId', 'creditMoveId', 'companyId', 'amount', 'debitAmountCurrency', 'creditAmountCurrency');
      for (const move of [await debitMoveId.moveId, await creditMoveId.moveId]) {

        // Collect data about cash basis.
        if (!(move.id in taxCashBasisValuesPerMove)) {
          taxCashBasisValuesPerMove[move.id] = await move._collectTaxCashBasisValues();
        }
        // Nothing to process on the move.
        if (!taxCashBasisValuesPerMove[move.id]) {
          continue;
        }
        const moveValues = taxCashBasisValuesPerMove[move.id];

        // Check the cash basis configuration only when at least one cash basis tax entry need to be created.
        const journal = await companyId.taxCashBasisJournalId;

        if (!journal.ok) {
          throw new UserError(await this._t(`There is no tax cash basis journal defined for the '%s' company.\n
                                      Configure it in Accounting/Configuration/Settings`, await companyId.displayName));
        }

        let partialAmount = 0.0;
        let partialAmountCurrency = 0.0;
        let rateAmount = 0.0;
        let rateAmountCurrency = 0.0;
        let sourceLine, counterpartLine;
        if ((await debitMoveId.moveId).eq(move)) {
          partialAmount += amount;
          partialAmountCurrency += debitAmountCurrency;
          rateAmount -= await creditMoveId.balance;
          rateAmountCurrency -= await creditMoveId.amountCurrency;
          sourceLine = debitMoveId;
          counterpartLine = creditMoveId;
        }
        if ((await creditMoveId.moveId).eq(move)) {
          partialAmount += amount;
          partialAmountCurrency += creditAmountCurrency;
          rateAmount += await debitMoveId.balance;
          rateAmountCurrency += await debitMoveId.amountCurrency;
          sourceLine = creditMoveId;
          counterpartLine = debitMoveId;
        }

        let percentage;
        if (moveValues['currency'].eq(await (await move.companyId).currencyId)) {
          // Percentage made on company's currency.
          percentage = partialAmount / moveValues['totalBalance'];
        }
        else {
          // Percentage made on foreign currency.
          percentage = partialAmountCurrency / moveValues['totalAmountCurrency'];
        }

        let paymentRate;
        if (!(await sourceLine.currencyId).eq(await counterpartLine.currencyId)) {
          // When the invoice and the payment are not sharing the same foreign currency, the rate is computed
          // on-the-fly using the payment date.
          paymentRate = await this.env.items('res.currency')._getConversionRate(
            await counterpartLine.companyCurrencyId,
            await sourceLine.currencyId,
            await counterpartLine.companyId,
            await counterpartLine.date,
          )
        }
        else if (rateAmount) {
          paymentRate = rateAmountCurrency / rateAmount;
        }
        else {
          paymentRate = 0.0;
        }

        const partialVals = {
          'partial': partial,
          'percentage': percentage,
          'paymentRate': paymentRate,
        }

        // Add partials.
        setdefault(moveValues, 'partials', []);
        moveValues['partials'].push(partialVals);
      }
    }
    // Clean-up moves having nothing to process.
    return Object.fromEntries(Object.entries(taxCashBasisValuesPerMove).filter(([k, v]) => v));
  }

  /**
   * Prepare the values to be used to create the cash basis journal items for the tax base line
      passed as parameter.

      :param base_line:       An account.move.line being the base of some taxes.
      :param balance:         The balance to consider for this line.
      :param amount_currency: The balance in foreign currency to consider for this line.
      :return:                A dictionary that could be passed to the create method of
                              account.move.line.
   * @param baseLine 
   * @param balance 
   * @param amountCurrency 
   * @returns 
   */
  @api.model()
  async _prepareCashBasisBaseLineVals(baseLine, balance, amountCurrency) {
    let account = await (await baseLine.companyId).accountCashBasisBaseAccountId;
    account = account.ok ? account : await baseLine.accountId;
    const taxIds = await (await baseLine.taxIds).filtered(async (x) => await x.taxExigibility === 'onPayment');
    const isRefund = await baseLine.belongsToRefund();
    const taxTags = await taxIds.getTaxTags(isRefund, 'base');
    const productTags = await (await baseLine.taxTagIds).filtered(async (x) => await x.applicability === 'products');
    const allTags = taxTags.add(productTags);

    return {
      'labe;': await (await baseLine.moveId).label,
      'debit': balance > 0.0 ? balance : 0.0,
      'credit': balance < 0.0 ? -balance : 0.0,
      'amountCurrency': amountCurrency,
      'currencyId': (await baseLine.currencyId).id,
      'partnerId': (await baseLine.partnerId).id,
      'accountId': account.id,
      'taxIds': [Command.set(taxIds.ids)],
      'taxTagIds': [Command.set(allTags.ids)],
      'taxTagInvert': await baseLine.taxTagInvert,
    }
  }

  /**
   * Prepare the move line used as a counterpart of the line created by
      _prepare_cash_basis_base_line_vals.

      :param cb_base_line_vals:   The line returned by _prepare_cash_basis_base_line_vals.
      :return:                    A dictionary that could be passed to the create method of
                                  account.move.line.
   * @param cbBaseLineVals 
   * @returns 
   */
  @api.model()
  async _prepareCashBasisCounterpartBaseLineVals(cbBaseLineVals) {
    return {
      'label': cbBaseLineVals['label'],
      'debit': cbBaseLineVals['credit'],
      'credit': cbBaseLineVals['debit'],
      'accountId': cbBaseLineVals['accountId'],
      'amountCurrency': -cbBaseLineVals['amountCurrency'],
      'currencyId': cbBaseLineVals['currencyId'],
      'partnerId': cbBaseLineVals['partnerId'],
    }
  }

  /**
   * Prepare the move line corresponding to a tax in the cash basis entry.

      :param tax_line:        An account.move.line record being a tax line.
      :param balance:         The balance to consider for this line.
      :param amount_currency: The balance in foreign currency to consider for this line.
      :return:                A dictionary that could be passed to the create method of
                              account.move.line.
   * @param taxLine 
   * @param balance 
   * @param amountCurrency 
   * @returns 
   */
  @api.model()
  async _prepareCashBasisTaxLineVals(taxLine, balance, amountCurrency) {
    const taxIds = await (await taxLine.taxIds).filtered(async (x) => await x.taxExigibility === 'onPayment');
    const baseTags = await taxIds.getTaxTags(await (await taxLine.taxRepartitionLineId).refundTaxId, 'base');
    const productTags = await (await taxLine.taxTagIds).filtered(async (x) => await x.applicability === 'products');
    const allTags = baseTags.add(await (await taxLine.taxRepartitionLineId).tagIds).add(productTags);

    return {
      'label': await taxLine.label,
      'debit': balance > 0.0 ? balance : 0.0,
      'credit': balance < 0.0 ? -balance : 0.0,
      'taxBaseAmount': await taxLine.taxBaseAmount,
      'taxRepartitionLineId': (await taxLine.taxRepartitionLineId).id,
      'taxIds': [Command.set(taxIds.ids)],
      'taxTagIds': [Command.set(allTags.ids)],
      'accountId': (await (await taxLine.taxRepartitionLineId).accountId).id || (await taxLine.accountId).id,
      'amountCurrency': amountCurrency,
      'currencyId': (await taxLine.currencyId).id,
      'partnerId': (await taxLine.partnerId).id,
      // No need to set tax_tag_invert as on the base line; it will be computed from the repartition line
    }
  }
  /**
   * Prepare the move line used as a counterpart of the line created by
      _prepare_cash_basis-tax_line_vals.

      :param tax_line:            An account.move.line record being a tax line.
      :param cb_tax_line_vals:    The result of _prepare_cash_basis_counterpart_tax_line_vals.
      :return:                    A dictionary that could be passed to the create method of
                                  account.move.line.
   */
  @api.model()
  async _prepareCashBasisCounterpartTaxLineVals(taxLine, cbTaxLineVals) {
    return {
      'label': cbTaxLineVals['label'],
      'debit': cbTaxLineVals['credit'],
      'credit': cbTaxLineVals['debit'],
      'accountId': (await taxLine.accountId).id,
      'amountCurrency': -cbTaxLineVals['amountCurrency'],
      'currencyId': cbTaxLineVals['currencyId'],
      'partnerId': cbTaxLineVals['partnerId'],
    }
  }

  /**
   * Get the grouping key of a cash basis base line that hasn't yet been created.
      :param base_line_vals:  The values to create a new account.move.line record.
      :return:                The grouping key as a tuple.
   * @param baseLineVals 
   * @returns 
   */
  @api.model()
  async _getCashBasisBaseLineGroupingKeyFromVals(baseLineVals) {
    const taxIds = baseLineVals['taxIds'][0][2] // Decode [(6, 0, [...])] command
    const baseTaxes = this.env.items('account.tax').browse(taxIds);
    return [
      baseLineVals['currencyId'],
      baseLineVals['partnerId'],
      baseLineVals['accountId'],
      Array.from((await baseTaxes.filtered(async (x) => await x.taxExigibility === 'onPayment')).ids),
    ];
  }

  /**
   * Get the grouping key of a journal item being a base line.
      :param base_line:   An account.move.line record.
      :param account:     Optional account to shadow the current base_line one.
      :return:            The grouping key as a tuple.
   * @param baseLine 
   * @param account 
   * @returns 
   */
  @api.model()
  async _getCashBasisBaseLineGroupingKeyFromRecord(baseLine, account?: any) {
    return [
      (await baseLine.currencyId).id,
      (await baseLine.partnerId).id,
      (bool(account) ? account : await baseLine.accountId).id,
      Array.from((await (await baseLine.taxIds).filtered(async (x) => await x.taxExigibility === 'onPayment')).ids),
    ];
  }

  /**
   * Get the grouping key of a cash basis tax line that hasn't yet been created.
      :param tax_line_vals:   The values to create a new account.move.line record.
      :return:                The grouping key as a tuple.
   * @param taxLineVals 
   * @returns 
   */
  @api.model()
  async _getCashBasisTaxLineGroupingKeyFromVals(taxLineVals) {
    const taxIds = taxLineVals['taxIds'][0][2] // Decode [(6, 0, [...])] command
    const baseTaxes = this.env.items('account.tax').browse(taxIds);
    return [
      taxLineVals['currencyId'],
      taxLineVals['partnerId'],
      taxLineVals['accountId'],
      Array.from((await baseTaxes.filtered(async (x) => await x.taxExigibility === 'onPayment')).ids),
      taxLineVals['taxRepartitionLineId'],
    ];
  }

  /**
   * Get the grouping key of a journal item being a tax line.
      :param tax_line:    An account.move.line record.
      :param account:     Optional account to shadow the current tax_line one.
      :return:            The grouping key as a tuple.
   * @param taxLine 
   * @param account 
   * @returns 
   */
  @api.model()
  async _getCashBasisTaxLineGroupingKeyFromRecord(taxLine, account?: any) {
    return [
      (await taxLine.currencyId).id,
      (await taxLine.partnerId).id,
      (bool(account) ? account : await taxLine.accountId).id,
      Array.from((await (await taxLine.taxIds).filtered(async (x) => await x.taxExigibility === 'onPayment')).ids),
      (await taxLine.taxRepartitionLineId).id,
    ];
  }

  /**
   * Create the tax cash basis journal entries.
      :return: The newly created journal entries.
   */
  async _createTaxCashBasisMoves() {
    const taxCashBasisValuesPerMove = await this._collectTaxCashBasisValues();

    const movesToCreate = [];
    const toReconcileAfter = [];
    for (const moveValues of Object.values(taxCashBasisValuesPerMove)) {
      const move = moveValues['move'];
      const pendingCashBasisLines = [];

      for (const partialValues of moveValues['partials']) {
        const partial = partialValues['partial'];

        // Init the journal entry.
        const moveVals = {
          'moveType': 'entry',
          'date': await partial.maxDate,
          'ref': await move.label,
          'journalId': (await (await partial.companyId).taxCashBasisJournalId).id,
          'lineIds': [],
          'taxCashBasisRecId': partial.id,
          'taxCashBasisOriginMoveId': move.id,
          'fiscalPositionId': (await move.fiscalPositionId).id,
        }

        // Tracking of lines grouped all together.
        // Used to reduce the number of generated lines and to avoid rounding issues.
        const partialLinesToCreate = {};

        for (const [cabaTreatment, line] of moveValues['toProcessLines']) {

          // ==========================================================================
          // Compute the balance of the current line on the cash basis entry.
          // This balance is a percentage representing the part of the journal entry
          // that is actually paid by the current partial.
          // ==========================================================================

          // Percentage expressed in the foreign currency.
          const amountCurrency = await (await line.currencyId).round(await line.amountCurrency * partialValues['percentage']);
          let balance = partialValues['paymentRate'] && amountCurrency / partialValues['paymentRate'] || 0.0;

          // ==========================================================================
          // Prepare the mirror cash basis journal item of the current line.
          // Group them all together as much as possible to reduce the number of
          // generated journal items.
          // Also track the computed balance in order to avoid rounding issues when
          // the journal entry will be fully paid. At that case, we expect the exact
          // amount of each line has been covered by the cash basis journal entries
          // and well reported in the Tax Report.
          // ==========================================================================

          let groupingKey, cbLineVals;
          if (cabaTreatment === 'tax') {
            // Tax line.

            cbLineVals = await this._prepareCashBasisTaxLineVals(line, balance, amountCurrency);
            groupingKey = stringify(await this._getCashBasisTaxLineGroupingKeyFromVals(cbLineVals));
          }
          else if (cabaTreatment === 'base') {
            // Base line.

            cbLineVals = await this._prepareCashBasisBaseLineVals(line, balance, amountCurrency);
            groupingKey = stringify(await this._getCashBasisBaseLineGroupingKeyFromVals(cbLineVals));
          }
          if (groupingKey in partialLinesToCreate) {
            const aggregatedVals = partialLinesToCreate[groupingKey]['vals'];

            const debit = aggregatedVals['debit'] + cbLineVals['debit'];
            const credit = aggregatedVals['credit'] + cbLineVals['credit'];
            balance = debit - credit;

            update(aggregatedVals, {
              'debit': balance > 0 ? balance : 0,
              'credit': balance < 0 ? -balance : 0,
              'amountCurrency': aggregatedVals['amountCurrency'] + cbLineVals['amountCurrency'],
            });

            if (cabaTreatment === 'tax') {
              update(aggregatedVals, {
                'taxBaseAmount': aggregatedVals['taxBaseAmount'] + cbLineVals['taxBaseAmount'],
              });
              partialLinesToCreate[groupingKey]['taxLine'] += line;
            }
          }
          else {
            partialLinesToCreate[groupingKey] = {
              'vals': cbLineVals,
            }
            if (cabaTreatment === 'tax') {
              update(partialLinesToCreate[groupingKey], {
                'taxLine': line,
              });
            }
          }
        }

        // ==========================================================================
        // Create the counterpart journal items.
        // ==========================================================================

        // To be able to retrieve the correct matching between the tax lines to reconcile
        // later, the lines will be created using a specific sequence.
        let sequence = 0;

        for (const [groupingKey, aggregatedVals] of Object.entries(partialLinesToCreate)) {
          const lineVals = aggregatedVals['vals'];
          lineVals['sequence'] = sequence;

          pendingCashBasisLines.push([groupingKey, lineVals['amountCurrency']]);
          let counterpartLineVals;
          if ('taxRepartitionLineId' in lineVals) {
            // Tax line.

            const taxLine = aggregatedVals['taxLine'];
            counterpartLineVals = await this._prepareCashBasisCounterpartTaxLineVals(taxLine, lineVals);
            counterpartLineVals['sequence'] = sequence + 1;

            if (await (await taxLine.accountId).reconcile) {
              const moveIndex = len(movesToCreate);
              toReconcileAfter.push([taxLine, moveIndex, counterpartLineVals['sequence']]);
            }
          }
          else {
            // Base line.

            counterpartLineVals = await this._prepareCashBasisCounterpartBaseLineVals(lineVals);
            counterpartLineVals['sequence'] = sequence + 1;
          }

          sequence += 2;

          moveVals['lineIds'] = moveVals['lineIds'].concat([[0, 0, counterpartLineVals], [0, 0, lineVals]]);
        }

        movesToCreate.push(moveVals);
      }
    }

    const moves = await this.env.items('account.move').create(movesToCreate);
    await moves._post(false);

    // Reconcile the tax lines being on a reconcile tax basis transfer account.
    for (let [lines, moveIndex, sequence] of toReconcileAfter) {

      // In expenses, all move lines are created manually without any grouping on tax lines.
      // In that case, 'lines' could be already reconciled.
      lines = await lines.filtered(async (x) => !await x.reconciled);
      if (!lines.ok) {
        continue;
      }

      const counterpartLine = await (await moves[moveIndex].lineIds).filtered(async (line) => await line.sequence == sequence);

      // When dealing with tiny amounts, the line could have a zero amount and then, be already reconciled.
      if (await counterpartLine.reconciled) {
        continue;
      }

      await lines.add(counterpartLine).reconcile();
    }
    return moves;
  }
}