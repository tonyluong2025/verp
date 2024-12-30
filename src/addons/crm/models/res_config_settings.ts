import { Fields, _Date, _Datetime, api } from "../../../core";
import { UserError, ValueError } from "../../../core/helper";
import { MetaModel, TransientModel, _super } from "../../../core/models";
import { bool, isInstance } from "../../../core/tools";
import { addDate, subDate } from "../../../core/tools/date_utils";

@MetaModel.define()
class ResConfigSettings extends TransientModel {
    static _module = module;
    static _parents = 'res.config.settings';

    static groupUseLead = Fields.Boolean({ string: "Leads", impliedGroup: 'crm.groupUseLead' });
    static groupUseRecurringRevenues = Fields.Boolean({ string: "Recurring Revenues", impliedGroup: 'crm.groupUseRecurringRevenues' });
    // Membership
    static isMembershipMulti = Fields.Boolean({ string: 'Multi Teams', configParameter: 'sales_team.membershipMulti' });
    // Lead assignment
    static crmUseAutoAssignment = Fields.Boolean(
        { string: 'Rule-Based Assignment', configParameter: 'crm.lead.auto.assignment' });
    static crmAutoAssignmentAction = Fields.Selection([
        ['manual', 'Manually'], ['auto', 'Repeatedly']],
        {
            string: 'Auto Assignment Action', compute: '_computeCrmAutoAssignmentData',
            readonly: false, store: true,
            help: 'Manual assign allow to trigger assignment from team form view using an action button. Automatic configures a cron running repeatedly assignment in all teams.'
        });
    static crmAutoAssignmentIntervalType = Fields.Selection([
        ['minutes', 'Minutes'], ['hours', 'Hours'],
        ['days', 'Days'], ['weeks', 'Weeks']],
        {
            string: 'Auto Assignment Interval Unit', compute: '_computeCrmAutoAssignmentData',
            readonly: false, store: true,
            help: 'Interval type between each cron run (e.g. each 2 days or each 2 hours)'
        });
    static crmAutoAssignmentIntervalNumber = Fields.Integer(
        {
            string: "Repeat every", compute: '_computeCrmAutoAssignmentData',
            readonly: false, store: true,
            help: 'Number of interval type between each cron run (e.g. each 2 days or each 4 days)'
        });
    static crmAutoAssignmentRunDatetime = Fields.Datetime(
        {
            string: "Auto Assignment Next Execution Date", compute: '_computeCrmAutoAssignmentData',
            readonly: false, store: true
        });
    // IAP
    static moduleCrmIapMine = Fields.Boolean("Generate new leads based on their country, industries, size, etc.");
    static moduleCrmIapEnrich = Fields.Boolean("Enrich your leads automatically with company data based on their email address.");
    static moduleWebsiteCrmIapReveal = Fields.Boolean("Create Leads/Opportunities from your website traffic");
    static leadEnrichAuto = Fields.Selection([
        ['manual', 'Enrich leads on demand only'],
        ['auto', 'Enrich all leads automatically'],
    ], { string: 'Enrich lead automatically', default: 'manual', configParameter: 'crm.iap.lead.enrich.setting' });
    static leadMiningInPipeline = Fields.Boolean("Create a lead mining request directly from the opportunity pipeline.", { configParameter: 'crm.leadMiningInPipeline' });
    static predictiveLeadScoringStartDate = Fields.Date({ string: 'Lead Scoring Starting Date', compute: "_computePlsStartDate", inverse: "_inversePlsStartDateStr" });
    static predictiveLeadScoringStartDateStr = Fields.Char({ string: 'Lead Scoring Starting Date in String', configParameter: 'crm.pls_start_date' });
    static predictiveLeadScoringFields = Fields.Many2many('crm.lead.scoring.frequency.field', { string: 'Lead Scoring Frequency Fields', compute: "_computePlsFields", inverse: "_inversePlsFieldsStr" });
    static predictiveLeadScoringFieldsStr = Fields.Char({ string: 'Lead Scoring Frequency Fields in String', configParameter: 'crm.plsFields' });
    static predictiveLeadScoringFieldLabels = Fields.Char({ compute: '_computePredictiveLeadScoringFieldLabels' });

