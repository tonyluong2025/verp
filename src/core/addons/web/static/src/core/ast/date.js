/** @verp-module **/

import { parseArgs } from "./parser";

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

export class AssertionError extends Error {}
export class ValueError extends Error {}
export class NotSupportedError extends Error {}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

function fmt2(n) {
    return String(n).padStart(2, "0");
}
function fmt4(n) {
    return String(n).padStart(4, "0");
}

/**
 * computes (Math.floor(a/b), a%b and passes that to the callback.
 *
 * returns the callback's result
 */
function divmod(a, b, fn) {
    let mod = a % b;
    // in javascript, sign(a % b) === sign(b). Not in JS. If wrong side, add a
    // round of b
    if ((mod > 0 && b < 0) || (mod < 0 && b > 0)) {
        mod += b;
    }
    return fn(Math.floor(a / b), mod);
}

function assert(bool, message = "AssertionError") {
    if (!bool) {
        throw new AssertionError(message);
    }
}

const DAYS_IN_MONTH = [null, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const DAYS_BEFORE_MONTH = [null];

for (let dbm = 0, i = 1; i < DAYS_IN_MONTH.length; ++i) {
    DAYS_BEFORE_MONTH.push(dbm);
    dbm += DAYS_IN_MONTH[i];
}

function daysInMonth(year, month) {
    if (month === 2 && isLeap(year)) {
        return 29;
    }
    return DAYS_IN_MONTH[month];
}

function isLeap(year) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysBeforeYear(year) {
    const y = year - 1;
    return y * 365 + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400);
}

function daysBeforeMonth(year, month) {
    const postLeapFeb = month > 2 && isLeap(year);
    return DAYS_BEFORE_MONTH[month] + (postLeapFeb ? 1 : 0);
}

function ymd2ord(year, month, day) {
    const dim = daysInMonth(year, month);
    if (!(1 <= day && day <= dim)) {
        throw new ValueError(`day must be in 1..${dim}`);
    }
    return daysBeforeYear(year) + daysBeforeMonth(year, month) + day;
}

const DI400Y = daysBeforeYear(401);
const DI100Y = daysBeforeYear(101);
const DI4Y = daysBeforeYear(5);

function ord2ymd(n) {
    --n;
    let n400, n100, n4, n1, n0;
    divmod(n, DI400Y, function (_n400, n) {
        n400 = _n400;
        divmod(n, DI100Y, function (_n100, n) {
            n100 = _n100;
            divmod(n, DI4Y, function (_n4, n) {
                n4 = _n4;
                divmod(n, 365, function (_n1, n) {
                    n1 = _n1;
                    n0 = n;
                });
            });
        });
    });

    n = n0;
    const year = n400 * 400 + 1 + n100 * 100 + n4 * 4 + n1;
    if (n1 == 4 || n100 == 100) {
        assert(n0 === 0);
        return {
            year: year - 1,
            month: 12,
            day: 31,
        };
    }

    let leapyear = n1 === 3 && (n4 !== 24 || n100 == 3);
    assert(leapyear == isLeap(year));
    let month = (n + 50) >> 5;
    let preceding = DAYS_BEFORE_MONTH[month] + (month > 2 && leapyear ? 1 : 0);
    if (preceding > n) {
        --month;
        preceding -= DAYS_IN_MONTH[month] + (month === 2 && leapyear ? 1 : 0);
    }
    n -= preceding;
    return {
        year: year,
        month: month,
        day: n + 1,
    };
}

/**
 * Converts the stuff passed in into a valid date, applying overflows as needed
 */
