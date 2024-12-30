import { Fields } from "../../../core";
import { MetaModel, TransientModel } from "../../../core/models"

@MetaModel.define()
class HrPlanWizard extends TransientModel {
    static _module = module;
    static _name = 'hr.plan.wizard';
    static _description = 'Plan Wizard';

    static planId = Fields.Many2one('hr.plan', {default: self => self.env.items('hr.plan').search([], {limit: 1})});
    static employeeId = Fields.Many2one(
        'hr.employee', {string: 'Employee', required: true,
        default: self => self.env.context['activeId'] ?? null,
    });

    async actionLaunch() {
        const [employee, plan] = await this('employeeId', 'planId');
        for (const activityType of await plan.planActivityTypeIds) {
            const responsible = await activityType.getResponsibleId(employee);

            if (await (await this.env.items('hr.employee').withUser(responsible)).checkAccessRights('read', false)) {
                const dateDeadline = await this.env.items('mail.activity')._calculateDateDeadline(await activityType.activityTypeId);
                await employee.activitySchedule({
                    activityTypeId: (await activityType.activityTypeId).id,
                    summary: await activityType.summary,
                    note: await activityType.note,
                    userId: responsible.id,
                    dateDeadline: dateDeadline
                });
            }
        }
        return {
            'type': 'ir.actions.actwindow',
            'resModel': 'hr.employee',
            'resId': employee.id,
            'label': await employee.displayName,
            'viewMode': 'form',
            'views': [[false, "form"]],
        }
    }
}
