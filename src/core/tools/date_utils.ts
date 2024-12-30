import { DateObjectUnits, DateTime, DiffOptions, Duration, DurationLike, DurationUnits } from "luxon";
import { monthrange } from "./calendar";
import { update } from "./misc";
import { tools } from "..";
import { parseLocale } from "./locale";
import { parseInt } from "./func";
import { floatRound } from "./float_utils";
import { ValueError } from "../helper";

export const TIMEDELTA_UNITS: [string, number][] = [
  ['year', 3600 * 24 * 365],
  ['month', 3600 * 24 * 30],
  ['week', 3600 * 24 * 7],
  ['day', 3600 * 24],
  ['hour', 3600],
  ['minute', 60],
  ['second', 1]
];

const SERVER_INTL = Object.assign({}, new Intl.DateTimeFormat().resolvedOptions(), new Intl.RelativeTimeFormat().resolvedOptions());

export const SERVER_LOCALE = SERVER_INTL.locale;

export const SERVER_TZ = SERVER_INTL.timeZone;

export function setDate(value: Date, kwargs: DateObjectUnits = {}) {
  return DateTime.fromJSDate(value).set(kwargs).toJSDate();
}

/**
 *  Return the sum of `'value'` and a class `relativedelta`.
 * @param value initial date or datetime
 * @param opts keyword to pass directly to class `relativedelta`
 * @return the resulting Date 
 */
export function addDate(value: Date, opts: DurationLike = {}): Date {
  return DateTime.fromJSDate(value).plus(opts).toJSDate();
}

export function subDate(value: Date, opts: DurationLike = {}): Date {
  return DateTime.fromJSDate(value).minus(opts).toJSDate();
}

export function diffDate(value: Date, other: Date, units?: DurationUnits, opts: DiffOptions = {}): Duration {
  return DateTime.fromJSDate(value).diff(DateTime.fromJSDate(other), units, opts);
}

/**
 * Compute the month dates range on which the 'date' parameter belongs to.
 * @param date A Date object
 * @returns A tuple [dateFrom, dateTo] having the same object type as the `date` parameter 
 */
export function getMonth(date: Date): [Date, Date] {
  const [year, month] = [date.getFullYear(), date.getMonth()+1];
  const dateFrom = DateTime.fromObject({ year: year, month: month, day: 1 }).toJSDate();
  const dateTo = DateTime.fromObject({ year: year, month: month, day: DateTime.local(year, month).daysInMonth }).toJSDate();
  return [dateFrom, dateTo];
}

/**
 * Get the number of the quarter on which the `date` parameter belongs to.
 * @param date a Date object
 * @returns A [1-4] integer
 */
export function getQuarterNumber(date: Date) {
  return Math.ceil((date.getMonth()+1) / 3);
}

/**
 * Compute the quarter dates range on which the `date` parameter belongs to.
 * @param date a Date object
 * @returns A tuple [dateFrom, dateTo] having the same object type as the `date` parameter
 */
export function getQuarter(date: Date) {
  const quarterNumber = getQuarterNumber(date);
  const monthIndex = (quarterNumber - 1) * 3;
  const dateFrom = new Date(date.getFullYear(), monthIndex, 1);
  let dateTo = addDate(dateFrom, { months: 2 });
  dateTo = setDate(dateTo, { day: monthrange(dateTo.getFullYear(), dateTo.getMonth()+1)[1] });
  return [dateFrom, dateTo];
}

export function combine(date: Date, time?: string): Date {
  let resDateTime = new Date(date);
  if (time === 'max') {
    resDateTime.setHours(23, 59, 59, 999);
  } else if (time === 'min') {
    resDateTime.setHours(0, 0, 0, 0);
  } else {
    resDateTime = new Date(toISODateString(resDateTime) + 'T' + time + (time.endsWith('Z') ? '' : 'Z'))
  }
  return resDateTime;
}

export function toISOTimeString(date: Date) {
  return date.toISOString().slice(11, -1);
}

export function toISODateString(date: Date) {
  return date.toISOString().slice(0, 10);
}

export function toFormat(date: Date, format: string, opts: {} = {}) {
  return DateTime.fromJSDate(date).toFormat(format, opts);
}

export function fromFormat(value: Date | string, format: string, opts: {} = {}) {
  return DateTime.fromFormat(String(value), format, opts).toJSDate();
}

function formatDuration(duration: Duration, opts: { granularity?: string, threshold?: number, addDirection?: boolean, format?: string, locale?: string } = {}) {
  update(opts, { granularity: 'second', threshold: 0.85, addDirection: false, format: 'long', locale: SERVER_LOCALE });
  if (!['narrow', 'short', 'medium', 'long'].includes(opts.format)) {
    throw new TypeError('Format must be one of "narrow", "short" or "long"');
  }
  if (opts.format === 'medium') {
    console.warn(`"medium" value for format param of formatDuration is deprecated. Use "long" instead`);
    opts.format = 'long';
  }
  let seconds;
  if (duration instanceof Duration) {
    seconds = tools.parseInt((duration.days * 86400) + duration.seconds);
  }
  else {
    seconds = duration;
  }
  let locale = parseLocale(opts.locale)[0];

  function* _iterPatterns(unit) {
    if (opts.addDirection) {
      const unitRelPatterns = locale._data['dateFields'][unit];
      if (seconds >= 0) {
        yield unitRelPatterns['future'];
      }
      else {
        yield unitRelPatterns['past'];
      }
    }
    unit = 'duration-' + unit
    yield (locale._data['unitPatterns'][unit] ?? {})[opts.format];
  }

  for (const [unit, secsPerUnit] of TIMEDELTA_UNITS) {
    let value = Math.abs(seconds) / secsPerUnit;
    if (value >= opts.threshold || unit == opts.granularity) {
      if (unit == opts.granularity && value > 0) {
        value = Math.max(1, value);
      }
      value = parseInt(Math.round(value));
      const pluralForm = locale.pluralForm(value);
      let pattern;
      for (const patterns of _iterPatterns(unit)) {
        if (patterns != null) {
          pattern = patterns[pluralForm];
          break;
        }
      }
      // This really should not happen
      if (pattern == null) {
        return '';
      }
      return pattern.replace('{0}', String(value));
    }
  }
  return '';
}

