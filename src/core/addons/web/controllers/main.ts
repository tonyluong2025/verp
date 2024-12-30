import assert from 'assert';
import crypto from 'crypto';
import fs from "fs/promises";
import { ServerResponse } from "http";
import _ from 'lodash';
import { DateTime } from 'luxon';
import path from "node:path";
import temp from 'temp';
import xpath from 'xpath';
import { http, modules, tools } from "../../..";
import { Environment } from '../../../api';
import { callKw, setattr, setdefault } from "../../../api/func";
import { serverWideModules } from "../../../conf";
import { Dict, OrderedDict } from "../../../helper/collections";
import { AccessDenied, AccessError, AttributeError, FileNotFoundError, NotImplementedError, StopIteration, UserError, ValueError } from "../../../helper/errors";
import { WebRequest, WebResponse, serializeException as _serializeException, addonsManifest, contentDisposition, dbFilter, dbList, dbMonodb, dispatchRpc, sendFile } from "../../../http";
import { checkMethodName } from '../../../models';
import { getResourcePath, listDir } from "../../../modules/modules";
import { expVersion } from "../../../service/common";
import { MetaDatebase } from '../../../service/db';
import { BadRequest, HTTPException, InternalServerError, abort } from "../../../service/middleware/exceptions";
import { urlEncode, urlParse } from "../../../service/middleware/utils";
import { wrapFile } from "../../../service/middleware/wsgi";
import { computeSessionToken } from '../../../service/security';
import * as lazy from "../../../tools";
import { _t, all, b64decode, b64encode, bool, chain, config, enumerate, extend, f, fileOpen, filePath, groupby, isInstance, isList, itemgetter, iter, len, localWebTranslations, next, parseInt, partial, pop, repr, setOptions, some, sorted, split, sum, toText } from "../../../tools";
import { fragmentFromString } from "../../../tools/html";
import { jsonParse, stringify } from '../../../tools/json';
import { guessMimetype } from "../../../tools/mimetypes";
import { cleanFilename } from '../../../tools/osutils';
import { safeEval } from '../../../tools/save_eval';
import { applyInheritanceSpecs } from "../../../tools/template_inheritance";
import { ExportXlsxWriter, GroupExportXlsxWriter } from '../../../tools/xlsx';
import { E, escapeHtml, getrootXml, isElement, parseXml, serializeHtml } from "../../../tools/xml";
import { render } from "../../base/models/ir_qweb";

const CONTENT_MAXAGE = http.STATIC_CACHE_LONG;

const DBNAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/;

const COMMENT_PATTERN = /'Modified by [\s\w\-.]+ from [\s\w\-.]+'/;

const SIGN_UP_REQUEST_PARAMS = new Set(['db', 'login', 'debug', 'token', 'message', 'error', 'scope', 'mode', 'redirect', 'redirectHostname', 'email', 'label', 'partnerId', 'password', 'confirmPassword', 'city', 'countryId', 'lang']);

function noneValuesFiltered(func) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalFunc = descriptor.value;
    const routeWrapper = async function (iterable) {
      let result = originalFunc.call(this, iterable.filter(v => v != null));
      return result;
    }
    descriptor.value = routeWrapper;
  }
}

/**
 * Some functions do not accept empty iterables (e.g. max, min with no default value)
    This returns the function `func` such that it returns None if the iterable
    is empty instead of raising a ValueError.
 * @param func 
 * @returns 
 */
function allowEmptyIterable(func) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalFunc = descriptor.value;
    const routeWrapper = async function (iterable) {
      const iterator = iter(iterable);
      try {
        const value = next(iterator);
        const result = func(chain([value], iterator));
        return result;
      } catch (e) {
        if (isInstance(e, StopIteration)) {
          return null;
        }
        throw e;
      }
    }
    descriptor.value = routeWrapper;
  }
}

const OPERATOR_MAPPING = {
  'max': noneValuesFiltered(allowEmptyIterable(Math.max)),
  'min': noneValuesFiltered(allowEmptyIterable(Math.min)),
  'sum': sum,
  'boolAnd': all,
  'boolOr': some,
}

async function abortAndRedirect(request: WebRequest, res, url) {
  let response = await request.redirect(res, url, 302);
  response = await http._root.getResponse(request, res, response, false);
  abort(response);
}

function serializeException() {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalFunc = descriptor.value;
    const routeWrapper = async function (...args) {
      try {
        let result = await originalFunc.call(this, ...args);
        return result;
      } catch (e) {
        console.error("An exception occurred during an http request");
        const se = http.serializeException(e);
        const error = {
          'code': 200,
          'message': "Verp Server Error",
          'data': se
        }
        return new InternalServerError(stringify(error));
      }
    }
    descriptor.value = routeWrapper;
  }
}

function clean(name: string) {
  return name.replace('\x3c', '');
}

/**
 * Decide if user requires a specific post-login redirect, e.g. for 2FA, or if they are
  fully logged and can proceed to the requested URL
 * @param uid 
 * @param redirect 
 * @returns 
 */
async function _getLoginRedirectUrl(req: WebRequest, uid: number, redirect?: string) {
  if (req.session.uid) {
    return redirect || '/web';
  }
  // partial session (MFA)
  const url = (await req.getEnv(uid)).items('res.users').browse(uid)._mfaUrl();
  if (!redirect)
    return url;

  const parsed = urlParse(url);
  const qs = parsed.searchQuery;
  qs['redirect'] = redirect;
  console.log('Not implemented');
  return parsed.toString();
}

export async function ensureDb(req: WebRequest, res: ServerResponse, redirect = '/web/database/selector') {
  // This helper should be used in web client auth="none" routes
  // if those routes needs a db to work with.
  // If the heuristics does not find any database, then the users will be redirected to db selector or any url specified by `redirect` argument.
  // If the db is taken out of a query parameter, it will be checked against
  // `http.dbFilter()` in order to ensure it's legit and thus avoid db
  // forgering that could lead to xss attacks.
  let db = req.params['db'] && req.params['db'].trim();

  // Ensure db is legit
  if (db && !dbFilter(req, [db]).includes(db)) {
    db = null;
  }

  if (db && !req.session.db) {
    // User asked a specific database on a new session.
    // That mean the nodb router has been used to find the route
    // Depending on installed module in the database, the rendering of the page
    // may depend on data injected by the database route dispatcher.
    // Thus, we redirect the user to the same page but with the session cookie set.
    // This will force using the database route dispatcher...
    req.session.db = db
    await abortAndRedirect(req, res, req.httpRequest.url);
  }

  // if db not provided, use the session one
  if (!db && req.session.db && dbFilter(req, [req.session.db])) {
    db = req.session.db;
  }

  // if no database provided and no database in session, use monodb
  if (!db) {
    db = await dbMonodb(req);
  }

  // if no db can be found til here, send to the database selector
  // the database selector will redirect to database manager if needed
  if (!db) {
    abort(await req.redirect(res, redirect, 303));
  }

  // always switch the session to the computed db
  if (db !== req.session.db) {
    req.session.logout();
    await abortAndRedirect(req, res, req.httpRequest.url);
  }
  req.session.db = db;
}

export class HomeStaticTemplateHelpers {
  NAME_TEMPLATE_DIRECTIVE = 't-name';
  STATIC_INHERIT_DIRECTIVE = 't-inherit';
  STATIC_INHERIT_MODE_DIRECTIVE = 't-inherit-mode';
  PRIMARY_MODE = 'primary';
  EXTENSION_MODE = 'extension';
  DEFAULT_MODE = this.PRIMARY_MODE;

  addons: string[];
  db: string;
  debug: boolean;
  checksumOnly: boolean;
  templateDict: OrderedDict<any>;
  /**
   * :param str|list addons: plain list or comma separated list of addons
    :param str db: the current db we are working on
    :param bool checksum_only: only computes the checksum of all files for addons
    :param str debug: the debug mode of the session
   * @param addons 
   * @param db 
   * @param checksum_only 
   * @param debug 
   */
  private constructor(addons: string | string[], db: string, checksumOnly = false, debug = false) {
    this.addons = typeof (addons) === 'string' ? addons.split(',') : addons;
    this.db = db;
    this.debug = debug;
    this.checksumOnly = checksumOnly;
    this.templateDict = new OrderedDict<any>();
  }

  static async getQwebTemplatesChecksum(req, options: { addons?: any, db?: null, debug?: boolean, bundle?: any } = {}) {
    return (await (new HomeStaticTemplateHelpers(options.addons, options.db, true, options.debug))._getQwebTemplates(req, options.bundle))[1];
  }

  static async getQwebTemplates(req, options: { addons?: any, db?: null, debug?: boolean, bundle?: any } = {}) {
    return (await (new HomeStaticTemplateHelpers(options.addons, options.db, false, options.debug))._getQwebTemplates(req, options.bundle))[0];
  }

  /**
   * Proxy for irAsset._getAssetPaths
    Useful to make 'self' testable.
   * @param bundle 
   * @returns 
   */
  async _getAssetPaths(req, bundle) {
    return (await req.getEnv()).items('ir.asset')._getAssetPaths(bundle, { addons: this.addons, xml: true });
  }

  /**
   * One and only entry point that gets and evaluates static qweb templates

    :rtype: (str, str)
   * @param bundle 
   * @returns 
   */
  async _getQwebTemplates(req, bundle) {
    const xmlPaths = new Dict<any>();

    // group paths by module, keeping them in order
    for (const [path, addon, _] of await this._getAssetPaths(req, bundle)) {
      xmlPaths[addon] = xmlPaths[addon] ?? [];
      const addonPaths = xmlPaths[addon];
      if (!addonPaths.includes(path)) {
        addonPaths.push(path);
      }
    }
    const [content, checksum] = await this._concatXml(req, xmlPaths);
    return [content, checksum];
  }

  /**
   * Read the content of a file or an ``ir.attachment`` record given by
    ``pathOrUrl``.

    :param str pathOrUrl:
    :returns: bytes
    :raises FileNotFoundError: if the path does not match a module file
        or an attachment
   * @param pathOrUrl 
   * @returns 
   */
  async _readAddonFile(req, pathOrUrl) {
    let contents;
    try {
      contents = await fs.readFile(filePath(pathOrUrl));
    } catch (e) {
      if (isInstance(e, FileNotFoundError)) {
        const attachment = await (await (await req.getEnv()).items('ir.attachment').sudo()).search([
          ['url', '=', pathOrUrl],
          ['type', '=', 'binary'],
        ], { limit: 1 });
        if (attachment.ok) {
          contents = await attachment.raw;
        }
        else {
          throw e;
        }
      }
      else {
        throw e;
      }
    }
    return contents;
  }

