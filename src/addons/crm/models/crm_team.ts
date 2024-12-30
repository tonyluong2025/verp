import { Fields, _Datetime, api } from "../../../core";
import { getattr } from "../../../core/api";
import { Dict, UserError, ValidationError, ValueError } from "../../../core/helper";
import { MetaModel, Model, _super } from "../../../core/models";
import { expression } from "../../../core/osv";
import { _f, bool, choices, f, floatCompare, floatRound, len, next, parseInt, update } from "../../../core/tools";
import { literalEval } from "../../../core/tools/ast";
import { subDate } from "../../../core/tools/date_utils";
import { safeEval } from "../../../core/tools/save_eval";

@MetaModel.define()
class Team extends Model {
    static _module = module;
    static _name = 'crm.team';
    static _parents = ['mail.alias.mixin', 'crm.team'];
    static _description = 'Sales Team';

    static useLeads = Fields.Boolean('Leads', { help: "Check this box to filter and qualify incoming requests as leads before converting them into opportunities and assigning them to a salesperson." });
    static useOpportunities = Fields.Boolean('Pipeline', { default: true, help: "Check this box to manage a presales process with opportunities." });
    static aliasId = Fields.Many2one(
        'mail.alias', {
        string: 'Alias', ondelete: "RESTRICT", required: true,
        help: "The email address associated with this channel. New emails received will automatically create new leads assigned to the channel."
    });
    // assignment
    static assignmentEnabled = Fields.Boolean('Lead Assign', { compute: '_computeAssignmentEnabled' });
    static assignmentAutoEnabled = Fields.Boolean('Auto Assignment', { compute: '_computeAssignmentEnabled' });
    static assignmentOptout = Fields.Boolean('Skip auto assignment');
    static assignmentMax = Fields.Integer(
        'Lead Average Capacity', {
        compute: '_computeAssignmentMax',
        help: 'Monthly average leads capacity for all salesmen belonging to the team'
    });
    static assignmentDomain = Fields.Char(
        'Assignment Domain', {
        tracking: true,
        help: 'Additional filter domain when fetching unassigned leads to allocate to the team.'
    });
    // statistics about leads / opportunities / both
    static leadUnassignedCount = Fields.Integer(
        { string: '# Unassigned Leads', compute: '_computeLeadUnassignedCount' });
    static leadAllAssignedMonthCount = Fields.Integer(
        {
            string: '# Leads/Opps assigned this month', compute: '_computeLeadAllAssignedMonthCount',
            help: "Number of leads and opportunities assigned this last month."
        });
    static opportunitiesCount = Fields.Integer(
        { string: '# Opportunities', compute: '_computeOpportunitiesData' });
    static opportunitiesAmount = Fields.Monetary(
        { string: 'Opportunities Revenues', compute: '_computeOpportunitiesData' });
    static opportunitiesOverdueCount = Fields.Integer(
        { string: '# Overdue Opportunities', compute: '_computeOpportunitiesOverdueData' });
    static opportunitiesOverdueAmount = Fields.Monetary(
        { string: 'Overdue Opportunities Revenues', compute: '_computeOpportunitiesOverdueData' });
    // alias: improve fields coming from _inherits, use inherited to avoid replacing them
    static aliasUserId = Fields.Many2one(
        'res.users', {
        related: 'aliasId.aliasUserId', readonly: false, inherited: true,
        domain: async (self) => [['groupsId', 'in', (await self.env.ref('sales_team.groupSaleSalesmanAllLeads')).id]]
    });

    @api.depends('crmTeamMemberIds.assignmentMax')
    async _computeAssignmentMax() {
        for (const team of this) {
            await team.set('assignmentMax', await (await team.crmTeamMemberIds).sum(member => member.assignmentMax));
        }
    }

    async _computeAssignmentEnabled() {
        const assignEnabled = await (await this.env.items('ir.config.parameter').sudo()).getParam('crm.lead.auto.assignment', false);
        let autoAssignEnabled = false;
        if (assignEnabled) {
            const assignCron = await (await this.sudo()).env.ref('crm.irCronCrmLeadAssign', false);
            autoAssignEnabled = bool(assignCron) ? await assignCron.active : false;
        }
        await this.set('assignmentEnabled', assignEnabled);
        await this.set('assignmentAutoEnabled', autoAssignEnabled);
    }

