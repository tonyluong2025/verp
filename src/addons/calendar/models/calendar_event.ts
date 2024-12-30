import ical, { ICalAlarm, ICalCalendarMethod } from 'ical-generator';
import _ from "lodash";
import { Command, Field, Fields, _Date, _Datetime, api, tools } from "../../../core";
import { _tzGet } from "../../../core/addons/base";
import { UserError, ValidationError } from "../../../core/helper";
import { MetaModel, Model, _super } from "../../../core/models";
import { AND } from "../../../core/osv/expression";
import { _f, allTimezones, bool, extend, floatRound, getLang, html2Text, isHtmlEmpty, len, next, pop, repeat, update } from "../../../core/tools";
import { addDate, dateSetTz, dateWithoutTz, diffDate, subDate, toFormat } from "../../../core/tools/date_utils";
import { STATE_SELECTION } from "./calendar_attendee";
import { BYDAY_SELECTION, END_TYPE_SELECTION, MONTH_BY_SELECTION, RRULE_TYPE_SELECTION, WEEKDAY_SELECTION, weekdayToField } from "./calendar_recurrence";

const SORT_ALIASES = {
  'start': 'sortStart',
  'startDate': 'sortStart',
}

/**
 *     :returns: ocurrence

    >>> getWeekdayOccurence(date(2019, 12, 17))
    3  # third Tuesday of the month

    >>> getWeekdayOccurence(date(2019, 12, 25))
    -1  # last Friday of the month

 * @param date 
 * @returns 
 */
function getWeekdayOccurence(date: Date) {
  const occurenceInMonth = Math.ceil(date.getDate() / 7);
  if ([4, 5].includes(occurenceInMonth)) { // fourth or fifth week on the month -> last
    return -1;
  }
  return occurenceInMonth;
}

@MetaModel.define()
class Meeting extends Model {
  static _module = module;
  static _name = 'calendar.event';
  static _description = "Calendar Event";
  static _order = "start desc";
  static _parents = ["mail.thread"];

  @api.model()
  async defaultGet(fields) {
    let self = this;
    // super default_model='crm.lead' for easier use in addons
    if (this.env.context['default_resModel'] && !this.env.context['default_resModelId']) {
      self = await this.withContext({
        default_resModelId: await this.env.items('ir.model')._getId(this.env.context['default_resModel'])
      });
    }

    const defaults = await _super(Meeting, self).defaultGet(fields);

    // support activeModel / activeId as replacement of default_* if not already given
    if (!('resModelId' in defaults) && 'resModelId' in fields &&
      self.env.context['activeModel'] && self.env.context['activeModel'] !== 'calendar.event') {
      defaults['resModelId'] = await self.env.items('ir.model')._getId(self.env.context['activeModel']);
      defaults['resModel'] = self.env.context['activeModel'];
    }
    if (!('resId' in defaults) && 'resId' in fields &&
      defaults['resModelId'] && self.env.context['activeId']) {
      defaults['resId'] = self.env.context['activeId'];
    }

    return defaults;
  }

  /**
   * When activeModel is res.partner, the current partners should be attendees
   * @returns 
   */
  @api.model()
  async _defaultPartners() {
    let partners = await (await this.env.user()).partnerId;
    const activeId = this._context['activeId'];
    if (this._context['activeModel'] === 'res.partner' && bool(activeId) && !partners.ids.includes(activeId)) {
      partners = partners.or(this.env.items('res.partner').browse(activeId));
    }
    return partners;
  }

