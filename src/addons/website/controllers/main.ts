import _ from "lodash";
import luxon, { DateTime, Duration } from "luxon";
import { _Datetime, http } from "../../../core";
import { Home } from "../../../core/addons/web";
import { setdefault } from "../../../core/api";
import { Dict, ValueError } from "../../../core/helper";
import { WebRequest, httpGet } from "../../../core/http";
import { BaseModel } from "../../../core/models";
import { Forbidden, NotFound } from "../../../core/service";
import { expVersion } from "../../../core/service/common";
import { urlEncode, urlJoin, urlParse } from "../../../core/service/middleware/utils";
import { URI, b64decode, bool, ellipsis, escapePsql, escapeRegExp, extend, f, isInstance, isList, islice, len, lstrip, parseInt, pop, range, slug, slugify, someAsync, sorted, stringPart, update } from "../../../core/tools";
import { iterchildren, parseXml } from "../../../core/tools/xml";

import path from "node:path";
import { expression } from "../../../core/osv";
import { BaseResponse } from "../../../core/service/middleware/base_response";
import { stringify } from "../../../core/tools/json";
import { _guessMimetype } from '../../http_routing/models/ir_http';
import { pager as portalPager } from '../../portal/controllers/portal';

// Completely arbitrary limits
const IMAGE_LIMITS = [1024, 768];
const [MAX_IMAGE_WIDTH, MAX_IMAGE_HEIGHT] = IMAGE_LIMITS;
const LOC_PER_SITEMAP = 45000;
const SITEMAP_CACHE_TIME: luxon.Duration = Duration.fromObject({ hours: 12 });

export class QueryURL extends Function {
    path: string;
    args: {};
    pathArgs: any;

    constructor(path: string = '', pathArgs?: any[] | {}, kw?: {}) {
        super();
        this.path = path;
        if (Array.isArray(pathArgs)) {
            this.pathArgs = pathArgs;
            this.args = kw ?? {};
        } else {
            this.pathArgs = [];
            this.args = pathArgs;
        }
        return new Proxy(this, {
            apply(target, thisArg, args) {
                return target.__call__(args[0], args[1], args.slice(2));
            },
        })
    }

    async __call__(path?: string, pathArgs?: any[], kw?: {}) {
        path = path || this.path;
        if (Array.isArray(pathArgs)) {
            kw = kw ?? {};
        } else {
            kw = pathArgs;
            pathArgs = [];
        }
        for (const [key, value] of Object.entries(this.args)) {
            setdefault(kw, key, value);
        }
        pathArgs = _.union(pathArgs ?? [], this.pathArgs);
        const paths = {}, fragments = [];
        for (const [key, value] of Object.entries<any>(kw)) {
            if (bool(value) && pathArgs.includes(key)) {
                if (isInstance(value, BaseModel)) {
                    paths[key] = slug([value.id, await value.seoName || await value.displayName]);
                }
                else {
                    paths[key] = f("%s", value);
                }
            }
            else if (bool(value)) {
                if (isList(value) || isInstance(value, Set)) {
                    fragments.push(urlEncode([...value].map(item => [key, item])));
                }
                else {
                    fragments.push(urlEncode([[key, value]]));
                }
            }
        }
        for (const key of pathArgs) {
            const value = paths[key];
            if (value != null) {
                path += '/' + key + '/' + value;
            }
        }
        if (bool(fragments)) {
            path += '?' + fragments.join('&');
        }
        return path;
    }
}

@http.define()
export class Website extends Home {
    static _module = module;

    // Force website: true + auth: 'public', required for login form layout
    @http.route({ website: true, auth: "public", sitemap: false })
    async webLogin(req, res, opts) {
        return super.webLogin(req, res, opts);
    }

    @http.route('/', { type: 'http', auth: "public", website: true, sitemap: true })
    async index(req: any, res) {
        // prefetch all menus (it will prefetch website.page too)
        const topMenu = await req.website.menuId;
        const env = await req.getEnv();
        const user = await env.user();
        const homepageId = await req.website._getCached('homepageId');
        const homepage = bool(homepageId) && env.items('website.page').browse(homepageId);
        if (bool(homepage) && (await (await homepage.sudo()).isVisible || await user.hasGroup('base.groupUser')) && await homepage.url !== '/') {
            return env.items('ir.http').reroute(req, res, await homepage.url);
        }

        const websitePage = await env.items('ir.http')._servePage(req, res);
        if (bool(websitePage)) {
            return websitePage;
        }
        else {
            const firstMenu = bool(topMenu) && bool(await topMenu.childId) && await (await topMenu.childId).filtered((menu) => menu.isVisible);
            if (bool(firstMenu)
                && !['/', '', '#'].includes(await firstMenu[0].url)
                && !await someAsync(['/?', '/#', ' '], async (char) => (await firstMenu[0].url).startsWith(char))
            ) {
                return req.redirect(res, await firstMenu[0].url);
            }
        }
        throw req.notFound(res);
    }

