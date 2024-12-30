import { Fields, _Date, api } from "../../../core";
import { MetaModel, TransientModel } from "../../../core/models"
import { bool } from "../../../core/tools";

@MetaModel.define()
class AccountBankBookReport extends TransientModel {
    static _module = module;
    static _name = "account.bankbook.report";
    static _description = "Bank Book Report";

    async _getDefaultAccountIds() {
        const journals = await this.env.items('account.journal').search([['type', '=', 'bank']]);
        const accounts = [];
        for (const journal of journals) {
            const [defaultAccount, company, outboundPaymentMethodLineIds, inboundPaymentMethodLineIds] = await journal('defaultAccountId', 'companyId', 'outboundPaymentMethodLineIds', 'inboundPaymentMethodLineIds');
            if (bool(defaultAccount.id)) {
                accounts.push(defaultAccount.id);
            }
            const [accountJournalPaymentCreditAccount, accountJournalPaymentDebitAccount] = await company('accountJournalPaymentCreditAccountId', 'accountJournalPaymentDebitAccountId')
            if (bool(accountJournalPaymentCreditAccount.id)) {
                accounts.push(accountJournalPaymentCreditAccount.id);
            }
            if (bool(accountJournalPaymentDebitAccount.id)) {
                accounts.push(accountJournalPaymentDebitAccount.id);
            }
            for (const accOut of outboundPaymentMethodLineIds) {
                const paymentAccount = await accOut.paymentAccountId;
                if (paymentAccount.ok) {
                    accounts.push(paymentAccount.id);
                }
            }
            for (const accIn of inboundPaymentMethodLineIds) {
                const paymentAccount = await accIn.paymentAccountId;
                if (paymentAccount.ok) {
                    accounts.push(paymentAccount.id);
                }
            }
        }
        return accounts;
    }

    static dateFrom = Fields.Date({string: 'Start Date', default: self => _Date.today(), required: true});
    static dateTo = Fields.Date({string: 'End Date', default: self => _Date.today(), required: true});
    static targetMove = Fields.Selection([['posted', 'Posted Entries'],
                                    ['all', 'All Entries']], {string: 'Target Moves', required: true,
                                   default: 'posted'});
    static journalIds = Fields.Many2many('account.journal', {string: 'Journals', required: true,
                                   default: self => self.env.items('account.journal').search([])});
    static accountIds = Fields.Many2many('account.account', {relation: 'accountAccountBankbookReport', column1: 'reportLineId', column2: 'accountId', string: 'Accounts', default: self => self._getDefaultAccountIds()});
    static displayAccount = Fields.Selection(
        [['all', 'All'], ['movement', 'With movements'],
         ['notZero', 'With balance is not equal to 0']],
        {string: 'Display Accounts', required: true, default: 'movement'});
    static sortby = Fields.Selection(
        [['sortDate', 'Date'], ['sortJournalPartner', 'Journal & Partner']],
        {string: 'Sort by', required: true, default: 'sortDate'});
    static initialBalance = Fields.Boolean({string: 'Include Initial Balances',
                                     help: ['If you selected date, this field allow you to add a row ',
                                          'to display the amount of debit/credit/balance that precedes the ',
                                          'filter you\'ve set.'].join()});

    @api.onchange('accountIds')
    async onchangeAccountIds() {
        if (bool(await this['accountIds'])) {
            const journals = await this.env.items('account.journal').search(
                [['type', '=', 'bank']]);
            const accounts = [];
            for (const journal of journals) {
                accounts.push((await (await journal.companyId).accountJournalPaymentCreditAccountId).id);
            }
            const domain = {'accountIds': [['id', 'in', accounts]]};
            return {'domain': domain};
        }
    }

    async _buildComparisonContext(data) {
        const result = {};
        const journalIds = 'journalIds' in data['form'] && data['form']['journalIds'];
        result['journalIds'] = bool(journalIds) ? journalIds : false;
        result['state'] = 'targetMove' in data['form'] && data['form']['targetMove'] || '';
        result['dateFrom'] = data['form']['dateFrom'] || false;
        result['dateTo'] = data['form']['dateTo'] || false;
        result['strictRange'] = result['dateFrom'] ? true : false;
        return result;
    }

    async checkReport() {
        const data = {};
        data['form'] = await this.readOne(['targetMove', 'dateFrom', 'dateTo', 'journalIds', 'accountIds',
                                  'sortby', 'initialBalance', 'displayAccount']);
        const comparisonContext = await this._buildComparisonContext(data);
        data['form']['comparisonContext'] = comparisonContext;
        return (await this.env.ref('account_daily_reports.actionReportBankBook')).reportAction(this, data);
    }
}