  /**
   * Concatenate xml files

    :param dict(list) fileDict:
        key: addon name
        value: list of files for an addon
    :returns: (concatenationResult, checksum)
    :rtype: (bytes, str)
   * @param xmlPaths 
   * @returns 
   */
  async _concatXml(req, fileDict?: Dict<any>): Promise<[any, any]> {
    const checksum = crypto.createHash('sha512');
    if (!fileDict) {
      return ['', checksum.digest('hex').slice(0, 64)];
    }

    let root: Element;
    for (const [addon, fnames] of fileDict) {
      for (const fname of fnames) {
        const contents = await this._readAddonFile(req, fname);
        checksum.update(contents);
        if (!this.checksumOnly) {
          const xml = await this._computeXmlTree(addon, fname, contents);
          if (root == null) {
            root = E.withType('templates');
          }
        }
      }
    }

    for (const addon of this.templateDict.values()) {
      for (const template of addon.values()) {
        root.appendChild(template.cloneNode(true));
      }
    }

    return [root ? serializeHtml(root) : '', checksum.digest('hex').slice(0, 64)];
  }

  /**
   * Computes the real addon name and the template name
    of the parent template (the one that is inherited from)

    :param str addon: the addon the template is declared in
    :param etree template: the current template we are are handling
    :returns: (str, str)
   * @param addon 
   * @param template 
   */
  async _getParentTemplate(addon: any, template: Element) {
    const originalTemplateName = template.getAttribute(this.STATIC_INHERIT_DIRECTIVE);
    const index = originalTemplateName.indexOf('.');
    const splitNameAttempt = [originalTemplateName.slice(0, index), originalTemplateName.slice(index + 1, originalTemplateName.length)];
    let [parentAddon, parentName] = splitNameAttempt[1] != undefined ? Array.from(splitNameAttempt) : [addon, originalTemplateName];
    if (!(parentAddon in this.templateDict)) {
      if (originalTemplateName in this.templateDict[addon]) {
        parentAddon = addon;
        parentName = originalTemplateName;
      }
      else {
        throw new ValueError(await _t('Module %s not loaded or inexistent, or templates of addon being loaded (%s) are misordered', parentAddon, addon));
      }
    }
    if (!(parentName in this.templateDict[parentAddon])) {
      throw new ValueError(await _t("No template found to inherit from. Module %s and template name %s", parentAddon, parentName));
    }

    return [parentAddon, parentName];
  }


  /**
   * Remove the comments added in the template already, they come from other templates extending the base of this inheritance
   * @param inheritedTemplate 
   */
  _removeInheritanceComments(inheritedTemplate) {
    const nodes: any[] = xpath.select('//comment()', inheritedTemplate) ?? [];
    for (const comment of nodes) {
      if (COMMENT_PATTERN.test(comment.textContent.trim())) {
        comment.parrentNode.removeChild(comment);
      }
    }
  }

  /**
   * Computes the xml tree that 'source' contains
    Applies inheritance specs in the process

    :param str addon: the current addon we are reading files for
    :param str file_name: the current name of the file we are reading
    :param str source: the content of the file
    :returns: etree
   * @param addon 
   * @param fileName 
   * @param source 
   */
  async _computeXmlTree(addon: any, fileName: any, source: any) {
    let allTemplatesTree;
    try {
      if (isInstance(source, Uint8Array)) {
        source = source.toString();
      }
      allTemplatesTree = getrootXml(parseXml(source));
    }
    catch (e) {
      console.error(`Could not parse file ${fileName}: ${e.message}`);
      throw e;
    }

    this.templateDict.setdefault(addon, new OrderedDict());
    for (const templateTree of Array.from<Element>(allTemplatesTree.childNodes)) {
      let templateName;
      if (isElement(templateTree) && templateTree.hasAttribute(this.NAME_TEMPLATE_DIRECTIVE)) {
        templateName = templateTree.getAttribute(this.NAME_TEMPLATE_DIRECTIVE);
        const index = templateName.indexOf('.');
        const dottedNames = [templateName.slice(0, index), templateName.slice(index + 1, templateName.length)];
        if (dottedNames[1] != null && dottedNames[0] === addon) {
          templateName = dottedNames[1];
        }
      }
      else {
        // this.templateDict[addon] grows after processing each template
        templateName = `anonymousTemplate${len(this.templateDict[addon])}`;
      }
      if (isElement(templateTree) && templateTree.hasAttribute(this.STATIC_INHERIT_DIRECTIVE)) {
        const inheritMode = templateTree.getAttribute(this.STATIC_INHERIT_MODE_DIRECTIVE) || this.DEFAULT_MODE;
        if (![this.PRIMARY_MODE, this.EXTENSION_MODE].includes(inheritMode)) {
          throw new ValueError(await _t("Invalid inherit mode. Module %s and template name %s", addon, templateName));
        }
        const [parentAddon, parentName] = await this._getParentTemplate(addon, templateTree);

        // After several performance tests, we found out that deepcopy is the most efficient
        // solution in this case (compared with copy, xpath with '.' and stringifying).
        const parentTree: Element = getrootXml(parseXml(this.templateDict[parentAddon][parentName].toString()));//.cloneNode(true);

        const xpaths = Array.from<any>(templateTree.childNodes).filter(node => isElement(node) && node.tagName === 'xpath');
        if (this.debug && inheritMode == this.EXTENSION_MODE) {
          for (const _xpath of xpaths) {
            const comment = _xpath.ownerDocument.createComment(` Modified by ${templateName} from ${addon} `);
            _xpath.parentNode.insertBefore(_xpath.parentNode.firstChild, comment);
          }
        }
        else if (inheritMode === this.PRIMARY_MODE) {
          setattr(parentTree, 'tagName', templateTree.tagName);
        }
        let inheritedTemplate: Element = await applyInheritanceSpecs(parentTree, xpaths);

        if (inheritMode === this.PRIMARY_MODE) { // New templateTree: A' = B(A)
          for (const attr of Array.from<any>(templateTree.attributes)) {
            if (!['t-inherit', 't-inherit-mode'].includes(attr.name)) {
              inheritedTemplate.setAttribute(attr.name, attr.value);
            }
          }
          if (this.debug) {
            this._removeInheritanceComments(inheritedTemplate);
          }
          this.templateDict[addon][templateName] = inheritedTemplate;
        }
        else {  // Modifies original: A = B(A)
          this.templateDict[parentAddon][parentName] = inheritedTemplate;
        }
      }
      else {
        if (templateName in this.templateDict[addon]) {
          throw new ValueError(await _t("Template %s already exists in module %s", templateName, addon));
        }
        this.templateDict[addon][templateName] = templateTree;
      }
    }
    return allTemplatesTree;
  }
}

// import { Response, Request, Params } from "@decorators/express";
/**
 *0: ('_loginRedirect', <bound method Home._...ED1B0748>>)
  1: ('health', <bound method Home.h...ED1B0748>>)
  2: ('index', <bound method Home.i...ED1B0748>>)
  3: ('switchToAdmin', <bound method Home.s...ED1B0748>>)
  4: ('webClient', <bound method Home.w...ED1B0748>>)
  5: ('webLoadMenus', <bound method Home.w...ED1B0748>>)
  6: ('webLogin', <bound method Home.w...ED1B0748>>)
 */
@http.define()
export class Home extends http.Controller {
  static _module = module;

  @http.route('/', { type: 'http', auth: "none" })
  async index(req: WebRequest, res: ServerResponse, opts: {} = {}) {
    return req.redirectQuery(res, '/web', req.uri.search, 303);
  }

  @http.route('/web', { type: 'http', auth: "none" })
  async webClient(req: WebRequest, res: ServerResponse, opts: {} = {}) {
    await ensureDb(req, res);
    if (!req.session.uid)
      return req.redirect(res, '/web/login', 303)
    if (opts['redirect'])
      return req.redirect(res, opts['redirect'], 303)

    req.uid = req.session.uid
    try {
      const irHttp = (await req.getEnv()).items('ir.http');
      const context = await irHttp.webclientRenderingContext(req);
      const response = await req.render(res, 'web.webclientBootstrap', context);
      response.setHeader('x-frame-options', 'DENY');
      return response;
    } catch (e) {
      if (isInstance(e, AccessError)) {
        return req.redirect(res, '/web/login?error=access');
      } else {
        console.error(e);
      }
    }
  }

  /**
   * Loads the menus for the webclient
   * @param req WebRequest
   * @param res ServerResponse
   * @param unique this parameters is not used, but mandatory: it is used by the HTTP stack to make a unique request
   * @returns the menus (including the images in Base64)
   */
  @http.route('/web/webclient/loadMenus/<string:unique>', { type: 'http', auth: "user", methods: ['GET'] })
  async webLoadMenus(req: WebRequest, res: ServerResponse, opts: {} = {}) {
    const menus = await (await req.getEnv()).items("ir.ui.menu").loadWebMenus(req.session.debug);
    const body = stringify(menus);
    const response = req.makeResponse(res, body, [
      // this method must specify a content-type application/json instead of using the default text/html set because
      // the type of the route is set to HTTP, but the rpc is made with a get and expects JSON
      ['content-type', 'application/json'],
      ['cache-control', 'public, max-age=' + String(CONTENT_MAXAGE)]],
    )
    return response;
  }

  async _loginRedirect(req: any, res: any, uid: any, redirect?: any): Promise<string> {
    return _getLoginRedirectUrl(req, uid, redirect);
  }

  @http.route('/web/login', { type: 'http', auth: "none" })
  async webLogin(req: WebRequest, res: ServerResponse, opts: {} = {}) {
    const redirect = opts['redirect'];
    await ensureDb(req, res);
    req.params['loginSuccess'] = false;
    if (req.method === 'GET' && redirect && req.session.uid) {
      return req.redirect(res, redirect);
    }

    if (!req.uid) {
      req.uid = global.SUPERUSER_ID;
    }

    const values = {}
    for (const [k, v] of Object.entries(req.params)) {
      if (SIGN_UP_REQUEST_PARAMS.has(k)) {
        values[k] = v;
      }
    }
    try {
      values['databases'] = await dbList(req);
    } catch (e) {
      if (isInstance(e, AccessDenied)) {
        values['databases'] = null;
      }
      else {
        throw e;
      }
    }
    if (req.method == 'POST') {
      const oldUid = req.uid;
      try {
        const uid = await req.session.authenticate(req, req.session.db, req.params['login'], req.params['password']);
        req.params['loginSuccess'] = true;
        const result = await req.redirect(res, await this._loginRedirect(req, res, uid, redirect));
        return result;
      } catch (e) {
        if (isInstance(e, AccessDenied)) {
          req.uid = oldUid;
          // if (e.args == core.exceptions.AccessDenied().args:
          values['error'] = await _t("Wrong login/password")
          // else:
          //     values['error'] = e.message
        }
        else {
          throw e;
        }
      }
    }
    else {
      if ('error' in req.params && req.params['error'] === 'access') {
        values['error'] = await _t('Only employees can access this database. Please contact the administrator.');
      }
    }
    if (!('login' in values) && req.session['authLogin']) {
      values['login'] = req.session['authLogin'];
    }

    if (!tools.config.get('listDb')) {
      values['disableDatabaseManager'] = true;
    }

    const response = await req.render(res, 'web.login', values);
    response.httpResponse.setHeader('x-frame-options', 'DENY');
    return response;
  }

