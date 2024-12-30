import { WebRequest } from "../../../core/http";
import { MetaModel, AbstractModel, _super } from "../../../core/models";

@MetaModel.define()
class IrHttp extends AbstractModel {
    static _module = module;
    static _parents = 'ir.http';

    async sessionInfo(req: WebRequest) {
        const result = await _super(IrHttp, this).sessionInfo(req);
        const env = await req.getEnv();
        if (await (await env.user()).hasGroup('base.groupUser')) {
            result['showEffect'] = await (await env.items('ir.config.parameter').sudo()).getParam('base_setup.showEffect');
        }
        return result;
    }
}