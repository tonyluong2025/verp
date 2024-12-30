import { DateTime } from "luxon";
import { Fields, _Date, api, registry } from "../../../core";
import { DefaultDict2, Dict, FrozenDict } from "../../../core/helper/collections";
import { RedirectWarning, UserError, ValidationError } from "../../../core/helper/errors";
import { MetaModel, Model, _super } from "../../../core/models";
import { expression } from "../../../core/osv";
import { bool, isInstance } from "../../../core/tools";
import { combine } from "../../../core/tools/date_utils";
import { floatCompare } from "../../../core/tools/float_utils";
import { extend, len, splitEvery } from "../../../core/tools/iterable";
import { stringify } from "../../../core/tools/json";
import { setOptions } from "../../../core/tools/misc";
import { f } from "../../../core/tools/utils";
import { ProcurementException } from "./stock_rule";

/**
 * Defines Minimum stock rules.
 */
@MetaModel.define()
class StockWarehouseOrderpoint extends Model {
    static _module = module;
    static _name = "stock.warehouse.orderpoint";
    static _description = "Minimum Inventory Rule";
    static _checkCompanyAuto = true;
    static _order = "locationId,companyId,id";

    @api.model()
    async defaultGet(fields) {
        const res = await _super(StockWarehouseOrderpoint, this).defaultGet(fields);
        let warehouse;// = None
        if (!('warehouseId' in res) && res.get('companyId')) {
            warehouse = await this.env.items('stock.warehouse').search([['companyId', '=', res['companyId']]], {limit: 1});
        }
        if (bool(warehouse)) {
            res['warehouseId'] = warehouse.id;
            res['locationId'] = (await warehouse.lotStockId).id;
        }
        return res;
    }

    @api.model()
    async _domainProductId() {
        let domain = "['type', '=', 'product']";
        if (this.env.context['activeModel'] === 'product.template') {
            const productTemplateId = this.env.context['activeId'] ?? false;
            domain = `['productTemplateId', '=', ${productTemplateId}]`;
        }
        else if (this.env.context['default_productId'] ?? false) {
            const productId = this.env.context['default_productId'] ?? false;
            domain = `['id', '=', ${productId}]`;
        }
        return `[${domain}, '|', ['companyId', '=', false], ['companyId', '=', companyId]]`;
    }

    static label = Fields.Char(
        'Name', {copy: false, required: true, readonly: true,
        default: self => self.env.items('ir.sequence').nextByCode('stock.orderpoint')});
    static trigger = Fields.Selection([
        ['auto', 'Auto'], ['manual', 'Manual']], {string: 'Trigger', default: 'auto', required: true});
    static active = Fields.Boolean(
        'Active', {default: true,
        help: "If the active field is set to false, it will allow you to hide the orderpoint without removing it."});
    static snoozedUntil = Fields.Date('Snoozed', {help: "Hidden until next scheduler."});
    static warehouseId = Fields.Many2one(
        'stock.warehouse', {string: 'Warehouse',
        checkCompany: true, ondelete: "CASCADE", required: true});
    static locationId = Fields.Many2one(
        'stock.location', {string: 'Location', index: true,
        ondelete: "CASCADE", required: true, checkCompany: true});
    static productTemplateId = Fields.Many2one('product.template', {related: 'productId.productTemplateId'});
    static productId = Fields.Many2one(
        'product.product', {string: 'Product', index: true,
        domain: (self) => self._domainProductId(),
        ondelete: 'CASCADE', required: true, checkCompany: true});
    static productCategoryId = Fields.Many2one('product.category', {string: 'Product Category', related: 'productId.categId', store: true});
    static productUom = Fields.Many2one(
        'uom.uom', {string: 'Unit of Measure', related: 'productId.uomId'})
    static productUomName = Fields.Char({string: 'Product unit of measure label', related: 'productUom.displayName', readonly: true});
    static productMinQty = Fields.Float(
        'Min Quantity', {digits: 'Product Unit of Measure', required: true, default: 0.0,
        help: "When the virtual stock equals to or goes below the Min Quantity specified for this field, Verp generates a procurement to bring the forecasted quantity to the Max Quantity."});
    static productMaxQty = Fields.Float(
        'Max Quantity', {digits: 'Product Unit of Measure', required: true, default: 0.0,
        help: "When the virtual stock goes below the Min Quantity, Verp generates a procurement to bring the forecasted quantity to the Quantity specified as Max Quantity."});
    static qtyMultiple = Fields.Float(
        'Multiple Quantity', {digits: 'Product Unit of Measure',
        default: 1, required: true,
        help: "The procurement quantity will be rounded up to this multiple.  If it is 0, the exact quantity will be used."});
    static groupId = Fields.Many2one(
        'procurement.group', {string: 'Procurement Group', copy: false,
        help: "Moves created through this orderpoint will be put in this procurement group. If none is given, the moves generated by stock rules will be grouped into one big picking."});
    static companyId = Fields.Many2one(
        'res.company', {string: 'Company', required: true, index: true,
        default: self => self.env.company()});
    static allowedLocationIds = Fields.One2many('stock.location', {compute: '_computeAllowedLocationIds'});