  @http.route('/web/loginlayout', { type: 'http', auth: "none" })
  async webLoginLayout(req: WebRequest, res: ServerResponse, opts: {} = {}) {
    const response = await req.render(res, 'web.loginLayout');
    return response;
  }

  @http.route('/web/become', { type: 'http', auth: 'user', sitemap: false })
  async switchToAdmin(req: WebRequest, res) {
    const env = await req.getEnv();
    const user = await env.user();
    let uid = user.id;
    if (await user._isSystem()) {
      uid = req.session.uid = global.SUPERUSER_ID;
      // invalidate session token cache as we've changed the uid
      env.items('res.users').clearCaches();
      req.session.sessionToken = computeSessionToken(req.session, env);
    }
    return req.redirect(res, await this._loginRedirect(req, res, uid));
  }

  @http.route('/web/health', { type: 'http', auth: 'none', saveSession: false })
  async health(req: WebRequest, res) {
    const data = stringify({
      'status': 'pass',
    })
    const headers = [['Content-Type', 'application/json'],
    ['Cache-Control', 'no-store']];
    return req.makeResponse(res, data, headers);
  }
}

@http.define()
export class WebClient extends http.Controller {
  static _module = module;

  @http.route('/web/webclient/locale/<string:lang>', { type: 'http', auth: "none" })
  loadLocale(req: WebRequest, res: ServerResponse, opts: {} = {}) {
    const lang: string = opts['lang'];
    const magicFileFinding = [lang.replace("_", '-').toLowerCase(), lang.split('_')[0]];
    for (const code of magicFileFinding) {
      try {
        return new WebResponse(req, res,
          wrapFile(
            res,
            fileOpen(`web/static/lib/moment/locale/${code}.js`, 'r').fd
          ),
          {
            contentType: 'application/javascript; charset=utf-8',
            headers: [['Cache-Control', `max-age=${http.STATIC_CACHE}`]],
            directPassthrough: true
          },
        )
      } catch (e) {
        if (isInstance(e, FileNotFoundError)) {
          console.debug("No moment locale for code %s", code);
        }
        else {
          throw e;
        }
      }
    }
    return req.makeResponse(res, "", [
      ['Content-Type', 'application/javascript'],
      ['Cache-Control', `max-age=${http.STATIC_CACHE}`],
    ]);
  }

  @http.route('/web/webclient/qweb/<string:unique>', { type: 'http', auth: "none", cors: "*" })
  async qweb(req: WebRequest, res: ServerResponse, opts: { unique?: any, mods?: any, db?: any, bundle?: any } = {}) {
    if (!req.db && opts.mods == null) {
      opts.mods = serverWideModules || [];
    }

    const content = await HomeStaticTemplateHelpers.getQwebTemplates(req, { addons: opts.mods, db: opts.db, debug: req.session.debug, bundle: opts.bundle });

    return req.makeResponse(res, content, [
      ['Content-Type', 'text/xml'],
      ['Cache-Control', 'public, max-age=' + String(CONTENT_MAXAGE)]
    ]);
  }

  /**
   * Load local translations from *.po files, as a temporary solution
          until we have established a valid session. This is meant only
          for translating the login page and db management chrome, using
          the browser's language. 
   * @param req 
   * @param res 
   * @param mods 
   * @returns 
   */
  @http.route('/web/webclient/bootstrapTranslations', { type: 'json', auth: "none" })
  async bootstrapTranslations(req: WebRequest, res: ServerResponse, opts: { mods?: any } = {}) {
    // For performance reasons we only load a single translation, so for
    // sub-languages (that should only be partially translated) we load the
    // main language PO instead - that should be enough for the login screen.
    const context = Object.assign({}, req.context);
    req.session._fixLang(context);
    const lang = context['lang'].split('_')[0];

    if (opts.mods == null) {
      opts.mods = serverWideModules ?? [];
      if (req.db) {
        opts.mods = extend(Array.from((await req.getEnv()).registry._initModules), opts.mods);
      }
    }
    const translationsPerModule = {}
    for (const addonName of new Set<string>(opts.mods)) {
      const manifest = addonsManifest[addonName];
      if (manifest && manifest['bootstrap']) {
        const addonsPath = addonsManifest[addonName]['addonsPath'];
        const fName = path.join(addonsPath, addonName, "i18n", lang + ".po");
        try {
          await fs.access(fName, fs.constants.F_OK);
        } catch (e) {
          if (e.code == 'ENOENT') {
            continue;
          } else {
            console.log("bootstrapTranslations error checking %s", fName, e.message);
          }
        }
        translationsPerModule[addonName] = { 'messages': await localWebTranslations(fName) };
      }
    }
    return {
      "modules": translationsPerModule,
      "langParameters": null
    }
  }

  /**
   *     Load the translations for the specified language and modules

    :param unique: this parameters is not used, but mandatory: it is used by the HTTP stack to make a unique request
    :param mods: the modules, a comma separated list
    :param lang: the language of the user
    :return:

   * @param req 
   * @param res 
   * @param unique 
   * @param mods 
   * @param lang 
   */
  @http.route('/web/webclient/translations/<string:unique>', { type: 'http', auth: "public", cors: "*" })
  async translations(req: WebRequest, res: ServerResponse, opts: { unique?: any, mods?: any, lang?: any } = {}) {
    if (opts.mods) {
      opts.mods = opts.mods.split(',');
    }
    else if (opts.mods == null) {
      opts.mods = Array.from((await req.getEnv()).registry._initModules).concat(serverWideModules || []);
    }
    const [translationsPerModule, langParams] = await (await req.getEnv()).items("ir.translation").getTranslationsForWebclient(opts.mods, opts.lang);

    const body = stringify({
      'lang': langParams && langParams["code"],
      'langParameters': langParams,
      'modules': translationsPerModule,
      'multiLang': len(await (await (await req.getEnv()).items('res.lang').sudo()).getInstalled()) > 1,
    });
    const response = req.makeResponse(res, body, [
      // this method must specify a content-type application/json instead of using the default text/html set because
      // the type of the route is set to HTTP, but the rpc is made with a get and expects JSON
      ['Content-Type', 'application/json'],
      ['Cache-Control', 'public, max-age=' + String(CONTENT_MAXAGE)],
    ])
    return response;
  }

  @http.route('/web/webclient/versionInfo', { type: 'json', auth: "none" })
  versionInfo(req: WebRequest, res: ServerResponse) {
    return expVersion();
  }

  @http.route('/web/tests', { type: 'http', auth: "user" })
  async testSuite(req: WebRequest, res: ServerResponse, opts: { mod?: any } = {}) {
    return req.render(res, 'web.qunitSuite');
  }

  @http.route('/web/tests/mobile', { type: 'http', auth: "none" })
  async testMobileSuite(req: WebRequest, res: ServerResponse, opts: { mod?: any } = {}) {
    return req.render(res, 'web.qunitMobileSuite');
  }

  @http.route('/web/benchmarks', { type: 'http', auth: "none" })
  async benchmarks(req: WebRequest, res: ServerResponse, opts: { mod?: any } = {}) {
    return req.render(res, 'web.benchmark_suite');
  }
}

@http.define()
class WebProxy extends http.Controller {
  static _module = module;

  /**
   * Effectively execute a POST request that was hooked through user login
   * @param req 
   * @param res 
   * @param opts 
   * @returns 
   */
  @http.route('/web/proxy/post/<path:path>', { type: 'http', auth: 'user', methods: ['GET'] })
  async post(req: WebRequest, res: ServerResponse, opts: { path?: string } = {}) {
    const data = [];
    for await (const elem of req.session.loadRequestData()) {
      data.push(elem);
    }
    if (!bool(data)) {
      throw new BadRequest();
    }
    const baseUrl = req.httpRequest.baseUrl;
    const searchQuery = req.httpRequest.uri.searchQuery;
    const headers = { 'X-Openerp-Session-Id': req.session.sid }
    // client = Client(http.root, theveb.wrappers.Response)
    // return client.post('/' + path, base_url=base_url, query_string=query_string,
    //                     headers=headers, data=data)
    console.warn('Not Implemented');
  }
}

@http.define()
class Database extends http.Controller {
  static _module = module;

  async _renderTemplate(req: WebRequest, res: ServerResponse, data: {} = {}) {
    setdefault(data, 'manage', true);
    data['insecure'] = await tools.config.verifyAdminPassword('admin');
    data['listDb'] = tools.config.get('listDb');
    data['langs'] = await MetaDatebase.expListLang();
    data['countries'] = await MetaDatebase.expListCountries();
    data['pattern'] = DBNAME_PATTERN.source;
    // databases list
    data['databases'] = [];
    try {
      data['databases'] = await dbList(req);
      data['incompatibleDatabases'] = await MetaDatebase.listDbIncompatible(data['databases']);
    } catch (e) {
      if (isInstance(e, AccessDenied)) {
        const monodb = await dbMonodb(req);
        if (monodb) {
          data['databases'] = [monodb];
        }
      }
      else {
        throw e;
      }
    }
    const templates = {}

    const template = await fs.readFile(filePath("web/static/src/public/database_manager.qweb.html"), 'utf8');
    templates['masterInput'] = await fs.readFile(filePath("web/static/src/public/database_manager.master_input.qweb.html"), 'utf8');
    templates['createForm'] = await fs.readFile(filePath("web/static/src/public/database_manager.create_form.qweb.html"), 'utf8');

    function load(templateName, options) {
      return [fragmentFromString(templates[templateName]), templateName];
    }

    return render(parseXml(template), data, load);
  }

  @http.route('/web/database/selector', { type: 'http', auth: "none" })
  async selector(req: WebRequest, res: ServerResponse, opts: {} = {}) {
    req.cr = null;
    return this._renderTemplate(req, res, { manage: false });
  }

  @http.route('/web/database/manager', { type: 'http', auth: "none" })
  async manager(req: WebRequest, res: ServerResponse, opts: {} = {}) {
    req.cr = null;
    return this._renderTemplate(req, res);
  }

