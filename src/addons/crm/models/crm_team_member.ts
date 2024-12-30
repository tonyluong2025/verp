import { Fields, _Datetime, api } from "../../../core";
import { getattr } from "../../../core/api";
import { ValidationError, ValueError } from "../../../core/helper";
import { MetaModel, Model } from "../../../core/models";
import { expression } from "../../../core/osv";
import { bool, choices, len, next, parseInt } from "../../../core/tools";
import { literalEval } from "../../../core/tools/ast";
import { subDate } from "../../../core/tools/date_utils";

@MetaModel.define()
class Team extends Model {
    static _module = module;
    static _parents = 'crm.team.member';

    // assignment
    static assignmentEnabled = Fields.Boolean({ related: "crmTeamId.assignmentEnabled" });
    static assignmentDomain = Fields.Char('Assignment Domain', { tracking: true });
    static assignmentOptout = Fields.Boolean('Skip auto assignment');
    static assignmentMax = Fields.Integer('Average Leads Capacity (on 30 days)', { default: 30 });
    static leadMonthCount = Fields.Integer(
        'Leads (30 days)', {
        compute: '_computeLeadMonthCount',
        help: 'Lead assigned to this member those last 30 days'
    });

    @api.depends('userId', 'crmTeamId')
    async _computeLeadMonthCount() {
        for (const member of this) {
            if (bool((await member.userId).id) && bool((await member.crmTeamId).id)) {
                await member.set('leadMonthCount', await (await (await this.env.items('crm.lead').withContext({ activeTest: false })).searchCount(
                    await member._getLeadMonthDomain()
                )));
            }
            else {
                await member.set('leadMonthCount', 0);
            }
        }
    }

    @api.constrains('assignmentDomain')
    async _constrainsAssignmentDomain() {
        for (const member of this) {
            let domain;
            try {
                domain = await member.assignmentDomain;
                domain = literalEval(domain || '[]');
                if (domain) {
                    await this.env.items('crm.lead').search(domain, { limit: 1 });
                }
            } catch (e) {
                throw new ValidationError(await this._t(
                    'Member assignment domain for user %s and team %s is incorrectly formatted',
                    await (await member.userId).label, await (await member.crmTeamId).label
                ));
            }
        }
    }

    async _getLeadMonthDomain() {
        const limitDate = subDate(_Datetime.now(), { days: 30 });
        return [
            ['userId', '=', (await this['userId']).id],
            ['teamId', '=', (await this['crmTeamId']).id],
            ['dateOpen', '>=', limitDate],
        ];
    }

    // ------------------------------------------------------------
    // LEAD ASSIGNMENT
    // ------------------------------------------------------------

