import { Fields } from "../../../core";
import { MetaModel, Model } from "../../../core/models"

@MetaModel.define()
class RecurringPlan extends Model {
    static _module = module;
    static _name = "crm.recurring.plan";
    static _description = "CRM Recurring revenue plans";
    static _order = "sequence";

    static label = Fields.Char('Plan Name', {required: true, translate: true});
    static numberOfMonths = Fields.Integer('# Months', {required: true});
    static active = Fields.Boolean('Active', {default: true});
    static sequence = Fields.Integer('Sequence', {default: 10});

    static _sqlConstraints = [
        ['checkNumberOfMonths', 'CHECK("numberOfMonths" >= 0)', 'The number of month can\'t be negative.'],
    ];
}