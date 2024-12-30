import fs from "fs/promises";
import http from 'http';
import _ from 'lodash';
import path from 'node:path';
import { format } from 'node:util';
import { api, conf, modules, service, tools } from "../../..";
import { Environment } from '../../../api';
import { getattr, setattr } from '../../../api/func';
import { Dict } from '../../../helper/collections';
import { AccessDenied, AccessError, MissingError, ValueError } from "../../../helper/errors";
import { ALLOWED_DEBUG_MODES, STATIC_CACHE_LONG, SessionExpiredException, WebRequest, WebResponse, _generateRoutingRules } from "../../../http";
import { AbstractModel, BaseModel, MetaModel } from "../../../models";
import { getModulePath, getResourcePath } from '../../../modules/modules';
import { BaseConverter, Forbidden, HTTPException, NotFound, NumberConverter, Router, Rule } from '../../../service/middleware';
import { BaseResponse } from '../../../service/middleware/base_response';
import { urlQuote } from '../../../service/middleware/utils';
import { UpCamelCase, b64decode, b64encode, bool, consteq, filePath, isInstance, md5, setOptions, sha512, sorted, str2bool, toText, ustr } from "../../../tools";
import { getExtension, guessExtension, guessMimetype, guessType } from '../../../tools/mimetypes';

export class RequestUID extends Dict<any> {
  constructor(options = {}) {
    super(options);
  }
}

export class ModelConverter extends BaseConverter {
  model: string;

  constructor(urlMap, model?: string) {
    super(urlMap);
    this.model = model
    this.regex = /([0-9]+)/;
  }

  async toPrimary(req: WebRequest, value) {
    const uid = new RequestUID({ value: value, converter: this });
    const env = await api.Environment.new(await req.getCr(), uid, req.context, false, req);
    return env.items(this.model).browse(tools.parseInt(value));
  }

  async toUrl(value) {
    return value.id;
  }
}

class ModelsConverter extends BaseConverter {
  model: string;

  constructor(urlMap, model?: string) {
    super(urlMap);
    this.model = model
    // TODO add support for slug in the form [A-Za-z0-9-] bla-bla-89 -> id 89
    this.regex = /([0-9,]+)/;
  }

  async toPrimary(req, value) {
    const uid = new RequestUID({ value: value, converter: this });
    const env = await api.Environment.new(await req.getCr(), uid, req.context, false, req);
    return env.items(this.model).browse(value.split(',').map(v => tools.parseInt(v)));
  }

  async toUrl(value) {
    return value.ids.join(',');
  }
}

class SignedIntConverter extends NumberConverter {
  regex = /-?\d+/;
  numConvert = Number
}

@MetaModel.define()
class IrHttp extends AbstractModel {
  static _module = module;
  static _name = 'ir.http';
  static _description = "HTTP Routing";

  _getRoutingMap() {
    return getattr(this.cls, '__routingMap', null);
  }

  _setRoutingMap(value) {
    setattr(this.cls, '__routingMap', value);
  }

  _clearRoutingMap() {
    if (this._getRoutingMap()) {
      this._setRoutingMap(new Map());
      console.debug("Clear routing map");
    }
  }

  get _rewriteLen() {
    return getattr(this.cls, '__rewriteLen', null);
  }

  set _rewriteLen(value) {
    setattr(this.cls, '__rewriteLen', value);
  }

  _getConverters() {
    return { 'model': ModelConverter, 'models': ModelsConverter, 'int': SignedIntConverter }
  }

  _generateRoutingRules(req, modules: any[], converters: any) {
    return _generateRoutingRules(modules, false, converters);
  }

  async _match(req, pathInfo, key?: any) {
    const route = await this.routingMap(req);
    const adapter = route.bindToEnviron(req);
    return adapter.match(req, pathInfo, { returnRule: true });
  }

  async _authMethodUser(req) {
    req.uid = req.session.uid;
    if (!req.uid)
      throw new SessionExpiredException("Session expired");
  }

  async _authMethodNone(req) {
    req.uid = null;
  }

