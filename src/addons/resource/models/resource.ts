import { getAllTimezones } from "countries-and-timezones";
import { DateTime } from "luxon";
import { RRule } from 'rrule';
import { api, tools } from "../../../core";
import { _tzGet } from "../../../core/addons/base";
import { Fields, _Date, _Datetime } from "../../../core/fields";
import { DefaultDict2, Dict, MapKey } from "../../../core/helper";
import { ValidationError } from "../../../core/helper/errors";
import { MetaModel, Model, _super } from "../../../core/models";
import { expression } from "../../../core/osv";
import { f, parseInt, update } from "../../../core/tools";
import { bool } from "../../../core/tools/bool";
import { addDate, dateMax, dateMin, diffDate, floatToTime, subDate } from "../../../core/tools/date_utils";
import { floatRound } from "../../../core/tools/float_utils";
import { chain, enumerate, len, range, rangeList, sorted, zip } from "../../../core/tools/iterable";

// Default hour per day value. The one should
// only be used when the one from the calendar
// is not available.
const HOURS_PER_DAY = 8
// This will generate 16th of days
const ROUNDING_FACTOR = 16

/**
 * Return ``dt`` with an explicit timezone, together with a function to
        convert a datetime to the same (naive or aware) timezone as ``dt``.
 * @param dt 
 * @returns 
 */
function makeAware(dt: string | Date): any[] {
    return [new Date(dt), (val: Date) => val.setTime(val.getTime() + new Date(dt).getTimezoneOffset() * 60000)];
}

/**
 * Iterate on the boundaries of intervals.
 * @param intervals 
 * @param opening 
 * @param closing 
 */
function* boundaries(intervals, opening, closing) {
    for (const [start, stop, recs] of intervals) {
        if (start < stop) {
            yield [start, opening, recs];
            yield [stop, closing, recs];
        }
    }
}
/**
 * Collection of ordered disjoint intervals with some associated records.
        Each interval is a triple ``(start, stop, records)``, where ``records``
        is a recordset.
 */
class Intervals {
    private _items: any[];

    constructor(intervals: any[] = []) {
        this._items = [];
        if (intervals.length) {
            // normalize the representation of intervals
            const starts = [];
            const recses = [];
            for (const [value, flag, recs] of sorted(boundaries(intervals, 'start', 'stop'))) {
                if (flag === 'start') {
                    starts.push(value);
                    recses.push(recs);
                }
                else {
                    const start = starts.pop();
                    if (!len(starts)) {
                        this._items.push([start, value, recses[0].union(recses)]);
                        recses.length = 0;
                    }
                }
            }
        }
    }

    _bool() {
        return this._items.length > 0;
    }

    get length() {
        return this._items.length;
    }
}

/**
 * Calendar model for a resource. It has

     - attendanceIds: list of resource.calendar.attendance that are a working
                       interval in a given weekday.
     - leaveIds: list of leaves linked to this calendar. A leave can be general
                  or linked to a specific resource, depending on its resource_id.

    All methods in this class use intervals. An interval is a tuple holding
    (beginDatetime, end_datetime). A list of intervals is therefore a list of
    tuples, holding several intervals of work or leaves.
 */
@MetaModel.define()
class ResourceCalendar extends Model {
    static _module = module;
    static _name = "resource.calendar";
    static _description = "Resource Working Time";

    @api.model()
    async defaultGet(fields) {
        const res = await _super(ResourceCalendar, this).defaultGet(fields);
        if (!res['label'] && res['companyId']) {
            res['label'] = await this._t('Working Hours of %s', await this.env.items('res.company').browse(res['companyId']).label);
        }
        if ('attendanceIds' in fields && !res['attendanceIds']) {
            const companyId = res['companyId'] ?? (await this.env.company()).id;
            const company = this.env.items('res.company').browse(companyId);
            const companyAttendanceIds = await (await company.resourceCalendarId).attendanceIds;
            if (bool(companyAttendanceIds)) {
                res['attendanceIds'] = [];
                for (const attendance of companyAttendanceIds) {
                    res['attendanceIds'].push(
                        [0, 0, await attendance.getDict(['label', 'dayofweek', 'hourFrom', 'hourTo', 'dayPeriod'])]
                    );
                }
            }
            else {
                res['attendanceIds'] = [
                    [0, 0, { 'label': await this._t('Monday Morning'), 'dayofweek': '0', 'hourFrom': 8, 'hourTo': 12, 'dayPeriod': 'morning' }],
                    [0, 0, { 'label': await this._t('Monday Afternoon'), 'dayofweek': '0', 'hourFrom': 13, 'hourTo': 17, 'dayPeriod': 'afternoon' }],
                    [0, 0, { 'label': await this._t('Tuesday Morning'), 'dayofweek': '1', 'hourFrom': 8, 'hourTo': 12, 'dayPeriod': 'morning' }],
                    [0, 0, { 'label': await this._t('Tuesday Afternoon'), 'dayofweek': '1', 'hourFrom': 13, 'hourTo': 17, 'dayPeriod': 'afternoon' }],
                    [0, 0, { 'label': await this._t('Wednesday Morning'), 'dayofweek': '2', 'hourFrom': 8, 'hourTo': 12, 'dayPeriod': 'morning' }],
                    [0, 0, { 'label': await this._t('Wednesday Afternoon'), 'dayofweek': '2', 'hourFrom': 13, 'hourTo': 17, 'dayPeriod': 'afternoon' }],
                    [0, 0, { 'label': await this._t('Thursday Morning'), 'dayofweek': '3', 'hourFrom': 8, 'hourTo': 12, 'dayPeriod': 'morning' }],
                    [0, 0, { 'label': await this._t('Thursday Afternoon'), 'dayofweek': '3', 'hourFrom': 13, 'hourTo': 17, 'dayPeriod': 'afternoon' }],
                    [0, 0, { 'label': await this._t('Friday Morning'), 'dayofweek': '4', 'hourFrom': 8, 'hourTo': 12, 'dayPeriod': 'morning' }],
                    [0, 0, { 'label': await this._t('Friday Afternoon'), 'dayofweek': '4', 'hourFrom': 13, 'hourTo': 17, 'dayPeriod': 'afternoon' }]
                ];
            }
        }
        return res;
    }