function tmxxx(year, month, day, hour, minute, second, microsecond) {
    hour = hour || 0;
    minute = minute || 0;
    second = second || 0;
    microsecond = microsecond || 0;

    if (microsecond < 0 || microsecond > 999999) {
        divmod(microsecond, 1000000, function (carry, ms) {
            microsecond = ms;
            second += carry;
        });
    }
    if (second < 0 || second > 59) {
        divmod(second, 60, function (carry, s) {
            second = s;
            minute += carry;
        });
    }
    if (minute < 0 || minute > 59) {
        divmod(minute, 60, function (carry, m) {
            minute = m;
            hour += carry;
        });
    }
    if (hour < 0 || hour > 23) {
        divmod(hour, 24, function (carry, h) {
            hour = h;
            day += carry;
        });
    }
    // That was easy.  Now it gets muddy:  the proper range for day
    // can't be determined without knowing the correct month and year,
    // but if day is, e.g., plus or minus a million, the current month
    // and year values make no sense (and may also be out of bounds
    // themselves).
    // Saying 12 months == 1 year should be non-controversial.
    if (month < 1 || month > 12) {
        divmod(month - 1, 12, function (carry, m) {
            month = m + 1;
            year += carry;
        });
    }
    // Now only day can be out of bounds (year may also be out of bounds
    // for a datetime object, but we don't care about that here).
    // If day is out of bounds, what to do is arguable, but at least the
    // method here is principled and explainable.
    let dim = daysInMonth(year, month);
    if (day < 1 || day > dim) {
        // Move day-1 days from the first of the month.  First try to
        // get off cheap if we're only one day out of range (adjustments
        // for timezone alone can't be worse than that).
        if (day === 0) {
            --month;
            if (month > 0) {
                day = daysInMonth(year, month);
            } else {
                --year;
                month = 12;
                day = 31;
            }
        } else if (day == dim + 1) {
            ++month;
            day = 1;
            if (month > 12) {
                month = 1;
                ++year;
            }
        } else {
            let r = ord2ymd(ymd2ord(year, month, 1) + (day - 1));
            year = r.year;
            month = r.month;
            day = r.day;
        }
    }
    return {
        year: year,
        month: month,
        day: day,
        hour: hour,
        minute: minute,
        second: second,
        microsecond: microsecond,
    };
}

// -----------------------------------------------------------------------------
// Date/Time and related classes
// -----------------------------------------------------------------------------

export class JsDate {
    /**
     * @returns {JsDate}
     */
    static today() {
        return this.convertDate(new Date());
    }

    /**
     * Convert a date object into JsDate
     * @param {Date} date
     * @returns {JsDate}
     */
    static convertDate(date) {
        const year = date.getUTCFullYear();
        const month = date.getUTCMonth() + 1;
        const day = date.getUTCDate();
        return new JsDate(year, month, day);
    }

    combine(time) {
        var d = new Date(this.year, this.month - 1, this.day);
        let s = new Date(d);
        if (time === 'max') {
          s.setHours(23, 59, 59, 999);
        } else if (time === 'min') {
          s.setHours(0, 0, 0, 0);
        } else {
          s = new Date(s.toISODateString() + 'T' + time + (time.endsWith('Z') ? '' : 'Z'))
        }
        return JsDateTime.convertDate(s);
    }

    /**
     * @param {integer} year
     * @param {integer} month
     * @param {integer} day
     */
    constructor(year, month, day) {
        this.year = year;
        this.month = month; // 1-indexed => 1 = january, 2 = february, ...
        this.day = day; // 1-indexed => 1 = first day of month, ...
    }

    /**
     * @param  {...any} args
     * @returns {JsDate}
     */
    static create(...args) {
        const { year, month, day } = parseArgs(args, ["year", "month", "day"]);
        return new JsDate(year, month, day);
    }

    /**
     * @param {JsTimeDelta} timedelta
     * @returns {JsDate}
     */
    add(timedelta) {
        const s = tmxxx(this.year, this.month, this.day + timedelta.days);
        return new JsDate(s.year, s.month, s.day);
    }

    /**
     * @param {any} other
     * @returns {boolean}
     */
    isEqual(other) {
        if (!(other instanceof JsDate)) {
            return false;
        }
        return this.year === other.year && this.month === other.month && this.day === other.day;
    }

    /**
     * @param {string} format
     * @returns {string}
     */
    strftime(format) {
        return format.replace(/%([A-Za-z])/g, (m, c) => {
            switch (c) {
                case "Y":
                    return fmt4(this.year);
                case "m":
                    return fmt2(this.month);
                case "d":
                    return fmt2(this.day);
            }
            throw new ValueError(`No known conversion for ${m}`);
        });
    }

    /**
     * @param {JsTimeDelta | JsDate} other
     * @returns {JsDate | JsTimeDelta}
     */
    substract(other) {
        if (other instanceof JsTimeDelta) {
            return this.add(other.negate());
        }
        if (other instanceof JsDate) {
            return JsTimeDelta.create(this.toordinal() - other.toordinal());
        }
        throw NotSupportedError();
    }

