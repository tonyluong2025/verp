import { AccessError } from "../../../core/helper";
import { MetaModel, TransientModel, _super } from "../../../core/models";

@MetaModel.define()
class APIKeyDescription extends TransientModel {
  static _module = module;
  static _parents = 'res.users.apikeys.description';

  async checkAccessMakeKey() {
    try {
      return _super(APIKeyDescription, this).checkAccessMakeKey();
    } catch(e) {
    // except AccessError:
      if (await (await this.env.items('ir.config.parameter').sudo()).getParam('portal.allowApiKeys')) {
        if (await this.userHasGroups('base.groupPortal')) {
          return;
        }
        else {
          throw new AccessError(await this._t("Only internal and portal users can create API keys"));
        }
      }
      throw e;
    }
  }
}