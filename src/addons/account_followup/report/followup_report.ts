import { Fields, api } from "../../../core";
import { MetaModel, Model } from "../../../core/models"
import { dropViewIfExists } from "../../../core/tools";

@MetaModel.define()
class AccountFollowupStat extends Model {
    static _module = module;
    static _name = "report.account.followup.stat";
    static _description = "Follow-up Statistics";
    static _recName = 'partnerId';
    static _order = 'dateMove';
    static _auto = false;

    static partnerId = Fields.Many2one('res.partner', {string: 'Partner', readonly: true});
    static dateMove = Fields.Date('First move', {readonly: true});
    static dateMoveLast = Fields.Date('Last move', {readonly: true});
    static dateFollowup = Fields.Date('Latest followup', {readonly: true});
    static followupId = Fields.Many2one('followup.line', {string: 'Follow Ups', readonly: true, ondelete: 'CASCADE'});
    static balance = Fields.Float('Balance', {readonly: true});
    static debit = Fields.Float('Debit', {readonly: true});
    static credit = Fields.Float('Credit', {readonly: true});
    static companyId = Fields.Many2one('res.company', {string: 'Company', readonly: true});
    static blocked = Fields.Boolean('Blocked', {readonly: true});

    @api.model()
    async init() {
        await dropViewIfExists(this._cr, this.cls._table);
        await this._cr.execute(`
            create or replace view "${this.cls._table}" as (
                SELECT
                    l.id as id,
                    l."partnerId" AS "partnerId",
                    min(l.date) AS "dateMove",
                    max(l.date) AS "dateMoveLast",
                    max(l."followupDate") AS "dateFollowup",
                    max(l."followupLineId") AS "followupId",
                    sum(l.debit) AS debit,
                    sum(l.credit) AS credit,
                    sum(l.debit - l.credit) AS balance,
                    l."companyId" AS "companyId",
                    l.blocked as blocked
                FROM
                    "accountMoveLine" l
                    LEFT JOIN "accountAccount" a ON (l."accountId" = a.id)
                WHERE
                    a."userTypeId" IN (SELECT id FROM "accountAccountType"
                    WHERE type = 'receivable') AND
                    l."fullReconcileId" is NULL AND
                    l."partnerId" IS NOT NULL
                GROUP BY
                    l.id, l."partnerId", l."companyId", l.blocked
            )`);
    }
}