verp.define('web.CalendarController', function (require) {
"use strict";

/**
 * Calendar Controller
 *
 * This is the controller in the Model-Renderer-Controller architecture of the
 * calendar view.  Its role is to coordinate the data from the calendar model
 * with the renderer, and with the outside world (such as a search view input)
 */

var AbstractController = require('web.AbstractController');
var core = require('web.core');
var Dialog = require('web.Dialog');
var dialogs = require('web.viewDialogs');
var QuickCreate = require('web.CalendarQuickCreate');

var _t = core._t;
var QWeb = core.qweb;

function dateToServer (date, fieldType) {
    date = date.clone().locale('en');
    if (fieldType === "date") {
        return date.local().format('YYYY-MM-DD');
    }
    return date.utc().format('YYYY-MM-DD HH:mm:ss');
}

var CalendarController = AbstractController.extend({
    customEvents: _.extend({}, AbstractController.prototype.customEvents, {
        changeDate: '_onchangeDate',
        changeFilter: '_onchangeFilter',
        deleteRecord: '_ondeleteRecord',
        dropRecord: '_onDropRecord',
        next: '_onNext',
        openCreate: '_onOpenCreate',
        openEvent: '_onOpenEvent',
        prev: '_onPrev',
        quickCreate: '_onQuickCreate',
        updateRecord: '_onupdateRecord',
        viewUpdated: '_onViewUpdated',
        AttendeeStatus: '_onAttendeeStatus',
    }),
    events: _.extend({}, AbstractController.prototype.events, {
        'click button.o-calendar-button-new': '_onButtonNew',
        'click button.o-calendar-button-prev': '_onButtonNavigation',
        'click button.o-calendar-button-today': '_onButtonNavigation',
        'click button.o-calendar-button-next': '_onButtonNavigation',
        'click button.o-calendar-button-day': '_onButtonScale',
        'click button.o-calendar-button-week': '_onButtonScale',
        'click button.o-calendar-button-month': '_onButtonScale',
        'click button.o-calendar-button-year': '_onButtonScale',
    }),
    /**
     * @override
     * @param {Widget} parent
     * @param {AbstractModel} model
     * @param {AbstractRenderer} renderer
     * @param {Object} params
     */
    init: function (parent, model, renderer, params) {
        this._super.apply(this, arguments);
        this.currentStart = null;
        this.displayName = params.displayName;
        this.quickAddPop = params.quickAddPop;
        this.disableQuickCreate = params.disableQuickCreate;
        this.eventOpenPopup = params.eventOpenPopup;
        this.showUnusualDays = params.showUnusualDays;
        this.formViewId = params.formViewId;
        this.readonlyFormViewId = params.readonlyFormViewId;
        this.mapping = params.mapping;
        this.context = params.context;
        this.previousOpen = null;
        // The quickCreating attribute ensures that we don't do several create
        this.quickCreating = false;
        this.scales = params.scales;
    },

    //--------------------------------------------------------------------------
    // Public
    //--------------------------------------------------------------------------

    /**
     * Render the buttons according to the CalendarView.buttons template and
     * add listeners on it. Set this.$buttons with the produced jQuery element
     *
     * @param {jQuery} [$node] a jQuery node where the rendered buttons
     *   should be inserted. $node may be undefined, in which case the Calendar
     *   inserts them into this.options.$buttons or into a div of its template
     */
    renderButtons: function ($node) {
        this.$buttons = $(QWeb.render('CalendarView.buttons', this._renderButtonsParameters()));

        this.$buttons.find('.o-calendar-button-' + this.mode).addClass('active');

        if ($node) {
            this.$buttons.appendTo($node);
        } else {
            this.$('.o-calendar-buttons').replaceWith(this.$buttons);
        }
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * Find a className in an array using the start of this class and
     * return the last part of a string
     * @private
     * @param {string} startClassName start of string to find in the "array"
     * @param {array|DOMTokenList} classList array of all class
     * @return {string|undefined}
     */
    _extractLastPartOfClassName(startClassName, classList) {
        var result;
        classList.forEach(function (value) {
            if (value && value.indexOf(startClassName) === 0) {
                result = value.substring(startClassName.length);
            }
        });
        return result;
    },
    /**
     * Move to the requested direction and reload the view
     *
     * @private
     * @param {string} to either 'prev', 'next' or 'today'
     * @returns {Promise}
     */
    _move: function (to) {
        this.model[to]();
        return this.reload();
    },
    /**
     * Parameter send to QWeb to render the template of Buttons
     *
     * @private
     * @return {{}}
     */
    _renderButtonsParameters() {
        return {
            scales: this.scales,
        };
    },
    /**
     * @override
     * @private
     */
    _update: function () {
        var self = this;
        if (!this.showUnusualDays) {
            return this._super.apply(this, arguments);
        }
        return this._super.apply(this, arguments).then(function () {
            self._rpc({
                model: self.modelName,
                method: 'getUnusualDays',
                args: [dateToServer(self.model.data.startDate, 'date'), dateToServer(self.model.data.endDate, 'date')],
                context: self.context,
            }).then(function (data) {
                _.each(self.$el.find('td.fc-day'), function (td) {
                    var $td = $(td);
                    if (data[$td.data('date')]) {
                        $td.addClass('o-calendar-disabled');
                    }
                });
            });
        });
    },
    /**
     * @private
     * @param {Object} record
     * @param {integer} record.id
     * @returns {Promise}
     */
    _updateRecord: function (record) {
        var reload = this.reload.bind(this, {});
        return this.model.updateRecord(record).then(reload, reload);
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * Handler when a user clicks on button to create event
     *
     * @private
     */
    _onButtonNew() {
        this.triggerUp('switchView', {viewType: 'form'});
    },
    /**
     * Handler when a user click on navigation button like prev, next, ...
     *
     * @private
     * @param {Event|jQueryEvent} jsEvent
     */
    _onButtonNavigation(jsEvent) {
        const action = this._extractLastPartOfClassName('o-calendar-button-', jsEvent.currentTarget.classList);
        if (action) {
            this._move(action);
        }
    },
    /**
     * Handler when a user click on scale button like day, month, ...
     *
     * @private
     * @param {Event|jQueryEvent} jsEvent
     */
    _onButtonScale(jsEvent) {
        const scale = this._extractLastPartOfClassName('o-calendar-button-', jsEvent.currentTarget.classList);
        if (scale) {
            this.model.setScale(scale);
            this.reload();
        }
    },

    /**
     * @private
     * @param {VerpEvent} event
     */
    _onchangeDate: function (event) {
        var modelData = this.model.get();
        if (modelData.targetDate.format('YYYY-MM-DD') === event.data.date.format('YYYY-MM-DD')) {
            // When clicking on same date, toggle between the two views
            switch (modelData.scale) {
                case 'month': this.model.setScale('week'); break;
                case 'week': this.model.setScale('day'); break;
                case 'day': this.model.setScale('month'); break;
            }
        } else if (modelData.targetDate.week() === event.data.date.week()) {
            // When clicking on a date in the same week, switch to day view
            this.model.setScale('day');
        } else {
            // When clicking on a random day of a random other week, switch to week view
            this.model.setScale('week');
        }
        if (event.data.scale) {
            this.model.setScale(event.data.scale);
        }
        this.model.setDate(event.data.date);
        this.reload();
    },
    /**
     * @private
     * @param {VerpEvent} event
     */
    _onchangeFilter: async function (event) {
        if (event.data.value !== 'all' && event.target.filterField) {
            const domain = [['userId', '=', this.getSession().uid]];
            if (event.data.value !== 'checkAll') {
                domain.push([event.target.writeField, '=', parseInt(event.data.value)]);
            }
            const existingFilter = await this._rpc({
                model: event.target.writeModel,
                method: 'search',
                args: [domain],
            });
            let val = {
                [event.target.filterField]: event.data.active,
            };
            await this._rpc({
                model: event.target.writeModel,
                method: 'write',
                args: [existingFilter, val],
            });
        }
        if (this.model.changeFilter(event.data) && !event.data.noReload) {
            this.reload();
        }
    },
    /**
     * @private
     * @param {VerpEvent} event
     */
    _ondeleteRecord: async function (event) {
        var self = this;
        if (event.data.event.record.recurrency) {
            const recurrenceUpdate = await this._askRecurrenceUpdatePolicy();
            event.data = Object.assign({}, event.data, {
                'recurrenceUpdate': recurrenceUpdate,
            });
            if (recurrenceUpdate === 'selfOnly') {
                self.model.deleteRecords([event.data.id], self.modelName).then(function () {
                self.reload();
            });
            } else {
                return this._rpc({
                    model: self.modelName,
                    method: 'actionMassDeletion',
                     args: [[event.data.id], recurrenceUpdate],
                }).then( function () {
                    self.reload();
                });
            }
        } else {
            Dialog.confirm(this, _t("Are you sure you want to delete this record ?"), {
                confirmCallback: function () {
                    self.model.deleteRecords([event.data.id], self.modelName).then(function () {
                        self.reload();
                    });
                }
            });
        }
    },
    /**
     * @private
     * @param {VerpEvent} event
     */
    _onDropRecord: function (event) {
        this._updateRecord(_.extend({}, event.data, {
            'drop': true,
        }));
    },
    /**
     * @private
     * @param {VerpEvent} event
     */
    _onNext: function (event) {
        event.stopPropagation();
        this._move('next');
    },
    /**
     * @private
     * @param {VerpEvent} event
     */
    _onOpenCreate: function (event) {
        var self = this;
        if (["year", "month"].includes(this.model.get().scale)) {
            event.data.allDay = true;
        }
        var data = this.model.calendarEventToRecord(event.data);

        var context = _.extend({}, this.context, event.options && event.options.context);
        // context default has more priority in defaultGet so if data.name is false then it may
        // lead to error/warning while saving record in form view as name field can be required
        if (data.name) {
            context.default_label = data.name;
        }
        context['default_' + this.mapping.dateStart] = data[this.mapping.dateStart] || null;
        if (this.mapping.dateStop) {
            context['default_' + this.mapping.dateStop] = data[this.mapping.dateStop] || null;
        }
        if (this.mapping.dateDelay) {
            context['default_' + this.mapping.dateDelay] = data[this.mapping.dateDelay] || null;
        }
        if (this.mapping.allday) {
            context['default_' + this.mapping.allday] = data[this.mapping.allday] || null;
        }

        for (var k in context) {
            if (context[k] && context[k]._isAMomentObject) {
                context[k] = dateToServer(context[k]);
            }
        }

        var options = _.extend({}, this.options, event.options, {
            context: context,
            title: this._setEventTitle()
        });

        if (this.quick != null) {
            this.quick.destroy();
            this.quick = null;
        }

        if (!options.disableQuickCreate && !event.data.disableQuickCreate && this.quickAddPop) {
            this.quick = new QuickCreate(this, true, options, data, event.data);
            this.quick.open();
            this.quick.opened(function () {
                self.quick.focus();
            });
            return;
        }

        if (this.eventOpenPopup) {
            if (this.previousOpen) { this.previousOpen.close(); }
            this.previousOpen = new dialogs.FormViewDialog(self, {
                resModel: this.modelName,
                context: context,
                title: options.title,
                viewId: this.formViewId || false,
                disableMultipleSelection: true,
                onSaved: function () {
                    if (event.data.onSave) {
                        event.data.onSave();
                    }
                    self.reload();
                },
            });
            this.previousOpen.on('closed', this, () => {
                if (event.data.onClose) {
                    event.data.onClose();
                }
            })
            this.previousOpen.open();
        } else {
            this.doAction({
                type: 'ir.actions.actwindow',
                resModel: this.modelName,
                views: [[this.formViewId || false, 'form']],
                target: 'current',
                context: context,
            });
        }
    },
    /**
     * @private
     * @param {VerpEvent} event
     */
    _onOpenEvent: function (event) {
        var self = this;
        var id = event.data._id;
        id = id && parseInt(id).toString() === id ? parseInt(id) : id;

        if (!this.eventOpenPopup) {
            this._rpc({
                model: self.modelName,
                method: 'getFormviewId',
                //The event can be called by a view that can have another context than the default one.
                args: [[id]],
                context: event.context || self.context,
            }).then(function (viewId) {
                self.doAction({
                    type:'ir.actions.actwindow',
                    resId: id,
                    resModel: self.modelName,
                    views: [[viewId || false, 'form']],
                    target: 'current',
                    context: event.context || self.context,
                });
            });
            return;
        }

        var options = {
            resModel: self.modelName,
            resId: id || null,
            context: event.context || self.context,
            title: _.str.sprintf(_t("Open: %s"), event.data.title),
            onSaved: function () {
                if (event.data.onSave) {
                    event.data.onSave();
                }
                self.reload();
            },
        };
        if (this.formViewId) {
            options.viewId = parseInt(this.formViewId);
        }
        new dialogs.FormViewDialog(this, options).open();
    },
    /**
     * @private
     * @param {VerpEvent} ev
     */
    _onPrev: function (ev) {
        ev.stopPropagation();
        this._move('prev');
    },

    /**
     * Handles saving data coming from quick create box
     *
     * @private
     * @param {VerpEvent} event
     */
    _onQuickCreate: function (event) {
        var self = this;
        if (this.quickCreating) {
            return;
        }
        this.quickCreating = true;
        this.model.createRecord(event)
            .then(function () {
                self.quick.destroy();
                self.quick = null;
                self.reload();
                self.quickCreating = false;
            })
            .guardedCatch(function (result) {
                var errorEvent = result.event;
                // This will occurs if there are some more fields required
                // Preventdefaulting the error event will prevent the traceback window
                errorEvent.preventDefault();
                event.data.options.disableQuickCreate = true;
                event.data.data.onSave = self.quick.destroy.bind(self.quick);
                self._onOpenCreate(event.data);
                self.quickCreating = false;
            });
    },
    /**
     * @private
     * @param {VerpEvent} event
     */
    _onupdateRecord: function (event) {
        this._updateRecord(event.data);
    },
    /**
     * The internal state of the calendar (mode, period displayed) has changed,
     * so update the control panel buttons and breadcrumbs accordingly.
     *
     * @private
     * @param {VerpEvent} event
     */
    _onViewUpdated: function (event) {
        this.mode = event.data.mode;
        if (this.$buttons) {
            this.$buttons.find('.active').removeClass('active');
            this.$buttons.find('.o-calendar-button-' + this.mode).addClass('active');
        }
        const title = `${this.displayName} (${event.data.title})`;
        return this.updateControlPanel({ title });
    },

    /**
     * Update Attendee status in batch for recurrent events
     * @private
     * @param {VerpEvent} event
     */
     _onAttendeeStatus: async function(event) {
         const self = this;
         let recurrenceUpdate = false;
         if (event.data.record.recurrency) {
            recurrenceUpdate = await this._askRecurrenceUpdatePolicy();
            event.data = Object.assign({}, event.data, {
                'recurrenceUpdate': recurrenceUpdate,
            });
         }
        return this._rpc({
            model: self.modelName,
            method: 'changeAttendeeStatus',
            args: [[event.data.id], event.data.selectedStatus, recurrenceUpdate],
        }).then( function () {
            self.reload();
        });
    },
    /**
     * This function has been created for the only purpose of
     * changing the title on the quick create from a calendar.
     * This way it can be overriden in other apps
     */
    _setEventTitle: function () {
        return _t('New Event');
    },
});

return CalendarController;

});
