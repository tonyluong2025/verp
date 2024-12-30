import assert from "assert";
import path from "path";
import URLJS from 'url-js';
import { format as f } from "util";
import { Dict, FrozenDict, MultiDict } from "../../helper";
import { RuntimeError } from "../../helper/errors";
import { WebRequest } from "../../http";
import { bool, doWithSync, len, lstrip, sorted, update } from "../../tools";
import { isInstance } from "../../tools/func";
import { iter } from "../../tools/iterable";
import { _encodeIdna } from "./idna";
import * as converter from './converter';
import { BadHost, BuildError, MethodNotAllowed, NotFound, RequestAliasRedirect, RequestRedirect, RequestSlash } from "./exceptions";
import { Rule } from "./rule";
import { _fastUrlQuote, toUnicode, urlEncode } from "./utils";
import { getHost } from "./wsgi";

const DEFAULT_CONVERTERS = {
  "default": converter.UnicodeConverter,
  "string": converter.UnicodeConverter,
  "any": converter.AnyConverter,
  "path": converter.PathConverter,
  "int": converter.IntegerConverter,
  "float": converter.FloatConverter,
  "uuid": converter.UUIDConverter,
}

const _simpleRuleRe = /<([^>]+)>/;

interface RouteOptions {
  rules?: [],
  defaultSubdomain?: string,
  charset?: string,
  strictSlashes?: boolean,
  redirectDefaults?: boolean,
  converters?: {},
  sortParameters?: boolean,
  sortKey?: string,
  encodingErrors?: string,
  hostMatching?: boolean,
}

/**
 * The map class stores all the URL rules and some configuration
    parameters.  Some of the configuration values are only stored on the
    `Map` instance since those affect all rules, others are just defaults
    and can be overridden for each rule.  Note that you have to specify all
    arguments besides the `rules` as keyword arguments!
 */
export class Router {
  _rules: Rule[];
  _rulesByEndpoint: Map<any, Rule[]>;
  _remap: boolean;
  _remapLock: null;
  charset: string;
  strictSlashes: boolean;
  encodingErrors: string;
  redirectDefaults: boolean;
  hostMatching: boolean;
  converters: {};
  sortParameters: boolean;
  sortKey: string;
  defaultSubdomain: string;
  defaultConverters = new FrozenDict<any>(DEFAULT_CONVERTERS);
  maxPartLength: number;
  maxPartCount: number;
  maxArgWeight: number;
  maxArgCount: number;
  maxArgSize: number;
  maxDefaultSize: number;

  private constructor() {
  }

  /**
   * 
    @param rules sequence of url rules for this map.
    @param defaultSubdomain The default subdomain for rules without a
                              subdomain defined.
    @param strictSlashes If a rule ends with a slash but the matched
        URL does not, redirect to the URL with a trailing slash.
    @param mergeSlashes: Merge consecutive slashes when matching or
        building URLs. Matches will redirect to the normalized URL.
        Slashes in variable parts are not merged.
    @param redirectDefaults This will redirect to the default rule if it
                              wasn't visited that way. This helps creating
                              unique URLs.
    @param converters A dict of converters that adds additional converters
                       to the list of converters. If you redefine one
                       converter this will override the original one.
    @param sortParameters If set to `true` the url parameters are sorted.
                            See `urlEncode` for more details.
    @param sortKey The sort key function for `urlEncode`.
    @param hostMatching if set to `true` it enables the host matching
                          feature and disables the subdomain one.  If
                          enabled the `host` parameter to rules is used
                          instead of the `subdomain` one.
   * @returns 
   */
  static async new(options: RouteOptions = {}) {
    const self = new Router();
    for (const [k, v] of Object.entries<any>({
      rules: [],
      defaultSubdomain: "",
      charset: "utf-8",
      strictSlashes: true,
      redirectDefaults: true,
      sortParameters: false,
      encodingErrors: "replace",
      hostMatching: false,
    })) {
      if (options[k] === undefined) {
        options[k] = v;
      }
    }

    self._rules = [];
    self._rulesByEndpoint = new Map();
    self._remap = true;

    self.defaultSubdomain = options.defaultSubdomain;
    self.charset = options.charset;
    self.encodingErrors = options.encodingErrors;
    self.strictSlashes = options.strictSlashes;
    self.redirectDefaults = options.redirectDefaults;
    self.hostMatching = options.hostMatching;

    self.converters = Object.assign({}, self.defaultConverters);
    if (options.converters) {
      Object.assign(self.converters, options.converters);
    }

    self.sortParameters = options.sortParameters;
    self.sortKey = options.sortKey;

    for (const rulefactory of options.rules || []) {
      await self.add(rulefactory);
    }
    self.maxPartLength = 0;
    self.maxPartCount = 0;
    self.maxArgWeight = 0;
    self.maxArgCount = 0;
    self.maxArgSize = 0;
    self.maxDefaultSize = 0;

    return self;
  }

