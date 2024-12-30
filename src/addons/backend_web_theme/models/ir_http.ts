import { WebRequest } from "../../../core/http";
import { AbstractModel, MetaModel, _super } from "../../../core/models"
import { bool, update } from "../../../core/tools";

@MetaModel.define()
class IrHttp extends AbstractModel {
    static _module = module;
    static _parents = "ir.http";

    async sessionInfo(req: WebRequest) {
        const result = await _super(IrHttp, this).sessionInfo(req);
        const company = req.session.uid && await (await (await req.getEnv()).user()).companyId;
        const blendMode = bool(company) && await company.backgroundBlendMode || false;
        update(result, {
            themeBackgroundBlendMode: blendMode || "normal",
            themeHasBackgroundImage: bool(company) && await company.backgroundImage
        })
        return result;
    }
}