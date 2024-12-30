import { DateTime } from 'luxon';
import { RRule, Weekday, rrulestr } from 'rrule';
import { Fields, _Date, api } from '../../../core';
import { _tzGet } from '../../../core/addons/base';
import { getattr } from '../../../core/api';
import { UserError } from '../../../core/helper';
import { MetaModel, Model } from '../../../core/models';
import { _f, allTimezones, bool, extend, f, isInstance, len, parseInt, quoteList } from '../../../core/tools';
import { addDate, combine, dateSetTz, dateWithoutTz, subDate } from '../../../core/tools/date_utils';

const MAX_RECURRENT_EVENT = 720;

const SELECT_FREQ_TO_RRULE = {
    'daily': RRule.DAILY,
    'weekly': RRule.WEEKLY,
    'monthly': RRule.MONTHLY,
    'yearly': RRule.YEARLY,
}

const RRULE_FREQ_TO_SELECT = {
    [RRule.DAILY]: 'daily',
    [RRule.WEEKLY]: 'weekly',
    [RRule.MONTHLY]: 'monthly',
    [RRule.YEARLY]: 'yearly',
}

const RRULE_WEEKDAY_TO_FIELD = {
    [RRule.MO.weekday]: 'mon',
    [RRule.TU.weekday]: 'tue',
    [RRule.WE.weekday]: 'wed',
    [RRule.TH.weekday]: 'thu',
    [RRule.FR.weekday]: 'fri',
    [RRule.SA.weekday]: 'sat',
    [RRule.SU.weekday]: 'sun',
}

const RRULE_WEEKDAYS = {'SUN': 'SU', 'MON': 'MO', 'TUE': 'TU', 'WED': 'WE', 'THU': 'TH', 'FRI': 'FR', 'SAT': 'SA'}

export const RRULE_TYPE_SELECTION = [
    ['daily', 'Days'],
    ['weekly', 'Weeks'],
    ['monthly', 'Months'],
    ['yearly', 'Years'],
]

export const END_TYPE_SELECTION = [
    ['count', 'Number of repetitions'],
    ['endDate', 'End date'],
    ['forever', 'Forever'],
]

export const MONTH_BY_SELECTION = [
    ['date', 'Date of month'],
    ['day', 'Day of month'],
]

export const WEEKDAY_SELECTION = [
    ['MON', 'Monday'],
    ['TUE', 'Tuesday'],
    ['WED', 'Wednesday'],
    ['THU', 'Thursday'],
    ['FRI', 'Friday'],
    ['SAT', 'Saturday'],
    ['SUN', 'Sunday'],
]

export const BYDAY_SELECTION = [
    ['1', 'First'],
    ['2', 'Second'],
    ['3', 'Third'],
    ['4', 'Fourth'],
    ['-1', 'Last'],
]

export function freqToSelect(rruleFreq) {
    return RRULE_FREQ_TO_SELECT[rruleFreq];
}

export function freqToRrule(freq) {
    return SELECT_FREQ_TO_RRULE[freq];
}

export function weekdayToField(weekdayIndex) {
    return RRULE_WEEKDAY_TO_FIELD[weekdayIndex];
}

@MetaModel.define()
class RecurrenceRule extends Model {
    static _module = module;
    static _name = 'calendar.recurrence';
    static _description = 'Event Recurrence Rule';

    static label = Fields.Char({compute: '_computeLabel', store: true});
    static baseEventId = Fields.Many2one('calendar.event', {ondelete: 'SET NULL', copy: false});  // store=False ?
    static calendarEventIds = Fields.One2many('calendar.event', 'recurrenceId');
    static eventTz = Fields.Selection(_tzGet, {string: 'Timezone', default: async (self) => self.env.context['tz'] || await (await self.env.user()).tz});
    static rrule = Fields.Char({compute: '_computeRrule', inverse: '_inverseRrule', store: true});
    static dtstart = Fields.Datetime({compute: '_computeDtstart'});
    static rruleType = Fields.Selection(RRULE_TYPE_SELECTION, {default: 'weekly'});
    static endType = Fields.Selection(END_TYPE_SELECTION, {default: 'count'});
    static interval = Fields.Integer({default: 1});
    static count = Fields.Integer({default: 1});
    static mon = Fields.Boolean();
    static tue = Fields.Boolean();
    static wed = Fields.Boolean();
    static thu = Fields.Boolean();
    static fri = Fields.Boolean();
    static sat = Fields.Boolean();
    static sun = Fields.Boolean();
    static monthBy = Fields.Selection(MONTH_BY_SELECTION, {default: 'date'});
    static day = Fields.Integer({default: 1});
    static weekday = Fields.Selection(WEEKDAY_SELECTION, {string: 'Weekday'});
    static byday = Fields.Selection(BYDAY_SELECTION, {string: 'By day'});
    static until = Fields.Date('Repeat Until');

