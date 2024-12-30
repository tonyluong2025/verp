import { Fields, api } from "../../../core";
import { MetaModel, Model } from "../../../core/models";

@MetaModel.define()
class Contacts extends Model {
  static _module = module;
  static _name = 'calendar.filters';
  static _description = 'Calendar Filters';

  static userId = Fields.Many2one('res.users', { string: 'Me', required: true, default: self => self.env.user() });
  static partnerId = Fields.Many2one('res.partner', { string: 'Employee', required: true });
  static active = Fields.Boolean('Active', { default: true });
  static partnerChecked = Fields.Boolean('Checked', {
    default: true,
    help: "This field is used to know if the partner is checked in the filter of the calendar view for the userId."
  });

  static _sqlConstraints = [
    ['userIdPartnerIdUnique', 'UNIQUE("userId", "partnerId")', 'A user cannot have the same contact twice.']
  ];

  @api.model()
  async unlinkFromPartnerId(partnerId) {
    return (await this.search([['partnerId', '=', partnerId]])).unlink();
  }
}