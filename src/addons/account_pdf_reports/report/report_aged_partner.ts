import { _Date, api } from "../../../core";
import { UserError } from "../../../core/helper";
import { AbstractModel, MetaModel } from "../../../core/models";
import { ellipsis, floatIsZero, quoteList } from "../../../core/tools";
import { bool } from "../../../core/tools/bool";
import { subDate, toDate, toDatetime, toFormat } from "../../../core/tools/date_utils";
import { range, sum } from "../../../core/tools/iterable";

@MetaModel.define()
class ReportAgedPartnerBalance extends AbstractModel {
    static _module = module;
    static _name = 'report.accounting.agedpartnerbalance';
    static _description = 'Aged Partner Balance Report';

    async _getPartnerMoveLines(accountType, partnerIds, dateFrom, targetMove, periodLength) {
        // This method can receive the context key 'includeNullifiedAmount' {Boolean}
        // Do an invoice and a payment and unreconcile. The amount will be nullified
        // By default, the partner wouldn't appear in this report.
        // The context key allow it to appear
        // In case of a period_length of 30 days as of 2019-02-08, we want the following periods:
        // Name       Stop         Start
        // 1 - 30   : 2019-02-07 - 2019-01-09
        // 31 - 60  : 2019-01-08 - 2018-12-10
        // 61 - 90  : 2018-12-09 - 2018-11-10
        // 91 - 120 : 2018-11-09 - 2018-10-11
        // +120     : 2018-10-10
        const periods = {};
        let start = toDatetime(dateFrom) as Date;
        dateFrom = toDate(dateFrom);
        for (let i=4; i >= 0; i--) {
            const stop = subDate(start, {days: periodLength});
            let periodName = String((5-(i+1)) * periodLength + 1) + '-' + String((5-i) * periodLength);
            const periodStop = toFormat(subDate(start, {days: 1}), 'yyyy-MM-dd');
            if (i == 0) {
                periodName = '+' + String(4 * periodLength);
            }
            periods[String(i)] = {
                'label': periodName,
                'stop': periodStop,
                'start': i!=0 && toFormat(stop, 'yyyy-MM-dd') || false,
            }
            start = stop;
        }
        const result = [];
        const total = [];
        const cr = this.env.cr;
        const userCompany = await (await this.env.user()).companyId;
        const userCurrency = await userCompany.currencyId;
        const companyIds = this._context['companyIds'] || [userCompany.id];
        let moveState = ['draft', 'posted'];
        const date = this._context['date'] || _Date.today();
        let company = this.env.items('res.company').browse(this._context['companyId']);
        company = company.ok ? company : await this.env.company();

        if (targetMove === 'posted') {
            moveState = ['posted'];
        }
        let argList = [quoteList(moveState), quoteList(accountType)];

        let reconciliationClause = '(l."reconciled" IS FALSE)';
        const res = await cr.execute(`SELECT "debitMoveId", "creditMoveId" FROM "accountPartialReconcile" WHERE "maxDate" > '%s'`, [dateFrom.toISOString()]);
        let reconciledAfterDate = [];
        for (const row of res) {
            reconciledAfterDate = reconciledAfterDate.concat([row['debitMoveId'], row['creditMoveId']]);
        }
        if (reconciledAfterDate.length) {
            reconciliationClause = '(l."reconciled" IS FALSE OR l.id IN (%s))';
            argList = argList.concat([String(Array.from(new Set(reconciledAfterDate)))]);
        }
        argList = argList.concat([dateFrom.toISOString(), String(companyIds)]);
        let query = `
            SELECT DISTINCT l."partnerId", UPPER("resPartner".label)
            FROM "accountMoveLine" AS l LEFT JOIN "resPartner" on l."partnerId" = "resPartner".id, "accountAccount", "accountMove" am
            WHERE (l."accountId" = "accountAccount".id)
                AND (l."moveId" = am.id)
                AND (am.state IN (%s))
                AND ("accountAccount"."internalType" IN (%s))
                AND ` + reconciliationClause + `
                AND (l.date <= '%s')
                AND l."companyId" IN (%s)
            ORDER BY UPPER("resPartner".label)`;
        const partners = await cr.execute(query, argList);
        // put a total of 0
        for (let i=7; i >= 0; i--) {
            total.push(0);
        }

        // Build a string like (1,2,3) for easy use in SQL query
        if (! bool(partnerIds)) {
            partnerIds = partners.filter(partner => partner['partnerId']).map(partner => partner['partnerId']);
        }
        const lines = Object.fromEntries(partners.map(partner => [partner['partnerId'] || false, []]));
        if (! bool(partnerIds)) {
            return [[], [], {}];
        }

        // This dictionary will store the not due amount of all partners
        const undueAmounts = {};
        query = `SELECT l.id
                FROM "accountMoveLine" AS l, "accountAccount", "accountMove" am
                WHERE (l."accountId" = "accountAccount".id) AND (l."moveId" = am.id)
                    AND (am.state IN (%s))
                    AND ("accountAccount"."internalType" IN (%s))
                    AND (COALESCE(l."dateMaturity",l.date) >= '%s')
                    AND ((l."partnerId" IN (%s)) OR (l."partnerId" IS NULL))
                AND (l.date <= '%s')
                AND l."companyId" IN (%s)`;
        let amlIds =  await cr.execute(query, [quoteList(moveState), quoteList(accountType), dateFrom.toISOString(),
                           String(partnerIds), dateFrom.toISOString(), String(companyIds)]);
        amlIds = amlIds.map(r => r['id']);
        for (const line of this.env.items('account.move.line').browse(amlIds)) {
            const [partner, balance] = await line('partnerId', 'balance');
            let partnerId = partner.id;
            partnerId = bool(partnerId) ? partnerId : false;
            if (!(partnerId in undueAmounts)) {
                undueAmounts[partnerId] = 0.0;
            }
            let lineAmount = await (await (await line.companyId).currencyId)._convert(balance, userCurrency, company, date)
            if (await userCurrency.isZero(lineAmount)) {
                continue;
            }
            for (const partialLine of await line.matchedDebitIds) {
                if (await partialLine.maxDate <= dateFrom) {
                    const lineCurrency = await (await partialLine.companyId).currencyId;
                    lineAmount += await lineCurrency._convert(await partialLine.amount, userCurrency, company, date);
                }
            }
            for (const partialLine of await line.matchedCreditIds) {
                if (await partialLine.maxDate <= dateFrom) {
                    const lineCurrency = await (await partialLine.companyId).currencyId;
                    lineAmount -= await lineCurrency._convert(await partialLine.amount, userCurrency, company, date);
                }
            }
            if (! await (await (await (await this.env.user()).companyId).currencyId).isZero(lineAmount)) {
                undueAmounts[partnerId] += lineAmount;
                lines[partnerId].push({
                    'line': line,
                    'amount': lineAmount,
                    'period': 6,
                });
            }
        }
        // Use one query per period and store results in history (a list variable)
        // Each history will contain: history[1] = {'<partnerId>': <partner_debit-credit>}
        const history = [];
        for (const i of range(5)) {
            let argsList = [quoteList(moveState), quoteList(accountType), String(partnerIds),];
            let datesQuery = '(COALESCE(l."dateMaturity",l.date)';

            if (periods[i]['start'] && periods[i]['stop']) {
                datesQuery += " BETWEEN '%s' AND '%s')";
                argsList = argsList.concat([periods[i]['start'], periods[i]['stop']]);
            }
            else if (periods[i]['start']) {
                datesQuery += " >= '%s')"
                argsList = argsList.concat([periods[i]['start'],]);
            }
            else {
                datesQuery += " <= '%s')"
                argsList = argsList.concat([periods[i]['stop'],]);
            }
            argsList = argsList.concat([dateFrom.toISOString(), String(companyIds)]);

            query = `SELECT l.id
                    FROM "accountMoveLine" AS l, "accountAccount", "accountMove" am
                    WHERE (l."accountId" = "accountAccount".id) AND (l."moveId" = am.id)
                        AND (am.state IN (%s))
                        AND ("accountAccount"."internalType" IN (%s))
                        AND ((l."partnerId" IN (%s)) OR (l."partnerId" IS NULL))
                        AND ` + datesQuery + `
                    AND (l.date <= '%s')
                    AND l."companyId" IN (%s)`;
            const res = await cr.execute(query, argsList);
            const partnersAmount = {};
            const amlIds = res.map(row => row['id']);
            for (const line of this.env.items('account.move.line').browse(amlIds)) {
                let partnerId = (await line.partnerId).id;
                partnerId = bool(partnerId) ? partnerId : false;
                if (! (partnerId in partnersAmount)) {
                    partnersAmount[partnerId] = 0.0;
                }
                const lineCurrencyId = await (await line.companyId).currencyId;
                let lineAmount = await lineCurrencyId._convert(await line.balance, userCurrency, company, date);
                if (await userCurrency.isZero(lineAmount)) {
                    continue;
                }
                for (const partialLine of await line.matchedDebitIds) {
                    if (await partialLine.maxDate <= dateFrom) {
                        const lineCurrencyId = await (await partialLine.companyId).currencyId;
                        lineAmount += await lineCurrencyId._convert(await partialLine.amount, userCurrency, company, date);
                    }
                }
                for (const partialLine of await line.matchedCreditIds) {
                    if (await partialLine.maxDate <= dateFrom) {
                        const lineCurrencyId = await (await partialLine.companyId).currencyId;
                        lineAmount -= await lineCurrencyId._convert(await partialLine.amount, userCurrency, company, date);
                    }
                }
                if (! await (await (await (await this.env.user()).companyId).currencyId).isZero(lineAmount)) {
                    partnersAmount[partnerId] += lineAmount;
                    lines[partnerId].push({
                        'line': line,
                        'amount': lineAmount,
                        'period': i + 1,
                    });
                }
            }
            history.push(partnersAmount);
        }

        for (const partner of partners) {
            if (partner['partnerId'] == null) {
                partner['partnerId'] = false;
            }
            let atLeastOneAmount = false;
            const values = {};
            let undueAmt = 0.0;
            if (partner['partnerId'] in undueAmounts) {  // Making sure this partner actually was found by the query
                undueAmt = undueAmounts[partner['partnerId']];
            }

            const rounding = await (await (await (await this.env.user()).companyId).currencyId).rounding;
            total[6] = total[6] + undueAmt;
            values['direction'] = undueAmt;
            if (! floatIsZero(values['direction'], {precisionRounding: rounding})) {
                atLeastOneAmount = true;
            }

            for (const i in range(5)) {
                let during: any = false;
                if (partner['partnerId'] in history[i]) {
                    during = [history[i][partner['partnerId']]];
                }
                // Adding counter
                total[i] = total[i] + (bool(during) && during[0] || 0);
                values[i] = bool(during) && during[0] || 0.0;
                if (! floatIsZero(values[i], {precisionRounding: rounding})) {
                    atLeastOneAmount = true;
                }
            }
            values['total'] = sum([values['direction']].concat(Array.from(range(5)).map(i => values[i])));
            //// Add for total
            total[6] += values['total'];
            values['partnerId'] = partner['partnerId'];
            if (partner['partnerId']) {
                const browsedPartner = this.env.items('res.partner').browse(partner['partnerId']);
                values['label'] = ellipsis(await browsedPartner.label, 45);
                values['trust'] = await browsedPartner.trust;
            }
            else {
                values['label'] = await this._t('Unknown Partner');
                values['trust'] = false;
            }
            if (atLeastOneAmount || (this._context['includeNullifiedAmount'] && lines[partner['partnerId']])) {
                result.push(values);
            }
        }

        return [result, total, lines];
    }

    @api.model()
    async _getReportValues(docids, data?: any) {
        if (! data['form'] || ! this.env.context['activeModel'] || ! this.env.context['activeId']) {
            throw new UserError(await this._t("Form content is missing, this report cannot be printed."));
        }

        const model = this.env.context['activeModel'];
        const docs = this.env.items(model).browse(this.env.context['activeId']);

        const targetMove = data['form']['targetMove'] || 'all';
        const dateFrom = toFormat(new Date(data['form']['dateFrom']), 'yyyy-MM-dd');

        let accountType;
        if (data['form']['resultSelection'] === 'customer') {
            accountType = ['receivable'];
        }
        else if (data['form']['resultSelection'] === 'supplier') {
            accountType = ['payable'];
        }
        else {
            accountType = ['payable', 'receivable'];
        }
        const partnerIds = data['form']['partnerIds'];
        const [movelines, total, ] = await this._getPartnerMoveLines(accountType, partnerIds, dateFrom, targetMove, data['form']['periodLength']);
        return {
            'docIds': this.ids,
            'docModel': model,
            'data': data['form'],
            'docs': docs,
            'now': () => new Date(),
            'getPartnerLines': movelines,
            'getDirection': total,
        }
    }
}