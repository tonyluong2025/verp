import _ from "lodash";
import { RRule } from "rrule";
import { Fields, _Date, api } from "../../../core";
import { AccessError, ValidationError, ValueError } from "../../../core/helper";
import { MetaModel, Model, _super } from "../../../core/models";
import { Query, expression } from "../../../core/osv";
import { urlEncode } from "../../../core/service/middleware/utils";
import { _f, bool, choice, f, formatDate, isDigit, isInstance, len, range, update } from "../../../core/tools";
import { addDate, combine, dateSetTz } from "../../../core/tools/date_utils";

/**
 * NB: Any field only available on the model hr.employee (i.e. not on the
    hr.employee.public model) should have `groups: "hr.groupHrUser"` on its
    definition to avoid being prefetched when the user hasn't access to the
    hr.employee model. Indeed, the prefetch loads the data for all the fields
    that are available according to the group defined on them.
 */
@MetaModel.define()
class HrEmployeePrivate extends Model {
    static _module = module;
    static _name = "hr.employee";
    static _description = "Employee";
    static _order = 'label';
    static _parents = ['hr.employee.base', 'mail.thread', 'mail.activity.mixin', 'resource.mixin', 'avatar.mixin'];
    static _mailPostAccess = 'read';

    // resource and user
    // required on the resource, make sure required="true" set in the view
    static label = Fields.Char({ string: "Employee Name", related: 'resourceId.label', store: true, readonly: false, tracking: true });
    static userId = Fields.Many2one('res.users', { string: 'User', related: 'resourceId.userId', store: true, readonly: false });
    static userPartnerId = Fields.Many2one({ related: 'userId.partnerId', relatedSudo: false, string: "User's partner" });
    static active = Fields.Boolean('Active', { related: 'resourceId.active', default: true, store: true, readonly: false });
    static companyId = Fields.Many2one('res.company', { required: true });
    static companyCountryId = Fields.Many2one('res.country', { string: 'Company Country', related: 'companyId.countryId', readonly: true });
    static companyCountryCode = Fields.Char({ related: 'companyCountryId.code', readonly: true });
    // private partner
    static addressHomeId = Fields.Many2one(
        'res.partner', {
            string: 'Address', help: 'Enter here the private address of the employee, not the one linked to your company.',
        groups: "hr.groupHrUser", tracking: true,
        domain: "['|', ['companyId', '=', false], ['companyId', '=', companyId]]"
    });
    static isAddressHomeACompany = Fields.Boolean(
        'The employee address has a company linked',
        { compute: '_computeIsAddressHomeACompany' },
    );
    static privateEmail = Fields.Char({ related: 'addressHomeId.email', string: "Private Email", groups: "hr.groupHrUser" });
    static lang = Fields.Selection({ related: 'addressHomeId.lang', string: "Lang", groups: "hr.groupHrUser", readonly: false });
    static countryId = Fields.Many2one(
        'res.country', { string: 'Nationality (Country)', groups: "hr.groupHrUser", tracking: true });
    static gender = Fields.Selection([
        ['male', 'Male'],
        ['female', 'Female'],
        ['other', 'Other']
    ], { groups: "hr.groupHrUser", tracking: true });
    static marital = Fields.Selection([
        ['single', 'Single'],
        ['married', 'Married'],
        ['cohabitant', 'Legal Cohabitant'],
        ['widower', 'Widower'],
        ['divorced', 'Divorced']
    ], { string: 'Marital Status', groups: "hr.groupHrUser", default: 'single', tracking: true });
    static spouseCompleteName = Fields.Char({ string: "Spouse Complete Name", groups: "hr.groupHrUser", tracking: true });
    static spouseBirthdate = Fields.Date({ string: "Spouse Birthdate", groups: "hr.groupHrUser", tracking: true });
    static children = Fields.Integer({ string: 'Number of Children', groups: "hr.groupHrUser", tracking: true });
    static placeOfBirth = Fields.Char('Place of Birth', { groups: "hr.groupHrUser", tracking: true });
    static countryOfBirth = Fields.Many2one('res.country', { string: "Country of Birth", groups: "hr.groupHrUser", tracking: true });
    static birthday = Fields.Date('Date of Birth', { groups: "hr.groupHrUser", tracking: true });
    static ssnid = Fields.Char('SSN No', { help: 'Social Security Number', groups: "hr.groupHrUser", tracking: true });
    static sinid = Fields.Char('SIN No', { help: 'Social Insurance Number', groups: "hr.groupHrUser", tracking: true });
    static identificationId = Fields.Char({ string: 'Identification No', groups: "hr.groupHrUser", tracking: true });
    static passportId = Fields.Char('Passport No', { groups: "hr.groupHrUser", tracking: true });
    static bankAccountId = Fields.Many2one(
        'res.partner.bank', {
            string: 'Bank Account Number',
        domain: "[['partnerId', '=', addressHomeId], '|', ['companyId', '=', false], ['companyId', '=', companyId]]",
        groups: "hr.groupHrUser",
        tracking: true,
        help: 'Employee bank salary account'
    });
    static permitNo = Fields.Char('Work Permit No', { groups: "hr.groupHrUser", tracking: true });
    static visaNo = Fields.Char('Visa No', { groups: "hr.groupHrUser", tracking: true });
    static visaExpire = Fields.Date('Visa Expire Date', { groups: "hr.groupHrUser", tracking: true });
    static workPermitExpirationDate = Fields.Date('Work Permit Expiration Date', { groups: "hr.groupHrUser", tracking: true });
    static hasWorkPermit = Fields.Binary({ string: "Work Permit", groups: "hr.groupHrUser", tracking: true });
    static workPermitScheduledActivity = Fields.Boolean({ default: false, groups: "hr.groupHrUser" });
    static additionalNote = Fields.Text({ string: 'Additional Note', groups: "hr.groupHrUser", tracking: true });
    static certificate = Fields.Selection([
        ['graduate', 'Graduate'],
        ['bachelor', 'Bachelor'],
        ['master', 'Master'],
        ['doctor', 'Doctor'],
        ['other', 'Other'],
    ], { string: 'Certificate Level', default: 'other', groups: "hr.groupHrUser", tracking: true });
    static studyField = Fields.Char("Field of Study", { groups: "hr.groupHrUser", tracking: true });
    static studySchool = Fields.Char("School", { groups: "hr.groupHrUser", tracking: true });
    static emergencyContact = Fields.Char("Emergency Contact", { groups: "hr.groupHrUser", tracking: true });
    static emergencyPhone = Fields.Char("Emergency Phone", { groups: "hr.groupHrUser", tracking: true });
    static kmHomeWork = Fields.Integer({ string: "Home-Work Distance", groups: "hr.groupHrUser", tracking: true });

