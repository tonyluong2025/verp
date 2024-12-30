import { MetaModel, Model, _super } from "../../../core/models"

@MetaModel.define()
class ResCurrency extends Model {
  static _module = module;
  static _parents = 'res.currency';

  async _activateGroupMultiCurrency() {
    // for Sale/ POS - Multi currency flows require pricelists
    await _super(ResCurrency, this)._activateGroupMultiCurrency();
    const groupUser = await (await this.env.ref('base.groupUser')).sudo();
    await groupUser._applyGroup(await this.env.ref('product.groupProductPricelist'));
  }
}