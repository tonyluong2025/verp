import { Fields, api } from "../../../core";
import { MetaModel, Model } from "../../../core/models";
import { addDate } from "../../../core/tools/date_utils";

@MetaModel.define()
class AccountRecurringTemplate extends Model {
    static _module = module;
    static _name = 'account.recurring.template';
    static _description = 'Recurring Template';
    static _recName = 'label';

    static label = Fields.Char('Name', { required: true });
    // accountId = Fields.Many2one('account.account', 'Account', required: true)
    static journalId = Fields.Many2one('account.journal', { string: 'Journal', required: true });
    static recurringPeriod = Fields.Selection({
        selection: [['days', 'Days'],
        ['weeks', 'Weeks'],
        ['months', 'Months'],
        ['years', 'Years']], store: true, required: true
    });
    // date_begin = Fields.Date(string='Start Date', required: true)
    // dateEnd = Fields.Date(string='End Date', required: true)
    static description = Fields.Text('Description');
    static state = Fields.Selection({
        selection: [['draft', 'Draft'],
        ['done', 'Done']], default: 'draft', string: 'Status'
    });
    static journalState = Fields.Selection({
        selection: [['draft', 'Un Posted'],
        ['posted', 'Posted']],
        required: true, default: 'draft', string: 'Generate Journal As'
    });
    static recurringInterval = Fields.Integer('Recurring Interval', { default: 1, required: true });
    static companyId = Fields.Many2one('res.company', { string: 'Company', default: async (self) => (await self.env.company()).id });
    // next_call = Fields.Date(string="Next Call", compute="_computeNextCall")

    @api.depends('dateBegin', 'dateEnd')
    async _computeNextCall() {
        for (const rec of this) {
            const execDate = addDate(await rec.dateBegin, { days: await rec.recurringInterval });
            if (execDate <= await rec.dateEnd) {
                await rec.set('nextCall', execDate);
            }
            else {
                await rec.set('state', 'done');
            }
        }
    }

    async actionDraft() {
        for (const rec of this) {
            await rec.set('state', 'draft');
        }
    }

    async actionDone() {
        for (const rec of this) {
            await rec.set('state', 'done');
        }
    }
}
