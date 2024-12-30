import _ from "lodash";
import { api, Fields } from "../../../core";
import { _super, MetaModel, Model } from "../../../core/models"
import { expression } from "../../../core/osv";
import { bool, enumerate, f, htmlTranslate, len, map, setOptions, slug, unslug, update } from "../../../core/tools";

@MetaModel.define()
class ProductTemplate extends Model {
    static _module = module;
    static _parents = [
        "product.template",
        "website.seo.metadata",
        'website.published.multi.mixin',
        'website.searchable.mixin',
        'rating.mixin',
    ];
    static _name = 'product.template';
    static _mailPostAccess = 'read';
    static _checkCompanyAuto = true;

    static websiteDescription = Fields.Html('Description for the website', {sanitizeAttributes: false, translate: htmlTranslate, sanitizeForm: false});
    static alternativeProductIds = Fields.Many2many(
        'product.template', {relation: 'productAlternativeRel', column1: 'srcId', column2: 'destId', checkCompany: true,
        string: 'Alternative Products', help: 'Suggest alternatives to your customer (upsell strategy). Those products show up on the product page.'});
    static accessoryProductIds = Fields.Many2many(
        'product.product', {relation: 'productAccessoryRel', column1: 'srcId', column2: 'destId', string: 'Accessory Products', checkCompany: true, help: 'Accessories show up when the customer reviews the cart before payment (cross-sell strategy).'});
    static websiteSizeX = Fields.Integer('Size X', {default: 1});
    static websiteSizeY = Fields.Integer('Size Y', {default: 1});
    static websiteRibbonId = Fields.Many2one('product.ribbon', {string: 'Ribbon'});
    static websiteSequence = Fields.Integer('Website Sequence', {help: "Determine the display order in the Website E-commerce", default: (self) => self._defaultWebsiteSequence(), copy: false});
    static publicCategIds = Fields.Many2many(
        'product.public.category', {relation: 'productPublicCategoryProductTemplateRel',
        string: 'Website Product Category',
        help: "The product will be available in each mentioned eCommerce category. Go to Shop > Customize and enable 'eCommerce categories' to view all eCommerce categories."});

    static productTemplateImageIds = Fields.One2many('product.image', 'productTemplateId', {string: "Extra Product Media", copy: true});

    static baseUnitCount = Fields.Float('Base Unit Count', {required: true, default: 0,
                                   compute: '_computeBaseUnitCount', inverse: '_setBaseUnitCount', store: true,
                                   help: "Display base unit price on your eCommerce pages. Set to 0 to hide it for this product."});
    static baseUnitId = Fields.Many2one('website.base.unit', {string: 'Custom Unit of Measure',
                                   compute: '_computeBaseUnitId', inverse: '_setBaseUnitId', store: true,
                                   help: "Define a custom unit to display in the price per unit of measure field."});
    static baseUnitPrice = Fields.Monetary("Price Per Unit", {currencyField: "currencyId", compute: "_computeBaseUnitPrice"});
    static baseUnitName = Fields.Char({compute: '_computeBaseUnitName', help: 'Displays the custom unit for the products if defined or the selected unit of measure otherwise.'});

    @api.depends('productVariantIds', 'productVariantIds.baseUnitCount')
    async _computeBaseUnitCount() {
        await this.set('baseUnitCount', 0);
        for (const template of await this.filtered(async (template) => len(await template.productVariantIds) == 1)) {
            await template.set('baseUnitCount', await (await template.productVariantIds).baseUnitCount);
        }
    }

    async _setBaseUnitCount() {
        for (const template of this) {
            const productVariantIds = await template.productVariantIds;
            if (len(productVariantIds) == 1) {
                await productVariantIds.set('baseUnitCount', await template.baseUnitCount);
            }
        }
    }

    @api.depends('productVariantIds', 'productVariantIds.baseUnitCount')
    async _computeBaseUnitId() {
        await this.set('baseUnitId', this.env.items('website.base.unit'));
        for (const template of await this.filtered(async (template) => len(await template.productVariantIds) == 1)) {
            await template.set('baseUnitId', await (await template.productVariantIds).baseUnitId);
        }
    }

    async _setBaseUnitId() {
        for (const template of this) {
            const productVariantIds = await template.productVariantIds;
            if (len(productVariantIds) == 1) {
                await productVariantIds.set('baseUnitId', await template.baseUnitId);
            }
        }
    }

    @api.depends('price', 'listPrice', 'baseUnitCount')
    async _computeBaseUnitPrice() {
        for (const template of this) {
            const templatePrice = bool(template.id) ? (await template.price || await template.listPrice) : await template.listPrice;
            await template.set('baseUnitPrice', await template.baseUnitCount && templatePrice / (await template.baseUnitCount));
        }
    }

