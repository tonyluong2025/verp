import { Fields, api } from "../../../core";
import { MetaModel, TransientModel, _super } from "../../../core/models"
import { isList, update } from "../../../core/tools";
import { bool } from "../../../core/tools/bool";

@MetaModel.define()
class AccountingReport extends TransientModel {
    static _module = module;
    static _name = "accounting.report";
    static _parents = "account.common.report";
    static _description = "Accounting Report";

    @api.model()
    async _getAccountReport() {
        let reports = [];
        if (this._context['activeId']) {
            const menu = await this.env.items('ir.ui.menu').browse(this._context['activeId']).label;
            reports = await this.env.items('account.financial.report').search([['label', 'ilike', menu]]);
        }
        return bool(reports[0]) ? reports[0] : false;
    }
    
    static enableFilter = Fields.Boolean({string: 'Enable Comparison'});
    static accountReportId = Fields.Many2one('account.financial.report', {string: 'Account Reports', required: true, default: self => self._getAccountReport()});
    static labelFilter = Fields.Char({string: 'Column Label', help: "This label will be displayed on report to show the balance computed for the given comparison filter."});
    static filterCmp = Fields.Selection([['filterNo', 'No Filters'], ['filterDate', 'Date']],
                                  {string: 'Filter by', required: true, default: 'filterNo'});
    static dateFromCmp = Fields.Date({string: 'Date From'});
    static dateToCmp = Fields.Date({string: 'Date To'});
    static debitCredit = Fields.Boolean({string: 'Display Debit/Credit Columns',
                                  help: ["This option allows you to get more details about ",
                                       "the way your balances are computed.",
                                       " Because it is space consuming, we do not allow to",
                                       " use it while doing a comparison."].join()});

    async _buildComparisonContext(data) {
        const result = {};
        result['journalIds'] = 'journalIds' in data['form'] && data['form']['journalIds'];
        result['journalIds'] = bool(result['journalIds']) && result['journalIds'] || false;
        result['state'] = 'targetMove' in data['form'] && data['form']['targetMove'] || '';
        if (data['form']['filterCmp'] === 'filterDate') {
            result['dateFrom'] = data['form']['dateFromCmp'];
            result['dateTo'] = data['form']['dateToCmp'];
            result['strictRange'] = true;
        }
        return result;
    }

    async checkReport() {
        const res = await _super(AccountingReport, this).checkReport();
        const data = {};
        data['form'] = await this.readOne(['accountReportId', 'dateFromCmp', 'dateToCmp', 'journalIds', 'filterCmp', 'targetMove']);
        for (const field of ['accountReportId']) {
            if (isList(data['form'][field])) {
                data['form'][field] = data['form'][field][0];
            }
        }
        const comparisonContext = await this._buildComparisonContext(data);
        res['data']['form']['comparisonContext'] = comparisonContext;
        return res;
    }

    async _printReport(data) {
        update(data['form'], await this.readOne(['dateFromCmp', 'debitCredit', 'dateToCmp', 'filterCmp', 'accountReportId', 'enableFilter', 'labelFilter', 'targetMove']));
        return (await this.env.ref('account_pdf_reports.actionReportFinancial')).reportAction(this, data, false);
    }
}