import ast from 'abstract-syntax-tree';
import assert from "assert";
import _ from "lodash";
import { format as f } from "util";
import { Dict } from "../../helper/collections";
import { LookupError, RuntimeError, ValidationError, ValueError } from "../../helper/errors";
import { BaseModel } from '../../models';
import { _f, extend, len } from "../../tools";
import { escapeRegExp, isInstance } from "../../tools/func";
import { safeEval } from "../../tools/save_eval";
import { AST } from './ast';
import { BaseConverter } from './converter';
import { RequestAliasRedirect, RequestSlash } from "./exceptions";
import { Router } from './router';
import { urlEncode, urlQuote } from "./utils";

/**
 * ast parse and prefix names with '$$' to avoid collision with user vars, return tree.body[0]
 * @param src 
 * @returns 
 */
function _prefixNames(src, prefix = '') {
  let tree: any = ast.parse(src);
  if (tree.type === 'ExpressionStatement') {
    tree = tree.expression;
  }
  ast.walk(tree, (node) => {
    if (node.type === 'Identifier') {
      ast.replace(tree, (n) => {
        if (n === node) {
          n['name'] = prefix + n['name'];
        }
        return n;
      })
    }
  });
  return tree;
}

const _CALL_CONVERTER_CODE_FMT = "await self.converters['{elem}'].toUrl()";
const _IF_KWARGS_URL_ENCODE_CODE = `
if (defaults) {
  values = Object.assign({}, values);
  for (const k of Object.keys(values)) {
    if (k in defaults) {
      values[k] = values[k] ?? defaults[k];
    }
  }
}
let q, params;
if (values.params) {
  q = '?';
  params = self._encodeQueryVars(values.params);
}
else {
  q = '';
  params = '';
}`;
const _IF_KWARGS_URL_ENCODE_AST = _prefixNames(_IF_KWARGS_URL_ENCODE_CODE);
const _URL_ENCODE_AST_NAMES = [AST.Identifier("q"), AST.Identifier("params")];

interface RuleFactory {
  getRules(route);
}

type Weighting = [
  numberStaticWeights: number,
  staticWeights: [number, number][],
  numberArgumentWeights: number,
  argumentWeights: number[]
]

type RulePart = {
  content: string,
  final: boolean,
  static: boolean,
  suffixed: boolean,
  weight: Weighting
}