    @api.depends('crmUseAutoAssignment')
    async _computeCrmAutoAssignmentData() {
        const assignCron = await (await this.sudo()).env.ref('crm.irCronCrmLeadAssign', false);
        for (const setting of this) {
            if (await setting.crmUseAutoAssignment && bool(assignCron)) {
                await setting.update({
                    crmAutoAssignmentAction: await assignCron.active ? 'auto' : 'manual',
                    crmAutoAssignmentIntervalType: await assignCron.intervalType || 'days',
                    crmAutoAssignmentIntervalNumber: await assignCron.intervalNumber || 1,
                    crmAutoAssignmentRunDatetime: await assignCron.nextcall
                });
            }
            else {
                await setting.update({
                    crmAutoAssignmentAction: 'manual',
                    crmAutoAssignmentIntervalType: false,
                    crmAutoAssignmentRunDatetime: false,
                    crmAutoAssignmentIntervalNumber: 1
                });
            }
        }
    }

    @api.onchange('crmAutoAssignmentIntervalType', 'crmAutoAssignmentIntervalNumber')
    async _onchangeCrmAutoAssignmentRunDatetime() {
        const [crmAutoAssignmentRunDatetime, crmAutoAssignmentIntervalType,
            crmAutoAssignmentIntervalNumber] = await this('crmAutoAssignmentRunDatetime', 'crmAutoAssignmentIntervalType', 'crmAutoAssignmentIntervalNumber');
        if (crmAutoAssignmentIntervalNumber <= 0) {
            throw new UserError(await this._t('Repeat frequency should be positive.'));
        }
        else if (crmAutoAssignmentIntervalNumber >= 100) {
            throw new UserError(await this._t('Invalid repeat frequency. Consider changing frequency type instead of using large numbers.'));
        }
        await this.set('crmAutoAssignmentRunDatetime', await this._getCrmAutoAssignmmentRunDatetime(
            crmAutoAssignmentRunDatetime,
            crmAutoAssignmentIntervalType,
            crmAutoAssignmentIntervalNumber
        ));
    }

    /**
     * As config_parameters does not accept m2m field,
            we get the fields back from the Char config field, to ease the configuration in config panel
     */
    @api.depends('predictiveLeadScoringFieldsStr')
    async _computePlsFields() {
        for (const setting of this) {
            if (await setting.predictiveLeadScoringFieldsStr) {
                const names = (await setting.predictiveLeadScoringFieldsStr).split(',');
                const fields = await this.env.items('ir.model.fields').search([['label', 'in', names], ['model', '=', 'crm.lead']]);
                await setting.set('predictiveLeadScoringFields', await this.env.items('crm.lead.scoring.frequency.field').search([['fieldId', 'in', fields.ids]]));
            }
            else {
                await setting.set('predictiveLeadScoringFields', null);
            }
        }
    }

    /**
     * As config_parameters does not accept m2m field,
            we store the fields with a comma separated string into a Char config field
     */
    async _inversePlsFieldsStr() {
        for (const setting of this) {
            const predictiveLeadScoringFields = await setting.predictiveLeadScoringFields;
            if (bool(predictiveLeadScoringFields)) {
                await setting.set('predictiveLeadScoringFieldsStr', (await predictiveLeadScoringFields.mapped('fieldId.label')).join(','));
            }
            else {
                await setting.set('predictiveLeadScoringFieldsStr', '');
            }
        }
    }