    static label = Fields.Char({ required: true });
    static active = Fields.Boolean("Active", {
        default: true,
        help: "If the active field is set to false, it will allow you to hide the Working Time without removing it."
    });
    static companyId = Fields.Many2one(
        'res.company', {
        string: 'Company',
        default: self => self.env.company()
    });
    static attendanceIds = Fields.One2many('resource.calendar.attendance', 'calendarId', { string: 'Working Time', compute: '_computeAttendanceIds', store: true, readonly: false, copy: true
    });
    static leaveIds = Fields.One2many('resource.calendar.leaves', 'calendarId', { string: 'Time Off' });
    static globalLeaveIds = Fields.One2many(
        'resource.calendar.leaves', 'calendarId', { string: 'Global Time Off',
        compute: '_computeGlobalLeaveIds', store: true, readonly: false,
        domain: [['resourceId', '=', false]], copy: true
    });
    static hoursPerDay = Fields.Float("Average Hour per Day", {
        default: HOURS_PER_DAY,
        help: "Average hours per day a resource is supposed to work with this calendar."
    });
    static tz = Fields.Selection(_tzGet, {
        string: 'Timezone', required: true,
        default: async (self) => self._context['tz'] || await (await self.env.user()).tz || 'UTC',
        help: "This field is used in order to define in which timezone the resources will work."
    });
    static tzOffset = Fields.Char({ compute: '_computeTzOffset', string: 'Timezone offset', invisible: true });
    static twoWeeksCalendar = Fields.Boolean({ string: "Calendar in 2 weeks mode" });
    static twoWeeksExplanation = Fields.Char('Explanation', { compute: "_computeTwoWeeksExplanation" });

    @api.depends('companyId')
    async _computeAttendanceIds() {
        for (const calendar of await this.filtered(async (c) => !bool(c._origin) || !(await c._origin.companyId).eq(await c.companyId))) {
            const companyCalendar = await (await calendar.companyId).resourceCalendarId;
            const attendanceIds = [];
            for (const attendance of await companyCalendar.attendanceIds) {
                if (! await attendance.resourceId) {
                    attendanceIds.push([0, 0, await attendance._copyAttendanceVals()]);
                }
            }
            await calendar.write({
                'twoWeeksCalendar': await companyCalendar.twoWeeksCalendar,
                'hoursPerDay': await companyCalendar.hoursPerDay,
                'tz': await companyCalendar.tz,
                'attendanceIds': [[5, 0, 0]].concat(attendanceIds)
            });
        }
    }

    @api.depends('companyId')
    async _computeGlobalLeaveIds() {
        for (const calendar of await this.filtered(async (c) => !bool(c._origin) || !(await c._origin.companyId).eq(await c.companyId))) {
            const globalLeaveIds = [];
            for (const leave of await (await (await calendar.companyId).resourceCalendarId).globalLeaveIds) {
                globalLeaveIds.push([0, 0, await leave._copyLeaveVals()]);
            }
            await calendar.write({
                'globalLeaveIds': [[5, 0, 0]].concat(globalLeaveIds)
            });
        }
    }

    @api.depends('tz')
    async _computeTzOffset() {
        for (const calendar of this) {
            const userDate = DateTime.fromISO(DateTime.now().toISODate(), { zone: await calendar.tz || 'UTC' }).toJSDate();
            const tzOffset = userDate.getTimezoneOffset();
            await calendar.set('tzOffset', (tzOffset >= 0 ? '+' : '-') + Math.abs(tzOffset).toString().padStart(4, '0'));
        }
    }

    @api.returns('self', (value) => value.id)
    async copy(defaultValue?: any) {
        this.ensureOne();
        if (defaultValue == null) {
            defaultValue = {};
        }
        if (!defaultValue['label']) {
            Object.assign(defaultValue, { label: await this._t('%s (copy)', this['label']) });
        }
        return _super(ResourceCalendar, this).copy(defaultValue);
    }

    @api.constrains('attendanceIds')
    async _checkAttendanceIds() {
        for (const resource of this) {
            const attendanceIds = await resource.attendanceIds;
            if (await resource.twoWeeksCalendar &&
                await attendanceIds.filtered(async (a) => await a.displayType === 'lineSection') &&
                ! await (await attendanceIds.sorted('sequence'))[0].displayType) {
                throw new ValidationError(await this._t("In a calendar with 2 weeks mode, all periods need to be in the sections."));
            }
        }
    }

    @api.depends('twoWeeksCalendar')
    async _computeTwoWeeksExplanation() {
        const today = _Date.today();
        const weekType = await this.env.items('resource.calendar.attendance').getWeekType(today);
        const weekTypeStr = weekType ? await this._t("second") : await this._t("first");
        const firstDay = DateTime.fromJSDate(today).startOf('week');
        const lastDay = DateTime.fromJSDate(today).endOf('week');
        await this.set('twoWeeksExplanation', await this._t("The current week (from %s to %s) correspond to the  %s one.", firstDay, lastDay, weekTypeStr));
    }

    async _getGlobalAttendances() {
        return (await this['attendanceIds']).filtered(async (attendance) =>
            ! await attendance.dateFrom && ! await attendance.dateTo
            && ! await attendance.resourceId && ! await attendance.displayType)
    }

    async _computeHoursPerDay(attendances) {
        if (!bool(attendances)) {
            return 0;
        }

        let hourCount = 0.0;
        for (const attendance of attendances) {
            hourCount += await attendance.hourTo - await attendance.hourFrom;
        }
        let numberOfDays;
        if (await this['twoWeeksCalendar']) {
            numberOfDays = len(new Set(await (await attendances.filtered(async (cal) => await cal.weekType === '1')).mapped('dayofweek')));
            numberOfDays += len(new Set(await (await attendances.filtered(async (cal) => await cal.weekType === '0')).mapped('dayofweek')));
        }
        else {
            numberOfDays = len(new Set(await attendances.mapped('dayofweek')));
        }

        return floatRound(hourCount / numberOfDays, { precisionDigits: 2 });
    }

    @api.onchange('attendanceIds', 'twoWeeksCalendar')
    async _onchangeHoursPerDay() {
        const attendances = await this._getGlobalAttendances();
        await this.set('hoursPerDay', this._computeHoursPerDay(attendances));
    }

