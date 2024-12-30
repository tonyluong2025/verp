import { _Datetime, api, Fields } from "../../../core";
import { _super, MetaModel, Model } from "../../../core/models"
import { bool, combine, floatRound, subDate } from "../../../core/tools";

@MetaModel.define()
class ProductProduct extends Model {
    static _module = module;
    static _parents = 'product.product';

    static salesCount = Fields.Float({compute: '_computeSalesCount', string: 'Sold'});

    async _computeSalesCount() {
        const result = {};
        await this.set('salesCount', 0);
        if (! await this.userHasGroups('sales_team.groupSaleSalesman')) {
            return result;
        }
        const dateFrom = _Datetime.toDatetime(combine(subDate(new Date(), {days: 365}), 'min'));

        const doneStates = this.env.items('sale.report')._getDoneStates();

        const domain = [
            ['state', 'in', doneStates],
            ['productId', 'in', this.ids],
            ['date', '>=', dateFrom],
        ];
        for (const group of await this.env.items('sale.report').readGroup(domain, ['productId', 'productUomQty'], ['productId'])) {
            result[group['productId'][0]] = group['productUomQty'];
        }
        for (const product of this) {
            if (! bool(product.id)) {
                await product.set('salesCount', 0.0);
                continue;
            }
            await product.set('salesCount', floatRound(result[product.id] ?? 0, {precisionRounding: await (await product.uomId).rounding}));
        }
        return result;
    }

    @api.onchange('type')
    async _onchangeType() {
        if (bool(this._origin) && await this['salesCount'] > 0) {
            return {
                'warning': {
                    'title': await this._t("Warning"),
                    'message': await this._t("You cannot change the product's type because it is already used in sales orders.")
                }
            }
        }
    }

    async actionViewSales() {
        const action = await this.env.items("ir.actions.actions")._forXmlid("sale.reportAllChannelsSalesAction");
        action['domain'] = [['productId', 'in', this.ids]];
        action['context'] = {
            'pivotMeasures': ['productUomQty'],
            'activeId': this._context['activeId'],
            'searchDefault_sales': 1,
            'activeModel': 'sale.report',
            'searchDefault_filterOrderDate': 1,
        }
        return action;
    }

    async _getInvoicePolicy() {
        return this['invoicePolicy'];
    }

    /**
     * Return the variant info based on its combination.
        See `_getCombinationInfo` for more information.
     * @param addQty 
     * @param pricelist 
     * @param parentCombination 
     * @returns 
     */
    async _getCombinationInfoVariant(addQty=1, pricelist=false, parentCombination=false) {
        this.ensureOne();
        return (await this['productTemplateId'])._getCombinationInfo({combination: await this['productTemplateAttributeValueIds'], productId: this.id, addQty, pricelist, parentCombination});
    }

    async _filterToUnlink() {
        const domain = [['productId', 'in', this.ids]];
        const lines = await this.env.items('sale.order.line').readGroup(domain, ['productId'], ['productId']);
        const linkedProductIds = lines.map(group => group['productId'][0]);
        return _super(ProductProduct, this.sub(await this.browse(linkedProductIds)))._filterToUnlink();
    }
}

@MetaModel.define()
class ProductAttributeCustomValue extends Model {
    static _module = module;
    static _parents = "product.attribute.custom.value";

    static saleOrderLineId = Fields.Many2one('sale.order.line', {string: "Sales Order Line", required: true, ondelete: 'CASCADE'});

    static _sqlConstraints = [
        ['sol_custom_value_unique', 'unique("customProductTemplateAttributeValueId", "saleOrderLineId")', "Only one Custom Value is allowed per Attribute Value per Sales Order Line."]
    ];
}

@MetaModel.define()
class ProductPackaging extends Model {
    static _module = module;
    static _parents = 'product.packaging';

    static sales = Fields.Boolean("Sales", {default: true, help: "If true, the packaging can be used for sales orders"});
}
