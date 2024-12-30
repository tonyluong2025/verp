import adler32 from 'adler-32';
import fs from 'fs';
import http from 'http';
import { DateTime } from 'luxon';
import * as mime from 'mime-types';
import * as pt from 'path';
import { fnmatch } from '../../tools/fnmatch';
import { isCallable, isInstance, isObject } from "../../tools/func";
import { extend } from '../../tools/iterable';
import { isFile } from "../../tools/misc";
import { URI } from '../../tools/uri';
import { httpDate, isResourceModified } from './utils';
import { wrapFile } from './wsgi';

/**Safely join zero or more untrusted path components to a base
    directory to avoid escaping the base directory.

 * @param directory The trusted base directory.
 * @param pathnames The untrusted path components relative to the
        base directory.
 * @returns A safe path, otherwise ``null``.
 */
function safeJoin(directory: string, ...pathnames: string[]) {
  const parts = [directory];
  for (let filename of pathnames) {
    if (filename !== '') {
      filename = pt.posix.normalize(filename);
    }

    if (filename.includes('\\') || pt.isAbsolute(filename) || filename === '..' || filename.startsWith('../')) {
      return null;
    }

    parts.push(filename);
  }
  return pt.join(...parts);
}


/**
 * A WSGI middleware that provides static content for development
    environments or simple server setups. Usage is quite simple::

        import path from 'path';
        import SharedDataMiddleware from './wsgi';

        var app = new SharedDataMiddleware(app, {
            '/static': path.join(path.dirname(__file__), 'static')
        })

    The contents of the folder ``./shared`` will now be available on
    ``http://example.com/shared/``.  This is pretty useful during development
    because a standalone media server is not required.  One can also mount
    files on the root folder and still continue to use the application because
    the shared data middleware forwards all unhandled requests to the
    application, even if the requests are below one of the shared folders.

    If `pkg_resources` is available you can also tell the middleware to serve
    files from package data::

        var app = new SharedDataMiddleware(app, {
            '/static': ['myapplication', 'static']
        })

    This will then serve the ``static`` folder in the `myapplication`
    package.

    The optional `disallow` parameter can be a list of :func:`~fnmatch.fnmatch`
    rules for files that are not accessible from the web.  If `cache` is set to
    `false` no caching headers are sent.

    Currently the middleware does not support non ASCII filenames.  If the
    encoding on the file system happens to be the encoding of the URI it may
    work but this could also be by accident.  We strongly suggest using ASCII
    only file names for static files.

    The middleware will guess the mimetype using the Javascript `mimetype`
    module.  If it's unable to figure out the charset it will fall back
    to `fallback_mimetype`.

    @param app the application to wrap.  If you don't want to wrap an
                application you can pass it :exc:`NotFound`.
    @param exports a list or dict of exported files and folders.
    @param disallow a list of function `~fnmatch.fnmatch` rules.
    @param fallbackMimetype the fallback mimetype for unknown files.
    @param cache: enable or disable caching headers.
    @param cacheTimeout: the cache timeout in seconds for the headers.
 */
export class SharedDataMiddleware {
  app: any;
  exports: any[];
  cache: boolean;
  /** unit: seconds */
  cacheTimeout: number;
  fallbackMimetype: string;

  constructor(
    app,
    exports,
    options?: {
      disallow?: string;
      fallbackMimetype?: string;
      cache?: boolean;
      cacheTimeout?: number;
    }
  ) {
    this.app = app;
    this.exports = [];

    options = options ?? {};
    this.cache = options.cache ?? true;
    this.cacheTimeout = options.cacheTimeout ?? 60 * 60 * 12;
    this.fallbackMimetype = options.fallbackMimetype ?? "text/plain";    

    if (isObject(exports)) {
      exports = Object.entries(exports);
    }

    for (const [key, value] of exports) {
      let loader;
      if (Array.isArray(value)) {
        loader = this.getPackageLoader(value[0], value[1]);
      }
      else if (typeof(value) === 'string') {
        if (isFile(value)) {
          loader = this.getFileLoader(value);
        }
        else {
          loader = this.getDirectoryLoader(value);
        }
      }
      else {
        throw new TypeError(`unknown function ${value}`);
      }

      this.exports.push([key, loader]);
    }

    if (options.disallow != null) {
      this.isAllowed = (x) => {
        return ! fnmatch(x, options.disallow);
      }
    }
  
    return new Proxy(this, {
      apply(target, thisArg, args: any[]=[]) {
        return target.dispatch(args[0], args[1]);
      },
    });
  }

