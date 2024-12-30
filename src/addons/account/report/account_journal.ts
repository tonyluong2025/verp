import { DateTime } from "luxon";
import { api } from "../../../core";
import { UserError } from "../../../core/helper";
import { AbstractModel, MetaModel } from "../../../core/models";
import { parseFloat, quoteList, toFormat } from "../../../core/tools";

@MetaModel.define()
class ReportJournal extends AbstractModel {
  static _module = module;
  static _name = 'report.account.journal';
  static _description = 'Account Journal Report';

  async lines(targetMove, journalIds, sortSelection, data) {
    if (Number.isInteger(journalIds)) {
      journalIds = [journalIds];
    }

    let moveState = ['draft', 'posted'];
    if (targetMove === 'posted') {
      moveState = ['posted'];
    }

    const queryGetClause = await this._getQueryGetClause(data);
    const params = [quoteList(moveState), String(journalIds)].concat(queryGetClause[2]);
    let query = 'SELECT "accountMoveLine".id FROM ' + queryGetClause[0] + ', "accountMove" am, "accountAccount" acc WHERE "accountMoveLine"."accountId" = acc.id AND "accountMoveLine"."moveId"=am.id AND am.state IN (%s) AND "accountMoveLine"."journalId" IN (%s) AND ' + queryGetClause[1] + ' ORDER BY '
    if (sortSelection === 'date') {
      query += '"accountMoveLine".date';
    }
    else {
      query += 'am.label';
    }
    query += ', "accountMoveLine"."moveId", acc.code';
    const res = await this.env.cr.execute(query, params);
    const ids = res.map(x => x['id]']);
    return this.env.items('account.move.line').browse(ids);
  }

  async _sumDebit(data, journalId) {
    let moveState = ['draft', 'posted'];
    if ((data['form']['targetMove'] || 'all') === 'posted') {
      moveState = ['posted'];
    }

    const queryGetClause = await this._getQueryGetClause(data);
    const params = [quoteList(moveState), String(journalId.ids)].concat(queryGetClause[2]);
    const res = await this.env.cr.execute(`SELECT SUM(debit) As debit FROM ' + queryGetClause[0] + ', "accountMove" am 
                        WHERE "accountMoveLine"."moveId"=am.id AND am.state IN (%s) AND "accountMoveLine"."journalId" IN (%s) AND ` + queryGetClause[1] + ' ',
      params);
    return res[0]['debit'] || 0.0;
  }

  async _sumCredit(data, journalId) {
    let moveState = ['draft', 'posted'];
    if ((data['form']['targetMove'] || 'all') === 'posted') {
      moveState = ['posted'];
    }

    const queryGetClause = await this._getQueryGetClause(data);
    const params = [quoteList(moveState), String(journalId.ids)].concat(queryGetClause[2]);
    const res = await this.env.cr.execute(`SELECT SUM(credit) AS credit FROM ` + queryGetClause[0] + `, "accountMove" am 
                        WHERE "accountMoveLine"."moveId"=am.id AND am.state IN (%s) AND "accountMoveLine"."journalId" IN (%s) AND ` + queryGetClause[1] + ' ',
      params);
    return parseFloat(res[0]['credit']);
  }

  async _getTaxes(data, journalId) {
    let moveState = ['draft', 'posted'];
    if ((data['form']['targetMove'] || 'all') === 'posted') {
      moveState = ['posted'];
    }

    const queryGetClause = await this._getQueryGetClause(data);
    const params = [quoteList(moveState), String(journalId.ids)].concat(queryGetClause[2]);
    const query = `
            SELECT rel."accountTaxId" AS id, SUM("accountMoveLine".balance) AS "baseAmount"
            FROM "accountMoveLineAccountTaxRel" rel, ` + queryGetClause[0] + ` 
            LEFT JOIN "accountMove" am ON "accountMoveLine"."moveId" = am.id
            WHERE "accountMoveLine".id = rel."accountMoveLineId"
                AND am.state IN (%s)
                AND "accountMoveLine"."journalId" IN (%s)
                AND ` + queryGetClause[1] + `
           GROUP BY rel."accountTaxId"`;
    let res = await this.env.cr.execute(query, params);
    const ids = [];
    const baseAmounts = {}
    for (const row of res) {
      ids.push(row['id']);
      baseAmounts[row['id']] = row['baseAmount'];
    }

    const result = new Map();
    for (const tax of this.env.items('account.tax').browse(ids)) {
      res = await this.env.cr.execute('SELECT sum(debit - credit) AS balance FROM ' + queryGetClause[0] + `, "accountMove" am 
                WHERE "accountMoveLine"."moveId"=am.id AND am.state IN (%s) AND "accountMoveLine"."journalId" IN (%s) AND ` + queryGetClause[1] + ' AND "taxLineId" = %s',
        params.concat([tax.id]))
      result.set(tax, {
        'baseAmount': baseAmounts[tax.id],
        'taxAmount': res[0]['balance'] || 0.0,
      });
      if (await journalId.type === 'sale') {
        //sales operation are credits
        const _tax = result.get(tax);
        _tax['baseAmount'] = _tax['baseAmount'] * -1;
        _tax['taxAmount'] = _tax['taxAmount'] * -1;
      }
    }
    return result;
  }

  async _getQueryGetClause(data) {
    return (await this.env.items('account.move.line').withContext(data['form']['usedContext'] ?? {}))._queryGet();
  }

  @api.model()
  async _getReportValues(docIds, data?: any) {
    if (!data['form']) {
      throw new UserError(await this._t("Form content is missing, this report cannot be printed."));
    }
    const targetMove = data['form']['targetMove'] || 'all';
    const sortSelection = data['form']['sortSelection'] || 'date';

    const res = {};
    for (const journal of data['form']['journalIds']) {
      res[journal] = await (await this.withContext(data['form']['usedContext'] ?? {})).lines(targetMove, journal, sortSelection, data);
    }
    return {
      'docIds': data['form']['journalIds'],
      'docModel': this.env.items('account.journal'),
      'data': data,
      'docs': this.env.items('account.journal').browse(data['form']['journalIds']),
      'now': () => new Date(),
      'lines': res,
      'sumCredit': this._sumCredit,
      'sumDebit': this._sumDebit,
      'getTaxes': this._getTaxes,
      'companyId': this.env.items('res.company').browse(data['form']['companyId'][0]),
    }
  }
}