    static jobId = Fields.Many2one({ tracking: true });
    static phone = Fields.Char({ related: 'addressHomeId.phone', relatedSudo: false, readonly: false, string: "Private Phone", groups: "hr.groupHrUser" });
    // employee in company
    static childIds = Fields.One2many('hr.employee', 'parentId', { string: 'Direct subordinates' });
    static categoryIds = Fields.Many2many(
        'hr.employee.category', {
            relation: 'employeeCategoryRel',
        column1: 'empId', column2: 'categoryId', groups: "hr.groupHrManager",
        string: 'Tags'
    });
    // misc
    static notes = Fields.Text('Notes', { groups: "hr.groupHrUser" });
    static color = Fields.Integer('Color Index', { default: 0 });
    static barcode = Fields.Char({ string: "Badge ID", help: "ID used for employee identification.", groups: "hr.groupHrUser", copy: false });
    static pin = Fields.Char({
        string: "PIN", groups: "hr.groupHrUser", copy: false,
        help: "PIN used to Check In/Out in the Kiosk Mode of the Attendance application (if enabled in Configuration) and to change the cashier in the Point of Sale application."
    });
    static departureReasonId = Fields.Many2one("hr.departure.reason", { string: "Departure Reason", groups: "hr.groupHrUser", copy: false, tracking: true, ondelete: 'RESTRICT' });
    static departureDescription = Fields.Html({ string: "Additional Information", groups: "hr.groupHrUser", copy: false, tracking: true });
    static departureDate = Fields.Date({ string: "Departure Date", groups: "hr.groupHrUser", copy: false, tracking: true });
    static messageMainAttachmentId = Fields.Many2one({ groups: "hr.groupHrUser" });
    static idCard = Fields.Binary({ string: "ID Card Copy", groups: "hr.groupHrUser" });
    static drivingLicense = Fields.Binary({ string: "Driving License", groups: "hr.groupHrUser" });

