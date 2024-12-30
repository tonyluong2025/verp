import { Fields } from "../../../core";
import { MetaModel, Model } from "../../../core/models";

@MetaModel.define()
class LeadScoringFrequency extends Model {
    static _module = module;
    static _name = 'crm.lead.scoring.frequency';
    static _description = 'Lead Scoring Frequency';

    static variable = Fields.Char('Variable', { index: true });
    static value = Fields.Char('Value');
    static wonCount = Fields.Float('Won Count', { digits: [16, 1] });  // Float because we add 0.1 to avoid zero Frequency issue
    static lostCount = Fields.Float('Lost Count', { digits: [16, 1] });  // Float because we add 0.1 to avoid zero Frequency issue
    static teamId = Fields.Many2one('crm.team', { string: 'Sales Team', ondelete: "CASCADE" });
}

@MetaModel.define()
class FrequencyField extends Model {
    static _module = module;
    static _name = 'crm.lead.scoring.frequency.field';
    static _description = 'Fields that can be used for predictive lead scoring computation';

    static label = Fields.Char({ related: "fieldId.fieldDescription" });
    static fieldId = Fields.Many2one(
        'ir.model.fields', {
            domain: [['modelId.model', '=', 'crm.lead']], required: true,
            ondelete: 'CASCADE'
        }
    );
}