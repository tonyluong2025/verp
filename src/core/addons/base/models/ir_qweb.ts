import { LexicalAnalyzer } from 'javascript-compiling-tokenizer';
import { Module } from "module";
import * as api from "../../../api";
import { Dict } from "../../../helper/collections";
import { NotImplementedError, ValueError } from "../../../helper/errors";
import { MetaModel } from "../../../models";
import { getResourcePath } from '../../../modules/modules';
import * as tools from "../../../tools";
import { _format, extend, getLang, repr } from '../../../tools';
import { isInstance } from "../../../tools/func";
import { QwebTracker } from '../../../tools/profiler';
import { _BUILTINS, testExpr } from "../../../tools/save_eval";
import { getrootXml, isElement, parseXml, popAttribute } from "../../../tools/xml";
import { AssetsBundle } from './assets_bundle';
import { SCRIPT_EXTENSIONS, STYLE_EXTENSIONS, canAggregate } from './ir_asset';
import { IrQWebFactory } from './ir_qweb_factory';
import { dedent } from './qweb';

export const _SAFE_QWEB_OPCODES = [];

@MetaModel.define()
class IrQWeb extends IrQWebFactory {
  static _module = module;
  static _parents = 'ir.qweb';
  static _description = 'Qweb';

  // OVERRIDE
  _availableObjects = Object.assign({}, _BUILTINS);
  _emptyLines = /\n\s*\n/g;

  /**
   * OVERRIDE
   * Prepare the context that will be sent to the evaluated function.

    @param values template values to be used for rendering
    @param options frozen dict of compilation parameters.
   */
  _prepareValues(values: {}={}, options: {}={}) {
    checkValues(values);
    values['true'] = true;
    values['false'] = false;
    if (!('request' in values)) {
      values['request'] = this.env.req;
    }
    return super._prepareValues(values, options);
  }

  /**
   * OVERRIDE
   * @param expr 
   * @param raiseOnMissing 
   * @returns 
   */
  _compileExpr(expr, raiseOnMissing=false): string {
    let tokens;
    try {
      tokens = new LexicalAnalyzer({verbose: false}).start(expr).tokens;
    } catch(e) {
      throw new ValueError(`Cannot compile expression: ${expr}`);
    }
    const namespaceExpr = this._compileExprTokens(tokens, this._allowedKeywords.concat(Object.keys(this._prepareGlobals())), null, raiseOnMissing);
    testExpr('return '+ namespaceExpr, _SAFE_QWEB_OPCODES);
    return namespaceExpr;
  }

  // order

  /**
   * OVERRIDE
   * @returns 
   */
  _directivesEvalOrder() {
    let directives = super._directivesEvalOrder();
    directives.splice(directives.indexOf('foreach'), 0, 'groups');
    directives.splice(directives.indexOf('call'), 0, 'lang');
    directives.splice(directives.indexOf('field'), 0, 'call-assets');
    return directives;
  }

  // compile

  /**
   * OVERRIDE
   * @param el 
   * @param options 
   * @param indent 
   * @returns 
   */
  async _compileNode(el: Element, options: {}={}, indent: number=0) {
    if (el.hasAttribute("groups")) {
      el.setAttribute("t-groups", popAttribute(el, "groups"))
    }
    return super._compileNode(el, options, indent);
  }

  // compile directives
  /**
   * OVERRIDE
   * @param el 
   * @param options 
   * @param directive 
   * @param indent 
   * @returns 
   */
  // @QwebTracker.wrapCompileDirective()
  async _compileDirective(el: Element, options: {}={}, directive: string, indent: number=0) {
    return super._compileDirective(el, options, directive, indent);
  }

