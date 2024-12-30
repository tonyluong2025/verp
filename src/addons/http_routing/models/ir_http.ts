import assert from "assert";
import { ServerResponse } from "http";
import { decode } from "utf8";
import { api, registry, tools } from "../../../core";
import { QWebException } from "../../../core/addons/base";
import * as ir_http from '../../../core/addons/base/models/ir_http';
import { Environment, getattr, hasattr } from "../../../core/api";
import { AccessError, MissingError, UserError } from "../../../core/helper";
import { WebRequest, _root } from "../../../core/http";
import { AbstractModel, MetaModel, _super } from "../../../core/models";
import { expression } from "../../../core/osv";
import { HTTPException, MethodNotAllowed, NotFound } from "../../../core/service";
import { BaseResponse } from "../../../core/service/middleware/base_response";
import { HTTP_STATUS_CODES, cleanString, urlUnquotePlus } from "../../../core/service/middleware/utils";
import { RequestRedirect, Rule } from "../../../core/service/middleware";
import { bool, config, doWith, f, isInstance, len, lstrip, parseInt, slug, stringPart, update, urlFor, ustr } from "../../../core/tools";

export function _guessMimetype(ext: any = null, value: string = 'text/html'): {} {
    const exts = {
        '.css': 'text/css',
        '.less': 'text/less',
        '.scss': 'text/scss',
        '.js': 'text/javascript',
        '.xml': 'text/xml',
        '.csv': 'text/csv',
        '.html': 'text/html',
    }
    return ext != null && (exts[ext] ?? value) || exts;
}

// NOTE: as the pattern is used as it for the ModelConverter (ir_http.js), do not use any flags
const _UNSLUG_RE = /(?:(\w{1,2}|\w[A-Za-z0-9-_]+?\w)-)?(-?\d+)(?=$|\/)/;

export class ModelConverter extends ir_http.ModelConverter {
    domain: any;

    constructor(urlMap, model?: any, domain: any = '[]') {
        super(urlMap, model);
        this.domain = domain;
        this.regex = _UNSLUG_RE;
    }

    async toUrl(value) {
        return slug(value == null ? [] : [value.id, await value.seoName || await value.displayName]);
    }

    async toPrimary(req: WebRequest, value: string) {
        const matching = value.match(this.regex);
        const uid = new ir_http.RequestUID({ value: value, match: matching, converter: this });
        let recordId = parseInt(matching[2]);
        const env = await Environment.new(await req.getCr(), uid, req.context, false, req);
        if (recordId < 0) {
            // limited support for negative IDs due to our slug pattern, assume abs() if not found
            if (!bool(env.items(this.model).browse(recordId).exists())) {
                recordId = Math.abs(recordId);
            }
        }
        return (await env.items(this.model).withContext({ _converterValue: value })).browse(recordId);
    }
}

@MetaModel.define()
class IrHttp extends AbstractModel {
    static _module = module;
    static _parents = 'ir.http';

    reroutingLimit = 10;

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

    async _getDefaultLang(req) {
        const env = await req.getEnv();
        const langCode = await (await env.items('ir.default').sudo()).get('res.partner', 'lang');
        if (langCode) {
            return env.items('res.lang')._langGet(langCode);
        }
        return env.items('res.lang').search([], { limit: 1 });
    }

    @api.model()
    async getFrontendSessionInfo(req) {
        const sessionInfo = await _super(IrHttp, this).getFrontendSessionInfo(req);
        const env = await req.getEnv();
        const irHttpModel = await env.items('ir.http').sudo();
        const modules = await irHttpModel.getTranslationFrontendModules(req);
        const userContext = req.session.uid ? req.session.getContext(req) : {};
        const lang = userContext['lang'];
        const translationHash = await env.items('ir.translation').getWebTranslationsHash(modules, lang);

        update(sessionInfo, {
            'translationURL': '/website/translations',
            'cacheHashes': {
                'translations': translationHash,
            },
        })
        return sessionInfo;
    }

