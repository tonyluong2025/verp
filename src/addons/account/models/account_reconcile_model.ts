import _ from "lodash";
import { DateTime } from "luxon";
import { api, tools } from "../../../core";
import { Command, Fields, _Date } from "../../../core/fields";
import { UserError, ValidationError, ValueError } from "../../../core/helper/errors";
import { MetaModel, Model } from "../../../core/models";
import { getUnaccentWrapper } from "../../../core/osv/expression";
import { _f, extend, f, html2Text, isInstance, len, sum } from "../../../core/tools";
import { bool } from "../../../core/tools/bool";
import { copysign, update } from "../../../core/tools/misc";

@MetaModel.define()
class AccountReconcileModelPartnerMapping extends Model {
  static _module = module;
  static _name = 'account.reconcile.model.partner.mapping';
  static _description = 'Partner mapping for reconciliation models';

  static modelId = Fields.Many2one({ comodelName: 'account.reconcile.model', readonly: true, required: true, ondelete: 'CASCADE' });
  static partnerId = Fields.Many2one({ comodelName: 'res.partner', string: "Partner", required: true, ondelete: 'CASCADE' });
  static paymentRefRegex = Fields.Char({ string: "Find Text in Label" });
  static narrationRegex = Fields.Char({ string: "Find Text in Notes" });

  @api.constrains('narrationRegex', 'paymentRefRegex')
  async validateRegex() {
    for (const record of this) {
      const [narrationRegex, paymentRefRegex] = await record('narrationRegex', 'paymentRefRegex');
      let currentRegex;
      if (!(narrationRegex || paymentRefRegex)) {
        throw new ValidationError(await this._t("Please set at least one of the match texts to create a partner mapping."));
      }
      try {
        if (paymentRefRegex) {
          currentRegex = paymentRefRegex;
          new RegExp(paymentRefRegex);
        }
        if (narrationRegex) {
          currentRegex = narrationRegex;
          new RegExp(narrationRegex);
        }
      } catch (e) {
        // except re.error:
        throw new ValidationError(await this._t("The following regular expression is invalid to create a partner mapping: %s", currentRegex));
      }
    }
  }
}

@MetaModel.define()
class AccountReconcileModelLine extends Model {
  static _module = module;
  static _name = 'account.reconcile.model.line';
  static _description = 'Rules for the reconciliation model';
  static _order = 'sequence, id';
  static _checkCompanyAuto = true;

  static modelId = Fields.Many2one('account.reconcile.model', { readonly: true, ondelete: 'CASCADE' });
  static allowPaymentTolerance = Fields.Boolean({ related: 'modelId.allowPaymentTolerance' });
  static paymentToleranceParam = Fields.Float({ related: 'modelId.paymentToleranceParam' });
  static ruleType = Fields.Selection({ related: 'modelId.ruleType' });
  static companyId = Fields.Many2one({ related: 'modelId.companyId', store: true });
  static sequence = Fields.Integer({ required: true, default: 10 });
  static accountId = Fields.Many2one('account.account', {
    string: 'Account', ondelete: 'CASCADE',
    domain: "[['deprecated', '=', false], ['companyId', '=', companyId], ['isOffBalance', '=', false]]",
    required: true, checkCompany: true
  });
  static journalId = Fields.Many2one('account.journal', {
    string: 'Journal', ondelete: 'CASCADE',
    domain: "[['type', '=', 'general'], ['companyId', '=', companyId]]",
    help: "This field is ignored in a bank statement reconciliation.", checkCompany: true
  });
  static label = Fields.Char({ string: 'Journal Item Label' });
  static amountType = Fields.Selection([
    ['fixed', 'Fixed'],
    ['percentage', 'Percentage of balance'],
    ['percentageStLine', 'Percentage of statement line'],
    ['regex', 'From label'],
  ], { required: true, default: 'percentage' });
  static showForceTaxIncluded = Fields.Boolean({ compute: '_computeShowForceTaxIncluded', help: 'Technical field used to show the force tax included button' });
  static forceTaxIncluded = Fields.Boolean({ string: 'Tax Included in Price', help: 'Force the tax to be managed as a price included tax.' });
  static amount = Fields.Float({ string: "Float Amount", compute: '_computeFloatAmount', store: true, help: "Technical shortcut to parse the amount to a float" });
  static amountString = Fields.Char({
    string: "Amount", default: '100', required: true, help: `Value for the amount of the writeoff line
    * Percentage: Percentage of the balance, between 0 and 100.
    * Fixed: The fixed value of the writeoff. The amount will count as a debit if it is negative, as a credit if it is positive.
    * From Label: There is no need for regex delimiter, only the regex is needed. For instance if you want to extract the amount from\nR:9672938 10/07 AX 9415126318 T:5L:NA BRT: 3358,07 C:\nYou could enter\nBRT: ([\d,]+)`});
  static taxIds = Fields.Many2many('account.tax', { string: 'Taxes', ondelete: 'RESTRICT', checkCompany: true });
  static analyticAccountId = Fields.Many2one('account.analytic.account', { string: 'Analytic Account', ondelete: 'SET NULL', checkCompany: true });
  static analyticTagIds = Fields.Many2many('account.analytic.tag', { string: 'Analytic Tags', checkCompany: true, relation: 'accountReconcileModelAnalyticTagRel' });

  @api.onchange('taxIds')
  async _onchangeTaxIds() {
    // Multiple taxes with force_tax_included results in wrong computation, so we
    // only allow to set the force_tax_included field if we have one tax selected
    if (len(await this['taxIds']) != 1) {
      await this.set('forceTaxIncluded', false);
    }
  }

  @api.depends('taxIds')
  async _computeShowForceTaxIncluded() {
    for (const record of this) {
      await record.set('showForceTaxIncluded', len(await record.taxIds) != 1 ? false : true);
    }
  }

  @api.onchange('amountType')
  async _onchangeAmountType() {
    const amountType = await this['amountType'];
    await this.set('amountString', '');
    if (['percentage', 'percentageStLine'].includes(amountType)) {
      await this.set('amountString', '100');
    }
    else if (amountType === 'regex') {
      await this.set('amountString', '([\d,]+)');
    }
  }

  @api.depends('amountString')
  async _computeFloatAmount() {
    for (const record of this) {
      // try {
      await record.set('amount', tools.parseFloat(await record.amountString));
      // } catch(e) {
      //   if (isInstance(e, ValueError)) {
      //     await record.set('amount', 0);
      //   }
      //   else {
      //     throw e;
      //   }
      // }
    }
  }

  @api.constrains('amountString')
  async _validateAmount() {
    for (const record of this) {
      const [amountType, amount] = await record('amountType', 'amount');
      if (amountType === 'fixed' && amount == 0) {
        throw new UserError(await this._t("The amount is not a number"));
      }
      if (amountType === 'percentageStLine' && amount == 0) {
        throw new UserError(await this._t("Balance percentage can't be 0"));
      }
      if (amountType === 'percentage' && amount == 0) {
        throw new UserError(await this._t("Statement line percentage can't be 0"));
      }
      if (amountType === 'regex') {
        try {
          new RegExp(await record.amountString);
        } catch (e) {
          // except re.error:
          throw new UserError(await this._t('The regex is not valid'));
        }
      }
    }
  }
}