    static _sqlConstraints = [
        ['monthDay', 
        f(`CHECK ("rruleType" != 'monthly'
                OR "monthBy" != 'day'
                OR day >= 1 AND day <= 31
                OR weekday in (%s) AND byday in (%s))`,
                quoteList(WEEKDAY_SELECTION.map(wd => wd[0])), quoteList(BYDAY_SELECTION.map(bd => bd[0]))),
         "The day must be between 1 and 31"],
    ];

    @api.depends('rrule')
    async _computeLabel() {
        for (const recurrence of this) {
            const period = Object.fromEntries(RRULE_TYPE_SELECTION)[await recurrence.rruleType];
            const every = _f(await this._t("Every {count} {period}"), {count: await recurrence.interval, period: period});

            let end, on;
            if (await recurrence.endType === 'count') {
                end = await this._t("for %s events", await recurrence.count);
            }
            else if (await recurrence.endType === 'endDate') {
                end = await this._t("until %s", await recurrence.until);
            }
            else {
                end = '';
            }

            if (await recurrence.rruleType === 'weekly') {
                let weekdays = await recurrence._getWeekDays();
                // Convert Weekday object
                weekdays = weekdays.map(w => String(w));
                // We need to get the day full name from its three first letters.
                const weekMap = Object.fromEntries(Object.entries(RRULE_WEEKDAYS).map(([k, v]) => [v, k]));
                const weekdayShort = weekdays.map(w => weekMap[w]);
                const dayStrings = WEEKDAY_SELECTION.filter(d => weekdayShort.includes(d[0])).map(d => d[1])
                on = await this._t("on %s", dayStrings.join(', '));
            }
            else if (await recurrence.rruleType === 'monthly') {
                if (await recurrence.monthBy === 'day') {
                    const weekdayLabel = Object.fromEntries(BYDAY_SELECTION)[await recurrence.byday];
                    on = _f(await this._t("on the {position} {weekday}"), {position: await recurrence.byday, weekday: weekdayLabel});
                }
                else {
                    on = await this._t("day %s", await recurrence.day);
                }
            }
            else {
                on = '';
            }
            await recurrence.set('label', [every, on, end].filter(s => s).join(' '));
        }
    }

    @api.depends('calendarEventIds.start')
    async _computeDtstart() {
        const groups = await this.env.items('calendar.event').readGroup([['recurrenceId', 'in', this.ids]], ['start:min'], ['recurrenceId']);
        const startMapping = Object.fromEntries(groups.map(group => [group['recurrenceId'][0], group['start']]));
        for (const recurrence of this) {
            await recurrence.set('dtstart', startMapping[recurrence.id]);
        }
    }

    @api.depends(
        'byday', 'until', 'rruleType', 'monthBy', 'interval', 'count', 'endType',
        'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun', 'day', 'weekday')
    async _computeRrule() {
        for (const recurrence of this) {
            await recurrence.set('rrule', await recurrence._rruleSerialize());
        }
    }

    async _inverseRrule() {
        for (const recurrence of this) {
            if (await recurrence.rrule) {
                const values = await this._rruleParse(await recurrence.rrule, await recurrence.dtstart);
                await recurrence.write(values);
            }
        }
    }

