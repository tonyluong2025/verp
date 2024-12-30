verp.define('web.time', function (require) {
"use strict";

var translation = require('web.translation');
var utils = require('web.utils');

var lpad = utils.lpad;
var rpad = utils.rpad;
var _t = translation._t;

/**
 * Replacer function for JSON.stringify, serializes Date objects to UTC
 * datetime in the VERP Server format.
 *
 * However, if a serialized value has a toJSON method that method is called
 * *before* the replacer is invoked. Date#toJSON exists, and thus the value
 * passed to the replacer is a string, the original Date has to be fetched
 * on the parent object (which is provided as the replacer's context).
 *
 * @param {String} k
 * @param {Object} v
 * @returns {Object}
 */
function dateToUtc (k, v) {
    var value = this[k];
    if (!(value instanceof Date)) { return v; }

    return datetimeToStr(value);
}

/**
 * Converts a string to a Date javascript object using ISO's
 * datetime string format (example: '2011-12-01T15:12:35.832Z').
 * 
 * The time zone is assumed to be UTC
 * and will be converted to the browser's time zone.
 * 
 * @param {String} str A string representing a datetime.
 * @returns {Date}
 */
function strToDatetime (str) {
    if(!str) {
        return str;
    }
    var regex = /^(\d\d\d\d)-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d(?:\.(\d+))?)$/;
    var regexISO = /^(\d\d\d\d)-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d(?:\.(\d+))?)Z$/;
    let res = regex.exec(str);
    if ( !res ) {
        res = regexISO.exec(str);
        if ( !res ) {
            throw new Error("'" + str + "' is not a valid datetime");
        }
    }
    var tmp = new Date(2000,0,1);
    tmp.setUTCMonth(1970);
    tmp.setUTCMonth(0);
    tmp.setUTCDate(1);
    tmp.setUTCFullYear(parseFloat(res[1]));
    tmp.setUTCMonth(parseFloat(res[2]) - 1);
    tmp.setUTCDate(parseFloat(res[3]));
    tmp.setUTCHours(parseFloat(res[4]));
    tmp.setUTCMinutes(parseFloat(res[5]));
    tmp.setUTCSeconds(parseFloat(res[6]));
    tmp.setUTCSeconds(parseFloat(res[6]));
    tmp.setUTCMilliseconds(parseFloat(utils.rpad((res[7] || "").slice(0, 3), 3)));
    return tmp;
}

/**
 * Converts a string to a Date javascript object using ISO's
 * date string format (exemple: '2011-12-01').
 * 
 * As a date is not subject to time zones, we assume it should be
 * represented as a Date javascript object at 00:00:00 in the
 * time zone of the browser.
 * 
 * @param {String} str A string representing a date.
 * @returns {Date}
 */
function strToDate (str) {
    if(!str) {
        return str;
    }
    var regex = /^(\d\d\d\d)-(\d\d)-(\d\d)$/;
    var res = regex.exec(str);
    if ( !res ) {
        throw new Error("'" + str + "' is not a valid date");
    }
    var tmp = new Date(2000,0,1);
    tmp.setFullYear(parseFloat(res[1]));
    tmp.setMonth(parseFloat(res[2]) - 1);
    tmp.setDate(parseFloat(res[3]));
    tmp.setHours(0);
    tmp.setMinutes(0);
    tmp.setSeconds(0);
    return tmp;
}

/**
 * Converts a string to a Date javascript object using ISO's
 * time string format (exemple: '15:12:35').
 * 
 * The Verp times are supposed to always be naive times. We assume it is
 * represented using a javascript Date with a date 1 of January 1970 and a
 * time corresponding to the meant time in the browser's time zone.
 * 
 * @param {String} str A string representing a time.
 * @returns {Date}
 */