@MetaModel.define()
class AccountReconcileModel extends Model {
  static _module = module;
  static _name = 'account.reconcile.model';
  static _description = 'Preset to create journal entries during a invoices and payments matching';
  static _parents = ['mail.thread'];
  static _order = 'sequence, id';
  static _checkCompanyAuto = true;

  // Base Fields.
  static active = Fields.Boolean({ default: true });
  static label = Fields.Char({ string: 'Name', required: true });
  static sequence = Fields.Integer({ required: true, default: 10 });
  static companyId = Fields.Many2one({
    comodelName: 'res.company',
    string: 'Company', required: true, readonly: true,
    default: self => self.env.company()
  });
  static ruleType = Fields.Selection({
    selection: [
      ['writeoffButton', 'Button to generate counterpart entry'],
      ['writeoffSuggestion', 'Rule to suggest counterpart entry'],
      ['invoiceMatching', 'Rule to match invoices/bills'],
    ], string: 'Type', default: 'writeoffButton', required: true, tracking: true
  });
  static autoReconcile = Fields.Boolean({
    string: 'Auto-validate', tracking: true,
    help: 'Validate the statement line automatically (reconciliation based on your rule).'
  });
  static toCheck = Fields.Boolean({ string: 'To Check', default: false, help: 'This matching rule is used when the user is not certain of all the information of the counterpart.' });
  static matchingOrder = Fields.Selection({
    selection: [
      ['oldFirst', 'Oldest first'],
      ['newFirst', 'Newest first'],
    ],
    required: true,
    default: 'oldFirst',
    tracking: true,
  });

  // ===== Conditions =====
  static matchTextLocationLabel = Fields.Boolean({
    default: true,
    help: "Search in the Statement's Label to find the Invoice/Payment's reference",
    tracking: true,
  });
  static matchTextLocationNote = Fields.Boolean({
    default: false,
    help: "Search in the Statement's Note to find the Invoice/Payment's reference",
    tracking: true,
  })
  static matchTextLocationReference = Fields.Boolean({
    default: false,
    help: "Search in the Statement's Reference to find the Invoice/Payment's reference",
    tracking: true,
  })
  static matchJournalIds = Fields.Many2many('account.journal', {
    string: 'Journals Availability',
    domain: "[['type', 'in', ['bank', 'cash']], ['companyId', '=', companyId]]",
    checkCompany: true,
    help: 'The reconciliation model will only be available from the selected journals.'
  });
  static matchNature = Fields.Selection({
    selection: [
      ['amountReceived', 'Received'],
      ['amountPaid', 'Paid'],
      ['both', 'Paid/Received']
    ], string: 'Amount Type', required: true, default: 'both', tracking: true,
    help: `The reconciliation model will only be applied to the selected transaction type:
        * Amount Received: Only applied when receiving an amount.
        * Amount Paid: Only applied when paying an amount.
        * Amount Paid/Received: Applied in both cases.`});
  static matchAmount = Fields.Selection({
    selection: [
      ['lower', 'Is Lower Than'],
      ['greater', 'Is Greater Than'],
      ['between', 'Is Between'],
    ], string: 'Amount Condition', tracking: true,
    help: 'The reconciliation model will only be applied when the amount being lower than, greater than or between specified amount(s).'
  });
  static matchAmountMin = Fields.Float({ string: 'Amount Min Parameter', tracking: true });
  static matchAmountMax = Fields.Float({ string: 'Amount Max Parameter', tracking: true });
  static matchLabel = Fields.Selection({
    selection: [
      ['contains', 'Contains'],
      ['notContains', 'Not Contains'],
      ['matchRegex', 'Match Regex'],
    ], string: 'Label', tracking: true, help: `The reconciliation model will only be applied when the label:
        * Contains: The proposition label must contains this string (case insensitive).
        * Not Contains: Negation of "Contains".
        * Match Regex: Define your own regular expression.`});
  static matchLabelParam = Fields.Char({ string: 'Label Parameter', tracking: true });
  static matchNote = Fields.Selection({
    selection: [
      ['contains', 'Contains'],
      ['notContains', 'Not Contains'],
      ['matchRegex', 'Match Regex'],
    ], string: 'Note', tracking: true, help: `The reconciliation model will only be applied when the note:
        * Contains: The proposition note must contains this string (case insensitive).
        * Not Contains: Negation of "Contains".
        * Match Regex: Define your own regular expression.`});
  static matchNoteParam = Fields.Char({ string: 'Note Parameter', tracking: true });
  static matchTransactionType = Fields.Selection({
    selection: [
      ['contains', 'Contains'],
      ['notContains', 'Not Contains'],
      ['matchRegex', 'Match Regex'],
    ], string: 'Transaction Type', tracking: true, help: `The reconciliation model will only be applied when the transaction type:
        * Contains: The proposition transaction type must contains this string (case insensitive).
        * Not Contains: Negation of "Contains".
        * Match Regex: Define your own regular expression.`});
  static matchTransactionTypeParam = Fields.Char({ string: 'Transaction Type Parameter', tracking: true });
  static matchSameCurrency = Fields.Boolean({
    string: 'Same Currency', default: true, tracking: true,
    help: 'Restrict to propositions having the same currency as the statement line.'
  });
  static allowPaymentTolerance = Fields.Boolean({
    string: "Payment Tolerance",
    default: true,
    tracking: true,
    help: "Difference accepted in case of underpayment.",
  })
  static paymentToleranceParam = Fields.Float({
    string: "Gap",
    compute: '_computePaymentToleranceParam',
    readonly: false,
    store: true,
    tracking: true,
    help: "The sum of total residual amount propositions matches the statement line amount under this amount/percentage.",
  })
  static paymentToleranceType = Fields.Selection({
    selection: [['percentage', "in percentage"], ['fixedAmount', "in amount"]],
    default: 'percentage',
    required: true,
    tracking: true,
    help: "The sum of total residual amount propositions and the statement line amount allowed gap type.",
  })
  static matchPartner = Fields.Boolean({
    string: 'Partner should be set', tracking: true,
    help: 'The reconciliation model will only be applied when a customer/vendor is set.'
  });
  static matchPartnerIds = Fields.Many2many('res.partner', {
    string: 'Only Those Partners',
    help: 'The reconciliation model will only be applied to the selected customers/vendors.'
  });
  static matchPartnerCategoryIds = Fields.Many2many('res.partner.category', {
    string: 'Only Those Partner Categories',
    help: 'The reconciliation model will only be applied to the selected customer/vendor categories.'
  });