    static ruleIds = Fields.Many2many('stock.rule', {string: 'Rules used', compute: '_computeRules'});
    static leadDaysDate = Fields.Date({compute: '_computeLeadDays'});
    static routeId = Fields.Many2one(
        'stock.location.route', {string: 'Preferred Route', domain: "[['productSelectable', '=', true]]"});
    static qtyOnHand = Fields.Float('On Hand', {readonly: true, compute: '_computeQty'});
    static qtyForecast = Fields.Float('Forecast', {readonly: true, compute: '_computeQty'});
    static qtyToOrder = Fields.Float('To Order', {compute: '_computeQtyToOrder', store: true, readonly: false});

    static _sqlConstraints = [
        ['qty_multiple_check', 'CHECK( "qtyMultiple" >= 0 )', 'Qty Multiple must be greater than or equal to zero.'],
        ['product_location_check', 'unique ("productId", "locationId", "companyId")', 'The combination of product and location must be unique.'],
    ];

    @api.depends('warehouseId')
    async _computeAllowedLocationIds() {
        let locDomain = [['usage', 'in', ['internal', 'view']]];
        // We want to keep only the locations
        //  - strictly belonging to our warehouse
        //  - not belonging to any warehouses
        for (const orderpoint of this) {
            const otherWarehouses = await this.env.items('stock.warehouse').search([['id', '!=', (await orderpoint.warehouseId).id]]);
            for (const viewLocationId of await otherWarehouses.mapped('viewLocationId')) {
                locDomain = expression.AND([locDomain, ['!', ['id', 'childOf', viewLocationId.id]]]);
                locDomain = expression.AND([locDomain, ['|', ['companyId', '=', false], ['companyId', '=', (await orderpoint.companyId).id]]]);
            }
            await orderpoint.set('allowedLocationIds', await this.env.items('stock.location').search(locDomain));
        }
    }

    @api.depends('ruleIds', 'productId.sellerIds', 'productId.sellerIds.delay')
    async _computeLeadDays() {
        for (const orderpoint of await this.withContext({bypassDelayDescription: true})) {
                const productId = await orderpoint.productId;
            if (!bool(productId) || !bool(await orderpoint.locationId)) {
                await orderpoint.set('leadDaysDate', false);
                continue;
            }
            const values = await orderpoint._getLeadDaysValues();
            const [leadDays, dummy] = await (await orderpoint.ruleIds)._getLeadDays(productId, ...values);
            const leadDaysDate = DateTime.fromJSDate(_Date.today()).plus({days: leadDays}).toJSDate();
            await orderpoint.set('leadDaysDate', leadDaysDate);
        }
    }

    @api.depends('routeId', 'productId', 'locationId', 'companyId', 'warehouseId', 'productId.routeIds')
    async _computeRules() {
        for (const orderpoint of this) {
                const [productId, locationId, routeId] = await orderpoint('productId', 'locationId', 'routeId');
            if (! bool(productId) || !bool(locationId)) {
                await orderpoint.set('ruleIds', false);
                continue;
            }
            await orderpoint.set('ruleIds', await productId._getRulesFromLocation(locationId, routeId));
        }
    }

    /**
     * Check if the UoM has the same category as the product standard UoM
     */
    @api.constrains('productId')
    async _checkProductUom() {
        for (const orderpoint of this) {
                if (!(await (await (await orderpoint.productId).uomId).categoryId).eq(await (await orderpoint.productUom).categoryId)) {
                        throw new ValidationError(await this._t('You have to select a product unit of measure that is in the same category as the default unit of measure of the product'));
                }
        }
    }

