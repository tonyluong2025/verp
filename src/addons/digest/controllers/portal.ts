import { ServerResponse } from "http";
import { http } from "../../../core";
import { ValueError } from "../../../core/helper/errors";
import { WebRequest } from "../../../core/http";
import { Forbidden, NotFound } from "../../../core/service";
import { urlEncode } from "../../../core/service/middleware/utils";
import { consteq } from "../../../core/tools/misc";
import { f } from "../../../core/tools/utils";

@http.define()
export class DigestController extends http.Controller {
  static _module = module;

  @http.route('/digest/<int:digestId>/unsubscribe', {type: 'http', website: true, auth: 'public'})
  async digestUnsubscribe(req: WebRequest, res: ServerResponse, opts: {digestId?: any, token?; any, userId?: any}) {
    const env = await req.getEnv();
    const digestSudo = await (await env.items('digest.digest').sudo()).browse(opts.digestId).exists();

    // new route parameters
    if (digestSudo.ok && opts.token && opts.userId) {
      const correctToken = digestSudo._getUnsubscribeToken(parseInt(opts.userId));
      if (! consteq(correctToken, opts.token)) {
        throw new NotFound(res);
      }
      await digestSudo._actionUnsubscribeUsers((await env.items('res.users').sudo()).browse(parseInt(opts.userId)));
    }
    // old route was given without any token or userId but only for auth users
    else if (digestSudo.ok && !opts.token && !opts.userId && !await (await env.user()).share) {
      await digestSudo.actionUnsubcribe();
    }
    else {
      throw new NotFound(res);
    }
    return req.render(res, 'digest.portalDigestUnsubscribed', {
      'digest': digestSudo,
    })
  }

  @http.route('/digest/<int:digestId>/setPeriodicity', {type: 'http', website: true, auth: 'user'})
  async digestSetPeriodicity(req: WebRequest, res: ServerResponse, opts: {digestId?: any, periodicity?: any}={}) {
    const env = await req.getEnv();
    if (! await (await env.user()).hasGroup('base.groupErpManager')) {
      throw new Forbidden(res);
    }
    if (!['daily', 'weekly', 'monthly', 'quarterly'].includes(opts.periodicity ?? 'weekly')) {
      throw new ValueError(await this._t(await req.getEnv(), 'Invalid periodicity set on digest'));
    }

    const digest = await env.items('digest.digest').browse(opts.digestId).exists();
    await digest.actionSetPeriodicity(opts.periodicity);

    const urlParams = {
      'model': digest._name,
      'id': digest.id,
      'activeId': digest.id,
    }
    return req.redirect(res, f('/web?#%s', urlEncode(urlParams)))
  }
}