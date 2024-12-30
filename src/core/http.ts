import assert from "assert";
import fs, { unlinkSync } from "fs";
import http, { ServerResponse } from 'http';
import _ from "lodash";
import { DateTime } from "luxon";
import { format } from "node:util";
import path from "path";
import * as prettier from 'prettier';
import * as core from '.';
import { Headers } from '../core/service/middleware/datastructures';
import { Environment } from "./api";
import { getattr, hasattr, mro, setattr } from "./api/func";
import { CombinedMultiDict, DefaultDict, Dict, FrozenDict, Stack } from "./helper/collections";
import { AccessDenied, KeyError, NotImplementedError, RedirectWarning, RuntimeError, UserError, ValueError } from "./helper/errors";
import { getModule, getmembers } from "./models";
import { getDirectories, readManifest } from "./modules/modules";
import { Router, Rule, security } from "./service";
import { BaseRequest } from "./service/middleware/base_request";
import { BaseResponse } from "./service/middleware/base_response";
import { BadRequest, Forbidden, HTTPException, NotFound } from "./service/middleware/exceptions";
import { SharedDataMiddleware } from "./service/middleware/shared_data";
import { redirect, urlEncode, urlQuote } from "./service/middleware/utils";
import { wrapFile } from "./service/middleware/wsgi";
import { checkSession } from "./service/security";
import { Cursor } from "./sql_db";
import { FileDescriptor, LOCALE_ALIASES, bool, config, consteq, doWith, escapeRegExp, extend, f, fileOpen, getArgumentNames, hash, isCallable, isDir, isInstance, isObject, len, parseLocale, pop, postMortem, rstringPart, rstrip, setOptions, sorted, str2bool, stringPart, stringify, unique, update, ustr } from "./tools";
import * as sessions from "./tools/sessions";
import * as lazy from './tools/lazy';
import { guessMimetype, guessType } from "./tools/mimetypes";
import { contextmanager } from "./tools/context";

type RequestOptions = http.RequestOptions & {params?: any}

export async function httpGet(url: string | URL, options?: RequestOptions): Promise<any> {
  return new Promise<any>((resolve, reject) => {
    const params = pop(options, 'params');
    if (bool(params)) {
      const searchParams = urlEncode(params);
      url = url + '?' + searchParams;
    } 
    const req = http.request(url, options, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error('statusCode=' + res.statusCode));
      }
      let body: any = [];
      res.on('data', function (chunk) {
        body.push(chunk);
      });
      res.on('end', function () {
        try {
          if (res.headers["content-type"] == 'application/json') {
            body = JSON.parse(Buffer.concat(body).toString());
          }
        } catch (e) {
          reject(e); // Tony check
        }
        resolve(res);
      });
    });
    req.on('error', (e) => {
      reject(e.message);
    });
    req.end();
  });
}

export async function httpPost(postData, url: string | URL, options?: RequestOptions): Promise<any> {
  await new Promise((resolve, reject) => {
    const params = pop(options, 'params');
    if (bool(params)) {
      const searchParams = urlEncode(params);
      url = url + '?' + searchParams;
    } 
    const req = http.request(url, options, (res) => {
      if (res.statusCode !== 200) {
        console.error(`Did not get an OK from the server. Code: ${res.statusCode}`);
        res.resume();
        return;
      }

      var body = [];
      res.on('data', function (chunk) {
        body.push(chunk);
      });
      res.on('close', function () {
        try {
          if (res.headers["content-type"] == 'application/json') {
            body = JSON.parse(Buffer.concat(body).toString());
          }
        } catch (e) {
          reject(e);
        }
        resolve(res);//{ body: body as any, statusCode: 'ok', headers: res.headers });
      });
    });
    req.on('error', (e) => {
      console.error(`problem with request: ${e.message}`);
      reject(e);
    });

    // Write data to request body
    req.write(postData);
    req.end();
  });
}

export async function dispatchRpc(req: WebRequest, serviceName: string, method: string, params: any[]) {
  let dispatch;
  if (serviceName === 'common') {
    dispatch = core.service.common.dispatch;
  }
  else if (serviceName === 'db') {
    dispatch = core.service.db.dispatch;
  }
  else if (serviceName === 'object') {
    dispatch = core.service.model.dispatch;
  }
  const result = await dispatch(method, req, ...params);
  return result;
}

const _requestStack = new Stack();

function getMeta(cls) {
  if (!hasattr(cls, '__verp_meta__')) {
    const meta = {
      url: '',
      middleware: [],
      routes: {},
    };
    return setattr(cls, '__verp_meta__', meta, { enumerable: false });
  }
  return getattr(cls, '__verp_meta__');
}

export function serializeException(e: any) {
  const cls = Object.getPrototypeOf(e);
  return {
    "name": "verp.exceptions." + cls.constructor.name,
    "message": e.message,
    "arguments": e.args,
    "debug": e.stack,
    "context": getattr(e, 'context', {}),
  }
}

export const ALLOWED_DEBUG_MODES = ['', '1', 'assets', 'tests']

export const controllersOnModule = new Dict<any>();//list

const NO_POSTMORTEM = [AccessDenied, UserError, RedirectWarning];

export class Controller {
  _t = core.tools._t;
}

export function define(middlewareOrRouterOptions?: {}, middleware = []) {
  return (cls) => {
    assert(getattr(cls, '_module'), `Invalid controller ${cls.name}, it should declare 'static _module = module`);
    let _a, _b;
    const meta = getMeta(cls.prototype);
    meta.middleware = Array.isArray(middlewareOrRouterOptions)
      ? middlewareOrRouterOptions.concat((_a = meta.middleware) !== null && _a !== void 0 ? _a : [])
      : middleware.concat((_b = meta.middleware) !== null && _b !== void 0 ? _b : []);
    meta.routerOptions = Array.isArray(middlewareOrRouterOptions) ? null : middlewareOrRouterOptions;

    setattr(cls, '_subclasses', new Set());
    const base = Object.getPrototypeOf(cls);
    if (!base.hasOwnProperty('_subclasses')) {
      setattr(base, '_subclasses', new Set());
    }
    getattr(base, '_subclasses').add(cls);
    const bases = mro(cls);
    for (const [k, v] of Object.entries<any>(Object.getOwnPropertyDescriptors<any>(cls.prototype))) {
      if (['constructor'].includes(k)) {
        continue;
      }
      const func = v.value;
      if (isCallable(func) && hasattr(func, 'originalFunc')) {
        // Set routing type on original functions
        let routingType = func.routing.get('type');
        const parent = bases.filter(claz => (claz.prototype instanceof Controller) && claz !== cls && hasattr(claz.prototype, k));
        const parentRoutingType = parent.length ? getattr(parent[0].prototype, k).originalFunc.routingType : routingType || 'http';
        if (routingType != null && routingType != parentRoutingType) {
          routingType = parentRoutingType;
          console.warn("Subclass re-defines <function %s.%s.%s> with different type than original. Will use original type: %s", meta.module, cls.name, k, parentRoutingType);
        }
        func.originalFunc.routingType = routingType || parentRoutingType;

        const args = getArgumentNames(func.originalFunc);
        const firstArg = len(args) >= 1 ? args[0][0] : null;
        if (["req", "request"].includes(firstArg)) {
          setattr(func, '_firstArgIsReq', true, { enumerable: false, configurable: false });
        }
      }
    }

    const nameClass: any[] = [getModule(cls._module), cls];
    let modul = meta.module;

    const classPath = nameClass[0].split(".");
    if (classPath[0] !== "core" && classPath[1] !== "addons") {
      modul = "";
    }
    else {
      // we want to know all modules that have controllers
      modul = classPath[2];
    }
    // but we only store controllers directly inheriting from Controller
    if (base !== Controller) {
      return;
    }
    const controllers = controllersOnModule;
    (controllers[modul] = controllers[modul] || []).push(nameClass);
  }
}

type RouteOptions = { type?: 'json' | 'http', auth?: string, methods?: string[], website?: boolean, sitemap?: any, saveSession?: boolean, csrf?: boolean, cors?: string, multilang?: boolean, fields?: {} }