  /**
   * Compile `t-groups` expressions into a javascript code as a list of
    strings.

    The code will contain the condition `if self.user_hasGroups(groups)` part that wrap the rest of the compiled code of this element.
   * @param el 
   * @param options 
   * @param indent 
   * @returns 
   */
  async _compileDirectiveGroups(el: Element, options: {}={}, indent: number=0) {
    const groups = popAttribute(el, 't-groups');
    const code: any[] = this._flushText(options, indent);
    code.push(this._indent(`if (await self.userHasGroups(${repr(groups)})) {`, indent));
    code.push((await this._compileDirectives(el, options, indent + 1)).concat(this._flushText(options, indent + 1) || [this._indent('// pass', indent + 1)]));
    code.push(this._indent('}', indent));
    return code;
  }

  async _compileDirectiveLang(el: Element, options: {}={}, indent: number=0) {
    el.setAttribute('t-options-lang', popAttribute(el, 't-lang'));
    return this._compileNode(el, options, indent);
  }

  /**
   * This special 't-call' tag can be used in order to aggregate/minify javascript and css assets
   * @param el 
   * @param options 
   * @param indent 
   */
  async _compileDirectiveCallAssets(el: Element, options: {}={}, indent: number=0) {
    if (Array.from(el.childNodes).filter(n => isElement(n)).length) {
      throw new SyntaxError("t-call-assets cannot contain children nodes");
    }

    const code = this._flushText(options, indent);
    code.push(this._indent(dedent(_format(`
    tCallAssetsNodes = await self._getAssetNodes({xmlid}, {request: values["request"], css: {css}, js: {js}, debug: values["debug"], asyncLoad: {asyncLoad}, deferLoad: {deferLoad}, lazyLoad: {lazyLoad}, media: {media}});
    for (const [index, value] of enumerate(tCallAssetsNodes)) {
      let [tagName, attrs, content] = value;
      if (index) {
        yield ''
      }
      yield '<';
      yield tagName;
    `.trim(), {
      'xmlid': repr(el.getAttribute('t-call-assets')),
      'css': this._compileBool(el.getAttribute('t-css') || true),
      'js': this._compileBool(el.getAttribute('t-js') || true),
      'asyncLoad': this._compileBool(el.getAttribute('asyncLoad') || false),
      'deferLoad': this._compileBool(el.getAttribute('deferLoad') || false),
      'lazyLoad': this._compileBool(el.getAttribute('lazyLoad') || false),
      'media': el.hasAttribute('media') ? repr(el.getAttribute('media')) : false,
    })), indent));
    extend(code, this._compileAttributes(options, indent + 1));
    code.push(this._indent(dedent(`
      if (! content && self._voidElements.has(tagName)) {
        yield '/>';
      }
      else {
        yield '>';
        if (content) {
          yield content;
        }
        yield '</';
        yield tagName;
        yield '>';
      }`).trim(), indent + 1));
    code.push(this._indent(`
    }`, indent));
    return code;
  }


  /**
   * OVERRIDE
   * render(template, values, **options)
    Render the template specified by the given name.

    @param template etree, xmlid, template name (see _getTemplate)
        * Call the method ``load`` is not an etree.
    @param values template values to be used for rendering
    @param options used to compile the template (the dict available for the rendering is frozen)
        * ``load`` (function) overrides the load method

    @returns bytes marked as markup-safe (decode to `markup`
              instead of `string`)
   */
  // @QwebTracker.wrapRender()
  @api.model()
  async _render(template: any, values: {} = {}, options: {} = {}) {
    const compileOptions = Dict.from({...this.env.context, devMode: tools.config.get('devMode')?.includes('qweb')});
    compileOptions.updateFrom(options);

    let result = await super._render(template, values, compileOptions);

    if (! values || ! values['__keepEmptyLines']) {
      result = result.replace(this._emptyLines,'\n');
    }

    if (!result.includes('data-pagebreak=')) {
      return result;
    }

    return result; 
  }

