import { Fields } from "../../../core";
import { MetaModel, TransientModel } from "../../../core/models"

@MetaModel.define()
class AccountBalanceReport extends TransientModel {
    static _module = module;
    static _name = 'account.balance.report';
    static _parents = "account.common.account.report";
    static _description = 'Trial Balance Report';

    static journalIds = Fields.Many2many('account.journal', {relation: 'accountBalanceReportJournalRel',
                                   column1: 'accountId', column2: 'journalId', 
                                   string: 'Journals', required: true, default: []});
    static analyticAccountIds = Fields.Many2many('account.analytic.account',
                                            {relation: 'accountTrialBalanceAnalyticRel',
                                            string: 'Analytic Accounts'});

    async _getReportData(data) {
        data = await this['prePrintReport'](data);
        const records = this.env.items(data['model']).browse(data['ids'] || []);
        return [records, data];
    }

    async _printReport(data) {
        let records; 
        [records, data] = await this._getReportData(data);
        return (await this.env.ref('account_pdf_reports.actionReportTrialBalance')).reportAction(records, data);
    }
}