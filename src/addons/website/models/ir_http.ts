import { ServerResponse } from "http";
import _ from "lodash";
import path from "path";
import xpath from "xpath";
import { api, registry } from "../../../core";
import { Environment, getattr, hasattr, setattr } from "../../../core/api";
import { serverWideModules } from "../../../core/conf";
import { AccessError, KeyError, ValueError } from "../../../core/helper";
import { WebRequest, WebResponse } from "../../../core/http";
import { AbstractModel, BaseModel, MetaModel, _super } from "../../../core/models";
import { FALSE_DOMAIN } from "../../../core/osv/expression";
import { Forbidden, NotFound } from "../../../core/service";
import { Router } from "../../../core/service/middleware";
import { bool, doWith, extend, f, getTimezoneInfo, isInstance, len, parseInt, partial, pop, rstrip, setOptions, update } from "../../../core/tools";
import { safeEval } from "../../../core/tools/save_eval";
import * as ir_http from '../../http_routing';
import { buildUrlWParams } from "../../portal";
import assert from "assert";

@MetaModel.define()
class IrHttp extends AbstractModel {
    static _module = module;
    static _parents = 'ir.http';
    _rewriteLen: {};
    static _rewriteLen: any;

    constructor() {
        super();
        this._rewriteLen = {};
    }

    async routingMap(req: any, key: any = null): Promise<Router> {
        key = key || (req && req.websiteRouting);
        return _super(IrHttp, this).routingMap(req, key);
    }

    clearCaches() {
        _super(IrHttp, this)._clearRoutingMap();
        return _super(IrHttp, this).clearCaches();
    }

    static async _slugMatching(req: WebRequest, endpoint: any, adapter: any, opts: {} = {}) {
        for (const [key, val] of Object.entries<any>(opts)) {
            if (isInstance(val, BaseModel)) {
                opts[key] = await val.withContext({ slugMatching: true });
            }
        }
        const qs = req.params.searchQuery;
        return adapter.build(endpoint, opts) + (qs && f('?%s', qs || ''));
    }

    async _match(req, pathInfo, key?: any) {
        key = key || (req && req.websiteRouting);
        return _super(IrHttp, this)._match(req, pathInfo, key);
    }

    static async* _generateRoutingRules(req, modules: any[], converters: any) {
        const websiteId = req.websiteRouting;
        console.debug("_generateRoutingRules for website: %s", websiteId);
        const domain = [['redirectType', 'in', ['308', '404']], '|', ['websiteId', '=', false], ['websiteId', '=', websiteId]];

        const rewrites = Object.fromEntries(await (await (await (await req.getEnv()).items('website.rewrite').sudo()).search(domain)).map(async x => [await x.urlFrom, x]));
        this._rewriteLen[websiteId] = len(rewrites);

        for await (let [url, endpoint, routing] of _super(IrHttp, this)._generateRoutingRules(req, modules, converters)) {
            routing = Object.assign({}, routing);
            if (url in rewrites) {
                const rewrite = rewrites[url];
                const urlTo = rewrite.urlTo;
                if (rewrite.redirectType == '308') {
                    console.debug('Add rule %s for %s', urlTo, websiteId);
                    yield [urlTo, endpoint, routing]  // yield new url

                    if (url != urlTo) {
                        console.debug('Redirect from %s to %s for website %s', url, urlTo, websiteId);
                        const _slugMatching = partial(this._slugMatching, req, endpoint);
                        routing['redirectTo'] = _slugMatching;
                        yield [url, endpoint, routing]  // yield original redirected to new url
                    }
                }
                else if (rewrite.redirectType == '404') {
                    console.debug('Return 404 for %s for website %s', url, websiteId);
                    continue;
                }
            } else {
                yield [url, endpoint, routing];
            }
        }
    }

    /**
     * Get the converters list for custom url pattern theveb need to
            match Rule. This override adds the website ones.
     * @returns 
     */
    _getConverters() {
        return Object.assign({},
            _super(IrHttp, this)._getConverters(),
            { 'model': ModelConverter },
        )
    }


    async _authMethodPublic(req) {
        if (!req.session.uid) {
            const env = await Environment.new(await req.getCr(), global.SUPERUSER_ID, req.context);
            const website = await env.items('website').getCurrentWebsite();
            req.uid = bool(website) && await website._getCached('userId');
        }
        if (!req.uid) {
            await _super(IrHttp, this)._authMethodPublic(req);
        }
    }

