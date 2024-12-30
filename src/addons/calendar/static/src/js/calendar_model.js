/** @verp-module alias=calendar.CalendarModel **/

    import Model from 'web.CalendarModel';

    const CalendarModel = Model.extend({

        /**
         * @override
         * Transform fullcalendar event object to verp Data object
         */
        calendarEventToRecord(event) {
            const data = this._super(event);
            return _.extend({}, data, {
                'recurrenceUpdate': event.recurrenceUpdate,
            });
        },
        async _getCalendarEventData(events) {
            const calendarEventData = await this._super(...arguments);
            const calendarEventByAttendeeData = await this._calendarEventByAttendee(calendarEventData);
            return calendarEventByAttendeeData;
        },
        /**
         * Split the events to display an event for each attendee with the correct status.
         * If the all filter is activated, we don't display an event for each attendee and keep
         * the previous behavior to display a single event.
         * 
         */
        async _calendarEventByAttendee(eventsData) {
            const self = this;
            let eventsDataByAttendee = [];
            const attendeeFilters = self.loadParams.filters.partnerIds;
            const everyoneFilter = attendeeFilters && (attendeeFilters.filters.find(f => f.value === "all") || {}).active || false;
            const attendeeIDs = attendeeFilters && _.filter(attendeeFilters.filters.map(partner => partner.value !== 'all' ? partner.value : false), id => id !== false);
            const eventIDs = eventsData.map(event => event.id);
            // Fetch the attendees' info from the partners selected in the filter to display the events
            this.attendees = await self._rpc({
                model: 'res.partner',
                method: 'getAttendeeDetail',
                args: [attendeeIDs, eventIDs],
            });
            if (!everyoneFilter) {
                const currentPartnerId = this.getSession().partnerId;
                eventsData.forEach(event => {
                    const attendees = event.record.partnerIds && event.record.partnerIds.length ? event.record.partnerIds : [event.record.partnerId[0]];
                    // Get the list of partnerId corresponding to active filters present in the current event
                    const attendeesFiltered = attendeeFilters.filters.reduce((acc, filter) => {
                        if (filter.active && attendees.includes(filter.value)) {
                            acc.push(filter.value);
                        }
                        return acc;
                    }, []);

                    // Create Event data for each attendee found
                    attendeesFiltered.forEach(attendee => {
                        let e = $.extend(true, {}, event);
                        e.attendeeId = attendee;
                        const attendeeInfo = self.attendees.find(a => a.id === attendee && a.eventId === e.record.id);
                        if (attendeeInfo) {
                            e.record.attendeeStatus = attendeeInfo.status;
                            e.record.isAlone = attendeeInfo.isAlone;
                            // check if this event data corresponds to the current partner
                            e.record.isCurrentPartner = currentPartnerId === attendeeInfo.id;
                        }
                        eventsDataByAttendee.push(e);
                    });
                });
            } else {
                eventsData.forEach(event => {
                    event.attendeeId = event.record.partnerId && event.record.partnerId[0];
                    const attendeeInfo = self.attendees.find(a => a.id === self.getSession().partnerId && a.eventId === event.record.id);
                    if (attendeeInfo) {
                        event.record.isAlone = attendeeInfo.isAlone;
                    }
                });
            }
            return eventsDataByAttendee.length ? eventsDataByAttendee : eventsData;
        },

        /**
         * Decline an event for the actual attendee
         * @param {Integer} eventId
         */
        declineEvent: function (event) {
            return this._rpc({
                model: 'calendar.attendee',
                method: 'doDecline',
                args: [this.attendees.find(attendee => attendee.eventId === event.id && attendee.id === this.getSession().partnerId).attendeeId],
            });
        },

    /**
     * Set the event color according to the filters values.
     * When Everybodies'events are displayed, the color are set according to the first attendeeId to decrease confusion.
     * Else, the event color are defined according to the existing filters colors.
     * @private
     * @param {any} element
     * @param {any} events
     * @returns {Promise}
     */
    _loadColors: function (element, events) {
        if (this.fieldColor) {
            const fieldName = this.fieldColor;
            for (const event of events) {
                // list of partners in case of calendar event
                const value = event.record[fieldName];
                const colorRecord = value[0];
                const filter = this.loadParams.filters[fieldName];
                const colorFilter = filter && filter.filters.map(f => f.value) || [colorRecord];
                const everyoneFilter = filter && (filter.filters.find(f => f.value === "all") || {}).active || false;
                let colorValue;
                if (!everyoneFilter) {
                    colorValue = event.attendeeId;
                } else {
                    const partnerId = this.getSession().partnerId
                    colorValue = value.includes(partnerId) ? partnerId : colorRecord;
                }
                event.colorIndex = this._getColorIndex(colorFilter, colorValue);
            }
            this.modelColor = this.fields[fieldName].relation || element.model;

        }
        return Promise.resolve();
    },

    });

    export default CalendarModel;