function strToTime (str) {
    if(!str) {
        return str;
    }
    var regex = /^(\d\d):(\d\d):(\d\d(?:\.(\d+))?)$/;
    var res = regex.exec(str);
    if ( !res ) {
        throw new Error("'" + str + "' is not a valid time");
    }
    var tmp = new Date();
    tmp.setFullYear(1970);
    tmp.setMonth(0);
    tmp.setDate(1);
    tmp.setHours(parseFloat(res[1]));
    tmp.setMinutes(parseFloat(res[2]));
    tmp.setSeconds(parseFloat(res[3]));
    tmp.setMilliseconds(parseFloat(rpad((res[4] || "").slice(0, 3), 3)));
    return tmp;
}

/**
 * Converts a Date javascript object to a string using ÍO's
 * datetime string format (example: '2011-12-01T15:12:35.123Z').
 * 
 * The time zone of the Date object is assumed to be the one of the
 * browser and it will be converted to UTC (standard for VERP 6.1).
 * 
 * @param {Date} obj
 * @returns {String} A string representing a datetime.
 */
function datetimeToStr (obj) {
    if (!obj) {
        return false;
    }
    return lpad(obj.getUTCFullYear(),4) + "-" + lpad(obj.getUTCMonth() + 1,2) + "-"
         + lpad(obj.getUTCDate(),2) + "T" + lpad(obj.getUTCHours(),2) + ":"
         + lpad(obj.getUTCMinutes(),2) + ":" + lpad(obj.getUTCSeconds(),2) + "."
         + lpad(obj.getUTCMilliseconds(),3) + "Z";
}

/**
 * Converts a Date javascript object to a string using ÍO's
 * date string format (exemple: '2011-12-01').
 * 
 * As a date is not subject to time zones, we assume it should be
 * represented as a Date javascript object at 00:00:00 in the
 * time zone of the browser.
 * 
 * @param {Date} obj
 * @returns {String} A string representing a date.
 */
function dateToStr (obj) {
    if (!obj) {
        return false;
    }
    return lpad(obj.getFullYear(),4) + "-" + lpad(obj.getMonth() + 1,2) + "-"
         + lpad(obj.getDate(),2);
}

/**
 * Converts a Date javascript object to a string using ÍO's
 * time string format (exemple: '15:12:35').
 * 
 * The Verp times are supposed to always be naive times. We assume it is
 * represented using a javascript Date with a date 1 of January 1970 and a
 * time corresponding to the meant time in the browser's time zone.
 * 
 * @param {Date} obj
 * @returns {String} A string representing a time.
 */
function timeToStr (obj) {
    if (!obj) {
        return false;
    }
    return lpad(obj.getHours(),2) + ":" + lpad(obj.getMinutes(),2) + ":"
         + lpad(obj.getSeconds(),2);
}

function autoStrToDate (value) {
    try {
        return strToDatetime(value);
    } catch(e) {}
    try {
        return strToDate(value);
    } catch(e) {}
    try {
        return strToTime(value);
    } catch(e) {}
    throw new Error(_.str.sprintf(_t("'%s' is not a correct date, datetime nor time"), value));
}

function autoDateToStr (value, type) {
    switch(type) {
        case 'datetime':
            return datetimeToStr(value);
        case 'date':
            return dateToStr(value);
        case 'time':
            return timeToStr(value);
        default:
            throw new Error(_.str.sprintf(_t("'%s' is not convertible to date, datetime nor time"), type));
    }
}

/**
 * Convert Javascript strftime to escaped moment.js format.
 *
 * @param {String} value original format
 */
function strftimeToMomentFormat (value) {
    if (_normalizeFormatCache[value] === undefined) {
        var isletter = /[a-zA-Z]/,
            output = [],
            inToken = false;

        for (var index=0; index < value.length; ++index) {
            var character = value[index];
            if (character === '%' && !inToken) {
                inToken = true;
                continue;
            }
            if (isletter.test(character)) {
                if (inToken && normalizeFormatTable[character] !== undefined) {
                    character = normalizeFormatTable[character];
                } else {
                    character = '[' + character + ']'; // moment.js escape
                }
            }
            output.push(character);
            inToken = false;
        }
        _normalizeFormatCache[value] = output.join('');
    }
    return _normalizeFormatCache[value];
}