  /**
   * Return the list of context keys to use for caching ``_getTemplate``.
   * @returns 
   */
  _getTemplateCacheKeys() {
    return ['lang', 'inheritBranding', 'editable', 'translatable', 'editTranslations', 'websiteId', 'profile', 'raiseOnCode'];
  }

  /**
   * OVERRIDE
   * @param idOrXmlid 
   * @param options 
   * @returns 
   */
  @tools.conditional(
    !tools.config.options['devMode'].includes('xml'),
    tools.ormcache('idOrXmlid', 'self._getTemplateCacheKeys().map(k => options[k])'),
  )
  // @QwebTracker.wrapCompile()
  async _compile(idOrXmlid: any, options: {}={}) {
    const id = parseInt(idOrXmlid);
    if (!isNaN(id)) {
      idOrXmlid = id;
    }
    return super._compile(idOrXmlid, options);
  }

  /**
   * OVERRIDE
   * @param name 
   * @param options 
   * @returns 
   */
  async _load(name, options): Promise<[Element, number|null]> {
    const self = this;
    let lang = await options['lang'];
    if (!lang) {
      try {
        lang = await getLang(self.env);
        lang = await lang.code;
      } catch (e) {
        throw e;
      }
    }
    let env = self.env;
    if (lang != env.context['lang']) {
      env = await env.change({context: {...env.context, lang: lang}});
    }

    const viewId = await self.env.items('ir.ui.view').getViewId(name);
    const template = await (await env.items('ir.ui.view').sudo())._readTemplate(viewId);

    // QWeb's `_readTemplate` will check if one of the first children of what we send to it has a "t-name" attribute having `name` as value to consider it has found it. As it'll never be the case when working with view ids or children view or children primary views, force it here.
    async function isChildView(viewName) {
      const viewId = await self.env.items('ir.ui.view').getViewId(viewName);
      const view = (await self.env.items('ir.ui.view').sudo()).browse(viewId);
      const inheritId = await view.inheritId;
      return inheritId != null;
    }

    if (typeof(name) === 'number' || await isChildView(name)) {
      const view = getrootXml(parseXml(template));
      for (const node of Array.from<any>(view.childNodes)) {
        if (isElement(node) && node.getAttribute('t-name')) {
          node.setAttribute('t-name', String(name));
        }
      }
      return [view, viewId];
    }
    else {
      return [template, viewId];
    }
  }

  // method called by computing code
  async getAssetBundle(bundleName, files, options?: {env?: any, request?: any, css?: boolean, js?: boolean}) {
    return AssetsBundle.new(bundleName, files, options);
  }

  /**
   * Generates asset nodes.
    If debug=assets, the assets will be regenerated when a file which composes them has been modified.
    Else, the assets will be generated only once and then stored in cache.
   * @param bundle 
   * @param options 
   * @param css 
   * @param js 
   * @param debug 
   * @param async_load 
   * @param defer_load 
   * @param lazyLoad 
   * @param media 
   */
  async _getAssetNodes(bundle, options?: {request?: any, css?: boolean, js?: boolean, debug?: any, asyncLoad?: boolean, deferLoad?: boolean, lazyLoad?: boolean, media?: string}) {
    options = options ?? {};
    options.css = options.css ?? true;
    options.js = options.js ?? true;
    let result;
    if (options.debug && options.debug.includes('assets')) {
      result = await this._generateAssetNodes(bundle, options);
    }
    else {
      result = await this._generateAssetNodesCache(bundle, options);
    }
    return result;
  }

  @tools.conditional(
    // in non-xml-debug mode we want assets to be cached forever, and the admin can force a cache clear
    // by restarting the server after updating the source code (or using the "Clear server cache" in debug tools)
    !tools.config.options['devMode'].includes('xml'),
    tools.ormcacheContext('bundle', 'options.css', 'options.js', 'options.debug', 'options.asyncLoad', 'options.deferLoad', 'options.lazyLoad', ["websiteId", "lang"]),
  )
  async _generateAssetNodesCache(bundle, options?: {css?: boolean, js?: boolean, debug?: boolean, asyncLoad?: boolean, deferLoad?: boolean, lazyLoad?: boolean, media?: string}) {
    options = options ?? {};
    options.css = options.css ?? true;
    options.js = options.js ?? true;
    return this._generateAssetNodes(bundle, options);
  }