    async _registerWebsiteTrack(req, res) {
        if (getattr(res, 'statusCode', 0) != 200) {
            return false;
        }

        let websitePage, template;// = false;
        if (hasattr(res, '_cachedPage')) {
            [websitePage, template] = [res._cachedPage, res._cachedTemplate];
        }
        else if (hasattr(res, 'qcontext')) {  // classic response
            const mainObject = res.qcontext['mainObject'];
            websitePage = getattr(mainObject, '_name', false) === 'website.page' && bool(mainObject);
            template = res.qcontext['responseTemplate'];
        }
        const env = await req.getEnv();
        const view = template && await env.items('website').getTemplate(template);
        if (bool(view) && await view.track) {
            await env.items('website.visitor')._handleWebpageDispatch(res, websitePage);
        }

        return false;
    }

    async _postprocessArgs(req, res, args: {} = {}, rule?: any) {
        const processing = await _super(IrHttp, this)._postprocessArgs(req, res, args, rule);
        if (processing) {
            return processing;
        }

        for (const record of Object.values<any>(args)) {
            if (isInstance(record, BaseModel) && record['canAccessFromCurrentWebsite']) {
                try {
                    if (! await record.canAccessFromCurrentWebsite()) {
                        return (await req.getEnv()).items('ir.http')._handleException(req, res, new NotFound(res));
                    }
                } catch (e) {
                    if (isInstance(e, AccessError)) {
                        // record.websiteId might not be readable as unpublished `event.event` due to ir.rule,
                        // return 403 instead of using `sudo()` for perfs as this is low level
                        return (await req.getEnv()).items('ir.http')._handleException(req, res, new Forbidden(res));
                    }
                    throw e;
                }
            }
        }
    }

    /**
     * In case of rerouting for translate (e.g. when visiting theverp.com/fr_BE/),
        _dispatch calls reroute() that returns _dispatch with altered request properties.
        The second _dispatch will continue until end of process. When second _dispatch is finished, the first _dispatch
        call receive the new altered request and continue.
        At the end, 2 calls of _dispatch (and this override) are made with exact same request properties, instead of one.
        As the response has not been sent back to the client, the visitor cookie does not exist yet when second _dispatch call
        is treated in _handle_webpage_dispatch, leading to create 2 visitors with exact same properties.
        To avoid this, we check if, !!! before calling super !!!, we are in a rerouting request. If not, it means that we are
        handling the original request, in which we should create the visitor. We ignore every other rerouting requests.
     * @param req 
     * @param res 
     * @returns 
     */
    async _dispatch(req: WebRequest, res: ServerResponse) {
        const isRerouting = hasattr(req, 'routingIteration');
        const isRerouting2 = 'routingIteration' in req;
        assert(isRerouting === isRerouting2);
        if (req.session.db) {
            const reg = await registry(req.session.db);
            const cr = reg.cursor();
            await doWith(cr, async () => {
                const env = await Environment.new(cr, global.SUPERUSER_ID, {}, false, req);
                setattr(req, 'websiteRouting', (await env.items('website').getCurrentWebsite()).id);
            });
        }
        res = await _super(IrHttp, this)._dispatch(req, res);

        if (!isRerouting) {
            await this._registerWebsiteTrack(req, res);
        }
        return res;
    }

    async _addDispatchParameters(req, func) {

        // DEPRECATED for /website/force/<websiteId> - remove me in master~saas-14.4
        // Force website with query string paramater, typically set from website selector in frontend navbar and inside tests
        const forceWebsiteId = req.params['fw'];
        const env = await req.getEnv();
        const user = await env.user();
        if (forceWebsiteId && req.session['forceWebsiteId'] != forceWebsiteId
            && await user.hasGroup('website.groupMultiWebsite')
            && await user.hasGroup('website.groupWebsitePublisher')) {
            await env.items('website')._forceWebsite(req.params['fw']);
        }
        const context = {};
        if (!req.context['tz']) {
            context['tz'] = (req.session['geoip'] ?? {})['timeZone'];
            try {
                getTimezoneInfo(context['tz'] || '');
            } catch (e) {
                if (isInstance(e, RangeError)) {
                    pop(context, 'tz');
                } else {
                    throw e;
                }
            }
        }
        req.website = await env.items('website').getCurrentWebsite();  // can use `request.env` since auth methods are called
        context['websiteId'] = req.website.id;
        // This is mainly to avoid access errors in website controllers where there is no
        // context (eg: /shop), and it's not going to propagate to the global context of the tab
        // If the company of the website is not in the allowed companies of the user, set the main
        // company of the user.
        const websiteCompanyId = await req.website._getCached('companyId');
        if (await req.website.isPublicUser()) {
            // avoid a read on res_company_user_rel in case of public user
            context['allowedCompanyIds'] = [websiteCompanyId];
        }
        else if ((await user.companyIds).ids.includes(websiteCompanyId)) {
            context['allowedCompanyIds'] = [websiteCompanyId];
        }
        else {
            context['allowedCompanyIds'] = (await user.companyId).ids;
        }
        // modify bound context
        req.context = Object.assign({}, req.context, context);

        await _super(IrHttp, this)._addDispatchParameters(req, func);

        if (req.routingIteration == 1) {
            req.website = await req.website.withContext(req.context);
        }
    }

