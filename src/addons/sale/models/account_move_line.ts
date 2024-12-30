import { _Date, Fields } from "../../../core";
import { UserError } from "../../../core/helper";
import { _super, BaseModel, MetaModel, Model } from "../../../core/models";
import { bool, enumerate, f, floatCompare, floatIsZero, isInstance, len } from "../../../core/tools";

@MetaModel.define()
class AccountMoveLine extends Model {
    static _module = module;
    static _parents = 'account.move.line';

    static saleLineIds = Fields.Many2many('sale.order.line', {
        relation: 'saleOrderLineInvoiceRel',
        column1: 'invoiceLineId', column2: 'orderLineId', string: 'Sales Order Lines', readonly: true, copy: false
    });

    async _copyDataExtendBusinessFields(values) {
        // OVERRIDE to copy the 'sale_line_ids' field as well.
        await _super(AccountMoveLine, this)._copyDataExtendBusinessFields(values);
        values['saleLineIds'] = [[6, null, (await this['saleLineIds']).ids]];
    }

    /**
     * Note: This method is called only on the move.line that having an analytic account, and
            so that should create analytic entries.
     * @returns 
     */
    async _prepareAnalyticLine() {
        const valuesList = await _super(AccountMoveLine, this)._prepareAnalyticLine();

        // filter the move lines that can be reinvoiced: a cost (negative amount) analytic line without SO line but with a product can be reinvoiced
        let moveToReinvoice = this.env.items('account.move.line');
        for (const [index, moveLine] of enumerate(this)) {
            const values = valuesList[index];
            if (!('soLine' in values)) {
                if (await moveLine._saleCanBeReinvoice()) {
                    moveToReinvoice = moveToReinvoice.or(moveLine);
                }
            }
        }

        // insert the sale line in the create values of the analytic entries
        if (moveToReinvoice.ok) {
            const mapSaleLinePerMove = await moveToReinvoice._saleCreateReinvoiceSaleLine();

            for (const values of valuesList) {
                const saleLine = mapSaleLinePerMove[values['moveId']];
                if (bool(saleLine)) {
                    values['soLine'] = saleLine.id;
                }
            }
        }
        return valuesList;
    }

    /**
     * determine if the generated analytic line should be reinvoiced or not.
            For Vendor Bill flow, if the product has a 'erinvoice policy' and is a cost, then we will find the SO on which reinvoice the AAL
     * @returns 
     */
    async _saleCanBeReinvoice() {
        this.ensureOne();
        if (bool(this['saleLineIds'])) {
            return false;
        }
        const uomPrecisionDigits = await this.env.items('decimal.precision').precisionGet('Product Unit of Measure');
        return floatCompare(await this['credit'] || 0.0, await this['debit'] || 0.0, { precisionDigits: uomPrecisionDigits }) != 1 && ![false, 'no'].includes(await (await this['productId']).expensePolicy);
    }

