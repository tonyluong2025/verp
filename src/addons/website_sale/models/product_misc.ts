import _ from "lodash";
import { api, Fields, tools } from "../../../core";
import { _super, MetaModel, Model } from "../../../core/models"
import { bool, f, html2Text, htmlTranslate, parseInt } from "../../../core/tools";
import { getRequestWebsite } from "../../website/models";
import { UserError, ValidationError, ValueError } from "../../../core/helper";

@MetaModel.define()
class ProductRibbon extends Model {
    static _module = module;
    static _name = "product.ribbon";
    static _description = 'Product ribbon';

    async nameGet() {
        return this.map(async ribbon => [ribbon.id, f('%s (#%d)', html2Text(await ribbon.html), ribbon.id)]);
    }

    static html = Fields.Html({string: 'Ribbon html', required: true, translate: true, sanitize: false});
    static bgcolor = Fields.Char({string: 'Ribbon background color', required: false});
    static textColor = Fields.Char({string: 'Ribbon text color', required: false});
    static htmlClass = Fields.Char({string: 'Ribbon class', required: true, default: ''});
}

@MetaModel.define()
class ProductPricelist extends Model {
    static _module = module;
    static _parents = "product.pricelist";

    /**
     * Find the first company's website, if there is one.
     * @returns 
     */
    async _defaultWebsite() {
        let companyId = (await this.env.company()).id;

        if (this._context['default_companyId']) {
            companyId = this._context['default_companyId'];
        }
        const domain = [['companyId', '=', companyId]];
        return this.env.items('website').search(domain, {limit: 1});
    }

    static websiteId = Fields.Many2one('website', {string: "Website", ondelete: 'RESTRICT', default: self => self._defaultWebsite(), domain: "[['companyId', '=?', companyId]]"});
    static code = Fields.Char({string: 'E-commerce Promotional Code', groups: "base.groupUser"});
    static selectable = Fields.Boolean({help: "Allow the end user to choose this price list"});

    clearCache() {
        // website._getPlPartnerOrder() is cached to avoid to recompute at each request the
        // list of available pricelists. So, we need to invalidate the cache when
        // we change the config of website price list to force to recompute.
        const website = this.env.items('website');
        const func: any = website._getPlPartnerOrder;
        func.clearCache(website);
    }

    @api.model()
    async create(data) {
        let self = this;
        if (data['companyId'] && ! data['websiteId']) {
            // l10n modules install will change the company currency, creating a
            // pricelist for that currency. Do not use user's company in that
            // case as module install are done with VerpBot (company 1)
            self = await self.withContext({default_companyId: data['companyId']});
        }
        const res = await _super(ProductPricelist, self).create(data);
        self.clearCache();
        return res;
    }

    async write(data) {
        const res = await _super(ProductPricelist, this).write(data);
        if (_.intersection(Object.keys(data), ['code', 'active', 'websiteId', 'selectable', 'companyId']).length) {
            await this._checkWebsitePricelist();
        }
        this.clearCache();
        return res;
    }

    async unlink() {
        const res = await _super(ProductPricelist, this).unlink();
        await this._checkWebsitePricelist();
        this.clearCache();
        return res;
    }

    async _getPartnerPricelistMultiSearchDomainHook(req, companyId) {
        let domain = await _super(ProductPricelist, this)._getPartnerPricelistMultiSearchDomainHook(req, companyId);
        const website = getRequestWebsite(req);
        if (website) {
            domain = domain.concat(await this._getWebsitePricelistsDomain(website.id));
        }
        return domain;
    }

    async _getPartnerPricelistMultiFilterHook(req) {
        let res = await _super(ProductPricelist, this)._getPartnerPricelistMultiFilterHook(req);
        const website = getRequestWebsite(req);
        if (website) {
            res = await res.filtered(async (pl) => pl._isAvailableOnWebsite(website.id));
        }
        return res;
    }

    async _checkWebsitePricelist() {
        for (const website of await this.env.items('website').search([])) {
            // sudo() to be able to read pricelists/website from another company
            if (! bool(await (await website.sudo()).pricelistIds)) {
                throw new UserError(await this._t("With this action, '%s' website would not have any pricelist available.", await website.label));
            }
        }
    }

    /**
     * To be able to be used on a website, a pricelist should either:
        - Have its `websiteId` set to current website (specific pricelist).
        - Have no `websiteId` set and should be `selectable` (generic pricelist)
          or should have a `code` (generic promotion).
        - Have no `companyId` or a `companyId` matching its website one.

        Note: A pricelist without a websiteId, not selectable and without a
              code is a backend pricelist.

        Change in this method should be reflected in `_getWebsitePricelistsDomain`.
     * @param websiteId 
     * @returns 
     */
    async _isAvailableOnWebsite(websiteId) {
        this.ensureOne();
        if ((await this['companyId']).ok && (await this['companyId']).ne(await this.env.items("website").browse(websiteId).companyId)) {
            return false;
        }
        return (await this['websiteId']).id == websiteId || (! (await this['websiteId']).ok && (await this['selectable'] || await (await this.sudo()).code));
    }

