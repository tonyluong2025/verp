import { Fields } from "../../../core";
import { AccessError } from "../../../core/helper";
import { MetaModel, Model, _super } from "../../../core/models";
import { isInstance, len } from "../../../core/tools";

@MetaModel.define()
class Partner extends Model {
    static _module = module;
    static _parents = ['res.partner'];

    static employeeIds = Fields.One2many(
        'hr.employee', 'addressHomeId', { string: 'Employees', groups: "hr.groupHrUser",
        help: "Related employees based on their private address"
    });
    static employeesCount = Fields.Integer({ compute: '_computeEmployeesCount', groups: "hr.groupHrUser" });

    /**
     * Override to allow an employee to see its private address in his profile.
            This avoids to relax access rules on `res.parter` and to add an `ir.rule`.
            (advantage in both security and performance).
            Use a try/except instead of systematically checking to minimize the impact on performance.
     * @returns 
     */
    async nameGet() {
        try {
            const res = await _super(Partner, this).nameGet();
            return res;
        } catch (e) {
            if (isInstance(e, AccessError)) {
                if (len(this) == 1 && (await (await (await this.env.user()).employeeIds).mapped('addressHomeId')).includes(this)) {
                    return _super(Partner, await this.sudo()).nameGet();
                }
            }
            throw e;
        }
    }

    async _computeEmployeesCount() {
        for (const partner of this) {
            await partner.set('employeesCount', len(await partner.employeeIds));
        }
    }

    async actionOpenEmployees() {
        this.ensureOne();
        return {
            'label': await this._t('Related Employees'),
            'type': 'ir.actions.actwindow',
            'resModel': 'hr.employee',
            'viewMode': 'kanban,tree,form',
            'domain': [['id', 'in', (await this['employeeIds']).ids]],
        }
    }
}
