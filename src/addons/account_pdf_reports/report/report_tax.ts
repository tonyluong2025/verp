import { api } from "../../../core";
import { UserError } from "../../../core/helper/errors";
import { AbstractModel, MetaModel } from "../../../core/models";
import { _convert$, f } from "../../../core/tools";

@MetaModel.define()
class ReportTax extends AbstractModel {
    static _module = module;
    static _name = 'report.accounting.tax';
    static _description = 'Tax Report';

    @api.model()
    async _getReportValues(docids, data?: any) {
        if (! data['form']) {
            throw new UserError(await this._t("Form content is missing, this report cannot be printed."));
        }
        return {
            'data': data['form'],
            'lines': await this.getLines(data['form']),
        }
    }

    _sqlFromAmlsOne() {
        const sql = `SELECT "accountMoveLine"."taxLineId" as id, COALESCE(SUM("accountMoveLine".debit-"accountMoveLine".credit), 0) as balance
                    FROM %s
                    WHERE %s GROUP BY "accountMoveLine"."taxLineId"`;
        return sql;
    }

    _sqlFromAmlsTwo() {
        const sql = `SELECT r."accountTaxId" as id, COALESCE(SUM("accountMoveLine".debit-"accountMoveLine".credit), 0) as balance
                 FROM %s
                 INNER JOIN "accountMoveLineAccountTaxRel" r ON ("accountMoveLine".id = r."accountMoveLineId")
                 INNER JOIN "accountTax" t ON (r."accountTaxId" = t.id)
                 WHERE %s GROUP BY r."accountTaxId"`;
        return sql;
    }

    async _computeFromAmls(options, taxes) {
        //compute the tax amount
        const sql = this._sqlFromAmlsOne();
        const [tables, whereClause, whereParams] = await this.env.items('account.move.line')._queryGet();
        let query = f(sql, tables, whereClause);
        let res = await this.env.cr.execute(_convert$(query), {bind: whereParams});
        for (const row of res) {
            if (res['id'] in taxes) {
                taxes[res['id']]['tax'] = Math.abs(row['balance']);
            }
        }

        //compute the net amount
        const sql2 = this._sqlFromAmlsTwo();
        query = f(sql2, tables, whereClause);
        res = await this.env.cr.execute(_convert$(query), {bind: whereParams});
        for (const row of res) {
            if (row['id'] in taxes) {
                taxes[row['id']]['net'] = Math.abs(row['balance']);
            }
        }
    }

    @api.model()
    async getLines(options) {
        const taxes = {}
        for (const tax of await this.env.items('account.tax').search([['typeTaxUse', '!=', 'none']])) {
            const childrenTaxIds = await tax.childrenTaxIds;
            if (childrenTaxIds.ok) {
                for (const child of childrenTaxIds) {
                    if (await child.typeTaxUse != 'none') {
                        continue;
                    }
                    taxes[child.id] = {'tax': 0, 'net': 0, 'label': await child.label, 'type': await tax.typeTaxUse}
                }
            }
            else {
                taxes[tax.id] = {'tax': 0, 'net': 0, 'label': await tax.label, 'type': await tax.typeTaxUse}
            }
        }
        await (await this.withContext({dateFrom: options['dateFrom'], dateTo: options['dateTo'],
                          state: options['targetMove'],
                          strictRange: true}))._computeFromAmls(options, taxes);
        const groups = Object.fromEntries(['sale', 'purchase'].map(tp => [tp, []]));
        for (const tax of Object.values(taxes)) {
            if (tax['tax']) {
                groups[tax['type']].push(tax);
            }
        }
        return groups;
    }
}