    /**
     * :param ranges: iterable of tuples (datetimeStart, datetimeStop)
        :return: tuple (events of the recurrence already in sync with ranges,
                 and ranges not covered by any events)
     * @param ranges 
     * @returns 
     */
    async _reconcileEvents(ranges) {
        ranges = new Set(ranges);

        const syncedEvents = await (await this['calendarEventIds']).filtered(async (e) => ranges.has(await e._range()));

        const existingRanges = new Set(await syncedEvents.map(async (event) => event._range()));
        const rangesToCreate = Array.from(ranges).filter(eventRange => !existingRanges.has(eventRange));
        return [syncedEvents, new Set(rangesToCreate)];
    }

    /**
     * when the base event is no more available (archived, deleted, etc.), a new one should be selected
     */
    async _selectNewBaseEvent() {
        for (const recurrence of this) {
            await recurrence.set('baseEventId', await recurrence._getFirstEvent());
        }
    }

    /**
     * Create missing events in the recurrence and detach events which no longer
        follow the recurrence rules.
        :return: detached events
     * @param specificValuesCreation 
     * @param noSendEdit 
     * @param genericValuesCreation 
     */
    async _applyRecurrence(specificValuesCreation?: {}, noSendEdit?: boolean, genericValuesCreation?: {}) {
        const eventVals = [];
        let keep = this.env.items('calendar.event');
        if (specificValuesCreation == null) {
            specificValuesCreation = {};
        }

        for (const recurrence of await this.filtered('baseEventId')) {
            await recurrence.set('calendarEventIds', (await recurrence.calendarEventIds).or(await recurrence.baseEventId));
            const event = bool(await recurrence.baseEventId) ? await recurrence.baseEventId : await recurrence._getFirstEvent(false);
            const duration = await event.stop - await event.start;
            let ranges, eventsToKeep, baseValues;
            if (bool(specificValuesCreation)) {
                ranges = new Set(Object.keys(specificValuesCreation).map(x => x.split(',')).filter(x => x[0] == recurrence.id).map(x => String([x[1], x[2]])));
            }
            else {
                ranges = await recurrence._rangeCalculation(event, duration);
            }

            [eventsToKeep, ranges] = await recurrence._reconcileEvents(ranges);
            keep = keep.or(eventsToKeep);
            [baseValues] = await event.copyData();
            const values = [];
            for (const [start, stop] of ranges) {
                const value = Object.assign({}, baseValues, {start: start, stop: stop, recurrenceId: recurrence.id, followRecurrence: true});
                const key = String([recurrence.id, start, stop]);
                if (key in specificValuesCreation) {
                    value.update(specificValuesCreation[key]);
                }
                if (bool(genericValuesCreation) && recurrence.id in genericValuesCreation) {
                    value.update(genericValuesCreation[recurrence.id]);
                }
                extend(values, value[value]);
            }
            extend(eventVals, values);
        }

        const events = (await this['calendarEventIds']).sub(keep);
        const detachedEvents = await this._detachEvents(events);
        await (await this.env.items('calendar.event').withContext({noMailToAttendees: true, mailCreateNolog: true})).create(eventVals);
        return detachedEvents;
    }

    /**
     * Stops the current recurrence at the given event and creates a new one starting
        with the event.
        :param event: starting point of the new recurrence
        :param recurrenceValues: values applied to the new recurrence
        :return: new recurrence
     * @param event 
     * @param recurrenceValues 
     * @returns 
     */
    async _splitFrom(event, recurrenceValues?: any) {
        if (recurrenceValues == null) {
            recurrenceValues = {};
        }
        event.ensureOne();
        if (! bool(this)) {
            return;
        }
        const [values] = await this.copyData() as {}[];
        const detachedEvents = await this._stopAt(event);

        const count = (recurrenceValues['count'] ?? 0) || len(detachedEvents);
        return this.create({
            ...values,
            ...recurrenceValues,
            'baseEventId': event.id,
            'calendarEventIds': [[6, 0, detachedEvents.ids]],
            'count': Math.max(count, 1),
        });
    }