    @api.depends('uomName', 'baseUnitId.label')
    async _computeBaseUnitName() {
        for (const template of this) {
            await template.set('baseUnitName', await (await template.baseUnitId).label || await template.uomName);
        }
    }

    async _prepareVariantValues(combination) {
        const variantDict = await _super(ProductTemplate, this)._prepareVariantValues(combination);
        variantDict['baseUnitCount'] = await this['baseUnitCount'];
        return variantDict;
    }

    async _getWebsiteAccessoryProduct() {
        let domain = await this.env.items('website').saleProductDomain();
        if (! await (await this.env.user())._isInternal()) {
            domain = expression.AND([domain, [['isPublished', '=', true]]]);
        }
        return (await this['accessoryProductIds']).filteredDomain(domain);
    }

    async _getWebsiteAlternativeProduct() {
        const domain = await this.env.items('website').saleProductDomain();
        return (await this['alternativeProductIds']).filteredDomain(domain);
    }

    /**
     * Return whether this `product.template` has at least one noVariant
        attribute.

        :return: True if at least one noVariant attribute, False otherwise
        :rtype: bool
     * @returns 
     */
    async _hasNoVariantAttributes() {
        this.ensureOne();
        return (await (await this['validProductTemplateAttributeLineIds']).attributeId).some(async (a) => await a.createVariant === 'noVariant');
    }

    /**
     * Return whether this `product.template` has at least one is_custom
        attribute value.

        :return: True if at least one is_custom attribute value, False otherwise
        :rtype: bool
     * @returns 
     */
    async _hasIsCustomValues() {
        this.ensureOne();
        return (await (await (await this['validProductTemplateAttributeLineIds']).productTemplateValueIds)._onlyActive()).some(v => v.isCustom);
    }

    /**
     * Return the sorted recordset of variants that are possible.

        The order is based on the order of the attributes and their values.

        See `_get_possible_variants` for the limitations of this method with
        dynamic or noVariant attributes, and also for a warning about
        performances.

        :param parentCombination: combination from which `self` is an
            optional or accessory product
        :type parentCombination: recordset `product.template.attribute.value`

        :return: the sorted variants that are possible
        :rtype: recordset of `product.product`
     */
    async _getPossibleVariantsSorted(parentCombination?: any) {
        this.ensureOne();

        async function _sortKeyAttributeValue(value) {
            const attributeId = await value.attributeId;
            // if you change this order, keep it in sync with _order from `product.attribute`
            return [await attributeId.sequence, attributeId.id];
        }

        /**
         * We assume all variants will have the same attributes, with only one value for each.
            - first level sort: same as "product.attribute"._order
            - second level sort: same as "product.attribute.value"._order
         * @param variant 
         * @returns 
         */
        async function _sortKeyVariant(variant) {
            const keys = [];
            for (const attribute of await (await variant.productTemplateAttributeValueIds).sorted(_sortKeyAttributeValue)) {
                // if you change this order, keep it in sync with _order from `product.attribute.value`
                keys.push(await (await attribute.productAttributeValueId).sequence);
                keys.push(attribute.id);
            }
            return keys;
        }

        return (await (this as any)._getPossibleVariants(parentCombination)).sorted(_sortKeyVariant);
    }

