import { Fields, api } from "../../../core";
import { MetaModel, TransientModel, _super } from "../../../core/models";

@MetaModel.define()
class StockRulesReport extends TransientModel {
    static _module = module;
    static _name = 'stock.rules.report';
    static _description = 'Stock Rules report';

    static productId = Fields.Many2one('product.product', { string: 'Product', required: true });
    static productTemplateId = Fields.Many2one('product.template', { string: 'Product Template', required: true });
    static warehouseIds = Fields.Many2many('stock.warehouse', { string: 'Warehouses', required: true, help: "Show the routes that apply on selected warehouses." });
    static productHasVariants = Fields.Boolean('Has variants', { default: false, required: true });

    @api.model()
    async defaultGet(fields) {
        const res = await _super(StockRulesReport, this).defaultGet(fields);
        let productTemplateId = this.env.items('product.template');
        if (fields.includes('productId')) {
            if (this.env.context['default_productId']) {
                const productId = this.env.items('product.product').browse(this.env.context['default_productId']);
                productTemplateId = await productId.productTemplateId;
                res['productTemplateId'] = productTemplateId.id;
                res['productId'] = productId.id;
            }
            else if (this.env.context['default_productTemplateId']) {
                productTemplateId = this.env.items('product.template').browse(this.env.context['default_productTemplateId']);
                res['productTemplateId'] = productTemplateId.id;
                const [productVariantId, productVariantIds] = await productTemplateId('productVariantId', 'productVariantIds');
                res['productId'] = productVariantId.id;
                if (productVariantIds._length > 1) {
                    res['productHasVariants'] = true;
                }
            }
        }
        if (fields.includes('warehouseIds')) {
            let company = productTemplateId.companyId;
            company = company.ok ? company : await this.env.company();
            const warehouseId = (await this.env.items('stock.warehouse').search([['companyId', '=', company.id]], { limit: 1 })).id;
            res['warehouseIds'] = [[6, 0, [warehouseId]]];
        }
        return res;
    }

    async _prepareReportData() {
        const [productId, warehouseIds] = await this('productId', 'warehouseIds');
        const data = {
            'productId': productId.id,
            'warehouseIds': warehouseIds.ids,
        }
        return data;
    }

    async printReport() {
        this.ensureOne();
        const data = await this._prepareReportData();
        return (await this.env.ref('stock.actionReportStockRule')).reportAction(null, data);
    }

}