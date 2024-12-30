import { _Date, Command, http } from "../../../core"
import { nl2br } from "../../../core/addons/base";
import { setdefault } from "../../../core/api";
import { Forbidden, NotFound } from "../../../core/service";
import { _t, bool, equal, f, floatCompare, floatRound, isInstance, jsonParse, len, parseFloat, parseInt, pop, range, setOptions, singleEmailRe, slug, sorted, stringify, update } from "../../../core/tools";
import { sitemapQs2dom } from "../../website/models";

import * as website from "../../website/controllers";
import * as payment from '../../payment/controllers';
import { AccessError, MapKey, MissingError, ValidationError, ValueError } from "../../../core/helper";
import { PaymentPostProcessing } from "../../payment/controllers/post_processing";
import { expression } from "../../../core/osv";
import { urlEncode, urlParse } from "../../../core/service/middleware/utils";
import _ from "lodash";
import assert from "assert";
import { buildUrlWParams } from "../../portal";
import { WebRequest } from "../../../core/http";

class TableCompute {
    table: {}

    constructor() {
        this.table = {}
    }

    _checkPlace(posx, posy, sizex, sizey, ppr) {
        let res = true;
        for (const y of range(sizey)) {
            for (const x of range(sizex)) {
                if (posx + x >= ppr) {
                    res = false;
                    break;
                }
                const row = setdefault(this.table, posy + y, {});
                if (setdefault(row, posx + x) != null) {
                    res = false;
                    break;
                }
            }
            for (const x of range(ppr)) {
                setdefault(this.table[posy + y], x, null);
            }
        }
        return res;
    }

    async _process(products, ppg=20, ppr=4) {
        // Compute products positions on the grid
        let minpos = 0,
        index = 0,
        maxy = 0,
        x = 0;
        for (const p of products) {
            x = Math.min(Math.max(await p.websiteSizeX, 1), ppr);
            let y = Math.min(Math.max(await p.websiteSizeY, 1), ppr);
            if (index >= ppg) {
                x = y = 1;
            }

            let pos = minpos;
            while (! this._checkPlace(pos % ppr, Math.floor(pos / ppr), x, y, ppr)) {
                pos += 1;
            }
            // if 21st products (index 20) and the last line is full (ppr products in it), break
            // (pos + 1.0) / ppr is the line where the product would be inserted
            // maxy is the number of existing lines
            // + 1.0 is because pos begins at 0, thus pos 20 is actually the 21st block
            // and to force to not round the division operation
            if (index >= ppg && Math.floor((pos + 1.0) / ppr) > maxy) {
                break;
            }

            if (x == 1 && y == 1) {   // simple heuristic for CPU optimization
                minpos = Math.floor(pos / ppr);
            }

            for (const y2 of range(y)) {
                for (const x2 of range(x)) {
                    this.table[Math.floor(pos / ppr) + y2][(pos % ppr) + x2] = false;
                }
            }
            this.table[Math.floor(pos / ppr)][pos % ppr] = {
                'product': p, 'x': x, 'y': y,
                'ribbon': await p._getWebsiteRibbon(),
            }
            if (index <= ppg) {
                maxy = Math.max(maxy, y + Math.floor(pos / ppr));
            }
            index += 1;
        }
        // Format table according to HTML needs
        let rows = sorted(Object.entries(this.table));
        rows = rows.map(r => r[1]);
        for (const col of range(rows.length)) {
            const cols = sorted(Object.entries(rows[col]));
            x += cols.length;
            rows[col] = cols.filter(r => r[1]).map(r => r[1]);
        }
        return rows;
    }
}

@http.define()
class WebsiteSaleForm extends website.WebsiteForm {
    static _module = module;

    @http.route('/website/form/shop.sale.order', {type: 'http', auth: "public", methods: ['POST'], website: true})
    async websiteFormSaleorder(req, res, opts:{}={}) {
        const modelRecord = await (await req.getEnv()).ref('sale.modelSaleOrder');
        let data;
        try {
            data = await this.extractData(req, modelRecord, opts);
        } catch(e) {
            return stringify({'errorFields': e.message});
        }

        const order = await req.website.saleGetOrder();
        if (bool(data['record'])) {
            await order.write(data['record']);
        }
        if (bool(data['custom'])) {
            const values = {
                'body': nl2br(data['custom']),
                'model': 'sale.order',
                'messageType': 'comment',
                'resId': order.id,
            }
            await (await (await req.getEnv()).items('mail.message').withUser(global.SUPERUSER_ID)).create(values);
        }
        if (bool(data['attachments'])) {
            await this.insertAttachment(req, modelRecord, order.id, data['attachments']);
        }
        return stringify({'id': order.id});
    }
}

@http.define()
class Website extends website.Website {
    static _module = module;

    @http.route()
    async autocomplete(req, res, opts: {searchType?: any, term?: any, order?: any, limit?: any, maxNbChars?: any, options?: any}={}) {
        setOptions(opts, {limit: 5, maxNbChars: 999, options: {}});
        if (!('displayCurrency' in opts.options)) {
            opts.options['displayCurrency'] = await (await req.website.getCurrentPricelist(req)).currencyId;
        }
        return super.autocomplete(req, res, opts);
    }

    @http.route()
    async getSwitchableRelatedViews(req, res, opts: {key?: any}={}) {
        let views = await super.getSwitchableRelatedViews(req, res, opts);
        if (opts.key === 'website_sale.product') {
            if (! await (await (await req.getEnv()).user()).hasGroup('product.groupProductVariant')) {
                const viewProductVariants = await req.website.viewref('website_sale.productVariants');
                views = await views.filter(v => v['id'] != viewProductVariants.id);
            }
        }
        return views;
    }

    @http.route()
    async toggleSwitchableView(req, res, opts: {viewKey?: any}={}): Promise<any> {
        await super.toggleSwitchableView(req, res, opts);
        if (['website_sale.productsListView', 'website_sale.addGridOrListOption'].includes(opts.viewKey)) {
            req.session.pop('websiteSaleShopLayoutMode', null);
        }
    }

    @http.route()
    async getCurrentCurrency(req, res, opts: {}={}) {
        const currency = await req.website.currencyId;
        return {
            'id': currency.id,
            'symbol': await currency.symbol,
            'position': await currency.position,
        }
    }
}

@http.define()
class WebsiteSale extends http.Controller {
    static _module = module;

    async _getPricelistContext(req) {
        const env =  await req.getEnv();
        const pricelistContext = Object.assign({}, env.context);
        let pricelist: any = false;
        if (! pricelistContext['pricelist']) {
            pricelist = await req.website.getCurrentPricelist(req);
            pricelistContext['pricelist'] = pricelist.id;
        }
        else {
            pricelist = env.items('product.pricelist').browse(pricelistContext['pricelist']);
        }
        return [pricelistContext, pricelist];
    }

    _getSearchOrder(order) {
        // OrderBy will be parsed in orm and so no direct sql injection
        // id is added to be sure that order is a unique sort key
        order = order || 'websiteSequence ASC';
        return f('isPublished desc, %s, id desc', order);
    }

    async _getSearchDomain(req, search, category, attribValues, searchInDescription: any=true) {
        let domains = [await req.website.saleProductDomain()];
        if (search) {
            for (const srch of search.split(" ")) {
                const subdomains = [
                    [['label', 'ilike', srch]],
                    [['productVariantIds.defaultCode', 'ilike', srch]]
                ]
                if (searchInDescription) {
                    subdomains.push([['description', 'ilike', srch]]);
                    subdomains.push([['descriptionSale', 'ilike', srch]]);
                }
                domains.push(expression.OR(subdomains));
            }
        }

        if (category) {
            domains.push([['publicCategIds', 'childOf', parseInt(category)]]);
        }

        if (attribValues) {
            let attrib,
            ids = [];
            for (const value of attribValues) {
                if (!bool(attrib)) {
                    attrib = value[0];
                    ids.push(value[1]);
                }
                else if (value[0] == attrib) {
                    ids.push(value[1]);
                }
                else {
                    domains.push([['attributeLineIds.valueIds', 'in', ids]]);
                    attrib = value[0];
                    ids = [value[1]];
                }
            }
            if (bool(attrib)) {
                domains.push([['attributeLineIds.valueIds', 'in', ids]]);
            }
        }
        return expression.AND(domains)
    }