    async switchCalendarType() {
        if (! await this['twoWeeksCalendar']) {
            const attendanceIds = await this['attendanceIds'];
            await attendanceIds.unlink();
            await this.set('attendanceIds', [
                [0, 0, {
                    'label': 'First week',
                    'dayofweek': '0',
                    'sequence': '0',
                    'hourFrom': 0,
                    'dayPeriod': 'morning',
                    'weekType': '0',
                    'hourTo': 0,
                    'displayType': 'lineSection'
                }],
                [0, 0, {
                    'label': 'Second week',
                    'dayofweek': '0',
                    'sequence': '25',
                    'hourFrom': 0,
                    'dayPeriod': 'morning',
                    'weekType': '1',
                    'hourTo': 0,
                    'displayType': 'lineSection'
                }],
            ]);

            await this.set('twoWeeksCalendar', true);
            const defaultAttendance = (await this.defaultGet('attendanceIds'))['attendanceIds'];
            for (const [idx, att] of enumerate(defaultAttendance)) {
                att[2]["weekType"] = '0';
                att[2]["sequence"] = idx + 1;
            }
            await this.set('attendanceIds', defaultAttendance);
            for (const [idx, att] of enumerate(defaultAttendance)) {
                att[2]["weekType"] = '1';
                att[2]["sequence"] = idx + 26;
            }
            await this.set('attendanceIds', defaultAttendance);
        }
        else {
            await this.set('twoWeeksCalendar', false);
            await (await this['attendanceIds']).unlink();
            await this.set('attendanceIds', (await this.defaultGet('attendanceIds'))['attendanceIds']);
        }
        await this._onchangeHoursPerDay();
    }

    @api.onchange('attendanceIds')
    async _onchangeAttendanceIds() {
        if (! await this['twoWeeksCalendar']) {
            return;
        }

        const attendanceIds = await this['attendanceIds'];
        let evenWeekSeq = await attendanceIds.filtered(async (att) => await att.displayType === 'lineSection' && await att.weekType === '0');
        let oddWeekSeq = await attendanceIds.filtered(async (att) => await att.displayType === 'lineSection' && await att.weekType === '1');
        if (len(evenWeekSeq) != 1 || len(oddWeekSeq) != 1) {
            throw new ValidationError(await this._t("You can't delete section between weeks."));
        }

        evenWeekSeq = await evenWeekSeq.sequence;
        oddWeekSeq = await oddWeekSeq.sequence;

        for (const line of await attendanceIds.filtered(async (att) => await att.displayType === false)) {
            if (evenWeekSeq > oddWeekSeq) {
                await line.set('weekType', evenWeekSeq > await line.sequence ? '1' : '0');
            }
            else {
                await line.set('weekType', oddWeekSeq > await line.sequence ? '0' : '1');
            }
        }
    }

    /**
     * attendance_ids correspond to attendance of a week, will check for each day of week that there are no superimpose.
     * @param attendanceIds 
     */
    async _checkOverlap(attendanceIds) {
        const result = [];
        for (const attendance of await attendanceIds.filtered(async (att) => ! await att.dateFrom && ! await att.dateTo)) {
            // 0.000001 is added to each start hour to avoid to detect two contiguous intervals as superimposing.
            // Indeed Intervals function will join 2 intervals with the start and stop hour corresponding.
            result.push([tools.parseInt(await attendance.dayofweek) * 24 + await attendance.hourFrom + 0.000001, tools.parseInt(await attendance.dayofweek) * 24 + await attendance.hourTo, attendance]);
        }

        if (len(new Intervals(result)) != result.length) {
            throw new ValidationError(await this._t("Attendances can't overlap %s", result));
        }
    }

    @api.constrains('attendanceIds')
    async _checkAttendance() {
        // Avoid superimpose in attendance
        for (const calendar of this) {
            const attendanceIds = await (await calendar.attendanceIds).filtered(async (attendance) => !bool(await attendance.resourceId) && attendance.displayType === false);
            if (await calendar.twoWeeksCalendar) {
                await calendar._checkOverlap(await attendanceIds.filtered(async (attendance) => await attendance.weekType == '0'));
                await calendar._checkOverlap(await attendanceIds.filtered(async (attendance) => await attendance.weekType == '1'));
            }
            else {
                await calendar._checkOverlap(attendanceIds);
            }
        }
    }

    // --------------------------------------------------
    // Computation API
    // --------------------------------------------------
    /**
     * Return the attendance intervals in the given datetime range.
            The returned intervals are expressed in specified tz or in the resource's timezone.
     * @param startDt 
     * @param endDt 
     * @param resources 
     * @param domain 
     * @param tz 
    */
    async _attendanceIntervalsBatch(startDt?: Date, endDt?: Date, resources?: any, domain?: any[], tz?: string) {
        this.ensureOne();
        resources = !resources ? this.env.items('resource.resource') : resources;
        this.ensureOne();

        const resourcesList = [...resources].concat([this.env.items('resource.resource')]);
        const resourceIds = resourcesList.map(r => r.id);
        domain = domain != null ? domain : [];
        domain = expression.AND([domain, [
            ['calendarId', '=', this.id],
            ['resourceId', 'in', resourceIds],
            ['displayType', '=', false],
        ]]);

        // for each attendance spec, generate the intervals in the date range
        const cacheDates = new DefaultDict2(() => new Dict());
        const cacheDeltas = new DefaultDict2(() => new Dict())
        const result = new DefaultDict2(() => []);
        for (const attendance of await this.env.items('resource.calendar.attendance').search(domain)) {
            for (const resource of resourcesList) {
                // express all dates and times in specified tz or in the resource's timezone
                tz = tz ? tz : await (resource.ok ? resource : this as any).tz;
                let start, end;
                let keyTz = String([tz, startDt.valueOf()]);
                if (keyTz in cacheDates) {
                    start = cacheDates[keyTz];
                }
                else {
                    start = startDt;//.astimezone(tz)
                    cacheDates[keyTz] = start;
                }
                keyTz = String([tz, endDt.valueOf()]);
                if (keyTz in cacheDates) {
                    end = cacheDates[keyTz];
                }
                else {
                    end = endDt;//.astimezone(tz)
                    cacheDates[keyTz] = end;
                }

                start = new Date(start.toDateString());
                if (await attendance.dateFrom) {
                    start = dateMax(start, await attendance.dateFrom);
                }
                let until: any = new Date(end.toDateString());
                if (await attendance.dateTo) {
                    until = dateMin(until, await attendance.dateTo);
                }
                if (await attendance.weekType) {
                    const startWeekType = await this.env.items('resource.calendar.attendance').getWeekType(start);
                    if (startWeekType !== parseInt(await attendance.weekType)) {
                        // start must be the week of the attendance
                        // if it's not the case, we must remove one week
                        start = subDate(start, { weeks: 1 });
                    }
                }
                const weekday = parseInt(await attendance.dayofweek);

                let days: RRule;
                if (await this['twoWeeksCalendar'] && await attendance.weekType) {
                    days = new RRule({ freq: RRule.WEEKLY, dtstart: start, interval: 2, until: until, byweekday: weekday });
                }
                else {
                    days = new RRule({ freq: RRule.DAILY, dtstart: start, until: until, byweekday: weekday });
                }

                for (const day of days.all()) {
                    // attendance hours are interpreted in the resource's timezone
                    const hourFrom = await attendance.hourFrom;
                    let keyTz = String([tz, day, hourFrom]);
                    let dt0, dt1;
                    if (keyTz in cacheDeltas) {
                        dt0 = cacheDeltas[keyTz];
                    }
                    else {
                        const time = floatToTime(hourFrom);
                        dt0 = new Date(day.getFullYear(), day.getMonth(), day.getDate(), time.getHours(), time.getMinutes(), time.getSeconds());
                        cacheDeltas[keyTz] = dt0;
                    }

                    const hourTo = await attendance.hourTo;
                    keyTz = String([tz, day, hourTo]);
                    if (keyTz in cacheDeltas) {
                        dt1 = cacheDeltas[keyTz];
                    }
                    else {
                        const time = floatToTime(hourFrom);
                        dt1 = new Date(day.getFullYear(), day.getMonth(), day.getDate(), time.getHours(), time.getMinutes(), time.getSeconds());
                        cacheDeltas[keyTz] = dt1;
                    }
                    result[resource.id].push([
                        dateMax(cacheDates[String([tz, startDt])], dt0),
                        dateMin(cacheDates[String([tz, endDt])], dt1),
                        attendance
                    ]);
                }
            }
        }
        return Object.fromEntries(resourcesList.map(r => [r.id, new Intervals(result[r.id])]));
    }

