import assert from 'assert';
import fs from 'fs';
import path from 'node:path';
import os from 'os';
import temp from 'temp';
import util, { format } from 'util';
import { getattr, setattr } from "../api";
import { Dict } from '../helper/collections';
import { CallbackDict } from "../helper/datastructures";
import { FileNotFoundError } from '../helper/errors';
import { listDir } from '../modules/modules';
import { escapeRegExp, isInstance, split } from './func';
import { stringify } from './json';
import { sha1 } from './misc';
import { fileClose, fileRead, fileWrite } from './models';
import { urandom } from './utils';

function generateKey(salt = null) {
  if (salt == null) {
    salt = Buffer.from(stringify(salt)).toString("ascii");
  }
  const rand = urandom(30);
  return sha1(salt + Date.now().toString() + rand);
}

class ModificationTrackingDict extends CallbackDict {
  modified: boolean;

  constructor(initial = {}) {
    super();
  }

  init(initial = {}) {
    function onupdate(self) {
      setattr(self, 'modified', true);// Always make new session id
    }
    setattr(this, 'modified', false);
    super.init(initial, onupdate);//
    Object.assign(this, initial);
  }

  copy() {
    const missing = {};
    const result = new ModificationTrackingDict();
    for (const name of Object.getOwnPropertyNames(this)) {
      const val = getattr(this, name, missing);
      if (val === missing) {
        setattr(result, name, val);
      }
    }
    return result;
  }
}

export class Session extends ModificationTrackingDict {
  sid: number;
  isNew: boolean;
  context: Dict<any>;

  constructor(data, sid, isNew = false) {
    super(data);
    this.sid = sid;
    this.isNew = isNew;
    this.context = new Dict();
  }

  get shouldSave() {
    return this.modified;
  }

  [util.inspect.custom]() {
    return util.format(`<%s %s%s>`, [
      this.constructor.name,
      stringify(this),
      this.shouldSave ? "*" : "",
    ]);
  }
}

export class SessionStore {
  sessionClass: any;

  constructor(sessionClass: any) {
    if (!sessionClass) {
      sessionClass = Session;
    }
    this.sessionClass = sessionClass;
  }

  new() {
    return new this.sessionClass({}, this.generateKey(), true);
  }

  /**
   * Save a session.
   * @param session 
   */
  save(session) { }

  /**
   * Save if a session class wants an update.
   * @param session 
   */
  saveIfModified(session) {
    if (session.shouldSave) {
      this.save(session);
    }
  }

  delete(session) { }

  /**
   * Get a session for this sid or a new session object.  This method has to check if the session key is valid and create a new session if that wasn't the case.
   * @param sid 
   * @returns 
   */
  get(sid) {
    return new this.sessionClass({}, sid, true);
  }

  /**
   * Check if a key has the correct format.
   * @param key 
   */
  isValidKey(key = '') {
    return (key.match(/^[a-f0-9]{40}$/g) || []).length > 0;
  }

  generateKey(salt?: any): any {
    return generateKey(salt)
  }
}

const _fsTransactionSuffix = ".__wz_sess";

export class FilesystemSessionStore extends SessionStore {
  path: any;
  filenameTemplate: string;
  renewMissing: boolean;
  mode: number;

  constructor(
    path?: string,
    options: {
      filenameTemplate?: string,
      sessionClass?: Function,
      renewMissing?: boolean,
      mode?: number,
    } = {}
  ) {
    super(options.sessionClass);
    if (path == null) {
      path = os.tmpdir();
    }
    this.path = path;
    const filenameTemplate = options.filenameTemplate ?? "%s.sess";
    assert(!filenameTemplate.endsWith(_fsTransactionSuffix), `filename templates may not end with ${_fsTransactionSuffix}`);
    this.filenameTemplate = filenameTemplate;
    this.mode = options.mode ?? 0o644;
    this.renewMissing = options.renewMissing;
  }

  getSessionFilename(sid) {
    // out of the box, this should be a strict ASCII subset but
    // you might reconfigure the session object to have a more
    // arbitrary string.
    return path.join(this.path, util.format(this.filenameTemplate, sid));
  }

  save(session) {
    const self = this;
    const fn = this.getSessionFilename(session.sid);
    temp.track();
    temp.open({ suffix: _fsTransactionSuffix, dir: self.path }, function (err, info) {
      if (!err) {
        try {
          fileWrite(info.path, Buffer.from(stringify(Object.assign({}, session))));
        }
        finally {
          fileClose(info.fd);
        }
        try {
          fs.renameSync(info.path, fn);
          fs.chmodSync(fn, self.mode);
          // console.debug(`saved file of session #${session.sid}`);
        } catch (e) {
          // except (IOError, OSError):
          console.log(e.message);
        }
      } else {
        console.log(err);
      }
    });
  }

  delete(session) {
    try {
      const fn = this.getSessionFilename(session.sid);
      fs.unlinkSync(fn);
      // console.debug(`deleted file of session #${session.sid}`);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.log(session.sid, err);
      }
    }
  }

  get(sid) {
    if (!this.isValidKey(sid)) {
      return this.new();
    }
    let fd, data, err, file;
    try {
      file = this.getSessionFilename(sid);
      fd = fs.openSync(file, "a+");
    } catch (e) {
      if (!isInstance(e, FileNotFoundError)) {
        if (this.renewMissing) {
          return this.new();
        }
        data = {};
        err = e;
      } else {
        console.log(e.message);
        // throw e;
      }
    }
    if (!err) {
      try {
        try {
          data = JSON.parse(fileRead(fd, 'utf8') as string);
        } catch (e) {
          data = {};
        }
      } finally {
        // console.log('ses get', stringify(data));
        fileClose(fd);
      }
    }
    const session = new this.sessionClass(data, sid, false);
    session.init(data);
    return session;
  }

  /**
   * Lists all sessions in the store.
   * @returns 
   */
  list() {
    const [before, after] = split(this.filenameTemplate, "%s");
    const regFilename = new RegExp(format("%s(.{5,})%s$", escapeRegExp(before), escapeRegExp(after)));
    const result = [];
    for (const filename of listDir(this.path)) {
      // this is a session that is still being saved.
      if (filename.endsWith(_fsTransactionSuffix)) {
        continue;
      }
      const match = regFilename.exec(filename);
      if (match && match[1]) {
        result.push(match[1]);
      }
    }
    return result;
  }
}