import http, { ServerResponse } from 'http';
import _, { range, split } from "lodash";
import { DateTime } from 'luxon';
import URL from 'node:url';
import { encode } from 'utf8';
import { getattr } from "../../api/func";
import { FrozenSet } from '../../helper';
import { iterMultiItems } from "../../helper/datastructures";
import { UnicodeError, ValueError } from "../../helper/errors";
import { WebResponse } from '../../http';
import { f, md5, setOptions } from '../../tools';
import { bool } from '../../tools/bool';
import { isInstance } from "../../tools/func";
import { iter, len, next, sorted } from "../../tools/iterable";
import { URI } from '../../tools/uri';
import { ETags, IfRange } from './datastructures';
import { parseDateTz } from './email';

const _schemeRe = /^[a-zA-Z0-9+-.]+$/g;

export const HTTP_STATUS_CODES = {
  100: "Continue",
  101: "Switching Protocols",
  102: "Processing",
  200: "OK",
  201: "Created",
  202: "Accepted",
  203: "Non Authoritative Information",
  204: "No Content",
  205: "Reset Content",
  206: "Partial Content",
  207: "Multi Status",
  226: "IM Used",  // see RFC 3229
  300: "Multiple Choices",
  301: "Moved Permanently",
  302: "Found",
  303: "See Other",
  304: "Not Modified",
  305: "Use Proxy",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",  // unused
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  407: "Proxy Authentication Required",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  411: "Length Required",
  412: "Precondition Failed",
  413: "Request Entity Too Large",
  414: "Request URI Too Long",
  415: "Unsupported Media Type",
  416: "Requested Range Not Satisfiable",
  417: "Expectation Failed",
  418: "I'm a teapot",  // see RFC 2324
  421: "Misdirected Request",  // see RFC 7540
  422: "Unprocessable Entity",
  423: "Locked",
  424: "Failed Dependency",
  426: "Upgrade Required",
  428: "Precondition Required",  // see RFC 6585
  429: "Too Many Requests",
  431: "Request Header Fields Too Large",
  449: "Retry With",  // proprietary MS extension
  451: "Unavailable For Legal Reasons",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  505: "HTTP Version Not Supported",
  507: "Insufficient Storage",
  510: "Not Extended",
}

const _alwaysSafe = new Set(
  "abcdefghijklmnopqrstuvwxyz"
  + "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
  + "0123456789"
  + "-._~"
)

/**
 * URL encode a single string with a given encoding.

  @param str the string to quote.
  @param charset the charset to be used.
  @param errors
  @param safe an optional sequence of safe characters.
  @param unsafe an optional sequence of unsafe characters.
 * @returns 
 */
export function urlQuote(str, options?: { charset?: string, errors?: string, safe?: string, unsafe?: string }) {
  return encodeURI(str);
  options = options || {};
  const charset = options.charset ?? "utf-8";
  const errors = options.errors ?? "strict";
  let safe: any = options.safe ?? "/:";
  let unsafe: any = options.safe || "";
  const encoder = new TextEncoder();
  if (!isInstance(str, Uint8Array) || typeof (str) !== 'string')
    str = String(str)
  if (typeof (str) === 'string')
    str = encoder.encode(str);
  if (typeof (safe) === 'string')
    safe = encoder.encode(safe)
  if (typeof (unsafe) === 'string')
    unsafe = encoder.encode(unsafe)
  safe = _.intersection(safe, Array.from(_alwaysSafe))// - frozenset(bytearray(unsafe))
  let rv = Buffer.from('');
  for (const char of str) {
    if (safe.includes(char)) {
      rv = Buffer.concat([rv, Buffer.from([char])]);
    }
    else {
      rv = Buffer.concat([rv, Buffer.from(_bytetohex[char])]);
    }
  }
  return toNative(Buffer.from(rv));
}

/**
 * URL encode a single string with the given encoding and convert
    whitespace to "+".

 * @param str The string to quote.
 * @param safe 
 * @param charset The charset to be used.
 * @param errors 
 * @returns 
 */
export function urlQuotePlus(str, safe = "", opts: { charset?: string, errors?: string } = {}) {
  setOptions(opts, { charset: "utf-8", errors: "strict" });
  return urlQuote(str, { charset: opts.charset, errors: opts.errors, safe: safe + " ", unsafe: "+" }).replace(" ", "+")
}