  static lineIds = Fields.One2many('account.reconcile.model.line', 'modelId');
  static partnerMappingLineIds = Fields.One2many('account.reconcile.model.partner.mapping', 'modelId', {
    string: "Partner Mapping Lines",
    help: `The mapping uses regular expressions.
      - To Match the text at the beginning of the line (in label or notes), simply fill in your text.
      - To Match the text anywhere (in label or notes), put your text between .*
        e.g: .*N°48748 abc123.*`});
  static pastMonthsLimit = Fields.Integer({
    string: "Search Months Limit",
    default: 18,
    tracking: true,
    help: "Number of months in the past to consider entries from when applying this model.",
  });
  static decimalSeparator = Fields.Char({
    default: async (self) => (await self.env.items('res.lang')._langGet(await (await self.env.user()).lang)).decimalPoint,
    tracking: true,
    help: "Every character that is nor a digit nor this separator will be removed from the matching string",
  });
  static showDecimalSeparator = Fields.Boolean({ compute: '_computeShowDecimalSeparator', help: "Technical field to decide if we should show the decimal separator for the regex matching field." });
  static numberEntries = Fields.Integer({ string: 'Number of entries related to this model', compute: '_computeNumberEntries' })

  async actionReconcileStat() {
    this.ensureOne();
    const action = await this.env.items("ir.actions.actions")._forXmlid("account.actionMoveJournalLine");
    const res = await this._cr.execute(`
            SELECT ARRAY_AGG(DISTINCT "moveId") AS id
            FROM "accountMoveLine"
            WHERE "reconcileModelId" = %s
        `, [this.id]);

    await action.update({
      'context': {},
      'domain': [['id', 'in', res[0]['id']]],
      'help': _f('<p class="o-view-nocontent-empty-folder">{str}</p>', { str: await this._t('This reconciliation model has created no entry so far') }),
    })
    return action;
  }

  async _computeNumberEntries() {
    const data = await this.env.items('account.move.line').readGroup([['reconcileModelId', 'in', this.ids]], ['reconcileModelId'], 'reconcileModelId');
    const mappedData = Object.fromEntries(data.map(d => [d['reconcileModelId'][0], d['reconcileModelId_count']]));
    for (const model of this) {
      await model.set('numberEntries', mappedData[model.id] || 0);
    }
  }

  @api.depends('lineIds.amountType')
  async _computeShowDecimalSeparator() {
    for (const record of this) {
      await record.set('showDecimalSeparator', await (await record.lineIds).some(async (l) => await l.amountType === 'regex'));
    }
  }

  @api.depends('paymentToleranceParam', 'paymentToleranceType')
  async _computePaymentToleranceParam() {
    for (const record of this) {
      if (await record.paymentToleranceType === 'percentage') {
        await record.set('paymentToleranceParam', Math.min(100.0, Math.max(0.0, await record.paymentToleranceParam)));
      }
      else {
        await record.set('paymentToleranceParam', Math.max(0.0, await record.paymentToleranceParam));
      }
    }
  }

  @api.constrains('allowPaymentTolerance', 'paymentToleranceParam', 'paymentToleranceType')
  async _checkPaymentToleranceParam() {
    for (const record of this) {
      if (await record.allowPaymentTolerance) {
        const [paymentToleranceType, paymentToleranceParam] = await record('paymentToleranceType', 'paymentToleranceParam');
        if (paymentToleranceType === 'percentage' && !(0 <= paymentToleranceParam && paymentToleranceParam <= 100)) {
          throw new ValidationError(await this._t("A payment tolerance defined as a percentage should always be between 0 and 100"));
        }
        else if (paymentToleranceType === 'fixedAmount' && paymentToleranceParam < 0) {
          throw new ValidationError(await this._t("A payment tolerance defined as an amount should always be higher than 0"));
        }
      }
    }
  }

  // RECONCILIATION PROCESS

  /**
   * Get move.lines dict (to be passed to the create()) corresponding to a tax.
      :param tax:             An account.tax record.
      :param base_line_dict:  A dict representing the move.line containing the base amount.
      :return: A list of dict representing move.lines to be created corresponding to the tax.
   * @param tax 
   * @param baseLineDict 
   */
  async _getTaxesMoveLinesDict(tax, baseLineDict) {
    this.ensureOne();
    let balance = baseLineDict['balance'];

    const res = await tax.computeAll(balance);

    const newAmlDicts = [];
    for (const taxRes of res['taxes']) {
      const tax = this.env.items('account.tax').browse(taxRes['id']);
      balance = taxRes['amount'];

      newAmlDicts.push({
        'accountId': taxRes['accountId'] || baseLineDict['accountId'],
        'label': taxRes['label'],
        'partnerId': baseLineDict['partnerId'],
        'balance': balance,
        'debit': balance > 0 && balance || 0,
        'credit': balance < 0 && -balance || 0,
        'analyticAccountId': await tax.analytic && baseLineDict['analyticAccountId'],
        'analyticTagIds': await tax.analytic && baseLineDict['analyticTagIds'],
        'taxRepartitionLineId': taxRes['taxRepartitionLineId'],
        'taxIds': [[6, 0, taxRes['taxIds']]],
        'taxTagIds': [[6, 0, taxRes['tagIds']]],
        'currencyId': false,
        'reconcileModelId': this.id,
      })

      // Handle price included taxes.
      const baseBalance = taxRes['base'];
      update(baseLineDict, {
        'balance': baseBalance,
        'debit': baseBalance > 0 && baseBalance || 0,
        'credit': baseBalance < 0 && -baseBalance || 0,
      })
    }

    baseLineDict['taxTagIds'] = [[6, 0, res['baseTags']]];
    return newAmlDicts;
  }

