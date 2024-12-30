import { Fields, api } from "../../../core";
import { MetaModel, Model } from "../../../core/models"
import { bool } from "../../../core/tools";

@MetaModel.define()
class ResUsers extends Model {
    static _module = module;
    static _parents = 'res.users';

    static crmTeamIds = Fields.Many2many(
        'crm.team', {relation: 'crmTeamMember', column1: 'userId', column2: 'crmTeamId', string: 'Sales Teams',
        checkCompany: true, copy: false, readonly: true,
        compute: '_computeCrmTeamIds', search: '_searchCrmTeamIds'});
    static crmTeamMemberIds = Fields.One2many('crm.team.member', 'userId', { string: 'Sales Team Members'});
    static saleTeamId = Fields.Many2one(
        'crm.team', {string: 'User Sales Team', compute: '_computeSaleTeamId',
        readonly: true, store: true,
        help: "Main user sales team. Used notably for pipeline, or to set sales team in invoicing or subscription."});

    @api.depends('crmTeamMemberIds.active')
    async _computeCrmTeamIds() {
        for (const user of this) {
            await user.set('crmTeamIds', await (await user.crmTeamMemberIds).crmTeamId);
        }
    }
    
    async _searchCrmTeamIds(operator, value) {
        return [['crmTeamMemberIds.crmTeamId', operator, value]];
    }

    @api.depends('crmTeamMemberIds.crmTeamId', 'crmTeamMemberIds.createdAt', 'crmTeamMemberIds.active')
    async _computeSaleTeamId() {
        for (const user of this) {
            if (! bool((await user.crmTeamMemberIds).ids)) {
                await user.set('saleTeamId', false);
            }
            else {
                const sortedMemberships = await user.crmTeamMemberIds;  // sorted by create date
                await user.set('saleTeamId', bool(sortedMemberships) ? await sortedMemberships(0).crmTeamId : false);
            }
        }
    }
}