const _hexdigits = "0123456789ABCDEFabcdef";
const _hextobyte = {}
for (const a of _hexdigits) {
  for (const b of _hexdigits) {
    _hextobyte[encode(a + b)] = parseInt(a + b, 16);
  }
}
const _bytetohex = range(256).map(char => cleanString(f("%%s", char.toString(16).toUpperCase())))

const _unquoteMaps = new Map([[new Set(), _hextobyte]]);

function _unquoteToBytes(str, unsafe: any = "") {
  if (isInstance(str, Uint8Array) || typeof (str) === 'string') {
    str = encode(str);
  }

  if (isInstance(str, Uint8Array) || typeof (str) === 'string') {
    unsafe = encode(unsafe);
  }

  unsafe = new FrozenSet(Buffer.from(unsafe));
  const groups = iter(str.split("%"));
  let result: any = Buffer.from(next(groups) ?? "");

  let hexToByte;
  if (_unquoteMaps.has(unsafe)) {
    hexToByte = _unquoteMaps.get(unsafe);
  } else {
    hexToByte = {};
    _unquoteMaps.set(unsafe, hexToByte);
    for (const [h, b] of Object.entries(_hextobyte)) {
      if (!unsafe.has(b))
        hexToByte[h] = b;
    }
  }

  for (const group of groups) {
    const code = group.slice(0, 2);

    if (code in hexToByte) {
      result = Buffer.concat([result, Buffer.from([hexToByte[code]])]);
      result = Buffer.concat([result, Buffer.from(group.slice(2))]);
    }
    else {
      result = Buffer.concat([result, Buffer.from([37])]);  // %
      result = Buffer.concat([result, Buffer.from(group)]);
    }
  }

  return result;
}

/**
 * URL decode a single string with a given encoding.  If the charset
    is set to `None` no unicode decoding is performed and raw bytes
    are returned.

 * @param str the string to unquote.
 * @param charset the charset of the query string.  If set to `None`
                    no unicode decoding will take place.
 * @param errors the error handling for the charset decoding.
 * @param unsafe 
 * @returns 
 */
export function urlUnquote(str, charset: any = "utf-8", errors = "replace", unsafe = "") {
  let rv = _unquoteToBytes(str, unsafe);
  if (charset != null) {
    // rv = cleanString(Buffer.from(rv).toString(charset), errors);
  }
  return rv;
}

/**
 * URL decode a single string with the given `charset` and decode "+" to
    whitespace.

    Per default encoding errors are ignored.  If you want a different behavior
    you can set `errors` to ``'replace'`` or ``'strict'``.  In strict mode a
    `HTTPUnicodeError` is raised.

    @param str: The string to unquote.
    @param charset: the charset of the query string.  If set to `None`
                    no unicode decoding will take place.
    @param errors: The error handling for the `charset` decoding.
    @returns 
 */
export function urlUnquotePlus(str, charset = "utf-8", errors = "replace") {
  if (isInstance(str, Uint8Array) || typeof (str) === 'string') {
    str = str.replace("+", " ");
  }
  else {
    str = str.replace("+", " ");
  }
  return urlUnquote(str, charset, errors);
}

/**
 * The reverse operation to :meth:`urlParse`.  This accepts arbitrary
    as well as :class:`URL` tuples and returns a URL as a string.

    @param components: the parsed URL as tuple which should be converted
                       into a URL string.
 * @returns 
 */
export function urlUnparse(components) {
  let [scheme, netloc, path, search, hash] = normalizeStringArray(components);
  const s = makeLiteralWrapper(scheme);
  let url = s("");

  // We generally treat file:///x and file:/x the same which is also
  // what browsers seem to do.  This also allows us to ignore a schema
  // register for netloc utilization or having to differenciate between
  // empty and missing netloc.
  if (netloc || (scheme && path.startsWith(s("/")))) {
    if (path && path.slice(0, 1) !== s("/"))
      path = s("/") + path
    url = s("//") + (netloc ?? s("")) + path
  }
  else if (path)
    url += path
  if (scheme)
    url = scheme + s(":") + url
  if (search)
    url = url + s("?") + search
  if (hash)
    url = url + s("#") + hash
  return url
}

/**
 * Precompile the translation table for a URL encoding function.

    Unlike function `urlQuote`, the generated function only takes the
    string to quote.

    @param charset The charset to encode the result with.
    @param errors How to handle encoding errors.
    @param safe An optional sequence of safe characters to never encode.
    @param unsafe An optional sequence of unsafe characters to always encode.
 */
