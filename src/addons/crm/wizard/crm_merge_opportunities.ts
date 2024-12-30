import { Fields, api } from "../../../core";
import { MetaModel, TransientModel, _super } from "../../../core/models";
import { bool } from "../../../core/tools";

/**
 *  Merge opportunities together.
    
    If we're talking about opportunities, it's just because it makes more sense
    to merge opps than leads, because the leads are more ephemeral objects.
    But since opportunities are leads, it's also possible to merge leads
    together (resulting in a new lead), or leads and opps together (resulting
    in a new opp).
 */
@MetaModel.define()
class MergeOpportunity extends TransientModel {
    static _module = module;
    static _name = 'crm.merge.opportunity';
    static _description = 'Merge Opportunities';

    /**
     * Use activeIds from the context to fetch the leads/opps to merge.
        In order to get merged, these leads/opps can't be in 'Dead' or 'Closed'
     * @param fields 
     * @returns 
     */
    @api.model()
    async defaultGet(fields) {
        const recordIds = this._context['activeIds'];
        const result = await _super(MergeOpportunity, this).defaultGet(fields);

        if (bool(recordIds)) {
            if (fields.includes('opportunityIds')) {
                const oppIds = (await this.env.items('crm.lead').browse(recordIds).filtered(async (opp) => await opp.probability < 100)).ids;
                result['opportunityIds'] = [[6, 0, oppIds]];
            }
        }
        return result;
    }

    static opportunityIds = Fields.Many2many('crm.lead', {relation: 'mergeOpportunityRel', column1: 'mergeId', column2: 'opportunityId', string: 'Leads/Opportunities'});
    static userId = Fields.Many2one('res.users', {string: 'Salesperson', index: true});
    static teamId = Fields.Many2one(
        'crm.team', {string: 'Sales Team', index: true,
        compute: '_computeTeamId', readonly: false, store: true});

    async actionMerge() {
        this.ensureOne();
        const mergeOpportunity = await (await this['opportunityIds']).mergeOpportunity((await this['userId']).id, (await this['teamId']).id);
        return mergeOpportunity.redirectLeadOpportunityView();
    }

    /**
     * When changing the user, also set a teamId or restrict team id
            to the ones userId is member of.
     */
    @api.depends('userId')
    async _computeTeamId() {
        for (const wizard of this) {
            const [user, team] = await wizard('userId','teamId');
            if (user.ok) {
                let userInTeam = false;
                if (team.ok) {
                    userInTeam = await wizard.env.items('crm.team').searchCount([['id', '=', team.id], '|', ['userId', '=', user.id], ['memberIds', '=', user.id]]);
                }
                if (!userInTeam) {
                    await wizard.set('teamId', await wizard.env.items('crm.team').search(['|', ['userId', '=', user.id], ['memberIds', '=', user.id]], {limit: 1}));
                }
            }
        }           
    }
}