    async _leaveIntervals(startDt?: Date, endDt?: Date, resources?: any, domain?: any[], tz?: string) {
        if (resources == null) {
            resources = this.env.items('resource.resource');
        }
        return (await this._leaveIntervalsBatch(startDt, endDt, resources, domain, tz))[resources.id];
    }

    /**
     * Return the leave intervals in the given datetime range.
            The returned intervals are expressed in specified tz or in the calendar's timezone.
     * @param startDt 
     * @param endDt 
     * @param resources 
     * @param domain 
     * @param tz 
    */
    async _leaveIntervalsBatch(startDt?: Date, endDt?: Date, resources?: any, domain?: any[], tz?: string) {
        resources = !resources ? this.env.items('resource.resource') : resources;
        // assert(startDt.tzinfo && endDt.tzinfo);
        this.ensureOne();

        // for the computation, express all datetimes in UTC
        const resourcesList = [...resources].concat([this.env.items('resource.resource')]);
        const resourceIds = resourcesList.map(r => r.id);
        if (domain == null) {
            domain = [['timeType', '=', 'leave']];
        }
        domain = domain.concat([
            ['calendarId', 'in', [false, this.id]],
            ['resourceId', 'in', resourceIds],
            ['dateFrom', '<=', endDt.toISOString()],
            ['dateTo', '>=', startDt.toISOString()],
        ]);

        // retrieve leave intervals in [startDt, endDt]
        const result = new DefaultDict2(() => []);
        const tzDates = {};
        for (const leave of await this.env.items('resource.calendar.leaves').search(domain)) {
            for (const resource of resourcesList) {
                if (![false, resource.id].includes((await leave.resourceId).id)) {
                    continue;
                }
                tz = tz ? tz : await (resource.ok ? resource : this).tz;
                let keyTz = String([tz, startDt.valueOf()]);
                let start, end;
                if (keyTz in tzDates) {
                    start = tzDates[keyTz];
                }
                else {
                    start = startDt;//.astimezone(tz)
                    keyTz = String([tz, startDt.valueOf()]);
                    tzDates[keyTz] = start;
                }
                keyTz = String([tz, endDt.valueOf()]);
                if (keyTz in tzDates) {
                    end = tzDates[keyTz];
                }
                else {
                    end = endDt;//.astimezone(tz);
                    keyTz = String([tz, endDt.valueOf()]);
                    tzDates[keyTz] = end;
                }
                const dt0 = new Date(await leave.dateFrom);//.astimezone(tz)
                const dt1 = new Date(await leave.dateTo);//.astimezone(tz)
                result[resource.id].push([dateMax(start, dt0), dateMin(end, dt1), leave]);
            }
        }

        return Object.fromEntries(resourcesList.map(r => [r.id, new Intervals(result[r.id])]));
    }

    /**
     * Return the effective work intervals between the given datetimes.
     * @param startDt 
     * @param endDt 
     * @param resources 
     * @param domain 
     * @param tz 
     * @returns 
     */
    async _workIntervalsBatch(startDt?: Date, endDt?: Date, resources?: any, domain?: any[], tz?: string) {
        let resourcesList;
        if (!bool(resources)) {
            resources = this.env.items('resource.resource');
            resourcesList = [resources];
        }
        else {
            resourcesList = Array.from(resources);
        }

        const attendanceIntervals = await this._attendanceIntervalsBatch(startDt, endDt, resources, domain, tz);
        const leaveIntervals = await this._leaveIntervalsBatch(startDt, endDt, resources, domain, tz);
        return Object.fromEntries(resourcesList.map(r => [r.id, attendanceIntervals[r.id] - leaveIntervals[r.id]]));
    }

    async _unavailableIntervals(startDt?: Date, endDt?: Date, resources?: any, domain?: any[], tz?: string) {
        if (resources == null) {
            resources = this.env.items('resource.resource');
        }
        return (await this._unavailableIntervalsBatch(startDt, endDt, resources, domain, tz))[resources.id];
    }