export function _fastUrlQuote(buf: any, options?: { charset?: string, errors?: string, safe?: string, unsafe?: string }): string {
  buf = Buffer.from(buf || '');
  return encodeURI(buf);

  setOptions(options, { charset: "utf-8", errors: "strict", safe: "/:", unsafe: "" })
  let encoder = new TextEncoder();
  let decoder = new TextDecoder(options.charset);

  let safe, unsafe;
  if (typeof (options.safe) === 'string') {
    safe = encoder.encode(options.safe); // => String to Uint8Array
  }

  if (typeof (options.unsafe) === 'string') {
    unsafe = encoder.encode(options.unsafe);// => String to Uint8Array
  }

  safe = _.difference(_.union(Array.from(safe), Array.from(_alwaysSafe)), Array.from(unsafe));
  const table: any[] = range(256).map(c => safe.includes(c) ? String.fromCharCode(c) : `%${c.toString(16).padStart(2, '0').toUpperCase()}`);

  // function quote(buf: Buffer) {
  //   buf.map(c => table[c]).join('');
  // }

  return buf.map(c => table[c]).join('');
}

function _fastUrlQuotePlus(string) {
  return _fastUrlQuote(string, { charset: 'utf-8', unsafe: '+' }).replace(/%20/g, '+');
}

export function toNative(x, options?: { charset?: string, errors?: string }): string {
  options = options || {};
  // charset?:string='utf-8', errors?: string="strict"
  if (x == null || typeof (x) === 'string')
    return x;
  return (new TextDecoder(options.charset ?? 'utf-8')).decode(x);
}

export function toUnicode(x: any, charset = 'utf-8', errors = "strict", allowNoneCharset = false) {
  if (x == null)
    return null;
  if (!isInstance(x, Uint8Array))
    return x.toString();
  if (charset == null && allowNoneCharset)
    return x

  return (new TextDecoder(charset)).decode(x)
}

export function toBytes(x, charset = 'utf-8', errors = "strict") {
  if (x == null) {
    return null;
  }
  if (isInstance(x, Buffer, DataView)) {
    return Buffer.from(x);
  }
  if (typeof (x) === 'string') {
    return Buffer.from(cleanString(x, errors));
  }
  throw new TypeError("Expected bytes")
}

/**
 * Returns a response object (a WSGI application) that, if called,
  redirects the client to the target location. Supported codes are
  301, 302, 303, 305, 307, and 308. 300 is not supported because
  it's not a real redirect and 304 because it's the answer for a
  request with a request with defined If-Modified-Since headers.

  @param location: the location the response should redirect to.
  @param code: the redirect status code. defaults to 302.
  @param class WeResponse: a WeResponse class to use when instantiating a
      response. The default is :class:`theveb.wrappers.WeResponse` if
      unspecified.
 * @returns 
 */
export function redirect(req, res: ServerResponse, location, code: number = 302, Res?: any): WebResponse {
  if (Res == null)
    Res = WebResponse;

  const displayLocation = _.escape(location);
  if (typeof (location) === 'string') {
    // Safe conversion is necessary here as we might redirect
    // to a broken URI scheme (for instance itms-services).
    // from .urls import iriToUri
    // console.warn('Must check iriToUri');
    location = encodeURI(location);
  }
  const response = new WebResponse(req, res,
    `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 3.2 Final//EN">\n
    <title>Redirecting...</title>\n
    <h1>Redirecting...</h1>\n
    <p>You should be redirected automatically to target URL: 
    <a href="${_.escape(location)}">${displayLocation}</a> if not click the link.`,
    { status: code, mimetype: "text/html" }
  )
  response.httpResponse.setHeader("location", location);
  return response;
}

const _toUriSafe = ":/?#[]@!$&'()*+,;=%";

