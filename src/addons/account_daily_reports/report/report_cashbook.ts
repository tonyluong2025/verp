import { api } from "../../../core";
import { UserError } from "../../../core/helper";
import { AbstractModel, MetaModel } from "../../../core/models";
import { _convert$, bool, parseValues, pop } from "../../../core/tools";

@MetaModel.define()
class ReportCashBook extends AbstractModel {
    static _module = module;
    static _name = 'report.account.daily.cashbook';
    static _description = 'Cash Book';

    /**
     * :param:
                       accounts: the recordset of accounts
                       init_balance: boolean value of initial_balance
                       sortby: sorting by date or partner and journal
                       display_account: type of account(receivable, payable and both)

               Returns a dictionary of accounts with following key and value {
                       'code': account code,
                       'name': account name,
                       'debit': sum of total debit amount,
                       'credit': sum of total credit amount,
                       'balance': total balance,
                       'amount_currency': sum of amount_currency,
                       'move_lines': list of move line
               }
     * @param accounts 
     * @param initBalance 
     * @param sortby 
     * @param displayAccount 
     * @returns 
     */
    async _getAccountMoveEntry(accounts, initBalance, sortby, displayAccount) {
        const cr = this.env.cr;
        const moveLine = this.env.items('account.move.line');
        const moveLines = Object.fromEntries(accounts.ids.map(x => [x, []]));

        // Prepare initial sql query and Get the initial move lines
        if (bool(initBalance)) {
            const [initTables, initWhereClause, initWhereParams] = await (await moveLine.withContext({ dateFrom: this.env.context['dateFrom'], dateTo: false, initialBal: true }))._queryGet();
            const initWheres = [""];
            if (initWhereClause.trim()) {
                initWheres.push(initWhereClause.trim());
            }
            const initFilters = initWheres.join(' AND ');
            let filters = initFilters.replace(/accountMoveLine__moveId/gm, 'm').replace(/accountMoveLine/gm, 'l');
            const sql = `
                    SELECT 0 AS lid, 
                    l."accountId" AS "accountId", '' AS ldate, '' AS lcode, 
                    0.0 AS "amountCurrency",'' AS lref, 'Initial Balance' AS llabel, 
                    COALESCE(SUM(l.credit),0.0) AS credit, COALESCE(SUM(l.debit),0.0) AS debit, COALESCE(SUM(l.debit),0) - COALESCE(SUM(l.credit),0) as balance, 
                    '' AS "lpartnerId", '' AS "moveName", '' AS "currencyCode", NULL AS "currencyId", '' AS "partnerName",
                    '' AS "mmoveId", '' AS "invoiceId", '' AS "invoiceType", '' AS "invoiceNumber"
                    FROM "accountMoveLine" l 
                    LEFT JOIN "accountMove" m ON (l."moveId" = m.id) 
                    LEFT JOIN "resCurrency" c ON (l."currencyId" = c.id) 
                    LEFT JOIN "resPartner" p ON (l."partnerId" = p.id) 
                    JOIN "accountJournal" j ON (l."journalId" = j.id) 
                    JOIN "accountAccount" acc ON (l."accountId" = acc.id) 
                    WHERE l."accountId" IN (${String(accounts.ids) || 'NULL'})` + filters + 'GROUP BY l."accountId"';
            const res = await cr.execute(_convert$(sql), { bind: initWhereParams });
            for (const row of res) {
                moveLines[pop(row, 'accountId')].push(parseValues(row));
            }
        }
        let sqlSort = 'l.date, l."moveId"';
        if (sortby === 'sortJournalPartner') {
            sqlSort = 'j.code, p.label, l."moveId"';
        }
        // Prepare sql query base on selected parameters from wizard
        const [tables, whereClause, whereParams] = await moveLine._queryGet();
        const wheres = [""];
        if (whereClause.trim()) {
            wheres.push(whereClause.trim());
        }
        let filters = wheres.join(" AND ");
        filters = filters.replace(/accountMoveLine__moveId/gm, 'm').replace(/accountMoveLine/gm, 'l');
        if (!bool(accounts)) {
            const journals = await this.env.items('account.journal').search([['type', '=', 'cash']]);
            accounts = [];
            for (const journal of journals) {
                for (const accOut of await journal.outboundPaymentMethodLineIds) {
                    const paymentAccount = await accOut.paymentAccountId;
                    if (paymentAccount.ok) {
                        accounts.push(paymentAccount.id);
                    }
                }
                for (const accIn of await journal.inboundPaymentMethodLineIds) {
                    const paymentAccount = await accIn.paymentAccountId;
                    if (paymentAccount.ok) {
                        accounts.push(paymentAccount.id);
                    }
                }
            }
            accounts = await this.env.items('account.account').search([['id', 'in', accounts]]);
        }
        const sql = `SELECT l.id AS lid, l."accountId" AS "accountId", l.date AS ldate, j.code AS lcode, l."currencyId", l."amountCurrency", l.ref AS lref, l.label AS llabel, COALESCE(l.debit,0) AS debit, COALESCE(l.credit,0) AS credit, COALESCE(SUM(l.debit),0) - COALESCE(SUM(l.credit), 0) AS balance,
                        m.label AS "moveName", c.symbol AS "currencyCode", p.label AS "partnerName"
                        FROM "accountMoveLine" l
                        JOIN "accountMove" m ON (l."moveId"=m.id)
                        LEFT JOIN "resCurrency" c ON (l."currencyId"=c.id)
                        LEFT JOIN "resPartner" p ON (l."partnerId"=p.id)
                        JOIN "accountJournal" j ON (l."journalId"=j.id)
                        JOIN "accountAccount" acc ON (l."accountId" = acc.id)
                        WHERE l."accountId" IN (${String(accounts.ids) || 'NULL'}) ` + filters + ` GROUP BY l.id, l."accountId", l.date, j.code, l."currencyId", l."amountCurrency", l.ref, l.label, m.label, c.symbol, p.label ORDER BY ` + sqlSort;
        const res = await cr.execute(_convert$(sql), { bind: whereParams });
        for (const row of res) {
            let balance = 0;
            for (const line of moveLines[row['accountId']]) {
                balance += line['debit'] - line['credit'];
            }
            parseValues(row);
            row['balance'] += balance;
            moveLines[pop(row, 'accountId')].push(row);
        }
        // Calculate the debit, credit and balance for Accounts
        const accountRes = [];
        for (const account of accounts) {
            let [code, label, currency, company] = await account('code', 'label', 'currencyId', 'companyId');
            currency = bool(currency) ? currency : await company.currencyId;
            const res: any = Object.fromEntries(['credit', 'debit', 'balance'].map(fn => [fn, 0.0]));
            res['code'] = code;
            res['label'] = label;
            res['moveLines'] = moveLines[account.id];
            for (const line of res['moveLines']) {
                res['debit'] += line['debit'];
                res['credit'] += line['credit'];
                res['balance'] = line['balance'];
            }
            if (displayAccount === 'all') {
                accountRes.push(res);
            }
            if (displayAccount === 'movement' && res['moveLines']) {
                accountRes.push(res);
            }
            if (displayAccount === 'notZero' && ! await currency.isZero(res['balance'])) {
                accountRes.push(res);
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
        const initBalance = data['form']['initialBalance'] || true;
        const displayAccount = data['form']['displayAccount'];

        const sortby = data['form']['sortby'] || 'sortDate';
        let codes = [];

        if (data['form']['journalIds'] || false) {
            codes = await (await this.env.items('account.journal').search([['id', 'in', data['form']['journalIds']]])).map(journal => journal.code);
        }
        const accountIds = data['form']['accountIds'];
        let accounts = await this.env.items('account.account').search([['id', 'in', accountIds]]);
        if (!bool(accounts)) {
            const journals = await this.env.items('account.journal').search([['type', '=', 'cash']]);
            accounts = [];
            for (const journal of journals) {
                for (const accOut of await journal.outboundPaymentMethodLineIds) {
                    const paymentAccount = await accOut.paymentAccountId;
                    if (paymentAccount.ok) {
                        accounts.push(paymentAccount.id);
                    }
                }
                for (const accIn of await journal.inboundPaymentMethodLineIds) {
                    const paymentAccount = await accIn.paymentAccountId;
                    if (paymentAccount.ok) {
                        accounts.push(paymentAccount.id);
                    }
                }
            }
            accounts = await this.env.items('account.account').search([['id', 'in', accounts]]);
        }
        const record = await (await this.withContext(data['form']['comparisonContext'] || {}))._getAccountMoveEntry(accounts, initBalance, sortby, displayAccount);
        return {
            'docIds': docids,
            'docModel': model,
            'data': data['form'],
            'docs': docs,
            'now': () => new Date(),
            'Accounts': record,
            'printJournal': codes,
        }
    }
}