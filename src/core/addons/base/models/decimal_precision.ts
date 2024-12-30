import { tools } from "../../..";
import * as api from "../../../api";
import { Fields } from "../../../fields"
import { Model, MetaModel, _super } from "../../../models"

@MetaModel.define()
class DecimalPrecision extends Model {
  static _module = module;
  static _name = 'decimal.precision';
  static _description = "Decimal Precision";

  static label = Fields.Char('Usage', {required: true});
  static digits = Fields.Integer('Digits', {required: true, default: 2});

  static _sqlConstraints = [
    ['label_uniq', 'unique (label)', "Only one value can be defined for each given usage!"],
  ]

  @api.model()
  @tools.ormcache('application')
  async precisionGet(application): Promise<number> {
    await this.flush(['label', 'digits']);
    const res = await this.env.cr.execute('select digits from "decimalPrecision" where label=$1', {bind: [application]});
    return res.length ? res[0]['digits'] : 2
  }

  @api.modelCreateMulti()
  async create(valsList) {
    const res = await _super(DecimalPrecision, this).create(valsList);
    this.clearCaches();
    return res;
  }
}