  async _authMethodPublic(req) {
    if (!req.session.uid) {
      req.uid = (await (await req.getEnv()).ref('base.publicUser')).id;
    }
    else {
      req.uid = req.session.uid;
    }
  }

  async _authenticate(req: WebRequest, endpoint) {
    let authMethod = endpoint.routing["auth"];
    if (req._isCorsPreflight(endpoint)) {
      authMethod = 'none';
    }
    try {
      if (req.session.uid) {
        try {
          await req.session.checkSecurity(req);
          // what if error in security.check()
          //   -> resUsers.check()
          //   -> resUsers._checkCredentials()
        } catch (e) {
          if (isInstance(e, AccessDenied, SessionExpiredException)) {
            // All other exceptions mean undetermined status (e.g. connection pool full),
            // let them bubble up
            req.session.logout(true);
          }
          else {
            throw e;
          }
        }
      }
      if (req.uid == null) {
        await this[`_authMethod${UpCamelCase(authMethod)}`](req);
      }
    } catch (e) {
      if (isInstance(e, AccessDenied, SessionExpiredException, HTTPException)) {
        throw e;
      }
      else {
        console.info("Exception during request Authentication.", e)
        throw new AccessDenied();
      }
    }
    return authMethod;
  }

  async _handleDebug(request: WebRequest) {
    if ('debug' in request.uri.searchQuery) {
      let debugMode: any = [];
      for (let debug of (request.uri.searchQuery['debug'] || '').split(',')) {
        if (!ALLOWED_DEBUG_MODES.includes(debug)) {
          debug = str2bool(debug, debug) ? '1' : '';
        }
        debugMode.push(debug);
      }
      debugMode = debugMode.join(',');

      // Write on session only when needed
      if (debugMode != request.session.debug) {
        request.session.debug = debugMode;
      }
    }
  }

  async routingMap(req: WebRequest, key: any = null): Promise<Router> {
    if (!this._getRoutingMap()) {
      this._setRoutingMap(new Map<any, any>());
      this._rewriteLen = {};
    }
    const routingMap: Map<any, any> = this._getRoutingMap();
    if (!routingMap.has(key)) {
      console.info('Generating routing map for key "%s"', key);
      const installed = _.union(Array.from((await req.getRegistry())._initModules), conf.serverWideModules);
      if (tools.config.get('testEnable') && modules.currentTest) {
        installed.push(modules.currentTest);
      }
      const mods = sorted(installed);
      // Note : when routing map is generated, we put it on the class `cls`
      // to make it available for all instance. Since `env` create an new instance
      // of the model, each instance will regenared its own routing map and thus
      // regenerate its EndPoint. The routing map should be static.
      const route = await Router.new({ strictSlashes: false, converters: this._getConverters() });
      for await (const [url, endpoint, routing] of this._generateRoutingRules(req, mods, this._getConverters())) {
        const xtraKeys = 'defaults subdomain buildOnly strictSlashes redirectTo alias host'.split(' ');
        const kw = {}
        for (const k of xtraKeys) {
          if (k in routing) {
            kw[k] = routing[k];
          }
        }
        const rule = new Rule(url, { endpoint: endpoint, methods: routing['methods'], ...kw });
        rule.mergeSlashes = false;
        await route.add(rule);
      }
      routingMap.set(key, route);
    }
    const res = routingMap.get(key);
    return res;
  }

  async _serveAttachment(req: WebRequest, res) {
    const env = await api.Environment.new(await req.getCr(), global.SUPERUSER_ID, req.context, false, req);
    const attach = await env.items('ir.attachment').getServeAttachment(req.url, null, ['label', 'checksum']);
    if (attach.length) {
      const wdate = attach[0]['__lastUpdate'],
      datas = attach[0]['datas'] || '',
      label = attach[0]['label'],
      checksum = attach[0]['checksum'] || sha512(datas).slice(0, 64);  // sha512/256

      if (!datas && label !== req.url && ['http://', 'https://', '/'].some(l => label.startsWith(l))) {
        return req.redirect(res, label, 301, false);
      }

      const response = new WebResponse(req, res, b64decode(datas), { mimetype: attach[0]['mimetype'] ?? 'application/octet-stream' });
      response.lastModified = wdate;

      response.setEtag(checksum);
      response.makeConditional(req.httpRequest);

      if (response.statusCode == 304) {
        return response;
      }

      // response.mimetype = attach[0]['mimetype'] or 'application/octet-stream'
      // response.data = base64.b64decode(datas)
      return response;
    }
  }

