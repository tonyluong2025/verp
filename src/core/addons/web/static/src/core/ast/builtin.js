/** @verp-module **/

import { JsDate, JsDateTime, JsRelativeDelta, JsTime, JsTimeDelta } from "./date";

export const BUILTINS = {
    /**
     * @param {any} value
     * @returns {boolean}
     */
    bool(value) {
        switch (typeof value) {
            case "number":
                return value !== 0;
            case "string":
                return value !== "";
            case "boolean":
                return value;
            case "object":
                if (value === null) {
                    return false;
                }
                if (value.isTrue) {
                    return value.isTrue();
                }
                return true;
        }
        return true;
    },

    time: {
        strftime(format) {
            return JsDateTime.now().strftime(format);
        },
    },

    contextToday() {
        return JsDate.today();
    },

    get today() {
        return JsDate.today().strftime("%Y-%m-%d");
    },

    get now() {
        return JsDateTime.now().strftime("%Y-%m-%d %H:%M:%S");
    },

    datetime: {
        time: JsTime,
        timedelta: JsTimeDelta,
        datetime: JsDateTime,
        date: JsDate,
    },

    relativedelta: JsRelativeDelta,
};