/**
 * A Rule represents one URL pattern.  There are some options for `Rule`
    that change the way it behaves and are passed to the `Rule` constructor.
    Note that besides the rule-string all arguments *must* be keyword arguments
    in order to not break the application on Werkzeug upgrades.

    `string`
        Rule strings basically are just normal URL paths with placeholders in
        the format ``<converter(arguments):name>`` where the converter and the
        arguments are optional.  If no converter is defined the `default`
        converter is used which means `string` in the normal configuration.

        URL rules that end with a slash are branch URLs, others are leaves.
        If you have `strict_slashes` enabled (which is the default), all
        branch URLs that are matched without a trailing slash will trigger a
        redirect to the same URL with the missing slash appended.

        The converters are defined on the `Map`.

    `endpoint`
        The endpoint for this rule. This can be anything. A reference to a
        function, a string, a number etc.  The preferred way is using a string
        because the endpoint is used for URL generation.

    `defaults`
        An optional dict with defaults for other rules with the same endpoint.
        This is a bit tricky but useful if you want to have unique URLs::

            urlMap = new Router([
                new Rule('/all/', {defaults: {'page': 1}, endpoint: 'allEntries'}),
                new Rule('/all/page/<int:page>', {endpoint: 'allEntries'})
            ])

        If a user now visits ``http://example.com/all/page/1`` he will be
        redirected to ``http://example.com/all/``.  If `redirect_defaults` is
        disabled on the `Map` instance this will only affect the URL
        generation.

    `subdomain`
        The subdomain rule string for this rule. If not specified the rule
        only matches for the `default_subdomain` of the map.  If the map is
        not bound to a subdomain this feature is disabled.

        Can be useful if you want to have user profiles on different subdomains
        and all subdomains are forwarded to your application::

            urlMap = new Router([
                new Rule('/', {subdomain: '<username>', endpoint: 'user/homepage'}),
                new Rule('/stats', {subdomain: '<username>', endpoint: 'user/stats'})
            ])

    `methods`
        A sequence of http methods this rule applies to.  If not specified, all
        methods are allowed. For example this can be useful if you want different
        endpoints for `POST` and `GET`.  If methods are defined and the path
        matches but the method matched against is not in this list or in the
        list of another rule for that path the error raised is of the type
        `MethodNotAllowed` rather than `NotFound`.  If `GET` is present in the
        list of methods and `HEAD` is not, `HEAD` is added automatically.

        `HEAD` is now automatically added to the methods if `GET` is
        present.  The reason for this is that existing code often did not
        work properly in servers not rewriting `HEAD` to `GET`
        automatically and it was not documented how `HEAD` should be
        treated.  This was considered a bug in Werkzeug because of that.

    `strictSlashes`
        Override the `Map` setting for `strict_slashes` only for this rule. If
        not specified the `Map` setting is used.

    `buildOnly`
        Set this to True and the rule will never match but will create a URL
        that can be build. This is useful if you have resources on a subdomain
        or folder that are not handled by the WSGI application (like static data)

    `redirectTo`
        If given this must be either a string or callable.  In case of a
        callable it's called with the url adapter that triggered the match and
        the values of the URL as keyword arguments and has to return the target
        for the redirect, otherwise it has to be a string with placeholders in
        rule syntax::

            function fooWithSlug(adapter, id) {
                // ask the database for the slug for the old id.  this of
                // course has nothing to do with theveb.
                return 'foo/' + Foo.getSlugForId(id);
            }
            let urlMap = new Router([
                new Rule('/foo/<slug>', {endpoint: 'foo'}),
                new Rule('/some/old/url/<slug>', {redirectTo: 'foo/<slug>'}),
                new Rule('/other/old/url/<int:id>', {redirectTo: fooWithSlug})
            ])

        When the rule is matched the routing system will raise a
        `RequestRedirect` exception with the target for the redirect.

        Keep in mind that the URL will be joined against the URL root of the
        script so don't use a leading slash on the target URL unless you
        really mean root of that domain.

    `alias`
        If enabled this rule serves as an alias for another rule with the same
        endpoint and arguments.

    `host`
        If provided and the URL map has host matching enabled this can be
        used to provide a match rule for the whole host.  This also means
        that the subdomain feature is disabled.
 */
export class Rule implements RuleFactory {
  rule: string;
  isLeaf: boolean;
  router: Router;
  strictSlashes: boolean;
  mergeSlashes: boolean;
  subdomain: string;
  host: string;
  websocket: boolean;
  defaults: Record<string, any>;
  buildOnly: boolean;
  alias: boolean;
  methods: Set<string>;
  endpoint: any;
  redirectTo: string | Function;
  args: Set<string>;
  converters: Record<string, BaseConverter>;

  private _trace: [boolean, string][];
  private _parts: RulePart[];
  private _regex: RegExp;
  private _argWeights: any[];
  private _staticWeights: any[];
  private _build: Function;
  private _buildUnknown: Function;

