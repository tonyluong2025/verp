import { Fields, _Date } from "../../../core";
import { MetaModel, TransientModel } from "../../../core/models"
import { bool } from "../../../core/tools";

@MetaModel.define()
class AccountDayBookReport extends TransientModel {
    static _module = module;
    static _name = "account.daybook.report";
    static _description = "Day Book Report";

    static dateFrom = Fields.Date({string: 'Start Date', default: self => _Date.today(), required: true});
    static dateTo = Fields.Date({string: 'End Date', default: self => _Date.today(), required: true});
    static targetMove = Fields.Selection([['posted', 'Posted Entries'],
                                    ['all', 'All Entries']], {string: 'Target Moves', required: true,
                                   default: 'posted'});
    static journalIds = Fields.Many2many('account.journal', {string: 'Journals', required: true,
                                   default: self => self.env.items('account.journal').search([])});
    static accountIds = Fields.Many2many('account.account', {relation: 'accountAccountDaybookReport', column1: 'reportLineId', column2: 'accountId', string: 'Accounts'});

    async _buildComparisonContext(data) {
        const result = {};
        const journalIds = 'journalIds' in data['form'] && data['form']['journalIds'];
        result['journalIds'] = bool(journalIds) ? journalIds : false;
        result['state'] = 'targetMove' in data['form'] && data['form']['targetMove'] || '';
        result['dateFrom'] = data['form']['dateFrom'];
        result['dateTo'] = data['form']['dateTo'];
        return result;
    }

    async checkReport() {
        const data = {};
        data['form'] = await this.readOne(['targetMove', 'dateFrom', 'dateTo', 'journalIds', 'accountIds']);
        const comparisonContext = await this._buildComparisonContext(data);
        data['form']['comparisonContext'] = comparisonContext;
        return (await this.env.ref('account_daily_reports.actionReportDayBook')).reportAction(this, data);
    }
}




