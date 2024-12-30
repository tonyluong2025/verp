import { api, Fields } from "../../../core";
import { AbstractModel } from "../../../core/models";
import { MetaModel, Model } from "../../../core/models"
import { bool, dropViewIfExists, f } from "../../../core/tools";

@MetaModel.define()
class SaleReport extends Model {
    static _module = module;
    static _name = "sale.report";
    static _description = "Sales Analysis Report";
    static _auto = false;
    static _recName = 'date';
    static _order = 'date desc';

    @api.model()
    _getDoneStates() {
        return ['sale', 'done', 'paid']
    }

    static label = Fields.Char('Order Reference', {readonly: true});
    static date = Fields.Datetime('Order Date', {readonly: true});
    static productId = Fields.Many2one('product.product', {string: 'Product Variant', readonly: true});
    static productUom = Fields.Many2one('uom.uom', {string: 'Unit of Measure', readonly: true});
    static productUomQty = Fields.Float('Qty Ordered', {readonly: true});
    static qtyToDeliver = Fields.Float('Qty To Deliver', {readonly: true});
    static qtyDelivered = Fields.Float('Qty Delivered', {readonly: true});
    static qtyToInvoice = Fields.Float('Qty To Invoice', {readonly: true})
    static qtyInvoiced = Fields.Float('Qty Invoiced', {readonly: true});
    static partnerId = Fields.Many2one('res.partner', {string: 'Customer', readonly: true});
    static companyId = Fields.Many2one('res.company', {string: 'Company', readonly: true});
    static userId = Fields.Many2one('res.users', {string: 'Salesperson', readonly: true});
    static priceTotal = Fields.Float('Total', {readonly: true});
    static priceSubtotal = Fields.Float('Untaxed Total', {readonly: true});
    static untaxedAmountToInvoice = Fields.Float('Untaxed Amount To Invoice', {readonly: true});
    static untaxedAmountInvoiced = Fields.Float('Untaxed Amount Invoiced', {readonly: true});
    static productTemplateId = Fields.Many2one('product.template', {string: 'Product', readonly: true});
    static categId = Fields.Many2one('product.category', {string: 'Product Category', readonly: true});
    static nbr = Fields.Integer('# of Lines', {readonly: true});
    static pricelistId = Fields.Many2one('product.pricelist', {string: 'Pricelist', readonly: true});
    static analyticAccountId = Fields.Many2one('account.analytic.account', {string: 'Analytic Account', readonly: true});
    static teamId = Fields.Many2one('crm.team', {string: 'Sales Team', readonly: true});
    static countryId = Fields.Many2one('res.country', {string: 'Customer Country', readonly: true});
    static industryId = Fields.Many2one('res.partner.industry', {string: 'Customer Industry', readonly: true});
    static commercialPartnerId = Fields.Many2one('res.partner', {string: 'Customer Entity', readonly: true});
    static state = Fields.Selection([
        ['draft', 'Draft Quotation'],
        ['sent', 'Quotation Sent'],
        ['sale', 'Sales Order'],
        ['done', 'Sales Done'],
        ['cancel', 'Cancelled'],
        ], {string: 'Status', readonly: true});
    static weight = Fields.Float('Gross Weight', {readonly: true});
    static volume = Fields.Float('Volume', {readonly: true});

    static discount = Fields.Float('Discount %', {readonly: true});
    static discountAmount = Fields.Float('Discount Amount', {readonly: true});
    static campaignId = Fields.Many2one('utm.campaign', {string: 'Campaign'});
    static mediumId = Fields.Many2one('utm.medium', {string: 'Medium'});
    static sourceId = Fields.Many2one('utm.source', {string: 'Source'});

    static orderId = Fields.Many2one('sale.order', {string: 'Order #', readonly: true});

