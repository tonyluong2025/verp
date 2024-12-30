import { Fields } from "../../../core/fields";
import { MetaModel, Model } from "../../../core/models";
import { dropViewIfExists } from "../../../core/tools/sql";

@MetaModel.define()
class ReportStockQuantity extends Model {
    static _module = module;
    static _name = 'report.stock.quantity';
    static _auto = false;
    static _description = 'Stock Quantity Report';

    static date = Fields.Date({string: 'Date', readonly: true});
    static productTemplateId = Fields.Many2one('product.template', {readonly: true});
    static productId = Fields.Many2one('product.product', {string: 'Product', readonly: true});
    static state = Fields.Selection([
        ['forecast', 'Forecasted Stock'],
        ['in', 'Forecasted Receipts'],
        ['out', 'Forecasted Deliveries'],
    ], {string: 'State', readonly: true});
    static productQty = Fields.Float({string: 'Quantity', readonly: true});
    static moveIds = Fields.One2many('stock.move', {readonly: true});
    static companyId = Fields.Many2one('res.company', {readonly: true});
    static warehouseId = Fields.Many2one('stock.warehouse', {readonly: true});

    async init() {
        await dropViewIfExists(this._cr, this.cls._table);
        const query = `
        CREATE or REPLACE VIEW "${this.cls._table}" AS (
        SELECT
            MIN(id) as id,
            "productId",
            "productTemplateId",
            state,
            date,
            sum("productQty") as "productQty",
            "companyId",
            "warehouseId"
        FROM (SELECT
                m.id,
                m."productId",
                pt.id as "productTemplateId",
                CASE
                    WHEN whs.id IS NOT NULL AND whd.id IS NULL THEN 'out'
                    WHEN whd.id IS NOT NULL AND whs.id IS NULL THEN 'in'
                END AS state,
                m.date::date AS date,
                CASE
                    WHEN whs.id IS NOT NULL AND whd.id IS NULL THEN -m."productQty"
                    WHEN whd.id IS NOT NULL AND whs.id IS NULL THEN m."productQty"
                END AS "productQty",
                m."companyId",
                CASE
                    WHEN whs.id IS NOT NULL AND whd.id IS NULL THEN whs.id
                    WHEN whd.id IS NOT NULL AND whs.id IS NULL THEN whd.id
                END AS "warehouseId"
            FROM
                "stockMove" m
            LEFT JOIN "stockLocation" ls on (ls.id=m."locationId")
            LEFT JOIN "stockLocation" ld on (ld.id=m."locationDestId")
            LEFT JOIN "stockWarehouse" whs ON ls."parentPath" like concat('%/', whs."viewLocationId", '/%')
            LEFT JOIN "stockWarehouse" whd ON ld."parentPath" like concat('%/', whd."viewLocationId", '/%')
            LEFT JOIN "productProduct" pp on pp.id=m."productId"
            LEFT JOIN "productTemplate" pt on pt.id=pp."productTemplateId"
            WHERE
                pt.type = 'product' AND
                m."productQty" != 0 AND
                (whs.id IS NOT NULL OR whd.id IS NOT NULL) AND
                (whs.id IS NULL OR whd.id IS NULL OR whs.id != whd.id) AND
                m.state NOT IN ('cancel', 'draft', 'done')
            UNION ALL
            SELECT
                -q.id as id,
                q."productId",
                pp."productTemplateId",
                'forecast' as state,
                date.*::date,
                q.quantity as "productQty",
                q."companyId",
                wh.id as "warehouseId"
            FROM
                GENERATE_SERIES((now() at time zone 'utc')::date - interval '3month',
                (now() at time zone 'utc')::date + interval '3 month', '1 day'::interval) date,
                "stockQuant" q
            LEFT JOIN "stockLocation" l on (l.id=q."locationId")
            LEFT JOIN "stockWarehouse" wh ON l."parentPath" like concat('%/', wh."viewLocationId", '/%')
            LEFT JOIN "productProduct" pp on pp.id=q."productId"
            WHERE
                (l.usage = 'internal' AND wh.id IS NOT NULL) OR
                l.usage = 'transit'
            UNION ALL
            SELECT
                m.id,
                m."productId",
                pt.id as "productTemplateId",
                'forecast' as state,
                GENERATE_SERIES(
                CASE
                    WHEN m.state = 'done' THEN (now() at time zone 'utc')::date - interval '3month'
                    ELSE m.date::date
                END,
                CASE
                    WHEN m.state != 'done' THEN (now() at time zone 'utc')::date + interval '3 month'
                    ELSE m.date::date - interval '1 day'
                END, '1 day'::interval)::date date,
                CASE
                    WHEN whs.id IS NOT NULL AND whd.id IS NULL AND m.state = 'done' THEN m."productQty"
                    WHEN whd.id IS NOT NULL AND whs.id IS NULL AND m.state = 'done' THEN -m."productQty"
                    WHEN whs.id IS NOT NULL AND whd.id IS NULL THEN -m."productQty"
                    WHEN whd.id IS NOT NULL AND whs.id IS NULL THEN m."productQty"
                END AS "productQty",
                m."companyId",
                CASE
                    WHEN whs.id IS NOT NULL AND whd.id IS NULL THEN whs.id
                    WHEN whd.id IS NOT NULL AND whs.id IS NULL THEN whd.id
                END AS "warehouseId"
            FROM
                "stockMove" m
            LEFT JOIN "stockLocation" ls on (ls.id=m."locationId")
            LEFT JOIN "stockLocation" ld on (ld.id=m."locationDestId")
            LEFT JOIN "stockWarehouse" whs ON ls."parentPath" like concat('%/', whs."viewLocationId", '/%')
            LEFT JOIN "stockWarehouse" whd ON ld."parentPath" like concat('%/', whd."viewLocationId", '/%')
            LEFT JOIN "productProduct" pp on pp.id=m."productId"
            LEFT JOIN "productTemplate" pt on pt.id=pp."productTemplateId"
            WHERE
                pt.type = 'product' AND
                m."productQty" != 0 AND
                (whs.id IS NOT NULL OR whd.id IS NOT NULL) AND
                (whs.id IS NULL or whd.id IS NULL OR whs.id != whd.id) AND
                m.state NOT IN ('cancel', 'draft')) as "forecastQty"
        GROUP BY "productId", "productTemplateId", state, date, "companyId", "warehouseId"
        );
        `;
        await this.env.cr.execute(query);
    }
}