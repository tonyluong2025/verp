import { Fields } from "../../../core/fields"
import { MetaModel, Model } from "../../../core/models"

@MetaModel.define()
class ActwindowView extends Model {
  static _module = module;
  static _parents = 'ir.actions.actwindow.view'

  static viewMode = Fields.Selection({selectionAdd: [
    ['activity', 'Activity']
  ], ondelete: {'activity': 'CASCADE'}})
}