  async _generateAssetNodes(bundle, options?: {request?: any, css?: boolean, js?: boolean, debug?: boolean, asyncLoad?: boolean, deferLoad?: boolean, lazyLoad?: boolean, media?: string}) {
    options = options ?? {};
    options.css = options.css ?? true;
    options.js = options.js ?? true;
    let nodeAttrs = null;
    if (options.css && options.media) {
      nodeAttrs = {
        'media': options.media,
      }
    }
    let [files, remains] = await this._getAssetContent(bundle, nodeAttrs, options.deferLoad, options.lazyLoad);
    const asset = await this.getAssetBundle(bundle, files, {env: this.env, request: options.request, css: options.css, js: options.js});
    remains = remains.filter(node => (options.css && node[0] === 'link') || (options.js && node[0] === 'script'));

    return remains.concat(await asset.toNode(options));
  }

  @tools.ormcacheContext('bundle', 'nodeAttrs && nodeAttrs["media"]', 'deferLoad', 'lazyLoad', ["websiteId", "lang"])
  async _getAssetContent(bundle, nodeAttrs: any, deferLoad?: boolean, lazyLoad?: boolean) {
    const assetPaths: string[] = await this.env.items('ir.asset')._getAssetPaths(bundle, {css: true, js: true});

    const files = [];
    const remains = [];
    for (const [path] of assetPaths) {
      const ext = path.split('.').slice(-1)[0];
      const isJs = SCRIPT_EXTENSIONS.includes(ext);
      const isCss = STYLE_EXTENSIONS.includes(ext);
      if (! isJs && ! isCss) {
        continue;
      }

      const mimetype = isJs ? 'text/javascript' : `text/${ext}`;
      if (canAggregate(path)) {
        const segments = path.split('/').filter(segment => !!segment);
        files.push({
          'atype': mimetype,
          'url': path,
          'filename': segments ? getResourcePath(segments[0], ...segments.slice(1)) : null,
          'content': '',
          'media': nodeAttrs && nodeAttrs.getAttribute('media'),
        })
      }
      else {
        let tag, attributes;
        if (isJs) {
          tag = 'script';
          attributes = {
            "type": mimetype,
          }
          attributes[lazyLoad ? "data-src" : "src"] = path;
          if (deferLoad || lazyLoad) {
            attributes["defer"] = "defer";
          }
        }
        else {
          tag = 'link';
          attributes = {
            "type": mimetype,
            "rel": "stylesheet",
            "href": path,
            'media': nodeAttrs && nodeAttrs['media'],
          }
        }
        remains.push([tag, attributes, ''])
      }
    }
    return [files, remains];
  }

  /**
   * OVERRIDE
   * @param record 
   * @param fieldName 
   * @param expression 
   * @param tagName 
   * @param fieldOptions 
   * @param options 
   * @param values 
   * @returns 
   */
  async _getField(record, fieldName, expression, tagName, fieldOptions={}, options={}, values={}) {
    if (record == undefined || record._fields == undefined) {
      return []; // debug
    }
    const field = record._fields[fieldName];

    // adds template compile options for rendering fields
    fieldOptions['templateOptions'] = options;

    // adds generic field options
    fieldOptions['tagName'] = tagName;
    fieldOptions['expression'] = expression;
    fieldOptions['type'] = fieldOptions['widget'] ?? field.type;
    const inheritBranding = options['inheritBranding'] ?? (options['inheritBrandingAuto'] && await record.checkAccessRights('write', false));
    fieldOptions['inheritBranding'] = inheritBranding;
    const translate = options['editTranslations'] && options['translatable'] && field.translate;
    fieldOptions['translate'] = translate;

    // field converter
    const model = 'ir.qweb.field.' + fieldOptions['type'];
    const converter = model in this.env.models ? this.env.items(model) : this.env.items('ir.qweb.field');

    // get content (the return values from fields are considered to be markup safe)
    const content = await converter.recordToHtml(record, fieldName, fieldOptions);
    const attributes = await converter.attributes(record, fieldName, fieldOptions, values);

    const result = [attributes, content, inheritBranding || translate];
    return result;
  }

