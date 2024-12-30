import { Fields } from "../../../core";
import { MetaModel, Model } from "../../../core/models"
import { dropViewIfExists, f } from "../../../core/tools";

/**
 * CRM Lead Analysis
 */
@MetaModel.define()
class ActivityReport extends Model {
    static _module = module;
    static _name = "crm.activity.report";
    static _auto = false;
    static _description = "CRM Activity Analysis";
    static _recName = 'id';

    static date = Fields.Datetime('Completion Date', {readonly: true});
    static leadCreatedAt = Fields.Datetime('Creation Date', {readonly: true});
    static dateConversion = Fields.Datetime('Conversion Date', {readonly: true});
    static dateDeadline = Fields.Date('Expected Closing', {readonly: true});
    static dateClosed = Fields.Datetime('Closed Date', {readonly: true});
    static authorId = Fields.Many2one('res.partner', {string: 'Assigned To', readonly: true});
    static userId = Fields.Many2one('res.users', {string: 'Salesperson', readonly: true});
    static teamId = Fields.Many2one('crm.team', {string: 'Sales Team', readonly: true});
    static leadId = Fields.Many2one('crm.lead', {string: "Opportunity", readonly: true});
    static body = Fields.Html('Activity Description', {readonly: true});
    static subtypeId = Fields.Many2one('mail.message.subtype', {string: 'Subtype', readonly: true});
    static mailActivityTypeId = Fields.Many2one('mail.activity.type', {string: 'Activity Type', readonly: true});
    static countryId = Fields.Many2one('res.country', {string: 'Country', readonly: true});
    static companyId = Fields.Many2one('res.company', {string: 'Company', readonly: true});
    static stageId = Fields.Many2one('crm.stage', {string: 'Stage', readonly: true});
    static partnerId = Fields.Many2one('res.partner', {string: 'Customer', readonly: true});
    static leadType = Fields.Selection(
        {string: 'Type',
        selection: [['lead', 'Lead'], ['opportunity', 'Opportunity']],
        help: "Type is used to separate Leads and Opportunities"});
    static active = Fields.Boolean('Active', {readonly: true});

    async _select() {
        return `
            SELECT
                m.id,
                l."createdAt" AS "leadCreatedAt",
                l."dateConversion",
                l."dateDeadline",
                l."dateClosed",
                m."subtypeId",
                m."mailActivityTypeId",
                m."authorId",
                m.date,
                m.body,
                l.id as "leadId",
                l."userId",
                l."teamId",
                l."countryId",
                l."companyId",
                l."stageId",
                l."partnerId",
                l.type as "leadType",
                l.active
        `;
    }

    async _from() {
        return `FROM "mailMessage" AS m`;
    }

    async _join() {
        return `JOIN "crmLead" AS l ON m."resId" = l.id`;
    }

    async _where() {
        const disccusionSubtype = await this.env.ref('mail.mtComment');
        return f(`WHERE m.model = 'crm.lead' AND (m."mailActivityTypeId" IS NOT NULL OR m."subtypeId" = %s)`, disccusionSubtype.id);
    }

    async init() {
        await dropViewIfExists(this._cr, this.cls._table);
        await this._cr.execute(f(`
            CREATE OR REPLACE VIEW "${this.cls._table}" AS (
                %s
                %s
                %s
                %s
            )
        `, await this._select(), await this._from(), await this._join(), await this._where())
        );
    }
}
