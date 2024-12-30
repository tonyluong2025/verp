/** @verp-module alias=calendar.CalendarRenderer **/

import CalendarRenderer from 'web.CalendarRenderer';
import CalendarPopover from 'web.CalendarPopover';
import session from 'web.session';

const AttendeeCalendarPopover = CalendarPopover.extend({
    template: 'Calendar.attendee.status.popover',
    events: _.extend({}, CalendarPopover.prototype.events, {
        'click .o-calendar-attendee-status .dropdown-item': '_onClickAttendeeStatus'
    }),
    /**
     * @constructor
     */
    init: function () {
        var self = this;
        this._super.apply(this, arguments);
        // Show status dropdown if user is in attendees list
        if (this.isCurrentPartnerAttendee()) {
            this.statusColors = {accepted: 'text-success', declined: 'text-danger', tentative: 'text-muted', needsAction: 'text-dark'};
            this.statusInfo = {};
            _.each(this.fields.attendeeStatus.selection, function (selection) {
                self.statusInfo[selection[0]] = {text: selection[1], color: self.statusColors[selection[0]]};
            });
            this.selectedStatusInfo = this.statusInfo[this.event.extendedProps.record.attendeeStatus];
        }
    },

    //--------------------------------------------------------------------------
    // Public
    //--------------------------------------------------------------------------

    /**
     * @return {boolean}
     */
    isCurrentPartnerOrganizer() {
        return this.event.extendedProps.record.partnerId[0] === session.partnerId;
    },
    /**
     * @return {boolean}
     */
    isCurrentPartnerAttendee() {
        return this.event.extendedProps.record.partnerIds.includes(session.partnerId);
    },
    /**
     * @override
     * @return {boolean}
     */
    isEventDeletable() {
        return this._super() && this.isCurrentPartnerAttendee();
    },
    /**
     * @override
     * @return {boolean}
     */
    isEventDetailsVisible() {
        return this._isEventPrivate() ? this.isCurrentPartnerAttendee() : this._super();
    },
    /**
     * @override
     * @return {boolean}
     */
    isEventEditable() {
        return this._isEventPrivate() ? this.isCurrentPartnerAttendee() : this._super();
    },
    /**
     * Check if we are a partner and if we are the only attendee.
     * This avoid to display attendee answer dropdown for single user attendees
     * @return {boolean}
     */
    displayAttendeeAnswerChoice() {
        const isCurrentpartner = (currentValue) => currentValue === session.partnerId;
        const onlyAttendee =  this.event.extendedProps.record.partnerIds.every(isCurrentpartner);
        return this.isCurrentPartnerAttendee() && this.event.extendedProps.record.isCurrentPartner && !onlyAttendee;
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * @private
     * @return {boolean}
     */
    _isEventPrivate() {
        return this.event.extendedProps.record.privacy === 'private';
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * @private
     * @param {MouseEvent} ev
     */
    _onClickAttendeeStatus: function (ev) {
        ev.preventDefault();
        const selectedStatus = $(ev.currentTarget).attr('data-action');
        this.triggerUp('AttendeeStatus', {id: parseInt(this.event.id), record: this.event.extendedProps.record,
        selectedStatus: selectedStatus});
    },
});


const AttendeeCalendarRenderer = CalendarRenderer.extend({
    template: 'calendar.CalendarView',

	config: _.extend({}, CalendarRenderer.prototype.config, {
        CalendarPopover: AttendeeCalendarPopover,
        eventTemplate: 'Calendar.calendar-box',
    }),
    /**
     * Add the attendee-id attribute in order to distinct the events when there are
     * several attendees in the event.
     * @override
     */
    _addEventAttributes: function (element, event) {
        this._super(...arguments);
        element.attr('data-attendee-id', event.extendedProps.attendeeId);
    },
    /**
     * If an attendeeId has been set on the event, we check also the attendee-id attribute
     * to select the good event on which the CSS class will be applied.
     * @override
     */
    _computeEventSelector: function (info) {
        let selector = this._super(...arguments);
        if (info.event.extendedProps.attendeeId) {
            selector += `[data-attendee-id=${info.event.extendedProps.attendeeId}]`;
        }
        return selector;
    },
});

export default {
    AttendeeCalendarRenderer: AttendeeCalendarRenderer,
    AttendeeCalendarPopover: AttendeeCalendarPopover,
};