  constructor(rule: string, options: {
    defaults?: Record<string, any>,
    subdomain?: string,
    methods?: Iterable<string>,
    buildOnly?: boolean,
    endpoint?: any,
    strictSlashes?: boolean,
    redirectTo?: string | Function,
    alias?: boolean,
    host?: string,
    websocket?: boolean
  } = {}) {
    if (!rule.startsWith("/")) {
      throw new ValueError("urls must start with a leading slash");
    }
    this.rule = rule;
    this.isLeaf = !rule.endsWith("/");
    this.strictSlashes = options.strictSlashes;
    this.subdomain = options.subdomain;
    this.host = options.host;
    this.defaults = options.defaults;
    this.buildOnly = options.buildOnly;
    this.alias = options.alias;
    this.websocket = options.websocket;
    if (options.methods == null) {
      this.methods = null;
    }
    else {
      if (typeof (options.methods) === 'string') {
        throw new TypeError("param 'methods' should be 'Iterable[str]', not 'str'");
      }
      this.methods = new Set([...options.methods].map(x => x.toUpperCase()));
      if (!this.methods.has("HEAD") && this.methods.has("GET")) {
        this.methods.add("HEAD");
      }
    }
    this.endpoint = options.endpoint;
    this.redirectTo = options.redirectTo;

    if (options.defaults) {
      this.args = new Set(Object.keys(options.defaults));
    }
    else {
      this.args = new Set<string>();
    }
    this.converters = {};
    this._trace = [];
    this._parts = [];
  }

  /**
   * Return an unbound copy of this rule.

        This can be useful if want to reuse an already bound URL for another
        map.  See ``getEmptyOptions`` to override what keyword arguments are
        provided to the new copy.
   * @returns 
   */
  empty() {
    return new Rule(this.rule, this.getEmptyOptions());
  }

  /**
   * Provides kwargs for instantiating empty copy with empty()

        Use this method to provide custom keyword arguments to the subclass of
        ``Rule`` when calling ``someRule.empty()``.  Helpful when the subclass
        has custom keyword arguments that are needed at instantiation.

        Must return a ``dict`` that will be provided as kwargs to the new
        instance of ``Rule``, following the initial ``this.rule`` value which
        is always provided as the first, required positional argument.
   * @returns 
   */
  getEmptyOptions(): {} {
    let defaults;
    if (this.defaults) {
      defaults = Object.assign({}, this.defaults);
    }
    return Object.assign({}, {
      defaults: defaults,
      subdomain: this.subdomain,
      methods: this.methods,
      buildOnly: this.buildOnly,
      endpoint: this.endpoint,
      strictSlashes: this.strictSlashes,
      redirectTo: this.redirectTo,
      alias: this.alias,
      host: this.host,
    });
  }

  *getRules(router: any) {
    yield this;
  }

  /**
   * Rebinds and refreshes the URL.  Call this if you modified the
        rule in place.
   */
  async refresh() {
    await this.bindToRouter(this.router, true);
  }

  /**
   * Bind the url to a router and create a regular expression based on
        the information from the rule itself and the defaults from the map.
   * @param route 
   * @param rebind 
   */
  async bindToRouter(router: Router, rebind = false) {
    if (this.router != null && !rebind) {
      throw new RuntimeError("url rule %s already bound to map %s", this, this.router);
    }
    this.router = router;

    if (this.strictSlashes == null) {
      this.strictSlashes = router.strictSlashes;
    }
    if (this.subdomain == null) {
      this.subdomain = router.defaultSubdomain;
    }
    await this.compile();
  }

  /**
   * Looks up the converter for the given parameter.
   * @param variableName 
   * @param converterName 
   * @param args 
   * @param kw 
   * @returns 
   */
  getConverter(variableName, converterName, args: [] = [], kw: {}) {
    if (!(converterName in this.router.converters)) {
      throw new LookupError("the converter %s does not exist", converterName);
    }
    return new this.router.converters[converterName](this.router, ...args, kw);
  }

  _encodeQueryVars(queryVars) {
    return urlEncode(
      queryVars,
      this.router.charset,
      false,
      this.router.sortParameters,
      this.router.sortKey,
    )
  }

