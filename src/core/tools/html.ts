import { DOMImplementation } from '@xmldom/xmldom';
import assert from "assert";
import { format } from "util";
import xpath from "xpath/xpath";
import { ParseError } from "../helper";
import { bool } from "./bool";
import { isBasestring, isInstance } from "./func";
import { len } from "./iterable";
import { E, _elementName, _nons, isText, parseHtml, parseXml } from "./xml";

export const safeAttrs = new Set([
  'abbr', 'accept', 'accept-charset', 'accesskey', 'action', 'align',
  'alt', 'axis', 'border', 'cellpadding', 'cellspacing', 'char', 'charoff',
  'charset', 'checked', 'cite', 'class', 'clear', 'cols', 'colspan',
  'color', 'compact', 'coords', 'datetime', 'dir', 'disabled', 'enctype',
  'for', 'frame', 'headers', 'height', 'href', 'hreflang', 'hspace', 'id',
  'ismap', 'label', 'lang', 'longdesc', 'maxlength', 'media', 'method',
  'multiple', 'name', 'nohref', 'noshade', 'nowrap', 'prompt', 'readonly',
  'rel', 'rev', 'rows', 'rowspan', 'rules', 'scope', 'selected', 'shape',
  'size', 'span', 'src', 'start', 'summary', 'tabindex', 'target', 'title',
  'type', 'usemap', 'valign', 'value', 'vspace', 'width']);
  
/**
 * Tags with body: <tag>...</tag>
   Tags without body: <tag/> (here we can find zero or more spaced before /)
   Comments <!-- ... -->
   Any text that is not < or >
 */
export const regTag = /^<([a-z]+)([^>]+)*(?:>(.*)<\/\1>|\s+\/>)$/smui;

export const _looksLikeFullHtmlUnicode = /^\\s*<(?:html|!doctype)/iu;

export const _looksLikeFullHtmlBytes = /^\\s*<(?:html|!doctype)/i;

/**
 * Parses several HTML elements, returning a list of elements.

  The first item in the list may be a string.
  If noLeadingText is true, then it will be an error if there is
  leading text, and it will always be a list of only elements.

  baseUrl will set the document's base_url attribute
  (and the tree's docinfo.URL).
 * @param html 
 * @param options 
 */
function _multiFragmentFromstring(html, options: { noLeadingText?: boolean, baseUrl?: string, parser?: any } = {}): Element[] {
  const parser = options.parser ? options.parser : parseXml;

  if (isInstance(html, Uint8Array)) {
    html = html.toString();
  }
  if (!_looksLikeFullHtmlUnicode.test(html)) {
    html = format('<html><body>%s</body></html>', html);
  }
  const doc = documentFromString(html, Object.assign(options, { parser: parser, baseUrl: options.baseUrl }));// as any as Document;
  assert(_nons(doc.doctype?.name) === 'html')
  const bodies = xpath.select('//body', doc);
  assert(len(bodies) == 1, format("too many bodies: %s in %s", bodies, html))
  const body = bodies[0] as Element;
  if (options.noLeadingText && isText(body.firstChild) && body.firstChild.textContent.trim()) {
    throw new ParseError("There is leading text: %s", body.firstChild.textContent);
  }
  return [body];
}

/**
 * Parses a single HTML element; it is an error if there is more than
    one element, or if anything but whitespace precedes or follows the
    element.
 
    If `'create_parent'` is true (or is a tag name) then a parent node
    will be created to encapsulate the HTML in a single element.  In this
    case, leading or trailing text is also allowed, as are multiple elements
    as result of the parsing.
 
    Passing a `'baseUrl'` will set the document's `'base_url'` attribute
    (and the tree's docinfo.URL).
 * @param html 
 * @param options 
 */
export function fragmentFromString(html, options: { createParent?: string, baseUrl?: string, parser?: any } = {}) {
  const parser = options.parser ? options.parser : parseXml;

  const acceptLeadingText = bool(options.createParent)

  const elements = _multiFragmentFromstring(html, Object.assign(options, { parser: parser, noLeadingText: !acceptLeadingText, baseUrl: options.baseUrl }));

  let createParent: any = options.createParent;
  if (createParent) {
    if (!isBasestring(createParent)) {
      createParent = 'div';
    }
    const newRoot = E.withType(createParent)
    if (elements.length) {
      if (isBasestring(elements[0])) {
        newRoot.textContent = elements[0] as any;
        elements.shift();
      }
      elements.forEach(elem => newRoot.appendChild(elem.cloneNode(true)));
    }
    return newRoot;
  }
  if (!elements.length) {
    throw new ParseError('No elements found');
  }
  if (elements.length > 1) {
    throw new ParseError("Multiple elements found (%s)", elements.map(e => _elementName(e)).join(', '));
  }
  const el = elements[0];
  if (isText(el.lastChild) && el.lastChild.textContent.trim()) {
    throw new ParseError("Element followed by text: %s", el.lastChild.textContent);
  }
  return el;
}

