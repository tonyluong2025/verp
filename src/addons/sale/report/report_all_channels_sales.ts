import { Fields } from "../../../core";
import { MetaModel, Model } from "../../../core/models"
import { dropViewIfExists, f } from "../../../core/tools";

@MetaModel.define()
class PosSaleReport extends Model {
    static _module = module;
    static _name = "report.all.channels.sales";
    static _description = "Sales by Channel (All in One)";
    static _auto = false;

    static label = Fields.Char('Order Reference', {readonly: true});
    static partnerId = Fields.Many2one('res.partner', {string: 'Partner', readonly: true});
    static productId = Fields.Many2one('product.product', {string: 'Product', readonly: true});
    static productTemplateId = Fields.Many2one('product.template', {string: 'Product Template', readonly: true});
    static dateOrder = Fields.Datetime({string: 'Date Order', readonly: true});
    static userId = Fields.Many2one('res.users', {string: 'Salesperson', readonly: true});
    static categId = Fields.Many2one('product.category', {string: 'Product Category', readonly: true});
    static companyId = Fields.Many2one('res.company', {string: 'Company', readonly: true});
    static priceTotal = Fields.Float('Total', {readonly: true});
    static pricelistId = Fields.Many2one('product.pricelist', {string: 'Pricelist', readonly: true});
    static countryId = Fields.Many2one('res.country', {string: 'Partner Country', readonly: true});
    static priceSubtotal = Fields.Float({string: 'Price Subtotal', readonly: true});
    static productQty = Fields.Float('Product Quantity', {readonly: true});
    static analyticAccountId = Fields.Many2one('account.analytic.account', {string: 'Analytic Account', readonly: true});
    static teamId = Fields.Many2one('crm.team', {string: 'Sales Team', readonly: true});

    _so() {
        const soStr = `
                SELECT sol.id AS id,
                    so.label AS label,
                    so."partnerId" AS "partnerId",
                    sol."productId" AS "productId",
                    pro."productTemplateId" AS "productTemplateId",
                    so."dateOrder" AS "dateOrder",
                    so."userId" AS "userId",
                    pt."categId" AS "categId",
                    so."companyId" AS "companyId",
                    sol."priceTotal" / CASE COALESCE(so."currencyRate", 0) WHEN 0 THEN 1.0 ELSE so."currencyRate" END AS "priceTotal",
                    so."pricelistId" AS "pricelistId",
                    rp."countryId" AS "countryId",
                    sol."priceSubtotal" / CASE COALESCE(so."currencyRate", 0) WHEN 0 THEN 1.0 ELSE so."currencyRate" END AS "priceSubtotal",
                    (sol."productUomQty" / u.factor * u2.factor) as "productQty",
                    so."analyticAccountId" AS "analyticAccountId",
                    so."teamId" AS "teamId"

            FROM "saleOrderLine" sol
                    JOIN "saleOrder" so ON (sol."orderId" = so.id)
                    LEFT JOIN "productProduct" pro ON (sol."productId" = pro.id)
                    JOIN "resPartner" rp ON (so."partnerId" = rp.id)
                    LEFT JOIN "productTemplate" pt ON (pro."productTemplateId" = pt.id)
                    LEFT JOIN "productPricelist" pp ON (so."pricelistId" = pp.id)
                    LEFT JOIN "uomUom" u on (u.id=sol."productUom")
                    LEFT JOIN "uomUom" u2 on (u2.id=pt."uomId")
            WHERE so.state in ('sale','done')
        `;
        return soStr;
    }

    _from() {
        return f(`(%s)`, this._so());
    }

    _getMainRequest() {
        const request = f(`
            CREATE or REPLACE VIEW "${this.cls._table}" AS
                SELECT id AS id,
                    label,
                    "partnerId",
                    'productId',
                    "productTemplateId",
                    "dateOrder",
                    "userId",
                    "categId",
                    "companyId",
                    "priceTotal",
                    "pricelistId",
                    "analyticAccountId",
                    "countryId",
                    "teamId",
                    "priceSubtotal",
                    "productQty"
                FROM %s
                AS foo`, this._from());
        return request;
    }

    async init() {
        await dropViewIfExists(this._cr, this.cls._table);
        await this._cr.execute(this._getMainRequest());
    }
}