    async _computeLeadUnassignedCount() {
        const leadsData = await this.env.items('crm.lead').readGroup([
            ['teamId', 'in', this.ids],
            ['type', '=', 'lead'],
            ['userId', '=', false],
        ], ['teamId'], ['teamId']);
        const counts = Object.fromEntries(leadsData.map(datum => [datum['teamId'][0], datum['teamId_count']]));
        for (const team of this) {
            await team.set('leadUnassignedCount', counts[team.id] ?? 0);
        }
    }

    @api.depends('crmTeamMemberIds.leadMonthCount')
    async _computeLeadAllAssignedMonthCount() {
        for (const team of this) {
            await team.set('leadAllAssignedMonthCount', await (await team.crmTeamMemberIds).sum(member => member.leadMonthCount));
        }
    }

    async _computeOpportunitiesData() {
        const opportunityData = await this.env.items('crm.lead').readGroup([
            ['teamId', 'in', this.ids],
            ['probability', '<', 100],
            ['type', '=', 'opportunity'],
        ], ['expectedRevenue:sum', 'teamId'], ['teamId']);
        const counts = Object.fromEntries(opportunityData.map(datum => [datum['teamId'][0], datum['teamId_count']]));
        const amounts = Object.fromEntries(opportunityData.map(datum => [datum['teamId'][0], datum['expectedRevenue']]));
        for (const team of this) {
            await team.update({
                opportunitiesCount: counts[team.id] ?? 0,
                opportunitiesAmount: amounts[team.id] ?? 0
            });
        }
    }

    async _computeOpportunitiesOverdueData() {
        const opportunityData = await this.env.items('crm.lead').readGroup([
            ['teamId', 'in', this.ids],
            ['probability', '<', 100],
            ['type', '=', 'opportunity'],
            ['dateDeadline', '<', _Datetime.now().toISOString()]
        ], ['expectedRevenue', 'teamId'], ['teamId']);
        const counts = {};
        const amounts = {};
        for (const datum of opportunityData) {
            counts[datum['teamId'][0]] = datum['teamId_count'];
            amounts[datum['teamId'][0]] = [datum['expectedRevenue']];
        }
        for (const team of this) {
            await team.update({
                opportunitiesOverdueCount: counts[team.id] ?? 0,
                opportunitiesOverdueAmount: amounts[team.id] ?? 0
            });
        }
    }

    @api.onchange('useLeads', 'useOpportunities')
    async _onchangeUseLeadsOpportunities() {
        if (! await this['useLeads'] && ! await this['useOpportunities']) {
            await this.set('aliasName', false);
        }
    }

    @api.constrains('assignmentDomain')
    async _constrainsAssignmentDomain() {
        for (const team of this) {
            let domain;
            try {
                domain = await team.assignmentDomain;
                domain = literalEval(domain);
                if (bool(domain)) {
                    await this.env.items('crm.lead').search(domain, { limit: 1 });
                }
            } catch (e) {
                throw new ValidationError(_f(await this._t('Assignment domain for team {team} is incorrectly formatted {domain}'), { team: await team.label, domain: String(domain) }));
            }
        }
    }

    // ------------------------------------------------------------
    // ORM
    // ------------------------------------------------------------

    async write(vals) {
        const result = await _super(Team, this).write(vals);
        if ('useLeads' in vals || 'useOpportunities' in vals) {
            for (const team of this) {
                const aliasVals = await team._aliasGetCreationValues();
                await team.write({
                    'aliasName': aliasVals['aliasName'] || await team.aliasName,
                    'aliasDefaults': aliasVals['aliasDefaults']
                });
            }
        }
        return result;
    }