    /**
     * Check above `_isAvailableOnWebsite` for explanation.
        Change in this method should be reflected in `_isAvailableOnWebsite`.
     * @param websiteId 
     * @returns 
     */
    async _getWebsitePricelistsDomain(websiteId) {
        const companyId = (await this.env.items("website").browse(websiteId).companyId).id;
        return [
            '&', ['companyId', 'in', [false, companyId]],
            '|', ['websiteId', '=', websiteId],
            '&', ['websiteId', '=', false],
            '|', ['selectable', '=', true], ['code', '!=', false],
        ]
    }

    /**
     * If `propertyProductPricelist` is read from website, we should use
            the website's company and not the user's one.
            Passing a `companyId` to super will avoid using the current user's
            company.
     * @param partnerIds 
     * @param companyId 
     * @returns 
     */
    async _getPartnerPricelistMulti(req, partnerIds, companyId?: any) {
        const website = getRequestWebsite(req);
        if (! companyId && website) {
            companyId = (await website.companyId).id;
        }
        return _super(ProductPricelist, this)._getPartnerPricelistMulti(req, partnerIds, companyId);
    }

    /**
     * Prevent misconfiguration multi-website/multi-companies.
           If the record has a company, the website should be from that company.
     * @returns 
     */
    @api.constrains('companyId', 'websiteId')
    async _checkWebsitesInCompany() {
        for (const record of await this.filtered(async (pl) => (await pl.websiteId).ok && (await pl.companyId).ok)) {
            if ((await (await record.websiteId).companyId).ne(await record.companyId)) {
                throw new ValidationError(await this._t("Only the company's websites are allowed.\nLeave the Company field empty or select a website from that company."));
            }
        }
    }
}

@MetaModel.define()
class ProductPublicCategory extends Model {
    static _module = module;
    static _name = "product.public.category";
    static _parents = [
        'website.seo.metadata',
        'website.multi.mixin',
        'website.searchable.mixin',
        'image.mixin',
    ]
    static _description = "Website Product Category";
    static _parentStore = true;
    static _order = "sequence, label, id";

    async _defaultSequence() {
        const cat = await this.search([], {limit: 1, order: "sequence DESC"});
        if (cat.ok) {
            return await cat.sequence + 5;
        }
        return 10000;
    }

    static label = Fields.Char({required: true, translate: true});
    static parentId = Fields.Many2one('product.public.category', {string: 'Parent Category', index: true, ondelete: "CASCADE"});
    static parentPath = Fields.Char({index: true});
    static childId = Fields.One2many('product.public.category', 'parentId', {string: 'Children Categories'});
    static parentsAndSelf = Fields.Many2many('product.public.category', {compute: '_computeParentsAndSelf'});
    static sequence = Fields.Integer({help: "Gives the sequence order when displaying a list of product categories.", index: true, default: self => self._defaultSequence()});
    static websiteDescription = Fields.Html('Category Description', {sanitizeAttributes: false, translate: htmlTranslate, sanitizeForm: false});
    static productTemplateIds = Fields.Many2many('product.template', {relation: 'productPublicCategoryProductTemplateRel'});

    @api.constrains('parentId')
    async checkParentId() {
        if (! await this._checkRecursion()) {
            throw new ValueError(await this._t('Error ! You cannot create recursive categories.'));
        }
    }

    async nameGet() {
        const res = [];
        for (const category of this) {
            res.push([category.id, (await (await category.parentsAndSelf).mapped('label')).join(' / ')]);
        }
        return res;
    }

    async _computeParentsAndSelf() {
        for (const category of this) {
            if (await category.parentPath) {
                await category.set('parentsAndSelf', await this.env.items('product.public.category').browse((await category.parentPath).split('/').slice(0,-1).map(p => parseInt(p))));
            }
            else {
                await category.set('parentsAndSelf', category);
            }
        }
    }

    @api.model()
    async _searchGetDetail(website, order, options) {
        const withDescription = options['displayDescription'];
        const searchFields = ['label'];
        const fetchFields = ['id', 'label'];
        const mapping = {
            'label': {'label': 'label', 'type': 'text', 'match': true},
            'websiteUrl': {'label': 'url', 'type': 'text', 'truncate': false},
        }
        if (withDescription) {
            searchFields.push('websiteDescription');
            fetchFields.push('websiteDescription');
            mapping['description'] = {'label': 'websiteDescription', 'type': 'text', 'match': true, 'html': true}
        }
        return {
            'model': 'product.public.category',
            'baseDomain': [website.websiteDomain()],
            'searchFields': searchFields,
            'fetchFields': fetchFields,
            'mapping': mapping,
            'icon': 'fa-folder-o',
            'order': order.includes('label desc') ? 'label desc, id desc' : 'label asc, id desc',
        }
    }

    async _searchRenderResults(fetchFields, mapping, icon, limit) {
        const resultsData = await _super(ProductPublicCategory, this)._searchRenderResults(fetchFields, mapping, icon, limit);
        for (const data of resultsData) {
            data['url'] = f('/shop/category/%s', data['id']);
        }
        return resultsData;
    }
}
