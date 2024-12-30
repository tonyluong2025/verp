import _ from "lodash";
import { http } from "../../../core";

@http.define()
export class WebsiteBackend extends http.Controller {
    static _module = module;
    
    @http.route('/website/fetchDashboardData', {type: "json", auth: 'user'})
    async fetchDashboardData(req, res, opts: {websiteId?: any, dateFrom?: any, dateTo?: any}={}) {
        const env = await req.getEnv();
        const user = await env.user();
        const website = env.items('website');
        const hasGroupSystem = await user.hasGroup('base.groupSystem');
        const hasGroupDesigner = await user.hasGroup('website.groupWebsiteDesigner');
        const dashboardData = {
            'groups': {
                'system': hasGroupSystem,
                'websiteDesigner': hasGroupDesigner
            },
            'currency': (await (await env.company()).currencyId).id,
            'dashboards': {
                'visits': {},
            }
        }

        let currentWebsite = opts.websiteId && website.browse(opts.websiteId);
        currentWebsite = currentWebsite.ok ? currentWebsite : await website.getCurrentWebsite();
        const multiWebsite = await user.hasGroup('website.groupMultiWebsite');
        let websites = multiWebsite && await env.items('website').search([]);
        websites = websites.ok ? websites : currentWebsite;
        dashboardData['websites'] = await websites.read(['id', 'label']);
        for (const [rec, website] of _.zip([...websites], [...dashboardData['websites']])) {
            website['domain'] = await rec._getHttpDomain();
            if (website['id'] === currentWebsite.id) {
                website['selected'] = true;
            }
        }
        if (hasGroupDesigner) {
            const [googleManagementClientId, googleAnalyticsKey] = await currentWebsite('googleManagementClientId', 'googleAnalyticsKey');
            if (googleManagementClientId && googleAnalyticsKey) {
                dashboardData['dashboards']['visits'] = {
                    gaClientId: googleManagementClientId || '',
                    gaAnalyticsKey: googleAnalyticsKey || '',
                }
            }
        }
        return dashboardData;
    }

    @http.route('/website/dashboard/setGaData', {type: 'json', auth: 'user'})
    async websiteSetGaData(req, res, opts: {websiteId?: any, gaClientId?: any, gaAnalyticsKey?: any}={}) {
        const env = await req.getEnv();
        const user = await env.user();
        if (! await user.hasGroup('base.groupSystem')) {
            return {
                'error': {
                    'title': await this._t(await req.getEnv(), 'Access Error'),
                    'message': await this._t(await req.getEnv(), 'You do not have sufficient rights to perform that action.'),
                }
            }
        }
        if (! opts.gaAnalyticsKey || ! opts.gaClientId.endsWith('.apps.googleusercontent.com')) {
            return {
                'error': {
                    'title': await this._t(await req.getEnv(), 'Incorrect Client ID / Key'),
                    'message': await this._t(await req.getEnv(), 'The Google Analytics Client ID or Key you entered seems incorrect.'),
                }
            }
        }
        const website = env.items('website');
        let currentWebsite = opts.websiteId && website.browse(opts.websiteId);
        currentWebsite = currentWebsite.ok ? currentWebsite : await website.getCurrentWebsite();

        await (await env.items('res.config.settings').create({
            'googleManagementClientId': opts.gaClientId,
            'googleAnalyticsKey': opts.gaAnalyticsKey,
            'websiteId': currentWebsite.id,
        })).execute();
        return true;
    }
}