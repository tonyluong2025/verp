import { api, Fields } from "../../../core";
import { MetaModel, Model } from "../../../core/models"
import { bool, len } from "../../../core/tools";

@MetaModel.define()
class WebsiteTrack extends Model {
    static _module = module;
    static _parents = 'website.track';

    static productId = Fields.Many2one('product.product', {index: true, ondelete: 'CASCADE', readonly: true});
}

@MetaModel.define()
class WebsiteVisitor extends Model {
    static _module = module;
    static _parents = 'website.visitor';

    static visitorProductCount = Fields.Integer('Product Views', {compute: "_computeProductStatistics", help: "Total number of views on products"});
    static productIds = Fields.Many2many('product.product', {string: "Visited Products", compute: "_computeProductStatistics"});
    static productCount = Fields.Integer('Products Views', {compute: "_computeProductStatistics", help: "Total number of product viewed"});

    @api.depends('websiteTrackIds')
    async _computeProductStatistics() {
        const results = await this.env.items('website.track').readGroup(
            [['visitorId', 'in', this.ids], ['productId', '!=', false],
             '|', ['productId.companyId', 'in', (await this.env.companies()).ids], ['productId.companyId', '=', false]],
            ['visitorId', 'productId'], ['visitorId', 'productId'],
            {lazy: false});
        const mappedData = {}
        for (const result of results) {
            const visitorInfo = mappedData[result['visitorId'][0]] ?? {'productCount': 0, 'productIds': new Set()};
            visitorInfo['productCount'] += result['__count'];
            visitorInfo['productIds'].add(result['productId'][0]);
            mappedData[result['visitorId'][0]] = visitorInfo;
        }
        for (const visitor of this) {
            const visitorInfo = mappedData[visitor.id] ?? {'productIds': [], 'productCount': 0};

            await visitor.set('productIds', [[6, 0, visitorInfo['productIds']]]);
            await visitor.set('visitorProductCount', visitorInfo['productCount']);
            await visitor.set('productCount', len(visitorInfo['productIds']));
        }
    }

    /**
     * add a website_track with a page marked as viewed
     * @param productId 
     */
    async _addViewedProduct(productId) {
        this.ensureOne();
        if (bool(productId) && await this.env.items('product.product').browse(productId)._isVariantPossible()) {
            const domain = [['productId', '=', productId]];
            const websiteTrackValues = {'productId': productId, 'visitDatetime': new Date()}
            await (this as any)._addTracking(domain, websiteTrackValues);
        }
    }
}