    static async* sitemapShop(env, rule, qs: string) {
        if (! qs || '/shop'.includes(qs.toLowerCase())) {
            yield {'loc': '/shop'}
        }

        const category = env.items('product.public.category');
        let dom = sitemapQs2dom(qs, '/shop/category', category.cls._recName);
        dom = dom.concat(await (await env.items('website').getCurrentWebsite()).websiteDomain());
        for (const cat of await category.search(dom)) {
            const loc = f('/shop/category/%s', slug([cat.id, await cat.seoName || await cat.displayName]));
            if (! qs || loc.includes(qs.toLowerCase())) {
                yield {'loc': loc}
            }
        }
    }

    async _getSearchOptions(post: {
        category?: any, attribValues?: any, pricelist?: any, minPrice?: number, maxPrice?: number, conversionRate?: number
    }={}) {
        setOptions(post, {minPrice: 0.0, maxPrice: 0.0, conversionRate: 1});
        return {
            'displayDescription': true,
            'displayDetail': true,
            'displayExtraDetail': true,
            'displayExtraLink': true,
            'displayImage': true,
            'allowFuzzy': ! post['noFuzzy'],
            'category': bool(post.category) ? String(post.category.id) : null,
            'minPrice': post.minPrice / post.conversionRate,
            'maxPrice': post.maxPrice / post.conversionRate,
            'attribValues': post.attribValues,
            'displayCurrency': await post.pricelist.currencyId,
        }
    }

    /**
     * Hook to update values used for rendering website_sale.products template
     * @param values 
     * @returns 
     */
    async _getAdditionalShopValues(values) {
        return {}
    }

    @http.route([
        '/shop',
        '/shop/page/<int:page>',
        '/shop/category/<model("product.public.category"):category>',
        '/shop/category/<model("product.public.category"):category>/page/<int:page>'
    ], {type: 'http', auth: "public", website: true, sitemap: WebsiteSale.sitemapShop})
    async shop(req, res, post: {page?: any, category?: any, search?: any, minPrice?: any, maxPrice?: any, ppg?: any, order?: any}={}) {
        setOptions(post, {page: 0, search: '', minPrice: 0.0, maxPrice: 0.0, ppg: false});
        let {page, category, search, minPrice, maxPrice, ppg, order} = post;
        const addQty = parseInt(post['addQty'] ?? 1);
        try {
            minPrice = parseFloat(minPrice);
        } catch(e) {
            minPrice = 0;
        }
        try {
            maxPrice = parseFloat(maxPrice);
        } catch(e) {
            maxPrice = 0;
        }
        const env = await req.getEnv();
        const Category = env.items('product.public.category');
        if (bool(category)) {
            category = await Category.search([['id', '=', parseInt(category)]], {limit: 1});
            if (!category || ! await category.canAccessFromCurrentWebsite()) {
                throw new NotFound(res);
            }
        }
        else {
            category = Category;
        }
        if (ppg) {
            try {
                ppg = parseInt(ppg);
                post['ppg'] = ppg;
            } catch(e) {
                ppg = false;
            }
        }
        if (! ppg) {
            ppg = await (await env.items('website').getCurrentWebsite()).shopPpg || 20;
        }
        const ppr = await (await env.items('website').getCurrentWebsite()).shopPpr || 4;

        const attrib = req.httpRequest.params.getlist('attrib');
        const attribValues = attrib.filter(v => bool(v)).map(v => v.split('-').map(x => parseInt(x)));
        const attributesIds = attribValues.map(v => v[0]);
        const attribSet = attribValues.map(v => v[1]);

        const keep = new website.QueryURL('/shop', {category: bool(category) && parseInt(category), search, attrib, minPrice, maxPrice, order});

        const [pricelistContext, pricelist] = await this._getPricelistContext(req);

        req.context = Object.assign({}, req.context, {pricelist: pricelist.id, partner: await (await env.user()).partnerId});

        let filterByPriceEnabled = await req.website.isViewActive('website_sale.filterProductsPrice');
        let conversionRate;
        if (filterByPriceEnabled) {
            const companyCurrency = await (await req.website.companyId).currencyId;
            conversionRate = await env.items('res.currency')._getConversionRate(companyCurrency, await pricelist.currencyId, await req.website.companyId, _Date.today());
        }
        else {
            conversionRate = 1;
        }

        let url = "/shop";
        if (search) {
            post["search"] = search;
        }
        if (attrib) {
            post['attrib'] = attrib
        }
        const options = await this._getSearchOptions({
            category: category,
            attribValues: attribValues,
            pricelist: pricelist,
            minPrice: minPrice,
            maxPrice: maxPrice,
            conversionRate: conversionRate,
            ...post
        });
        // No limit because attributes are obtained from complete product list
        const [productCount, details, fuzzySearchTerm] = await req.website._searchWithFuzzy("productsOnly", search,
            null, this._getSearchOrder(post['order']), options);
        const searchProduct = await (details[0]['results'] ?? env.items('product.template')).withContext({binSize: true});

        filterByPriceEnabled = await req.website.isViewActive('website_sale.filterProductsPrice');
        let availableMinPrice, availableMaxPrice;
        if (filterByPriceEnabled) {
            // TODO Find an alternative way to obtain the domain through the search metadata.
            const Product = await env.items('product.template').withContext({binSize: true});
            const domain = await this._getSearchDomain(req, search, category, attribValues);

            // This is ~4 times more efficient than a search for the cheapest and most expensive products
            const [fromClause, whereClause, whereParams] = await (await Product._whereCalc(domain)).getSql();
            const query = `
                SELECT COALESCE(MIN("listPrice"), 0) * ${conversionRate} AS "availableMinPrice", COALESCE(MAX("listPrice"), 0) * ${conversionRate} AS "availableMaxPrice"
                  FROM ${fromClause}
                 WHERE ${whereClause}
            `;
            const result = await env.cr.execute(query, whereParams);
            availableMinPrice = result[0]['availableMinPrice']
            availableMaxPrice = result[0]['availableMaxPrice'];

            if (minPrice || maxPrice) {
                // The if/else condition in the minPrice / maxPrice value assignment
                // tackles the case where we switch to a list of products with different
                // available min / max prices than the ones set in the previous page.
                // In order to have logical results and not yield empty product lists, the
                // price filter is set to their respective available prices when the specified
                // min exceeds the max, and / or the specified max is lower than the available min.
                if (minPrice) {
                    minPrice = minPrice <= availableMaxPrice ? minPrice : availableMinPrice;
                    post['minPrice'] = minPrice;
                }
                if (maxPrice){
                    maxPrice = maxPrice >= availableMinPrice ? maxPrice : availableMaxPrice;
                    post['maxPrice'] = maxPrice;
                }
            }
        }
        const websiteDomain = await req.website.websiteDomain();
        const categsDomain = [['parentId', '=', false]].concat(websiteDomain);
        let searchCategories;
        if (search) {
            searchCategories = await Category.search([['productTemplateIds', 'in', searchProduct.ids]].concat(websiteDomain)).parentsAndSelf;
            categsDomain.push(['id', 'in', searchCategories.ids]);
        }
        else {
            searchCategories = Category;
        }
        const categs = await Category.search(categsDomain);

        if (bool(category)) {
            url = f("/shop/category/%s", slug([category.id, await category.seoName || await category.displayName]));
        }
        const pager = await req.website.pager({url: url, total: productCount, page: page, step: ppg, scope: 7, urlArgs: post});
        const offset = pager['offset'];
        const products = searchProduct.slice(offset, offset + ppg);

        let attributes;
        const ProductAttribute = env.items('product.attribute');
        if (bool(products)) {
            // get all products without limit
            attributes = await ProductAttribute.search([
                ['productTemplateIds', 'in', searchProduct.ids],
                ['visibility', '=', 'visible'],
            ]);
        }
        else {
            attributes = ProductAttribute.browse(attributesIds);
        }
        let layoutMode = req.session.get('websiteSaleShopLayoutMode');
        if (! layoutMode) {
            if (await (await req.website.viewref('website_sale.productsListView')).active) {
                layoutMode = 'list';
            }
            else {
                layoutMode = 'grid';
            }
        }

        const values = {
            'search': fuzzySearchTerm || search,
            'original_search': fuzzySearchTerm || search,
            'order': post['order'] ?? '',
            'category': category,
            'attribValues': attribValues,
            'attribSet': attribSet,
            'pager': pager,
            'pricelist': pricelist,
            'addQty': addQty,
            'products': products,
            'searchProduct': searchProduct,
            'searchCount': productCount,  // common for all searchbox
            'bins': await (new TableCompute())._process(products, ppg, ppr),
            'ppg': ppg,
            'ppr': ppr,
            'categories': categs,
            'attributes': attributes,
            'keep': keep,
            'searchCategoriesIds': searchCategories.ids,
            'layoutMode': layoutMode,
        }
        if (filterByPriceEnabled) {
            values['minPrice'] = minPrice || availableMinPrice;
            values['maxPrice'] = maxPrice || availableMaxPrice;
            values['availableMinPrice'] = floatRound(availableMinPrice, {precisionDigits: 2});
            values['availableMaxPrice'] = floatRound(availableMaxPrice, {precisionDigits: 2});
        }
        if (bool(category)) {
            values['mainObject'] = category;
        }
        update(values, await this._getAdditionalShopValues(values));
        return req.render(res, "website_sale.products", values);
    }