  /**
   * Compiles the regular expression and stores it.
   * @returns 
   */
  async compile() {
    assert(this.router != null, "rule not bound");

    const domainRule = this.router.hostMatching
      ? this.host || ""
      : this.subdomain || "";

    this.converters = {};
    this._trace = [];
    this._staticWeights = [];
    this._argWeights = [];

    const regexParts = [];

    const self: Rule = this;
    function _buildRegex(rule: string) {
      let index = 0
      for (const [converter, args, variable] of parseRule(rule)) {
        if (converter == null) {
          regexParts.push(escapeRegExp(variable));
          self._trace.push([false, variable]);
          for (const part of variable.split("/")) {
            // ex: variable = '/web/login => 3 parts ['', 'web', 'login'] 
            // ==> maxPartIndex = 2 and maxPartLength = len('login') = 5; 
            if (part) {
              self._staticWeights.push([index, -part.length]);
              self.router.maxPartLength = Math.max(self.router.maxPartLength, part.length);
              self.router.maxPartCount = Math.max(self.router.maxPartCount, index + 1);
            }
          }
        } else {
          let c_args, c_kwargs;
          if (args) {
            [c_args, c_kwargs] = parseConverterArgs(args);
          }
          else {
            [c_args, c_kwargs] = [[], null];
          }
          const convobj = self.getConverter(variable, converter, c_args, c_kwargs);
          regexParts.push(f(`(?<%s>%s)`, variable, convobj.regex.source));
          self.converters[variable] = convobj;
          self._trace.push([true, variable]);
          self._argWeights.push(convobj.weight);
          self.router.maxArgWeight = Math.max(self.router.maxArgWeight, convobj.weight);
          self.router.maxArgCount = Math.max(self.router.maxArgCount, self._argWeights.length);
          self.args.add(String(variable));
          self.router.maxArgSize = Math.max(self.router.maxArgSize, self.args.size);
          self.router.maxDefaultSize = Math.max(self.router.maxDefaultSize, len(self.defaults));
        }
        index = index + 1;
      }
    }

    _buildRegex(domainRule);
    regexParts.push("\\\\|");
    this._trace.push([false, "|"]);

    _buildRegex(this.isLeaf ? this.rule : this.rule.endsWith("/") ? this.rule.slice(0, -1) : this.rule);

    if (!this.isLeaf) {
      this._trace.push([false, "/"]);
    }

    this._build = await this._compileBuilder(false);
    this._buildUnknown = await this._compileBuilder(true);

    if (this.buildOnly) {
      return
    }
    const regex = f("^%s%s$",
      regexParts.join(''),
      (!this.isLeaf || !this.strictSlashes)
      && "(?<!/)(?<__suffix__>/?)"
      || "",
    );
    try {
      this._regex = new RegExp(regex, 'u');
    } catch (e) {
      console.log(`Error Rule: "${this.rule}" \n\tregExp: "${regex}"`);
      throw e;
    }
  }

  static _getFuncCode(code: string, name?: string): Function {
    const context = {};
    const options = {};
    return safeEval(code, context, options);
  }

