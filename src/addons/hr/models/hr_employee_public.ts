import { Fields, api, tools } from "../../../core";
import { MetaModel, Model } from "../../../core/models"
import { f, quoteDouble, quoteList } from "../../../core/tools";

@MetaModel.define()
class HrEmployeePublic extends Model {
    static _module = module;
    static _name = "hr.employee.public";
    static _parents = ["hr.employee.base"];
    static _description = 'Public Employee';
    static _order = 'label';
    static _auto = false;
    static _logAccess = true; // Include magic fields

    // Fields coming from hr.employee.base
    static createdAt = Fields.Datetime({readonly: true});
    static label = Fields.Char({readonly: true});
    static active = Fields.Boolean({readonly: true});
    static departmentId = Fields.Many2one({readonly: true});
    static jobId = Fields.Many2one({readonly: true});
    static jobTitle = Fields.Char({readonly: true});
    static companyId = Fields.Many2one({readonly: true});
    static addressId = Fields.Many2one({readonly: true});
    static mobilePhone = Fields.Char({readonly: true});
    static workPhone = Fields.Char({readonly: true});
    static workEmail = Fields.Char({readonly: true});
    static workLocationId = Fields.Many2one({readonly: true});
    static userId = Fields.Many2one({readonly: true});
    static resourceId = Fields.Many2one({readonly: true});
    static resourceCalendarId = Fields.Many2one({readonly: true});
    static tz = Fields.Selection({readonly: true});
    static color = Fields.Integer({readonly: true});
    static employeeType = Fields.Selection({readonly: true});

    static employeeId = Fields.Many2one('hr.employee', {string: 'Employee', compute: "_computeEmployeeId", search: "_searchEmployeeId", computeSudo: true});
    // hr.employee.public specific fields
    static childIds = Fields.One2many('hr.employee.public', 'parentId', { string: 'Direct subordinates', readonly: true});
    static image1920 = Fields.Image("Image", {related: 'employeeId.image1920', computeSudo: true});
    static image1024 = Fields.Image("Image 1024", {related: 'employeeId.image1024', computeSudo: true});
    static image512 = Fields.Image("Image 512", {related: 'employeeId.image512', computeSudo: true});
    static image256 = Fields.Image("Image 256", {related: 'employeeId.image256', computeSudo: true});
    static image128 = Fields.Image("Image 128", {related: 'employeeId.image128', computeSudo: true});
    static avatar1920 = Fields.Image("Avatar", {related: 'employeeId.avatar1920', computeSudo: true});
    static avatar1024 = Fields.Image("Avatar 1024", {related: 'employeeId.avatar1024', computeSudo: true});
    static avatar512 = Fields.Image("Avatar 512", {related: 'employeeId.avatar512', computeSudo: true});
    static avatar256 = Fields.Image("Avatar 256", {related: 'employeeId.avatar256', computeSudo: true});
    static avatar128 = Fields.Image("Avatar 128", {related: 'employeeId.avatar128', computeSudo: true});
    static parentId = Fields.Many2one('hr.employee.public', {string: 'Manager', readonly: true});
    static coachId = Fields.Many2one('hr.employee.public', {string: 'Coach', readonly: true});
    static userPartnerId = Fields.Many2one({related: 'userId.partnerId', relatedSudo: false, string: "User's partner"});

    async _searchEmployeeId(operator, value) {
        return [['id', operator, value]];
    }

    async _computeEmployeeId() {
        for (const employee of this) {
            await employee.set('employeeId', this.env.items('hr.employee').browse(employee.id));
        }
    }

    @api.model()
    async _getFields() {
        return this._fields.items().filter(([, field]) => field.store && !['many2many', 'one2many'].includes(field.type)).map(([name,]) => f('emp."%s"', name)).join(',');
    }

    async init() {
        await tools.dropViewIfExists(this._cr, this.cls._table);
        await this._cr.execute(f(`
                CREATE or REPLACE VIEW "${this.cls._table}" as (
                SELECT
                    %s
                FROM "hrEmployee" emp
            )`, await this._getFields())
        );
    }
}