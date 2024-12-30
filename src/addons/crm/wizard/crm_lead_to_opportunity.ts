import { Fields, api } from "../../../core";
import { UserError } from "../../../core/helper";
import { MetaModel, TransientModel, _super } from "../../../core/models";
import { bool, len } from "../../../core/tools";

@MetaModel.define()
class Lead2OpportunityPartner extends TransientModel {
    static _module = module;
    static _name = 'crm.lead2opportunity.partner';
    static _description = 'Convert Lead to Opportunity (not in mass)';

    /**
     * Allow support of activeId / activeModel instead of jut default_leadId
        to ease window action definitions, and be backward compatible.
     * @param fields 
     * @returns 
     */
    @api.model()
    async defaultGet(fields) {
        const result = await _super(Lead2OpportunityPartner, this).defaultGet(fields);

        if (! bool(result['leadId']) && this.env.context['activeId']) {
            result['leadId'] = this.env.context['activeId'];
        }
        return result;
    }

    static label = Fields.Selection([
        ['convert', 'Convert to opportunity'],
        ['merge', 'Merge with existing opportunities']
    ], {string: 'Conversion Action', compute: '_computeName', readonly: false, store: true, computeSudo: false});
    static action = Fields.Selection([
        ['create', 'Create a new customer'],
        ['exist', 'Link to an existing customer'],
        ['nothing', 'Do not link to a customer']
    ], {string: 'Related Customer', compute: '_computeAction', readonly: false, store: true, computeSudo: false});
    static leadId = Fields.Many2one('crm.lead', {string: 'Associated Lead', required: true});
    static duplicatedLeadIds = Fields.Many2many(
        'crm.lead', {string: 'Opportunities', context: {'activeTest': false},
        compute: '_computeDuplicatedLeadIds', readonly: false, store: true, computeSudo: false});
    static partnerId = Fields.Many2one(
        'res.partner', {string: 'Customer',
        compute:'_computePartnerId', readonly: false, store: true, computeSudo: false});
    static userId = Fields.Many2one(
        'res.users', {string: 'Salesperson',
        compute: '_computeUserId', readonly: false, store: true, computeSudo: false});
    static teamId = Fields.Many2one(
        'crm.team', {string: 'Sales Team',
        compute: '_computeTeamId', readonly: false, store: true, computeSudo: false});
    static forceAssignment = Fields.Boolean(
        'Force assignment', {default: true,
        help: 'If checked, forces salesman to be updated on updated opportunities even if already set.'});

    @api.depends('duplicatedLeadIds')
    async _computeName() {
        for (const convert of this) {
            if (! await convert.label) {
                await convert.set('label', bool(await convert.duplicatedLeadIds) && len(await convert.duplicatedLeadIds) >= 2 ? 'merge' : 'convert');
            }
        }
    }

    @api.depends('leadId')
    async _computeAction() {
        for (const convert of this) {
            const lead = await convert.leadId;
            if (! bool(lead)) {
                await convert.set('action', 'nothing');
            }
            else {
                const partner = await lead._findMatchingPartner();
                if (bool(partner)) {
                    await convert.seValue('action', 'exist');
                }
                else if (await lead.contactName) {
                    await convert.set('action', 'create');
                }
                else {
                    await convert.set('action', 'nothing');
                }
            }
        }
    }

    @api.depends('leadId', 'partnerId')
    async _computeDuplicatedLeadIds() {
        for (const convert of this) {
            const [lead, partner] = await convert('leadId', 'partnerId');
            if (!lead.ok) {
                await convert.set('duplicatedLeadIds', false);
                continue;
            }
            const partnerEmail = await (await lead.partnerId).email;
            await convert.set('duplicatedLeadIds', (await this.env.items('crm.lead')._getLeadDuplicates(
                partner,
                partnerEmail ? partnerEmail : await lead.emailFrom,
                true)).ids
            );
        }
    }

    @api.depends('action', 'leadId')
    async _computePartnerId() {
        for (const convert of this) {
            if (await convert.action === 'exist') {
                await convert.set('partnerId', await (await convert.leadId)._findMatchingPartner());
            }
            else {
                await convert.set('partnerId', false);
            }
        }
    }

    @api.depends('leadId')
    async _computeUserId() {
        for (const convert of this) {
            const user = await (await convert.leadId).userId;
            await convert.set('userId', user.ok ? user : false);
        }
    }

    /**
     * When changing the user, also set a teamId or restrict team id
        to the ones userId is member of.
     */
    @api.depends('userId')
    async _computeTeamId() {
        for (const convert of this) {
            // setting user as void should not trigger a new team computation
            let [user, team] = await convert('userId', 'teamId')
            if (!user.ok) {
                continue;
            }
            if (team.ok && (await team.memberIds).or(await team.userId).includes(user)) {
                continue;
            }
            team = await this.env.items('crm.team')._getDefaultTeamId(user.id, null);
            await convert.set('teamId', team.id);
        }
    }

    /**
     * Check some preconditions before the wizard executes.
     * @param fields 
     * @returns 
     */
    @api.model()
    async viewInit(fields): Promise<any> {
        // JEM TDE FIXME: clean that brol
        for (const lead of this.env.items('crm.lead').browse(this._context['activeIds'] ?? [])) {
            if (await lead.probability == 100) {
                throw new UserError(await this._t("Closed/Dead leads cannot be converted into opportunities."));
            }
        }
        return false;
    }

    async actionApply() {
        let resultOpportunity;
        if (await this['label'] === 'merge') {
            resultOpportunity = await this._actionMerge();
        }
        else {
            resultOpportunity = await this._actionConvert();
        }
        return resultOpportunity.redirectLeadOpportunityView();
    }

    async _actionMerge() {
        const [toMerge, user, team] = await this('duplicatedLeadIds', 'userId', 'teamId');
        const resultOpportunity = await toMerge.mergeOpportunity({autoUnlink: false});
        await resultOpportunity.actionUnarchive();

        if (await resultOpportunity.type === "lead") {
            await this._convertAndAllocate(resultOpportunity, [user.id], team.id);
        }
        else {
            if (! (await resultOpportunity.userId).ok || await this['forceAssignment']) {
                await resultOpportunity.write({
                    'userId': user.id,
                    'teamId': team.id,
                });
            }
        }
        await (await toMerge.sub(resultOpportunity).sudo()).unlink();
        return resultOpportunity;
    }

    async _actionConvert() {
        const resultOpportunities = this.env.items('crm.lead').browse(this._context['activeIds'] ?? []);
        await this._convertAndAllocate(resultOpportunities, [(await this['userId']).id], (await this['teamId']).id);
        return resultOpportunities[0];
    }

    async _convertAndAllocate(leads, userIds, teamId: any=false) {
        this.ensureOne();

        for (const lead of leads) {
            if (await lead.active && await this['action'] !== 'nothing') {
                await this._convertHandlePartner(
                    lead, await this['action'], (await this['partnerId']).id || (await lead.partnerId).id
                )
            }
            await lead.convertOpportunity((await lead.partnerId).id, false, false);
        }

        let leadsToAllocate = leads;
        if (! await this['forceAssignment']) {
            leadsToAllocate = await leadsToAllocate.filtered(async (lead) => !await lead.userId);
        }
        if (bool(userIds)) {
            await leadsToAllocate._handleSalesmenAssignment(userIds, teamId);
        }
    }

    async _convertHandlePartner(lead, action, partnerId) {
        // used to propagate userId (salesman) on created partners during conversion
        await (await lead.withContext({default_userId: (await this['userId']).id}))._handlePartnerAssignment(
            partnerId,
            action === 'create'
        );
    }
}