    static _sqlConstraints = [
        ['barcode_uniq', 'unique (barcode)', "The Badge ID must be unique, this one is already assigned to another employee."],
        ['user_uniq', 'unique ("userId", "companyId")', "A user cannot be linked to multiple employees in the same company."]
    ];

    @api.depends('label', 'userId.avatar1920', 'image1920')
    async _computeAvatar1920() {
        await _super(HrEmployeePrivate, this)._computeAvatar1920();
    }

    @api.depends('label', 'userId.avatar1024', 'image1024')
    async _computeAvatar1024() {
        await _super(HrEmployeePrivate, this)._computeAvatar1024();
    }

    @api.depends('label', 'userId.avatar512', 'image512')
    async _computeAvatar512() {
        await _super(HrEmployeePrivate, this)._computeAvatar512();
    }

    @api.depends('label', 'userId.avatar256', 'image256')
    async _computeAvatar256() {
        await _super(HrEmployeePrivate, this)._computeAvatar256();
    }

    @api.depends('label', 'userId.avatar128', 'image128')
    async _computeAvatar128() {
        await _super(HrEmployeePrivate, this)._computeAvatar128();
    }

    async _computeAvatar(avatarField, imageField) {
        for (const employee of this) {
            let avatar = await employee._origin[imageField];
            if (!avatar) {
                if ((await employee.userId).ok) {
                    avatar = await (await employee.userId)[avatarField];
                }
                else {
                    avatar = await employee._avatarGetPlaceholder();
                }
            }
            await employee.set(avatarField, avatar);
        }
    }

    async nameGet() {
        if (await this.checkAccessRights('read', false)) {
            return _super(HrEmployeePrivate, this).nameGet();
        }
        return this.env.items('hr.employee.public').browse(this.ids).nameGet();
    }

    async _read(fields) {
        if (await this.checkAccessRights('read', false)) {
            return _super(HrEmployeePrivate, this)._read(fields);
        }
        const res = await this.env.items('hr.employee.public').browse(this.ids).read(fields);
        for (const r of res) {
            const record = this.browse(r['id']);
            await record._updateCache(Object.fromEntries(Object.entries(r).filter(([k, v]) => fields.includes(k))), false);
        }
    }

    @api.model()
    async _cronCheckWorkPermitValidity() {
        // Called by a cron
        // Schedule an activity 1 month before the work permit expires
        const outdatedDays = addDate(_Date.today(), { months: 1 });
        const nearlyExpiredWorkPermits = await this.search([['workPermitScheduledActivity', '=', false], ['workPermitExpirationDate', '<', outdatedDays]]);
        let employeesScheduled = this.env.items('hr.employee');
        for (const employee of await nearlyExpiredWorkPermits.filtered(async (e) => await e.parentId)) {
            const responsibleUserId = (await (await employee.parentId).userId).id;
            if (responsibleUserId.ok) {
                employeesScheduled = employeesScheduled.or(employee);
                const lang = await this.env.items('res.users').browse(responsibleUserId).lang;
                const formatedDate = await formatDate(employee.env, await employee.workPermitExpirationDate, lang, "dd MMMM y");
                await employee.activitySchedule({
                    actTypeXmlid: 'mail.mailActivityDataTodo',
                    note: _f(await this._t('The work permit of {employee} expires at {date}.'), {
                        employee: await employee.label,
                        date: formatedDate
                    }),
                    userId: responsibleUserId
                });
            }
        }
        await employeesScheduled.write({ 'workPermitScheduledActivity': true });
    }

    async read(fields, load = '_classicRead') {
        if (await this.checkAccessRights('read', false)) {
            return _super(HrEmployeePrivate, this).read(fields, load);
        }
        const privateFields = _.difference(fields, this.env.models['hr.employee.public']._fields.keys());
        if (privateFields.length) {
            throw new AccessError(await this._t('The fields "%s" you try to read is not available on the public employee profile.', privateFields.join(',')));
        }
        return this.env.items('hr.employee.public').browse(this.ids).read(fields, load);
    }