  /**
   * Iterate over all rules and check if the endpoint expects
          the arguments provided.  This is for example useful if you have
          some URLs that expect a language code and others that do not and
          you want to wrap the builder a bit so that the current language
          code is automatically added if not provided but endpoints expect
          it.
   * @param endpoint the endpoint to check
   * @param args this function accepts one or more arguments
                            as positional arguments.  Each one of them is
                            checked.
   * @returns 
   */
  isEndpointExpecting(endpoint, ...args) {
    this.update();
    for (const rule of this._rulesByEndpoint.get(endpoint)) {
      if (args.every(val => rule.args.has(val))) {
        return true;
      }
    }
    return false;
  }

  iterRules(endpoint?: any) {
    this.update();
    if (endpoint != null) {
      return iter(this._rulesByEndpoint.get(endpoint));
    }
    return iter(this._rules);
  }

  async add(rulefactory: Rule) {
    for (const rule of rulefactory.getRules(this)) {
      await rule.bindToRouter(this);
      this._rules.push(rule);
      if (!this._rulesByEndpoint.has(rule.endpoint)) {
        this._rulesByEndpoint.set(rule.endpoint, []);
      }
      this._rulesByEndpoint.get(rule.endpoint).push(rule);
    }
    this._remap = true;
  }

  bindToRoute(options: {
    serverName?: string,
    scriptName?: string,
    subdomain?: string,
    urlScheme?: string,
    defaultMethod?: string,
    pathInfo?: string,
    queryArgs?: any,
  } = {}) {
    options.serverName = (options.serverName || '').toLowerCase();
    if (this.hostMatching) {
      if (options.subdomain != null) {
        throw new RuntimeError("host matching enabled and a subdomain was provided");
      }
    } else if (options.subdomain == null) {
      options.subdomain = this.defaultSubdomain;
    }
    if (options.scriptName == null) {
      options.scriptName = '/';
    }
    if (options.pathInfo == null) {
      options.pathInfo = '/';
    }
    for (const [k, v] of Object.entries<any>({ urlScheme: "http", defaultMethod: "GET" })) {
      if (options[k] === undefined) {
        options[k] = v;
      }
    }
    try {
      options.serverName = _encodeIdna(options.serverName);
    } catch (e) {
      throw new BadHost();
    }
    return new MapAdapter(this, options);
  }

  bindToEnviron(req: WebRequest, serverName?: string, subdomain?: string) {
    const wsgiServerName = getHost(req.httpRequest).toLowerCase();

    if (serverName == null) {
      serverName = wsgiServerName;
    }
    else {
      serverName = serverName.toLowerCase();
    }

    if (subdomain == null && !this.hostMatching) {
      const curServerName = wsgiServerName.split('.');
      const realServerName = serverName.split('.');
      const offset = - realServerName.length;
      if (curServerName.slice(offset).some((e, i) => e !== realServerName[i])) {
        subdomain = '<invalid>';
      }
      else {
        subdomain = curServerName.slice(0, offset).filter(e => !!e).join('.');
      }
    }
    return this.bindToRoute({
      serverName: serverName,
      subdomain: subdomain,
      urlScheme: req.uri.protocol,
      defaultMethod: req.httpRequest.method,
      pathInfo: req.uri.pathname,
      queryArgs: req.uri.searchQuery,
    });
  }