    async _getFrontendLangs(req) {
        if (getRequestWebsite(req)) {
            return (await (await req.getEnv()).items('res.lang').getAvailable()).map(([code]) => code);
        }
        else {
            return _super(IrHttp, this)._getFrontendLangs(req);
        }
    }

    async _getDefaultLang(req) {
        if (getattr(req, 'website', false)) {
            return (await req.getEnv()).items('res.lang').browse(await req.website._getCached('defaultLangId'));
        }
        return _super(IrHttp, this)._getDefaultLang(req);
    }

    async _getTranslationFrontendModulesName(req) {
        const mods = await _super(IrHttp, this)._getTranslationFrontendModulesName(req);
        const installed = _.intersection<any>(Array.from((await req.getRegistry())._initModules), serverWideModules);
        return mods.concat(installed.filter(mod => mod.startsWith('website')));
    }

    async _servePage(req: WebRequest, res: ServerResponse) {
        const reqPage = req.httpRequest.pathname;

        async function _searchPage(comparator = '=') {
            const pageDomain = [['url', comparator, reqPage]].concat(req.website.websiteDomain());
            return (await (await req.getEnv()).items('website.page').sudo()).search(pageDomain, { order: 'websiteId asc', limit: 1 });
        }
        // specific page first
        let page = await _searchPage();

        // case insensitive search
        if (!bool(page)) {
            page = await _searchPage('=ilike');
            if (bool(page)) {
                console.info("Page %s not found, redirecting to existing page %s", reqPage, await page.url);
                return req.redirect(res, await page.url);
            }
        }
        // redirect without trailing /
        if (!bool(page) && reqPage !== "/" && reqPage.endsWith("/")) {
            // mimick `_postprocessArgs()` redirect
            let path = req.httpRequest.pathname.slice(0, -1);
            if (!req.lang.eq(await this._getDefaultLang(req))) {
                path = '/' + await req.lang.urlCode + path;
            }
            if (req.uri.search) {
                path += '?' + Buffer.from(req.uri.search).toString('utf-8');
            }
            return req.redirect(res, path, 301);
        }

        if (bool(page)) {
            // prefetch all menus (it will prefetch website.page too)
            const menuPagesIds = await req.website._getMenuPageIds(req);
            await page.browse([page.id].concat(menuPagesIds)).mapped('viewId.label');
            await req.website.menuId;
        }
        if (bool(page) && (await req.website.isPublisher() || await page.isVisible)) {
            let needToCache = false;
            const cacheKey = await page._getCacheKey(req);
            if (
                await page.cacheTime  // cache > 0
                && req.httpRequest.method == "GET"
                && await (await (await req.getEnv()).user())._isPublic()    // only cache for unlogged user
                && !('nocache' in req.params)  // allow bypass cache / debug
                && !req.session.debug
                && len(cacheKey) && cacheKey[cacheKey.length-1] != null  // nocache via expr
            ) {
                needToCache = true;
                try {
                    const r = page._getCacheResponse(cacheKey);
                    if (new Date(r.get('time') + await page.cacheTime) > new Date()) {
                        const response = new WebResponse(req, res, r.get('content'), { mimetype: r.get('contenttype') });
                        setattr(response, '_cachedTemplate', r.get('template'));
                        setattr(response, '_cachedPage', page);
                        return res;
                    }
                } catch (e) {
                    if (!isInstance(e, KeyError, TypeError)) {
                        throw e;
                    }
                }
            }
            const _path = path.parse(reqPage);
            const response = await req.render(res, (await page.viewId).id, {
                deletable: true,
                mainObject: page,
                mimetype: ir_http._guessMimetype(_path.ext)
            });

            if (needToCache && response.statusCode == 200) {
                const r = await response.render();
                page._setCacheResponse(cacheKey, {
                    'content': r,
                    'contenttype': response.getHeader('Content-Type'),
                    'time': new Date(),
                    'template': getattr(res, 'qcontext', {})['responseTemplate']
                })
            }
            return response;
        }
        return false;
    }

