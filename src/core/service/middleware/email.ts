import { isDigit, parseInt } from "../../tools";

/**
 * Convert a date string to a time tuple.Accounts for military timezones.
 * @param data 
 * @returns 
 */
export function parseDateTz(data) {
  const res = _parseDateTz(data);
  if (!res) {
    return;
  }
  if (res[9] == null) {
    res[9] = 0;
  }
  return Array.from(res);
}

/**
 * Convert a time string to a time tuple.
 * @param data 
 * @returns 
 */
function parseDate(data) {
  const t = parseDateTz(data);
  if (Array.isArray(t)) {
    return t.slice(0, 9);
  }
  else {
    return t;
  }
}

const _daynames = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const _monthnames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const _timezones = {
  'UT': 0, 'UTC': 0, 'GMT': 0, 'Z': 0,
  'AST': -400, 'ADT': -300,  // Atlantic (used in Canada)
  'EST': -500, 'EDT': -400,  // Eastern
  'CST': -600, 'CDT': -500,  // Central
  'MST': -700, 'MDT': -600,  // Mountain
  'PST': -800, 'PDT': -700   // Pacific
}

/**
 * Convert date to extended time tuple.

  The last (additional) element is the time zone offset in seconds, except ifthe timezone was specified as -0000.  In that case the last element is None.  This indicates a UTC timestamp that explicitly declaims knowledge of the source timezone, as opposed to a +0000 timestamp that indicates the source timezone really was UTC.
 * @param data 
 * @returns 
 */
function _parseDateTz(value) {
  if (!value) {
    return;
  }
  let data: string[] = value.trim().split(' ');
  // The FWS after the comma after the day-of-week is optional, so search and adjust for this.
  if (data[0].endsWith(',') || _daynames.includes(data[0].toLowerCase())) {
    // There's a dayname here. Skip it
    data.shift();
  }
  else {
    const i = data[0].lastIndexOf(',');
    if (i >= 0) {
      data[0] = data[0].slice(i + 1);
    }
  }
  if (data.length == 3) { // RFC 850 date, deprecated
    const stuff = data[0].split('-')
    if ((stuff.length) == 3) {
      data = stuff.concat(data.slice(1));
    }
  }
  if (data.length == 4) {
    const s = data[3];
    let i = s.indexOf('+');
    if (i == -1) {
      i = s.indexOf('-');
    }
    if (i > 0) {
      data.pop();
      // data[3:] = [s[:i], s[i:]];
      data = data.concat([...s.slice(0, i), ...s.slice(i)])
    }
    else {
      data.push('') // Dummy tz
    }
  }
  if (data.length < 5) {
    return null;
  }
  data = data.slice(0, 5);
  let dd, mm, yy, tm, tz;
  [dd, mm, yy, tm, tz] = data;
  mm = mm.toLowerCase();
  if (!_monthnames.includes(mm)) {
    [dd, mm] = [mm, dd.toLowerCase()];
    if (!_monthnames.includes(mm)) {
      return null;
    }
  }
  mm = _monthnames.indexOf(mm) + 1;
  if (mm > 12) {
    mm -= 12;
  }
  if (dd[dd.length - 1] == ',') {
    dd = dd.slice(0, -1);
  }
  let i = yy.indexOf(':');
  if (i > 0) {
    [yy, tm] = [tm, yy];
  }
  if (yy[yy.length - 1] === ',') {
    yy = yy.slice(0, -1);
  }
  if (!isDigit(yy[0])) {
    [yy, tz] = [tz, yy];
  }
  if (tm[tm.length - 1] === ',') {
    tm = tm.slice(0, -1);
  }
  tm = tm.split(':');
  let tss, thh, tmm;
  if (tm.length == 2) {
    [thh, tmm] = tm;
    tss = '0';
  }
  else if (tm.length == 3) {
    [thh, tmm, tss] = tm;
  }
  else if ((tm.length == 1) && tm[0].includes('.')) {
    // Some non-compliant MUAs use '.' to separate time elements.
    tm = tm[0].split('.');
    if (tm.length == 2) {
      [thh, tmm] = tm;
      tss = 0;
    }
    else if (tm.length == 3) {
      [thh, tmm, tss] = tm;
    }
  }
  else {
    return null;
  }
  try {
    yy = parseInt(yy, 10, true);
    dd = parseInt(dd, 10, true);
    thh = parseInt(thh, 10, true);
    tmm = parseInt(tmm, 10, true);
    tss = parseInt(tss, 10, true);
  } catch (e) {
    return null;
  }
  // Check for a yy specified in two-digit format, then convert it to the appropriate four-digit format, according to the POSIX standard. RFC 822 calls for a two-digit yy, but RFC 2822 (which obsoletes RFC 822) mandates a 4-digit yy. For more information, see the documentation for the time module.
  if (yy < 100) {
    // The year is between 1969 and 1999 (inclusive).
    if (yy > 68) {
      yy += 1900;
    }
    // The year is between 2000 and 2068 (inclusive).
    else {
      yy += 2000;
    }
  }
  let tzOffset = null;
  tz = tz.toUpperCase();
  if (tz in _timezones) {
    tzOffset = _timezones[tz];
  }
  else {
    tzOffset = parseInt(tz);
    if (tzOffset == 0 && tz.startsWith('-')) {
      tzOffset = null;
    }
  }
  // Convert a timezone offset into seconds ; -0500 -> -18000
  if (tzOffset) {
    let tzSign;
    if (tzOffset < 0) {
      tzSign = -1;
      tzOffset = -tzOffset;
    }
    else {
      tzSign = 1;
    }
    tzOffset = tzSign * (Math.round(tzOffset / 100) * 3600 + (tzOffset % 100) * 60);
  }
  // Daylight Saving Time flag is set to -1, since DST is unknown.
  return [yy, mm, dd, thh, tmm, tss, 0, 1, -1, tzOffset];
}
