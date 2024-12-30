import { http } from "../../../core"
import { pop } from "../../../core/tools";
import { VariantController } from "../../sale/controllers/variant"

@http.define()
class WebsiteSaleVariantController extends VariantController {
    static _module = module;

    /**
     * Special route to use website logic in get_combination_info override.
        This route is called in JS by appending Website to the base route.
     * @param req 
     * @param res 
     * @param opts 
     * @returns 
     */
    @http.route(['/sale/getCombinationInfoWebsite'], {type: 'json', auth: "public", methods: ['POST'], website: true})
    async getCombinationInfoWebsite(req, res, opts: {productTemplateId?: any, productId?: any, combination?: any, addQty?: any}={}) {
        pop(opts, 'pricelistId');
        const combination = await this.getCombinationInfo(req, res, {...opts, pricelistId: await req.website.getCurrentPricelist(req)});
        const env = await req.getEnv();
        if (await req.website.googleAnalyticsKey) {
            combination['productTrackingInfo'] = await env.items('product.template').getGoogleAnalyticsData(combination);
        }
        const carouselView = await env.items('ir.ui.view')._renderTemplate('website_sale.shopProductCarousel', {
            'product': env.items('product.template').browse(combination['productTemplateId']),
            'productVariant': env.items('product.product').browse(combination['productId']),
        });
        combination['carousel'] = carouselView;
        return combination;
    }

    /**
     * Override because on the website the public user must access it.
     * @param req 
     * @param res 
     * @param opts 
     * @returns 
     */
    @http.route({auth: "public"})
    async createProductVariant(req, res, opts: {productTemplateId?: any, productTemplateAttributeValueIds?: any}={}) {
        return super.createProductVariant(req, res, opts);
    }
}