    async _serveRedirect(req, res) {
        const reqPage = req.httpRequest.pathname;
        const domain = [
            ['redirectType', 'in', ['301', '302']],
            // trailing / could have been removed by server_page
            '|', ['urlFrom', '=', rstrip(reqPage, '/')], ['urlFrom', '=', reqPage + '/']
        ];
        extend(domain, req.website.websiteDomain());
        return (await (await req.getEnv()).items('website.rewrite').sudo()).search(domain, { limit: 1 });
    }

    async _serveFallback(req, res, exception) {
        // serve attachment before
        const parent = await _super(IrHttp, this)._serveFallback(req, res, exception);
        if (bool(parent)) {  // attachment
            return parent;
        }
        if (!req.isFrontend) {
            return false;
        }
        const websitePage = await this._servePage(req, res);
        if (websitePage) {
            return websitePage;
        }

        const redirect = await this._serveRedirect(req, res);
        if (redirect) {
            return req.redirect(res,
                buildUrlWParams(await redirect.urlTo, req.params),
                await redirect.redirectType,
                false
            );  // safe because only designers can specify redirects
        }
        return false;
    }

    async _getExceptionCodeValues(req: WebRequest, exception) {
        let [code, values] = await _super(IrHttp, this)._getExceptionCodeValues(req, exception);
        if (isInstance(exception, NotFound) && await req.website.isPublisher()) {
            code = 'page_404';
            values['path'] = req.httpRequest.pathname.slice(1);
        }
        if (isInstance(exception, Forbidden) &&
            exception.description == "websiteVisibilityPasswordRequired") {
            code = 'protected_403'
            values['path'] = req.httpRequest.pathname;
        }
        return [code, values]
    }

    async _getValues500Error(req, env, values, exception) {
        const View = env.items("ir.ui.view");
        values = await _super(IrHttp, this)._getValues500Error(req, env, values, exception);
        if ('qwebException' in values) {
            let exceptionTemplate;
            try {
                // exception.name might be int, string
                exceptionTemplate = parseInt(exception.name);
            } catch (e) {
                if (isInstance(e, ValueError)) {
                    exceptionTemplate = exception.name;
                }
                else {
                    throw e;
                }
            }
            const view = await View._viewObj(exceptionTemplate);
            if (exception.html && (await view.arch).includes(exception.html)) {
                values['view'] = view;
            }
            else {
                // There might be 2 cases where the exception code can't be found
                // in the view, either the error is in a child view or the code
                // contains branding (<div t-att-data="request.browse('ok')"/>).
                const et = await (await view.withContext({ inheritBranding: false }))._getCombinedArch();
                const node = exception.path ? xpath.select1(exception.path, et) : et;
                const line = node != null && node.toString('unicode');
                if (line) {
                    values['view'] = await (await View._viewsGet(exceptionTemplate)).filtered(
                        async (v) => (await v.arch).includes(line)
                    )
                    values['view'] = values['view'] && values['view'][0];
                }
            }
        }
        // Needed to show reset template on translated pages (`_prepareQcontext` will set it for main lang)
        values['editable'] = req.uid && await req.website.isPublisher();
        return values;
    }

    async _getErrorHtml(req, env, code, values) {
        if (['page_404', 'protected_403'].includes(code)) {
            return [code.split('_')[1], await env.items('ir.ui.view')._renderTemplate(f('website.%s', code), values)];
        }
        return _super(IrHttp, this)._getErrorHtml(req, env, code, values);
    }

    async binaryContent(req, options: { xmlid?: string, model?: string, id?: number, field?: string, unique?: boolean, filename?: string, filenameField?: string, download?: boolean, mimetype?: string, defaultMimetype?: string, accessToken?: string, defaultFilename?: string } = {}) {
        setOptions(options, { model: 'ir.attachment', field: 'datas', filenameField: 'label', defaultMimetype: 'application/octet-stream' });
        let obj;
        if (options.xmlid) {
            obj = await (this as any)._xmlidToObj(req, this.env, options.xmlid);
        }
        else if (options.id && options.model in this.env.models) {
            obj = this.env.items(options.model).browse(parseInt(options.id));
        }
        let self = this;
        if (bool(obj) && 'websitePublished' in obj._fields) {
            if (await (await this.env.items(obj._name).sudo()).search([['id', '=', obj.id], ['websitePublished', '=', true]])) {
                self = await self.sudo();
            }
        }
        return _super(IrHttp, self).binaryContent(req, options);
    }

