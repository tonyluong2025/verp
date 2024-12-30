import fs from "fs";
import http from "http";
import { rsplit } from "../../tools/func";
import { lstrip, rstrip } from "../../tools/utils";
import { _encodeIdna, wsgiGetBytes } from "./idna";
import { BaseRequest } from "./base_request";
import { uriToIri, urlQuote } from "./utils";

export function getCurrentUrl(
  req: BaseRequest,
  options: {
    rootOnly?: boolean,
    stripQuerystring?: boolean,
    hostOnly?: boolean,
    trustedHosts?: string[],
  } = {}
) {
  const tmp = [req.uri.protocol, "://", getHost(req, options.trustedHosts)];
  if (options.hostOnly) {
    return uriToIri(tmp.join('') + "/");
  }
  tmp.push(rstrip(urlQuote(wsgiGetBytes(req.uri.pathname)), "/"));
  tmp.push("/");
  if (!options.rootOnly) {
    tmp.push(lstrip(urlQuote(wsgiGetBytes(req.uri.pathname || ""))), "/");
    if (!options.stripQuerystring) {
      let qs = req.uri.search;
      if (qs) {
        tmp.push("?" + qs);
      }
    }
  }
  return uriToIri(tmp.join(''));
}

/**
 * Checks if a host is trusted against a list.  This also takes care
    of port normalization.

    @param hostname the hostname to check
    @param trustedList a list of hostnames to check against.  If a
                         hostname starts with a dot it will match against
                         all subdomains as well.
 */
export function hostIsTrusted(hostname?: string, trustedList: string[] = []) {
  if (!hostname)
    return false

  if (typeof (trustedList) === 'string')
    trustedList = [trustedList];

  function _normalize(hostname: string) {
    if (hostname.includes(':')) {
      hostname = rsplit(hostname, ":", 1)[0];
    }
    return _encodeIdna(hostname);
  }

  try {
    hostname = _normalize(hostname).toString();
  } catch (e) {
    return false;
  }
  for (let ref of trustedList) {
    let suffixMatch;
    if (ref.startsWith(".")) {
      ref = ref.slice(1);
      suffixMatch = true;
    }
    else {
      suffixMatch = false;
    }
    try {
      ref = _normalize(ref).toString();
    } catch (e) {
      return false;
    }
    if (ref === hostname) {
      return true;
    }
    if (suffixMatch && hostname.endsWith("." + ref)) {
      return true;
    }
  }
  return false;
}

/**
 * Return the host for the given WSGI requestment. This first checks
  the ``Host`` header. If it's not present, then ``SERVER_NAME`` and
  ``SERVER_PORT`` are used. The host will only contain the port if it
  is different than the standard port for the protocol.

  Optionally, verify that the host is trusted using
  function `hostIsTrusted` and throw a
  `exceptions.SecurityError` if it is not.

  @param request The request to get the host from.
  @param trustedHosts A list of trusted hosts.
  @returns Host, with port if necessary.
  @throws exceptions.SecurityError: If the host is not
      trusted.
 */
export function getHost(request: BaseRequest, trustedHosts?: string[]): string {
  let rv;
  // if ("HTTP_HOST" in request) {
  //   rv = request["HTTP_HOST"];
  //   if (request["wsgi.urlScheme"] === "http" && rv.endsWith(":80")) {
  //     rv = rv.slice(0,-3);
  //   }
  //   else if (request["wsgi.urlScheme"] === "https" && rv.endsWith(":443")) {
  //     rv = rv.slice(0,-4);
  //   }
  // }
  // else {
  //   rv = request["SERVER_NAME"];
  //   if ((request["wsgi.urlScheme"] !== 'https' && request["SERVER_PORT"] !== '443') ||
  //       (request["wsgi.urlScheme"] !== 'http' && request["SERVER_PORT"] !== '80')) {
  //     rv += ":" + request["SERVER_PORT"];
  //   }
  // }
  // if (trustedHosts != null) {
  //   if (! hostIsTrusted(rv, trustedHosts)) {
  //     throw new SecurityError('Host "%s" is not trusted', rv);
  //   }
  // }
  rv = request.headers['host'];
  return rv;
}

export function wrapFile(res: http.ServerResponse, f: any, options?: {}) {
  let result;
  try {
    result = fs.readFileSync(f, options);
  }
  catch (e) {
    res.statusCode = 500;
    res.end(`Error getting the file: ${e}.`);
  }
  finally {
    fs.closeSync(f);
  }
  return result;
}

const regex = /((([a-zA-Z]+(-[a-zA-Z0-9]+){0,2})|\*)(;q=[0-1](\.[0-9]+)?)?)*/g;

export function parseAcceptLanguages(al): any[] {
  var strings = (al || "").match(regex);
  return strings.map(function (m) {
    if (!m) {
      return;
    }

    var bits = m.split(';');
    var ietf = bits[0].split('-');
    var hasScript = ietf.length === 3;

    return {
      code: ietf[0],
      script: hasScript ? ietf[1] : null,
      region: hasScript ? ietf[2] : ietf[1],
      quality: bits[1] ? parseFloat(bits[1].split('=')[1]) : 1.0
    };
  }).filter(function (r) {
    return r;
  }).sort(function (a, b) {
    return b.quality - a.quality;
  });
}