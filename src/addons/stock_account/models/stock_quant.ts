import { Fields, api } from "../../../core";
import { MetaModel, Model, _super } from "../../../core/models";
import { bool, floatIsZero, groupbyAsync } from "../../../core/tools";

@MetaModel.define()
class StockQuant extends Model {
    static _module = module;
    static _parents = 'stock.quant';

    static value = Fields.Monetary('Value', { compute: '_computeValue', groups: 'stock.groupStockManager' });
    static currencyId = Fields.Many2one('res.currency', { compute: '_computeValue', groups: 'stock.groupStockManager' });
    static accountingDate = Fields.Date(
        'Accounting Date',
        { help: "Date at which the accounting entries will be created in case of automated inventory valuation. If empty, the inventory date will be used." });

    /**
     * For standard and AVCO valuation, compute the current accounting
        valuation of the quants by multiplying the quantity by
        the standard price. Instead for FIFO, use the quantity times the
        average cost (valuation layers are not manage by location so the
        average cost is the same for all location and the valuation field is
        a estimation more than a real value).
     * @returns 
     */
    @api.depends('companyId', 'locationId', 'ownerId', 'productId', 'quantity')
    async _computeValue() {
        for (const quant of this) {
            const company = await quant.companyId;
            await quant.set('currencyId', await company.currencyId);
            // If the user didn't enter a location yet while enconding a quant.
            if (!bool(await quant.locationId)) {
                await quant.set('value', 0);
                return;
            }

            if (! await (await quant.locationId)._shouldBeValued() ||
                (bool(await quant.ownerId) && !(await quant.ownerId).eq(await company.partnerId))) {
                await quant.set('value', 0);
                continue;
            }
            const product = await quant.productId;
            if (await product.costMethod === 'fifo') {
                const quantity = await (await product.withCompany(company)).quantitySvl;
                if (floatIsZero(quantity, { precisionRounding: await (await product.uomId).rounding })) {
                    await quant.set('value', 0);
                    continue;
                }
                const averageCost = await (await product.withCompany(company)).valueSvl / quantity;
                await quant.set('value', await quant.quantity * averageCost);
            }
            else {
                await quant.set('value', await quant.quantity * await (await product.withCompany(company)).standardPrice);
            }
        }
    }

    /**
     * This override is done in order for the grouped list view to display the total value of
        the quants inside a location. This doesn't work out of the box because `value` is a computed
        field.
     * @param domain 
     * @param fields 
     * @param groupby 
     * @param opts 
     * @returns 
     */
    @api.model()
    async readGroup(domain, fields, groupby, opts: { offset?: any, limit?: any, orderby?: any, lazy?: any } = {}) {
        opts.offset = opts.offset ?? 0;
        opts.lazy = opts.lazy ?? true;
        if (!fields.includes('value')) {
            return _super(StockQuant, this).readGroup(domain, fields, groupby, opts);
        }
        const res = await _super(StockQuant, this).readGroup(domain, fields, groupby, opts);
        for (const group of res) {
            if (group['__domain']) {
                const quants = await this.search(group['__domain']);
                group['value'] = await quants.sum(quant => quant.value);
            }
        }
        return res;
    }

    async _applyInventory() {
        for (const [accountingDate, inventoryIds] of await groupbyAsync(this, (q) => q.accountingDate)) {
            const inventories = this.env.items('stock.quant').concat(inventoryIds);
            if (accountingDate) {
                await (await _super(StockQuant, await inventories.withContext({ forcePeriodDate: accountingDate })))._applyInventory();
                await inventories.set('accountingDate', false);
            }
            else {
                await _super(StockQuant, inventories)._applyInventory();
            }
        }
    }

    /**
     * Returns a list of fields user can edit when editing a quant in `inventory_mode`.
     * @returns 
     */
    @api.model()
    async _getInventoryFieldsWrite() {
        let res = await _super(StockQuant, this)._getInventoryFieldsWrite();
        res = res.concat(['accountingDate']);
        return res;
    }
}
