import { Fields, api } from "../../../core";
import { MetaModel, Model } from "../../../core/models";
import { bool, f } from "../../../core/tools";

@MetaModel.define()
class Alarm extends Model {
  static _module = module;
  static _name = 'calendar.alarm';
  static _description = 'Event Alarm';

  static _intervalSelection = { 'minutes': 'Minutes', 'hours': 'Hours', 'days': 'Days' }

  static label = Fields.Char('Name', { translate: true, required: true });
  static alarmType = Fields.Selection(
    [['notification', 'Notification'], ['email', 'Email']],
    { string: 'Type', required: true, default: 'email' });
  static duration = Fields.Integer('Remind Before', { required: true, default: 1 });
  static interval = Fields.Selection(
    Object.entries(Alarm._intervalSelection), { string: 'Unit', required: true, default: 'hours' });
  static durationMinutes = Fields.Integer(
    'Duration in minutes', {
      store: true,
    search: '_searchDurationMinutes', compute: '_computeDurationMinutes',
    help: "Duration in minutes"
  });
  static mailTemplateId = Fields.Many2one(
    'mail.template', {
      string: "Email Template",
    domain: [['model', 'in', ['calendar.attendee']]],
    compute: '_computeMailTemplateId', readonly: false, store: true,
    help: "Template used to render mail reminder content."
  });
  static body = Fields.Text("Additional Message", { help: "Additional message that would be sent with the notification for the reminder" });

  @api.depends('interval', 'duration')
  async _computeDurationMinutes() {
    for (const alarm of this) {
      if (await alarm.interval === "minutes") {
        await alarm.set('durationMinutes', await alarm.duration);
      }
      else if (await alarm.interval === "hours") {
        await alarm.set('durationMinutes', await alarm.duration * 60);
      }
      else if (await alarm.interval === "days") {
        await alarm.set('durationMinutes', await alarm.duration * 60 * 24);
      }
      else {
        await alarm.set('durationMinutes', 0);
      }
    }
  }

  @api.depends('alarmType', 'mailTemplateId')
  async _computeMailTemplateId() {
    for (const alarm of this) {
      if (await alarm.alarmType === 'email' && !bool(await alarm.mailTemplateId)) {
        await alarm.set('mailTemplateId', this.env.items('ir.model.data')._xmlidToResId('calendar.calendarTemplateMeetingReminder'));
      }
      else if (await alarm.alarmType !== 'email' || !bool(await alarm.mailTemplateId)) {
        await alarm.set('mailTemplateId', false);
      }
    }
  }

  async _searchDurationMinutes(operator, value) {
    return [
      '|', '|',
      '&', ['interval', '=', 'minutes'], ['duration', operator, value],
      '&', ['interval', '=', 'hours'], ['duration', operator, value / 60],
      '&', ['interval', '=', 'days'], ['duration', operator, value / 60 / 24],
    ];
  }

  @api.onchange('duration', 'interval', 'alarmType')
  async _onchangeDurationInterval() {
    const displayInterval = Alarm._intervalSelection[await this['interval']] ?? '';
    const displayAlarmType = Object.fromEntries(await this._fields['alarmType']._descriptionSelection(this._fields['alarmType'], this.env))[await this['alarmType']];
    await this.set('label', f("%s - %s %s", displayAlarmType, await this['duration'], displayInterval));
  }
}