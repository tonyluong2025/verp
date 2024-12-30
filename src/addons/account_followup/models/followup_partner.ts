import { Fields, api } from "../../../core";
import { MetaModel, Model } from "../../../core/models";
import { dropViewIfExists } from "../../../core/tools";

@MetaModel.define()
class FollowupStatByPartner extends Model {
    static _module = module;
    static _name = "followup.stat.by.partner";
    static _description = "Follow-up Statistics by Partner";
    static _recName = 'partnerId';
    // static _auto = false;

    async _getInvoicePartnerId() {
        for (const rec of this) {
            const partner = await rec.partnerId;
            await rec.set('invoicePartnerId', partner.addressGet(['invoice'])['invoice'] ?? partner.id);
        }
    }

    static partnerId = Fields.Many2one('res.partner', {string: 'Partner', readonly: true});
    static dateMove = Fields.Date('First move', {readonly: true});
    static dateMoveLast = Fields.Date('Last move', {readonly: true});
    static dateFollowup = Fields.Date('Latest follow-up', {readonly: true});
    static maxFollowupId = Fields.Many2one('followup.line', {string: 'Max Follow Up Level', readonly: true, ondelete: 'CASCADE'});
    static balance = Fields.Float('Balance', {readonly: true});
    static companyId = Fields.Many2one('res.company', {string: 'Company', readonly: true});
    static invoicePartnerId = Fields.Many2one('res.partner', {compute: '_getInvoicePartnerId', string: 'Invoice Address'});

    @api.model()
    async __init() {
        await dropViewIfExists(this._cr, this.cls._table);
        await this._cr.execute(`
            create view "${this.cls._table}" as (
                SELECT
                    l."partnerId" * 10000::bigint + l."companyId" as id,
                    l."partnerId" AS "partnerId",
                    min(l.date) AS "dateMove",
                    max(l.date) AS "dateMoveLast",
                    max(l."followupDate") AS "dateFollowup",
                    max(l."followupLineId") AS "maxFollowupId",
                    sum(l.debit - l.credit) AS balance,
                    l."companyId" as "companyId"
                FROM
                    "accountMoveLine" l
                    LEFT JOIN "accountAccount" a ON (l."accountId" = a.id)
                WHERE
                    a."userTypeId" IN (SELECT id FROM "accountAccountType"
                    WHERE type = 'receivable') AND
                    l."fullReconcileId" is NULL AND
                    l."partnerId" IS NOT NULL
                    GROUP BY
                    l."partnerId", l."companyId"
            )`
        );
    }
}