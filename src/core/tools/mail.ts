import uts46 from "idna-uts46";
import os from "os";
import { UnicodeEncodeError } from "../helper/errors";
import { urlParse } from "../service/middleware/utils";
import { bool } from "./bool";
import { isInstance, rstringPart } from "./func";
import * as html from "./html";
import { extend } from "./iterable";
import { f, isASCII } from "./utils";
import { escapeHtml, markup } from "./xml";

export const safeAttrs = new Set(Array.from(html.safeAttrs).concat(['style',
  'data-o-mail-quote',  // quote detection
  'data-oe-model', 'data-oe-id', 'data-oe-field', 'data-oe-type', 'data-oe-expression', 'data-oe-translation-id', 'data-oe-nodeid',
  'data-last-history-steps',
  'data-publish', 'data-id', 'data-resId', 'data-interval', 'data-member_id', 'data-scroll-background-ratio', 'data-view-id',
  'data-class', 'data-mimetype', 'data-original-src', 'data-original-id', 'data-gl-filter', 'data-quality', 'data-resize-width',
  'data-shape', 'data-shape-colors', 'data-file-name', 'data-original-mimetype',
]));

const SPACE = ' ';
const COMMASPACE = ', ';
const EMPTYSTRING = '';
const UEMPTYSTRING = '';
const CRLF = '\r\n';
const TICK = "'";

export const emailRe = new RegExp("([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,63})", 'g');

