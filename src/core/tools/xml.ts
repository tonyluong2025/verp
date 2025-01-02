import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { getattr } from '../api/func';
import { FrozenSet } from '../helper/collections';
import { ParseError, ValueError, XmlError } from '../helper/errors';
import { isBasestring, isObject } from './func';
import { extend, sorted } from './iterable';

export enum NodeType {
  ELEMENT_NODE = 1,
  ATTRIBUTE_NODE = 2,
  TEXT_NODE = 3,
  CDATA_SECTION_NODE = 4,
  ENTITY_REFERENCE_NODE = 5,
  ENTITY_NODE = 6,
  PROCESSING_INSTRUCTION_NODE = 7,
  COMMENT_NODE = 8,
  DOCUMENT_NODE = 9,
  DOCUMENT_TYPE_NODE = 10,
  DOCUMENT_FRAGMENT_NODE = 11,
  NOTATION_NODE = 12,
}

export const SKIPPED_ELEMENT_TYPES = [NodeType.COMMENT_NODE, NodeType.PROCESSING_INSTRUCTION_NODE, NodeType.TEXT_NODE];

function _parse(text: string, mimeType?: string, encoding?: string) {
  const mylocator = {};
  const parseLog = { errorLevel: 0 };

  function manageXmlParseError(msg, errorLevel, errorLog) {
    if ((errorLog.errorLevel == null) || (errorLog.errorLevel < errorLevel)) {
      errorLog.errorLevel = errorLevel;
    }
    if (errorLog[errorLevel.toString()] == null) {
      errorLog[errorLevel.toString()] = [];
    }
    errorLog[errorLevel.toString()].push(msg);
  }

  const domParser = new DOMParser({
    locator: mylocator,
    errorHandler: {
      warning: (msg) => { if (global._debug) console.warn('Warning parseXml: ' + msg); },
      error: (msg) => { manageXmlParseError(msg, 2, parseLog) },
      fatalError: (msg) => { manageXmlParseError(msg, 3, parseLog) },
    }
  });

  const dom = domParser.parseFromString(text, mimeType || 'text/xml');
  if (parseLog.errorLevel > 0) {
    const msg = 'Error parseXml(level=' + parseLog.errorLevel + '): \n' + text;
    const err = parseLog.errorLevel == 2
      ? new XmlError(msg)
      : new ParseError(msg);
    err.name = 'parseXml';
    err.stack = parseLog[parseLog.errorLevel].toString();
    console.log(err);
    throw err;
  }
  return dom as any as Element;
}

export function serializeXml(node, encoding?: string, prettyPrint?: boolean) {
  const ser = new XMLSerializer();
  return ser.serializeToString(node);
}

export function parseXml(text, encoding?: string): Element {
  return _parse(text, "text/xml").firstChild as Element;
}

export function parseHtml(text, encoding?: string): Element {
  return _parse(text, "text/html").firstChild as Element;
}

export function serializeHtml(node, encoding?: string) {
  return serializeXml(node);
}

export function getrootXml(de: Element) {
  if (!de.ownerDocument || (isProcessingInstruction(de) && de.tagName !== 'xml')) {
    throw new XmlError("Object is not XML data document with header %s", `<?xml version="1.0" encoding="utf-8"?>`);
  }
  if (!isElement(de)) {
    return de.ownerDocument.documentElement as Element;
  } else {
    let root = de;
    while (isElement(root.parentNode)) {
      root = root.parentNode as Element;
    }
    return root;
  }
}

export function getText(el: Element, defaultValue: string = ''): string {
  if (isText(el)) {
    return el.nodeValue;
  }
  if (!el) {
    return defaultValue;
  }
  let text;
  if (el.firstChild && isText(el.firstChild)) {
    text = el.firstChild;
  } else if (el.lastChild && isText(el.lastChild)) {
    text = el.lastChild;
  }
  return (text ? text.nodeValue : '') || defaultValue;
}

