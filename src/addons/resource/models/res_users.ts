import { Fields } from "../../../core/fields";
import { MetaModel, Model, _super } from "../../../core/models";
import { bool } from "../../../core/tools/bool";
import { len } from "../../../core/tools/iterable";

@MetaModel.define()
class ResUsers extends Model {
  static _module = module;
  static _parents = 'res.users';

  static resourceIds = Fields.One2many('resource.resource', 'userId', { string: 'Resources' });
  static resourceCalendarId = Fields.Many2one(
    'resource.calendar', {string: 'Default Working Hours', related: 'resourceIds.calendarId', readonly: false});

  async write(vals) {
    const rslt = await _super(ResUsers, this).write(vals);

    const user = await this.env.user();
    // If the timezone of the admin user gets set on their first login, also update the timezone of the default working calendar
    if (bool(user) && vals['tz'] && len(this) == 1 && ! await user.loginDate
      && user.eq(await this.env.ref('base.userAdmin', false)) && this.eq(user)) {
      await (await this['resourceCalendarId']).set('tz', vals['tz']);
    }
    return rslt;
  }
}