  @http.route('/web/database/create', { type: 'http', auth: "none", methods: ['POST'], csrf: false })
  async create(req: WebRequest, res: ServerResponse, post: { masterPwd?: string, label?: string, lang?: string, password?: string } = {}) {
    const insecure = tools.config.verifyAdminPassword('admin');
    if (insecure && post.masterPwd) {
      await dispatchRpc(req, 'db', 'changeAdminPassword', ["admin", post.masterPwd]);
    }
    let error;
    try {
      if (!DBNAME_PATTERN.test(post.label)) {
        throw new Error(await _t('Invalid database name. Only alphanumerical characters, underscore, hyphen and dot are allowed.'));
      }
      // country code could be = "false" which is actually true in javascript
      const countryCode = post['countryCode'] || false;
      await dispatchRpc(req, 'db', 'createDatabase', [post.masterPwd, post.label, bool(post['demo']), post.lang, post.password, post['login'], countryCode, post['phone']]);
      req.session.authenticate(req, post.label, post['login'], post.password);
      return req.redirect(res, '/web');
    } catch (e) {
      error = f("Database creation error: %s", e);
    }
    return this._renderTemplate(req, res, { error: error });
  }


  @http.route('/web/database/duplicate', { type: 'http', auth: "none", methods: ['POST'], csrf: false })
  async duplicate(req: WebRequest, res, opts: { masterPwd?: any, name?: any, newName?: any } = {}) {
    const insecure = tools.config.verifyAdminPassword('admin');
    if (insecure && opts.masterPwd) {
      await dispatchRpc(req, 'db', 'changeAdminPassword', ["admin", opts.masterPwd]);
    }
    try {
      if (!DBNAME_PATTERN.test(opts.newName)) {
        throw new Error(await _t('Invalid database name. Only alphanumerical characters, underscore, hyphen and dot are allowed.'));
      }
      await dispatchRpc(req, 'db', 'duplicateDatabase', [opts.masterPwd, opts.name, opts.newName]);
      req.cr = null;  // duplicating a database leads to an unusable cursor
      return req.redirect(res, '/web/database/manager');
    } catch (e) {
      const error = f("Database duplication error: %s", String(e));
      return this._renderTemplate(req, res, { error: error });
    }
  }

  @http.route('/web/database/drop', { type: 'http', auth: "none", methods: ['POST'], csrf: false })
  async drop(req: WebRequest, res: ServerResponse, opts: { masterPwd?: string, label?: string } = {}) {
    const insecure = config.verifyAdminPassword('admin');
    if (insecure && opts.masterPwd) {
      await dispatchRpc(req, 'db', 'changeAdminPassword', ["admin", opts.masterPwd]);
    }
    try {
      await dispatchRpc(req, 'db', 'drop', [opts.masterPwd, opts.label]);
      req.cr = null;  // dropping a database leads to an unusable cursor
      req.db = null;
      if (req.session.db == opts.label) {
        req.session.logout();
      }
      return req.redirect(res, '/web/database/manager');
    } catch (e) {
      const error = f("Database deletion error: %s", e);
      return this._renderTemplate(req, res, { error: error });
    }
  }

  @http.route('/web/database/backup', { type: 'http', auth: "none", methods: ['POST'], csrf: false })
  async backup(req, res, opts: { masterPwd?: any, label?: any, backupFormat?: any } = { backupFormat: 'zip' }) {
    const insecure = config.verifyAdminPassword('admin');
    if (insecure && opts.masterPwd) {
      await dispatchRpc(req, 'db', 'changeAdminPassword', ["admin", opts.masterPwd]);
    }
    try {
      await MetaDatebase.checkSuper(opts.masterPwd);
      const ts = DateTime.now().toFormat("yyyy-MM-dd_hh-mm-ss");
      const filename = f("%s_%s.%s", opts.label, ts, opts.backupFormat);
      const headers = [
        ['Content-Type', 'application/octet-stream; charset=binary'],
        ['Content-Disposition', contentDisposition(filename)],
      ]
      const dumpStream = await MetaDatebase.dumpDb(opts.label, null, opts.backupFormat);
      const response = new WebResponse(req, res, dumpStream, { headers: headers, directPassthrough: true });
      return response;
    } catch (e) {
      console.error('Database.backup');
      const error = f("Database backup error: %s", String(e));
      return this._renderTemplate(req, res, { error: error });
    }
  }

  @http.route('/web/database/restore', { type: 'http', auth: "none", methods: ['POST'], csrf: false })
  async restore(req: WebRequest, res, opts: { masterPwd?: any, backupFile?: any, label?: any, copy?: any } = {}) {
    const insecure = config.verifyAdminPassword('admin');
    if (insecure && opts.masterPwd) {
      await dispatchRpc(req, 'db', 'changeAdminPassword', ["admin", opts.masterPwd]);
    }
    let dataFile: temp.OpenFile;
    try {
      await MetaDatebase.checkSuper(opts.masterPwd);
      dataFile = temp.openSync({ suffix: '.bk' });
      await fs.writeFile(dataFile.path, opts.backupFile);
      // fs.closeSync(dataFile.fd); // no need
      await MetaDatebase.restoreDb(opts.label, dataFile.path, bool(opts.copy));
      return req.redirect(res, '/web/database/manager');
    } catch (e) {
      const error = f("Database restore error: %s", String(e));
      return this._renderTemplate(req, res, { error: error });
    } finally {
      if (dataFile) {
        await fs.unlink(dataFile.path);
      }
    }
  }

  @http.route('/web/database/changePassword', { type: 'http', auth: "none", methods: ['POST'], csrf: false })
  async changePassword(req: WebRequest, res, opts: { masterPwd?: any, masterPwdNew?: any } = {}) {
    try {
      await dispatchRpc(req, 'db', 'changeAdminPassword', [opts.masterPwd, opts.masterPwdNew]);
      return req.redirect(res, '/web/database/manager')
    } catch (e) {
      const error = f("Master password update error: %s", String(e));
      return this._renderTemplate(req, res, { error: error });
    }
  }

  /**
   * Used by Mobile application for listing database
      :return: List of databases
      :rtype: list
   * @param req 
   * @param res 
   * @returns 
   */
  @http.route('/web/database/list', { type: 'json', auth: 'none' })
  async list(req: WebRequest, res: ServerResponse) {
    return dbList(req);
  }
}

@http.define()
export class Session extends http.Controller {
  static _module = module;

  @http.route('/web/session/getSessionInfo', { type: 'json', auth: "none" })
  async getSessionInfo(req: WebRequest, res: ServerResponse) {
    req.session.checkSecurity(req);
    req.uid = req.session.uid;
    // req.disableDb = false;
    return (await req.getEnv()).items('ir.http').sessionInfo(req);
  }

  @http.route('/web/session/authenticate', { type: 'json', auth: "none" })
  async authenticate(req: WebRequest, res: ServerResponse, opts: { db?: string, login?: string, password?: string, baseLocation?: string } = {}) {
    await req.session.authenticate(req, opts.db, opts.login, opts.password);
    return (await req.getEnv()).items('ir.http').sessionInfo(req);
  }

  @http.route('/web/session/changePassword', { type: 'json', auth: "user" })
  async changePassword(req: WebRequest, res: ServerResponse, opts: { fields?: [] } = {}) {
    const [oldPassword, newPassword, confirmPassword] = itemgetter(['oldPassword', 'newPassword', 'confirmPassword'])(Object.fromEntries(opts.fields.map(f => [f['name'], f['value']])));
    if (!(oldPassword.trim() && newPassword.trim() && confirmPassword.trim())) {
      return { 'error': await _t(await req.getEnv(), 'You cannot leave any password empty.') };
    }
    if (newPassword !== confirmPassword) {
      return { 'error': await _t(await req.getEnv(), 'The new password and its confirmation must be identical.') }
    }

    let msg = await _t("Error, password not changed !");
    try {
      if (await (await req.getEnv()).items('res.users').changePassword(oldPassword, newPassword)) {
        return { 'newPassword': newPassword };
      }
    } catch (e) {
      console.error(e);
      if (isInstance(e, AccessDenied)) {
        // msg = e.message;
        // if msg == AccessDenied().message:
        msg = await _t(await req.getEnv(), 'The old password you provided is incorrect, your password was not changed.')
      }
      else {//if (isInstance(e, UserError)) {
        msg = e.message;
      }
    }
    return { 'error': msg };
  }

  @http.route('/web/session/getLangList', { type: 'json', auth: "none" })
  async getLangList(req: WebRequest, res: ServerResponse) {
    try {
      const result = await dispatchRpc(req, 'db', 'listLang', []) || [];
      return result;
    } catch (e) {
      return { "error": e, "title": await _t(await req.getEnv(), "Languages") }
    }
  }

  @http.route('/web/session/modules', { type: 'json', auth: "user" })
  async modules(req: WebRequest, res: ServerResponse) {
    // return all installed modules. Web client is smart enough to not load a module twice
    return _.union(Array.from((await req.getEnv()).registry._initModules), modules.currentTest ? [modules.currentTest] : []);
  }

  /**
   * This method store an action object in the session object and returns an integer
    identifying that action. The method get_session_action() can be used to get
    back the action.

    :param the_action: The action to save in the session.
    :type the_action: anything
    :return: A key identifying the saved action.
    :rtype: integer
   * @param theAction 
   * @returns 
   */
  @http.route('/web/session/saveSessionAction', { type: 'json', auth: "user" })
  async saveSessionAction(req: WebRequest, res: ServerResponse, opts: { theAction?: any } = {}) {
    return req.session.saveAction(opts.theAction);
  }

  /**
   * Gets back a previously saved action. This method can return None if the action
    was saved since too much time (this case should be handled in a smart way).

    :param key: The key given by save_session_action()
    :type key: integer
    :return: The saved action or None.
    :rtype: anything
   * @param req 
   * @param res 
   * @param opts 
   * @returns 
   */
  @http.route('/web/session/getSessionAction', { type: 'json', auth: "user" })
  async getSessionAction(req: WebRequest, res: ServerResponse, opts: { key?: any } = {}) {
    return req.session.getAction(opts.key);
  }

  @http.route('/web/session/check', { type: 'json', auth: "user" })
  async check(req: WebRequest) {
    await req.session.checkSecurity(req);
    return null;
  }

  @http.route('/web/session/account', { type: 'json', auth: "user" })
  async account(req: WebRequest) {
    const ICP = await (await req.getEnv()).items('ir.config_parameter').sudo();
    const params = {
      'responseType': 'token',
      'clientId': await ICP.getParam('database.uuid') || '',
      'state': stringify({ 'd': req.db, 'u': await ICP.getParam('web.base.url') }),
      'scope': 'userinfo',
    }
    return 'https://accounts.theverp.com/oauth2/auth?' + urlEncode(params);
  }

  @http.route('/web/session/destroy', { type: 'json', auth: "user" })
  async destroy(req: WebRequest) {
    req.session.logout();
  }

  @http.route('/web/session/logout', { type: 'http', auth: "none" })
  async logout(req: WebRequest, res: ServerResponse, opts: { redirect?: string } = {}) {
    req.session.logout(true);
    return req.redirect(res, opts.redirect || '/web', 303)
  }
}

@http.define()
class DataSet extends http.Controller {
  static _module = module;

