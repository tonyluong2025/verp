import { _Date, _Datetime, api } from "../../../core";
import { setdefault } from "../../../core/api";
import { Dict } from "../../../core/helper";
import { MetaModel, AbstractModel } from "../../../core/models"
import { bool, extend, f, len, plaintext2html } from "../../../core/tools";
import { addDate, diffDate, subDate } from "../../../core/tools/date_utils";

@MetaModel.define()
class AlarmManager extends AbstractModel {
    static _module = module;
    static _name = 'calendar.alarm.manager';
    static _description = 'Event Alarm Manager';

    async _getNextPotentialLimitAlarm(alarmType, opts: {seconds?: any, partners?: any}={}) {
        let result = new Dict<any>();
        let deltaRequest = `
            SELECT
                rel."calendarEventId", max(alarm."durationMinutes") AS "maxDelta", min(alarm."durationMinutes") AS "minDelta"
            FROM
                "calendarAlarmCalendarEventRel" AS rel
            LEFT JOIN "calendarAlarm" AS alarm ON alarm.id = rel."calendarAlarmId"
            WHERE alarm."alarmType" = '%s'
            GROUP BY rel."calendarEventId"
        `;
        let baseRequest = `
            SELECT
                cal.id,
                cal.start - interval '1' minute  * "calculDelta"."maxDelta" AS "firstAlarm",
                CASE
                    WHEN cal.recurrency THEN rrule.until - interval '1' minute  * "calculDelta"."minDelta"
                    ELSE cal.stop - interval '1' minute  * "calculDelta"."minDelta"
                END as "lastAlarm",
                cal.start as "firstEventDate",
                CASE
                    WHEN cal.recurrency THEN rrule.until
                    ELSE cal.stop
                END as "lastEventDate",
                "calculDelta"."minDelta",
                "calculDelta"."maxDelta",
                rrule.rrule AS rule
            FROM
                "calendarEvent" AS cal
            RIGHT JOIN "calculDelta" ON "calculDelta"."calendarEventId" = cal.id
            LEFT JOIN "calendarRecurrence" as rrule ON rrule.id = cal."recurrenceId"
        `;

        let filterUser = `
            RIGHT JOIN "calendarEventResPartnerRel" AS "partRel" ON "partRel"."calendarEventId" = cal.id
                AND "partRel"."resPartnerId" IN (%s)
        `;

        // Add filter on alarm type
        let tupleParams = [alarmType];

        // Add filter on partnerId
        if (bool(opts.partners)) {
            baseRequest += filterUser;
            extend(tupleParams, [String(opts.partners.ids) || 'NULL']);
        }

        // Upper bound on firstAlarm of requested events
        let firstAlarmMaxValue = "";
        if (opts.seconds == null) {
            // first alarm in the future + 3 minutes if there is one, now otherwise
            firstAlarmMaxValue = `
                COALESCE((SELECT MIN(cal.start - interval '1' minute  * "calculDelta"."maxDelta")
                FROM "calendarEvent" cal
                RIGHT JOIN "calculDelta" ON "calculDelta"."calendarEventId" = cal.id
                WHERE cal.start - interval '1' minute  * "calculDelta"."maxDelta" > now() at time zone 'utc'
            ) + interval '3' minute, now() at time zone 'utc')`;
        }
        else {
            // now + given seconds
            firstAlarmMaxValue = "(now() at time zone 'utc' + interval '%s' second )";
            extend(tupleParams, [opts.seconds,]);
        }
        await this.flush();
        const res = await this._cr.execute(f(`
            WITH "calculDelta" AS (%s)
            SELECT *
                FROM ( %s WHERE cal.active = True ) AS ALL_EVENTS
               WHERE ALL_EVENTS."firstAlarm" < '%s'
                 AND ALL_EVENTS."lastEventDate" > (now() at time zone 'utc')
        `, [deltaRequest, baseRequest, firstAlarmMaxValue]), tupleParams);

        for (const {id, firstAlarm, lastAlarm, firstEventDate, lastEventDate, minDelta, maxDelta, rule} of res) {
            result[id] = {
                'eventId': id,
                'firstAlarm': firstAlarm,
                'lastAlarm': lastAlarm,
                'firstMeeting': firstEventDate,
                'lastMeeting': lastEventDate,
                'minDuration': minDelta,
                'maxDuration': maxDelta,
                'rrule': rule
            }
          }

        // determine accessible events
        const events = this.env.items('calendar.event').browse(result);
        result = Dict.from((await events._filterAccessRules('read')).ids.map(key => [key, result[key]]));
        return result;
    }

    /**
     * Search for some alarms in the interval of time determined by some parameters (after, inTheNextXSeconds, ...)
            :param oneDate: date of the event to check (not the same that in the event browse if recurrent)
            :param event: Event browse record
            :param eventMaxdelta: biggest duration from alarms for this event
            :param inTheNextXSeconds: looking in the future (in seconds)
            :param after: if not False: will return alert if after this date (date as string - todo: change in master)
            :param missing: if not False: will return alert even if we are too late
            :param notif: Looking for type notification
            :param mail: looking for type email
     * @param oneDate 
     * @param event 
     * @param eventMaxdelta 
     * @param inTheNextXSeconds 
     * @param alarmType 
     * @param after 
     * @param missing 
     * @returns 
     */
    async doCheckAlarmForOneDate(oneDate, event, eventMaxdelta, inTheNextXSeconds, alarmType, after?: any, missing?: any) {
        const result = [];
        // TODO: remove eventMaxdelta and if using it
        let past = subDate(oneDate, {minutes: missing * eventMaxdelta});
        const future = addDate(_Datetime.now(), {seconds: inTheNextXSeconds});
        if (future <= past) {
            return result;
        }
        for (const alarm of await event.alarmIds) {
            if (await alarm.alarmType !== alarmType) {
                continue;
            }
            past = subDate(oneDate, {minutes: missing * await alarm.durationMinutes});
            if (future <= past) {
                continue;
            }
            if (after && past <= _Datetime.toDatetime(after)) {
                continue;
            }
            result.push({
                'alarmId': alarm.id,
                'eventId': event.id,
                'notifyAt': subDate(oneDate, {minutes: await alarm.durationMinutes}),
            })
        }
        return result;
    }