    /**
     * Main processing method to assign leads to sales team members. It also
        converts them into opportunities. This method should be called after
        ``_allocate_leads`` as this method assigns leads already allocated to
        the member's team. Its main purpose is therefore to distribute team
        workload on its members based on their capacity.

        Preparation

          * prepare lead domain for each member. It is done using a logical
            AND with team's domain and member's domain. Member domains further
            restricts team domain;
          * prepare a set of available leads for each member by searching for
            leads matching domain with a sufficient limit to ensure all members
            will receive leads;
          * prepare a weighted population sample. Population are members that
            should received leads. Initial weight is the number of leads to
            assign to that specific member. This is minimum value between
            * remaining this month: assignmentMax - number of lead already
              assigned this month;
            * days-based assignment: assignmentMax with a ratio based on
              ``workDays`` parameter (see ``CrmTeam.actionAssignLeads()``)
            * e.g. Michel Poilvache (max: 30 - currently assigned: 15) limit
              for 2 work days: min(30-15, 30/15) -> 2 leads assigned
            * e.g. Michel Tartopoil (max: 30 - currently assigned: 26) limit
              for 10 work days: min(30-26, 30/3) -> 4 leads assigned

        This method then follows the following heuristic

          * take a weighted random choice in population;
          * find first available (not yet assigned) lead in its lead set;
          * if found:
            * convert it into an opportunity and assign member as salesperson;
            * lessen member's weight so that other members have an higher
              probability of being picked up next;
          * if not found: consider this member is out of assignment process,
            remove it from population so that it is not picked up anymore;

        Assignment is performed one lead at a time for fairness purpose. Indeed
        members may have overlapping domains within a given team. To ensure
        some fairness in process once a member receives a lead, a new choice is
        performed with updated weights. This is not optimal from performance
        point of view but increases probability leads are correctly distributed
        within the team.

        :param float workDays: see ``CrmTeam.actionAssignLeads()``;

        :return membersData: dict() with each member assignment result:
          membership: {
            'assigned': set of lead IDs directly assigned to the member;
          }, ...
     * @param workDays 
     * @returns 
     */
    async _assignAndConvertLeads(workDays: number = 1) {
        if (workDays < 0.2 || workDays > 30) {
            throw new ValueError(
                await this._t('Leads team allocation should be done for at least 0.2 or maximum 30 work days, not %s.', workDays.toFixed(2))
            );
        }

        const [membersData, population, weights] = [new Map<any, any>(), [], []];
        const members = await this.filtered(async (member) => ! await member.assignmentOptout && await member.assignmentMax > 0);
        if (!bool(members)) {
            return membersData;
        }

        // prepare a global lead count based on total leads to assign to salespersons
        const leadLimit = await members.sum(member => member._getAssignmentQuota(workDays));

        // could probably be optimized
        for (const member of members) {
            const domain = await member.assignmentDomain;
            const leadDomain = expression.AND([
                literalEval(domain || '[]'),
                ['&', '&', ['userId', '=', false], ['dateOpen', '=', false], ['teamId', '=', (await member.crmTeamId).id]]
            ]);

            const leads = await this.env.items("crm.lead").search(leadDomain, { order: 'probability DESC', limit: leadLimit });

            const toAssign = await member._getAssignmentQuota(workDays);
            membersData.set(member.id, {
                "teamMember": member,
                "max": await member.assignmentMax,
                "toAssign": toAssign,
                "leads": leads,
                "assigned": this.env.items("crm.lead"),
            });
            population.push(member.id);
            weights.push(toAssign);
        }

        const leadsDoneIds = new Set();
        let counter = 0;
        // auto-commit except in testing mode
        const autoCommit = !getattr(this.env, 'testing', false);
        const commitBundleSize = parseInt(await (await this.env.items('ir.config.parameter').sudo()).getParam('crm.assignment.commit.bundle', 100));
        while (population && weights.some(w => bool(w))) {
            counter += 1
            const memberId = Array.from(choices(population, weights, null, 1))[0];
            const memberIndex = population.indexOf(memberId);
            const memberData = membersData.get(memberId);

            const lead = next(memberData['leads'].filter(lead => !leadsDoneIds.has(lead.id)), false);
            if (bool(lead)) {
                leadsDoneIds.add(lead.id);
                membersData.get(memberId)["assigned"] += lead;
                weights[memberIndex] = weights[memberIndex] - 1;

                await (await lead.withContext({ mailAutoSubscribeNoNotify: true })).convertOpportunity(
                    (await lead.partnerId).id,
                    (await memberData['teamMember'].userId).ids
                );

                if (autoCommit && counter % commitBundleSize == 0) {
                    await this._cr.commit();
                }
            }
            else {
                weights[memberIndex] = 0;
            }
            if (weights[memberIndex] <= 0) {
                population.splice(memberIndex, 1);
                weights.splice(memberIndex, 1);
            }

            // failsafe
            if (counter > 100000) {
                population.length = 0;
            }
        }

        if (autoCommit) {
            await this._cr.commit();
        }
        // log results and return
        const resultData = new Map<any, any>();
        for (const [memberId, memberInfo] of membersData) {
            resultData.set(memberInfo["teamMember"], { "assigned": memberInfo["assigned"] });
        }
        console.info('Assigned %s leads to %s salesmen', leadsDoneIds.size, len(members));
        for (const [member, memberInfo] of resultData) {
            console.info('-> member %s: assigned %s leads (%s)', member.id, len(memberInfo["assigned"]), memberInfo["assigned"]);
        }
        return resultData;
    }

    /**
     * Compute assignment quota based on workDays. This quota includes
        a compensation to speedup getting to the lead average (``assignmentMax``).
        As this field is a counter for "30 days" -> divide by requested work
        days in order to have base assign number then add compensation.

        :param float workDays: see ``CrmTeam.actionAssignLeads()``;
     */
    async _getAssignmentQuota(workDays: number = 1) {
        const assignRatio = workDays / 30.0;
        const [assignmentMax, leadMonthCount] = await this('assignmentMax', 'leadMonthCount');
        const toAssign = assignmentMax * assignRatio;
        const compensation = Math.max(0, assignmentMax - (leadMonthCount + toAssign)) * 0.2;
        return Math.round(toAssign + compensation);
    }
}