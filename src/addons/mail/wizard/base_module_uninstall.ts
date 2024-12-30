import { MetaModel, TransientModel, _super } from "../../../core/models"

@MetaModel.define()
class BaseModuleUninstall extends TransientModel {
  static _module = module;
  static _parents = "base.module.uninstall";

  async _getModels() {
    // consider mail-thread models only
    const models = await _super(BaseModuleUninstall, this)._getModels()
    return models.filtered('isMailThread');
  }
}