    /**
     * Stops the recurrence at the given event. Detach the event and all following
        events from the recurrence.

        :return: detached events from the recurrence
     * @param event 
     * @returns 
     */
    async _stopAt(event) {
        this.ensureOne();
        const events = this._getEventsFrom(await event.start);
        const detachedEvents = await this._detachEvents(events);
        if (! bool(await this['calendarEventIds'])) {
            await (await this.withContext({archiveOnError: true})).unlink();
            return detachedEvents;
        }

        let until;
        if (await event.allday) {
            until = await this._getStartOfPeriod(await event.startDate);
        }
        else {
            const untilDatetime = await this._getStartOfPeriod(await event.start);
            const untilTimezoned = DateTime.fromJSDate(untilDatetime, {zone: await this._getTimezone()}).toJSDate();
            until = _Date.today(untilTimezoned);
        }
        await this.write({
            'endType': 'endDate',
            'until': subDate(until, {days: 1}),
        })
        return detachedEvents;
    }

    @api.model()
    async _detachEvents(events) {
        await events.write({
            'recurrenceId': false,
            'recurrency': false,
        })
        return events;
    }

    /**
     * Write values on events in the recurrence.
        :param values: event values
        :param dstart: if provided, only write events starting from this point in time
     * @param values 
     * @param dtstart 
     * @returns 
     */
    async _writeEvents(values, dtstart?: Date) {
        const events = dtstart ? await this._getEventsFrom(dtstart) : await this['calendarEventIds'];
        return (await events.withContext({noMailToAttendees: true, dontNotify: true})).write(Object.assign(values, {recurrenceUpdate: 'selfOnly'}));
    }

    /**
     * Compute rule string according to value type RECUR of iCalendar
        :return: string containing recurring rule (empty if no rule)
     * @returns 
     */
    async _rruleSerialize() {
        if (await this['interval'] <= 0) {
            throw new UserError(await this._t('The interval cannot be negative.'));
        }
        if (await this['endType'] === 'count' && await this['count'] <= 0) {
            throw new UserError(await this._t('The number of repetitions cannot be negative.'));
        }

        return await this['rruleType'] ? String(await this._getRrule()) : '';
    }

    /**
     * 
     * @param ruleStr. ex: DTSTART:20240515T103320RRULE:FREQ=WEEKLY;WKST=SU;COUNT=1;BYDAY=WE 
     * @param dateStart 
     */
    @api.model()
    async _rruleParse(ruleStr: string, dateStart: Date) {
        // LUL TODO clean this mess
        const data = {};
        const dayList = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

        // if ('Z' in ruleStr && dateStart && !dateStart.tzinfo) {
        //     dateStart = pytz.utc.localize(dateStart);
        // }
        const rule = rrulestr(ruleStr, {dtstart: dateStart});
        const opts = rule.options;
        data['rruleType'] = freqToSelect(opts.freq);
        data['count'] = opts.count;
        data['interval'] = opts.interval;
        data['until'] = opts.until;
        // Repeat weekly
        if (opts.byweekday) {
            for (const weekday of dayList) {
                data[weekday] = false;  // reset
            }
            for (const weekdayIndex of opts.byweekday) {
                const weekday = new Weekday(weekdayIndex);
                data[weekdayToField(weekday.weekday)] = true;
                data['rruleType'] = 'weekly';
            }
        }

        // Repeat monthly by nweekday ((weekday, weeknumber), )
        if (opts.bynweekday) {
            data['weekday'] = dayList[opts.bynweekday[0][0]].toUpperCase();
            data['byday'] = String(opts.bynweekday)[0][1];
            data['monthBy'] = 'day';
            data['rruleType'] = 'monthly';
        }

        if (opts.bymonthday) {
            data['day'] = opts.bymonthday[0];
            data['monthBy'] = 'date';
            data['rruleType'] = 'monthly';
        }

        // Repeat yearly but for verp it's monthly, take same information as monthly but interval is 12 times
        if (opts.bymonth) {
            data['interval'] *= 12;
        }
        if (data['until']) {
            data['endType'] = 'endDate';
        }
        else if (data['count']) {
            data['endType'] = 'count';
        }
        else {
            data['endType'] = 'forever';
        }
        return data;
    }

    async _getLangWeekStart() {
        const lang = this.env.items('res.lang')._langGet(await (await this.env.user()).lang);
        const weekStart = parseInt(await lang.weekStart)  // lang.weekStart ranges from '1' to '7'
        return new Weekday(weekStart - 1) // rrule expects an int from 0 to 6
    }