  async _serveFallback(req, res, exception) {
    const attach = await this._serveAttachment(req, res);
    if (attach) {
      return attach;
    }
    return false;
  }

  async _handleException(req, res, exception) {
    await this._handleDebug(req);

    if ((isInstance(exception, HTTPException) && exception.code == 404) ||
      (isInstance(exception, AccessError))) {
      const serve = await this._serveFallback(req, res, exception);
      if (serve)
        return serve
    }

    if (tools.config.options['devMode']?.includes('theveb')
      && !isInstance(exception, NotFound)
      && req._requestType !== 'json')
      throw exception;

    try {
      const result = await req._handleException(res, exception);
      return result;
    } catch (e) {
      if (isInstance(exception, AccessDenied)) {
        return new Forbidden(res);
      }
      else {
        throw e;
      }
    }
  }

  async _dispatch(req: WebRequest, res: http.ServerResponse) {
    await this._handleDebug(req);

    // locate the controller method
    let func, rule, args;
    try {
      [rule, args] = await this._match(req, req.uri.pathname);
      func = rule.endpoint;
    } catch (e) {
      if (isInstance(e, NotFound)) {
        return this._handleException(req, res, e);
      } else {
        console.error(`${req.url}: ${e}`); // maybe: TypeError, SyntaxError
      }
    }
    if (!func) {
      return this._handleException(req, res, `Not found rule for '${req.url}'`);
    }
    // check authentication level
    let authMethod;
    try {
      authMethod = await this._authenticate(req, func);
    } catch (e) {
      return this._handleException(req, res, e);
    }

    await this._postprocessArgs(req, res, args, rule);

    // set and execute handler
    let result;
    try {
      req.setHandler(func, args, authMethod);
      result = await req.dispatch(res);
      if (isInstance(result, Error)) {
        throw result;
      }
    } catch (e) {
      return this._handleException(req, res, e);
    }
    return result;
  }

  async _redirect(req, res, location, code: number = 303) {
    return service.utils.redirect(req, res, location, code = code, WebResponse);
  }

  async _postprocessArgs(req, res, args: {} = {}, rule?: any) {
    for (const [key, val] of Object.entries<any>(args)) {
      // Replace uid placeholder by the current request.uid
      if (isInstance(val, BaseModel) && isInstance(val._uid, RequestUID)) {
        args[key] = await val.withUser(req.uid);
      }
    }
  }

  /*------------------------------------------------------
  * Binary server
  * ------------------------------------------------------*/

  async _xmlidToObj(req, env: Environment, xmlid) {
    return env.ref(xmlid, false);
  }

  async _binaryIrAttachmentRedirectContent(record, defaultMimetype = 'application/octet-stream') {
    // mainly used for theme images attachemnts
    let status, content, filename, filehash;
    let mimetype = await record['mimetype'] ?? false;
    const [type, url] = await record(['type', 'url']);
    if (type === 'url' && url) {
      // if url in in the form /somehint server locally
      const urlMatch = /^\/(\w+)\/(.+)$/.exec(url);
      if (urlMatch) {
        const module = urlMatch[1];
        let modulePath = getModulePath(module);
        let moduleResourcePath = getResourcePath(module, urlMatch[2]);

        if (modulePath && moduleResourcePath) {
          modulePath = path.join(path.normalize(modulePath), '')  // join ensures the path ends with '/'
          moduleResourcePath = path.normalize(moduleResourcePath);
          if (moduleResourcePath.startsWith(modulePath)) {
            const buffer = await fs.readFile(filePath(moduleResourcePath));
            content = b64encode(buffer);
            status = 200;
            filename = path.basename(moduleResourcePath);
            mimetype = guessMimetype(buffer, defaultMimetype);
            filehash = `${md5(toText(content))}`;
          }
        }
      }
      if (!content) {
        status = 301;
        content = record.url;
      }
    }
    return [status, content, filename, mimetype, filehash]
  }