  async _compileBuilder(appendUnknown: boolean = true): Promise<Function> {
    const defaults = this.defaults ?? {};
    const domOps: [boolean, string][] = [];
    const urlOps: [boolean, string][] = [];

    let opl = domOps;
    for (let [isDynamic, data] of this._trace) {
      if (data === "|" && opl === domOps) {
        opl = urlOps;
        continue;
      }
      // this seems like a silly case to ever come up but:
      // if a default is given for a value that appears in the rule,
      // resolve it to a constant ahead of time
      if (isDynamic && data in defaults) {
        data = await this.converters[data].toUrl(defaults[data]);
        opl.push([false, data]);
      }
      else if (!isDynamic) {
        opl.push([false, urlQuote(data, { safe: "!$&'()*+,/:;=@" })]);
      }
      else {
        opl.push([true, data]);
      }
    }

    function _convert(elem) {
      const ret = _prefixNames(_f(_CALL_CONVERTER_CODE_FMT, { elem: elem })).body[0];
      ret.expression.argument.arguments = [AST.Member(AST.Identifier("values"), AST.Identifier(elem))];
      return ret.expression;
    }

    function _parts(ops) {
      let parts = [];
      for (const [isDynamic, elem] of ops) {
        if (isDynamic) {
          parts.push(_convert(elem));
        }
        else {
          parts.push(AST.Literal(elem));
        }
      }

      parts = parts.length ? parts : [AST.Literal("")];
      // constant fold
      const ret = [parts[0]];
      for (const p of parts.slice(1)) {
        if (p.type === 'Literal' && ret[ret.length - 1].type === 'Literal') {
          ret[ret.length - 1] = AST.Literal(ret[ret.length - 1].value + p.value);
        }
        else {
          ret.push(p);
        }
      }
      return ret;
    }

    const domParts = _parts(domOps);
    const urlParts = _parts(urlOps);
    let body;
    if (!appendUnknown) {
      body = [];
    }
    else {
      body = [_IF_KWARGS_URL_ENCODE_AST];
      extend(urlParts, _URL_ENCODE_AST_NAMES);
    }

    function _join(parts) {
      if (len(parts) == 1) {
        return parts[0];
      }
      else {
        const call = _prefixNames('[].join("")', '').body[0];
        call.expression.callee.object.elements = parts;
        return call.expression;
      }
    }

    body.push(AST.Return(AST.Array([_join(domParts), _join(urlParts)])));

    const args = [];
    for (const [isDynamic, elem] of _.union(domOps, urlOps)) {
      if (isDynamic && !(elem in defaults)) {
        args.push(String(elem));
      }
    }

    // (self, values: {id, model,..., params}, defaults: {}={...}) => { return []; }
    const funcAst = _prefixNames("async () => {}").body[0];
    // self = this rule for call rule's functions
    funcAst.expression.params.push(AST.Identifier("self"));
    // values passed when call rule.build(values)
    funcAst.expression.params.push(AST.Identifier("values"));
    // defaults if no in values
    const properties = [];
    for (const [key, val] of Object.entries(defaults)) {
      properties.push(AST.Property(AST.Identifier(key), AST.Literal(val)));
    }
    funcAst.expression.params.push(AST.Assignment(AST.Identifier("defaults"), properties.length
      ? AST.Object(properties)
      : AST.Literal(null)
    ));

    funcAst.expression.body = AST.Block(body);

    const modul = ast.parse("");
    modul.body = [funcAst];

    let code = ast.generate(modul,);
    const func = Rule._getFuncCode(code);
    return func;
  }

  /**
 *  rule.rule = '/web/assets/<int:id>-<string:unique>/<path:extra>/<string:filename>'
    rule._trace = [
      [false, '|'], 
      [false, '/web/assets/'], 
      [true, 'id'], 
      [false, '-'], 
      [true, 'unique'], 
      [false, '/'], 
      [true, 'extra'], 
      [false, '/'], 
      [true, 'filename']
    ]
    values = {
      'id': 371, 
      'unique': '4fece11', 
      'extra': '1', 
      'filename': 'web.assets_frontend.min.css'
    }
    => [,path] = [,'/web/assets/371-4fece11/1/web.assets_frontend.min.css']
 * @param values 
 * @returns 
 */
  async build(values: {} = {}, appendUnknown: boolean = true): Promise<[string, string]> {
    try {
      if (appendUnknown) {
        return this._buildUnknown(this, values);
      }
      else {
        return this._build(this, values);
      }
    } catch (e) {
      if (isInstance(e, ValidationError)) {
        return [null, null];
      } else {
        console.log('Rule.build Error:', this.rule, values, e.message);
        console.log(String(this._buildUnknown));
        throw e;
      }
    }
  }