    @api.model()
    async getTranslationFrontendModules(req: WebRequest) {
        const modules = await (await req.getEnv()).items('ir.module.module').sudo();
        const extraModulesDomain = await this._getTranslationFrontendModulesDomain(req);
        let extraModulesName = await this._getTranslationFrontendModulesName(req);
        if (bool(extraModulesDomain)) {
            const newModule = await (await modules.search(
                expression.AND([extraModulesDomain, [['state', '=', 'installed']]])
            )).mapped('label');
            extraModulesName.push(newModule);
        }
        return extraModulesName;
    }

    /**
     * Return a domain to list the domain adding web-translations and
              dynamic resources that may be used frontend views
     * @returns 
     */
    async _getTranslationFrontendModulesDomain(req) {
        return [];
    }

    /**
     * Return a list of module name where web-translations and
            dynamic resources may be used in frontend views
     * @returns 
     */
    async _getTranslationFrontendModulesName(req) {
        return ['web']
    }

    static bots = "bot|crawl|slurp|spider|curl|wget|facebookexternalhit".split("|");

    isABot(req: WebRequest) {
        // We don't use regexp and ustr voluntarily
        // timeit has been done to check the optimum method
        const userAgent = String(req.headers['user-agent'] || '').toLowerCase();
        try {
            const result = IrHttp.bots.some(bot => userAgent.includes(bot));
            return result;
        } catch (e) {
            //   except UnicodeDecodeError:
            const result = IrHttp.bots.some(bot => cleanString(userAgent, 'ignore').includes(bot));
            return result;
        }
    }

    async _getFrontendLangs(req) {
        return (await (await req.getEnv()).items('res.lang').getInstalled()).map(([code]) => code);
    }

    /**
     * 
     * @param req Try to find a similar lang. Eg: fr_BE and fr_FR
            :param lang_code: the lang `code` (en_US)
     * @param langCode 
     * @returns 
     */
    async getNearestLang(req, langCode) {
        if (!langCode) {
            return false;
        }
        let shortMatch = false;
        const short = stringPart(langCode, '_')[0];
        for (const code of await this._getFrontendLangs(req)) {
            if (code === langCode) {
                return code;
            }
            if (!shortMatch && code.startsWith(short)) {
                shortMatch = code;
            }
        }
        return shortMatch;
    }

    async _geoipSetupResolver(req) {
        // Lazy init of GeoIP resolver
        if (global._geoipResolver != null) {
            return;
        }
        const geofile = config.get('geoipDatabase');
        try {
            global._geoipResolver = false;//GeoIPResolver.open(geofile) || false;
        } catch (e) {
            console.warn('Cannot load GeoIP: %s', ustr(e));
        }
    }

    async _geoipResolve(req: WebRequest) {
        if (!('geoip' in req.session)) {
            let record = {};
            if (global._geoipResolver && req.httpRequest.socket.remoteAddress) {
                record = global._geoipResolver.resolve(req.httpRequest.socket.remoteAddress) || {};
            }
            req.session['geoip'] = record;
        }
    }

    async _addDispatchParameters(req: WebRequest, func) {
        let Lang = (await req.getEnv()).items('res.lang');
        // only called for isFrontend request
        if (req.routingIteration == 1) {
            const context = Object.assign({}, req.context);
            const path = req.uri.pathname.split('/');
            const isABot = this.isABot(req);

            const langCodes = (await Lang.getAvailable()).map(([code]) => code);
            const nearestLang = !func && await this.getNearestLang(req, await Lang._langGetCode(path[1]));
            let cookLang = req.cookie['frontend_lang'];
            cookLang = langCodes.includes(cookLang) && cookLang;

            let lang;
            if (nearestLang) {
                lang = await Lang._langGet(nearestLang);
            }
            else {
                let nearestCtxLg = !isABot && await this.getNearestLang(req, (await req.getEnv()).context['lang']);
                nearestCtxLg = langCodes.includes(nearestCtxLg) && nearestCtxLg;
                const preferredLang = await Lang._langGet(cookLang || nearestCtxLg);
                lang = bool(preferredLang) ? preferredLang : await this._getDefaultLang(req);
            }
            req.lang = lang;
            context['lang'] = await lang._getCached('code');

            // bind modified context
            req.context = context;
        }
    }