    async _saleCreateReinvoiceSaleLine() {
        const saleOrderMap = await this._saleDetermineOrder();

        const saleLineValuesToCreate = [];  // the list of creation values of sale line to create.
        const existingSaleLineCache = {};  // in the salesPrice-delivery case, we can reuse the same sale line. This cache will avoid doing a search each time the case happen
        // `mapMoveSaleLine` is map where
        //   - key is the move line identifier
        //   - value is either a sale.order.line record (existing case), or an integer representing the index of the sale line to create in
        //     the `saleLineValuesToCreate` (not existing case, which will happen more often than the first one).
        const mapMoveSaleLine = {};

        for (const moveLine of this) {
            const saleOrder = saleOrderMap[moveLine.id];

            // no reinvoice as no sales order was found
            if (!bool(saleOrder)) {
                continue;
            }

            // raise if the sale order is not currenlty open
            if (await saleOrder.state !== 'sale') {
                const messageUnconfirmed = await this._t('The Sales Order %s linked to the Analytic Account %s must be validated before registering expenses.');
                const messages = {
                    'draft': messageUnconfirmed,
                    'sent': messageUnconfirmed,
                    'done': await this._t('The Sales Order %s linked to the Analytic Account %s is currently locked. You cannot register an expense on a locked Sales Order. Please create a new SO linked to this Analytic Account.'),
                    'cancel': await this._t('The Sales Order %s linked to the Analytic Account %s is cancelled. You cannot register an expense on a cancelled Sales Order.'),
                }
                throw new UserError(f(messages[await saleOrder.state], await saleOrder.label, await (await saleOrder.analyticAccountId).label));
            }
            let price = await moveLine._saleGetInvoicePrice(saleOrder);

            // find the existing sale.line or keep its creation values to process this in batch
            const product = await moveLine.productId;
            let saleLine;
            if (await product.expensePolicy === 'salesPrice' && await product.invoicePolicy === 'delivery') {  // for those case only, we can try to reuse one
                const mapEntryKey = [saleOrder.id, product.id, price].join('-');  // cache entry to limit the call to search
                saleLine = existingSaleLineCache[mapEntryKey];
                if (bool(saleLine)) {  // already search, so reuse it. sale_line can be sale.order.line record or index of a "to create values" in `sale_line_values_to_create`
                    mapMoveSaleLine[moveLine.id] = saleLine;
                    existingSaleLineCache[mapEntryKey] = saleLine;
                }
                else {  // search for existing sale line
                    const saleLine = await this.env.items('sale.order.line').search([
                        ['orderId', '=', saleOrder.id],
                        ['priceUnit', '=', price],
                        ['productId', '=', (await moveLine.productId).id],
                        ['isExpense', '=', true],
                    ], { limit: 1 });
                    if (bool(saleLine)) {  // found existing one, so keep the browse record
                        mapMoveSaleLine[moveLine.id] = existingSaleLineCache[mapEntryKey] = saleLine;
                    }
                    else {  // should be create, so use the index of creation values instead of browse record
                        // save value to create it
                        saleLineValuesToCreate.push(await moveLine._salePrepareSaleLineValues(saleOrder, price));
                        // store it in the cache of existing ones
                        existingSaleLineCache[mapEntryKey] = len(saleLineValuesToCreate) - 1;  // save the index of the value to create sale line
                        // store it in the map_move_sale_line map
                        mapMoveSaleLine[moveLine.id] = len(saleLineValuesToCreate) - 1;  // save the index of the value to create sale line
                    }
                }
            }
            else {  // save its value to create it anyway
                saleLineValuesToCreate.push(await moveLine._salePrepareSaleLineValues(saleOrder, price));
                mapMoveSaleLine[moveLine.id] = len(saleLineValuesToCreate) - 1;  // save the index of the value to create sale line
            }
        }
        // create the sale lines in batch
        const newSaleLines = await this.env.items('sale.order.line').create(saleLineValuesToCreate);
        for (const sol of newSaleLines) {
            await sol._onchangeDiscount();
        }

        // build result map by replacing index with newly created record of sale.order.line
        const result = {};
        for (const [moveLineId, unknownSaleLine] of Object.entries(mapMoveSaleLine)) {
            if (typeof unknownSaleLine === 'number') {  // index of newly created sale line
                result[moveLineId] = newSaleLines[unknownSaleLine];
            }
            else if (isInstance(unknownSaleLine, BaseModel)) {  // already record of sale.order.line
                result[moveLineId] = unknownSaleLine;
            }
        }
        return result;
    }