  async _getRecordAndCheck(req, options?: { xmlid?: string, model?: string, id?: number, field?: string, accessToken?: string }): Promise<[any, number]> {
    options = options ?? {};
    const field = options.field ?? 'datas';

    // get object and content
    let record = null;
    if (options.xmlid) {
      record = await this._xmlidToObj(req, this.env, options.xmlid);
    }
    else if (options.id && options.model in this.env.models) {
      record = this.env.items(options.model).browse(tools.parseInt(options.id));
    }

    // obj exists
    if (!bool(record) || !(field in record._fields)) {
      return [null, 404];
    }

    try {
      if (options.model === 'ir.attachment') {
        const optionsAccessToken = options.accessToken;
        const recordSudo = await record.sudo();
        const [accessToken, isPublic] = await recordSudo(['accessToken', 'isPublic']);
        if (optionsAccessToken && !consteq(accessToken || '', optionsAccessToken)) {
          return [null, 403];
        }
        else if (optionsAccessToken && consteq(accessToken || '', optionsAccessToken)) {
          record = recordSudo;
        }
        else if (isPublic) {
          record = recordSudo;
        }
        else if (await (await this.env.user()).hasGroup('base.groupPortal')) {
          // Check the read access on the record linked to the attachment
          // eg: Allow to download an attachment on a task from /my/task/taskId
          await record.check('read');
          record = recordSudo;
        }
      }
      // check read access
      try {
        // We have prefetched some fields of record, among which the field 'updatedAt' used by '__lastUpdate' below. In order to check access on record, we have to invalidate its cache first.
        if (!record.env.su) {
          record._cache.clear();
        }
        await record['__lastUpdate'];
      } catch (e) {
        if (isInstance(e, AccessError)) {
          return [null, 403];
        } else {
          throw e;
        }
      }
      return [record, 200];
    } catch (e) {
      if (isInstance(e, MissingError, ValueError)) {
        return [null, 404];
      } else {
        throw e;
      }
    }
  }

  async _binaryRecordContent(record, field = 'datas', filename?: any, filenameField = 'label', defaultMimetype = 'application/octet-stream') {
    const model = record._name;
    let mimetype = 'mimetype' in record._fields && await record['mimetype'] || false;
    let checksum = 'checksum' in record._fields && await record['checksum'] || false;
    let content = null;

    const fieldDef = record._fields[field];
    if (fieldDef.type === 'binary' && fieldDef.attachment && !fieldDef.related) {
      if (model !== 'ir.attachment') {
        const fieldAttachment = await (await this.env.items('ir.attachment').sudo()).searchRead([['resModel', '=', model], ['resId', '=', record.id], ['resField', '=', field]], ['datas', 'mimetype', 'checksum'], { limit: 1 });
        if (fieldAttachment.ok) {
          mimetype = await fieldAttachment['mimetype'];
          content = await fieldAttachment['datas'];
          checksum = await fieldAttachment['checksum'];
        }
      }
      else {
        mimetype = await record['mimetype'];
        content = await record['datas'];
        checksum = await record['checksum'];
      }
    }
    if (!content) {
      try {
        content = await record[field] || '';
      } catch (e) {
        if (isInstance(e, AccessError)) {
          // `record[field]` may not be readable for current user -> 404
          content = '';
        }
        else {
          throw e;
        }
      }
    }
    // filename
    if (!filename) {
      const _filenameField = await record[filenameField];
      if (_filenameField) {
        filename = _filenameField;
      }
      if (!filename) {
        filename = format("%s-%s-%s", record._name, record.id, field);
      }
    }
    if (!mimetype) {
      let decodedContent;
      try {
        decodedContent = b64decode(content);
      } catch (e) {
        // except base64.binascii.Error:  # if we could not decode it, no need to pass it down: it would crash elsewhere...
        return [404, [], null];
      }
      mimetype = guessMimetype(decodedContent, defaultMimetype);
    }
    // extension
    const hasExtension = getExtension(filename) || guessType(filename);
    if (!hasExtension) {
      const extension = guessExtension(mimetype);
      if (extension) {
        filename = format(`%s.%s`, filename, extension);
      }
    }
    if (!checksum) {
      checksum = `${md5(toText(content))}`;
    }

    const status = content.length ? 200 : 404;
    return [status, content, filename, mimetype, checksum];
  }

