import { Fields, api } from "../../../core";
import { AccessError, MapKey } from "../../../core/helper";
import { MetaModel, Model, _super } from "../../../core/models";
import { bool, len, pop } from "../../../core/tools";

const HR_READABLE_FIELDS = [
    'active',
    'childIds',
    'employeeId',
    'addressHomeId',
    'employeeIds',
    'employeeParentId',
    'hrPresenceState',
    'lastActivity',
    'lastActivityTime',
    'canEdit',
    'isSystem',
]

const HR_WRITABLE_FIELDS = [
    'additionalNote',
    'privateStreet',
    'privateStreet2',
    'privateCity',
    'privateStateId',
    'privateZip',
    'privateCountryId',
    'addressId',
    'barcode',
    'birthday',
    'categoryIds',
    'children',
    'coachId',
    'countryOfBirth',
    'departmentId',
    'displayName',
    'emergencyContact',
    'emergencyPhone',
    'employeeBankAccountId',
    'employeeCountryId',
    'gender',
    'identificationId',
    'isAddressHomeACompany',
    'jobTitle',
    'privateEmail',
    'kmHomeWork',
    'marital',
    'mobilePhone',
    'notes',
    'employeeParentId',
    'passportId',
    'permitNo',
    'employeePhone',
    'pin',
    'placeOfBirth',
    'spouseBirthdate',
    'spouseCompleteName',
    'visaExpire',
    'visaNo',
    'workEmail',
    'workLocationId',
    'workPhone',
    'certificate',
    'studyField',
    'studySchool',
    'privateLang',
    'employeeType',
]

@MetaModel.define()
class User extends Model {
    static _module = module;
    static _parents = ['res.users'];

    async _employeeIdsDomain() {
        // employeeIds is considered a safe field and as such will be fetched as sudo.
        // So try to enforce the security rules on the field to make sure we do not load employees outside of active companies
        return [['companyId', 'in', (await this.env.company()).ids.concat(this.env.context['allowedCompanyIds'] ?? [])]];
    }

    // note: a user can only be linked to one employee per company (see sql constraint in ´hr.employee´)
    static employeeIds = Fields.One2many('hr.employee', 'userId', { string: 'Related employee', domain: (self) => self._employeeIdsDomain() });
    static employeeId = Fields.Many2one('hr.employee', {
        string: "Company employee",
        compute: '_computeCompanyEmployee', search: '_searchCompanyEmployee', store: false
    });