  // description
  static label = Fields.Char('Meeting Subject', { required: true });
  static description = Fields.Html('Description');
  static userId = Fields.Many2one('res.users', { string: 'Organizer', default: self => self.env.user() });
  static partnerId = Fields.Many2one(
    'res.partner', { string: 'Scheduled by', related: 'userId.partnerId', readonly: true });
  static location = Fields.Char('Location', { tracking: true, help: "Location of Event" });
  static videocallLocation = Fields.Char('Meeting URL');
  // visibility
  static privacy = Fields.Selection(
    [['public', 'Public'],
    ['private', 'Private'],
    ['confidential', 'Only internal users']],
    {
      string: 'Privacy', default: 'public', required: true,
      help: "People to whom this event will be visible."
    });
  static showAs = Fields.Selection(
    [['free', 'Available'],
    ['busy', 'Busy']], {
    string: 'Show as', default: 'busy', required: true,
    help: "If the time is shown as 'busy', this event will be visible to other people with either the full \
        information or simply 'busy' written depending on its privacy. Use this option to let other people know \
        that you are unavailable during that period of time. \n If the event is shown as 'free', other users know \
        that you are available during that period of time."});
  static isHighlighted = Fields.Boolean(
    { compute: '_computeIsHighlighted', string: 'Is the Event Highlighted' });
  static isOrganizerAlone = Fields.Boolean({
    compute: '_computeIsOrganizerAlone', string: "Is the Organizer Alone",
    help: "Check if the organizer is alone in the event, i.e. if the organizer is the only one that hasn't declined \
        the event (only if the organizer is not the only attendee)"});
  // filtering
  static active = Fields.Boolean(
    'Active', {
    default: true,
    tracking: true,
    help: "If the active field is set to false, it will allow you to hide the event alarm information without removing it."
  });
  static categIds = Fields.Many2many(
    'calendar.event.type', { relation: 'meetingCategoryRel', column1: 'eventId', column2: 'typeId', string: 'Tags' });
  // timing
  static start = Fields.Datetime(
    'Start', {
    required: true, tracking: true, default: self => _Date.today(),
    help: "Start date of an event, without time for full days events"
  });
  static stop = Fields.Datetime(
    'Stop', {
    required: true, tracking: true, default: self => addDate(_Date.today(), { hours: 1 }),
    compute: '_computeStop', readonly: false, store: true,
    help: "Stop date of an event, without time for full days events"
  });
  static displayTime = Fields.Char('Event Time', { compute: '_computeDisplayTime' });
  static allday = Fields.Boolean('All Day', { default: false });
  static startDate = Fields.Date(
    'Start Date', {
    store: true, tracking: true,
    compute: '_computeDates', inverse: '_inverseDates'
  });
  static stopDate = Fields.Date(
    'End Date', {
    store: true, tracking: true,
    compute: '_computeDates', inverse: '_inverseDates'
  });
  static duration = Fields.Float('Duration', { compute: '_computeDuration', store: true, readonly: false });
  // linked document
  // LUL TODO use fields.Reference ?
  static resId = Fields.Integer('Document ID');
  static resModelId = Fields.Many2one('ir.model', { string: 'Document Model', ondelete: 'CASCADE' });
  static resModel = Fields.Char(
    'Document Model Name', { related: 'resModelId.model', readonly: true, store: true });
  // messaging
  static activityIds = Fields.One2many('mail.activity', 'calendarEventId', { string: 'Activities' });
  // attendees
  static attendeeIds = Fields.One2many('calendar.attendee', 'eventId', { string: 'Participant' });
  static attendeeStatus = Fields.Selection(
    STATE_SELECTION, { string: 'Attendee Status', compute: '_computeAttendee' });
  static partnerIds = Fields.Many2many(
    'res.partner', {
    relation: 'calendarEventResPartnerRel',
    string: 'Attendees', default: self => self._defaultPartners()
  });
  // alarms
  static alarmIds = Fields.Many2many(
    'calendar.alarm', {
    relation: 'calendarAlarmCalendarEventRel',
    string: 'Reminders', ondelete: "RESTRICT",
    help: "Notifications sent to all attendees to remind of the meeting."
  });
  // RECURRENCE FIELD
  static recurrency = Fields.Boolean('Recurrent');
  static recurrenceId = Fields.Many2one(
    'calendar.recurrence', { string: "Recurrence Rule", index: true });
  static followRecurrence = Fields.Boolean({ default: false }); // Indicates if an event follows the recurrence, i.e. is not an exception
  static recurrenceUpdate = Fields.Selection([
    ['selfOnly', "This event"],
    ['futureEvents', "This and following events"],
    ['allEvents', "All events"],
  ], {
    store: false, copy: false, default: 'selfOnly',
    help: "Choose what to do with other events in the recurrence. Updating All Events is not allowed when dates or time is modified"
  });
  // Those field are pseudo-related fields of recurrenceId.
  // They can't be "real" related fields because it should work at record creation
  // when recurrenceId is not created yet.
  // If some of these fields are set and recurrenceId does not exists,
  // a `calendar.recurrence.rule` will be dynamically created.
  static rrule = Fields.Char('Recurrent Rule', { compute: '_computeRecurrence', readonly: false });
  static rruleType = Fields.Selection(RRULE_TYPE_SELECTION, {
    string: 'Recurrence',
    help: "Let the event automatically repeat at that interval",
    compute: '_computeRecurrence', readonly: false
  });
  static eventTz = Fields.Selection(
    _tzGet, { string: 'Timezone', compute: '_computeRecurrence', readonly: false });
  static endType = Fields.Selection(
    END_TYPE_SELECTION, {
    string: 'Recurrence Termination',
    compute: '_computeRecurrence', readonly: false
  });
  static interval = Fields.Integer({
    string: 'Repeat Every', compute: '_computeRecurrence', readonly: false,
    help: "Repeat every (Days/Week/Month/Year)"
  });
  static count = Fields.Integer({
    string: 'Repeat', help: "Repeat x times", compute: '_computeRecurrence', readonly: false
  });
  static mon = Fields.Boolean({ compute: '_computeRecurrence', readonly: false });
  static tue = Fields.Boolean({ compute: '_computeRecurrence', readonly: false });
  static wed = Fields.Boolean({ compute: '_computeRecurrence', readonly: false });
  static thu = Fields.Boolean({ compute: '_computeRecurrence', readonly: false });
  static fri = Fields.Boolean({ compute: '_computeRecurrence', readonly: false });
  static sat = Fields.Boolean({ compute: '_computeRecurrence', readonly: false });
  static sun = Fields.Boolean({ compute: '_computeRecurrence', readonly: false });
  static monthBy = Fields.Selection(
    MONTH_BY_SELECTION, { string: 'Option', compute: '_computeRecurrence', readonly: false });
  static day = Fields.Integer('Date of month', { compute: '_computeRecurrence', readonly: false });
  static weekday = Fields.Selection(WEEKDAY_SELECTION, { compute: '_computeRecurrence', readonly: false });
  static byday = Fields.Selection(BYDAY_SELECTION, { compute: '_computeRecurrence', readonly: false });
  static until = Fields.Date({ compute: '_computeRecurrence', readonly: false });
  // UI Fields.
  static displayDescription = Fields.Boolean({ compute: '_computeDisplayDescription' });

  async _computeIsHighlighted() {
    if (this.env.context['activeModel'] === 'res.partner') {
      const partnerId = this.env.context['activeId'];
      for (const event of this) {
        if (bool(await (await event.partnerIds).filtered((s) => s.id == partnerId))) {
          await event.set('isHighlighted', true);
        }
        else {
          await event.set('isHighlighted', false);
        }
      }
    }
    else {
      for (const event of this) {
        await event.set('isHighlighted', false);
      }
    }
  }

  /**
   * Check if the organizer of the event is the only one who has accepted the event.
          It does not apply if the organizer is the only attendee of the event because it
          would represent a personnal event.
          The goal of this field is to highlight to the user that the others attendees are
          not available for this event.
   */
  @api.depends('partnerId', 'attendeeIds')
  async _computeIsOrganizerAlone() {
    for (const event of this) {
      const organizer = await (await event.attendeeIds).filtered(async (a) => (await a.partnerId).eq(await event.partnerId));
      const allDeclined = ! await (await event.attendeeIds).sub(organizer).some(async (a) => await a.state !== 'declined');
      await event.set('isOrganizerAlone', len(await event.attendeeIds) > 1 && allDeclined);
    }
  }

  async _computeDisplayTime() {
    for (const meeting of this) {
      const [start, stop, duration, allday] = await meeting('start', 'stop', 'duration', 'allday');
      await meeting.set('displayTime', await this._getDisplayTime(start, stop, duration, allday));
    }
  }

  /**
   * Adapt the value of startDate(time)/stopDate(time)
          according to start/stop fields and allday. Also, compute
          the duration for not allday meeting ; otherwise the
          duration is set to zero, since the meeting last all the day.
   */
  @api.depends('allday', 'start', 'stop')
  async _computeDates() {
    for (const meeting of this) {
      const [start, stop, allday] = await meeting('start', 'stop', 'allday');
      if (allday && start && stop) {
        await meeting.set('startDate', _Date.today(start));
        await meeting.set('stopDate', _Date.today(stop));
      }
      else {
        await meeting.set('startDate', false);
        await meeting.set('stopDate', false);
      }
    }
  }

  @api.depends('stop', 'start')
  async _computeDuration() {
    for (const event of this) {
      const [start, stop] = await event('start', 'stop');
      await event.set('duration', await this._getDuration(start, stop));
    }
  }

  @api.depends('start', 'duration')
  async _computeStop() {
    // stop and duration fields both depends on the start field.
    // But they also depends on each other.
    // When start is updated, we want to update the stop datetime based on
    // the *current* duration. In other words, we want: change start => keep the duration fixed and
    // recompute stop accordingly.
    // However, while computing stop, duration is marked to be recomputed. Calling `event.duration` would trigger
    // its recomputation. To avoid this we manually mark the field as computed.
    const durationField = this._fields['duration'];
    this.env.removeToCompute(durationField, this);
    for (const event of this) {
      // Round the duration (in hours) to the minute to avoid weird situations where the event
      // stops at 4:19:59, later displayed as 4:19.
      const [start, stop, duration, allday] = await event('start', 'stop', 'duration', 'allday');
      await event.set('stop', start && addDate(start, { minutes: Math.round((duration || 1.0) * 60) }));
      if (allday) {
        await event.set('stop', subDate(stop, { seconds: 1 }));
      }
    }
  }

