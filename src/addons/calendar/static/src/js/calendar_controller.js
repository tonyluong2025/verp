/** @verp-module alias=calendar.CalendarController **/

    import Controller from 'web.CalendarController';
    import Dialog from 'web.Dialog';
    import { qweb as QWeb, _t } from 'web.core';

    const CalendarController = Controller.extend({

    renderButtons: function ($node) {
        this._super.apply(this, arguments);
        const $addButton =  $(QWeb.render('Calendar.calendarAddButtons'));
        this.$buttons.prepend($addButton)
        const self = this;
        // When clicking on "Add", create a new record in form view
        this.$buttons.on('click', 'button.o-calendar-button-new', () => {
            // TODO: switch to ir.action.actwindow in master
            return self.doAction('calendar.actionCalendarEventNotify', {
                additionalContext: self.context,
            });
        });
    },

        _askRecurrenceUpdatePolicy() {
            return new Promise((resolve, reject) => {
                new Dialog(this, {
                    title: _t('Edit Recurrent event'),
                    size: 'small',
                    $content: $(QWeb.render('calendar.RecurrentEventUpdate')),
                    buttons: [{
                        text: _t('Confirm'),
                        classes: 'btn-primary',
                        close: true,
                        click: function () {
                            resolve(this.$('input:checked').val());
                        },
                    }],
                }).open();
            });
        },

        /**
         * If the event comes from the organizer we delete the event, else we the event is decline for the attendee
         * @override 
         */
        _onDeleteRecord: function (ev) {
            const event = _.find(this.model.data.data, e => e.id === ev.data.id && e.attendeeId === ev.data.event.attendeeId);
            if (this.getSession().partnerId === event.attendeeId && this.getSession().partnerId === event.record.partnerId[0]) {
                this._super(...arguments);
            } else {
                var self = this;
                this.model.declineEvent(event).then(function () {
                    self.reload();
                });
            }
        },

        /**
         * @override
         * @private
         * @param {VerpEvent} event
         */
        async _onDropRecord(event) {
            const _super = this._super; // reference to this._super is lost after async call
            await this._dropdUpdateRecord(event);
            _super.apply(this, arguments);
        },

        /**
         * @override
         * @private
         * @param {VerpEvent} event
         */
        async _onUpdateRecord(event) {
            const _super = this._super;  // reference to this._super is lost after async call
            await this._dropdUpdateRecord(event);
            _super.apply(this, arguments);
        },

        async _dropdUpdateRecord(event) {
            if (event.data.record.recurrency) {
                const recurrenceUpdate = await this._askRecurrenceUpdatePolicy();
                event.data = _.extend({}, event.data, {
                    'recurrenceUpdate': recurrenceUpdate,
                });
            }
        }

    });

    export default CalendarController;
