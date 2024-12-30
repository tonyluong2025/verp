import { Fields } from "../../../core";
import { MetaModel, Model } from "../../../core/models"
import { dropViewIfExists, f } from "../../../core/tools";

@MetaModel.define()
class PosOrderReport extends Model {
    static _module = module;
    static _name = "report.pos.order";
    static _description = "Point of Sale Orders Report";
    static _auto = false;
    static _order = 'date desc';

    static date = Fields.Datetime({string: 'Order Date', readonly: true});
    static orderId = Fields.Many2one('pos.order', {string: 'Order', readonly: true});
    static partnerId = Fields.Many2one('res.partner', {string: 'Customer', readonly: true});
    static productId = Fields.Many2one('product.product', {string: 'Product', readonly: true});
    static productTemplateId = Fields.Many2one('product.template', {string: 'Product Template', readonly: true});
    static state = Fields.Selection(
        [['draft', 'New'], ['paid', 'Paid'], ['done', 'Posted'],
         ['invoiced', 'Invoiced'], ['cancel', 'Cancelled']],
        {string: 'Status', readonly: true});
    static userId = Fields.Many2one('res.users', {string: 'User', readonly: true});
    static priceTotal = Fields.Float({string: 'Total Price', readonly: true});
    static priceSubtotal = Fields.Float({string: 'Subtotal w/o discount', readonly: true});
    static totalDiscount = Fields.Float({string: 'Total Discount', readonly: true});
    static averagePrice = Fields.Float({string: 'Average Price', readonly: true, groupOperator: "avg"});
    static companyId = Fields.Many2one('res.company', {string: 'Company', readonly: true});
    static nbrLines = Fields.Integer({string: 'Sale Line Count', readonly: true});
    static productQty = Fields.Integer({string: 'Product Quantity', readonly: true});
    static journalId = Fields.Many2one('account.journal', {string: 'Journal', readonly: true});
    static delayValidation = Fields.Integer({string: 'Delay Validation', readonly: true});
    static productCategId = Fields.Many2one('product.category', {string: 'Product Category', readonly: true});
    static invoiced = Fields.Boolean({readonly: true});
    static configId = Fields.Many2one('pos.config', {string: 'Point of Sale', readonly: true});
    static posCategId = Fields.Many2one('pos.category', {string: 'PoS Category', readonly: true});
    static pricelistId = Fields.Many2one('product.pricelist', {string: 'Pricelist', readonly: true});
    static sessionId = Fields.Many2one('pos.session', {string: 'Session', readonly: true});
    static margin = Fields.Float({string: 'Margin', readonly: true});

    async _select() {
        return ''+
            `SELECT
                MIN(l.id) AS id,
                COUNT(*)::int AS "nbrLines",
                s."dateOrder" AS date,
                SUM(l.qty) AS "productQty",
                SUM(l.qty * l."priceUnit" / CASE COALESCE(s."currencyRate", 0) WHEN 0 THEN 1.0 ELSE s."currencyRate" END) AS "priceSubtotal",
                SUM(ROUND(((l.qty * l."priceUnit") * (100 - l.discount) / 100 / CASE COALESCE(s."currencyRate", 0) WHEN 0 THEN 1.0 ELSE s."currencyRate" END)::numeric, cu."decimalPlaces")) AS "priceTotal",
                SUM((l.qty * l."priceUnit") * (l.discount / 100) / CASE COALESCE(s."currencyRate", 0) WHEN 0 THEN 1.0 ELSE s."currencyRate" END) AS "totalDiscount",
                CASE
                    WHEN SUM(l.qty * u.factor) = 0 THEN NULL
                    ELSE (SUM(l.qty*l."priceUnit" / CASE COALESCE(s."currencyRate", 0) WHEN 0 THEN 1.0 ELSE s."currencyRate" END)/SUM(l.qty * u.factor))::decimal
                END AS "averagePrice",
                SUM(cast(to_char(date_trunc('day',s."dateOrder") - date_trunc('day',s."createdAt"),'DD') AS INT)) AS "delayValidation",
                s.id as "orderId",
                s."partnerId" AS "partnerId",
                s.state AS state,
                s."userId" AS "userId",
                s."companyId" AS "companyId",
                s."saleJournal" AS "journalId",
                l."productId" AS "productId",
                pt."categId" AS "productCategId",
                p."productTemplateId",
                ps."configId",
                pt."posCategId",
                s."pricelistId",
                s."sessionId",
                s."accountMove" IS NOT NULL AS invoiced,
                SUM(l."priceSubtotal" - COALESCE(l."totalCost",0) / CASE COALESCE(s."currencyRate", 0) WHEN 0 THEN 1.0 ELSE s."currencyRate" END) AS margin`;
    }

    async _from() {
        return ''+
            `FROM "posOrderLine" AS l
                INNER JOIN "posOrder" s ON (s.id=l."orderId")
                LEFT JOIN "productProduct" p ON (l."productId"=p.id)
                LEFT JOIN "productTemplate" pt ON (p."productTemplateId"=pt.id)
                LEFT JOIN "uomUom" u ON (u.id=pt."uomId")
                LEFT JOIN "posSession" ps ON (s."sessionId"=ps.id)
                LEFT JOIN "resCompany" co ON (s."companyId"=co.id)
                LEFT JOIN "resCurrency" cu ON (co."currencyId"=cu.id)`;
    }

    async _groupby() {
        return `GROUP BY
                s.id, s."dateOrder", s."partnerId",s.state, pt."categId",
                s."userId", s."companyId", s."saleJournal",
                s."pricelistId", s."accountMove", s."createdAt", s."sessionId",
                l."productId",
                pt."categId", pt."posCategId",
                p."productTemplateId",
                ps."configId"`;
    }

    async init() {
        await dropViewIfExists(this._cr, this.cls._table);
        await this._cr.execute(f(
            `CREATE OR REPLACE VIEW "${this.cls._table}" AS (
                %s
                %s
                %s
            )`, await this._select(), await this._from(), await this._groupby())
        );
    }
}
