import { Fields, _Date, _Datetime, api } from "../../../core";
import { Dict } from "../../../core/helper";
import { AbstractModel, MetaModel } from "../../../core/models";
import { bool, extend, formatTime, len } from "../../../core/tools";
import { literalEval } from "../../../core/tools/ast";
import { addDate, dateSetTz, dateWithoutTz } from "../../../core/tools/date_utils";

@MetaModel.define()
class HrEmployeeBase extends AbstractModel {
    static _module = module;
    static _name = "hr.employee.base";
    static _description = "Basic Employee";
    static _order = 'label';

    static label = Fields.Char();
    static active = Fields.Boolean("Active");
    static color = Fields.Integer('Color Index', { default: 0 });
    static departmentId = Fields.Many2one('hr.department', { string: 'Department', domain: "['|', ['companyId', '=', false], ['companyId', '=', companyId]]" });
    static jobId = Fields.Many2one('hr.job', { string: 'Job Position', domain: "['|', ['companyId', '=', false], ['companyId', '=', companyId]]" });
    static jobTitle = Fields.Char("Job Title", { compute: "_computeJobTitle", store: true, readonly: false });
    static companyId = Fields.Many2one('res.company', { string: 'Company' });
    static addressId = Fields.Many2one('res.partner', { string: 'Work Address', compute: "_computeAddressId", store: true, readonly: false, domain: "['|', ['companyId', '=', false], ['companyId', '=', companyId]]" });
    static workPhone = Fields.Char('Work Phone', { compute: "_computePhones", store: true, readonly: false });
    static mobilePhone = Fields.Char('Work Mobile');
    static workEmail = Fields.Char('Work Email');
    static workLocationId = Fields.Many2one('hr.work.location', { string: 'Work Location', compute: "_computeWorkLocationId", store: true, readonly: false, domain: "[['addressId', '=', addressId], '|', ['companyId', '=', false], ['companyId', '=', companyId]]" });
    static userId = Fields.Many2one('res.users');
    static resourceId = Fields.Many2one('resource.resource');
    static resourceCalendarId = Fields.Many2one('resource.calendar', { domain: "['|', ['companyId', '=', false], ['companyId', '=', companyId]]" });
    static parentId = Fields.Many2one('hr.employee', { string: 'Manager', compute: "_computeParentId", store: true, readonly: false, domain: "['|', ['companyId', '=', false], ['companyId', '=', companyId]]" });
    static coachId = Fields.Many2one(
        'hr.employee', { string: 'Coach', compute: '_computeCoach', store: true, readonly: false, domain: "['|', ['companyId', '=', false], ['companyId', '=', companyId]]", help: 'Select the "Employee" who is the coach of this employee.\nThe "Coach" has no specific rights or responsibilities by default.' });
    static tz = Fields.Selection({
        string: 'Timezone', related: 'resourceId.tz', readonly: false,
        help: "This field is used in order to define in which timezone the resources will work."
    });
    static hrPresenceState = Fields.Selection([
        ['present', 'Present'],
        ['absent', 'Absent'],
        ['toDefine', 'To Define']], { compute: '_computePresenceState', default: 'toDefine' });
    static lastActivity = Fields.Date({ compute: "_computeLastActivity" });
    static lastActivityTime = Fields.Char({ compute: "_computeLastActivity" });
    static hrIconDisplay = Fields.Selection([
        ['presencePresent', 'Present'],
        ['presenceAbsentActive', 'Present but not active'],
        ['presenceAbsent', 'Absent'],
        ['presenceToDefine', 'To define'],
        ['presenceUndetermined', 'Undetermined']], { compute: '_computePresenceIcon' });
    static employeeType = Fields.Selection([
        ['employee', 'Employee'],
        ['student', 'Student'],
        ['trainee', 'Trainee'],
        ['contractor', 'Contractor'],
        ['freelance', 'Freelancer'],
    ], {
        string: 'Employee Type', default: 'employee', required: true,
        help: "The employee type. Although the primary purpose may seem to categorize employees, this field has also an impact in the Contract History. Only Employee type is supposed to be under contract and will have a Contract History."
    });

    /**
     * This method is overritten in several other modules which add additional
        presence criterions. e.g. hrAttendance, hrHolidays
     */
    @api.depends('userId.imStatus')
    async _computePresenceState() {
        // Check on login
        const checkLogin = literalEval(await (await this.env.items('ir.config.parameter').sudo()).getParam('hr.hrPresenceControlLogin', 'false'));
        const employeeToCheckWorking = await this.filtered(async (e) => await (await e.userId).imStatus === 'offline');
        const workingNowList = await employeeToCheckWorking._getEmployeeWorkingNow();
        for (const employee of this) {
            let state = 'toDefine';
            if (checkLogin) {
                const imStatus = await (await employee.userId).imStatus;
                if (imStatus === 'online') {
                    state = 'present';
                }
                else if (imStatus === 'offline' && !workingNowList.includes(employee.id)) {
                    state = 'absent';
                }
            }
            await employee.set('hrPresenceState', state);
        }
    }