    /**
     * Return the unavailable intervals between the given datetimes.
     * @param startDt 
     * @param endDt 
     * @param resources 
     * @param domain 
     * @param tz 
     * @returns 
     */
    async _unavailableIntervalsBatch(startDt?: Date, endDt?: Date, resources?: any, domain?: any[], tz?: string) {
        let resourcesList;
        if (!resources) {
            resources = this.env.items('resource.resource');
            resourcesList = [resources];
        }
        else {
            resourcesList = [...resources];
        }

        const resourcesWorkIntervals = await this._workIntervalsBatch(startDt, endDt, resources, domain, tz);
        const result = {};
        for (const resource of resourcesList) {
            let workIntervals = resourcesWorkIntervals[resource.id].map(([start, stop,]) => [start, stop]);
            // start + flatten(intervals) + end
            workIntervals = [startDt].concat(Array.from(chain(workIntervals))).concat([endDt]);
            // pick groups of two
            workIntervals = Array.from(zip(rangeList(workIntervals, 0, workIntervals.length, 2), rangeList(workIntervals, 1, workIntervals.length, 2)));
            result[resource.id] = workIntervals;
        }
        return result
    }

    // Private Methods / Helpers

    /**
     * helper function to compute duration of `intervals`
        expressed in days and hours.
        `dayTotal` is a dict {date: nHours} with the number of hours for each day.
     * @param intervals 
     * @param dayTotal 
     * @returns 
     */
    _getDaysData(intervals, dayTotal) {
        const dayHours = new Dict<number>();
        for (const [start, stop, meta] of intervals) {
            const startDate = start.toDateString();
            if (!dayHours.has(startDate)) {
                dayHours.set(startDate, 0);
            }
            dayHours[startDate] = dayHours[startDate] + diffDate(stop, start, 'seconds').seconds / 3600;
        }
        // compute number of days as quarters
        const days = dayHours.keys().reduce((prev, day) => prev + dayTotal[day] ? floatRound(ROUNDING_FACTOR * dayHours[day] / dayTotal[day]) / ROUNDING_FACTOR : 0, 0);
        return {
            'days': days,
            'hours': dayHours.values().reduce((pre, cur) => pre + cur, 0),
        }
    }

    /**
     * @return dict with hours of attendance in each day between `from_datetime` and `to_datetime`
     * @param fromDatetime 
     * @param toDatetime 
     * @param resources 
     * @returns 
     */
    async _getResourcesDayTotal(fromDatetime: Date, toDatetime: Date, resources?: any) {
        this.ensureOne();
        resources = !resources ? this.env.items('resource.resource') : resources;
        const resourcesList = [...resources].concat([this.env.items('resource.resource')]);
        // total hours per day:  retrieve attendances with one extra day margin,
        // in order to compute the total hours on the first and last days
        const fromFull = subDate(fromDatetime, { days: 1 });
        const toFull = addDate(toDatetime, { days: 1 });
        const intervals = await this._attendanceIntervalsBatch(fromFull, toFull, resources);

        const result = new Dict<Dict<Number>>();//() => new DefaultDict2(() => 0.0));
        for (const resource of resourcesList) {
            if (!result.has(resource.id)) {
                result.set(resource.id, new Dict<Number>());
            }
            const dayTotal = result.get(resource.id);
            for (const [start, stop, meta] of intervals[resource.id]) {
                const startDate = start.toDateString();
                if (!dayTotal.has(startDate)) {
                    dayTotal.set(startDate, 0);
                }
                dayTotal[startDate] += diffDate(stop, start, 'seconds').seconds / 3600;
            }
        }
        return result;
    }

    /**
     * Return the closest work interval boundary within the search range.
        Consider only starts of intervals unless `match_end` is true. It will then only consider
        ends of intervals.
        :param dt: reference datetime
        :param match_end: wether to search for the begining of an interval or the end.
        :param search_range: time interval considered. Defaults to the entire day of `dt`
        :rtype: datetime | None
     * @param dt 
     * @param matchEnd 
     * @param resources 
     * @param searchRange 
     * @returns 
     */
    async _getClosestWorkTime(dt, opts: { matchEnd?: boolean, resources?: any, searchRange?: any } = {}) {
        function intervalDt(interval) {
            return interval[opts.matchEnd ? 1 : 0];
        }

        if (opts.resources == null) {
            opts.resources = this.env.items('resource.resource');
        }

        // if (! dt.tzinfo || searchRange && ! (searchRange[0].tzinfo && searchRange[1].tzinfo):
        //     raise ValueError('Provided datetimes needs to be timezoned')
        // dt = dt.astimezone(timezone(self.tz))

        let rangeStart, rangeEnd;
        if (!opts.searchRange) {
            rangeStart = new Date(dt.toDateString());// (hour=0, minute=0, second=0)
            rangeEnd = addDate(rangeStart, { days: 1 });// + relativedelta(days=1, hour=0, minute=0, second=0)
        }
        else {
            [rangeStart, rangeEnd] = opts.searchRange;
        }

        if (!rangeStart <= dt && dt <= rangeEnd) {
            return null;
        }
        const workIntervals = sorted(
            (await this._workIntervalsBatch(rangeStart, rangeEnd, opts.resources))[opts.resources.id],
            (i) => Math.abs(intervalDt(i) - dt),
        )
        return bool(workIntervals) ? intervalDt(workIntervals[0]) : null;
    }

    // External API

    /**
     * `compute_leaves` controls whether or not this method is taking into
            account the global leaves.
 
            `domain` controls the way leaves are recognized.
            None means default value ('time_type', '=', 'leave')
 
            Counts the number of work hours between two datetimes.
     * @param startDt 
     * @param endDt 
     * @param computeLeaves 
     * @param domain 
     * @returns 
     */
    async getWorkHoursCount(startDt: Date, endDt: Date, computeLeaves: boolean = true, domain?: any[]) {
        this.ensureOne();
        // Set timezone in UTC if no timezone is explicitly given
        // if (! startDt.tzinfo)
        //     start_dt = start_dt.replace(tzinfo=utc)
        // if not end_dt.tzinfo:
        //     end_dt = end_dt.replace(tzinfo=utc)

        let intervals;
        if (computeLeaves) {
            intervals = (await this._workIntervalsBatch(startDt, endDt, null, domain))[String(false)];
        }
        else {
            intervals = (await this._attendanceIntervalsBatch(startDt, endDt))[String(false)];
        }

        return intervals.reduce((pre, [start, stop, meta]) => pre + diffDate(stop, start, 'seconds').seconds / 3600, 0);
    }