    /**
     * When unlinking, concatenate ``crm.lead.scoring.frequency`` linked to
        the team into "no team" statistics.
     */
    async unlink() {
        const frequencies = await this.env.items('crm.lead.scoring.frequency').search([['teamId', 'in', this.ids]]);
        if (frequencies.ok) {
            let existingNoteam = await (await this.env.items('crm.lead.scoring.frequency').sudo()).search([
                ['teamId', '=', false],
                ['variable', 'in', await frequencies.mapped('variable')]
            ]);
            for (const frequency of frequencies) {
                const [wonCount, lostCount, variable, value] = await frequency('wonCount', 'lostCount', 'variable', 'value');
                // skip void-like values
                if (floatCompare(wonCount, 0.1, { precisionDigits: 2 }) != 1 && floatCompare(lostCount, 0.1, { precisionDigits: 2 }) != 1) {
                    continue;
                }

                const match = await existingNoteam.filtered(async (frequNt) => await frequNt.variable == variable && await frequNt.value == value);
                if (match.ok) {
                    // remove extra .1 that may exist in db as those are artifacts of initializing
                    // frequency table. Final value of 0 will be set to 0.1.
                    const existWonCount = floatRound(await match.wonCount, { precisionDigits: 0, roundingMethod: 'HALF-UP' });
                    const existLostCount = floatRound(await match.lostCount, { precisionDigits: 0, roundingMethod: 'HALF-UP' });
                    const addWonCount = floatRound(wonCount, { precisionDigits: 0, roundingMethod: 'HALF-UP' });
                    const addLostCount = floatRound(lostCount, { precisionDigits: 0, roundingMethod: 'HALF-UP' });
                    const newWonCount = existWonCount + addWonCount;
                    const newLostCount = existLostCount + addLostCount;
                    await match.update({
                        wonCount: floatCompare(newWonCount, 0.1, { precisionDigits: 2 }) == 1 ? newWonCount : 0.1,
                        lostCount: floatCompare(newLostCount, 0.1, { precisionDigits: 2 }) == 1 ? newLostCount : 0.1
                    });
                }
                else {
                    existingNoteam = existingNoteam.add(await (await this.env.items('crm.lead.scoring.frequency').sudo()).create({
                        'lostCount': floatCompare(lostCount, 0.1, { precisionDigits: 2 }) == 1 ? lostCount : 0.1,
                        'teamId': false,
                        'value': value,
                        'variable': variable,
                        'wonCount': floatCompare(wonCount, 0.1, { precisionDigits: 2 }) == 1 ? wonCount : 0.1,
                    }));
                }
            }
        }
        return _super(Team, this).unlink();
    }

    // ------------------------------------------------------------
    // MESSAGING
    // ------------------------------------------------------------

    async _aliasGetCreationValues() {
        const values = await _super(Team, this)._aliasGetCreationValues();
        values['aliasModelId'] = (await this.env.items('ir.model')._get('crm.lead')).id;
        if (bool(this.id)) {
            if (! await this['useLeads'] && ! await this['useOpportunities']) {
                values['aliasName'] = false;
            }
            const defaults = literalEval(await this['aliasDefaults'] || "Object()");
            values['aliasDefaults'] = defaults;
            const hasGroupUseLead = await (await this.env.user()).hasGroup('crm.groupUseLead');
            defaults['type'] = hasGroupUseLead && await this['useLeads'] ? 'lead' : 'opportunity';
            defaults['teamId'] = this.id;
        }
        return values;
    }

    // ------------------------------------------------------------
    // LEAD ASSIGNMENT
    // ------------------------------------------------------------

