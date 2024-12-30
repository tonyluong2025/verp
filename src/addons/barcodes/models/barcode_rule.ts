import { api } from "../../../core"
import { Fields } from "../../../core/fields"
import { ValidationError } from "../../../core/helper/errors"
import { MetaModel, Model } from "../../../core/models"
import { len } from "../../../core/tools/iterable"
import { _f } from "../../../core/tools/utils"

@MetaModel.define()
class BarcodeRule extends Model {
  static _module = module;
  static _name = 'barcode.rule'
  static _description = 'Barcode Rule'
  static _order = 'sequence asc, id'

  static label = Fields.Char({string: 'Rule Name', size: 32, required: true, help: 'An internal identification for this barcode nomenclature rule'})
  static barcodeNomenclatureId = Fields.Many2one('barcode.nomenclature', {string: 'Barcode Nomenclature'})
  static sequence = Fields.Integer({string: 'Sequence', help: 'Used to order rules such that rules with a smaller sequence match first'})
  static encoding = Fields.Selection([
    ['any', 'Any'],
    ['ean13', 'EAN-13'],
    ['ean8', 'EAN-8'],
    ['upca', 'UPC-A'],
  ], {string: 'Encoding', required: true, default: 'any', help: 'This rule will apply only if the barcode is encoded with the specified encoding'})
  static type = Fields.Selection([
    ['alias', 'Alias'],
    ['product', 'Unit Product'],
  ], {string: 'Type', required: true, default: 'product'})
  static pattern = Fields.Char({string: 'Barcode Pattern', size: 32, help: "The barcode matching pattern", required: true, default: '.*'})
  static alias = Fields.Char({string: 'Alias', size: 32, default: '0', help: 'The matched pattern will alias to this barcode', required: true})

  @api.constrains('pattern')
  async _checkPattern() {
    for (const rule of this) {
      const pattern: string = await rule.pattern;
      const p = pattern.replace('\\\\', 'X').replace('\\{', 'X').replace('\\}', 'X');
      const findall = Array.from(p.matchAll(/[{]|[}]/g));  // p does not contain escaped { or }
      if (len(findall) == 2) {
        if (! p.match(/[{][N]*[D]*[}]/)) {
          throw new ValidationError(_f(await this._t("There is a syntax error in the barcode pattern {pattern}: braces can only contain N's followed by D's."), {pattern: pattern}));
        }
        else if (p.match(/[{][}]/)) {
          throw new ValidationError(_f(await this._t("There is a syntax error in the barcode pattern {pattern}: empty braces."), {pattern: pattern}));
        }
      }
      else if (len(findall) != 0) {
        throw new ValidationError(_f(await this._t("There is a syntax error in the barcode pattern {pattern}: a rule can only contain one pair of braces."), {pattern: pattern}));
      }
      else if (p === '*') {
        throw new ValidationError(await this._t(" '*' is not a valid Regex Barcode Pattern. Did you mean '.*' ?"));
      }
    }
  }
}