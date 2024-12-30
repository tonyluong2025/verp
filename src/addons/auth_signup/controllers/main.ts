import { ServerResponse } from "http";
import { http, tools } from "../../../core";
import { ensureDb, Home } from "../../../core/addons/web/controllers/main";
import { WebRequest } from "../../../core/http";

@http.define()
class AuthSignupHome extends Home {
  static _module = module;

  @http.route()
  async webLogin(req: WebRequest, res: ServerResponse, args: {} = {}) {
    await ensureDb(req, res);
    const response = await super.webLogin(req, res, args);
    Object.assign(response.qcontext, await this.getAuthSignupConfig(req));
    if (req.httpRequest.method === 'GET' && req.session.uid && req.params['redirect']) {
      // Redirect if already logged in and redirect param is present
      return req.redirect(response.httpResponse, req.params['redirect']);
    }
    return response;
  }

  /**
   * retrieve the module config (which features are enabled) for the login page
   * @returns 
   */
  async getAuthSignupConfig(req) {
    const env = await req.getEnv();
    const conf = await env.items('ir.config.parameter').sudo();
    return {
      'disableDatabaseManager': !tools.config.get('listDb'),
      'signupEnabled': await env.items('res.users')._getSignupInvitationScope() === 'b2c',
      'resetPasswordEnabled': await conf.getParam('auth_signup.resetPassword') === 'true',
    }
  }
}