    @http.route(['/shop/<model("product.template"):product>'], {type: 'http', auth: "public", website: true, sitemap: true, fields: {product: ['id', 'env', 'label', 'seoName', 'displayName']}})
    async product(req, res, opts: {product?: any, category?: any, search?: any}={}) {
        setOptions(opts, {category: '', search: ''});
        return req.render(res, "website_sale.product", await this._prepareProductValues(req, opts.product, opts.category, opts.search, opts));
    }

    @http.route(['/shop/product/<model("product.template"):product>'], {type: 'http', auth: "public", website: true, sitemap: false})
    async oldProduct(req, res, opts: {product?: any, category?: any, search?: any}={}) {
        setOptions(opts, {category: '', search: ''});
        return req.redirect(res, buildUrlWParams(f("/shop/%s", slug([opts.product.id, await opts.product.seoName || await opts.product.displayName]), req.params), {code: 301}));
    }

    async _prepareProductValues(req, product, category, search, opts) {
        const addQty = parseInt(opts['addQty'] ?? 1);
        const env = await req.getEnv();
        const productContext = Object.assign({}, env.context, {quantity: addQty,
                               activeId: product.id,
                               partner: await (await env.user()).partnerId});
        const ProductCategory = env.items('product.public.category');

        if (category) {
            category = await ProductCategory.browse(parseInt(category)).exists();
        }
        const attrib = req.httpRequest.params.getlist('attrib'),
        minPrice = req.params.get('minPrice'),
        maxPrice = req.params.get('maxPrice');
        const attribValues = attrib.filter(v => bool(v)).map(v => v.split("-").map(x => parseInt(x)));
        const attribSet = attribValues.map(v => v[1]);

        const keep = new website.QueryURL('/shop', {category: bool(category) && category.id, search, attrib, minPrice, maxPrice});

        const categs = await ProductCategory.search([['parentId', '=', false]]);

        const pricelist = await req.website.getCurrentPricelist(req);

        if (! productContext['pricelist']) {
            productContext['pricelist'] = pricelist.id;
            product = await product.withContext(productContext);
        }
        // Needed to trigger the recently viewed product rpc
        const viewTrack = await (await req.website.viewref("website_sale.product")).track;

        return {
            'search': search,
            'category': category,
            'pricelist': pricelist,
            'attribValues': attribValues,
            'attribSet': attribSet,
            'keep': keep,
            'categories': categs,
            'mainObject': product,
            'product': product,
            'addQty': addQty,
            'viewTrack': viewTrack,
        }
    }

    @http.route(['/shop/changePricelist/<model("product.pricelist"):plId>'], {type: 'http', auth: "public", website: true, sitemap: false})
    async pricelistChange(req, res, post: {plId?: any}={}) {
        let redirectUrl = req.httpRequest.referrer;
        const env = await res.getEnv();
        if ((post.plId.selectable || post.plId == await (await (await env.user()).partnerId).propertyProductPricelist) 
                && await req.website.isPricelistAvailable(post.plId.id)) {
            if (redirectUrl && await req.website.isViewActive('website_sale.filterProductsPrice')) {
                const decodedUrl = urlParse(redirectUrl),
                args = decodedUrl.searchQuery;
                let minPrice = args.get('minPrice'),
                maxPrice = args.get('maxPrice');
                if (minPrice || maxPrice) {
                    const previousPriceList = await req.website.getCurrentPricelist(req);
                    try {
                        minPrice = parseFloat(minPrice);
                        args['minPrice'] = minPrice && String(
                            await (await previousPriceList.currencyId)._convert(minPrice, await post.plId.currencyId, await req.website.companyId, _Date.today(), false)
                        );
                    } catch(e) {
                        if (!isInstance(e, ValueError, TypeError)) {
                            throw e;
                        }
                    }
                    try {
                        maxPrice = parseFloat(maxPrice);
                        args['maxPrice'] = maxPrice && String(
                            await (await previousPriceList.currencyId)._convert(maxPrice, await post.plId.currencyId, await req.website.companyId, _Date.today(), false)
                        );
                    } catch(e) {
                        if (!isInstance(e, ValueError, TypeError)) {
                            throw e;
                        }
                    }
                    decodedUrl.search = urlEncode(args);
                    redirectUrl = decodedUrl.toString();
                }
            }
            req.session['websiteSaleCurrentPl'] = post.plId.id;
            await req.website.saleGetOrder({forcePricelist: post.plId.id});
        }
        return req.redirect(res, redirectUrl || '/shop');
    }

    @http.route(['/shop/pricelist'], {type: 'http', auth: "public", website: true, sitemap: false})
    async pricelist(req, res, post: {promo?: any}={}) {
        const redirect = post['r'] ?? '/shop/cart';
        // empty promo code is used to reset/remove pricelist (see `sale_get_order()`)
        if (post.promo) {
            const pricelist = await (await (await req.getEnv()).items('product.pricelist').sudo()).search([['code', '=', post.promo]], {limit: 1});
            if (!bool(pricelist) || (bool(pricelist) && ! await req.website.isPricelistAvailable(pricelist.id))) {
                return req.redirect(f("%s?codeNotAvailable=1", redirect));
            }
        }
        await req.website.saleGetOrder({code: post.promo});
        return req.redirect(res, redirect);
    }