    async _getStartOfPeriod(dt) {
        let start;
        if (await this['rruleType'] === 'weekly') {
            const weekStart = await this._getLangWeekStart();
            console.log('Must check _getStartOfPeriod');
            start = addDate(dt, {days: 7});//{weekday: weekStart.nth(-1)});
        }
        else if (await this['rruleType'] === 'monthly') {
            start = addDate(dt, {day: 1});
        }
        else {
            start = dt;
        }
        // Comparaison of DST (to manage the case of going too far back in time).
        // If we detect a change in the DST between the creation date of an event
        // and the date used for the occurrence period, we use the creation date of the event.
        // This is a hack to avoid duplication of events (for example on google calendar).
        if (isInstance(dt, Date)) {
            const timezone = await this._getTimezone();
            // Tony check
            // dstDt = timezone.localize(dt).dst()
            // dstStart = timezone.localize(start).dst()
            // if dstDt != dstStart:
            //     start = dt
        }
        return start
    }

    async _getFirstEvent(includeOutliers: boolean=false) {
        if (!bool(await this['calendarEventIds'])) {
            return this.env.items('calendar.event');
        }
        let events = await (await this['calendarEventIds']).sorted('start');
        if (! includeOutliers) {
            events = events.sub(await this._getOutliers());
        }
        return events.slice(0,1);
    }

    async _getOutliers() {
        let syncedEvents = this.env.items('calendar.event');
        for (const recurrence of this) {
            if (bool(await recurrence.calendarEventIds)) {
                const start = Math.min(await (await recurrence.calendarEventIds).mapped('start'));
                const starts = await recurrence._getOccurrences(start);
                syncedEvents = syncedEvents.or(await (await recurrence.calendarEventIds).filtered(async (e) => starts.includes(e.start)));
            }
        }
        return (await this['calendarEventIds']).sub(syncedEvents);
    }

    /**
     * Calculate the range of recurrence when applying the recurrence
        The following issues are taken into account:
            start of period is sometimes in the past (weekly or monthly rule).
            We can easily filter these range values but then the count value may be wrong...
            In that case, we just increase the count value, recompute the ranges and dismiss the useless values
     * @param event 
     * @param duration 
     * @returns 
     */
    async _rangeCalculation(event, duration) {
        this.ensureOne();
        const originalCount = await this['endType'] === 'count' && await this['count'];
        let ranges = new Set<any>(await this._getRanges(await event.start, duration));
        const start = await event.start;
        const futureEvents = Array.from(ranges).filter(([x, y]) => x.toDateString() >= start.toDateString() && y.toDateString() >= start.toDateString()).map(([x,y]) => String([x, y]));
        if (originalCount && len(futureEvents) < originalCount) {
            // Rise count number because some past values will be dismissed.
            await this.set('count', (2*originalCount) - len(futureEvents));
            ranges = new Set(await this._getRanges(start, duration));
            // We set back the occurrence number to its original value
            await this.set('count', originalCount);
        }
        // Remove ranges of events occurring in the past
        ranges = new Set(Array.from(ranges).filter(([x, y]) => x.toDateString() >= start.toDateString() && y.toDateString() >= start.toDateString()).map(([x,y]) => String([x, y])));
        return ranges
    }

    async _getRanges(start, eventDuration) {
        const starts = await this._getOccurrences(start);
        return starts.map(start => [start, addDate(start, eventDuration)]);
    }

    async _getTimezone() {
        const timezone = await this['eventTz'] || this.env.context['tz'] || 'UTC';
        return allTimezones.includes(timezone) ? timezone : false;
    }