  /**
   * OVERRIDE
   * @param value 
   * @param expression 
   * @param tagName 
   * @param fieldOptions 
   * @param options 
   * @param values 
   * @returns 
   */
  async _getWidget(value, expression, tagName, fieldOptions, options, values) {
    // adds template compile options for rendering fields
    fieldOptions['templateOptions'] = options;

    fieldOptions['type'] = fieldOptions['widget'];
    fieldOptions['tagName'] = tagName;
    fieldOptions['expression'] = expression;

    // field converter
    const model = 'ir.qweb.field.' + fieldOptions['type'];
    const converter = model in this.env.models ? this.env.items(model) : this.env.items('ir.qweb.field');

    // get content (the return values from widget are considered to be markup safe)
    const content = await converter.valueToHtml(value, fieldOptions);
    const attributes = {};
    attributes['data-oe-type'] = fieldOptions['type'];
    attributes['data-oe-expression'] = fieldOptions['expression'];

    return [attributes, content, null];
  }

}

function checkValues(d: {}) {
  if (! d) {
    return d;
  }
  for (const v of Object.values(d)) {
    if (isInstance(v, Module)) {
      throw new TypeError(`Module ${v} can not be used in evaluation contexts

Prefer providing only the items necessary for your intended use.

If a "module" is necessary for backwards compatibility, use
'core.tools.safe_eval.wrapModule' to generate a wrapper recursively
whitelisting allowed attributes.

Pre-wrapped modules are provided as attributes of 'core.tools.safe_eval'.
`)
    }
  }
  return d;
}

/**
 * Rendering of a qweb template without database and outside the registry.
    (Widget, field, or asset rendering is not implemented.)
    @param templateName template identifier
    @param values template values to be used for rendering
    @param load function like `load(templateName, options)` which
        returns an etree from the given template name (from initial rendering
        or template `t-call`).
    @param options used to compile the template (the dict available for the
        rendering is frozen)
    @returns bytes marked as markup-safe (decode to `Markup`
                instead of `string`)
 */
export async function render(templateName, values, load, options: {}={}) {
  class MockPool {
    dbName = null;
    __cache = new Map<any, any>();
  }

  class MockEnv extends Dict<any> {
    constructor(obj?: any) {
      super(obj);
      this.context = {}
    }
  }

  @MetaModel.define()
  class MockIrQWeb extends IrQWeb {
    static _module = module;
    static _parents = 'ir.qweb';
    static _register = false;               // not visible in real registry

    env: any;
    pool: any;

    constructor() {
      super();
      this.env = new MockEnv();
      this.pool = new MockPool();
    }

    async _getField(...args: any[]): Promise<any[]> {
      throw new NotImplementedError("Fields are not allowed in this rendering mode. Please use \"env['ir.qweb']._render\" method");
    }

    async _getWidget(...args: any[]): Promise<any[]> {
      throw new NotImplementedError("Widgets are not allowed in this rendering mode. Please use \"env['ir.qweb']._render\" method")
    }

    async _getAssetNodes(...args: any[]) {
      throw new NotImplementedError("Assets are not allowed in this rendering mode. Please use \"env['ir.qweb']._render\" method");
    }
  }

  const renderer = new MockIrQWeb();
  return renderer._render(templateName, values, {load: load, ...options});
}