    /**
     * Main cart management + abandoned cart revival
        accessToken: Abandoned cart SO access token
        revive: Revival method when abandoned cart. Can be 'merge' or 'squash'
     * @param req 
     * @param res 
     * @param post 
     * @returns 
     */
    @http.route(['/shop/cart'], {type: 'http', auth: "public", website: true, sitemap: false})
    async cart(req, res, post: {accessToken?: any, revive?: string}={}) {
        let order = await req.website.saleGetOrder();
        if (bool(order) && await order.state !== 'draft') {
            req.session['saleOrderId'] = null;
            order = await req.website.saleGetOrder();
        }
        const values = {};
        if (post.accessToken) {
            const abandonedOrder = await (await (await req.getEnv()).items('sale.order').sudo()).search([['accessToken', '=', post.accessToken]], {limit: 1});
            if (!bool(abandonedOrder)) {  // wrong token (or SO has been deleted)
                throw new NotFound(res);
            }
            if (await abandonedOrder.state !== 'draft') {  // abandoned cart already finished
                update(values, {'abandonedProceed': true});
            }
            else if (post.revive === 'squash' || (post.revive === 'merge' && ! req.session.get('saleOrderId'))) {  // restore old cart or merge with unexistant
                req.session['saleOrderId'] = abandonedOrder.id;
                return req.redirect(res, '/shop/cart');
            }
            else if (post.revive === 'merge') {
                await (await abandonedOrder.orderLine).write({'orderId': req.session['saleOrderId']});
                await abandonedOrder.actionCancel();
            }
            else if (abandonedOrder.id != req.session['saleOrderId']) {  // abandoned cart found, user have to choose what to do
                update(values, {'accessToken': await abandonedOrder.accessToken});
            }
        }
        update(values, {
            'websiteSaleOrder': order,
            'date': _Date.today(),
            'suggestedProducts': [],
        });
        if (bool(order)) {
            await (await (await order.orderLine).filtered(async (l) => ! await (await l.productId).active)).unlink();
            let _order = order;
            if (!(await req.getEnv()).context['pricelist']) {
                _order = await order.withContext({pricelist: (await order.pricelistId).id});
            }
            values['suggestedProducts'] = await _order._cartAccessories();
        }
        if (post['type'] == 'popover') {
            // force no-cache so IE11 doesn't cache this XHR
            return req.render(res, "website_sale.cartPopover", values, {headers: {'Cache-Control': 'no-cache'}});
        }
        return req.render(res, "website_sale.cart", values);
    }

    /**
     * This route is called when adding a product to cart (no options).
     * @param req 
     * @param res 
     * @param post 
     * @returns 
     */
    @http.route(['/shop/cart/update'], {type: 'http', auth: "public", methods: ['POST'], website: true})
    async cartUpdate(req, res, post: {productId?: any, addQty?: any, setQty?: any}={}) {
        setOptions(post, {addQty: 1, setQty: 0});
        let saleOrder = await req.website.saleGetOrder({forceCreate: true});
        if (await saleOrder.state !== 'draft') {
            req.session['saleOrderId'] = null;
            saleOrder = await req.website.saleGetOrder({forceCreate: true});
        }
        let productCustomAttributeValues;
        if (post['productCustomAttributeValues']) {
            productCustomAttributeValues = jsonParse(post['productCustomAttributeValues']);
        }
        let noVariantAttributeValues;
        if (post['noVariantAttributeValues']) {
            noVariantAttributeValues = jsonParse(post['noVariantAttributeValues']);
        }
        await saleOrder._cartUpdate({
            productId: parseInt(post.productId),
            addQty: post.addQty,
            setQty: post.setQty,
            productCustomAttributeValues: productCustomAttributeValues,
            noVariantAttributeValues: noVariantAttributeValues
        });

        if (post['express']) {
            return req.redirect(res, "/shop/checkout?express=1");
        }
        return req.redirect(res, "/shop/cart");
    }

    /**
     * This route is called :
            - When changing quantity from the cart.
            - When adding a product from the wishlist.
            - When adding a product to cart on the same page (without redirection).
     * @param req 
     * @param res 
     * @param opts 
     * @returns 
     */
    @http.route(['/shop/cart/updateJson'], {type: 'json', auth: "public", methods: ['POST'], website: true, csrf: false})
    async cartUpdateJson(req, res, opts: {productId?: any, lineId?: any, addQty?: any, setQty?: any, display?: any}={}) {
        setOptions(opts, {display: true});
        let order = await req.website.saleGetOrder({forceCreate: 1});
        if (await order.state !== 'draft') {
            await req.website.saleReset();
            if (opts['forceCreate']) {
                order = await req.website.saleGetOrder({forceCreate: 1});
            }
            else {
                return {};
            }
        }
        const pcav = opts['productCustomAttributeValues'],
        nvav = opts['noVariantAttributeValues'],
        value = await order._cartUpdate({
            productId: opts.productId,
            lineId: opts.lineId,
            addQty: opts.addQty,
            setQty: opts.setQty,
            productCustomAttributeValues: pcav ? jsonParse(pcav) : null,
            noVariantAttributeValues: nvav ? jsonParse(nvav) : null
        });

        if (! await order.cartQuantity) {
            await req.website.saleReset();
            return value;
        }

        order = await req.website.saleGetOrder();
        value['cartQuantity'] = await order.cartQuantity;

        if (! opts.display) {
            return value;
        }

        const env = await req.getEnv();
        value['website_sale.cartLines'] = await env.items('ir.ui.view')._renderTemplate("website_sale.cartLines", {
            'websiteSaleOrder': order,
            'date': _Date.today(),
            'suggestedProducts': await order._cartAccessories()
        });
        value['website_sale.shortCartSummary'] = await env.items('ir.ui.view')._renderTemplate("website_sale.shortCartSummary", {
            'websiteSaleOrder': order,
        });
        return value;
    }

    @http.route('/shop/saveShopLayoutMode', {type: 'json', auth: 'public', website: true})
    async saveShopLayoutMode(req, res, opts: {layoutMode?: any}={}) {
        assert(['grid', 'list'].includes(opts.layoutMode), "Invalid shop layout mode");
        req.session['websiteSaleShopLayoutMode'] = opts.layoutMode;
    }

    // ------------------------------------------------------
    // Checkout
    // ------------------------------------------------------

    async checkoutCheckAddress(req, res, order) {
        const partner = await order.partnerId;
        const billingFieldsRequired = await this._getMandatoryFieldsBilling((await partner.countryId).id);
        if (!(Object.values(await partner.readOne(billingFieldsRequired)).every(v => bool(v)))) {
            return req.redirect(res, f('/shop/address?partnerId=%d', partner.id));
        }
        const shipping = await order.partnerShippingId;
        const shippingFieldsRequired = await this._getMandatoryFieldsShipping((await shipping.countryId).id);
        if (!Object.values(await shipping.readOne(shippingFieldsRequired)).every(v => bool(v))) {
            return req.redirect(res, f('/shop/address?partnerId=%d', shipping.id));
        }
    }

    async checkoutRedirection(req, res, order) {
        // must have a draft sales order with lines at this point, otherwise reset
        if (!bool(order) || await order.state !== 'draft') {
            req.session['saleOrderId'] = null;
            req.session['saleTransactionId'] = null;
            return req.redirect(res, '/shop');
        }

        if (bool(order) && !bool(await order.orderLine)) {
            return req.redirect(res, '/shop/cart');
        }

        // if transaction pending / done: redirect to confirmation
        const tx = (await req.getEnv()).context['websiteSaleTransaction'];
        if (bool(tx) && await tx.state !== 'draft') {
            return req.redirect(res, f('/shop/payment/confirmation/%s', order.id));
        }
    }

