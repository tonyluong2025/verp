verp.define('web.CalendarModel', function (require) {
"use strict";

var AbstractModel = require('web.AbstractModel');
var Context = require('web.Context');
var core = require('web.core');
var fieldUtils = require('web.fieldUtils');
var session = require('web.session');

var _t = core._t;

function dateToServer (date) {
    return date.clone().utc().locale('en').format('YYYY-MM-DD HH:mm:ss');
}

return AbstractModel.extend({
    /**
     * @override
     */
    init: function () {
        this._super.apply(this, arguments);
        this.endDate = null;
        var weekStart = _t.database.parameters.weekStart;
        // calendar uses index 0 for Sunday but Verp stores it as 7
        this.weekStart = weekStart !== undefined && weekStart !== false ? weekStart % 7 : moment().startOf('week').day();
        this.weekStop = this.weekStart + 6;
        this.filterCheckAll = {};
    },

    //--------------------------------------------------------------------------
    // Public
    //--------------------------------------------------------------------------

    /**
     * Transform fullcalendar event object to VERP Data object
     */
    calendarEventToRecord: function (event) {
        // Normalize eventEnd without changing fullcalendars event.
        var data = {};
        data[this.mapping.createNameField || 'label'] = event.title;
        var start = event.start.clone();
        var end = event.end && event.end.clone();

        // Set end date if not existing
        if (!end || end.diff(start) < 0) { // undefined or invalid end date
            if (event.allDay) {
                end = start.clone();
            } else {
                // in week mode or day mode, convert allday event to event
                end = start.clone().add(2, 'h');
            }
        } else if (event.allDay) {
            // For an "allDay", FullCalendar gives the end day as the
            // next day at midnight (instead of 23h59).
            end.add(-1, 'days');
        }

        var isDateEvent = this.fields[this.mapping.dateStart].type === 'date';
        // An "allDay" event without the "allday" option is not considered
        // as a 24h day. It's just a part of the day (by default: 7h-19h).
        if (event.allDay) {
            if (!this.mapping.allday && !isDateEvent) {
                if (event.rStart) {
                    start.hours(event.rStart.hours())
                         .minutes(event.rStart.minutes())
                         .seconds(event.rStart.seconds())
                         .utc();
                    end.hours(event.rEnd.hours())
                       .minutes(event.rEnd.minutes())
                       .seconds(event.rEnd.seconds())
                       .utc();
                } else {
                    // default hours in the user's timezone
                    start.hours(7);
                    end.hours(19);
                }
                start.add(-this.getSession().getTZOffset(start), 'minutes');
                end.add(-this.getSession().getTZOffset(end), 'minutes');
            }
        } else {
            start.add(-this.getSession().getTZOffset(start), 'minutes');
            end.add(-this.getSession().getTZOffset(end), 'minutes');
        }

        if (this.mapping.allday) {
            if (event.record) {
                data[this.mapping.allday] =
                    (this.data.scale !== 'month' && event.allDay) ||
                    event.record[this.mapping.allday] &&
                    end.diff(start) < 10 ||
                    false;
            } else {
                data[this.mapping.allday] = event.allDay;
            }
        }

        data[this.mapping.dateStart] = start;
        if (this.mapping.dateStop) {
            data[this.mapping.dateStop] = end;
        }

        if (this.mapping.dateDelay) {
            if (this.data.scale !== 'month' || (this.data.scale === 'month' && !event.drop)) {
                data[this.mapping.dateDelay] = (end.diff(start) <= 0 ? end.endOf('day').diff(start) : end.diff(start)) / 1000 / 3600;
            }
        }

        return data;
    },
    /**
     * @param {Object} filter
     * @returns {boolean}
     */
    changeFilter: function (filter) {
        var Filter = this.data.filters[filter.fieldName];
        if (filter.value === 'all') {
            Filter.all = filter.active;
        }
        else if (filter.value === 'checkAll') {
            // Select all numeric filters and update the checkboxes
            this.filterCheckAll[filter.fieldName] = filter.active;
            // Deactivate the All selection
            Filter.all = false;
            if (filter.active) {
                // Check every displayed filters except the 'all' filter
                Filter.filters.filter(el => el.value !== 'all').forEach(element => element.active = true );
                return true;

            } else {
               Filter.filters.forEach(element => element.active = false);
               return true;
            }
        }
        var f = _.find(Filter.filters, function (f) {
            return f.value === filter.value;
        });
        if (f) {
            if (f.active !== filter.active) {
                // Update the value according to the checkbox state
                f.active = filter.active;
            } else if (filter.active) {
                // if the filter is NOT active, we remove it by returning true [triggered by _onFilterRemove]
                return false;
            }
        } else if (filter.active) {
            Filter.filters.push({
                value: filter.value,
                active: true,
            });
        }
        return true;
    },
    /**
     * @param {VerpEvent} event
     */
    createRecord: function (event) {
        var data = this.calendarEventToRecord(event.data.data);
        for (var k in data) {
            if (data[k] && data[k]._isAMomentObject) {
                data[k] = dateToServer(data[k]);
            }
        }
        return this._rpc({
                model: this.modelName,
                method: 'create',
                args: [data],
                context: event.data.options.context,
            });
    },
    /**
     * @param {any} ids
     * @param {any} model
     * @returns
     */
    deleteRecords: function (ids, model) {
        return this._rpc({
                model: model,
                method: 'unlink',
                args: [ids],
                context: session.userContext, // todo: combine with view context
            });
    },
    /**
     * @override
     * @returns {Object}
     */
    __get: function () {
        return _.extend({}, this.data, {
            fields: this.fields
        });
    },
    /**
     * @override
     * @param {any} params
     * @returns {Promise}
     */
    __load: function (params) {
        var self = this;
        this.modelName = params.modelName;
        this.fields = params.fields;
        this.fieldNames = params.fieldNames;
        this.fieldsInfo = params.fieldsInfo;
        this.mapping = params.mapping;
        this.mode = params.mode;       // one of month, week or day
        this.scales = params.scales;   // one of month, week or day
        this.scalesInfo = params.scalesInfo;

        // Check whether the date field is editable (i.e. if the events can be
        // dragged and dropped)
        this.editable = params.editable;
        this.creatable = params.creatable;

        // display more button when there are too much event on one day
        this.eventLimit = params.eventLimit;

        // fields to display color, e.g.: userId.partnerId
        this.fieldColor = params.fieldColor;
        if (!this.preloadPromise) {
            this.preloadPromise = new Promise(function (resolve, reject) {
                Promise.all([
                    self._rpc({model: self.modelName, method: 'checkAccessRights', args: ["write", false]}),
                    self._rpc({model: self.modelName, method: 'checkAccessRights', args: ["create", false]})
                ]).then(function (result) {
                    var write = result[0];
                    var create = result[1];
                    self.writeRight = write;
                    self.createRight = create;
                    resolve();
                }).guardedCatch(reject);
            });
        }

        this.data = {
            domain: params.domain,
            context: params.context,
            // get in arch the filter to display in the sidebar and the field to read
            filters: params.filters,
        };

        this.setDate(params.initialDate);
        // Use mode attribute in xml file to specify zoom timeline (day,week,month)
        // by default month.
        this.setScale(params.mode);

        _.each(this.data.filters, function (filter) {
            if (filter.avatarField && !filter.avatarModel) {
                filter.avatarModel = self.modelName;
            }
        });

        return this.preloadPromise.then(this._loadCalendar.bind(this));
    },
    /**
     * Move the current date range to the next period
     */
    next: function () {
        this.setDate(this.data.targetDate.clone().add(1, this.data.scale));
    },
    /**
     * Move the current date range to the previous period
     */
    prev: function () {
        this.setDate(this.data.targetDate.clone().add(-1, this.data.scale));
    },
    /**
     * @override
     * @param {Object} [params.context]
     * @param {Array} [params.domain]
     * @returns {Promise}
     */
    __reload: function (handle, params) {
        if (params.domain) {
            this.data.domain = params.domain;
        }
        if (params.context) {
            this.data.context = params.context;
        }
        return this._loadCalendar();
    },
    /**
     * @param {Moment} start. in local TZ
     */
    setDate: function (start) {
        // keep highlight/targetDate in localtime
        this.data.highlightDate = this.data.targetDate = start.clone();
        this.data.startDate = this.data.endDate = start;
        switch (this.data.scale) {
            case 'year': {
                const yearStart = this.data.startDate.clone().startOf('year');
                let yearStartDay = this.weekStart;
                if (yearStart.day() < yearStartDay) {
                    // the 1st of January is before our week start (e.g. week start is Monday, and
                    // 01/01 is Sunday), so we go one week back
                    yearStartDay -= 7;
                }
                this.data.startDate = yearStart.day(yearStartDay).startOf('day');
                this.data.endDate = this.data.endDate.clone()
                    .endOf('year').day(this.weekStop).endOf('day');
                break;
            }
            case 'month':
                var monthStart = this.data.startDate.clone().startOf('month');

                var monthStartDay;
                if (monthStart.day() >= this.weekStart) {
                    // the month's first day is after our week start
                    // Then we are in the right week
                    monthStartDay = this.weekStart;
                } else {
                    // The month's first day is before our week start
                    // Then we should go back to the the previous week
                    monthStartDay = this.weekStart - 7;
                }

                this.data.startDate = monthStart.day(monthStartDay).startOf('day');
                this.data.endDate = this.data.startDate.clone().add(5, 'week').day(this.weekStop).endOf('day');
                break;
            case 'week':
                var weekStart = this.data.startDate.clone().startOf('week');
                var weekStartDay = this.weekStart;
                if (this.data.startDate.day() < this.weekStart) {
                    // The week's first day is after our current day
                    // Then we should go back to the previous week
                    weekStartDay -= 7;
                }
                this.data.startDate = this.data.startDate.clone().day(weekStartDay).startOf('day');
                this.data.endDate = this.data.endDate.clone().day(weekStartDay + 6).endOf('day');
                break;
            default:
                this.data.startDate = this.data.startDate.clone().startOf('day');
                this.data.endDate = this.data.endDate.clone().endOf('day');
        }
        // We have set start/stop datetime as definite begin/end boundaries of a period (month, week, day)
        // in local TZ (what is the begining of the week *I am* in ?)
        // The following code:
        // - converts those to UTC using our homemade method (testable)
        // - sets the moment UTC flag to true, to ensure compatibility with third party libs
        var manualUtcDateStart = this.data.startDate.clone().add(-this.getSession().getTZOffset(this.data.startDate), 'minutes');
        var formattedUtcDateStart = manualUtcDateStart.format('YYYY-MM-DDTHH:mm:ss') + 'Z';
        this.data.startDate = moment.utc(formattedUtcDateStart);

        var manualUtcDateEnd = this.data.endDate.clone().add(-this.getSession().getTZOffset(this.data.startDate), 'minutes');
        var formattedUtcDateEnd = manualUtcDateEnd.format('YYYY-MM-DDTHH:mm:ss') + 'Z';
        this.data.endDate = moment.utc(formattedUtcDateEnd);
    },
    /**
     * @param {string} scale the scale to set
     */
    setScale: function (scale) {
        if (!_.contains(this.scales, scale)) {
            scale = "week";
        }
        this.data.scale = scale;
        this.setDate(this.data.targetDate);
    },
    /**
     * Move the current date range to the period containing today
     */
    today: function () {
        this.setDate(moment(new Date()));
    },
    /**
     * @param {Object} record
     * @param {integer} record.id
     * @returns {Promise}
     */
    updateRecord: function (record) {
        // Cannot modify actual label yet
        var data = _.omit(this.calendarEventToRecord(record), 'label');
        for (var k in data) {
            if (data[k] && data[k]._isAMomentObject) {
                data[k] = dateToServer(data[k]);
            }
        }
        var context = new Context(this.data.context, {fromUi: true});
        return this._rpc({
            model: this.modelName,
            method: 'write',
            args: [[parseInt(record.id, 10)], data],
            context: context
        });
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * Converts this.data.filters into a domain
     *
     * @private
     * @returns {Array}
     */
    _getFilterDomain: function () {
        // List authorized values for every field
        // fields with an active 'all' filter are skipped
        var authorizedValues = {};
        var avoidValues = {};

        _.each(this.data.filters, function (filter) {
            // Skip 'all' filters because they do not affect the domain
            if (filter.all) return;
            // all visible filters have been activated
            if (filter.visible) return;

            // Loop over subfilters to complete authorizedValues
            _.each(filter.filters, function (f) {
                if (filter.writeModel) {
                    if (!authorizedValues[filter.fieldName])
                        authorizedValues[filter.fieldName] = [];

                    if (f.active) {
                        authorizedValues[filter.fieldName].push(f.value);
                    }
                } else {
                    if (!f.active) {
                        if (!avoidValues[filter.fieldName])
                            avoidValues[filter.fieldName] = [];

                        avoidValues[filter.fieldName].push(f.value);
                    }
                }
            });
        });

        // Compute the domain
        var domain = [];
        for (var field in authorizedValues) {
            domain.push([field, 'in', authorizedValues[field]]);
        }
        for (var field in avoidValues) {
            if (avoidValues[field].length > 0) {
                domain.push([field, 'not in', avoidValues[field]]);
            }
        }

        return domain;
    },
    /**
     * @private
     * @returns {Object}
     */
    _getFullCalendarOptions: function () {
        var format12Hour = {
            hour: 'numeric',
            minute: '2-digit',
            omitZeroMinute: true,
            meridiem: 'short'
        };
        var format24Hour = {
            hour: 'numeric',
            minute: '2-digit',
            hour12: false,
        };
        return {
            defaultView: this.scalesInfo[this.mode || 'week'],
            header: false,
            selectable: this.creatable && this.createRight,
            selectMirror: true,
            editable: this.editable,
            droppable: true,
            navLinks: false,
            eventLimit: this.eventLimit, // allow "more" link when too many events
            snapMinutes: 15,
            longPressDelay: 500,
            eventResizableFromStart: true,
            nowIndicator: true,
            weekNumbers: true,
            weekNumbersWithinDays: true,
            weekNumberCalculation: function (date) {
                // Since FullCalendar v4 ISO 8601 week date is preferred so we force the old system
                return moment(date).week();
            },
            weekLabel: _t("Week"),
            allDayText: _t("All day"),
            monthNames: moment.months(),
            monthNamesShort: moment.monthsShort(),
            dayNames: moment.weekdays(),
            dayNamesShort: moment.weekdaysShort(),
            dayNamesMin: moment.weekdaysMin(),
            firstDay: this.weekStart,
            slotLabelFormat: _t.database.parameters.timeFormat.search("%H") !== -1 ? format24Hour : format12Hour,
            allDaySlot: this.mapping.allday || this.fields[this.mapping.dateStart].type === 'date',
        };
    },
    /**
     * Return a domain from the date range
     *
     * @private
     * @returns {Array} A domain containing datetimes start and stop in UTC
     *  those datetimes are formatted according to server's standards
     */
    _getRangeDomain: function () {
        // Build VERP Domain to filter object by this.mapping.dateStart field
        // between given start, end dates.
        var domain = [[this.mapping.dateStart, '<=', dateToServer(this.data.endDate)]];
        if (this.mapping.dateStop) {
            domain.push([this.mapping.dateStop, '>=', dateToServer(this.data.startDate)]);
        } else if (!this.mapping.dateDelay) {
            domain.push([this.mapping.dateStart, '>=', dateToServer(this.data.startDate)]);
        }
        return domain;
    },
    /**
     * @private
     * @returns {Promise}
     */
    _loadCalendar: function () {
        var self = this;
        this.data.fcOptions = this._getFullCalendarOptions();
        var defs = _.map(this.data.filters, this._loadFilter.bind(this));

        return Promise.all(defs).then(function () {
            return self._rpc({
                    model: self.modelName,
                    method: 'searchRead',
                    context: self.data.context,
                    fields: self.fieldNames,
                    domain: self.data.domain.concat(self._getRangeDomain()).concat(self._getFilterDomain())
            })
            .then(async function (events) {
                self._parseServerData(events);
                self.data.data = await self._getCalendarEventData(events);
                return Promise.all([
                    self._loadColors(self.data, self.data.data),
                    self._loadRecordsToFilters(self.data, self.data.data)
                ]);
            });
        });
    },
    /**
     * @private
     * @param {any} element
     * @param {any} events
     * @returns {Promise}
     */
    _loadColors: function (element, events) {
        if (this.fieldColor) {
            const fieldName = this.fieldColor;
            _.each(events, function (event) {
                var value = event.record[fieldName];
                event.colorIndex = _.isArray(value) ? value[0] : value;
            });
            this.modelColor = this.fields[fieldName].relation || element.model;
        }
        return Promise.resolve();
    },
    /**
     * Get the color index used to render the event and the filter.
     * Since we have a maximum of 30 colors, we have to adapt the color
     * index in case the id exceeds the number of colors available.
     *
     * - actualColorList contains the list of color already used in the filter
     * - colorIndex is the color we try to apply for the event
     * 
     * @private
     * @param {Array} actualColorList
     * @param {Integer} colorIndex
     * @returns {Integer}
     */
    _getColorIndex: function(actualColorList, colorIndex) {
        var actualColorList = actualColorList || [0];
        var newColorIndex = colorIndex % 50;
        if (newColorIndex !== colorIndex && actualColorList.includes(newColorIndex)) {
            newColorIndex = this._getColorIndex(actualColorList, newColorIndex + 3);
        }
        return newColorIndex;
    },
    /**
     * @private
     * @param {any} filter
     * @returns {Promise}
     */
    _loadFilter: function (filter) {
        if (!filter.writeModel) {
            return Promise.resolve();
        }

        var field = this.fields[filter.fieldName];
        var fields = [filter.writeField];
        if (filter.filterField) {
            fields.push(filter.filterField);
        }
        return this._rpc({
                model: filter.writeModel,
                method: 'searchRead',
                domain: [["userId", "=", session.uid]],
                fields: fields,
            })
            .then(function (res) {
                var records = _.map(res, function (record) {
                    var _value = record[filter.writeField];
                    var value = _.isArray(_value) ? _value[0] : _value;
                    var f = _.find(filter.filters, function (f) {return f.value === value;});
                    var formater = fieldUtils.format[_.contains(['many2many', 'one2many'], field.type) ? 'many2one' : field.type];
                    // By default, only current user partner is checked.
                    return {
                        'id': record.id,
                        'value': value,
                        'label': formater(_value, field),
                        'active': (f && f.active) || (filter.filterField && record[filter.filterField]),
                    };
                });
                records.sort(function (f1,f2) {
                    return _.string.naturalCmp(f2.label, f1.label);
                });

                // add my profile
                if (field.relation === 'res.partner' || field.relation === 'res.users') {
                    var value = field.relation === 'res.partner' ? session.partnerId : session.uid;
                    var me = _.find(records, function (record) {
                        return record.value === value;
                    });
                    if (me) {
                        records.splice(records.indexOf(me), 1);
                    } else {
                        var f = _.find(filter.filters, function (f) {return f.value === value;});
                        me = {
                            'value': value,
                            'label': session.label,
                            'active': !f || f.active,
                        };
                    }
                    records.unshift(me);
                }
                // add all selection
                records.push({
                    'value': 'all',
                    'label': field.relation === 'res.partner' || field.relation === 'res.users' ? _t("Everybody's calendars") : _t("Everything"),
                    'active': filter.all,
                });

                filter.filters = records;
            });
    },
    /**
     * @private
     * @param {any} element
     * @param {any} events
     * @returns {Promise}
     */
    _loadRecordsToFilters: function (element, events) {
        var self = this;
        var newFilters = {};
        var toRead = {};
        var defs = [];
        var colorFilter = {};

        _.each(this.data.filters, function (filter, fieldName) {
            var field = self.fields[fieldName];

            newFilters[fieldName] = filter;
            if (filter.writeModel) {
                if (field.relation === self.modelColor) {
                    _.each(filter.filters, function (f) {
                        f.colorIndex = self._getColorIndex(_.map(filter.filters, f => f.value), f.value);
                    });
                }
                return;
            }

            _.each(filter.filters, function (filter) {
                filter.display = !filter.active;
            });

            var fs = [];
            var undefinedFs = [];
            _.each(events, function (event) {
                var data =  event.record[fieldName];
                if (!_.contains(['many2many', 'one2many'], field.type)) {
                    data = [data];
                } else {
                    toRead[field.relation] = (toRead[field.relation] || []).concat(data);
                }
                _.each(data, function (_value) {
                    var value = _.isArray(_value) ? _value[0] : _value;
                    var f = {
                        'colorIndex': self.modelColor === (field.relation || element.model) ? value : false,
                        'value': value,
                        'label': fieldUtils.format[field.type](_value, field) || _t("Undefined"),
                        'avatarModel': field.relation || element.model,
                    };
                    // if field used as color does not have value then push filter in undefinedFs,
                    // such filters should come last in filter list with Undefined string, later merge it with fs
                    value ? fs.push(f) : undefinedFs.push(f);
                });
            });
            _.each(_.union(fs, undefinedFs), function (f) {
                var f1 = _.findWhere(filter.filters, _.omit(f, 'colorIndex'));
                if (f1) {
                    f1.display = true;
                } else {
                    f.display = f.active = true;
                    filter.filters.push(f);
                }
            });

            if (filter.colorModel && filter.fieldColor) {
                var ids = filter.filters.reduce((acc, f) => {
                    if (!f.colorIndex && f.value) {
                        acc.push(f.value);
                    }
                    return acc;
                }, []);
                if (!colorFilter[filter.colorModel]) {
                    colorFilter[filter.colorModel] = {};
                }
                if (ids.length) {
                    defs.push(self._rpc({
                        model: filter.colorModel,
                        method: 'searchRead',
                        args: [[['id', 'in', _.uniq(ids)]], [filter.fieldColor]],
                    })
                    .then(function (res) {
                        _.each(res, function (c) {
                            colorFilter[filter.colorModel][c.id] = c[filter.fieldColor];
                        });
                    }));
                }
            }
        });

        _.each(toRead, function (ids, model) {
            defs.push(self._rpc({
                    model: model,
                    method: 'nameGet',
                    args: [_.uniq(ids)],
                })
                .then(function (res) {
                    toRead[model] = _.object(res);
                }));
        });
        return Promise.all(defs).then(function () {
            _.each(self.data.filters, function (filter) {
                if (filter.writeModel) {
                    return;
                }
                if (filter.filters.length && (filter.filters[0].avatarModel in toRead)) {
                    _.each(filter.filters, function (f) {
                        f.label = toRead[f.avatarModel][f.value];
                    });
                }
                if (filter.colorModel && filter.fieldColor) {
                    _.each(filter.filters, function (f) {
                        if (!f.colorIndex) {
                            f.colorIndex = colorFilter[filter.colorModel] && colorFilter[filter.colorModel][f.value];
                        }
                    });
                }
            });
        });
    },
    /**
     * parse the server values to javascript framwork
     *
     * @private
     * @param {Object} data the server data to parse
     */
    _parseServerData: function (data) {
        var self = this;
        _.each(data, function(event) {
            _.each(self.fieldNames, function (fieldName) {
                event[fieldName] = self._parseServerValue(self.fields[fieldName], event[fieldName]);
            });
        });
    },
    /**
     * Transform VERP event object to fullcalendar event object
     *
     * @private
     * @param {Object} evt
     */
    _recordToCalendarEvent: function (evt) {
        var dateStart;
        var dateStop;
        var dateDelay = evt[this.mapping.dateDelay] || 1.0,
            allday = this.fields[this.mapping.dateStart].type === 'date' ||
                this.mapping.allday && evt[this.mapping.allday] || false,
            theTitle = '',
            attendees = [];

        if (!allday) {
            dateStart = evt[this.mapping.dateStart].clone();
            dateStop = this.mapping.dateStop ? evt[this.mapping.dateStop].clone() : null;
        } else {
            dateStart = evt[this.mapping.dateStart].clone().startOf('day');
            dateStop = this.mapping.dateStop ? evt[this.mapping.dateStop].clone().startOf('day') : null;
        }

        if (!dateStop && dateDelay) {
            dateStop = dateStart.clone().add(dateDelay,'hours');
        }

        if (!allday) {
            dateStart.add(this.getSession().getTZOffset(dateStart), 'minutes');
            dateStop.add(this.getSession().getTZOffset(dateStop), 'minutes');
        }

        if (this.mapping.allday && evt[this.mapping.allday]) {
            dateStop.add(1, 'days');
        }
        var r = {
            'record': evt,
            'start': dateStart.local(true).toDate(),
            'end': dateStop.local(true).toDate(),
            'rStart': dateStart.clone().local(true).toDate(),
            'rEnd': dateStop.clone().local(true).toDate(),
            'title': theTitle,
            'allDay': allday,
            'id': evt.id,
            'attendees':attendees,
        };

        if (!(this.mapping.allday && evt[this.mapping.allday]) && this.data.scale === 'month' && this.fields[this.mapping.dateStart].type !== 'date') {
            r.showTime = true;
        }

        return r;
    },
    _getCalendarEventData: function (events) {
        return _.map(events, this._recordToCalendarEvent.bind(this));
    }
});

});
