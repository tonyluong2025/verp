import { api } from "../../../core";
import { UserError } from "../../../core/helper";
import { AbstractModel, MetaModel } from "../../../core/models";
import { _convert$, parseFloat, quoteList } from "../../../core/tools";

@MetaModel.define()
class ReportJournal extends AbstractModel {
    static _module = module;
    static _name = 'report.accounting.journal';
    static _description = 'Journal Audit Report';

    async lines(targetMove, journalIds, sortSelection, data) {
        if (typeof(journalIds) === 'number') {
            journalIds = [journalIds];
        }

        let moveState = ['draft', 'posted'];
        if (targetMove === 'posted') {
            moveState = ['posted'];
        }

        const queryGetClause = await this._getQueryGetClause(data);
        let query = `SELECT "accountMoveLine".id FROM ` + queryGetClause[0] + `, "accountMove" am, "accountAccount" acc WHERE "accountMoveLine"."accountId" = acc.id AND "accountMoveLine"."moveId"=am.id AND am.state IN (${quoteList(moveState)}) AND "accountMoveLine"."journalId" IN (${String(journalIds) || 'NULL'}) AND ` + queryGetClause[1] + ` ORDER BY `;
        if (sortSelection === 'date') {
            query += '"accountMoveLine".date';
        }
        else {
            query += 'am.label';
        }
        query += ', "accountMoveLine"."moveId", acc.code';
        const res = await this.env.cr.execute(_convert$(query), {bind: queryGetClause[2]});
        return this.env.items('account.move.line').browse(res.map(r => r['id']));
    }

    async _sumDebit(data, journalId) {
        let moveState = ['draft', 'posted'];
        if ((data['form']['targetMove'] || 'all') === 'posted') {
            moveState = ['posted'];
        }

        const queryGetClause = await this._getQueryGetClause(data);
        const sql = `SELECT SUM(debit) as debit FROM ` + queryGetClause[0] + `, "accountMove" am 
                        WHERE "accountMoveLine"."moveId"=am.id AND am.state IN (${quoteList(moveState)}) AND "accountMoveLine"."journalId" IN (${String(journalId.ids) || 'NULL'}) AND ` + queryGetClause[1] + ' ';
        const res = await this.env.cr.execute(_convert$(sql), {bind: queryGetClause[2]});
        return parseFloat(res[0]['debit']);
    }

    async _sumCredit(data, journalId) {
        let moveState = ['draft', 'posted'];
        if ((data['form']['targetMove'] || 'all') === 'posted') {
            moveState = ['posted'];
        }

        const queryGetClause = await this._getQueryGetClause(data);
        const sql = `SELECT SUM(credit) AS credit FROM ` + queryGetClause[0] + `, "accountMove" am 
                        WHERE "accountMoveLine"."moveId"=am.id AND am.state IN (${quoteList(moveState)}) AND "accountMoveLine"."journalId" IN (${String(journalId.ids) || 'NULL'}) AND ` + queryGetClause[1] + ' ';
        const res = await this.env.cr.execute(_convert$(sql), {bind: queryGetClause[2]});
        return parseFloat(res[0]['credit']);
    }

    async _getTaxes(data, journalId) {
        let moveState = ['draft', 'posted'];
        if ((data['form']['targetMove'] || 'all') === 'posted') {
            moveState = ['posted'];
        }

        const queryGetClause = await this._getQueryGetClause(data);
        const query = `
            SELECT rel."accountTaxId" AS id, SUM("accountMoveLine".balance) AS amount
            FROM "accountMoveLineAccountTaxRel" rel, ` + queryGetClause[0] + ` 
            LEFT JOIN "accountMove" am ON "accountMoveLine"."moveId" = am.id
            WHERE "accountMoveLine".id = rel."accountMoveLineId"
                AND am.state IN (${quoteList(moveState)})
                AND "accountMoveLine"."journalId" IN (${String(journalId.ids) || 'NULL'})
                AND ` + queryGetClause[1] + `
           GROUP BY rel."accountTaxId"`;
        const res = await this.env.cr.execute(_convert$(query), {bind: queryGetClause[2]});
        const ids = [];
        const baseAmounts = {};
        for (const row of res) {
            ids.push(row['id']);
            baseAmounts[row['id']] = parseFloat(row['amount']);
        }

        const result = {};
        for (const tax of this.env.items('account.tax').browse(ids)) {
            const query = `SELECT sum(debit - credit) AS balance FROM ` + queryGetClause[0] + `, "accountMove" am 
                WHERE "accountMoveLine"."moveId"=am.id AND am.state IN (${quoteList(moveState)}) AND "accountMoveLine"."journalId" IN (${String(journalId.ids) || 'NULL'}) AND ` + queryGetClause[1] + ` AND "taxLineId" = ${tax.id}`;
            const res = await this.env.cr.execute(_convert$(query), {bind: queryGetClause[2]});
            result[tax] = {
                'baseAmount': baseAmounts[tax.id],
                'taxAmount': parseFloat(res[0]['balance']),
            }
            if (await journalId.type === 'sale') {
                //sales operation are credits
                result[tax]['baseAmount'] = result[tax]['baseAmount'] * -1
                result[tax]['taxAmount'] = result[tax]['taxAmount'] * -1
            }
        }
        return result;
    }

    async _getQueryGetClause(data) {
        return (await this.env.items('account.move.line').withContext(data['form']['usedContext'] || {}))._queryGet();
    }

    @api.model()
    async _getReportValues(docids, data?: any) {
        if (! data['form']) {
            throw new UserError(await this._t("Form content is missing, this report cannot be printed."));
        }

        const targetMove = data['form']['targetMove'] || 'all';
        const sortSelection = data['form']['sortSelection'] || 'date';

        const res = {};
        for (const journal of data['form']['journalIds']) {
            res[journal] = await (await this.withContext(data['form']['usedContext'] || {})).lines(targetMove, journal, sortSelection, data);
        }
        const self = this;
        return {
            'docIds': data['form']['journalIds'],
            'docModel': this.env.items('account.journal'),
            'data': data,
            'docs': this.env.items('account.journal').browse(data['form']['journalIds']),
            'now': () => new Date(),
            'lines': res,
            'sumCredit': this._sumCredit.bind(self),
            'sumDebit': this._sumDebit.bind(self),
            'getTaxes': this._getTaxes.bind(self),
        }
    }
}
