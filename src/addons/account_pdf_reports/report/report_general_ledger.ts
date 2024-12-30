import { api } from "../../../core";
import { UserError } from "../../../core/helper/errors";
import { AbstractModel, MetaModel } from "../../../core/models";
import { _convert$, parseValues } from "../../../core/tools";
import { bool } from "../../../core/tools/bool";
import { pop } from "../../../core/tools/misc";

@MetaModel.define()
class ReportGeneralLedger extends AbstractModel {
    static _module = module;
    static _name = 'report.accounting.generalledger';
    static _description = 'General Ledger Report';

    /**
     *         :param:
                accounts: the recordset of accounts
                analyticAccountIds: the recordset of analytic accounts
                initBalance: boolean value of initial_balance
                sortby: sorting by date or partner and journal
                displayAccount: type of account(receivable, payable and both)

        Returns a dictionary of accounts with following key and value {
                'code': account code,
                'name': account name,
                'debit': sum of total debit amount,
                'credit': sum of total credit amount,
                'balance': total balance,
                'amountCurrency': sum of amount_currency,
                'moveLines': list of move line
        }

     * @param accounts 
     * @param analyticAccountIds 
     * @param partnerIds 
     * @param initBalance 
     * @param sortby 
     * @param displayAccount 
     * @returns 
     */
    async _getAccountMoveEntry(accounts, analyticAccountIds, partnerIds, initBalance, sortby, displayAccount) {
        const cr = this.env.cr;
        const MoveLine = this.env.items('account.move.line');
        const moveLines = Object.fromEntries(Array.from(accounts.ids).map(x => [x, []]));

        // Prepare initial sql query and Get the initial move lines
        if (initBalance) {
            const context = Object.assign({}, this.env.context);
            context['dateFrom'] = this.env.context['dateFrom'];
            context['dateTo'] = false;
            context['initialBal'] = true;
            if (bool(analyticAccountIds)) {
                context['analyticAccountIds'] = analyticAccountIds;
            }
            if (bool(partnerIds)) {
                context['partnerIds'] = partnerIds;
            }
            const [initTables, initWhereClause, initWhereParams] = await (await MoveLine.withContext(context))._queryGet();
            const initWheres = [''];
            if (initWhereClause.trim()) {
                initWheres.push(initWhereClause.trim());
            }
            const initFilters = initWheres.join(' AND ');
            const filters = initFilters.replace(/accountMoveLine__moveId/gm, 'm').replace(/accountMoveLine/gm, 'l');
            const sql = `SELECT 0 AS lid, l."accountId" AS "accountId", '' AS ldate,
                '' AS lcode, 0.0 AS "amountCurrency", 
                aaa.label AS "analyticAccountId", '' AS lref, 
                'Initial Balance' AS llabel, COALESCE(SUM(l.debit),0.0) AS debit, 
                COALESCE(SUM(l.credit),0.0) AS credit, 
                COALESCE(SUM(l.debit),0) - COALESCE(SUM(l.credit), 0) as balance, 
                '' AS "lpartnerId",
                '' AS "moveName", '' AS "mmoveId", '' AS "currencyCode",
                NULL AS "currencyId",
                '' AS "invoiceId", '' AS "invoiceType", '' AS "invoiceNumber",
                '' AS "partnerName"
                FROM "accountMoveLine" l
                LEFT JOIN "accountMove" m ON (l."moveId"=m.id)
                LEFT JOIN "accountAnalyticAccount" aaa ON (aaa.id=l."analyticAccountId")
                LEFT JOIN "resCurrency" c ON (l."currencyId"=c.id)
                LEFT JOIN "resPartner" p ON (l."partnerId"=p.id)
                JOIN "accountJournal" j ON (l."journalId"=j.id)
                WHERE l.accountId IN (${String(accounts.ids) || 'NULL'})` + filters + ' GROUP BY l."accountId", aaa.label';
            const res = await cr.execute(_convert$(sql), {bind: initWhereParams});
            for (const row of res) {
                moveLines[pop(row, 'accountId')].push(parseValues(row));
            }
        }

        let sqlSort = 'l.date, l."moveId"';
        if (sortby === 'sortJournalPartner') {
            sqlSort = 'j.code, p.label, l."moveId"';
        }

        // Prepare sql query base on selected parameters from wizard
        const context = Object.assign({}, this.env.context);
        if (bool(analyticAccountIds)) {
            context['analyticAccountIds'] = analyticAccountIds;
        }
        if (bool(partnerIds)) {
            context['partnerIds'] = partnerIds;
        }

        const [tables, whereClause, whereParams] = await (await MoveLine.withContext(context))._queryGet();
        const wheres = [''];
        if (whereClause.trim()) {
            wheres.push(whereClause.trim());
        }
        let filters = wheres.join(' AND ');
        filters = filters.replace(/accountMoveLine__moveId/gm, 'm').replace(/accountMoveLine/gm, 'l');

        // Get move lines base on sql query and Calculate the total balance of move lines
        const sql = `SELECT l.id AS lid, l."accountId" AS "accountId", 
            l.date AS ldate, j.code AS lcode, l."currencyId", 
            l."amountCurrency", aaa.label AS "analyticAccountId",
            l.ref AS lref, l.label AS llabel, COALESCE(l.debit,0) AS debit, 
            COALESCE(l.credit,0) AS credit, 
            COALESCE(SUM(l.debit),0) - COALESCE(SUM(l.credit), 0) AS balance,
            m.label AS "moveName", c.symbol AS "currencyCode", 
            p.label AS "partnerName"
            FROM "accountMoveLine" l
            JOIN "accountMove" m ON (l."moveId"=m.id)
            LEFT JOIN "resCurrency" c ON (l."currencyId"=c.id)
            LEFT JOIN "resPartner" p ON (l."partnerId"=p.id)
            JOIN "accountJournal" j ON (l."journalId"=j.id)
            LEFT JOIN "accountAnalyticAccount" aaa ON (aaa.id=l."analyticAccountId")
            JOIN "accountAccount" acc ON (l."accountId" = acc.id) 
            WHERE l."accountId" IN (${String(accounts.ids) || 'NULL'}) ` + filters + ` GROUP BY l.id, 
            l."accountId", l.date, j.code, l."currencyId", l."amountCurrency", 
            l.ref, l.label, m.label, c.symbol, p.label, aaa.label ORDER BY ` + sqlSort;
        const res = await cr.execute(_convert$(sql), {bind: whereParams});
        for (const row of res) {
            let balance = 0;
            for (const line of moveLines[row['accountId']]) {
                balance += line['debit'] - line['credit'];
            }
            row['balance'] += balance;
            moveLines[pop(row, 'accountId')].push(row);
        }

        // Calculate the debit, credit and balance for Accounts
        const accountRes = [];
        for (const account of accounts) {
            let [currency, label, code] = await account('currencyId', 'label', 'code');
            currency = bool(currency) ? currency : await (await account.companyId).currencyId;
            const row = Object.fromEntries<any>(['credit', 'debit', 'balance'].map(fn => [fn, 0.0]));
            row['code'] = code;
            row['label'] = label;
            row['moveLines'] = moveLines[account.id];
            for (const line of row['moveLines']) {
                row['debit'] += line['debit'];
                row['credit'] += line['credit'];
                row['balance'] = line['balance'];
            }
            if (displayAccount === 'all') {
                accountRes.push(row);
            }
            if (displayAccount === 'movement' && row['moveLines']) {
                accountRes.push(row);
            }
            if (displayAccount === 'notZero' && ! await currency.isZero(row['balance'])) {
                accountRes.push(row);
            }
        }
        return accountRes;
    }