/**
 * Convert an IRI to a URI. All non-ASCII and unsafe characters are
  quoted. If the URL has a domain, it is encoded to Punycode.

  >>> iri_to_uri('http://\\u2603.net/p\\xe5th?q=\\xe8ry%DF')
  'http://xn--n3h.net/p%C3%A5th?q=%C3%A8ry%DF'

  @param iri The IRI to convert.
  @param charset The encoding of the IRI.
  @param errors Error handler to use during ``bytes.encode``.
  @param safeConversion Return the URL unchanged if it only contains
      ASCII characters and no whitespace. See the explanation below.

  There is a general problem with IRI conversion with some protocols
  that are in violation of the URI specification. Consider the
  following two IRIs::

      magnet:?xt=uri:whatever
      itms-services://?action=download-manifest

  After parsing, we don't know if the scheme requires the ``//``,
  which is dropped if empty, but conveys different meanings in the
  final URL if it's present or not. In this case, you can use
  ``safe_conversion``, which will return the URL unchanged if it only
  contains ASCII characters and no whitespace. This can result in a
  URI with unquoted characters if it was not already quoted correctly,
  but preserves the URL's semantics. Werkzeug uses this for the
  ``Location`` header for redirects.
 */
export function iriToUri(iri, options?: { charset?: "utf-8", errors?: "strict", safeConversion?: boolean }) {
  options = options || {}
  if (Array.isArray(iri))
    iri = urlUnparse(iri);

  if (options.safeConversion) {
    // If we're not sure if it's safe to convert the URL, and it only
    // contains ASCII characters, return it unconverted.
    try {
      const nativeIri = toNative(iri);
      const asciiIri = cleanString(nativeIri);

      // Only return if it doesn't have whitespace. (Why?)
      if (asciiIri.indexOf(' ') < 0)
        return nativeIri
    } catch (e) {
      if (!isInstance(e, UnicodeError))
        throw e;
    }
  }
  iri = urlParse(toUnicode(iri, options.charset, options.errors));
  const path = _fastUrlQuote(iri.pathname, { charset: options.charset, errors: options.errors, safe: _toUriSafe });
  const query = _fastUrlQuote(iri.query, { charset: options.charset, errors: options.errors, safe: _toUriSafe });
  const fragment = _fastUrlQuote(iri.fragment, { charset: options.charset, errors: options.errors, safe: _toUriSafe });
  return toNative(
    urlUnparse([iri.scheme, iri.encodeNetloc(), path, query, fragment])
  )
}

export function uriToIri(str: string): string {
  return decodeURI(str);
}

function makeLiteralWrapper(reference): Function {
  if (reference == null || typeof (reference) === 'string') {
    return (str) => str;
  }
  return methodCaller('encode', 'latin1');
}

/**
 * Ensures that all types in the tuple are either strings
  or bytes.
 * @param components 
 * @returns 
 */
function normalizeStringArray(tup: any[]): any[] {
  const isText = typeof (tup[0] ?? null) === 'string';
  for (const arg of tup) {
    if (arg != null && tup[0] != null && (typeof (arg) === 'string') != isText) {
      throw new TypeError(`Cannot mix str and bytes arguments (got ${String(tup)})`);
    }
  }
  return tup;
}

/**
 * Return a callable object that calls the given method on its operand.
    After f = methodcaller('name'), the call f(r) returns r.name().
    After g = methodcaller('name', 'date', foo=1), the call g(r) returns
    r.name('date', foo=1).
 */
class MethodCaller extends Function {
  _name: any;
  _args: any[];

  constructor(...args: any[]) {
    super();
    if (len(args) < 2) {
      throw new TypeError('methodcaller needs at least one argument, the method name');
    }
    this._name = args.shift();
    if (typeof (this._name) !== 'string') {
      throw new TypeError('method name must be a string');
    }
    this._args = args;

    return new Proxy(this, {
      apply(target, thisArg, args: any[] = []) {
        return target.__call__(args[0]);
      },
    });
  }

  __call__(obj) {
    return getattr(obj, this._name)(...this._args);
  }
}

function methodCaller(...args: any[]) {
  return new MethodCaller(...args);
}

/**
 * Parses a URL from a string into a :class:`URL` array.  If the URL
    is lacking a scheme it can be provided as second argument. Otherwise,
    it is ignored.  Optionally fragments can be stripped from the URL
    by setting `allowFragments` to `false`.

    The inverse of this function is :func:`urlUnparse`.

    @param url the URL to parse.
    @param scheme the default schema to use if the URL is schemaless.
    @param allowHash if set to `false` a fragment will be removed from the URL.
 */
