import { MetaModel, AbstractModel, _super } from "../../../core/models"

@MetaModel.define()
class IrHttp extends AbstractModel {
  static _module = module;
  static _parents = 'ir.http';

  async _getTranslationFrontendModulesName(req) {
    const mods = await _super(IrHttp, this)._getTranslationFrontendModulesName(req);
    return mods.concat(['portal']);
  }

  async _getFrontendLangs(req) {
    if (req && req.isFrontend) {
      return (await (await req.getEnv()).items('res.lang').getAvailable()).filter(lang => lang[3]).map(lang => lang[0]);
    }
    return _super(IrHttp, this)._getFrontendLangs(req);
  }
}