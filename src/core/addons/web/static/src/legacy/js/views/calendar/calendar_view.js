verp.define('web.CalendarView', function (require) {
"use strict";

var AbstractView = require('web.AbstractView');
var CalendarModel = require('web.CalendarModel');
var CalendarController = require('web.CalendarController');
var CalendarRenderer = require('web.CalendarRenderer');
var core = require('web.core');
var vjUtils = require('web.vjUtils');
var utils = require('web.utils');

var _lt = core._lt;

// gather the fields to get
var fieldsToGather = [
    "dateStart",
    "dateDdelay",
    "dateStop",
    "allDay",
    "recurrenceUpdate",
    "createNameField",
];

const scalesInfo = {
    day: 'timeGridDay',
    week: 'timeGridWeek',
    month: 'dayGridMonth',
    year: 'dayGridYear',
};

var CalendarView = AbstractView.extend({
    displayName: _lt('Calendar'),
    icon: 'fa-calendar',
    jsLibs: [
        '/web/static/lib/fullcalendar/core/main.js',
        '/web/static/lib/fullcalendar/interaction/main.js',
        '/web/static/lib/fullcalendar/moment/main.js',
        '/web/static/lib/fullcalendar/daygrid/main.js',
        '/web/static/lib/fullcalendar/timegrid/main.js',
        '/web/static/lib/fullcalendar/list/main.js'
    ],
    cssLibs: [
        '/web/static/lib/fullcalendar/core/main.css',
        '/web/static/lib/fullcalendar/daygrid/main.css',
        '/web/static/lib/fullcalendar/timegrid/main.css',
        '/web/static/lib/fullcalendar/list/main.css'
    ],
    config: _.extend({}, AbstractView.prototype.config, {
        Model: CalendarModel,
        Controller: CalendarController,
        Renderer: CalendarRenderer,
    }),
    viewType: 'calendar',
    searchMenuTypes: ['filter', 'favorite'],

    /**
     * @override
     */
    init: function (viewInfo, params) {
        this._super.apply(this, arguments);
        var arch = this.arch;
        var fields = this.fields;
        var attrs = arch.attrs;

        if (!attrs.dateStart) {
            throw new Error(_lt("Calendar view has not defined 'dateStart' attribute."));
        }

        var mapping = {};
        var fieldNames = fields.displayName ? ['displayName'] : [];
        var displayFields = {};
        let popoverFields = {};

        _.each(fieldsToGather, function (field) {
            if (arch.attrs[field]) {
                var fieldName = attrs[field];
                mapping[field] = fieldName;
                fieldNames.push(fieldName);
            }
        });

        var filters = {};

        var eventLimit = attrs.eventLimit !== null && (isNaN(+attrs.eventLimit) ? _.str.toBool(attrs.eventLimit) : +attrs.eventLimit);

        var modelFilters = [];
        _.each(arch.children, function (child) {
            if (child.tag !== 'field') return;
            var fieldName = child.attrs.name;
            fieldNames.push(fieldName);
            popoverFields[fieldName] = {attrs: child.attrs};
            if (!child.attrs.invisible || child.attrs.filters) {
                child.attrs.options = child.attrs.options ? vjUtils.vjEval(child.attrs.options) : {};
                if (!child.attrs.invisible) {
                    displayFields[fieldName] = {attrs: child.attrs};
                }

                if (params.sidebar === false) return; // if we have not sidebar, (eg: Dashboard), we don't use the filter "coworkers"

                if (child.attrs.avatarField) {
                    filters[fieldName] = filters[fieldName] || {
                        'title': fields[fieldName].string,
                        'fieldName': fieldName,
                        'filters': [],
                        'checkAll': {},
                    };
                    filters[fieldName].avatarField = child.attrs.avatarField;
                    filters[fieldName].avatarModel = fields[fieldName].relation;
                }
                if (child.attrs.writeModel) {
                    filters[fieldName] = filters[fieldName] || {
                        'title': fields[fieldName].string,
                        'fieldName': fieldName,
                        'filters': [],
                        'checkAll': {},
                    };
                    filters[fieldName].writeModel = child.attrs.writeModel;
                    filters[fieldName].writeField = child.attrs.writeField; // can't use a x2many fields
                    filters[fieldName].filterField = child.attrs.filterField;

                    modelFilters.push(fields[fieldName].relation);
                }
                if (child.attrs.filters) {
                    filters[fieldName] = filters[fieldName] || {
                        'title': fields[fieldName].string,
                        'fieldName': fieldName,
                        'checkAll': {},
                        'filters': [],
                    };
                    if (child.attrs.color) {
                        filters[fieldName].fieldColor = child.attrs.color;
                        filters[fieldName].colorModel = fields[fieldName].relation;
                    }
                    if (!child.attrs.avatarField && fields[fieldName].relation) {
                        if (fields[fieldName].relation.includes(['res.users', 'res.partner', 'hr.employee'])) {
                            filters[fieldName].avatarField = 'avatar128';
                        }
                        filters[fieldName].avatarModel = fields[fieldName].relation;
                    }
                }
            }
        });

        if (attrs.color) {
            var fieldName = attrs.color;
            fieldNames.push(fieldName);
        }

        //if quickAdd = false, we don't allow quickAdd
        //if quickAdd = not specified in view, we use the default widgets.QuickCreate
        //if quickAdd = is NOT false and IS specified in view, we this one for widgets.QuickCreate'
        this.controllerParams.quickAddPop = (!('quickAdd' in attrs) || utils.toBoolElse(attrs.quickAdd+'', true));
        this.controllerParams.disableQuickCreate =  params.disableQuickCreate || !this.controllerParams.quickAddPop;

        // If formViewId is set, then the calendar view will open a form view
        // with this id, when it needs to edit or create an event.
        this.controllerParams.formViewId =
            attrs.formViewId ? parseInt(attrs.formViewId, 10) : false;
        if (!this.controllerParams.formViewId && params.action) {
            var formViewDescr = _.find(params.action.views, function (v) {
                return v.type ===  'form';
            });
            if (formViewDescr) {
                this.controllerParams.formViewId = formViewDescr.viewID;
            }
        }

        let scales;
        const allowedScales = Object.keys(scalesInfo);
        if (arch.attrs.scales) {
            scales = arch.attrs.scales.split(',')
                .filter(x => allowedScales.includes(x));
        } else {
            scales = allowedScales;
        }

        this.controllerParams.eventOpenPopup = utils.toBoolElse(attrs.eventOpenPopup || '', false);
        this.controllerParams.showUnusualDays = utils.toBoolElse(attrs.showUnusualDays || '', false);
        this.controllerParams.mapping = mapping;
        this.controllerParams.context = params.context || {};
        this.controllerParams.displayName = params.action && params.action.label;
        this.controllerParams.scales = scales;

        this.rendererParams.displayFields = displayFields;
        this.rendererParams.popoverFields = popoverFields;
        this.rendererParams.model = viewInfo.model;
        this.rendererParams.hideDate = utils.toBoolElse(attrs.hideDate || '', false);
        this.rendererParams.hideTime = utils.toBoolElse(attrs.hideTime || '', false);
        this.rendererParams.canDelete = this.controllerParams.activeActions.delete;
        this.rendererParams.canCreate = this.controllerParams.activeActions.create;
        this.rendererParams.scalesInfo = scalesInfo;

        this.loadParams.fieldNames = _.uniq(fieldNames);
        this.loadParams.mapping = mapping;
        this.loadParams.fields = fields;
        this.loadParams.fieldsInfo = viewInfo.fieldsInfo;
        this.loadParams.editable = !fields[mapping.dateStart].readonly;
        this.loadParams.creatable = this.controllerParams.activeActions.create;
        this.loadParams.eventLimit = eventLimit;
        this.loadParams.fieldColor = attrs.color;

        this.loadParams.filters = filters;
        this.loadParams.mode = (params.context && params.context.defaultMode) || attrs.mode;
        this.loadParams.scales = scales;
        this.loadParams.initialDate = moment(
            (params.context && params.context.initialDate) ||
            params.initialDate || 
            new Date()
        );
        this.loadParams.scalesInfo = scalesInfo;
    },
});

return CalendarView;

});
