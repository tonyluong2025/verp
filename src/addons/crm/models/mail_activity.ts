import { MetaModel, Model, _super } from "../../../core/models";
import { bool, update } from "../../../core/tools";

@MetaModel.define()
class MailActivity extends Model {
    static _module = module;
    static _parents = "mail.activity";

    /**
     * Small override of the action that creates a calendar.

        If the activity is linked to a crm.lead through the "opportunity_id" field, we include in
        the action context the default values used when scheduling a meeting from the crm.lead form
        view.
        e.g: It will set the partnerId of the crm.lead as default attendee of the meeting.
     * @returns 
     */
    async actionCreateCalendarEvent() {
        const action = await _super(MailActivity, this).actionCreateCalendarEvent();
        const opportunity = await (await this['calendarEventId']).opportunityId;
        if (bool(opportunity)) {
            const opportunityActionContext = await (await opportunity.actionScheduleMeeting({ smartCalendar: false })).get('context', {});
            opportunityActionContext['initialDate'] = await (await this['calendarEventId']).start;

            update(action['context'], opportunityActionContext);
        }
        return action;
    }
}