  @http.route('/web/dataset/searchRead', { type: 'json', auth: "user" })
  async searchRead(req: WebRequest, res: ServerResponse, opts: { model?: string, fields?: any, offset?: number, limit?: any, domain?: any, sort?: any } = {}) {
    return this.doSearchRead(req, res, pop(opts, 'model'), opts);
  }

  /**
   * Performs a search() followed by a read() (if needed) using the
    provided search criteria

    :param str model: the name of the model to search on
    :param fields: a list of the fields to return in the result records
    :type fields: [str]
    :param int offset: from which index should the results start being returned
    :param int limit: the maximum number of records to return
    :param list domain: the search domain for the query
    :param list sort: sorting directives
    :returns: A structure (dict) with two keys: ids (all the ids matching
              the (domain, context) pair) and records (paginated records
              matching fields selection set)
    :rtype: list
   * @param self 
   * @param model 
   * @param fields 
   * @param offset 
   * @param limit 
   * @param domain 
   * @param sort 
   */
  async doSearchRead(req: WebRequest, res: ServerResponse, model, options: { domain?: any, fields?: any, offset?: number, limit?: any, sort?: any } = {}) {
    const Model = (await req.getEnv()).items(model);
    return Model.webSearchRead(options);
  }

  @http.route('/web/dataset/load', { type: 'json', auth: "user" })
  async load(req, res, opts: { model?: any, id?: any, fields?: any } = {}) {
    let value = {};
    const r = await (await req.getEnv()).items(opts.model).browse([opts.id]).read();
    if (r.ok) {
      value = r[0];
    }
    return { 'value': value }
  }

  async callCommon(req, res, model, method, args, opts: { domainId?: any, contextId?: any } = {}) {
    return this._callKw(req, res, model, method, args, {});
  }

  async _callKw(req, res, model, method, args: any[] = [], kwargs: {} = {}) {
    checkMethodName(method);
    Object.assign(kwargs, { req: req, res: res });
    return callKw((await req.getEnv()).items(model), method, args, kwargs);
  }

  @http.route('/web/dataset/call', { type: 'json', auth: "user" })
  async call(req, res, opts: { model?: string, method?: string, args?: any } = {}) {
    return this._callKw(req, res, pop(opts, 'model'), pop(opts, 'method'), pop(opts, 'args'), {});
  }

  @http.route(['/web/dataset/callKw', '/web/dataset/callKw/<path:path>'], { type: 'json', auth: "user" })
  async callKw(req, res, opts: { model?: string, method?: string, args?: any[], kwargs?: {}, path?: any } = {}) {
    return this._callKw(req, res, pop(opts, 'model'), pop(opts, 'method'), pop(opts, 'args'), pop(opts, 'kwargs'));
  }

  @http.route('/web/dataset/callButton', { type: 'json', auth: "user" })
  async callButton(req, res, opts: { model?: string, method?: string, args?: any, kwargs?: {} } = {}) {
    const action = await this._callKw(req, res, pop(opts, 'model'), pop(opts, 'method'), pop(opts, 'args'), pop(opts, 'kwargs'));
    if (typeof (action) === 'object' && action['type'] !== '') {
      return cleanAction(action, await req.getEnv());
    }
    return false;
  }

  /**
   * Re-sequences a number of records in the model, by their ids

      The re-sequencing starts at the first model of ``ids``, the sequence
      number is incremented by one after each record and starts at ``offset``

      :param ids: identifiers of the records to resequence, in the new sequence order
      :type ids: list(id)
      :param str field: field used for sequence specification, defaults to
                        "sequence"
      :param int offset: sequence number for first record in ``ids``, allows
                          starting the resequencing from an arbitrary number,
                          defaults to ``0``
   * @param req 
   * @param res 
   * @param opts 
   * @returns 
   */
  @http.route('/web/dataset/resequence', { type: 'json', auth: "user" })
  async resequence(req, res, opts: { model?: string, ids?: any[], field?: 'sequence', offset?: 0 } = {}) {
    const m = (await req.getEnv()).items(opts.model);
    if (!bool(await m.fieldsGet([opts.field || 'sequence']))) {
      return false;
    }
    for (const [i, record] of enumerate(m.browse(opts.ids))) {
      await record.write({ field: i + (opts.offset || 0) });
    }
    return true;
  }
}

@http.define()
class View extends http.Controller {
  static _module = module;

  /**
   * Edit a custom view
    :param int custom_id: the id of the edited custom view
    :param str arch: the edited arch of the custom view
    :returns: dict with acknowledged operation (result set to true)
   * @param req 
   * @param res 
   * @param opts 
   * @returns 
   */
  @http.route('/web/view/editCustom', { type: 'json', auth: "user" })
  async editCustom(req: WebRequest, res: ServerResponse, opts: { customId?: number, arch?: string } = {}) {
    const customView = (await req.getEnv()).items('ir.ui.view.custom').browse(opts.customId);
    await customView.write({ 'arch': opts.arch });
    return { 'result': true }
  }
}

@http.define()
class Binary extends http.Controller {
  static _module = module;

  @http.route(['/web/content',
    '/web/content/<string:xmlid>',
    '/web/content/<string:xmlid>/<string:filename>',
    '/web/content/<int:id>',
    '/web/content/<int:id>/<string:filename>',
    '/web/content/<string:model>/<int:id>/<string:field>',
    '/web/content/<string:model>/<int:id>/<string:field>/<string:filename>'], { type: 'http', auth: "public" })
  async contentCommon(req, res, opts: { xmlid?: string, model?: string, id?: any, field?: string, filename?: any, filenameField?: string, unique?: any, mimetype?: string, download?: any, data?: any, token?: any, accessToken?: any } = {}) {
    setOptions(opts, { model: 'ir.attachment', field: 'datas', filenameField: 'label' });
    return (await req.getEnv()).items('ir.http')._getContentCommon(opts);
  }

  @http.route(['/web/assets/debug/<string:filename>',
    '/web/assets/debug/<path:extra>/<string:filename>',
    '/web/assets/<int:id>/<string:filename>',
    '/web/assets/<int:id>-<string:unique>/<string:filename>',
    '/web/assets/<int:id>-<string:unique>/<path:extra>/<string:filename>'], { type: 'http', auth: "public" })
  async contentAssets(req: WebRequest, res: ServerResponse, opts: { id?: number, filename?: string, unique?: any, extra?: any } = {}) {
    const filename = opts.filename;
    let domain;
    if (opts.extra) {
      domain = [['url', '=like', `/web/assets/%/${opts.extra}/${filename}`]]
    }
    else {
      domain = [
        ['url', '=like', `/web/assets/%/${filename}`],
        ['url', 'not like', `/web/assets/%/%/${filename}`]
      ]
    }
    const env = await req.getEnv();
    const id = bool(opts.id) ? opts.id : await (await env.items('ir.attachment').sudo()).search(domain, { limit: 1 }).id;
    return env.items('ir.http')._getContentCommon(req, res, { xmlid: null, model: 'ir.attachment', id: id, field: 'datas', unique: opts.unique, filename: filename, filenameField: 'label', download: null, mimetype: null, accessToken: null, token: null });
  }

  @http.route(['/web/image',
    '/web/image/<string:xmlid>',
    '/web/image/<string:xmlid>/<string:filename>',
    '/web/image/<string:xmlid>/<int:width>x<int:height>',
    '/web/image/<string:xmlid>/<int:width>x<int:height>/<string:filename>',
    '/web/image/<string:model>/<int:id>/<string:field>',
    '/web/image/<string:model>/<int:id>/<string:field>/<string:filename>',
    '/web/image/<string:model>/<int:id>/<string:field>/<int:width>x<int:height>',
    '/web/image/<string:model>/<int:id>/<string:field>/<int:width>x<int:height>/<string:filename>',
    '/web/image/<int:id>',
    '/web/image/<int:id>/<string:filename>',
    '/web/image/<int:id>/<int:width>x<int:height>',
    '/web/image/<int:id>/<int:width>x<int:height>/<string:filename>',
    '/web/image/<int:id>-<string:unique>',
    '/web/image/<int:id>-<string:unique>/<string:filename>',
    '/web/image/<int:id>-<string:unique>/<int:width>x<int:height>',
    '/web/image/<int:id>-<string:unique>/<int:width>x<int:height>/<string:filename>'], { type: 'http', auth: "public" })
  async contentImage(req, res, opts: { xmlid?: any, model?: string, id?: number, field?: string, filenameField?: string, unique?: any, filename?: any, mimetype?: any, download?: any, width?: number, height?: number, quality?: any, crop?: boolean, accessToken?: any } = {}) {
    setOptions(opts, { model: 'ir.attachment', field: 'datas', filenameField: 'label', width: 0, height: 0, crop: false });
    opts.quality = parseInt(opts['quality'] || 0);
    // other kwargs are ignored on purpose
    return (await req.getEnv()).items('ir.http')._contentImage(req, res, opts);
  }

  // backward compatibility
  @http.route(['/web/binary/image'], { type: 'http', auth: "public" })
  async contentImageBackwardCompatibility(req, res, opts: { model?: string, id?: number, field?: string, resize?: string } = {}) {
    let width, height;
    if (opts.resize) {
      [width, height] = opts.resize.split(",")
    }
    return (await req.getEnv()).items('ir.http')._contentImage(req, res, { model: opts.model, resId: opts.id, field: opts.field, width: width, height: height });
  }

  @http.route('/web/binary/upload', { type: 'http', auth: "user" })
  @serializeException()
  async upload(req, res, opts: { ufile?: any, callback?: any } = {}) {
    const out = `<script language="javascript" type="text/javascript">
                  var win = window.top.window;
                  win.jQuery(win).trigger(%s, %s);
              </script>`;
    let args;
    try {
      const data = opts.ufile.read();
      args = [len(data), opts.ufile.filename,
      opts.ufile.contentType, toText(b64encode(data))]
    } catch (e) {
      args = [false, String(e)];
    }
    return opts.callback ? f(out, stringify(clean(opts.callback)), stringify(args)) : stringify(args)
  }

  @http.route('/web/binary/uploadAttachment', { type: 'http', auth: "user" })
  @serializeException()
  async uploadAttachment(req, res, opts: { model?: string, id?: number, ufile?: string, callback?: any } = {}) {
    /*
    files = request.httprequest.files.getlist('ufile')
        Model = request.env['ir.attachment']
        out = """<script language="javascript" type="text/javascript">
                    var win = window.top.window;
                    win.jQuery(win).trigger(%s, %s);
                </script>"""
        args = []
        for ufile in files:

            filename = ufile.filename
            if request.httprequest.user_agent.browser == 'safari':
                Safari sends NFD UTF-8 (where é is composed by 'e' and [accent])
                we need to send it the same stuff, otherwise it'll fail
                filename = unicodedata.normalize('NFD', ufile.filename)

            try:
                attachment = Model.create({
                    'name': filename,
                    'datas': base64.encodebytes(ufile.read()),
                    'res_model': model,
                    'res_id': int(id)
                })
                attachment._post_add_create()
            except AccessError:
                args.append({'error': _("You are not allowed to upload an attachment here.")})
            except Exception:
                args.append({'error': _("Something horrible happened")})
                _logger.exception("Fail to upload attachment %s" % ufile.filename)
            else:
                args.append({
                    'filename': clean(filename),
                    'mimetype': ufile.content_type,
                    'id': attachment.id,
                    'size': attachment.file_size
                })
        return out % (json.dumps(clean(callback)), json.dumps(args)) if callback else json.dumps(args)
        */
  }