    /**
     * To switch from a website to another, we need to force the website in
        session, AFTER landing on that website domain (if set) as this will be a
        different session.
     * @param req 
     * @param res 
     * @param opts 
     * @returns 
     */
    @http.route('/website/force/<int:websiteId>', { type: 'http', auth: "user", website: true, sitemap: false, multilang: false })
    async websiteForce(req: WebRequest, res, { websiteId = null, path = null, isredir = null }) {
        path = path ?? '/';
        const env = await req.getEnv();
        const user = await env.user();
        if (!await user.hasGroup('website.groupMultiWebsite')
            && await user.hasGroup('website.groupWebsitePublisher')) {
            // The user might not be logged in on the forced website, so he won't
            // have rights. We just redirect to the path as the user is already
            // on the domain (basically a no-op as it won't change domain or
            // force website).
            // Website 1 : 127.0.0.1 (admin)
            // Website 2 : 127.0.0.2 (not logged in)
            // Click on "Website 2" from Website 1
            return req.redirect(res, path);
        }
        const website = env.items('website').browse(websiteId);

        if (!isredir && await website.domain) {
            const domainFrom = req.host || '';
            const domainTo = urlParse(await website._getHttpDomain()).host;
            if (domainFrom !== domainTo) {
                // redirect to correct domain for a correct routing map
                const urlTo = urlJoin(await website._getHttpDomain(), f('/website/force/%s?isredir=1&path=%s', website.id, path));
                return req.redirect(res, urlTo);
            }
        }
        await website._force();
        return req.redirect(res, path);
    }

    // ------------------------------------------------------
    // Login - overwrite of the web login so that regular users are redirected to the backend
    // while portal users are redirected to the frontend by default
    // ------------------------------------------------------

    /**
     * Redirect regular users (employees) to the backend) and others to
        the frontend
     * @param uid 
     * @param redirect 
     * @returns 
     */
    async _loginRedirect(req: WebRequest, res, uid, redirect?: any) {
        if (!redirect && req.params.get('loginSuccess')) {
            if (await (await req.getEnv()).items('res.users').browse(uid).hasGroup('base.groupUser')) {
                redirect = '/web?' + urlEncode(req.params);
            }
            else {
                redirect = '/my';
            }
        }
        return super._loginRedirect(req, res, uid, redirect = redirect)
    }

    // Business

    @http.route('/website/getLanguages', { type: 'json', auth: "user", website: true })
    async websiteLanguages(req, res, opts) {
        return (await req.website.languageIds).map(async (lang) => lang('code', 'urlCode', 'label'));
    }

    /**
     * :param lang: supposed to be value of `url_code` field
     * @param req 
     * @param res 
     * @param opts 
     * @returns 
     */
    @http.route('/website/lang/<lang>', { type: 'http', auth: "public", website: true, multilang: false })
    async changeLang(req: WebRequest, res, { lang = null, r = '/' } = {}) {
        if (lang === 'default') {
            lang = await (await req.website.defaultLangId).urlCode;
            r = f('/%s%s', lang, r || '/');
        }
        const langCode = await (await req.getEnv()).items('res.lang')._langGetCode(lang);
        // replace context with correct lang, to avoid that the url_for of request.redirect remove the
        // default lang in case we switch from /fr -> /en with /en as default lang.
        req.context = Object.assign({}, req.context, { lang: langCode });
        const redirect = await req.redirect(res, r || f('/%s', lang));
        redirect.setCookie('frontend_lang', langCode);
        return redirect;
    }

    @http.route(['/website/countryInfos/<model("res.country"):country>'], { type: 'json', auth: "public", methods: ['POST'], website: true })
    async countryInfos(req, res, { country = null } = {}) {
        const fields = await country.getAddressFields();
        return Object.assign({}, { fields: fields, states: await (await country.stateIds).map(async (st) => st('id', 'label', 'code')), phoneCode: await country.phoneCode });
    }

    @http.route(['/robots.txt'], { type: 'http', auth: "public", website: true, sitemap: false })
    async robots(req, res) {
        return req.render(res, 'website.robots', { 'urlRoot': req.httpRequest.urlRoot, mimetype: 'text/plain' });
    }

    @http.route('/sitemap.xml', { type: 'http', auth: "public", website: true, multilang: false, sitemap: false })
    async sitemapXmlIndex(req, res) {
        const env = await req.getEnv();
        const currentWebsite = req.website;
        const attachment = await env.items('ir.attachment').sudo();
        const view = await env['ir.ui.view'].sudo();
        const mimetype = 'application/xml;charset=utf-8';
        let content;

        async function createSitemap(url, content) {
            return attachment.create({
                'raw': Buffer.from(content),
                'mimetype': mimetype,
                'type': 'binary',
                'name': url,
                'url': url,
            });
        }
        let dom: any[] = [['url', '=', f('/sitemap-%s.xml', currentWebsite.id)], ['type', '=', 'binary']];
        const sitemap = await attachment.search(dom, { limit: 1 });
        if (sitemap.ok) {
            // Check if stored version is still valid
            luxon.DateTime.now
            const createdAt = _Datetime.toDatetime(await sitemap.createdAt);
            const delta = luxon.Interval.fromDateTimes(createdAt, DateTime.now());
            if (delta.toDuration().hours < SITEMAP_CACHE_TIME.hours) {
                content = b64decode(await sitemap.datas);
            }
        }
        if (!content) {
            // Remove all sitemaps in ir.attachments as we're going to regenerated them
            dom = [['type', '=', 'binary'], '|', ['url', '=like', f('/sitemap-%s-%%.xml', currentWebsite.id)],
            ['url', '=', f('/sitemap-%s.xml', currentWebsite.id)]]
            const sitemaps = await attachment.search(dom);
            await sitemaps.unlink();

            let pages = 0;
            const locs = await (await (await req.website.withContext({ _filterDuplicatePages: true })).withUser(await req.website.userId))._enumeratePages();
            let lastSitemap;
            while (true) {
                const values = {
                    'locs': islice(locs, 0, LOC_PER_SITEMAP),
                    'urlRoot': req.httpRequest.urlRoot.slice(0, -1),
                }
                const urls = await view._renderTemplate('website.sitemapLocs', values);
                if (urls.trim()) {
                    const content = await view._render_template('website.sitemapXml', { 'content': urls });
                    pages += 1;
                    lastSitemap = createSitemap(f('/sitemap-%s-%s.xml', currentWebsite.id, pages), content);
                }
                else {
                    break;
                }
            }
            if (!pages) {
                return req.notFound(res);
            }
            else if (pages == 1) {
                // rename the -id-page.xml => -id.xml
                await lastSitemap.write({
                    'url': f("/sitemap-%s.xml", currentWebsite.id),
                    'label': f("/sitemap-%s.xml", currentWebsite.id),
                });
            }
            else {
                // TODO: in master/saas-15, move current_website_id in template directly
                const pagesWithWebsite = [];
                for (const p of range(1, pages + 1)) {
                    pagesWithWebsite.push(f("%s-%s", currentWebsite.id, p));
                }

                // Sitemaps must be split in several smaller files with a sitemap index
                content = await view._renderTemplate('website.sitemapIndexXml', {
                    'pages': pagesWithWebsite,
                    'urlRoot': req.httpRequest.urlRoot,
                })
                createSitemap(f('/sitemap-%s.xml', currentWebsite.id), content);
            }
        }

        return req.makeResponse(req, content, [['Content-Type', mimetype]]);
    }

