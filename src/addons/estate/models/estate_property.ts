import { Fields } from "../../../core/fields";
import { MetaModel, Model } from "../../../core/models";

@MetaModel.define()
class EstateProperty extends Model {
  static _module = module;
  static _name = 'estate.property';
  static _description = 'Estate Property';

  static label = Fields.Char({required: true});
  static price = Fields.Float({ digits: 0, readonly: true, help: 'The currency of rate 1 to the rate of the currency.'});
  static note = Fields.Char('Notes');
  static active = Fields.Boolean('Active', { default: true, help: "If unchecked, it will allow you to hide the property without removing it." });
}