const specialsre = /[][\\()<>@,:;".]/g;
const escapesre = /[\\"]/g;
export const singleEmailRe = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,63}$/g;
export const mailHeaderMsgidRe = /<[^<>]+>'/g;
export const emailAddrEscapesRe = /[\\"]/g;

export function htmlSanitize(src, options?: { silent?: true, sanitizeTags?: true, sanitizeAttributes?: false, sanitizeStyle?: false, sanitizeForm?: true, stripStyle?: false, stripClasses?: false }) {
  return src;
}

export async function decodeMessageHeader(message, header, separator = ' ') {
  return (await message.getAll(header, [])).filter(h => h).join(separator);
}

export function publishString(source, options?: {
  sourcePath?: null, destinationPath?: null,
  reader?: null, readerName?: 'standalone',
  parser?: null, parserName?: 'restructuredtext',
  writer?: any, writerName?: 'pseudoxml',
  settings?: null, settingsSpec?: null,
  settingsOverrides?: any, configSection?: null,
  enableExitStatus?: false
}) {
  return source;
}

/**
 * Check if a html content is empty. If there are only formatting tags with style
  attributes or a void content  return true. Famous use case if a
  '<p style="..."><br></p>' added by some web editor.
 * @param htmlContent html content, coming from example from an HTML field
 * @returns bool, true if no content found or if containing only void formatting tags
 */
export function isHtmlEmpty(htmlContent: string) {
  if (!htmlContent) {
    return true;
  }
  const tagRe = /\<\s*\/?(?:p|div|span|br|b|i|font)(?:(?=\s+\w*)[^/>]*|\s*)\/?\s*\>/g;
  return !bool(htmlContent.replace(tagRe, '').trim());
}

/**
 * Return a list of (name, email) address tuples found in `'text'` . Note
    that text should be an email header or a stringified email list as it may
    give broader results than expected on actual text.
 * @param text 
 * @returns 
 */
export function emailSplitTuples(text) {
  if (!text) {
    return [];
  }
  // getaddresses() returns '' when email parsing fails, and
  // sometimes returns emails without at least '@'. The '@'
  // is strictly required in RFC2822's `addr-spec`.
  return getaddresses([text]).filter(addr => addr[1] && addr[1].includes('@')).map(addr => [addr[0], addr[1]]);
}

/**
 * Prepare string to be used in a quoted string.
    Turns backslash and double quote characters into quoted pairs.  These
    are the only characters that need to be quoted inside a quoted string.
    Does not add the surrounding double quotes.
 * @param str 
 * @returns 
 */
function quote(str) {
  return str.replace('\\', '\\\\').replace('"', '\\"');
}

class AddrlistClass {
  specials: string;
  pos: number;
  LWS: string;
  CR: string;
  FWS: any;
  atomends: any;
  phraseends: any;
  field: string;
  commentlist: any[];

  constructor(field: string) {
    this.specials = '()<>@,:;.\"[]';
    this.pos = 0;
    this.LWS = ' \t';
    this.CR = '\r\n';
    this.FWS = this.LWS + this.CR;
    this.atomends = this.specials + this.LWS + this.CR;
    // Note that RFC 2822 now specifies `.' as obs-phrase, meaning that it
    // is obsolete syntax.  RFC 2822 requires that we recognize obsolete
    // syntax, so allow dots in phrases.
    this.phraseends = this.atomends.replace('.', '');
    this.field = field;
    this.commentlist = [];
  }

  /**
   * Skip white space and extract comments.
   */
  gotonext() {
    const wslist = [];
    while (this.pos < this.field.length) {
      if ((this.LWS + '\n\r').includes(this.field[this.pos])) {
        if (!'\n\r'.includes(this.field[this.pos])) {
          wslist.push(this.field[this.pos]);
        }
        this.pos += 1;
      }
      else if (this.field[this.pos] === '(') {
        this.commentlist.push(this.getcomment());
      }
      else {
        break;
      }
    }
    return wslist.join(EMPTYSTRING);
  }

  getaddrlist(): string[] {
    const result = [];
    while (this.pos < this.field.length) {
      const ad = this.getaddress();
      if (ad) {
        extend(result, ad);
      }
      else {
        result.push(['', '']);
      }
      this.pos += 1;
    }
    return result;
  }

  /**
   * Parse the next address.
   */
  getaddress() {
    this.commentlist = [];
    this.gotonext();

    const oldpos = this.pos;
    const oldcl = this.commentlist;
    const plist = this.getphraselist();

    this.gotonext();
    let returnlist = [];

    if (this.pos >= this.field.length) {
      // Bad email address technically, no domain.
      if (plist) {
        returnlist = [[this.commentlist.join(SPACE), plist[0]]];
      }
    }

    else if ('.@'.includes(this.field[this.pos])) {
      // email address is just an addrspec
      // this isn't very efficient since we start over
      this.pos = oldpos;
      this.commentlist = oldcl;
      const addrspec = this.getaddrspec();
      returnlist = [[this.commentlist.join(SPACE), addrspec]];
    }

    else if (this.field[this.pos] === ':') {
      // address is a group
      let returnlist = [];

      const fieldlen = this.field.length;
      this.pos += 1;
      while (this.pos < this.field.length) {
        this.gotonext();
        if (this.pos < fieldlen && this.field[this.pos] === ';') {
          this.pos += 1;
          break;
        }
        returnlist = returnlist.concat(this.getaddress());
      }
    }

    else if (this.field[this.pos] === '<') {
      // Address is a phrase then a route addr
      const routeaddr = this.getrouteaddr()

      if (this.commentlist) {
        returnlist = [[plist.join(SPACE) + ' (' + this.commentlist.join(' ') + ')', routeaddr]]
      }
      else {
        returnlist = [[plist.join(SPACE), routeaddr]];
      }
    }

    else {
      if (plist) {
        returnlist = [[this.commentlist.join(SPACE), plist[0]]];
      }
      else if (this.specials.includes(this.field[this.pos])) {
        this.pos += 1;
      }
    }

    this.gotonext();
    if ((this.pos < this.field.length) && this.field[this.pos] === ',') {
      this.pos += 1;
    }
    return returnlist;
  }

  /**
   * Parse a route address (Return-path value).

    This method just skips all the route stuff and returns the addrspec.
   * @returns 
   */
  getrouteaddr() {
    if (this.field[this.pos] !== '<') {
      return;
    }

    let expectroute = false;
    this.pos += 1;
    this.gotonext();
    let adlist = '';
    while (this.pos < this.field.length) {
      if (expectroute) {
        this.getdomain();
        expectroute = false;
      }
      else if (this.field[this.pos] === '>') {
        this.pos += 1;
        break;
      }
      else if (this.field[this.pos] === '@') {
        this.pos += 1;
        expectroute = true;
      }
      else if (this.field[this.pos] === ':') {
        this.pos += 1;
      }
      else {
        adlist = this.getaddrspec();
        this.pos += 1;
        break;
      }
      this.gotonext();
    }
    return adlist;
  }

  /**
   * Parse a header fragment delimited by special characters.

    `beginchar' is the start character for the fragment.
    If self is not looking at an instance of `beginchar' then
    getdelimited returns the empty string.

    `endchars' is a sequence of allowable end-delimiting characters.
    Parsing stops when one of these is encountered.

    If `allowcomments' is non-zero, embedded RFC 2822 comments are allowed
    within the parsed fragment.
   * @param beginchar 
   * @param endchars 
   * @param allowcomments 
   * @returns 
   */
  getdelimited(beginchar, endchars, allowcomments = true) {
    if (this.field[this.pos] !== beginchar) {
      return '';
    }

    const slist = [''];
    let quote = false;
    this.pos += 1;
    while (this.pos < this.field.length) {
      if (quote) {
        slist.push(this.field[this.pos]);
        quote = false;
      }
      else if (endchars.includes(this.field[this.pos])) {
        this.pos += 1;
        break;
      }
      else if (allowcomments && this.field[this.pos] === '(') {
        slist.push(this.getcomment());
        continue;        // have already advanced pos from getcomment
      }
      else if (this.field[this.pos] === '\\') {
        quote = true;
      }
      else {
        slist.push(this.field[this.pos]);
      }
      this.pos += 1;
    }

    return slist.join(EMPTYSTRING);
  }

  /**
   * Parse an RFC 2822 addr-spec.
   */
  getaddrspec() {
    const aslist = [];

    this.gotonext();
    while (this.pos < this.field.length) {
      let preserveWs = true;
      if (this.field[this.pos] === '.') {
        if (aslist.length && !aslist.slice(-1)[0].trim()) {
          aslist.pop();
        }
        aslist.push('.');
        this.pos += 1;
        preserveWs = false;
      }
      else if (this.field[this.pos] === '"') {
        aslist.push(f('"%s"', quote(this.getquote())));
      }
      else if (this.atomends.includes(this.field[this.pos])) {
        if (aslist.length && !aslist.slice(-1)[0].trim()) {
          aslist.pop();
        }
        break;
      }
      else {
        aslist.push(this.getatom());
      }
      const ws = this.gotonext();
      if (preserveWs && ws) {
        aslist.push(ws);
      }
    }

    if (this.pos >= this.field.length || this.field[this.pos] !== '@') {
      return aslist.join(EMPTYSTRING);
    }

    aslist.push('@');
    this.pos += 1;
    this.gotonext();
    const domain = this.getdomain();
    if (!domain) {
      // Invalid domain, return an empty address instead of returning a
      // local part to denote failed parsing.
      return EMPTYSTRING
    }
    return aslist.join(EMPTYSTRING) + domain;
  }

  /**
   * Get the complete domain name from an address.
   * @returns 
   */
  getdomain() {
    const sdlist = [];
    while (this.pos < this.field.length) {
      if (this.LWS.includes(this.field[this.pos])) {
        this.pos += 1;
      }
      else if (this.field[this.pos] === '(') {
        this.commentlist.push(this.getcomment());
      }
      else if (this.field[this.pos] === '[') {
        sdlist.push(this.getdomainliteral());
      }
      else if (this.field[this.pos] === '.') {
        this.pos += 1;
        sdlist.push('.');
      }
      else if (this.field[this.pos] === '@') {
        // bpo-34155: Don't parse domains with two `@` like
        // `a@malicious.org@important.com`.
        return EMPTYSTRING;
      }
      else if (this.atomends.includes(this.field[this.pos])) {
        break;
      }
      else {
        sdlist.push(this.getatom());
      }
    }
    return sdlist.join(EMPTYSTRING);
  }

  /**
   * Get a quote-delimited fragment from self's field.
   * @returns 
   */
  getquote() {
    return this.getdelimited('"', '"\r', false);
  }

  /**
   * Get a parenthesis-delimited fragment from self's field.
   * @returns 
   */
  getcomment() {
    return this.getdelimited('(', ')\r', true);
  }

  /**
   * Parse an RFC 2822 domain-literal.
   * @returns 
   */
  getdomainliteral() {
    return f('[%s]', this.getdelimited('[', ']\r', false));
  }

  /**
   * Parse an RFC 2822 atom.

      Optional atomends specifies a different set of end token delimiters
      (the default is to use this.atomends). This is used e.g. in
      getphraselist() since phrase endings must not include the `.' (which
      is legal in phrases).
   * @param atomends 
   * @returns 
   */
  getatom(atomends?: any) {
    const atomlist = [''];
    if (atomends == null) {
      atomends = this.atomends;
    }

    while (this.pos < this.field.length) {
      if (atomends.includes(this.field[this.pos])) {
        break;
      }
      else {
        atomlist.push(this.field[this.pos]);
      }
      this.pos += 1;
    }

    return atomlist.join(EMPTYSTRING);
  }

  /**
   * Parse a sequence of RFC 2822 phrases.

    A phrase is a sequence of words, which are in turn either RFC 2822
    atoms or quoted-strings.  Phrases are canonicalized by squeezing all
    runs of continuous whitespace into one space.
   */
  getphraselist() {
    const plist = [];

    while (this.pos < this.field.length) {
      if (this.FWS.includes(this.field[this.pos])) {
        this.pos += 1;
      }
      else if (this.field[this.pos] === '"') {
        plist.push(this.getquote());
      }
      else if (this.field[this.pos] === '(') {
        this.commentlist.push(this.getcomment());
      }
      else if (this.phraseends.includes(this.field[this.pos])) {
        break;
      }
      else {
        plist.push(this.getatom(this.phraseends));
      }
    }
    return plist;
  }
}

class _AddressList extends AddrlistClass {
  addresslist: string[];

  constructor(field: string) {
    super(field);
    if (field) {
      this.addresslist = this.getaddrlist();
    }
    else {
      this.addresslist = []
    }
  }
}

/**
 * Return a list of (REALNAME, EMAIL) for each fieldvalue.
 * @param fieldvalues 
 * @returns 
 */
function getaddresses(fieldvalues) {
  const all = fieldvalues.join(COMMASPACE);
  const a = new _AddressList(all);
  return a.addresslist;
}

/**
 * Return a list of the email addresses found in `'text'`
 * @param text 
 * @returns 
 */
export function emailSplit(text) {
  if (!text) {
    return [];
  }
  return emailSplitTuples(text).map(([, email]) => email);
}

/**
 * Sanitize and standardize email address entries.
  A normalized email is considered as :
  - having a left part + @ + a right part (the domain can be without '.something')
  - being lower case
  - having no name before the address. Typically, having no 'Name <>'
  Ex:
  - Possible Input Email : 'Name <NaMe@DoMaIn.CoM>'
  - Normalized Output Email : 'name@domain.com'
 * @param text 
 * @returns 
 */
export function emailNormalize(text, forceSingle = true) {
  const emails = emailSplit(text);
  if (!bool(emails) || emails.length != 1 && forceSingle) {
    return false;
  }
  let [localPart, at, domain] = rstringPart(emails[0], '@');
  if (isASCII(localPart)) {
    localPart = localPart.toLowerCase();
  }

  return localPart + at + domain.toLowerCase();
}

/**
 * Tool method allowing to extract email addresses from a text input and returning
    normalized version of all found emails. If no email is found, a void list
    is returned.

    e.g. if email is 'tony@e.com, "Tony2" <tony2@e.com' returned result is ['tony@e.com, tony2@e.com']
 * @param text 
 * @returns list of normalized emails found in text
 */
export function emailNormalizeAll(text: string) {
  if (!text) {
    return [];
  }
  const emails = emailSplit(text);
  return emails.map(email => emailNormalize(email)).filter(email => bool(email));
}

/**
 * Extract the company domain to be used by IAP services notably. Domain
    is extracted from email information e.g:
        - info@proximus.be -> proximus.be
 * @param email 
 * @returns 
 */
export function emailDomainExtract(email: any) {
  const normalizedEmail = emailNormalize(email);
  if (normalizedEmail) {
    return normalizedEmail.split('@')[1];
  }
  return false;
}

/**
 * Return the domain normalized or false if the domain is invalid.
 * @param domain 
 * @returns 
 */
export function emailDomainNormalize(domain: string) {
  if (!domain || domain.includes('@')) {
    return false;
  }

  return domain.toLowerCase();
}

/**
 * Extract the company domain to be used by IAP services notably. Domain
    is extracted from an URL e.g:
        - www.info.theverp.com -> theverp.com
 * @param url 
 * @returns 
 */
export function urlDomainExtract(url) {
  const parserResults = urlParse(url);
  const companyHostname = parserResults.hostname;
  if (companyHostname && companyHostname.includes('.')) {
    return companyHostname.split('.').slice(-2).join('.');  // remove subdomains
  }
  return false;
}

/**
 * Return a list of email addresses found in `'text'`, formatted using
  formataddr.
 * @param text 
 * @returns 
 */
export function emailSplitAndFormat(text) {
  if (!text) {
    return [];
  }
  return emailSplitTuples(text).map(([name, email]) => formataddr([name, email]));
}

/**
 * Pretty format a 2-tuple of the form (realname, emailAddress).

    If the first element of pair is falsy then only the email address
    is returned.

    Set the charset to ascii to get a RFC-2822 compliant email. The
    realname will be base64 encoded (if necessary) and the domain part
    of the email will be punycode encoded (if necessary). The local part
    is left unchanged thus require the SMTPUTF8 extension when there are
    non-ascii characters.

    >>> formataddr(('John Doe', 'johndoe@example.com'))
    '"John Doe" <johndoe@example.com>'

    >>> formataddr(('', 'johndoe@example.com'))
    'johndoe@example.com'
 * @param pair 
 * @param charset 
 */
export function formataddr(pair: any[], charset: any = 'utf-8') {
  let [name, address] = pair;
  let [local, at, domain] = rstringPart(address, '@');

  try {
    new TextEncoder().encode(domain);
  } catch (e) {
    domain = uts46.toAscii(domain);
  }

  if (name) {
    try {
      new TextEncoder().encode(name);
    } catch (e) {
      if (isInstance(e, UnicodeEncodeError)) {
        // charset mismatch, encode as utf-8/base64
        // rfc2047 - MIME Message Header Extensions for Non-ASCII Text
        name = Buffer.from(name, 'base64').toString('ascii')
        return `=?utf-8?b?${name}?= <${local}@${domain}>`
      }
      else {
        // ascii name, escape it if needed
        // rfc2822 - Internet Message Format
        //   #section-3.4 - Address Specification
        name = name.replace(emailAddrEscapesRe, '\\\$0');
        return `"{name}" <${local}@${domain}>`
      }
    }
  }
  return `${local}@${domain}`;
}

/**
 * Transform the url into clickable link with <a/> tag 
 * @param text 
 * @returns 
 */
export function htmlKeepUrl(text: string) {
  let idx = 0;
  let final = '';
  const linkTags = new RegExp(`(?<!["'])((ftp|http|https):\/\/(\w+:{0,1}\w*@)?([^\s<"']+)(:[0-9]+)?(\/|\/([^\s<"']))?)(?![^\s<"']*["']|[^\s<"']*</a>)`);
  const matches = text.matchAll(linkTags);
  for (const item of matches) {
    final += text.slice(idx, item.length);
    final += f('<a href="%s" target="_blank" rel="noreferrer noopener">%s</a>', item[0], item[0]);
    idx = item.length;
  }
  final += text.slice(idx);
  return final;
}

export function html2Text(body = '') {
  return body
    // .replace(/\n/ig, '')
    // .replace(/<style[^>]*>[\s\S]*?<\/style[^>]*>/ig, '')
    // .replace(/<head[^>]*>[\s\S]*?<\/head[^>]*>/ig, '')
    // .replace(/<script[^>]*>[\s\S]*?<\/script[^>]*>/ig, '')
    .replace(/<\/\s*(?:p|div)>/ig, '\n')
    .replace(/<br[^>]*\/?>/ig, '\n')
    .replace(/<[^>]*>/ig, '') // one for removing all with tag <>
    .replace('&nbsp;', ' ')
    .replace(/[^\S\r\n][^\S\r\n]+/ig, ' ')
}

/**
 * Convert plaintext into html. Content of the text is escaped to manage
    html entities, using misc.html_escape().
    - all \n,\r are replaced by <br />
    - enclose content into <p>
    - convert url into clickable link
    - 2 or more consecutive <br /> are considered as paragraph breaks

    :param string container_tag: container of the html; by default the
        content is embedded into a <div>
 * @param text 
 * @param containerTag 
 * @returns 
 */
export function plaintext2html(text, containerTag?: any) {
  text = escapeHtml(String(text));

  // 1. replace \n and \r
  text = text.replace(/(\r\n|\r|\n)/, '<br/>');

  // 2. clickable links
  text = htmlKeepUrl(text);

  // 3-4: form paragraphs
  let idx = 0;
  let final = '<p>';
  const brTags = /(([<]\s*[bB][rR]\s*\/?[>]\s*){2,})/;
  const matches = text.matchAll(brTags);
  for (const item of matches) {
    final += text.slice(idx, item.index) + '</p><p>'
    idx = item.length;
  }
  final += text.slice(idx) + '</p>';

  // 5. container
  if (containerTag) { // FIXME: validate that container_tag is just a simple tag?
    final = f('<%s>%s</%s>', containerTag, final, containerTag);
  }
  return markup(final);
}

export class EmailMessage {
  body: string;

  constructor(options: { body?: string } = {}) {
    this.body = options.body || '';
  }

  asBytes() {
    return Buffer.from(this.body);
  }
}

/**
 * Returns a string that can be used in the Message-ID RFC822 header field
    Used to track the replies related to a given object thanks to the "In-Reply-To" or "References" fields that Mail User Agents will set.
 * @param resId 
 * @returns 
 */
export function generateTrackingMessageId(resId) {
  const rnd = Math.random();
  const rndstr = rnd.toFixed(15).slice(2);
  return f("<%s.%s-verp-%s@%s>", rndstr, (new Date()).getTime(), resId, os.hostname());
}

export function reOpen(self, resId, model, context?: any) {
  // save original model in context, because selecting the list of available
  // templates requires a model in context
  context = Object.assign({}, context, { default_model: model });
  return {
    'type': 'ir.actions.actwindow',
    'viewMode': 'form',
    'resId': resId,
    'resModel': self._name,
    'target': 'new',
    'context': context,
  }
}

/**
 * Prepend some HTML content at the beginning of an other HTML content.
 * @param htmlBody 
 * @param htmlContent 
 * @returns 
 */
export function prependHtmlContent(htmlBody, htmlContent) {
  const cls = Object.getPrototypeOf(htmlContent);
  const obj = new cls();
  htmlContent = obj(htmlContent.replace(/(<\/?(?:html|body|head|!\s*DOCTYPE)[^>]*>)/gm, ''));
  htmlContent = htmlContent.trim();

  const bodyMatch = htmlBody.matchAll(/<body[^>]*>/) || htmlBody.matchAll(/<html[^>]*>/);
  let insertIndex = 0;
  if (bodyMatch) {
    const match = bodyMatch.next().value;
    insertIndex = bodyMatch.index + bodyMatch.length;
  }

  return htmlBody.slice(0, insertIndex) + htmlContent + htmlBody.slice(insertIndex);
}

/**
 * Change the FROM of the message and use the old one as name.

  e.g.
  * Old From: "Admin" <admin@gmail.com>
  * New From: notifications@theverp.com
  * Output: "Admin" <notifications@theverp.com>
 * @param oldEmail 
 * @param newEmail 
 * @returns 
 */
export function encapsulateEmail(oldEmail, newEmail): string | void {
  const oldEmailSplit = getaddresses([oldEmail]);
  if (!oldEmailSplit.length || !bool(oldEmailSplit[0])) {
    return oldEmail;
  }

  const newEmailSplit = getaddresses([newEmail]);
  if (!newEmailSplit.length || !bool(newEmailSplit[0])) {
    return;
  }
  let oldName, namePart;
  [oldName, oldEmail] = oldEmailSplit[0];
  if (oldName) {
    namePart = oldName;
  }
  else {
    namePart = oldEmail.split("@")[0];
  }

  return formataddr([
    namePart,
    newEmailSplit[0][1],
  ]);
}

/**
 * Returns a string suitable for RFC 2822 compliant Message-ID, e.g:

  <142480216486.20800.16526388040877946887@nightshade.la.mastaler.com>

  Optional idstring if given is a string used to strengthen the
  uniqueness of the message id.  Optional domain if given provides the
  portion of the message id after the '@'.  It defaults to the locally
  defined hostname.
 * @param idstring 
 * @param domain 
 * @returns 
 */
export async function makeMsgid(idstring?: string, domain?: any) {
  const timeval = (new Date()).getMilliseconds() * 100;
  const pid = process.pid;
  const rnd = Math.random();
  const randint = rnd.toFixed(15).slice(2);
  if (idstring == null) {
    idstring = '';
  }
  else {
    idstring = '.' + idstring;
  }
  if (domain == null) {
    domain = await getfqdn();
  }
  return f('<%d.%d.%d%s@%s>', timeval, pid, randint, idstring, domain);
}

/**
 * Get fully qualified domain name from name.

    An empty argument is interpreted as meaning the local host.

    First the hostname returned by gethostbyaddr() is checked, then
    possibly existing aliases. In case no FQDN is available, hostname
    from gethostname() is returned.
 * @param name 
 * @returns 
 */
async function getfqdn(name = '') {
  name = name.trim();
  if (!name || name == '0.0.0.0') {
    name = os.hostname();
  }
  let err, hostname, aliases = [];
  try {
    const { Resolver } = require('node:dns').promises;
    const resolver = new Resolver();
    const addresses = await resolver.resolve4('example.org');
    for (const a of addresses) {
      const hostnames = await resolver.reverse(a);
      aliases = aliases.concat(hostnames);
    }
    hostname = aliases[0];
  } catch (e) {
    err = e;
  }
  if (!err) {
    let found;
    for (const name in aliases) {
      if (name.includes('.')) {
        found = true;
        break;
      }
    }
    if (!found) {
      name = hostname;
    }
  }
  return name;
}