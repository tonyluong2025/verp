import http from 'http';
import { Dict } from '../../helper/collections';
import { isCallable, isInstance } from '../../tools/func';
import { formatBytes } from '../../tools/misc';
import { cookieSerialize } from './cookie';
import { httpDate, quoteEtag } from './utils';

export class BaseResponse extends Function {
  defaultStatus: 200;
  defaultMimetype = 'text/html';
  charset = "utf-8";
  implicitSequenceConversion = true;
  autocorrectLocationHeader = true;
  automaticallySetContentLength = true;
  maxCookieSize = 4093;

  httpResponse: http.ServerResponse;
  httpRequest: any; // => http.IncomingMessage;
  contents: any[];
  template: string;
  qcontext: {};
  uid: number;
  status: number;
  directPassthrough: any;
  _onClose: any[];
  lastModified: any;
  cacheControl: Dict<any>;
  expires: number;
  reason: string | Uint8Array;
  url: string;

  constructor(req, res, content?: any, options: {
    status?: number,
    headers?: {},
    mimetype?: string,
    contentType?: string,
    directPassthrough?: boolean
  }={}) {
    super();
    this.cacheControl = new Dict();
    
    this.httpRequest = req;
    this.httpResponse = res;

    let headers: any = options.headers ?? {};
    if (Array.isArray(headers)) {
      headers = Object.fromEntries(headers);
    } 
    for (const [key, value] of Object.entries(headers)) {
      this.setHeader(key, value);
    }

    let mimetype = options.mimetype;
    let contentType = options.contentType;
    if (contentType == null) {
      if (mimetype == null && !this.hasHeader('content-type')) {
        mimetype = this.defaultMimetype;
      }
      if (mimetype != null) {
        mimetype = getContentType(mimetype, this.charset);
      }
      contentType = mimetype;
    }
    if (contentType != null) {
      this.setHeader("content-type", contentType);
    }

    let status = options.status || res?.statusCode;
    if (status == null) {
      status = this.defaultStatus;
    }
    if (typeof(status) === 'number') {
      this.statusCode = status;
    }
    this.status = status;
    this.contents = [];
    this.directPassthrough = options.directPassthrough;
    this._onClose = [];

    // we set the response after the headers so that if a class changes
    // the charset attribute, the data is set in the correct charset.
    if (content == null) {
      this.contents = res?.contents || [];
    }
    else if (isInstance(content, Uint8Array) || typeof(content) === 'string') {
      this.setData(content);
    }
    else {
      this.contents = Array.isArray(content) ? content : [content];
    }

    return new Proxy(this, {
      apply(target, thisArg, args: any[]=[]) {
        return target.__call__(args[0], args[1], args[2]);
      },
    });
  }

  __call__(req, res, next?: any) {
    let length = 0;
    for (const content of this.contents) {
      length += content.length;
    }
    console.log(req.httpRequest.method, this.httpResponse.statusCode, req.httpRequest.url, `(${formatBytes(length)} in ${(new Date().getTime() - req.httpRequest.createdAt.getTime()) / 1000}ms)`);
    for (const content of this.contents) {
      this.httpResponse.write(content);
    }
    if (isCallable(next)) {
      return next();
    } else {
      this.httpResponse.end();
      return true;
    }
  }

  set statusCode(value) {
    this.httpResponse.statusCode = value;
  }

  static forceType(cls, response: any): any {
    if (!isInstance(response, BaseResponse)) {
      response = new cls(response.req, response);
    }
    response = Object.setPrototypeOf(response, cls);
    return response;
  }
  
  setData(value: any) {
    if (typeof(value) === 'string') {
      value = (new TextDecoder(this.charset)).decode(Buffer.from(value));
      // value = Buffer.from(value, 'base64').toString();
    }
    // else
    //   value = bytes(value)
    this.contents.push(value);
    // if (this.automaticallySetContentLength) {
    //   this.setHeader("content-length", len(value));
    // }
  }

  setCookie(key, value, options: {path?: string, maxAge?: any, httpOnly?: boolean, expires?: any, domain?: any}={}) {
    options.path = options.path || '/';
    const vals = cookieSerialize(key, value, options);
    this.setHeader('set-cookie', vals);
  }

  getHeader(key, value?: any) {
    return this.httpResponse.getHeader(key) ?? value;
  }

  hasHeader(key) {
    return this.httpResponse.hasHeader(key);
  }

  setHeader(key, value) {
    return this.httpResponse.setHeader(key, value);
  }

  writeHead(code, ...args: any[]) {
    return this.httpResponse.writeHead(code, ...args);
  }

  write(chunk: any, callback?: any) {
    return this.httpResponse.write(chunk, callback)
  }

  end(...args) {
    return this.httpResponse.end(...args);
  }

  setEtag(etag, weak=false) {
    this.setHeader("ETag", quoteEtag(etag, weak));
  }

  makeConditional(request: http.IncomingMessage, acceptRanges: boolean=false, completeLength?: any) {
    console.warn("Method not implemented.");
    if (["GET", "HEAD"].includes(request.method)) {
      // if the date is not in the headers, add it now.  We however
      // will not override an already existing header.  Unfortunately
      // this header will be overriden by many WSGI servers including
      // wsgiref.
      if (!this.hasHeader("date")) {
        this.setHeader("Date", httpDate());
      }
      // acceptRanges = _cleanAcceptRanges(acceptRanges);
      // is206 = self._process_range_request(request, complete_length, accept_ranges)
      // if not is206 and not is_resource_modified(
      //     request,
      //     self.headers.get("etag"),
      //     None,
      //     self.headers.get("last-modified"),
      // ):
      //     if parse_etags(request.get("HTTP_IF_MATCH")):
      //         self.status_code = 412
      //     else:
      //         self.status_code = 304
      // if (
      //     self.automatically_set_content_length
      //     and "content-length" not in self.headers
      // ):
      //     length = self.calculate_content_length()
      //     if length is not None:
      //         self.headers["Content-Length"] = length
    }
    return this;
  }
}


const _charsetMimetypes = [
  "application/ecmascript",
  "application/javascript",
  "application/sql",
  "application/xml",
  "application/xml-dtd",
  "application/xml-external-parsed-entity",
]

export function getContentType(mimetype: string, charset: string): any {
  if (
    mimetype.startsWith("text/")
    || _charsetMimetypes.includes(mimetype)
    || mimetype.endsWith("+xml")
  ) {
    mimetype += "; charset=" + charset;
  }
  return mimetype;
}