    _selectSale(fields?: any) {
        if (! bool(fields)) {
            fields = {}
        }
        let select = `
            min(l.id) as id,
            l."productId" as "productId",
            t."uomId" as "productUom",
            CASE WHEN l."productId" IS NOT NULL THEN sum(l."productUomQty" / u.factor * u2.factor) ELSE 0 END as "productUomQty",
            CASE WHEN l."productId" IS NOT NULL THEN sum(l."qtyDelivered" / u.factor * u2.factor) ELSE 0 END as "qtyDelivered",
            CASE WHEN l."productId" IS NOT NULL THEN SUM((l."productUomQty" - l."qtyDelivered") / u.factor * u2.factor) ELSE 0 END as "qtyToDeliver",
            CASE WHEN l."productId" IS NOT NULL THEN sum(l."qtyInvoiced" / u.factor * u2.factor) ELSE 0 END as "qtyInvoiced",
            CASE WHEN l."productId" IS NOT NULL THEN sum(l."qtyToInvoice" / u.factor * u2.factor) ELSE 0 END as "qtyToInvoice",
            CASE WHEN l."productId" IS NOT NULL THEN sum(l."priceTotal" / CASE COALESCE(s."currencyRate", 0) WHEN 0 THEN 1.0 ELSE s."currencyRate" END) ELSE 0 END as "priceTotal",
            CASE WHEN l."productId" IS NOT NULL THEN sum(l."priceSubtotal" / CASE COALESCE(s."currencyRate", 0) WHEN 0 THEN 1.0 ELSE s."currencyRate" END) ELSE 0 END as "priceSubtotal",
            CASE WHEN l."productId" IS NOT NULL THEN sum(l."untaxedAmountToInvoice" / CASE COALESCE(s."currencyRate", 0) WHEN 0 THEN 1.0 ELSE s."currencyRate" END) ELSE 0 END as "untaxedAmountToInvoice",
            CASE WHEN l."productId" IS NOT NULL THEN sum(l."untaxedAmountInvoiced" / CASE COALESCE(s."currencyRate", 0) WHEN 0 THEN 1.0 ELSE s."currencyRate" END) ELSE 0 END as "untaxedAmountInvoiced",
            COUNT(*)::int as nbr,
            s.label as label,
            s."dateOrder" as date,
            s.state as state,
            s."partnerId" as "partnerId",
            s."userId" as "userId",
            s."companyId" as "companyId",
            s."campaignId" as "campaignId",
            s."mediumId" as "mediumId",
            s."sourceId" as "sourceId",
            extract(epoch from avg(date_trunc('day',s."dateOrder")-date_trunc('day',s."createdAt")))/(24*60*60)::decimal(16,2) as delay,
            t."categId" as "categId",
            s."pricelistId" as "pricelistId",
            s."analyticAccountId" as "analyticAccountId",
            s."teamId" as "teamId",
            p."productTemplateId",
            partner."countryId" as "countryId",
            partner."industryId" as "industryId",
            partner."commercialPartnerId" as "commercialPartnerId",
            CASE WHEN l."productId" IS NOT NULL THEN sum(p.weight * l."productUomQty" / u.factor * u2.factor) ELSE 0 END as weight,
            CASE WHEN l."productId" IS NOT NULL THEN sum(p.volume * l."productUomQty" / u.factor * u2.factor) ELSE 0 END as volume,
            l.discount as discount,
            CASE WHEN l."productId" IS NOT NULL THEN sum((l."priceUnit" * l."productUomQty" * l.discount / 100.0 / CASE COALESCE(s."currencyRate", 0) WHEN 0 THEN 1.0 ELSE s."currencyRate" END))ELSE 0 END as "discountAmount",
            s.id as "orderId"
        `;

        for (const field of Object.values(fields)) {
            select += field;
        }
        return select;
    }

    _fromSale(fromClause='') {
        const from = f(`
                "saleOrderLine" l
                      left join "saleOrder" s on (s.id=l."orderId")
                      join "resPartner" partner on s."partnerId" = partner.id
                        left join "productProduct" p on (l."productId"=p.id)
                            left join "productTemplate" t on (p."productTemplateId"=t.id)
                    left join "uomUom" u on (u.id=l."productUom")
                    left join "uomUom" u2 on (u2.id=t."uomId")
                    left join "productPricelist" pp on (s."pricelistId" = pp.id)
                %s
        `, fromClause);
        return from;
    }

    _groupbySale(groupby='') {
        groupby = f(`
            l."productId",
            l."orderId",
            t."uomId",
            t."categId",
            s.label,
            s."dateOrder",
            s."partnerId",
            s."userId",
            s.state,
            s."companyId",
            s."campaignId",
            s."mediumId",
            s."sourceId",
            s."pricelistId",
            s."analyticAccountId",
            s."teamId",
            p."productTemplateId",
            partner."countryId",
            partner."industryId",
            partner."commercialPartnerId",
            l.discount,
            s.id %s
        `, groupby);
        return groupby;
    }

    /**
     * Hook to return additional fields SQL specification for select part of the table query.

        :param dict fields: additional fields info provided by _query overrides (old API), prefer overriding
            _selectAdditionalFields instead.
        :returns: mapping field -> SQL computation of the field
        :rtype: dict
     * @param fields 
     * @returns 
     */
    _selectAdditionalFields(fields) {
        return fields;
    }

    _query(withClause='', fields?: any, groupby='', fromClause='') {
        if (! bool(fields)) {
            fields = {}
        }
        const saleReportFields = this._selectAdditionalFields(fields);
        const with_ = withClause ? f("WITH %s", withClause) : "";
        return f('%s (SELECT %s FROM %s WHERE l."displayType" IS NULL GROUP BY %s)',
               with_, this._selectSale(saleReportFields), this._fromSale(fromClause), this._groupbySale(groupby));
    }

    async init() {
        await dropViewIfExists(this._cr, this.cls._table);
        await this._cr.execute(`CREATE or REPLACE VIEW "${this.cls._table}" as (%s)`, [this._query()]);
    }
}

@MetaModel.define()
class SaleOrderReportProforma extends AbstractModel {
    static _module = module;
    static _name = 'report.sale.proforma';//'report.sale.report_saleproforma';
    static _description = 'Proforma Report';

    @api.model()
    async _getReportValues(docids, data?: any) {
        const docs = this.env.items('sale.order').browse(docids);
        return {
            'docIds': docs.ids,
            'docModel': 'sale.order',
            'docs': docs,
            'proforma': true
        }
    }
}