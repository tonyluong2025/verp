import { _Date, api } from "../../../core";
import { MetaModel, Model, _super } from "../../../core/models";
import { getModuleIcon } from "../../../core/modules";
import { combine, dateSetTz } from "../../../core/tools/date_utils";

@MetaModel.define()
class Users extends Model {
  static _module = module;
  static _parents = 'res.users';

  async _systrayGetCalendarEventDomain() {
    const user = await this.env.user();
    const tz = await user.tz;
    const startDt = new Date();
    let startDate;
    if (tz) {
      startDate = _Date.today(dateSetTz(startDt, tz));// timezone(tz).localize(startDt).astimezone(UTC).date();
    }
    else {
      startDate = _Date.today();
    }
    let endDt = combine(startDate, 'max');
    if (tz) {
      endDt = _Date.today(dateSetTz(endDt, tz));//timezone(tz).localize(endDt).astimezone(UTC)
    }
    return ['&', '|',
      '&',
      '|',
      ['start', '>=', startDt.toISOString()],
      ['stop', '>=', startDt.toISOString()],
      ['start', '<=', endDt.toISOString()],
      '&',
      ['allday', '=', true],
      ['startDate', '=', _Date.toString(startDate)],
      ['attendeeIds.partnerId', '=', (await user.partnerId).id]];
  }

  @api.model()
  async systrayGetActivities() {
    const res: any[] = await _super(Users, this).systrayGetActivities();

    let meetingsLines = await this.env.items('calendar.event').searchRead(
      await this._systrayGetCalendarEventDomain(),
      ['id', 'start', 'label', 'allday', 'attendeeStatus'],
      { order: 'start' });
    meetingsLines = meetingsLines.map(line => line['attendeeStatus'] !== 'declined');
    if (meetingsLines.length) {
      const meetingLabel = await this._t("Today's Meetings");
      const meetingsSystray = {
        'type': 'meeting',
        'label': meetingLabel,
        'model': 'calendar.event',
        'icon': getModuleIcon(this.env.items('calendar.event')._originalModule),
        'meetings': meetingsLines,
      }
      res.unshift(meetingsSystray);
    }
    return res;
  }
}