    /**
     * Cron method assigning leads. Leads are allocated to all teams and
        assigned to their members. It is based on either cron configuration
        either forced through ``workDays`` parameter.

        When based on cron configuration purpose of cron is to assign leads to
        sales persons. Assigned workload is set to the workload those sales
        people should perform between two cron iterations. If their maximum
        capacity is reached assign process will not assign them any more lead.

        e.g. cron is active with intervalNumber 3, intervalType days. This
        means cron runs every 3 days. Cron will assign leads for 3 work days
        to salespersons each 3 days unless their maximum capacity is reached.

        If cron runs on an hour- or minute-based schedule minimum assignment
        performed is equivalent to 0.2 workdays to avoid rounding issues.
        Max assignment performed is for 30 days as it is better to run more
        often than planning for more than one month. Assign process is best
        designed to run every few hours (~4 times / day) or each few days.

        See ``CrmTeam.actionAssignLeads()`` and its sub methods for more
        details about assign process.

        :param float work_days: see ``CrmTeam.actionAssignLeads()``;
     * @param workDays 
     * @returns 
     */
    @api.model()
    async _cronAssignLeads(workDays?: any) {
        const assignCron = await (await this.sudo()).env.ref('crm.irCronCrmLeadAssign', false);
        if (!workDays && bool(assignCron) && await assignCron.active) {
            const [intervalType, intervalNumber] = await assignCron('intervalType', 'intervalNumber');
            if (intervalType === 'months') {
                workDays = 30;  // maximum one month of work
            }
            else if (intervalType === 'weeks') {
                workDays = Math.min(30, intervalNumber * 7);  // max at 30 (better lead repartition)
            }
            else if (intervalType === 'days') {
                workDays = Math.min(30, intervalNumber * 1);  // max at 30 (better lead repartition)
            }
            else if (intervalType === 'hours') {
                workDays = Math.max(0.2, intervalNumber / 24);// min at 0.2 to avoid small numbers issues
            }
            else if (intervalType === 'minutes') {
                workDays = Math.max(0.2, intervalNumber / 1440); // min at 0.2 to avoid small numbers issues
            }
        }
        workDays = workDays ? workDays : 1;  // avoid void values
        await (await this.env.items('crm.team').search([
            '&', '|', ['useLeads', '=', true], ['useOpportunities', '=', true],
            ['assignmentOptout', '=', false]
        ]))._actionAssignLeads(workDays);
        return true;
    }

    /**
     * Manual (direct) leads assignment. This method both

          * assigns leads to teams given by self;
          * assigns leads to salespersons belonging to self;

        See sub methods for more details about assign process.

        :param float work_days: number of work days to consider when assigning leads
          to teams or salespersons. We consider that Member.assignment_max (or
          its equivalent on team model) targets 30 work days. We make a ratio
          between expected number of work days and maximum assignment for those
          30 days to know lead count to assign.

        :return action: a client notification giving some insights on assign
          process;
     * @param workDays 
     * @param log 
     * @returns 
     */
    async actionAssignLeads(workDays: number = 1, log: boolean = true) {
        const [teamsData, membersData] = await this._actionAssignLeads(workDays);

        // format result messages
        const logs = await this._actionAssignLeadsLogs(teamsData, membersData);
        const htmlMessage = logs.join('<br />');
        const notifMessage = logs.join(' ');

        // log a note in case of manual assign (as this method will mainly be called
        // on singleton record set, do not bother doing a specific message per team)
        const logAction = _f(await this._t("Lead Assignment requested by {userName}"), { userName: await (await this.env.user()).label });
        const logMessage = f("<p>%s<br /><br />%s</p>", logAction, htmlMessage);
        await (this as any)._messageLogBatch(Object.fromEntries(await this.map(team => [team.id, logMessage])));

        return {
            'type': 'ir.actions.client',
            'tag': 'displayNotification',
            'params': {
                'type': 'success',
                'title': await this._t("Leads Assigned"),
                'message': notifMessage,
                'next': {
                    'type': 'ir.actions.actwindow_close'
                },
            }
        }
    }

    /**
     * Private method for lead assignment. This method both

          * assigns leads to teams given by self;
          * assigns leads to salespersons belonging to self;

        See sub methods for more details about assign process.

        :param float workDays: see ``CrmTeam.actionAssignLeads()``;

        :return teamsData, membersData: structure-based result of assignment
          process. For more details about data see ``CrmTeam._allocateLeads()``
          and ``CrmTeamMember._assignAndConvertLeads``;
     */
    async _actionAssignLeads(workDays: number = 1) {
        const user = await this.env.user();
        if (! await user.hasGroup('sales_team.groupSaleManager') && !user.hasGroup('base.groupSystem')) {
            throw new UserError(await this._t('Lead/Opportunities automatic assignment is limited to managers or administrators'));
        }
        const crmTeamMemberIds = await this['crmTeamMemberIds'];
        console.info('### START Lead Assignment (%s teams, %s sales persons, %s workDays)', len(this), len(crmTeamMemberIds), workDays.toFixed(2));
        const teamsData = await this._allocateLeads(workDays);
        console.info('### Team repartition done. Starting salesmen assignment.');
        const membersData = await crmTeamMemberIds._assignAndConvertLeads(workDays);
        console.info('### END Lead Assignment');
        return [teamsData, membersData];
    }