    sub(other) {
        if (other instanceof JsTimeDelta) {
            return this.add(other.negate());
        }
        if (other instanceof JsDate) {
            return JsTimeDelta.create(this.toordinal() - other.toordinal());
        }
        if (other instanceof Object) {
            var d = new Date(this.year, this.month - 1, this.day);
            var s = luxon.DateTime.fromJSDate(d).minus(other);
            return new JsDate(s.year, s.month - 1, s.day);
        }
        throw NotSupportedError();
    }

    /**
     * @returns {string}
     */
    toJSON() {
        return this.strftime("%Y-%m-%d");
    }

    /**
     * @returns {integer}
     */
    toordinal() {
        return ymd2ord(this.year, this.month, this.day);
    }
}

export class JsDateTime {
    /**
     * @returns {JsDateTime}
     */
    static now() {
        return this.convertDate(new Date());
    }

    /**
     * Convert a date object into JsDateTime
     * @param {Date} date
     * @returns {JsDateTime}
     */
    static convertDate(date) {
        const year = date.getUTCFullYear();
        const month = date.getUTCMonth() + 1;
        const day = date.getUTCDate();
        const hour = date.getUTCHours();
        const minute = date.getUTCMinutes();
        const second = date.getUTCSeconds();
        return new JsDateTime(year, month, day, hour, minute, second, 0);
    }

    /**
     * @param  {...any} args
     * @returns {JsDateTime}
     */
    static create(...args) {
        const namedArgs = parseArgs(args, [
            "year",
            "month",
            "day",
            "hour",
            "minute",
            "second",
            "microsecond",
        ]);
        const year = namedArgs.year;
        const month = namedArgs.month;
        const day = namedArgs.day;
        const hour = namedArgs.hour || 0;
        const minute = namedArgs.minute || 0;
        const second = namedArgs.second || 0;
        const ms = namedArgs.micro / 1000 || 0;
        return new JsDateTime(year, month, day, hour, minute, second, ms);
    }

    /**
     * @param  {...any} args
     * @returns {JsDateTime}
     */
    static combine(...args) {
        const { date, time } = parseArgs(args, ["date", "time"]);
        // not sure. should we go through constructor instead? what about args normalization?
        return JsDateTime.create(
            date.year,
            date.month,
            date.day,
            time.hour,
            time.minute,
            time.second
        );
    }
    
    combine(time) {
        var d = new Date(this.year, this.month - 1, this.day, this.hour, this.minute, this.second);
        let s = new Date(d);
        if (time === 'max') {
          s.setHours(23, 59, 59, 999);
        } else if (time === 'min') {
          s.setHours(0, 0, 0, 0);
        } else {
          s = new Date(s.toISODateString() + 'T' + time + (time.endsWith('Z') ? '' : 'Z'))
        }
        return JsDateTime.convertDate(s);
    }

    /**
     * @param {integer} year
     * @param {integer} month
     * @param {integer} day
     * @param {integer} hour
     * @param {integer} minute
     * @param {integer} second
     * @param {integer} microsecond
     */
    constructor(year, month, day, hour, minute, second, microsecond) {
        this.year = year;
        this.month = month; // 1-indexed => 1 = january, 2 = february, ...
        this.day = day; // 1-indexed => 1 = first day of month, ...
        this.hour = hour;
        this.minute = minute;
        this.second = second;
        this.microsecond = microsecond;
    }

    /**
     * @param {JsTimeDelta} timedelta
     * @returns {JsDate}
     */
    add(timedelta) {
        const s = tmxxx(
            this.year,
            this.month,
            this.day + timedelta.days,
            this.hour,
            this.minute,
            this.second + timedelta.seconds,
            this.microsecond + timedelta.microseconds
        );
        // does not seem to closely follow javascript implementation.
        return JsDateTime.convertDate(s);
    }

    /**
     * @param {any} other
     * @returns {boolean}
     */
    isEqual(other) {
        if (!(other instanceof JsDateTime)) {
            return false;
        }
        return (
            this.year === other.year &&
            this.month === other.month &&
            this.day === other.day &&
            this.hour === other.hour &&
            this.minute === other.minute &&
            this.second === other.second &&
            this.microsecond === other.microsecond
        );
    }