  /**
   * This method is used to set the start and stop values of all day events.
          The calendar view needs dateStart and dateStop values to display correctly the allday events across
          several days. As the user edit the {start,stop}_date fields when allday is true,
          this inverse method is needed to update the  start/stop value and have a relevant calendar view.
   */
  async _inverseDates() {
    for (const meeting of this) {
      if (await meeting.allday) {
        // Convention break:
        // stop and start are NOT in UTC in allday event
        // in this case, they actually represent a date
        // because fullcalendar just drops times for full day events.
        // i.e. Christmas is on 25/12 for everyone
        // even if people don't celebrate it simultaneously
        let enddate = _Datetime.toDatetime(await meeting.stopDate) as Date;
        enddate.setHours(18);

        const startdate = _Datetime.toDatetime(await meeting.startDate) as Date;
        startdate.setHours(8);  // Set 8 AM

        await meeting.write({
          'start': dateWithoutTz(startdate),
          'stop': dateWithoutTz(enddate)
        });
      }
    }
  }

  async _computeAttendee() {
    for (const meeting of this) {
      const attendee = await meeting._findAttendee();
      await meeting.set('attendeeStatus', bool(attendee) ? await attendee.state : 'needsAction');
    }
  }

  @api.constrains('start', 'stop', 'startDate', 'stopDate')
  async _checkClosingDate() {
    for (const meeting of this) {
      const [label, allday, start, stop, startDate, stopDate] = await meeting('label', 'allday', 'start', 'stop', 'startDate', 'stopDate');
      if (!allday && start && stop && stop < start) {
        throw new ValidationError(
          await this._t('The ending date and time cannot be earlier than the starting date and time.') + '\n' +
          _f(await this._t("Meeting '{label}' starts '{startDatetime}' and ends '{endDatetime}'"), {
            label: label,
            startDatetime: start,
            endDatetime: stop
          })
        )
      }
      if (allday && startDate && stopDate && stopDate < startDate) {
        throw new ValidationError(
          await this._t('The ending date cannot be earlier than the starting date.') + '\n' +
          _f(await this._t("Meeting '{label}' starts '{startDatetime}' and ends '{endDatetime}'"), {
            label: label,
            startDatetime: start,
            endDatetime: stop
          })
        )
      }
    }
  }

  @api.depends('recurrenceId', 'recurrency')
  async _computeRecurrence() {
    const recurrenceFields = await this._getRecurrentFields();
    const falseValues = Object.fromEntries(recurrenceFields.map(field => [field, false]));  // computes need to set a value
    const defaults = await this.env.items('calendar.recurrence').defaultGet(recurrenceFields);
    const defaultRruleValues = await (await this['recurrenceId']).defaultGet(recurrenceFields);
    for (const event of this) {
      if (await event.recurrency) {
        await event.update(defaults);  // default recurrence values are needed to correctly compute the recurrence params
        const eventValues = await event._getRecurrenceParams();
        const recurrence = await event.recurrenceId;
        let rruleValues = {}
        for (const field of recurrenceFields) {
          if (await recurrence[field]) {
            rruleValues[field] = await recurrence[field];
          }
        }
        rruleValues = bool(rruleValues) ? rruleValues : defaultRruleValues;
        await event.update({ ...falseValues, ...eventValues, ...rruleValues });
      }
      else {
        await event.update(falseValues);
      }
    }
  }

  @api.depends('description')
  async _computeDisplayDescription() {
    for (const event of this) {
      await event.set('displayDescription', !isHtmlEmpty(await event.description));
    }
  }

  // CRUD

  @api.modelCreateMulti()
  async create(valsList: {}[]) {
    // Prevent sending update notification when _inverseDates is called
    let self = await this.withContext({ isCalendarEventNew: true });
    const user = await self.env.user();
    valsList = valsList.map(vals => !('userId' in vals) ? Object.assign({}, vals, { userId: user.id }) : vals);

    const defaults = await self.defaultGet(['activityIds', 'resModelId', 'resId', 'userId', 'resModel', 'partnerIds']);
    const meetingActivityType = await self.env.items('mail.activity.type').search([['category', '=', 'meeting']], { limit: 1 });
    // get list of models ids and filter out None values directly
    const modelIds = valsList.map(values => values['resModelId'] ?? defaults['resModelId']).filter(val => val);
    const modelName = defaults.get('resModel');
    const validActivityModelIds = modelName && (await (await self.env.items(modelName).sudo()).browse(modelIds).filtered(m => 'activityIds' in m._fields)).ids || [];
    if (meetingActivityType && !defaults.get('activityIds')) {
      for (const values of valsList) {
        // created from calendar: try to create an activity on the related record
        if (values['activityIds']) {
          continue;
        }
        const resModelId = values['resModelId'] ?? defaults.get('resModelId');
        const resId = values['resId'] ?? defaults.get('resId');
        const userId = values['userId'] ?? defaults.get('userId');
        if (!bool(resModelId) || !bool(resId)) {
          continue;
        }
        if (!validActivityModelIds.includes(resModelId)) {
          continue;
        }
        const activityVals = {
          'resModelId': resModelId,
          'resId': resId,
          'activityTypeId': meetingActivityType.id,
        }
        if (bool(userId)) {
          activityVals['userId'] = userId;
        }
        values['activityIds'] = [[0, 0, activityVals]];
      }
    }

    // Add commands to create attendees from partners (if present) if no attendee command
    // is already given (coming from Google event for example).
    // Automatically add the current partner when creating an event if there is none (happens when we quickcreate an event)
    const defaultPartnersIds = defaults.get('partnerIds') || [[4, (await user.partnerId).id]];
    valsList = await Promise.all(valsList.map(async (vals) => !vals['attendeeIds'] ? Object.assign({}, vals, { attendeeIds: await self._attendeesValues(vals['partnerIds'] ?? defaultPartnersIds) }) : vals));
    const recurrenceFields = await self._getRecurrentFields();
    const recurringVals = valsList.filter(vals => vals['recurrency']);
    const otherVals = valsList.filter(vals => !vals['recurrency']);
    let events = await _super(Meeting, self).create(otherVals);

    for (const vals of recurringVals) {
      vals['followRecurrence'] = true;
    }
    const recurringEvents = await _super(Meeting, self).create(recurringVals);
    events = events.add(recurringEvents);

    for (const [event, vals] of _.zip([...recurringEvents], [...recurringVals])) {
      const recurrenceValues = Object.fromEntries(recurrenceFields.filter(field => field in vals).map(field => [field, pop(vals, field)]));
      if (vals['recurrency']) {
        const detachedEvents = await event._applyRecurrenceValues(recurrenceValues);
        await detachedEvents.set('active', false);
      }
    }
    await (await (await events.filtered(async (event) => await event.start > _Datetime.now())).attendeeIds)._sendMailToAttendees(
      await self.env.ref('calendar.calendarTemplateMeetingInvitation', false)
    )
    await events._syncActivities(valsList.reduce((pre: string[], vals) => pre.concat(Object.keys(vals)), []));
    if (!self.env.context['dontNotify']) {
      await events._setupAlarms();
    }

    return events.withContext({ isCalendarEventNew: false });
  }