export function setText(el: any, text: string) {
  if (isText(el)) {
    el.replaceData(0, el.data.length, text);
  } else {
    let child;
    if (el.firstChild && isText(el.firstChild)) {
      child = el.firstChild;
    } else if (el.lastChild && isText(el.lastChild)) {
      child = el.lastChild;
    }
    child.replaceData(0, child.data.length, text);
  }
}

export function deleteText(el: any) {
  if (isText(el)) {
    el.deleteData(0, el.data.length);
  } else {
    let child;
    if (el.firstChild && isText(el.firstChild)) {
      child = el.firstChild;
    } else if (el.lastChild && isText(el.lastChild)) {
      child = el.lastChild;
    }
    child.deleteData(0, child.data.length);
  }
}

export function* iterancestors(el: Element) {
  while (el && isElement(el.parentNode)) {
    el = el.parentNode as Element;
    yield el;
  }
}

function _unquoteMatch(s: string, pos: number) {
  if (s.slice(0, 1) === '"' && s.slice(-1) === '"' || s.slice(0, 1) === "'" && s.slice(-1) === "'") {
    return [s.slice(1, -1), pos + 1];
  }
  else {
    return [s, pos];
  }
}

const _archiveRe = /[^ ]+/g;
const _parseMetaRefreshUrl = /[^;=]*;\s*(?:url\s*=\s*)?(?<url>.*)$/i;
const _iterCssUrls = new RegExp('url\((' + '["][^"]*["]|' + "['][^']*[']|" + '[^)]*)\)', 'i');

const linkAttrs = new FrozenSet([
  'action', 'archive', 'background', 'cite', 'classid',
  'codebase', 'data', 'href', 'longdesc', 'profile', 'src',
  'usemap',
  // Not standard:
  'dynsrc', 'lowsrc',
  // HTML5 formaction
  'formaction'
]);
/**
 * Yield (element, attribute, link, pos), where attribute may be None
  (indicating the link is in the text).  ``pos`` is the position
  where the link occurs; often 0, but sometimes something else in
  the case of links in stylesheets or style tags.

  Note: <base href> is *not* taken into account in any way.  The
  link you get is exactly the link in the document.

  Note: multiple links inside of a single text string or
  attribute value are returned in reversed order.  This makes it
  possible to replace or delete them from the text string value
  based on their reported text positions.  Otherwise, a
  modification at one text position can change the positions of
  links reported later on.
 * @param self 
 * @returns 
 */
export function* iterlinks(self: Element) {
  for (const elem of iterchildren(self, isElement)) {
    const el = elem as Element;
    const attribs = el.attributes;
    const tag = _nons(el.tagName);
    if (tag === 'object') {
      let codebase = null;
      // <object> tags have attributes that are relative to
      // codebase
      if ('codebase' in attribs) {
        codebase = el.getAttribute('codebase');
        yield [el, 'codebase', codebase, 0];
      }
      for (const attrib of ['classid', 'data']) {
        if (attrib in attribs) {
          let value = el.getAttribute(attrib);
          if (codebase != null) {
            value = urljoin(codebase, value);
          }
          yield [el, attrib, value, 0];
        }
      }
      if ('archive' in attribs) {
        for (const match of el.getAttribute('archive').matchAll(_archiveRe)) {
          let value = match[0];
          if (codebase != null) {
            value = urljoin(codebase, value);
          }
          yield [el, 'archive', value, match.index];
        }
      }
    }
    else {
      for (const attrib of linkAttrs) {
        if (attrib in attribs) {
          yield [el, attrib, el.getAttribute(attrib), 0];
        }
      }
    }
    if (tag === 'meta') {
      const httpEquiv = getAttribute(el, 'http-equiv', '').toLowerCase();
      if (httpEquiv === 'refresh') {
        const content = getAttribute(el, 'content', '');
        const value = content.matchAll(_parseMetaRefreshUrl).next().value;
        let url = (value ? value.groups['url'] : content).trim();
        // unexpected content means the redirect won't work, but we might
        // as well be permissive and return the entire string.
        if (url) {
          let pos;
          [url, pos] = _unquoteMatch(url, value ? value.startsWith('url') : content.indexOf(url));
          yield [el, 'content', url, pos];
        }
      }
    }
    else if (tag === 'param') {
      const valuetype = getAttribute(el, 'valuetype', '');
      if (valuetype.toLowerCase() === 'ref') {
        // http://www.w3.org/TR/html401/struct/objects.html#adef-valuetype
        yield [el, 'value', el.getAttribute('value'), 0];
      }
    }
    else if (tag === 'style' && el.textContent) {
      let urls =
        Array.from(el.textContent.matchAll(_iterCssUrls)).map(match => _unquoteMatch(match[1], match.index + 1)).reverse().concat(Array.from(el.textContent.matchAll(_iterCssUrls)).map(match => [match.index + 1, match[1]]));
      if (urls.length) {
        // sort by start pos to bring both match sets back into order
        // and reverse the list to report correct positions despite
        // modifications
        urls = sorted(urls, (item) => String(item), true);
        for (const [start, url] of urls) {
          yield [el, null, url, start];
        }
      }
    }
    if ('style' in attribs) {
      const urls = Array.from(el.getAttribute('style').matchAll(_iterCssUrls));
      if (urls.length) {
        // return in reversed order to simplify in-place modifications
        for (const match of urls.reverse()) {
          const [url, start] = _unquoteMatch(match[1], match.index + 1);
          yield [el, 'style', url, start];
        }
      }
    }
  }
}

