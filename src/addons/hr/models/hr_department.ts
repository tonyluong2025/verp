import { Fields, api } from "../../../core";
import { ValidationError } from "../../../core/helper";
import { MetaModel, Model, _super } from "../../../core/models";
import { bool, f } from "../../../core/tools";

@MetaModel.define()
class Department extends Model {
    static _module = module;
    static _name = "hr.department";
    static _description = "Department";
    static _parents = ['mail.thread'];
    static _order = "label";
    static _recName = 'completeName';

    static label = Fields.Char('Department Name', { required: true });
    static completeName = Fields.Char('Complete Name', { compute: '_computeCompleteName', recursive: true, store: true });
    static active = Fields.Boolean('Active', { default: true });
    static companyId = Fields.Many2one('res.company', { string: 'Company', index: true, default: self => self.env.company() });
    static parentId = Fields.Many2one('hr.department', { string: 'Parent Department', index: true, domain: "['|', ['companyId', '=', false], ['companyId', '=', companyId]]" });
    static childIds = Fields.One2many('hr.department', 'parentId', { string: 'Child Departments' });
    static managerId = Fields.Many2one('hr.employee', { string: 'Manager', tracking: true, domain: "['|', ['companyId', '=', false], ['companyId', '=', companyId]]" });
    static memberIds = Fields.One2many('hr.employee', 'departmentId', { string: 'Members', readonly: true });
    static totalEmployee = Fields.Integer({ compute: '_computeTotalEmployee', string: 'Total Employee' });
    static jobsIds = Fields.One2many('hr.job', 'departmentId', { string: 'Jobs' });
    static note = Fields.Text('Note');
    static color = Fields.Integer('Color Index');

    async nameGet() {
        if (!(this.env.context['hierarchicalNaming'] ?? true)) {
            return this.map(async (record) => [record.id, await record.label]);
        }
        return _super(Department, this).nameGet();
    }

    @api.model()
    async nameCreate(name) {
        return (await (await this.create({ 'label': name })).nameGet())[0];
    }

    @api.depends('label', 'parentId.completeName')
    async _computeCompleteName() {
        for (const department of this) {
            if ((await department.parentId).ok) {
                await department.set('completeName', f('%s / %s', await (await department.parentId).completeName, await department.label));
            }
            else {
                await department.set('completeName', await department.label);
            }
        }
    }

    async _computeTotalEmployee() {
        const empData = await this.env.items('hr.employee').readGroup([['departmentId', 'in', this.ids]], ['departmentId'], ['departmentId']);
        const result = Object.fromEntries(empData.map(data => [data['departmentId'][0], data['departmentId_count']]));
        for (const department of this) {
            await department.set('totalEmployee', result[department.id] ?? 0);
        }
    }

    @api.constrains('parentId')
    async _checkParentId() {
        if (! await this._checkRecursion()) {
            throw new ValidationError(await this._t('You cannot create recursive departments.'));
        }
    }

    @api.model()
    async create(vals) {
        // TDE note: auto-subscription of manager done by hand, because currently
        // the tracking allows to track+subscribe fields linked to a res.user record
        // An update of the limited behavior should come, but not currently done.
        const department = await (await _super(Department, await this.withContext({ mailCreateNosubscribe: true }))).create(vals);
        const manager = this.env.items('hr.employee').browse(vals['managerId']);
        const user = await manager.userId;
        if (user.ok) {
            await department.messageSubscribe((await user.partnerId).ids);
        }
        return department;
    }

    /**
     * If updating manager of a department, we need to update all the employees
            of department hierarchy, and subscribe the new manager.
     * @param vals 
     * @returns 
     */
    async write(vals) {
        // TDE note: auto-subscription of manager done by hand, because currently
        // the tracking allows to track+subscribe fields linked to a res.user record
        // An update of the limited behavior should come, but not currently done.
        if ('managerId' in vals) {
            const managerId = vals["managerId"];
            if (bool(managerId)) {
                const manager = this.env.items('hr.employee').browse(managerId);
                // subscribe the manager user
                const user = await manager.userId;
                if (user.ok) {
                    await (this as any).messageSubscribe((await user.partnerId).ids);
                }
            }
            // set the employees's parent to the new manager
            await this._updateEmployeeManager(managerId);
        }
        return _super(Department, this).write(vals);
    }

    async _updateEmployeeManager(managerId) {
        let employees = this.env.items('hr.employee');
        for (const department of this) {
            employees = employees.or(await this.env.items('hr.employee').search([
                ['id', '!=', managerId],
                ['departmentId', '=', department.id],
                ['parentId', '=', (await department.managerId).id]
            ]));
        }
        await employees.write({ 'parentId': managerId });
    }
}