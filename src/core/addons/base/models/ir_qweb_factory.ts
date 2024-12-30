import * as xmldom from '@xmldom/xmldom/lib/dom';
import assert from 'assert';
import fs from 'fs';
import { Generator } from 'javascript-compiling-tokenizer';
import _ from "lodash";
import { format } from 'util';
import { Dict, FrozenDict, FrozenSet, MapKey } from "../../../helper/collections";
import { ValueError } from "../../../helper/errors";
import { MetaModel } from '../../../models';
import { bool, stringBase64, toText } from '../../../tools';
import { equal, isDigit, isInstance, rstringPart } from "../../../tools/func";
import { chain, count, enumerate, extend, isIterable, iter, len, next, range } from "../../../tools/iterable";
import { pop, popitem, repr } from '../../../tools/misc';
import { compile, unsafeEval } from "../../../tools/save_eval";
import { UpCamelCase } from "../../../tools/utils";
import * as xml from '../../../tools/xml';
import { markup } from '../../../tools/xml';
import { QWeb, QWebCodeFound, QWebException, dedent } from './qweb';

function _debug(msg, ...args) {
  if (msg.startsWith('async function* template209')) {
    console.log(msg, ...args);
  }
}

/**
 * Adds 'prefix' to the beginning of selected lines in 'text'.

  If 'predicate' is provided, 'prefix' will only be added to the lines
  where 'predicate(line)' is true. If 'predicate' is not provided,
  it will default to adding 'prefix' to all non-empty lines that do not
  consist solely of whitespace characters.
 * @param text 
 * @param prefix 
 * @param predicate 
 * @returns 
 */
function _indent(text: string, prefix: string, predicate?: any) {
  if (predicate == null) {
    predicate = (line: string) => line.trim();
  }
  function* prefixedLines() {
    for (const line of text.split('\n')) {
      yield (predicate(line) ? prefix + line : line);
    }
  }

  return Array.from(prefixedLines()).join('');
}

function _subNsmap(ns1: {}, ns2: {}) {
  const ns = {};
  for (const n1 of Object.entries(ns1)) {
    let diff = true;
    for (const n2 of Object.entries(ns2)) {
      if (n1[0] === n2[0] && n1[1] === n2[1]) {
        diff = false;
        break;
      }
    }
    if (diff) {
      ns[n1[0]] = n1[1];
    }
  }
  return ns;
}

function _joinCode(codeLines: string | string[], num?: number) {
  let result = '';
  let idx = Number.isInteger(num) ? num : null;
  for (const line of codeLines) {
    if (Array.isArray(line)) {
      result += _joinCode(line, idx);
      idx = Number.isInteger(num) && idx + line.length + 1;
    } else if (typeof (line) === 'string' && line.trim()) {
      result += '\n' + (Number.isInteger(num) ? `${idx++}`.padEnd(3) : '') + line;
    }
  }
  return result;
}

const _NAME_REGEX = /[a-zA-Z0-9_]+/m;

const _whitespaceOnlyRe = /^[ \t]+$/gm;

const _leadingWhitespaceRe = /(^[ \t]*)(?:[^ \t\n])/gm;