    /**
     * Get ocurrences of the rrule
        :param dtstart: start of the recurrence
        :return: iterable of datetimes
     * @param dtstart 
     * @returns 
     */
    async _getOccurrences(dtstart: Date) {
        this.ensureOne();
        dtstart = await this._getStartOfPeriod(dtstart);
        if (this._isAllday()) {
            return (await this._getRrule(dtstart=dtstart)).all();
        }

        const timezone = await this._getTimezone();
        // Localize the starting datetime to avoid missing the first occurrence
        dtstart = dateSetTz(dtstart, timezone);
        // dtstart is given as a naive datetime, but it actually represents a timezoned datetime
        // (rrule package expects a naive datetime)
        const occurences = await this._getRrule(dateWithoutTz(dtstart));

        /*
        # Special timezoning is needed to handle DST (Daylight Saving Time) changes.
        # Given the following recurrence:
        #   - monthly
        #   - 1st of each month
        #   - timezone US/Eastern (UTC−05:00)
        #   - at 6am US/Eastern = 11am UTC
        #   - from 2019/02/01 to 2019/05/01.
        # The naive way would be to store:
        # 2019/02/01 11:00 - 2019/03/01 11:00 - 2019/04/01 11:00 - 2019/05/01 11:00 (UTC)
        #
        # But a DST change occurs on 2019/03/10 in US/Eastern timezone. US/Eastern is now UTC−04:00.
        # From this point in time, 11am (UTC) is actually converted to 7am (US/Eastern) instead of the expected 6am!
        # What should be stored is:
        # 2019/02/01 11:00 - 2019/03/01 11:00 - 2019/04/01 10:00 - 2019/05/01 10:00 (UTC)
        #                                                  *****              *****
        */
        return occurences.all().map(occurrence => dateWithoutTz(dateSetTz(dtstart, 'UTC')));
    }

    async _getEventsFrom(dtstart) {
        return this.env.items('calendar.event').search([
            ['id', 'in', (await this['calendarEventIds']).ids],
            ['start', '>=', dtstart]
        ]);
    }

    /**
     * 
     * @returns tuple of rrule weekdays for this recurrence.
     */
    async _getWeekDays() {
        const res = [];
        for (const [weekdayIndex, weekday] of Object.entries({
            [RRule.MO.weekday]: await this['mon'],
            [RRule.TU.weekday]: await this['tue'],
            [RRule.WE.weekday]: await this['wed'],
            [RRule.TH.weekday]: await this['thu'],
            [RRule.FR.weekday]: await this['fri'],
            [RRule.SA.weekday]: await this['sat'],
            [RRule.SU.weekday]: await this['sun'],
        })) {
            if (weekday) {
                res.push(new Weekday(parseInt(weekdayIndex)));
            }
        }
        return res;
    }

    /**
     * Returns whether a majority of events are allday or not (there might be some outlier events)
     */
    async _isAllday() {
        let score = await (await this['calendarEventIds']).sum(async (e) => await e.allday ? 1 : -1);
        return score >= 0;
    }

    async _getRrule(dtstart?: any) {
        this.ensureOne();
        const freq = await this['rruleType'];
        const rruleParams = {
            dtstart: dtstart,
            interval: await this['interval'],
        }
        if (freq === 'monthly' && await this['monthBy'] === 'date') { //# e.g. every 15th of the month
            rruleParams['bymonthday'] = await this['day'];
        }
        else if (freq === 'monthly' && await this['monthBy'] === 'day') {  // e.g. every 2nd Monday in the month
            rruleParams['byweekday'] = getattr(RRule, RRULE_WEEKDAYS[await this['weekday']])(parseInt(await this['byday']));
            // e.g. MO(+2) for the second Monday of the month
        }
        else if (freq === 'weekly') {
            const weekdays = await this._getWeekDays();
            if (! weekdays) {
                throw new UserError(await this._t("You have to choose at least one day in the week"));
            }
            rruleParams['byweekday'] = weekdays;
            rruleParams['wkst'] = await this._getLangWeekStart();
        }
        if (await this['endType'] === 'count') {  // e.g. stop after X occurence
            rruleParams['count'] = Math.min(await this['count'], MAX_RECURRENT_EVENT);
        }
        else if (await this['endType'] === 'forever') {
            rruleParams['count'] = MAX_RECURRENT_EVENT;
        }
        else if (await this['endType'] === 'endDate') { // e.g. stop after 12/10/2020
            rruleParams['until'] = combine(await this['until'], 'max');
        }
        return new RRule({
            ...freqToRrule(freq), ...rruleParams
        });
    }
}