  /**
   * Get move.lines dict (to be passed to the create()) corresponding to the reconciliation model's write-off lines.
      :param st_line:             An account.bank.statement.line record.(possibly empty, if performing manual reconciliation)
      :param residual_balance:    The residual balance of the statement line.
      :return: A list of dict representing move.lines to be created corresponding to the write-off lines.
   * @param stLine 
   * @param residualBalance 
   * @param partnerId 
   * @returns 
   */
  async _getWriteOffMoveLinesDict(stLine, residualBalance, partnerId) {
    this.ensureOne();

    if (await this['ruleType'] === 'invoiceMatching' && (! await this['allowPaymentTolerance'] || this['paymentToleranceParam'] == 0)) {
      return [];
    }

    let compCurr, stLineResidual;
    if (bool(stLine)) {
      compCurr = await stLine.companyCurrencyId;
      const matchedCandidatesValues = await this._processMatchedCandidatesData(stLine);
      stLineResidual = matchedCandidatesValues['balanceSign'] * matchedCandidatesValues['residualBalance'];
    }
    else {
      compCurr = await (await this['companyId']).currencyId;

      // No statement line
      if (await (await this['lineIds']).some(async (x) => await x.amountType === 'percentageStLine')) {
        return [];
      }
    }

    const decimalSeparator = await this['decimalSeparator'];
    let linesValsList = [];
    for (const line of await this['lineIds']) {
      const [amountType, amount, amountString] = await line('amountType', 'amount', 'amountString');
      let balance;
      if (amountType === 'percentage') {
        balance = await compCurr.round(residualBalance * (amount / 100.0));
      }
      else if (amountType === 'percentageStLine') {
        if (bool(stLine)) {
          balance = await compCurr.round(stLineResidual * (amount / 100.0));
        }
        else {
          balance = 0.0;
        }
      }
      else if (amountType === 'regex') {
        const match = (await stLine.paymentRef).match(new RegExp(amountString));
        if (match) {
          const sign = residualBalance > 0.0 ? 1 : -1;
          try {
            const extractedMatchGroup = match[1].replace(new RegExp('[^\d' + decimalSeparator + ']'), '');
            const extractedBalance = parseFloat(extractedMatchGroup.replace(decimalSeparator, '.'));
            balance = copysign(extractedBalance * sign, residualBalance);
          } catch (e) {
            if (isInstance(e, ValueError)) {
              balance = 0;
            }
            else {
              throw e;
            }
          }
        }
        else {
          balance = 0;
        }
      }
      else if (amountType === 'fixed') {
        balance = await compCurr.round(amount * (residualBalance > 0.0 ? 1 : -1));
      }

      if (await compCurr.isZero(balance)) {
        continue;
      }

      const writeoffLine = {
        'label': await line.label || await stLine.paymentRef,
        'balance': balance,
        'debit': balance > 0 && balance || 0,
        'credit': balance < 0 && -balance || 0,
        'accountId': (await line.accountId).id,
        'currencyId': compCurr.id,
        'analyticAccountId': (await line.analyticAccountId).id,
        'analyticTagIds': [[6, 0, (await line.analyticTagIds).ids]],
        'reconcileModelId': this.id,
      }
      linesValsList.push(writeoffLine);

      residualBalance -= balance;

      const [taxIds, forceTaxIncluded] = await line('taxIds', 'forceTaxIncluded');
      if (taxIds.ok) {
        let taxes = taxIds;
        const detectedFiscalPosition = await this.env.items('account.fiscal.position').getFiscalPosition(partnerId);
        if (bool(detectedFiscalPosition)) {
          taxes = await detectedFiscalPosition.mapTax(taxes);
        }
        writeoffLine['taxIds'] = [Command.set(taxes.ids)];
        // Multiple taxes with force_tax_included results in wrong computation, so we
        // only allow to set the force_tax_included field if we have one tax selected
        if (forceTaxIncluded) {
          taxes = await taxes[0].withContext({ forcePriceInclude: true });
        }
        const taxValsList = await this._getTaxesMoveLinesDict(taxes, writeoffLine);
        extend(linesValsList, taxValsList);
        if (!forceTaxIncluded) {
          for (const taxLine of taxValsList) {
            residualBalance -= taxLine['balance'];
          }
        }
      }
    }

    return linesValsList;
  }

  // RECONCILIATION CRITERIA

  /**
   * Apply criteria to get candidates for all reconciliation models.
 
      This function is called in enterprise by the reconciliation widget to match
      the statement lines with the available candidates (using the reconciliation models).
 
      :param st_lines:        Account.bank.statement.lines recordset.
      :param excluded_ids:    Account.move.lines to exclude.
      :param partner_map:     Dict mapping each line with new partner eventually.
      :return:                A dict mapping each statement line id with:
          * aml_ids:      A list of account.move.line ids.
          * model:        An account.reconcile.model record (optional).
          * status:       'reconciled' if the lines has been already reconciled, 'write_off' if the write-off must be
                          applied on the statement line.
   * @param stLines 
   * @param excludedIds 
   * @param partnerMap 
   */
  async _applyRules(stLines, excludedIds?: any, partnerMap?: any) {
    // This functions uses SQL to compute its results. We need to flush before doing anything more.
    // const promises = [];
    for (const modelName of ['account.bank.statement', 'account.bank.statement.line', 'account.move', 'account.move.line', 'res.company', 'account.journal', 'account.account']) {
      const model = this.env.items(modelName);
      await model.flush(model._fields);
    }
    // await Promise.all(promises);

    const results = Object.fromEntries(await stLines.map((line) => [line.id, { 'amlIds': [] }]));

    const availableModels = await (await this.filtered(async (m) => await m.ruleType !== 'writeoffButton')).sorted();
    let amlIdsToExclude = [] // Keep track of already processed amls.
    let reconciledAmlsIds = [] // Keep track of already reconciled amls.

    // First associate with each rec models all the statement lines for which it is applicable
    const linesWithPartnerPerModel = new Map();//() => []);
    for (const stLine of stLines) {
      // Statement lines created in old versions could have a residual amount of zero. In that case, don't try to
      // match anything.
      if (! await stLine.amountResidual) {
        continue;
      }

      let mappedPartner = bool(partnerMap) && partnerMap[stLine.id] && this.env.items('res.partner').browse(partnerMap[stLine.id]);
      mappedPartner = bool(mappedPartner) ? mappedPartner : await stLine.partnerId;

      for (const recModel of availableModels) {
        const partner = bool(mappedPartner) ? mappedPartner : await recModel._getPartnerFromMapping(stLine);

        if (await recModel._isApplicableFor(stLine, partner)) {
          if (!linesWithPartnerPerModel.has(recModel)) {
            linesWithPartnerPerModel.set(recModel, []);
          }
          linesWithPartnerPerModel.get(recModel).push([stLine, partner]);
        }
      }
    }

    // Execute only one SQL query for each model (for performance)
    let matchedLines = this.env.items('account.bank.statement.line');
    for (const recModel of availableModels) {

      // We filter the lines for this model, in case a previous one has already found something for them
      const filteredStLinesWithPartner = linesWithPartnerPerModel.get(recModel).filter(x => !matchedLines.includes(x[0]));

      if (!filteredStLinesWithPartner.length) {
        // No unreconciled statement line for this model
        continue;
      }

      const allModelCandidates = await recModel._getCandidates(filteredStLinesWithPartner, excludedIds);

      for (const [stLine, partner] of filteredStLinesWithPartner) {
        const candidates = allModelCandidates[stLine.id];
        if (bool(candidates)) {
          const [modelRslt, newReconciledAmlIds, newTreatedAmlIds] = await recModel._getRuleResult(stLine, candidates, amlIdsToExclude, reconciledAmlsIds, partner);

          if (bool(modelRslt)) {
            // We inject the selected partner (possibly coming from the rec model)
            modelRslt['partner'] = partner;

            results[stLine.id] = modelRslt;
            reconciledAmlsIds = _.union(reconciledAmlsIds, newReconciledAmlIds);
            amlIdsToExclude = _.union(amlIdsToExclude, newTreatedAmlIds);
            matchedLines = matchedLines.add(stLine);
          }
        }
      }
    }

    return results;
  }