    /**
     * Tool method to prepare notification about assignment process result.

        :param teamsData: see ``CrmTeam._allocateLeads()``;
        :param membersData: see ``CrmTeamMember._assignAndConvertLeads()``;

        :return list: list of formatted logs, ready to be formatted into a nice
        plaintext or html message at caller's will
     * @param teamsData 
     * @param membersData 
     */
    async _actionAssignLeadsLogs(teamsData: any[], membersData: {}) {
        // extract some statistics
        const assigned = teamsData.reduce((pre, team) => pre + len(teamsData[team]['assigned']) + len(teamsData[team]['merged']));
        const duplicates = teamsData.reduce((pre, team) => pre + len(teamsData[team]['duplicates']));
        const members = len(membersData);
        const membersAssigned = Object.values<any>(membersData).reduce((pre, memberData) => pre + len(memberData['assigned']));

        // format user notification
        const messageParts = [];
        // 1- duplicates removal
        if (duplicates) {
            await messageParts.push(_f(await this._t("{duplicates} duplicates leads have been merged."), { duplicates: duplicates }));
        }
        // 2- nothing assigned at all
        if (!assigned && !membersAssigned) {
            if (len(self) == 1) {
                if (! await this['assignmentMax']) {
                    messageParts.push(
                        _f(await this._t("No allocated leads to {teamName} team because it has no capacity. Add capacity to its salespersons."), { teamName: await this['label'] }));
                }
                else {
                    messageParts.push(
                        _f(await this._t("No allocated leads to {teamName} team and its salespersons because no unassigned lead matches its domain."), { teamName: await this['label'] }));
                }
            }
            else {
                messageParts.push(
                    await this._t("No allocated leads to any team or salesperson. Check your Sales Teams and Salespersons configuration as well as unassigned leads."))
            }
        }

        // 3- team allocation
        if (!assigned && membersAssigned) {
            if (len(this) == 1) {
                messageParts.push(
                    _f(await this._t("No new lead allocated to {teamName} team because no unassigned lead matches its domain."),
                        { teamName: await this['label'] }));
            }
            else {
                messageParts.push(await this._t("No new lead allocated to the teams because no lead match their domains."));
            }
        }
        else if (assigned) {
            if (len(this) == 1) {
                messageParts.push(
                    _f(await this._t("{assigned} leads allocated to {teamName} team."),
                        { assigned: assigned, teamName: await this['label'] }));
            }
            else {
                messageParts.push(
                    _f(await this._t("{assigned} leads allocated among {teamCount} teams."),
                        { assigned: assigned, teamCount: len(this) }));
            }
        }
        // 4- salespersons assignment
        if (!membersAssigned && assigned) {
            messageParts.push(
                await this._t("No lead assigned to salespersons because no unassigned lead matches their domains."));
        }
        else if (membersAssigned) {
            messageParts.push(
                _f(await this._t("{membersAssigned} leads assigned among {memberCount} salespersons."),
                    { membersAssigned: membersAssigned, memberCount: members }));
        }
        return messageParts;
    }

