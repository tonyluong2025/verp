import { http } from "../../../core"
import { bool, parseInt } from "../../../core/tools";
import * as mail from '../../mail';

@http.define()
class CrmController extends http.Controller {
    static _module = module;

    @http.route('/lead/caseMarkWon', {type: 'http', auth: 'user', methods: ['GET']})
    async crmLeadCaseMarkWon(req, res, opts: {resId?: number, token?: string}={}) {
        const [comparison, record, redirect] = await mail.MailController._checkTokenAndRecordOrRedirect(req, res, 'crm.lead', parseInt(opts.resId), opts.token);
        if (comparison && bool(record)) {
            try {
                await record.actionSetWonRainbowman();
            }catch(e) {
                console.error("Could not mark crm.lead as won");
                return mail.MailController._redirectToMessaging(req, res);
            }
        }
        return redirect;
    }

    @http.route('/lead/caseMarkLost', {type: 'http', auth: 'user', methods: ['GET']})
    async crmLeadCaseMarkLost(req, res, opts: {resId?: number, token?: string}={}) {
        const [comparison, record, redirect] = await mail.MailController._checkTokenAndRecordOrRedirect(req, res, 'crm.lead', parseInt(opts.resId), opts.token);
        if (comparison && bool(record)) {
            try {
                await record.actionSetLost();
            } catch(e) {
                console.error("Could not mark crm.lead as lost");
                return mail.MailController._redirectToMessaging(req, res);
            }
        }
        return redirect;
    }

    @http.route('/lead/convert', {type: 'http', auth: 'user', methods: ['GET']})
    async crmLeadConvert(req, res, opts: {resId?: number, token?: string}={}) {
        const [comparison, record, redirect] = await mail.MailController._checkTokenAndRecordOrRedirect(req, res, 'crm.lead', parseInt(opts.resId), opts.token);
        if (comparison && bool(record)) {
            try {
                await record.convertOpportunity((await record.partnerId).id);
            } catch(e) {
                console.error("Could not convert crm.lead to opportunity");
                return mail.MailController._redirectToMessaging(req, res);
            }
        }
        return redirect;
    }
}