  /**
   * Returns true iff this reconciliation model can be used to search for matches
      for the provided statement line and partner.
   * @param stLine 
   * @param partner 
   * @returns 
   */
  async _isApplicableFor(stLine, partner) {
    this.ensureOne();

    // Filter on journals, amount nature, amount and partners
    // All the conditions defined in this block are non-match conditions.
    const [matchJournalIds, matchNature, matchAmount, matchAmountMax, matchAmountMin, matchPartner, matchPartnerIds, matchPartnerCategoryIds] = await this('matchJournalIds', 'matchNature', 'matchAmount', 'matchAmountMax', 'matchAmountMin', 'matchPartner', 'matchPartnerIds', 'matchPartnerCategoryIds');
    const [moveId, amount] = await stLine('moveId', 'amount');
    if ((matchJournalIds.ok && !matchJournalIds.includes(await moveId.journalId))
      || (matchNature === 'amountReceived' && amount < 0)
      || (matchNature === 'amountPaid' && amount > 0)
      || (matchAmount === 'lower' && Math.abs(amount) >= matchAmountMax)
      || (matchAmount === 'greater' && Math.abs(amount) <= matchAmountMin)
      || (matchAmount === 'between' && (Math.abs(amount) > matchAmountMax || Math.abs(amount) < matchAmountMin))
      || (matchPartner && !bool(partner))
      || (matchPartner && matchPartnerIds.ok && !matchPartnerIds.includes(partner))
      || (matchPartner && matchPartnerCategoryIds.ok && !matchPartnerCategoryIds.includes(await partner.categoryId))
    ) {
      return false;
    }
    // Filter on label, note and transaction_type
    for (let [record, ruleField, recordField] of [[stLine, 'label', 'paymentRef'], [moveId, 'note', 'narration'], [stLine, 'transactionType', 'transactionType']]) {
      ruleField = _.upperFirst(ruleField);
      const ruleTerm = (await this['match' + ruleField + 'Param'] || '').toLowerCase();
      const recordTerm = (await record[recordField] || '').toLowerCase();

      // This defines non-match conditions
      const matchRuleField = await this['match' + ruleField];
      if ((matchRuleField === 'contains' && !recordTerm.includes(ruleField))
        || (matchRuleField === 'notContains' && recordTerm.includes(ruleTerm))
        || (matchRuleField === 'matchRegex' && !recordTerm.match(ruleTerm))
      ) {
        return false;
      }
    }
    return true;
  }

  /**
   * Returns the match candidates for this rule, with respect to the provided parameters.
 
      :param st_lines_with_partner: A list of tuples (statement_line, partner),
                                    associating each statement line to treate with
                                    the corresponding partner, given by the partner map
      :param excluded_ids: a set containing the ids of the amls to ignore during the search
                           (because they already been matched by another rule)
   * @param stLinesWithPartner 
   * @param excludedIds 
   * @returns 
   */
  async _getCandidates(stLinesWithPartner, excludedIds) {
    this.ensureOne();

    const treatmentMap = {
      'invoiceMatching': (x) => x._getInvoiceMatchingQuery(stLinesWithPartner, excludedIds),
      'writeoffSuggestion': (x) => x._getWriteoffSuggestionQuery(stLinesWithPartner, excludedIds),
    }

    const queryGenerator = treatmentMap[await this['ruleType']];
    const [query, params] = queryGenerator(this);
    const res = await this._cr.execute(query, params);

    const rslt = {};//new Map();//() => []);
    for (const candidateDict of res) {
      const id = candidateDict['id'];
      rslt[id] = rslt[id] ?? [];
      rslt[id].push(candidateDict);
    }
    return rslt;
  }

  /**
   * Returns the query applying the current invoiceMatching reconciliation
      model to the provided statement lines.
 
      :param st_lines_with_partner: A list of tuples (statement_line, partner),
                                    associating each statement line to treate with
                                    the corresponding partner, given by the partner map
      :param excluded_ids:    Account.move.lines to exclude.
      :return:                (query, params)
   * @param stLinesWithPartner 
   * @param excludedIds 
   */
  async _getInvoiceMatchingQuery(stLinesWithPartner, excludedIds) {
    this.ensureOne();
    if (await this['ruleType'] !== 'invoiceMatching') {
      throw new UserError(await this._t(`Programmation Error: Can't call _getInvoiceMatchingQuery() for different rules than 'invoiceMatching'`));
    }

    const unaccent = await getUnaccentWrapper(this._cr);

    // N.B: 'communication_flag' is there to distinguish invoice matching through the number/reference
    // (higher priority) from invoice matching using the partner (lower priority).
    let query = `
          SELECT
              "stLine".id                         AS id,
              aml.id                              AS "amlId",
              aml."currencyId"                    AS "amlCurrencyId",
              aml."dateMaturity"                  AS "amlDateMaturity",
              aml."amountResidual"                AS "amlAmountResidual",
              aml."amountResidualCurrency"        AS "amlAmountResidualCurrency",
              ` + await this._getSelectCommunicationFlag() + ` AS "communicationFlag",
              ` + await this._getSelectPaymentReferenceFlag() + ` AS "paymentReferenceFlag"
          FROM "accountBankStatementLine" "stLine"
          JOIN "accountMove" "stLineMove"          ON "stLineMove".id = "stLine"."moveId"
          JOIN "resCompany" company                ON company.id = "stLineMove"."companyId"
          , "accountMoveLine" aml
          LEFT JOIN "accountMove" move             ON move.id = aml."moveId" AND move.state = 'posted'
          LEFT JOIN "accountAccount" account       ON account.id = aml."accountId"
          LEFT JOIN "resPartner" partner           ON aml."partnerId" = partner.id
          LEFT JOIN "accountPayment" payment       ON payment."moveId" = move.id
          WHERE
              aml."companyId" = "stLineMove"."companyId"
              AND move.state = 'posted'
              AND account.reconcile IS TRUE
              AND aml.reconciled IS FALSE
          `;

    // Add conditions to handle each of the statement lines we want to match
    const stLinesQueries = [];
    for (const [stLine, partner] of stLinesWithPartner) {
      // In case we don't have any partner for this line, we try assigning one with the rule mapping
      let stLineSubquery;
      if (await stLine.amount > 0) {
        stLineSubquery = "aml.balance > 0";
      }
      else {
        stLineSubquery = "aml.balance < 0";
      }

      if (await this['matchSameCurrency']) {
        stLineSubquery += f(` AND COALESCE(aml."currencyId", company."currencyId") = %s`, (await stLine.foreignCurrencyId).id || (await (await stLine.moveId).currencyId).id);
      }
      if (bool(partner)) {
        stLineSubquery += f(` AND aml."partnerId" = %s`, partner.id);
      }
      else {
        stLineSubquery += `
            AND
            (
                substring(REGEXP_REPLACE("stLine"."paymentRef", '[^0-9\s]', '', 'g'), '\S(?:.*\S)*') != ''
                AND
                (
                    (` + await this._getSelectCommunicationFlag() + `)
                    OR
                    (` + await this._getSelectPaymentReferenceFlag() + `)
                )
            )
            OR
            (
                / We also match statement lines without partners with amls
                //whose partner's name's parts (splitting on space) are all present
                //within the payment_ref, in any order, with any characters between them.

                "amlPartner".label IS NOT NULL
                AND ` + unaccent(`"stLine"."paymentRef"`) + ` ~* ('^' || (
                    SELECT string_agg(concat('(?=.*\m', chunk[1], '\M)'), '')
                      FROM regexp_matches(` + unaccent(`"amlPartner".label"`) + `, '\w{3,}', 'g') AS chunk
                ))
            )
        `;
      }
      stLinesQueries.push(f(`"stLine".id = %s AND (%s)`, stLine.id, stLineSubquery));
    }
    query += f(` AND (%s) `, stLinesQueries.join(' OR '));

    const params = {};

    // If this reconciliation model defines a past_months_limit, we add a condition
    // to the query to only search on move lines that are younger than this limit.
    if (await this['pastMonthsLimit']) {
      const dateLimit = DateTime.fromJSDate(await _Date.contextToday(this)).minus({ months: await this['pastMonthsLimit'] }).toJSDate();
      query += 'AND aml.date >= {amlDateLimit}';
      params['amlDateLimit'] = dateLimit;
    }

    // Filter out excluded account.move.line.
    if (excludedIds) {
      query += 'AND aml.id NOT IN {excludedAmlIds}';
      params['excludedAmlIds'] = String(excludedIds);
    }

    if (await this['matchingOrder'] === 'newFirst') {
      query += ' ORDER BY "amlDateMaturity" DESC, "amlId" DESC';
    }
    else {
      query += ' ORDER BY "amlDateMaturity" ASC, "amlId" ASC';
    }

    return [query, params];
  }

