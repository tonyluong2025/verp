import { Fields } from "../../../core/fields";
import { MetaModel, Model } from "../../../core/models";

@MetaModel.define()
class ResPartner extends Model {
  static _module = module;
  static _parents = 'res.partner';

  static teamId = Fields.Many2one(
    'crm.team', {
      string: 'Sales Team',
    help: 'If set, this Sales Team will be used for sales and assignments related to this partner'
  })
}