  @http.route([
    '/web/binary/companyLogo',
    '/logo',
    '/logo.png',
  ], { type: 'http', auth: "none", cors: "*" })
  async companyLogo(req: WebRequest, res: ServerResponse, opts: { dbname?: any } = {}) {
    const imgname = 'logo';
    const imgext = '.png';
    const placeholder = partial(getResourcePath, 'web', 'static', 'img');
    let uid = null;
    if (req.session.db) {
      opts.dbname = req.session.db;
      uid = req.session.uid;
    }
    else if (opts.dbname == null) {
      opts.dbname = await dbMonodb(req);
    }

    if (!uid) {
      uid = global.SUPERUSER_ID;
    }

    let response;
    if (!opts.dbname) {
      response = await sendFile(req, res, await placeholder(imgname + imgext));
    }
    else {
      try {
        // create an empty registry
        const registry = await modules.registry.Registry.create(opts.dbname);
        const cr = registry.cursor();
        // with registry.cursor() as cr:
        const company = opts && opts['company'] ? tools.parseInt(opts['company']) : false;
        let row;
        if (company) {
          row = await cr.execute(`
            SELECT "logoWeb", "updatedAt"
              FROM "resCompany"
              WHERE id = %s
          `, [company]);
        }
        else {
          row = await cr.execute(`
            SELECT c."logoWeb", c."updatedAt"
              FROM "resUsers" u
            LEFT JOIN "resCompany" c
              ON c.id = u."companyId"
            WHERE u.id = %s
          `, [uid]);
        }
        if (row[0]) {
          const imageBase64 = b64decode(row[0]['logoWeb']);
          const imageData = imageBase64.values();
          const mimetype = guessMimetype(imageBase64, 'image/png');
          let imgext = '.' + mimetype.split('/')[1];
          if (imgext === '.svg+xml') {
            imgext = '.svg';
          }
          response = await sendFile(req, res, imageData, { filename: imgname + imgext, mimetype: mimetype, mtime: row[0]['updatedAt'] });
        }
        else {
          response = await sendFile(req, res, await placeholder('nologo.png'));
        }
        await cr.close();
      } catch (e) {
        response = await sendFile(req, res, await placeholder(imgname + imgext));
      }
    }
    return response;
  }

  /**
   * This route will return a list of base64 encoded fonts.

    Those fonts will be proposed to the user when creating a signature
    using mode 'auto'.

    :return: base64 encoded fonts
    :rtype: list
   * @param req 
   * @param res 
   * @param opts 
   */
  @http.route(['/web/sign/getFonts', '/web/sign/getFonts/<string:fontname>'], { type: 'json', auth: 'public' })
  async getFonts(req: WebRequest, res: ServerResponse, opts: { fontname?: string } = {}) {
    const supportedExts = ['.ttf', '.otf', '.woff', '.woff2']
    const fonts = [];
    const fontsDirectory = filePath(path.join('web', 'static', 'fonts', 'sign'));
    if (opts.fontname) {
      const fontPath = path.join(fontsDirectory, opts.fontname);
      // const fd = fileOpen(fontPath, 'r', supportedExts).fd;
      const font = await fs.readFile(filePath(fontPath, supportedExts));
      // fileClose(fd);
      fonts.push(b64encode(font));
    }
    else {
      const fontFilenames = listDir(fontsDirectory).filter(fn =>
        supportedExts.some(ext => fn.endsWith(ext))).sort();
      for (const filename of fontFilenames) {
        // const fd = fileOpen(path.join(fontsDirectory, filename), 'r', supportedExts).fd;
        const font = await fs.readFile(filePath(path.join(fontsDirectory, filename), supportedExts));
        // fileClose(fd);
        fonts.push(b64encode(font));
      }
    }
    return fonts;
  }
}

@http.define()
class Action extends http.Controller {
  static _module = module;

  @http.route('/web/action/load', { type: 'json', auth: "user" })
  async load(req, res, opts: { actionId?: any, additionalContext?: any }) {
    const env: Environment = await req.getEnv();
    let action, actionId;
    actionId = parseInt(String(opts.actionId));
    if (isNaN(actionId)) {
      try {
        action = await env.ref(opts.actionId);
        assert(action._name.startsWith('ir.actions.'));
        actionId = action.id;
      } catch (e) {
        actionId = 0;   // force failed read
      }
    }
    let result: any = false;
    const baseAction = await env.items('ir.actions.actions').browse(actionId);
    if (bool(baseAction)) {
      const ctx = Dict.from(req.context);
      const type = await baseAction['type'];
      if (type === 'ir.actions.report') { // actionId = 147
        ctx.updateFrom({ 'binSize': true });
      }
      if (opts.additionalContext) {
        ctx.updateFrom(opts.additionalContext);
      }
      req.context = ctx;
      result = (await (await env.items(type).sudo()).searchRead([['actionId', '=', actionId]]))[0];
      result['id'] = actionId; // change actwindow.id to baseAction.id

      if (bool(result)) {
        result = cleanAction(result, env);
      }
    }
    return result;
  }

  @http.route('/web/action/run', { type: 'json', auth: "user" })
  async run(req, res, opts: { actionId?: number } = {}) {
    const env: Environment = await req.getEnv();
    const actionId = parseInt(String(opts.actionId));
    const action = await env.items('ir.actions.server').search([['actionId', '=', actionId]]);
    if (action.ok) {
      const result = await action.run();
      return bool(result) ? cleanAction(result, env) : false;
    }
    return false;
  }
}

@http.define()
class Export extends http.Controller {
  static _module = module;

  /**
   * Returns all valid export formats
    :returns: for each export format, a pair of identifier and printable name
    :rtype: [(str, str)]
   * @param req 
   * @param res 
   * @returns 
   */
  @http.route('/web/export/formats', { type: 'json', auth: "user" })
  async formats() {
    return [
      { 'tag': 'xlsx', 'label': 'XLSX', 'error': null },
      { 'tag': 'csv', 'label': 'CSV' },
    ]
  }

  async fieldsGet(req, model?: string) {
    const Model = (await req.getEnv()).items(model);
    const fields = await Model.fieldsGet();
    return fields;
  }

  @http.route('/web/export/getFields', { type: 'json', auth: "user" })
  async getFields(req, res, opts: { model?: string, prefix?: string, parentName?: string, importCompat?: boolean, parentFieldType?: string, parentField?: string, exclude?: any } = {}) {
    setOptions(opts, { prefix: '', parentName: '', importCompat: true });
    let fields = await this.fieldsGet(req, opts.model);
    if (opts.importCompat) {
      if (['many2one', 'many2many'].includes(opts.parentFieldType)) {
        const recName = await (await req.getEnv()).items(opts.model)._recNameFallback();
        fields = { 'id': fields['id'], recName: fields[recName] }
      }
    }
    else {
      fields['.id'] = { ...fields['id'] }
    }

    fields['id']['string'] = await _t(await req.getEnv(), 'External ID');

    const parentField = opts.parentField;
    if (bool(parentField)) {
      parentField['string'] = await _t(await req.getEnv(), 'External ID');
      fields['id'] = parentField;
    }

    const fieldsSequence = sorted(
      Object.entries(fields), (field) => String(field[1]['string'] || '').toLocaleLowerCase()
    );

    const records = [];
    for (const [fieldName, field] of fieldsSequence) {
      if (opts.importCompat && fieldName !== 'id') {
        if (opts.exclude && opts.exclude.includes(fieldName)) {
          continue;
        }
        if (field['readonly']) {
          // If none of the field's states unsets readonly, skip the field
          let all = true;
          for (const attrs of Object.values(field['states'] ?? {})) {
            if (Dict.from(attrs).get('readonly', true)) {
              all = false;
              break;
            }
          }
          if (all) {
            continue;
          }
        }
      }
      if (!(field['exportable'] ?? true)) {
        continue;
      }

      const id = opts.prefix + (opts.prefix && '/' || '') + fieldName;
      let val = id;
      if (fieldName === 'name' && opts.importCompat && ['many2one', 'many2many'].includes(opts.parentFieldType)) {
        // Add name field when expand m2o and m2m fields in import-compatible mode
        val = opts.prefix;
      }
      const name = opts.parentName + (opts.parentName && '/' || '') + field['string'];
      const record = {
        'id': id, 'string': name,
        'value': val, 'children': false,
        'fieldType': field['type'],
        'required': field['required'],
        'relationField': field['relationField']
      }
      records.push(record);

      if (len(id.split('/')) < 3 && 'relation' in field) {
        const ref = field.pop('relation')
        record['value'] += '/id'
        record['params'] = { 'model': ref, 'prefix': id, 'name': name, 'parentField': field }
        record['children'] = true
      }
    }
    return records;
  }

  @http.route('/web/export/namelist', { type: 'json', auth: "user" })
  async namelist(req, res, opts: { model?: string, exportId?: string } = {}) {
    const env = await req.getEnv();
    const _export = await env.items('ir.exports').browse([opts.exportId]).readOne();
    const exportFieldsList = await env.items('ir.exports.line').browse(_export['exportFields']).read();

    const fieldsData = this.fieldsInfo(opts.model, exportFieldsList.map(f => f['name']));

    return exportFieldsList.map(field => { return { 'name': field['name'], 'label': fieldsData[field['name']] } });
  }