/**
 * Convert moment.js format to javascript strftime
 *
 * @param {String} value original format
 */
function momentToStrftimeFormat(value) {
    var regex = /(MMMM|DDDD|dddd|YYYY|MMM|ddd|mm|ss|ww|WW|MM|YY|hh|HH|DD|A|d)/g;
    return value.replace(regex, function(val){
        return '%'+inverseNormalizeFormatTable[val];
    });
}

var _normalizeFormatCache = {};
var normalizeFormatTable = {
    // Javascript strftime to moment.js conversion table
    // See verp/addons/base/views/res_lang_views.xml
    // for details about supported directives
    'a': 'ddd',
    'A': 'dddd',
    'b': 'MMM',
    'B': 'MMMM',
    'd': 'DD',
    'H': 'HH',
    'I': 'hh',
    'j': 'DDDD',
    'm': 'MM',
    'M': 'mm',
    'p': 'A',
    'S': 'ss',
    'U': 'ww',
    'W': 'WW',
    'w': 'd',
    'y': 'YY',
    'Y': 'YYYY',
    // unsupported directives
    'c': 'ddd MMM D HH:mm:ss YYYY',
    'x': 'MM/DD/YY',
    'X': 'HH:mm:ss'
};
var inverseNormalizeFormatTable = _.invert(normalizeFormatTable);

/**
 * Get date format of the user's language
 */
function getLangDateFormat() {
    return strftimeToMomentFormat(_t.database.parameters.dateFormat);
}

/**
 * Get time format of the user's language
 */
function getLangTimeFormat() {
    return strftimeToMomentFormat(_t.database.parameters.timeFormat);
}

/**
 * Get date time format of the user's language
 */
function getLangDatetimeFormat() {
    return strftimeToMomentFormat(_t.database.parameters.dateFormat + " " + _t.database.parameters.timeFormat);
}

const dateFormatWoZeroCache = {};
/**
 * Get date format of the user's language - allows non padded
 */
function getLangDateFormatWoZero() {
    const dateFormat = getLangDateFormat();
    if (!(dateFormat in dateFormatWoZeroCache)) {
        dateFormatWoZeroCache[dateFormat] = dateFormat
            .replace('MM', 'M')
            .replace('DD', 'D');
    }
    return dateFormatWoZeroCache[dateFormat];
}

const timeFormatWoZeroCache = {};
/**
 * Get time format of the user's language - allows non padded
 */
function getLangTimeFormatWoZero() {
    const timeFormat = getLangTimeFormat();
    if (!(timeFormat in timeFormatWoZeroCache)) {
        timeFormatWoZeroCache[timeFormat] = timeFormat
            .replace('HH', 'H')
            .replace('mm', 'm')
            .replace('ss', 's');
    }
    return timeFormatWoZeroCache[timeFormat];
}

return {
    dateToUtc: dateToUtc,
    strToDatetime: strToDatetime,
    strToDate: strToDate,
    strToTime: strToTime,
    datetimeToStr: datetimeToStr,
    dateToStr: dateToStr,
    timeToStr: timeToStr,
    autoStrToDate: autoStrToDate,
    autoDateToStr: autoDateToStr,
    strftimeToMomentFormat: strftimeToMomentFormat,
    momentToStrftimeFormat: momentToStrftimeFormat,
    getLangDateFormat: getLangDateFormat,
    getLangTimeFormat: getLangTimeFormat,
    getLangDateFormatWoZero: getLangDateFormatWoZero,
    getLangTimeFormatWoZero: getLangTimeFormatWoZero,
    getLangDatetimeFormat: getLangDatetimeFormat,
};

});