  async _getSelectCommunicationFlag() {
    this.ensureOne();
    //# Determine a matching or not with the statement line communication using the aml.label, move.label or move.ref.
    const stRefList = [];
    if (await this['matchTextLocationLabel']) {
      extend(stRefList, ['"stLine"."paymentRef"']);
    }
    if (await this['matchTextLocationNote']) {
      extend(stRefList, ['"stLineMove".narration']);
    }
    if (await this['matchTextLocationReference']) {
      extend(stRefList, ['"stLineMove".ref']);
    }

    const stRef = stRefList.map(stRefName => f(`COALESCE("%s", '')`, stRefName)).join(" || ' ' || ");
    if (!stRef.length) {
      return "FALSE";
    }

    const statementCompare = `(
        {moveField} IS NOT NULL AND substring(REGEXP_REPLACE({moveField}, '[^0-9\s]', '', 'g'), '\S(?:.*\S)*') != ''
        AND (
            regexp_split_to_array(substring(REGEXP_REPLACE({moveField}, '[^0-9\s]', '', 'g'), '\S(?:.*\S)*'),'\s+')
            && regexp_split_to_array(substring(REGEXP_REPLACE({stRef}, '[^0-9\s]', '', 'g'), '\S(?:.*\S)*'), '\s+')
        )
    )`;
    return ['aml.label', 'move.label', 'move.ref'].map(field =>
      _f(statementCompare, { moveField: field, stRef: stRef })).join(" OR ");

  }

  async _getSelectPaymentReferenceFlag() {
    // Determine a matching or not with the statement line communication using the move.payment_reference.
    const stRefList = [];
    if (await this['matchTextLocationLabel']) {
      extend(stRefList, ['"stLine"."paymentRef"']);
    }
    if (await this['matchTextLocationNote']) {
      extend(stRefList, ['"stLineMove".narration']);
    }
    if (await this['matchTextLocationReference']) {
      extend(stRefList, ['"stLineMove".ref']);
    }
    if (!stRefList.length) {
      return "FALSE";
    }

    // payment_reference is not used on account.move for payments; ref is used instead
    return f(`((move."paymentReference" IS NOT NULL OR (payment.id IS NOT NULL AND move.ref IS NOT NULL)) AND ({%s}))`, stRefList.map(stRef => `regexp_replace(CASE WHEN payment.id IS NULL THEN move."paymentReference" ELSE move.ref END, '\s+', '', 'g') = regexp_replace(${stRef}, '\s+', '', 'g')`).join(" OR "));
  }

  /**
   * Find partner with mapping defined on model.
 
      For invoice matching rules, matches the statement line against each
      regex defined in partner mapping, and returns the partner corresponding
      to the first one matching.
 
      :param st_line (Model<account.bank.statement.line>):
          The statement line that needs a partner to be found
      :return Model<res.partner>:
          The partner found from the mapping. Can be empty an empty recordset
          if there was nothing found from the mapping or if the function is
          not applicable.
   * @param stLine 
   * @returns 
   */
  async _getPartnerFromMapping(stLine) {
    this.ensureOne();

    if (!['invoiceMatching', 'writeoffSuggestion'].includes(await this['ruleType'])) {
      return this.env.items('res.partner');
    }

    for (const partnerMapping of await this['partnerMappingLineIds']) {
      const [paymentRefRegex, narrationRegex] = await partnerMapping('paymentRefRegex', 'narrationRegex');
      const matchPaymentRef = paymentRefRegex ? (await stLine.paymentRef).match(paymentRefRegex) : true;
      const matchNarration = narrationRegex ? (html2Text(await stLine.narration || '').trim()).match(narrationRegex) : true;

      if (matchPaymentRef && matchNarration) {
        return partnerMapping.partnerId;
      }
    }
    return this.env.items('res.partner');
  }

  /**
   * Returns the query applying the current writeoff_suggestion reconciliation
      model to the provided statement lines.
 
      :param st_lines_with_partner: A list of tuples (statement_line, partner),
                                    associating each statement line to treate with
                                    the corresponding partner, given by the partner map
      :param excluded_ids:    Account.move.lines to exclude.
      :return:                (query, params)
   * @param stLinesWithPartner 
   * @param excludedIds 
   * @returns 
   */
  async _getWriteoffSuggestionQuery(stLinesWithPartner, excludedIds?: any) {
    this.ensureOne();

    if (await this['ruleType'] !== 'writeoffSuggestion') {
      throw new UserError(await this._t("Programmation Error: Can't call _getWriteoffSuggestionQuery() for different rules than 'writeoffSuggestion'"));
    }

    const query = `
              SELECT
                  "stLine".id AS id
              FROM "accountBankStatementLine" "stLine"
              WHERE "stLine".id IN ({stLineIds})
          `;
    const params = {
      'stLineIds': String(stLinesWithPartner.map((stLine) => stLine.id)),
    }

    return [query, params];
  }

  /**
   * Get the result of a rule from the list of available candidates, depending on the
      other reconciliations performed by previous rules.
   * @param stLine 
   * @param candidates 
   * @param amlIdsToExclude 
   * @param reconciledAmlsIds 
   * @param partnerMap 
   * @returns 
   */
  async _getRuleResult(stLine, candidates, amlIdsToExclude, reconciledAmlsIds, partnerMap) {
    this.ensureOne();

    if (await this['ruleType'] === 'invoiceMatching') {
      return this._getInvoiceMatchingRuleResult(stLine, candidates, amlIdsToExclude, reconciledAmlsIds, partnerMap);
    }
    else if (await this['ruleType'] === 'writeoffSuggestion') {
      return [await this._getWriteoffSuggestionRuleResult(stLine, partnerMap), [], []];
    }
    else {
      return [null, [], []];
    }
  }