    /**
     * Get the events with an alarm of the given type between the cron
        last call and now.

        Please note that all new reminders created since the cron last
        call with an alarm prior to the cron last call are skipped by
        design. The attendees receive an invitation for any new event
        already.
     * @param alarmType 
     * @returns 
     */
    async _getEventsByAlarmToNotify(alarmType) {
        const lastcall = (this.env.context['lastcall'] || subDate(_Date.today(), {weeks: 1})).toISOString();
        const res = await this.env.cr.execute(`
            SELECT alarm.id AS "alarmId", event.id AS "eventId"
              FROM "calendarEvent" AS event
              JOIN "calendarAlarmCalendarEventRel" AS "eventAlarmRel"
                ON event.id = "eventAlarmRel"."calendarEventId"
              JOIN "calendarAlarm" AS alarm
                ON "eventAlarmRel"."calendarAlarmId" = alarm.id
             WHERE (
                   alarm."alarmType" = '%s'
               AND event.active
               AND event.start - CAST(alarm.duration || ' ' || alarm.interval AS Interval) >= '%s'
               AND event.start - CAST(alarm.duration || ' ' || alarm.interval AS Interval) < now() at time zone 'utc'
             )`, [alarmType, lastcall]);

        const eventsByAlarm = {}
        for (const {alarmId, eventId} of res) {
            setdefault(eventsByAlarm, alarmId, []).push(eventId);
        }
        return eventsByAlarm;
    }

    @api.model()
    async _sendReminder() {
        // Executed via cron
        const eventsByAlarm = await this._getEventsByAlarmToNotify('email');
        if (! bool(eventsByAlarm)) {
            return;
        }

        const eventIds = []
        for (const ids of Object.values<any>(eventsByAlarm)) {
          for (const id of ids) {
            if (!eventIds.includes) {
              eventIds.push(id);
            }
          }
        }
        const events = this.env.items('calendar.event').browse(eventIds);
        const attendees = await (await events.attendeeIds).filtered(async (a) => await a.state !== 'declined');
        const alarms = this.env.items('calendar.alarm').browse(Object.keys(eventsByAlarm));
        for (const alarm of alarms) {
            const alarmAttendees = await attendees.filtered(async (attendee) => eventsByAlarm[alarm.id].includes((await attendee.eventId).id));
            await (await alarmAttendees.withContext({
                mailNotifyForceSend: true,
                calendarTemplateIgnoreRecurrence: true
            }))._sendMailToAttendees(await alarm.mailTemplateId, true);
        }
    }

    @api.model()
    async getNextNotif() {
        const partner = await (await this.env.user()).partnerId;
        const allNotif = [];

        if (!bool(partner)) {
            return [];
        }

        const allMeetings = await this._getNextPotentialLimitAlarm('notification', {partners: partner});
        const timeLimit = 3600 * 24  // return alarms of the next 24 hours
        for (const eventId of allMeetings.keys()) {
            const maxDelta = allMeetings[eventId]['maxDuration'];
            const meeting = this.env.items('calendar.event').browse(eventId);
            const inDateFormat = _Datetime.toDatetime(await meeting.start);
            const lastFound = await this.doCheckAlarmForOneDate(inDateFormat, meeting, maxDelta, timeLimit, 'notification', await partner.calendarLastNotifAck);
            if (bool(lastFound)) {
                for (const alert of lastFound) {
                    allNotif.push(await this.doNotifReminder(alert));
                }
            }
        }
        return allNotif;
    }

    async doNotifReminder(alert) {
        const alarm = this.env.items('calendar.alarm').browse(await alert['alarmId']);
        const meeting = this.env.items('calendar.event').browse(await alert['eventId']);

        if (await alarm.alarmType === 'notification') {
            let message = await meeting.displayTime;
            if (await alarm.body) {
                message += f('<p>%s</p>', plaintext2html(alarm.body));
            }
            let delta: any = diffDate(await alert['notifyAt'], _Datetime.now(), ['seconds', 'days']);
            delta = delta.seconds + delta.days * 3600 * 24;

            return {
                'alarmId': alarm.id,
                'eventId': meeting.id,
                'title': await meeting.label,
                'message': message,
                'timer': delta,
                'notifyAt': _Datetime.toString(alert['notifyAt']),
            }
        }
    }

    /**
     * 
     * @param partnerIds 
     */
    async _notifyNextAlarm(partnerIds) {
        const notifications = [];
        const users = await this.env.items('res.users').search([['partnerId', 'in', Array.from(partnerIds)]]);
        for (const user of users) {
            const notif = await (await (await this.withUser(user)).withContext({allowedCompanyIds: (await user.companyIds).ids})).getNextNotif();
            notifications.push([await user.partnerId, 'calendar.alarm', notif]);
        }
        if (len(notifications) > 0) {
            await this.env.items('bus.bus')._sendmany(notifications);
        }
    }
}