    static jobTitle = Fields.Char({ related: 'employeeId.jobTitle', readonly: false, relatedSudo: false });
    static workPhone = Fields.Char({ related: 'employeeId.workPhone', readonly: false, relatedSudo: false });
    static mobilePhone = Fields.Char({ related: 'employeeId.mobilePhone', readonly: false, relatedSudo: false });
    static employeePhone = Fields.Char({ related: 'employeeId.phone', readonly: false, relatedSudo: false });
    static workEmail = Fields.Char({ related: 'employeeId.workEmail', readonly: false, relatedSudo: false });
    static categoryIds = Fields.Many2many({ related: 'employeeId.categoryIds', string: "Employee Tags", readonly: false, relatedSudo: false });
    static departmentId = Fields.Many2one({ related: 'employeeId.departmentId', readonly: false, relatedSudo: false });
    static addressId = Fields.Many2one({ related: 'employeeId.addressId', readonly: false, relatedSudo: false });
    static workLocationId = Fields.Many2one({ related: 'employeeId.workLocationId', readonly: false, relatedSudo: false });
    static employeeParentId = Fields.Many2one({ related: 'employeeId.parentId', readonly: false, relatedSudo: false });
    static coachId = Fields.Many2one({ related: 'employeeId.coachId', readonly: false, relatedSudo: false });
    static addressHomeId = Fields.Many2one({ related: 'employeeId.addressHomeId', readonly: false, relatedSudo: false });
    static privateStreet = Fields.Char({ related: 'addressHomeId.street', string: "Private Street", readonly: false, relatedSudo: false });
    static privateStreet2 = Fields.Char({ related: 'addressHomeId.street2', string: "Private Street2", readonly: false, relatedSudo: false });
    static privateCity = Fields.Char({ related: 'addressHomeId.city', string: "Private City", readonly: false, relatedSudo: false });
    static privateStateId = Fields.Many2one({
        related: 'addressHomeId.stateId', string: "Private State", readonly: false, relatedSudo: false,
        domain: "[['countryId', '=?', privateCountryId]]"
    });
    static privateZip = Fields.Char({ related: 'addressHomeId.zip', readonly: false, string: "Private Zip", relatedSudo: false });
    static privateCountryId = Fields.Many2one({ related: 'addressHomeId.countryId', string: "Private Country", readonly: false, relatedSudo: false });
    static isAddressHomeACompany = Fields.Boolean({ related: 'employeeId.isAddressHomeACompany', readonly: false, relatedSudo: false });
    static privateEmail = Fields.Char({ related: 'addressHomeId.email', string: "Private Email", readonly: false });
    static privateLang = Fields.Selection({ related: 'addressHomeId.lang', string: "Employee Lang", readonly: false });
    static kmHomeWork = Fields.Integer({ related: 'employeeId.kmHomeWork', readonly: false, relatedSudo: false });
    // res.users already have a field bank_account_id and countryId from the res.partner inheritance: don't redefine them
    static employeeBankAccountId = Fields.Many2one({ related: 'employeeId.bankAccountId', string: "Employee's Bank Account Number", relatedSudo: false, readonly: false });
    static employeeCountryId = Fields.Many2one({ related: 'employeeId.countryId', string: "Employee's Country", readonly: false, relatedSudo: false });
    static identificationId = Fields.Char({ related: 'employeeId.identificationId', readonly: false, relatedSudo: false });
    static passportId = Fields.Char({ related: 'employeeId.passportId', readonly: false, relatedSudo: false });
    static gender = Fields.Selection({ related: 'employeeId.gender', readonly: false, relatedSudo: false })
    static birthday = Fields.Date({ related: 'employeeId.birthday', readonly: false, relatedSudo: false });
    static placeOfBirth = Fields.Char({ related: 'employeeId.placeOfBirth', readonly: false, relatedSudo: false });
    static countryOfBirth = Fields.Many2one({ related: 'employeeId.countryOfBirth', readonly: false, relatedSudo: false });
    static marital = Fields.Selection({ related: 'employeeId.marital', readonly: false, relatedSudo: false });
    static spouseCompleteName = Fields.Char({ related: 'employeeId.spouseCompleteName', readonly: false, relatedSudo: false });
    static spouseBirthdate = Fields.Date({ related: 'employeeId.spouseBirthdate', readonly: false, relatedSudo: false });
    static children = Fields.Integer({ related: 'employeeId.children', readonly: false, relatedSudo: false });
    static emergencyContact = Fields.Char({ related: 'employeeId.emergencyContact', readonly: false, relatedSudo: false });
    static emergencyPhone = Fields.Char({ related: 'employeeId.emergencyPhone', readonly: false, relatedSudo: false });
    static visaNo = Fields.Char({ related: 'employeeId.visaNo', readonly: false, relatedSudo: false });
    static permitNo = Fields.Char({ related: 'employeeId.permitNo', readonly: false, relatedSudo: false });
    static visaExpire = Fields.Date({ related: 'employeeId.visaExpire', readonly: false, relatedSudo: false });
    static additionalNote = Fields.Text({ related: 'employeeId.additionalNote', readonly: false, relatedSudo: false });
    static barcode = Fields.Char({ related: 'employeeId.barcode', readonly: false, relatedSudo: false });
    static pin = Fields.Char({ related: 'employeeId.pin', readonly: false, relatedSudo: false });
    static certificate = Fields.Selection({ related: 'employeeId.certificate', readonly: false, relatedSudo: false });
    static studyField = Fields.Char({ related: 'employeeId.studyField', readonly: false, relatedSudo: false });
    static studySchool = Fields.Char({ related: 'employeeId.studySchool', readonly: false, relatedSudo: false });
    static employeeCount = Fields.Integer({ compute: '_computeEmployeeCount' });
    static hrPresenceState = Fields.Selection({ related: 'employeeId.hrPresenceState' });
    static lastActivity = Fields.Date({ related: 'employeeId.lastActivity' });
    static lastActivityTime = Fields.Char({ related: 'employeeId.lastActivityTime' });
    static employeeType = Fields.Selection({ related: 'employeeId.employeeType', readonly: false, relatedSudo: false });
    static canEdit = Fields.Boolean({ compute: '_computeCanEdit' });
    static isSystem = Fields.Boolean({ compute: '_computeIsSystem' });

    @api.dependsContext('uid')
    async _computeIsSystem() {
        await this.set('isSystem', await (await this.env.user())._isSystem());
    }

    async _computeCanEdit() {
        const canEdit = await (await this.env.items('ir.config.parameter').sudo()).getParam('hr.hrEmployeeSelfEdit') || await (await this.env.user()).hasGroup('hr.groupHrUser');
        for (const user of this) {
            await user.set('canEdit', canEdit);
        }
    }

    @api.depends('employeeIds')
    async _computeEmployeeCount() {
        for (const user of await this.withContext({ activeTest: false })) {
            await user.set('employeeCount', len(await user.employeeIds));
        }
    }

    SELF_READABLE_FIELDS() {
        return _super(User, this).SELF_READABLE_FIELDS().concat(HR_READABLE_FIELDS).concat(HR_WRITABLE_FIELDS);
    }