    @api.model()
    async loadViews(kw: {} = {}) {
        if (await this.checkAccessRights('read', false)) {
            return _super(HrEmployeePrivate, this).loadViews(kw);
        }
        return this.env.items('hr.employee.public').loadViews(kw);
    }

    /**
     * 
     * @param args 
     * @param options 
     * @returns 
     */
    @api.model()
    async _search(args: any[], options: { offset?: number, limit?: number, order?: string, count?: boolean, accessRightsUid?: boolean } = {}) {
        if (await this.checkAccessRights('read', false)) {
            return _super(HrEmployeePrivate, this)._search(args, options);
        }
        let ids;
        try {
            ids = await this.env.items('hr.employee.public')._search(args, options);
        } catch (e) {
            if (isInstance(e, ValueError)) {
                throw new AccessError(await this._t('You do not have access to this document.'));
            } else {
                throw e;
            }
        }
        if (!options.count && isInstance(ids, Query)) {
            // the result is expected from this table, so we should link tables
            ids = await _super(HrEmployeePrivate, await this.sudo())._search([['id', 'in', ids]]);
        }
        return ids;
    }

    /**
     * Override this method in order to redirect many2one towards the right model depending on access_uid
     * @param accessUid 
     * @returns 
     */
    async getFormviewId(accessUid?: any) {
        let thisSudo;
        if (accessUid) {
            thisSudo = await this.withUser(accessUid);
        }
        else {
            thisSudo = this;
        }
        if (await thisSudo.checkAccessRights('read', false)) {
            return _super(HrEmployeePrivate, this).getFormviewId(accessUid);
        }
        // Hardcode the form view for public employee
        return (await this.env.ref('hr.hrEmployeePublicViewForm')).id;
    }

    /**
     * Override this method in order to redirect many2one towards the right model depending on access_uid
     * @param accessUid 
     * @returns 
     */
    async getFormviewAction(accessUid?: any) {
        const res = await _super(HrEmployeePrivate, this).getFormviewAction(accessUid);
        let thisSudo;
        if (accessUid) {
            thisSudo = await this.withUser(accessUid);
        }
        else {
            thisSudo = this;
        }

        if (! await thisSudo.checkAccessRights('read', false)) {
            res['resModel'] = 'hr.employee.public';
        }

        return res;
    }

    @api.constrains('pin')
    async _verifyPin() {
        for (const employee of this) {
            if (await employee.pin && !isDigit(await employee.pin)) {
                throw new ValidationError(await this._t("The PIN must be a sequence of digits."));
            }
        }
    }

    @api.onchange('userId')
    async _onchangeUser() {
        const user = await this['userId'];
        if (user.ok) {
            await this.update(await this._syncUser(user, bool(await this['image1920'])));
            if (! await this['label']) {
                await this.set('label', await user.label);
            }
        }
    }

    @api.onchange('resourceCalendarId')
    async _onchangeTimezone() {
        const resourceCalendar = await this['resourceCalendarId'];
        if (bool(resourceCalendar) && ! await this['tz']) {
            await this.set('tz', await resourceCalendar.tz);
        }
    }

    async _syncUser(user, employeeHasImage: boolean = false) {
        const vals = {
            workEmail: await user.email,
            userId: user.id,
        };
        if (!employeeHasImage) {
            vals['image1920'] = await user.image1920;
        }
        if (await user.tz) {
            vals['tz'] = await user.tz;
        }
        return vals;
    }