    @api.onchange('locationId')
    async _onchangeLocationId() {
        const warehouse = (await (await this['locationId']).warehouseId).id;
        if (bool(warehouse)) {
            await this.set('warehouseId', warehouse);
        }
    }

    /**
     * Finds location id for changed warehouse.
     */
    @api.onchange('warehouseId')
    async _onchangeWarehouseId() {
        const warehouseId = await this['warehouseId'];
        if (bool(warehouseId)) {
            await this.set('locationId', (await warehouseId.lotStockId).id);
        }
        else {
                await this.set('locationId', false);
        }
    }

    @api.onchange('productId')
    async _onchangeProductId() {
        const productId = await this['productId'];
        if (bool(productId)) {
            await this.set('productUom', (await productId.uomId).id);
        }
    }

    @api.onchange('companyId')
    async _onchangeCompanyId() {
        const companyId = await this['companyId'];
        if (bool(companyId)) {
            await this.set('warehouseId', await this.env.items('stock.warehouse').search([
                ['companyId', '=', companyId.id]
            ], {limit: 1}));
        }
        }

    @api.onchange('routeId')
    async _onchangeRouteId() {
        if (bool(await this['routeId'])) {
            await this.set('qtyMultiple', await this._getQtyMultipleToOrder());
        }
    }

    async write(vals) {
        if ('companyId' in vals) {
            for (const orderpoint of this) {
                if ((await orderpoint.companyId).id != vals['companyId']) {
                    throw new UserError(await this._t("Changing the company of this record is forbidden at this point, you should rather archive it and create a new one."));
                }
            }
        }
        return _super(StockWarehouseOrderpoint, this).write(vals);
    }

    async actionProductForecastReport() {
        this.ensureOne();
        const productId = await this['productId'];
        const action = await productId.actionProductForecastReport();
        action['context'] = {
            'activeId': productId.id,
            'activeModel': 'product.product',
        }
        const warehouse = await this['warehouseId'];
        if (bool(warehouse)) {
            action['context']['warehouse'] = warehouse.id;
        }
        return action;
    }

    @api.model()
    async actionOpenOrderpoints() {
        return this._getOrderpointAction();
    }

    async actionStockReplenishmentInfo() {
        this.ensureOne();
        const action = await this.env.items("ir.actions.actions")._forXmlid('stock.actionStockReplenishmentInfo');
        action['label'] = await this._t('Replenishment Information for %s in %s', await (await this['productId']).displayName, await (await this['warehouseId']).displayName);
        const res = await this.env.items('stock.replenishment.info').create({
            'orderpointId': this.id,
        })
        action['resId'] = res.id;
        return action;
    }

    async actionReplenish() {
        try {
            await this._procureOrderpointConfirm(await this.env.company());
        } catch(e) {
        // except UserError as e:
            if (len(this) != 1) {
                throw e;
            }
            const productId = await this['productId'];
            throw new RedirectWarning(e, {
                'label': await productId.displayName,
                'type': 'ir.actions.actwindow',
                'resModel': 'product.product',
                'resId': productId.id,
                'views': [[(await this.env.ref('product.productNormalFormView')).id, 'form']],
                'context': {'formViewInitialMode': 'edit'}
            }, await this._t('Edit Product'));
        }
        let notification;
        if (len(this) == 1) {
            notification = await this._getReplenishmentOrderNotification();
        }
        // Forced to call compute quantity because we don't have a link.
        await this._computeQty();
        await (await this.filtered(async (o) => (await o.createdUid).id == global.SUPERUSER_ID && (await o.qtyToOrder <= 0.0) && await o.trigger === 'manual')).unlink();
        return notification;
    }

    async actionReplenishAuto() {
        await this.set('trigger', 'auto');
        return this.actionReplenish();
    }