    async checkoutValues(req, opts) {
        const order = await req.website.saleGetOrder({forceCreate: 1});
        let shippings: any = [];
        const orderPartner = await order.partnerId;
        if (orderPartner.ne(await (await (await req.website.userId).sudo()).partnerId)) {
            const Partner = await (await orderPartner.withContext({showAddress: 1})).sudo();
            shippings = await Partner.search([
                ["id", "childOf", (await orderPartner.commercialPartnerId).ids],
                '|', ["type", "in", ["delivery", "other"]], ["id", "=", (await orderPartner.commercialPartnerId).id]
            ], {order: 'id desc'});
            if (bool(shippings)) {
                if (opts['partnerId'] || 'useBilling' in opts) {
                    let partnerId;
                    if ('useBilling' in opts) {
                        partnerId = orderPartner.id;
                    }
                    else {
                        partnerId = parseInt(opts['partnerId']);
                    }
                    if ((await shippings.mapped('id')).includes(partnerId)) {
                        await order.set('partnerShippingId', partnerId);
                    }
                }
            }
        }
        return {
            'order': order,
            'shippings': shippings,
            'onlyServices': bool(order) && await order.onlyServices || false
        }
    }

    async _getMandatoryFieldsBilling(req, countryId: any=false) {
        let result = ["label", "email", "street", "city", "countryId"];
        if (countryId) {
            const country = (await req.getEnv()).items('res.country').browse(countryId);
            if (await country.stateRequired) {
                result = result.concat(['stateId']);
            }
            if (await country.zipRequired) {
                result = result.concat(['zip']);
            }
        }
        return result;
    }

    async _getMandatoryFieldsShipping(req, countryId: any=false) {
        let result = ["label", "street", "city", "countryId"];
        if (countryId) {
            const country = (await req.getEnv()).items('res.country').browse(countryId);
            if (await country.stateRequired) {
                result = result.concat(['stateId']);
            }
            if (await country.zipRequired) {
                result = result.concat(['zip']);
            }
        }
        return result;
    }

    async checkoutFormValidate(req, mode, allFormValues, data) {
        // mode: tuple ('new|edit', 'billing|shipping')
        // allFormValues: all values before preprocess
        // data: values after preprocess
        const error = {},
        errorMessage = [];
        const env = await req.getEnv();

        if (data['partnerId']) {
            const partnerSu = await (await env.items('res.partner').sudo()).browse(parseInt(data['partnerId'])).exists();
            const nameChange = ('label' in data) && data['label'] != await partnerSu.label ? partnerSu : false;
            const emailChange = ('email' in data) && data['email'] != await partnerSu.email ? partnerSu : false;

            // Prevent changing the billing partner name if invoices have been issued.
            if (mode[1] === 'billing' && bool(nameChange) && ! await partnerSu.canEditVat()) {
                error['label'] = 'error';
                errorMessage.push(_t(env, 
                    "Changing your name is not allowed once documents have been issued for your account. Please contact us directly for this operation."
                ));
            }

            // Prevent change the partner name or email if it is an internal user.
            if ((bool(nameChange) || bool(emailChange)) && !await (await (await partnerSu.userIds).mapped('share')).every(v => bool(v))) {
                update(error, {
                    'label': bool(nameChange) ? 'error' : undefined,
                    'email': bool(emailChange) ? 'error' : undefined,
                })
                errorMessage.push(await this._t(env,
                    ["If you are ordering for an external person, please place your order via the",
                    " backend. If you wish to change your name or email address, please do so in",
                    " the account settings or contact your administrator."].join('')
                ));
            }
        }

        // Required fields from form
        let requiredFields = (allFormValues['fieldRequired'] || '').split(',').filter(f => bool(f));

        // Required fields from mandatory field function
        const countryId = parseInt(data['countryId'] ?? false);
        requiredFields = requiredFields.concat(mode[1] === 'shipping' && await this._getMandatoryFieldsShipping(req, countryId) || await this._getMandatoryFieldsBilling(req, countryId));

        // error message for empty required fields
        for (const fieldName of requiredFields) {
            let val = data[fieldName];
            if (typeof val === 'string') {
                val = val.trim();
            }
            if (! val) {
                error[fieldName] = 'missing';
            }
        }
        // email validation
        if (data['email'] && !data['email'].match(singleEmailRe)) {
            error["email"] = 'error';
            errorMessage.push(await this._t(env, 'Invalid Email! Please enter a valid email address.'));
        }
        // vat validation
        const Partner = env.items('res.partner');
        if (data["vat"] && ("checkVat" in Partner._fields)) {
            if (countryId) {
                data["vat"] = await Partner.fixEuVatNumber(countryId, data["vat"]);
            }
            const partnerDummy = await Partner.new(await this._getVatValidationFields(data));
            try {
                await partnerDummy.checkVat();
            } catch(e) {
                if (isInstance(e, ValidationError)) {
                    error["vat"] = 'error';
                    errorMessage.push(e.message);
                }
            }
        }
        if (Object.values(error).filter(err => err == 'missing').length) {
            errorMessage.push(await this._t(env, 'Some required fields are empty.'));
        }

        return [error, errorMessage];
    }

    async _getVatValidationFields(data) {
        return {
            'vat': data['vat'],
            'countryId': data['countryId'] ? parseInt(data['countryId']) : false,
        }
    }

    async _checkoutFormSave(req, mode, checkout, allValues) {
        const Partner = (await req.getEnv()).items('res.partner');
        let partnerId;
        if (mode[0] === 'new') {
            partnerId = (await (await (await Partner.sudo()).withContext({trackingDisable: true})).create(checkout)).id;
        }
        else if (mode[0] == 'edit') {
            partnerId = parseInt(allValues['partnerId'] || 0);
            if (partnerId) {
                // double check
                const order = await req.website.saleGetOrder();
                const shippings = await (await Partner.sudo()).search([["id", "childOf", (await (await order.partnerId).commercialPartnerId).ids]]);
                if (!(await shippings.mapped('id')).includes(partnerId) && partnerId != (await order.partnerId).id) {
                    return new Forbidden();
                }
                await (await Partner.browse(partnerId).sudo()).write(checkout);
            }
        }
        return partnerId;
    }

    async valuesPreprocess(req, order, mode, values) {
        const newValues = {};
        const partnerFields = (await req.getEnv()).models['res.partner']._fields;

        for (const [k, v] of Object.entries(values)) {
            // Convert the values for many2one fields to integer since they are used as IDs
            if (k in partnerFields && partnerFields[k].type == 'many2one') {
                newValues[k] = bool(v) && parseInt(v);
            }
            // Store empty fields as `False` instead of empty strings `''` for consistency with other applications like
            // Contacts.
            else if (v == '') {
                newValues[k] = false;
            }
            else {
                newValues[k] = v;
            }
        }
        return newValues;
    }

    async valuesPostprocess(req, order, mode, values, errors, errorMsg) {
        const newValues = {};
        const authorizedFields = await (await (await req.getEnv()).items('ir.model')._get('res.partner'))._getFormWritableFields();
        for (const [k, v] of Object.entries(values)) {
            // don't drop empty value, it could be a field to reset
            if (k in authorizedFields && v != null) {
                newValues[k] = v;
            }
            else {  // DEBUG ONLY
                if (!['fieldRequired', 'partnerId', 'callback', 'submitted'].includes(k)) { // classic case
                    console.debug("website_sale postprocess: %s value has been dropped (empty or not writable)", k);
                }
            }
        }
        if (await req.website.specificUserAccount) {
            newValues['websiteId'] = req.website.id;
        }
        if (mode[0] == 'new') {
            newValues['companyId'] = (await req.website.companyId).id;
            newValues['teamId'] = bool(await req.website.salesteamId) && (await req.website.salesteamId).id;
            newValues['userId'] = (await req.website.salespersonId).id;
        }

        const lang = (await req.website.mapped('languageIds.code')).includes(await req.lang.code) ? await req.lang.code : null;
        if (lang) {
            newValues['lang'] = lang;
        }
        if (equal(mode, ['edit', 'billing']) && await (await order.partnerId).type === 'contact') {
            newValues['type'] = 'other';
        }
        if (mode[1] === 'shipping'){
            newValues['parentId'] = (await (await order.partnerId).commercialPartnerId).id;
            newValues['type'] = 'delivery';
        }
        return [newValues, errors, errorMsg];
    }