    @api.model()
    async create(vals) {
        if (vals['userId']) {
            const user = this.env.items('res.users').browse(vals['userId']);
            update(vals, await this._syncUser(user, bool(vals['image1920'])));
            vals['label'] = vals['label'] || await user.label;
        }
        const employee = await _super(HrEmployeePrivate, this).create(vals);
        const [department, addressHome] = await employee('departmentId', 'addressHomeId');
        if (department.ok) {
            await (await (await this.env.items('mail.channel').sudo()).search([
                ['subscriptionDepartmentIds', 'in', department.id]
            ]))._subscribeUsersAutomatically();
        }
        await employee._messageSubscribe(addressHome.ids);
        // Launch onboarding plans
        const url = f('/web#%s', urlEncode({
            'action': 'hr.planWizardAction',
            'activeId': employee.id,
            'activeModel': 'hr.employee',
            'menuId': (await this.env.ref('hr.menuHrRoot')).id,
        }));
        await employee._messageLog({ body: await this._t('<b>Congratulations!</b> May I recommend you to setup an <a href="%s">onboarding plan?</a>', url) });
        return employee;
    }

    async write(vals) {
        if ('addressHomeId' in vals) {
            const accountIds = vals['bankAccountId'] || (await this['bankAccountId']).ids;
            if (bool(accountIds)) {
                await this.env.items('res.partner.bank').browse(accountIds).set('partnerId', vals['addressHomeId']);
            }
            await (this as any).messageUnsubscribe((await this['addressHomeId']).ids);
            if (vals['addressHomeId']) {
                await (this as any)._messageSubscribe([vals['addressHomeId']]);
            }
        }

        if (vals['userId']) {
            // Update the profile pictures with user, except if provided 
            update(vals, await this._syncUser(this.env.items('res.users').browse(vals['userId']),
                bool(await this.all(emp => emp.image1920))));
        }
        if ('workPermitExpirationDate' in vals) {
            vals['workPermitScheduledActivity'] = false;
        }
        const res = await _super(HrEmployeePrivate, this).write(vals);
        if (vals['departmentId'] || vals['userId']) {
            const departmentId = bool(vals['departmentId']) ? vals['departmentId'] : (await this.slice(0, 1).departmentId).id;
            // When added to a department or changing user, subscribe to the channels auto-subscribed by department
            await (await (await this.env.items('mail.channel').sudo()).search([
                ['subscriptionDepartmentIds', 'in', departmentId]
            ]))._subscribeUsersAutomatically();
        }
        return res;
    }

    async unlink() {
        const resources = await this.mapped('resourceId');
        await _super(HrEmployeePrivate, this).unlink();
        return resources.unlink();
    }

    _getEmployeeM2oToEmptyOnArchivedEmployees() {
        return ['parentId', 'coachId'];
    }

    _getUserM2oToEmptyOnArchivedEmployees() {
        return [];
    }

    async toggleActive() {
        const res = await _super(HrEmployeePrivate, this).toggleActive();
        const unarchivedEmployees = await this.filtered(employee => employee.active);
        await unarchivedEmployees.write({
            'departureReasonId': false,
            'departureDescription': false,
            'departureDate': false
        });
        const archivedAddresses = await (await unarchivedEmployees.mapped('addressHomeId')).filtered(async (addr) => ! await addr.active);
        await archivedAddresses.toggleActive();

        const archivedEmployees = await this.filtered(async (e) => ! await e.active);
        if (archivedEmployees.ok) {
            // Empty links to this employees (example: manager, coach, time off responsible, ...)
            const employeeFieldsToEmpty = this._getEmployeeM2oToEmptyOnArchivedEmployees();
            const userFieldsToEmpty = this._getUserM2oToEmptyOnArchivedEmployees();
            const employeeDomain = employeeFieldsToEmpty.map(field => [[field, 'in', archivedEmployees.ids]]);
            const user = await archivedEmployees.userId;
            const userDomain = userFieldsToEmpty.map(field => [[field, 'in', user.ids]]);
            const employees = await this.env.items('hr.employee').search(expression.OR(employeeDomain.concat(userDomain)));
            for (const employee of employees) {
                for (const field of employeeFieldsToEmpty) {
                    if (await employee[field] in archivedEmployees._fields) {
                        await employee.set(field, false);
                    }
                }
                for (const field of userFieldsToEmpty) {
                    if (await employee[field] in (await archivedEmployees.userId)._fields) {
                        await employee.set(field, false);
                    }
                }
            }
        }

        if (len(this) == 1 && !await this['active'] && !this.env.context['noWizard']) {
            return {
                'type': 'ir.actions.actwindow',
                'label': await this._t('Register Departure'),
                'resModel': 'hr.departure.wizard',
                'viewMode': 'form',
                'target': 'new',
                'context': { 'activeId': this.id },
                'views': [[false, 'form']]
            }
        }
        return res;
    }

