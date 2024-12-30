import { Fields, _Date } from "../../../core";
import { MetaModel, TransientModel } from "../../../core/models"

@MetaModel.define()
class TaxAdjustments extends TransientModel {
  static _module = module;
  static _name = 'tax.adjustments.wizard';
  static _description = 'Tax Adjustments Wizard';

  static reason = Fields.Char({ string: 'Justification', required: true });
  static journalId = Fields.Many2one('account.journal', { string: 'Journal', required: true, default: self => self._getDefaultJournal(), domain: [['type', '=', 'general']] });
  static date = Fields.Date({ required: true, default: self => _Date.contextToday(self) });
  static debitAccountId = Fields.Many2one('account.account', {
    string: 'Debit account', required: true,
    domain: "[['deprecated', '=', false], ['isOffBalance', '=', false]]"
  });
  static creditAccountId = Fields.Many2one('account.account', {
    string: 'Credit account', required: true,
    domain: "[['deprecated', '=', false], ['isOffBalance', '=', false]]"
  });
  static amount = Fields.Monetary({ currencyField: 'companyCurrencyId', required: true });
  static adjustmentType = Fields.Selection([['debit', 'Applied on debit journal item'], ['credit', 'Applied on credit journal item']], { string: "Adjustment Type", required: true });
  static taxReportLineId = Fields.Many2one({ string: "Report Line", comodelName: 'account.tax.report.line', required: true, help: "The report line to make an adjustment for.", domain: (self) => self._domainTaxReport() });
  static companyCurrencyId = Fields.Many2one('res.currency', { readonly: true, default: async (x) => (await x.env.company()).currencyId });
  static reportId = Fields.Many2one({ string: "Report", related: 'taxReportLineId.reportId' });

  async _getDefaultJournal() {
    return (await this.env.items('account.journal').search([['type', '=', 'general']], { limit: 1 })).id;
  }

  async _domainTaxReport() {
    const fiscalCountryIds = (await this.env.items('account.fiscal.position').search([['companyId', '=', (await this.env.company()).id], ['foreignVat', '!=', false]]).countryId).ids;
    return [['tagName', '!=', null], '|', ['reportId.countryId', '=', (await (await this.env.company()).countryId).id], ['reportId.countryId', 'in', fiscalCountryIds]];
  }

  async createMove() {
    const moveLineVals = [];
    const [adjustmentType, amount, taxReportLineId, reason, debitAccountId, creditAccountId, journalId, date] = await this('adjustmentType', 'amount', 'taxReportLineId', 'reason', 'debitAccountId', 'creditAccountId', 'journalId', 'date');
    const isDebit = adjustmentType === 'debit';
    const signMultiplier = (amount < 0 ? -1 : 1) * (adjustmentType === 'credit' && -1 || 1);
    const filterLambda = (signMultiplier < 0)
      ? async (x) => x.taxNegate
      : async (x) => ! await x.taxNegate;
    const adjustmentTag = await (await taxReportLineId.tagIds).filtered(filterLambda);

    // Vals for the amls corresponding to the ajustment tag
    moveLineVals.push([0, 0, {
      'label': reason,
      'debit': isDebit ? Math.abs(amount) : 0,
      'credit': !isDebit ? Math.abs(amount) : 0,
      'accountId': isDebit ? debitAccountId.id : creditAccountId.id,
      'taxTagIds': [[6, false, [adjustmentTag.id]]],
    }]);

    // Vals for the counterpart line
    moveLineVals.push([0, 0, {
      'label': reason,
      'debit': !isDebit ? Math.abs(amount) : 0,
      'credit': isDebit ? Math.abs(amount) : 0,
      'accountId': isDebit ? creditAccountId.id : debitAccountId.id,
    }]);

    // Create the move
    const vals = {
      'journalId': journalId.id,
      'date': date,
      'state': 'draft',
      'lineIds': moveLineVals,
    }
    const move = await this.env.items('account.move').create(vals);
    await move._post();

    // Return an action opening the created move
    const result = await this.env.items('ir.actions.actions')._forXmlid('account.actionMoveLineForm');
    result['views'] = [[false, 'form']];
    result['resId'] = move.id;
    return result;
  }
}