    /**
     * Override for website, where we want to:
            - take the website pricelist if no pricelist is set
            - apply the b2b/b2c setting to the result

        This will work when adding websiteId to the context, which is done
        automatically when called from routes with website: true.
     * @param combination 
     * @param productId 
     * @param addQty 
     * @param pricelist 
     * @param parentCombination 
     * @param onlyTemplate 
     */
    async _getCombinationInfo(opts: {combination?: any, productId?: any, addQty?: any, pricelist?: any, parentCombination?: any, onlyTemplate?: any}={}) {
        this.ensureOne();
        // setOptions(opts, {combination: false, productId: false, addQty: 1, pricelist: false, parentCombination: false, onlyTemplate: false});
        let {combination = false, productId = false, addQty = 1, pricelist = false, parentCombination = false, onlyTemplate = false} = opts;

        let currentWebsite;// = false;

        if (this.env.context['websiteId']) {
            currentWebsite = await this.env.items('website').getCurrentWebsite();
            if (!bool(pricelist)) {
                pricelist = await currentWebsite.getCurrentPricelist(this.env.req);
            }
        }
        const combinationInfo = await _super(ProductTemplate, this)._getCombinationInfo({
            combination, productId, addQty, pricelist, parentCombination, onlyTemplate});

        if (this.env.context['websiteId']) {
            const context = Object.assign({}, this.env.context, {
                'quantity': this.env.context['quantity'] ?? addQty,
                'pricelist': pricelist && pricelist.id
            });

            let product = this.env.items('product.product').browse(combinationInfo['productId']);
            product = await (bool(product) ? product : this).withContext(context);
            const partner = await (await this.env.user()).partnerId;
            const companyId = await currentWebsite.companyId;

            const taxDisplay = await this.userHasGroups('account.groupShowLineSubtotalsTaxExcluded') && 'totalExcluded' || 'totalIncluded';
            const fpos = await (await this.env.items('account.fiscal.position').sudo()).getFiscalPosition(partner.id);
            const productTaxes = await (await (await product.sudo()).taxesId).filtered(async (x) => (await x.companyId).eq(companyId));
            const taxes = await fpos.mapTax(productTaxes);

            // The listPrice is always the price of one.
            let quantity1 = 1;
            combinationInfo['price'] = await this.env.items('account.tax')._fixTaxIncludedPriceCompany(
                combinationInfo['price'], productTaxes, taxes, companyId);
            const currencyId = await pricelist.currencyId;
            const price = (await taxes.computeAll(combinationInfo['price'], currencyId, quantity1, product, partner))[taxDisplay];
            let listPrice;
            if (await pricelist.discountPolicy === 'withoutDiscount') {
                combinationInfo['listPrice'] = await this.env.items('account.tax')._fixTaxIncludedPriceCompany(
                    combinationInfo['listPrice'], productTaxes, taxes, companyId);
                listPrice = (await taxes.computeAll(combinationInfo['listPrice'], currencyId, quantity1, product, partner))[taxDisplay];
            }
            else {
                listPrice = price;
            }
            combinationInfo['priceExtra'] = await this.env.items('account.tax')._fixTaxIncludedPriceCompany(combinationInfo['priceExtra'], productTaxes, taxes, companyId);
            const priceExtra = (await taxes.computeAll(combinationInfo['priceExtra'], currencyId, quantity1, product, partner))[taxDisplay];
            const hasDiscountedPrice = await currencyId.compareAmounts(listPrice, price) == 1;

            update(combinationInfo, {
                baseUnitName: await product.baseUnitName,
                baseUnitPrice: await product.baseUnitCount && listPrice / (await product.baseUnitCount),
                price,
                listPrice,
                priceExtra,
                hasDiscountedPrice,
            });
        }
        return combinationInfo;
    }

    /**
     * Returns the holder of the image to use as default representation.
        If the product template has an image it is the product template,
        otherwise if the product has variants it is the first variant

        :return: this product template or the first product variant
        :rtype: recordset of 'product.template' or recordset of 'product.product'
     * @returns 
     */
    async _getImageHolder() {
        this.ensureOne();
        if (await this['image128']) {
            return this;
        }
        const variant = this.env.items('product.product').browse(await (this as any)._getFirstPossibleVariantId());
        // if the variant has no image anyway, spare some queries by using template
        return await variant.imageVariant128 ? variant : this;
    }

    /**
     * Override: if a website is set on the product or given, fallback to
        the company of the website. Otherwise use the one from parent method.
     * @param kwargs 
     * @returns 
     */
    async _getCurrentCompanyFallback(opts) {
        const res = await _super(ProductTemplate, this)._getCurrentCompanyFallback(opts);
        let website = await this['websiteId'];
        website = bool(website) ? website : opts['website'];
        const company = bool(website) && await website.companyId;
        return bool(company) ? company : res;
    }

    async _initColumn(columnName) {
        // to avoid generating a single default websiteSequence when installing the module,
        // we need to set the default row by row for this column
        if (columnName === "websiteSequence") {
            console.debug("Table '%s': setting default value of new column %s to unique values for each row", this.cls._table, columnName);
            const prodTmplIds: any[] = await this.env.cr.execute(`SELECT id FROM "%s" WHERE "websiteSequence" IS NULL`, [this.cls._table]);
            const maxSeq = await this._defaultWebsiteSequence();
            const query = `
                UPDATE "${this.cls._table}"
                SET "websiteSequence" = p."webSeq"
                FROM (VALUES (%s, %s)) AS p("pId", "webSeq")
                WHERE id = p."pId"
            `;
            for (const [i, prodTmpl] of enumerate(prodTmplIds)) {
                await this.env.cr.execute(query, [prodTmpl['id'], maxSeq + i * 5]);
            }
        }
        else {
            await _super(ProductTemplate, this)._initColumn(columnName);
        }
    }

