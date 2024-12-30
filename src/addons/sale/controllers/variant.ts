import { http } from "../../../core"
import { bool, parseInt, update } from "../../../core/tools";

@http.define()
export class VariantController extends http.Controller {
    static _module = module;
    
    @http.route(['/sale/getCombinationInfo'], {type: 'json', auth: "user", methods: ['POST']})
    async getCombinationInfo(req, res, opts: {productTemplateId?: any, productId?: any, combination?: any, addQty?: any, pricelistId?: any}={}) {
        const env = await req.getEnv();
        let combination = env.items('product.template.attribute.value').browse(opts.combination);
        const pricelist = await this._getPricelist(req, opts.pricelistId);
        let productTemplate = env.items('product.template');
        if ('context' in opts) {
            productTemplate = await productTemplate.withContext(opts['context']);
        }
        productTemplate = productTemplate.browse(parseInt(opts.productTemplateId));
        const result = await productTemplate._getCombinationInfo({combination, productId: parseInt(opts.productId || 0), addQty : parseInt(opts.addQty || 1), pricelist});
        if ('parentCombination' in opts) {
            const parentCombination = env.items('product.template.attribute.value').browse(opts['parentCombination']);
            if (! bool(await combination.exists()) && bool(opts.productId)) {
                const product = env.items('product.product').browse(parseInt(opts.productId));
                if (bool(await product.exists())) {
                    combination = await product.productTemplateAttributeValueIds;
                }
            }
            update(result, {
                'isCombinationPossible': await productTemplate._isCombinationPossible(combination, parentCombination),
                'parentExclusions': await productTemplate._getParentAttributeExclusions(parentCombination)
            });
        }
        return result;
    }
    
    @http.route(['/sale/createProductVariant'], {type: 'json', auth: "user", methods: ['POST']})
    async createProductVariant(req, res, opts: {productTemplateId?: any, productTemplateAttributeValueIds?: any}={}) {
        return (await req.getEnv()).items('product.template').browse(parseInt(opts.productTemplateId)).createProductVariant(opts.productTemplateAttributeValueIds);
    }

    async _getPricelist(req, pricelistId, pricelistFallback=false) {
        return (await req.getEnv()).items('product.pricelist').browse(parseInt(pricelistId || 0));
    }
}