/**
 * Decorator marking the decorated method as being a handler for
    requests. The method must be part of a subclass of ``Controller``.

    @param route string or array. The route part that will determine which
                  http requests will match the decorated method. Can be a
                  single string or an array of strings. See theveb's routing
                  documentation for the format of route expression (
                  http://theveb.pocoo.org/docs/routing/ ).
    @param type The type of request, can be ``'http'`` or ``'json'``.
    @param auth The type of authentication method, can on of the following:

                 * ``user``: The user must be authenticated and the current request
                   will perform using the rights of the user.
                 * ``public``: The user may or may not be authenticated. If she isn't,
                   the current request will perform using the shared Public user.
                 * ``none``: The method is always active, even if there is no
                   database. Mainly used by the framework and authentication
                   modules. There request code will not have any facilities to access
                   the database nor have any configuration indicating the current
                   database nor the current user.
    @param methods A sequence of http methods this route applies to. If not
                    specified, all methods are allowed.
    @param cors The Access-Control-Allow-Origin cors directive value.
    @param csrf Whether CSRF protection should be enabled for the route.

                      Defaults to ``true``. See :ref:`CSRF Protection
                      <csrf>` for more.

    .. _csrf:

    .. admonition:: CSRF Protection
        :class: alert-warning

        Verp implements token-based `CSRF protection
        <https://en.wikipedia.org/wiki/CSRF>`_.

        CSRF protection is enabled by default and applies to *UNSAFE*
        HTTP methods as defined by :rfc:`7231` (all methods other than
        ``GET``, ``HEAD``, ``TRACE`` and ``OPTIONS``).

        CSRF protection is implemented by checking requests using
        unsafe methods for a value called ``csrfToken`` as part of
        the request's form data. That value is removed from the form
        as part of the validation and does not have to be taken in
        account by your own form processing.

        When adding a new controller for an unsafe method (mostly POST
        for e.g. forms):

        * if the form is generated in Javascript, a csrf token is
          available via :meth:`request.csrfToken()
          <verp.http.WebRequest.csrfToken`, the
          :data:`~verp.http.request` object is available by default
          in QWeb templates, it may have to be added
          explicitly if you are not using QWeb.

        * if the form is generated in Javascript, the CSRF token is
          added by default to the QWeb (js) rendering context as
          ``csrfToken`` and is otherwise available as ``csrfToken``
          on the ``web.core`` module:

          .. code-block:: javascript

              require('web.core').csrfToken

        * if the endpoint can be called by external parties (not from
          Verp) as e.g. it is a REST API or a `webhook
          <https://en.wikipedia.org/wiki/Webhook>`_, CSRF protection
          must be disabled on the endpoint. If possible, you may want
          to implement other methods of request validation (to ensure
          it is not called by an unrelated third-party).
 * @param route 
 * @param kw 
 * @returns 
 */
export function route(route?: string | string[] | {}, kw: RouteOptions = {}) {
  if (typeof (route) !== 'string' && !Array.isArray(route)) {
    kw = route;
    route = null;
  }
  const routing = Dict.from<any>(kw);
  assert(!('type' in routing) || ['http', 'json'].includes(routing['type']));

  function decorator(target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    assert(getattr(target.constructor, '_module'), `Invalid controller class ${target.constructor.name}, it should declare 'static _module = module`);

    // setup one time for one controller
    const meta = getMeta(target);
    if (!meta.module) {
      const modulename = getModule(target.constructor._module);
      assert(modulename.startsWith('core.addons.'), `Invalid controller module, it should start with 'core.addons`);
      meta.module = modulename.split('.')[2];
    }

    if (route) {
      let routes;
      if (Array.isArray(route)) {
        routes = route;
      } else {
        routes = [route];
      }
      routing['routes'] = routes;
      const wrong = routing.pop('method', null);
      if (wrong) {
        if (kw['methods'] === undefined) {
          kw['methods'] = wrong;
        }
        console.warn(`<function %s.%s> defined with invalid routing parameter 'method', assuming 'methods'`, meta.module, propertyKey);
      }
    }

    const originalFunc = descriptor.value;
    const routeWrapper = async function (req, res, args) {
      args = Array.isArray(args) ? args : [args];
      let result = await originalFunc.call(this, req, res, ...args);
      if (isInstance(result, WebResponse) || originalFunc.routingType === 'json') {
        return result;
      }
      if (isInstance(result, Uint8Array) || typeof (result) === 'string') {
        return new WebResponse(req, res, result);
      }
      if (isInstance(result, HTTPException)) {
        result = (result as HTTPException).getResponse(res);
      }
      if (isInstance(result, BaseResponse)) {
        result = BaseResponse.forceType(WebResponse, result);
        WebResponse.prototype.setDefault.apply(result);
        return result;
      }

      console.warn(`function %s.%s returns an invalid response type (%s) for request url = '%s'`, meta.module, originalFunc.name, result?.constructor?.name, req.url);
      return result;
    };
    setattr(routeWrapper, 'name', originalFunc.name);
    setattr(routeWrapper, 'routing', routing, { enumerable: false });
    setattr(routeWrapper, 'originalFunc', originalFunc, { enumerable: false });
    descriptor.value = routeWrapper;
  };
  return decorator;
}

