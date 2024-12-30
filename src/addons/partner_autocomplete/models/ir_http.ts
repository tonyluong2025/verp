import { WebRequest } from "../../../core/http";
import { AbstractModel, MetaModel, _super } from "../../../core/models"

@MetaModel.define()
class Http extends AbstractModel {
    static _module = module;
    static _parents = 'ir.http';

    /**
     * Add information about iap enrich to perform
     * @returns 
     */
    async sessionInfo(req: WebRequest) {
        const sessionInfo = await _super(Http, this).sessionInfo(req);
        if (sessionInfo['isAdmin']) {
            sessionInfo['iapCompanyEnrich'] = ! await (await (await (await req.getEnv()).user()).companyId).iapEnrichAutoDone;
        }
        return sessionInfo;
    }
}