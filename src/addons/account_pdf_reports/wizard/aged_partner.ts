import { Fields } from "../../../core";
import { UserError } from "../../../core/helper";
import { MetaModel, TransientModel } from "../../../core/models";
import { update } from "../../../core/tools";
import { subDate, toFormat } from "../../../core/tools/date_utils";

@MetaModel.define()
class AccountAgedTrialBalance extends TransientModel {
    static _module = module;
    static _name = 'account.aged.trial.balance';
    static _parents = 'account.common.partner.report';
    static _description = 'Account Aged Trial balance Report';

    static periodLength = Fields.Integer({string: 'Period Length (days)', required: true, default: 30});
    static journalIds = Fields.Many2many('account.journal', {string: 'Journals', required: true});
    static dateFrom = Fields.Date({default: self => toFormat(self, 'yyyy-MM-dd')});

    async _getReportData(data) {
        const res = {}
        data = await this['prePrintReport'](data);
        update(data['form'], await this.readOne(['periodLength']));
        const periodLength = data['form']['periodLength'];
        if (periodLength <= 0) {
            throw new UserError(await this._t('You must set a period length greater than 0.'));
        }
        if (! data['form']['dateFrom']) {
            throw new UserError(await this._t('You must set a start date.'));
        }
        let start = data['form']['dateFrom'];
        for (let i=5; i>=0; i--) {
            let stop = subDate(start, {days: periodLength - 1});
            res[i] = {
                'label': (i != 0 && (String((5 - (i + 1)) * periodLength) + '-' + String((5 - i) * periodLength)) || ('+' + String(4 * periodLength))),
                'stop': toFormat(start, 'yyyy-MM-dd'),
                'start': (i != 0 && toFormat(stop, 'yyyy-MM-dd') || false),
            }
            start = subDate(stop, {days: 1});
        }
        update(data['form'], res);
        return data;
    }

    async _printReport(data) {
        data = await this._getReportData(data);
        return (await (await this.env.ref('account_pdf_reports.actionReportAgedPartnerBalance')).
            withContext({landscape: true})).reportAction(this, data);
    }
}