    static async* sitemapWebsiteInfo(env, rule, qs) {
        const website = await env.items('website').getCurrentWebsite();
        if (!(
            await (await website.viewref('website.websiteInfo', false)).active
            && await (await website.viewref('website.showWebsiteInfo', false)).active
        )) {
            // avoid 404 or blank page in sitemap
            return false;
        }
        if (!qs || '/website/info'.includes(qs.toLowerCase())) {
            yield { 'loc': '/website/info' }
        }
    }

    @http.route('/website/info', { type: 'http', auth: "public", website: true, sitemap: Website.sitemapWebsiteInfo })
    async websiteInfo(req, res, opts) {
        if (! await (await req.website.viewref('website.websiteInfo', false)).active) {
            // Deleted or archived view (through manual operation in backend).
            // Don't check `show_website_info` view: still need to access if
            // disabled to be able to enable it through the customize show.
            throw req.notFound(res);
        }

        const module = await (await req.getEnv()).items('ir.module.module').sudo();
        const apps = await module.search([['state', '=', 'installed'], ['application', '=', true]]);
        const l10n = await module.search([['state', '=', 'installed'], ['label', '=like', 'l10n_%']]);
        const values = {
            'apps': apps,
            'l10n': l10n,
            'version': expVersion()
        }
        return req.render(res, 'website.websiteInfo', values);
    }

    @http.route(['/website/configurator', '/website/configurator/<int:step>'], { type: 'http', auth: "user", website: true, multilang: false })
    async websiteConfigurator(req, res, opts: { step?: any }) {
        opts.step = opts.step ?? 1;
        const env = await req.getEnv();
        if (! await (await env.user()).hasGroup('website.groupWebsiteDesigner')) {
            throw new NotFound(res);
        }
        const websiteId = await env.items('website').getCurrentWebsite();
        if (await websiteId.configuratorDone) {
            return req.redirect(res, '/');
        }
        if ((await req.getEnv()).lang !== await (await websiteId.defaultLangId).code) {
            return req.redirect(res, f('/%s%s', await (await websiteId.defaultLangId).urlCode, req.httpRequest.pathname));
        }
        return req.render(res, 'website.websiteConfigurator');
    }

    @http.route(['/website/social/<string:social>'], { type: 'http', auth: "public", website: true, sitemap: false })
    async social(req, res, opts: { social?: any }) {
        const url = await req.website[f('social_%s', opts.social)] ?? false;
        if (!url) {
            throw new NotFound(res);
        }
        return req.redirect(res, url, { local: false });
    }

    @http.route('/website/getSuggestedLinks', { type: 'json', auth: "user", website: true })
    async getSuggestedLink(req, res, opts: { needle?: any, limit?: any } = {}) {
        opts.limit = opts.limit ?? 10;
        const currentWebsite = req.website;

        const matchingPages = [];
        for (const page of await (await currentWebsite.withContext({ _filterDuplicatePages: true })).searchPages(opts.needle, { limit: parseInt(opts.limit) })) {
            matchingPages.push({
                'value': page['loc'],
                'label': 'label' in page && f('%s (%s)', page['loc'], page['label']) || page['loc'],
            })
        }
        const matchingUrls = new Set(matchingPages.map(match => match['value']));

        const matchingLastModified = [];
        const lastModifiedPages = await (await currentWebsite.withContext({ _filterDuplicatePages: true }))._getWebsitePages(null, 'updatedAt desc', 5);
        for (const [url, name] of await lastModifiedPages.mapped(async (p) => p('url', 'label'))) {
            if (name.toLowerCase().includes(opts.needle.toLowerCase()) || url.toLowerCase().includes(opts.needle.toLowerCase()) && !matchingUrls.has(url)) {
                matchingLastModified.push({
                    'value': url,
                    'label': f('%s (%s)', url, name),
                });
            }
        }

        const suggestedControllers = [];
        for (const [name, url, mod] of await currentWebsite.getSuggestedControllers()) {
            if (name.toLowerCase().includes(opts.needle.toLowerCase()) || url.toLowerCase().includes(opts.needle.toLowerCase())) {
                const moduleSudo = mod && await (await (await req.getEnv()).ref(f('base.module_%s', mod), false)).sudo();
                const icon = mod && f("<img src='%s' width='24px' height='24px' class='mr-2 rounded' /> ", moduleSudo.ok && await moduleSudo.icon || mod) || '';
                suggestedControllers.push({
                    'value': url,
                    'label': f('%s%s (%s)', icon, url, name),
                })
            }
        }
        return {
            'matchingPages': sorted(matchingPages, (o) => o['label']),
            'others': [
                Object.assign({}, { title: await this._t(await req.getEnv(), 'Last modified pages'), values: matchingLastModified }),
                Object.assign({}, { title: await this._t(await req.getEnv(), 'Apps url'), values: suggestedControllers }),
            ]
        }
    }