    @api.onchange('companyId')
    async _onchangeCompanyId() {
        if (bool(this._origin)) {
            return {
                'warning': {
                    'title': await this._t("Warning"),
                    'message': await this._t("To avoid multi company issues (loosing the access to your previous contracts, leaves, ...), you should create another employee in the new company instead.")
                }
            }
        }
    }

    async generateRandomBarcode() {
        for (const employee of this) {
            await employee.set('barcode', '041' + Array.from(range(9)).map(i => choice('0123456789')).join(''));
        }
    }

    /**
     * Checks that chosen address (res.partner) is not linked to a company.
     */
    @api.depends('addressHomeId.parentId')
    async _computeIsAddressHomeACompany() {
        for (const employee of this) {
            try {
                await employee.set('isAddressHomeACompany', bool((await (await employee.addressHomeId).parentId).id) != false);
            } catch (e) {
                if (isInstance(e, AccessError)) {
                    await employee.set('isAddressHomeACompany', false);
                } else {
                    throw e;
                }
            }
        }
    }

    async _getTz() {
        // Finds the first valid timezone in his tz, his work hours tz,
        //  the company calendar tz or UTC and returns it as a string
        this.ensureOne();
        return await this['tz'] ||
            await (await this['resourceCalendarId']).tz ||
            await (await (await this['companyId']).resourceCalendarId).tz ||
            'UTC';
    }

    async _getTzBatch() {
        // Finds the first valid timezone in his tz, his work hours tz,
        //  the company calendar tz or UTC
        // Returns a dict {employeeId: tz}
        return Object.fromEntries(await this.map(async (emp) => [emp.id, await emp._getTz()]));
    }

    // ---------------------------------------------------------
    // Business Methods
    // ---------------------------------------------------------

    @api.model()
    async getImportTemplates() {
        return [{
            'label': await this._t('Import Template for Employees'),
            'template': '/hr/static/xls/hr_employee.xls'
        }];
    }

    /**
     * When a user updates his own employee's data, all operations are performed
        by super user. However, tracking messages should not be posted as VerpBot
        but as the actual user.
        This method is used in the overrides of `_message_log` and `message_post`
        to post messages as the correct user.
     * @returns 
     */
    async _postAuthor() {
        const realUser = this.env.context['binaryFieldRealUser'];
        let self = this;
        if (self.env.isSuperuser() && realUser) {
            self = await self.withUser(realUser);
        }
        return self;
    }

    async _getUnusualDays(dateFrom: Date, dateTo?: Date) {
        // Checking the calendar directly allows to not grey out the leaves taken
        // by the employee
        // Prevents a traceback when loading calendar views and no employee is linked to the user.
        if (!this.ok) {
            return {};
        }
        this.ensureOne();
        const calendar = await this['resourceCalendarId'];
        if (!bool(calendar)) {
            return {};
        }
        const dfrom = dateSetTz(combine(_Date.toDate(dateFrom) as Date, 'min'), 'UTC');
        const dto = dateSetTz(combine(_Date.toDate(dateTo) as Date, 'max'), 'UTC');

        const works = (await calendar._workIntervalsBatch(dfrom, dto))['false'].map(d => _Date.today(d[0]));
        const res = {}
        for (const day of new RRule({ freq: RRule.DAILY, dtstart: dfrom, until: dto }).all()) {
            res[_Date.toString(_Date.today(day)) as string] = !works.includes(_Date.today(day));
        }
        return res;
    }

    // ---------------------------------------------------------
    // Messaging
    // ---------------------------------------------------------

    async _messageLog(options: {} = {}) {
        return _super(HrEmployeePrivate, await this._postAuthor())._messageLog(options);
    }

    @api.returns('mail.message', (value) => value.id)
    async messagePost(options: {} = {}) {
        return _super(HrEmployeePrivate, await this._postAuthor()).messagePost(options);
    }

    _smsGetPartnerFields() {
        return ['userPartnerId']
    }

    _smsGetNumberFields() {
        return ['mobilePhone'];
    }
}