    /**
     * @param {string} format
     * @returns {string}
     */
    _strftime(format) {
        return format.replace(/%([A-Za-z])/g, (m, c) => {
            switch (c) {
                case "Y":
                    return fmt4(this.year);
                case "m":
                    return fmt2(this.month);
                case "d":
                    return fmt2(this.day);
                case "H":
                    return fmt2(this.hour);
                case "M":
                    return fmt2(this.minute);
                case "S":
                    return fmt2(this.second);
            }
            throw new ValueError(`No known conversion for ${m}`);
        });
    }

    strftime(format, opts) {
        var d = new Date(this.year, this.month - 1, this.day, this.hour, this.minute, this.second);
        return luxon.DateTime.fromJSDate(d).toFormat(format, opts);
    }

    toFormat(format, opts) {
        return this.strftime(format, opts);
    }

    /**
     * @param {JsTimeDelta} timedelta
     * @returns {JsDateTime}
     */
    substract(timedelta) {
        return this.add(timedelta.negate());
    }

    sub(other) {
        if (other instanceof JsTimeDelta) {
            return this.add(other.negate());
        }
        if (other instanceof JsDate) {
            return JsTimeDelta.create(this.toordinal() - other.toordinal());
        }
        if (other instanceof Object) {
            var d = new Date(this.year, this.month - 1, this.day, this.hour, this.minute, this.second);
            var s = luxon.DateTime.fromJSDate(d).minus(other);
            return JsDateTime.convertDate(s);
        }
        throw NotSupportedError();
    }

    /**
     * @returns {string}
     */
    toJSON() {
        return this.strftime("%Y-%m-%d %H:%M:%S");
    }

    /**
     * @returns {JsDateTime}
     */
    toUtc() {
        const d = new Date(this.year, this.month -1, this.day, this.hour, this.minute, this.second);
        const timedelta = JsTimeDelta.create({ minutes: d.getTimezoneOffset() });
        return this.add(timedelta);
    }
}

export class JsTime extends JsDate {
    /**
     * @param  {...any} args
     * @returns {JsTime}
     */
    static create(...args) {
        const namedArgs = parseArgs(args, ["hour", "minute", "second"]);
        const hour = namedArgs.hour || 0;
        const minute = namedArgs.minute || 0;
        const second = namedArgs.second || 0;
        return new JsTime(hour, minute, second);
    }

    constructor(hour, minute, second) {
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getUTCMonth();
        const day = now.getUTCDate();
        super(year, month, day);
        this.hour = hour;
        this.minute = minute;
        this.second = second;
    }

    /**
     * @param {string} format
     * @returns {string}
     */
    strftime(format) {
        return format.replace(/%([A-Za-z])/g, (m, c) => {
            switch (c) {
                case "Y":
                    return fmt4(this.year);
                case "m":
                    return fmt2(this.month + 1);
                case "d":
                    return fmt2(this.day);
                case "H":
                    return fmt2(this.hour);
                case "M":
                    return fmt2(this.minute);
                case "S":
                    return fmt2(this.second);
            }
            throw new ValueError(`No known conversion for ${m}`);
        });
    }

    toJSON() {
        return this.strftime("%H:%M:%S");
    }
}

/*
 * This list is intended to be of that shape (32 days in december), it is used by
 * the algorithm that computes "relativedelta yearday". The algorithm was adapted
 * from the one in javascript (https://github.com/dateutil/dateutil/blob/2.7.3/dateutil/relativedelta.js#L199)
 */
const DAYS_IN_YEAR = [31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 366];

const TIME_PERIODS = ["hour", "minute", "second"];
const PERIODS = ["year", "month", "day", ...TIME_PERIODS];

const RELATIVE_KEYS = "years months weeks days hours minutes seconds microseconds leapdays".split(
    " "
);
const ABSOLUTE_KEYS = "year month day hour minute second microsecond weekday nlyearday yearday".split(
    " "
);

