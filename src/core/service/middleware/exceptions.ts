import _ from "lodash";
import { format } from "util";
import { LookupError } from "../../helper/errors";
import { isInstance } from "../../tools";
import { _format } from "../../tools/utils";
import { BaseResponse } from "./base_response";

export class HTTPException extends Function {
  static code: number;
  static description: string;
  _description: string;
  response: any;

  constructor(response?: any, description?: string) {
    super();
    this.response = response;
    if (description) {
      this._description = description;
    }
    return new Proxy(this, {
      apply(target, thisArg, args: any[] = []) {
        return target.__call__(args);
      },
    });
  }

  __call__(args: any[]) {
    const req = args[0];
    let res = args[1];
    res = this.getResponse(res);
    const headers = this.getHeaders();
    res.setHeader(headers[0], headers[1]);
    res.writeHead(this.code || this.response?.status || 200);
    res.end(this.getBody(res));
  }

  /**
   * Get a list of headers.
   * @returns 
   */
  getHeaders(): any[] {
    return ["content-type", "text/html"]
  }

  /**
   * Get a response object.  If one was passed to the exception
    it's returned directly.
   * @param request This can be used to modify the response depending
                    on how the request looked like.
   * @returns a class `Response` object or a subclass thereof
   */
  getResponse(res): BaseResponse {
    if (this.response != null) {
      return new BaseResponse(this.response.req, this.response);
    }
    return new BaseResponse(res.httpRequest, res);
  }

  /**
   * Get the HTML body.
   * @param request 
   */
  getBody(res?: any) {
    return _format(`
      <!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 3.2 Final//EN">\n
      <title>{code} {name}</title>\n
      <h1>{name}</h1>\n
      {description}\n
    `, {
      "code": this.code || this.response?.status || res.status,
      "name": _.escape(this.constructor.name),
      "description": this.getDescription(res),
    });
  }

  getDescription(res?: any) {
    return format("<p>%s</p>", _.escape(this.description).replace("\n", "<br>"));
  }

  get description() {
    return (this.constructor as any).description ?? this._description;
  }

  get message() {
    return this.description;
  }

  get code() {
    return (this.constructor as any).code;
  }
}

export class NotFound extends HTTPException {
  static code = 404;
  static description = 'The requested URL was not found on the server. If you entered the URL manually please check your spelling and try again.';
}

/**
 * *403* `Forbidden`

    Raise if the user doesn't have the permission for the requested resource
    but was authenticated.
 */
export class Forbidden extends HTTPException {
  static code = 403;
  static description = `You don't have the permission to access the requested resource. It is either read-protected or not readable by the server.`;
}

export class Retry extends HTTPException {
  static code = 307;
  static description = `You cannot access at this time. Please try again later!`;
}

/**
 * *405* `Method Not Allowed`

Raise if the server used a method the resource does not handle.  For
example `POST` if the resource is view only.  Especially useful for REST.

The first argument for this exception should be a list of allowed methods.
Strictly speaking the response would be invalid if you don't provide valid
methods in the header which you can do with that list.
 */
export class MethodNotAllowed extends HTTPException {
  static code = 405
  static description = "The method is not allowed for the requested URL."
  validMethods: any;

  constructor(res, validMethods?: any, description?: any) {
    super(res, `${description} allowed: ${validMethods}`);
    this.validMethods = validMethods;
  }

  getHeaders(): any[] {
    const headers = super.getHeaders();
    if (this.validMethods) {
      headers.push(["allow", this.validMethods.join(', ')]);
    }
    return headers;
  }
}

export class BadRequest extends HTTPException {
  static code = 400
  static description = "The browser (or proxy) sent a request that this server could not understand."
}

export class BadHost extends BadRequest { };

const defaultExceptions = {};

(function _findExceptions() {
  for (const [name, cls] of Object.entries<any>(module.exports)) {
    let isHttpException;
    try {
      isHttpException = Object.getPrototypeOf(cls) == HTTPException;
    } catch (e) {
      isHttpException = false;
    }
    if (!isHttpException || cls.code == null) {
      continue;
    }
    const oldObj = defaultExceptions[cls.code];
    if (oldObj != null && isInstance(cls?.prototype, oldObj)) {
      continue;
    }
    defaultExceptions[cls.code] = cls;
  }
})();

class Aborter extends Function {
  mapping: {};

  constructor(mapping?: any, extra?: any) {
    super();
    if (mapping == null) {
      mapping = defaultExceptions;
    }
    this.mapping = Object.assign({}, mapping);
    if (extra != null) {
      Object.assign(this.mapping, extra);
    }
    return new Proxy(this, {
      apply(target, thisArg, args: any[] = []) {
        return target.__call__(args[0], ...args.slice(1));
      },
    });
  }

  __call__(code, ...args) {
    if (!args.length && typeof (code) !== 'number') {
      throw new HTTPException(code);
    }
    if (!(code in this.mapping)) {
      throw new LookupError("no exception for %s", code);
    }
    throw new this.mapping[code](...args);
  }
}

const _aborter = new Aborter();

/**
 * Raises an `HTTPException` for the given status code or WSGI
    application:

    abort(404)  # 404 Not Found
    abort(Response('Hello World'))

    Can be passed a WSGI application or a status code.  If a status code is
    given it's looked up in the list of exceptions and will raise that
    exception, if passed a WSGI application it will wrap it in a proxy WSGI
    exception and raise that:

       abort(404)
       abort(Response('Hello World'))
 * @param status 
 * @param args 
 * @returns 
 */
export function abort(res, ...args: any) {
  return _aborter(res, ...args);
}

export class Timeout extends Error { }

export class RoutingException extends Error { }

export class RequestSlash extends RoutingException { }

export class RequestAliasRedirect extends RoutingException {
  matchedValues: {};
  constructor(matchedValues: {}) {
    super();
    this.matchedValues = matchedValues;
  }
}

/**
 * Raise if the map requests a redirect. This is for example the case if
    `strict_slashes` are activated and an url that requires a trailing slash.

    The attribute `newUrl` contains the absolute destination url.
 */
export class RequestRedirect extends HTTPException {
  static code = 308
  newUrl: string;

  constructor(newUrl) {
    super();
    this.newUrl = newUrl;
  }
}


export class BuildError extends RoutingException {
  constructor(...args: any[]) {
    super();
  }
}

export class InternalServerError extends HTTPException {
  static code = 500;
  static description = 'The server encountered an internal error and was unable to complete your request. Either the server is overloaded or there is an error in the application.';
}