    @http.route('/website/snippet/filters', { type: 'json', auth: 'public', website: true })
    async getDynamicFilter(req, res, opts: { filterId?: any, templateKey?: any, limit?: any, searchDomain?: any, withSample?: any } = {}) {
        const dynamicFilter = await (await (await req.getEnv()).items('website.snippet.filter').sudo()).search(
            [['id', '=', opts.filterId]].concat(req.website.websiteDomain())
        )
        return dynamicFilter.ok && await dynamicFilter._render(opts.templateKey, opts.limit, opts.searchDomain, opts.withSample) || [];
    }

    @http.route('/website/snippet/optionsFilters', { type: 'json', auth: 'user', website: true })
    async getDynamicSnippetFilters(req, res, opts: { modelName?: any, searchDomain?: any } = {}) {
        let domain = req.website.websiteDomain();
        if (opts.searchDomain) {
            domain = expression.AND([domain, opts.searchDomain]);
        }
        if (opts.modelName) {
            domain = expression.AND([
                domain,
                ['|', ['filterId.modelId', '=', opts.modelName], ['actionServerId.modelId.model', '=', opts.modelName]]
            ]);
        }
        const dynamicFilter = await (await (await req.getEnv()).items('website.snippet.filter').sudo()).searchRead(domain, ['id', 'label', 'limit', 'modelName'], {
            order: 'id asc'
        });
        return dynamicFilter;
    }

    @http.route('/website/snippet/filterTemplates', { type: 'json', auth: 'public', website: true })
    async getDynamicSnippetTemplates(req, res, opts: { filterName?: any } = {}) {
        const domain = [['key', 'ilike', '.dynamicFilterTemplate'], ['type', '=', 'qweb']];
        if (opts.filterName) {
            domain.push(['key', 'ilike', escapePsql(f('_%s_', opts.filterName))]); // Tony check
        }
        const templates = await (await (await req.getEnv()).items('ir.ui.view').sudo()).searchRead(domain, ['key', 'label', 'archDb']);

        for (const t of templates) {
            const child = parseXml(pop(t, 'archDb')).childNodes.item(0) as Element;
            if (child && child.hasAttributes()) {
                t['numOfEl'] = child.getAttribute('data-number-of-elements');
                t['numOfElSm'] = child.getAttribute('data-number-of-elements-sm');
                t['numOfElFetch'] = child.getAttribute('data-number-of-elements-fetch');
            }
        }
        return templates;
    }

    @http.route('/website/getCurrentCurrency', { type: 'json', auth: "public", website: true })
    async getCurrentCurrency(req, res, opts) {
        const currency = await (await req.website.companyId).currencyId;
        return {
            'id': currency.id,
            'symbol': await currency.symbol,
            'position': await currency.position,
        }
    }

    // Search Bar

    _getSearchOrder(order) {
        // OrderBy will be parsed in orm and so no direct sql injection
        // id is added to be sure that order is a unique sort key
        order = order || 'label ASC';
        return f('isPublished desc, %s, id desc', order);
    }

