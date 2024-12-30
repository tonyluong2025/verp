import { Fields, api } from "../../../core";
import { MetaModel, TransientModel, _super } from "../../../core/models"
import { bool } from "../../../core/tools/bool";

@MetaModel.define()
class ResConfigSettings extends TransientModel {
  static _module = module;
  static _parents = 'res.config.settings';

  static portalAllowApiKeys = Fields.Boolean(
    {string: 'Customer API Keys',
    compute: '_computePortalAllowApiKeys',
    inverse: '_inversePortalAllowApiKeys'}
  );

  async _computePortalAllowApiKeys() {
    for (const setting of this) {
      await setting.set('portalAllowApiKeys', await (await this.env.items('ir.config.parameter').sudo()).getParam('portal.allowApiKeys'));
    }
  }

  async _inversePortalAllowApiKeys() {
    await (await this.env.items('ir.config.parameter').sudo()).setParam('portal.allowApiKeys', await this['portalAllowApiKeys']);
  }

  @api.model()
  async getValues() {
    const res = await _super(ResConfigSettings, this).getValues();
    res['portalAllowApiKeys'] = bool(await (await this.env.items('ir.config.parameter').sudo()).getParam('portal.allowApiKeys'));
    return res;
  }
}