    async _xmlidToObj(req, env, xmlid) {
        const websiteId = await env.items('website').getCurrentWebsite();
        if (bool(websiteId) && await websiteId.themeId) {
            const domain = [['key', '=', xmlid], ['websiteId', '=', websiteId.id]];
            let attachment = env.items('ir.attachment');
            if (await (await (await req.getEnv()).user().share)) {
                domain.push(['isPublic', '=', true]);
                attachment = await attachment.sudo();
            }
            const obj = await attachment.search(domain);
            if (bool(obj)) {
                return obj[0];
            }
        }
        return _super(IrHttp, this)._xmlidToObj(req, env, xmlid);
    }

    @api.model()
    async getFrontendSessionInfo(req) {
        const sessionInfo = await _super(IrHttp, this).getFrontendSessionInfo(req);
        const env = await req.getEnv();
        const user = await env.user();
        update(sessionInfo, {
            'isWebsiteUser': user.id == (await req.website.userId).id,
            'langUrlCode': await req.lang._getCached('urlCode'),
            'geoipCountryCode': (req.session['geoip'] ?? {})['countryCode'],
        });
        if (await user.hasGroup('website.groupWebsitePublisher')) {
            update(sessionInfo, {
                'websiteId': req.website.id,
                'websiteCompanyId': await req.website._getCached('companyId'),
            });
        }
        return sessionInfo;
    }
}

class ModelConverter extends ir_http.ModelConverter {

    async toUrl(value) {
        if (value?.env?.context?.slugMatching) {
            return value.env.context['_converterValue'] ?? String(value.id);
        }
        return super.toUrl(value);
    }

    async* generate(req, uid, dom?: any, args?: any) {
        const env = await req.getEnv();
        const model = await env.items(this.model).withUser(uid);
        // Allow to current_website_id directly in route domain
        update(args, { currentWebsiteId: (await env.items('website').getCurrentWebsite()).id });
        const domain = safeEval(this.domain, Object.assign({}, args ?? {}));
        if (dom) {
            extend(domain, dom);
        }
        for (const record of await model.search(domain)) {
            // return record so URL will be the real endpoint URL as the record will go through `slug()`
            // the same way as endpoint URL is retrieved during dispatch (301 redirect), see `to_url()` from ModelConverter
            yield record;
        }
    }
}

/**
 * Return the website set on `request` if called in a frontend context
    (website=true on route).
    This method can typically be used to check if we are in the frontend.

    This method is easy to mock during tests to simulate frontend
    context, rather than mocking every method accessing request.website.

    Don't import directly the method or it won't be mocked during tests, do:
    ```
    from verp.addons.website.models import ir_http
    myVar = ir_http.getRequestWebsite()
 * @param req 
 * @returns 
 */
export function getRequestWebsite(req: any) {
    return req && getattr(req, 'website', false) || false;
}

/**
 * Convert a query_string (can contains a path) to a domain
 * @param qs 
 * @param route 
 * @param field 
 * @returns 
 */
export function sitemapQs2dom(qs, route, field: string = 'label') {
    let dom = [];
    if (qs && !route.includes(qs.toLowerCase())) {
        const needles = qs.strip('/').split('/');
        // needles will be altered and keep only element which one is not in route
        // diff(from=['shop', 'product'], to=['shop', 'product', 'product']) => to=['product']
        unorderableListDifference(route.strip('/').split('/'), needles);
        if (len(needles) == 1) {
            dom = [[field, 'ilike', needles[0]]];
        }
        else {
            dom = Array.from(FALSE_DOMAIN);
        }
    }
    return dom;
}

/**
 * Same behavior as sorted_list_difference but
    for lists of unorderable items (like dicts).

    As it does a linear search per item (remove) it
    has O(n*n) performance.
 * @param expected 
 * @param actual 
 */
function unorderableListDifference(expected, actual: Set<any>) {
    const missing = [];
    while (bool(expected)) {
        const item = expected.pop();
        try {
            actual.delete(item);
        } catch (e) {
            if (isInstance(e, ValueError)) {
                missing.push(item);
            } else {
                throw e;
            }
        }
    }
    // anything left in actual is unexpected
    return [missing, actual]
}