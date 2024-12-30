import _ from "lodash";
import { api, Fields } from "../../../core";
import { Counter } from "../../../core/helper";
import { _super, MetaModel, Model } from "../../../core/models"
import { expression } from "../../../core/osv";
import { bool, extend, f, len, parseInt, range, sorted, UpCamelCase, update } from "../../../core/tools";

@MetaModel.define()
class WebsiteSnippetFilter extends Model {
    static _module = module;
    static _parents = 'website.snippet.filter';

    static productCrossSelling = Fields.Boolean({string: "About cross selling products", default: false,
        help: "True only for product filters that require a productId because they relate to cross selling"});

    @api.model()
    async _getWebsiteCurrency() {
        const pricelist = await (await this.env.items('website').getCurrentWebsite()).getCurrentPricelist(this.env.req);
        return pricelist.currencyId;
    }

    async _getHardcodedSample(model) {
        let samples = await _super(WebsiteSnippetFilter, this)._getHardcodedSample(model);
        if (model.cls._name === 'product.product') {
            const data = [{
                'image512': '/product/static/img/product_chair.png',
                'displayName': await this._t('Chair'),
                'descriptionSale': await this._t('Sit comfortably'),
            }, {
                'image512': '/product/static/img/product_lamp.png',
                'displayName': await this._t('Lamp'),
                'descriptionSale': await this._t('Lightbulb sold separately'),
            }, {
                'image512': '/product/static/img/product_product_20-image.png',
                'displayName': await this._t('Whiteboard'),
                'descriptionSale': await this._t('With three feet'),
            }, {
                'image512': '/product/static/img/product_product_27-image.png',
                'displayName': await this._t('Drawer'),
                'descriptionSale': await this._t('On wheels'),
            }, {
                'image512': '/product/static/img/product_product_7-image.png',
                'displayName': await this._t('Box'),
                'descriptionSale': await this._t('Reinforced for heavy loads'),
            }, {
                'image512': '/product/static/img/product_product_9-image.png',
                'displayName': await this._t('Bin'),
                'descriptionSale': await this._t('Pedal-based opening system'),
            }];
            const merged = []
            for (const index of range(0, Math.max(len(samples), len(data)))) {
                merged.push({...samples[index % len(samples)], ...data[index % len(data)]});
                // merge definitions
            }
            samples = merged;
        }
        return samples;
    }

    async _filterRecordsToValues(records, isSample=false) {
        const resProducts = await _super(WebsiteSnippetFilter, this)._filterRecordsToValues(records, isSample);
        if (await this['modelName'] === 'product.product') {
            for (const resProduct of resProducts) {
                const product = resProduct['_record'];
                if (! isSample) {
                    update(resProduct, await product._getCombinationInfoVariant());
                    if (records.env.context['add2cartRerender']) {
                        resProduct['_add2cartRerender'] = true;
                    }
                }
            }
        }
        return resProducts;
    }

    @api.model()
    async _getProducts(mode, context) {
        const handler = this[f('_getProducts%s', UpCamelCase(mode))] ?? this._getProductsLatestSold;
        const website = await this.env.items('website').getCurrentWebsite();
        const {dynamicFilter, searchDomain, limit} = context;
        const domain = expression.AND([
            [['websitePublished', '=', true]],
            await website.websiteDomain(),
            [['companyId', 'in', [false, (await website.companyId).id]]],
            searchDomain || [],
        ])
        const products = await handler.call(this, website, limit, domain, context);
        return dynamicFilter._filterRecordsToValues(products, false);
    }

    async _getProductsLatestSold(website, limit, domain, context) {
        let products = [];
        const saleOrders = await (await this.env.items('sale.order').sudo()).search([
            ['websiteId', '=', website.id],
            ['state', 'in', ['sale', 'done']],
        ], {limit: 8, order: 'dateOrder DESC'});
        if (bool(saleOrders)) {
            const soldProducts = await (await saleOrders.orderLine).map(async (p) => (await p.productId).id);
            const productsIds = (new Counter(soldProducts)).mostCommon().map(([id]) => id);
            if (productsIds.length) {
                domain = expression.AND([
                    domain,
                    [['id', 'in', productsIds]],
                ]);
                products = await (await this.env.items('product.product').withContext({displayDefaultCode: false})).search(domain);
                products = sorted(products, p => productsIds.indexOf(p.id)).slice(0, limit);
            }
        }
        return products;
    }

    async _getProductsLatestViewed(website, limit, domain, context) {
        let products = [];
        const visitor = await this.env.items('website.visitor')._getVisitorFromRequest();
        if (bool(visitor)) {
            const excludedProducts = (await (await (await website.saleGetOrder()).orderLine).productId).ids;
            const trackedProducts = await (await this.env.items('website.track').sudo()).readGroup(
                [['visitorId', '=', visitor.id], ['productId', '!=', false], ['productId.websitePublished', '=', true], ['productId', 'not in', excludedProducts]],
                ['productId', 'visit_datetime:max'], ['productId'], {limit, orderby: 'visitDatetime DESC'});
            const productsIds = trackedProducts.map(product => product['productId'][0]);
            if (bool(productsIds)) {
                domain = expression.AND([
                    domain,
                    [['id', 'in', productsIds]],
                ]);
                products = await (await this.env.items('product.product').withContext({displayDefaultCode: false, add2cartRerender: true})).search(domain, {limit});
            }
        }
        return products;
    }

    async _getProductsRecentlySoldWith(website, limit, domain, context) {
        let products = [];
        let currentId = context['productTemplateId'];
        if (currentId) {
            currentId = parseInt(currentId);
            const saleOrders = await (await this.env.items('sale.order').sudo()).search([
                ['websiteId', '=', website.id],
                ['state', 'in', ['sale', 'done']],
                ['orderLine.productId.productTemplateId', '=', currentId],
            ], {limit: 8, order: 'dateOrder DESC'});
            if (bool(saleOrders)) {
                const currentTemplate = this.env.items('product.template').browse(currentId);
                const excludedProducts = (await (await (await (await (await website.saleGetOrder()).orderLine).productId).productTemplateId).productVariantIds).ids;
                extend(excludedProducts, (await currentTemplate.productVariantIds).ids);
                const includedProducts = [];
                for (const saleOrder of saleOrders) {
                    extend(includedProducts, (await (await saleOrder.orderLine).productId).ids);
                }
                const productsIds = _.difference(includedProducts, excludedProducts);
                if (productsIds.length) {
                    domain = expression.AND([
                        domain,
                        [['id', 'in', productsIds]],
                    ]);
                    products = await (await this.env.items('product.product').withContext({displayDefaultCode: false})).search(domain, {limit});
                }
            }
        }
        return products;
    }

    async _getProductsAccessories(website, limit, domain, context) {
        let products = [];
        let currentId = context['productTemplateId'];
        if (currentId) {
            currentId = parseInt(currentId);
            const currentTemplate = this.env.items('product.template').browse(currentId);
            if (bool(await currentTemplate.exists())) {
                const excludedProducts = (await (await (await website.saleGetOrder()).orderLine).productId).ids;
                extend(excludedProducts, (await currentTemplate.productVariantIds).ids);
                const includedProducts = (await currentTemplate._getWebsiteAccessoryProduct()).ids;
                const productsIds = _.difference(includedProducts, excludedProducts);
                if (productsIds.length) {
                    domain = expression.AND([
                        domain,
                        [['id', 'in', productsIds]],
                    ]);
                    products = await (await this.env.items('product.product').withContext({displayDefaultCode: false})).search(domain, {limit});
                }
            }
        }
        return products;
    }
}