export async function formatTimeAgo(env, timeDelta, langCode: any = false, addDirection: any = true) {
  if (!langCode) {
    const langs = (await env.items('res.lang').getInstalled()).map(([code]) => code);
    let lang = (await (await (await env.user()).companyId).partnerId).lang;
    langCode = langs.includes(env.context['lang']) ? env.context['lang'] : (lang.ok || langs[0]);
  }
  console.warn('Not implemented');
  const locale = parseLocale(langCode);
  return new Date();
  // return babel.dates.format_timedelta(-time_delta, add_direction=add_direction, locale=locale)
}

/**
 * Remove tzOffset and 'Z'
 * @param date 
 * @returns 
 */
export function dateWithoutTz(date: Date) {
  const tzoffset = date.getTimezoneOffset() * 60000; // offset in milliseconds
  const withoutTz = new Date(date.valueOf() - tzoffset)
    .toISOString()
  return new Date(withoutTz);
};

export function dateSetTz(date: Date, tz: string = SERVER_TZ, locale: string = SERVER_LOCALE, isDst = false) {
  return new Date(date.toLocaleString(locale, { timeZone: tz }));
}

export function dateSetLocale(date: Date, locale: string = SERVER_LOCALE) {
  DateTime.fromJSDate(date).setLocale(locale).toJSDate();
}

export function isDstObserved(date: Date) {
  function stdTimezoneOffset(date: Date) {
    var jan = new Date(date.getFullYear(), 0, 1);
    var jul = new Date(date.getFullYear(), 6, 1);
    return Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
  }

  return date.getTimezoneOffset() < stdTimezoneOffset(date);
}

/**
 * Date with hour=minute=second=millisecond=0
 * @param date 
 * @returns 
 */
export function today(date?: Date) {
  const _date = date ? date : new Date();
  _date.setHours(0, 0, 0, 0);
  return _date;
}

export function toDate(value?: string | Date, JSDate: boolean = true): DateTime | Date | null {
  if (!value) {
    return null;
  }
  if (typeof value === 'string') {
    value = new Date(value);
    value.setHours(0,0,0,0);
  } 
  if (!JSDate) {
    return DateTime.fromJSDate(value);
  }
  return value;
}

export function toDatetime(value: string | Date, JSDate: boolean = true): DateTime | Date | null {
  if (!value) {
    return null;
  }
  if (typeof value === 'string') {
    value = new Date(value + (value.endsWith('Z') ? '' : 'Z'));
  }
  if (!JSDate) {
    return DateTime.fromJSDate(value);
  }
  return value;
}

export function dateMax(...dates: any[]) {
  if (dates.length == 1 && Array.isArray(dates[0])) {
    dates = dates[0];
  }
  return new Date(Math.max(...dates.map(date => date.valueOf())));
}

export function dateMin(...dates: any[]) {
  if (dates.length == 1 && Array.isArray(dates[0])) {
    dates = dates[0];
  }
  return new Date(Math.min(...dates.map(date => date.valueOf())));
}

/**
 * Date range generator with a step interval.
 * @param start beginning date of the range
 * @param end ending date of the range
 * @param step interval of the range
 * @returns Iterator[Date] a range of datetime from start to end
 */
export function* daterange(start, end, step = { months: 1 }) {
  if (start > end) {
    throw new ValueError("start > end, start date must be before end");
  }
  if (start == addDate(start, step)) {
    throw new ValueError("Looks like step is null");
  }
  let dt = start;
  while (dt <= end) {
    yield localize(dt);
    dt = addDate(dt, step);
  }
}

export function setTimeMax(date: Date) {
  date.setHours(23, 59, 59, 999);
  return date;
}

function modf(float: number) {
  return [Number((float % 1).toFixed(3).substring(2)), Math.floor(float)];
}

/**
* Convert a number of hours into a time object.
* @param hours 
*/
export function floatToTime(hours: number): Date {
  const date = new Date();
  if (hours == 24.0) {
    return setTimeMax(date);
  }
  const [fractional, integral] = modf(hours);
  date.setHours(integral, tools.parseInt(floatRound(60 * fractional, { precisionDigits: 0 })), 0, 0);
  return date;
}

export function startOf(date: Date, groupby: any): any {
  return DateTime.fromJSDate(date).startOf(groupby).toJSDate();
}

function* localize(dt: any) {
  console.log("Not implemeted");
  return dt;
}