    /**
     * Get the mapping of move.line with the sale.order record on which its analytic entries should be reinvoiced
            :return a dict where key is the move line id, and value is sale.order record (or None).
     * @returns 
     */
    async _saleDetermineOrder() {
        const analyticAccounts = await this.mapped('analyticAccountId');

        // link the analytic account with its open SO by creating a map: {AA.id: sale.order}, if we find some analytic accounts
        const mapping = {};
        if (bool(analyticAccounts)) {  // first, search for the open sales order
            const saleOrders = await this.env.items('sale.order').search([['analyticAccountId', 'in', analyticAccounts.ids], ['state', '=', 'sale']], { order: 'createdAt DESC' });
            for (const saleOrder of saleOrders) {
                mapping[(await saleOrder.analyticAccountId).id] = saleOrder;
            }
            const analyticAccountsWithoutOpenOrder = await analyticAccounts.filtered(async (account) => !mapping[account.id]);
            if (bool(analyticAccountsWithoutOpenOrder)) {  // then, fill the blank with not open sales orders
                const saleOrders = await this.env.items('sale.order').search([['analyticAccountId', 'in', analyticAccountsWithoutOpenOrder.ids]], { order: 'createdAt DESC' });
            }
            for (const saleOrder of saleOrders) {
                mapping[(await saleOrder.analyticAccountId).id] = saleOrder;
            }
        }
        // map of AAL index with the SO on which it needs to be reinvoiced. Maybe be None if no SO found
        const res = {}
        for (const moveLine of this) {
            res[moveLine.id] = mapping[(await moveLine.analyticAccountId).id];
        }
        return res;
    }

    /**
     * Generate the sale.line creation value from the current move line
     * @param order 
     * @param price 
     * @returns 
     */
    async _salePrepareSaleLineValues(order, price) {
        this.ensureOne();
        const lastSoLine = await this.env.items('sale.order.line').search([['orderId', '=', order.id]], { order: 'sequence desc', limit: 1 });
        const lastSequence = lastSoLine ? await lastSoLine.sequence + 1 : 100;

        let fpos = await order.fiscalPositionId;
        fpos = bool(fpos) ? fpos : await fpos.getFiscalPosition((await order.partnerId).id);
        const productTaxes = await (await (await this['productId']).taxesId).filtered(async (tax) => (await tax.companyId).eq(await order.companyId));
        const taxes = await fpos.mapTax(productTaxes);

        return {
            'orderId': order.id,
            'label': await this['label'],
            'sequence': lastSequence,
            'priceUnit': price,
            'taxId': await taxes.map(x => x.id),
            'discount': 0.0,
            'productId': (await this['productId']).id,
            'productUom': (await this['productUomId']).id,
            'productUomQty': 0.0,
            'isExpense': true,
        }
    }

    /**
     * Based on the current move line, compute the price to reinvoice the analytic line that is going to be created (so the
            price of the sale line).
     * @param order 
     * @returns 
     */
    async _saleGetInvoicePrice(order) {
        this.ensureOne();

        const unitAmount = await this['quantity'];
        const amount = (await this['credit'] || 0.0) - (await this['debit'] || 0.0);

        if (await (await this['productId']).expensePolicy === 'salesPrice') {
            return (await (await this['productId']).withContext({
                partner: await order.partnerId,
                dateOrder: await order.dateOrder,
                pricelist: (await order.pricelistId).id,
                uom: (await this['productUomId']).id
            })).price;
        }

        const uomPrecisionDigits = await this.env.items('decimal.precision').precisionGet('Product Unit of Measure');
        if (floatIsZero(unitAmount, { precisionDigits: uomPrecisionDigits })) {
            return 0.0;
        }

        // Prevent unnecessary currency conversion that could be impacted by exchange rate
        // fluctuations
        const company = await this['companyId'];
        if ((await company.currencyId).ok && amount && (await company.currencyId).eq(await order.currencyId)) {
            return Math.abs(amount / unitAmount);
        }

        let priceUnit = Math.abs(amount / unitAmount);
        const currency = await company.currencyId;
        if (currency.ok && !currency.eq(await order.currencyId)) {
            priceUnit = await currency._convert(priceUnit, await order.currencyId, await order.companyId, await order.dateOrder || _Date.today());
        }
        return priceUnit;
    }

    async _getDownpaymentLines() {
        // OVERRIDE
        return (await (await (await this['saleLineIds']).filtered('isDownpayment')).invoiceLines).filtered(async (line) => (await line.moveId)._isDownpayment());
    }
}