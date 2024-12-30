import { Fields, api } from "../../../core";
import { AbstractModel, MetaModel } from "../../../core/models";

@MetaModel.define()
class MailActivityMixin extends AbstractModel {
  static _module = module;
  static _parents = 'mail.activity.mixin';

  static activityCalendarEventId = Fields.Many2one(
    'calendar.event', {
      string: "Next Activity Calendar Event",
    compute: '_computeActivityCalendarEventId', groups: "base.groupUser"
  });

  /**
   * This computes the calendar event of the next activity.
      It evaluates to false if there is no such event.
   */
  @api.depends('activityIds.calendarEventId')
  async _computeActivityCalendarEventId() {
    for (const record of this) {
      await record.set('activityCalendarEventId', await (await record.activityIds).slice(0, 1).calendarEventId);
    }
  }
}