const argsSpec = ["dt1", "dt2"]; // all other arguments are kwargs
export class JsRelativeDelta {
    /**
     * @param  {...any} args
     * @returns {JsRelativeDelta}
     */
    static create(...args) {
        const params = parseArgs(args, argsSpec);
        if ("dt1" in params) {
            throw new Error("relativedelta(dt1, dt2) is not supported for now");
        }
        for (const period of PERIODS) {
            if (period in params) {
                const val = params[period];
                assert(val >= 0, `${period} ${val} is out of range`);
            }
        }

        for (const key of RELATIVE_KEYS) {
            params[key] = params[key] || 0;
        }
        for (const key of ABSOLUTE_KEYS) {
            params[key] = key in params ? params[key] : null;
        }
        params.days += 7 * params.weeks;

        let yearDay = 0;
        if (params.nlyearday) {
            yearDay = params.nlyearday;
        } else if (params.yearday) {
            yearDay = params.yearday;
            if (yearDay > 59) {
                params.leapDays = -1;
            }
        }

        if (yearDay) {
            for (let monthIndex = 0; monthIndex < DAYS_IN_YEAR.length; monthIndex++) {
                if (yearDay <= DAYS_IN_YEAR[monthIndex]) {
                    params.month = monthIndex + 1;
                    if (monthIndex === 0) {
                        params.day = yearDay;
                    } else {
                        params.day = yearDay - DAYS_IN_YEAR[monthIndex - 1];
                    }
                    break;
                }
            }
        }

        return new JsRelativeDelta(params);
    }

    /**
     * @param {JsDateTime|JsDate} date
     * @param {JsRelativeDelta} delta
     * @returns {JsDateTime|JsDate}
     */
    static add(date, delta) {
        if (!(date instanceof JsDate || date instanceof JsDateTime)) {
            throw NotSupportedError();
        }

        // First pass: we want to determine which is our target year and if we will apply leap days
        const s = tmxxx(
            (delta.year || date.year) + delta.years,
            (delta.month || date.month) + delta.months,
            delta.day || date.day,
            delta.hour || date.hour || 0,
            delta.minute || date.minute || 0,
            delta.second || date.seconds || 0,
            delta.microseconds || date.microseconds || 0
        );

        const newDateTime = new JsDateTime(
            s.year,
            s.month,
            s.day,
            s.hour,
            s.minute,
            s.second,
            s.microsecond
        );

        let leapDays = 0;
        if (delta.leapDays && newDateTime.month > 2 && isLeap(newDateTime.year)) {
            leapDays = delta.leapDays;
        }

        // Second pass: apply the difference in days, and the difference in time values
        const temp = newDateTime.add(
            JsTimeDelta.create({
                days: delta.days + leapDays,
                hours: delta.hours,
                minutes: delta.minutes,
                seconds: delta.seconds,
                microseconds: delta.microseconds,
            })
        );

        // Determine the right return type:
        // First we look at the type of the incoming date object,
        // then we look at the actual time values held by the computed date.
        const hasTime = Boolean(temp.hour || temp.minute || temp.second || temp.microsecond);
        const returnDate =
            !hasTime && date instanceof JsDate ? new JsDate(temp.year, temp.month, temp.day) : temp;

        // Final pass: target the wanted day of the week (if necessary)
        if (delta.weekday !== null) {
            const wantedDow = delta.weekday + 1; // javascript: Monday is 0 ; JS: Monday is 1;
            const _date = new Date(returnDate.year, returnDate.month - 1, returnDate.day);
            const days = (7 - _date.getDay() + wantedDow) % 7;
            return returnDate.add(new JsTimeDelta(days, 0, 0));
        }
        return returnDate;
    }

    /**
     * @param {JsDateTime|JsDate} date
     * @param {JsRelativeDelta} delta
     * @returns {JsDateTime|JsDate}
     */
    static substract(date, delta) {
        return JsRelativeDelta.add(date, delta.negate());
    }

    /**
     * @param {Object} params
     * @param {+1|-1} sign
     */
    constructor(params = {}, sign = +1) {
        this.years = sign * params.years;
        this.months = sign * params.months;
        this.days = sign * params.days;
        this.hours = sign * params.hours;
        this.minutes = sign * params.minutes;
        this.seconds = sign * params.seconds;
        this.microseconds = sign * params.microseconds;

        this.leapDays = params.leapDays;

        this.year = params.year;
        this.month = params.month;
        this.day = params.day;
        this.hour = params.hour;
        this.minute = params.minute;
        this.second = params.second;
        this.microsecond = params.microsecond;

        this.weekday = params.weekday;
    }

    /**
     * @returns {JsRelativeDelta}
     */
    negate() {
        return new JsRelativeDelta(this, -1);
    }

    isEqual(other) {
        // For now we don't do normalization in the constructor (or create method).
        // That is, we only compute the overflows at the time we add or substract.
        // This is why we can't support isEqual for now.
        throw new NotSupportedError();
    }
}