export function urlParse(url: string, scheme?: any, allowHash = true) {
  const s = makeLiteralWrapper(url);
  const isTextBased = typeof (url) === 'string';
  if (scheme == null) {
    scheme = s("");
  }
  let netloc = s("");
  let query = s("");
  let hash = s("");
  let i = url.indexOf(s(":"));
  if (i > 0 && toNative(url.slice(0, i), { errors: "replace" }).match(_schemeRe)) {
    // make sure "iri" is not actually a port number (in which case
    // "scheme" is really part of the path)
    const rest = url.slice(i + 1);
    if (len(rest) || rest.replace(/\s+/g, ' ').trim().split(' ').some(c => !(c in s("0123456789")))) {
      // not a port number
      [scheme, url] = [url.slice(0, i).toLowerCase(), rest];
    }
  }
  if (url.slice(0, 2) === s("//")) {
    let delim = len(url);
    for (const c of s("/?#")) {
      const wdelim = url.indexOf(c, 2);
      if (wdelim >= 0)
        delim = Math.min(delim, wdelim);
    }
    [netloc, url] = [url.slice(2, delim), url.slice(delim)];
    if ((netloc.includes(s("[")) && !netloc.includes(s("]"))) || (
      netloc.includes(s("]")) && !netloc.includes(s("["))
    )) {
      throw new ValueError("Invalid IPv6 URL");
    }
  }
  if (allowHash && url.includes(s("#"))) {
    [url, hash] = split(url, s("#"));
  }
  if (url.includes(s("?"))) {
    [url, query] = split(url, s("?"));
  }

  return new URI(URL.format({ protocol: scheme, auth: netloc, pathname: url, query: query, hash }));
}

/**
 * Join a base URL and a possibly relative URL to form an absolute
  interpretation of the latter.

  @param base the base URL for the join operation.
  @param url the URL to join.
  @param allowFragments indicates whether fragments should be allowed.
 * @returns 
 */
export function urlJoin(base, url, allowFragments = true) {
  if (Array.isArray(base))
    base = urlUnparse(base);
  if (Array.isArray(url))
    url = urlUnparse(url);

  [base, url] = normalizeStringArray([base, url]);
  const s = makeLiteralWrapper(base);

  if (!base) {
    return url;
  }
  if (!url) {
    return base;
  }
  const buri = urlParse(base, null, allowFragments);
  // const bscheme = uri.protocol;
  // let pathname = uri.pathname;
  // let hash = uri.hash;
  const uri = urlParse(url, buri.protocol, allowFragments);
  if (uri.protocol !== buri.protocol) {
    return url;
  }
  if (uri.auth) {
    return urlUnparse([uri.protocol, uri.auth, uri.pathname, uri.search, uri.hash]);
  }
  const netloc = buri.auth;

  let segments, query;
  if (uri.pathname.slice(0, 1) === s("/"))
    segments = uri.pathname.split(s("/"));
  else if (!uri.pathname) {
    segments = buri.pathname.split(s("/"));
    if (!uri.search) {
      query = buri.search;
    }
  }
  else {
    segments = buri.pathname.split(s("/")).slice(0, -1).concat(uri.pathname.split(s("/")));
  }

  // If the rightmost part is "./" we want to keep the slash but
  // remove the dot.
  if (segments[segments.length - 1] === s("."))
    segments[segments.length - 1] = s("");

  // Resolve ".." and "."
  segments = segments.filter(segment => segment !== s("."));
  while (1) {
    let i = 1;
    const n = len(segments) - 1
    while (i < n) {
      if (segments[i] === s("..") && ![s(""), s("..")].includes(segments[i - 1])) {
        segments.splice(i - 1, 3);
        break;
      }
      i += 1;
    }
    if (i == n) {
      break;
    }
  }
  // Remove trailing ".." if the URL is absolute
  const unwantedMarker = [s(""), s("..")];
  while (segments[0] === unwantedMarker[0] && segments[1] === unwantedMarker[1]) {
    segments.splice(1, 1);
  }

  const pathname = segments.join(s("/"));
  return urlUnparse([uri.protocol, netloc, pathname, query, uri.hash]);
}

/**
 *'backslashreplace'	- uses a backslash instead of the character that could not be encoded
  'ignore'	- ignores the characters that cannot be encoded
  'namereplace'	- replaces the character with a text explaining the character
  'strict'	- Default, raises an error on failure
  'replace'	- replaces the character with a questionmark
  'xmlcharrefreplace'	- replaces the character with an xml character
 * @param input 
 * @param replace 
 * @returns 
 */
