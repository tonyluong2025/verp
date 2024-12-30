import { Fields, api } from "../../../core";
import { MetaModel, Model, _super } from "../../../core/models";
import { pop } from "../../../core/tools";

export const AVAILABLE_PRIORITIES = [
    ['0', 'Low'],
    ['1', 'Medium'],
    ['2', 'High'],
    ['3', 'Very High'],
];

/**
 * Model for case stages. This models the main stages of a document
        management flow. Main CRM objects (leads, opportunities, project
        issues, ...) will now use only stages, instead of state and stages.
        Stages are for example used to display the kanban view of records.
 */
@MetaModel.define()
class Stage extends Model {
    static _module = module;
    static _name = "crm.stage";
    static _description = "CRM Stages";
    static _recName = 'label';
    static _order = "sequence, label, id";

    /**
     * As we have lots of default_team_id in context used to filter out
        leads and opportunities, we pop this key from default of stage creation.
        Otherwise stage will be created for a given team only which is not the
        standard behavior of stages.
     * @param fields 
     * @returns 
     */
    @api.model()
    async defaultGet(fields) {
        let self = this;
        if ('default_teamId' in this.env.context) {
            const ctx = Object.assign({}, this.env.context);
            pop(ctx, 'default_teamId');
            self = await self.withContext(ctx);
        }
        return _super(Stage, self).defaultGet(fields);
    }

    static label = Fields.Char('Stage Name', { required: true, translate: true });
    static sequence = Fields.Integer('Sequence', { default: 1, help: "Used to order stages. Lower is better." });
    static isWon = Fields.Boolean('Is Won Stage?');
    static requirements = Fields.Text('Requirements', { help: "Enter here the internal requirements for this stage (ex: Offer sent to customer). It will appear as a tooltip over the stage's name." });
    static teamId = Fields.Many2one('crm.team', {
        string: 'Sales Team', ondelete: "SET NULL",
        help: 'Specific team that uses this stage. Other teams will not be able to see or use this stage.'
    });
    static fold = Fields.Boolean('Folded in Pipeline',
        { help: 'This stage is folded in the kanban view when there are no records in that stage to display.' });
    // This field for interface only
    static teamCount = Fields.Integer('teamCount', { compute: '_computeTeamCount' });

    @api.depends('label')
    async _computeTeamCount() {
        await this.set('teamCount', await this.env.items('crm.team').searchCount([]));
    }
}