    /**
     * We want new product to be the last (highest seq).
        Every product should ideally have an unique sequence.
        Default sequence (10000) should only be used for DB first product.
        As we don't resequence the whole tree (as `sequence` does), this field
        might have negative value.
     * @returns 
     */
    async _defaultWebsiteSequence() {
        const res = await this._cr.execute(`SELECT MAX("websiteSequence") AS mseq FROM "%s"`, [this.cls._table]);
        const maxSequence = res[0]['mseq'];
        if (maxSequence == null) {
            return 10000;
        }
        return maxSequence + 5;
    }

    async setSequenceTop() {
        const minSequence = await (await this.sudo()).search([], {order: 'websiteSequence ASC', limit: 1});
        await this.set('websiteSequence', await minSequence.websiteSequence - 5);
    }

    async setSequenceBottom() {
        const maxSequence = await (await this.sudo()).search([], {order: 'websiteSequence DESC', limit: 1});
        await this.set('websiteSequence', await maxSequence.websiteSequence + 5);
    }

    async setSequenceUp() {
        let previousProductTmpl = await (await this.sudo()).search([
            ['websiteSequence', '<', await this['websiteSequence']],
            ['websitePublished', '=', await this['websitePublished']],
        ], {order: 'websiteSequence DESC', limit: 1});
        if (previousProductTmpl.ok) {
            const websiteSequence = await previousProductTmpl.websiteSequence;
            await previousProductTmpl.set('websiteSequence', await this['websiteSequence']);
            await this.set('websiteSequence', websiteSequence);
        }
        else {
            await this.setSequenceTop();
        }
    }

    async setSequenceDown() {
        const nextProdcutTmpl = await this.search([
            ['websiteSequence', '>', await this['websiteSequence']],
            ['websitePublished', '=', await this['websitePublished']],
        ], {order: 'websiteSequence ASC', limit: 1});
        if (nextProdcutTmpl.ok) {
            const websiteSequence = await nextProdcutTmpl.websiteSequence;
            await nextProdcutTmpl.set('websiteSequence', await this['websiteSequence']);
            await this.set('websiteSequence', websiteSequence);
        }
        else {
            return this.setSequenceBottom();
        }
    }

    async _defaultWebsiteMeta() {
        const res = await _super(ProductTemplate, this)._defaultWebsiteMeta();
        res['defaultOpengraph']['og:description'] = res['defaultTwitter']['twitter:description'] = await this['descriptionSale'];
        res['defaultOpengraph']['og:title'] = res['defaultTwitter']['twitter:title'] = await this['label'];
        res['defaultOpengraph']['og:image'] = res['defaultTwitter']['twitter:image'] = await this.env.items('website').imageUrl(this, 'image1024');
        res['defaultMetaDescription'] = await this['descriptionSale'];
        return res;
    }

    async _computeWebsiteUrl() {
        await _super(ProductTemplate, this)._computeWebsiteUrl();
        for (const product of this) {
            if (bool(product.id)) {
                await product.set('websiteUrl', f("/shop/%s", slug([product.id, await product.seoName || await product.displayName])));
            }
        }
    }

    async _isSoldOut() {
        return (await this['productVariantId'])._isSoldOut();
    }

    async _getWebsiteRibbon() {
        return this['websiteRibbonId'];
    }

    // ---------------------------------------------------------
    // Rating Mixin API
    // ---------------------------------------------------------

    /**
     * Only take the published rating into account to compute avg and count
     * @returns 
     */
    async _ratingDomain() {
        const domain = await _super(ProductTemplate, this)._ratingDomain();
        return expression.AND([domain, [['isInternal', '=', false]]]);
    }

    /**
     * Return a list of records implementing `image.mixin` to
        display on the carousel on the website for this template.

        This returns a list and not a recordset because the records might be
        from different models (template and image).

        It contains in this order: the main image of the template and the
        Template Extra Images.
     * @returns 
     */
    async _getImages() {
        this.ensureOne();
        return [this].concat(Array.from(await this['productTemplateImageIds']));
    }