export function documentFromString(str: string, options: { parser?: any, baseUrl?: string, ensureHeadBody?: boolean, boundTag?: string, removeBlankText?: boolean, encoding?: string } = {}) {
  const parser = options.parser ? options.parser : parseHtml;
  const ensureHeadBody = options.ensureHeadBody || false;

  const dom = new DOMImplementation();
  const doc = dom.createDocument('', '', dom.createDocumentType('html', '', ''));
  str = str.trim();
  const htmlStr = str.match(/<html>([\S\s]*?)<\/html>/gmi);
  const bodyStr = str.match(/<body>([\S\s]*?)<\/body>/gmi);
  const boundTag = ensureHeadBody && 'body' || options.boundTag;
  if (!htmlStr && !bodyStr && boundTag) {
    str = `<${boundTag}>${str}</${boundTag}>`;
  }
  let value = parser(str) as Element;

  let htmlDom: Element;
  if (!htmlStr) {
    htmlDom = doc.createElementNS(null, 'html');
  }
  if (!htmlDom) {
    htmlDom = xpath.select1('//html', value) as Element;
  } else {
    htmlDom.appendChild(value);
  }

  const headStr = str.match(/<head>([\S\s]*?)<\/head>/gmi);
  if (ensureHeadBody && !headStr) {
    const head = E.withType('head', '');
    const body = xpath.select1('//body', value) as Element;
    htmlDom.insertBefore(head, body);
  }

  doc.appendChild(htmlDom.cloneNode(true));
  return doc;
}

export class HtmlDiff {
  makeTable(arg0: any, arg1: any, arg2: any, arg3: any, options: { context?: any, numlines?: number } = {}) {
    return 'HtmlDiff.Method not implemented.';
  }
  tabsize: number;

  constructor(tabsize: number) {
    this.tabsize = tabsize;
  }
}


/**
 * Return, in an HTML table, the diff between two texts.
 * @param dataFrom tuple(text, name), name will be used as table header
 * @param dataTo tuple(text, name), name will be used as table header
 * @param customStyle string, style css including <style> tag
 * @returns a string containing the diff in an HTML table format
 */
export function getDiff(dataFrom, dataTo, customStyle: boolean = false) {
  /**
   * The HtmlDiff lib will add some useful classes on the DOM to
      identify elements. Simply append to those classes some BS4 ones.
      For the table to fit the modal width, some custom style is needed.
   * @param htmlDiff 
   * @param customStyle 
   * @returns 
   */
  function handleStyle(htmlDiff, customStyle) {
    const toAppend = {
      'diff_header': 'bg-600 text-center align-top px-2',
      'diff_next': 'd-none',
    }
    for (const [_old, _new] of Object.entries(toAppend)) {
      htmlDiff = htmlDiff.replace(_old, format("%s %s", _old, _new));
    }
    htmlDiff = htmlDiff.replace('nowrap', '');
    htmlDiff += customStyle || `
            <style>
                .modal-dialog.modal-lg:has(table.diff) {
                    max-width: 1600px;
                    padding-left: 1.75rem;
                    padding-right: 1.75rem;
                }
                table.diff { width: 100%; }
                table.diff th.diff_header { width: 50%; }
                table.diff td.diff_header { white-space: nowrap; }
                table.diff td { word-break: break-all; vertical-align: top; }
                table.diff .diff_chg, table.diff .diff_sub, table.diff .diff_add {
                    display: inline-block;
                    color: inherit;
                }
                table.diff .diff_sub, table.diff td:nth-child(3) > .diff_chg { background-color: #ffc1c0; }
                table.diff .diff_add, table.diff td:nth-child(6) > .diff_chg { background-color: #abf2bc; }
                table.diff td:nth-child(3):has(>.diff_chg, .diff_sub) { background-color: #ffebe9; }
                table.diff td:nth-child(6):has(>.diff_chg, .diff_add) { background-color: #e6ffec; }
            </style>
        `;
    return htmlDiff;
  }

  const diff = (new HtmlDiff(2)).makeTable(
    dataFrom[0].split('\n'),
    dataTo[0].split('\n'),
    dataFrom[1],
    dataTo[1],
    {
      context: true,  // Show only diff lines, not all the code
      numlines: 3
    },
  )

  return handleStyle(diff, customStyle);
}