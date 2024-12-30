import { Fields, api } from "../../../core";
import { MetaModel, Model, _super } from "../../../core/models";
import { len } from "../../../core/tools";
import { handleHistoryDivergence } from "../../web_editor";

@MetaModel.define()
class Job extends Model {
    static _module = module;
    static _name = "hr.job";
    static _description = "Job Position";
    static _parents = ['mail.thread'];
    static _order = 'sequence';

    static label = Fields.Char({ string: 'Job Position', required: true, index: true, translate: true });
    static sequence = Fields.Integer({ default: 10 });
    static expectedEmployees = Fields.Integer({
        compute: '_computeEmployees', string: 'Total Forecasted Employees', store: true,
        help: 'Expected number of employees for this job position after new recruitment.'
    });
    static noOfEmployee = Fields.Integer({
        compute: '_computeEmployees', string: "Current Number of Employees", store: true,
        help: 'Number of employees currently occupying this job position.'
    });
    static noOfRecruitment = Fields.Integer({
        string: 'Expected New Employees', copy: false,
        help: 'Number of new employees you expect to recruit.', default: 1
    });
    static noOfHiredEmployee = Fields.Integer({
        string: 'Hired Employees', copy: false,
        help: 'Number of hired employees for this job position during recruitment phase.'
    });
    static employeeIds = Fields.One2many('hr.employee', 'jobId', { string: 'Employees', groups: 'base.groupUser' });
    static description = Fields.Html({ string: 'Job Description', sanitizeAttributes: false });
    static requirements = Fields.Text('Requirements');
    static departmentId = Fields.Many2one('hr.department', { string: 'Department', domain: "['|', ['companyId', '=', false], ['companyId', '=', companyId]]" });
    static companyId = Fields.Many2one('res.company', { string: 'Company', default: self => self.env.company() });
    static state = Fields.Selection([
        ['recruit', 'Recruitment in Progress'],
        ['open', 'Not Recruiting']
    ], { string: 'Status', readonly: true, required: true, tracking: true, copy: false, default: 'recruit', help: "Set whether the recruitment process is open or closed for this job position." });

    static _sqlConstraints = [
        ['label_company_uniq', 'unique(label, "companyId", "departmentId")', 'The name of the job position must be unique per department in company!'],
        ['no_of_recruitment_positive', 'CHECK("noOfRecruitment" >= 0)', 'The expected number of new employees must be positive.']
    ];

    @api.depends('noOfRecruitment', 'employeeIds.jobId', 'employeeIds.active')
    async _computeEmployees() {
        const employeeData = await this.env.items('hr.employee').readGroup([['jobId', 'in', this.ids]], ['jobId'], ['jobId']);
        const result = Object.fromEntries(employeeData.map(data => [data['jobId'][0], data['jobId_count']]));
        for (const job of this) {
            await job.update({
                noOfEmployee: result[job.id] ?? 0,
                expectedEmployees: (result[job.id] ?? 0) + await job.noOfRecruitment
            });
        }
    }

    /**
     * We don't want the current user to be follower of all created job
     * @param values 
     * @returns 
     */
    @api.model()
    async create(values) {
        return _super(Job, await this.withContext({ mailCreateNosubscribe: true })).create(values);
    }

    @api.returns('self', (value) => value.id)
    async copy(defaultValues: {} = {}) {
        this.ensureOne();
        if (!('label' in defaultValues)) {
            defaultValues['label'] = await this._t("%s (copy)", await this['label']);
        }
        return _super(Job, this).copy(defaultValues);
    }

    async setRecruit() {
        for (const record of this) {
            const noOfRecruitment = await record.noOfRecruitment == 0 ? 1 : await record.noOfRecruitment;
            await record.write({ 'state': 'recruit', 'noOfRecruitment': noOfRecruitment });
        }
        return true;
    }

    async setOpen() {
        return this.write({
            'state': 'open',
            'noOfRecruitment': 0,
            'noOfHiredEmployee': 0
        });
    }

    async write(vals) {
        if (len(this) == 1) {
            await handleHistoryDivergence(this, 'description', vals);
        }
        return _super(Job, this).write(vals);
    }
}