    @http.route(['/shop/address'], {type: 'http', methods: ['GET', 'POST'], auth: "public", website: true, sitemap: false})
    async address(req, res, opts: {}={}) {
        const Partner = await (await (await req.getEnv()).items('res.partner').withContext({showAddress: 1})).sudo();
        const order = await req.website.saleGetOrder();

        const redirection = await this.checkoutRedirection(req, res, order);
        if (redirection) {
            return redirection;
        }

        let post, errorMsg, values, errors;
        let mode: any[] = [false, false];
        let canEditVat = false;
        
        [values, errors] = [{}, {}];

        let partnerId = parseInt(opts['partnerId'] ?? -1);
        const orderPartner = await order.partnerId;
        // IF PUBLIC ORDER
        if ((await order.partnerId).id == (await (await (await req.website.userId).sudo()).partnerId).id) {
            mode = ['new', 'billing'];
            canEditVat = true;
        }
        // IF ORDER LINKED TO A PARTNER
        else {
            if (partnerId > 0) {
                if (partnerId == orderPartner.id) {
                    mode = ['edit', 'billing'];
                    canEditVat = await orderPartner.canEditVat();
                }
                else {
                    const shippings = await Partner.search([['id', 'childOf', (await orderPartner.commercialPartnerId).ids]]);
                    if ((await orderPartner.commercialPartnerId).id == partnerId) {
                        mode = ['new', 'shipping'];
                        partnerId = -1;
                    }
                    else if ((await shippings.mapped('id')).includes(partnerId)) {
                        mode = ['edit', 'shipping'];
                    }
                    else {
                        return new Forbidden();
                    }
                }
                if (bool(mode) && partnerId != -1) {
                    values = Partner.browse(partnerId);
                }
            }
            else if (partnerId == -1) {
                mode = ['new', 'shipping'];
            }
            else { // no mode - refresh without post?
                return req.redirect(res, '/shop/checkout');
            }
        }
        // IF POSTED
        if ('submitted' in opts && req.httpRequest.method == "POST") {
            const preValues = await this.valuesPreprocess(req, order, mode, opts);
            [errors, errorMsg] = await this.checkoutFormValidate(req, mode, opts, preValues);
            [post, errors, errorMsg] = await this.valuesPostprocess(req, order, mode, preValues, errors, errorMsg);

            if (bool(errors)) {
                errors['errorMessage'] = errorMsg;
                values = opts;
            }
            else {
                const partnerId = await this._checkoutFormSave(req, mode, post, opts);
                // We need to validate _checkout_form_save return, because when partnerId not in shippings
                // it returns Forbidden() instead the partnerId
                if (isInstance(partnerId, Forbidden)) {
                    return partnerId;
                }
                if (mode[1] == 'billing') {
                    await order.set('partnerId', partnerId);
                    await (await order.withContext({notSelfSaleperson: true})).onchangePartnerId();
                    // This is the *only* thing that the front end user will see/edit anyway when choosing billing address
                    await order.set('partnerInvoiceId', partnerId);
                    if (! opts['useSame']) {
                        opts['callback'] = opts['callback'] || 
                            (! await order.onlyServices && (mode[0] == 'edit' && '/shop/checkout' || '/shop/address'));
                    }
                    // We need to update the pricelist(by the one selected by the customer), because onchange_partner reset it
                    // We only need to update the pricelist when it is not redirected to /confirm_order
                    if ((opts['callback'] ?? false) != '/shop/confirmOrder') {
                        await req.website.saleGetOrder({updatePricelist: true});
                    }
                }
                else if (mode[1] == 'shipping') {
                    await order.set('partnerShippingId', partnerId);
                }
                // TDE FIXME: don't ever do this
                // -> TDE: you are the guy that did what we should never do in commit e6f038a
                await order.set('messagePartnerIds', [[4, partnerId], [3, (await req.website.partnerId).id]]);
                if (!bool(errors)) {
                    return req.redirect(res, opts['callback'] || '/shop/confirmOrder');
                }
            }
        }
        const renderValues = {
            'websiteSaleOrder': order,
            'partnerId': partnerId,
            'mode': mode,
            'checkout': values,
            'canEditVat': canEditVat,
            'error': errors,
            'callback': opts['callback'],
            'onlyServices': bool(order) && await order.onlyServices,
        }
        update(renderValues, await this._getCountryRelatedRenderValues(req, opts, renderValues));
        return req.render(res, "website_sale.address", renderValues);
    }

    /**
     * This method provides fields related to the country to render the website sale form
     * @param req 
     * @param opts 
     * @param renderValues 
     * @returns 
     */
    async _getCountryRelatedRenderValues(req, opts, renderValues) {
        const values = renderValues['checkout'],
        mode = renderValues['mode'],
        order = renderValues['websiteSaleOrder'];

        let defCountryId = await (await order.partnerId).countryId;
        // IF PUBLIC ORDER
        if ((await order.partnerId).id == (await (await (await req.website.userId).sudo()).partnerId).id) {
            const countryCode = await req.session['geoip']['countryCode'];
            if (countryCode) {
                defCountryId = await (await req.getEnv()).items('res.country').search([['code', '=', countryCode]], {limit: 1});
            }
            else {
                defCountryId = await (await (await req.website.userId).sudo()).countryId;
            }
        }

        let country = 'countryId' in values && values['countryId'] != '' && (await req.getEnv()).items('res.country').browse(parseInt(values['countryId']));
        country = bool(country) && await country.exists();
        country = bool(country) ? country : defCountryId;

        return {
            'country': country,
            'countryStates': await country.getWebsiteSaleStates(mode[1]),
            'countries': await country.getWebsiteSaleCountries(mode[1]),
        }
    }

    @http.route(['/shop/checkout'], {type: 'http', auth: "public", website: true, sitemap: false})
    async checkout(req, res, post: {}={}) {
        const order = await req.website.saleGetOrder();

        let redirection = await this.checkoutRedirection(req, res, order);
        if (redirection) {
            return redirection;
        }
        if ((await order.partnerId).id == (await (await (await req.website.userId).sudo()).partnerId).id) {
            return req.redirect(res, '/shop/address');
        }

        redirection = await this.checkoutCheckAddress(req, res, order);
        if (redirection) {
            return redirection;
        }

        const values = await this.checkoutValues(req, post);

        if (post['express']) {
            return req.redirect(res, '/shop/confirmOrder');
        }
        update(values, {'websiteSaleOrder': order});

        // Avoid useless rendering if called in ajax
        if (post['xhr']) {
            return 'ok';
        }
        return req.render(res, "website_sale.checkout", values);
    }

    @http.route(['/shop/confirmOrder'], {type: 'http', auth: "public", website: true, sitemap: false})
    async confirmOrder(req, res, post: {}={}) {
        const order = await req.website.saleGetOrder();

        const redirection = await this.checkoutRedirection(req, res, order) || await this.checkoutCheckAddress(req, res, order);
        if (redirection) {
            return redirection;
        }

        await order.onchangePartnerShippingId();
        await (await order.orderLine)._computeTaxId();
        req.session['saleLastOrderId'] = order.id;
        await req.website.saleGetOrder({updatePricelist: true});
        const extraStep = await req.website.viewref('website_sale.extraInfoOption');
        if (await extraStep.active) {
            return req.redirect(res, "/shop/extraInfo");
        }
        return req.redirect(res, "/shop/payment");
    }