  async _computeFieldValue(field: Field) {
    if (field.computeSudo) {
      return _super(Meeting, await this.withContext({ prefetchFields: false }))._computeFieldValue(field);
    }
    return _super(Meeting, this)._computeFieldValue(field);
  }

  async _read(fields: string[] = []) {
    if (await this.env.isSystem()) {
      await _super(Meeting, this)._read(fields);
      return;
    }

    // fields = set(fields)
    const privateFields = _.difference(fields, await this._getPublicFields());
    if (!privateFields.length) {
      await _super(Meeting, this)._read(fields);
      return;
    }

    privateFields.push('partnerIds');
    await _super(Meeting, this)._read(_.union(fields, ['privacy', 'userId', 'partnerIds']));
    const user = await this.env.user();
    const currentPartnerId = await user.partnerId;
    const othersPrivateEvents = await this.filtered(
      async (e) => await e.privacy === 'private'
        && !(await e.userId).eq(user)
        && !(await e.partnerIds).includes(currentPartnerId)
    );
    if (!bool(othersPrivateEvents)) {
      return;
    }

    for (const fieldName of privateFields) {
      const field = this._fields[fieldName];
      const replacement = await field.convertToCache(
        fieldName === 'label' ? await this._t('Busy') : false,
        othersPrivateEvents);
      this.env.cache.update(othersPrivateEvents, field, repeat(replacement)); // Tony check
    }
  }

  async write(values) {
    let detachedEvents = this.env.items('calendar.event');
    const recurrenceUpdateSetting = pop(values, 'recurrenceUpdate', null);
    const updateRecurrence = ['allEvents', 'futureEvents'].includes(recurrenceUpdateSetting) && len(this) == 1;
    const breakRecurrence = values['recurrency'] == false;

    let updateAlarms = false;
    let updateTime = false;
    if ('partnerIds' in values) {
      values['attendeeIds'] = await this._attendeesValues(values['partnerIds']);
      updateAlarms = true;
    }

    const timeFields = await this.env.items('calendar.event')._getTimeFields();
    if (timeFields.some(key => values[key])) {
      updateAlarms = true;
      updateTime = true;
    }
    if ('alarmIds' in values) {
      updateAlarms = true;
    }

    if ((!recurrenceUpdateSetting || recurrenceUpdateSetting === 'selfOnly' && len(this) == 1) && !('followRecurrence' in values)) {
      // if any({field: values[field] for field in timeFields if field in values}):
      if (timeFields.some(field => field in values)) {
        values['followRecurrence'] = false;
      }
    }
    const previousAttendees = await this['attendeeIds'];

    const recurrenceValues = Object.fromEntries((await this._getRecurrentFields()).filter(field => field in values).map(field => [field, pop(values, field)]));
    if (updateRecurrence) {
      if (breakRecurrence) {
        // Update this event
        detachedEvents = detachedEvents.or(await this._breakRecurrence(recurrenceUpdateSetting == 'futureEvents'));
      }
      else {
        const futureUpdateStart = recurrenceUpdateSetting === 'futureEvents' ? await this['start'] : null;
        const timeValues = Object.fromEntries(timeFields.filter(field => field in values).map(field => [field, pop(values, field)]));
        if (recurrenceUpdateSetting === 'allEvents') {
          // Update all events: we create a new reccurrence and dismiss the existing events
          await this._rewriteRecurrence(values, timeValues, recurrenceValues);
        }
        else {
          // Update future events
          detachedEvents = detachedEvents.or(await this._splitRecurrence(timeValues));
          await (await this['recurrenceId'])._writeEvents(values, futureUpdateStart);
        }
      }
    }
    else {
      await _super(Meeting, this).write(values);
      await this._syncActivities(Object.keys(values));
    }
    // We reapply recurrence for future events and when we add a rrule and 'recurrency' == True on the event
    if (!['selfOnly', 'allEvents'].includes(recurrenceUpdateSetting) && !breakRecurrence) {
      detachedEvents = detachedEvents.or(await this._applyRecurrenceValues(recurrenceValues, recurrenceUpdateSetting === 'futureEvents'));
    }

    await detachedEvents.and(this).set('active', false);
    await (await detachedEvents.sub(this).withContext({ archiveOnError: true })).unlink();

    // Notify attendees if there is an alarm on the modified event, or if there was an alarm
    // that has just been removed, as it might have changed their next event notification
    if (!this.env.context['dontNotify'] && updateAlarms) {
      await this._setupAlarms();
    }
    const attendeeUpdateEvents = await this.filtered(async (ev) => !(await ev.userId).eq(await this.env.user()));
    if (updateTime && bool(attendeeUpdateEvents)) {
      // Another user update the event time fields. It should not be auto accepted for the organizer.
      // This prevent weird behavior when a user modified future events time fields and
      // the base event of a recurrence is accepted by the organizer but not the following events
      await (await (await attendeeUpdateEvents.attendeeIds).filtered(async (att) => (await (await this['userId']).partnerId).eq(await att.partnerId))).write({ 'state': 'needsAction' });
    }

    const currentAttendees = await (await this.filtered('active')).attendeeIds;
    if ('partnerIds' in values) {
      // we send to all partners and not only the new ones
      await currentAttendees.sub(previousAttendees)._sendMailToAttendees(
        await this.env.ref('calendar.calendarTemplateMeetingInvitation', false)
      );
    }
    if (!this.env.context['isCalendarEventNew'] && 'start' in values) {
      const startDate = _Datetime.toDatetime(values['start']);
      // Only notify on future events
      if (startDate && startDate >= _Datetime.now()) {
        await (await currentAttendees.and(previousAttendees).withContext({
          calendarTemplateIgnoreRecurrence: !updateRecurrence
        }))._sendMailToAttendees(
          await this.env.ref('calendar.calendarTemplateMeetingChangedate', false)
        );
      }
    }
    return true;
  }

  /**
   * Hide private events' name for events which don't belong to the current user
   */
  async nameGet() {
    const hidden = await this.filtered(
      async (evt) =>
        await evt.privacy === 'private' &&
        (await evt.userId).id != this.env.uid &&
        !(await evt.partnerIds).includes(await (await this.env.user()).partnerId)
    )

    const shown = this.sub(hidden);
    const shownNames = await _super(Meeting, shown).nameGet();
    const obfuscatedNames = await Promise.all(hidden.ids.map(async (eid) => [eid, await this._t('Busy')]));
    return shownNames.concat(obfuscatedNames);
  }

