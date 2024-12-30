import { http } from "../../../core"
import { WebRequest } from "../../../core/http";
import { expression } from "../../../core/osv";
import { bool, convertFile, len, parseInt } from "../../../core/tools";

@http.define()
class PosController extends http.Controller {
    static _module = module;

    /**
     * Open a pos session for the given config.

        The right pos session will be selected to open, if non is open yet a new session will be created.

        /pos/ui and /pos/web both can be used to acces the POS. On the SaaS,
        /pos/ui uses HTTPS while /pos/web uses HTTP.

        :param debug: The debug mode to load the session in.
        :type debug: str.
        :param configId: id of the config that has to be loaded.
        :type configId: str.
        :returns: object -- The rendered pos session.
     * @param req 
     * @param res 
     * @param opts 
     * @returns 
     */
    @http.route(['/pos/web', '/pos/ui'], {type: 'http', auth: 'user'})
    async posWeb(req: WebRequest, res, opts: {configId?: any}={}) {
        let domain = [
            ['state', 'in', ['opening', 'opened']],
            ['userId', '=', req.session.uid],
            ['rescue', '=', false]
        ];
        if (opts.configId) {
            domain = expression.AND([domain, [['configId', '=', parseInt(opts.configId)]]]);
        }
        const env = await req.getEnv();
        const sudo = await env.items('pos.session').sudo();
        let posSession = await sudo.search(domain, {limit: 1});

        // The same POS session can be opened by a different user => search without restricting to
        // current user. Note: the config must be explicitly given to avoid fallbacking on a random
        // session.
        if (! bool(posSession) && opts.configId) {
            domain = [
                ['state', 'in', ['opening', 'opened']],
                ['rescue', '=', false],
                ['configId', '=', parseInt(opts.configId)],
            ];
            posSession = await sudo.search(domain, {limit: 1});
        }
        if (!bool(posSession)) {
            return req.redirect(res, '/web#action=point_of_sale.actionClientPosMenu');
        }
        // The POS only work in one company, so we enforce the one of the session in the context
        const company = await posSession.companyId;
        const sessionInfo = await env.items('ir.http').sessionInfo(req);
        sessionInfo['userContext']['allowedCompanyIds'] = company.ids;
        sessionInfo['userCompanies'] = {'currentCompany': company.id, 'allowedCompanies': {[company.id]: sessionInfo['userCompanies']['allowedCompanies'][company.id]}}
        const context = {
            'sessionInfo': sessionInfo,
            'loginNumber': await posSession.login(),
        }
        const response = await req.render(res, 'point_of_sale.index', context);
        response.setHeader('Cache-Control', 'no-store');
        return response;
    }

    @http.route('/pos/ui/tests', {type: 'http', auth: "user"})
    async testSuite(req: WebRequest, res, opts: {mod?: any}={}) {
        const domain = [
            ['state', '=', 'opened'],
            ['userId', '=', req.session.uid],
            ['rescue', '=', false]
        ];
        const env = await req.getEnv();
        const posSession = await (await env.items('pos.session').sudo()).search(domain, {limit: 1});
        const sessionInfo = await env.items('ir.http').sessionInfo(req);
        sessionInfo['userContext']['allowedCompanyIds'] = (await posSession.companyId).ids;
        const context = {
            'sessionInfo': sessionInfo,
        }
        return req.render(res, 'point_of_sale.qunitSuite', context);
    }

    @http.route('/pos/saleDetailsReport', {type: 'http', auth: 'user'})
    async printSaleDetails(req: WebRequest, res, opts: {dateStart?: any, dateStop?: any}={}) {
        const env = await req.getEnv();
        const r = env.items('pos.report.saledetails'),
        [pdf] = await (await (await env.ref('point_of_sale.saleDetailsReport')).withContext({dateStart: opts.dateStart, dateStop: opts.dateStop}))._renderQwebPdf(r);
        const pdfhttpheaders = [['Content-Type', 'application/pdf'], ['Content-Length', String(len(pdf))]];
        return req.makeResponse(res, pdf, pdfhttpheaders);
    }

    @http.route('/pos/loadOnboardingData', {type: 'json', auth: 'user'})
    async loadOnboardingData(req: WebRequest, res) {
        await convertFile(await req.getEnv(), 'point_of_sale', 'data/point_of_sale_onboarding.xml', {}, 'init', false, 'data');
    }
}
