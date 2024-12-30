import path from "node:path";
import { getattr } from "../api";
import { ValueError } from "../helper/errors";
import { cleanString, urlJoin, urlParse } from "../service/middleware/utils";
import { bool } from "./bool";
import { toText } from "./compat";
import { isInstance, stringPart } from "./func";
import { len } from "./iterable";
import { URI } from "./uri";
import { f } from "./utils";

function _guessMimetype(ext: any = null, defaultValue = 'text/html') {
  const exts = {
    '.css': 'text/css',
    '.less': 'text/less',
    '.scss': 'text/scss',
    '.js': 'text/javascript',
    '.xml': 'text/xml',
    '.csv': 'text/csv',
    '.html': 'text/html',
  }
  return ext != null ? (exts[ext] ?? defaultValue) : exts
}

/**
 * Transform a string to a slug that can be used in a url path.
    This method will first try to do the job with javascript-slugify if present. Otherwise it will process string by stripping leading and ending spaces, converting unicode chars to ascii, lowering all chars and replacing spaces and underscore with hyphen "-".
 * @param str 
 * @param maxLength 
 * @returns 
 */
export function slugifyOne(str: string, maxLength = 0) {
  str = String(str);
  const uni = cleanString(Buffer.from(str.normalize('NFKD')).toString('ascii'), 'ignore');
  let slugStr = uni.replace(/[\W_]/g, ' ').trim().toLowerCase();
  slugStr = slugStr.replace(/[-\s]+/g, '-');
  return maxLength > 0 ? slugStr.slice(0, maxLength) : slugStr;
}

export function slugify(str, maxLength = 0, p = false) {
  if (!p) {
    return slugifyOne(str, maxLength);
  }
  else {
    const res = [];
    for (const u of str.split('/')) {
      if (slugifyOne(u, maxLength) !== '') {
        res.push(slugifyOne(u, maxLength))
      }
    }
    // check if supported extension
    const [pathNoExt, ext] = [path.dirname(str), path.extname(str)];
    if (ext && ext in _guessMimetype()) {
      res[res.length - 1] = slugifyOne(pathNoExt) + ext;
    }
    return res.join('/');
  }
}

export function slug(value: [] | [number, string] | { id: number, seoName: string, displayName: string }) {
  let identifier, label;
  if (Array.isArray(value)) {
    // assume nameSearch result array
    [identifier, label] = value;
  }
  else if (isInstance(value, Object)) {
    if (!bool(value.id)) {
      throw new ValueError("Cannot slug non-existent record %s", value)
    }
    [identifier, label] = [value.id, value.seoName || value.displayName];
  }
  const slugname = slugify(label || '').trim().replace(/^-*|-*$/g, '');

  if (!slugname) {
    return String(identifier);
  }
  return f("%s-%d", slugname, identifier);
}

const _UNSLUG_RE = new RegExp('(?:(\\w{1,2}|\\w[A-Za-z0-9-_]+?\\w)-)?(-?\\d+)(?=$|/)', 'g');

/**
 * Extract slug and id from a string.
 * Always return un 2-tuple [string|null, number|null]
 * @param str 
 * @returns 
 */
export function unslug(str: string) {
  const m = str.match(_UNSLUG_RE);
  if (!m) {
    return [null, null];
  }
  return [m[1], parseInt(m[2])];
}

/**
 * From /blog/my-super-blog-1" to "blog/1"
 * @param str 
 * @returns 
 */
export function unslugUrl(str: string) {
  const parts = str.split('/');
  if (parts.length) {
    const unslugVal = unslug(parts[parts.length - 1])
    if (unslugVal[1]) {
      parts[parts.length - 1] = String(unslugVal[1]);
      return parts.join('/');
    }
  }
  return str;
}

/**
 * Given a relative URL, make it absolute and add the required lang or
 * remove useless lang.
 * Nothing will be done for absolute or invalid URL.
 * If there is only one language installed, the lang will not be handled
 * unless forced with `lang` parameter.
 * @param pathOrUri 
 * @param langCode Must be the lang `code`. It could also be something
                    else, such as `'[lang]'` (used for urlReturn).
 * @returns 
 */