    @api.model()
    async _searchGetDetail(website, order, options) {
        const withImage = options['displayImage'],
        withDescription = options['displayDescription'],
        withCategory = options['displayExtraLink'],
        withPrice = options['displayDetail'],
        domains = [await website.saleProductDomain()],
        category = options['category'],
        minPrice = options['minPrice'],
        maxPrice = options['maxPrice'],
        attribValues = options['attribValues'];
        if (category) {
            domains.push([['publicCategIds', 'childOf', unslug(category)[1]]]);
        }
        if (minPrice) {
            domains.push([['listPrice', '>=', minPrice]]);
        }
        if (maxPrice) {
            domains.push([['listPrice', '<=', maxPrice]]);
        }
        if (attribValues) {
            let attrib,
            ids = [];
            for (const value of attribValues) {
                if (! attrib) {
                    attrib = value[0];
                    ids.push(value[1]);
                }
                else if (value[0] === attrib) {
                    ids.push(value[1]);
                }
                else {
                    domains.push([['attributeLineIds.valueIds', 'in', ids]]);
                    attrib = value[0];
                    ids = [value[1]];
                }
            }
            if (attrib) {
                domains.push([['attributeLineIds.valueIds', 'in', ids]]);
            }
        }
        const searchFields = ['label', 'defaultCode', 'productVariantIds.defaultCode'],
        fetchFields = ['id', 'label', 'websiteUrl'],
        mapping = {
            'label': {'label': 'label', 'type': 'text', 'match': true},
            'defaultCode': {'label': 'defaultCode', 'type': 'text', 'match': true},
            'productVariantIds.defaultCode': {'label': 'productVariantIds.defaultCode', 'type': 'text', 'match': true},
            'websiteUrl': {'label': 'websiteUrl', 'type': 'text', 'truncate': false},
        }
        if (withImage) {
            mapping['imageUrl'] = {'label': 'imageUrl', 'type': 'html'}
        }
        if (withDescription) {
            // Internal note is not part of the rendering.
            searchFields.push('description');
            fetchFields.push('description');
            searchFields.push('descriptionSale');
            fetchFields.push('descriptionSale');
            mapping['description'] = {'label': 'descriptionSale', 'type': 'text', 'match': true}
        }
        if (withPrice) {
            mapping['detail'] = {'label': 'price', 'type': 'html', 'displayCurrency': options['displayCurrency']};
            mapping['detailStrike'] = {'label': 'listPrice', 'type': 'html', 'displayCurrency': options['displayCurrency']};
        }
        if (withCategory) {
            mapping['extraLink'] = {'label': 'category', 'type': 'dict', 'itemType': 'text'}
            mapping['extraLinkUrl'] = {'label': 'categoryUrl', 'type': 'dict', 'itemType': 'text'};
        }
        return {
            'model': 'product.template',
            'baseDomain': domains,
            'searchFields': searchFields,
            'fetchFields': fetchFields,
            'mapping': mapping,
            'icon': 'fa-shopping-cart',
        }
    }

    async _searchRenderResults(fetchFields, mapping, icon, limit) {
        const withImage = 'imageUrl' in mapping,
        withCategory = 'extraLink' in mapping,
        withPrice = 'detail' in mapping,
        resultsData = await _super(ProductTemplate, this)._searchRenderResults(fetchFields, mapping, icon, limit),
        currentWebsite = await this.env.items('website').getCurrentWebsite();
        for (const [product, data] of _.zip([...this], resultsData)) {
            const categIds = await (await product.publicCategIds).filtered(async (c) => ! bool(await c.websiteId) || (await c.websiteId).eq(currentWebsite));
            if (withPrice) {
                const combinationInfo = await product._getCombinationInfo({onlyTemplate: true}),
                monetaryOptions = {'displayCurrency': mapping['detail']['displayCurrency']};
                data['price'] = await this.env.items('ir.qweb.field.monetary').valueToHtml(combinationInfo['price'], monetaryOptions);
                if (combinationInfo['hasDiscountedPrice']) {
                    data['listPrice'] = await this.env.items('ir.qweb.field.monetary').valueToHtml(combinationInfo['listPrice'], monetaryOptions);
                }
            }
            if (withImage) {
                data['imageUrl'] = f('/web/image/product.template/%s/image128', data['id']);
            }
            if (withCategory && bool(categIds)) {
                data['category'] = {'extraLinkTitle': len(categIds) > 1 ? await this._t('Categories:') : await this._t('Category:')}
                data['categoryUrl'] = {}
                for (const categ of categIds) {
                    const slugCateg = slug([categ.id, await categ.seoName || await categ.displayName]);
                    data['category'][slugCateg] = await categ.label;
                    data['categoryUrl'][slugCateg] = f('/shop/category/%s', slugCateg);
                }
            }
        }
        return resultsData;
    }

    @api.model()
    async getGoogleAnalyticsData(combination) {
        const product = this.env.items('product.product').browse(combination['productId']);
        return {
            'itemId': await product.barcode || product.id,
            'itemName': combination['displayName'],
            'itemCategory': await (await product.categId).label || '-',
            'currency': await (await product.currencyId).label,
            'price': combination['listPrice'],
        }
    }
}