    /**
     * Allocate leads to teams given by self. This method sets ``teamId``
        field on lead records that are unassigned (no team and no responsible).
        No salesperson is assigned in this process. Its purpose is simply to
        allocate leads within teams.

        This process allocates all available leads on teams weighted by their
        maximum assignment by month that indicates their relative workload.

        Heuristic of this method is the following:
          * find unassigned leads for each team, aka leads being
            * without team, without user -> not assigned;
            * not in a won stage, and not having False/0 (lost) or 100 (won)
              probability) -> live leads;
            * if set, a delay after creation can be applied (see BUNDLE_HOURS_DELAY)
              parameter explanations here below;
            * matching the team's assignment domain (empty means
              everything);

          * assign a weight to each team based on their assignment_max that
            indicates their relative workload;

          * pick a random team using a weighted random choice and find a lead
            to assign:

            * remove already assigned leads from the available leads. If there
              is not any lead spare to assign, remove team from active teams;
            * pick the first lead and set the current team;
            * when setting a team on leads, leads are also merged with their
              duplicates. Purpose is to clean database and avoid assigning
              duplicates to same or different teams;
            * add lead and its duplicates to already assigned leads;

          * pick another random team until their is no more leads to assign
            to any team;

        This process ensure that teams having overlapping domains will all
        receive leads as lead allocation is done one lead at a time. This
        allocation will be proportional to their size (assignment of their
        members).

        :config int crm.assignment.bundle: deprecated
        :config int crm.assignment.commit.bundle: optional config parameter allowing
          to set size of lead batch to be committed together. By default 100
          which is a good trade-off between transaction time and speed
        :config int crm.assignment.delay: optional config parameter giving a
          delay before taking a lead into assignment process (BUNDLE_HOURS_DELAY)
          given in hours. Purpose if to allow other crons or automated actions
          to make their job. This option is mainly historic as its purpose was
          to let automated actions prepare leads and score before PLS was added
          into CRM. This is now not required anymore but still supported;

        :param float work_days: see ``CrmTeam.actionAssignLeads()``;

        :return teamsData: dict() with each team assignment result:
          team: {
            'assigned': set of lead IDs directly assigned to the team (no
              duplicate or merged found);
            'merged': set of lead IDs merged and assigned to the team (main
              leads being results of merge process);
            'duplicates': set of lead IDs found as duplicates and merged into
              other leads. Those leads are unlinked during assign process and
              are already removed at return of this method;
          }, ...
     * @param workDays 
     */
    async _allocateLeads(workDays: number = 1) {
        if (workDays < 0.2 || workDays > 30) {
            throw new ValueError(
                await this._t('Leads team allocation should be done for at least 0.2 or maximum 30 work days, not %s.', workDays.toFixed(2))
            );
        }

        const BUNDLE_HOURS_DELAY = parseInt(await (await this.env.items('ir.config.parameter').sudo()).getParam('crm.assignment.delay', 0));
        const BUNDLE_COMMIT_SIZE = parseInt(await (await this.env.items('ir.config.parameter').sudo()).getParam('crm.assignment.commit.bundle', 100));
        const autoCommit = !getattr(this.env, 'testing', false);

        // leads
        const maxCreateDt = subDate(await this.env.cr.now(), { hours: BUNDLE_HOURS_DELAY });
        const duplicatesLeadCache = new Dict<any>();

        // teams data
        const [teamsData, population, weights] = [new Map<any, any>(), [], []];
        for (const team of this) {
            if (! await team.assignmentMax) {
                continue;
            }
            const domain = await team.assignmentDomain;
            const leadDomain = expression.AND([
                literalEval(domain || '[]'),
                [['createdAt', '<=', maxCreateDt]],
                ['&', ['teamId', '=', false], ['userId', '=', false]],
                ['|', ['stageId', '=', false], ['stageId.isWon', '=', false]]
            ]);

            const leads = await this.env.items("crm.lead").search(leadDomain);
            // Fill duplicate cache: search for duplicate lead before the assignation
            // avoid to flush during the search at every assignation
            for (const lead of leads) {
                if (!(lead in duplicatesLeadCache)) {
                    duplicatesLeadCache[lead] = await lead._getLeadDuplicates(null, await lead.emailFrom);
                }
            }
            teamsData.set(team, {
                "team": team,
                "leads": leads,
                "assigned": new Set(),
                "merged": new Set(),
                "duplicates": new Set(),
            });
            population.push(team);
            weights.push(await team.assignmentMax);
        }

        // Start a new transaction, since data fetching take times
        // and the first commit occur at the end of the bundle,
        // the first transaction can be long which we want to avoid
        if (autoCommit) {
            this._cr.commit();
        }
        // assignment process data
        const globalData = { assigned: new Set(), merged: new Set(), duplicates: new Set() };
        let [leadsDoneIds, leadUnlinkIds, counter] = [new Set(), new Set(), 0];
        while (population.length) {
            counter += 1;
            const team = next(choices(population, weights, null, 1));

            // filter remaining leads, remove team if no more leads for it
            teamsData.get(team)["leads"] = await (await teamsData.get(team)["leads"].filtered(async (lead) => !leadsDoneIds.has(lead.id))).exists();
            if (!bool(teamsData.get(team)["leads"])) {
                const populationIndex = population.indexOf(team);
                population.splice(populationIndex, 1);
                weights.splice(populationIndex, 1);
                continue;
            }
            // assign + deduplicate and concatenate results in teams_data to keep some history
            const candidateLead = teamsData.get(team)["leads"][0];
            const assignRes = await team._allocateLeadsDeduplicate(candidateLead, duplicatesLeadCache);
            for (const key of ['assigned', 'merged', 'duplicates']) {
                update(teamsData.get(team)[key], assignRes[key]);
                update(leadsDoneIds, assignRes[key]);
                update(globalData[key], assignRes[key]);
            }
            update(leadUnlinkIds, assignRes['duplicates']);

            // auto-commit except in testing mode. As this process may be time consuming or we
            // may encounter errors, already commit what is allocated to avoid endless cron loops.
            if (autoCommit && counter % BUNDLE_COMMIT_SIZE == 0) {
                // unlink duplicates once
                await this.env.items('crm.lead').browse(leadUnlinkIds).unlink();
                leadUnlinkIds = new Set();
                await this._cr.commit();
            }
        }

        // unlink duplicates once
        await this.env.items('crm.lead').browse(leadUnlinkIds).unlink();

        if (autoCommit) {
            await this._cr.commit();
        }

        // some final log
        console.info('## Assigned %s leads', (len(globalData['assigned']) + len(globalData['merged'])));
        for (const [team, teamData] of teamsData) {
            console.info(
                '## Assigned %s leads to team %s',
                len(teamData['assigned']) + len(teamData['merged']), team.id);
            console.info(
                '\tLeads: direct assign %s / merge result %s / duplicates merged: %s',
                teamData['assigned'], teamData['merged'], teamData['duplicates']);
        }
        return teamsData;
    }

