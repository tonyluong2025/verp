import { registry } from "..";
import { consteq } from "../tools/misc";

export async function check(req, db, uid, passwd) {
  const resUsers = (await registry(db)).models['res.users'];
  return resUsers.check(req, db, uid, passwd)
}

export async function computeSessionToken(session, env) {
  const self = env.items('res.users').browse(session.uid);
  return self._computeSessionToken(session.sid);
}

export async function checkSession(session, env) {
  const self = env.items('res.users').browse(session.uid);
  const expected = await self._computeSessionToken(session.sid);
  if (expected && consteq(expected, session.sessionToken)) {
    return true;
  }
  return false;
}