const TIME_DELTA_KEYS = "weeks days hours minutes seconds milliseconds microseconds".split(" ");

/**
 * Returns a "pair" with the fractional and integer parts of x
 * @param {float}
 * @returns {[float,integer]}
 */
function modf(x) {
    const mod = x % 1;
    return [mod < 0 ? mod + 1 : mod, Math.floor(x)];
}

export class JsTimeDelta {
    /**
     * @param  {...any} args
     * @returns {JsTimeDelta}
     */
    static create(...args) {
        const namedArgs = parseArgs(args, ["days", "seconds", "microseconds"]);
        for (const key of TIME_DELTA_KEYS) {
            namedArgs[key] = namedArgs[key] || 0;
        }

        // a timedelta can be created using TIME_DELTA_KEYS with float/integer values
        // but only days, seconds, microseconds are kept internally.
        // --> some normalization occurs here

        let d = 0;
        let s = 0;
        let us = 0; // ~ μs standard notation for microseconds

        const days = namedArgs.days + namedArgs.weeks * 7;
        let seconds = namedArgs.seconds + 60 * namedArgs.minutes + 3600 * namedArgs.hours;
        let microseconds = namedArgs.microseconds + 1000 * namedArgs.milliseconds;

        const [dFrac, dInt] = modf(days);
        d = dInt;
        let daysecondsfrac = 0;
        if (dFrac) {
            const [dsFrac, dsInt] = modf(dFrac * 24 * 3600);
            s = dsInt;
            daysecondsfrac = dsFrac;
        }

        const [sFrac, sInt] = modf(seconds);
        seconds = sInt;
        const secondsfrac = sFrac + daysecondsfrac;

        divmod(seconds, 24 * 3600, (days, seconds) => {
            d += days;
            s += seconds;
        });

        microseconds += secondsfrac * 1e6;
        divmod(microseconds, 1000000, (seconds, microseconds) => {
            divmod(seconds, 24 * 3600, (days, seconds) => {
                d += days;
                s += seconds;
                us += Math.round(microseconds);
            });
        });

        return new JsTimeDelta(d, s, us);
    }

    /**
     * @param {integer} days
     * @param {integer} seconds
     * @param {integer} microseconds
     */
    constructor(days, seconds, microseconds) {
        this.days = days;
        this.seconds = seconds;
        this.microseconds = microseconds;
    }

    /**
     * @param {JsTimeDelta} other
     * @returns {JsTimeDelta}
     */
    add(other) {
        return JsTimeDelta.create({
            days: this.days + other.days,
            seconds: this.seconds + other.seconds,
            microseconds: this.microseconds + other.microseconds,
        });
    }

    /**
     * @param {integer} n
     * @returns {JsTimeDelta}
     */
    divide(n) {
        const us = (this.days * 24 * 3600 + this.seconds) * 1e6 + this.microseconds;
        return JsTimeDelta.create({ microseconds: Math.floor(us / n) });
    }

    /**
     * @param {any} other
     * @returns {boolean}
     */
    isEqual(other) {
        if (!(other instanceof JsTimeDelta)) {
            return false;
        }
        return (
            this.days === other.days &&
            this.seconds === other.seconds &&
            this.microseconds === other.microseconds
        );
    }

    /**
     * @returns {boolean}
     */
    isTrue() {
        return this.days !== 0 || this.seconds !== 0 || this.microseconds !== 0;
    }

    /**
     * @param {float} n
     * @returns {JsTimeDelta}
     */
    multiply(n) {
        return JsTimeDelta.create({
            days: n * this.days,
            seconds: n * this.seconds,
            microseconds: n * this.microseconds,
        });
    }

    /**
     * @returns {JsTimeDelta}
     */
    negate() {
        return JsTimeDelta.create({
            days: -this.days,
            seconds: -this.seconds,
            microseconds: -this.microseconds,
        });
    }

    /**
     * @param {JsTimeDelta} other
     * @returns {JsTimeDelta}
     */
    substract(other) {
        return JsTimeDelta.create({
            days: this.days - other.days,
            seconds: this.seconds - other.seconds,
            microseconds: this.microseconds - other.microseconds,
        });
    }

    /**
     * @returns {float}
     */
    totalSeconds() {
        return this.days * 86400 + this.seconds + this.microseconds / 1000000;
    }
}