export function iterchildren(el: Element, filter?: Function | string, reversed: boolean = false, ...tags: string[]): any[] {
  if (!el.childNodes) {
    return [];
  }
  let func;
  if (typeof (filter) === 'string') {
    func = (n) => getattr(n, 'tagName', null) === filter;
  } else if (typeof (filter) === 'function') {
    func = (n) => filter(n);
  }
  let res = Array.from<any>(el.childNodes);
  res = func ? res.filter(func) : res;
  res = reversed ? res.reverse() : res;
  return res;
}

export function iterdescendants(el: Element, filter?: Function | string, reversed: boolean = false, ...tags: string[]): any[] {
  if (el.hasChildNodes()) {
    const res = iterchildren(el, filter, reversed, ...tags);
    for (const child of Array.from<Element>(el.childNodes as any).filter(child => isElement(child))) {
      extend(res, iterchildren(child, filter, reversed, ...tags));
    }
    return res;
  }
  return [];
}

export function getpath(el: Element, root?: Element) {
  if (root == null) {
    root = el.ownerDocument.documentElement;
  }
  const paths = [];
  let _el = el;
  do {
    paths.push(_el)
    if (_el === root) {
      break;
    }
    _el = _el.parentNode as any;
  } while (_el);
  if (_el !== root) {
    throw new ValueError('Element is not in this tree');
  }
  let path = '';
  let _root = paths.pop();
  path = path + '/' + _root.localName;
  while (paths.length) {
    _el = paths.pop();
    path = path + '/' + _el.localName;
    const childMap = {};
    let index;
    for (const child of Array.from<any>(_root.childNodes ?? []).filter(child => isElement(child))) {
      childMap[child.tagName] = childMap[child.tagName] == null ? 0 : childMap[child.tagName] + 1;
      if (child === _el) {
        index = childMap[child.tagName];
        _root = child;
      }
    }
    if (childMap[_root.tagName]) {
      path = path + `[${index}]`;
    }
  }
  return path;
}

/**
 * #1
 * @param el 
 * @returns boolean
 */
export function isElement(el: any) {
  return el && el.nodeType === NodeType.ELEMENT_NODE // 1
}

/**
 * #2
 * @param el 
 * @returns boolean
 */
export function isAttribute(el: any) {
  return isObject(el) && el.nodeType === NodeType.ATTRIBUTE_NODE // 2
}

/**
 * #3
 * @param el 
 * @returns boolean
 */