  update() {
    if (!this._remap) {
      return;
    }

    doWithSync(this._remapLock, () => {
      if (!this._remap) {
        return;
      }
      this._rules = sorted(this._rules, (x: Rule) => x.matchCompareKey());
      for (let [k, rules] of this._rulesByEndpoint) {
        this._rulesByEndpoint.set(k, sorted(rules, (x: Rule) => x.buildCompareKey()));
      }
      this._remap = false;
    });
  }
}

class MapAdapter {
  router: Router;
  serverName: string;
  scriptName: string;
  subdomain: string;
  urlScheme: string;
  pathInfo: string;
  defaultMethod: string;
  queryArgs: string;

  constructor(router: Router, options: {
    serverName?: string,
    scriptName?: string,
    subdomain?: string,
    urlScheme?: string,
    defaultMethod?: string,
    pathInfo?: string,
    queryArgs?: string,
  } = {}) {
    this.router = router
    this.serverName = toUnicode(options.serverName);
    let scriptName = toUnicode(options.scriptName);
    if (!scriptName?.endsWith("/")) {
      scriptName = (scriptName || '') + "/";
    }
    this.scriptName = scriptName;
    this.subdomain = toUnicode(options.subdomain);
    this.urlScheme = toUnicode(options.urlScheme);
    this.pathInfo = toUnicode(options.pathInfo);
    this.defaultMethod = toUnicode(options.defaultMethod);
    this.queryArgs = options.queryArgs;
  }

  encodeQueryArgs(queryArgs) {
    if (typeof (queryArgs) !== 'string') {
      queryArgs = urlEncode(queryArgs, this.router.charset);
    }
    return queryArgs;
  }

  /**
   * Figures out the full host name for the given domain part.  The
    domain part is a subdomain in case host matching is disabled or
    a full host name.
   * @param domainPart 
   * @returns 
   */
  getHost(domainPart) {
    if (this.router.hostMatching) {
      if (!domainPart) {
        return this.serverName;
      }
      return toUnicode(domainPart, "ascii");
    }
    let subdomain = domainPart;
    if (!subdomain) {
      subdomain = this.subdomain;
    }
    else {
      subdomain = toUnicode(subdomain, "ascii");
    }
    return (subdomain + subdomain ? "." : "") + this.serverName;
  }

  makeRedirectUrl(pathInfo, queryArgs?: any, domainPart?: any) {
    let suffix = "";
    if (queryArgs) {
      suffix = "?" + this.encodeQueryArgs(queryArgs);
    }
    while (this.scriptName.startsWith('/')) {
      this.scriptName = this.scriptName.slice(1);
    }
    while (pathInfo.startsWith('/')) {
      pathInfo = pathInfo.slice(1);
    }
    return f(
      "%s://%s/%s%s",
      this.urlScheme ?? "http",
      this.getHost(domainPart),
      path.join(this.scriptName.slice(0, -1), pathInfo),
      suffix
    );
  }

  /**
   * Internally called to make an alias redirect URL.
   * @param path 
   * @param endpoint 
   * @param values 
   * @param method 
   * @param queryArgs 
   */
  async makeAliasRedirectUrl(path, endpoint, values, method, queryArgs) {
    let url = await this.build(endpoint, values, method, true, false);
    if (queryArgs) {
      url += "?" + this.encodeQueryArgs(queryArgs);
    }
    assert(url !== path, "detected invalid alias setting. No canonical URL found");
    return url;
  }