    /**
     * Assign leads to sales team given by self by calling lead tool
        method _handle_salesmen_assignment. In this method we deduplicate leads
        allowing to reduce number of resulting leads before assigning them
        to salesmen.

        :param leads: recordset of leads to assign to current team;
        :param duplicates_cache: if given, avoid to perform a duplicate search
          and fetch information in it instead;
     * @param leads 
     * @param duplicatesCache 
     */
    async _allocateLeadsDeduplicate(leads, duplicatesCache?: Map<any, any>) {
        this.ensureOne();
        duplicatesCache = duplicatesCache != null ? duplicatesCache : new Map();

        // classify leads
        let leadsAssigned = this.env.items('crm.lead');  // direct team assign
        const [leadsDoneIds, leadsMergedIds, leadsDupIds] = [new Set(), new Set(), new Set()];  // classification
        const leadsDupsDict = new Map();  // lead -> its duplicate
        for (const lead of leads) {
            if (!leadsDoneIds.has(lead.id)) {
                // fill cache if not already done
                if (!duplicatesCache.has(lead)) {
                    duplicatesCache.set(lead, await lead._getLeadDuplicates(null, await lead.emailFrom));
                }
                const leadDuplicates = await duplicatesCache.get(lead).exists();

                if (len(leadDuplicates) > 1) {
                    leadsDupsDict.set(lead, leadDuplicates);
                    lead.add(leadDuplicates).ids.forEach(id => { if (!leadsDoneIds.has(id)) leadsDoneIds.add(id) });
                }
                else {
                    leadsAssigned = leadsAssigned.add(lead);
                    leadsDoneIds.add(lead.id);
                }
            }
        }

        // assign team to direct assign (leads_assigned) + dups keys (to ensure their team
        // if they are elected master of merge process)
        const dupsToAssign = leadsDupsDict.keys();
        await leadsAssigned.union(dupsToAssign)._handleSalesmenAssignment(null, this.id);

        for (const lead of await leads.filtered(async (lead) => leadsDupsDict.has(lead))) {
            const leadDuplicates = leadsDupsDict.get(lead);
            const merged = await leadDuplicates._mergeOpportunity({ autoUnlink: false, maxLength: 0 });
            leadDuplicates.sub(merged).ids.forEach(id => { if (!leadsDupIds.has(id)) leadsDupIds.add(id) });
            leadsMergedIds.add(merged.id);
        }

        return {
            'assigned': new Set(leadsAssigned.ids),
            'merged': leadsMergedIds,
            'duplicates': leadsDupIds,
        }
    }