export async function urlLang(req, pathOrUri, langCode?: any) {
  let location = toText(pathOrUri).trim();
  // return location;

  const Lang = (await req.getEnv()).items('res.lang');
  const forceLang = langCode != null;
  let url: URI;
  try {
    url = urlParse(location);
  } catch (e) {
    // e.g. Invalid IPv6 URL, `urlParse('http://]')`
    url = null;
  }
  // relative URL with either a path or a forceLang
  if (url && !url.protocol && !url.auth && (url.pathname || forceLang)) {
    location = urlJoin(req.httpRequest.pathname, location);
    const langUrlCodes = (await Lang.getAvailable()).map(item => item[1]);
    langCode = toText(langCode || req.context['lang']);//.replace('_', '-');
    let langUrlCode = await Lang._langCodeToUrlcode(langCode);
    langUrlCode = langUrlCodes.includes(langUrlCode) ? langUrlCode : langCode;
    if ((langUrlCodes.length > 1 || forceLang) && await isMultilangUrl(req, location, langUrlCodes)) {
      let [loc, sep, qs] = stringPart(location, '?');
      let ps: string[] = loc.split('/');
      const defaultLg = await (await req.getEnv()).items('ir.http')._getDefaultLang(req);
      if (langUrlCodes.includes(ps[1])) {
        // Replace the language only if we explicitly provide a language to urlFor
        if (forceLang) {
          ps[1] = langUrlCode;
        }
        // Remove the default language unless it's explicitly provided
        else if (ps[1] == await defaultLg.urlCode) {
          ps.splice(1, 1);
        }
      }
      // Insert the context language or the provided language
      else if (langUrlCode != await defaultLg.urlCode || forceLang) {
        ps.splice(1, 0, langUrlCode);
      }
      location = ps.join('/') + sep + qs;
    }
  }
  return location;
}

/**
 * Check if the given URL content is supposed to be translated.
    To be considered as translatable, the URL should either:
    1. Match a POST (non-GET actually) controller that is `website=true` and
        either `multilang` specified to true or if not specified, with `type='http'`.
    2. If not matching 1., everything not under /static/ or /web/ will be translatable
 * @param localUrl 
 * @param langUrlCodes 
 */
export async function isMultilangUrl(req, localUrl: string, langUrlCodes?: any) {
  // return true;
  const env = await req.getEnv();
  if (!langUrlCodes) {
    langUrlCodes = (await env.items('res.lang').getAvailable()).map(lang => lang[1]);
  }
  const spath = localUrl.split('/');
  // if a language is already in the path, remove it
  if (langUrlCodes.includes(spath[1])) {
    spath.splice(1, 1);
    localUrl = spath.join('/');
  }

  const url = stringPart(localUrl, '#')[0].split('?');
  const path = url[0];

  // Consider /static/ and /web/ files as non-multilang
  if (path.includes('/static/') || path.startsWith('/web/')) {
    return false;
  }

  const queryString = url.length > 1 ? url[1] : null;

  // Try to match an endpoint in theveb's routing table
  try {
    const [, func] = await env.items('ir.http').urlRewrite(req, path, queryString);
    // /page/xxx has no endpoint/func but is multilang
    return (!func || (
      func.routing.get('website', false)
      && func.routing.get('multilang', func.routing['type'] == 'http')
    ));
  } catch (e) {
    console.warn(e);
    return false;
  }
}

/**
 * Return the url with the rewriting applied.
    Nothing will be done for absolute URL, invalid URL, or short URL from 1 char.

  @param urlFrom The URL to convert.
  @param langCode Must be the lang `code`. It could also be something
                    else, such as `[lang]` (used for urlReturn).
  @param noRewrite don't try to match route with website.rewrite.
 */
export async function urlFor(req, urlFrom, langCode?: any, noRewrite = false) {
  // don't try to match route if we know that no rewrite has been loaded.
  const routing = getattr(req, 'websiteRouting', null)  // not modular, but not overridable
  const irHttp = (await req.getEnv()).items('ir.http');
  if (!(irHttp._rewriteLen ?? {})[routing]) {
    noRewrite = true;
  }

  const [path, _, qs] = stringPart(urlFrom || '', '?');
  let newUrl;
  if (!noRewrite && path && (
    len(path) > 1
    && path.startsWith('/')
    && !path.includes('/static/')
    && !path.startsWith('/web/')
  )) {
    [newUrl] = await irHttp.urlRewrite(req, path);
    newUrl = !qs ? newUrl : newUrl + f('?%s', qs);
  }
  return urlLang(req, newUrl ?? urlFrom, langCode);
}