    @api.depends('productId', 'locationId', 'productId.stockMoveIds', 'productId.stockMoveIds.state', 'productId.stockMoveIds.productUomQty')
    async _computeQty() {
        const orderpointsContexts = new DefaultDict2(() => this.env.items('stock.warehouse.orderpoint'));
        for (const orderpoint of this) {
            if (! bool(await orderpoint.productId) || !bool(await orderpoint.locationId)) {
                // await Promise.all([
                    await orderpoint.set('qtyOnHand', false),
                    await orderpoint.set('qtyForecast', false)
                // ]);
                continue;
            }
            const orderpointContext = await orderpoint._getProductContext();
            const productContext = stringify(new FrozenDict({...this.env.context, ...orderpointContext}));
            orderpointsContexts[productContext] = orderpointsContexts[productContext].or(orderpoint);
        }
        for (const [orderpointContext, orderpointsByContext] of orderpointsContexts.items()) {
            const productsQty = {};
            for (const p of await (await (await orderpointsByContext.productId).withContext(JSON.parse(orderpointContext))).read(['qtyAvailable', 'virtualAvailable'])) {
                productsQty[p['id']] = p;
            }
            const productsQtyInProgress = await orderpointsByContext._quantityInProgress();
            for (const orderpoint of orderpointsByContext) {
                const id = (await orderpoint.productId).id;
                await orderpoint.set('qtyOnHand', productsQty[id]['qtyAvailable']),
                await orderpoint.set('qtyForecast', productsQty[id]['virtualAvailable'] + productsQtyInProgress[orderpoint.id])
            }
        }
    }

    @api.depends('qtyMultiple', 'qtyForecast', 'productMinQty', 'productMaxQty')
    async _computeQtyToOrder() {
        for (const orderpoint of this) {
            if (!bool(await orderpoint.productId) || !bool(await orderpoint.locationId)) {
                await orderpoint.set('qtyToOrder', false);
                continue;
            }
            let qtyToOrder = 0.0;
            const rounding = await (await orderpoint.productUom).rounding;
            if (floatCompare(await orderpoint.qtyForecast, await orderpoint.productMinQty, {precisionRounding: rounding}) < 0) {
                let qtyToOrder = Math.max(await orderpoint.productMinQty, await orderpoint.productMaxQty) - await orderpoint.qtyForecast;
                const qtyMultiple = await orderpoint.qtyMultiple;
                const remainder = qtyMultiple > 0 && (qtyToOrder % qtyMultiple) || 0.0;
                if (floatCompare(remainder, 0.0, {precisionRounding: rounding}) > 0) {
                    qtyToOrder += qtyMultiple - remainder;
                }
            }
            await orderpoint.set('qtyToOrder', qtyToOrder);
        }
    }

    /**
     * Calculates the minimum quantity that can be ordered according to the PO UoM or BoM
     * @returns 
     */
    async _getQtyMultipleToOrder() {
        this.ensureOne();
        return 0;
    }

    /**
     * Write the `routeId` field on `self`. This method is intendend to be called on the orderpoints generated when openning the replenish report.
     */
    async _setDefaultRouteId() {
        const self = await this.filtered(async (o) => ! bool(await o.routeId));
        const rulesGroups = await self.env.items('stock.rule').readGroup([
            ['routeId.productSelectable', '!=', false],
            ['locationId', 'in', (await self.locationId).ids],
            ['action', 'in', ['pullPush', 'pull']]
        ], ['locationId', 'routeId'], ['locationId', 'routeId'], {lazy: false});
        for (const g of rulesGroups) {
            if (!g['routeId']) {
                continue;
            }
            const orderpoints = await self.filtered(async (o) => (await o.locationId).id == g['locationId'][0]);
            await orderpoints.set('routeId', g['routeId']);
        }
    }

    async _getLeadDaysValues() {
        this.ensureOne();
        return new Dict<any>();
    }

    /**
     * Used to call `virtualAvailable` when running an orderpoint.
     * @returns 
     */
    async _getProductContext() {
        this.ensureOne();
        return {
            'location': (await this['locationId']).id,
            'toDate': combine(await this['leadDaysDate'], 'max')
        }
    }

