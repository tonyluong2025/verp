import { ValueError } from "../helper/errors";
import { f } from "./utils";

const MINYEAR = 1;
const MAXYEAR = 9999;

const January = 1;
const February = 2;

const mdays = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

class IllegalMonthError extends ValueError {
  month: number;

  constructor(month) {
    super("bad month number %s; must be 1-12", month);
    this.month = month;
  }

  toString() {
    return f("bad month number %s; must be 1-12", this.month);
  }
}

class IllegalWeekdayError extends ValueError {
  weekday: number;

  constructor(weekday) {
    super("bad weekday number %s; must be 0 (Monday) to 6 (Sunday)", weekday);
    this.weekday = weekday;
  }

  toStirng() {
    return f("bad weekday number %s; must be 0 (Monday) to 6 (Sunday)", this.weekday);
  }
}

/**
 * Return true for leap years, false for non-leap years.
 * @param year 
 * @returns 
 */
export function isleap(year) {
  return year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
}

/**
 * Return number of leap years in range [y1, y2].
       Assume y1 <= y2.
 * @param y1 
 * @param y2 
 * @returns 
 */
export function leapdays(y1, y2) {
  y1 -= 1;
  y2 -= 1;
  return (Math.floor(y2 / 4) - Math.floor(y1 / 4)) - (Math.floor(y2 / 100) - Math.floor(y1 / 100)) + (Math.floor(y2 / 400) - Math.floor(y1 / 400));
}

/**
 * Return weekday (0-6 ~ Mon-Sun) for year, month (1-12), day (1-31).
 * @param year 
 * @param month 
 * @param day 
 * @returns 
 */
function weekday(year, month, day) {
  if (!(MINYEAR <= year && year <= MAXYEAR)) {
    year = 2000 + year % 400;
  }
  return (new Date(year, month - 1, day)).getDay();
}

/**
 * Return weekday (0-6 ~ Mon-Sun) and number of days (28-31) for year, month (1-12).
 * @param year 
 * @param month 
 * @returns 
 */
export function monthrange(year, month) {
  if (!(1 <= month && month <= 12)) {
    throw new IllegalMonthError(month);
  }
  const day1 = weekday(year, month, 1);
  const ndays = monthlen(year, month);
  return [day1, ndays];
}

function monthlen(year, month) {
  return mdays[month] + (month == February && isleap(year) ? 1 : 0);
}