    /**
     * Before executing the endpoint method, add website params on request, such as
                - current website (record)
                - multilang support (set on cookies)
                - geoip dict data are added in the session
            Then follow the parent dispatching.
            Reminder :  Do not use `request.env` before authentication phase, otherwise the env
                        set on request will be created with uid=None (and it is a lazy property)
     * @param req 
     * @param res 
     * @returns 
     */
    async _dispatch(req: WebRequest, res: ServerResponse) {
        req.routingIteration = getattr(req, 'routingIteration', 0) + 1;

        let func;
        let routingError;
        let newUrl;
        // handle // in url
        if (req.httpRequest.method === 'GET' && req.uri.pathname.includes('//')) {
            newUrl = req.uri.pathname.replace('//', '/') + '?' + decode(req.uri.search);
            return req.redirect(res, newUrl, 301);
        }
        // locate the controller method
        try {
            const [rule, args] = await (this as any)._match(req, req.uri.pathname);
            func = rule.endpoint;
            req.isFrontend = func.routing['website'] ?? false;
        } catch (e) {
            if (isInstance(e, NotFound)) {
                // either we have a language prefixed route, either a real 404
                // in all cases, website processes them exept if second element is static
                // Checking static will avoid to generate an expensive 404 web page since
                // most of the time the browser is loading and inexisting assets or image. A standard 404 is enough.
                // Earlier check would be difficult since we don't want to break data modules
                const pathComponents = req.uri.pathname.split('/');
                req.isFrontend = len(pathComponents) < 3 || pathComponents[2] !== 'static' || !pathComponents[pathComponents.length-1].includes('.');
                routingError = e;
            } else {
                throw e;
            }
        }
        req.isFrontendMultilang = !func || (func && req.isFrontend && (func.routing['multilang'] ?? func.routing['type'] == 'http'));

        // check authentication level
        try {
            if (func) {
                await (this as any)._authenticate(req, func);
            }
            else if (req.uid == null && req.isFrontend) {
                await (this as any)._authMethodPublic(req);
            }
        } catch (e) {
            return this._handleException(req, res, e);
        }

        await this._geoipSetupResolver(req);
        await this._geoipResolve(req);

        // For website routes (only), add website params on `request`
        if (req.isFrontend) {
            await this._addDispatchParameters(req, func);

            let path: any = req.uri.pathname.split('/');
            const defaultLgId = await this._getDefaultLang(req);
            if (req.routingIteration == 1) {
                const isABot = this.isABot(req);
                const nearestLang = !func && await this.getNearestLang(req, await (await req.getEnv()).items('res.lang')._langGetCode(path[1]));
                const urlLg = nearestLang && path[1];

                // The default lang should never be in the URL, and a wrong lang
                // should never be in the URL.
                const wrongUrlLg = urlLg && (urlLg != await req.lang.urlCode || urlLg == await defaultLgId.urlCode);
                // The lang is missing from the URL if multi lang is enabled for
                // the route and the current lang is not the default lang.
                // POST requests are excluded from this condition.
                const missingUrlLg = !urlLg && req.isFrontendMultilang && !req.lang.eq(defaultLgId) && req.httpRequest.method !== 'POST';
                // Bots should never be redirected when the lang is missing
                // because it is the only way for them to index the default lang.
                if (wrongUrlLg || (missingUrlLg && !isABot)) {
                    if (urlLg) {
                        path.splice(1, 1);
                    }
                    if (!req.lang.eq(defaultLgId)) {
                        path.splice(1, 0, await req.lang.urlCode);
                    }
                    path = path.join('/') || '/';
                    routingError = null;
                    const redirect = await req.redirect(res, path + '?' + decode(req.uri.search));
                    redirect.setCookie('frontend_lang', await req.lang.code);
                    return redirect;
                }
                else if (urlLg) {
                    req.uid = null;
                    if (req.uri.pathname === f('/%s/', urlLg)) {
                        // special case for homepage controller, mimick `_postprocess_args()` redirect
                        path = req.uri.pathname.slice(0, -1);
                        if (req.uri.search) {
                            path += '?' + decode(req.uri.search);
                        }
                        return req.redirect(res, path, 301);
                    }
                    path.slice(1, 1);
                    routingError = null;
                    return this.reroute(req, res, path.join('/') || '/');
                }
                else if (missingUrlLg && isABot) {
                    // Ensure that if the URL without lang is not redirected, the
                    // current lang is indeed the default lang, because it is the
                    // lang that bots should index in that case.
                    req.lang = defaultLgId;
                    req.context = Object.assign({}, req.context, { lang: await defaultLgId.code });
                }
            }
            if (req.lang.eq(defaultLgId)) {
                const context = Object.assign({}, req.context);
                context['editTranslations'] = false;
                req.context = context;
            }
        }

        if (routingError) {
            return this._handleException(req, res, routingError);
        }
        // removed cache for auth public
        const result = await _super(IrHttp, this)._dispatch(req, res);

        const cookLang = req.cookie['frontend_lang'];
        if (req.isFrontend && cookLang !== await req.lang._getCached('code') && hasattr(result, 'setCookie')) {
            result.setCookie('frontend_lang', await req.lang._getCached('code'));
        }

        return result;
    }