    /**
     * Create manual orderpoints for missing product in each warehouses. It also removes
        orderpoints that have been replenish. In order to do it:
        - It uses the report.stock.quantity to find missing quantity per product/warehouse
        - It checks if orderpoint already exist to refill this location.
        - It checks if it exists other sources (e.g RFQ) tha refill the warehouse.
        - It creates the orderpoints for missing quantity that were not refill by an upper option.

        return replenish report ir.actions.actwindow
     * @returns 
     */
    async _getOrderpointAction() {
        const action = await this.env.items("ir.actions.actions")._forXmlid("stock.actionOrderpointReplenish");
        action['context'] = this.env.context;
        // Search also with archived ones to avoid to trigger product_location_check SQL constraints later
        // It means that when there will be a archived orderpoint on a location + product, the replenishment
        // report won't take in account this location + product and it won't create any manual orderpoint
        // In master: the active field should be remove
        let orderpoints = await (await this.env.items('stock.warehouse.orderpoint').withContext({activeTest: false})).search([]);
        // Remove previous automatically created orderpoint that has been refilled.
        const orderpointsRemoved = await orderpoints._unlinkProcessedOrderpoints();
        orderpoints = orderpoints.sub(orderpointsRemoved);
        let toRefill = new Dict<any>(); //float
        const allProductIds = [];
        const allWarehouseIds = [];
        // Take 3 months since it's the max for the forecast report
        const toDate = DateTime.fromJSDate(_Date.today()).plus({months: 3}).toJSDate();
        const qtyByProductWarehouse = await this.env.items('report.stock.quantity').readGroup(
            [['date', '=', toDate], ['state', '=', 'forecast']],
            ['productId', 'productQty', 'warehouseId'],
            ['productId', 'warehouseId'], {lazy: false});
        for (const group of qtyByProductWarehouse) {
            const warehouseId = group['warehouseId'] && group['warehouseId'][0];
            if (group['productQty'] >= 0.0 || ! bool(warehouseId)) {
                continue;
            }
            allProductIds.push(group['productId'][0]);
            allWarehouseIds.push(warehouseId);
            const key = `${group['productId'][0]}@${warehouseId}`;
            toRefill[key] = toRefill[key] || 0.0;
            toRefill[key] = group['productQty'];
        }
        if (!bool(toRefill)) {
            return action;
        }

        // Recompute the forecasted quantity for missing product today but at this time
        // with their real lead days.
        const keyToRemove = [];
        const pwhPerDay = new Dict<any>(); //list
        let product, warehouse;
        for (const key of toRefill.keys()) {
            [product, warehouse] = key.split('@') as [any, any];
            product = await this.env.items('product.product').browse(product).withPrefetch(allProductIds);
            warehouse = await this.env.items('stock.warehouse').browse(warehouse).withPrefetch(allWarehouseIds);
            const rules = await product._getRulesFromLocation(await warehouse.lotStockId);
            const leadDays = (await (await rules.withContext({bypassDelayDescription: true}))._getLeadDays(product))[0];
            const k = `${leadDays}@${warehouse.id}`;
            pwhPerDay[k] = pwhPerDay[k] ?? [];
            pwhPerDay[k].push(product.id);
        }
        // group product by leadDays and warehouse in order to read virtualAvailable in batch
        for (const [key, pIds] of pwhPerDay.items()) {
            const [days, warehouseId] = key.split('@');
            const products = this.env.items('product.product').browse(pIds);
            const qties = await (await products.withContext({
                warehouse: Number(warehouseId),
                toDate: DateTime.now().plus({days: Number(days)})
            })).read(['virtualAvailable']);
            for (const qty of qties) {
                if (floatCompare(qty['virtualAvailable'], 0, {precisionRounding: await (await product.uomId).rounding}) >= 0) {
                    keyToRemove.push(`${qty['id']}@${warehouse.id}`);
                }
                else {
                    toRefill[`${qty['id']}@${warehouse.id}`] = qty['virtualAvailable'];
                }
            }
        }

        for (const key of keyToRemove) {
            delete toRefill[key];
        }
        if (!bool(toRefill)) {
            return action;
        }

        // Remove incoming quantity from other origin than moves (e.g RFQ)
        const productIds = []
        const warehouseIds = []
        for (const key of toRefill.keys()) {
            const [productId, warehouseId] = key.split('@') as [any, any];
            productIds.push(Number(productId));
            warehouseIds.push(Number(warehouseId));
        }
        const [dummy, qtyByProductWh] = await this.env.items('product.product').browse(productIds)._getQuantityInProgress({warehouseIds: warehouseIds});
        const rounding = await this.env.items('decimal.precision').precisionGet('Product Unit of Measure');
        // Group orderpoint by product-warehouse
        let orderpointByProductWh = await this.env.items('stock.warehouse.orderpoint').readGroup(
            [['id', 'in', orderpoints.ids]],
            ['productId', 'warehouseId', 'qtyToOrder:sum'],
            ['productId', 'warehouseId'], {lazy: false});
        orderpointByProductWh = Object.fromEntries(orderpointByProductWh.map(record => [`${record['productId'][0]}@${record['warehouseId'][0]}`, record['qtyToOrder']]));
        for (const [key, productQty] of toRefill.items()) {
            // const [product, warehouse] = key.split('@');
            let qtyInProgress = qtyByProductWh[key] || 0.0;
            qtyInProgress += orderpointByProductWh[key] || 0.0;
            // Add qty to order for other orderpoint under this warehouse.
            if (!qtyInProgress) {
                continue;
            }
            toRefill[key] = productQty + qtyInProgress;
        }
        toRefill = Dict.from(toRefill.items().filter(([k, v]) => floatCompare(v, 0.0, {precisionDigits: rounding}) < 0.0));

        let lotStockIdByWarehouse = await this.env.items('stock.warehouse').searchRead([
            ['id', 'in', toRefill.keys().map(g => Number(g.split('@')[1]))]
        ], ['lotStockId']);
        lotStockIdByWarehouse = Dict.from(lotStockIdByWarehouse.map(w => [w['id'], w['lotStockId'][0]]));

        // With archived ones to avoid `product_location_check` SQL constraints
        let orderpointByProductLocation = await (await this.env.items('stock.warehouse.orderpoint').withContext({activeTest: false})).readGroup(
            [['id', 'in', orderpoints.ids]],
            ['productId', 'locationId', 'ids:array_agg(id)'],
            ['productId', 'locationId'], {lazy: false});
        orderpointByProductLocation = Dict.from(orderpointByProductLocation.map(record => [`${record['productId'][0]}@${record['locationId'][0]}`, record['ids'][0]]));

        const orderpointValuesList = [];
        for (const [key, productQty] of toRefill.items()) {
            const [product, warehouse] = key.split('@');
            const lotStockId = lotStockIdByWarehouse[warehouse];
            const orderpointId = orderpointByProductLocation.get(`${product}@${lotStockId}`);
            if (bool(orderpointId)) {
                const orderpoint = this.env.items('stock.warehouse.orderpoint').browse(orderpointId);
                const qtyForecast = await orderpoint.qtyForecast;
                await orderpoint.set('qtyForecast', qtyForecast + productQty);
            }
            else {
                const orderpointValues = await this.env.items('stock.warehouse.orderpoint')._getOrderpointValues(product, lotStockId);
                setOptions(orderpointValues, {
                    'label': await this._t('Replenishment Report'),
                    'warehouseId': warehouse,
                    'companyId': (await this.env.items('stock.warehouse').browse(warehouse).companyId).id,
                });
                orderpointValuesList.push(orderpointValues);
            }
        }
        orderpoints = await (await this.env.items('stock.warehouse.orderpoint').withUser(global.SUPERUSER_ID)).create(orderpointValuesList);
        for (const orderpoint of orderpoints) {
            const route0 = (await (await orderpoint.productId).routeIds).slice(0,1);
            await orderpoint.set('routeId', bool(route0) ? route0 : await orderpoint._setDefaultRouteId());
            await orderpoint.set('qtyMultiple', await orderpoint._getQtyMultipleToOrder());
        }
        return action;
    }