    /**
     * Returns list of results according to the term and options

        :param str searchType: indicates what to search within, 'all' matches all available types
        :param str term: search term written by the user
        :param str order:
        :param int limit: number of results to consider, defaults to 5
        :param int maxNbChars: max number of characters for text fields
        :param dict options: options map containing
            allowFuzzy: enables the fuzzy matching when truthy
            fuzzy (boolean): true when called after finding a name through fuzzy matching

        :returns: dict (or false if no result) containing
            - 'results' (list): results (only their needed field values)
                    note: the monetary fields will be strings properly formatted and
                    already containing the currency
            - 'resultsCount' (int): the number of results in the database
                    that matched the search query
            - 'parts' (dict): presence of fields across all results
            - 'fuzzySearch': search term used instead of requested search
     * @param req 
     * @param res 
     * @param opts 
     * @returns 
     */
    @http.route('/website/snippet/autocomplete', { type: 'json', auth: 'public', website: true })
    async autocomplete(req, res, opts: { searchType?: any, term?: any, order?: any, limit?: any, maxNbChars?: any, options?: any } = {}) {
        const limit = opts.limit ?? 5;
        const maxNbChars = opts.maxNbChars ?? 999;
        const order = this._getSearchOrder(opts.order);
        const options = opts.options ?? {};
        let [resultsCount, searchResults, fuzzyTerm] = await req.website._searchWithFuzzy(opts.searchType, opts.term, limit, order, options);
        if (!resultsCount) {
            return {
                'results': [],
                'resultsCount': 0,
                'parts': {},
            }
        }
        const term = fuzzyTerm || opts.term;
        searchResults = await req.website._searchRenderResults(searchResults, limit);

        const mappings = [];
        let resultsData = [];
        for (const searchResult of searchResults) {
            extend(resultsData, searchResult['resultsData']);
            mappings.push(searchResult['mapping']);
        }
        if (opts.searchType == 'all') {
            // Only supported order for 'all' is on name
            resultsData = sorted(resultsData, (r) => r['label'] || '', order.includes('label desc'));
        }
        resultsData = resultsData.slice(0, limit);
        const result = [];

        async function getMappingValue(fieldType: string, value: string, fieldMeta: {}) {
            if (fieldType === 'text') {
                if (value && (fieldMeta['truncate'] ?? true)) {
                    value = ellipsis(value, maxNbChars, '...');
                }
                if (fieldMeta['match'] && value && bool(term)) {
                    const pattern = term.replace('  ', ' ').split(' ').map(e => escapeRegExp(e)).join('|');
                    if (pattern) {
                        const parts = value.split(`(${pattern})`);//, flags=re.IGNORECASE)
                        if (len(parts) > 1) {
                            value = await (await (await req.getEnv()).items('ir.ui.view').sudo())._renderTemplate(
                                "website.searchTextWithHighlight",
                                { 'parts': parts }
                            );
                            fieldType = 'html';
                        }
                    }
                }
            }
            if (!['image', 'binary'].includes(fieldType) && f('ir.qweb.field.%s', fieldType) in (await req.getEnv()).models) {
                const opt = {}
                if (fieldType === 'monetary') {
                    opt['displayCurrency'] = options['displayCurrency'];
                }
                else if (fieldType === 'html') {
                    opt['templateOptions'] = {};
                }
                value = await (await req.getEnv()).items(f('ir.qweb.field.%s', fieldType)).valueToHtml(value, opt);
            }
            return escape(value);
        }

        for (const record of resultsData) {
            const mapping = record['_mapping'];
            const mapped = {
                '_fa': record['_fa'],
            }
            for (const [mappedName, fieldMeta] of Object.entries(mapping)) {
                const value = record[fieldMeta['label']];
                if (!value) {
                    mapped[mappedName] = '';
                    continue;
                }
                const fieldType = fieldMeta['type'];
                if (fieldType === 'dict') {
                    // Map a field with multiple values, stored in a dict with values type: item_type
                    const itemType = fieldMeta['itemType'];
                    mapped[mappedName] = {}
                    for (const [key, item] of Object.entries<string>(value)) {
                        mapped[mappedName][key] = await getMappingValue(itemType, item, fieldMeta);
                    }
                }
                else {
                    mapped[mappedName] = await getMappingValue(fieldType, value, fieldMeta);
                }
            }
            result.push(mapped);
        }

        const parts = {}
        for (const mapping of mappings) {
            for (const key of mapping) {
                parts[key] = true;
            }
        }
        return {
            'results': result,
            'resultsCount': resultsCount,
            'parts': parts,
            'fuzzySearch': fuzzyTerm,
        }
    }

    @http.route(['/pages', '/pages/page/<int:page>'], { type: 'http', auth: "public", website: true, sitemap: false })
    async pagesList(req, res, opts: { page?: any, search?: any } = {}) {
        const page = opts.page ?? 1;
        const search = opts.search || '';
        const options = {
            'displayDescription': false,
            'displayDetail': false,
            'displayExtraDetail': false,
            'displayExtraLink': false,
            'displayImage': false,
            'allowFuzzy': !opts['noFuzzy'],
        }
        let step = 50;
        const [pagesCount, details, fuzzySearchTerm] = await req.website._searchWithFuzzy(
            "pages", search, page * step, 'label asc, websiteId desc, id', options);
        let pages = details[0]['results'] ?? (await req.getEnv()).items('website.page');

        const pager = await portalPager({
            url: "/pages",
            urlArgs: { 'search': search },
            total: pagesCount,
            page: page,
            step: step
        });

        pages = pages.slice((page - 1) * step, page * step);

        const values = {
            'pager': pager,
            'pages': pages,
            'search': fuzzySearchTerm || search,
            'searchCount': pagesCount,
            'originalSearch': fuzzySearchTerm && search,
        }
        return req.render(res, "website.listWebsitePublicPages", values);
    }

    @http.route([
        '/website/search',
        '/website/search/page/<int:page>',
        '/website/search/<string:searchType>',
        '/website/search/<string:searchType>/page/<int:page>',
    ], { type: 'http', auth: "public", website: true, sitemap: false })
    async hybridList(req, res, opts: { page?: any, search?: any, searchType?: any } = {}) {
        update(opts, { page: 1, search: '', searchType: 'all' });
        if (!opts.search) {
            return req.render(res, "website.listHybrid");
        }
        const options = {
            'displayDescription': true,
            'displayDetail': true,
            'displayExtraDetail': true,
            'displayExtraLink': true,
            'displayImage': true,
            'allowFuzzy': !opts['noFuzzy'],
        }
        const data = await this.autocomplete(req, res, { searchType: opts.searchType, term: opts.search, order: 'label asc', limit: 500, maxNbChars: 200, options: options });

        let results = data['results'] ?? [];
        const searchCount = len(results);
        const parts = data['parts'] ?? {};

        const step = 50;
        const pager = await portalPager({
            url: f("/website/search/%s", opts.searchType),
            urlArgs: { 'search': opts.search },
            total: searchCount,
            page: opts.page,
            step: step
        });

        results = results.slice((opts.page - 1) * step, opts.page * step);

        const values = {
            'pager': pager,
            'results': results,
            'parts': parts,
            'search': opts.search,
            'fuzzySearch': data['fuzzySearch'],
            'searchCount': searchCount,
        }
        return req.render(req, "website.listHybrid", values);
    }