  /**
   * Subclasses can override this method to disallow the access to
    certain files.  However by providing `disallow` in the constructor
    this method is overwritten.
   * @param filename 
   * @returns 
   */
  isAllowed(filename) {
    return true;
  }

  _opener(filename) {
    return () => [
      fs.openSync(filename, "r"),
      fs.statSync(filename).mtime,
      fs.statSync(filename).size
    ]
  }

  getFileLoader(filename) {
    const self: any = this;
    return (x) => [pt.parse(filename).base, self._opener(filename)];
  }

  getPackageLoader(pack, packagePath) {
    console.warn('Not implemented');
    return (str) => [];
  }

  getDirectoryLoader(directory) {
    const self: any = this;
    function loader(path) {
      if (path != null) {
        path = safeJoin(directory, path);
      }
      else {
        path = directory;
      }

      if (isFile(path)) {
        return [pt.parse(path).base, self._opener(path)];
      }

      return [null, null];
    }
    return loader;
  }

  generateEtag(mtime, filesize, realFilename) {
    if (! isInstance(realFilename, Uint8Array)) {
      realFilename = (new TextDecoder('utf8')).decode(Buffer.from(realFilename));
    }

    return `wzsdm-${mtime}-${filesize}-${adler32.str(realFilename) & 0xFFFFFFFF}`;
  }

  async dispatch(req: http.IncomingMessage, res: http.ServerResponse, startResponse?: any) {
    const path = new URI(req.url).pathname;

    let realFilename, fileLoader;

    for (let [searchPath, loader] of this.exports) {
      if (searchPath === path) {
        [realFilename, fileLoader] = loader(null);
        if (fileLoader != null) {
          break;
        }
      }

      if (! searchPath.endsWith("/")) {
        searchPath += "/";
      }

      if (path.startsWith(searchPath)) {
        [realFilename, fileLoader] = loader(path.slice(searchPath.length));
        if (fileLoader != null) {
          break;
        }
      }
    }

    if (fileLoader == null || !this.isAllowed(realFilename)) {
      return this.app(req, res);
    }

    const guessedType = mime.lookup(realFilename);
    const mimeType = (guessedType ?? this.fallbackMimetype) as string;
    const [fd, mtime, filesize] = fileLoader();

    let headers = [["date", httpDate(new Date())]];

    if (this.cache) {
      const timeout = this.cacheTimeout;
      const etag = this.generateEtag(mtime, filesize, realFilename);
      headers = headers.concat([
        ["etag", `"${etag}"`],
        ["cache-control", `max-age=${timeout}, public`],
      ]);

      if (! isResourceModified(req, etag, null, mtime)) {
        fs.close(fd);
        res.writeHead(304, "Not Modified", headers);
        return [];
      }

      headers.push(["expires", httpDate(DateTime.now().plus({second: timeout}).toJSDate())]);
    }
    else {
      headers.push(["cache-control", "public"]);
    }

    extend(headers, 
      [
        ["content-type", mimeType],
        ["content-length", `${filesize}`],
        ["last-modified", httpDate(mtime)],
        // Website you wish to allow to connect
        // ['access-control-allow-origin', "*"],

        // Request methods you wish to allow
        // ['access-control-allow-methods', 'GET'],

        // Request headers you wish to allow
        // ['access-control-allow-headers', 'x-requested-with,content-type'],

        // Set to true if you need the website to include cookies in the requests sent
        // to the API (e.g. in case you use sessions)
        // ['access-control-allow-credentials', 'true']
      ]
    )
    
    // sendFile(req: WebRequest, res: http.ServerResponse, fp, options: {mimetype?: string|boolean, asAttachment?: boolean, filename?: string, mtime?: string, addEtags?: boolean, cacheTimeout?: number, conditional?: boolean}={})
    if (isCallable(startResponse)) {
      startResponse(200, "OK", headers);
      res.end(wrapFile(res, fd));
      // return startResponse(req, res, {name: realFilename, fd: fd}, {headers: headers});
    } else {
      res.writeHead(200, "OK", headers);
      res.end();
    }
    return;
  }
}