  async match(req, pathInfo?: string, options: { method?: string, returnRule?: boolean, queryArgs?: any } = {}): Promise<[Rule | any, {}]> {
    this.router.update();
    if (pathInfo == null) {
      pathInfo = this.pathInfo;
    }
    else {
      pathInfo = toUnicode(pathInfo, this.router.charset);
    }

    const queryArgs = (options.queryArgs != null) ? options.queryArgs : this.queryArgs;
    const method = (options.method ?? this.defaultMethod).toUpperCase();

    const path = f(`%s|%s`,
      (this.router.hostMatching && this.serverName || this.subdomain) || '',
      (pathInfo && f("/%s", lstrip(pathInfo, "/"))) || '',
    )

    const haveMatchFor = new Set<string>();
    for (const rule of this.router._rules) {
      let rv: {};
      try {
        rv = await rule.match(req, path, method);
        if (rv != null) update(req.params, rv || {});
      } catch (e) {
        if (isInstance(e, RequestSlash)) {
          throw new RequestRedirect(
            this.makeRedirectUrl(_fastUrlQuote(pathInfo, { charset: this.router.charset, safe: "/:|+" }) + "/", queryArgs)
          );
        }
        if (isInstance(e, RequestAliasRedirect)) {
          throw new RequestRedirect(
            await this.makeAliasRedirectUrl(path, rule.endpoint, e.matchedValues, method, queryArgs)
          )
        }
        else {
          throw e;
        }
      }
      if (rv == null) {
        continue;
      }
      if (rule.methods != null && !rule.methods.has(method)) {
        rule.methods.forEach(e => haveMatchFor.add(e));
        continue;
      }

      let redirectUrl;
      if (this.router.redirectDefaults) {
        redirectUrl = await this.getDefaultRedirect(rule, method, rv, queryArgs);
        if (redirectUrl) {
          throw new RequestRedirect(redirectUrl);
        }
      }

      if (rule.redirectTo) {
        if (typeof (rule.redirectTo) == 'string') {
          async function replacer(match, ...args: any[]) {
            const value = rv[match.group(1)];
            return rule.converters[match.group(1)].toUrl(value);
          }

          const promises = [];
          rule.redirectTo.replace(_simpleRuleRe, (match, ...args: any[]) => {
            const promise = replacer(args[0], args[1]);
            promises.push(promise);
            return match;
          });
          const data = await Promise.all(promises);
          redirectUrl = rule.redirectTo.replace(_simpleRuleRe, () => data.shift());
        }
        else {
          redirectUrl = await rule.redirectTo(this, rv);
        }
        throw new RequestRedirect(
          String(
            URLJS(
              f("%s://%s%s%s",
                this.urlScheme ?? "http",
                this.subdomain ? this.subdomain + "." : "",
                this.serverName,
                this.scriptName,
              ),
              redirectUrl,
            )
          )
        )
      }
      if (options.returnRule) {
        return [rule, rv];
      } else {
        return [rule.endpoint, rv];
      }
    }
    if (haveMatchFor.size) {
      throw new MethodNotAllowed(Array.from(haveMatchFor), `The method "${method}" is not allowed for the requested URL. Allowed: ${haveMatchFor}`);
    }
    throw new NotFound();
  }

  async getDefaultRedirect(rule: any, method: any, values: any, queryArgs: any): Promise<any> {
    assert(this.router.redirectDefaults);
    for (const r of this.router._rulesByEndpoint.get(rule.endpoint)) {
      // every rule that comes after this one, including ourself
      // has a lower priority for the defaults.  We order the ones
      // with the highest priority up for building.
      if (r === rule) {
        break;
      }
      if (r.providesDefaultsFor(rule) && r.suitableFor(values, method)) {
        Object.assign(values, r.defaults);
        const [domainPart, path] = await r.build(values);
        return this.makeRedirectUrl(path, queryArgs, domainPart);
      }
    }
  }

