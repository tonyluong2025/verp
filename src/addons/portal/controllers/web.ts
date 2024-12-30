import { http } from "../../../core";
import * as main from "../../../core/addons/web/controllers";

@http.define()
class PortalHome extends main.Home {
    static _module = module;

    @http.route()
    async index(req, res, opts: {}={}) {
        if (req.session.uid && ! await (await (await req.getEnv()).items('res.users').sudo()).browse(req.session.uid).hasGroup('base.groupUser')) {
            return req.redirectQuery(res, '/my', req.params);
        }
        return super.index(req, res, opts);
    }

    async _loginRedirect(req, res, uid, redirect?: any) {
        if (! redirect && ! await (await (await req.getEnv()).items('res.users').sudo()).browse(uid).hasGroup('base.groupUser')) {
            redirect = '/my';
        }
        return super._loginRedirect(req, res, uid, redirect);
    }

    @http.route('/web', {type: 'http', auth: "none"})
    async webClient(req, res, opts: {sAction?: any}={}) {
        if (req.session.uid && ! await (await (await req.getEnv()).items('res.users').sudo()).browse(req.session.uid).hasGroup('base.groupUser')) {
            return req.redirectQuery(res, '/my', req.params.query, req.params.code);
        }
        return super.webClient(req, res, opts);
    }
}