    @api.depends('userId')
    async _computeLastActivity() {
        let presences = await this.env.items('bus.presence').searchRead([['userId', 'in', (await this.mapped('userId')).ids]], ['userId', 'lastPresence']);
        // transform the result to a dict with this format {user.id: last_presence}
        presences = Dict.from(presences.map(p => [p['userId'][0], p['lastPresence']]));

        for (const employee of this) {
            const tz = await employee.tz;
            const lastPresence = presences.get((await employee.userId).id, false);
            if (lastPresence) {
                const lastActivityDatetime = dateWithoutTz(dateSetTz(lastPresence, tz));
                await employee.set('lastActivity', _Date.today(lastActivityDatetime));
                if (await employee.lastActivity == _Date.today()) {
                    await employee.set('lastActivityTime', await formatTime(this.env, lastPresence, null, 'short'));
                }
                else {
                    await employee.set('lastActivityTime', false);
                }
            }
            else {
                await employee.set('lastActivity', false);
                await employee.set('lastActivityTime', false);
            }
        }
    }

    @api.depends('parentId')
    async _computeCoach() {
        for (const employee of this) {
            const [manager, coach] = await employee('parentId', 'coachId');
            const previousManager = await employee._origin.parentId;
            if (manager.ok && (coach.eq(previousManager) || !coach.ok)) {
                await employee.set('coachId', manager);
            }
            else if (!coach.ok) {
                await employee.set('coachId', false);
            }
        }
    }

    @api.depends('jobId')
    async _computeJobTitle() {
        for (const employee of await this.filtered('jobId')) {
            await employee.set('jobTitle', await (await employee.jobId).label);
        }
    }

    @api.depends('addressId')
    async _computePhones() {
        for (const employee of this) {
            if ((await employee.addressId).ok && await (await employee.addressId).phone) {
                await employee.set('workPhone', await (await employee.addressId).phone);
            }
            else {
                await employee.set('workPhone', false);
            }
        }
    }

    @api.depends('companyId')
    async _computeAddressId() {
        for (const employee of this) {
            const address = await (await (await employee.companyId).partnerId).addressGet(['default']);
            await employee.set('addressId', bool(address) ? address['default'] : false);
        }
    }

    @api.depends('departmentId')
    async _computeParentId() {
        for (const employee of await this.filtered('departmentId.managerId')) {
            await employee.set('parentId', await (await employee.departmentId).managerId);
        }
    }

    /**
     * This method compute the state defining the display icon in the kanban view.
        It can be overriden to add other possibilities, like time off or attendances recordings.
     */
    @api.depends('resourceCalendarId', 'hrPresenceState')
    async _computePresenceIcon() {
        const workingNowList = await (await this.filtered(async (e) => await e.hrPresenceState === 'present'))._getEmployeeWorkingNow();
        for (const employee of this) {
            let icon;
            if (await employee.hrPresenceState === 'present') {
                if (workingNowList.includes(employee.id)) {
                    icon = 'presencePresent';
                }
                else {
                    icon = 'presenceAbsentActive';
                }
            }
            else if (await employee.hrPresenceState === 'absent') {
                // employee is not in the working_now_list and he has a userId
                icon = 'presenceAbsent';
            }
            else {
                // without attendance, default employee state is 'to_define' without confirmed presence/absence
                // we need to check why they are not there
                if (bool(await employee.userId)) {
                    // Display an orange icon on internal users.
                    icon = 'presenceToDefine';
                }
                else {
                    // We don't want non-user employee to have icon.
                    icon = 'presenceUndetermined'
                }
            }
            await employee.set('hrIconDisplay', icon);
        }
    }

    @api.depends('addressId')
    async _computeWorkLocationId() {
        const toReset = await this.filtered(async (e) => !(await e.addressId).eq(await (await e.workLocationId).addressId));
        await toReset.set('workLocationId', false);
    }

    @api.model()
    async _getEmployeeWorkingNow() {
        const workingNow = [];
        // We loop over all the employee tz and the resource calendar_id to detect working hours in batch.
        const allEmployeeTz = new Set<string>(await this.mapped('tz'));
        for (const tz of allEmployeeTz) {
            const employeeIds = await this.filtered(async (e) => await e.tz == tz);
            const resourceCalendarIds = await employeeIds.mapped('resourceCalendarId');
            for (const calendarId of resourceCalendarIds) {
                const resEmployeeIds = await employeeIds.filtered(async (e) => (await e.resourceCalendarId).id == calendarId.id);
                const startDt = _Datetime.now();
                const stopDt = addDate(startDt, { hours: 1 });
                const fromDatetime = dateSetTz(startDt, tz || 'UTC');
                const toDatetime = dateSetTz(stopDt, tz || 'UTC');
                // Getting work interval of the first is working. Functions called on resource_calendar_id
                // are waiting for singleton
                const workInterval = (await (await resEmployeeIds[0].resourceCalendarId)._workIntervalsBatch(fromDatetime, toDatetime))['false'];
                // Employee that is not supposed to work have empty items.
                if (len(workInterval._items) > 0) {
                    // The employees should be working now according to their work schedule
                    extend(workingNow, resEmployeeIds.ids);
                }
            }
        }
        return workingNow;
    }
}