  @api.model()
  async readGroup(domain, fields, groupby, options: { offset?: number, limit?: number, orderby?: any, lazy?: boolean } = {}) {
    options.lazy = options.lazy ?? true;
    groupby = typeof (groupby) === 'string' ? [groupby] : groupby;
    const groupedFields = groupby.map(groupField => groupField.split(':')[0]);
    const privateFields = _.difference<string>(groupedFields, await this._getPublicFields());
    if (!this.env.su && privateFields.length) {
      // display public and confidential events
      const user = await this.env.user();
      domain = AND([domain, ['|', ['privacy', '!=', 'private'], ['userId', '=', user.id]]]);
      await this.env.items('bus.bus')._sendone(await user.partnerId, 'simpleNotification', {
        'title': await this._t('Private Event Excluded'),
        'message': await this._t('Grouping by %s is not allowed on private events.', privateFields.map(fieldName => this._fields[fieldName].string).join(','))
      })
      return _super(Meeting, this).readGroup(domain, fields, groupby, options);
    }
    return _super(Meeting, this).readGroup(domain, fields, groupby, options);
  }

  async unlink() {
    // Get concerned attendees to notify them if there is an alarm on the unlinked events,
    // as it might have changed their next event notification
    const events = await this.filteredDomain([['alarmIds', '!=', false]]);
    const partnerIds = (await events.mapped('partnerIds')).ids;

    // don't forget to update recurrences if there are some base events in the set to unlink,
    // but after having removed the events ;-)
    const recurrences = await this.env.items("calendar.recurrence").search([
      ['baseEventId.id', 'in', await this.map(e => e.id)]
    ]);

    const result = await _super(Meeting, this).unlink();

    if (bool(recurrences)) {
      await recurrences._selectNewBaseEvent();
    }
    // Notify the concerned attendees (must be done after removing the events)
    await this.env.items('calendar.alarm.manager')._notifyNextAlarm(partnerIds);
    return result;
  }

  /**
   * When an event is copied, the attendees should be recreated to avoid sharing the same attendee records
       between copies
   * @param defaultValues 
   */
  async copy(defaultValues?: any) {
    this.ensureOne();
    if (!defaultValues) {
      defaultValues = {};
    }
    // We need to make sure that the attendeeIds are recreated with new ids to avoid sharing attendees between events
    // The copy should not have the same attendee status than the original event
    update(defaultValues, { partnerIds: [Command.set([])], attendeeIds: [Command.set([])] });
    const copiedEvent = await _super(Meeting, this).copy(defaultValues);
    await copiedEvent.write({ 'partnerIds': [[Command.set((await this['partnerIds']).ids)]] });
    return copiedEvent;
  }

  /**
   * :param partnerCommands: ORM commands for partnerId field (0 and 1 commands not supported)
      :return: associated attendeeIds ORM commands
   * @param partnerCommands 
   * @returns 
   */
  async _attendeesValues(partnerCommands) {
    let attendeeCommands = [];
    let removedPartnerIds = [];
    let addedPartnerIds = [];
    const ids = (await this['partnerIds']).ids;
    for (const command of partnerCommands) {
      const op = command[0];
      if ([2, 3].includes(op)) {  // Remove partner
        extend(removedPartnerIds, [command[1]]);
      }
      else if (op == 6) {  // Replace all
        extend(removedPartnerIds, _.difference(ids, command[2]));  // Don't recreate attendee if partner already attend the event
        extend(addedPartnerIds, _.difference(command[2], ids));
      }
      else if (op == 4) {
        extend(addedPartnerIds, !ids.includes(command[1]) ? [command[1]] : []);
      }
      // commands 0 and 1 not supported
    }

    let attendeesToUnlink;
    if (!this.ok) {
      attendeesToUnlink = this.env.items('calendar.attendee');
    }
    else {
      attendeesToUnlink = await this.env.items('calendar.attendee').search([
        ['eventId', 'in', this.ids],
        ['partnerId', 'in', removedPartnerIds],
      ]);
    }
    extend(attendeeCommands, await attendeesToUnlink.map(attendee => [2, attendee.id]));  // Removes and delete  
    extend(attendeeCommands, addedPartnerIds.map(partnerId => [0, 0, { partnerId: partnerId }]));
    return attendeeCommands;
  }

  // ACTIONS

  async actionOpenCalendarEvent() {
    const [resModel, resId] = await this('resModel', 'resId');
    if (resModel && resId) {
      return this.env.items(resModel).browse(resId).getFormviewAction();
    }
    return false;
  }

  async actionSendmail() {
    const email = await (await this.env.user()).email;
    if (email) {
      for (const meeting of this) {
        await (await meeting.attendeeIds)._sendMailToAttendees(
          await this.env.ref('calendar.calendarTemplateMeetingInvitation', false)
        );
      }
    }
    return true;
  }

  async actionOpenComposer() {
    if (!bool(this['partnerIds'])) {
      throw new UserError(await this._t("There are no attendees on these events"));
    }
    const templateId = await this.env.items('ir.model.data')._xmlidToResId('calendar.calendarTemplateMeetingUpdate', false);
    // The mail is sent with datetime corresponding to the sending user TZ
    const compositionMode = this.env.context['compositionMode'] ?? 'comment';
    const composeCtx = {
      default_compositionMode: compositionMode,
      default_model: 'calendar.event',
      default_resIds: this.ids,
      default_useTemplate: bool(templateId),
      default_templateId: templateId,
      default_partnerIds: (await this['partnerIds']).ids,
      mailTz: await (await this.env.user()).tz,
    };
    return {
      'type': 'ir.actions.actwindow',
      'label': await this._t('Contact Attendees'),
      'viewMode': 'form',
      'resModel': 'mail.compose.message',
      'views': [[false, 'form']],
      'viewId': false,
      'target': 'new',
      'context': composeCtx,
    }
  }

  /**
   * Method used when an existing user wants to join
   * @param partnerId 
   */
  async actionJoinMeeting(partnerId) {
    this.ensureOne();
    const partner = this.env.items('res.partner').browse(partnerId);
    if (!(await this['partnerIds']).includes(partner)) {
      await this.write({ 'partnerIds': [[4, partner.id]] });
    }
  }

  async actionMassDeletion(recurrenceUpdateSetting) {
    this.ensureOne();
    if (recurrenceUpdateSetting === 'allEvents') {
      const events = await (await this['recurrenceId']).calendarEventIds;
      await (await this['recurrenceId']).unlink();
      await events.unlink();
    }
    else if (recurrenceUpdateSetting === 'futureEvents') {
      const futureEvents = await (await (await this['recurrenceId']).calendarEventIds).filtered(async (ev) => await ev.start >= await this['start']);
      await futureEvents.unlink();
    }
  }

  /**
   * The aim of this action purpose is to be called from sync calendar module when mass deletion is not possible.
   * @param recurrenceUpdateSetting 
   */
  async actionMassArchive(recurrenceUpdateSetting) {
    this.ensureOne();
    if (recurrenceUpdateSetting === 'allEvents') {
      await (await (await this['recurrenceId']).calendarEventIds).write({ 'active': false });
    }
    else if (recurrenceUpdateSetting === 'futureEvents' && bool(await this['recurrenceId'])) {
      const detachedEvents = await (await this['recurrenceId'])._stopAt(this);
      await detachedEvents.write({ 'active': false });
    }
  }

  // MAILING