    /**
     * Get the working duration (in days and hours) for a given period, only
            based on the current calendar. This method does not use resource to
            compute it.
 
            `domain` is used in order to recognise the leaves to take,
            None means default value ('time_type', '=', 'leave')
 
            Returns a dict {'days': n, 'hours': h} containing the
            quantity of working time expressed as days and as hours.
     * @param fromDatetime 
     * @param toDatetime 
     * @param computeLeaves 
     * @param domain 
     * @returns 
     */
    async getWorkDurationData(fromDatetime: Date, toDatetime: Date, computeLeaves: boolean = true, domain?: any[]) {
        // naive datetimes are made explicit in UTC
        [fromDatetime,] = makeAware(fromDatetime);
        [toDatetime,] = makeAware(toDatetime);

        const dayTotal = (await this._getResourcesDayTotal(fromDatetime, toDatetime))[String(false)];

        // actual hours per day
        let intervals;
        if (computeLeaves) {
            intervals = (await this._workIntervalsBatch(fromDatetime, toDatetime, null, domain))[String(false)];
        }
        else {
            intervals = (await this._attendanceIntervalsBatch(fromDatetime, toDatetime, null, domain))[String(false)];
        }

        return this._getDaysData(intervals, dayTotal);
    }

    /**
     * `compute_leaves` controls whether or not this method is taking into
        account the global leaves.
 
        `domain` controls the way leaves are recognized.
        None means default value ('time_type', '=', 'leave')
 
        Return datetime after having planned hours
     * @param hours 
     * @param dayDt 
     * @param computeLeaves 
     * @param domain 
     * @param resources 
     */
    async planHours(hours, dayDt: Date, computeLeaves: boolean = false, domain?: any[], resources?: any) {
        let revert;
        [dayDt, revert] = makeAware(dayDt);

        if (resources == null) {
            resources = this.env.items('resource.resource');
        }

        // which method to use for retrieving intervals
        let getIntervals, resourceId;
        if (computeLeaves) {
            getIntervals = this._workIntervalsBatch.bind(this)
            resourceId = resources.id
        }
        else {
            domain = null;
            resources = null;
            getIntervals = this._attendanceIntervalsBatch.bind(this);
            resourceId = false;
        }

        if (hours >= 0) {
            const days = 14;
            for (const n of range(100)) {
                const dt = addDate(dayDt, { days: days * n });
                for (const [start, stop, meta] of (await getIntervals(dt, addDate(dt, { days: days }), resources, domain))[resourceId]) {
                    const intervalHours = diffDate(stop, start, 'seconds').seconds / 3600
                    if (hours <= intervalHours) {
                        return revert(addDate(start, { hours: hours }));
                    }
                    hours -= intervalHours;
                }
            }
            return false;
        }
        else {
            hours = Math.abs(hours);
            const delta = 14;
            for (const n of range(100)) {
                const dt = subDate(dayDt, { days: delta * n });
                for (const [start, stop, meta] of (await getIntervals(subDate(dt, { days: delta }), dt, resources, domain))[resourceId].reverse()) {
                    const intervalHours = diffDate(stop, start, 'seconds').seconds / 3600;
                    if (hours <= intervalHours) {
                        return revert(subDate(stop, { hours: hours }));
                    }
                    hours -= intervalHours;
                }
            }
            return false;
        }
    }

    /**
     * `compute_leaves` controls whether or not this method is taking into
        account the global leaves.
 
        `domain` controls the way leaves are recognized.
        None means default value ('time_type', '=', 'leave')
 
        Returns the datetime of a days scheduling.
     * @param days 
     * @param dayDt 
     * @param computeLeaves 
     * @param domain 
     * @returns 
     */
    async planDays(days, dayDt: Date, computeLeaves: boolean = false, domain?: any[]) {
        let revert, getIntervals;
        [dayDt, revert] = makeAware(dayDt);

        // which method to use for retrieving intervals
        if (computeLeaves) {
            getIntervals = this._workIntervalsBatch.bind(this);
        }
        else {
            domain = null;
            getIntervals = this._attendanceIntervalsBatch.bind(this);
        }
        if (days > 0) {
            const found = new Set<string>();
            const delta = 14;
            for (const n of range(100)) {
                const dt = addDate(dayDt, { days: delta * n });
                for (const [start, stop, meta] of (await getIntervals(dt, addDate(dt, { days: delta }), null, domain))[String(false)]) {
                    found.add(start.toDateString());
                    if (len(found) === delta) {
                        return revert(stop);
                    }
                }
            }
            return false;
        }

        else if (days < 0) {
            days = Math.abs(days);
            const found = new Set<string>();
            const delta = 14;
            for (const n of range(100)) {
                const dt = subDate(dayDt, { days: delta * n });
                for (const [start, stop, meta] of (await getIntervals(subDate(dt, { days: delta }), dt, null, domain))[String(false)].reverse()) {
                    found.add(start.toDateString());
                    if (len(found) === days) {
                        return revert(start);
                    }
                }
            }
            return false;
        }
        else {
            return revert(dayDt);
        }
    }

    async _getMaxNumberOfHours(start: Date, end: Date) {
        this.ensureOne();
        if (!bool(await this['attendanceIds'])) {
            return 0;
        }
        const mappedData = new Dict<any>();//(() => 0);
        for (const attendance of await (await this['attendanceIds']).filtered(async (a) => (! await a.dateFrom || ! await a.dateTo) || (await a.dateFrom <= _Date.today(end) && await a.dateTo >= _Date.today(start)))) {
            const key = String([await attendance.weekType, await attendance.dayofweek]);
            if (!mappedData.has(key)) {
                mappedData.set(key, 0);
            }
            mappedData[key] += await attendance.hourTo - await attendance.hourFrom;
        }
        return Math.max(...mappedData.values());
    }

}

@MetaModel.define()
class ResourceCalendarAttendance extends Model {
    static _module = module;
    static _name = "resource.calendar.attendance";
    static _description = "Work Detail";
    static _order = 'weekType, dayofweek, hourFrom';