    // ------------------------------------------------------
    // Extra step
    // ------------------------------------------------------
    @http.route(['/shop/extraInfo'], {type: 'http', auth: "public", website: true, sitemap: false})
    async extraInfo(req, res, post: {}={}) {
        // Check that this option is activated
        const extraStep = await req.website.viewref('website_sale.extraInfoOption');
        if (! await extraStep.active) {
            return req.redirect(res, "/shop/payment");
        }
        // check that cart is valid
        const order = await req.website.saleGetOrder();
        const redirection = await this.checkoutRedirection(req, res, order);
        if (redirection) {
            return redirection;
        }
        const values = {
            'websiteSaleOrder': order,
            'post': post,
            'escape': (x) => x.replace(/\'/, "'"),
            'partner': (await order.partnerId).id,
            'order': order,
        }
        return req.render(res, "website_sale.extraInfo", values);
    }

    // ------------------------------------------------------
    // Payment
    // ------------------------------------------------------

    async _getShopPaymentValues(req, order, opts) {
        const env = await req.getEnv();
        const loggedIn = ! await (await env.user())._isPublic();
        const acquirersSudo = await (await env.items('payment.acquirer').sudo())._getCompatibleAcquirers(
            (await order.companyId).id,
            (await order.partnerId).id,
            {currencyId: (await order.currencyId).id,
            saleOrderId: order.id,
            websiteId: req.website.id,}
        );  // In sudo mode to read the fields of acquirers, order and partner (if not logged in)
        const tokens = loggedIn ? await env.items('payment.token').search(
            [['acquirerId', 'in', acquirersSudo.ids], ['partnerId', '=', (await order.partnerId).id]]
        ) : env.items('payment.token');
        const feesByAcquirer = new MapKey();
        for (const acqSudo of await acquirersSudo.filtered('feesActive')) {
            feesByAcquirer.set(acqSudo, await acqSudo._computeFees(
                await order.amountTotal, await order.currencyId, await (await order.partnerId).countryId
            ));
        }
        // Prevent public partner from saving payment methods but force it for logged in partners
        // buying subscription products
        const showTokenizeInput = loggedIn 
            && ! await (await env.items('payment.acquirer').sudo())._isTokenizationRequired({
                saleOrderId: order.id
            });
            
        return {
            'websiteSaleOrder': order,
            'errors': [],
            'partner': await order.partnerInvoiceId,
            'order': order,
            'paymentActionId': (await env.ref('payment.actionPaymentAcquirer')).id,
            // Payment form common (checkout and manage) values
            'acquirers': acquirersSudo,
            'tokens': tokens,
            'feesByAcquirer': feesByAcquirer,
            'showTokenizeInput': showTokenizeInput,
            'amount': await order.amountTotal,
            'currency': await order.currencyId,
            'partnerId': (await order.partnerId).id,
            'accessToken': await order._portalEnsureToken(),
            'transactionRoute': `/shop/payment/transaction/${order.id}`,
            'landingRoute': '/shop/payment/validate',
        }
    }

    /**
     * Payment step. This page proposes several payment means based on available
        payment.acquirer. State at this point :

         - a draft sales order with lines; otherwise, clean context / session and
           back to the shop
         - no transaction in context / session, or only a draft one, if the customer
           did go to a payment.acquirer website but closed the tab without
           paying / canceling
     * @param req 
     * @param res 
     * @param post 
     * @returns 
     */
    @http.route('/shop/payment', {type: 'http', auth: 'public', website: true, sitemap: false})
    async shopPayment(req, res, post: {}={}) {
        const order = await req.website.saleGetOrder();
        const redirection = await this.checkoutRedirection(req, res, order) || await this.checkoutCheckAddress(req, res, order);
        if (redirection) {
            return redirection;
        }

        const renderValues = await this._getShopPaymentValues(req, order, post);
        renderValues['onlyServices'] = bool(order) && await order.onlyServices || false;

        if (bool(renderValues['errors'])) {
            pop(renderValues, 'acquirers', '');
            pop(renderValues, 'tokens', '');
        }

        return req.render(res, "website_sale.payment", renderValues);
    }

    @http.route('/shop/payment/getStatus/<int:saleOrderId>', {type: 'json', auth: "public", website: true})
    async shopPaymentGetStatus(req, res, post: {saleOrderId?: any}={}) {
        const env = await req.getEnv();
        const order = await (await env.items('sale.order').sudo()).browse(post.saleOrderId).exists();
        if (order.id != req.session['saleLastOrderId']) {
            // either something went wrong or the session is unbound
            // prevent recalling every 3rd of a second in the JS widget
            return {};
        }
        return {
            'recall': await (await order.getPortalLastTransaction()).state == 'pending',
            'message': await env.items('ir.ui.view')._renderTemplate("website_sale.paymentConfirmationStatus", {
                'order': order
            })
        }
    }

    /**
     * Method that should be called by the server when receiving an update
        for a transaction. State at this point
     * @param req 
     * @param res 
     * @param post 
     */
    @http.route('/shop/payment/validate', {type: 'http', auth: "public", website: true, sitemap: false})
    async shopPaymentValidate(req, res, post: {transactionId?: any, saleOrderId?: any}={}) {
        const env = await req.getEnv();
        let order;
        if (post.saleOrderId == null) {
            order = await req.website.saleGetOrder();
            if (! bool(order) && 'saleLastOrderId' in req.session) {
                // Retrieve the last known order from the session if the session key `sale_order_id`
                // was prematurely cleared. This is done to prevent the user from updating their cart
                // after payment in case they don't return from payment through this route.
                const lastOrderId = req.session['saleLastOrderId'];
                order = await (await env.items('sale.order').sudo()).browse(lastOrderId).exists();
            }
        }
        else {
            order = (await env.items('sale.order').sudo()).browse(post.saleOrderId);
            assert(order.id == req.session.get('saleLastOrderId'));
        }

        let tx;
        if (post.transactionId) {
            tx = (await env.items('payment.transaction').sudo()).browse(post.transactionId);
            assert((await order.transactionIds()).includes(tx));
        }
        else if (bool(order)) {
            tx = await order.getPortalLastTransaction();
        }
        else {
            tx = null;
        }

        if (! bool(order) || (await order.amountTotal && !bool(tx))) {
            return req.redirect(res, '/shop');
        }

        if (bool(order) && !await order.amountTotal && ! bool(tx)) {
            await (await order.withContext({sendEmail: true})).actionConfirm();
            return req.redirect(req, await order.getPortalUrl());
        }

        // clean context and session, then redirect to the confirmation page
        await req.website.saleReset();
        if (bool(tx) && await tx.state == 'draft') {
            return req.redirect(res, '/shop');
        }

        PaymentPostProcessing.removeTransactions(req, tx);
        return req.redirect(res, '/shop/confirmation');
    }

    /**
     * End of checkout process controller. Confirmation is basically seing
        the status of a sale.order. State at this point :
         - should not have any context / session info: clean them
         - take a sale.order id, because we request a sale.order and are not
           session dependant anymore
     * @param req 
     * @param res 
     * @param post 
     * @returns 
     */
    @http.route(['/shop/confirmation'], {type: 'http', auth: "public", website: true, sitemap: false})
    async shopPaymentConfirmation(req, res, post: {}={}) {
        const saleOrderId = req.session.get('saleLastOrderId');
        if (bool(saleOrderId)) {
            const order = (await (await req.getEnv()).items('sale.order').sudo()).browse(saleOrderId);
            return req.render(res, "website_sale.confirmation", {
                'order': order,
                'orderTrackingInfo': await this.order2ReturnDict(order),
            });
        }
        else {
            return req.redirect(res, '/shop');
        }
    }

    @http.route(['/shop/print'], {type: 'http', auth: "public", website: true, sitemap: false})
    async printSaleorder(req, res, post: {}={}) {
        const saleOrderId = req.session.get('saleLastOrderId');
        if (saleOrderId) {
            const [pdf] = await (await (await (await req.getEnv()).ref('sale.actionReportSaleorder')).withUser(global.SUPERUSER_ID))._renderQwebPdf([saleOrderId]);
            const pdfhttpheaders = [['Content-Type', 'application/pdf'], ['Content-Length', f('%s', len(pdf))]];
            return req.makeResponse(res, pdf, pdfhttpheaders);
        }
        else {
            return req.redirect(res, '/shop');
        }
    }

    // ------------------------------------------------------
    // Edit
    // ------------------------------------------------------

    @http.route(['/shop/addProduct'], {type: 'json', auth: "user", methods: ['POST'], website: true})
    async addProduct(req, res, post: {label?: any, category?: any}={}) {
        const env = await req.getEnv();
        const product = await env.items('product.product').create({
            'label': post.label || await this._t(env, "New Product"),
            'publicCategIds': post.category,
            'websiteId': req.website.id,
        });
        return f("%s?enableEditor=1", await (await product.productTemplateId).websiteUrl);
    }

    @http.route(['/shop/changeSequence'], {type: 'json', auth: 'user'})
    async changeSequence(req, res, post: {id?: any, sequence?: any}={}) {
        const productTmpl = (await req.getEnv()).items('product.template').browse(post.id);
        const sequence = post.sequence;
        if (sequence == "top") {
            await productTmpl.setSequenceTop();
        }
        else if (sequence == "bottom") {
            await productTmpl.setSequenceBottom();
        }
        else if (sequence == "up") {
            await productTmpl.setSequenceUp();
        }
        else if (sequence == "down") {
            await productTmpl.setSequenceDown();
        }
    }

    @http.route(['/shop/changeSize'], {type: 'json', auth: 'user'})
    async changeSize(req, res, post: {id?: any, x?: any, y?: any}={}) {
        const product = (await req.getEnv()).items('product.template').browse(post.id);
        return product.write({'websiteSizeX': post.x, 'websiteSizeY': post.y});
    }

    @http.route(['/shop/changePpg'], {type: 'json', auth: 'user'})
    async changePpg(req, res, post: {ppg?: any}={}) {
        await (await (await req.getEnv()).items('website').getCurrentWebsite()).set('shopPpg', post.ppg);
    }

    @http.route(['/shop/changePpr'], {type: 'json', auth: 'user'})
    async changePpr(req, res, post: {ppr?: any}={}) {
        await (await (await req.getEnv()).items('website').getCurrentWebsite()).set('shopPpr', post.ppr);
    }

    /**
     * Transforms a list of order lines into a dict for google analytics
     * @param orderLines 
     * @returns 
     */
    async orderLines2GoogleApi(orderLines) {
        const ret = [];
        for (const line of orderLines) {
            const product = await line.productId;
            ret.push({
                'itemId': await product.barcode || product.id,
                'itemName': await product.label || '-',
                'itemCategory': await (await product.categId).label || '-',
                'price': await line.priceUnit,
                'quantity': await line.productUomQty,
            });
        }
        return ret;
    }

    /**
     * Returns the trackingCart dict of the order for Google analytics basically defined to be inherited
     * @param order 
     * @returns 
     */
    async order2ReturnDict(order) {
        return {
            'transactionId': order.id,
            'affiliation': await (await order.companyId).label,
            'value': await order.amountTotal,
            'tax': await order.amountTax,
            'currency': await (await order.currencyId).label,
            'items': await this.orderLines2GoogleApi(await order.orderLine),
        }
    }

    @http.route(['/shop/countryInfos/<model("res.country"):country>'], {type: 'json', auth: "public", methods: ['POST'], website: true})
    async countryInfos(req, res, opts: {country?: any, mode?: any}={}) {
        const country = opts['country'];
        return {
            fields: await country.getAddressFields(),
            states: (await country.getWebsiteSaleStates(opts.mode)).map(async (st) => [st.id, await st.label, await st.code]),
            phoneCode: await country.phoneCode,
            zipRequired: await country.zipRequired,
            stateRequired: await country.stateRequired,
        }
    }

    // --------------------------------------------------------------------------
    // Products Recently Viewed
    // --------------------------------------------------------------------------
    @http.route('/shop/products/recentlyViewedUpdate', {type: 'json', auth: 'public', website: true})
    async productsRecentlyViewedUpdate(req: WebRequest, res, post: {productId?: any}={}) {
        const result = {};
        const visitorSudo = await (await req.getEnv()).items('website.visitor')._getVisitorFromRequest({forceCreate: true});
        if (bool(visitorSudo)) {
            if ((req.cookie['visitorUuid'] ?? '') != await visitorSudo.accessToken) {
                result['visitorUuid'] = await visitorSudo.accessToken;
            }
            await visitorSudo._addViewedProduct(post.productId);
        }
        return result;
    }

    @http.route('/shop/products/recentlyViewedDelete', {type: 'json', auth: 'public', website: true})
    async productsRecentlyViewedDelete(req, res, post: {productId?: any}={}) {
        const env = await req.getEnv();
        const visitorSudo = await env.items('website.visitor')._getVisitorFromRequest();
        if (bool(visitorSudo)) {
            await (await (await env.items('website.track').sudo()).search([['visitorId', '=', visitorSudo.id], ['productId', '=', post.productId]])).unlink();
        }
        return {};
    }
}

@http.define()
class PaymentPortal extends payment.PaymentPortal {
    static _module = module;