function getArguments(f) {
  const s = f.toString();
  let res;
  try {
    res = s.replace(/[\r\n\s]+/g, ' ')
      .match(/(?:(async\s*)?function\s*\w*)?\s*(?:\((.*?)\)|([^\s]+))/)
      .slice(2, 3)
      .join('')
      .split(/\s*,\s*/)
      .map(arg => {
        let [name, value] = arg.split('=');
        name = name.trim();
        let type = 'any';
        let tryInt = parseInt(value);
        if (!isNaN(tryInt)) {
          return [name, 'integer', tryInt];
        }
        let tryFloat = parseFloat(value);
        if (!isNaN(tryFloat)) {
          return [name, 'float', tryFloat];
        }
        if (/^{(.*?)}$/.test(value?.trim())) {
          return [name, 'object', value.trim()];
        }
        if (/['"`]/.test(value)) {
          return [name, 'string', value];
        }
        value = value
          ? value.trim() // JSON.parse(`${value.trim().replace(/(?:['`])([^@\."`][^"'`]*)(?:['`])/g, '"$1"')}`) // Tony must normalize json string
          : value;
        return [name, 'any', value];
      });
    return res;
  } catch (e) {
    console.log(`Can't get arguments of the function\n`, s.slice(0, 100));
    throw e;
  }
}

/**
 * Route decorator factory, creates decorator
 *
 * @param {string} httpMethod
 * @param {string} url
 * @param {Type[]} middleware
 */
function decoratorFactory(target, key, httpMethod = 'all', url, middleware = []) {
  const meta = getMeta(target);
  // init the routes dictionary
  const routes = meta.routes[key] = meta.routes[key] || {};
  const routeKey = `${httpMethod}.${url}`;
  if (routes[routeKey]) {
    // the combination of httpMethod and url is already registered for this method (fn)
    // let's not register a new route but concat its middlewares
    routes[routeKey].middleware = [...routes[routeKey].middleware, ...middleware];
  }
  else {
    // this is a new route for the method
    routes[routeKey] = {
      method: httpMethod,
      url,
      middleware,
    };
  }
}

function listDir(dir) {
  const listChild: string[] = [];
  const children = getDirectories(dir);
  for (const name of children) {
    listChild.push(path.join(dir, name));
  }
  return listChild;
}

let sessionGc = (sessionStore) => {
  if (Math.random() < 0.001) {
    // we keep session one week
    const lastWeek = DateTime.now().minus({ days: 7 }).toJSDate();
    for (const path of listDir(sessionStore.path)) {
      try {
        const mtimeMs = fs.statSync(path).mtimeMs;
        const lastMs = lastWeek.getMilliseconds();
        console.log(path, mtimeMs, lastMs);
        if (fs.statSync(path).mtimeMs < lastWeek.getMilliseconds()) {
          fs.unlinkSync(path);
        }
      } catch (e) {

      }
    };
  }
};

const VERP_DISABLE_SESSION_GC = str2bool(process.env['VERP_DISABLE_SESSION_GC'] || '0');

if (VERP_DISABLE_SESSION_GC) {
  sessionGc = (s) => null;
}

/**
 * All routes
 *
 * Special-cased "all" method, applying the given route `path`,
 * middleware, and callback to _every_ HTTP method.
 *
 * @param {string} url
 * @param {Type[]} [middleware]
 */
function all(url, middleware) {
  return (target, key) => {
    decoratorFactory(target, key, 'all', url);
  }
}

interface RouteDefinition {
  // Path to our route
  path: string;
  // HTTP Request method (get, post, ...)
  requestMethod: 'get' | 'post' | 'delete' | 'options' | 'put';
  // Method name within our class responsible for this route
  methodName: string;
};

//----------------------------------------------------------
// Controller and route registration
//----------------------------------------------------------
export const addonsManifest = {};
export const controllersPerModule = new DefaultDict(); //list

export class SessionExpiredException extends Error { }

export class AuthenticationError extends Error { }

export class VERPSession extends sessions.Session {
  httpRequest: BaseRequest;

  constructor(...args: any[]) {
    args = args || [];
    super(args.shift(), args.shift(), args.shift());
  }

  init(data) {
    this.inited = false;
    this.modified = false;
    this.rotate = false;
    super.init(data);
    this.inited = true;
    this._defaultValues();
    this.modified = false;
  }

  /**
   * Authenticate the current user with the given db, login and
    password. If successful, store the authentication parameters in the
    current session and request, unless multi-factor-authentication
    is activated. In that case, that last part will be done by
    `finalize`.
   * @param db 
   * @param login 
   * @param password 
   * @returns 
   */
  async authenticate(req: WebRequest, db: string, login?: any, password?: any) {
    const env = {
      interactive: true,
      baseLocation: rstrip(req.urlRoot, '/'),
      HTTP_HOST: req.uri.port,
    };
    const reg = await core.registry(db);
    const cr = reg.cursor();
    const uid = await (await Environment.new(cr, global.SUPERUSER_ID, {}, false, req)).items('res.users').authenticate(req, db, login, password, env);
    this.preUid = uid;

    this.rotate = true;
    this.db = db;
    this.login = login;
    // req.disableDb = false;

    const user = (await (await req.getEnv()).change({ user: uid })).items('res.users').browse(uid);
    if (! await user._mfaUrl()) {
      await this.finalize(req);
    }

    return uid;
  }

  logout(keepDb = false) {
    for (const k of Object.keys(this)) {
      if (!(keepDb && k === 'db') && k !== 'debug') {
        delete this[k];
      }
    }
    this._defaultValues();
    this.rotate = true;
  }

  /**
   * Finalizes a partial session, should be called on MFA validation to
    convert a partial / pre-session into a full-fledged "logged-in" one
   */
  async finalize(req: WebRequest) {
    this.rotate = true;
    req.uid = this.uid = this.pop('preUid');
    const user = (await req.getEnv(this.uid)).items('res.users').browse(this.uid);
    this.sessionToken = await user._computeSessionToken(this.sid);
    await this.getContext(req);
  }

  /**
   * Check the current authentication parameters to know if those are still
        valid. This method should be called at each request. If the
        authentication fails, a :exc:`SessionExpiredException` is raised.
   */
  async checkSecurity(req: WebRequest) {
    if (!this.db || !this.uid) {
      throw new SessionExpiredException("Session expired");
    }
    // We create our own environment instead of the request's one.
    // to avoid creating it without the uid since request.uid isn't set yet
    const env = await Environment.new(await req.getCr(), this.uid, this.context, false, req);
    // here we check if the session is still valid
    if (! await checkSession(this, env)) {
      throw new SessionExpiredException("Session expired");
    }
  }

  _defaultValues() {
    this.setdefault("db", null)
    this.setdefault("uid", null)
    this.setdefault("login", null)
    this.setdefault("sessionToken", null)
    this.setdefault("context", {})
    this.setdefault("debug", '')
  }

  /**
   * Re-initializes the current user's session context (based on his
    preferences) by calling res.users.getContext() with the old context.

   * @returns the new context
   */
  async getContext(req: WebRequest) {
    assert(this.uid, "The user needs to be logged-in to initialize his context");
    this.context = await (await req.getEnv()).items('res.users').contextGet() ?? {};
    this.context['uid'] = this.uid;
    this._fixLang(this.context);
    return this.context;
  }

  /**
   * VERP provides languages which may not make sense and/or may not
    be understood by the web client's libraries.

    Fix those here.

    @param dict context: context to fix
   * @param context 
   */
  _fixLang(context: {}) {
    let lang = context['lang'];

    // inane VERP locale
    if (lang === 'ar_AR') {
      lang = 'ar'
    }

    // lang to lang_REGION (datejs only handles lang_REGION, no bare langs)
    if (lang in LOCALE_ALIASES) {
      lang = LOCALE_ALIASES[lang];
    }

    context['lang'] = lang || 'en_US';
  }

  /**
   * This method store an action object in the session and returns an integer
    identifying that action. The method get_action() can be used to get
    back the action.

    @param action The action to save in the session.
    @returns A key identifying the saved action.
   */
  saveAction(action) {
    const savedActions = this.setdefault('savedActions', { "next": 1, "actions": {} });
    // we don't allow more than 10 stored actions
    if (len(savedActions["actions"]) >= 10) {
      delete savedActions["actions"][Math.min(...savedActions["actions"])];
    }
    const key = savedActions["next"];
    savedActions["actions"][key] = action;
    savedActions["next"] = key + 1;
    this.modified = true;
    return key;
  }

  /**
   * Gets back a previously saved action. This method can return None if the action
    was saved since too much time (this case should be handled in a smart way).

    @param key The key given by saveAction()
    @returns The saved action or None.
   */
  getAction(key: string) {
    const savedActions = this.get('savedActions', {});
    return savedActions.get("actions", {}).get(key);
  }

  async saveRequestData(req: WebRequest) {
    const _req = req.httpRequest;
    // NOTE we do not store files in the session itself to avoid loading them in memory.By storing them in the session store, we ensure every worker (even ones on other servers) can access them. It also allow stale files to be deleted by `session_gc`.
    /*
    for (const f of Object.values(req.files)) {
      const storename = format('werkzeug_%s_%s.file', this.sid, Buffer.from(uuid4()).toString('hex'))
      const _path = path.join(_root.sessionStore.path, storename);
      const fd = fileOpen(_path, "w").fd;
      // fileWrite(fd, f);
      // with open(path, 'w') as fp:
      // f.save(fp)
      fileClose(fd);
      files.add(f.name, [storename, f.filename, f.contentType]);
    }
    this['serializedRequestData'] = {
      'form': req.form,
      'files': files,
    }*/
    console.warn('Not Implemented');
  }

  @contextmanager()
  async* loadRequestData() {
    const data = this.pop('serializedRequestData', null);
    const files = [];
    try {
      if (bool(data)) {
        // regenerate files filenames with the current session store
        for (const [name, [storename, filename, contentType]] of Object.entries<any>(data['files'])) {
          const _path = path.join(_root.sessionStore.path, storename);
          files.push({ name, path, filename, contentType });
        }
        yield new CombinedMultiDict([data['form'], files]);
      }
      else {
        yield null;
      }
    }
    finally {
      // cleanup files
      for (const [f,] of Object.values(files)) {
        try {
          unlinkSync(f);
        } catch (e) {
          // pass
        }
      }
    }
  }
}

/**
 * Response object passed through controller route chain.

    In addition to the :class:`theveb.wrappers.Response` parameters, this
    class's constructor can take the following additional parameters
    for QWeb Lazy Rendering.

    @param template template to render
    @param qcontext Rendering context to use
    @param uid User id to use for the ir.ui.view render call,
                    ``null`` to use the request's user (the default)

    these attributes are available as parameters on the Response object and
    can be altered at any time before rendering

    Also exposes all the attributes and methods of
    class `theveb.wrappers.Response`.
 */
export class WebResponse extends BaseResponse {
  httpResponse: http.ServerResponse;
  httpRequest: WebRequest;

  constructor(req, res, content?: any, options: {
    status?: number,
    headers?: {},
    mimetype?: string,
    contentType?: string,
    directPassthrough?: boolean,
    template?: string,
    qcontext?: {}
  } = {}) {
    const template = pop(options, 'template', null);
    const qcontext = pop(options, 'qcontext', null);
    const uid = pop(options, 'uid', null);

    super(req, res, content, options);
    this.httpRequest = req;

    this.setDefault(template, qcontext, uid);

    return new Proxy(this, {
      apply(target, thisArg, args: any[] = []) {
        return target.__call__(args[0], args[1], args[2]);
      },
    });
  }

  setDefault(template?: any, qcontext?: any, uid?: any) {
    this.template = template;
    this.qcontext = qcontext ?? {};
    this.qcontext['responseTemplate'] = this.template;
    this.uid = uid;
    const request = this.httpRequest;
    // Support for Cross-Origin Resource Sharing
    if (request.endpoint && 'cors' in request.endpoint.routing) {
      this.setHeader('access-control-allow-origin', request.endpoint.routing['cors']);
      let methods = 'GET, POST';
      if (request.endpoint.routing['type'] === 'json') {
        methods = 'POST';
      }
      else if (request.endpoint.routing.get('methods')) {
        methods = request.endpoint.routing['methods'].join(', ');
      }
      this.setHeader('access-control-allow-methods', methods);
    }
  }

  get isQweb() {
    return this.template != null;
  }

  async render() {
    try {
      const request = this.httpRequest;
      let env: Environment = await request.getEnv();
      env = await env.change({ user: this.uid ?? request.uid ?? global.SUPERUSER_ID, req: request });
      return await env.items('ir.ui.view')._renderTemplate(this.template, this.qcontext);
    } catch (e) {
      throw e;
    }
  }

  async flatten() {
    if (this.template) {
      let content = await this.render();
      // content = beautify.html(content);
      content = await prettier.format(content, { parser: 'html' });
      this.contents.push(content);
      this.template = null;
    }
  }

  raiseForStatus() {
    let httpErrorMsg = '';
    let reason;
    if (isInstance(this.reason, Uint8Array)) {
      // We attempt to decode utf-8 first because some servers
      // choose to localize their reason strings. If the string
      // isn't utf-8, we fall back to iso-8859-1 for all other
      // encodings. (See PR #3538)
      try {
        reason = Buffer.from(this.reason).toString('utf-8');
      } catch (e) {
        reason = Buffer.from(this.reason).toString('binary');//'iso-8859-1')
      }
    }
    else {
      reason = this.reason;
    }
    if (400 <= this.statusCode && this.statusCode < 500) {
      httpErrorMsg = f('%s Client Error: %s for url: %s', this.statusCode, reason, this.url);
    }
    else if (500 <= this.statusCode && this.statusCode < 600) {
      httpErrorMsg = f('%s Server Error: %s for url: %s', this.statusCode, reason, this.url);
    }
    if (httpErrorMsg) {
      throw new HTTPException(null, httpErrorMsg);
    }
  }
}

function* _iterEncoded(iterable, charset) {
  for (const item of iterable) {
    if (typeof (item) === 'string')
      yield Buffer.from(item).toString(charset);
    else
      yield item;
  }
}

export class Endpoint {
  _controller: any;
  routing: FrozenDict<any>;
  cls: any;
  method: any;
  original: any;
  args: {};

  constructor(cls, method, routing) {
    this.cls = cls;
    this.method = method;
    this.original = getattr(method, 'originalFunc', method);
    this.routing = new FrozenDict(routing);
    this.args = {};
  }

  run(...args: any[]) {
    return this.method.apply(this.controller, args);
  }

  get firstArgIsReq() {
    return getattr(this.method, '_firstArgIsReq', false);
  }

  get controller() {
    if (this._controller == undefined) {
      this._controller = new this.cls();
    }
    return this._controller;
  }

  repr() {
    return f('<EndPoint method=%s routing=%s>', this.method, JSON.stringify(this.routing));
  }

  toString() {
    return this.repr();
  }
}

const regex = /((([a-zA-Z]+(-[a-zA-Z0-9]+){0,2})|\*)(;q=[0-1](\.[0-9]+)?)?)*/g;

export class WebRequest {
  private _context: Dict<any>;
  private _session: VERPSession;
  private _uid: number;
  private _env: Environment;
  private _failed: boolean;
  private _cr: Cursor;
  private _db: string;

  httpRequest: BaseRequest;
  endpoint: Endpoint;
  endpointArgs: {};
  authMethod: any;

  divTime = 10000;
  host: string;
  website: any;
  routingIteration: number;
  isFrontend: boolean;
  isFrontendMultilang: boolean;
  lang: any;

  constructor(req: BaseRequest) {
    this.httpRequest = req;
    this._db = this.session.db;
  }

  get context() {
    if (this._context == null) {
      this._context = new FrozenDict(this.session.context);
    }
    return this._context;
  }

  set context(val) {
    this._context = new FrozenDict(val);
    this._env = null;
  }

  get body() {
    return this.httpRequest.body;
  }

  get params() {
    return this.httpRequest.params;
  }

  set params(val: any) {
    this.httpRequest.params = Dict.from(val);
  }

  get uid() {
    return this._uid;
  }

  set uid(val) {
    this._uid = val;
    this._env = null;
  }

  get uri() {
    return this.httpRequest.uri;
  }

  get url() {
    return this.httpRequest.url;
  }

  /**
   * Like attr `url` but without the querystring
    See also attr `trustedHosts`.
   */
  // @cachedProperty
  get baseUrl() {
    return this.httpRequest.baseUrl;
  }

  get method() {
    return this.httpRequest.method;
  }

  get headers() {
    return this.httpRequest.headers;
  }

  get db(): string | null {
    if (!this._db) {
      this._db = this.session.db;
    }
    return this._db;
  }

  set db(db) {
    this._db = db;
  }

  get cookie() {
    return this.httpRequest.cookie;
  }

  get urlRoot() {
    return this.httpRequest.urlRoot;
  }

  get socket() {
    return this.httpRequest.socket;
  }

  get session() {
    this._session = this.httpRequest.session;
    return this._session;
  }

  set session(val: VERPSession) {
    this.httpRequest.session = val;
    this._session = val;
  }

  async getEnv(uid?: number, su?: boolean) {
    if (this._env == undefined) {
      const cr = await this.getCr();
      this._env = await core.api.Environment.new(cr, this.uid, this.context, su, this);
    }
    return this._env;
  }

  async getRegistry() {
    return core.registry(this.db);
  }

  async getCr() {
    if (!this.db) {
      throw new RuntimeError('request not bound to a database');
    }
    if (!this._cr) {
      const registry = await this.getRegistry();
      this._cr = registry.cursor();
    }
    return this._cr;
  }

  set cr(cr: Cursor) {
    this._cr = cr;
  }

  async __enter__() {
    _requestStack.push(this);
    return this;
  }

  async __exit__(errObj) {
    _requestStack.pop();
    const cr = this._cr;
    if (cr) {
      try {
        const registry = await this.getRegistry();
        if (errObj == null && !this._failed) {
          if (cr.objTransaction) {
            await cr.commit();
            await cr.reset();
          }
          if (registry) {
            await registry.signalChanges();
          }
        }
        else if (registry) {
          await registry.resetChanges();
        }
      }
      catch(e) {
        console.warn(e.message + (errObj ? `\nPrevious: ${errObj.message}` : ''));
      }
      finally {
        await cr.close();
      }
    }
    // just to be sure no one tries to re-use the request
    this._db = null;
    this.uid = null;
  }

  _isCorsPreflight(endpoint: any) {
    // console.log('Method not implemented.');
    return false;
  }

  async _callFunction(...args: any[]) {
    args = args ?? [];
    const _requestType = getattr(this, '_requestType', null);
    if (this.endpoint.routing['type'] !== _requestType) {
      const msg = f("%s, %s: Function declared as capable of handling request of type '%s' but called with a request of type '%s'", this.endpoint.original, this.httpRequest.pathname, this.endpoint.routing['type'], _requestType);
      console.info(msg);
      throw new BadRequest(msg);
    }

    if (bool(this.endpointArgs)) {
      let kwargs: {};
      if (isObject(args[args.length - 1])) {
        kwargs = args[args.length - 1];
      } else {
        args.push({});
      }
      update(kwargs, this.endpointArgs);
    }

    if (!isInstance(args[0], WebRequest)) { // this.endpoint.firstArgIsReq
      args.unshift(this);
    }

    let firstTime = true;

    const self = this;
    // Correct exception handling and concurrency retry
    // @service_model.check
    async function checkedCall(dbName, ...a) {
      // nonlocal firstTime
      // The decorator can call us more than once if there is an database error. In this case, the request cursor is unusable. Rollback transaction to create a new one.
      if (self._cr && (!firstTime)) {
        await self._cr.rollback();
        (await self.getEnv()).clear();
      }
      firstTime = false;
      const result = await self.endpoint.run(...a);
      if (isInstance(result, WebResponse) && result.isQweb) {
        // Early rendering of lazy responses to benefit from @service_model.check protection
        await result.flatten();
      }
      if (self._cr != null) {
        // flush here to avoid triggering a serialization error outside of this context, which would not retry the call
        await self._cr.flush();
      }
      return result;
    }

    if (this.db) {
      return checkedCall(this.db, ...args);
    }
    return this.endpoint.run(...args);
  }

  setHandler(endpoint, args: {} = {}, auth) {
    const _args = {}
    for (const [k, v] of Object.entries<any>(args)) {
      if (!k.startsWith("_ignored_")) {
        _args[k] = v;
      }
    }
    this.endpointArgs = _args;
    this.endpoint = endpoint;
    this.authMethod = auth;
  }

  async render(res, template, qcontext?: any, lazy = true, kw: {} = {}): Promise<WebResponse> {
    throw new Error("Method not implemented.");
  }

  async dispatch(res: http.ServerResponse): Promise<WebResponse> {
    throw new Error("Method not implemented.");
  }

  async _handleException(res, exception): Promise<any> {
    this._failed = exception;  // prevent tx commit
    if (!isInstance(exception, ...NO_POSTMORTEM) && !isInstance(exception, HTTPException)) {
      postMortem(config, []);
    }
    console.error('>>> Error to client:', exception.message, res.req.url ? '\n'+res.req.url : '');
    throw exception;
  }

  async redirect(res: ServerResponse, location: any, code: number = 303, local: boolean = true): Promise<WebResponse> {
    // compatibility, Werkzeug support URL as location
    let href: string = isInstance(location, URL) ? location.href : location;
    if (local) {
      href = isInstance(location, URL) ? location.pathname + location.search : location;
      href = '/' + (href.startsWith('/') ? href.slice(1) : href);
    }
    if (this.db) {
      return (await this.getEnv()).items('ir.http')._redirect(this, res, href, code);
    }
    return redirect(this, res, href, code, WebResponse);
  }

  async redirectQuery(res: http.ServerResponse, location, query?: any, code: number = 303, local: boolean = true): Promise<WebResponse> {
    if (query) {
      location += '?' + urlEncode(query);
    }
    return this.redirect(res, location, code, local);
  }

  /**
   * Generates and returns a CSRF token for the current session

    @param timeLimit the CSRF token validity period (in seconds), or
                        ``null`` for the token to be valid as long as the
                        current user session is (the default)
    @returns ASCII token string
   */
  async csrfToken(timeLimit?: number) {
    const token = this.session.sid;

    // if no `timeLimit` => distant 1y expiry (31536000) so maxTs acts as salt
    const maxTs = Math.round(new Date().getTime() / this.divTime + (timeLimit ?? 31536000));
    const msg = `${token}${maxTs}`;
    const secret = await (await (await this.getEnv()).items('ir.config.parameter').sudo()).getParam('database.secret');
    assert(secret, "CSRF protection requires a configured database secret")

    const hm = hash(Buffer.from(secret, 'ascii'), msg, 'sha1');

    const res = `${hm}o${maxTs}`;
    // console.log('csrf', token, res);
    return res;
  }

  async validateCsrf(csrf: any) {
    if (!csrf) {
      return false;
    }
    const [hm, o, maxTs] = rstringPart(String(csrf), 'o');
    if (maxTs) {
      try {
        const now = Math.round(new Date().getTime() / this.divTime);// + 31536000);
        if (parseInt(maxTs) < now) {
          return false;
        }
      } catch (e) {
        return false;
      }
    }
    const token = this.session.uid;
    const msg = `${token}${maxTs}`;
    const secret = await (await (await this.getEnv()).items('ir.config.parameter').sudo()).getParam('database.secret');
    assert(secret, 'CSRF protection requires a configured database secret');
    const hmExpected = hash(Buffer.from(secret, 'ascii'), msg, 'sha1');
    return consteq(hm, hmExpected);
  }

  makeResponse(res: http.ServerResponse, data: string | Buffer, headers?: string[][], cookies?: any): WebResponse {
    throw new NotImplementedError();
  }

  parse(al: string) {
    const strings = (al || "").match(regex);
    return strings.map(function (m) {
      if (!m) {
        return;
      }
      const bits = m.split(';');
      const ietf = bits[0].split('-');
      const hasScript = ietf.length === 3;

      return {
        code: ietf[0],
        script: hasScript ? ietf[1] : null,
        region: hasScript ? ietf[2] : ietf[1],
        quality: bits[1] ? parseFloat(bits[1].split('=')[1]) : 1.0
      };
    }).filter(function (r) {
      return r;
    }).sort(function (a, b) {
      return b.quality - a.quality;
    });
  }

  /*
  pick(supportedLanguages, acceptLanguage, options) {
    options = options || {};

    if (!supportedLanguages || !supportedLanguages.length || !acceptLanguage) {
      return null;
    }

    if (typeof acceptLanguage === 'string'){
      acceptLanguage = this.parse(acceptLanguage);
    }

    var supported = supportedLanguages.map(function(support){
      var bits = support.split('-');
      var hasScript = bits.length === 3;

      return {
        code: bits[0],
        script: hasScript ? bits[1] : null,
        region: hasScript ? bits[2] : bits[1]
      };
    });

    for (var i = 0; i < acceptLanguage.length; i++) {
      var lang = acceptLanguage[i];
      var langCode = lang.code.toLowerCase();
      var langRegion = lang.region ? lang.region.toLowerCase() : lang.region;
      var langScript = lang.script ? lang.script.toLowerCase() : lang.script;
      for (var j = 0; j < supported.length; j++) {
        var supportedCode = supported[j].code.toLowerCase();
        var supportedScript = supported[j].script ? supported[j].script.toLowerCase() : supported[j].script;
        var supportedRegion = supported[j].region ? supported[j].region.toLowerCase() : supported[j].region;
        if (langCode === supportedCode &&
          (options.loose || !langScript || langScript === supportedScript) &&
          (options.loose  || !langRegion || langRegion === supportedRegion)) {
            return supportedLanguages[j];
        }
      }
    }

    return null;
  }
  */
  get acceptLanguages() {
    return this.parse(this.httpRequest.headers['accept-language']);
  }

}

export class HttpRequest extends WebRequest {
  _requestType = "http";

  constructor(req: BaseRequest) {
    super(req);
    // from request body
    this.params.updateFrom(req.body);
    this.params.updateFrom(req.body['params']);
    this.params.pop('params', null);
    this.params.pop('session_id', null);
  }

  async _handleException(res, exception) {
    try {
      const result = await super._handleException(res, exception);
      return result;
    } catch (e) {
      if (isInstance(e, SessionExpiredException)) {
        if (!this.params['noredirect']) {
          const redirect = this.url;
          return this.redirect(res, f('/web/login?redirect=%s', redirect));
        }
      } else if (isInstance(e, HTTPException)) {
        return e;
      } else {
        throw e;
      }
    }
  }

  _isCorsPreflight(endpoint) {
    return this.httpRequest.method == 'OPTIONS' && endpoint && endpoint.routing.get('cors');
  }

  async dispatch(res: http.ServerResponse): Promise<WebResponse> {
    if (this._isCorsPreflight(this.endpoint)) {
      const headers = {
        'access-control-max-age': 60 * 60 * 24,
        'access-control-allow-headers': 'origin, x-requested-with, content-type, accept, authorization'
      }
      return new WebResponse(this, res, undefined, { status: 200, headers: headers })
    }

    if (!['GET', 'HEAD', 'OPTIONS', 'TRACE'].includes(this.httpRequest.method) && this.endpoint.routing.get('csrf', true)) {// csrf checked by default
      const token = this.params.pop('csrfToken'); //delete this.params['csrfToken'];
      if (! await this.validateCsrf(token)) {
        if (token != null)
          console.warn("CSRF validation failed on path '%s'", this.uri.pathname);
        else
          console.warn(`No CSRF validation token provided for path '%s'....`);
        throw new BadRequest(res, 'Session expired (invalid CSRF token)')
      }
    }
    let r: any = await this._callFunction(res, this.params); // convert to Dict/same {} for all enpoint
    if (!r) {
      r = new WebResponse(this, res, undefined, { status: 204 })  // no content
    }
    return r;
  }

  /**
   * Helper for non-HTML responses, or HTML responses with custom
    response headers or cookies.

    While handlers can just return the HTML markup of a page they want to
    send as a string if non-HTML data is returned they need to create a
    complete response object, or the returned data will not be correctly
    interpreted by the clients.

    @param data response body
    @param headers HTTP headers to set on the response ``[[name, value]]``
    @param cookies cookies to set on the client
   */
  makeResponse(res: http.ServerResponse, data: string | Buffer, headers: string[][] = [], cookies = {}) {
    const response = new WebResponse(this, res, data, { headers: headers });
    if (cookies) {
      for (const [k, v] of Object.entries(cookies)) {
        response.setCookie(k, v);
      }
    }
    return response;
  }

  async render(res: http.ServerResponse, template, qcontext?: any, lazy = true, kw: {} = {}): Promise<WebResponse> {
    const response = new WebResponse(this, res, null, { template: template, qcontext: qcontext, ...kw });
    // lazy = false; // Testing
    if (!lazy) {
      return response.render();
    }
    return response;
  }

  /**
   * Shortcut for a `HTTP 404
    <http://tools.ietf.org/html/rfc7231#section-6.5.4>`_ (Not Found)
    response
   * @param description 
   * @returns 
   */
  notFound(res: http.ServerResponse, description?: any) {
    return new NotFound(res, description);
  }
}

/**
 * Request handler for `JSON-RPC 2
    <http://www.jsonrpc.org/specification>`_ over HTTP

    * ``method`` is ignored
    * ``params`` must be a JSON object (not an array) and is passed as keyword
      arguments to the handler method
    * the handler method's result is returned as JSON-RPC ``result`` and
      wrapped in the `JSON-RPC Response
      <http://www.jsonrpc.org/specification#response_object>`_

    Successful request::

      --> {"jsonrpc": "2.0",
           "method": "call",
           "params": {"context": {},
                      "arg1": "val1" },
           "id": null}

      <-- {"jsonrpc": "2.0",
           "result": { "res1": "val1" },
           "id": null}

    Request producing a error::

      --> {"jsonrpc": "2.0",
           "method": "call",
           "params": {"context": {},
                      "arg1": "val1" },
           "id": null}

      <-- {"jsonrpc": "2.0",
           "error": {"code": 1,
                     "message": "End user error message.",
                     "data": {"code": "codestring",
                              "debug": "traceback" } },
           "id": null}
 */
export class JsonRequest extends WebRequest {
  _requestType = "json";
  _requestId: number;

  constructor(req: BaseRequest) {
    super(req);
    this._requestId = req.params.get('id');

    // regular jsonrpc2
    this.params = Dict.from<any>(this.body["params"]);
    this.context = this.params.pop('context', Dict.from(this.session.context));
  }

  _jsonResponse(res: http.ServerResponse, result?: any, error?: any) {
    const response = {
      'jsonrpc': '2.0',
      'id': this.httpRequest.body['id']
    }
    if (error != null) {
      response['error'] = error
    }
    if (result != null) {
      response['result'] = result
    }
    const mime = 'application/json'
    const body = stringify(response);

    let status = 200;
    if (error) {
      status = error['code'] || 200;
    }
    return new WebResponse(this, res,
      body, {
      status: status,
      headers: [
        ['Content-Type', mime],
      ]
    }
    );
  }

  /**
   * Called within an except block to allow converting exceptions
           to arbitrary responses. Anything returned (except None) will
           be used as response.
   * @param res 
   * @param exception 
   */
  async _handleException(res, exception): Promise<any> {
    try {
      const result = await super._handleException(res, exception);
      return result;
    }
    catch (e) {
      if (!isInstance(exception, SessionExpiredException)) {
        if (e.message && e.message == "bus.Bus not available in test mode") {
          console.info(e);
        }
        else if (isInstance(e, UserError, NotFound)) {
          console.warn(e);
        }
        else {
          console.info('ERR %s\n   ', this.httpRequest.url, e.stack);
        }
      }
      const error = {
        'code': 200,
        'message': "Verp Server Error",
        'data': serializeException(exception),
      }
      if (isInstance(exception, NotFound)) {
        error['httpStatus'] = 404;
        error['code'] = 404;
        error['message'] = "404: Not Found";
      }
      if (isInstance(exception, AuthenticationError)) {
        error['code'] = 100;
        error['message'] = "Verp Session Invalid";
      }
      if (isInstance(exception, SessionExpiredException)) {
        error['code'] = 100;
        error['message'] = "Verp Session Expired";
      }
      return this._jsonResponse(res, null, error);
    }
  }

  async dispatch(res: http.ServerResponse): Promise<WebResponse> {
    const result = await this._callFunction(res, this.params);
    return this._jsonResponse(res, result);
  }
}

export const STATIC_CACHE = 3600 * 24 * 7;
export const STATIC_CACHE_LONG = 3600 * 24 * 365;

class Root {
  _loaded: boolean;

  @lazy.define()
  get sessionStore() {
    // Setup http sessions
    const _path = core.tools.config.sessionDir;
    // console.debug('HTTP sessions stored in: %s', _path);
    if (VERP_DISABLE_SESSION_GC) {
      console.info('Default session GC disabled, manual GC required.');
    }
    return new sessions.FilesystemSessionStore(
      _path, { sessionClass: VERPSession, renewMissing: true }
    )
  }

  @lazy.define()
  async nodbRoutingMap(): Promise<Router> {
    const routingMap = await Router.new({ strictSlashes: false, converters: null });
    for await (const [url, endpoint, routing] of _generateRoutingRules(core.conf.serverWideModules, true)) {
      const rule = new Rule(url, { endpoint: endpoint, methods: routing['methods'] });
      rule.mergeSlashes = false;
      await routingMap.add(rule);
    }
    console.info("Generated nondb routing", routingMap._rules.length, "rules");
    return routingMap;
  }

  loadAddons() {
    const statics = {}
    const manifests = addonsManifest;
    for (const addonsPath of core.addons.paths) {
      for (const module of sorted(getDirectories(addonsPath))) {
        if (!(module in manifests)) {
          // Deal with the manifest first
          const manifest = readManifest(addonsPath, module);
          if (!manifest || (manifest['installable'] === false && !('assets' in manifest))) {
            continue;
          }
          manifest['addonsPath'] = addonsPath;
          manifests[module] = manifest;
          // Then deal with the statics
          const pathStatic = path.join(addonsPath, module, 'static');
          if (isDir(pathStatic)) {
            console.debug("Loading static %s", module);
            statics[`/${module}/static`] = pathStatic;
          }
        }
      }
    }
    if (len(statics)) {
      console.debug("HTTP Configuring static files");
    }
    let app = this.dispatch;
    const sharedMw = new SharedDataMiddleware(app.bind(this), statics, { cache: true, cacheTimeout: STATIC_CACHE });
    app = sharedMw.dispatch;
    setattr(this, 'dispatch', new DisableCacheMiddleware(app.bind(sharedMw)));
  }

  getRequest(httpRequest: BaseRequest): WebRequest {
    if (["application/json", "application/json-rpc"].includes(httpRequest.headers["content-type"])) {
      return new JsonRequest(httpRequest);
    }
    else {
      return new HttpRequest(httpRequest);
    }
  }

  /**
   * @param request 
   * @param res 
   * @param next 
   * @returns 
   */
  async dispatch(request: http.IncomingMessage, res: http.ServerResponse, next?: any) {
    const baseReq = BaseRequest.new(request);

    const explicitSession = this.setupSession(baseReq);
    await this.setupDb(baseReq);
    this.setupLang(baseReq);

    await baseReq.parseBody();
    // req is HttpRequest or JsonRequest based on 'content-type' in baseReq header
    const req = this.getRequest(baseReq);

    const self = this;
    async function _dispatchNodb(req: WebRequest, res): Promise<any> {
      let func, args;
      try {
        [func, args] = await (await self.nodbRoutingMap()).bindToEnviron(req).match(req);
      } catch (e) {
        if (isInstance(e, HTTPException)) {
          return req._handleException(res, e);
        }
        else {
          throw e;
        }
      }
      req.setHandler(func, args, "none");
      let result;
      try {
        result = await req.dispatch(res);
      } catch (e) {
        return req._handleException(res, e)
      }
      return result;
    }
    try {
      let requestManager = req;
      if (req.session.profileSession) {
        requestManager = this.getProfileContextManager(req);
      }
      let result, response;
      await doWith(requestManager, async () => {
        const db = req.session.db;
        if (db) {
          let irHttp;
          let error;
          try {
            await (await core.registry(db)).checkSignaling();
            // await doWith(new core.tools.MuteLogger('core.sql_db'), () => {
            const registry = await req.getRegistry();
            if (!registry.ready) {
              throw new Forbidden(res, 'The server is not ready so you cannot access it at this time. Please try again!');
            }
            irHttp = (await req.getEnv()).items('ir.http');
          } catch (e) {
            error = e;
            req.session.logout();
            if (isInstance(e, Error)) { // AttributeError, OperationalError, ProgrammingError
              const p = req.uri.pathname + req.uri.search;
              if (p === '/web') {
                throw e;
              } else {
                result = await _dispatchNodb(req, res);
              }
            }
            else {
              throw e;
            }
          }
          if (!error && irHttp) {
            result = await irHttp._dispatch(req, res);
          }
        }
        else {
          result = await _dispatchNodb(req, res);
        }
        response = await this.getResponse(req, res, result, explicitSession);
      });
      return response(req, response, next);
    } catch (e) {
      if (isInstance(e, HTTPException)) {
        return e(request, res, next);
      }
      const response = await this.getResponse(req, res, e.message, explicitSession);
      return response(req, response, next);
    }
  }

  setupSession(req: BaseRequest) {
    sessionGc(this.sessionStore);
    const args = req.uri.searchQuery ?? {};
    let sid = args['session_id'];
    let explicitSession = true;
    if (!sid) {
      sid = req.headers["x-verp-session-id"];
    }
    if (!sid) {
      const cookie = req.cookie;
      sid = cookie['session_id'];
      explicitSession = false;
    }
    if (sid == null) {
      req.session = this.sessionStore.new();
    }
    else {
      req.session = this.sessionStore.get(sid);
    }
    return explicitSession;
  }

  async setupDb(httpRequest: any) {
    let db = httpRequest.session.db
    // Check if session.db is legit
    if (db) {
      if (!dbFilter(httpRequest, [db]).includes(db)) {
        console.warn("Logged into database '%s', but dbfilter rejects it; logging session out.", db);
        httpRequest.session.logout();
        db = null;
      }
    }
    if (!db) {
      httpRequest.session.db = await dbMonodb(httpRequest);
    }
  }

  setupLang(req: BaseRequest) {
    if (!("lang" in req.session.context)) {
      const alang = req.acceptLanguages[0]?.code ?? "en-US";
      let lang;
      try {
        const [code, territory, x, y] = parseLocale(alang, '-');
        if (territory) {
          lang = `${code}_${territory}`;
        }
        else {
          lang = LOCALE_ALIASES[code];
        }
      } catch (e) {
        if (isInstance(e, ValueError, KeyError)) {
          lang = 'en_US';
        }
        else {
          throw e;
        }
      }
      req.session.context["lang"] = lang;
    }
  }

  getProfileContextManager(request: WebRequest) {
    console.warn("Method not implemented.");
    return request;
  }

  async getResponse(req: WebRequest, res: http.ServerResponse, result: any, explicitSession: any) {
    if (isInstance(result, WebResponse) && result.isQweb) {
      try {
        await result.flatten();
      } catch (e) {
        if (req.db) {
          result = await (await req.getEnv()).items('ir.http')._handleException(req, res, e);
        } else {
          throw e;
        }
      }
    }
    let response: WebResponse;
    if (isInstance(result, Uint8Array) || typeof (result) === 'string') {
      response = new WebResponse(req, res, result, { mimetype: 'text/html' });
    }
    else {//if (!isInstance(result, WebResponse)) {
      //   if (typeof (result) !== 'string') {
      //     result = stringify(result);
      //   }
      //   response = new WebResponse(req, res, result);
      // }
      // else {
      response = result;
      this.setCsp(response);
    }

    const saveSession = (!req.endpoint) || req.endpoint.routing.get('saveSession', true);
    if (!saveSession) {
      return response;
    }
    if (req.session.shouldSave) {
      if (req.session.rotate) {
        this.sessionStore.delete(req.session);
        req.session.sid = this.sessionStore.generateKey();
        if (req.session.uid) {
          req.session.sessionToken = await security.computeSessionToken(req.session, await req.getEnv());
        }
        req.session.modified = true;
      }
      this.sessionStore.save(req.session);
    }
    if (!explicitSession && isCallable(response.setCookie)) {
      response.setCookie(
        'session_id', req.session.sid, { maxAge: 90 * 24 * 60 * 60, httpOnly: true }
      );
    }

    return response;
  }

  setCsp(res) {
    // ignore HTTP errors
    if (!isInstance(res, WebResponse)) {
      return;
    }

    if (res.hasHeader('content-security-policy')) {
      return;
    }

    const [mime, _params] = parseHeader(res.getHeader('content-type') || '');
    if (!mime?.startsWith('image/')) {
      return;
    }

    res.setHeader('content-security-policy', "default-src 'none'");
  }

  async getDbRouter(req: WebRequest, db): Promise<Router> {
    if (!db) {
      return this.nodbRoutingMap();
    }
    return (await req.getEnv()).items('ir.http').routingMap(req);
  }
}

export const _root = new Root();

export function root(req?: any, res?: any, next?: any) {
  if (!_root._loaded) {
    _root._loaded = true;
    _root.loadAddons(); // load static addons
  }
  return _root.dispatch(req, res, next);
}

export function dbFilter(req, dbs: any[]) {
  let h = req.uri.hostname || '';
  let [d, x, r] = stringPart(h, '.');
  if (d === "www" && r) {
    d = stringPart(r, '.')[0];
  }
  if (core.tools.config.get('dbFilter')) {
    [d, h] = [escapeRegExp(d), escapeRegExp(h)];
    r = core.tools.config.options['dbFilter'].replace('%h', h).replace('%d', d);
    dbs = dbs.filter(i => i.match(r));
  }
  else if (core.tools.config.get('dbName')) {
    // In case --db-filter is not provided and --database is passed, Verp will
    // use the value of --database as a comma separated list of exposed databases.
    const exposedDbs = new Set(core.tools.config.get('dbName').split(',').map(db => db.trim()));
    dbs = sorted(_.intersection(Array.from(exposedDbs), dbs));
  }
  return dbs;
}

/**
 * Magic function to find the current database.
    Implementation details:
    * Magic
    * More magic
    Returns `null` if the magic is not magic enough.
 * @param req 
 */
export async function dbMonodb(req: any) {
  const dbs = await dbList(req, true);

  // try the db already in the session
  const dbSession = req.session.db;
  if (dbSession && dbs.includes(dbSession)) {
    return dbSession;
  }

  // if there is only one possible db, we take that one
  if (dbs.length == 1) {
    return dbs[0];
  }
  return null;
}

export async function dbList(req: any, force: boolean = false) {
  let dbs: string[];
  try {
    dbs = await core.service.db.MetaDatebase.listDbs(force);
  } catch (e) {
    // except psycopg2.OperationalError:
    return [];
  }
  return dbFilter(req, dbs);
}

export async function sendFile(req: WebRequest, res: http.ServerResponse, fp, options: { mimetype?: string | boolean, asAttachment?: boolean, filename?: string, mtime?: string, addEtags?: boolean, cacheTimeout?: number, conditional?: boolean } = {}) {
  setOptions(options, { mimetype: null, asAttachment: false, filename: null, mtime: null, addEtags: true, cacheTimeout: STATIC_CACHE, conditional: true });

  let file: FileDescriptor;
  let size: number;
  let mtime;

  if (typeof (fp) === 'string') {
    if (!options.filename) {
      options.filename = path.basename(fp);
    }
    file = fileOpen(fp, 'r');
    size = fs.statSync(fp).size;
    if (!options.mtime) {
      mtime = fs.statSync(fp).mtimeMs;
    }
  }
  else { // FileDescriptor
    file = fp;
    size = fs.statSync(file.name).size;
    if (!options.filename) {
      options.filename = path.basename(file.name) ?? null;
    }
  }

  let mimetype;
  if (options.mimetype == null && options.filename) {
    mimetype = guessType(options.filename);
  }
  if (mimetype === false) {
    mimetype = 'application/octet-stream';
  }

  const headers = new Headers();
  if (options.asAttachment) {
    if (options.filename == null) {
      throw new TypeError('filename unavailable, required for sending as attachment');
    }
    headers.add('content-disposition', 'attachment', { filename: options.filename });
    headers['content-length'] = size;
  }
  const data = wrapFile(res, file.fd);
  let rv = new WebResponse(req, res, data, { mimetype: mimetype, headers: headers, directPassthrough: true });

  if (typeof (mtime) === 'string') {
    try {
      const serverFormat = core.tools.DEFAULT_SERVER_DATETIME_FORMAT;
      mtime = DateTime.fromFormat(options.mtime.split('.')[0], serverFormat).toJSDate();
    } catch (e) {
      mtime = null;
    }
  } else {
    mtime = options.mtime;
  }
  if (mtime != null) {
    rv.lastModified = mtime;
  }
  rv.cacheControl.isPublic = true;
  if (options.cacheTimeout) {
    rv.cacheControl.maxAge = options.cacheTimeout;
    rv.expires = core.tools.parseInt(Date.now() + options.cacheTimeout);
  }
  if (options.addEtags && options.filename && mtime) {
    rv.setEtag(format('verp-%s-%s-%s', mtime, size, adler32(typeof (options.filename) === 'string' ? options.filename : options.filename) & 0xffffffff));
    if (options.conditional) {
      rv = rv.makeConditional(req.httpRequest);
      if (rv.statusCode == 304) {
        rv.httpResponse.removeHeader('x-sendfile');
      }
    }
  }

  return rv;
}

function* _parseparam(s: string) {
  while (s.slice(0, 1) === ';') {
    s = s.substring(1);
    let end = s.indexOf(';');
    while (end > 0 && ((s.slice(end).match(/"/g) || []).length
      - (s.slice(end).match(/\\"/g) || []).length) % 2) {
      end = s.indexOf(';', end + 1);
    }
    if (end < 0) {
      end = s.length;
    }
    const f = s.slice(0, end);
    yield f.trim();
    s = s.slice(end);
  }
}

/**
 * Parse a Content-type like header.
  Return the main content-type and a dictionary of options.
 * @param line 
 * @returns 
 */
export function parseHeader(line): [string, {}] {
  const parts = _parseparam(';' + line);
  const key = parts.next().value as string;
  const pdict = {}
  for (const p of parts) {
    const i = p.indexOf('=');
    if (i >= 0) {
      const name = p.slice(0, i).trim().toLowerCase();
      let value = p.slice(i + 1).trim();
      if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') {
        value = value.slice(1, -1);
        value = value.replace('\\\\', '\\').replace('\\"', '"')
      }
      pdict[name] = value;
    }
  }
  return [key, pdict];
}

class DisableCacheMiddleware extends Function {
  app: any;

  constructor(app) {
    super();
    this.app = app;

    return new Proxy(this, {
      apply(target, thisArg, args: any[] = []) {
        return target.__call__(args[0], args[1], args[2]);
      },
    });
  }

  __call__(request: http.IncomingMessage, response: http.ServerResponse, next?: any) {
    function startWrapped(code, status, headers) {
      const baseReq = BaseRequest.new(request);
      _root.setupSession(baseReq);

      const req = new HttpRequest(baseReq);
      if (req.session && req.session.debug && !req.headers['user-agent'].includes('htmltoPdf')) {
        let newCacheControl;
        if (req.session.debug.includes("assets") && (req.httpRequest.url.includes('.js') || req.httpRequest.url.includes(".css"))) {
          newCacheControl = 'no-store';
        }
        else {
          newCacheControl = 'no-cache';
        }

        let cacheControlValue = newCacheControl;
        const newHeaders = [];
        for (const [k, v] of headers) {
          if (k.toLowerCase() !== 'cache-control') {
            newHeaders.push([k, v]);
          }
          else if (!(v.includes(newCacheControl))) {
            cacheControlValue += `, ${v}`;
          }
        }

        newHeaders.push(['cache-control', cacheControlValue]);
        response.writeHead(code, status, newHeaders);
      }
      else {
        response.writeHead(code, status, headers);
      }
    }
    return this.app(request, response, startWrapped);
  }
}


/*
 * @param modules 
 * @param nodbOnly 
 * @param converters 
 */
export function* _generateRoutingRules(modules: string[], nodbOnly: boolean, converters?: any): Generator<[string, Endpoint, {}]> {
  function getSubclasses(klass) {
    function valid(cls) {
      const modulename = getModule(cls._module);
      return modulename.startsWith('core.addons.') && modules.includes(modulename.split(".")[2]);
    }
    let result = [];
    for (const subclass of klass['_subclasses']) {
      if (valid(subclass)) {
        extend(result, getSubclasses(subclass));
      }
    }
    if (!result.length && valid(klass)) {
      result = [klass];
    }
    return result;
  }

  const controllers = controllersOnModule;
  for (const modul of modules) {  // Travel modules loaded
    if (!(modul in controllers)) {// they have controllers 
      continue;
    }

    for (const [conName, controller] of controllers[modul]) { // Travel all controllers of the module
      const subclasses = unique(getSubclasses(controller));
      const methods = {};
      for (const cls of subclasses) {
        const members = getmembers(cls, 'prototype', isCallable);
        for (const [name, method, cl] of members) {
          methods[name] = [name, method, cl];
        }
      }
      for (const [methodName, method, cl] of Object.values<any>(methods)) {
        if (hasattr(method, 'routing')) {
          const routing = { type: 'http', auth: 'user', method: null, routes: null }
          const doneMethods = [];
          const _mro = mro(cl);
          for (let i = _mro.length - 1; i >= 0; i--) {
            const claz = _mro[i];
            const fn = getattr(claz.prototype, methodName, null);
            if (fn && hasattr(fn, 'routing') && !(doneMethods.includes(fn))) {
              doneMethods.push(fn);
              Object.assign(routing, fn.routing);
            }
          }
          if (!nodbOnly || routing['auth'] === 'none') {
            assert(routing['routes'], `Method ${cl.name}.${methodName} has not route defined`);
            const endpoint = new Endpoint(cl, method, routing);
            for (const url of routing['routes']) {
              yield [url, endpoint, routing];
            }
          }
        }
      }
    }
  }
}

export function contentDisposition(filename) {
  filename = ustr(filename);
  const escaped = urlQuote(filename, { safe: '', unsafe: '()<>@,;:"/[]?={}\\*\'%' });  // RFC6266

  return f("attachment; filename*=UTF-8''%s", escaped);
}

/**
 * Return new headers based on `headers` but with `Content-Length` and
  `Content-Type` set appropriately depending on the given `content` only if it
  is safe to do, as well as `X-Content-Type-Options: nosniff` so that if the
  file is of an unsafe type, it is not interpreted as that type if the
  `Content-type` header was already set to a different mimetype
 * @param headers 
 * @param content 
 * @returns 
 */
export function setSafeImageHeaders(headers, content) {
  headers = new Headers(headers);
  const safeTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/x-icon'];
  const contentType = guessMimetype(content);
  if (safeTypes.includes(contentType)) {
    headers['content-type'] = contentType;
  }
  headers['x-content-type-options'] = 'nosniff';
  headers['content-length'] = content.length;
  return Array.from<any[]>(headers);
}

function adler32(arg: string): any {
  console.warn("Function not implemented.");
  return arg;
}
