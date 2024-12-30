import { Fields } from "../../../core";
import { UserError } from "../../../core/helper";
import { MetaModel, TransientModel } from "../../../core/models";
import { update } from "../../../core/tools";

@MetaModel.define()
class AccountReportGeneralLedger extends TransientModel {
    static _module = module;
    static _name = "account.report.general.ledger";
    static _parents = "account.common.account.report";
    static _description = "General Ledger Report";

    static initialBalance = Fields.Boolean({string: 'Include Initial Balances',
                                    help: ['If you selected date, this field allow',
                                         ' you to add a row to display the amount ',
                                         'of debit/credit/balance that precedes',
                                         ' the filter you\'ve set.'].join()});
    static sortby = Fields.Selection([['sortDate', 'Date'], 
                               ['sortJournalPartner', 'Journal & Partner']], 
                              {string: 'Sort by', required: true, default: 'sortDate'});
    static journalIds = Fields.Many2many('account.journal',
                                   {relation: 'accountReportGeneralLedgerJournalRel',
                                   column1: 'accountId', column2: 'journalId', 
                                   string: 'Journals', required: true});

    async _getReportData(data) {
        data = await this['prePrintReport'](data);
        update(data['form'], await this.readOne(['initialBalance', 'sortby']));
        if (data['form']['initialBalance'] && ! data['form']['dateFrom']) {
            throw new UserError(await this._t("You must define a Start Date"));
        }
        const records = this.env.items(data['model']).browse(data['ids'] || []);
        return [records, data];
    }

    async _printReport(data) {
        let records;
        [records, data] = await this._getReportData(data);
        return (await (await this.env.ref('account_pdf_reports.actionReportGeneralLedger')).withContext({landscape: true})).reportAction(records, data);
    }
}