    @api.model()
    async _getOrderpointValues(product, location) {
        return {
            'productId': product,
            'locationId': location,
            'productMaxQty': 0.0,
            'productMinQty': 0.0,
            'trigger': 'manual',
        }
    }

    async _getReplenishmentOrderNotification() {
        return false;
    }

    /**
     * Return Quantities that are not yet in virtual stock but should be deduced from orderpoint rule
        (example: purchases created from orderpoints)
     * @returns 
     */
    async _quantityInProgress() {
        return Dict.from(await this.mapped((x) => [x.id, 0.0]));
    }

    @api.autovacuum()
    async _unlinkProcessedOrderpoints() {
        const domain = [
            ['createdUid', '=', global.SUPERUSER_ID],
            ['trigger', '=', 'manual'],
            ['qtyToOrder', '<=', 0]
        ]
        if (bool(this.ids)) {
            expression.AND([domain, [['ids', 'in', this.ids]]]);
        }
        const orderpointsToRemove = await (await this.env.items('stock.warehouse.orderpoint').withContext({activeTest: false})).search(domain);
        // Remove previous automatically created orderpoint that has been refilled.
        await orderpointsToRemove.unlink();
        return orderpointsToRemove;
    }

    /**
     * Prepare specific key for moves or other components that will be created from a stock rule
        comming from an orderpoint. This method could be override in order to add other custom key that could
        be used in move/po creation.
     * @param date 
     * @param group 
     * @returns 
     */
    async _prepareProcurementValues(date?: any, group?: any) {
        const datePlanned = date ?? _Date.today();
        return {
            'routeIds': await this['routeId'],
            'datePlanned': datePlanned,
            'dateDeadline': date ?? false,
            'warehouseId': await this['warehouseId'],
            'orderpointId': this,
            'groupId': bool(group) ? group : await this['groupId'],
        }
    }