    SELF_WRITEABLE_FIELDS() {
        return _super(User, this).SELF_WRITEABLE_FIELDS().concat(HR_WRITABLE_FIELDS);
    }

    @api.model()
    async fieldsViewGet(viewId?: any, viewType: string = 'form', toolbar: boolean = false, submenu: boolean = false) {
        // When the front-end loads the views it gets the list of available fields
        // for the user (according to its access rights). Later, when the front-end wants to
        // populate the view with data, it only asks to read those available Fields.
        // However, in this case, we want the user to be able to read/write its own data,
        // even if they are protected by groups.
        // We make the front-end aware of those fields by sending all field definitions.
        // Note: limit the `sudo` to the only action of "editing own profile" action in order to
        // avoid breaking `groups` mecanism on res.users form view.
        const profileView = await this.env.ref("hr.resUsersViewFormProfile");
        const originalUser = await this.env.user();
        let self = this;
        if (profileView && viewId == profileView.id) {
            self = await self.withUser(global.SUPERUSER_ID);
        }
        const result = await _super(User, self).fieldsViewGet(viewId, viewType, toolbar, submenu);
        // Due to using the SUPERUSER the result will contain action that the user may not have access too
        // here we filter out actions that requires special implicit rights to avoid having unusable actions
        // in the dropdown menu.
        if (toolbar && !(await self.env.user()).eq(originalUser)) {
            self = await self.withUser(originalUser.id);
            if (! await self.userHasGroups("base.groupErpManager")) {
                const changePasswordAction = await self.env.ref("base.changePasswordWizardAction");
                result['toolbar']['action'] = result['toolbar']['action'].filter(act => act['id'] != changePasswordAction.id);
            }
        }
        return result;
    }

    /**
     * Get values to sync to the related employee when the User is changed.
     * @returns 
     */
    _getEmployeeFieldsToSync() {
        return ['label', 'email', 'image1920', 'tz'];
    }

    /**
     * Synchronize user and its related employee
        and check access rights if employees are not allowed to update
        their own data (otherwise sudo is applied for self data).
     * @param vals 
     */
    async write(vals) {
        const hrFields = new Set();
        for (const [fieldName, field] of this._fields) {
            if (field.relatedField && field.relatedField.modelName === 'hr.employee' && fieldName in vals) {
                hrFields.add(field);
            }
        }
        const canEditSelf = await (await this.env.items('ir.config.parameter').sudo()).getParam('hr.hrEmployeeSelfEdit') || await (await this.env.user()).hasGroup('hr.groupHrUser');
        if (hrFields.size && !canEditSelf) {
            // Raise meaningful error message
            throw new AccessError(await this._t("You are only allowed to update your preferences. Please contact a HR officer to update other information."));
        }

        const result = await _super(User, this).write(vals);

        const employeeValues = {}
        for (const fname of this._getEmployeeFieldsToSync().filter(f => f in vals)) {
            employeeValues[fname] = vals[fname];
        }

        if (bool(employeeValues)) {
            if ('email' in employeeValues) {
                employeeValues['workEmail'] = pop(employeeValues, 'email');
            }
            if ('image1920' in vals) {
                const withoutImage = await (await this.env.items('hr.employee').sudo()).search([['userId', 'in', this.ids], ['image1920', '=', false]]);
                const withImage = await (await this.env.items('hr.employee').sudo()).search([['userId', 'in', this.ids], ['image1920', '!=', false]]);
                await withoutImage.write(employeeValues);
                if (!canEditSelf) {
                    pop(employeeValues, 'image1920');
                }
                await withImage.write(employeeValues);
            }
            else {
                await (await (await this.env.items('hr.employee').sudo()).search([['userId', 'in', this.ids]])).write(employeeValues);
            }
        }
        return result;
    }

    @api.model()
    async actionGet() {
        if ((await (await this.env.user()).employeeId).ok) {
            return this.env.items('ir.actions.actions')._forXmlid('hr.resUsersActionMy');
        }
        return _super(User, this).actionGet();
    }

    @api.depends('employeeIds')
    @api.dependsContext('company')
    async _computeCompanyEmployee() {
        const employeePerUser = new MapKey<any, any>();
        for (const employee of await this.env.items('hr.employee').search([['userId', 'in', this.ids], ['companyId', '=', (await this.env.company()).id]])) {
            employeePerUser.set(await employee.userId, employee);
        }
        for (const user of this) {
            await user.set('employeeId', employeePerUser.get(user));
        }
    }

    _searchCompanyEmployee(operator, value) {
        return [['employeeIds', operator, value]];
    }

    async actionCreateEmployee() {
        this.ensureOne();
        await this.env.items('hr.employee').create(Object.assign({},
            {
                label: await this['label'],
                companyId: (await this.env.company()).id,
                ...await this.env.items('hr.employee')._syncUser(this)
            }
        ));
    }
}