    async _redirect(req, res, location, code = 303) {
        if (req && req.db && getattr(req, 'isFrontend', false)) {
            location = await urlFor(req, location);
        }
        return _super(IrHttp, this)._redirect(req, res, location, code);
    }

    async reroute(req, res, path) {
        if (!hasattr(req, 'rerouting')) {
            req.rerouting = [req.uri.pathname];
        }
        if (req.rerouting.includes(path)) {
            throw new Error("Rerouting loop is forbidden");
        }
        req.rerouting.push(path);
        if (len(req.rerouting) > this.reroutingLimit) {
            throw new Error("Rerouting limit exceeded");
        }
        // req.httpRequest.uri.pathname = path;
        // void theveb cachedProperty. TODO: find a proper way to do this
        for (const key of ['fullPath', 'url', 'baseUrl']) {
            req.httpRequest.__dict__.pop(key, null);
        }
        // since theveb 2.0 `path`` became an attribute and is not a cached property anymore
        if (hasattr(typeof (req.httpRequest), 'path')) { // cached property
            req.httpRequest.__dict__.pop('path', null);
        }
        else { // direct attribute
            req.uri.pathname = '/' + lstrip(path, '/');
        }
        return this._dispatch(req, res);
    }

    async _postprocessArgs(req, res, args, rule: Rule) {
        await _super(IrHttp, this)._postprocessArgs(req, res, args, rule);
        let path;
        try {
            [, path] = await rule.build(args);
            assert(path != null);
        } catch (e) {
            if (isInstance(e, MissingError)) {
                return this._handleException(req, res, new NotFound(res));
            }
            else {
                return this._handleException(req, res, e);
            }
        }

        if (getattr(req, 'isFrontendMultilang', false) && ['GET', 'HEAD'].includes(req.httpRequest.method)) {
            const generatedPath = urlUnquotePlus(path);
            const currentPath = urlUnquotePlus(req.uri.pathname);
            if (generatedPath.compare(currentPath) !== 0) {
                if (!req.lang.eq(await this._getDefaultLang(req))) {
                    path = '/' + await req.lang.urlCode + path;
                }
                if (req.uri.queryString) {
                    path += '?' + decode(req.uri.queryString);
                }
                return req.redirect(res, path, 301);
            }
        }
    }

    /**
     * Return a tuple with the error code following by the values matching the exception
     * @param exception 
     */
    async _getExceptionCodeValues(req, exception): Promise<[number, {}]> {
        let code = 500;  // default code
        const values = {
            exception: exception,
            traceback: exception.stack,
        }
        if (isInstance(exception, UserError)) {
            values['errorMessage'] = exception.message;
            code = 400;
            if (isInstance(exception, AccessError)) {
                code = 403;
            }
        }
        else if (isInstance(exception, QWebException)) {
            update(values, { qwebException: exception });

            if (isInstance(exception.error, AccessError)) {
                code = 403;
            }
        }
        else if (isInstance(exception, HTTPException)) {
            code = exception.code;
        }

        update(values, {
            statusMessage: HTTP_STATUS_CODES[code] || '',
            statusCode: code,
        });

        return [code, values]
    }

