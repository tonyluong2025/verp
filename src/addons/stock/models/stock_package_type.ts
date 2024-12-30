import { Fields } from "../../../core/fields";
import { MetaModel, Model, _super } from "../../../core/models";
import { update } from "../../../core/tools/misc";

@MetaModel.define()
class PackageType extends Model {
  static _module = module;
  static _name = 'stock.package.type';
  static _description = "Stock package type";

  async _getDefaultLengthUom() {
    return this.env.items('product.template')._getLengthUomNameFromIrConfigParameter();
  }

  async _getDefaultWeightUom() {
    return this.env.items('product.template')._getWeightUomNameFromIrConfigParameter();
  }

  static label = Fields.Char('Package Type', { required: true });
  static sequence = Fields.Integer('Sequence', { default: 1, help: "The first in the sequence is the default one." });
  static height = Fields.Integer('Height', { help: "Packaging Height" });
  static width = Fields.Integer('Width', { help: "Packaging Width" });
  static packagingLength = Fields.Integer('Length', { help: "Packaging Length" });
  static maxWeight = Fields.Float('Max Weight', { help: 'Maximum weight shippable in this packaging' });
  static barcode = Fields.Char('Barcode', { copy: false });
  static weightUomName = Fields.Char({ string: 'Weight unit of measure label', compute: '_computeWeightUomName', default: self => self._getDefaultWeightUom() });
  static lengthUomName = Fields.Char({ string: 'Length unit of measure label', compute: '_computeLengthUomName', default: self => self._getDefaultLengthUom() });
  static companyId = Fields.Many2one('res.company', { string: 'Company', index: true });
  static storageCategoryCapacityIds = Fields.One2many('stock.storage.category.capacity', 'packageTypeId', { string: 'Storage Category Capacity', copy: true });

  static _sqlConstraints = [
    ['barcode_uniq', 'unique(barcode)', "A barcode can only be assigned to one package type !"],
    ['positive_height', 'CHECK(height>=0)', 'Height must be positive'],
    ['positive_width', 'CHECK(width>=0)', 'Width must be positive'],
    ['positive_length', 'CHECK("packagingLength">=0)', 'Length must be positive'],
    ['positive_max_weight', 'CHECK("maxWeight">=0.0)', 'Max Weight must be positive'],
  ];

  async _computeLengthUomName() {
    for (const packageType of this) {
      await packageType.set('lengthUomName', await this.env.items('product.template')._getLengthUomNameFromIrConfigParameter());
    }
  }

  async _computeWeightUomName() {
    for (const packageType of this) {
      await packageType.set('weightUomName', await this.env.items('product.template')._getWeightUomNameFromIrConfigParameter());
    }
  }

  async copy(defaultValue?: any) {
    defaultValue = defaultValue ?? {};
    update(defaultValue, { label: await this._t("%s (copy)", await this['label'])});
    return _super(PackageType, this).copy(defaultValue);
  }
}