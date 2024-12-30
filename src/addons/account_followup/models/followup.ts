import { Fields, api } from "../../../core";
import { ValidationError } from "../../../core/helper";
import { MetaModel, Model, _super } from "../../../core/models";
import { _f, isInstance } from "../../../core/tools";

@MetaModel.define()
class FollowupFollowup extends Model {
    static _module = module;
    static _name = 'followup.followup';
    static _description = 'Account Follow-up';
    static _recName = 'label';

    static label = Fields.Char({string: "Name", related: 'companyId.label', readonly: true});
    static followupLine = Fields.One2many('followup.line', 'followupId', { string: 'Follow-up', copy: true});
    static companyId = Fields.Many2one('res.company', {string: 'Company', required: true, default: self => self.env.company()});

    static _sqlConstraints = [['company_uniq', 'unique("companyId")',
                         'Only one follow-up per company is allowed']];
}

@MetaModel.define()
class FollowupLine extends Model {
    static _module = module;
    static _name = 'followup.line';
    static _description = 'Follow-up Criteria';
    static _order = 'delay';

    async _computeSequence() {
        const followupLine = await (await this['followupId']).followupLine;
        const delays: any[] = await followupLine.map(line => line.delay);
        delays.sort();
        for (const line of followupLine) {
            const sequence = delays.indexOf(await line.delay);
            await line.set('sequence', sequence+1);
        }
    }

    @api.model()
    async defaultGet(defaultFields) {
        const values = await _super(FollowupLine, this).defaultGet(defaultFields);
        const ref = await this.env.ref('account_followup.emailTemplateAccountFollowupDefault')
        if (ref.ok) {
            values['emailTemplateId'] = ref.id;
        }
        return values;
    }

    static label = Fields.Char('Follow-Up Action', {required: true});
    static sequence = Fields.Integer('Sequence', {compute:'_computeSequence',
                              store: false,
                              help: "Gives the sequence order when displaying a list of follow-up lines."});
    static followupId = Fields.Many2one('followup.followup', {string: 'Follow Ups',
                                  required: true, ondelete: 'CASCADE'});
    static delay = Fields.Integer('Due Days',
                           {help: ["The number of days after the due date of the ",
                                "invoice to wait before sending the reminder. Could be negative if you want ",
                                "to send a polite alert beforehand."].join(),
                           required: true});
    static description = Fields.Text('Printed Message', {translate: true, default: `
        Dear {partnerName},

Exception made if there was a mistake of ours, it seems that the following
amount stays unpaid. Please, take appropriate measures in order to carry out
this payment in the next 8 days.

Would your payment have been carried out after this mail was sent, please
ignore this message. Do not hesitate to contact our accounting department.

Best Regards,
`});
    static sendEmail = Fields.Boolean('Send an Email', {default: true,
                                help: "When processing, it will send an email"});
    static sendLetter = Fields.Boolean('Send a Letter', {default: true,
                                 help: "When processing, it will print a letter"});
    static manualAction = Fields.Boolean('Manual Action', {default: false,
                                   help: "When processing, it will set the manual action to be taken for that customer."});
    static manualActionNote = Fields.Text('Action To Do');
    static manualActionResponsibleId = Fields.Many2one('res.users',
                                                   {string: 'Assign a Responsible', ondelete: 'SET NULL'});
    static emailTemplateId = Fields.Many2one('mail.template', {string: 'Email Template',
                                        ondelete: 'SET NULL'});

    static _sqlConstraints = [['days_uniq', 'unique("followupId", delay)',
                         'Days of the follow-up levels must be different']];

    @api.constrains('description')
    async _checkDescription() {
        for (const line of this) {
            if (await line.description) {
                try {
                    _f(await line.description, {'partnerName': '', 'date': '',
                                                'userSignature': '',
                                                'companyName': ''});
                } catch(e) {
                    if (isInstance(e, ValidationError)) {
                        throw new ValidationError(
                        await this._t('Your description is invalid, use the right legend or %% if you want to use the percent character.'));
                    } else {
                        throw e;
                    }
                }
            }
        }
    }
}