export function cleanString(input: string, errors: string = 'replace') {
  var output = "";
  for (var i = 0; i < input.length; i++) {
    if (input.charCodeAt(i) <= 127) {
      output += input.charAt(i);
    } else {
      if (errors === 'ignore') {
        continue;
      } else if (errors === 'backslashreplace') {
        output += '\\';
      } else if (errors === 'namereplace') {
        output += `[${i}]<${input.charCodeAt(i)}>`;
      } else if (errors === 'strict') {
        throw new UnicodeError(`String "${input}" error at [${i}] charcode ${input.charCodeAt(i)}`);
      } else {
        output += '?';
      }
    }
  }
  return output;
}

function* _urlEncodeImpl(obj, charset, encodeKeys, sort, key) {
  let iterable: any = iterMultiItems(obj)
  if (sort)
    iterable = sorted(iterable, (x) => x[key])
  for (let [key, value] of iterable) {
    if (!value)
      continue
    if (!isInstance(key, Uint8Array))
      key = Buffer.from(encode(key)).toString(charset)
    if (!isInstance(value, Uint8Array))
      value = Buffer.from(encode(value)).toString(charset)
    yield _fastUrlQuotePlus(key) + "=" + _fastUrlQuotePlus(value)
  }
}

/**
 * URL encode a dict/`MultiDict`.  If a value is `null` it will not appear
  in the result string.  Per default only values are encoded into the target
  charset strings.  If `encode_keys` is set to ``true`` unicode keys are
  supported too.

  If `sort` is set to `true` the items are sorted by `key` or the default
  sorting algorithm.

  @param obj the object to encode into a query string.
  @param charset the charset of the query string.
  @param encodeKeys set to `true` if you have unicode keys.
  @param sort set to `true` if you want parameters to be sorted by `key`.
  @param key an optional function to be used for sorting.  For more details
              check out the :func:`sorted` documentation.
  @param separator the separator to be used for the pairs.
*/
export function urlEncode(
  obj, charset = "utf-8", encodeKeys = false, sort = false, key?: any, separator = "&"
) {
  separator = toNative(separator, { charset: "ascii" });
  const result = [..._urlEncodeImpl(obj, charset, encodeKeys, sort, key)].join(separator);
  return result;
}

/**
 * Create etag md5 hex from string
 * @param data 
 * @returns 
 */
export function generateEtag(data: string) {
  return md5(data);
}

/**
 * Parses an if-range header which can be an etag or a date.  Returns
  a class `~datastructures.IfRange` object.
 * @param value 
 * @returns 
 */
export function parseIfRangeHeader(value) {
  if (!value) {
    return new IfRange();
  }
  const date = parseDate(value);
  if (date != null) {
    return new IfRange({ date: date });
  }
  // drop weakness information
  return new IfRange({ etag: unquoteEtag(value)[0] as string });
}

/**
 * Parse one of the following date formats into a datetime object:

      Sun, 06 Nov 1994 08:49:37 GMT  ; RFC 822, updated by RFC 1123
      Sunday, 06-Nov-94 08:49:37 GMT ; RFC 850, obsoleted by RFC 1036
      Sun Nov  6 08:49:37 1994       ; ANSI C's asctime() format

  If parsing fails the return value is `null`.

  @param value: a string with a supported date format.
  @return a class `Date` object or null.
 */
export function parseDate(value): Date | null {
  if (value) {
    let t = parseDateTz(value.trim())
    if (t != null) {
      try {
        let year = t[0];
        // unfortunately that function does not tell us if two digityears were part of the string, or if they were prefixed with two zeroes.  So what we do is to assume that 69-99 refer to 1900, and everything below to 2000
        if (year >= 0 && year <= 68) {
          year += 2000;
        }
        else if (year >= 69 && year <= 99) {
          year += 1900;
        }
        const v = [year, ...t.slice(1, 7)];
        let date: any = new Date(v[0], v[1], v[2], v[3], v[4], v[5], v[6]);
        date = DateTime.fromJSDate(date).minus({ second: t.slice(-1)[0] });
        return date.toJSDate();
      } catch (e) {
        return null;
      }
    }
  }
}

export function httpDate(date: Date = new Date()): string {
  return date.toISOString();
}

/**
 * Quote an etag.
    @param etag the etag to quote.
    @param weak set to `true` to tag it "weak".
 */
