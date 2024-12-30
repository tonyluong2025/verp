import _ from "lodash";
import { AccessDenied, ValueError } from "../helper";
import * as release from "../release";
import { registry } from "..";
import { isInstance } from "../tools";
import { Environment } from "../api";

export function dispatch(method, req, ...params) {
  const exp = module.exports;
  const expMethodName = 'exp' + _.upperFirst(method);
  if (expMethodName in exp) {
    return exp[expMethodName](req, ...params);
  }
  else {
    throw new ValueError("Method not found: %s", method);
  }
}

export async function expLogin(req, db, login, password) {
    return expAuthenticate(req, db, login, password, null);
}

export async function expAuthenticate(req, db, login, password, userAgentEnv: {}={}) {
    const reg = await registry(db);
    const cr = reg.cursor();
    const resUsers = (await Environment.new(cr, global.SUPERUSER_ID, {}, false, req)).items('res.users');
    try {
        const result = await resUsers.authenticate(req, db, login, password, {...userAgentEnv, 'interactive': false});
        return result;
    } catch(e) {
      if (isInstance(e, AccessDenied)) {
        return false;
      }
      throw e;
    }
}

const RPC_VERSION_1 = {
  'serverVersion': release.version,
  'serverVersionInfo': release.versionInfo,
  'serverSerie': release.serie,
  'protocolVersion': 1,
}

export function expVersion() {
  return RPC_VERSION_1
}

/**
 * Return information about the VERP Server.
 * @param extended: if true then return version info
 * @return string if extended is false else tuple
 */
export function expAbout(extended: boolean = false) {
  const info = 'See http://theverp.com';

  if (extended) {
    return [info, release.version];
  }
  return info;
}