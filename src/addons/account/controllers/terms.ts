import { http } from "../../../core";
import { WebRequest } from "../../../core/http";
import { bool } from "../../../core/tools";

async function *sitemapTerms(env, rule, qs: string) {
    if (qs && !'/terms'.includes(qs.toLowerCase())) {
        return;
    }
    const useInvoiceTerms = await (await env.items('ir.config.parameter').sudo()).getParam('account.useInvoiceTerms');
    if (bool(useInvoiceTerms) && await (await env.company()).termsType === 'html') {
        yield {'loc': '/terms'};
    }
}

@http.define()
class TermsController extends http.Controller {
    static _module = module;
    
    @http.route('/terms', {type: 'http', auth: 'public', website: true, sitemap: sitemapTerms})
    async termsConditions(req: WebRequest, res, opts={}) {
        const env = await req.getEnv();
        const company = await env.company();
        const useInvoiceTerms = await (await env.items('ir.config.parameter').sudo()).getParam('account.useInvoiceTerms');
        if (! (bool(useInvoiceTerms) && await company.termsType === 'html')) {
            return req.render(res, 'http_routing.httpError', {
                'statusCode': await this._t(await req.getEnv(), 'Oops'),
                'statusMessage': await this._t(await req.getEnv(), "The requested page is invalid, or doesn't exist anymore.")
            });
        }
        const values = {
            'useInvoiceTerms': useInvoiceTerms,
            'company': company
        }
        return req.render(res, "account.accountTermsConditionsPage", values);
    }
}
