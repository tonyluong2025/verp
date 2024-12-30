(function (vj) {
"use strict";

/**
 * This file add extra functionality to the javascript interpreter exported by vj.js
 *
 * Main extra functionality is about time management, more precisely:
 * - date
 * - datetime
 * - relativedelta
 *
 * These javascript modules are exported in the vj.extras object, and can be added
 * to the evaluation context.  For example,
 *
 *  var context = {
 *      datetime: vj.extras.datetime,
 *      date: vj.extras.date,
 *      time: vj.extras.time,
 *  };
 *  var result = vj.eval(some_javascript_expression, context);
 */

/*
 * vj.js helpers and setup
 */

/**
 * computes (Math.floor(a/b), a%b and passes that to the callback.
 *
 * returns the callback's result
 */
function divmod (a, b, fn) {
    var mod = a%b;
    // in javascript, sign(a % b) === sign(b). Not in JS. If wrong side, add a
    // round of b
    if (mod > 0 && b < 0 || mod < 0 && b > 0) {
        mod += b;
    }
    return fn(Math.floor(a/b), mod);
}

/**
 * Passes the fractional and integer parts of x to the callback, returns
 * the callback's result
 */
function modf(x, fn) {
    var mod = x%1;
    if (mod < 0) {
        mod += 1;
    }
    return fn(mod, Math.floor(x));
}

function assert(bool) {
    if (!bool) {
        throw new Error("AssertionError");
    }
}


var obj = function () {};
obj.prototype = vj.object;
var asJS = function (arg) {
    if (arg instanceof obj) {
        return arg.toJSON();
    }
    return arg;
};

var datetime = vj.VJ_call(vj.object);

var zero = vj.float.fromJSON(0);

var DAYS_IN_MONTH = [null, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
var DAYS_BEFORE_MONTH = [null];
var dbm = 0;

for (var i=1; i<DAYS_IN_MONTH.length; ++i) {
    DAYS_BEFORE_MONTH.push(dbm);
    dbm += DAYS_IN_MONTH[i];
}

function is_leap(year) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function days_before_year(year) {
    var y = year - 1;
    return y*365 + Math.floor(y/4) - Math.floor(y/100) + Math.floor(y/400);
}

function days_in_month(year, month) {
    if (month === 2 && is_leap(year)) {
        return 29;
    }
    return DAYS_IN_MONTH[month];
}

function days_before_month(year, month) {
    var post_leap_feb = month > 2 && is_leap(year);
    return DAYS_BEFORE_MONTH[month] + (post_leap_feb ? 1 : 0);
}

function ymd2ord(year, month, day) {
    var dim = days_in_month(year, month);
    if (!(1 <= day && day <= dim)) {
        throw new Error("ValueError: day must be in 1.." + dim);
    }
    return days_before_year(year) +
           days_before_month(year, month) +
           day;
}

function get_quarter_number(month) {
    return Math.ceil(month / 3);
}

function get_quarter(year, month) {
    var quarter_number = get_quarter_number(month);
    var month_from = ((quarter_number - 1) * 3) + 1
    var dateFrom = {year: year, month: month_from, day: 1}
    var dateTo = {year: year, month: month_from + 2, day: days_in_month(year, month)}
    return [dateFrom, dateTo];
}

function get_day_of_week(year, month, day) {
    // Since JavaScript is a piece of garbage, months start at 0
    var d = new Date(year, month - 1, day);
    // Convert to ISO8601: Monday = 0 ... Sunday = 6
    return (d.getDay() + 6) % 7;
}

var DI400Y = days_before_year(401);
var DI100Y = days_before_year(101);
var DI4Y = days_before_year(5);

function ord2ymd(n) {
    --n;
    var n400, n100, n4, n1, n0;
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
    var year = n400 * 400 + 1 + n100 * 100 + n4 * 4 + n1;
    if (n1 == 4 || n100 == 100) {
        assert(n0 === 0);
        return {
            year: year - 1,
            month: 12,
            day: 31
        };
    }

    var leapyear = n1 === 3 && (n4 !== 24 || n100 == 3);
    assert(leapyear == is_leap(year));
    var month = (n + 50) >> 5;
    var preceding = DAYS_BEFORE_MONTH[month] + ((month > 2 && leapyear) ? 1 : 0);
    if (preceding > n) {
        --month;
        preceding -= DAYS_IN_MONTH[month] + ((month === 2 && leapyear) ? 1 : 0);
    }
    n -= preceding;
    return {
        year: year,
        month: month,
        day: n+1
    };
}

/**
 * Converts the stuff passed in into a valid date, applying overflows as needed
 */
function tmxxx(year, month, day, hour, minute, second, microsecond) {
    hour = hour || 0; minute = minute || 0; second = second || 0;
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
        divmod(month-1, 12, function (carry, m) {
            month = m + 1;
            year += carry;
        });
    }
    // Now only day can be out of bounds (year may also be out of bounds
    // for a datetime object, but we don't care about that here).
    // If day is out of bounds, what to do is arguable, but at least the
    // method here is principled and explainable.
    var dim = days_in_month(year, month);
    if (day < 1 || day > dim) {
        // Move day-1 days from the first of the month.  First try to
        // get off cheap if we're only one day out of range (adjustments
        // for timezone alone can't be worse than that).
        if (day === 0) {
            --month;
            if (month > 0) {
                day = days_in_month(year, month);
            } else {
                --year; month=12; day=31;
            }
        } else if (day == dim + 1) {
            ++month;
            day = 1;
            if (month > 12) {
                month = 1;
                ++year;
            }
        } else {
            var r = ord2ymd(ymd2ord(year, month, 1) + (day - 1));
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
        microsecond: microsecond
    };
}

datetime.timedelta = vj.type('timedelta', null, {
    __init__: function () {
        var args = vj.VJ_parseArgs(arguments, [
            ['days', zero], ['seconds', zero], ['microseconds', zero],
            ['milliseconds', zero], ['minutes', zero], ['hours', zero],
            ['weeks', zero]
        ]);

        var d = 0, s = 0, m = 0;
        var days = args.days.toJSON() + args.weeks.toJSON() * 7;
        var seconds = args.seconds.toJSON()
                    + args.minutes.toJSON() * 60
                    + args.hours.toJSON() * 3600;
        var microseconds = args.microseconds.toJSON()
                         + args.milliseconds.toJSON() * 1000;

        // Get rid of all fractions, and normalize s and us.
        // Take a deep breath <wink>.
        var daysecondsfrac = modf(days, function (dayfrac, days) {
            d = days;
            if (dayfrac) {
                return modf(dayfrac * 24 * 3600, function (dsf, dsw) {
                    s = dsw;
                    return dsf;
                });
            }
            return 0;
        });

        var secondsfrac = modf(seconds, function (sf, s) {
            seconds = s;
            return sf + daysecondsfrac;
        });
        divmod(seconds, 24*3600, function (days, seconds) {
            d += days;
            s += seconds;
        });
        // seconds isn't referenced again before redefinition

        microseconds += secondsfrac * 1e6;
        divmod(microseconds, 1000000, function (seconds, microseconds) {
            divmod(seconds, 24*3600, function (days, seconds) {
                d += days;
                s += seconds;
                m += Math.round(microseconds);
            });
        });

        // Carrying still possible here?

        this.days = d;
        this.seconds = s;
        this.microseconds = m;
    },
    __str__: function () {
        var hh, mm, ss;
        divmod(this.seconds, 60, function (m, s) {
            divmod(m, 60, function (h, m) {
                hh = h;
                mm = m;
                ss = s;
            });
        });
        var s = _.str.sprintf("%d:%02d:%02d", hh, mm, ss);
        if (this.days) {
            s = _.str.sprintf("%d day%s, %s",
                this.days,
                (this.days != 1 && this.days != -1) ? 's' : '',
                s);
        }
        if (this.microseconds) {
            s = _.str.sprintf("%s.%06d", s, this.microseconds);
        }
        return vj.str.fromJSON(s);
    },
    __eq__: function (other) {
        if (!vj.VJ_isInstance(other, datetime.timedelta)) {
            return vj.false;
        }

        return (this.days === other.days
            && this.seconds === other.seconds
            && this.microseconds === other.microseconds)
                ? vj.true : vj.false;
    },
    __add__: function (other) {
        if (!vj.VJ_isInstance(other, datetime.timedelta)) {
            return vj.NotImplemented;
        }
        return vj.VJ_call(datetime.timedelta, [
            vj.float.fromJSON(this.days + other.days),
            vj.float.fromJSON(this.seconds + other.seconds),
            vj.float.fromJSON(this.microseconds + other.microseconds)
        ]);
    },
    __radd__: function (other) { return this.__add__(other); },
    __sub__: function (other) {
        if (!vj.VJ_isInstance(other, datetime.timedelta)) {
            return vj.NotImplemented;
        }
        return vj.VJ_call(datetime.timedelta, [
            vj.float.fromJSON(this.days - other.days),
            vj.float.fromJSON(this.seconds - other.seconds),
            vj.float.fromJSON(this.microseconds - other.microseconds)
        ]);
    },
    __rsub__: function (other) {
        if (!vj.VJ_isInstance(other, datetime.timedelta)) {
            return vj.NotImplemented;
        }
        return this.__neg__().__add__(other);
    },
    __neg__: function () {
        return vj.VJ_call(datetime.timedelta, [
            vj.float.fromJSON(-this.days),
            vj.float.fromJSON(-this.seconds),
            vj.float.fromJSON(-this.microseconds)
        ]);
    },
    __pos__: function () { return this; },
    __mul__: function (other) {
        if (!vj.VJ_isInstance(other, vj.float)) {
            return vj.NotImplemented;
        }
        var n = other.toJSON();
        return vj.VJ_call(datetime.timedelta, [
            vj.float.fromJSON(this.days * n),
            vj.float.fromJSON(this.seconds * n),
            vj.float.fromJSON(this.microseconds * n)
        ]);
    },
    __rmul__: function (other) { return this.__mul__(other); },
    __div__: function (other) {
        if (!vj.VJ_isInstance(other, vj.float)) {
            return vj.NotImplemented;
        }
        var usec = ((this.days * 24 * 3600) + this.seconds) * 1000000
                    + this.microseconds;
        return vj.VJ_call(
            datetime.timedelta, [
                zero, zero, vj.float.fromJSON(usec / other.toJSON())]);
    },
    __floordiv__: function (other) { return this.__div__(other); },
    totalSeconds: function () {
        return vj.float.fromJSON(
            this.days * 86400
          + this.seconds
          + this.microseconds / 1000000);
    },
    __nonzero__: function () {
        return (!!this.days || !!this.seconds || !!this.microseconds)
            ? vj.true
            : vj.false;
    }
});

datetime.datetime = vj.type('datetime', null, {
    __init__: function () {
        var zero = vj.float.fromJSON(0);
        var args = vj.VJ_parseArgs(arguments, [
            'year', 'month', 'day',
            ['hour', zero], ['minute', zero], ['second', zero],
            ['microsecond', zero], ['tzinfo', vj.None]
        ]);
        for(var key in args) {
            if (!args.hasOwnProperty(key)) { continue; }
            this[key] = asJS(args[key]);
        }
    },
    __eq__: function (other) {
        return (this.year === other.year
             && this.month === other.month
             && this.day === other.day
             && this.hour === other.hour
             && this.minute === other.minute
             && this.second === other.second
             && this.microsecond === other.microsecond
             && this.tzinfo === other.tzinfo)
            ? vj.true : vj.false;
    },
    replace: function () {
        var args = vj.VJ_parseArgs(arguments, [
            ['year', vj.None], ['month', vj.None], ['day', vj.None],
            ['hour', vj.None], ['minute', vj.None], ['second', vj.None],
            ['microsecond', vj.None] // FIXME: tzinfo, can't use None as valid input
        ]);
        var params = {};
        for(var key in args) {
            if (!args.hasOwnProperty(key)) { continue; }

            var arg = args[key];
            params[key] = (arg === vj.None ? this[key] : asJS(arg));
        }
        return vj.VJ_call(datetime.datetime, params);
    },
    start_of: function() {
        var args = vj.VJ_parseArgs(arguments, 'granularity');
        var granularity = args.granularity.toJSON();
        if (granularity === 'year') {
            return vj.VJ_call(datetime.datetime, [this.year, 1, 1]);
        } else if (granularity === 'quarter') {
            var quarter = get_quarter(this.year, this.month)[0];
            return vj.VJ_call(datetime.datetime, [quarter.year, quarter.month, quarter.day]);
        } else if (granularity === 'month') {
            return vj.VJ_call(datetime.datetime, [this.year, this.month, 1]);
        } else if (granularity === 'week') {
            var dow = get_day_of_week(this.year, this.month, this.day);
            return vj.VJ_call(datetime.datetime, [this.year, this.month, this.day - dow]);
        } else if (granularity === 'day') {
            return vj.VJ_call(datetime.datetime, [this.year, this.month, this.day]);
        } else if (granularity === 'hour') {
            return vj.VJ_call(datetime.datetime, [this.year, this.month, this.day, this.hour]);
        } else {
            throw new Error(
                'ValueError: ' + granularity + ' is not a supported granularity, supported ' +
                ' granularities are: year, quarter, month, week, day and hour.'
            )
        }
    },
    end_of: function () {
        var args = vj.VJ_parseArgs(arguments, 'granularity');
        var granularity = args.granularity.toJSON();
        var min = [23, 59, 59];
        if (granularity === 'year') {
            return vj.VJ_call(datetime.datetime, [this.year, 12, 31].concat(min));
        } else if (granularity === 'quarter') {
            var quarter = get_quarter(this.year, this.month)[1];
            return vj.VJ_call(
                datetime.datetime, [quarter.year, quarter.month, quarter.day].concat(min)
            );
        } else if (granularity === 'month') {
            var dom = days_in_month(this.year, this.month);
            return vj.VJ_call(datetime.datetime, [this.year, this.month, dom].concat(min));
        } else if (granularity === 'week') {
            var dow = get_day_of_week(this.year, this.month, this.day);
            return vj.VJ_call(
                datetime.datetime, [this.year, this.month, this.day + (6 - dow)].concat(min)
            );
        } else if (granularity === 'day') {
            return vj.VJ_call(datetime.datetime, [this.year, this.month, this.day].concat(min));
        } else if (granularity === 'hour') {
            return vj.VJ_call(
                datetime.datetime, [this.year, this.month, this.day, this.hour, 59, 59]
            );
        } else {
            throw new Error(
                'ValueError: ' + granularity + ' is not a supported granularity, supported ' +
                ' granularities are: year, quarter, month, week, day and hour.'
            )
        }
    },
    _add: function() {
        var args = vj.VJ_parseArgs(arguments, [
            ['years', vj.None], ['months', vj.None], ['days', vj.None],
            ['hours', vj.None], ['minutes', vj.None], ['seconds', vj.None],
        ]);
        return vj.VJ_add(this, vj.VJ_call(relativedelta, {
            'years': args.years,
            'months': args.months,
            'days': args.days,
            'hours': args.hours,
            'minutes': args.minutes,
            'seconds': args.seconds,
        }));
    },
    _subtract: function() {
        var args = vj.VJ_parseArgs(arguments, [
            ['years', vj.None], ['months', vj.None], ['days', vj.None],
            ['hours', vj.None], ['minutes', vj.None], ['seconds', vj.None],
        ]);
        var params = {};
        for (var key in args) {
            params[key] = (args[key] === vj.None ? args[key] : vj.float.fromJSON(-asJS(args[key])));
        }
        return vj.VJ_add(this, vj.VJ_call(relativedelta, params));
    },
    _strftime: function () {// origin used for other format
        var self = this;
        var args = vj.VJ_parseArgs(arguments, 'format');
        return vj.str.fromJSON(args.format.toJSON()
            .replace(/%([A-Za-z])/g, function (m, c) {
                switch (c) {
                case 'Y': return _.str.sprintf('%04d', self.year);
                case 'm': return _.str.sprintf('%02d', self.month);
                case 'd': return _.str.sprintf('%02d', self.day);
                case 'H': return _.str.sprintf('%02d', self.hour);
                case 'M': return _.str.sprintf('%02d', self.minute);
                case 'S': return _.str.sprintf('%02d', self.second);
                }
                throw new Error('ValueError: No known conversion for ' + m);
            }));
    },
    strftime: function (format, opts) {
        var d = new Date(this.year, this.month - 1, this.day, this.hour, this.minute, this.second);
        return luxon.DateTime.fromJSDate(d).toFormat(format, opts);
    },
    toFormat: function (format, opts) {
        return this.strftime(format, opts);
    },
    add: function(opts = {}) {
        var d = new Date(this.year, this.month - 1, this.day, this.hour, this.minute, this.second);
        var s = luxon.DateTime.fromJSDate(d).plus(opts);
        return datetime.datetime.fromJSON(s.year, s.month - 1, s.day, s.hour, s.minute, s.second);
    },
    subtract(opts = {}) {
        var d = new Date(this.year, this.month - 1, this.day, this.hour, this.minute, this.second);
        var s = luxon.DateTime.fromJSDate(d).minus(opts);
        return datetime.datetime.fromJSON(s.year, s.month - 1, s.day, s.hour, s.minute, s.second);
    },
    sub(opts = {}) {
        return this.subtract(opts);
    },
    diff(other, units, opts = {}) {
        var d = new Date(this.year, this.month - 1, this.day, this.hour, this.minute, this.second);
        return luxon.DateTime.fromJSDate(d).diff(luxon.DateTime.fromJSDate(other), units, opts);
    },
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
        return datetime.datetime.fromJSON(s.year, s.month - 1, s.day, s.hour, s.minute, s.second);
    },
    toUtc: function () {
        var d = new Date(this.year, this.month - 1, this.day, this.hour, this.minute, this.second);
        var offset = d.getTimezoneOffset();
        var kwargs = {minutes: vj.float.fromJSON(offset)};
        var timedelta = vj.VJ_call(vj.extras.datetime.timedelta,[],kwargs);
        var s = tmxxx(this.year, this.month, this.day + timedelta.days, this.hour, this.minute, this.second + timedelta.seconds);
        return datetime.datetime.fromJSON(s.year, s.month, s.day, s.hour, s.minute, s.second);
    },
    now: vj.classmethod.fromJSON(function () {
        var d = new Date();
        return vj.VJ_call(datetime.datetime, [
            d.getFullYear(), d.getMonth() + 1, d.getDate(),
            d.getHours(), d.getMinutes(), d.getSeconds(),
            d.getMilliseconds() * 1000]);
    }),
    today: vj.classmethod.fromJSON(function () {
        var dt_class = vj.VJ_getAttr(datetime, 'datetime');
        return vj.VJ_call(vj.VJ_getAttr(dt_class, 'now'));
    }),
    utcnow: vj.classmethod.fromJSON(function () {
        var d = new Date();
        return vj.VJ_call(datetime.datetime,
            [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(),
             d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(),
             d.getUTCMilliseconds() * 1000]);
    }),

    combine: vj.classmethod.fromJSON(function () {
        var args = vj.VJ_parseArgs(arguments, 'date time');
        return vj.VJ_call(datetime.datetime, [
            vj.VJ_getAttr(args.date, 'year'),
            vj.VJ_getAttr(args.date, 'month'),
            vj.VJ_getAttr(args.date, 'day'),
            vj.VJ_getAttr(args.time, 'hour'),
            vj.VJ_getAttr(args.time, 'minute'),
            vj.VJ_getAttr(args.time, 'second')
        ]);
    }),
    toJSON: function () {
        return new Date(
            this.year,
            this.month - 1,
            this.day,
            this.hour,
            this.minute,
            this.second,
            this.microsecond / 1000);
    },
    __add__: function (other) {
        if (!vj.VJ_isInstance(other, datetime.timedelta)) {
            return vj.NotImplemented;
        }
        var s = tmxxx(this.year, this.month, this.day + other.days, this.hour, this.minute, this.second + other.seconds);
        return datetime.datetime.fromJSON(s.year, s.month, s.day, s.hour, s.minute, s.second);
    },
    __sub__: function (other) {
        if (vj.VJ_isInstance(other, datetime.timedelta)) {
            return vj.VJ_add(this, vj.VJ_negative(other));
        }
        return vj.NotImplemented;
    },
    fromJSON: function (year, month, day, hour, minute, second) {
        return vj.VJ_call(datetime.datetime, [year, month, day, hour, minute, second]);
    },
});

datetime.date = vj.type('date', null, {
    __init__: function () {
        var args = vj.VJ_parseArgs(arguments, 'year month day');
        this.year = asJS(args.year);
        this.month = asJS(args.month);
        this.day = asJS(args.day);
    },
    _strftime: function () { // origin used for other format
        var self = this;
        var args = vj.VJ_parseArgs(arguments, 'format');
        return vj.str.fromJSON(args.format.toJSON()
            .replace(/%([A-Za-z])/g, function (m, c) {
                switch (c) {
                case 'Y': return self.year;
                case 'm': return _.str.sprintf('%02d', self.month);
                case 'd': return _.str.sprintf('%02d', self.day);
                }
                throw new Error('ValueError: No known conversion for ' + m);
            }));
    },
    strftime: function (format, opts) {
        var d = new Date(this.year, this.month - 1, this.day);
        return luxon.DateTime.fromJSDate(d).toFormat(format, opts);
    },
    toFormat: function (format, opts) {
        return this.strftime(format, opts);
    },
    add: function(opts = {}) {
        var d = new Date(this.year, this.month - 1, this.day);
        var s = luxon.DateTime.fromJSDate(d).plus(opts);
        return datetime.datetime.fromJSON(s.year, s.month - 1, s.day);
    },
    subtract(opts = {}) {
        var d = new Date(this.year, this.month - 1, this.day);
        var s = luxon.DateTime.fromJSDate(d).minus(opts);
        return datetime.datetime.fromJSON(s.year, s.month - 1, s.day);
    },
    sub(opts = {}) {
        return this.subtract(opts);
    },
    diff(other, units, opts = {}) {
        var d = new Date(this.year, this.month - 1, this.day);
        return luxon.DateTime.fromJSDate(d).diff(luxon.DateTime.fromJSDate(other), units, opts);
    },
    __eq__: function (other) {
        return (this.year === other.year
             && this.month === other.month
             && this.day === other.day)
            ? vj.true : vj.false;
    },
    replace: function () {
        var args = vj.VJ_parseArgs(arguments, [
            ['year', vj.None], ['month', vj.None], ['day', vj.None]
        ]);
        var params = {};
        for(var key in args) {
            if (!args.hasOwnProperty(key)) { continue; }

            var arg = args[key];
            params[key] = (arg === vj.None ? this[key] : asJS(arg));
        }
        return vj.VJ_call(datetime.date, params);
    },
    start_of: function() {
        var args = vj.VJ_parseArgs(arguments, 'granularity');
        var granularity = args.granularity.toJSON();
        if (granularity === 'year') {
            return vj.VJ_call(datetime.date, [this.year, 1, 1]);
        } else if (granularity === 'quarter') {
            var quarter = get_quarter(this.year, this.month)[0];
            return vj.VJ_call(datetime.date, [quarter.year, quarter.month, quarter.day]);
        } else if (granularity === 'month') {
            return vj.VJ_call(datetime.date, [this.year, this.month, 1]);
        } else if (granularity === 'week') {
            var dow = get_day_of_week(this.year, this.month, this.day);
            return vj.VJ_call(datetime.date, [this.year, this.month, this.day - dow]);
        } else if (granularity === 'day') {
            return vj.VJ_call(datetime.date, [this.year, this.month, this.day]);
        } else {
            throw new Error(
                'ValueError: ' + granularity + ' is not a supported granularity, supported ' +
                ' granularities are: year, quarter, month, week and day.'
            )
        }
    },
    end_of: function () {
        var args = vj.VJ_parseArgs(arguments, 'granularity');
        var granularity = args.granularity.toJSON();
        if (granularity === 'year') {
            return vj.VJ_call(datetime.date, [this.year, 12, 31]);
        } else if (granularity === 'quarter') {
            var quarter = get_quarter(this.year, this.month)[1];
            return vj.VJ_call(datetime.date, [quarter.year, quarter.month, quarter.day]);
        } else if (granularity === 'month') {
            var dom = days_in_month(this.year, this.month);
            return vj.VJ_call(datetime.date, [this.year, this.month, dom]);
        } else if (granularity === 'week') {
            var dow = get_day_of_week(this.year, this.month, this.day);
            return vj.VJ_call(datetime.date, [this.year, this.month, this.day + (6 - dow)]);
        } else if (granularity === 'day') {
            return vj.VJ_call(datetime.date, [this.year, this.month, this.day]);
        } else {
            throw new Error(
                'ValueError: ' + granularity + ' is not a supported granularity, supported ' +
                ' granularities are: year, quarter, month, week and day.'
            )
        }
    },
    _add: function() {
        var args = vj.VJ_parseArgs(arguments, [
            ['years', vj.None], ['months', vj.None], ['days', vj.None],
        ]);
        return vj.VJ_add(this, vj.VJ_call(relativedelta, {
            'years': args.years,
            'months': args.months,
            'days': args.days,
        }));
    },
    _subtract: function() {
        var args = vj.VJ_parseArgs(arguments, [
            ['years', vj.None], ['months', vj.None], ['days', vj.None],
        ]);
        var params = {};
        for (var key in args) {
            params[key] = (args[key] === vj.None ? args[key] : vj.float.fromJSON(-asJS(args[key])));
        }
        return vj.VJ_add(this, vj.VJ_call(relativedelta, params));
    },
    __add__: function (other) {
        if (!vj.VJ_isInstance(other, datetime.timedelta)) {
            return vj.NotImplemented;
        }
        var s = tmxxx(this.year, this.month, this.day + other.days);
        return datetime.date.fromJSON(s.year, s.month, s.day);
    },
    __radd__: function (other) { return this.__add__(other); },
    __sub__: function (other) {
        if (vj.VJ_isInstance(other, datetime.timedelta)) {
            return vj.VJ_add(this, vj.VJ_negative(other));
        }
        if (vj.VJ_isInstance(other, datetime.date)) {
            // FIXME: getattr and sub API methods
            return vj.VJ_call(datetime.timedelta, [
                vj.VJ_subtract(
                    vj.VJ_call(vj.VJ_getAttr(this, 'toordinal')),
                    vj.VJ_call(vj.VJ_getAttr(other, 'toordinal')))
            ]);
        }
        return vj.NotImplemented;
    },
    toordinal: function () {
        return vj.float.fromJSON(ymd2ord(this.year, this.month, this.day));
    },
    weekday: function () {
        return  vj.float.fromJSON((this.toordinal().toJSON()+6)%7);
    },
    fromJSON: function (year, month, day) {
        return vj.VJ_call(datetime.date, [year, month, day]);
    },
    today: vj.classmethod.fromJSON(function () {
        var d = new Date ();
        return vj.VJ_call(datetime.date, [
            d.getFullYear(), d.getMonth() + 1, d.getDate()]);
    }),
});

datetime.time = vj.type('time', null, {
    __init__: function () {
        var zero = vj.float.fromJSON(0);
        var args = vj.VJ_parseArgs(arguments, [
            ['hour', zero], ['minute', zero], ['second', zero], ['microsecond', zero],
            ['tzinfo', vj.None]
        ]);

        for(var k in args) {
            if (!args.hasOwnProperty(k)) { continue; }
            this[k] = asJS(args[k]);
        }
    }
});

var time = vj.VJ_call(vj.object);
time.strftime = vj.VJ_def.fromJSON(function () {
    var args  = vj.VJ_parseArgs(arguments, 'format');
    var dt_class = vj.VJ_getAttr(datetime, 'datetime');
    var d = vj.VJ_call(vj.VJ_getAttr(dt_class, 'utcnow'));
    return vj.VJ_call(vj.VJ_getAttr(d, 'strftime'), [args.format]);
});

var args = _.map(('year month day hour minute second '
                + 'years months weeks days hours minutes seconds '
                + 'weekday leapdays yearday nlyearday').split(' '), function (arg) {
    switch (arg) {
        case 'years':case 'months':case 'days':case 'leapdays':case 'weeks':
        case 'hours':case 'minutes':case 'seconds':
        return [arg, zero];
    case 'year':case 'month':case 'day':case 'weekday':
    case 'hour':case 'minute':case 'second':
    case 'yearday':case 'nlyearday':
        return [arg, null];
    default:
        throw new Error("Unknown relativedelta argument " + arg);
    }
});
args.unshift('*');

var _utils = {
    monthrange: function (year, month) {
        if (month < 1 || month > 12) {
            throw new Error("Illegal month " + month);
        }

        var day1 = this.weekday(year, month, 1);
        var ndays = this.mdays[month] + (month == this.February && this.isleap(year));
        return [day1, ndays];
    },
    weekday: function (year, month, day) {
        var date = vj.VJ_call(datetime.date, [year, month, day]);
        return vj.VJ_call(vj.VJ_getAttr(date, 'weekday'));
    },
    isleap: function (year) {
        return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    },
    mdays: [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31],
    January: 1,
    February: 2
};

var relativedelta = vj.type('relativedelta', null, {
    __init__: function () {
        this.ops = vj.VJ_parseArgs(arguments, args);
        this.ops.days = vj.float.fromJSON(
            asJS(this.ops.days) + asJS(this.ops.weeks) * 7
        );

        var yday = zero;
        if (this.ops.nlyearday) {
            yday = this.ops.nlyearday;
        } else if (this.ops.yearday) {
            yday = this.ops.yearday;
            if (asJS(this.ops.yearday) > 59) {
                this.ops.leapdays = vj.float.fromJS(-1);
            }
        }
        if (vj.VJ_isTrue(yday)) {
            var ydayidx = [31, 59, 90, 120, 151, 181, 212,
                           243, 273, 304, 334, 366];
            for(var idx=0; idx<ydayidx.length; ++idx) {
                var ydays = ydayidx[idx];
                if (asJS(yday) <= ydays) {
                    this.ops.month = vj.float.fromJSON(idx+1);
                    if (!idx) {
                        this.ops.day = yday;
                    } else {
                        this.ops.day = vj.VJ_subtract(
                            yday,
                            vj.float.fromJSON(ydayidx[idx-1])
                        );
                    }
                    break;
                }
            }
            if (idx === ydayidx.length) {
                throw new Error("Invalid year day (" + asJS(yday) + ")");
            }
        }
        this._fix();
    },
    _fix: function () {
        var self = this;
        var months = asJS(this.ops.months);
        if (Math.abs(months) > 11) {
            var s = months > 0 ? 1 : -1;
            divmod(months * s, 12, function (years, months) {
                self.ops.months = vj.float.fromJSON(months*s);
                self.ops.years = vj.float.fromJSON(
                    asJS(self.ops.years) + years*s);
            });
        }
        this._has_time = 0;
    },
    __add__: function (other) {
        if (!(vj.VJ_isInstance(other, datetime.date) ||
            vj.VJ_isInstance(other, datetime.datetime))) {
            return vj.NotImplemented;
        }
        // TODO: test this whole mess
        var year = (asJS(this.ops.year) || asJS(other.year)) + asJS(this.ops.years);
        var month = asJS(this.ops.month) || asJS(other.month);
        var months;
        if (months = asJS(this.ops.months)) {
            if (Math.abs(months) < 1 || Math.abs(months) > 12) {
                throw new Error("Can only use relative months between -12 and +12");
            }
            month += months;
            if (month > 12) {
                year += 1;
                month -= 12;
            }
            if (month < 1) {
                year -= 1;
                month += 12;
            }
        }

        var day = Math.min(_utils.monthrange(year, month)[1],
                           asJS(this.ops.day) || asJS(other.day));

        var repl = {
            year: vj.float.fromJSON(year),
            month: vj.float.fromJSON(month),
            day: vj.float.fromJSON(day)
        };

        if (vj.VJ_isInstance(other, datetime.datetime)) {
            repl.hour = vj.float.fromJSON(asJS(this.ops.hour) || asJS(other.hour));
            repl.minute = vj.float.fromJSON(asJS(this.ops.minute) || asJS(other.minute));
            repl.second = vj.float.fromJSON(asJS(this.ops.second) || asJS(other.second));
        }

        var days = asJS(this.ops.days);
        if (vj.VJ_isTrue(this.ops.leapdays) && month > 2 && _utils.isleap(year)) {
            days += asJS(this.ops.leapdays);
        }

        var ret = vj.VJ_add(
            vj.VJ_call(vj.VJ_getAttr(other, 'replace'), repl),
            vj.VJ_call(datetime.timedelta, {
                days: vj.float.fromJSON(days),
                hours: vj.float.fromJSON(asJS(this.ops.hours)),
                minutes: vj.float.fromJSON(asJS(this.ops.minutes)),
                seconds: vj.float.fromJSON(asJS(this.ops.seconds))
            })
        );

        if (this.ops.weekday) {
            // FIXME: only handles numeric weekdays, not decorated
            var weekday = asJS(this.ops.weekday), nth = 1;
            var jumpdays = (Math.abs(nth) - 1) * 7;

            var ret_weekday = asJS(vj.VJ_call(vj.VJ_getAttr(ret, 'weekday')));
            if (nth > 0) {
                jumpdays += (7-ret_weekday+weekday) % 7;
            } else {
                jumpdays += (ret_weekday - weekday) % 7;
                jumpdays *= -1;
            }
            ret = vj.VJ_add(
                ret,
                vj.VJ_call(datetime.timedelta, {
                    days: vj.float.fromJSON(jumpdays)
                })
            );
        }

        return ret;
    },
    __radd__: function (other) {
        return this.__add__(other);
    },
    __rsub__: function (other) {
        return this.__neg__().__radd__(other);
    },
    __neg__: function () {
        return vj.VJ_call(relativedelta, {
            years: vj.VJ_negative(this.ops.years),
            months: vj.VJ_negative(this.ops.months),
            days: vj.VJ_negative(this.ops.days),
            leapdays: this.ops.leapdays,
            hours: vj.VJ_negative(this.ops.hours),
            minutes: vj.VJ_negative(this.ops.minutes),
            seconds: vj.VJ_negative(this.ops.seconds),
            year: this.ops.year,
            month: this.ops.month,
            day: this.ops.day,
            weekday: this.ops.weekday,
            hour: this.ops.hour,
            minute: this.ops.minute,
            second: this.ops.second
        });
    }
});

vj.extras = {
    datetime: datetime,
    time: time,
    relativedelta: relativedelta,
};

})(typeof exports === 'undefined' ? vj : exports);