  async _getInvoiceMatchingRuleResult(stLine, candidates, amlIdsToExclude, reconciledAmlsIds, partner) {
    let newReconciledAmlIds = [];
    let newTreatedAmlIds = [];
    let priorities;
    [candidates, priorities] = await this._filterCandidates(candidates, amlIdsToExclude, reconciledAmlsIds);

    let stLineCurrency = await stLine.foreignCurrencyId;
    stLineCurrency = stLineCurrency.ok ? stLineCurrency : await stLine.currencyId;
    const candidateCurrencies = new Set(candidates.map(candidate => candidate['amlCurrencyId']));
    let keptCandidates = candidates;
    if (candidateCurrencies.size == 1 && candidateCurrencies.has(stLineCurrency.id)) {
      keptCandidates = [];
      let sumKeptCandidates = 0;
      for (const candidate of candidates) {
        const candidateResidual = candidate['amlAmountResidualCurrency'];

        if (await stLineCurrency.compareAmounts(candidateResidual, -await stLine.amountResidual) == 0) {
          // Special case: the amounts are the same, submit the line directly.
          keptCandidates = [candidate];
          break;
        }

        else if (await stLineCurrency.compareAmounts(Math.abs(sumKeptCandidates), Math.abs(await stLine.amountResidual)) < 0) {
          // Candidates' and statement line's balances have the same sign, thanks to _get_invoice_matching_query.
          // We hence can compare their absolute value without any issue.
          // Here, we still have room for other candidates ; so we add the current one to the list we keep.
          // Then, we continue iterating, even if there is no room anymore, just in case one of the following candidates
          // is an exact match, which would then be preferred on the current candidates.
          keptCandidates.push(candidate);
          sumKeptCandidates += candidateResidual;
        }
      }
    }

    // It is possible kept_candidates now contain less different priorities; update them
    const keptCandidatesByPriority = await this._sortReconciliationCandidatesByPriority(keptCandidates, amlIdsToExclude, reconciledAmlsIds);
    priorities = Object.keys(keptCandidatesByPriority);

    // We check the amount criteria of the reconciliation model, and select the
    // kept_candidates if they pass the verification.
    const matchedCandidatesValues = await this._processMatchedCandidatesData(stLine, keptCandidates);
    const status = await this._checkRulePropositions(matchedCandidatesValues);
    let rslt;
    if (status.includes('rejected')) {
      rslt = null;
    }
    else {
      rslt = {
        'model': this,
        'amlIds': keptCandidates.map(candidate => candidate['amlId']),
      }
      newTreatedAmlIds = Array.from(rslt['amlIds']);

      // Create write-off lines (in company's currency).
      let writeoffValsList;
      if (status.includes('allowWriteOff')) {
        const residualBalanceAfterRec = matchedCandidatesValues['residualBalance'] + matchedCandidatesValues['candidatesBalance'];
        writeoffValsList = await this._getWriteOffMoveLinesDict(
          stLine,
          matchedCandidatesValues['balance_sign'] * residualBalanceAfterRec,
          partner.id,
        )
        if (writeoffValsList.length) {
          rslt['status'] = 'writeOff'
          rslt['writeOffVals'] = writeoffValsList;
        }
      }
      else {
        writeoffValsList = [];
      }

      // Reconcile.
      if (status.includes('allowAutoReconcile')) {

        // Process auto-reconciliation. We only do that for the first two priorities, if they are not matched elsewhere.
        const amlIds = keptCandidates.map(candidate => candidate['amlId']);
        const linesValsList = Object.fromEntries(amlIds.map(amlId => ['id', amlId]));

        if (linesValsList.length && _.intersection(priorities, [1, 3]).length && await this['autoReconcile']) {

          // Ensure this will not throw new an error if case of missing account to create an open balance.
          const [dummy, openBalanceVals] = await stLine._prepareReconciliation(linesValsList.concat(writeoffValsList));

          if (!bool(openBalanceVals) || openBalanceVals['accountId']) {

            if (!(await stLine.partnerId).ok && partner.ok) {
              await stLine.set('partnerId', partner);
            }

            await stLine.reconcile(linesValsList.concat(writeoffValsList), true);

            rslt['status'] = 'reconciled';
            rslt['reconciledLines'] = await stLine.lineIds;
            newReconciledAmlIds = newTreatedAmlIds;
          }
        }
      }
    }
    return [rslt, newReconciledAmlIds, newTreatedAmlIds];
  }
  /**
   * Simulate the reconciliation of the statement line with the candidates and
      compute some useful data to perform all the matching rules logic.

      :param statement_line:  An account.bank.statement.line record.
      :param candidates:      Fetched account.move.lines from query (dict).
      :return:                A dict containing:
          * currency:                 The currency of the transaction.
          * statement_line:           The statement line matching the candidates.
          * candidates:               Fetched account.move.lines from query (dict).
          * reconciliation_overview:  The computed reconciliation from '_prepare_reconciliation'.
          * open_balance_vals:        The open balance returned by '_prepare_reconciliation'.
          * balance_sign:             The sign applied to the balance to make amounts always positive.
          * residual_balance:         The residual balance of the statement line before reconciling anything,
                                      always positive and expressed in company's currency.
          * candidates_balance:       The balance of candidates lines expressed in company's currency.
          * residual_balance_curr:    The residual balance of the statement line before reconciling anything,
                                      always positive and expressed in transaction's currency.
          * candidates_balance_curr:  The balance of candidates lines expressed in transaction's currency.
   */
  async _processMatchedCandidatesData(statementLine, candidates?: any): Promise<{}> {
    candidates = candidates || [];

    const [reconciliationOverview, openBalanceVals] = await statementLine._prepareReconciliation(
      candidates.map(aml => {
        return {
          'currencyId': aml['amlCurrencyId'],
          'amountResidual': aml['amlAmountResidual'],
          'amountResidualCurrency': aml['amlAmountResidualCurrency'],
        }
      })
    );

    // Compute 'residual_balance', the remaining amount to reconcile of the statement line expressed in the
    // transaction currency.
    const [liquidityLines, suspenseLines, dummy] = await statementLine._seekForLines();
    let stlResidualBalance, stlResidualBalanceCurr;
    if (bool(await statementLine.toCheck)) {
      stlResidualBalance = - await liquidityLines.balance;
      stlResidualBalanceCurr = - await liquidityLines.amountCurrency;
    }
    else if (await (await suspenseLines.accountId).reconcile) {
      stlResidualBalance = sum(await suspenseLines.mapped('amountResidual'));
      stlResidualBalanceCurr = sum(await suspenseLines.mapped('amountResidualCurrency'));
    }
    else {
      stlResidualBalance = sum(await suspenseLines.mapped('balance'));
      stlResidualBalanceCurr = sum(await suspenseLines.mapped('amountCurrency'));
    }

    // Compute 'reconciled_balance', the total reconciled amount to be reconciled by the candidates.
    let candidatesBalance = 0.0;
    let candidatesBalanceCurr = 0.0;
    for (const reconciliationVals of reconciliationOverview) {
      const lineVals = reconciliationVals['lineVals'];
      candidatesBalance -= lineVals['debit'] - lineVals['credit'];
      if (lineVals['currencyId']) {
        candidatesBalanceCurr -= lineVals['amountCurrency'];
      }
      else {
        candidatesBalanceCurr -= lineVals['debit'] - lineVals['credit'];
      }
    }
    // Sign amount to ease computation. Multiplying any amount from the statement line makes it positive.
    const balanceSign = stlResidualBalance > 0.0 ? 1 : -1;

    const [foreignCurrencyId, currencyId] = await statementLine('foreignCurrencyId', 'currencyId');
    return {
      'currency': foreignCurrencyId.ok ? foreignCurrencyId : currencyId,
      'statementLine': statementLine,
      'candidates': candidates,
      'reconciliationOverview': reconciliationOverview,
      'openBalanceVals': openBalanceVals,
      'balanceSign': balanceSign,
      'residualBalance': balanceSign * stlResidualBalance,
      'candidatesBalance': balanceSign * candidatesBalance,
      'residualBalanceCurr': balanceSign * stlResidualBalanceCurr,
      'candidatesBalanceCurr': balanceSign * candidatesBalanceCurr,
    }
  }