  /**
   * Get comma-separated attendee email addresses.
   * @returns 
   */
  async _getAttendeeEmails() {
    this.ensureOne();
    return (await (await this['attendeeIds']).mapped("email")).filter(e => e).join(',');
  }

  async _getMailTz() {
    this.ensureOne();
    return await this['eventTz'] || await (await this.env.user()).tz;
  }

  async _syncActivities(fields) {
    // update activities
    for (const event of this) {
      if (bool(await event.activityIds)) {
        const activityValues = {}
        if (fields.incudes('label')) {
          activityValues['summary'] = await event.label;
        }
        if (fields.includes('description')) {
          activityValues['note'] = await event.description;
        }
        if (fields.includes('start')) {
          // self.start is a datetime UTC *only when the event is not allday*
          // activty.dateDeadline is a date (No TZ, but should represent the day in which the user's TZ is)
          // See 72254129dbaeae58d0a2055cba4e4a82cde495b7 for the same issue, but elsewhere
          let deadline = await event.start;
          const userTz = this.env.context['tz'];
          if (userTz && ! await event.allday) {
            deadline = dateSetTz(deadline, userTz);
          }
          activityValues['dateDeadline'] = _Date.today(deadline);
        }
        if (fields.includes('userId')) {
          activityValues['userId'] = (await event.userId).id;
        }
        if (len(activityValues)) {
          await (await event.activityIds).write(activityValues);
        }
      }
    }
  }

  // ALARMS

  async _getTriggerAlarmTypes() {
    return ['email'];
  }

  /**
   * Schedule cron triggers for future events
   * @returns 
   */
  async _setupAlarms() {
    const cron = await (await this.env.ref('calendar.irCronSchedulerAlarm')).sudo();
    const alarmTypes = await this._getTriggerAlarmTypes();
    let eventsToNotify = this.env.items('calendar.event');

    for (const event of this) {
      for (const alarm of await (await event.alarmIds).filter(async (alarm) => alarmTypes.includes(await alarm.alarmType))) {
        const at = subDate(await event.start, { minutes: await alarm.durationMinutes });
        if (! await cron.lastcall || at > await cron.lastcall) {
          // Don't trigger for past alarms, they would be skipped by design
          await cron._trigger(at);
        }
      }
      if (await (await event.alarmIds).all(async (alarm) => await alarm.alarmType === 'notification')) {
        // filter events before notifying attendees through calendarAlarmManager
        eventsToNotify = eventsToNotify.or(await event.filtered(async (ev) => bool(await ev.alarmIds) && await ev.stop >= _Datetime.now()));
      }
    }
    if (bool(eventsToNotify)) {
      await this.env.items('calendar.alarm.manager')._notifyNextAlarm((await eventsToNotify.partnerIds).ids);
    }
  }

  // RECURRENCY

  /**
   * Apply the new recurrence rules in `values`. Create a recurrence if it does not exist
      and create all missing events according to the rrule.
      If the changes are applied to future
      events only, a new recurrence is created with the updated rrule.
 
      :param values: new recurrence values to apply
      :param future: rrule values are applied to future events only if True.
                     Rrule changes are applied to all events in the recurrence otherwise.
                     (ignored if no recurrence exists yet).
      :return: events detached from the recurrence
   * @param values 
   * @param future 
   * @returns 
   */
  async _applyRecurrenceValues(values, future: boolean = true) {
    if (!bool(values)) {
      return this.browse();
    }
    let recurrenceVals = [];
    let toUpdate = this.env.items('calendar.recurrence');
    for (const event of this) {
      if (!bool(await event.recurrenceId)) {
        extend(recurrenceVals, [Object.assign({}, values, { baseEventId: event.id, calendarEventIds: [[4, event.id]] })]);
      }
      else if (future) {
        toUpdate = toUpdate.or(await (await event.recurrenceId)._splitFrom(event, values));
      }
    }
    await this.write({ 'recurrency': true, 'followRecurrence': true });
    toUpdate = toUpdate.or(await this.env.items('calendar.recurrence').create(recurrenceVals));
    return toUpdate._applyRecurrence();
  }

  async _getRecurrenceParams() {
    if (!this.ok) {
      return {};
    }
    const eventDate = await this._getStartDate();
    const weekdayFieldName = weekdayToField(eventDate.getDay() - 1);
    return {
      weekdayFieldName: true,
      'weekday': weekdayFieldName.toUpperCase(),
      'byday': String(getWeekdayOccurence(eventDate)),
      'day': eventDate.getDate(),
    }
  }

  /**
   * Apply time changes to events and update the recurrence accordingly.
 
      :return: detached events
   * @param timeValues 
   * @returns 
   */
  async _splitRecurrence(timeValues) {
    this.ensureOne()
    if (!bool(timeValues)) {
      return this.browse();
    }
    let previousWeekDayField;
    if (await this['followRecurrence'] && await this['recurrency']) {
      previousWeekDayField = weekdayToField((await this._getStartDate()).getDay() - 1);
    }
    else {
      // When we try to change recurrence values of an event not following the recurrence, we get the parameters from
      // the baseEvent
      previousWeekDayField = weekdayToField(await (await (await (await this['recurrenceId']).baseEventId)._getStartDate()).weekday());
    }
    await this.write(timeValues);
    return this._applyRecurrenceValues({
      [previousWeekDayField]: false,
      ...await this._getRecurrenceParams(),
    }, true);
  }

  /**
   * Breaks the event's recurrence.
      Stop the recurrence at the current event if `future` is True, leaving past events in the recurrence.
      If `future` is False, all events in the recurrence are detached and the recurrence itself is unlinked.
      :return: detached events excluding the current events
   * @param future 
   * @returns 
   */
  async _breakRecurrence(future: boolean = true) {
    let recurrencesToUnlink = this.env.items('calendar.recurrence');
    let detachedEvents = this.env.items('calendar.event');
    for (const event of this) {
      const recurrence = await event.recurrenceId;
      if (future) {
        detachedEvents = detachedEvents.or(await recurrence._stopAt(event));
      }
      else {
        detachedEvents = detachedEvents.or(await recurrence.calendarEventIds);
        await (await recurrence.calendarEventIds).set('recurrenceId', false);
        recurrencesToUnlink = recurrencesToUnlink.or(recurrence);
      }
    }
    await (await recurrencesToUnlink.withContext({ archiveOnError: true })).unlink();
    return detachedEvents.sub(this);
  }

