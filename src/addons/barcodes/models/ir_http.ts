
import { WebRequest } from "../../../core/http";
import { AbstractModel, MetaModel, _super } from "../../../core/models"

@MetaModel.define()
class IrHttp extends AbstractModel {
  static _module = module;
  static _parents = 'ir.http'

  async sessionInfo(req: WebRequest) {
    const res = await _super(IrHttp, this).sessionInfo(req);
    if (await (await this.env.user()).hasGroup('base.groupUser')) {
      res['maxTimeBetweenKeysInMs'] = parseInt(
        await (await this.env.items('ir.config.parameter').sudo()).getParam('barcode.maxTimeBetweenKeysInMs', '100')
      );
    }
    return res;
  }
}