  /**
   * Check restrictions that can't be handled for each move.line separately.
    Note: Only used by models having a type equals to 'invoiceMatching'.
 
    :param matched_candidates_values: The values computed by '_process_matched_candidates_data'.
    :return: A string representing what to do with the candidates:
        * rejected:             Reject candidates.
        * allowWriteOff:      Allow to generate the write-off from the reconcile model lines if specified.
        * allowAutoReconcile: Allow to automatically reconcile entries if 'auto_validate' is enabled.
   */
  async _checkRulePropositions(matchedCandidatesValues): Promise<any[]> {
    const candidates = matchedCandidatesValues['candidates'];
    const currency = matchedCandidatesValues['currency'];

    if (! await this['allowPaymentTolerance']) {
      return ['allowWriteOff', 'allowAutoReconcile'];
    }
    if (!bool(candidates)) {
      return ['rejected'];
    }

    // The statement line will be fully reconciled.
    const residualBalanceAfterRec = matchedCandidatesValues['residualBalanceCurr'] + matchedCandidatesValues['candidatesBalanceCurr'];
    if (await currency.isZero(residualBalanceAfterRec)) {
      return ['allowAutoReconcile'];
    }

    // The payment amount is higher than the sum of invoices.
    // In that case, don't check the tolerance and don't try to generate any write-off.
    if (residualBalanceAfterRec > 0.0) {
      return ['allowAutoReconcile'];
    }

    // No tolerance, reject the candidates.
    if (await this['paymentToleranceParam'] == 0) {
      return ['rejected'];
    }

    // If the tolerance is expressed as a fixed amount, check the residual payment amount doesn't exceed the
    // tolerance.
    if (await this['paymentToleranceType'] === 'fixedAmount' && -residualBalanceAfterRec <= await this['paymentToleranceParam']) {
      return ['allowWriteOff', 'allowAutoReconcile'];
    }

    // The tolerance is expressed as a percentage between 0 and 100.0.
    const reconciledPercentageLeft = (residualBalanceAfterRec / matchedCandidatesValues['candidatesBalanceCurr']) * 100.0;
    if (await this['paymentToleranceType'] === 'percentage' && reconciledPercentageLeft <= await this['paymentToleranceParam']) {
      return ['allowWriteOff', 'allowAutoReconcile'];
    }

    return ['rejected'];
  }

  /**
   * Sorts reconciliation candidates by priority and filters them so that only
      the most prioritary are kept.
   * @param candidates 
   * @param amlIdsToExclude 
   * @param reconciledAmlsIds 
   * @returns 
   */
  async _filterCandidates(candidates, amlIdsToExclude, reconciledAmlsIds) {
    const candidatesByPriority = await this._sortReconciliationCandidatesByPriority(candidates, amlIdsToExclude, reconciledAmlsIds);

    // This can happen if the candidates were already reconciled at this point
    if (!bool(candidatesByPriority)) {
      return [[], []];
    }

    const maxPriority = Math.min(...Object.keys(candidatesByPriority).map(i => Number(i)));

    let filteredCandidates = candidatesByPriority[maxPriority];
    const filteredPriorities = new Set([maxPriority]);

    if ([1, 3, 5].includes(maxPriority)) {
      // We also keep the already proposed values of the same priority level
      const proposedPriority = maxPriority + 1;
      filteredCandidates += candidatesByPriority[proposedPriority];
      if (candidatesByPriority[proposedPriority]) {
        filteredPriorities.add(proposedPriority);
      }
    }

    return [filteredCandidates, Array.from(filteredPriorities)];
  }

  /**
   * Sorts the provided candidates and returns a mapping of candidates by
      priority (1 being the highest).
 
      The priorities are defined as follows:
 
      1: payment_reference_flag is true,  so the move's payment_reference
         field matches the statement line's.
 
      2: Same as 1, but the candidates have already been proposed for a previous statement line
 
      3: communication_flag is true, so either the move's ref, move's name or
         aml's name match the statement line's payment reference.
 
      4: Same as 3, but the candidates have already been proposed for a previous statement line
 
      5: candidates proposed by the query, but no match with the statement
         line's payment ref could be found.
 
      6: Same as 5, but the candidates have already been proposed for a previous statement line
   * @param candidates 
   * @param alreadyProposedAmlIds 
   * @param alreadyReconciledAmlIds 
   */
  async _sortReconciliationCandidatesByPriority(candidates, alreadyProposedAmlIds, alreadyReconciledAmlIds) {
    const candidatesByPriority = {};

    for (const candidate of candidates.filter((x) => !alreadyReconciledAmlIds.includes(x['amlId']))) {
      let priority;
      if (candidate['paymentReferenceFlag']) {
        priority = 1;
      }
      else if (candidate['communicationFlag']) {
        priority = 3;
      }
      else {
        priority = 5;
      }
      if (alreadyProposedAmlIds.includes(candidate['amlId'])) {
        // So, priorities 2, 4 and 6 are created here
        priority += 1;
      }
      candidatesByPriority[priority] = candidatesByPriority[priority] ?? [];
      candidatesByPriority[priority].push(candidate);
    }

    return candidatesByPriority;
  }

  async _getWriteoffSuggestionRuleResult(stLine, partner) {
    // Create write-off lines.
    const matchedCandidatesValues = await this._processMatchedCandidatesData(stLine);
    const residualBalanceAfterRec = matchedCandidatesValues['residualBalance'] + matchedCandidatesValues['candidatesBalance'];
    const writeoffValsList = await this._getWriteOffMoveLinesDict(
      stLine,
      matchedCandidatesValues['balanceSign'] * residualBalanceAfterRec,
      partner.id,
    )

    const rslt = {
      'model': this,
      'status': 'writeOff',
      'amlIds': [],
      'writeOffVals': writeoffValsList,
    }

    // Process auto-reconciliation.
    if (writeoffValsList.length && await this['autoReconcile']) {
      if (!(await stLine.partnerId).ok && partner.ok) {
        await stLine.set('partnerId', partner);
      }

      await stLine.reconcile(writeoffValsList);
      rslt['status'] = 'reconciled';
      rslt['reconciledLines'] = await stLine.lineIds;
    }
    return rslt;
  }
}