import { api } from "../../../core";
import { Fields } from "../../../core/fields";
import { MetaModel, Model, _super } from "../../../core/models";

@MetaModel.define()
class ResCompany extends Model {
  static _module = module;
  static _parents = 'res.company';

  static resourceCalendarIds = Fields.One2many(
      'resource.calendar', 'companyId', { string: 'Working Hours'});
  static resourceCalendarId = Fields.Many2one(
      'resource.calendar', {string: 'Default Working Hours', ondelete: 'RESTRICT'});

  @api.model()
  async _initDataResourceCalendar() {
    await (await this.search([['resourceCalendarId', '=', false]]))._createResourceCalendar();
  }

  async _createResourceCalendar() {
    for (const company of this) {
      await company.set('resourceCalendarId', await this.env.items('resource.calendar').create({
        'label': await this._t('Standard 40 hours/week'),
        'companyId': company.id
      }).id);
    }
  }

  @api.model()
  async create(values) {
    const company = await _super(ResCompany, this).create(values);
    const resourceCalendarId = await company.resourceCalendarId;
    if (! resourceCalendarId.ok) {
      await (await company.sudo())._createResourceCalendar();
    }
    // calendar created from form view: no companyId set because record was still not created
    if (!(await resourceCalendarId.companyId).ok) {
      await resourceCalendarId.set('companyId', company.id);
    }
    return company;
  }
}