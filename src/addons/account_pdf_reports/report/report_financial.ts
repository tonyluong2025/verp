import _ from "lodash";
import { api } from "../../../core";
import { UserError } from "../../../core/helper";
import { AbstractModel, MetaModel } from "../../../core/models";
import { _convert$, parseFloat, parseValues, sorted } from "../../../core/tools";
import { bool } from "../../../core/tools/bool";

@MetaModel.define()
class ReportFinancial extends AbstractModel {
    static _module = module;
    static _name = 'report.accounting.financial';
    static _description = 'Financial Reports';

    /**
     * 
     * @param accounts 
     * @returns 
     */
    async _computeAccountBalance(accounts) {
        const mapping = {
            'balance': "COALESCE(SUM(debit),0) - COALESCE(SUM(credit), 0) as balance",
            'debit': "COALESCE(SUM(debit), 0) as debit",
            'credit': "COALESCE(SUM(credit), 0) as credit",
        };
        const cols = ['balance', 'debit', 'credit'];

        const result = {};
        for (const account of accounts) {
            result[account.id] = Object.fromEntries(cols.map(col => [col, 0.0]));
        }
        if (bool(accounts)) {
            let [tables, whereClause, whereParams] = await this.env.items('account.move.line')._queryGet();
            tables = tables ? tables : '"accountMoveLine"';
            const wheres = [""];
            if (whereClause.trim()) {
                wheres.push(whereClause.trim());
            }
            const filters = wheres.join(' AND ');
            const query = `SELECT "accountId" as id, ` + Object.values(mapping).join(', ') +
                ` FROM ` + tables +
                ` WHERE "accountId" IN (${String(accounts._ids)}) `
                + filters +
                ` GROUP BY "accountId"`;
            const res = await this.env.cr.execute(_convert$(query), { bind: whereParams });
            for (const row of res) {
                result[row['id']] = parseValues(row);
            }
        }
        return result;
    }

    /**
     * returns a dictionary with key=the ID of a record and value=the credit, debit and balance amount
           computed for this record. If the record is of type :
               'accounts' : it's the sum of the linked accounts
               'accountType' : it's the sum of leaf accoutns with such an account_type
               'accountReport' : it's the amount of the related report
               'sum' : it's the sum of the children of this record (aka a 'view' record)
     * @param reports 
     * @returns 
     */
    async _computeReportBalance(reports) {
        const result = {};
        const fields = ['credit', 'debit', 'balance'];
        for (const report of reports) {
            if (report.id in result) {
                continue;
            }
            result[report.id] = Object.fromEntries(fields.map(fn => [fn, 0.0]));
            if (await report.type === 'accounts') {
                // it's the sum of the linked accounts
                result[report.id]['account'] = await this._computeAccountBalance(await report.accountIds);
                for (const value of Object.values(result[report.id]['account'])) {
                    for (const field of fields) {
                        result[report.id][field] += value[field];
                    }
                }
            }
            else if (await report.type === 'accountType') {
                // it's the sum the leaf accounts with such an account type
                const accounts = await this.env.items('account.account').search(
                    [['userTypeId', 'in', (await report.accountTypeIds).ids]]);
                result[report.id]['account'] = await this._computeAccountBalance(accounts);
                for (const value of Object.values(result[report.id]['account'])) {
                    for (const field of fields) {
                        result[report.id][field] += value[field];
                    }
                }
            }
            else if (await report.type === 'accountReport' && (await report.accountReportId).ok) {
                // it's the amount of the linked report
                const result2 = await this._computeReportBalance(await report.accountReportId);
                for (const value of Object.values(result2)) {
                    for (const field of fields) {
                        result[report.id][field] += value[field];
                    }
                }
            }
            else if (await report.type === 'sum') {
                // it's the sum of the children of this account.report
                const result2 = await this._computeReportBalance(await report.childrenIds);
                for (const value of Object.values(result2)) {
                    for (const field of fields) {
                        result[report.id][field] += value[field];
                    }
                }
            }
        }
        return result;
    }

