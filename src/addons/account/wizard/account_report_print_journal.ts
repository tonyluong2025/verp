import { Fields } from "../../../core";
import { MetaModel, TransientModel } from "../../../core/models"
import { update } from "../../../core/tools/misc";

@MetaModel.define()
class AccountPrintJournal extends TransientModel {
  static _module = module;
  static _parents = "account.common.journal.report";
  static _name = "account.print.journal";
  static _description = "Account Print Journal";

  static sortSelection = Fields.Selection([['date', 'Date'], ['moveName', 'Journal Entry Number']], { string: 'Entries Sorted by', required: true, default: 'moveName' });
  static journalIds = Fields.Many2many('account.journal', { string: 'Journals', required: true, default: async (self) => self.env.items('account.journal').search([['type', 'in', ['sale', 'purchase']]]) });

  async _printReport(data) {
    data = await (this as any).prePrintReport(data);
    update(data['form'], { 'sortSelection': await this['sortSelection'] });
    return (await (await this.env.ref('account.action_report_journal')).with_context({ landscape: true })).reportAction(this, data);
  }
}