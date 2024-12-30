import { Fields } from "../../../core/fields"
import { MetaModel, Model } from "../../../core/models"

@MetaModel.define()
class View extends Model {
  static _module = module;
  static _parents = 'ir.ui.view';

  static type = Fields.Selection({selectionAdd: [['activity', 'Activity']]});
}