    /**
     * Create procurements based on orderpoints.
        :param bool use_new_cursor: if set, use a dedicated cursor and auto-commit after processing
            1000 orderpoints.
            This is appropriate for batch jobs only.
     * @param useNewCursor 
     * @param companyId 
     * @param raiseUserError 
     */
    async _procureOrderpointConfirm(useNewCursor: any=false, companyId?: any, raiseUserError: boolean=true) {
        let self = await this.withCompany(companyId);

        for (const orderpointsBatchIds of splitEvery(1000, self.ids)) {
            let cr;
            if (useNewCursor) {
                cr = (await registry(self._cr.dbName)).cursor();
                self = await self.withEnv(await self.env.change({cr: cr}));
            }
            let orderpointsBatch = self.env.items('stock.warehouse.orderpoint').browse(orderpointsBatchIds);
            const allOrderpointsExceptions = [];
            while (orderpointsBatch.ok) {
                const procurements = [];
                for (const orderpoint of orderpointsBatch) {
                    const [displayName, productId, qtyToOrder, productUom, locationId, label, companyId, leadDaysDate] = await orderpoint('displayName', 'productId', 'qtyToOrder', 'productUom', 'locationId', 'label','companyId', 'leadDaysDate');
                    const origins = (orderpoint.env.context['origins'] ?? {})[orderpoint.id] ?? false;
                    let origin;
                    if (bool(origins)) {
                        origin = f('%s - %s', displayName, origins.join(','));
                    }
                    else {
                        origin = label;
                    }
                    if (floatCompare(qtyToOrder, 0.0, {precisionRounding: await productUom.rounding}) == 1) {
                        const date = combine(leadDaysDate, 'min');
                        const values = orderpoint._prepareProcurementValues(date);
                        procurements.push(await self.env.items('procurement.group').Procurement(productId, qtyToOrder, productUom, locationId, label, origin, companyId, values));
                    }
                }
                let err;
                try {
                    // with this.env.cr.savepoint():
                        await (await self.env.items('procurement.group').withContext({fromOrderpoint: true})).run(procurements, raiseUserError);
                } catch(e) {
                    err = true;
                    if (isInstance(e, ProcurementException)) {
                        const orderpointsExceptions = [];
                        for (const [procurement, errorMsg] of e.procurementExceptions) {
                            extend(orderpointsExceptions, [[procurement.values['orderpointId'], errorMsg]]);
                        }
                        extend(allOrderpointsExceptions, orderpointsExceptions);
                        const failedOrderpoints = self.env.items('stock.warehouse.orderpoint').concat(orderpointsExceptions.map(o => o[0]));
                        if (!bool(failedOrderpoints)) {
                            console.error('Unable to process orderpoints');
                            break;
                        }
                        orderpointsBatch = orderpointsBatch.sub(failedOrderpoints);
                    }
                    else {//if (isInstance(e, OperationalError)) {
                        if (useNewCursor) {
                            await cr.rollback();
                            continue;
                        }
                        else {
                            throw e;
                        }
                    }
                }
                if (!err) {
                    await orderpointsBatch._postProcessScheduler();
                    break;
                }
            }

            // Log an activity on product template for failed orderpoints.
            for (const [orderpoint, errorMsg] of allOrderpointsExceptions) {
                const productId = await orderpoint.productId;
                const productTemplateId = await productId.productTemplateId;
                const existingActivity = await self.env.items('mail.activity').search([
                    ['resId', '=', productTemplateId.id],
                    ['resModelId', '=', (await self.env.ref('product.modelProductTemplate')).id],
                    ['note', '=', errorMsg]]);
                if (!bool(existingActivity)) {
                    const id = (await productId.responsibleId).id;
                    await productTemplateId.activitySchedule({
                        actTypeXmlid: 'mail.mailActivityDataWarning',
                        note: errorMsg,
                        userId: bool(id) ? id : global.SUPERUSER_ID
                    });
                }
            }
            if (useNewCursor) {
                await cr.commit();
                await cr.close();
                console.info("A batch of %s orderpoints is processed and committed", len(orderpointsBatchIds));
            }
        }
        return {}
    }

    async _postProcessScheduler() {
        return true;
    }
}