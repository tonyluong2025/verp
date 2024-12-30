import { Dict } from "../helper";
import { urlParse } from "../service/middleware/utils";
import { rstringPart, split, stringPart } from "./func";

interface Conditions {
  protocol?: string | string[] | undefined;
  username?: string | undefined;
  password?: string | undefined;
  host?: string | undefined;
  hostname?: string | undefined;
  port?: string | undefined;
  path?: string | undefined;
  pathname?: string | undefined;
  hash?: string | undefined;
  search?: string | undefined;
  origin?: string | undefined;
}

/**
 * https://user:pass@www.theverp.com:443/web?id=1#hash
 */
export class URI {
  /** protocol # scheme 
   *  ex: http
   **/
  protocol: string | undefined;
  /** auth # netloc # user:pass@host:post 
   *  ex: user:pass@www.theverp.com:443
   **/
  private _auth: string | undefined;
  username: string | undefined;
  password: string | undefined;
  private _host: string | undefined;
  hostname: string | undefined;
  port: string | undefined;
  /** path = pathname?search
   *  ex: /web?id=1
   **/
  path: string | undefined;
  /** ex: /web
   **/
  pathname: string | undefined;
  search: string | undefined;
  searchQuery: Dict<any>;
  hash: string | undefined;
  origin: string | undefined;
  timeout: number | undefined;

  constructor(uri: string) {
    let x, rest: string | undefined;
    [this.protocol, x, rest] = rstringPart(uri, '://');
    [this.auth, x, rest] = stringPart(rest, '/');
    rest = '/' + (rest || '');
    [this.path, this.hash] = rest.split('#');
    [this.pathname, this.search] = this.path.split('?');
    this.searchQuery = urlDecode(this.search);
    this.origin = (this.protocol ? this.protocol + '://' : '')
      + (this.auth || '')
      + (this.path || '')
      + (this.hash ? '#' + this.hash : '');
  }

  /**
   * auth= user:pass@host
   */
  get auth() {
    return this._auth;
  }

  set auth(value) {
    if (typeof (value) === 'string') {
      this._auth = value;
      const [user, host] = split(value, '@');
      this.host = host;

      if (typeof (user) === 'string') {
        [this.username, this.password] = user.split(':');
      }
    }
  }

  /**
   *  host = hostname:port
   */
  get host() {
    return this._host;
  }

  set host(value) {
    if (typeof (value) === 'string') {
      this._host = value;
      [this.hostname, this.port] = value.split(':');
    }
  }

  toString() {
    return (this.protocol ? this.protocol + '://' : '')
      + (this.auth ? this.auth : '')
      + (this.pathname ? this.pathname : '')
      + (this.search ? '?' + this.search : '')
      + (this.hash ? '#' + this.hash : '');
  }

  validate(str: string, conditions?: Conditions) {
    return validateUri(str, conditions);
  }
}

/**
  const link= 'postgres://user:pass@example.com:5432/dbname?id=1#hash';
  const url = new URI(link);
  console.log('***START URL');
  console.log(url.origin, url.hostname, url.username, url.password, url.port, url.pathname);
  console.log(url.protocol, url.search, url.path, url.hash);
*/

export function validateUri(str: string, conditions?: Conditions) {
  let protocols: string[];
  if (conditions && conditions.protocol) {
    protocols = (typeof conditions.protocol === 'string') ? [conditions.protocol] : conditions.protocol;
  } else {
    protocols = ['https?'];
  }
  const pattern = new RegExp(`^((${protocols.join('|')}):\\/\\/)?` + // protocol
    '([a-z\\d-]+:[a-z\\d-]+@)?' + // user:pass
    '((([a-z\\d]([a-z\\d-]*[a-z\\d])*)\\.)+[a-z]{2,}|' + // domain name
    '((\\d{1,3}\\.){3}\\d{1,3})|localhost)' + // OR ip (v4) address
    '(\\:\\d+)?(\\/[-a-z\\d%_.~+]*)*' + // port and path
    '(\\?[;&a-z\\d%_.~+=-]*)?' + // query string
    '(\\#[-a-z\\d_]*)?$', 'i'); // fragment locator
  return !!pattern.test(str);
}

export function validateUrl(url) {
  if (!['http', 'https', 'ftp', 'ftps'].includes(urlParse(url).protocol)) {
    return 'http://' + url;
  }
  return url;
}

export function urlDecode(str: string): Dict<string> {
  return str ? Dict.from(decodeURIComponent(str).split('&').map(arg => arg.split('='))) : new Dict<string>();
}