export function isText(el: any) {
  return el && el.nodeType === NodeType.TEXT_NODE // 3
}

/**
 * #4
 * @param el 
 * @returns boolean
 */
export function isCData(el: any) {
  return el && el.nodeType === NodeType.CDATA_SECTION_NODE // 4
}

/**
 * #5
 * @param el 
 * @returns boolean
 */
export function isEntityReferenceNode(el: any) {
  return el && el.nodeType === NodeType.ENTITY_REFERENCE_NODE // 5
}

/**
 * #6
 * @param el 
 * @returns boolean
 */
export function isEntityNode(el: any) {
  return el && el.nodeType === NodeType.ENTITY_NODE // 7
}

/**
 * #7
 * @param el 
 * @returns boolean
 */
export function isProcessingInstruction(el: any) {
  return el && el.nodeType === NodeType.PROCESSING_INSTRUCTION_NODE // 7
}

/**
 * #8
 * @param el 
 * @returns boolean
 */
export function isComment(el: any) {
  return el && el.nodeType === NodeType.COMMENT_NODE // 8
}

/**
 * #9
 * @param el 
 * @returns boolean
 */
export function isDocument(el: any) {
  return el && el.nodeType === NodeType.DOCUMENT_NODE // 9
}

/**
 * #10
 * @param el 
 * @returns boolean
 */
export function isDocumentTypeNode(el: any) {
  return el && el.nodeType === NodeType.DOCUMENT_TYPE_NODE // 10
}

/**
 * #11
 * @param el 
 * @returns boolean
 */
export function isDocumentFragment(el: any) {
  return el && el.nodeType === NodeType.DOCUMENT_FRAGMENT_NODE // 11
}

/**
 * #12
 * @param el 
 * @returns boolean
 */
export function isNotationNode(el: any) {
  return el && el.nodeType === NodeType.NOTATION_NODE // 12
}

export function getAttributes(el: any, func: Function=(a)=>a) {
  return Array.from<Attr>(el?.attributes ?? []).filter(attr => isAttribute(attr) && func(attr));
}

export function firstChild(el: Element, func: Function=(a)=>a) {
  for (let i = 0; i < el.childNodes.length; i++) {
    const child = el.childNodes.item(i);
    if (func(child)) {
      return child;
    }
  };
  return null;
}

export function childNodes(el: Element, func: Function=(a)=>a) {
  return Array.from<any>(el?.childNodes ?? []).filter(child => func(child));
}

export function getObjectAttributes(el: any, func: Function=(a)=>a) {
  return Object.fromEntries(getAttributes(el, func).map(attr => [attr.name, attr.value]));
}

export function getAttribute(el: any, name: string, value?: any): string {
  if (el && el.hasAttribute && el.hasAttribute(name)) {
    return el.getAttribute(name) || value;
  }
  return value;
}

export function popAttribute(el: any, name: string, value?: any) {
  const attr = el.getAttribute(name);
  el.removeAttribute(name);
  return attr || value;
}

export function _elementName(el: Element) {
  if (isComment(el)) {
    return 'comment';
  }
  else if (isBasestring(el)) {
    return 'string';
  }
  else {
    return _nons(el.tagName);
  }
}

function serializeAttrs(attrs = {}) {
  const res = Object.entries<any>(attrs).map(([key, val]) => `${key}="${val}"`);
  if (res.length)
    return ' ' + res.join(' ');
  else
    return '';
}

export class ElementMaker {
  static field(value?: string | {}, attrs = {}, children?: Element[]) {
    return ElementMaker.withType('field', value, attrs, children);
  }

  static separator(value?: string | {}, attrs = {}, children?: Element[]) {
    return ElementMaker.withType('separator', value, attrs, children);
  }

  static newline(value?: string | {}, attrs = {}, children?: Element[]) {
    return ElementMaker.withType('newline', value, attrs, children);
  }

  static group(value?: string | {}, attrs = {}, children?: Element[]) {
    return ElementMaker.withType('group', value, attrs, children);
  }

