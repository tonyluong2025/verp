import _ from "lodash";
import { api } from "../../../core";
import { Fields } from "../../../core/fields";
import { DefaultDict2, Dict } from "../../../core/helper/collections";
import { AbstractModel, MetaModel, _super } from "../../../core/models";
import { bool } from "../../../core/tools/bool";
import { pop } from "../../../core/tools/misc";

@MetaModel.define()
class ResourceMixin extends AbstractModel {
  static _module = module;
  static _name = "resource.mixin";
  static _description = 'Resource Mixin';

  static resourceId = Fields.Many2one(
    'resource.resource', {
      string: 'Resource',
    autojoin: true, index: true, ondelete: 'RESTRICT', required: true
  });
  static companyId = Fields.Many2one(
    'res.company', {
      string: 'Company',
    default: self => self.env.company(),
    index: true, related: 'resourceId.companyId', store: true, readonly: false
  });
  static resourceCalendarId = Fields.Many2one(
    'resource.calendar', {
      string: 'Working Hours',
    default: async (self) => (await self.env.company()).resourceCalendarId, index: true, related: 'resourceId.calendarId', store: true, readonly: false
  })
  static tz = Fields.Selection(
    {
      string: 'Timezone', related: 'resourceId.tz', readonly: false,
      help: "This field is used in order to define in which timezone the resources will work."
    })

  @api.model()
  async create(values) {
    if (!values['resourceId']) {
      const resourceVals = { 'label': values[this.cls._recName] }
      const tz = pop(values, 'tz') ??
        await this.env.items('resource.calendar').browse(values.get('resourceCalendarId')).tz;
      if (tz) {
        resourceVals['tz'] = tz;
      }
      const resource = await this.env.items('resource.resource').create(resourceVals);
      values['resourceId'] = resource.id;
    }
    return _super(ResourceMixin, this).create(values);
  }

  async copyData(defaultValue?: any) {
    if (defaultValue == null) {
      defaultValue = {};
    }
    const resource = await (await this['resourceId']).copy()
    defaultValue['resourceId'] = resource.id;
    defaultValue['companyId'] = (await resource.companyId).id;
    defaultValue['resourceCalendarId'] = (await resource.calendarId).id;
    return _super(ResourceMixin, this).copyData(defaultValue);
  }

  /**
   * By default the resource calendar is used, but it can be changed using the `calendar` argument.

      `domain` is used in order to recognise the leaves to take, None means default value ('time_type', '=', 'leave')

      Returns a dict {'days': n, 'hours': h} containing thequantity of working time expressed as days and as hours.
    * @param fromDatetime 
    * @param toDatetime 
    * @param computeLeaves 
    * @param calendar 
    * @param domain 
    * @returns 
    */
  async _getWorkDaysDataBatch(fromDatetime, toDatetime, computeLeaves: boolean = true, calendar?: any, domain?: any) {
    const resources = await this.mapped('resourceId');
    const mappedEmployees = {}
    for (const e of this) {
      mappedEmployees[(await e.resourceId).id] = e.id;
    }
    const result = {};

    const mappedResources = new DefaultDict2(() => this.env.items('resource.resource'));
    for (const record of this) {
      const key = bool(calendar) ? calendar : await record.resourceCalendarId;
      // if (!mappedResources.has(key)) {
      //   mappedResources.set(key, this.env.items('resource.resource'));
      // }
      mappedResources[key] = mappedResources[key].or(await record.resourceId);
    }
    for (const [calendar, calendarResources] of mappedResources) {
      if (!calendar) {
        for (const calendarResource of calendarResources) {
          result[calendarResource.id] = { 'days': 0, 'hours': 0 }
        }
        continue;
      }
      const dayTotal = await calendar._getResourcesDayTotal(fromDatetime, toDatetime, calendarResources);

      // actual hours per day
      let intervals;
      if (computeLeaves) {
        intervals = calendar._workIntervalsBatch(fromDatetime, toDatetime, calendarResources, domain);
      }
      else {
        intervals = calendar._attendanceIntervalsBatch(fromDatetime, toDatetime, calendarResources);
      }

      for (const calendarResource of calendarResources) {
        result[calendarResource.id] = calendar._getDaysData(intervals[calendarResource.id], dayTotal[calendarResource.id]);
      }
    }

    // convert "resource: result" into "employee: result"
    return Object.fromEntries(resources.map(r => [mappedEmployees[r.id], result[r.id]]));
  }