  async fieldsInfo(model, exportFields) {
    const info = {}
    const fields = await this.fieldsGet(model);
    if (exportFields.includes('.id')) {
      fields['.id'] = fields['id'] ?? { 'string': 'ID' };
    }
    /**
     * To make fields retrieval more efficient, fetch all sub-fields of a
        given field at the same time. Because the order in the export list is
        arbitrary, this requires ordering all sub-fields of a given field
        together so they can be fetched at the same time
      
        Works the following way:
        * sort the list of fields to export, the default sorting order will
          put the field itself (if present, for xmlid) and all of its
          sub-fields right after it
        * then, group on: the first field of the path (which is the same for
          a field and for its subfields and the length of splitting on the
          first '/', which basically means grouping the field on one side and
          all of the subfields on the other. This way, we have the field (for
          the xmlid) with length 1, and all of the subfields with the same
          base but a length "flag" of 2
        * if we have a normal field (length 1), just add it to the info
          mapping (with its string) as-is
        * otherwise, recursively call fields_info via graft_subfields.
          all graft_subfields does is take the result of fields_info (on the
          field's model) and prepend the current base (current field), which
          rebuilds the whole sub-tree for the field
        #
        result: because we're not fetching the fieldsGet for half the
        database models, fetching a namelist with a dozen fields (including
        relational data) falls from ~6s to ~300ms (on the leads model).
        export lists with no sub-fields (e.g. import_compatible lists with
        no o2m) are even more efficient (from the same 6s to ~170ms, as
        there's a single fieldsGet to execute)
     */
    for (let [[base, length], subfields] of groupby(
      sorted(exportFields),
      (field) => [field.split('/', 1)[0], len(field.split('/', 1))])) {
      subfields = Array.from(subfields);
      if (length == 2) {
        // subfields is a seq of $base/*rest, and not loaded yet
        Object.assign(info, this.graftSubfields(
          fields[base]['relation'], base, fields[base]['string'],
          subfields
        ))
      }
      else if (base in fields) {
        info[base] = fields[base]['string'];
      }

      return info;
    }
  }

  async graftSubfields(model, prefix, prefixString, fields) {
    const exportFields = fields.map(field => split(field, '/', 1)[1]);
    return Object.entries<any>(await this.fieldsInfo(model, exportFields)).map(([k, v]) => [prefix + '/' + k, prefixString + '/' + v]);
  }
}

/**
 * This class builds an ordered tree of groups from the result of a `read_group(lazy=False)`.
    The `read_group` returns a list of dictionnaries and each dictionnary is used to
    build a leaf. The entire tree is built by inserting all leaves.
 */
class GroupsTreeNode {
  private _model: any;
  private _exportFieldNames: any;
  private _groupby: any;
  private _groupbyType: any;
  count: number;
  children: OrderedDict<GroupsTreeNode>;
  data: any[];

  private constructor(model, fields, groupby, groupbyType) {
    this._model = model
    this._exportFieldNames = fields; //  exported field names (e.g. 'journalId', 'accountId/label', ...)
    this._groupby = groupby;
    this._groupbyType = groupbyType;

    this.count = 0;  // Total number of records in the subtree
    this.children = new OrderedDict();
    this.data = [];  // Only leaf nodes have data
  }

  static async new(model, fields, groupby, groupbyType, root?: any) {
    const node = new GroupsTreeNode(model, fields, groupby, groupbyType);
    if (root) {
      await node.insertLeaf(root);
    }
    return node;
  }

  _getAggregate(fieldName, data, groupOperator) {
    // When exporting one2many fields, multiple data lines might be exported for one record.
    // Blank cells of additionnal lines are filled with an empty string. This could lead to '' being
    // aggregated with an integer or float.
    data = data.filter(value => value != '');

    if (groupOperator == 'avg') {
      return this._getAvgAggregate(fieldName, data);
    }

    const aggregateFunc: Function = OPERATOR_MAPPING[groupOperator];
    if (!aggregateFunc) {
      console.warn("Unsupported export of group_operator '%s' for field %s on model %s", groupOperator, fieldName, this._model._name);
      return;
    }

    if (this.data.length) {
      return aggregateFunc(data);
    }
    return aggregateFunc(this.children.values().map(child => child.aggregatedValues.get(fieldName)));
  }

  _getAvgAggregate(fieldName, data) {
    const aggregateFunc = OPERATOR_MAPPING['sum'];
    if (this.data.length) {
      return aggregateFunc(data) / this.count;
    }
    const childrenSums = this.children.values().map(child => child.aggregatedValues.get(fieldName) * child.count);
    return aggregateFunc(childrenSums) / this.count;
  }

  /**
   * Return field names of exported field having a group operator
   * @returns 
   */
  _getAggregatedFieldNames() {
    const aggregatedFieldNames = [];
    for (let fieldName of this._exportFieldNames) {
      if (fieldName == '.id') {
        fieldName = 'id';
      }
      if ('/' in fieldName) {
        // Currently no support of aggregated value for nested record fields
        // e.g. line_ids/analytic_line_ids/amount
        continue;
      }
      const field = this._model._fields[fieldName];
      if (field.groupOperator) {
        aggregatedFieldNames.push(fieldName);
      }
    }
    return aggregatedFieldNames;
  }

  // Lazy property to memoize aggregated values of children nodes to avoid useless recomputations
  @lazy.define()
  get aggregatedValues() {

    const aggregatedValues = new Dict<any>();

    // Transpose the data matrix to group all values of each field in one iterable
    const fieldValues = _.zip(...this.data);
    for (const fieldName of this._exportFieldNames) {
      const fieldData = bool(this.data) && next(fieldValues) || [];

      if (fieldName in this._getAggregatedFieldNames()) {
        const field = this._model._fields[fieldName];
        aggregatedValues[fieldName] = this._getAggregate(fieldName, fieldData, field.groupOperator);
      }
    }
    return aggregatedValues;
  }

  /**
   * Return the child identified by `key`.
      If it doesn't exists inserts a default node and returns it.
      :param key: child key identifier (groupby value as returned by read_group,
                  usually (id, display_name))
      :return: the child node
   * @param key 
   * @returns 
   */
  child(key) {
    if (!(key in this.children)) {
      this.children[key] = new GroupsTreeNode(this._model, this._exportFieldNames, this._groupby, this._groupbyType);
    }
    return this.children[key];
  }

  /**
   * Build a leaf from `group` and insert it in the tree.
      :param group: dict as returned by `read_group(lazy=False)`
   * @param group 
   */
  async insertLeaf(group) {
    const leafPath = this._groupby.map(groupbyField => group.get(groupbyField));
    const domain = group.pop('__domain');
    const count = group.pop('__count');

    const records = await this._model.search(domain, { offset: 0, limit: false, order: false });

    // Follow the path from the top level group to the deepest
    // group which actually contains the records' data.
    let node = this; // root
    node.count += count;
    for (const nodeKey of leafPath) {
      // Go down to the next node or create one if it does not exist yet.
      node = node.child(nodeKey);
      // Update count value and aggregated value.
      node.count += count;
    }
    node.data = (await records.exportData(this._exportFieldNames)).get('datas', []);
  }
}


class ExportFormat extends http.Controller {
  static _module = module;

  /**
   * Provides the format's content type
   */
  get contentType(): string {
    throw new NotImplementedError();
  }

  get extension(): string {
    throw new NotImplementedError()
  }

  /**
   * Creates a filename *without extension* for the item / format of
      model ``base``.
   * @param base 
   * @returns 
   */
  async filename(req, base) {
    const env = await req.getEnv();
    if (!(base in env.models)) {
      return base;
    }

    const modelDescription = await (await env.items('ir.model')._get(base)).label;
    return `${modelDescription} (${base})`;
  }

  /**
   * Conversion method from Verp's export data to whatever the
      current export class outputs
 
      :params list fields: a list of fields to export
      :params list rows: a list of records to export
      :returns:
      :rtype: bytes
   * @param fields 
   * @param rows 
   */
  async fromData(fields, rows) {
    throw new NotImplementedError();
  }

  async fromGroupData(fields, groups) {
    throw new NotImplementedError();
  }

  async base(req, res, data) {
    const params = jsonParse(data);
    let [model, fields, ids, domain, importCompat] =
      itemgetter(['model', 'fields', 'ids', 'domain', 'importCompat'])(params);

    const Model = await (await req.getEnv()).items(model).withContext({ importCompat, ...params['context'] });
    if (! await Model._isAnOrdinaryTable()) {
      fields = fields.filter(field => field['name'] != 'id');
    }
    const fieldNames = fields.map(f => f['name']); // Tony check name => label
    let columnsHeaders, responseData;
    if (importCompat) {
      columnsHeaders = fieldNames;
    }
    else {
      columnsHeaders = fields.map(field => field['label'].trim());
    }
    const groupby = params['groupby'];
    if (!importCompat && groupby) {
      const groupbyType = groupby.map(x => Model._fields[x.split(':')[0]].type);
      domain = bool(ids) ? [['id', 'in', ids]] : domain;
      const groupsData = await Model.readGroup(domain, fieldNames.map(x => x != '.id' ? x : 'id'), groupby, { lazy: false });

      //readGroup(lazy=False) returns a dict only for final groups (with actual data),
      //not for intermediary groups. The full group tree must be re-constructed.
      const tree = await GroupsTreeNode.new(Model, fieldNames, groupby, groupbyType);
      for (const leaf of groupsData) {
        await tree.insertLeaf(leaf);
      }
      responseData = await this.fromGroupData(fields, tree);
    }
    else {
      const records = bool(ids) ? Model.browse(ids) : await Model.search(domain, { offset: 0, limit: false, order: false });

      const exportData = (await records.exportData(fieldNames)).get('datas', []);
      responseData = await this.fromData(columnsHeaders, exportData);
    }
    //TODO: call `clean_filename` directly in `content_disposition`?
    return req.makeResponse(res, responseData,
      [['Content-Disposition',
        contentDisposition(
          cleanFilename(await this.filename(req, model) + this.extension))],
      ['Content-Type', this.contentType]],
    )
  }
}

@http.define()
class CSVExport extends ExportFormat {
  static _module = module;

  @http.route('/web/export/csv', { type: 'http', auth: "user" })
  @serializeException()
  async index(req, res, opts: { data?: any } = {}) {
    return this.base(req, res, opts.data);
  }

  get contentType() {
    return 'text/csv;charset=utf8';
  }

  get extension() {
    return '.csv';
  }

  async fromGroupData(fields, groups) {
    throw new UserError(await _t("Exporting grouped data to csv is not supported."));
  }

  async fromData(fields, rows) {
    console.warn('Not Implemented');
    // fp = io.BytesIO()
    // writer = pycompat.csv_writer(fp, quoting=1)

    // writer.writerow(fields)

    // for data in rows:
    //     row = []
    //     for d in data:
    //         Spreadsheet apps tend to detect formulas on leading =, + and -
    //         if isinstance(d, str) and d.startsWith(('=', '-', '+')):
    //             d = "'" + d

    //         row.append(pycompat.to_text(d))
    //     writer.writerow(row)

    // return fp.getvalue()
  }
}

@http.define()
class ExcelExport extends ExportFormat {
  static _module = module;

  @http.route('/web/export/xlsx', { type: 'http', auth: "user" })
  @serializeException()
  async index(req, res, data) {
    return this.base(req, res, data);
  }

  get contentType() {
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  }

  get extension() {
    return '.xlsx';
  }