    // ------------------------------------------------------------
    // ACTIONS
    // ------------------------------------------------------------

    //TODO JEM : refactor this stuff with xml action, proper customization,
    @api.model()
    async actionYourPipeline() {
        const action = await this.env.items("ir.actions.actions")._forXmlid("crm.crmLeadActionPipeline");
        return this._actionUpdateToPipeline(action);
    }

    @api.model()
    async actionOpportunityForecast() {
        const action = await this.env.items('ir.actions.actions')._forXmlid('crm.crmLeadActionForecast');
        return this._actionUpdateToPipeline(action);
    }

    @api.model()
    async _actionUpdateToPipeline(action) {
        let userTeamId = (await (await this.env.user()).saleTeamId).id;
        if (bool(userTeamId)) {
            // To ensure that the team is readable in multi company
            userTeamId = (await this.search([['id', '=', userTeamId]], { limit: 1 })).id;
        }
        else {
            userTeamId = (await this.search([], { limit: 1 })).id;
            action['help'] = await this._t(`<p class='o-view-nocontent-smiling-face'>Add new opportunities</p><p>
    Looks like you are not a member of a Sales Team. You should add yourself
    as a member of one of the Sales Team.
</p>`);
            if (bool(userTeamId)) {
                action['help'] += await this._t("<p>As you don't belong to any Sales Team, Verp opens the first one by default.</p>");
            }
        }
        const actionContext = safeEval(action['context'], { 'uid': this.env.uid });
        if (bool(userTeamId)) {
            actionContext['default_teamId'] = userTeamId;
        }
        action['context'] = actionContext;
        return action;
    }

    async _computeDashboardButtonName() {
        await _super(Team, this)._computeDashboardButtonName();
        const teamWithPipelines = await this.filtered((el) => el.useOpportunities);
        await teamWithPipelines.update({ 'dashboardButtonName': await this._t("Pipeline") });
    }

    async actionPrimaryChannelButton() {
        this.ensureOne();
        if (await this['useOpportunities']) {
            const action = await this.env.items('ir.actions.actions')._forXmlid('crm.crmCaseFormViewSalesteamsOpportunity');
            const rcontext = {
                'team': this,
            }
            action['help'] = await this.env.items('ir.ui.view')._renderTemplate('crm.crmActionHelper', rcontext);
            return action;
        }
        return _super(Team, this).actionPrimaryChannelButton();
    }

    async _graphGetModel() {
        if (await this['useOpportunities']) {
            return 'crm.lead';
        }
        return _super(Team, this)._graphGetModel();
    }

    async _graphDateColumn() {
        if (await this['useOpportunities']) {
            return 'createdAt';
        }
        return _super(Team, this)._graphDateColumn();
    }

    async _graphYQuery() {
        if (await this['useOpportunities']) {
            return 'COUNT(*)::int';
        }
        return _super(Team, this)._graphYQuery();
    }

    async _extraSqlConditions() {
        if (await this['useOpportunities']) {
            return "AND type LIKE 'opportunity'";
        }
        return _super(Team, this)._extraSqlConditions();
    }

    async _graphTitleAndKey() {
        if (await this['useOpportunities']) {
            return ['', await this._t('New Opportunities')]; // no more title
        }
        return _super(Team, this)._graphTitleAndKey();
    }
}