const _FORMAT_REGEX = /(?:#\{(.+?)\})|(?:\{\{(.+?)\}\})/g;

const _VARNAME_REGEX = /\W/g;

const _allowedGlobals = Object.getOwnPropertyNames(global);

@MetaModel.define()
export class IrQWebFactory extends QWeb {
  static _module = module;
  static _name = 'ir.qweb';
  // A void element is an element whose content model never allows it to have contents under any circumstances. Void elements can have attributes.
  _voidElements = new FrozenSet([
    'area', 'base', 'br', 'col', 'command', 'embed', 'hr', 'img', 'input', 'keygen',
    'link', 'meta', 'param', 'source', 'track', 'wbr', 'menuitem',]);
  _nameGen = count();
  // _availableObjects builtins is not security safe (it's dangerous), is overridden by irQweb to only expose the safeEval builtins.
  _availableObjects: {} = {
    // 'Dict': Dict,
    // 'JSON': JSON,
  };
  _allowedKeywords = ['await', 'async', 'as', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'let', 'new', 'null', 'of', 'package', 'private', 'protected', 'public', 'require', 'return', 'super', 'switch', 'static', 'then', 'this', 'throw', 'try', 'true', 'typeof', 'undefined', 'var', 'void', 'while', 'with', 'yield', 'includes'].concat(_allowedGlobals);

  // values for running time
  _prepareValues(values, options: {} = {}) {
    values['compileOptions'] = options;
    return values;
  }

  /**
   * Prepare the global context that will sent to eval the qweb generated
    code.
    @param globalsDict: template global values use in compiled code
    @param options frozen dict of compilation parameters.
   */
  _prepareGlobals(globalsDict: {} = {}, options: {} = {}) {
    return Object.assign(globalsDict, {
      'Dict': Dict,
      'MapKey': MapKey,
      'isInstance': isInstance,
      'isIterable': isIterable,
      'len': len,
      'bool': bool,
      'markup': markup,
      'escape': _.escape,
      '_debug': _debug,
      'equal': equal,
      'repr': repr,
      'format': format,
      'f': format,
      'enumerate': enumerate,
      'diff': _.difference,
      'range': range,
      'pop': pop,
      'popitem': popitem,
      'decode': stringBase64,
      'compileOptions': options
    }, this._availableObjects);
  }

  // compute helpers
  /**
   * Add an item (converts to a str) to the list.
      This will be concatenated and added during a call to the
      `_flushText` method. This makes it possible to return only one
      yield containing all the parts.
   * @param text 
   * @param options 
   */
  _appendText(text: string, options: {} = {}) {
    options['_textConcat'].push(this._compileToStr(text));
  }

  /**
   * Concatenate all the textual chunks added by the `_appendText`
        method into a single yield.
   * @param options 
   * @param indent 
   * @returns 
   */
  _flushText(options: {}, indent: number = 0) {
    let textConcat: any[] = options['_textConcat'];
    if (len(textConcat)) {
      const text = textConcat.join('');
      textConcat.length = 0;
      if (isNaN(indent)) {
        indent = 0;
      }
      return [`${_.fill(Array(indent), '    ').join('')}yield \`${text}\`;`];
    }
    else {
      return [];
    }
  }

  _indent(code: string, indent: number = 0): any {
    if (isNaN(indent)) {
      indent = 0;
    }
    return _indent(code, _.fill(Array(indent), '    ').join(''));
  }

  _makeName(prefix = 'var') {
    return `${prefix}_${next(this._nameGen)}`;
  }

  // order

  /**
   * List all supported directives in the order in which they should be
        evaluated on a given element. For instance, a node bearing both
        ``foreach`` and ``if`` should see ``foreach`` executed before ``if`` aka
        .. code-block:: xml
            <el t-foreach="foo" t-as="bar" t-if="bar">
        should be equivalent to
        .. code-block:: xml
            <t t-foreach="foo" t-as="bar">
                <t t-if="bar">
                    <el>
        then this method should return ``['foreach', 'if']``.
   * @returns 
   */
  _directivesEvalOrder() {
    return [
      'debug',
      'foreach',
      'if', 'elif', 'else',
      'field', 'esc', 'raw', 'out',
      'tag',
      'call', 'apply',
      'set',
      'content',
    ];
  }

  /**
   * Test whether the given element is purely static, i.e. (there
        are no t-* attributes), does not require dynamic rendering for its
        attributes.
   * @param el 
   * @param options 
   * @returns 
   */
  _isStaticNode(el: xmldom.Element, options: any) {
    return el.tagName !== 't' && !Array.from<Attr>(el.attributes ?? []).some(a => a.name.startsWith('t-') && !['t-tag', 't-content'].includes(a.name));
  }

  _debugTrace(logger, options) {
    console.debug(logger, options);
  }

  // method called by computing code
  async _postProcessingAttr(localName: any, attributes: {} = {}, options: {} = {}) {
    return attributes;
  }

  //compile
  _compileFormat(expr: string) {
    let text = '';
    const values = [];
    let baseIdx = 0;
    const matches = expr.matchAll(_FORMAT_REGEX);
    for (const m of matches) {
      const literal = expr.slice(baseIdx, m.index);
      if (literal) {
        text += literal.replace('{', '{{').replace("}", "}}");
      }
      text += '%s';
      values.push(`await self._compileToStr(${this._compileExpr(m[1] || m[2])})`);
      baseIdx = m.index + m[0].length;
    }
    // str past last regex match
    const literal = expr.slice(baseIdx);
    if (literal) {
      text += literal.replace('{', '{{').replace("}", "}}");
    }

    let code = repr(text);
    if (values.length) {
      code = 'format(' + code + `, ${values.join(", ")})`;
    }
    return code;
  }

  /**
   * * Transform the list of token coming into a javascript instruction in
    textual form by adding the namepaces for the dynamic values.

    Example: `5 + a + b.c` to be `5 + values.get('a') + values['b'].c`
    Unknown values are considered to be None, but using `values['b']`
    gives a clear error message in cases where there is an attribute for
    example (have a `KeyError: 'b'`, instead of `AttributeError: 'NoneType'
    object has no attribute 'c'`).

   * @param tokens 
   * @param allowedKeys 
   * @param argumentNames 
   * @param raiseOnMissing 
   * @returns 
   */
  _compileExprTokens(tokens, allowedKeys: string[], argumentNames?: any, raiseOnMissing?: boolean): string {
    let argumentName = '_arg_%s__';
    argumentNames = argumentNames ?? [];

    function _getNames(tokens, end = 0) {
      const names: any[] = [];
      let j = 0;
      while (j < end) {
        let type = tokens[j].type;
        let value = tokens[j].value;
        if (type === 'name' && value && !allowedKeys.includes(value) && !argumentNames.includes(value) && !names.includes(value)) { // single arg, ex: lg => lg[0]
          names.push(value);
        }
        else if (type === 'params') { // block args, ex: (lg) => lg[0]
          for (const param of value ?? []) {
            if (param.type === 'name' && param.value && !allowedKeys.includes(value) && !argumentNames.includes(param.value) && !names.includes(param.value)) {
              names.push(param.value);
            }
          }
        }
        j += 1;
      }
      return names;
    }

    let index = 0;
    let preType;
    while (index < len(tokens)) {
      let t = tokens[index];
      let type = t.type;
      let value = t.value;
      if (type === 'arrow' || (type === 'codeblock' && preType === 'params') || (type === 'operator' && value === '=>')) {
        argumentNames = argumentNames.concat(_getNames(tokens, index));
        break;
      }
      index += 1;
      preType = type !== 'space' ? type : preType;
    }

    const code: any[] = [];
    let assigner = true;
    index = 0;
    while (index < len(tokens)) {
      let t = tokens[index];
      let type = t.type;
      let value = t.value;
      if (value.length && type === 'name') {
        let num = Number(value);
        if (!Number.isNaN(num)) {
          value = num;
          type = typeof (num);
        }
      }
      switch (type) {
        case "params": // ()
        case "array": // []
        case "codeblock": // {}
          {
            value = this._compileExprTokens(value, allowedKeys, argumentNames, raiseOnMissing);
            if (type === "params") {
              value = `(${value})`;
            } else if (type === "array") {
              value = `[${value}]`;
            } else {
              value = `{${value}}`;
            }
            type = "stringLiteral";
            break;
          }
        case "assignee":
          {
            const val = value.match(/[a-zA-Z0-9_]+/m);
            if (val != null) {
              if (!allowedKeys.includes(val[0]) && !argumentNames.includes(val[0])) {
                value = `values['${val[0]}']${value.slice(val[0].length)}`;
              }
              type = "stringLiteral";
              assigner = false;
            }
            break;
          }
        case 'name': // not reserved: 'const', 'var', 'let'
          {
            const val = value.match(/[a-zA-Z0-9_]+/m);
            if (val != null) {
              if (allowedKeys.includes(val[0]) || argumentNames.includes(val[0])) {
                assigner = false;
              }
              else if (assigner) {
                value = `values['${val[0]}']${value.slice(val[0].length)}`;
                type = "string";
                assigner = false;
              }
            }
            break;
          }

        case 'const': // assignable: /[^\s\n\t\r,;(){}[\]=]/;
        case 'var':
        case 'let':
        case "import":
        case "await":
        case "statementseperator": // ;
        case 'seperator': // ,
        case 'assigner': // =
        case 'arrow': // =>
          {
            assigner = true;
            break;
          }
        case "operator":
          {
            if (value === '.') {
              assigner = false;
            } else {
              assigner = true;
            }
            break;
          }
        case "number":
        // special: /[^a-zA-Z0-9_;\s\n\t\r]/
        case "space": // \s
        case "tab": // \t
        case "eol": // \r
        case "carriagereturn": // \n
        case "string": // doublequote "" or singlequote ''
        case "stringLiteral": // backtick ``
        case "inlinecomment": // //
        case "multilinecomment": // /** */
        default: {
          assigner = true;
        }
      }
      code.push({ "type": type, "value": value });
      index += 1;
    }
    const namespaceExpr = new Generator().start(code);
    return namespaceExpr;
  }

  _compileBool(attr: any, defaultValue: any = false) {
    if (attr) {
      if (attr === true) {
        return true;
      }
      attr = attr.toLowerCase();
      if (['false', '0'].includes(attr)) {
        return false;
      }
      else if (['true', '1'].includes(attr)) {
        return true;
      }
    }
    return bool(defaultValue);
  }

  _compileToStr(expr: any) {
    return toText(expr);
  }

  _compileAttributes(options: {}, indent?: number) {
    // Use str(value) to change markup into str and escape it, then use str
    // to avoid the escaping of the other html content.
    const body = this._flushText(options, indent);
    body.push(this._indent(`attrs = await self._postProcessingAttr(tagName, attrs, compileOptions);`, indent));
    body.push(this._indent(`for (const [name, value] of Object.entries(attrs)) {`, indent));
    body.push(this._indent(`  if (value || typeof(value) === 'string') {`, indent + 1));
    body.push(this._indent(`    yield ' ' + String(name) + '=\"' + String(value) + '\"'`, indent + 2));
    body.push(this._indent(`  }`, indent + 1));
    body.push(this._indent(`}`, indent));
    return body;
  }

  _compileStaticAttributes(el: xmldom.Element, options: {} = {}, indent?: number, attrAlreadyCreated?: boolean) {
    // Etree will also remove the ns prefixes indirection in the attributes. As we only have
    // the namespace definition, we'll use an nsmap where the keys are the definitions and
    // the values the prefixes in order to get back the right prefix and restore it.
    const nsprefixmap = {};
    for (const [k, v] of chain(Object.entries(options['nsmap']), Object.entries(el._nsMap))) {
      nsprefixmap[k] = v;
    }

    const code = [];
    for (const attr of Array.from<xmldom.Attribute>(el.attributes)) {
      if (!attr.name.startsWith('t-')) {
        let name = attr.name;
        if (attr.namespaceURI) {
          name = `${nsprefixmap[attr.namespaceURI]}:${attr.localName}`;
        }
        code.push(this._indent(`attrs[${repr(name)}] = ${repr(attr.value)};`, indent));
      }
    }
    return code;
  }

  _compileDynamicAttributes(el: xmldom.Element, options: {} = {}, indent?: number, attrAlreadyCreated?: boolean) {
    const code = [];
    for (const attr of Array.from<xmldom.Attribute>(el.attributes)) {
      if (attr.name.startsWith('t-attf-')) {
        code.push(this._indent(`attrs[${repr(attr.name.slice(7))}] = ${this._compileFormat(attr.value)};`, indent));
      }
      else if (attr.name.startsWith('t-att-')) {
        code.push(this._indent(`attrs[${repr(attr.name.slice(6))}] = ${this._compileExpr(attr.value)};`, indent));
      }
      else if (attr.name === 't-att') {
        code.push(this._indent(dedent(`
          const attsValue = ${this._compileExpr(attr.value)};
          if (typeof(attsValue) === 'object') {
            Dict.fill(attrs, attsValue);
          }
          else if (Array.isArray(attsValue) && !Array.isArray(attsValue[0])) {
            Dict.fill(attrs, [attsValue]);
          }
          else if (Array.isArray(attsValue)) {
            Dict.fill(attrs, attsValue);
          }`), indent));
      }
    }
    return code;
  }

  _compileAllAttributes(el: xmldom.Element, options: {} = {}, indent?: number, attrAlreadyCreated?: boolean) {
    const code = [];
    if (Array.from<any>(el.attributes).some(a => a.name.startsWith('t-att') || !a.name.startsWith('t-'))) {
      if (!attrAlreadyCreated) {
        attrAlreadyCreated = true;
        code.push(this._indent("attrs = {};", indent));
      }
      extend(code, this._compileStaticAttributes(el, options, indent));
      extend(code, this._compileDynamicAttributes(el, options, indent));
    }
    if (attrAlreadyCreated) {
      code.push(this._indent(`tagName = ${repr(el.tagName)};`, indent));
      extend(code, this._compileAttributes(options, indent));
    }
    return code;
  }

  _compileTagOpen(el: xmldom.Element, options: {} = {}, indent?: any, attrAlreadyCreated?: boolean) {
    const extraAttrib = {};
    let unqualifiedElTag, elTag;
    if (!len(el._nsMap)) {
      unqualifiedElTag = elTag = el.localName;
    }
    else {
      // Etree will remove the ns prefixes indirection by inlining the corresponding
      // nsmap definition into the tag attribute. Restore the tag and prefix here.
      // Note: we do not support namespace dynamic attributes, we need a default URI
      // on the root and use attribute directive t-att="{'xmlns:example': value}".
      unqualifiedElTag = el.localName;
      elTag = el.tagName;

      // If `el` introduced new namespaces, write them as attribute by using the
      // `extraAttrib` dict.
      for (const [nsPrefix, nsDefinition] of Object.entries(_subNsmap(el._nsMap, options['nsmap']))) {
        if (nsPrefix == null) {
          extraAttrib['xmlns'] = nsDefinition;
        }
        else {
          extraAttrib[`xmlns:${nsPrefix}`] = nsDefinition;
        }
      }
    }
    const code = [];
    if (unqualifiedElTag !== 't') {
      const attributes = Object.entries<any>(extraAttrib).map(([name, value]) => ` ${String(name)}="${String(_.escape(this._compileToStr(value)))}"`).join('');
      this._appendText(format("<%s%s", elTag, attributes), options);
      extend(code, this._compileAllAttributes(el, options, indent, attrAlreadyCreated));
      if (this._voidElements.has(unqualifiedElTag)) {
        this._appendText('/>', options);
      }
      else {
        this._appendText('>', options);
      }
    }
    return code;
  }

  _compileTagClose(el: xmldom.Element, options: {} = {}, indent?: any) {
    let unqualifiedElTag, elTag;
    if (!len(el._nsMap))
      unqualifiedElTag = elTag = el.localName;
    else {
      unqualifiedElTag = el.localName;
      elTag = el.tagName;
    }
    if (unqualifiedElTag !== 't' && !this._voidElements.has(elTag)) {
      this._appendText(`</${elTag}>`, options);
    }
    return [];
  }

  /**
   * Compile the given element into javascript.

    The t-* attributes (directives) will be converted to a javascript instruction. If there
    are no t-* attributes, the element will be considered static.

    Directives are compiled using the order provided by the
    ``_directivesEvalOrder`` method (an create the
    ``options['iterDirectives']`` iterator).
    For compilation, the directives supported are those with a
    compilation method ``_compileDirective_*``

    * @param el 
    * @param _options 
    * @param indent 
    * @returns list of string
    */
  async _compileNode(el: Element, options: {} = {}, indent?: number): Promise<string[]> {
    // if tag don't have qweb attributes don't use directives
    if (this._isStaticNode(el, options)) {
      return this._compileStaticNode(el, options, indent);
    }

    if (options['raiseOnCode']) {
      throw new QWebCodeFound();
    }

    let body;
    const path = xml.getpath(el, options['root']);
    if (options['lastPathNode'] !== path) {
      options['lastPathNode'] = path;
      body = [this._indent(`log["lastPathNode"] = ${repr(path)};`, indent)];
    }
    else {
      body = [];
    }

    // create an iterator on directives to compile in order
    options['iterDirectives'] = iter(this._directivesEvalOrder().concat([null]));
    el.setAttribute('t-tag', el.localName);
    if (!(_.intersection(['t-out', 't-esc', 't-raw', 't-field'], Array.from<Attr>(el.attributes).map(a => a.name)).length)) {
      if (!el.hasAttribute('t-content')) {
        el.setAttribute('t-content', 'true');
      }
    }

    return body.concat(await this._compileDirectives(el, options, indent));
  }

  async _compileDirectives(el: Element, options: {} = {}, indent?: number) {
    if (this._isStaticNode(el, options)) {
      el.removeAttribute('t-tag');
      el.removeAttribute('t-content');
      return this._compileStaticNode(el, options, indent);
    }
    // compile the first directive present on the element
    const elAttributeNames = Array.from(el.attributes).map(a => a.name);
    for (const directive of options['iterDirectives']) {
      if (elAttributeNames.includes('t-' + directive)) {
        return this._compileDirective(el, options, directive, indent);
      }
    }

    return [];
  }

  /**
   * Compile a purely static element into a list of string.
   * @param el 
   * @param options 
   * @param indent 
   */
  async _compileStaticNode(el: any, options: {} = {}, indent?: number) {
    if (!xml.isElement(el)) {
      return;
    }
    let unqualifiedElTag, elTag, attrib, originalNsmap;
    if (!len(el._nsMap)) {
      /**
       * prefix = 'cus'
       * localName = 'Customer'
       * nodeName = 'cus:Customer'
       * tagName = 'cus:Customer'
       */
      unqualifiedElTag = elTag = el.localName;
      attrib = {};
      for (const attr of Array.from<Attr>(el.attributes)) {
        if (xml.isAttribute(attr)) {
          attrib[attr.name] = attr.value;
        }
      }
      attrib = await this._postProcessingAttr(el.localName, attrib, options);
    }
    else {
      unqualifiedElTag = el.localName;
      elTag = unqualifiedElTag;
      if (el.prefix) {
        elTag = `${el.prefix}:${elTag}`;
      }
      attrib = {};
      const nsmap = _subNsmap(el._nsMap, options['nsmap'] ?? {});
      for (const [nsPrefix, nsDefinition] of Object.entries(nsmap)) {
        if (nsPrefix == null) {
          attrib['xmlns'] = nsDefinition;
        }
        else {
          attrib[`xmlns:${nsPrefix}`] = nsDefinition;
        }
      }

      const ns = chain(Object.entries(options['nsmap']), Object.entries(el._nsMap));
      const nsprefixmap = {};
      for (const [k, v] of ns) {
        nsprefixmap[v] = k;
      }
      for (const attr of Array.from<Attr>(el.attributes)) {
        if (xml.isAttribute(attr)) {
          if (attr.namespaceURI) {
            attrib[`${nsprefixmap[attr.namespaceURI]}:${attr.localName}`] = attr.value;
          }
          else {
            attrib[attr.name] = attr.value;
          }
        }
      }
      attrib = await this._postProcessingAttr(el.localName, attrib, options);
      originalNsmap = Dict.from(options['nsmap']);
    }

    if (unqualifiedElTag !== 't') {
      const attributes = Object.entries(attrib)
        .filter(([name, value]) => value || typeof (value) === 'string')
        .map(([name, value]) => ` ${name}="${_.escape(String(value))}"`)
        .join('');
      this._appendText(`<${elTag}${attributes}`, options);
      if (this._voidElements.has(unqualifiedElTag)) {
        this._appendText('/>', options);
      }
      else {
        this._appendText('>', options);
      }
    }
    let body;
    if (len(el._nsMap)) {
      Object.assign(options['nsmap'], el._nsMap);
      body = await this._compileDirectiveContent(el, options, indent);
      options['nsmap'] = originalNsmap;
    }
    else {
      body = await this._compileDirectiveContent(el, options, indent);
    }

    if (unqualifiedElTag !== 't') {
      if (!this._voidElements.has(unqualifiedElTag)) {
        this._appendText(`</${elTag}>`, options);
      }
    }

    return body;
  }

  // compile directives
  async _compileDirective(el: xmldom.Element, options: {}, directive: any, indent: number = 0) {
    const name = `_compileDirective${UpCamelCase(directive.replace('-', '_'))}`;
    const compileHandler = this[name];
    if (compileHandler) {
      return compileHandler.apply(this, [el, options, indent]);
    }
    throw new ValueError(el);
  }

  async _compileDirectiveDebug(el: xmldom.Element, options: {}, indent: number = 0): Promise<any> {
    const _debugger = xml.popAttribute(el, 't-debug');
    const code = [];
    if (options['devMode']) {
      code.push(this._indent(`self._debugTrace(${repr(_debugger)}, compileOptions)`, indent));
    }
    else {
      console.warn("@t-debug in template is only available in qweb dev mode options");
    }
    extend(code, await this._compileDirectives(el, options, indent));
    return code;
  }

  /**
   * compile t-options and add to the dict the t-options-xxx values
   * @param el 
   * @param options 
   * @param indent 
   * @returns 
   */
  async _compileDirectiveOptions(el: xmldom.Element, options: {}, indent: number = 0): Promise<any> {
    const varname = options['tOptionsVarname'] ?? 'tOptions';
    const code = [];
    const dictArg = [];
    for (const key of Object.keys(el.attributes)) {
      if (key.startsWith('t-options-')) {
        const value = xml.popAttribute(el, key);
        const optionName = key.slice(10);
        dictArg.push(`${repr(optionName)}: ${this._compileExpr(value)}`);
      }
    }
    const tOptions = xml.popAttribute(el, 't-options');
    if (len(tOptions) && len(dictArg)) {
      code.push(this._indent(`${varname} = ${[...(new Set([this._compileExpr(tOptions), dictArg.join(', ')]))]}`), indent);
    }
    else if (len(dictArg)) {
      code.push(this._indent(`${varname} = ${dictArg.join(', ')}`, indent));
    }
    else if (len(tOptions)) {
      code.push(this._indent(`${varname} = ${this._compileExpr(tOptions)}`, indent));
    }

    return code;
  }

  async _compileDirectiveTag(el: xmldom.Element, options: {}, indent: number = 0): Promise<any> {
    el.removeAttribute('t-tag');

    const code = this._compileTagOpen(el, options, indent, false);

    // Update the dict of inherited namespaces before continuing the recursion. Note:
    // since `options['nsmap']` is a dict (and therefore mutable) and we do **not**
    // want changes done in deeper recursion to bevisible in earlier ones, we'll pass
    // a copy before continuing the recursion and restore the original afterwards.
    if (len(el._nsMap)) {
      extend(code, await this._compileDirectives(el, Object.assign({}, { ...options, nsmap: el._nsMap }, indent)));
    }
    else {
      extend(code, await this._compileDirectives(el, options, indent));
    }

    extend(code, this._compileTagClose(el, options));

    return code;
  }

  async _compileDirectiveSet(el: xmldom.Element, options: {}, indent: number = 0): Promise<any> {
    const varname = xml.popAttribute(el, 't-set');
    let code = this._flushText(options, indent);
    let expr;
    if (el.getAttribute('t-value')) {
      if (varname === '0') {
        throw new ValueError('t-set="0" should not contains t-value or t-valuef');
      }
      expr = xml.popAttribute(el, 't-value', null);
      expr = this._compileExpr(expr);
    }
    else if (el.getAttribute('t-valuef')) {
      if (varname === '0') {
        throw new ValueError('t-set="0" should not contains t-value or t-valuef');
      }
      const exprf = xml.popAttribute(el, 't-valuef');
      expr = this._compileFormat(exprf);
    }
    else {
      // set the content as value
      const defName = `qwebTSet_${options['lastPathNode'].replace(_VARNAME_REGEX, '_')}`;
      const defValue = defName + '_value';
      const content = (await this._compileDirectiveContent(el, options, indent + 1)).concat(this._flushText(options, indent + 1));
      if (content) {
        code.push(this._indent(`async function* ${defName}() {`, indent));
        extend(code, content);
        code.push(this._indent(`}`, indent));
        code.push(this._indent(`let ${defValue} = '';`, indent));
        code.push(this._indent(`for await (const val of ${defName}()) ${defValue} += val;`, indent));
        expr = `markup(${defValue});`;
      }
      else {
        expr = "''";
      }
    }

    code.push(this._indent(`values[${repr(varname)}] = ${expr};`, indent));
    return code;
  }

  async _compileDirectiveContent(el: xmldom.Element, options: {}, indent: any): Promise<any> {
    const content = [];
    for (const item of Array.from<any>(el.childNodes)) {
      if (xml.isComment(item)) {
        if (this.env?.context['preserveComments']) {
          this._appendText(format("<!--%s-->", item.textContent), options);
        }
      }
      else if (xml.isText(item)) {
        this._appendText(item.textContent, options);
      }
      else {
        extend(content, await this._compileNode(item, options, indent));
      }
    }
    return content;
  }

  async _compileDirectiveElse(el: xmldom.Element, options: {}, indent: number = 0): Promise<any> {
    if (xml.popAttribute(el, 't-else') === 'tSkipElse') {
      return [];
    }
    const tIf = options['tIf'] ?? null; delete options['tIf'];
    if (!tIf) {
      throw new ValueError("t-else directive must be preceded by t-if directive");
    }
    const compiled = await this._compileDirectives(el, options, indent);
    el.setAttribute('t-else', 'tSkipElse');
    return compiled;
  }

  async _compileDirectiveElif(el: xmldom.Element, options: {}, indent: number = 0): Promise<any> {
    const elif = el.getAttribute('t-elif');
    if (elif === 'tSkipElse') {
      el.removeAttribute('t-elif');
      return [];
    }
    const tIf = options['tIf'] ?? null; delete options['tIf'];
    if (!tIf) {
      throw new ValueError("t-elif directive must be preceded by t-if directive");
    }
    const compiled = await this._compileDirectiveIf(el, options, indent);
    el.setAttribute('t-elif', 'tSkipElse');
    return compiled;
  }

  async _compileDirectiveIf(el: Element, options: {}, indent: number = 0): Promise<any> {
    if (isNaN(indent)) {
      indent = 0;
    }
    let expr;
    if (el.getAttribute('t-elif')) {
      expr = xml.popAttribute(el, 't-elif');
    }
    else {
      expr = xml.popAttribute(el, 't-if');
    }

    const code = this._flushText(options, indent);
    const contentIf = (await this._compileDirectives(el, options, indent + 1)).concat(this._flushText(options, indent + 1));

    let orelse = [];
    let nextEl: any = el.nextSibling;
    const commentsToRemove = [];
    while (xml.isComment(nextEl) || xml.isText(nextEl)) {
      if (xml.isComment(nextEl)) {
        commentsToRemove.push(nextEl);
      }
      nextEl = nextEl?.nextSibling;
    }
    if (nextEl && nextEl.attributes && _.intersection(Array.from<Attr>(nextEl.attributes).map(attr => attr.name), ['t-else', 't-elif']).length) {
      const parent = el.parentNode;
      for (const comment of commentsToRemove) {
        parent.removeChild(comment);
      }
      if (xml.isText(nextEl) && !nextEl.data.trim()) {
        throw new ValueError("Unexpected non-whitespace characters between t-if and t-else directives");
      }
      nextEl.data = null;
      orelse = (await this._compileNode(nextEl, Object.assign(options, { tIf: true }), indent + 1)).concat(this._flushText(options, indent + 1));
    }
    code.push(this._indent(`if (${this._compileExpr(expr)}) {`, indent));
    extend(code, contentIf || [this._indent('', indent + 1)]);
    code.push(this._indent(`}`, indent));
    if (len(orelse)) {
      code.push(this._indent("else {", indent));
      extend(code, orelse);
      code.push(this._indent("}", indent));
    }
    return code;
  }

  /**
   * Compile `t-foreach` expressions into a javascript code as a list of
    strings.

    `t-as` is used to define the key name.
    `t-foreach` compiled value can be an iterable, an dictionary or a
    number.

    The code will contain loop `for` that wrap the rest of the compiled
    code of this element.
    Some key into values dictionary are create automatically:
        *_size, *_index, *_value, *_first, *_last, *_odd, *_even, *_parity
   * @param el 
   * @param options 
   * @param indent 
   */
  async _compileDirectiveForeach(el: xmldom.Element, options: {}, indent: number = 0): Promise<any> {
    const exprForeach = xml.popAttribute(el, 't-foreach');
    const exprAs = xml.popAttribute(el, 't-as');

    let code = this._flushText(options, indent);
    let contentForeach = await this._compileDirectives(el, options, indent + 1);
    extend(contentForeach, this._flushText(options, indent + 1));
    // return code;
    const tForeach = this._makeName('t_foreach');
    const size = this._makeName('size');
    const hasValue = this._makeName('hasValue');

    if (isDigit(exprForeach)) {
      code.push(this._indent(dedent(`
        let ${size} = ${parseInt(exprForeach)};
        values[${repr(exprAs + '_size')}] = ${size};
        const ${tForeach} = range(${size});
        const ${hasValue} = false;
      `).trim(), indent))
    }
    else {
      code.push(this._indent(dedent(`
        let ${size};
        let ${tForeach} = ${await this._compileExpr(exprForeach)} ?? [];
        if (typeof(${tForeach}) === 'number') {
          ${size} = ${tForeach};
          values[${repr(exprAs + '_size')}] = ${size};
          ${tForeach} = range(${size});
        }
        else if ('_length' in ${tForeach}) {
          ${size} = ${tForeach}._length;
          values[${repr(exprAs + '_size')}] = ${size};
        }
        else if ('length' in ${tForeach}) {
          ${size} = ${tForeach}.length;
          values[${repr(exprAs + '_size')}] = ${size};
        }
        else if ('size' in ${tForeach}) {
          ${size} = ${tForeach}.size;
          values[${repr(exprAs + '_size')}] = ${size};
        }
        else {
          ${size} = null;
        }
        let ${hasValue} = false;
        if (${tForeach} instanceof Map || ${tForeach} instanceof MapKey) {
          ${tForeach} = ${tForeach}.entries();
          ${hasValue} = true;
        }
        if (typeof ${tForeach} === 'object' && !isIterable(${tForeach})) {
          ${tForeach} = Object.entries(${tForeach});
          ${hasValue} = true;
        }
      `), indent))
    }
    code.push(this._indent(dedent(`
      for (const [index, item] of enumerate(${tForeach})) {
        values[${repr(exprAs + '_index')}] = index;
        if (${hasValue}) {
          [values[${repr(exprAs)}], values[${repr(exprAs + '_value')}]] = item;
        }
        else {
          values[${repr(exprAs)}] = item;
          values[${repr(exprAs + '_value')}] = item;
        }
        values[${repr(exprAs + '_first')}] = values[${repr(exprAs + '_index')}] == 0;
        if (${size} != null) {
          values[${repr(exprAs + '_last')}] = index + 1 === ${size};
        }
        values[${repr(exprAs + '_odd')}] = index % 2;
        values[${repr(exprAs + '_even')}] = ! values[${repr(exprAs + '_odd')}];
        values[${repr(exprAs + '_parity')}] = values[${repr(exprAs + '_odd')}] ? 'odd' : 'even';
    `), indent));
    // inside statement "for"
    code.push(this._indent(`log["lastPathNode"] = ${repr(xml.getpath(el, options["root"]))};`, indent + 1));
    extend(code, contentForeach || this._indent('continue', indent + 1));
    // close statement "for"
    code.push(this._indent(`}`, indent));

    return code;
  }

  async _compileDirectiveOut(el: xmldom.Element, options: {}, indent: number = 0): Promise<any> {
    let ttype = 't-out';
    let expr = xml.popAttribute(el, 't-out', null);
    if (expr == null) {
      // deprecated use.
      ttype = 't-esc';
      expr = xml.popAttribute(el, 't-esc', null);
      if (expr == null) {
        ttype = 't-raw';
        expr = xml.popAttribute(el, 't-raw');
      }
    }
    const code = this._flushText(options, indent);
    options['tOptionsVarname'] = 'tOutTOptions';
    const codeOptions = await this._compileDirective(el, options, 'options', indent)
    extend(code, codeOptions)

    if (expr === "0") {
      if (len(codeOptions)) {
        code.push(this._indent("content = markup(Array.from(values['0'] || []).join(''));", indent));
      }
      else {
        extend(code, this._compileTagOpen(el, options, indent));
        extend(code, this._flushText(options, indent));
        code.push(this._indent("for (const str of Array.from(values['0'] || [])) yield str;", indent));
        extend(code, this._compileTagClose(el, options));
        return code;
      }
    }
    else
      code.push(this._indent(`content = ${this._compileExpr(expr)};`, indent));

    if (len(codeOptions)) {
      code.push(this._indent(`result = await self._getWidget(content, ${repr(expr)}, ${repr(el.tagName)}, tOutTOptions, compileOptions, values);`, indent));
      code.push(this._indent("[attrs, content, forceDisplay] = result;", indent));
    }
    else {
      code.push(this._indent("forceDisplay = null;", indent));

      if (ttype === 't-raw') {
        // deprecated use.
        code.push(this._indent(dedent(`
          if (content != null && content !== false) content = markup(content);
        `), indent));
      }
    }
    extend(code, await this._compileWidgetValue(el, options, indent, !len(codeOptions)));
    return code;
  }

  async _compileDirectiveEsc(el: xmldom.Element, options: {}, indent: number = 0): Promise<any> {
    if (options['devMode'])
      console.warn(
        "Found deprecated directive @t-esc=%s in template %s. Replace by @t-out",
        el.getAttribute('t-esc'),
        options['ref'] || '<unknown>',
      );
    return this._compileDirectiveOut(el, options, indent);
  }

  async _compileDirectiveRaw(el: xmldom.Element, options: {}, indent: number = 0): Promise<any> {
    // deprecated use.
    console.warn(
      `Found deprecated directive @t-raw=%s in template %s. Replace by @t-out, and explicitely wrap content in 'markup' if necessary (which likely is not the case)`,
      el.getAttribute('t-raw'),
      options['ref'] || '<unknown>'
    );
    return this._compileDirectiveOut(el, options, indent);
  }

  /**
   * Compile `t-field` expressions into a javascript code as a list of
    strings.

    The compiled code will call ``_getField`` method at rendering time
    using the type of value supplied by the field. This behavior can be
    changed with `t-options-widget` or `t-options={'widget': ...}.

    The code will contain evalution and rendering of the compiled value
    value from the record field. If the compiled value is None or false,
    the tag is not added to the render
    (Except if the widget forces rendering or there is default content.).
   * @param el 
   * @param options 
   * @param indent 
   * @returns 
   */
  async _compileDirectiveField(el: xmldom.Element, options: {}, indent: number = 0): Promise<any> {
    const tagName = el.tagName;
    assert(!["table", "tbody", "thead", "tfoot", "tr", "td", "li", "ul", "ol", "dl", "dt", "dd"].includes(tagName),
      `RTE widgets do not work correctly on ${tagName} elements`);
    assert(tagName !== 't',
      "t-field can not be used on a t element, provide an actual HTML node");
    assert(el.getAttribute('t-field').includes('.'),
      "t-field must have at least a dot like 'record.fieldName'");

    const expression = xml.popAttribute(el, 't-field');
    let [record, dot, fieldName] = rstringPart(expression, '.');
    // expression = "partner.countryId.stateId.label" 
    //   => record = "partner.countryId.stateId"
    //   => fieldName = "label"
    // change record => "await (await partner.countryId).stateId"
    if (!record.includes('await')) { // Fixing await
      const list = record.split('.');
      let obj = list.shift();
      for (const name of list) {
        obj = `(await ${obj}.${name})`;
      }
      record = obj;
    }
    const code = [];
    options['tOptionsVarname'] = 'tFieldTOptions';
    let codeOptions = await this._compileDirective(el, options, 'options', indent);
    if (!bool(codeOptions)) codeOptions = [this._indent("tFieldTOptions = {};", indent)];
    extend(code, codeOptions);
    code.push(this._indent(`result = await self._getField(${this._compileExpr(record, true)}, ${repr(fieldName || '')}, ${repr(expression)}, ${repr(tagName)}, tFieldTOptions, compileOptions, values);`, indent));
    code.push(this._indent("[attrs, content, forceDisplay] = result;", indent));
    code.push(this._indent("if (content != null && bool(content) !== false) {", indent));
    code.push(this._indent("content = await self._compileToStr(content);", indent + 1));
    code.push(this._indent("}", indent));
    extend(code, await this._compileWidgetValue(el, options, indent));
    return code;
  }

  /**
   * Take care of part of the compilation of `t-out` and `t-field` (and
        the technical directive `t-tag). This is the part that takes care of
        whether or not created the tags and the default content of the element.
   * @param el 
   * @param options 
   * @param indent 
   * @param without_attributes 
   */
  async _compileWidgetValue(el: xmldom.Element, options: {}, indent: number = 0, withoutAttributes = false) {
    xml.popAttribute(el, 't-tag', null);

    const code = this._flushText(options, indent);
    code.push(this._indent("if (content != null && bool(content) !== false) {", indent));
    extend(code, this._compileTagOpen(el, options, indent + 1, !withoutAttributes));
    extend(code, this._flushText(options, indent + 1));
    code.push(this._indent("yield String(content);", indent + 1));
    extend(code, this._compileTagClose(el, options));
    extend(code, this._flushText(options, indent + 1));

    const defaultBody = await this._compileDirectiveContent(el, options, indent + 1);
    if (len(defaultBody) || options['_textConcat']) {
      // default content
      const _textConcat = Array.from(options['_textConcat']);
      options['_textConcat'] = [];
      code.push(this._indent("}", indent));
      code.push(this._indent("else {", indent));
      extend(code, this._compileTagOpen(el, options, indent + 1, !withoutAttributes));
      extend(code, this._flushText(options, indent + 1));
      extend(code, defaultBody);
      extend(options['_textConcat'], _textConcat);
      extend(code, this._compileTagClose(el, options));
      extend(code, this._flushText(options, indent + 1));
      code.push(this._indent("}", indent));
    }
    else {
      code.push(this._indent("}", indent));
      const content = this._compileTagOpen(el, options, indent + 1, !withoutAttributes)
        .concat(this._compileTagClose(el, options))
        .concat(this._flushText(options, indent + 1));
      if (len(content)) {
        code.push(this._indent("else if (forceDisplay) {", indent));
        extend(code, content);
        code.push(this._indent("}", indent));
      }
    }

    return code;
  }

  /**
   * Compile `t-call` expressions into a javascript code as a list of
        strings.

        `t-call` allow formating string dynamic at rendering time.
        Can use `t-options` used to call and render the sub-template at
        rendering time.
        The sub-template is called with a copy of the rendering values
        dictionary. The dictionary contains the key 0 coming from the
        compilation of the contents of this element

        The code will contain the call of the template and a function from the
        compilation of the content of this element.
   * @param el 
   * @param options 
   * @param indent 
   * @returns 
   */
  async _compileDirectiveCall(el: xmldom.Element, options: {}, indent: number = 0): Promise<any> {
    const expr = xml.popAttribute(el, 't-call');

    const nsmap = options['nsmap'];

    const code = this._flushText(options, indent);
    options['tOptionsVarname'] = 'tCallTOptions';
    const codeOptions = await this._compileDirective(el, options, 'options', indent) || [this._indent('const tCallTOptions = {}', indent)];
    extend(code, codeOptions);

    const defName = 'tCallContent';
    const content = await this._compileDirectiveContent(el, options, indent + 1);
    if (content.length && !options['_textConcat']) {
      this._appendText('', options);
    }
    extend(content, this._flushText(options, indent + 1));
    if (content.length) {
      code.push(this._indent('{', indent));
      code.push(this._indent(`async function* ${defName}(self, values, log) {`, indent));
      extend(code, content);
      code.push(this._indent('}', indent));
      code.push(this._indent("tCallValues = Object.assign({},  values);", indent));
      code.push(this._indent("let res = '';", indent));
      code.push(this._indent(`for await (const str of ${defName}(self, tCallValues, log)) `, indent));
      code.push(this._indent(`res = res + str;`, indent + 1));
      code.push(this._indent(`tCallValues['0'] = markup(res)`, indent));
      code.push(this._indent('}', indent));
    } else {
      code.push(this._indent("tCallValues = Object.assign({}, values);", indent));
      code.push(this._indent("tCallValues['0'] = markup('');", indent));
    }

    code.push(this._indent(dedent(`
      tCallOptions = Object.assign({}, compileOptions);
      Object.assign(tCallOptions, {'callerTemplate': ${repr(String(options['template']))}, 'lastPathNode': ${repr(String(xml.getpath(el, options['root'])))} })
    `).trim(), indent));
    if (len(nsmap)) {
      const nsmap = []
      for (const [key, value] of Object.entries<any>(options['nsmap'])) {
        if (typeof (key) === 'string') {
          nsmap.push(`${repr(key)}:${repr(value)}`);
        }
        else {
          nsmap.push(`[null]:${repr(value)}`);
        }
      }
      code.push(this._indent(`Object.assign(tCallOptions, {nsmap: {${nsmap.join(', ')}}});`, indent));
    }

    const template = this._compileFormat(expr);

    if (len(codeOptions)) {
      code.push(this._indent("Object.assign(tCallOptions, tCallTOptions);", indent));
      code.push(this._indent(dedent(`
        if (compileOptions['lang'] !== tCallOptions['lang']) {
          const selfLang = await self.withContext({lang: tCallOptions['lang']});
          for await (const val of (await selfLang._compile(request, ${template}, tCallOptions))(selfLang, tCallValues)) {
            yield val;
          }
        }
        else {
          for await (const val of (await self._compile(${template}, tCallOptions))(self, tCallValues)) {
            yield val;
          }
        }
      `).trim(), indent));
    } else {
      code.push(this._indent(`for await (const val of (await self._compile(${template}, tCallOptions))(self, tCallValues)) {
        yield val;
      }`, indent));
    }

    return code;
  }

  /**
   * Compile the given template into a rendering function (generator)::
        render(qweb, values)
    where ``qweb`` is a QWeb instance and ``values`` are the values to render.
   * @param idOrXmlid 
   * @param options 
   */
  async _compile(template: any, options: {} = {}) {
    let [element, document, ref] = await this._getTemplate(template, options);
    if (!ref) {
      ref = element.getAttribute('t-name') || String(document);
    }
    // console.log(`build template ${template} # ${ref}`);
    // reference to get xml and etree (usually the template ID)
    options['ref'] = ref;
    // str xml of the reference template used for compilation. Useful for debugging, dev mode and profiling.
    options['refXml'] = typeof (document) === 'string' ? document : String(document);//, 'utf-8')

    const _options = Dict.from(options);
    options = new FrozenDict<any>(options);

    // Initial template value send to render method (not in the froozen dict because it may be
    // different from one render to another. Indeed, it may be the view ID or the key)
    _options['template'] = template;
    // Root of the etree which will be processed during compilation.
    _options['root'] = xml.getrootXml(element);

    // Reference to the last node being compiled. It is mainly used for debugging and displaying
    // error messages.
    _options['lastPathNode'] = null;

    if (!options['nsmap']) {
      _options['nsmap'] = {};
    }

    // generate code

    const defName = typeof (ref) === 'number' ? `template${UpCamelCase(String(ref))}` : "template";
    let codeLines;
    try {
      _options['_textConcat'] = [];
      this._appendText("", _options); // To ensure the template function is a generator and doesn't become a regular function
      codeLines = await this._compileNode(element, _options, 1);
      codeLines = codeLines.concat(this._flushText(_options, 1));
    } catch (e) {
      if (isInstance(e, QWebException))
        throw e;
      if (isInstance(e, QWebCodeFound))
        throw e;
      else
        throw new QWebException("Error when _compileNode xml template", this, options, e, { template: template, path: _options['lastPathNode'] });
    }

    const wrapFuncOpen = [
      `async function* ${defName}(self, values, log={}) {`,
      `    let result, attrs, tagName, forceDisplay, content, tCallValues, tCallOptions, renderTemplate, tFieldTOptions, tCallAssetsNodes;`,
      `    try {`,
      `        // _debug(String(${defName}.name)); // detail code`,
    ];
    // codeLines here
    const wrapFuncClose = [
      `    } catch(e) {`,
      `        _debug('Error in %s at %s: %s', '${defName}', log["lastPathNode"], e);`,
      `        _debug(String(${defName})); // detail code`,
      `        throw e;`,
      `    }`,
      `}`
    ];
    const code = _joinCode([
      wrapFuncOpen,
      codeLines,
      wrapFuncClose
    ]);

    // compile code and defined default values
    let compiled, compiledFn;
    try {
      compiled = compile(code, `<${defName}>`, 'exec');
      const globalsDict = this._prepareGlobals({}, options);
      compiledFn = unsafeEval(compiled, globalsDict); // Tony must check and changse to safeEval
      compiledFn = compiledFn ?? ((self, values, log) => values);
    } catch (e) { // e.name === 'SyntaxError'
      if (isInstance(e, QWebException)) {
        throw e;
      }
      else {
        throw new QWebException("Error when compile/eval xml template: %s\n%s", this, options, e, { template: template });
      }
    }
    // return the wrapped function

    async function* renderTemplate(self, values) {
      let log, line = wrapFuncOpen.length;
      try {
        log = { 'lastPathNode': null }
        values = self._prepareValues(values, options);
        for await (const val of compiledFn(self, values, log)) {
          line++;
          yield val;
        }
      } catch (e) {
        if (isInstance(e, QWebException)) {//, TransactionRollbackError))
          throw e;
        }
        else {
          throw new QWebException(`Error when render the template:`, this, options, e, { template: template, path: log['lastPathNode'], line: line });
        }
      }
    }

    return renderTemplate;
  }

  async _render(template: any, values: {} = {}, options: {} = {}) {
    if (values && 0 in values) {
      throw new ValueError('values[0] should be unset when call the _render method and only set into the template.');
    }

    const renderTemplate = await this._compile(template, options);
    const rendering = renderTemplate(this, values);
    let result = '';
    for await (const str of rendering) {
      result = result + str;
    }
    return result;

    /** test
    const arch = await template.archDb;
    const doc = arch ? xml.serializeHtml(xml.documentFromString(arch)) : `<html><body><h1>QWEB TEMPLATE</h1>Body here</body></html>`;
    return doc;
     */
  }

  /**
   * Load a given template and return a tuple ``[xml, ref]``` 
   * @param template 
   * @param options 
   * @returns 
   */
  async _load(template?: any, options: {} = {}): Promise<[any, number | null]> {
    return [template, null];
  }

  /**
   * Retrieve the given template, and return it as a tuple ``(etree,
    xml, ref)``, where ``element`` is an etree, ``document`` is the
    str document that contains ``element``, and ``ref`` if the uniq
    reference of the template (id, t-name or template).

    @param template template identifier, name or etree
    @param options used to compile the template (the dict available for
        the rendering is frozen)
        ``load`` (function) overrides the load method
   */
  async _getTemplate(template, options: {} = {}): Promise<[Element, string, string]> {
    let ref = template;
    let element: any;
    let document: any;
    if (xml.isDocument(template)) {
      element = (template as Document).documentElement;
      document = xml.serializeHtml(element);
      return [element, document, element.getAttribute('t-name')];
    }
    else if (xml.isElement(template)) {
      element = template as Element;
      document = xml.serializeHtml(element);
      return [element, document, element.getAttribute('t-name')];
    }
    else {
      try {
        const loaded = await (options['load'] ?? this._load).call(this, template, options);
        if (!loaded) {
          throw new ValueError("Can not load template '%s'", template);
        }
        [document, ref] = loaded;
      } catch (e) {
        if (isInstance(e, QWebException)) {
          throw e;
        }
        else {
          template = options['callerTemplate'] ?? template;
          console.log('_getTemplate could not load template', e);
          throw new QWebException("_getTemplate could not load template", this, options, e, { template: template });
        }
      }
    }

    if (document == null) {
      throw new QWebException("Template not found", this, options, new ValueError('Document is null'), { template: template });
    }

    if (xml.isElement(document)) {
      element = document;
      document = xml.serializeHtml(document);
    }
    else if (!document.trim().startsWith('<') && fs.existsSync(document))
      element = xml.getrootXml(xml.parseXml(document));
    else
      element = xml.getrootXml(xml.parseXml(document));

    for (const node of Array.from<Element>(element?.childNodes)) {
      if (xml.isElement(node) && node.getAttribute('t-name') === String(template)) {
        return [node, document, ref];
      }
    }
    return [element, document, ref];
  }

  /**
   * Method called at compile time to return the field value.

   * @param record 
   * @param fieldName 
   * @param expression 
   * @param tagName 
   * @param field_options 
   * @param options 
   * @param values 
   * @returns tuple
          * dict: attributes
          * string or null: content
          * boolean: forceDisplay display the tag if the content and defaultContent are None
   */
  async _getField(record, fieldName, expression, tagName, fieldOptions, options, values) {
    return this._getWidget(await record[fieldName], expression, tagName, fieldOptions, options, values);
  }

  /**
   * Method called at compile time to return the widget value.

   * @param value 
   * @param expression 
   * @param tagName 
   * @param fieldOptions 
   * @param options 
   * @param values 
   * @returns tuple:
          * dict: attributes
          * string or null: content
          * boolean: forceDisplay display the tag if the content and defaultContent are None
   */
  async _getWidget(value, expression, tagName, fieldOptions, options, values) {
    return [{}, value, false];
  }
}