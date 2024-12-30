import { api } from "../../../core";
import { UserError } from "../../../core/helper/errors";
import { AbstractModel, MetaModel } from "../../../core/models";
import { _convert$, quoteList } from "../../../core/tools";

@MetaModel.define()
class ReportPartnerLedger extends AbstractModel {
    static _module = module;
    static _name = 'report.accounting.partnerledger';
    static _description = 'Partner Ledger Report';

    async _lines(data, partner) {
        const fullAccount = [];
        const currency = this.env.items('res.currency');
        const queryGetData = await (await this.env.items('account.move.line').withContext(data['form']['usedContext'] || {}))._queryGet();
        const reconcileClause = data['form']['reconciled'] ? '' : ' AND "accountMoveLine"."fullReconcileId" IS NULL ';
        const params = [partner.id, quoteList(data['computed']['moveState']), String(data['computed']['accountIds'])].concat(queryGetData[2]);
        const query = `
            SELECT "accountMoveLine".id, "accountMoveLine".date, j.code, acc.code as acode, acc.label as alabel, "accountMoveLine".ref, m.label as "moveName", "accountMoveLine".label, "accountMoveLine".debit, "accountMoveLine".credit, "accountMoveLine"."amountCurrency", "accountMoveLine"."currencyId", c.symbol AS "currencyCode"
            FROM ` + queryGetData[0] + `
            LEFT JOIN "accountJournal" j ON ("accountMoveLine"."journalId" = j.id)
            LEFT JOIN "accountAccount" acc ON ("accountMoveLine"."accountId" = acc.id)
            LEFT JOIN "resCurrency" c ON ("accountMoveLine"."currencyId"=c.id)
            LEFT JOIN "accountMove" m ON (m.id="accountMoveLine"."moveId")
            WHERE "accountMoveLine"."partnerId" = %s
                AND m.state IN (%s)
                AND "accountMoveLine"."accountId" IN (%s) AND ` + queryGetData[1] + reconcileClause + `
                ORDER BY "accountMoveLine".date`;
        const res = await this.env.cr.execute(query, params);
        let sum = 0.0;
        const langCode = this.env.context['lang'] || 'en_US';
        const lang = this.env.items('res.lang');
        const langId = await lang._langGet(langCode);
        const dateFormat = await langId.dateFormat;
        for (const r of res) {
            r['date'] = r['date'];
            r['displayedName'] = ['moveName', 'ref', 'label'].filter(fieldName => ![undefined, null, '', '/'].includes(r[fieldName])).map(fieldName => r[fieldName]).join('-');
            sum += r['debit'] - r['credit'];
            r['progress'] = sum;
            r['currencyId'] = currency.browse(r['currencyId']);
            r['dateFormat'] = dateFormat;
            fullAccount.push(r);
        }
        return fullAccount;
    }

    async _sumPartner(data, partner, field) {
        if (!['debit', 'credit', 'debit - credit'].includes(field)) {
            return;
        }
        const queryGetData = await (await this.env.items('account.move.line').withContext(data['form']['usedContext'] || {}))._queryGet();
        const reconcileClause = data['form']['reconciled'] ? '' : ' AND "accountMoveLine"."fullReconcileId" IS NULL ';

        const params = [partner.id, quoteList(data['computed']['moveState']), String(data['computed']['accountIds'])].concat(queryGetData[2]);
        const query = `SELECT sum("` + field + `") as total
                FROM ` + queryGetData[0] + `, "accountMove" AS m
                WHERE "accountMoveLine"."partnerId" = %s
                    AND m.id = "accountMoveLine"."moveId"
                    AND m.state IN (%s)
                    AND "accountId" IN (%s)
                    AND ` + queryGetData[1] + reconcileClause
        const res = await this.env.cr.execute(query, params);
        const contemp = res[0];
        let result = 0.0;
        if (contemp != undefined) {
            result = contemp['total'] || 0.0;
        }
        return result;
    }

    @api.model()
    async _getReportValues(docids, data?: any) {
        if (! data['form']) {
            throw new UserError(await this._t("Form content is missing, this report cannot be printed."));
        }
        data['computed'] = {};

        const objPartner = this.env.items('res.partner');
        const queryGetData = await (await this.env.items('account.move.line').withContext(data['form']['usedContext'] || {}))._queryGet();
        data['computed']['moveState'] = ['draft', 'posted'];
        if ((data['form']['targetMove'] || 'all') === 'posted') {
            data['computed']['moveState'] = ['posted'];
        }
        const resultSelection = data['form']['resultSelection'] || 'customer';
        if (resultSelection === 'supplier') {
            data['computed']['ACCOUNT_TYPE'] = ['payable'];
        }
        else if (resultSelection === 'customer') {
            data['computed']['ACCOUNT_TYPE'] = ['receivable'];
        }
        else {
            data['computed']['ACCOUNT_TYPE'] = ['payable', 'receivable'];
        }
        let res = await this.env.cr.execute(`
            SELECT a.id
            FROM "accountAccount" a
            WHERE a."internalType" IN (%s)
            AND NOT a.deprecated`, [quoteList(data['computed']['ACCOUNT_TYPE'])]);
        data['computed']['accountIds'] = res.map(row => row['id']);
        const reconcileClause = data['form']['reconciled'] ? '' : ' AND "accountMoveLine"."fullReconcileId" IS NULL ';
        const query = `
            SELECT DISTINCT "accountMoveLine"."partnerId"
            FROM ` + queryGetData[0] + `, "accountAccount" AS account, "accountMove" AS am
            WHERE "accountMoveLine"."partnerId" IS NOT NULL
                AND "accountMoveLine"."accountId" = account.id
                AND am.id = "accountMoveLine"."moveId"
                AND am.state IN (${quoteList(data['computed']['moveState'])})
                AND "accountMoveLine"."accountId" IN (${String(data['computed']['accountIds'])})
                AND NOT account.deprecated
                AND ` + queryGetData[1] + reconcileClause;
        res = await this.env.cr.execute(_convert$(query), {bind: queryGetData[2]});
        let partnerIds;
        if (data['form']['partnerIds']) {
            partnerIds = data['form']['partnerIds'];
        }
        else {
            partnerIds = res.map(r => r['partnerId']);
        }
        let partners = objPartner.browse(partnerIds);
        partners = await partners.sorted(async (x) => [await x.ref || '', await x.label || ''].join(','));
        return {
            'docIds': partnerIds,
            'docModel': this.env.items('res.partner'),
            'data': data,
            'docs': partners,
            'now': () => new Date(),
            'lines': this._lines.bind(this),
            'sumPartner': this._sumPartner.bind(this),
        }
    }
}