  /**
   * Building URLs works pretty much the other way round.  Instead of
    `match` you call `build` and pass it the endpoint and a dict of
    arguments for the placeholders.

    The `build` function also accepts an argument called `force_external`
    which, if you set it to `true` will force external URLs. Per default
    external URLs (include the server name) will only be used if the
    target URL is on a different subdomain.

    >>> m = new Router([
    ...     new Rule('/', {endpoint: 'index'}),
    ...     new Rule('/downloads/', {endpoint: 'downloads/index'}),
    ...     new Rule('/downloads/<int:id>', {endpoint: 'downloads/show'})
    ... ]);
    >>> urls = m.bindToRoute("example.com", "/");
    >>> await urls.build("index", {})
    '/'
    >>> await urls.build("downloads/show", {'id': 42})
    '/downloads/42'
    >>> await urls.build("downloads/show", {'id': 42}, null, true);
    'http://example.com/downloads/42'

    Because URLs cannot contain non ASCII data you will always get
    bytestrings back.  Non ASCII characters are urlencoded with the
    charset defined on the map instance.

    Additional values are converted to unicode and appended to the URL as
    URL querystring parameters:

    >>> await urls.build("index", {'q': 'My Searchstring'})
    => '/?q=My+Searchstring'

    When processing those additional values, lists are furthermore
    interpreted as multiple values (class MultiDict`):

    >>> await urls.build("index", {'q': ['a', 'b', 'c']})
    => '/?q=a&q=b&q=c'

    Passing a ``MultiDict`` will also add multiple values:

    >>> await urls.build("index", MultiDict((('p', 'z'), ('q', 'a'), ('q', 'b'))))
    => '/?p=z&q=a&q=b'

    If a rule does not exist when building a `BuildError` exception is raised.

    The build method accepts an argument called `method` which allows you to specify the method you want to have an URL built for if you have different methods for the same endpoint specified.

    @param endpoint the endpoint of the URL to build.
    @param values the values for the URL to build.  Unhandled values are appended to the URL as query parameters.
    @param method the HTTP method for the rule if there are different URLs for different methods on the same endpoint.
    @param forceExternal enforce full canonical external URLs. If the URL scheme is not provided, this will generate a protocol-relative URL.
    @param appendUnknown unknown parameters are appended to the generated URL as query string argument.  Disable this if you want the builder to ignore those.
   */
  async build(
    endpoint,
    values?: any,
    method?: any,
    forceExternal?: any,
    appendUnknown = true,
  ) {
    this.router.update();

    if (bool(values)) {
      if (values instanceof MultiDict) {
        const tempValues = new Dict();
        for (let [key, value] of values.entries()) {
          if (!value) {
            continue;
          }
          if (len(value) == 1) { // flatten single item lists
            value = value[0];
            if (value == null) { // drop None
              continue;
            }
          }
          tempValues[key] = value;
        }
        values = tempValues;
      }
      else {
        // drop null
        values = Dict.from(Object.entries<any>(values).filter(i => i[1] != null));
      }
    }
    else {
      values = new Dict();
    }

    const rv = await this._partialBuild(endpoint, values, method, appendUnknown);
    if (rv == null) {
      throw new BuildError(endpoint, values, method, self);
    }

    let [domainPart, path] = rv;

    const host = this.getHost(domainPart);

    // shortcut this.
    if (!forceExternal && (
      (this.router.hostMatching && host === this.serverName)
      || (!this.router.hostMatching && domainPart === this.subdomain)
    )) {
      while (this.scriptName.endsWith('/')) {
        this.scriptName = this.scriptName.slice(0, -1);
      }
      while (path.startsWith('/')) {
        path = path.slice(1);
      }
      return f("%s/%s", this.scriptName, path);
    }

    while (path.startsWith('/')) {
      path = path.slice(1);
    }
    return f(
      "%s//%s%s/%s",
      this.urlScheme ? this.urlScheme + ":" : "",
      host,
      this.scriptName.slice(0, -1),
      path,
    );
  }

  /**
   * Helper for :meth:`build`.  Returns subdomain and path for the rule that accepts this endpoint, values and method.
   * @param endpoint 
   * @param values 
   * @param method 
   * @param appendUnknown 
   * @returns 
   */
  async _partialBuild(endpoint: any, values: any, method?: string, appendUnknown?: boolean): Promise<[string, string, boolean] | null> {
    // in case the method is none, try with the default method first
    if (method == null) {
      const rv = await this._partialBuild(
        endpoint, values, this.defaultMethod, appendUnknown
      )
      if (rv != null) {
        return rv;
      }
    }

    // Default method did not match or a specific method is passed.
    // Check all for first match with matching host. If no matching
    // host is found, go with first result.
    let firstMatch;

    for (const rule of this.router._rulesByEndpoint.get(endpoint) || []) {
      if (rule.suitableFor(values, method)) {
        const buildRv = await rule.build(values, appendUnknown);

        if (buildRv != null) {
          const rv: [string, string, boolean] = [buildRv[0], buildRv[1], rule.websocket];
          if (this.router.hostMatching) {
            if (rv[0] === this.serverName) {
              return rv;
            }
            else if (firstMatch == null) {
              firstMatch = rv;
            }
          }
          else {
            return rv;
          }
        }
      }
    }
    return firstMatch;
  }
}