    static label = Fields.Char({ required: true });
    static dayofweek = Fields.Selection([
        ['0', 'Monday'],
        ['1', 'Tuesday'],
        ['2', 'Wednesday'],
        ['3', 'Thursday'],
        ['4', 'Friday'],
        ['5', 'Saturday'],
        ['6', 'Sunday']
    ], { string: 'Day of Week', required: true, index: true, default: '0' });
    static dateFrom = Fields.Date({ string: 'Starting Date' });
    static dateTo = Fields.Date({ string: 'End Date' });
    static hourFrom = Fields.Float({
        string: 'Work from', required: true, index: true,
        help: "Start and End time of working.\nA specific value of 24:00 is interpreted as 23:59:59.999."
    });
    static hourTo = Fields.Float({ string: 'Work to', required: true });
    static calendarId = Fields.Many2one("resource.calendar", { string: "Resource's Calendar", required: true, ondelete: 'CASCADE' });
    static dayPeriod = Fields.Selection([['morning', 'Morning'], ['afternoon', 'Afternoon']], { required: true, default: 'morning' });
    static resourceId = Fields.Many2one('resource.resource', { string: 'Resource' });
    static weekType = Fields.Selection([
        ['1', 'Second'],
        ['0', 'First']
    ], { string: 'Week Number', default: false });
    static twoWeeksCalendar = Fields.Boolean("Calendar in 2 weeks mode", { related: 'calendarId.twoWeeksCalendar' });
    static displayType = Fields.Selection([
        ['lineSection', "Section"]], { default: false, help: "Technical field for UX purpose." });
    static sequence = Fields.Integer({
        default: 10,
        help: "Gives the sequence of this line when displaying the resource calendar."
    });

    @api.onchange('hourFrom', 'hourTo')
    async _onchangeHours() {
        // avoid negative or after midnight
        await this.set('hourFrom', Math.min(await this['hourFrom'], 23.99));
        await this.set('hourFrom', Math.max(await this['hourFrom'], 0.0));
        await this.set('hourTo', Math.min(await this['hourTo'], 24));
        await this.set('hourTo', Math.max(await this['hourTo'], 0.0));
        //avoid wrong order
        await this.set('hourTo', Math.max(await this['hourTo'], await this['hourFrom']));
    }

    @api.model()
    async getWeekType(date: Date) {
        // weekType is defined by
        //  * counting the number of days from January 1 of year 1
        //    (extrapolated to dates prior to the first adoption of the Gregorian calendar)
        //  * converted to week numbers and then the parity of this number is asserted.
        // It ensures that an even week number always follows an odd week number. With classical week number,
        // some years have 53 weeks. Therefore, two consecutive odd week number follow each other (53 --> 1).
        return parseInt(Math.floor(Math.floor(DateTime.now().diff(DateTime.local(1, 1, 1), 'days').days - 1) / 7) % 2);
    }

    async _computeDisplayName() {
        await _super(ResourceCalendarAttendance, this)._computeDisplayName();
        const thisWeekType = String(await this.getWeekType(await _Date.contextToday(this)));
        const sectionNames = { '0': await this._t('First week'), '1': await this._t('Second week') }
        const sectionInfo = { 'true': await this._t('this week'), 'false': await this._t('other week') }
        for (const record of await this.filtered(async (l) => await l.displayType === 'lineSection')) {
            const sectionName = f("%s (%s)", sectionNames[await record.weekType], sectionInfo[String(thisWeekType == await record.weekType)]);
            await record.set('displayName', sectionName);
        }
    }

    async _copyAttendanceVals() {
        this.ensureOne();
        return this.getDict(['label', 'dayofweek', 'dateFrom', 'dateTo', 'hourFrom', 'hourTo', 'dayPeriod', 'weekType', 'displayType', 'sequence']);
    }
}

@MetaModel.define()
class ResourceResource extends Model {
    static _module = module;
    static _name = "resource.resource";
    static _description = "Resources";
    static _order = "label";

    @api.model()
    async defaultGet(fields) {
        const res = await _super(ResourceResource, this).defaultGet(fields);
        if (!res['calendarId'] && res['companyId']) {
            const company = this.env.items('res.company').browse(res['companyId']);
            res['calendarId'] = (await company.resourceCalendarId).id;
        }
        return res;
    }

    static label = Fields.Char({ required: true });
    static active = Fields.Boolean(
        'Active', {
        default: true,
        help: "If the active field is set to false, it will allow you to hide the resource record without removing it."
    });
    static companyId = Fields.Many2one('res.company', { string: 'Company', default: self => self.env.company() });
    static resourceType = Fields.Selection([
        ['user', 'Human'],
        ['material', 'Material']], {
        string: 'Type',
        default: 'user', required: true
    });
    static userId = Fields.Many2one('res.users', { string: 'User', help: 'Related user name for the resource to manage its access.' });
    static timeEfficiency = Fields.Float(
        'Efficiency Factor', {
        default: 100, required: true,
        help: "This field is used to calculate the expected duration of a work order at this work center. For example, if a work order takes one hour and the efficiency factor is 100%, then the expected duration will be one hour. If the efficiency factor is 200%, however the expected duration will be 30 minutes."
    });
    static calendarId = Fields.Many2one(
        "resource.calendar", {
        string: 'Working Time',
        default: async (self) => (await self.env.company()).resourceCalendarId,
        required: true, domain: "[['companyId', '=', companyId]]",
        help: "Define the schedule of resource"
    })
    static tz = Fields.Selection(
        _tzGet, {
        string: 'Timezone', required: true,
        default: async (self) => self._context['tz'] || await (await self.env.user()).tz || 'UTC',
        help: "This field is used in order to define in which timezone the resources will work."
    });

    static _sqlConstraints = [
        ['checkTimeEfficiency', 'CHECK("timeEfficiency">0)', 'Time efficiency must be strictly positive'],
    ]

    @api.modelCreateMulti()
    async create(valsList) {
        for (const values of valsList) {
            if (values['companyId'] && !values['calendarId']) {
                values['calendarId'] = (await this.env.items('res.company').browse(values['companyId']).resourceCalendarId).id;
            }
            if (!values['tz']) {
                // retrieve timezone on user or calendar
                const tz = await this.env.items('res.users').browse(values['userId']).tz ??
                    await this.env.items('resource.calendar').browse(values['calendarId']).tz
                if (tz) {
                    values['tz'] = tz;
                }
            }
        }
        return _super(ResourceResource, this).create(valsList);
    }

    @api.returns('self', (value) => value.id)
    async copy(defaultValue?: any) {
        this.ensureOne();
        if (defaultValue == null) {
            defaultValue = {};
        }
        if (!defaultValue['label']) {
            Object.assign(defaultValue, { label: await this._t('%s (copy)', await this['label']) });
        }
        return _super(ResourceResource, this).copy(defaultValue);
    }