    @api.model()
    async _getReportValues(docids, data?: any) {
        if (!data['form'] || !this.env.context['activeModel']) {
            throw new UserError(await this._t("Form content is missing, this report cannot be printed."));
        }
        const model = this.env.context['activeModel'];
        const docs = this.env.items(model).browse(this.env.context['activeIds'] || []);
        const initBalance = data['form']['initialBalance'] ?? true;
        const sortby = data['form']['sortby'] || 'sortDate';
        const displayAccount = data['form']['displayAccount'];
        let codes = [];
        if (data['form']['journalIds'] || false) {
            codes = await (await this.env.items('account.journal').search([['id', 'in', data['form']['journalIds']]]))
                .map(journal => journal.code);
        }
        let analyticAccountIds = false;
        if (data['form']['analyticAccountIds'] || false) {
            analyticAccountIds = await this.env.items('account.analytic.account').search(
                [['id', 'in', data['form']['analyticAccountIds']]]);
        }
        let partnerIds = false;
        if (data['form']['partnerIds'] || false) {
            partnerIds = await this.env.items('res.partner').search(
                [['id', 'in', data['form']['partnerIds']]]);
        }
        let accounts;
        if (model === 'account.account') {
            accounts = docs;
        }
        else {
            const domain = [];
            if (data['form']['accountIds'] || false) {
                domain.push(['id', 'in', data['form']['accountIds']]);
            }
            accounts = await this.env.items('account.account').search(domain);
        }
        const accountsRes = await (await this.withContext(data['form']['usedContext'] || {}))._getAccountMoveEntry(
            accounts,
            analyticAccountIds,
            partnerIds,
            initBalance, sortby, displayAccount);
        return {
            'docIds': docids,
            'docModel': model,
            'data': data['form'],
            'docs': docs,
            'now': () => new Date(),
            'Accounts': accountsRes,
            'printJournal': codes,
            'accounts': accounts,
            'partnerIds': partnerIds,
            'analyticAccountIds': analyticAccountIds,
        }
    }
}