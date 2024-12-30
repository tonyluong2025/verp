import { ServerResponse } from "http";
import { http } from "../../../core"
import { WebRequest } from "../../../core/http";

@http.define()
class OnboardingController extends http.Controller {
  static _module = module;

  /**
   * Returns the `banner` for the account invoice onboarding panel. 
      It can be empty if the user has closed it or if he doesn't have the permission to see it.
   * @param req 
   * @param res 
   * @param opts 
   * @returns 
   */
  @http.route('/account/accountInvoiceOnboarding', { type: 'json', auth: "user" })
  async accountInvoiceOnboarding(req: WebRequest, res: ServerResponse) {
    const env = await req.getEnv();
    const company = await env.company();
    if (! await env.isAdmin() || await company.accountInvoiceOnboardingState === 'closed') {
      return {}
    }

    return {
      'html': await (await env.ref('account.accountInvoiceOnboardingPanel'))._render({
        'company': company,
        'state': company.getAndUpdateAccountInvoiceOnboardingState()
      })
    }
  }

  /**
   * Returns the `banner` for the account dashboard onboarding panel.
      It can be empty if the user has closed it or if he doesn't have the permission to see it.
   * @param req 
   * @param res 
   * @param opts 
   * @returns 
   */
  @http.route('/account/accountDashboardOnboarding', { type: 'json', auth: "user" })
  async accountDashboardOnboarding(req, res) {
    const env = await req.getEnv();
    const company = await env.company();

    if (! await env.isAdmin() || await company.accountDashboardOnboardingState === 'closed') {
      return {};
    }

    return {
      'html': await (await env.ref('account.accountDashboardOnboardingPanel'))._render({
        'company': company,
        'state': await company.getAndUpdateAccountDashboardOnboardingState()
      })
    }
  }
}