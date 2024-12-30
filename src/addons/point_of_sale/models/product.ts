import { Fields, _Date, api } from "../../../core";
import { UserError } from "../../../core/helper";
import { MetaModel, Model } from "../../../core/models";
import { f, groupbyAsync, itemgetter, sortedAsync } from "../../../core/tools";

@MetaModel.define()
class ProductTemplate extends Model {
    static _module = module;
    static _parents = 'product.template';

    static availableInPos = Fields.Boolean({ string: 'Available in POS', help: 'Check if you want this product to appear in the Point of Sale.', default: false });
    static toWeight = Fields.Boolean({ string: 'To Weigh With Scale', help: "Check if the product should be weighted using the hardware scale integration." });
    static posCategId = Fields.Many2one('pos.category', {
        string: 'Point of Sale Category',
        help: "Category used in the Point of Sale."
    });

    @api.ondelete(false)
    async _unlinkExceptOpenSession() {
        const productCtx = Object.assign({}, this.env.context, { activeTest: false });
        if (await (await this.withContext(productCtx)).searchCount([['id', 'in', this.ids], ['availableInPos', '=', true]])) {
            if (await (await this.env.items('pos.session').sudo()).searchCount([['state', '!=', 'closed']])) {
                throw new UserError(await this._t('You cannot delete a product saleable in point of sale while a session is still opened.'));
            }
        }
    }

    @api.onchange('saleOk')
    async _onchangeSaleOk() {
        if (! await this['saleOk']) {
            await this.set('availableInPos', false);
        }
    }
}

@MetaModel.define()
class ProductProduct extends Model {
    static _module = module;
    static _parents = 'product.product';

    @api.ondelete(false)
    async _unlinkExceptActivePosSession() {
        const productCtx = Object.assign({}, this.env.context, { activeTest: false });
        if (await (await this.env.items('pos.session').sudo()).searchCount([['state', '!=', 'closed']])) {
            if (await (await this.withContext(productCtx)).searchCount([['id', 'in', this.ids], ['productTemplateId.availableInPos', '=', true]])) {
                throw new UserError(await this._t('You cannot delete a product saleable in point of sale while a session is still opened.'));
            }
        }
    }

    async getProductInfoPos(price, quantity, posConfigId) {
        this.ensureOne();
        const config = this.env.items('pos.config').browse(posConfigId);

        // Tax related
        const taxes = await (await this['taxesId']).computeAll(price, {currency: await config.currencyId, quantity, product: this});
        const groupedTaxes = {}
        for (const tax of taxes['taxes']) {
            if (tax['id'] in groupedTaxes) {
                groupedTaxes[tax['id']]['amount'] += quantity ? tax['amount'] / quantity : 0;
            }
            else {
                groupedTaxes[tax['id']] = {
                    'label': tax['label'],
                    'amount': quantity ? tax['amount'] / quantity : 0
                }
            }
        }

        const allPrices = {
            'priceWithoutTax': quantity ? taxes['totalExcluded'] / quantity : 0,
            'priceWithTax': quantity ? taxes['totalIncluded'] / quantity : 0,
            'taxDetails': Object.values(groupedTaxes),
        }

        // Pricelists
        let pricelists;
        if (await config.usePricelist) {
            pricelists = await config.availablePricelistIds;
        }
        else {
            pricelists = await config.pricelistId;
        }
        const pricePerPricelistId = await pricelists.priceGet(this.id, quantity);
        const pricelistList = await pricelists.map(async (pl) => { return { 'label': await pl.label, 'price': pricePerPricelistId[pl.id] } });

        // Warehouses
        const uomName = await this['uomName'];
        const warehouseList = [];
        for (const w of await this.env.items('stock.warehouse').search([])) {
            const warehouse = await this.withContext({ 'warehouse': w.id });
            warehouseList.push({
                'label': await w.label,
                'availableQuantity': await warehouse.qtyAvailable,
                'forecastedQuantity': await warehouse.virtualAvailable,
                'uom': uomName
            });
        }

        // Suppliers
        const key = itemgetter(['label']);
        const supplierList = [];
        const sellerIds = await this['sellerIds'];
        for (const [key, group] of await groupbyAsync(await sortedAsync(sellerIds, (item) => key(item)), (item) => key(item))) {
            for (const s of Array.from<any>(group)) {
                if (!((await s.dateStart && await s.dateStart > _Date.today()) || (await s.dateEnd && await s.dateEnd < _Date.today()) || (await s.minQty > quantity))) {
                    supplierList.push({
                        'label': await (await s.label).label,
                        'delay': await s.delay,
                        'price': await s.price
                    })
                    break;
                }
            }
        }

        // Variants
        const variantList = []
        for (const attributeLine of await this['attributeLineIds']) {
            variantList.push({
                'label': await (await attributeLine.attributeId).label,
                'values': await Promise.all((await (await attributeLine.valueIds).mapped('label')).map(async (attrName) => { 
                    return { 
                        'label': attrName, 
                        'search': f('%s %s', await this['label'], attrName) 
                    } 
                }))
            });
        }

        return {
            'allPrices': allPrices,
            'pricelists': pricelistList,
            'warehouses': warehouseList,
            'suppliers': supplierList,
            'variants': variantList
        }
    }
}

@MetaModel.define()
class UomCateg extends Model {
    static _module = module;
    static _parents = 'uom.category';

    static isPosGroupable = Fields.Boolean({
        string: 'Group Products in POS',
        help: "Check if you want to group products of this category in point of sale orders"
    });
}

@MetaModel.define()
class Uom extends Model {
    static _module = module;
    static _parents = 'uom.uom';

    static isPosGroupable = Fields.Boolean({ related: 'categoryId.isPosGroupable', readonly: false });
}