import { Fields, api } from "../../../core";
import { UserError } from "../../../core/helper";
import { MetaModel, Model } from "../../../core/models";
import { bool } from "../../../core/tools";

@MetaModel.define()
class HrPlanActivityType extends Model {
    static _module = module;
    static _name = 'hr.plan.activity.type';
    static _description = 'Plan activity type';
    static _recName = 'summary';

    static activityTypeId = Fields.Many2one('mail.activity.type', {
        string: 'Activity Type',
        default: self => self.env.ref('mail.mailActivityDataTodo'),
        domain: (self) => ['|', ['resModel', '=', false], ['resModel', '=', 'hr.employee']],
        ondelete: 'RESTRICT'
    });
    static summary = Fields.Char('Summary', { compute: "_computeDefaultSummary", store: true, readonly: false });
    static responsible = Fields.Selection([
        ['coach', 'Coach'],
        ['manager', 'Manager'],
        ['employee', 'Employee'],
        ['other', 'Other']], { default: 'employee', string: 'Responsible', required: true });
    // sgv todo change back to 'Responsible Person'
    static responsibleId = Fields.Many2one('res.users', { string: 'Name', help: 'Specific responsible of activity if not linked to the employee.' });
    static note = Fields.Html('Note');

    @api.depends('activityTypeId')
    async _computeDefaultSummary() {
        for (const planType of this) {
            if (!await planType.summary && (await planType.activityTypeId).ok && await (await planType.activityTypeId).summary) {
                await planType.set('summary', await (await planType.activityTypeId).summary);
            }
        }
    }

    async getResponsibleId(employee) {
        let responsible = await this['responsible'];
        const [label, coach, parent] = await employee('label', 'coachId', 'parentId');
        if (responsible === 'coach') {
            if (coach.ok) {
                throw new UserError(await this._t('Coach of employee %s is not set.', label));
            }
            responsible = await coach.userId;
            if (!bool(responsible)) {
                throw new UserError(await this._t('User of coach of employee %s is not set.', label));
            }
        }
        else if (responsible === 'manager') {
            if (parent.ok) {
                throw new UserError(await this._t('Manager of employee %s is not set.', label));
            }
            responsible = await parent.userId;
            if (!bool(responsible)) {
                throw new UserError(await this._t('User of manager of employee %s is not set.', label));
            }
        }
        else if (responsible === 'employee') {
            responsible = await employee.userId;
            if (!bool(responsible)) {
                throw new UserError(await this._t('User linked to employee %s is required.', label));
            }
        }
        else if (responsible === 'other') {
            responsible = await this['responsibleId'];
            if (!bool(responsible)) {
                throw new UserError(await this._t('No specific user given on activity %s.', await (await this['activityTypeId']).label));
            }
        }
        return responsible;
    }
}

@MetaModel.define()
class HrPlan extends Model {
    static _module = module;
    static _name = 'hr.plan';
    static _description = 'plan';

    static label = Fields.Char('Name', { required: true });
    static planActivityTypeIds = Fields.Many2many('hr.plan.activity.type', { string: 'Activities' });
    static active = Fields.Boolean({ default: true });
}