import _ from "lodash";
import { Fields, _Datetime, api } from "../../../core";
import { MetaModel, Model } from "../../../core/models";
import { bool, f, len, next } from "../../../core/tools";

@MetaModel.define()
class Partner extends Model {
  static _module = module;
  static _parents = 'res.partner';

  static meetingCount = Fields.Integer("# Meetings", { compute: '_computeMeetingCount' });
  static meetingIds = Fields.Many2many('calendar.event', { relation: 'calendarEventResPartnerRel', column1: 'resPartnerId', column2: 'calendarEventId', string: 'Meetings', copy: false });
  static calendarLastNotifAck = Fields.Datetime('Last notification marked as read from base Calendar', { default: () => _Datetime.now() });

  async _computeMeetingCount() {
    const result = await this._computeMeeting();
    for (const p of this) {
      await p.set('meetingCount', len(result[p.id] ?? []));
    }
  }

  async _computeMeeting() {
    if (bool(this.ids)) {
      const allPartners: any[] = await (await this.withContext({ activeTest: false })).searchRead([['id', 'childOf', this.ids]], ["parentId"]);

      const query = await this.env.items('calendar.event')._search([], {isQuery: true});  // ir.rules will be applied
      const [subqueryString, subqueryParams] = query.select();
      const subquery = f(subqueryString, ...subqueryParams);

      const meetingData = await this.env.cr.execute(`
                SELECT "resPartnerId", "calendarEventId", COUNT(1)::int
                  FROM "calendarEventResPartnerRel"
                 WHERE "resPartnerId" IN (%s) AND "calendarEventId" IN (%s)
                GROUP BY "resPartnerId", "calendarEventId"
            `, [String(allPartners.map(p => p['id'])) || 'NULL', subquery]);

      // Create a dict {partnerId: eventIds} and fill with events linked to the partner
      const meetings = Object.fromEntries(allPartners.map(p => [p['id'], []]));
      for (const m of meetingData) {
        meetings[m['resPartnerId']].push(m['calendarEventId']);
      }

      // Add the events linked to the children of the partner
      for (const p of allPartners) {
        let partner = p;
        while (bool(partner)) {
          if (this.ids.includes(partner["id"])) {
            meetings[partner["id"]] = _.union(meetings[partner["id"]], meetings[p["id"]]);
          }
          partner = next(allPartners.filter(pt => partner["parentId"] && pt["id"] == partner["parentId"][0]), null);
        }
      }
      return Object.fromEntries(this.ids.map(id => [id, meetings[id]]));
    }
    return {}
  }

  /**
   * Return a list of dict of the given meetings with the attendees details
      Used by:
          - base_calendar.js : Many2ManyAttendee
          - calendar_model.js (calendar.CalendarModel)
   * @param meetingIds 
   * @returns 
   */
  async getAttendeeDetail(meetingIds) {
    const attendeesDetails = [];
    const meetings = this.env.items('calendar.event').browse(meetingIds);
    const meetingsAttendees = await meetings.mapped('attendeeIds');
    const user = await this.env.user();
    for (const partner of this) {
      const partnerInfo = (await partner.nameGet())[0];
      for (const attendee of await meetingsAttendees.filtered(async (att) => (await att.partnerId).eq(partner))) {
        const attendeeIsOrganizer = user.eq(await (await attendee.eventId).userId) && (await attendee.partnerId).eq(await user.partnerId);
        attendeesDetails.push({
          'id': partnerInfo[0],
          'label': partnerInfo[1],
          'status': await attendee.state,
          'eventId': (await attendee.eventId).id,
          'attendeeId': attendee.id,
          'isAlone': await (await attendee.eventId).isOrganizerAlone && attendeeIsOrganizer,
          // attendees data is sorted according to this key in JS.
          'isOrganizer': (await attendee.partnerId).eq(await (await (await attendee.eventId).userId).partnerId) ? 1 : 0
        });
      }
    }
    return attendeesDetails;
  }

  @api.model()
  async _setCalendarLastNotifAck() {
    const partner = await this.env.items('res.users').browse(this.env.context['uid'] ?? this.env.uid).partnerId;
    await partner.write({ 'calendarLastNotifAck': _Datetime.now() });
  }

  async scheduleMeeting() {
    this.ensureOne();
    const partnerIds = this.ids;
    partnerIds.push((await (await this.env.user()).partnerId).id);
    const action = await this.env.items("ir.actions.actions")._forXmlid("calendar.actionCalendarEvent");
    action['context'] = {
      'default_partnerIds': partnerIds,
    }
    action['domain'] = ['|', ['id', 'in', (await this._computeMeeting())[this.id]], ['partnerIds', 'in', this.ids]];
    return action;
  }
}