    @api.onchange('companyId')
    async _onchangeCompanyId() {
        if (bool(await this['companyId'])) {
            await this.set('calendarId', (await (await this['companyId']).resourceCalendarId).id);
        }
    }

    @api.onchange('userId')
    async _onchangeUserId() {
        const userId = await this['userId'];
        if (bool(userId)) {
            await this.set('tz', await userId.tz);
        }
    }

    /**
     * Adjust the given start and end datetimes to the closest effective hours encoded
        in the resource calendar. Only attendances in the same day as `start` and `end` are
        considered (respectively). If no attendance is found during that day, the closest hour
        is None.
        e.g. simplified example:
             given two attendances: 8am-1pm and 2pm-5pm, given start=9am and end=6pm
             resource._adjust_to_calendar(start, end)
             >>> {resource: (8am, 5pm)}
        :return: Closest matching start and end of working periods for each resource
        :rtype: dict(resource, tuple(datetime | None, datetime | None))
     * @param start 
     * @param end 
     * @returns 
     */
    async _adjustToCalendar(start, end) {
        let revertStartTz, revertEndTz;
        [start, revertStartTz] = makeAware(start);
        [end, revertEndTz] = makeAware(end);
        const result = {}
        for (const resource of this) {
            const calendarStart = await (await resource.calendarId)._getClosestWorkTime(start, { resource: resource });
            let searchRange;
            const tz = getAllTimezones(await resource.tz);
            if (calendarStart && start.toDateString() == end.toDateString()) {
                // Make sure to only search end after start
                searchRange = [
                    start,
                    addDate(new Date(end.toDateString()), { days: 1 }),
                ];
            }
            const calendarEnd = await (await resource.calendarId)._getClosestWorkTime(end, { matchEnd: true, resource: resource, searchRange: searchRange });
            result[resource] = [
                calendarStart && revertStartTz(calendarStart),
                calendarEnd && revertEndTz(calendarEnd),
            ]
        }
        return result;
    }

    /**
     * Compute the intervals during which employee is unavailable with hour granularity between start and end
            Note: this method is used in enterprise (forecast and planning)
     * @param start 
     * @param end 
     * @returns 
     */
    async _getUnavailableIntervals(start, end) {
        const resourceMapping = {}
        const calendarMapping = new MapKey<any, ResourceResource>();
        for (const resource of this) {
            const calendar = await resource.calendarId;
            if (!calendarMapping.has(calendar)) {
                calendarMapping.set(calendar, this.env.items('resource.resource') as ResourceResource);
            }
            calendarMapping.set(calendarMapping.get(calendar).or(resource));
        }

        for (const [calendar, resources] of calendarMapping.items()) {
            const resourcesUnavailableIntervals = await calendar._unavailableIntervalsBatch(start, end, resources);
            update(resourceMapping, resourcesUnavailableIntervals);
        }
        return resourceMapping;
    }
}

@MetaModel.define()
class ResourceCalendarLeaves extends Model {
    static _module = module;
    static _name = "resource.calendar.leaves";
    static _description = "Resource Time Off Detail";
    static _order = "dateFrom";

    async defaultGet(fieldsList) {
        const res = await _super(ResourceCalendarLeaves, this).defaultGet(fieldsList);
        if (fieldsList.includes('dateFrom') && fieldsList.includes('dateTo') && !res['dateFrom'] && !res['dateTo']) {
            // Then we give the current day and we search the begin and end hours for this day in resource.calendar of the current company
            const today = _Datetime.now();
            // Tony must fix
            // userTz = timezone(self.env.user.tz or self._context.get('tz') or self.companyId.resource_calendar_id.tz or 'UTC')
            // dateFrom = user_tz.localize(datetime.combine(today, time.min))
            // dateTo = user_tz.localize(datetime.combine(today, time.max))
            // intervals = self.env.company.resource_calendar_id._workIntervalsBatch(dateFrom.replace(tzinfo=utc), dateTo.replace(tzinfo=utc))[false]
            // if intervals:  # Then we stop and return the dates given in parameter
            //     list_intervals = [(start, stop) for start, stop, records in intervals]  # Convert intervals in interval list
            //     dateFrom = list_intervals[0][0]  # We take the first date in the interval list
            //     dateTo = listIntervals[listIntervals.length-1][1]  # We take the last date in the interval list
            // res.update(
            //     dateFrom=dateFrom.astimezone(utc).replace(tzinfo=None),
            //     dateTo=dateTo.astimezone(utc).replace(tzinfo=None)
            // )
        }
        return res
    }

    static label = Fields.Char('Reason');
    static companyId = Fields.Many2one(
        'res.company', {
        string: "Company", readonly: true, store: true,
        default: self => self.env.company(), compute: '_computeCompanyId'
    });
    static calendarId = Fields.Many2one('resource.calendar', { string: 'Working Hours', index: true });
    static dateFrom = Fields.Datetime('Start Date', { required: true });
    static dateTo = Fields.Datetime('End Date', { required: true });
    static resourceId = Fields.Many2one(
        "resource.resource", {
        string: 'Resource', index: true,
        help: "If empty, this is a generic time off for the company. If a resource is set, the time off is only for this resource"
    });
    static timeType = Fields.Selection([['leave', 'Time Off'], ['other', 'Other']], {
        default: 'leave',
        help: "Whether this should be computed as a time off or as work time (eg: formation)"
    });

    @api.depends('calendarId')
    async _computeCompanyId() {
        for (const leave of this) {
            const companyId = await (await leave.calendarId).companyId;
            await leave.set('companyId', companyId.ok ? companyId : await this.env.company());
        }
    }

    @api.constrains('dateFrom', 'dateTo')
    async checkDates() {
        if ((await this.filtered(async (leave) => await leave.dateFrom > await leave.dateTo)).ok) {
            throw new ValidationError(await this._t('The start date of the time off must be earlier than the end date.'));
        }
    }

    @api.onchange('resourceId')
    async onchangeResource() {
        const resourceId = await this['resourceId'];
        if (resourceId.ok) {
            await this.set('calendarId', await resourceId.calendarId);
        }
    }

    async _copyLeaveVals() {
        this.ensureOne();
        return this.getDict(['label', 'dateFrom', 'dateTo', 'timeType']);
    }
}