    // ------------------------------------------------------
    // Edit
    // ------------------------------------------------------

    @http.route(['/website/pages', '/website/pages/page/<int:page>'], { type: 'http', auth: "user", website: true })
    async pagesManagement(req, res, opts: { page?: any, sortby?: any, search?: any } = {}) {
        update(opts, { page: 1, sortby: 'url', search: '' });
        // only website_designer should access the page Management
        if (! await (await (await req.getEnv()).user()).hasGroup('website.groupWebsiteDesigner')) {
            throw new NotFound(res);
        }

        const Page = (await req.getEnv()).items('website.page');
        const searchbarSortings = {
            'url': { 'label': await this._t(await req.getEnv(), 'Sort by Url'), 'order': 'url' },
            'label': { 'label': await this._t(await req.getEnv(), 'Sort by Name'), 'order': 'label' },
        }
        // default sortby order
        const sortOrder = (searchbarSortings[opts.sortby] || 'url')['order'] + ', websiteId desc, id';

        let domain = req.website.websiteDomain();
        if (opts.search) {
            domain = domain.concat(['|', ['label', 'ilike', opts.search], ['url', 'ilike', opts.search]]);
        }

        let pages = await Page.search(domain, { order: sortOrder });
        if (opts.sortby !== 'url' || !req.session.debug) {
            pages = await pages._getMostSpecificPages();
        }
        const pagesCount = len(pages);

        const step = 50;
        const pager = await portalPager({
            url: "/website/pages",
            urlArgs: { 'sortby': opts.sortby },
            total: pagesCount,
            page: opts.page,
            step: step
        });

        pages = pages.slice((opts.page - 1) * step, opts.page * step);

        const values = {
            'pager': pager,
            'pages': pages,
            'search': opts.search,
            'sortby': opts.sortby,
            'searchbarSortings': searchbarSortings,
            'searchCount': pagesCount,
        }
        return req.render(res, "website.listWebsitePages", values);
    }

    @http.route(['/website/add', '/website/add/<path:path>'], { type: 'http', auth: "user", website: true, methods: ['POST'] })
    async pagenew(req, res, opts: { path?: any, noredirect?: any, addMenu?: any, template?: any } = {}) {
        update(opts, { path: "", noredirect: false, addMenu: false, template: false });
        // for supported mimetype, get correct default template
        const ext = path.parse(opts.path).ext;
        const extSpecialCase = ext && ext in _guessMimetype() && ext !== '.html';

        if (!opts.template && extSpecialCase) {
            const defaultTempl = f('website.default%s', _.upperFirst(lstrip(ext, '.')));
            if (await (await req.getEnv()).ref(defaultTempl, false)) {
                opts.template = defaultTempl;
            }
        }

        const template = opts.template && { template: opts.template } || {};
        const page = await (await req.getEnv()).items('website').newPage({ label: opts.path, addMenu: opts.addMenu, ...template });
        const url = page['url'];
        if (opts.noredirect) {
            return new BaseResponse(req, res, url, { mimetype: 'text/plain' });
        }
        if (extSpecialCase) {  // redirect non html pages to backend to edit
            return req.redirect(res, '/web#id=' + String(page['viewId']) + '&viewType=form&model=ir.ui.view');
        }
        return req.redirect(res, url + "?enableEditor=1");
    }

    @http.route("/website/getSwitchableRelatedViews", { type: "json", auth: "user", website: true })
    async getSwitchableRelatedViews(req, res, opts: { key?: any } = {}) {
        let views = await (await (await req.getEnv()).items("ir.ui.view").getRelatedViews(opts.key, false)).filtered((v) => v.customizeShow);

        // TODO remove in master: customizeShow was kept by mistake on a view
        // in website_crm. It was removed in stable at the same time this hack is
        // introduced but would still be shown for existing customers if nothing
        // else was done here. For users that disabled the view but were not
        // supposed to be able to, we hide it too. The feature does not do much
        // and is not a discoverable feature anyway, best removing the confusion
        // entirely. If someone somehow wants that very technical feature, they
        // can still enable the view again via the backend. We will also
        // re-enable the view automatically in master.
        const crmContactusView = await req.website.viewref('website_crm.contactusForm', false);
        views = views.sub(crmContactusView);

        views = await views.sorted(async (v) => [(await v.inheritId).id, await v.label]);
        return (await views.withContext({ displayWebsite: false })).read(['label', 'id', 'key', 'xmlid', 'active', 'inheritId']);
    }

    @http.route('/website/toggleSwitchableView', { type: 'json', auth: 'user', website: true })
    async toggleSwitchableView(req, res, opts: { viewKey?: any } = {}): Promise<any> {
        if (await req.website.userHasGroups('website.groupWebsiteDesigner')) {
            await (await req.website.viewref(opts.viewKey)).toggleActive();
        }
        else {
            return new Forbidden(res);
        }
    }