  /**
   * By default the resource calendar is used, but it can be
      changed using the `calendar` argument.

      `domain` is used in order to recognise the leaves to take,
      None means default value ('time_type', '=', 'leave')

      Returns a dict {'days': n, 'hours': h} containing the number of leaves
      expressed as days and as hours.
    * @param fromDatetime 
    * @param toDatetime 
    * @param calendar 
    * @param domain 
    * @returns 
    */
  async _getLeaveDaysDataBatch(fromDatetime, toDatetime, calendar?: any, domain?: any) {
    const resources = await this.mapped('resourceId');
    const mappedEmployees = {}
    for (const e of this) {
      mappedEmployees[(await e.resourceId).id] = e.id;
    }
    const result = {}

    const mappedResources = new DefaultDict2(() => this.env.items('resource.resource'));
    for (const record of this) {
      const key = bool(calendar) ? calendar : await record.resourceCalendarId;
      mappedResources[key] = mappedResources[key].or(await record.resourceId);
    }

    for (const [calendar, calendarResources] of mappedResources) {
      const dayTotal = calendar._getResourcesDayTotal(fromDatetime, toDatetime, calendarResources);

      // compute actual hours per day
      const attendances = calendar._attendanceIntervalsBatch(fromDatetime, toDatetime, calendarResources);
      const leaves = calendar._leaveIntervalsBatch(fromDatetime, toDatetime, calendarResources, domain);

      for (const calendarResource of calendarResources) {
        result[calendarResource.id] = calendar._getDaysData(
          attendances[calendarResource.id] = _.intersection(attendances[calendarResource.id], leaves[calendarResource.id],
            dayTotal[calendarResource.id])
        )
      }
    }
    // convert "resource: result" into "employee: result"
    return Object.fromEntries(resources.map(r => [mappedEmployees[r.id], result[r.id]]));
  }

  async _adjustToCalendar(start, end) {
    const resourceResults = await (await this['resourceId'])._adjustToCalendar(start, end);
    // change dict keys from resources to associated records.
    const res = {};
    for (const record of this) {
      res[record] = resourceResults[await record.resourceId];
    }
    return res;
  }

  /**
   *  By default the resource calendar is used, but it can be changed using the `calendar` argument.

    `domain` is used in order to recognise the leaves to take,
    None means default value ('time_type', '=', 'leave')

    Returns a list of tuples (day, hours) for each day
    containing at least an attendance.

    * @param fromDatetime 
    * @param toDatetime 
    * @param calendar 
    * @param any 
    * @param domain 
    * @returns 
    */
  async listWorkTimePerDay(fromDatetime, toDatetime, calendar?: any, domain?: any) {
    const resource = await this['resourceId'];
    calendar = calendar || await this['resourceCalendarId'];

    const intervals = (await calendar._workIntervalsBatch(fromDatetime, toDatetime, resource, domain))[resource.id]
    const result = new Dict<number>(); //defaultdict(float)
    for (const [start, stop, meta] of intervals) {
      result[start.date()] += stop.minus(start).totalSeconds() / 3600;
    }
    return result.items().sort();
  }

  /**
   * By default the resource calendar is used, but it can be changed using the `calendar` argument.

    `domain` is used in order to recognise the leaves to take,
    None means default value ('time_type', '=', 'leave')

    Returns a list of tuples (day, hours, resource.calendar.leaves)
    for each leave in the calendar.
    * @param fromDatetime 
    * @param toDatetime 
    * @param calendar 
    * @param domain 
    * @returns 
    */
  async listLeaves(fromDatetime, toDatetime, calendar?: any, domain?: any) {
    const resource = await this['resourceId'];
    calendar = calendar || await this['resourceCalendarId'];

    const attendances = (await calendar._attendanceIntervalsBatch(fromDatetime, toDatetime, resource))[resource.id]
    const leaves = (await calendar._leaveIntervalsBatch(fromDatetime, toDatetime, resource, domain))[resource.id]
    const result = [];
    for (const [start, stop, leave] of _.intersection<any>(leaves, attendances)) {
      const hours = stop.minus(start).totalSeconds() / 3600
      result.push((start.date(), hours, leave))
    }
    return result;
  }
}