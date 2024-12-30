verp.define('web.pyUtilsTests', function(require) {
"use strict";

var Context = require('web.Context');
var vjUtils = require('web.vjUtils');
var time = require('web.time');
var testUtils = require('web.testUtils');

const r = String.raw;

QUnit.assert.checkAST = function (expr, message) {
    var ast = vjUtils._getPyJSAST(expr);
    var formattedAST = vjUtils._formatAST(ast);
    this.pushResult({
        result: expr === formattedAST,
        actual: formattedAST,
        expected: expr,
        message: message
    });
};

QUnit.module('core', function () {

    QUnit.module('vj_utils');

    QUnit.test('simple javascript expression', function(assert) {
        assert.expect(2);

        var result = vjUtils.py_eval("true and false");
        assert.strictEqual(result, false, "should properly evaluate basic expression");
        result = vjUtils.py_eval("a + b", {a: 1, b: 41});
        assert.strictEqual(result, 42, "should properly evaluate basic sum");
    });

    QUnit.test('simple arithmetic', function(assert) {
        assert.expect(3);

        var result = vjUtils.py_eval("1 + 2");
        assert.strictEqual(result, 3, "should properly evaluate sum");
        result = vjUtils.py_eval("42 % 5");
        assert.strictEqual(result, 2, "should properly evaluate modulo operator");
        result = vjUtils.py_eval("2 ** 3");
        assert.strictEqual(result, 8, "should properly evaluate power operator");
    });


    QUnit.test('not prefix', function (assert) {
        assert.expect(3);

        assert.ok(vj.eval('not false'));
        assert.ok(vj.eval('not foo', {foo: false}));
        assert.ok(vj.eval('not a in b', {a: 3, b: [1, 2, 4, 8]}));
    });


    function makeTimeCheck (assert) {
        var context = vjUtils.context();
        return function (expr, func, message) {
            // evaluate expr between two calls to new Date(), and check that
            // the result is between the transformed dates
            var d0 = new Date();
            var result = vj.eval(expr, context);
            var d1 = new Date();
            assert.ok(func(d0) <= result && result <= func(d1), message);
        };
    }

    // Port from pypy/lib_pypy/test_datetime.js
    function makeEq(assert, c2) {
        var ctx = vjUtils.context();
        var c = _.extend({ td: ctx.datetime.timedelta }, c2 || {});
        return function (a, b, message) {
            assert.ok(vj.eval(a + ' == ' + b, c), message);
        };
    }

    QUnit.test('strftime', function (assert) {
        assert.expect(3);

        var check = makeTimeCheck(assert);

        check("time.strftime('%Y')", function(d) {
            return String(d.getFullYear());
        });

        check("time.strftime('%Y')+'-01-30'", function(d) {
            return String(d.getFullYear()) + '-01-30';
        });

        check("time.strftime('%Y-%m-%d %H:%M:%S')", function(d) {
            return _.str.sprintf('%04d-%02d-%02d %02d:%02d:%02d',
                d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(),
                d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
        });
    });

    QUnit.test('contextToday', function (assert) {
        assert.expect(1);

        var check = makeTimeCheck(assert, vjUtils);

        check("contextToday().strftime('%Y-%m-%d')", function(d) {
            return String(_.str.sprintf('%04d-%02d-%02d',
                d.getFullYear(), d.getMonth() + 1, d.getDate()));
        });
    });

    QUnit.test('timedelta.test_constructor', function (assert) {
        assert.expect(16);

        var eq = makeEq(assert);

        // keyword args to constructor
        eq('td()', 'td(weeks=0, days=0, hours=0, minutes=0, seconds=0, ' +
                        'milliseconds=0, microseconds=0)');
        eq('td(1)', 'td(days=1)');
        eq('td(0, 1)', 'td(seconds=1)');
        eq('td(0, 0, 1)', 'td(microseconds=1)');
        eq('td(weeks=1)', 'td(days=7)');
        eq('td(days=1)', 'td(hours=24)');
        eq('td(hours=1)', 'td(minutes=60)');
        eq('td(minutes=1)', 'td(seconds=60)');
        eq('td(seconds=1)', 'td(milliseconds=1000)');
        eq('td(milliseconds=1)', 'td(microseconds=1000)');

        // Check float args to constructor
        eq('td(weeks=1.0/7)', 'td(days=1)');
        eq('td(days=1.0/24)', 'td(hours=1)');
        eq('td(hours=1.0/60)', 'td(minutes=1)');
        eq('td(minutes=1.0/60)', 'td(seconds=1)');
        eq('td(seconds=0.001)', 'td(milliseconds=1)');
        eq('td(milliseconds=0.001)', 'td(microseconds=1)');
    });

    QUnit.test('timedelta.test_computations', function (assert) {
        assert.expect(28);

        var c = vjUtils.context();
        var zero = vj.float.fromJSON(0);
        var eq = makeEq(assert, {
            // one week
            a: vj.VJ_call(c.datetime.timedelta, [
                vj.float.fromJSON(7)]),
            // one minute
            b: vj.VJ_call(c.datetime.timedelta, [
                zero, vj.float.fromJSON(60)]),
            // one millisecond
            c: vj.VJ_call(c.datetime.timedelta, [
                zero, zero, vj.float.fromJSON(1000)]),
        });

        eq('a+b+c', 'td(7, 60, 1000)');
        eq('a-b', 'td(6, 24*3600 - 60)');
        eq('-a', 'td(-7)');
        eq('+a', 'td(7)');
        eq('-b', 'td(-1, 24*3600 - 60)');
        eq('-c', 'td(-1, 24*3600 - 1, 999000)');
        // eq('abs(a)', 'a');
        // eq('abs(-a)', 'a');
        eq('td(6, 24*3600)', 'a');
        eq('td(0, 0, 60*1000000)', 'b');
        eq('a*10', 'td(70)');
        eq('a*10', '10*a');
        // eq('a*10L', '10*a');
        eq('b*10', 'td(0, 600)');
        eq('10*b', 'td(0, 600)');
        // eq('b*10L', 'td(0, 600)');
        eq('c*10', 'td(0, 0, 10000)');
        eq('10*c', 'td(0, 0, 10000)');
        // eq('c*10L', 'td(0, 0, 10000)');
        eq('a*-1', '-a');
        eq('b*-2', '-b-b');
        eq('c*-2', '-c+-c');
        eq('b*(60*24)', '(b*60)*24');
        eq('b*(60*24)', '(60*b)*24');
        eq('c*1000', 'td(0, 1)');
        eq('1000*c', 'td(0, 1)');
        eq('a//7', 'td(1)');
        eq('b//10', 'td(0, 6)');
        eq('c//1000', 'td(0, 0, 1)');
        eq('a//10', 'td(0, 7*24*360)');
        eq('a//3600000', 'td(0, 0, 7*24*1000)');

        // Issue #11576
        eq('td(999999999, 86399, 999999) - td(999999999, 86399, 999998)', 'td(0, 0, 1)');
        eq('td(999999999, 1, 1) - td(999999999, 1, 0)',
            'td(0, 0, 1)');
    });

    QUnit.test('timedelta.test_basic_attributes', function (assert) {
        assert.expect(3);

        var ctx = vjUtils.context();
        assert.strictEqual(vj.eval('datetime.timedelta(1, 7, 31).days', ctx), 1);
        assert.strictEqual(vj.eval('datetime.timedelta(1, 7, 31).seconds', ctx), 7);
        assert.strictEqual(vj.eval('datetime.timedelta(1, 7, 31).microseconds', ctx), 31);
    });

    QUnit.test('timedelta.test_total_seconds', function (assert) {
        assert.expect(6);

        var c = { timedelta: vjUtils.context().datetime.timedelta };
        assert.strictEqual(vj.eval('timedelta(365).total_seconds()', c), 31536000);
        assert.strictEqual(
            vj.eval('timedelta(seconds=123456.789012).total_seconds()', c),
            123456.789012);
        assert.strictEqual(
            vj.eval('timedelta(seconds=-123456.789012).total_seconds()', c),
            -123456.789012);
        assert.strictEqual(
            vj.eval('timedelta(seconds=0.123456).total_seconds()', c), 0.123456);
        assert.strictEqual(vj.eval('timedelta().total_seconds()', c), 0);
        assert.strictEqual(
            vj.eval('timedelta(seconds=1000000).total_seconds()', c), 1e6);
    });

    QUnit.test('timedelta.test_str', function (assert) {
        assert.expect(10);

        var c = { td: vjUtils.context().datetime.timedelta };

        assert.strictEqual(vj.eval('str(td(1))', c), "1 day, 0:00:00");
        assert.strictEqual(vj.eval('str(td(-1))', c), "-1 day, 0:00:00");
        assert.strictEqual(vj.eval('str(td(2))', c), "2 days, 0:00:00");
        assert.strictEqual(vj.eval('str(td(-2))', c), "-2 days, 0:00:00");

        assert.strictEqual(vj.eval('str(td(hours=12, minutes=58, seconds=59))', c),
                    "12:58:59");
        assert.strictEqual(vj.eval('str(td(hours=2, minutes=3, seconds=4))', c),
                        "2:03:04");
        assert.strictEqual(
            vj.eval('str(td(weeks=-30, hours=23, minutes=12, seconds=34))', c),
            "-210 days, 23:12:34");

        assert.strictEqual(vj.eval('str(td(milliseconds=1))', c), "0:00:00.001000");
        assert.strictEqual(vj.eval('str(td(microseconds=3))', c), "0:00:00.000003");

        assert.strictEqual(
            vj.eval('str(td(days=999999999, hours=23, minutes=59, seconds=59, microseconds=999999))', c),
            "999999999 days, 23:59:59.999999");
    });

    QUnit.test('timedelta.test_massive_normalization', function (assert) {
        assert.expect(3);

        var td = vj.VJ_call(
            vjUtils.context().datetime.timedelta,
            {microseconds: vj.float.fromJSON(-1)});
        assert.strictEqual(td.days, -1);
        assert.strictEqual(td.seconds, 24 * 3600 - 1);
        assert.strictEqual(td.microseconds, 999999);
    });

    QUnit.test('timedelta.test_bool', function (assert) {
        assert.expect(5);

        var c = { td: vjUtils.context().datetime.timedelta };
        assert.ok(vj.eval('bool(td(1))', c));
        assert.ok(vj.eval('bool(td(0, 1))', c));
        assert.ok(vj.eval('bool(td(0, 0, 1))', c));
        assert.ok(vj.eval('bool(td(microseconds=1))', c));
        assert.ok(vj.eval('bool(not td(0))', c));
    });

    QUnit.test('date.test_computations', function (assert) {
        assert.expect(31);

        var d = vjUtils.context().datetime;

        var a = d.date.fromJSON(2002, 1, 31);
        var b = d.date.fromJSON(1956, 1, 31);
        assert.strictEqual(
            vj.eval('(a - b).days', {a: a, b: b}),
            46 * 365 + 12);
        assert.strictEqual(vj.eval('(a - b).seconds', {a: a, b: b}), 0);
        assert.strictEqual(vj.eval('(a - b).microseconds', {a: a, b: b}), 0);

        var day = vj.VJ_call(d.timedelta, [vj.float.fromJSON(1)]);
        var week = vj.VJ_call(d.timedelta, [vj.float.fromJSON(7)]);
        a = d.date.fromJSON(2002, 3, 2);
        var ctx = {
            a: a,
            day: day,
            week: week,
            date: d.date
        };
        assert.ok(vj.eval('a + day == date(2002, 3, 3)', ctx));
        assert.ok(vj.eval('day + a == date(2002, 3, 3)', ctx)); // 5
        assert.ok(vj.eval('a - day == date(2002, 3, 1)', ctx));
        assert.ok(vj.eval('-day + a == date(2002, 3, 1)', ctx));
        assert.ok(vj.eval('a + week == date(2002, 3, 9)', ctx));
        assert.ok(vj.eval('a - week == date(2002, 2, 23)', ctx));
        assert.ok(vj.eval('a + 52*week == date(2003, 3, 1)', ctx)); // 10
        assert.ok(vj.eval('a - 52*week == date(2001, 3, 3)', ctx));
        assert.ok(vj.eval('(a + week) - a == week', ctx));
        assert.ok(vj.eval('(a + day) - a == day', ctx));
        assert.ok(vj.eval('(a - week) - a == -week', ctx));
        assert.ok(vj.eval('(a - day) - a == -day', ctx)); // 15
        assert.ok(vj.eval('a - (a + week) == -week', ctx));
        assert.ok(vj.eval('a - (a + day) == -day', ctx));
        assert.ok(vj.eval('a - (a - week) == week', ctx));
        assert.ok(vj.eval('a - (a - day) == day', ctx));

        assert.throws(function () {
            vj.eval('a + 1', ctx);
        }, /^Error: TypeError:/); //20
        assert.throws(function () {
            vj.eval('a - 1', ctx);
        }, /^Error: TypeError:/);
        assert.throws(function () {
            vj.eval('1 + a', ctx);
        }, /^Error: TypeError:/);
        assert.throws(function () {
            vj.eval('1 - a', ctx);
        }, /^Error: TypeError:/);

        // delta - date is senseless.
        assert.throws(function () {
            vj.eval('day - a', ctx);
        }, /^Error: TypeError:/);
        // mixing date and (delta or date) via * or // is senseless
        assert.throws(function () {
            vj.eval('day * a', ctx);
        }, /^Error: TypeError:/); // 25
        assert.throws(function () {
            vj.eval('a * day', ctx);
        }, /^Error: TypeError:/);
        assert.throws(function () {
            vj.eval('day // a', ctx);
        }, /^Error: TypeError:/);
        assert.throws(function () {
            vj.eval('a // day', ctx);
        }, /^Error: TypeError:/);
        assert.throws(function () {
            vj.eval('a * a', ctx);
        }, /^Error: TypeError:/);
        assert.throws(function () {
            vj.eval('a // a', ctx);
        }, /^Error: TypeError:/); // 30
        // date + date is senseless
        assert.throws(function () {
            vj.eval('a + a', ctx);
        }, /^Error: TypeError:/);

    });

    QUnit.test('add', function (assert) {
        assert.expect(2);
        assert.strictEqual(
            vj.eval("(datetime.datetime(2017, 4, 18, 9, 32, 15).add(hours=2, minutes=30, " +
                "seconds=10)).strftime('%Y-%m-%d %H:%M:%S')", vjUtils.context()),
            '2017-04-18 12:02:25'
        );
        assert.strictEqual(
            vj.eval("(datetime.date(2017, 4, 18).add(months=1, years=3, days=5))" +
                ".strftime('%Y-%m-%d')", vjUtils.context()),
            '2020-05-23'
        );
    });

    QUnit.test('subtract', function(assert) {
        assert.expect(2);
        assert.strictEqual(
            vj.eval("(datetime.datetime(2017, 4, 18, 9, 32, 15).subtract(hours=1, minutes=5, " +
                "seconds=33)).strftime('%Y-%m-%d %H:%M:%S')", vjUtils.context()),
            '2017-04-18 08:26:42'
        );
        assert.strictEqual(
            vj.eval("(datetime.date(2017, 4, 18).subtract(years=5, months=1, days=1))" +
                ".strftime('%Y-%m-%d')", vjUtils.context()),
            '2012-03-17'
        );
    })

    QUnit.test('start_of/end_of', function (assert) {
        assert.expect(26);

        var datetime = vjUtils.context().datetime;
        // Ain't that a kick in the head?
        var _date = datetime.date.fromJSON(2281, 10, 11);
        var _datetime = datetime.datetime.fromJSON(2281, 10, 11, 22, 33, 44);
        var ctx = {
            _date: _date,
            _datetime: _datetime,
            date: datetime.date,
            datetime: datetime.datetime
        };

        // Start of period
        // Dates first
        assert.ok(vj.eval('_date.start_of("year") == date(2281, 1, 1)', ctx));
        assert.ok(vj.eval('_date.start_of("quarter") == date(2281, 10, 1)', ctx));
        assert.ok(vj.eval('_date.start_of("month") == date(2281, 10, 1)', ctx));
        assert.ok(vj.eval('_date.start_of("week") == date(2281, 10, 10)', ctx));
        assert.ok(vj.eval('_date.start_of("day") == date(2281, 10, 11)', ctx));
        assert.throws(function () {
            vj.eval('_date.start_of("hour")', ctx);
        }, /^Error: ValueError:/);

        // Datetimes
        assert.ok(vj.eval('_datetime.start_of("year") == datetime(2281, 1, 1)', ctx));
        assert.ok(vj.eval('_datetime.start_of("quarter") == datetime(2281, 10, 1)', ctx));
        assert.ok(vj.eval('_datetime.start_of("month") == datetime(2281, 10, 1)', ctx));
        assert.ok(vj.eval('_datetime.start_of("week") == datetime(2281, 10, 10)', ctx));
        assert.ok(vj.eval('_datetime.start_of("day") == datetime(2281, 10, 11)', ctx));
        assert.ok(vj.eval('_datetime.start_of("hour") == datetime(2281, 10, 11, 22, 0, 0)', ctx));
        assert.throws(function () {
            vj.eval('_datetime.start_of("cheese")', ctx);
        }, /^Error: ValueError:/);

        // End of period
        // Dates
        assert.ok(vj.eval('_date.end_of("year") == date(2281, 12, 31)', ctx));
        assert.ok(vj.eval('_date.end_of("quarter") == date(2281, 12, 31)', ctx));
        assert.ok(vj.eval('_date.end_of("month") == date(2281, 10, 31)', ctx));
        assert.ok(vj.eval('_date.end_of("week") == date(2281, 10, 16)', ctx));
        assert.ok(vj.eval('_date.end_of("day") == date(2281, 10, 11)', ctx));
        assert.throws(function () {
            vj.eval('_date.start_of("hour")', ctx);
        }, /^Error: ValueError:/);

        // Datetimes
        assert.ok(vj.eval('_datetime.end_of("year") == datetime(2281, 12, 31, 23, 59, 59)', ctx));
        assert.ok(vj.eval('_datetime.end_of("quarter") == datetime(2281, 12, 31, 23, 59, 59)', ctx));
        assert.ok(vj.eval('_datetime.end_of("month") == datetime(2281, 10, 31, 23, 59, 59)', ctx));
        assert.ok(vj.eval('_datetime.end_of("week") == datetime(2281, 10, 16, 23, 59, 59)', ctx));
        assert.ok(vj.eval('_datetime.end_of("day") == datetime(2281, 10, 11, 23, 59, 59)', ctx));
        assert.ok(vj.eval('_datetime.end_of("hour") == datetime(2281, 10, 11, 22, 59, 59)', ctx));
        assert.throws(function () {
            vj.eval('_datetime.end_of("cheese")', ctx);
        }, /^Error: ValueError:/);
    });

    QUnit.test('relativedelta', function (assert) {
        assert.expect(7);

        assert.strictEqual(
            vj.eval("(datetime.date(2012, 2, 15) + relativedelta(days=-1)).strftime('%Y-%m-%d 23:59:59')",
                    vjUtils.context()),
            "2012-02-14 23:59:59");
        assert.strictEqual(
            vj.eval("(datetime.date(2012, 2, 15) + relativedelta(days=1)).strftime('%Y-%m-%d')",
                    vjUtils.context()),
            "2012-02-16");
        assert.strictEqual(
            vj.eval("(datetime.date(2012, 2, 15) + relativedelta(days=-1)).strftime('%Y-%m-%d')",
                    vjUtils.context()),
            "2012-02-14");
        assert.strictEqual(
            vj.eval("(datetime.date(2012, 2, 1) + relativedelta(days=-1)).strftime('%Y-%m-%d')",
                    vjUtils.context()),
            '2012-01-31');
        assert.strictEqual(
            vj.eval("(datetime.date(2015,2,5)+relativedelta(days=-6,weekday=0)).strftime('%Y-%m-%d')",
                    vjUtils.context()),
            '2015-02-02');
        assert.strictEqual(
            vj.eval("(datetime.date(2018, 2, 1) + relativedelta(years=7, months=42, days=42)).strftime('%Y-%m-%d')",
                    vjUtils.context()),
            '2028-09-12');
        assert.strictEqual(
            vj.eval("(datetime.date(2018, 2, 1) + relativedelta(years=-7, months=-42, days=-42)).strftime('%Y-%m-%d')",
                    vjUtils.context()),
            '2007-06-20');
    });


    QUnit.test('timedelta', function (assert) {
        assert.expect(4);
        assert.strictEqual(
            vj.eval("(datetime.datetime(2017, 2, 15, 1, 7, 31) + datetime.timedelta(days=1)).strftime('%Y-%m-%d %H:%M:%S')",
                    vjUtils.context()),
            "2017-02-16 01:07:31");
        assert.strictEqual(
            vj.eval("(datetime.datetime(2012, 2, 15, 1, 7, 31) - datetime.timedelta(hours=1)).strftime('%Y-%m-%d %H:%M:%S')",
                    vjUtils.context()),
            "2012-02-15 00:07:31");
        assert.strictEqual(
            vj.eval("(datetime.datetime(2012, 2, 15, 1, 7, 31) + datetime.timedelta(hours=-1)).strftime('%Y-%m-%d %H:%M:%S')",
                    vjUtils.context()),
            "2012-02-15 00:07:31");
        assert.strictEqual(
            vj.eval("(datetime.datetime(2012, 2, 15, 1, 7, 31) + datetime.timedelta(minutes=100)).strftime('%Y-%m-%d %H:%M:%S')",
                    vjUtils.context()),
            "2012-02-15 02:47:31");
    });

    QUnit.test('datetime.tojson', function (assert) {
        assert.expect(7);

        var result = vj.eval(
            'datetime.datetime(2012, 2, 15, 1, 7, 31)',
            vjUtils.context());

        assert.ok(result instanceof Date);
        assert.strictEqual(result.getFullYear(), 2012);
        assert.strictEqual(result.getMonth(), 1);
        assert.strictEqual(result.getDate(), 15);
        assert.strictEqual(result.getHours(), 1);
        assert.strictEqual(result.getMinutes(), 7);
        assert.strictEqual(result.getSeconds(), 31);
    });


    QUnit.test('to_utc in october with winter/summer change', function (assert) {
        assert.expect(7);

        const originalGetTimezoneOffset = Date.prototype.getTimezoneOffset;
        Date.prototype.getTimezoneOffset = function () {
            const month = this.getMonth() // starts at 0;
            if (10 <= month || month <= 2) {
                //rough approximation
                return -60;
            } else {
                return -120;
            }
        }

        var result = vj.eval(
            "datetime.datetime(2022, 10, 17).to_utc()",
            vjUtils.context());

        assert.ok(result instanceof Date);
        assert.strictEqual(result.getFullYear(), 2022);
        assert.strictEqual(result.getMonth(), 9);
        assert.strictEqual(result.getDate(), 16);
        assert.strictEqual(result.getHours(), 22);
        assert.strictEqual(result.getMinutes(), 0);
        assert.strictEqual(result.getSeconds(), 0);

        Date.prototype.getTimezoneOffset = originalGetTimezoneOffset;
    });

    QUnit.test('datetime.combine', function (assert) {
        assert.expect(2);

        var result = vj.eval(
            'datetime.datetime.combine(datetime.date(2012, 2, 15),' +
            '                          datetime.time(1, 7, 13))' +
            '   .strftime("%Y-%m-%d %H:%M:%S")',
            vjUtils.context());
        assert.strictEqual(result, "2012-02-15 01:07:13");

        result = vj.eval(
            'datetime.datetime.combine(datetime.date(2012, 2, 15),' +
            '                          datetime.time())' +
            '   .strftime("%Y-%m-%d %H:%M:%S")',
            vjUtils.context());
        assert.strictEqual(result, '2012-02-15 00:00:00');
    });

    QUnit.test('datetime.replace', function (assert) {
        assert.expect(1);

        var result = vj.eval(
            'datetime.datetime(2012, 2, 15, 1, 7, 13)' +
            '   .replace(hour=0, minute=0, second=0)' +
            '   .strftime("%Y-%m-%d %H:%M:%S")',
            vjUtils.context());
        assert.strictEqual(result, "2012-02-15 00:00:00");
    });

    QUnit.test('conditional expressions', function (assert) {
        assert.expect(2);
        assert.strictEqual(
            vj.eval('1 if a else 2', {a: true}),
            1
        );
        assert.strictEqual(
            vj.eval('1 if a else 2', {a: false}),
            2
        );
    });

    QUnit.module('vj_utils (eval domain contexts)', {
        beforeEach: function() {
            this.userContext = {
                uid: 1,
                lang: 'en_US',
                tz: false,
            };
        },
    });


    QUnit.test('empty, basic', function (assert) {
        assert.expect(3);

        var result = vjUtils.eval_domains_and_contexts({
            contexts: [this.userContext],
            domains: [],
        });

        // default values for new db
        assert.deepEqual(result.context, {
            lang: 'en_US',
            tz: false,
            uid: 1
        });
        assert.deepEqual(result.domain, []);
        assert.deepEqual(result.groupby, []);
    });


    QUnit.test('context_merge_00', function (assert) {
        assert.expect(1);

        var ctx = [
            {
                "__contexts": [
                    { "lang": "en_US", "tz": false, "uid": 1 },
                    {
                        "activeId": 8,
                        "activeIds": [ 8 ],
                        "activeModel": "sale.order",
                        "bin_raw": true,
                        "default_composition_mode": "comment",
                        "default_model": "sale.order",
                        "default_resId": 8,
                        "default_template_id": 18,
                        "default_use_template": true,
                        "edi_web_url_view": "faaaake",
                        "lang": "en_US",
                        "mark_so_as_sent": null,
                        "show_address": null,
                        "tz": false,
                        "uid": null
                    },
                    {}
                ],
                "__evalContext": null,
                "__ref": "compoundContext"
            },
            { "activeId": 9, "activeIds": [ 9 ], "activeModel": "mail.compose.message" }
        ];
        var result = vjUtils.eval_domains_and_contexts({
            contexts: ctx,
            domins: [],
        });

        assert.deepEqual(result.context, {
            activeId: 9,
            activeIds: [9],
            activeModel: 'mail.compose.message',
            bin_raw: true,
            default_composition_mode: 'comment',
            default_model: 'sale.order',
            default_resId: 8,
            default_template_id: 18,
            default_use_template: true,
            edi_web_url_view: "faaaake",
            lang: 'en_US',
            mark_so_as_sent: null,
            show_address: null,
            tz: false,
            uid: null
        });

    });

    QUnit.test('context_merge_01', function (assert) {
        assert.expect(1);

        var ctx = [{
            "__contexts": [
                {
                    "lang": "en_US",
                    "tz": false,
                    "uid": 1
                },
                {
                    "default_attachment_ids": [],
                    "default_body": "",
                    "default_model": "res.users",
                    "default_parent_id": false,
                    "default_resId": 1
                },
                {}
            ],
            "__evalContext": null,
            "__ref": "compoundContext"
        }];
        var result = vjUtils.eval_domains_and_contexts({
            contexts: ctx,
            domains: [],
        });

        assert.deepEqual(result.context, {
            "default_attachment_ids": [],
            "default_body": "",
            "default_model": "res.users",
            "default_parent_id": false,
            "default_resId": 1,
            "lang": "en_US",
            "tz": false,
            "uid": 1
        });
    });

    QUnit.test('domain with time', function (assert) {
        assert.expect(1);

        var result = vjUtils.eval_domains_and_contexts({
            domains: [
                [['type', '=', 'contract']],
                ["|", ["state", "in", ["open", "draft"]], [["type", "=", "contract"], ["state", "=", "pending"]]],
                "['|', '&', ('date', '!=', false), ('date', '<=', time.strftime('%Y-%m-%d')), ('is_overdue_quantity', '=', true)]",
                [['userId', '=', 1]]
            ],
            contexts: [],
        });

        var d = new Date();
        var today = _.str.sprintf("%04d-%02d-%02d",
                d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
        assert.deepEqual(result.domain, [
            ["type", "=", "contract"],
            "|", ["state", "in", ["open", "draft"]],
                 [["type", "=", "contract"],
                  ["state", "=", "pending"]],
            "|",
                "&", ["date", "!=", false],
                        ["date", "<=", today],
                ["is_overdue_quantity", "=", true],
            ["userId", "=", 1]
        ]);
    });

    QUnit.test('conditional context', function (assert) {
        assert.expect(2);

        var d = {
            __ref: 'domain',
            __debug: "[('companyId', '=', context.get('companyId',false))]"
        };

        var result1 = vjUtils.eval_domains_and_contexts({
            domains: [d],
            contexts: [],
        });
        assert.deepEqual(result1.domain, [['companyId', '=', false]]);

        var result2 = vjUtils.eval_domains_and_contexts({
            domains: [d],
            contexts: [],
            eval_context: {companyId: 42},
        });
        assert.deepEqual(result2.domain, [['companyId', '=', 42]]);
    });

    QUnit.test('substitution in context', function (assert) {
        assert.expect(1);

        // setup(session);
        var c = "{'default_opportunity_id': activeId, 'default_duration': 1.0, 'lng': lang}";
        var cc = new Context(c);
        cc.setEvalContext({activeId: 42});
        var result = vjUtils.eval_domains_and_contexts({
            domains:[], contexts: [this.userContext, cc]
        });

        assert.deepEqual(result.context, {
            lang: "en_US",
            tz: false,
            uid: 1,
            default_opportunity_id: 42,
            default_duration: 1.0,
            lng: "en_US"
        });
    });

    QUnit.test('date', function (assert) {
        assert.expect(1);

        var d = "[('state','!=','cancel'),('opening_date','>',contextToday().strftime('%Y-%m-%d'))]";
        var result = vjUtils.eval_domains_and_contexts({
            domains: [d],
            contexts: [],
        });

        var date = new Date();
        var today = _.str.sprintf("%04d-%02d-%02d",
            date.getFullYear(), date.getMonth() + 1, date.getDate());
        assert.deepEqual(result.domain, [
            ['state', '!=', 'cancel'],
            ['opening_date', '>', today]
        ]);
    });

    QUnit.test('delta', function (assert) {
        assert.expect(1);

        var d = "[('type','=','in'),('day','<=', time.strftime('%Y-%m-%d')),('day','>',(contextToday()-datetime.timedelta(days=15)).strftime('%Y-%m-%d'))]";
        var result = vjUtils.eval_domains_and_contexts({
            domains: [d],
            contexts: [],
        });
        var date = new Date();
        var today = _.str.sprintf("%04d-%02d-%02d",
            date.getFullYear(), date.getMonth() + 1, date.getDate());
        date.setDate(date.getDate() - 15);
        var ago_15_d = _.str.sprintf("%04d-%02d-%02d",
            date.getFullYear(), date.getMonth() + 1, date.getDate());
        assert.deepEqual(result.domain, [
            ['type', '=', 'in'],
            ['day', '<=', today],
            ['day', '>', ago_15_d]
        ]);
    });

    QUnit.test('horror from the deep', function (assert) {
        assert.expect(1);

        var cs = [
            {"__ref": "compoundContext",
                "__contexts": [
                    {"__ref": "context", "__debug": "{'k': 'foo,' + str(context.get('test_key', false))}"},
                    {"__ref": "compoundContext",
                        "__contexts": [
                            {"lang": "en_US", "tz": false, "uid": 1},
                            {"lang": "en_US", "tz": false, "uid": 1,
                                "activeModel": "sale.order", "default_type": "out",
                                "show_address": 1, "contact_display": "partner_address",
                                "activeIds": [9], "activeId": 9},
                            {}
                        ], "__evalContext": null },
                    {"activeId": 8, "activeIds": [8],
                        "activeModel": "stock.picking.out"},
                    {"__ref": "context", "__debug": "{'default_ref': 'stock.picking.out,'+str(context.get('activeId', false))}", "__id": "54d6ad1d6c45"}
                ], "__evalContext": null}
        ];
        var result = vjUtils.eval_domains_and_contexts({
            domains: [],
            contexts: cs,
        });

        assert.deepEqual(result.context, {
            k: 'foo,false',
            lang: 'en_US',
            tz: false,
            uid: 1,
            activeModel: 'stock.picking.out',
            activeId: 8,
            activeIds: [8],
            default_type: 'out',
            show_address: 1,
            contact_display: 'partner_address',
            default_ref: 'stock.picking.out,8'
        });
    });

    QUnit.module('vj_utils (contexts)');

    QUnit.test('context_recursive', function (assert) {
        assert.expect(3);

        var context_to_eval = [{
            __ref: 'context',
            __debug: '{"foo": context.get("bar", "qux")}'
        }];
        assert.deepEqual(
            vjUtils.eval('contexts', context_to_eval, {bar: "ok"}),
            {foo: 'ok'});
        assert.deepEqual(
            vjUtils.eval('contexts', context_to_eval, {bar: false}),
            {foo: false});
        assert.deepEqual(
            vjUtils.eval('contexts', context_to_eval),
            {foo: 'qux'});
    });

    QUnit.test('context_sequences', function (assert) {
        assert.expect(1);

        // Context n should have base evaluation context + all of contexts
        // 0..n-1 in its own evaluation context
        var activeId = 4;
        var result = vjUtils.eval('contexts', [
            {
                "__contexts": [
                    {
                        "departmentId": false,
                        "lang": "en_US",
                        "project_id": false,
                        "section_id": false,
                        "tz": false,
                        "uid": 1
                    },
                    { "search_default_create_uid": 1 },
                    {}
                ],
                "__evalContext": null,
                "__ref": "compoundContext"
            },
            {
                "activeId": activeId,
                "activeIds": [ activeId ],
                "activeModel": "purchase.requisition"
            },
            {
                "__debug": "{'record_id' : activeId}",
                "__id": "63e8e9bff8a6",
                "__ref": "context"
            }
        ]);

        assert.deepEqual(result, {
            departmentId: false,
            lang: 'en_US',
            project_id: false,
            section_id: false,
            tz: false,
            uid: 1,
            search_default_create_uid: 1,
            activeId: activeId,
            activeIds: [activeId],
            activeModel: 'purchase.requisition',
            record_id: activeId
        });
    });

    QUnit.test('non-literal_eval_contexts', function (assert) {
        assert.expect(1);

        var result = vjUtils.eval('contexts', [{
            "__ref": "compoundContext",
            "__contexts": [
                {"__ref": "context", "__debug": "{'moveType':parent.moveType}",
                    "__id": "462b9dbed42f"}
            ],
            "__evalContext": {
                "__ref": "compoundContext",
                "__contexts": [{
                        "__ref": "compoundContext",
                        "__contexts": [
                            {"__ref": "context", "__debug": "{'moveType': moveType}",
                                "__id": "16a04ed5a194"}
                        ],
                        "__evalContext": {
                            "__ref": "compoundContext",
                            "__contexts": [
                                {"lang": "en_US", "tz": false, "uid": 1,
                                    "journalType": "sale", "section_id": false,
                                    "default_moveType": "outInvoice",
                                    "moveType": "outInvoice", "departmentId": false},
                                {"id": false, "journalId": 10,
                                    "number": false, "moveType": "outInvoice",
                                    "currencyId": 1, "partnerId": 4,
                                    "fiscalPositionId": false,
                                    "invoice_date": false, "date": false,
                                    "paymentTermId": false,
                                    "reference": false, "accountId": 440,
                                    "name": false, "invoiceLineIds": [],
                                    "tax_line_ids": [], "amountUntaxed": 0,
                                    "amountTax": 0, "reconciled": false,
                                    "amountTotal": 0, "state": "draft",
                                    "amount_residual": 0, "companyId": 1,
                                    "date_due": false, "userId": 1,
                                    "partner_bank_id": false, "origin": false,
                                    "moveId": false, "comment": false,
                                    "paymentIds": [[6, false, []]],
                                    "activeId": false, "activeIds": [],
                                    "activeModel": "account.move",
                                    "parent": {}}
                    ], "__evalContext": null}
                }, {
                    "id": false,
                    "productId": 4,
                    "name": "[PC1] Basic PC",
                    "quantity": 1,
                    "uomId": 1,
                    "priceUnit": 100,
                    "accountId": 853,
                    "discount": 0,
                    "account_analytic_id": false,
                    "companyId": false,
                    "note": false,
                    "invoice_line_tax_ids": [[6, false, [1]]],
                    "activeId": false,
                    "activeIds": [],
                    "activeModel": "account.move.line",
                    "parent": {
                        "id": false, "journalId": 10, "number": false,
                        "moveType": "outInvoice", "currencyId": 1,
                        "partnerId": 4, "fiscalPositionId": false,
                        "invoice_date": false, "date": false,
                        "paymentTermId": false,
                        "reference": false, "accountId": 440, "name": false,
                        "tax_line_ids": [], "amountUntaxed": 0, "amountTax": 0,
                        "reconciled": false, "amountTotal": 0,
                        "state": "draft", "amount_residual": 0, "companyId": 1,
                        "date_due": false, "userId": 1,
                        "partner_bank_id": false, "origin": false,
                        "moveId": false, "comment": false,
                        "paymentIds": [[6, false, []]]}
                }],
                "__evalContext": null
            }
        }]);

        assert.deepEqual(result, {moveType: 'outInvoice'});
    });

    QUnit.test('return-input-value', function (assert) {
        assert.expect(1);

        var result = vjUtils.eval('contexts', [{
            __ref: 'compoundContext',
            __contexts: ["{'lineId': lineId , 'journalId': journalId }"],
            __evalContext: {
                __ref: 'compoundContext',
                __contexts: [{
                    __ref: 'compoundContext',
                    __contexts: [
                        {lang: 'en_US', tz: 'Europe/Paris', uid: 1},
                        {lang: 'en_US', tz: 'Europe/Paris', uid: 1},
                        {}
                    ],
                    __evalContext: null,
                }, {
                    activeId: false,
                    activeIds: [],
                    activeModel: 'account.move',
                    amount: 0,
                    companyId: 1,
                    id: false,
                    journalId: 14,
                    lineId: [
                        [0, false, {
                            accountId: 55,
                            amount_currency: 0,
                            analyticAccountId: false,
                            credit: 0,
                            currencyId: false,
                            date_maturity: false,
                            debit: 0,
                            name: "dscsd",
                            partnerId: false,
                            tax_line_id: false,
                        }]
                    ],
                    name: '/',
                    narration: false,
                    parent: {},
                    partnerId: false,
                    date: '2011-01-1',
                    ref: false,
                    state: 'draft',
                    to_check: false,
                }],
                __evalContext: null,
            },
        }]);
        assert.deepEqual(result, {
            journalId: 14,
            lineId: [[0, false, {
                accountId: 55,
                amount_currency: 0,
                analyticAccountId: false,
                credit: 0,
                currencyId: false,
                date_maturity: false,
                debit: 0,
                name: "dscsd",
                partnerId: false,
                tax_line_id: false,
            }]],
        });
    });

    QUnit.module('vj_utils (domains)');

    QUnit.test('current_date', function (assert) {
        assert.expect(1);

        var current_date = time.dateToStr(new Date());
        var result = vjUtils.eval('domains',
            [[],{"__ref":"domain","__debug":"[('label','>=',current_date),('label','<=',current_date)]","__id":"5dedcfc96648"}],
            vjUtils.context());
        assert.deepEqual(result, [
            ['label', '>=', current_date],
            ['label', '<=', current_date]
        ]);
    });

    QUnit.test('context_freevar', function (assert) {
        assert.expect(3);

        var domains_to_eval = [{
            __ref: 'domain',
            __debug: '[("foo", "=", context.get("bar", "qux"))]'
        }, [['bar', '>=', 42]]];
        assert.deepEqual(
            vjUtils.eval('domains', domains_to_eval, {bar: "ok"}),
            [['foo', '=', 'ok'], ['bar', '>=', 42]]);
        assert.deepEqual(
            vjUtils.eval('domains', domains_to_eval, {bar: false}),
            [['foo', '=', false], ['bar', '>=', 42]]);
        assert.deepEqual(
            vjUtils.eval('domains', domains_to_eval),
            [['foo', '=', 'qux'], ['bar', '>=', 42]]);
    });

    QUnit.module('vj_utils (groupbys)');

    QUnit.test('groupbys_00', function (assert) {
        assert.expect(1);

        var result = vjUtils.eval('groupbys', [
            {groupby: 'foo'},
            {groupby: ['bar', 'qux']},
            {groupby: null},
            {groupby: 'grault'}
        ]);
        assert.deepEqual(result, ['foo', 'bar', 'qux', 'grault']);
    });

    QUnit.test('groupbys_01', function (assert) {
        assert.expect(1);

        var result = vjUtils.eval('groupbys', [
            {groupby: 'foo'},
            { __ref: 'context', __debug: '{"groupby": "bar"}' },
            {groupby: 'grault'}
        ]);
        assert.deepEqual(result, ['foo', 'bar', 'grault']);
    });

    QUnit.test('groupbys_02', function (assert) {
        assert.expect(1);

        var result = vjUtils.eval('groupbys', [
            {groupby: 'foo'},
            {
                __ref: 'compoundContext',
                __contexts: [ {groupby: 'bar'} ],
                __evalContext: null
            },
            {groupby: 'grault'}
        ]);
        assert.deepEqual(result, ['foo', 'bar', 'grault']);
    });

    QUnit.test('groupbys_03', function (assert) {
        assert.expect(1);

        var result = vjUtils.eval('groupbys', [
            {groupby: 'foo'},
            {
                __ref: 'compoundContext',
                __contexts: [
                    { __ref: 'context', __debug: '{"groupby": value}' }
                ],
                __evalContext: { value: 'bar' }
            },
            {groupby: 'grault'}
        ]);
        assert.deepEqual(result, ['foo', 'bar', 'grault']);
    });

    QUnit.test('groupbys_04', function (assert) {
        assert.expect(1);

        var result = vjUtils.eval('groupbys', [
            {groupby: 'foo'},
            {
                __ref: 'compoundContext',
                __contexts: [
                    { __ref: 'context', __debug: '{"groupby": value}' }
                ],
                __evalContext: { value: 'bar' }
            },
            {groupby: 'grault'}
        ], { value: 'bar' });
        assert.deepEqual(result, ['foo', 'bar', 'grault']);
    });

    QUnit.test('groupbys_05', function (assert) {
        assert.expect(1);

        var result = vjUtils.eval('groupbys', [
            {groupby: 'foo'},
            { __ref: 'context', __debug: '{"groupby": value}' },
            {groupby: 'grault'}
        ], { value: 'bar' });
        assert.deepEqual(result, ['foo', 'bar', 'grault']);
    });

    QUnit.module('pyutils (_formatAST)');

    QUnit.test("basic values", function (assert) {
        assert.expect(6);

        assert.checkAST("1", "integer value");
        assert.checkAST("1.4", "float value");
        assert.checkAST("-12", "negative integer value");
        assert.checkAST("true", "boolean");
        assert.checkAST(`"some string"`, "a string");
        assert.checkAST("None", "None");
    });

    QUnit.test("dictionary", function (assert) {
        assert.expect(3);

        assert.checkAST("{}", "empty dictionary");
        assert.checkAST(`{"a": 1}`, "dictionary with a single key");
        assert.checkAST(`d["a"]`, "get a value in a dictionary");
    });

    QUnit.test("list", function (assert) {
        assert.expect(2);

        assert.checkAST("[]", "empty list");
        assert.checkAST("[1]", "list with one value");
    });

    QUnit.test("tuple", function (assert) {
        assert.expect(2);

        assert.checkAST("()", "empty tuple");
        assert.checkAST("(1, 2)", "basic tuple");
    });

    QUnit.test("simple arithmetic", function (assert) {
        assert.expect(15);

        assert.checkAST("1 + 2", "addition");
        assert.checkAST("+(1 + 2)", "other addition, prefix");
        assert.checkAST("1 - 2", "substraction");
        assert.checkAST("-1 - 2", "other substraction");
        assert.checkAST("-(1 + 2)", "other substraction");
        assert.checkAST("1 + 2 + 3", "addition of 3 integers");
        assert.checkAST("a + b", "addition of two variables");
        assert.checkAST("42 % 5", "modulo operator");
        assert.checkAST("a * 10", "multiplication");
        assert.checkAST("a ** 10", "**");
        assert.checkAST("~10", "bitwise not");
        assert.checkAST("~(10 + 3)", "bitwise not");
        assert.checkAST("a * (1 + 2)", "multiplication and addition");
        assert.checkAST("(a + b) * 43", "addition and multiplication");
        assert.checkAST("a // 10", "integer division");
    });

    QUnit.test("boolean operators", function (assert) {
        assert.expect(6);

        assert.checkAST("true and false", "boolean operator");
        assert.checkAST("true or false", "boolean operator or");
        assert.checkAST("(true or false) and false", "boolean operators and and or");
        assert.checkAST("not false", "not prefix");
        assert.checkAST("not foo", "not prefix with variable");
        assert.checkAST("not a in b", "not prefix with expression");
    });

    QUnit.test("conditional expression", function (assert) {
        assert.expect(2);

        assert.checkAST("1 if a else 2");
        assert.checkAST("[] if a else 2");
    });

    QUnit.test("other operators", function (assert) {
        assert.expect(7);

        assert.checkAST("x == y", "== operator");
        assert.checkAST("x != y", "!= operator");
        assert.checkAST("x < y", "< operator");
        assert.checkAST("x is y", "is operator");
        assert.checkAST("x is not y", "is and not operator");
        assert.checkAST("x in y", "in operator");
        assert.checkAST("x not in y", "not in operator");
    });

    QUnit.test("equality", function (assert) {
        assert.expect(1);
        assert.checkAST("a == b", "simple equality");
    });

    QUnit.test("strftime", function (assert) {
        assert.expect(3);
        assert.checkAST(`time.strftime("%Y")`, "strftime with year");
        assert.checkAST(`time.strftime("%Y") + "-01-30"`, "strftime with year");
        assert.checkAST(`time.strftime("%Y-%m-%d %H:%M:%S")`, "strftime with year");
    });

    QUnit.test("contextToday", function (assert) {
        assert.expect(1);
        assert.checkAST(`contextToday().strftime("%Y-%m-%d")`, "context today call");
    });


    QUnit.test("function call", function (assert) {
        assert.expect(5);
        assert.checkAST("td()", "simple call");
        assert.checkAST("td(a, b, c)", "simple call with args");
        assert.checkAST('td(days = 1)', "simple call with kwargs");
        assert.checkAST('f(1, 2, days = 1)', "mixing args and kwargs");
        assert.checkAST('str(td(2))', "function call in function call");
    });

    QUnit.test("various expressions", function (assert) {
        assert.expect(3);
        assert.checkAST('(a - b).days', "substraction and .days");
        assert.checkAST('a + day == date(2002, 3, 3)');

        var expr = `[("type", "=", "in"), ("day", "<=", time.strftime("%Y-%m-%d")), ("day", ">", (contextToday() - datetime.timedelta(days = 15)).strftime("%Y-%m-%d"))]`;
        assert.checkAST(expr);
    });

    QUnit.test('escaping support', function (assert) {
        assert.expect(4);
        assert.strictEqual(vj.eval(r`"\x61"`), "a", "hex escapes");
        assert.strictEqual(vj.eval(r`"\\abc"`), r`\abc`, "escaped backslash");
        assert.checkAST(r`"\\abc"`, "escaped backslash AST check");

        const {_getPyJSAST, _formatAST} = vjUtils;
        const a = r`'foo\\abc"\''`;
        const b = _formatAST(_getPyJSAST(_formatAST(_getPyJSAST(a))));
        // Our repr uses JSON.stringify which always uses double quotes,
        // whereas Javascript's repr is single-quote-biased: strings are repr'd
        // using single quote delimiters *unless* they contain single quotes and
        // no double quotes, then they're delimited with double quotes.
        assert.strictEqual(b, r`"foo\\abc\"'"`);
    });

    QUnit.module('pyutils (_normalizeDomain)');

    QUnit.assert.checkNormalization = function (domain, normalizedDomain) {
        normalizedDomain = normalizedDomain || domain;
        var result = vjUtils.normalizeDomain(domain);
        this.pushResult({
            result: result === normalizedDomain,
            actual: result,
            expected: normalizedDomain
        });
    };


    QUnit.test("return simple (normalized) domains", function (assert) {
        assert.expect(3);

        assert.checkNormalization("[]");
        assert.checkNormalization(`[("a", "=", 1)]`);
        assert.checkNormalization(`["!", ("a", "=", 1)]`);
    });

    QUnit.test("properly add the & in a non normalized domain", function (assert) {
        assert.expect(1);
        assert.checkNormalization(
            `[("a", "=", 1), ("b", "=", 2)]`,
            `["&", ("a", "=", 1), ("b", "=", 2)]`
        );
    });

    QUnit.test("normalize domain with ! operator", function (assert) {
        assert.expect(1);
        assert.checkNormalization(
            `["!", ("a", "=", 1), ("b", "=", 2)]`,
            `["&", "!", ("a", "=", 1), ("b", "=", 2)]`
        );
    });

    QUnit.module('pyutils (assembleDomains)');

    QUnit.assert.checkAssemble = function (domains, operator, domain) {
        domain = vjUtils.normalizeDomain(domain);
        var result = vjUtils.assembleDomains(domains, operator);
        this.pushResult({
            result: result === domain,
            actual: result,
            expected: domain
        });
    };

    QUnit.test("assemble domains", function (assert) {
        assert.expect(7);

        assert.checkAssemble([], '&', "[]");
        assert.checkAssemble(["[('a', '=', 1)]"], null, "[('a', '=', 1)]");
        assert.checkAssemble(
            ["[('a', '=', '1'), ('b', '!=', 2)]"],
            'AND',
            "['&',('a', '=', '1'), ('b', '!=', 2)]"
        );
        assert.checkAssemble(
            ["[('a', '=', '1')]", "[]"],
            'AND',
            "[('a', '=', '1')]"
        );
        assert.checkAssemble(
            ["[('a', '=', '1')]", "[('b', '<=', 3)]"],
            'AND',
            "['&',('a', '=', '1'),('b','<=', 3)]"
        );
        assert.checkAssemble(
            ["[('a', '=', '1'), ('c', 'in', [4, 5])]", "[('b', '<=', 3)]"],
            'OR',
            "['|', '&',('a', '=', '1'),('c', 'in', [4, 5]),('b','<=', 3)]"
        );
        assert.checkAssemble(
            ["[('userId', '=', uid)]"],
            null,
            "[('userId', '=', uid)]"
        );
    });
});
});