  /**
   * Check if the rule matches a given path. Path is a string in the
        form ``"subdomain|/path"`` and is assembled by the map.  If
        the map is doing host matching the subdomain part will be the host
        instead.

        If the rule matches a dict with the converted values is returned,
        otherwise the return value is `None`.
   * @param req 
   * @param path 
   * @param method 
   * @returns 
   */
  async match(req, path: string, method?: string) {
    if (!this.buildOnly) {
      const m = this._regex.exec(path);
      if (m && m[0]) {
        const groups = Dict.from<any>(m.groups);
        if (
          this.strictSlashes
          && !this.isLeaf
          && !groups.pop("__suffix__")
          && (
            method == null || this.methods == null || this.methods.has(method)
          )
        ) {
          throw new RequestSlash();
        }
        else if (!this.strictSlashes) {
          delete groups["__suffix__"];
        }

        const result = {};
        for (let [name, value] of groups.items()) {
          try {
            value = await this.converters[name].toPrimary(req, value);
          } catch (e) {
            if (isInstance(e, ValidationError)) {
              return;
            }
            else {
              throw e;
            }
          }
          result[String(name)] = value;
        }
        if (this.defaults) {
          Object.assign(result, this.defaults);
        }

        if (this.alias && this.router.redirectDefaults) {
          throw new RequestAliasRedirect(result);
        }

        return result;
      }
    }
  }

  /**
   * The match compare key for sorting.
      Current implementation:
      1.  rules without any arguments come first for performance
          reasons only as we expect them to match faster and some
          common ones usually don't have any arguments (index pages etc.)
      2.  rules with more static parts come first so the second argument
          is the negative length of the number of the static weights.
      3.  we order by static weights, which is a combination of index
          and length
      4.  The more complex rules come first so the next argument is the
          negative length of the number of argument weights.
      5.  lastly we order by the actual argument weights.
   * @returns 
   */
  matchCompareKey() {
    return [
      this.args.size ? 1 : 0,
      this.router.maxPartCount - this._staticWeights.length,
      this._staticWeights,
      this.router.maxArgCount - this._argWeights.length,
      this._argWeights
    ];
  }

  /**
   * The build compare key for sorting.
   * @returns 
   */
  buildCompareKey() {
    return [
      len(this.alias) ? 1 : 0,
      this.router.maxArgSize - this.args.size,
      this.router.maxDefaultSize - len(this.defaults)
    ];
  }

  providesDefaultsFor(rule: any) {
    return (
      !this.buildOnly
      && len(this.defaults)
      && this.endpoint === rule.endpoint
      && this !== rule
      && this.args == rule.args
    )
  }

  /**
   * Check if the dict of values has enough data for url generation.

    :internal:
   * @param values 
   * @param method 
   * @returns 
   */
  suitableFor(values: any, method: any): boolean {
    // if a method was given explicitly and that method is not supported
    // by this rule, this rule is not suitable.
    if (
      method != null
      && this.methods != null
      && !this.methods.has(method)
    ) {
      return false;
    }

    const defaults = this.defaults ?? {}

    // all arguments required must be either in the defaults dict or
    // the value dictionary otherwise it's not suitable
    for (const key of Object.keys(this.args)) {
      if (!(key in defaults) && !(key in values)) {
        return false;
      }
    }

    // in case defaults are given we ensure that either the value was
    // skipped or the value is the same as the default value.
    if (len(defaults)) {
      for (const [key, value] of Object.entries<any>(defaults)) {
        if (key in values && value != values[key]) {
          return false;
        }
      }
    }

    return true;
  }
}

// const _ruleRe = new RegExp(
//   `(?<static>[^<]*)                          // static rule data
//   <
//   (?:
//       (?<converter>[a-zA-Z_][a-zA-Z0-9_]*)   // converter name
//       (?:\\((?<args>.*?)\\))?                // converter arguments
//       \\:                                    // variable delimiter
//   )?
//   (?<variable>[a-zA-Z_][a-zA-Z0-9_]*)        // variable name
//   >
//   `,
//   'g'
// )
/**
 * ex: /web/content/<string(10,max=5):model>/<int:id>/<string:field>/<string:filename>
 * => matches: (4) [
 * [/web/content/<string:model>, { 
 *    static: /web/content/
 *    converter: string
 *    args: 10,max=5
 *    variable: model 
 *  }],
 * [/<int:id>, {
 *    static: /
 *    converter: int
 *    variable: id 
 *  }
 * [/<string:field>, {
 *    static: /
 *    converter: string, 
 *    variable: field
 * }], 
 * [/<string:filename>, {
 *    static: /
 *    converter: string, 
 *    variable: filename
 * }]]
 */