    async getAccountLines(data) {
        let lines = [];
        const accountReport = await this.env.items('account.financial.report').search(
            [['id', '=', data['accountReportId'][0]]]);
        const childReports = await accountReport._getChildrenByOrder();
        const res = await (await this.withContext(data['usedContext']))._computeReportBalance(childReports);
        if (data['enableFilter']) {
            const comparisonRes = await (await this.withContext(data['comparisonContext']))._computeReportBalance(childReports);
            for (const [reportId, value] of Object.entries(comparisonRes)) {
                res[reportId]['compBal'] = value['balance'];
                const reportAcc = res[reportId]['account'];
                if (bool(reportAcc)) {
                    for (const [accountId, val] of Object.entries(comparisonRes[reportId]['account'])) {
                        reportAcc[accountId]['compBal'] = val['balance'];
                    }
                }
            }
        }
        for (const report of childReports) {
            const vals = {
                'label': await report.label,
                'balance': res[report.id]['balance'] * parseFloat(await report.sign),
                'type': 'report',
                'level': await report.styleOverwrite && await report.styleOverwrite || await report.level,
                'accountType': await report.type || false, //used to underline the financial report balances
            }
            if (data['debitCredit']) {
                vals['debit'] = res[report.id]['debit'];
                vals['credit'] = res[report.id]['credit'];
            }

            if (data['enableFilter']) {
                vals['balanceCmp'] = res[report.id]['compBal'] * parseFloat(await report.sign);
            }

            lines.push(vals);
            if (await report.displayDetail === 'noDetail') {
                //the rest of the loop is used to display the details of the financial report, so it's not needed here.
                continue;
            }
            if (res[report.id]['account']) {
                const subLines = [];
                for (const [accountId, value] of Object.entries(res[report.id]['account'])) {
                    //if there are accounts to display, we add them to the lines with a level equals to their level in
                    //the COA + 1 (to avoid having them with a too low level that would conflicts with the level of data
                    //financial reports for Assets, liabilities...)
                    let flag = false;
                    const account = this.env.items('account.account').browse(accountId);
                    const [companyId] = await account('companyId');
                    const currencyId = await companyId.currencyId;
                    const vals = {
                        'label': await account.code + ' ' + await account.label,
                        'balance': value['balance'] * parseFloat(await report.sign) || 0.0,
                        'type': 'account',
                        'level': await report.displayDetail === 'detailWithHierarchy' && 4,
                        'accountType': await account.internalType,
                    }
                    if (data['debitCredit']) {
                        vals['debit'] = value['debit'];
                        vals['credit'] = value['credit'];
                        if (! await currencyId.isZero(vals['debit']) || ! await currencyId.isZero(vals['credit'])) {
                            flag = true;
                        }
                    }
                    if (! await currencyId.isZero(vals['balance'])) {
                        flag = true;
                    }
                    if (data['enableFilter']) {
                        vals['balanceCmp'] = value['compBal'] * parseFloat(await report.sign);
                        if (! await currencyId.isZero(vals['balanceCmp'])) {
                            flag = true;
                        }
                    }
                    if (flag) {
                        subLines.push(vals);
                    }
                }
                lines = lines.concat(sorted(subLines, (subLine) => subLine['label']));
            }
        }
        return lines;
    }

    @api.model()
    async _getReportValues(docids, data?: any) {
        if (!data['form'] || !this.env.context['activeModel'] || !this.env.context['activeId']) {
            throw new UserError(await this._t("Form content is missing, this report cannot be printed."));
        }
        const model = this.env.context['activeModel'];
        const docs = this.env.items(model).browse(this.env.context['activeId']);
        const reportLines = await this.getAccountLines(data['form']);
        return {
            'docIds': this.ids,
            'docModel': model,
            'data': data['form'],
            'docs': docs,
            'now': () => new Date(),
            'getAccountLines': reportLines,
            'fill': _.fill
        }
    }
}