  async _binarySetHeaders(req: WebRequest, status, content, filename, mimetype, unique, filehash?: any, download = false): Promise<[number, any[][], string]> {
    const headers = [['content-type', mimetype || ''], ['x-content-type-options', 'nosniff'], ['content-security-policy', "default-src 'none'"]]
    // cache
    const etag = req && req.httpRequest.headers['if-none-match'];
    status = status ?? 200;
    if (filehash) {
      headers.push(['etag', filehash]);
      if (etag === filehash && status == 200) {
        status = 304
      }
    }
    headers.push(['cache-control', format('max-age=%s', unique ? STATIC_CACHE_LONG : 0)]);
    // content-disposition default name
    if (download) {
      headers.push(['content-disposition', contentDisposition(filename)]);
    }

    return [status, headers, content]
  }

  /**
   * Get file, attachment or downloadable content

        If the ``xmlid`` and ``id`` parameter is omitted, fetches the default value for the
        binary field (via ``defaultGet``), otherwise fetches the field for
        that precise record.

    @param req
    @param res
    @param xmlid xmlid of the record
    @param model name of the model to fetch the binary from
    @param id id of the record from which to fetch the binary
    @param field binary field
    @param unique add a max-age for the cache control
    @param filename choose a filename
    @param filenameField if not create an filename with model-id-field
    @param download apply headers to download the file
    @param mimetype mintype of the field (for headers)
    @param defaultMimetype default mintype if no mintype found
    @param accessToken optional token for unauthenticated access
                              only available  for ir.attachment
    @returns: [status, headers, content]
   */
  async binaryContent(req, options: { xmlid?: string, model?: string, id?: number, field?: string, unique?: boolean, filename?: string, filenameField?: string, download?: boolean, mimetype?: string, defaultMimetype?: string, accessToken?: string, defaultFilename?: string } = {}) {
    setOptions(options, { model: 'ir.attachment', field: 'datas', filenameField: 'label', defaultMimetype: 'application/octet-stream' });

    let [record, status] = await this._getRecordAndCheck(req, options) ?? [];
    if (!bool(record)) {
      return [status || 404, [], null];
    }

    status = null;
    let content, headers, filehash;
    if (record._name === 'ir.attachment') {
      [status, content, options.defaultFilename, options.mimetype, filehash] = await this._binaryIrAttachmentRedirectContent(record, options.defaultMimetype);
      options.filename = options.filename ?? options.defaultFilename;
    }
    if (!content) {
      [status, content, options.filename, options.mimetype, filehash] = await this._binaryRecordContent(
        record, options.field, options.filename, options.filenameField, 'application/octet-stream');
    }

    [status, headers, content] = await this._binarySetHeaders(
      req, status, content, options.filename, options.mimetype, options.unique, filehash, options.download);

    return [status, headers ?? [], content];
  }

  async _responseByStatus(req, res, status, headers, content) {
    if (status == 304) {
      return new BaseResponse(req, res, null, { status: status, headers: headers });
    }
    else if (status == 301) {
      return req.redirect(res, content, 301, false);
    }
    else if (status != 200) {
      return req.notFound(res, req.url);
    }
  }
}

function contentDisposition(filename: any): any {
  filename = ustr(filename);
  const escaped = urlQuote(filename, { safe: '' });

  return `attachment; filename*=UTF-8''${escaped}`;
}

