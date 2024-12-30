import { Fields } from "../../../core";
import { MetaModel, Model, _super } from "../../../core/models";
import { _f, f, isHtmlEmpty, plaintext2html } from "../../../core/tools";

@MetaModel.define()
class MailActivityType extends Model {
  static _module = module;
  static _parents = "mail.activity.type";

  static category = Fields.Selection({ selectionAdd: [['meeting', 'Meeting']] });
}

@MetaModel.define()
class MailActivity extends Model {
  static _module = module;
  static _parents = "mail.activity";

  static calendarEventId = Fields.Many2one('calendar.event', { string: "Calendar Meeting", ondelete: 'CASCADE' });

  async actionCreateCalendarEvent() {
    this.ensureOne();
    const action = await this.env.items("ir.actions.actions")._forXmlid("calendar.actionCalendarEvent");
    action['context'] = {
      'default_activityTypeId': (await this['activityTypeId']).id,
      'default_resId': this.env.context['default_resId'],
      'default_resModel': this.env.context['default_resModel'],
      'default_label': await this['summary'] || await this['resName'],
      'default_description': !isHtmlEmpty(await this['note']) ? await this['note'] : '',
      'default_activityIds': [[6, 0, this.ids]],
    }
    return action;
  }

  async _actionDone(feedback?: boolean, attachmentIds?: any) {
    const events = await this.mapped('calendarEventId');
    const [messages, activities] = await _super(MailActivity, this)._actionDone({ feedback: feedback, attachmentIds: attachmentIds });
    if (feedback) {
      for (const event of events) {
        let description = await event.description;
        description = f('%s<br />%s',
          !isHtmlEmpty(description) ? description : '',
          feedback ? _f(await this._t('Feedback: {feedback}'), { feedback: plaintext2html(feedback) }) : '',
        );
        await event.write({ 'description': description });
      }
    }
    return [messages, activities];
  }

  async unlinkWMeeting() {
    const events = await this.mapped('calendarEventId');
    const res = await this.unlink();
    await events.unlink();
    return res;
  }
}