    /**
     * As config_parameters does not accept Date field,
            we get the date back from the Char config field, to ease the configuration in config panel
     */
    @api.depends('predictiveLeadScoringStartDateStr')
    async _computePlsStartDate() {
        for (const setting of this) {
            const leadScoringStartDate = await setting.predictiveLeadScoringStartDateStr;
            // if config param is deleted / empty, set the date 8 days prior to current date
            if (!leadScoringStartDate) {
                await setting.set('predictiveLeadScoringStartDate', _Date.toDate(subDate(_Date.today(), { days: 8 })));
            }
            else {
                try {
                    await setting.set('predictiveLeadScoringStartDate', _Date.toDate(leadScoringStartDate));
                } catch (e) {
                    if (isInstance(e, ValueError)) {
                        // the config parameter is malformed, so set the date 8 days prior to current date
                        await setting.set('predictiveLeadScoringStartDate', _Date.toDate(subDate(_Date.today(), { days: 8 })));
                    } else {
                        throw e;
                    }
                }
            }
        }
    }

    /**
     * As config_parameters does not accept Date field,
            we store the date formated string into a Char config field
     */
    async _inversePlsStartDateStr() {
        for (const setting of this) {
            if (await setting.predictiveLeadScoringStartDate) {
                await setting.set('predictiveLeadScoringStartDateStr', _Date.toString(await setting.predictiveLeadScoringStartDate));
            }
        }
    }

    @api.depends('predictiveLeadScoringFields')
    async _computePredictiveLeadScoringFieldLabels() {
        for (const setting of this) {
            const predictiveLeadScoringFields = await setting.predictiveLeadScoringFields;
            if (bool(predictiveLeadScoringFields)) {
                const fieldNames = [await this._t('Stage')].concat(await predictiveLeadScoringFields.map(field => field.label));
                await setting.set('predictiveLeadScoringFieldLabels', await this._t('%s and %s', fieldNames.slice(0, -1).join(', '), fieldNames[fieldNames.length - 1]));
            }
            else {
                await setting.set('predictiveLeadScoringFieldLabels', await this._t('Stage'));
            }
        }
    }

    async setValues() {
        const userGroups = await (await this.env.user()).groupsId;
        const groupUseLead = await this.env.ref('crm.groupUseLead');
        const groupLeadBefore = userGroups.includes(groupUseLead);
        await _super(ResConfigSettings, this).setValues();
        // update use leads / opportunities setting on all teams according to settings update
        const groupLeadAfter = userGroups.includes(groupUseLead);
        if (groupLeadBefore != groupLeadAfter) {
            const teams = await this.env.items('crm.team').search([]);
            await (await teams.filtered('useOpportunities')).set('useLeads', groupLeadAfter);
            for (const team of teams) {
                await (await team.aliasId).write(await team._aliasGetCreationValues());
            }
        }
        // synchronize cron with settings
        const assignCron = await (await this.sudo()).env.ref('crm.irCronCrmLeadAssign', false);
        if (bool(assignCron)) {
            await assignCron.update({
                active: await this['crmUseAutoAssignment'] && await this['crmAutoAssignmentAction'] === 'auto',
                intervalType: await this['crmAutoAssignmentIntervalType'],
                intervalNumber: await this['crmAutoAssignmentIntervalNumber'],
                // keep nextcall on cron as it is required whatever the setting
                nextcall: await this['crmAutoAssignmentRunDatetime'] ? await this['crmAutoAssignmentRunDatetime'] : await assignCron.nextcall
            });
        }
        // TDE FIXME: re create cron if not found ?
    }

    async _getCrmAutoAssignmmentRunDatetime(runDatetime, runInterval, runIntervalNumber) {
        if (!runInterval) {
            return false;
        }
        if (runInterval === 'manual') {
            return runDatetime ? runDatetime : false;
        }
        return addDate(_Datetime.now(), { [runInterval]: runIntervalNumber });
    }

    async actionCrmAssignLeads() {
        this.ensureOne();
        return (await this.env.items('crm.team').search([['assignmentOptout', '=', false]])).actionAssignLeads(2, false);
    }
}