const _ruleRe = /(?<static>[^<]*)<(?:(?<converter>[a-zA-Z_][a-zA-Z0-9_]*)(?:\((?<args>.*?)\))?\:)?(?<variable>[a-zA-Z_][a-zA-Z0-9_]*)>/g;

/**
 * return array 3 format:
 * [null, null, static]
 * [converter, args, variable]
 * [null, null, remaining]
 * @param rule 
 */
function* parseRule(rule: string) {
  let pos = 0;
  let end = rule.length;
  const usedNames = new Set<string>();
  const result = rule.matchAll(_ruleRe) as any;
  for (const m of result) {
    const groups = Dict.from<any>(m.groups);
    if (groups["static"]) {
      yield [null, null, groups["static"]];
    }
    const variable = groups["variable"];
    const converter = groups["converter"] ?? "default";
    if (usedNames.has(variable)) {
      throw new ValueError("variable name %s used twice.", variable);
    }
    usedNames.add(variable);
    yield [converter, groups["args"] ?? null, variable];
    pos += m[0].length;
  }
  if (pos < end) {
    const remaining = rule.slice(pos);
    if (remaining.includes(">") || remaining.includes("<")) {
      throw new ValueError("malformed url rule: %s", rule);
    }
    yield [null, null, remaining];
  }
}

// const _converterArgsRe = new RegExp(
//   `
//   ((?<name>\\w+)\\s*=\\s*)?
//   (?<value>
//       true|false|
//       \\d+.\\d+|
//       \\d+.|
//       \\d+|
//       [\\w\\d_.]+|
//       [urUR]?(?<stringval>"[^"]*?"|'[^']*')
//   )\\s*,
//   `,
//   'gu',
// );
const _converterArgsRe = /((?<name>\w+)\s*=\s*)?(?<value>true|false|\d+.\d+|\d+.|\d+|[\w\d_.]+|[urUR]?(?<stringval>"[^"]*?"|'[^']*'))\s*,/gu;
/**
 * ex args: base,10,code=SG,lang=us
 * => matches: (4) [
 *  [base, {value: base}], 
 *  [10, {value: 10}], 
 *  [code=SG, {name: code, value: SG}], 
 *  [lang=us, {name: lang, value: us}]
 * ]
 * @param argstr 
 * @returns 
 */
function parseConverterArgs(argstr: string) {
  argstr += ",";
  const args = [];
  const kwargs = {};

  const matches = argstr.matchAll(_converterArgsRe);
  for (const m of matches) {
    const groups = Dict.from<any>(m.groups);
    let value = groups["stringval"];
    if (value == null) {
      value = groups["value"];
    }
    value = _primarize(value);
    if (!groups["name"]) {
      args.push(value);
    }
    else {
      kwargs[groups["name"]] = value;
    }
  }

  return [args, kwargs];
}

const _PRIMARY_CONSTANTS = { "null": null, "true": true, "false": false };

function _primarize(value: string) {
  if (value in _PRIMARY_CONSTANTS) {
    return _PRIMARY_CONSTANTS[value];
  }
  for (const convert of [parseInt, parseFloat]) {
    const res = convert(value);
    if (!isNaN(res)) {
      return res;
    }
  }
  if (value.slice(0, 1) === value.slice(-1) && `"'`.includes(value[0])) {
    value = value.slice(1, -1);
  }
  return String(value);
}