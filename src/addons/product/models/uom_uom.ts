import { api } from "../../../core";
import { MetaModel, Model } from "../../../core/models";

@MetaModel.define()
class UoM extends Model {
  static _module = module;
  static _parents = 'uom.uom';

  @api.onchange('rounding')
  async _onchangeRounding() {
    const precision = await this.env.items('decimal.precision').precisionGet('Product Unit of Measure');
    if (await (this as any).rounding < 1.0 / 10.0**precision) {
      return {'warning': {
        'title': await this._t('Warning!'),
        'message': await this._t(
            "This rounding precision is higher than the Decimal Accuracy (%s digits).\nThis may cause inconsistencies in computations.\n Please set a precision between %s and 1.", precision, 1.0 / 10.0**precision),
      }}
    }
  }
}