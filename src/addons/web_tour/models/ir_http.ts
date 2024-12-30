import { WebRequest } from "../../../core/http";
import { AbstractModel, MetaModel, _super } from "../../../core/models";

@MetaModel.define()
class IrHttp extends AbstractModel {
  static _module = module;
  static _parents = 'ir.http';

  async sessionInfo(req: WebRequest) {
    const result = await _super(IrHttp, this).sessionInfo(req);
    if (result['isAdmin']) {
      const demoModulesCount = await (await this.env.items('ir.module.module').sudo()).searchCount([['demo', '=', true]]);
      result['webTours'] = await (await req.getEnv()).items('web.tour.tour').getConsumedTours();
      result['tourDisable'] = demoModulesCount > 0;
    }
    return result;
  }
}