export function quoteEtag(etag, weak = false): string {
  if (etag.includes('"')) {
    throw new ValueError("invalid etag");
  }
  etag = `"${etag}"`;
  if (weak) {
    etag = "W/" + etag;
  }
  return etag;
}

/**
 * Unquote a single etag:

    >>> unquoteEtag('W/"bar"')
    ['bar', true]
    >>> unquoteEtag('"bar"')
    ['bar', false]

    @param etag the etag identifier to unquote.
    @returns a ``[etag, weak]`` tuple.
 */
export function unquoteEtag(etag: string): [string, boolean] {
  if (!etag) {
    return [null, null];
  }
  etag = etag.trim();
  let weak = false;
  if (etag.startsWith("W/") || etag.startsWith("w/")) {
    weak = true;
    etag = etag.slice(2)
  }
  if (etag.slice(0, 1) === '""' && etag.slice(-1) === '"') {
    etag = etag.slice(1, -1);
  }
  return [etag, weak];
}

/**
 * Convenience method for conditional requests.
    @param request the request to be checked.
    @param etag the etag for the response for comparison.
    @param data or alternatively the data of the response to automatically generate an etag using method `generateEtag`.
    @param lastModified an optional date of the last modification.
    @param ignoreIfRange: If `false`, `If-Range` header will be taken into account.
    @returns `true` if the resource was modified, otherwise `false`.
 */
export function isResourceModified(request: http.IncomingMessage, etag: string, data?: any, lastModified?: any, ignoreIfRange = true) {
  if (etag === null && data != null) {
    etag = generateEtag(data);
  }
  else if (data != null) {
    throw new TypeError("both data and etag given");
  }
  if (!["GET", "HEAD"].includes(request.method)) {
    return false;
  }

  let unmodified = false;
  if (typeof (lastModified) === 'string') {
    lastModified = parseDate(lastModified);
  }

  // ensure that microsecond is zero because the HTTP spec does not transmitthat either and we might have some false positives.  See issue #39
  if (lastModified != null) {
    lastModified = (lastModified as Date).setMilliseconds(0);
  }

  let ifRange = null;
  if (!ignoreIfRange && ("if-range" in request.headers)) {
    // https://tools.ietf.org/html/rfc7233#section-3.2
    // A server MUST ignore an If-Range header field received in a request
    // that does not contain a Range header field.
    ifRange = parseIfRangeHeader(request.headers['if-range']);
  }

  let modifiedSince;
  if (ifRange != null && ifRange.date != null) {
    modifiedSince = ifRange.date;
  }
  else {
    modifiedSince = parseDate(request.headers["if-modified-since"]);
  }

  if (modifiedSince && lastModified && lastModified <= modifiedSince) {
    unmodified = true;
  }

  if (bool(etag)) {
    let x;
    etag = unquoteEtag(etag)[0] as string;
    if (ifRange != null && ifRange.etag != null) {
      unmodified = parseEtags(ifRange.etag).contains(etag);
    }
    else {
      const ifNoneMatch = parseEtags(request.headers["if-none-match"]);
      if (bool(ifNoneMatch)) {
        // https://tools.ietf.org/html/rfc7232#section-3.2
        // "A recipient MUST use the weak comparison function when comparing
        // entity-tags for If-null-Match"
        unmodified = ifNoneMatch.containsWeak(etag);
      }

      // https://tools.ietf.org/html/rfc7232#section-3.1
      // "Origin server MUST use the strong comparison function when
      // comparing entity-tags for If-Match"
      const ifMatch = parseEtags(request.headers['if-match']);
      if (bool(ifMatch)) {
        unmodified = !ifMatch.isStrong(etag);
      }
    }
  }

  return !unmodified;
}

const regEtag = /([Ww]\/)?(?:"(.*?)"|(.*?))(?:\s*,\s*|$)/g;

function parseEtags(value: string) {
  if (!value) {
    return new ETags();
  }
  const strong = []
  const weak = []
  let end = value.length;
  let pos = 0
  while (pos < end) {
    let match: any = value.slice(pos).matchAll(regEtag);
    if (match == null) {
      break;
    }
    match = match.next().value;
    let [isWeak, quoted, raw] = match;
    if (raw === "*") {
      return new ETags(null, null, true);
    }
    else if (quoted) {
      raw = quoted;
    }
    if (isWeak) {
      weak.push(raw);
    }
    else {
      strong.push(raw);
    }
    pos += match[0].length;
  }
  return new ETags(strong, weak);
}