  /**
   * Recreate the whole recurrence when all recurrent events must be moved
      timeValues corresponds to date times for one specific event. We need to update the baseEvent of the recurrence
      and reapply the recurrence later. All exceptions are lost.
   * @param values 
   * @param timeValues 
   * @param recurrenceValues 
   */
  async _rewriteRecurrence(values, timeValues, recurrenceValues) {
    this.ensureOne();
    const baseEvent = await (await this['recurrenceId']).baseEventId;
    if (!bool(baseEvent)) {
      throw new UserError(await this._t("You can't update a recurrence without base event."));
    }
    const [baseTimeValues] = await baseEvent.read(['start', 'stop', 'allday']);
    const updateDict = {}
    const startUpdate = _Datetime.toDatetime(timeValues['start']) as Date;
    const stopUpdate = _Datetime.toDatetime(timeValues['stop']) as Date;
    // Convert the baseEventId hours according to new values: time shift
    if (startUpdate || stopUpdate) {
      if (startUpdate) {
        const start = addDate(baseTimeValues['start'], diffDate(startUpdate, await this['start']));
        const stop = addDate(baseTimeValues['stop'], diffDate(startUpdate, this['start']));
        const startDate = addDate(_Date.today(baseTimeValues['start']), diffDate(_Date.today(startUpdate), _Date.today(await this['start'])));
        const stopDate = addDate(_Date.today(baseTimeValues['stop']), diffDate(_Date.today(startUpdate), _Date.today(await this['start'])));
        update(updateDict, { 'start': start, 'startDate': startDate, 'stop': stop, 'stopDate': stopDate });
      }
      if (stopUpdate) {
        if (!startUpdate) {
          // Apply the same shift for start
          const start = addDate(baseTimeValues['start'], diffDate(stopUpdate, await this['stop']));
          const startDate = addDate(_Date.today(baseTimeValues['start']), diffDate(_Date.today(stopUpdate), _Date.today(await this['stop'])));
          update(updateDict, { 'start': start, 'startDate': startDate });
        }
        const stop = addDate(baseTimeValues['stop'], diffDate(stopUpdate, await this['stop']));
        const stopDate = addDate(_Date.today(baseTimeValues['stop']), diffDate(_Date.today(stopUpdate), _Date.today(await this['stop'])));
        update(updateDict, { 'stop': stop, 'stopDate': stopDate });
      }
    }
    update(timeValues, updateDict);
    if (bool(timeValues) || bool(recurrenceValues)) {
      const recFields = await this._getRecurrentFields();
      const [recVals] = await baseEvent.read(recFields);
      const oldRecurrenceValues = Object.fromEntries(recFields.filter(field => field in recVals).map(field => [field, pop(recVals, field)]));
      await baseEvent.write({ ...values, ...timeValues });
      // Delete all events except the base event and the currently modified
      const expandableEvents = (await (await this['recurrenceId']).calendarEventIds).sub((await (await this['recurrenceId']).baseEventId).add(this));
      await (await (await this['recurrenceId']).withContext({ archiveOnError: true })).unlink();
      await (await expandableEvents.withContext({ archiveOnError: true })).unlink();
      // Make sure to recreate a new recurrence. Needed to prevent sync issues
      await baseEvent.set('recurrenceId', false);
      // Recreate all events and the recurrence: override updated values
      const newValues = {
        ...oldRecurrenceValues,
        ...await baseEvent._getRecurrenceParams(),
        ...recurrenceValues,
      }
      pop(newValues, 'rrule');
      const detachedEvents = await baseEvent._applyRecurrenceValues(newValues);
      await detachedEvents.write({ 'active': false });
      // archive the current event if all the events were recreated
      if (this.ne(await (await this['recurrenceId']).baseEventId) && bool(timeValues)) {
        await this.set('active', false);
      }
    }
    else {
      // Write on all events. Carefull, it could trigger a lot of noise to Google/Microsoft...
      await (await this['recurrenceId'])._writeEvents(values);
    }
  }

  // MANAGEMENT

  async changeAttendeeStatus(status, recurrenceUpdateSetting) {
    this.ensureOne();
    let events;
    if (recurrenceUpdateSetting === 'allEvents') {
      events = await (await this['recurrenceId']).calendarEventIds;
    }
    else if (recurrenceUpdateSetting === 'futureEvents') {
      events = await (await (await this['recurrenceId']).calendarEventIds).filtered(async (ev) => await ev.start >= await this['start']);
    }
    else {
      events = this;
    }
    const attendee = await (await events.attendeeIds).filtered(async (x) => (await x.partnerId).eq(await (await this.env.user()).partnerId));
    if (status === 'accepted') {
      const allEvents = recurrenceUpdateSetting === 'allEvents';
      return (await attendee.withContext({ allEvents: allEvents })).doAccept();
    }
    if (status === 'declined') {
      return attendee.doDecline();
    }
    return attendee.doTentative();
  }

  async findPartnerCustomer() {
    this.ensureOne();
    const partnerId = await (await this['userId']).partnerId;
    return next(
      await (await (await (await this['attendeeIds']).sorted('createdAt'))
        .filtered(async (attendee) => (await attendee.partnerId).ne(partnerId)))
        .map(async (attendee) => attendee.partnerId),
      this.env.items('calendar.attendee')
    );
  }

  // TOOLS

  /**
   * Return the first attendee where the user connected has been invited
          or the attendee selected in the filter that is the owner
          from all the meetingIds in parameters.
   * @returns 
   */
  async _findAttendee() {
    this.ensureOne();
    const user = await this.env.user();
    const userPartner = await user.partnerId;
    const [partner, attendeeIds] = await this('partnerId', 'attendeeIds');
    const myAttendee = await attendeeIds.filtered(async (att) => (await att.partnerId).eq(userPartner));
    if (myAttendee) {
      return myAttendee.slice(0, 1);
    }
    const eventCheckedAttendees = await (await this.env.items('calendar.filters').search([
      ['userId', '=', user.id],
      ['partnerId', 'in', (await attendeeIds.partnerId).ids],
      ['partnerChecked', '=', true]
    ])).mapped('partnerId');
    if (eventCheckedAttendees.includes(partner) && (await attendeeIds.partnerId).includes(partner)) {
      return (await attendeeIds.filtered(async (att) => (await att.partnerId).eq(partner))).slice(0, 1);
    }
    const attendee = await attendeeIds.filtered(async (att) => eventCheckedAttendees.includes(await att.partnerId) && await att.state !== "needsAction");
    return attendee.slice(0, 1);
  }

  /**
   * Return the event starting date in the event's timezone.
      If no starting time is assigned (yet), return today as default
      :return: date
   * @returns 
   */
  async _getStartDate() {
    let start = await this['start'];
    if (!start) {
      return _Date.today();
    }
    if (await this['recurrency'] && await this['eventTz']) {
      const tz = allTimezones.includes(await this['eventTz']) ? await this['eventTz'] : false;
      // Ensure that all day events date are not calculated around midnight. TZ shift would potentially return bad date
      if (await this['allday']) {
        start.setHours(12);
      }
      return _Date.today(dateSetTz(start, tz));
    }
    return _Date.today(start);
  }

  async _range() {
    this.ensureOne();
    return this('start', 'stop');
  }

  /**
   * get the displayTime of the meeting, forcing the timezone. This method is called from email template, to not use sudo().
   * @param tz 
   * @returns 
   */
  async getDisplayTimeTz(tz: boolean = false) {
    this.ensureOne();
    let self = this;
    if (tz) {
      self = await self.withContext({ tz: tz });
    }
    const [start, stop, duration, allday] = await this('start', 'stop', 'duration', 'allday');
    return self._getDisplayTime(start, stop, duration, allday);
  }

