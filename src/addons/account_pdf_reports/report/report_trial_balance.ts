import { DateTime } from "luxon";
import { api } from "../../../core";
import { UserError } from "../../../core/helper/errors";
import { AbstractModel, MetaModel } from "../../../core/models";
import { pop } from "../../../core/tools/misc";
import { _convert$, parseFloat, parseValues } from "../../../core/tools";

@MetaModel.define()
class ReportTrialBalance extends AbstractModel {
    static _module = module;
    static _name = 'report.accounting.trialbalance';
    static _description = 'Trial Balance Report';

    /**
     * compute the balance, debit and credit for the provided accounts
            :Arguments:
                `accounts`: list of accounts record,
                `display_account`: it's used to display either all accounts or those accounts which balance is > 0
            :Returns a list of dictionary of Accounts with following key and value
                `name`: Account name,
                `code`: Account code,
                `credit`: total amount of credit,
                `debit`: total amount of debit,
                `balance`: total amount of balance,
     * @param accounts 
     * @param displayAccount 
     * @returns 
     */
    async _getAccounts(accounts, displayAccount) {
        const accountResult = {};
        // Prepare sql query base on selected parameters from wizard
        let [tables, whereClause, whereParams] = await this.env.items('account.move.line')._queryGet();
        // tables = tables.replace('"','');
        if (! tables) {
            tables = '"accountMoveLine"';
        }
        const wheres = [""];
        if (whereClause.trim()) {
            wheres.push(whereClause.trim());
        }
        const filters = wheres.join(' AND ');
        // compute the balance, debit and credit for the provided accounts
        const query = `SELECT "accountId" AS id, SUM(debit) AS debit, SUM(credit) AS credit, 
                   (SUM(debit) - SUM(credit)) AS balance` +
                   ' FROM ' + tables + ` WHERE "accountId" IN (${String(accounts.ids) || 'NULL'}) ` + filters + ` GROUP BY "accountId"`;
        const rows = await this.env.cr.execute(_convert$(query), {bind: whereParams});
        for (const row of rows) {
            accountResult[pop(row, 'id')] = parseValues(row);
        }
        const accountRes = [];
        for (const account of accounts) {
            const res = Object.fromEntries(['credit', 'debit', 'balance'].map(fn => [fn, 0.0]));
            let [currency, code, label] = await account('currencyId', 'code', 'label');
            currency = currency.ok ? currency : await (await account.companyId).currencyId;
            res['code'] = code;
            res['label'] = label;
            if (account.id in accountResult) {
                res['debit'] = accountResult[account.id]['debit'];
                res['credit'] = accountResult[account.id]['credit']
                res['balance'] = accountResult[account.id]['balance'];
            }
            if (displayAccount === 'all') {
                accountRes.push(res);
            }
            if (displayAccount === 'notZero' && ! await currency.isZero(res['balance'])) {
                accountRes.push(res);
            }
            if (displayAccount === 'movement' && (! await currency.isZero(res['debit']) || ! await currency.isZero(res['credit']))) {
                accountRes.push(res);
            }
        }
        return accountRes;
    }

    @api.model()
    async _getReportValues(docids, data?: any) {
        if (! data['form'] || ! this.env.context['activeModel']) {
            throw new UserError(await this._t("Form content is missing, this report cannot be printed."));
        }
        const model = this.env.context['activeModel'];
        const docs = this.env.items(model).browse(this.env.context['activeIds'] || []);
        const displayAccount = data['form']['displayAccount'];
        const accounts = model === 'account.account' ? docs : await this.env.items('account.account').search([]);
        const context = data['form']['usedContext'];
        let analyticAccounts = [];
        if (data['form']['analyticAccountIds']) {
            const analyticAccountIds = await this.env.items('account.analytic.account').browse(data['form']['analyticAccountIds']);
            context['analyticAccountIds'] = analyticAccountIds;
            analyticAccounts = await analyticAccountIds.map((account) => account.label);
        }
        const accountRes = await (await this.withContext(context))._getAccounts(accounts, displayAccount);
        let codes = [];
        if (data['form']['journalIds'] ?? false) {
            codes = await (await this.env.items('account.journal').search([['id', 'in', data['form']['journalIds']]])).map(journal => journal.code);
        }
        return {
            'docIds': this.ids,
            'docModel': model,
            'data': data['form'],
            'docs': docs,
            'printJournal': codes,
            'analyticAccounts': analyticAccounts,
            'now': () => new Date(),
            'accounts': accountRes,
        }
    }
}