  async fromGroupData(fields, groups: GroupsTreeNode) {
    const xlsxWriter = new GroupExportXlsxWriter(fields, null, groups.count);
    lazy.doWithSync(xlsxWriter, () => {
      let [x, y] = [1, 0];
      for (const [groupName, group] of groups.children.items()) {
        [x, y] = xlsxWriter.writeGroup(x, y, groupName, group);
      }
    });
    return xlsxWriter.value;
  }

  async fromData(fields, rows) {
    const xlsxWriter = new ExportXlsxWriter(fields, null, len(rows));
    lazy.doWithSync(xlsxWriter, () => {
      for (const [rowIndex, row] of enumerate(rows)) {
        for (let [cellIndex, cellValue] of enumerate(row)) {
          if (Array.isArray(cellValue)) {
            cellValue = toText(cellValue);
          }
          xlsxWriter.writeCell(rowIndex + 1, cellIndex, cellValue);
        }
      }
    });
    return xlsxWriter.value;
  }
}

@http.define()
class ReportController extends http.Controller {
  static _module = module;


  //------------------------------------------------------
  // Report controllers
  //------------------------------------------------------
  @http.route([
    '/report/<converter>/<reportname>',
    '/report/<converter>/<reportname>/<docids>',
  ], { type: 'http', auth: 'user', website: true })
  async reportRoutes(req, res, opts: { reportname?: any, docids?: any, converter?: any, context?: any } = {}) {
    let { reportname, docids, converter, ...data } = opts;
    const env = await req.getEnv();
    const report = await env.items('ir.actions.report')._getReportFromName(reportname);
    const context = Dict.from(env.context);

    if (docids) {
      docids = docids.split(',').map(x => parseInt(x));
    }
    if (data['options']) {
      lazy.update(data, jsonParse(pop(data, 'options')));
    }
    if (data['context']) {
      data['context'] = jsonParse(data['context']);
      context.updateFrom(data['context']);
    }
    if (converter === 'html') {
      const html = (await (await report.withContext(context))._renderQwebHtml(docids, data))[0];
      return req.makeResponse(res, html);
    }
    else if (converter === 'pdf') {
      const pdf = (await (await report.withContext(context))._renderQwebPdf(docids, data))[0];
      const pdfhttpheaders = [['Content-Type', 'application/pdf'], ['Content-Length', len(pdf)]];
      return req.makeResponse(res, pdf, pdfhttpheaders);
    }
    else if (converter === 'text') {
      const text = (await (await report.withContext(context))._renderQwebText(docids, data))[0];
      const texthttpheaders = [['Content-Type', 'text/plain'], ['Content-Length', len(text)]];
      return req.makeResponse(res, text, texthttpheaders);
    }
    else {
      throw new HTTPException(res, f('Converter %s not implemented.', converter));
    }
  }

  //------------------------------------------------------
  // Misc. route utils
  //------------------------------------------------------
  /**
   * Contoller able to render barcode images thanks to reportlab.
      Samples::
 
          <img t-att-src="'/report/barcode/QR/%s' % o.name"/>
          <img t-att-src="'/report/barcode/?type=%s&amp;value=%s&amp;width=%s&amp;height=%s' %
              ('QR', o.name, 200, 200)"/>
 
      :param type: Accepted types: 'Codabar', 'Code11', 'Code128', 'EAN13', 'EAN8', 'Extended39',
      'Extended93', 'FIM', 'I2of5', 'MSI', 'POSTNET', 'QR', 'Standard39', 'Standard93',
      'UPCA', 'USPS_4State'
      :param width: Pixel width of the barcode
      :param height: Pixel height of the barcode
      :param humanreadable: Accepted values: 0 (default) or 1. 1 will insert the readable value
      at the bottom of the output image
      :param quiet: Accepted values: 0 (default) or 1. 1 will display white
      margins on left and right.
      :param mask: The mask code to be used when rendering this QR-code.
                   Masks allow adding elements on top of the generated image,
                   such as the Swiss cross in the center of QR-bill codes.
      :param barLevel: QR code Error Correction Levels. Default is 'L'.
      ref: https://hg.reportlab.com/hg-public/reportlab/file/830157489e00/src/reportlab/graphics/barcode/qr.js#l101
   * @param req 
   * @param res 
   * @param opts 
   * @returns 
   */
  @http.route(['/report/barcode', '/report/barcode/<type>/<path:value>'], { type: 'http', auth: "public" })
  async reportBarcode(req, res, opts: { type?: any, value?: any } = {}) {
    let { type, value, ...options } = opts;
    let barcode;
    try {
      barcode = await (await req.getEnv()).items('ir.actions.report').barcode(type, value, options);
    } catch (e) {
      if (isInstance(e, ValueError, AttributeError)) {
        throw new HTTPException(res, 'Cannot convert into barcode.');
      }
      throw e;
    }
    return req.makeResponse(res, barcode, [['Content-Type', 'image/png']]);
  }
  /**
   * This function is used by 'action_manager_report.js' in order to trigger the download of
      a pdf/controller report.
 
      :param data: a javascript array JSON.stringified containg report internal url ([0]) and
      type [1]
      :returns: Response with an attachment header
   * @param req 
   * @param res 
   * @param data 
   */
  @http.route(['/report/download'], { type: 'http', auth: "user" })
  async reportDownload(req: WebRequest, res, opts: { data?: any, context?: any } = {}) {
    let { data, context } = opts;
    const requestcontent = jsonParse(data);
    const url = requestcontent[0],
      type = requestcontent[1];
    let reportname = '???';
    try {
      if (['qweb-pdf', 'qweb-text'].includes(type)) {
        const converter = type === 'qweb-pdf' ? 'pdf' : 'text';
        const extension = type === 'qweb-pdf' ? 'pdf' : 'txt';

        const pattern = type === 'qweb-pdf' ? '/report/pdf/' : '/report/text/';
        reportname = url.split(pattern)[1].split('?')[0];

        let docids,
          response: WebResponse;
        if (reportname.includes('/')) {
          [reportname, docids] = reportname.split('/');
        }
        if (docids) {
          //Generic report:
          response = await this.reportRoutes(req, res, { reportname, docids, converter, context });
        }
        else {
          // Particular report:
          data = Dict.from(lazy.urlDecode(url.split('?')[1]).items());  //decoding the args represented in JSON
          if ('context' in data) {
            context = jsonParse(context ?? '{}');
            const dataContext = jsonParse(pop(data, 'context'));
            context = stringify({ ...context, ...dataContext });
          }
          response = await this.reportRoutes(req, res, { reportname, converter, context, ...data });
        }
        const report = await (await req.getEnv()).items('ir.actions.report')._getReportFromName(reportname);
        let filename = f("%s.%s", await report.label, extension);

        if (docids) {
          const ids = docids.split(",").map(x => parseInt(x));
          const obj = (await req.getEnv()).items(await report.model).browse(ids);
          if (await report.printReportName && !(len(obj) > 1)) {
            const reportName = safeEval(await report.printReportName, { 'object': obj, 'time': Date });
            filename = f("%s.%s", reportName, extension);
          }
        }
        response.setHeader('Content-Disposition', contentDisposition(filename));
        return response;
      }
      else {
        return;
      }
    } catch (e) {
      console.error("Error while generating report %s", reportname);
      const se = _serializeException(e);
      const error = {
        'code': 200,
        'message': "Verp Server Error",
        'data': se
      }
      const response = req.makeResponse(res, escapeHtml(stringify(error)));
      throw new InternalServerError(response);
    }
  }

  @http.route(['/report/checkHtmltoPdf'], { type: 'json', auth: "user" })
  async checkHtmltoPdf(req) {
    return (await req.getEnv()).items('ir.actions.report').getChromiumState();
  }

}

function cleanAction(action: {}, env: Environment) {
  const actionType = setdefault(action, 'type', 'ir.actions.actwindow.close');
  if (actionType === 'ir.actions.actwindow') {
    action = fixViewModes(action);
  }

  // When returning an action, keep only relevant fields/properties
  const readableFields = env.items(action['type'])._getReadableFields();
  const actionTypeFields = env.models[action['type']]._fields.keys();

  const cleanedAction = Object.fromEntries<any>(Object.entries(action).filter(([field]) => readableFields.includes(field) || !actionTypeFields.includes(field)));

  // Warn about custom properties fields, because use is discouraged
  const actionName = action['label'] ?? action;
  const customProperties = _.difference(Object.keys(action), readableFields, actionTypeFields);
  if (customProperties.length) {
    console.warn(`Action %s contains custom properties %s. Passing them
        via the 'params' or 'context' properties is recommended instead`,
      actionName, customProperties.map(e => repr(e)).join(', '))
  }
  return cleanedAction;
}

/**
 * While the server generates a sequence called "views" computing dependencies
  between a bunch of stuff for views coming directly from the database
  (the ``ir.actions.actwindow model``), it's also possible for e.g. buttons
  to return custom view dictionaries generated on the fly.
 
  In that case, there is no ``views`` key available on the action.
 
  Since the web client relies on ``action['views']``, generate it here from
  ``viewMode`` and ``viewId``.
 
  Currently handles two different cases:
 
  * no viewId, multiple viewMode
  * single viewId, single viewMode
 
  :param dict action: action descriptor dictionary to generate a views key for
 */
function generateViews(action) {
  let viewId = action['viewId'] || false;
  if (isList(viewId)) {
    viewId = viewId[0];
  }

  // providing at least one view mode is a requirement, not an option
  const viewModes = action['viewMode'].split(',');

  if (viewModes.length > 1) {
    if (viewId) {
      throw new ValueError('Non-db action dictionaries should provide either multiple view modes or a single view mode and an optional view id.\nGot view modes %s and view id %s for action %s', viewModes, viewId, action.id);
    }
    action['views'] = viewModes.map(mode => [false, mode])
    return;
  }
  action['views'] = [[viewId, viewModes[0]]];
}

/**
 * For historical reasons, Verp has weird dealings in relation to
  viewMode and the viewType attribute (on window actions):
 
  * one of the view modes is ``tree``, which stands for both list views
    and tree views
  * the choice is made by checking ``viewType``, which is either
    ``form`` for a list view or ``tree`` for an actual tree view
 
  This methods simply folds the viewType into viewMode by adding a
  new view mode ``list`` which is the result of the ``tree`` viewMode
  in conjunction with the ``form`` viewType.
 
  TODO: this should go into the doc, some kind of "peculiarities" section
 
  :param dict action: an action descriptor
  :returns: nothing, the action is modified in place
 * @param action 
 * @returns 
 */
function fixViewModes(action) {
  if (!action['views']) {
    generateViews(action);
  }

  if (pop(action, 'viewType', 'form') !== 'form') {
    return action;
  }

  if ('viewMode' in action) {
    action['viewMode'] = action['viewMode'].split(',').map(mode => mode !== 'tree' ? mode : 'list').join(',');
  }
  action['views'] = action['views'].map(([id, mode]) => [id, mode !== 'tree' ? mode : 'list']);

  return action;
}
