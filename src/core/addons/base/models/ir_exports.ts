import { Fields } from "../../../fields";
import { MetaModel, Model } from "../../../models";

@MetaModel.define()
class IrExports extends Model {
  static _module = module;
  static _name = 'ir.exports';
  static _description = 'Exports';
  static _order = 'label';

  static label = Fields.Char({string: 'Export Name'});
  static resource = Fields.Char({index: true});
  static exportFields = Fields.One2many('ir.exports.line', 'exportId', { string: 'Export ID', copy: true});
}

@MetaModel.define()
class IrExportsLine extends Model {
  static _module = module;
  static _name = 'ir.exports.line';
  static _description = 'Exports Line';
  static _order = 'id';

  static label = Fields.Char({string: 'Field Name'});
  static exportId = Fields.Many2one('ir.exports', {string: 'Export', index: true, ondelete: 'CASCADE'});
}