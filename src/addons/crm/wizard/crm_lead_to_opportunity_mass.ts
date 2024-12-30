import { Fields, api } from "../../../core";
import { MetaModel, TransientModel, _super } from "../../../core/models";
import { extend, len } from "../../../core/tools";

@MetaModel.define()
class Lead2OpportunityMassConvert extends TransientModel {
    static _module = module;
    static _name = 'crm.lead2opportunity.partner.mass';
    static _description = 'Convert Lead to Opportunity (in mass)';
    static _parents = 'crm.lead2opportunity.partner';

    static leadId = Fields.Many2one({ required: false });
    static leadTomergeIds = Fields.Many2many(
        'crm.lead', {
            relation: 'crmConvertLeadMassLeadRel',
        string: 'Active Leads', context: { 'activeTest': false },
        default: self => (self.env.context['activeIds'] ?? []),
    });
    static userIds = Fields.Many2many('res.users', { string: 'Salespersons' });
    static deduplicate = Fields.Boolean('Apply deduplication', { default: true, help: 'Merge with existing leads/opportunities of each partner' });
    static action = Fields.Selection({
        selectionAdd: [
            ['eachExistOrCreate', 'Use existing partner or create'],
        ], string: 'Related Customer', ondelete: {
            'eachExistOrCreate': async (recs) => recs.write({ 'action': 'exist' }),
        }
    });
    static forceAssignment = Fields.Boolean({ default: false });

    @api.depends('duplicatedLeadIds')
    async _computeName() {
        for (const convert of this) {
            await convert.set('label', 'convert');
        }
    }

    @api.depends('leadTomergeIds')
    async _computeAction() {
        for (const convert of this) {
            await convert.set('action', 'eachExistOrCreate');
        }
    }

    @api.depends('leadTomergeIds')
    async _computePartnerId() {
        for (const convert of this) {
            await convert.set('partnerId', false);
        }
    }

    @api.depends('userIds')
    async _computeTeamId() {
        for (const convert of this) {
            let [user, team, userIds] = await convert('userId', 'teamId', 'userIds');
            // setting user as void should not trigger a new team computation
            if (!user.ok && !userIds.ok && team.ok) {
                continue;
            }
            user = user.ok ? user : userIds.ok && userIds[0] || await this.env.user();
            if (team.ok && (await team.memberIds).or(await team.userId).includes(user)) {
                continue;
            }
            team = await this.env.items('crm.team')._getDefaultTeamId(user.id, null);
            await convert.set('teamId', team.id);
        }
    }

    @api.depends('leadTomergeIds')
    async _computeDuplicatedLeadIds() {
        for (const convert of this) {
            let duplicated = this.env.items('crm.lead');
            for (const lead of await convert.leadTomergeIds) {
                const partner = await lead.partnerId;
                const duplicatedLeads = await this.env.items('crm.lead')._getLeadDuplicates(
                    partner,
                    partner.ok && await partner.email || await lead.emailFrom,
                    false);
                if (len(duplicatedLeads) > 1) {
                    duplicated = duplicated.add(lead);
                }
            }
            await convert.set('duplicatedLeadIds', duplicated.ids);
        }
    }

    /**
     * When "massively" (more than one at a time) converting leads to
        opportunities, check the salesteam_id and salesmen_ids and update
        the values before calling super.
     * @param leads 
     * @param userIds 
     * @param teamId 
     * @returns 
     */
    async _convertAndAllocate(leads, userIds, teamId: any = false) {
        this.ensureOne();
        let salesmenIds = [];
        if ((await this['userIds']).ok) {
            salesmenIds = (await this['userIds']).ids;
        }
        return _super(Lead2OpportunityMassConvert, this)._convertAndAllocate(leads, salesmenIds, teamId);
    }

    async actionMassConvert() {
        this.ensureOne();
        let self = this;
        if (await this['label'] === 'convert' && await this['deduplicate']) {
            // TDE CLEANME: still using activeIds from context
            const activeIds = this._context['activeIds'] ?? [];
            const mergedLeadIds = [];
            const remainingLeadIds = [];
            for (let lead of await this['leadTomergeIds']) {
                if (!mergedLeadIds.includes(lead)) {
                    const [partner, emailFrom] = await lead('partnerId', 'emailFrom');
                    const duplicatedLeads = await this.env.items('crm.lead')._getLeadDuplicates(
                        partner,
                        await partner.email || emailFrom,
                        false
                    );
                    if (len(duplicatedLeads) > 1) {
                        lead = await duplicatedLeads.mergeOpportunity();
                        extend(mergedLeadIds, duplicatedLeads.ids);
                        remainingLeadIds.push(lead.id);
                    }
                }
            }
            // rebuild list of lead IDS to convert, following given order
            let finalIds = activeIds.filter(leadId => !mergedLeadIds.includes(leadId));
            finalIds = finalIds.concat(remainingLeadIds.filter(leadId => !finalIds.includes(leadId)));

            self = await this.withContext({ activeIds: finalIds });  // only update activeIds when there are set
        }
        return (self as any).actionApply();
    }

    async _convertHandlePartner(lead, action, partnerId) {
        if (await this['action'] === 'eachExistOrCreate') {
            partnerId = (await lead._findMatchingPartner(true)).id;
            action = 'create';
        }
        return _super(Lead2OpportunityMassConvert, this)._convertHandlePartner(lead, action, partnerId);
    }
}