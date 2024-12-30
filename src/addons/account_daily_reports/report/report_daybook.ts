import { DateTime } from "luxon";
import { api } from "../../../core";
import { UserError } from "../../../core/helper";
import { AbstractModel, MetaModel } from "../../../core/models";
import { bool, parseValues, range } from "../../../core/tools";
import { addDate, diffDate } from "../../../core/tools/date_utils";

@MetaModel.define()
class ReportDayBook extends AbstractModel {
    static _module = module;
    static _name = 'report.account.daily.daybook';
    static _description = 'Day Book';

    async _getAccountMoveEntry(accounts, formData: {}, date: Date) {
        const cr = this.env.cr;
        let moveLine = this.env.items('account.move.line');
        const initWheres = [""];

        const [initTables, initWhereClause, initWhereParams] = await moveLine._queryGet();
        if (initWhereClause.trim()) {
            initWheres.push(initWhereClause.trim());
        }
        let targetMove;
        if (formData['targetMove'] === 'posted') {
            targetMove = "AND m.state = 'posted'";
        }
        else {
            targetMove = '';
        }
        const sql = `
                    SELECT 0 AS lid, 
                          l."accountId" AS "accountId", l.date AS ldate, j.code AS lcode, 
                          l."amountCurrency" AS "amountCurrency", l.ref AS lref, l.label AS llabel, 
                          COALESCE(SUM(l.credit),0.0) AS credit, COALESCE(l.debit,0) AS debit, COALESCE(SUM(l.debit),0) - COALESCE(SUM(l.credit),0) as balance, 
                              m.label AS "moveName", 
                              c.symbol AS "currencyCode", 
                              p.name AS "lpartnerId", 
                              m.id AS "mmoveId" 
                            FROM 
                              "accountMoveLine" l 
                              LEFT JOIN "accountMove" m ON (l."moveId" = m.id) 
                              LEFT JOIN "resCurrency" c ON (l."currencyId" = c.id) 
                              LEFT JOIN "resPartner" p ON (l."partnerId" = p.id) 
                              JOIN "accountJournal" j ON (l."journalId" = j.id) 
                              JOIN "accountAccount" acc ON (l."accountId" = acc.id) 
                            WHERE 
                              l."accountId" IN (${String(accounts.ids) || 'NULL'}) 
                              AND l."journalId" IN (${String(formData['journalIds']) || 'NULL'}) ` + targetMove + ` 
                              AND l.date = '${date.toISOString()}' 
                            GROUP BY 
                              l.id, 
                              l."accountId", 
                              l.date, 
                              m.label, 
                              m.id, 
                              p.label, 
                              c.symbol, 
                              j.code, 
                              l.ref 
                            ORDER BY 
                              l.date DESC
                     `;
        const data = await cr.execute(sql);
        const res = {};
        let [debit, credit, balance] = [0.00, 0.00, 0.00];
        for (const line of data) {
            parseValues(line);
            debit += line['debit'];
            credit += line['credit'];
            balance += line['balance'];
        }
        res['debit'] = debit;
        res['credit'] = credit;
        res['balance'] = balance;
        res['lines'] = data;
        return res;
    }

    @api.model()
    async _getReportValues(docids, data?: any) {
        if (!data['form'] || !this.env.context['activeModel']) {
            throw new UserError(await this._t("Form content is missing, this report cannot be printed."));
        }
        const model = this.env.context['activeModel'];
        const docs = this.env.items(model).browse(this.env.context['activeIds'] || []);
        const formData = data['form'];

        const dateFrom = DateTime.fromFormat(String(formData['dateFrom']), 'yyyy-MM-dd').toJSDate();
        const dateTo = DateTime.fromFormat(String(formData['dateTo']), 'yyyy-MM-dd').toJSDate();
        let codes = [];

        const journalIds = data['form']['journalIds'];
        if (bool(journalIds)) {//} || false) {
            codes = await (await this.env.items('account.journal').search([['id', 'in', journalIds]])).map(journal => journal.code);
        }
        const accounts = await this.env.items('account.account').search([]);
        const dates = [];
        const record = [];
        let daysTotal = diffDate(dateTo, dateFrom).days;
        for (const day of range(daysTotal + 1)) {
            dates.push(addDate(dateFrom, { days: day }));
        }
        for (const date of dates) {
            // const dateData = date.toString();
            const accountsRes = await (await this.withContext(data['form']['comparisonContext'] || {}))._getAccountMoveEntry(accounts, formData, date);
            if (bool(accountsRes['lines'])) {
                record.push({
                    'date': date,
                    'debit': accountsRes['debit'],
                    'credit': accountsRes['credit'],
                    'balance': accountsRes['balance'],
                    'moveLines': accountsRes['lines']
                })
            }
        }
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