import { AbstractModel, MetaModel, _super } from "../../../core/models"
import { bool, f, floatIsZero, floatRepr, sum } from "../../../core/tools";

@MetaModel.define()
class ReplenishmentReport extends AbstractModel {
    static _module = module;
    static _parents = 'stock.report.productproductreplenishment';

    /**
     * Overrides to computes the valuations of the stock.
     * @param productTemplateIds 
     * @param productVariantIds 
     * @param whLocationIds 
     * @returns 
     */
    async _computeDraftQuantityCount(productTemplateIds, productVariantIds, whLocationIds) {
        const res = await _super(ReplenishmentReport, this)._computeDraftQuantityCount(productTemplateIds, productVariantIds, whLocationIds);
        if (!await this.userHasGroups('stock.groupStockManager')) {
            return res;
        }
        const domain = await (this as any)._productDomain(productTemplateIds, productVariantIds);
        const company = await this.env.items('stock.location').browse(whLocationIds[0]).companyId;
        const svl = await this.env.items('stock.valuation.layer').search(domain.concat([['companyId', '=', company.id]]));
        let domainQuants = [
            ['companyId', '=', company.id],
            ['locationId', 'in', whLocationIds]
        ];
        if (bool(productTemplateIds)) {
            domainQuants = domainQuants.concat([['productId.productTmplId', 'in', productTemplateIds]]);
        }
        else {
            domainQuants = domainQuants.concat([['productId', 'in', productVariantIds]]);
        }
        const quants = await this.env.items('stock.quant').search(domainQuants);
        let currency = await svl.currencyId;
        currency = bool(currency) ? currency : await (await this.env.company()).currencyId;
        const totalQuantity = sum(await svl.mapped('quantity'));
        // Because we can have negative quantities, `total_quantity` may be equal to zero even if the warehouse's `quantity` is positive.
        let value;
        if (bool(svl) && !floatIsZero(totalQuantity, {precisionRounding: await (await (await svl.productId).uomId).rounding})) {
            value = sum(await svl.mapped('value')) * (sum(await quants.mapped('quantity')) / totalQuantity);
        }
        else {
            value = 0;
        }
        value = floatRepr(value, await currency.decimalPlaces);
        if (await currency.position === 'after') {
            value = f('%s %s', value, await currency.symbol);
        }
        else {
            value = f('%s %s', await currency.symbol, value);
        }
        res['value'] = value;
        return res;
    }
}