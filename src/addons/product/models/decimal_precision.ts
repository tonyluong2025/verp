import { api } from "../../../core";
import { ValidationError } from "../../../core/helper/errors";
import { MetaModel, Model } from "../../../core/models";
import { f } from "../../../core/tools";
import { floatCompare } from "../../../core/tools/float_utils";

@MetaModel.define()
class DecimalPrecision extends Model {
  static _module = module;
  static _parents = 'decimal.precision';

  @api.constrains('digits')
  async _checkMainCurrencyRounding() {
    const rounding = await (await (await this.env.company()).currencyId).rounding;
    for (const precision of this) {
      const digits = await precision.digits;
      if (await precision.label === 'Account' && floatCompare(rounding, 10 ** -digits, {precisionDigits: 6})) {
        throw new ValidationError(await this._t("You cannot define the decimal precision of 'Account' as greater than the rounding factor of the company's main currency"));
      }
    }
    return true;
  }

  @api.onchange('digits')
  async _onchangeDigits() {
    const self: any = this;
    if (await self.label !== "Product Unit of Measure") { // precisionGet() relies on this label
      return;
    }
    // We are changing the precision of UOM fields; check whether the
    // precision is equal or higher than existing units of measure.
    const rounding = 1.0 / 10.0**(await self.digits);
    const dangerousUom = await self.env.items('uom.uom').search([['rounding', '<', rounding]]);
    if (dangerousUom.ok) {
      const uomDescriptions = [];
      for (const uom of dangerousUom) {
        uomDescriptions.push(f(" - %s (id=%s, precision=%s)", await uom.label, uom.id, await uom.rounding));
      }
      return {'warning': {
        'title': await this._t('Warning!'),
        'message': await this._t(
          `You are setting a Decimal Accuracy less precise than the UOMs:\n
          %s\n
          This may cause inconsistencies in computations.\n
          Please increase the rounding of those units of measure, or the digits of this Decimal Accuracy.`, uomDescriptions.join('\n')
        ),
      }}
    }
  }
}