import { ServerResponse } from "http";
import { http } from "../../../core";
import { UserError } from "../../../core/helper/errors";
import { WebRequest } from "../../../core/http";
import { stringify } from "../../../core/tools/json";
import { dispatch } from "../models/bus";

@http.define()
export class BusController extends http.Controller {
  static _module = module;
  
  // override to add channels
  async _poll(req: WebRequest, res: ServerResponse, dbname, channels, last, options) {
    channels = Array.from(channels)  // do not alter original list
    channels.push('broadcast');
    // update the user presence
    if (req.session.uid && 'busInactivity' in options) {
      await (await req.getEnv()).items('bus.presence').updateBus({inactivityPeriod: options['busInactivity'], identityField: 'userId', identityValue: req.session.uid});
    }
    await (await req.getCr()).close();
    req.cr = null;
    return dispatch.poll(req, res, dbname, channels, last, options);
  }

  @http.route('/longpolling/poll', {type: "json", auth: "public", cors: "*"})
  async poll(req: WebRequest, res: ServerResponse, opts: {channels?: any, last?: any}={}) {
    if (! dispatch) {
      throw new Error("bus.Bus unavailable");
    }
    if (opts.channels?.filter(c => typeof(c) !== 'string').length) {
      throw new Error("bus.Bus only string channels are allowed.");
    }
    if ((await req.getRegistry()).inTestMode()) {
      throw new UserError(await this._t(await req.getEnv(), "bus.Bus not available in test mode"));
    }
    return this._poll(req, res, req.db, opts.channels, opts.last, opts);
  }

  @http.route('/longpolling/imStatus', {type: "json", auth: "user"})
  async imStatus(req: WebRequest, res: ServerResponse, opts: {partnerIds?: any}={}) {
    return (await (await (await req.getEnv()).items('res.partner').withContext({activeTest: false})).search([['id', 'in', opts.partnerIds]])).read(['imStatus']);
  }

  @http.route('/longpolling/health', {type: 'http', auth: 'none', saveSession: false})
  async health(req: WebRequest, res: ServerResponse) {
    const data = stringify({
      'status': 'pass',
    })
    const headers = [['Content-Type', 'application/json'], ['Cache-Control', 'no-store']];
    return req.makeResponse(res, data, headers);
  }
}