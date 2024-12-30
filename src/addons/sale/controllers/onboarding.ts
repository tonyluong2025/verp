import { http } from "../../../core"

@http.define()
class OnboardingController extends http.Controller {
    static _module = module;
    /**
     * Returns the `banner` for the sale onboarding panel.
            It can be empty if the user has closed it or if he doesn't have
            the permission to see it.
     * @param req 
     * @param res 
     * @returns 
     */
    @http.route('/sales/saleQuotationOnboardingPanel', {auth: 'user', type: 'json'})
    async saleQuotationOnboarding(req, res) {
        const env = await req.getEnv();
        const company = await env.company();
        if (! await env.isAdmin() || await company.saleQuotationOnboardingState === 'closed') {
            return {};
        }

        return {
            'html': await (await env.ref('sale.saleQuotationOnboardingPanel'))._render({
                'company': company,
                'state': await company.getAndUpdateSaleQuotationOnboardingState()
            })
        }
    }
}