  static record(value?: string | {}, attrs = {}, children?: Element[]) {
    return ElementMaker.withType('record', value, attrs, children);
  }

  static attribute(value?: string | {}, attrs = {}, children?: Element[]) {
    return ElementMaker.withType('attribute', value, attrs, children);
  }

  static xpath(value?: string | {}, attrs = {}, children?: Element[]) {
    return ElementMaker.withType('xpath', value, attrs, children);
  }

  static form(value?: string | {}, attrs = {}, children?: Element[]) {
    return ElementMaker.withType('form', value, attrs, children);
  }

  static tree(value?: string | {}, attrs = {}, children?: Element[]) {
    return ElementMaker.withType('tree', value, attrs, children);
  }

  static kanban(value?: string | {}, attrs = {}, children?: Element[]) {
    return ElementMaker.withType('kanban', value, attrs, children);
  }

  static graph(value?: string | {}, attrs = {}, children?: Element[]) {
    return ElementMaker.withType('graph', value, attrs, children);
  }

  static calendar(value?: string | {}, attrs = {}, children?: Element[]) {
    return ElementMaker.withType('calendar', value, attrs, children);
  }

  static sheet(value?: string | {}, attrs = {}, children?: Element[]) {
    return ElementMaker.withType('sheet', value, attrs, children);
  }

  static search(value?: string | {}, attrs = {}, children?: Element[]) {
    return ElementMaker.withType('search', value, attrs, children);
  }

  static pivot(value?: string | {}, attrs = {}, children?: Element[]) {
    return ElementMaker.withType('pivot', value, attrs, children);
  }

  static div(value?: string | {}, attrs = {}, children?: Element[]) {
    return ElementMaker.withType('div', value, attrs, children);
  }

  static withType(type: string, value?: string | {} | Element[], attrs?: {} | Element[], children?: Element[]) {
    if (Array.isArray(value)) {
      children = value as [];
      attrs = attrs;
      value = null;
    }
    else if (typeof value === 'object') {
      children = Array.isArray(attrs) ? attrs as [] : [];
      attrs = value;
      value = null;
    }
    const _children = [];
    for (const child of children ?? []) {
      if (child.ownerDocument) {
        _children.push(child);
      } else if (typeof (child) === 'object') {
        Object.assign(attrs, child);
      }
    }
    const elem = value != null
      ? parseXml(`<${type}${serializeAttrs(attrs)}>${value}</${type}>`)
      : parseXml(`<${type}${serializeAttrs(attrs)}/>`)
    for (const child of _children) {
      elem.appendChild(child.cloneNode(true));
    }
    return elem;
  }
}

export class ElementTree {

}

export const E = ElementMaker;

export function escapeHtml(unsafe: string) {
  return unsafe
    .replace('&', '&amp;')
    .replace('<', '&lt;')
    .replace('>', '&gt;')
    .replace('"', '&quot;')
    .replace("'", '&#039;');
}

export function unescapeHtml(htmlStr: string) {
  return htmlStr
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    ;
}

const XHTML_NAMESPACE = "http://www.w3.org/1999/xhtml"

export function _nons(tag: string) {
  if (isBasestring(tag)) {
    if (tag[0] === '{' && tag.slice(1, XHTML_NAMESPACE.length + 1) === XHTML_NAMESPACE)
      return tag.split('}').slice(-1)[0];
  }
  return tag
}

export function markup(text: string) {
  return text;
}

export class Markup extends Function {
  private _text: any;

  constructor(text: any) {
    super();
    this._text = text;
    return new Proxy(this, {
      apply(target, thisArg, args: any[]) {
        return target.__call__(...args);
      },
    });
  }

  __call__(...args: any[]) {
    return this._text;
  }

  toString(): string {
    return this.__call__();
  }

  valueOf(): string {
    return this.toString();
  }
}

function urljoin(base: any, url: string): string {
  return new URL(url, base).href;
}