    async _getValues500Error(req, env, values, exception) {
        values['view'] = env.items("ir.ui.view");
        return values;
    }

    async _getErrorHtml(req, env, code, values) {
        return [code, await env.items('ir.ui.view')._renderTemplate(f('http_routing.%s', code), values)];
    }

    async _handleException(req, res, exception) {
        const isFrontendRequest = bool(getattr(req, 'isFrontend', false));
        if (!isFrontendRequest) {
            // Don't touch non frontend requests exception handling
            return _super(IrHttp, this)._handleException(req, res, exception);
        }
        try {
            const response = await _super(IrHttp, this)._handleException(req, res, exception);

            if (isInstance(response, Error)) {
                exception = response;
            }
            else {
                // if parent excplicitely returns a plain response, then we don't touch it
                return response;
            }
        } catch (e) {
            if (config.options['devMode'].includes('theveb')) {
                throw e;
            }
            exception = e;
        }
        let [code, values] = await this._getExceptionCodeValues(req, exception);

        if (code == null) {
            // Hand-crafted HTTPException likely coming from abort(),
            // usually for a redirect response -> return it directly
            return exception;
        }

        if (!req.uid) {
            await (this as any)._authMethodPublic(req);
        }

        // We rollback the current transaction before initializing a new
        // cursor to avoid potential deadlocks.

        // If the current (failed) transaction was holding a lock, the new
        // cursor might have to wait for this lock to be released further
        // down the line. However, this will only happen after the
        // request is done (and in fact it won't happen). As a result, the
        // current thread/worker is frozen until its timeout is reached.

        // So rolling back the transaction will release any potential lock
        // and, since we are in a case where an exception was raised, the
        // transaction shouldn't be committed in the first place.
        const env = await req.getEnv();
        await env.cr.rollback();
        const cr = (await registry(env.cr.dbName)).cursor();
        let html;
        await doWith(cr, async () => {
            const env = await Environment.new(cr, req.uid, (await req.getEnv()).context);
            if (code == 500) {
                console.error("500 Internal Server Error: %s", values['traceback']);
                values = await this._getValues500Error(req, env, values, exception);
            }
            else if (code == 403) {
                console.warn("403 Forbidden:\n%s", values['traceback']);
            }
            else if (code == 400) {
                console.warn("400 Bad Request:\n%s", values['traceback']);
            }
            try {
                [code, html] = await this._getErrorHtml(req, env, code, values);
            } catch (e) {
                [code, html] = [418, await env.items('ir.ui.view')._renderTemplate('http_routing.httpError', values)];
            }
        });
        return new BaseResponse(req, res, html, { status: code, contentType: 'text/html;charset=utf-8' });
    }

    @api.model()
    @tools.ormcache('path', 'queryArgs')
    async urlRewrite(req, path, queryArgs?: any) {
        let newUrl = false;
        const router = (await _root.getDbRouter(req, req.db)).bindToEnviron(req, '');
        let endpoint;
        try {
            endpoint = await router.match(req, path, { method: 'POST', queryArgs: queryArgs });
        } catch (e) {
            if (isInstance(e, MethodNotAllowed)) {
                endpoint = await router.match(req, path, { method: 'GET', queryArgs: queryArgs });
            }
            else if (isInstance(e, RequestRedirect)) {
                // get path from http://{path}?{current query string}
                newUrl = e.newUrl.split('?')[0].sice(7);
                [, endpoint] = await this.urlRewrite(req, newUrl, queryArgs);
                endpoint = endpoint && [endpoint];
            }
            else if (isInstance(e, NotFound)) {
                newUrl = path;
            }
        }
        return [newUrl || path, endpoint && endpoint[0]];
    }
}