  /**
   * Returns iCalendar file for the event invitation. https://github.com/sebbo2002/ical-generator
          :returns a dict of .ics file content for each meeting
   * @returns 
   */
  async _getIcsFile() {
    function icsDatetime(idate, allday: boolean = false) {
      if (idate) {
        if (allday) {
          return idate;
        }
        return dateSetTz(idate, 'UTC');
      }
      return false;
    }

    const result = {}

    for (const meeting of this) {
      const [start, stop] = await meeting('start', 'stop');
      if (!start || !stop) {
        throw new UserError(await this._t("First you have to specify the date of the invitation."));
      }
      const [allday, label, description, location, rrule, alarmIds, attendeeIds, user] = await meeting('allday', 'label', 'description', 'location', 'rrule', 'alarmIds', 'attendeeIds', 'userId');
      const calendar = ical({ name: 'vevent' });
      // A method is required for outlook to display event as an invitation
      calendar.method(ICalCalendarMethod.REQUEST);
      let event: any = {};
      event['created'] = icsDatetime(_Datetime.now());
      event['start'] = icsDatetime(start, allday);
      event['end'] = icsDatetime(stop, allday);
      event['summary'] = label;
      if (!isHtmlEmpty(description)) {
        if ('appointmentTypeId' in meeting._fields && bool(await this['appointmentTypeId'])) {
          // convertOnlineEventDescToText method for correct data formatting in external calendars
          event['description'] = await this.convertOnlineEventDescToText(description);
        }
        else {
          event['description'] = html2Text(description);
        }
      }
      if (location) {
        event['location'] = location;
      }
      if (rrule) {
        event['rrule'] = rrule;
      }
      event['organizer'] = { 
        email: await user.email || '', 
        name: await user.label 
      };

      const attendees = [];
      for (const attendee of attendeeIds) {
        attendees.push({
          email: await attendee.email || '',
          name: await attendee.label
        });
      }
      if (attendees.length) {
        event['attendees'] = attendees;
      }

      event = calendar.createEvent(event);

      if (bool(alarmIds)) {
        const alarms = [];
        for (const alarm of alarmIds) {
          const alm = {};
          const interval = await alarm.interval;
          const duration = await alarm.duration;
          let delta;
          if (interval == 'days') {
            delta = duration * 24 * 60 * 60;
          }
          else if (interval == 'hours') {
            delta = duration * 60 * 60;
          }
          else if (interval == 'minutes') {
            delta = duration * 60;
          }
          alm['trigger'] = delta;
          alm['description'] = await alarm.label || 'Verp';
          alarms.push(new ICalAlarm(alm, event));
        }
        event.alarms = alarms;
      }
      result[meeting.id] = calendar.toString();
    }
    return result;
  }

  /**
   * We can sync the calendar events with google calendar, iCal and Outlook, and we
      also pass the event description along with other data. This description needs
      to be in plaintext to be displayed properly in above platforms. Because online
      events have fixed format for the description, this method removes some specific
      html tags, and converts it into readable plaintext (to be used in external
      calendars). Note that for regular (offline) events, we simply use the standard
      `html2plaintext` method instead.
   */
  async convertOnlineEventDescToText(description) {
    let descStr = String(description);
    const tagsToReplace = ["<ul>", "</ul>", "<li>"];
    for (const tag of tagsToReplace) {
      descStr = descStr.replace(tag, "");
    }
    descStr = descStr.replace("</li>", "<br/>");
    return html2Text(descStr);
  }

  /**
   * Return date and time (from to from) based on duration with timezone in string. Eg :
              1) if user add duration for 2 hours, return : August-23-2013 at (04-30 To 06-30) (Europe/Brussels)
              2) if event all day ,return : AllDay, July-31-2013
   * @param start 
   * @param stop 
   * @param zduration 
   * @param zallday 
   */
  @api.model()
  async _getDisplayTime(start, stop, zduration, zallday) {
    const timezone = this._context['tz'] || await (await (await this.env.user()).partnerId).tz || 'UTC';

    // get date/time format according to context
    const [formatDate, formatTime] = await this._getDateFormats();

    // convert date and time into user timezone
    const selfTz = await this.withContext({ tz: timezone });
    const date = await _Datetime.contextTimestamp(selfTz, _Datetime.toDatetime(start) as Date);
    const dateDeadline = await _Datetime.contextTimestamp(selfTz, _Datetime.toDatetime(stop) as Date);

    // convert into string the date and time, using user formats
    const toText = tools.toText;
    const dateStr = toText(toFormat(date, formatDate));
    const timeStr = toText(toFormat(date, formatTime));

    let displayTime;
    if (zallday) {
      displayTime = _f(await this._t("All Day, {day}"), { day: dateStr });
    }
    else if (zduration < 24) {
      const duration = addDate(date, { minutes: Math.round(zduration * 60) });
      const durationTime = toText(toFormat(duration, formatTime));
      displayTime = _f(await this._t(
        "{day} at ({start} To {end}) ({timezone})"), {
        day: dateStr,
        start: timeStr,
        end: durationTime,
        timezone: timezone,
      });
    }
    else {
      const ddDate = toText(toFormat(dateDeadline, formatDate));
      const ddTime = toText(toFormat(dateDeadline, formatTime));
      displayTime = _f(await this._t(
        "{dateStart} at {timeStart} To\n {dateEnd} at {timeEnd} ({timezone})"), {
        dateStart: dateStr,
        timeStart: timeStr,
        dateEnd: ddDate,
        timeEnd: ddTime,
        timezone: timezone,
      });
    }
    return displayTime;
  }

  /**
   * Get the duration value between the 2 given dates.
   * @param start 
   * @param stop 
   * @returns 
   */
  async _getDuration(start, stop) {
    if (!start || !stop) {
      return 0;
    }
    const duration = subDate(stop, start).getSeconds() / 3600;
    return floatRound(duration, { precisionDigits: 2 });
  }

  /**
   * get current date and time format, according to the context lang
          :return: a tuple with (format date, format time)
   * @returns 
   */
  @api.model()
  async _getDateFormats() {
    const lang = await getLang(this.env);
    return lang('dateFormat', 'timeFormat');
  }

  @api.model()
  async _getRecurrentFields() {
    return ['byday', 'until', 'rruleType', 'monthBy', 'eventTz', 'rrule',
      'interval', 'count', 'endType', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat',
      'sun', 'day', 'weekday'];
  }

  @api.model()
  async _getTimeFields() {
    return ['start', 'stop', 'startDate', 'stopDate'];
  }

  @api.model()
  async _getCustomFields() {
    const allFields = await this.fieldsGet([], ['manual']);
    return Object.keys(allFields).filter(fname => allFields[fname]['manual']);
  }

  @api.model()
  async _getPublicFields() {
    return _.union(await this._getRecurrentFields(), await this._getTimeFields(), await this._getCustomFields(), [
      'id', 'active', 'allday',
      'duration', 'userId', 'interval', 'partnerId',
      'count', 'rrule', 'recurrenceId', 'showAs', 'privacy']);
  }
}