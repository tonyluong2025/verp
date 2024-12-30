import { Fields } from "../../../core";
import { MetaModel, TransientModel } from "../../../core/models"
import { update } from "../../../core/tools";

@MetaModel.define()
class AccountPrintJournal extends TransientModel {
    static _module = module;
    static _name = "account.print.journal";
    static _parents = "account.common.journal.report";
    static _description = "Account Print Journal";

    static sortSelection = Fields.Selection([['date', 'Date'], ['moveName', 'Journal Entry Number']],
                                      {string: 'Entries Sorted by', required: true, default: 'moveName'});
    static journalIds = Fields.Many2many('account.journal', {string: 'Journals', required: true,
                                   default: self => self.env.items('account.journal').search([['type', 'in', ['sale', 'purchase']]])});

    async _getReportData(data) {
        data = await this['prePrintReport'](data);
        update(data['form'], {'sortSelection': await this['sortSelection']});
        return data;
    }

    async _printReport(data) {
        data = await this._getReportData(data);
        return (await (await this.env.ref('account_pdf_reports.actionReportJournal')).withContext({landscape: true})).reportAction(this, data);
    }
}