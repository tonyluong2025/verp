import busboy from 'busboy';
import contentType from 'content-type';
import http from 'http';
import getRawBody from 'raw-body';
import { Dict, MultiDict } from '../../helper/collections';
import { len } from '../../tools';
import { isInstance } from '../../tools/func';
import { URI } from '../../tools/uri';
import { cookieParse } from './cookie';
import { getCurrentUrl, parseAcceptLanguages } from './wsgi';

const RE_BOUNDARY = /^multipart\/.+?(?:; boundary=(?:(?:"(.+)")|(?:([^\s]+))))$/i;

export class BaseRequest extends http.IncomingMessage {
  private _body: {};
  private _params: Dict<any>;
  private _createdAt: Date;
  trustedHosts: string[];
  httpRequest: http.IncomingMessage;
  session: any;
  uri: URI;
  form: any[];
  files: any[];

  private constructor(arg) {
    super(arg);
  }

  /**
   * The full URL root (with hostname), this is the application
      root as IRI.
   */
  // @cachedProperty
  static new(req: http.IncomingMessage) {
    const self = new BaseRequest(req.socket);
    self._createdAt = new Date();
    Object.assign(self, req);
    self._body = {};
    self.httpRequest = req;
    self.uri = new URI(req.url);
    self.uri.host = self.uri.host ?? req.headers.host;
    self.params = Dict.from(self.uri.searchQuery || {}); // parse from url string
    return self;
  }

  get createdAt() {
    return this._createdAt;
  }

  get body() {
    return this._body;
  }

  set body(val) {
    this._body = val;
  }

  get path() {
    return this.uri.path;
  }

  get pathname() {
    return this.uri.pathname;
  }

  get params() {
    return this._params;
  }

  set params(value) {
    this._params = value;
  }

  get cookie() {
    return cookieParse(this.httpRequest.headers.cookie || '');
  }

  get urlRoot() {
    return getCurrentUrl(this, { rootOnly: true, trustedHosts: this.trustedHosts });
  }

  /**
   * Like :attr:`url` but without the querystring
    See also: :attr:`trusted_hosts`.
   */
  // @cachedProperty
  get baseUrl() {
    return getCurrentUrl(
      this, { stripQuerystring: true, trustedHosts: this.trustedHosts }
    )
  }

  get acceptLanguages() {
    return parseAcceptLanguages(this.headers['accept-language']);
  }

  async parseBody(callback = (msg) => { }) {
    let body = await this.getBody();
    if (typeof body === 'string') {
      body = body.replace('+', '%2B');
      try {
        body = decodeURIComponent(body);
      } catch (e) {
        // pass by decode URI
      }
      try {
        this._body = JSON.parse(body); // try parse json
      } catch (e) {
        if (isInstance(e, SyntaxError)) {
          try {
            this._body = Object.fromEntries(body.split('&').map(arg => arg.split('=')));
          } catch (e) {
            if (isInstance(e, SyntaxError)) {
              const msg = `Invalid JSON data: ${body}`;
              console.info('%s: %s', this.httpRequest.url, msg);
              callback(msg);
            }
            else {
              throw e;
            }
          }
        }
      }
    }
    else if (body) {
      this.params.updateFrom(len(body.form) ? body.form.entries() : {});
      this.files = body.files;
    }
    console.log('-> Curl:', this.httpRequest.url);
  }

  async getBody() {
    const req = this.httpRequest;
    if (req.headers['content-type']) {
      let m;
      if (m = RE_BOUNDARY.exec(req.headers['content-type'])) { // multipart
        return new Promise<any>((resolve, reject) => {
          const bb = busboy({ headers: req.headers });
          const files = [];
          const form = new MultiDict();;
          bb.on('file', (name, stream, info) => {
            // { filename, encoding, mimeType } = info;
            // save to file
            // const saveTo = path.join(os.tmpdir(), `busboy-upload-${random()}`);
            // stream.pipe(fs.createWriteStream(saveTo));
            // stream.on('data', (data) => {
            //   files.push([{name, info, data}]);
            // });
            files.push([name, { stream, ...info }]);
          });
          bb.on('field', (name, value, info) => {
            // { encoding, mimeType } = info;
            form.add(name, value);
          });
          bb.on('close', () => {
            resolve({ form, files });
          });
          bb.on('error', (error) => {
            reject(error);
          });
          req.pipe(bb);
        });
      }
      else {
        try {
          const body = await getRawBody(req, {
            length: req.headers['content-length'],
            limit: '1mb',
            encoding: contentType.parse(req).parameters.charset
          })
          return body.toString();
        } catch (e) {
          return null;
        }
      }
    }
  }
}