    /**
     * Create a draft transaction and return its processing values.

        :param int orderId: The sales order to pay, as a `sale.order` id
        :param str accessToken: The access token used to authenticate the request
        :param dict kwargs: Locally unused data passed to `_create_transaction`
        :return: The mandatory values for the processing of the transaction
        :rtype: dict
        :raise: ValidationError if the invoice id or the access token is invalid
     * @param req 
     * @param res 
     * @param opts 
     * @returns 
     */
    @http.route(
        '/shop/payment/transaction/<int:orderId>', {type: 'json', auth: 'public', website: true}
    )
    async shopPaymentTransaction(req, res, opts: {orderId?: any, accessToken?: any}={}) {
        // Check the order id and the access token
        let orderSudo;
        try {
            orderSudo = await this._documentCheckAccess(req, 'sale.order', opts.orderId, opts.accessToken);
        } catch(e) {
            if (isInstance(e, MissingError)) {
                throw e;
            }
            if (isInstance(e, AccessError)) {
                throw new ValidationError(await this._t("The access token is invalid."));
            }
        }
        if (await orderSudo.state == "cancel") {
            throw new ValidationError(await this._t("The order has been canceled."));
        }
        if (floatCompare(opts['amount'], await orderSudo.amountTotal, {precisionRounding: await (await orderSudo.currencyId).rounding})) {
            throw new ValidationError(await this._t("The cart has been updated. Please refresh the page."));
        }
        update(opts, {
            'referencePrefix': null,  // Allow the reference to be computed based on the order
            'partnerId': (await orderSudo.partnerInvoiceId).id,
            'saleOrderId': opts.orderId,  // Include the SO to allow Subscriptions to tokenize the tx
        });
        pop(opts, 'customCreateValues', null);  // Don't allow passing arbitrary create values
        const txSudo = await this._createTransaction(req, {
            customCreateValues: {'saleOrderIds': [Command.set([opts.orderId])]}, ...opts,
        });

        // Store the new transaction into the transaction list and if there's an old one, we remove
        // it until the day the ecommerce supports multiple orders at the same time.
        const lastTxId = req.session.get('__websiteSaleLastTxId');
        const lastTx = await (await (await req.getEnv()).items('payment.transaction').browse(lastTxId).sudo()).exists();
        if (bool(lastTx)) {
            PaymentPostProcessing.removeTransactions(req, lastTx);
        }
        req.session['__websiteSaleLastTxId'] = txSudo.id;

        return txSudo._getProcessingValues();
    }
}