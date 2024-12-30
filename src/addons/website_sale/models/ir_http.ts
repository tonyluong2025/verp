import { WebRequest } from "../../../core/http";
import { _super, AbstractModel } from "../../../core/models"
import { MetaModel } from "../../../core/models"
import { parseInt } from "../../../core/tools";

@MetaModel.define()
class IrHttp extends AbstractModel {
    static _module = module;
    static _parents = 'ir.http';

    async _dispatch(req: WebRequest, res) {
        const affiliateId = req.params.get('affiliateId');
        if (affiliateId) {
            req.session['affiliateId'] = parseInt(affiliateId);
        }
        return _super(IrHttp, this)._dispatch(req, res);
    }
}