    /**
     * This method will try to reset a broken view.
        Given the mode, the view can either be:
        - Soft reset: restore to previous architeture.
        - Hard reset: it will read the original `arch` from the XML file if the
        view comes from an XML file (arch_fs).
     * @param req 
     * @param res 
     * @param opts 
     * @returns 
     */
    @http.route('/website/resetTemplate', { type: 'http', auth: 'user', methods: ['POST'], website: true, csrf: false })
    async resetTemplate(req, res, opts: { viewId?: any, mode?: any, redirect?: any } = {}) {
        update(opts, { mode: 'soft', redirect: '/' });
        const view = (await req.getEnv()).items('ir.ui.view').browse(parseInt(opts.viewId));
        // Deactivate COW to not fix a generic view by creating a specific
        await (await view.withContext({ websiteId: null })).resetArch(opts.mode);
        return req.redirect(res, opts.redirect);
    }

    @http.route(['/website/publish'], { type: 'json', auth: "user", website: true })
    async publish(req, res, opts: { id?: any, object?: any } = {}) {
        const model = (await req.getEnv()).items(opts.object);
        const record = model.browse(parseInt(opts.id));

        const values = {}
        if ('websitePublished' in model._fields) {
            const websitePublished = await record.websitePublished;
            values['websitePublished'] = !websitePublished;
            await record.write(values);
            return bool(websitePublished);
        }
        return false;
    }

    @http.route(['/website/seoSuggest'], { type: 'json', auth: "user", website: true })
    async seoSuggest(req, res, opts: { keywords?: any, lang?: any } = {}) {
        const language = opts.lang.split("_");
        const uri = new URI("http://google.com/complete/search");
        let content;
        try {
            uri.searchQuery = Dict.from({ 'ie': 'utf8', 'oe': 'utf8', 'output': 'toolbar', 'q': opts.keywords, 'hl': language[0], 'gl': language[1] });
            content = await httpGet(uri.toString());
            // req.raise_for_status()
        } catch (e) {
            // except IOError:
            return [];
        }
        const xmlroot = parseXml(content);
        const result = []
        for (const sugg of iterchildren(xmlroot)) {
            if (len(sugg) && sugg.items(0).hasAttribute('data')) {
                result.push(sugg.items(0).getAttribute('data'));
            }
        }
        return stringify(result);
    }

    @http.route(['/website/getSeoData'], { type: 'json', auth: "user", website: true })
    async getSeoData(req, res, opts: { resId?: any, resModel?: any } = {}) {
        if (!(await req.getEnv()).user.hasGroup('website.groupWebsitePublisher')) {
            throw new Forbidden(res);
        }

        const fields = ['websiteMetaTitle', 'websiteMetaDescription', 'websiteMetaKeywords', 'websiteMetaOgImg'];
        if (opts.resModel === 'website.page') {
            extend(fields, ['websiteIndexed', 'websiteId']);
        }
        const record = (await req.getEnv()).items(opts.resModel).browse(opts.resId);
        const result = (await record._readFormat(fields))[0]
        result['hasSocialDefaultImage'] = await req.website.hasSocialDefaultImage;

        if (['website.page', 'ir.ui.view'].includes(opts.resModel) && 'seoName' in record._fields) {  // allow custom slugify
            result['seoNameDefault'] = slugify(await record.displayName);  // default slug, if seoName become empty
            result['seoName'] = await record.seoName && slugify(await record.seoName) || '';
        }
        return result;
    }

    @http.route(['/google<string(length=16):key>.html'], { type: 'http', auth: "public", website: true, sitemap: false })
    async googleConsoleSearch(req, res, opts: { key?: any } = {}) {
        const key = opts.key;
        if (! await req.website.googleSearchConsole) {
            console.warn('Google Search Console not enable');
            throw new NotFound(res);
        }
        const gsc = await req.website.googleSearchConsole;
        const trusted = gsc.slice(gsc.startsWith('google') && len('google'), gsc.endsWith('.html') && -len('.html') || undefined);

        if (key !== trusted) {
            if (key.startsWith(trusted)) {
                await (await req.website.sudo()).set('googleSearchConsole', f("google%s.html", key));
            }
            else {
                console.warn('Google Search Console %s not recognize', key);
                throw new NotFound(res);
            }
        }
        return req.makeResponse(res, f("google-site-verification: %s", await req.website.googleSearchConsole));
    }

    @http.route('/website/googleMapsApiKey', { type: 'json', auth: 'public', website: true })
    async googleMapsApiKey(req, res) {
        return stringify({
            'googleMapsApiKey': await req.website.googleMapsApiKey || ''
        });
    }

    // ------------------------------------------------------
    // Themes
    // ------------------------------------------------------

    async _getCustomizeData(req, keys, isViewData) {
        const modelName = isViewData ? 'ir.ui.view' : 'ir.asset';
        const model = await (await req.getEnv()).items(modelName).withContext({ activeTest: false });
        keys = keys.filter(key => key.length); // remove key == '' for faster
        if (!bool(keys)) {
            return model;
        }
        const domain = [["key", "in", keys]].concat(req.website.websiteDomain());
        return (await model.search(domain)).filterDuplicate();
    }

    @http.route(['/website/themeCustomizeDataGet'], { type: 'json', auth: 'user', website: true })
    async themeCustomizeDataGet(req, res, opts: { keys?: any, isViewData?: any } = {}) {
        const records = await this._getCustomizeData(req, opts.keys, opts.isViewData);
        return (await records.filtered('active')).mapped('key');
    }

