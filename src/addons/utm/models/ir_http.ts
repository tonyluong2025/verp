import { ServerResponse } from "http";
import { WebRequest, WebResponse } from "../../../core/http";
import { AbstractModel, MetaModel, _super } from "../../../core/models"
import { isInstance } from "../../../core/tools";

@MetaModel.define()
class IrHttp extends AbstractModel {
    static _module = module;
    static _parents = 'ir.http';

    async getUtmDomainCookies(req: WebRequest) {
        return req.host;
    }

    async _setUtm(req: WebRequest, res: WebResponse) {
        if (isInstance(res, Error)) {
            return res;
        }
        // the parent dispatch might destroy the session
        if (! req.db) {
            return res;
        }
        const domain = await this.getUtmDomainCookies(req);
        for (const [key, dummy, cook] of (await req.getEnv()).items('utm.mixin').trackingFields()) {
            if (key in req.params && req.cookie[key] !== req.params[key]) {
                res.setCookie(cook, req.params[key], {domain: domain});
            }
        }
        return res;
    }

    async _dispatch(req, res) {
        res = await _super(IrHttp, this)._dispatch(req, res);
        return this._setUtm(req, res);
    }

    async _handleException(req, res, exception) {
        res = await _super(IrHttp, this)._handleException(req, res, exception);
        return this._setUtm(req, res);
    }
}