    /**
     * Enables and/or disables views/assets according to list of keys.

        :param isViewData: true = "ir.ui.view", false = "ir.asset"
        :param enable: list of views/assets keys to enable
        :param disable: list of views/assets keys to disable
        :param resetViewArch: restore the default template after disabling
     * @param req 
     * @param res 
     * @param opts 
     */
    @http.route(['/website/themeCustomizeData'], { type: 'json', auth: 'user', website: true })
    async themeCustomizeData(req, res, opts: { isViewData?: any, enable?: any, disable?: any, resetViewArch?: any } = {}) {
        const disabledData = await (await this._getCustomizeData(req, opts.disable, opts.isViewData)).filtered('active');
        if (opts.resetViewArch) {
            await disabledData.resetArch('hard');
        }
        await disabledData.write({ 'active': false });
        await (await (await this._getCustomizeData(req, opts.enable, opts.isViewData)).filtered(async (x) => ! await x.active)).write({ 'active': true });
    }

    /**
     * Reloads asset bundles and returns their unique URLs.
     * @param req 
     * @param res 
     * @param opts 
     * @returns 
     */
    @http.route(['/website/themeCustomizeBundleReload'], { type: 'json', auth: 'user', website: true })
    async themeCustomizeBundleReload(req, res) {
        return {
            'web.assetsCommon': await (await req.getEnv()).items('ir.qweb')._getAssetLinkUrls('web.assetsCommon'),
            'web.assetsFrontend': await (await req.getEnv()).items('ir.qweb')._getAssetLinkUrls('web.assetsFrontend'),
            'website.assetsEditor': await (await req.getEnv()).items('ir.qweb')._getAssetLinkUrls('website.assetsEditor'),
        }
    }

    /**
     * Params:
            url (str):
                the URL of the scss file to customize (supposed to be a variable
                file which will appear in the assets_common bundle)

            values (dict):
                key,value mapping to integrate in the file's map (containing the
                word hook). If a key is already in the file's map, its value is
                overridden.

        Returns:
            boolean
     * @param req 
     * @param res 
     * @param opts 
     * @returns 
     */
    @http.route(['/website/make_scss_custo'], { type: 'json', auth: 'user', website: true })
    async makeScssCusto(req, res, opts: { url?: any, values?: any } = {}) {
        await (await req.getEnv()).items('webeditor.assets').makeScssCustomization(opts.url, opts.values);
        return true;
    }

    // ------------------------------------------------------
    // Server actions
    // ------------------------------------------------------

    @http.route([
        '/website/action/<pathOrXmlidOrId>',
        '/website/action/<pathOrXmlidOrId>/<path:path>',
    ], { type: 'http', auth: "public", website: true })
    async actionsServer(req, res, opts: { pathOrXmlidOrId?: any, post?: any } = {}) {
        const pathOrXmlidOrId = opts.pathOrXmlidOrId;
        const serverActions = (await req.getEnv()).items('ir.actions.server');
        let action, actionId;// = None

        // find the actionId: either an xmlid, the path, or an ID
        if (typeof (pathOrXmlidOrId) === 'string' && pathOrXmlidOrId.includes('.')) {
            action = await (await (await req.getEnv()).ref(pathOrXmlidOrId, false)).sudo();
        }
        if (!bool(action)) {
            action = await (await serverActions.sudo()).search(
                [['websitePath', '=', pathOrXmlidOrId], ['websitePublished', '=', true]], { limit: 1 });
        }
        if (!bool(action)) {
            try {
                actionId = parseInt(pathOrXmlidOrId);
                action = await (await (await serverActions.sudo()).search([['actionId', '=', actionId]])).exists();
            } catch (e) {
                if (!isInstance(e, ValueError)) {
                    throw e;
                }
            }
        }
        // run it, return only if we got a Response object
        if (bool(action)) {
            if (await action.state === 'code' && await action.websitePublished) {
                // use main session env for execution
                const actionRes = await serverActions.browse(action.id).run();
                if (isInstance(actionRes, BaseResponse)) {
                    return actionRes;
                }
            }
        }
        return req.redirect(res, '/')
    }
}

// Retrocompatibility routes
@http.define()
class WebsiteBinary extends http.Controller {
    static _module = module;

    @http.route([
        '/website/image',
        '/website/image/<xmlid>',
        '/website/image/<xmlid>/<int:width>x<int:height>',
        '/website/image/<xmlid>/<field>',
        '/website/image/<xmlid>/<field>/<int:width>x<int:height>',
        '/website/image/<model>/<id>/<field>',
        '/website/image/<model>/<id>/<field>/<int:width>x<int:height>'
    ], { type: 'http', auth: "public", website: false, multilang: false })
    async contentImage(req, res, opts: { id?: any, maxWidth?: number, maxHeight?: number } = {}) {
        if (opts.maxWidth) {
            opts['width'] = opts.maxWidth;
        }
        if (opts.maxHeight) {
            opts['height'] = opts.maxHeight;
        }
        if (opts.id) {
            const [id, , unique] = stringPart(opts.id, '_');
            opts['id'] = parseInt(id);
            if (unique) {
                opts['unique'] = unique;
            }
        }
        opts['resId'] = pop(opts, 'id', null);
        return (await req.getEnv()).items('ir.http')._contentImage(opts);
    }

    // if not icon provided in DOM, browser tries to access /favicon.ico, eg when opening an order pdf
    @http.route(['/favicon.ico'], { type: 'http', auth: 'public', website: true, multilang: false, sitemap: false })
    async favicon(req: WebRequest, res, opts) {
        const website = req.website;
        const response = await req.redirect(res, await website.imageUrl(website, 'favicon'), 301);
        response.setHeader('Cache-Control', f('public, max-age=%s', http.STATIC_CACHE_LONG));
        return response;
    }
}