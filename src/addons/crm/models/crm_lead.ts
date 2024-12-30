import _ from "lodash";
import { DateTime } from "luxon";
import { Fields, _Date, _Datetime, api, models } from "../../../core";
import { getattr, hasattr, setdefault } from "../../../core/api";
import { AccessError, DefaultDict2, Dict, OrderedDict, UserError } from "../../../core/helper";
import { MetaModel, Model, _super } from "../../../core/models";
import { expression } from "../../../core/osv";
import { dbFactory } from "../../../core/service/db";
import { _f, allTimezones, bool, createIndex, emailNormalize, emailNormalizeAll, emailSplit, emailSplitTuples, extend, f, floatCompare, floatRound, formataddr, isCallable, isHtmlEmpty, isInstance, islice, len, next, parseInt, pop, range, remove, rsplit, setOptions, someAsync, sorted, splitEvery, update } from "../../../core/tools";
import { addDate, dateMax, dateMin, dateSetTz, dateWithoutTz, diffDate } from "../../../core/tools/date_utils";
import { _MAIL_DOMAIN_BLACKLIST } from "../../iap";
import { phoneParse } from "../../phone_validation";
import { AVAILABLE_PRIORITIES } from "./crm_stage";

const CRM_LEAD_FIELDS_TO_MERGE = [
    // UTM mixin
    'campaignId',
    'mediumId',
    'sourceId',
    // Mail mixin
    'emailCc',
    // description
    'label',
    'userId',
    'companyId',
    'teamId',
    // pipeline
    'stageId',
    // revenues
    'expectedRevenue',
    // dates
    'createdAt',
    'dateActionLast',
    // partner / contact
    'partnerId',
    'title',
    'partnerName',
    'contactName',
    'emailFrom',
    'mobile',
    'phone',
    'website',
    // address
    'street',
    'street2',
    'zip',
    'city',
    'stateId',
    'countryId',
]

// Subset of partner fields: sync any of those
const PARTNER_FIELDS_TO_SYNC = [
    'mobile',
    'title',
    'position',
    'website',
]

// Subset of partner fields: sync all or none to avoid mixed addresses
const PARTNER_ADDRESS_FIELDS_TO_SYNC = [
    'street',
    'street2',
    'city',
    'zip',
    'stateId',
    'countryId',
]

// Those values have been determined based on benchmark to minimise
// computation time, number of transaction and transaction time.
const PLS_COMPUTE_BATCH_STEP = 50000;  // verp.models.PREFETCH_MAX = 1000 but larger cluster can speed up global computation
const PLS_UPDATE_BATCH_STEP = 5000;

@MetaModel.define()
class Lead extends Model {
    static _module = module;
    static _name = "crm.lead";
    static _description = "Lead/Opportunity";
    static _order = "priority desc, id desc";
    static _parents = [
        'mail.thread.cc',
        'mail.thread.blacklist',
        'mail.thread.phone',
        'mail.activity.mixin',
        'utm.mixin',
        'format.address.mixin',
    ];
    static _checkCompanyAuto = true;

    // Description
    static label = Fields.Char(
        'Opportunity', {
        index: true, required: true,
        compute: '_computeName', readonly: false, store: true
    });
    static userId = Fields.Many2one(
        'res.users', {
        string: 'Salesperson', default: self => self.env.user(),
        domain: "['&', ['share', '=', false], ['companyIds', 'in', userCompanyIds]]",
        checkCompany: true, index: true, tracking: true
    });
    static userCompanyIds = Fields.Many2many(
        'res.company', {
        compute: '_computeUserCompanyIds',
        help: 'UX: Limit to lead company or all if no company'
    });
    static userEmail = Fields.Char('User Email', { related: 'userId.email', readonly: true });
    static userLogin = Fields.Char('User Login', { related: 'userId.login', readonly: true });
    static teamId = Fields.Many2one(
        'crm.team', {
        string: 'Sales Team', checkCompany: true, index: true, tracking: true,
        domain: "['|', ['companyId', '=', false], ['companyId', '=', companyId]]",
        compute: '_computeTeamId', ondelete: "SET NULL", readonly: false, store: true
    });
    static companyId = Fields.Many2one(
        'res.company', {
        string: 'Company', index: true,
        compute: '_computeCompanyId', readonly: false, store: true
    });
    static referred = Fields.Char('Referred By');
    static description = Fields.Html('Notes');
    static active = Fields.Boolean('Active', { default: true, tracking: true });
    static type = Fields.Selection([
        ['lead', 'Lead'], ['opportunity', 'Opportunity']],
        {
            index: true, required: true, tracking: 15,
            default: async (self) => await self.env.items('res.users').hasGroup('crm.groupUseLead') ? 'lead' : 'opportunity'
        });
    // Pipeline management
    static priority = Fields.Selection(
        AVAILABLE_PRIORITIES, {
        string: 'Priority', index: true,
        default: AVAILABLE_PRIORITIES[0][0]
    });
    static stageId = Fields.Many2one(
        'crm.stage', {
        string: 'Stage', index: true, tracking: true,
        compute: '_computeStageId', readonly: false, store: true,
        copy: false, groupExpand: '_readGroupStageIds', ondelete: 'RESTRICT',
        domain: "['|', ['teamId', '=', false], ['teamId', '=', teamId]]"
    });
    static kanbanState = Fields.Selection([
        ['grey', 'No next activity planned'],
        ['red', 'Next activity late'],
        ['green', 'Next activity is planned']], {
        string: 'Kanban State',
        compute: '_computeKanbanState'
    });
    static tagIds = Fields.Many2many(
        'crm.tag', {
        relation: 'crmTagRel', column1: 'leadId', column2: 'tagId', string: 'Tags',
        help: "Classify and analyze your lead/opportunity categories like: Training, Service"
    });
    static color = Fields.Integer('Color Index', { default: 0 });
    // Revenues
    static expectedRevenue = Fields.Monetary('Expected Revenue', { currencyField: 'companyCurrency', tracking: true });
    static proratedRevenue = Fields.Monetary('Prorated Revenue', { currencyField: 'companyCurrency', store: true, compute: "_computeProratedRevenue" });
    static recurringRevenue = Fields.Monetary('Recurring Revenues', { currencyField: 'companyCurrency', groups: "crm.groupUseRecurringRevenues", tracking: true });
    static recurringPlan = Fields.Many2one('crm.recurring.plan', { string: "Recurring Plan", groups: "crm.groupUseRecurringRevenues" });
    static recurringRevenueMonthly = Fields.Monetary('Expected MRR', {
        currencyField: 'companyCurrency', store: true,
        compute: "_computeRecurringRevenueMonthly",
        groups: "crm.groupUseRecurringRevenues"
    });
    static recurringRevenueMonthlyProrated = Fields.Monetary('Prorated MRR', {
        currencyField: 'companyCurrency', store: true,
        compute: "_computeRecurringRevenueMonthlyProrated",
        groups: "crm.groupUseRecurringRevenues"
    });
    static companyCurrency = Fields.Many2one("res.currency", { string: 'Currency', compute: "_computeCompanyCurrency", readonly: true });
    // Dates
    static dateClosed = Fields.Datetime('Closed Date', { readonly: true, copy: false });
    static dateActionLast = Fields.Datetime('Last Action', { readonly: true });
    static dateOpen = Fields.Datetime(
        'Assignment Date', { compute: '_computeDateOpen', readonly: true, store: true });
    static dayOpen = Fields.Float('Days to Assign', { compute: '_computeDayOpen', store: true });
    static dayClose = Fields.Float('Days to Close', { compute: '_computeDayClose', store: true });
    static dateLastStageUpdate = Fields.Datetime(
        'Last Stage Update', { compute: '_computeDateLastStageUpdate', index: true, readonly: true, store: true });
    static dateConversion = Fields.Datetime('Conversion Date', { readonly: true });
    static dateDeadline = Fields.Date('Expected Closing', { help: "Estimate of the date on which the opportunity will be won." });
    // Customer / contact
    static partnerId = Fields.Many2one(
        'res.partner', {
        string: 'Customer', checkCompany: true, index: true, tracking: 10,
        domain: "['|', ['companyId', '=', false], ['companyId', '=', companyId]]",
        help: "Linked partner (optional). Usually created when converting the lead. You can find a partner by its Name, TIN, Email or Internal Reference."
    });
    static partnerIsBlacklisted = Fields.Boolean('Partner is blacklisted', { related: 'partnerId.isBlacklisted', readonly: true });
    static contactName = Fields.Char(
        'Contact Name', {
        tracking: 30,
        compute: '_computeContactName', readonly: false, store: true
    });
    static partnerName = Fields.Char(
        'Company Name', {
        tracking: 20, index: true,
        compute: '_computePartnerName', readonly: false, store: true,
        help: 'The name of the future partner company that will be created while converting the lead into opportunity'
    });
    static position = Fields.Char('Job Position', { compute: '_computePosition', readonly: false, store: true });
    static title = Fields.Many2one('res.partner.title', { string: 'Title', compute: '_computeTitle', readonly: false, store: true });
    static emailFrom = Fields.Char(
        'Email', {
        tracking: 40, index: true,
        compute: '_computeEmailFrom', inverse: '_inverseEmailFrom', readonly: false, store: true
    });
    static phone = Fields.Char(
        'Phone', {
        tracking: 50,
        compute: '_computePhone', inverse: '_inversePhone', readonly: false, store: true
    });
    static mobile = Fields.Char('Mobile', { compute: '_computeMobile', readonly: false, store: true });
    static phoneState = Fields.Selection([
        ['correct', 'Correct'],
        ['incorrect', 'Incorrect']], { string: 'Phone Quality', compute: "_computePhoneState", store: true });
    static emailState = Fields.Selection([
        ['correct', 'Correct'],
        ['incorrect', 'Incorrect']], { string: 'Email Quality', compute: "_computeEmailState", store: true });
    static website = Fields.Char('Website', { index: true, help: "Website of the contact", compute: "_computeWebsite", readonly: false, store: true });
    static langId = Fields.Many2one(
        'res.lang', {
        string: 'Language',
        compute: '_computeLangId', readonly: false, store: true
    });
    // Address fields
    static street = Fields.Char('Street', { compute: '_computePartnerAddressValues', readonly: false, store: true });
    static street2 = Fields.Char('Street2', { compute: '_computePartnerAddressValues', readonly: false, store: true });
    static zip = Fields.Char('Zip', { changeDefault: true, compute: '_computePartnerAddressValues', readonly: false, store: true });
    static city = Fields.Char('City', { compute: '_computePartnerAddressValues', readonly: false, store: true });
    static stateId = Fields.Many2one(
        "res.country.state", {
        string: 'State',
        compute: '_computePartnerAddressValues', readonly: false, store: true,
        domain: "[['countryId', '=?', countryId]]"
    });
    static countryId = Fields.Many2one(
        'res.country', {
        string: 'Country',
        compute: '_computePartnerAddressValues', readonly: false, store: true
    });
    // Probability (Opportunity only)
    static probability = Fields.Float(
        'Probability', {
        groupOperator: "avg", copy: false,
        compute: '_computeProbabilities', readonly: false, store: true
    });
    static automatedProbability = Fields.Float('Automated Probability', { compute: '_computeProbabilities', readonly: true, store: true });
    static isAutomatedProbability = Fields.Boolean('Is automated probability?', { compute: "_computeIsAutomatedProbability" });
    // Won/Lost
    static lostReason = Fields.Many2one(
        'crm.lost.reason', {
        string: 'Lost Reason',
        index: true, ondelete: 'RESTRICT', tracking: true
    });
    // Statistics
    static calendarEventIds = Fields.One2many('calendar.event', 'opportunityId', { string: 'Meetings' });
    static calendarEventCount = Fields.Integer('# Meetings', { compute: '_computeCalendarEventCount' });
    static duplicateLeadIds = Fields.Many2many("crm.lead", { compute: "_computePotentialLeadDuplicates", string: "Potential Duplicate Lead", context: { "activeTest": false } });
    static duplicateLeadCount = Fields.Integer({ compute: "_computePotentialLeadDuplicates", string: "Potential Duplicate Lead Count" });
    // UX
    static partnerEmailUpdate = Fields.Boolean('Partner Email will Update', { compute: '_computePartnerEmailUpdate' });
    static partnerPhoneUpdate = Fields.Boolean('Partner Phone will Update', { compute: '_computePartnerPhoneUpdate' });

    static _sqlConstraints = [
        ['checkProbability', 'check(probability >= 0 and probability <= 100)', 'The probability of closing the deal should be between 0% and 100%!']
    ];

    get _primaryEmail() {
        return 'emailFrom';
    }

    @api.depends('activityDateDeadline')
    async _computeKanbanState() {
        const today = _Date.today();
        for (const lead of this) {
            let kanbanState = 'grey';
            if (await lead.activityDateDeadline) {
                const leadDate = _Date.toDate(await lead.activityDateDeadline);
                if (leadDate >= today) {
                    kanbanState = 'green';
                }
                else {
                    kanbanState = 'red';
                }
            }
            await lead.set('kanbanState', kanbanState);
        }
    }

    @api.depends('companyId')
    async _computeUserCompanyIds() {
        const allCompanies = await this.env.items('res.company').search([]);
        for (const lead of this) {
            if (!bool(await lead.companyId)) {
                await lead.set('userCompanyIds', allCompanies);
            }
            else {
                await lead.set('userCompanyIds', await lead.companyId);
            }
        }
    }

    @api.depends('companyId')
    async _computeCompanyCurrency() {
        for (const lead of this) {
            if (!bool(await lead.companyId)) {
                await lead.set('companyCurrency', await (await this.env.company()).currencyId);
            }
            else {
                await lead.set('companyCurrency', await (await lead.companyId).currencyId);
            }
        }
    }

    /**
     * When changing the user, also set a teamId or restrict team id
        to the ones userId is member of.
     */
    @api.depends('userId', 'type')
    async _computeTeamId() {
        for (const lead of this) {
            // setting user as void should not trigger a new team computation
            if (!bool(await lead.userId)) {
                continue;
            }
            let [user, team] = await lead('userId', 'teamId');
            if (bool(team) && (await team.memberIds).or(await team.userId).includes(user)) {
                continue;
            }
            const teamDomain = await lead.type === 'lead' ? [['useLeads', '=', true]] : [['useOpportunities', '=', true]];
            team = await this.env.items('crm.team')._getDefaultTeamId({ userId: user.id, domain: teamDomain });
            await lead.set('teamId', team.id);
        }
    }

    /**
     * Compute companyId coherency.
     */
    @api.depends('userId', 'teamId', 'partnerId')
    async _computeCompanyId() {
        for (const lead of this) {
            let [proposal, user, team, partnerId] = await lead('companyId', 'userId', 'teamId', 'partnerId');

            // invalidate wrong configuration
            if (bool(proposal)) {
                // company not in responsible companies
                if (user.ok && !(await user.companyIds).includes(proposal)) {
                    proposal = false;
                }
                // inconsistent
                if ((await team.companyId).ok && !proposal.eq(await team.companyId)) {
                    proposal = false;
                }
                // void company on team and no assignee
                if (team.ok && !(await team.companyId).ok && !(await lead.userId).ok) {
                    proposal = false;
                }
                // no user and no team -> void company and let assignment do its job
                // unless customer has a company
                if (!team.ok && !user.ok &&
                    (!partnerId.ok || !(await partnerId.companyId).eq(proposal))) {
                    proposal = false;
                }
            }
            // propose a new company based on team > user (respecting context) > partner
            if (!bool(proposal)) {
                if ((await team.companyId).ok) {
                    proposal = await team.companyId;
                }
                else if (user.ok) {
                    if ((await user.companyIds).includes(await this.env.company())) {
                        proposal = await this.env.company();
                    }
                    else {
                        proposal = (await user.companyId).and(await this.env.companies());
                    }
                }
                else if (partnerId.ok) {
                    proposal = await partnerId.companyId;
                }
                else {
                    proposal = false;
                }
            }
            // set a new company
            if (!(await lead.companyId).eq(proposal)) {
                await lead.set('companyId', proposal);
            }
        }
    }

    @api.depends('teamId', 'type')
    async _computeStageId() {
        for (const lead of this) {
            if (!bool(await lead.stageId)) {
                await lead.set('stageId', (await lead._stageFind({ domain: [['fold', '=', false]] })).id);
            }
        }
    }

    @api.depends('userId')
    async _computeDateOpen() {
        for (const lead of this) {
            await lead.set('dateOpen', (await lead.userId).ok ? _Datetime.now() : false);
        }
    }

    @api.depends('stageId')
    async _computeDateLastStageUpdate() {
        for (const lead of this) {
            await lead.set('dateLastStageUpdate', _Datetime.now());
        }
    }

    /**
     * Compute difference between create date and open date
     */
    @api.depends('createdAt', 'dateOpen')
    async _computeDayOpen() {
        const leads = await this.filtered(async (lead) => await lead.dateOpen && await lead.createdAt);
        const others = await this.sudo(leads);
        await others.set('dayOpen', null);
        for (const lead of leads) {
            const dateCreate = _Datetime.toDatetime(await lead.createdAt) as Date;
            dateCreate.setMilliseconds(0);
            const dateOpen = _Datetime.toDatetime(await lead.dateOpen) as Date;
            await lead.set('dayOpen', Math.abs(diffDate(dateOpen, dateCreate, 'days').days));
        }
    }

    /**
     * Compute difference between current date and log date
     */
    @api.depends('createdAt', 'dateClosed')
    async _computeDayClose() {
        const leads = await this.filtered(async (lead) => await lead.dateClosed && await lead.createdAt);
        const others = this.sub(leads);
        await others.set('dayClose', null);
        for (const lead of leads) {
            const dateCreate = _Datetime.toDatetime(await lead.createdAt) as Date;
            const dateClose = _Datetime.toDatetime(await lead.dateClosed) as Date;
            await lead.set('dayClose', Math.abs(diffDate(dateClose, dateCreate, 'days').days));
        }
    }

    @api.depends('partnerId')
    async _computeName() {
        for (const lead of this) {
            const [label, partner] = await lead('label', 'partnerId');
            if (!label && partner.ok && await partner.label) {
                await lead.set('label', await this._t("%s's opportunity", await partner.label));
            }
        }
    }

    /**
     * compute the new values when partnerId has changed
     */
    @api.depends('partnerId')
    async _computeContactName() {
        for (const lead of this) {
            await lead.update(await lead._prepareContactNameFromPartner(await lead.partnerId));
        }
    }

    /**
     * compute the new values when partnerId has changed
     */
    @api.depends('partnerId')
    async _computePartnerName() {
        for (const lead of this) {
            await lead.update(await lead._preparePartnerNameFromPartner(await lead.partnerId));
        }
    }

    /**
     * compute the new values when partnerId has changed
     * @returns 
     */
    @api.depends('partnerId')
    async _computePosition() {
        for (const lead of this) {
            const [position, partner] = await lead('position', 'partnerId');
            if (!position || await partner.position) {
                await lead.set('position', await partner.position);
            }
        }
    }

    /**
     * compute the new values when partnerId has changed
     */
    @api.depends('partnerId')
    async _computeTitle() {
        for (const lead of this) {
            const [title, partner] = await lead('title', 'partnerId');
            if (!title || await partner.title) {
                await lead.set('title', await partner.title);
            }
        }
    }

    /**
     * compute the new values when partnerId has changed
     * @returns 
     */
    @api.depends('partnerId')
    async _computeMobile() {
        for (const lead of this) {
            const [mobile, partner] = await lead('mobile', 'partnerId');
            if (!mobile || await partner.mobile) {
                await lead.set('mobile', await partner.mobile);
            }
        }
    }

    /**
     * compute the new values when partnerId has changed
     * @returns 
     */
    @api.depends('partnerId')
    async _computeWebsite() {
        for (const lead of this) {
            const [website, partner] = await lead('website', 'partnerId');
            if (!website || await partner.website) {
                await lead.set('website', await partner.website);
            }
        }
    }

    /**
     * compute the lang based on partner when partnerId has changed
     * @returns 
     */
    @api.depends('partnerId')
    async _computeLangId() {
        const woLang = await this.filtered(async (lead) => !(await lead.langId).ok && (await lead.partnerId).ok);
        if (!woLang.ok) {
            return;
        }
        // prepare cache
        const langCodes = await (await woLang.mapped('partnerId.lang')).filter(code => code);
        const langIdByCode = Object.fromEntries(await Promise.all(langCodes.map(async (code) => [code, await this.env.items('res.lang')._langGetId(code)])));
        for (const lead of woLang) {
            await lead.set('langId', langIdByCode[await (await lead.partnerId).lang] ?? false);
        }
    }

    /**
     * Sync all or none of address fields
     */
    @api.depends('partnerId')
    async _computePartnerAddressValues() {
        for (const lead of this) {
            await lead.update(await lead._prepareAddressValuesFromPartner(await lead.partnerId));
        }
    }

    @api.depends('partnerId.email')
    async _computeEmailFrom() {
        for (const lead of this) {
            const partner = await lead.partnerId;
            if (await partner.email && await lead._getPartnerEmailUpdate()) {
                await lead.set('emailFrom', await partner.email);
            }
        }
    }

    async _inverseEmailFrom() {
        for (const lead of this) {
            if (await lead._getPartnerEmailUpdate()) {
                await (await lead.partnerId).set('email', await lead.emailFrom);
            }
        }
    }

    @api.depends('partnerId.phone')
    async _computePhone() {
        for (const lead of this) {
            const phone = await (await lead.partnerId).phone;
            if (phone && await lead._getPartnerPhoneUpdate()) {
                await lead.set('phone', phone);
            }
        }
    }

    async _inversePhone() {
        for (const lead of this) {
            if (await lead._getPartnerPhoneUpdate()) {
                await (await lead.partnerId).set('phone', await lead.phone);
            }
        }
    }

    @api.depends('phone', 'countryId.code')
    async _computePhoneState() {
        for (const lead of this) {
            let phoneStatus: any = false;
            const [phone, country] = await lead('phone', 'countryId');
            if (phone) {
                const countryCode = country.ok && await country.code ? await country.code : null;
                try {
                    if (await phoneParse(phone, countryCode)) {  // otherwise library not installed
                        phoneStatus = 'correct';
                    }
                } catch (e) {
                    if (isInstance(e, UserError)) {
                        phoneStatus = 'incorrect';
                    }
                    else {
                        throw e;
                    }
                }
            }
            await lead.set('phoneState', phoneStatus);
        }
    }

    @api.depends('emailFrom')
    async _computeEmailState() {
        for (const lead of this) {
            let emailState: any = false;
            const emailFrom = await lead.emailFrom;
            if (emailFrom) {
                emailState = 'incorrect';
                for (const email of emailSplit(emailFrom)) {
                    if (emailNormalize(email)) {
                        emailState = 'correct';
                        break;
                    }
                }
            }
            await lead.set('emailState', emailState);
        }
    }

    /**
     * If probability and automatedProbability are equal probability computation
        is considered as automatic, aka probability is sync with automatedProbability
     */
    @api.depends('probability', 'automatedProbability')
    async _computeIsAutomatedProbability() {
        for (const lead of this) {
            await lead.set('isAutomatedProbability', floatCompare(await lead.probability, await lead.automatedProbability, { precisionDigits: 2 }) == 0);
        }
    }

    @api.depends(async (self) => ['stageId', 'teamId'].concat(await self._plsGetSafeFields()))
    async _computeProbabilities() {
        const leadProbabilities = await this._plsGetNaiveBayesProbabilities();
        for (const lead of this) {
            if (lead.id in leadProbabilities) {
                const wasAutomated = await lead.active && await lead.isAutomatedProbability;
                await lead.set('automatedProbability', leadProbabilities[lead.id]);
                if (wasAutomated) {
                    await lead.set('probability', await lead.automatedProbability);
                }
            }
        }
    }

    @api.depends('expectedRevenue', 'probability')
    async _computeProratedRevenue() {
        for (const lead of this) {
            await lead.set('proratedRevenue', floatRound((await lead.expectedRevenue || 0.0) * (await lead.probability || 0) / 100.0, { precisionDigits: 2 }));
        }
    }

    @api.depends('recurringRevenue', 'recurringPlan.numberOfMonths')
    async _computeRecurringRevenueMonthly() {
        for (const lead of this) {
            await lead.set('recurringRevenueMonthly', (await lead.recurringRevenue || 0.0) / (await (await lead.recurringPlan).numberOfMonths || 1));
        }
    }

    @api.depends('recurringRevenueMonthly', 'probability')
    async _computeRecurringRevenueMonthlyProrated() {
        for (const lead of this) {
            await lead.set('recurringRevenueMonthlyProrated', (await lead.recurringRevenueMonthly || 0.0) * (await lead.probability || 0) / 100.0);
        }
    }

    async _computeCalendarEventCount() {
        let mappedData;
        if (bool(await this.ids)) {
            const meetingData = await (await this.env.items('calendar.event').sudo()).readGroup([
                ['opportunityId', 'in', this.ids]
            ], ['opportunityId'], ['opportunityId']);
            mappedData = Object.fromEntries(meetingData.map(m => [m['opportunityId'][0], m['opportunityId_count']]));
        }
        else {
            mappedData = {};
        }
        for (const lead of this) {
            await lead.set('calendarEventCount', mappedData[lead.id] ?? 0);
        }
    }

    @api.depends('emailFrom', 'partnerId', 'contactName', 'partnerName')
    async _computePotentialLeadDuplicates() {
        const MIN_EMAIL_LENGTH = 7;
        const MIN_NAME_LENGTH = 6;
        const SEARCH_RESULT_LIMIT = 21;
        const self = this;
        /**
         * Returns the recordset obtained by performing a search on the provided
            model with the provided domain if the cardinality of that recordset is
            below a given threshold (i.e: `SEARCH_RESULT_LIMIT`). Otherwise, returns
            an empty recordset of the provided model as it indicates search term
            was not relevant.

            Note: The method will use the administrator privileges to guarantee
            that a maximum amount of leads will be included in the search results
            and transcend multi-company record rules. It also includes archived records.
            Idea is that counter indicates duplicates are present and that lead
            could be escalated to managers.
         * @param modelName 
         * @param domain 
         * @returns 
         */
        async function returnIfRelevant(modelName, domain) {
            // Includes archived records and transcend multi-company record rules
            const model = await (await self.env.items(modelName).sudo()).withContext({ activeTest: false });
            const res = await model.search(domain, { limit: SEARCH_RESULT_LIMIT });
            return len(res) < SEARCH_RESULT_LIMIT ? res : model;
        }

        /**
         * Returns the full email address if the domain of the email address
            is common (i.e: in the mail domain blacklist). Otherwise, returns
            the domain of the email address. A minimal length is required to avoid
            returning false positives records.
         */
        function getEmailToSearch(email) {
            if (!email || len(email) < MIN_EMAIL_LENGTH) {
                return false;
            }
            const parts = rsplit(email, '@', 1);
            if (len(parts) > 1) {
                let emailDomain = parts[1];
                if (!_MAIL_DOMAIN_BLACKLIST.has(emailDomain)) {
                    return '@' + emailDomain;
                }
            }
            return email;
        }

        for (const lead of this) {
            const leadId = isInstance(lead.id, models.NewId) ? lead._origin.id : lead.id;
            const commonLeadDomain = [
                ['id', '!=', leadId]
            ];

            let duplicateLeadIds = this.env.items('crm.lead');
            const emailSearch = getEmailToSearch(await lead.emailFrom);

            if (emailSearch) {
                duplicateLeadIds = duplicateLeadIds.or(await returnIfRelevant('crm.lead', commonLeadDomain.concat([
                    ['emailFrom', 'ilike', emailSearch]
                ])));
            }
            if (await lead.partnerName && len(await lead.partnerName) >= MIN_NAME_LENGTH) {
                duplicateLeadIds = duplicateLeadIds.or(await returnIfRelevant('crm.lead', commonLeadDomain.concat([
                    ['partnerName', 'ilike', await lead.partnerName]
                ])));
            }
            if (await lead.contactName && len(await lead.contactName) >= MIN_NAME_LENGTH) {
                duplicateLeadIds = duplicateLeadIds.or(await returnIfRelevant('crm.lead', commonLeadDomain.concat([
                    ['contactName', 'ilike', await lead.contactName]
                ])));
            }
            if (bool(await lead.partnerId) && bool(await (await lead.partnerId).commercialPartnerId)) {
                duplicateLeadIds = duplicateLeadIds.or(await (await lead.withContext({ activeTest: false })).search(commonLeadDomain.concat([
                    ["partnerId", "childOf", (await (await lead.partnerId).commercialPartnerId).id]
                ])));
            }

            await lead.set('duplicateLeadIds', duplicateLeadIds.add(lead));
            await lead.set('duplicateLeadCount', len(duplicateLeadIds));
        }
    }

    @api.depends('emailFrom', 'partnerId')
    async _computePartnerEmailUpdate() {
        for (const lead of this) {
            await lead.set('partnerEmailUpdate', await lead._getPartnerEmailUpdate());
        }
    }

    @api.depends('phone', 'partnerId')
    async _computePartnerPhoneUpdate() {
        for (const lead of this) {
            await lead.set('partnerPhoneUpdate', await lead._getPartnerPhoneUpdate());
        }
    }

    @api.onchange('phone', 'countryId', 'companyId')
    async _onchangePhoneValidation() {
        const phone = await this['phone'];
        if (phone) {
            await this.set('phone', await (this as any).phoneGetSanitizedNumber('phone', 'INTERNATIONAL') || phone);
        }
    }

    @api.onchange('mobile', 'countryId', 'companyId')
    async _onchangeMobileValidation() {
        const mobile = await this['mobile'];
        if (mobile) {
            await this.set('mobile', await (this as any).phoneGetSanitizedNumber('mobile', 'INTERNATIONAL') || mobile);
        }
    }

    /**
     * Get a dictionary with values coming from partner information to
        copy on a lead. Non-address fields get the current lead
        values to avoid being reset if partner has no value for them.
     * @param partner 
     * @returns 
     */
    async _prepareValuesFromPartner(partner) {
        // Sync all address fields from partner, or none, to avoid mixing them.
        const values = await this._prepareAddressValuesFromPartner(partner);

        // For other fields, get the info from the partner, but only if set
        for (const f of PARTNER_FIELDS_TO_SYNC) {
            values[f] = partner[f] || this[f];
        }
        if (await partner.lang) {
            values['langId'] = await this.env.items('res.lang')._langGetId(await partner.lang);
        }
        // Fields with specific logic
        update(values, await this._prepareContactNameFromPartner(partner));
        update(values, await this._preparePartnerNameFromPartner(partner));

        return this._convertToWrite(values);
    }

    async _prepareAddressValuesFromPartner(partner) {
        const values = {};
        // Sync all address fields from partner, or none, to avoid mixing them.
        if (someAsync(PARTNER_ADDRESS_FIELDS_TO_SYNC, f => partner[f])) {
            for (const f of PARTNER_ADDRESS_FIELDS_TO_SYNC) {
                values[f] = await partner[f];
            }
        }
        else {
            for (const f of PARTNER_ADDRESS_FIELDS_TO_SYNC) {
                values[f] = await this[f];
            }
        }
        return values;
    }

    async _prepareContactNameFromPartner(partner) {
        const contactName = await partner.isCompany ? false : await partner.label;
        return { 'contactName': contactName || await this['contactName'] }
    }

    /**
     * Company name: name of partner parent (if set) or name of partner
        (if company) or companyName of partner (if not a company).
     * @param partner 
     * @returns 
     */
    async _preparePartnerNameFromPartner(partner) {
        let partnerName = await (await partner.parentId).label;
        if (!partnerName && await partner.isCompany) {
            partnerName = await partner.label;
        }
        else if (!partnerName && await partner.companyName) {
            partnerName = await partner.companyName;
        }
        return { 'partnerName': partnerName || await this['partnerName'] }
    }

    /**
     * Calculate if we should write the email on the related partner. When
        the email of the lead / partner is an empty string, we force it to False
        to not propagate a False on an empty string.

        Done in a separate method so it can be used in both ribbon and inverse
        and compute of email update methods.
     * @returns 
     */
    async _getPartnerEmailUpdate(): Promise<boolean> {
        this.ensureOne();
        const [partner, emailFrom] = await this('partnerId', 'emailFrom');
        const partnerEmail = await partner.email;
        if (partner.ok && emailFrom !== partnerEmail) {
            const leadEmailNormalized = emailNormalize(emailFrom) || emailFrom || false;
            const partnerEmailNormalized = emailNormalize(partnerEmail) || partnerEmail || false;
            return leadEmailNormalized !== partnerEmailNormalized;
        }
        return false;
    }

    async _getPartnerPhoneUpdate() {
        this.ensureOne();
        const [partner, phone] = await this('partnerId', 'phone');
        const partnerPhone = await partner.phone;
        if (partner.ok && phone !== partnerPhone) {
            const leadPhoneFormatted = await (this as any).phoneGetSanitizedNumber('phone') || phone || false;
            const partnerPhoneFormatted = await partner.phoneGetSanitizedNumber('phone') || partnerPhone || false;
            return leadPhoneFormatted !== partnerPhoneFormatted;
        }
        return false;
    }

    // ------------------------------------------------------------
    // ORM
    // ------------------------------------------------------------

    async _autoInit() {
        const res = await _super(Lead, this)._autoInit();
        await createIndex(this._cr, 'crmLeadUserIdTeamIdTypeIndex',
            this.cls._table, ['"userId"', '"teamId"', '"type"']);
        await createIndex(this._cr, 'crmLeadCreatedAtTeamIdIdx',
            this.cls._table, ['"createdAt"', '"teamId"']);
        return res;
    }

    @api.modelCreateMulti()
    async create(valsList) {
        for (const vals of valsList) {
            if (vals['website']) {
                vals['website'] = await this.env.items('res.partner')._cleanWebsite(vals['website']);
            }
        }
        const leads = await _super(Lead, this).create(valsList);

        for (const [lead, values] of _.zip([...leads], [...valsList])) {
            if (values.keys().some(field => ['active', 'stageId'].includes(field))) {
                await lead._handleWonLost(values);
            }
        }

        return leads;
    }

    async write(vals) {
        if (vals['website']) {
            vals['website'] = await this.env.items('res.partner')._cleanWebsite(vals['website']);
        }
        let [stageUpdated, stageIsWon] = [vals['stageId'], false];
        // stage change: update dateLastStageUpdate
        if (bool(stageUpdated)) {
            const stage = this.env.items('crm.stage').browse(vals['stageId']);
            if (await stage.isWon) {
                update(vals, { 'probability': 100, 'automatedProbability': 100 });
                stageIsWon = true;
            }
        }
        // stage change with new stage: update probability and dateClosed
        if ((vals['probability'] ?? 0) >= 100 || !(vals['active'] ?? true)) {
            vals['dateClosed'] = _Datetime.now();
        }
        else if ((vals['probability'] ?? 0) > 0) {
            vals['dateClosed'] = false;
        }
        else if (bool(stageUpdated) && !stageIsWon && !('probability' in vals)) {
            vals['dateClosed'] = false;
        }

        if (Object.keys(vals).some(field => ['active', 'stageId'].includes(field))) {
            await this._handleWonLost(vals);
        }

        if (!stageIsWon) {
            return _super(Lead, this).write(vals);
        }
        // stage change between two won stages: does not change the dateClosed
        const leadsAlreadyWon = await this.filtered(async (lead) => await (await lead.stageId).isWon);
        const remaining = this.sub(leadsAlreadyWon);
        let result;
        if (remaining.ok) {
            result = await _super(Lead, remaining).write(vals);
        }
        if (leadsAlreadyWon.ok) {
            pop(vals, 'dateClosed', false);
            result = await _super(Lead, leadsAlreadyWon).write(vals);
        }
        return result;
    }

    /**
     * Override to support ordering on myActivityDateDeadline.

        Ordering through web client calls searchRead with an order parameter set.
        SearchRead then calls search. In this override we therefore override search
        to intercept a search without count with an order on myActivityDateDeadline.
        In that case we do the search in two steps.

        First step: fill with deadline-based results

          * Perform a readGroup on my activities to get a mapping leadId / deadline
            Remember dateDeadline is required, we always have a value for it. Only
            the earliest deadline per lead is kept.
          * Search leads linked to those activities that also match the asked domain
            and order from the original search request.
          * Results of that search will be at the top of returned results. Use limit
            None because we have to search all leads linked to activities as ordering
            on deadline is done in post processing.
          * Reorder them according to deadline asc or desc depending on original
            search ordering. Finally take only a subset of those leads to fill with
            results matching asked offset / limit.

        Second step: fill with other results. If first step does not gives results
        enough to match offset and limit parameters we fill with a search on other
        leads. We keep the asked domain and ordering while filtering out already
        scanned leads to keep a coherent results.

        All other search and searchRead are left untouched by this override to avoid
        side effects. SearchCount is not affected by this override.
     */
    @api.model()
    async search(args, opts: { offset?: number, limit?: number, order?: string, count?: boolean } = {}) {
        const offset = opts.offset ?? 0;
        const limit = opts.limit;
        if (opts.count || !opts.order || !opts.order.toLowerCase().includes('myActivityDateDeadline'.toLowerCase())) {
            return _super(Lead, this).search(args, opts);
        }
        const orderItems = (opts.order || this.cls._order).split(',').map(orderItem => orderItem.trim().toLowerCase());

        // Perform a readGroup on my activities to get a mapping leadId / deadline
        // Remember dateDeadline is required, we always have a value for it. Only
        // the earliest deadline per lead is kept.
        const activityAsc = orderItems.some(item => item.includes('myActivityDateDeadline asc'.toLowerCase()));
        const myLeadActivities = await this.env.items('mail.activity').readGroup(
            [['resModel', '=', this._name], ['userId', '=', this.env.uid]],
            ['resId', 'dateDeadline:min'],
            ['resId'],
            { orderby: 'dateDeadline ASC' }
        );
        const myLeadMapping = Object.fromEntries(myLeadActivities.map(item => [item['resId'], item['dateDeadline']]));
        const myLeadIds = myLeadMapping.keys();
        const myLeadDomain = expression.AND([[['id', 'in', myLeadIds]], args]);
        const myLeadOrder = orderItems.filter(item => !item.toLowerCase().includes('myActivityDateDeadline'.toLowerCase())).join(', ');

        // Search leads linked to those activities and order them. See docstring
        // of this method for more details.
        const searchRes = await _super(Lead, this).search(myLeadDomain, { offset: 0, limit: null, order: myLeadOrder, count: opts.count });
        const myLeadIdsOrdered = sorted(searchRes.ids, (leadId) => myLeadMapping[leadId], !activityAsc);
        // keep only requested window (offset + limit, or offset+)
        const myLeadIdsKeep = limit ? myLeadIdsOrdered.slice(offset, offset + limit) : myLeadIdsOrdered.slice(offset);
        // keep list of already skipped lead ids to exclude them from future search
        const myLeadIdsSkip = limit ? myLeadIdsOrdered.slice(0, offset + limit) : myLeadIdsOrdered;

        // do not go further if limit is achieved
        if (limit && len(myLeadIdsKeep) >= limit) {
            return this.browse(myLeadIdsKeep);
        }

        // Fill with remaining leads. If a limit is given, simply remove count of
        // already fetched. Otherwise keep none. If an offset is set we have to
        // reduce it by already fetch results hereabove. Order is updated to exclude
        // myActivityDateDeadline when calling super() .
        const leadLimit = limit ? (limit - len(myLeadIdsKeep)) : null;
        let leadOffset;
        if (offset) {
            leadOffset = Math.max((offset - len(searchRes), 0));
        }
        else {
            leadOffset = 0;
        }
        const leadOrder = orderItems.filter(item => !item.toLowerCase().includes('myActivityDateDeadline'.toLowerCase())).join(', ');

        const otherLeadRes = await _super(Lead, this).search(
            expression.AND([[['id', 'not in', myLeadIdsSkip]], args]),
            { offset: leadOffset, limit: leadLimit, order: leadOrder, count: opts.count }
        );
        return this.browse(myLeadIdsKeep).add(otherLeadRes);
    }

    /**
     * This method handle the state changes :
        - To lost : We need to increment corresponding lost count in scoring frequency table
        - To won : We need to increment corresponding won count in scoring frequency table
        - From lost to Won : We need to decrement corresponding lost count + increment corresponding won count
        in scoring frequency table.
        - From won to lost : We need to decrement corresponding won count + increment corresponding lost count
        in scoring frequency table.
     */
    async _handleWonLost(vals) {
        const leadObj = this.env.items('crm.lead');
        let leadsReachWon = leadObj;
        let leadsLeaveWon = leadObj;
        let leadsReachLost = leadObj;
        let leadsLeaveLost = leadObj;
        const wonStageIds = (await this.env.items('crm.stage').search([['isWon', '=', true]])).ids;
        for (const lead of this) {
            const active = await lead.active;
            if ('stageId' in vals) {
                if (wonStageIds.includes(vals['stageId'])) {
                    if (await lead.probability == 0) {
                        leadsLeaveLost = leadsLeaveLost.add(lead);
                    }
                    leadsReachWon = leadsReachWon.add(lead);
                }
                else if (wonStageIds.includes((await lead.stageId).id) && active) {  // a lead can be lost at wonStage
                    leadsLeaveWon = leadsLeaveWon.add(lead);
                }
            }
            if ('active' in vals) {
                if (!vals['active'] && active) {  // archive lead
                    if (wonStageIds.includes((await lead.stageId).id) && !leadsLeaveWon.includes(lead)) {
                        leadsLeaveWon = leadsLeaveWon.add(lead);
                    }
                    leadsReachLost = leadsReachLost.add(lead);
                }
                else if (vals['active'] && !active) {  // restore lead
                    leadsLeaveLost = leadsLeaveLost.add(lead);
                }
            }
        }
        await leadsReachWon._plsIncrementFrequencies(null, 'won');
        await leadsLeaveWon._plsIncrementFrequencies('won');
        await leadsReachLost._plsIncrementFrequencies(null, 'lost');
        await leadsLeaveLost._plsIncrementFrequencies('lost');
    }

    @api.returns('self', (value) => value.id)
    async copy(defaultValue?: any) {
        this.ensureOne();
        // SET DEFAULT value in context, if not already set (Put stage to 'new' stage)
        const context = structuredClone(this._context);
        setdefault(context, 'default_type', await this['type']);
        setdefault(context, 'default_teamId', (await this['teamId']).id);
        // Set dateOpen to today if it is an opp
        defaultValue = defaultValue ?? {};
        defaultValue['dateOpen'] = await this['type'] === 'opportunity' ? _Datetime.now() : false;
        // Do not assign to an archived user
        if (! await (await this['userId']).active) {
            defaultValue['userId'] = false;
        }
        if (! await (await this.env.user()).hasGroup('crm.groupUseRecurringRevenues')) {
            defaultValue['recurringRevenue'] = 0;
            defaultValue['recurringPlan'] = false;
        }
        return _super(Lead, await this.withContext(context)).copy(defaultValue);
    }

    /**
     * Update meetings when removing opportunities, otherwise you have
        a link to a record that does not lead anywhere.
     */
    async unlink() {
        const meetings = await this.env.items('calendar.event').search([
            ['resId', 'in', this.ids],
            ['resModel', '=', this._name],
        ]);
        if (meetings.ok) {
            await meetings.write({
                'resId': false,
                'resModelId': false,
            });
        }
        return _super(Lead, this).unlink();
    }

    @api.model()
    async _fieldsViewGet(viewId?: any, viewType: string = 'form', toolbar: boolean = false, submenu: boolean = false) {
        if (this._context['opportunityId']) {
            const opportunity = this.browse(this._context['opportunityId']);
            const action = await opportunity.getFormviewAction();
            if (action['views'] && action['views'].some(viewId => viewId[1] === viewType)) {
                viewId = next(action['views'].filter(viewId => viewId[1] == viewType).map(viewId => viewId[0]));
            }
        }
        const res = await _super(Lead, this)._fieldsViewGet(viewId, viewType, toolbar, submenu);
        if (viewType === 'form') {
            res['arch'] = await (this as any)._fieldsViewGetAddress(res['arch']);
        }
        return res;
    }

    @api.model()
    async _readGroupStageIds(stages, domain, order) {
        // retrieve teamId from the context and write the domain
        // - ['id', 'in', stages.ids]: add columns that should be present
        // - OR ['fold', '=', false]: add default columns that are not folded
        // - OR ['teamIds', '=', teamId], ['fold', '=', false] if teamId: add team columns that are not folded
        const teamId = this._context['default_teamId'];
        let searchDomain;
        if (bool(teamId)) {
            searchDomain = ['|', ['id', 'in', stages.ids], '|', ['teamId', '=', false], ['teamId', '=', teamId]];
        }
        else {
            searchDomain = ['|', ['id', 'in', stages.ids], ['teamId', '=', false]];
        }
        // perform search
        const stageIds = await stages._search(searchDomain, { order: order, accessRightsUid: global.SUPERUSER_ID });
        return stages.browse(stageIds);
    }

    /**
     * Determine the stage of the current lead with its teams, the given domain and the given teamId
            :param teamId
            :param domain : base search domain for stage
            :param order : base search order for stage
            :param limit : base search limit for stage
            :returns crm.stage recordset
     * @param teamId 
     * @param domain 
     * @param order 
     * @param limit 
     * @returns 
     */
    async _stageFind(opts: { teamId?: any, domain?: any[], order?: string, limit?: number } = {}) {
        setOptions(opts, { teamId: false, order: 'sequence, id', limit: 1 })
        // collect all teamIds by adding given one, and the ones related to the current leads
        const teamIds = new Set();
        if (bool(opts.teamId)) {
            teamIds.add(opts.teamId);
        }
        for (const lead of this) {
            if ((await lead.teamId).ok) {
                teamIds.add((await lead.teamId).id);
            }
        }
        let searchDomain;
        // generate the domain
        if (teamIds.size) {
            searchDomain = ['|', ['teamId', '=', false], ['teamId', 'in', Array.from(teamIds)]];
        }
        else {
            searchDomain = [['teamId', '=', false]];
        }
        // AND with the domain in parameter
        if (bool(opts.domain)) {
            searchDomain = searchDomain.concat(opts.domain);
        }
        // perform search, return the first found
        return this.env.items('crm.stage').search(searchDomain, { order: opts.order, limit: opts.limit });
    }

    // ------------------------------------------------------------
    // ACTIONS
    // ------------------------------------------------------------

    /**
     * When archiving: mark probability as 0. When re-activating
        update probability again, for leads and opportunities.
     */
    async toggleActive() {
        const res = await _super(Lead, this).toggleActive();
        const activated = await this.filtered((lead) => lead.active);
        const archived = await this.filtered(async (lead) => !await lead.active);
        if (activated.ok) {
            await activated.write({ 'lostReason': false });
            await activated._computeProbabilities();
        }
        if (archived.ok) {
            await archived.write({ 'probability': 0, 'automatedProbability': 0 });
        }
        return res;
    }

    async actionSetLost(additionalValues?: {}) {
        const res = await this.actionArchive();
        if (bool(additionalValues)) {
            await this.write(Object.assign({}, additionalValues));
        }
        return res;
    }

    /**
     * Won semantic: probability = 100 (active untouched)
     */
    async actionSetWon() {
        await this.actionUnarchive();
        // group the leads by teamId, in order to write once by values couple (each write leads to frequency increment)
        const leadsByWonStage = new Map();
        for (const lead of this) {
            const wonStages = await this._stageFind({ domain: [['isWon', '=', true]], limit: null });
            // ABD : We could have a mixed pipeline, with "won" stages being separated by "standard"
            // stages. In the future, we may want to prevent any "standard" stage to have a higher
            // sequence than any "won" stage. But while this is not the case, searching
            // for the "won" stage while alterning the sequence order (see below) will correctly
            // handle such a case :
            //       stage sequence : [x] [x (won)] [y] [y (won)] [z] [z (won)]
            //       when in stage [y] and marked as "won", should go to the stage [y (won)],
            //       not in [x (won)] nor [z (won)]
            const sequence = await (lead.stageId).sequence;
            let stageId = next(await wonStages.filter(async (stage) => await stage.sequence > sequence), null);
            if (!bool(stageId)) {
                stageId = next(await (await wonStages.reversed()).filter(async (stage) => await stage.sequence <= sequence), wonStages);
            }
            if (stageId in leadsByWonStage) {
                leadsByWonStage.set(stageId, leadsByWonStage.get(stageId).add(lead));
            }
            else {
                leadsByWonStage.set(stageId, lead);
            }
        }
        for (const [wonStageId, leads] of leadsByWonStage) {
            await leads.write({ 'stageId': wonStageId.id, 'probability': 100 });
        }
        return true;
    }

    async actionSetAutomatedProbability() {
        await this.write({ 'probability': await this['automatedProbability'] });
    }

    async actionSetWonRainbowman() {
        this.ensureOne();
        this.actionSetWon();

        const message = await this._getRainbowmanMessage();
        if (bool(message)) {
            const user = await (await this['teamId']).userId;
            return {
                'effect': {
                    'fadeout': 'slow',
                    'message': message,
                    'imgurl': f('/web/image/%s/%s/image1024', user._name, await user.image1024 ? user.id : '/web/static/img/smile.svg'),
                    'type': 'rainbowMan',
                }
            }
        }
        return true;
    }

    async getRainbowmanMessage() {
        this.ensureOne();
        if (await (await this['stageId']).isWon) {
            return this._getRainbowmanMessage();
        }
        return false;
    }

    async _getRainbowmanMessage() {
        const [user, team, expectedRevenue] = await this('userId', 'teamId', 'expectedRevenue');
        if (!bool(user) || !bool(team)) {
            return false;
        }
        if (!expectedRevenue) {
            // Show rainbow man for the first won lead of a salesman, even if expected revenue is not set. It is not
            // very often that leads without revenues are marked won, so simply get count using ORM instead of query
            const today = _Date.today();
            const userWonLeadsCount = await this.searchCount([
                ['type', '=', 'opportunity'],
                ['userId', '=', user.id],
                ['probability', '=', 100],
                ['dateClosed', '>=', DateTime.fromJSDate(today).startOf('year')],
                ['dateClosed', '<', DateTime.fromJSDate(today).endOf('year')],
            ]);
            if (userWonLeadsCount == 1) {
                return this._t('Go, go, go! Congrats for your first deal.');
            }
            return false;
        }

        await this.flush();  // flush fields to make sure DB is up to date
        const query = `
            SELECT
                SUM(CASE WHEN "userId" = {userId} THEN 1 ELSE 0 END) as totalwon,
                MAX(CASE WHEN "dateClosed" >= CURRENT_DATE - INTERVAL '30 days' AND "userId" = {userId} THEN "expectedRevenue" ELSE 0 END) as maxuser30,
                MAX(CASE WHEN "dateClosed" >= CURRENT_DATE - INTERVAL '7 days' AND "userId" = {userId} THEN "expectedRevenue" ELSE 0 END) as maxuser7,
                MAX(CASE WHEN "dateClosed" >= CURRENT_DATE - INTERVAL '30 days' AND "teamId" = {teamId} THEN "expectedRevenue" ELSE 0 END) as maxteam30,
                MAX(CASE WHEN "dateClosed" >= CURRENT_DATE - INTERVAL '7 days' AND "teamId" = {teamId} THEN "expectedRevenue" ELSE 0 END) as maxteam7
            FROM "crmLead"
            WHERE
                type = 'opportunity'
            AND
                active = True
            AND
                probability = 100
            AND
                DATE_TRUNC('year', "dateClosed") = DATE_TRUNC('year', CURRENT_DATE)
            AND
                ("userId" = {userId} OR "teamId" = {teamId})
        `;
        const [queryResult] = await this.env.cr.execute(_f(query, { 'userId': user.id, 'teamId': team.id }));

        let message;
        if (queryResult['totalWon'] == 1) {
            message = await this._t('Go, go, go! Congrats for your first deal.');
        }
        else if (queryResult['maxteam30'] == expectedRevenue) {
            message = await this._t('Boom! Team record for the past 30 days.');
        }
        else if (queryResult['maxteam7'] == expectedRevenue) {
            message = await this._t('Yeah! Deal of the last 7 days for the team.');
        }
        else if (queryResult['maxuser30'] == expectedRevenue) {
            message = await this._t('You just beat your personal record for the past 30 days.');
        }
        else if (queryResult['maxuser7'] == expectedRevenue) {
            message = await this._t('You just beat your personal record for the past 7 days.');
        }
        return message;
    }

    /**
     * Open meeting's calendar view to schedule meeting on current opportunity.

            :param smartCalendar: boolean, to set to False if the view should not try to choose relevant
              mode and initial date for calendar view, see ``_getOpportunityMeetingViewParameters``
            :return dict: dictionary value for created Meeting view
     */
    async actionScheduleMeeting(smartCalendar: boolean = true) {
        this.ensureOne();
        const action = this.env.items("ir.actions.actions")._forXmlid("calendar.actionCalendarEvent");
        const partnerIds = (await (await this.env.user()).partnerId).ids;
        const [partner, type, team, label] = await this('partnerId', 'type', 'teamId', 'label');
        if (partner.ok) {
            partnerIds.push(partner.id);
        }
        const currentOpportunityId = type == 'opportunity' ? this.id : false;
        action['context'] = {
            'searchDefault_opportunityId': currentOpportunityId,
            'default_opportunityId': currentOpportunityId,
            'default_partnerId': partner.id,
            'default_partnerIds': partnerIds,
            'default_teamId': team.id,
            'default_label': label,
        }

        // 'Smart' calendar view : get the most relevant time period to display to the user.
        if (bool(currentOpportunityId) && smartCalendar) {
            const [mode, initialDate] = await this._getOpportunityMeetingViewParameters();
            update(action['context'], { 'default_mode': mode, 'initialDate': initialDate });
        }
        return action;
    }

    /**
     * Return the most relevant parameters for calendar view when viewing meetings linked to an opportunity.
            If there are any meetings that are not finished yet, only consider those meetings,
            since the user would prefer no to see past meetings. Otherwise, consider all meetings.
            Allday events datetimes are used without taking tz into account.
            -If there is no event, return week mode and false (The calendar will target 'now' by default)
            -If there is only one, return week mode and date of the start of the event.
            -If there are several events entirely on the same week, return week mode and start of first event.
            -Else, return month mode and the date of the start of first event as initial date. (If they are
            on the same month, this will display that month and therefore show all of them, which is expected)

            :return tuple(mode, initialDate)
                - mode: selected mode of the calendar view, 'week' or 'month'
                - initialDate: date of the start of the first relevant meeting. The calendar will target that date.
     */
    async _getOpportunityMeetingViewParameters() {
        this.ensureOne();
        const meetingResults = await this.env.items("calendar.event").searchRead([['opportunityId', '=', this.id]], ['start', 'stop', 'allday']);
        if (!bool(meetingResults)) {
            return ["week", false];
        }

        let userTz = await (await this.env.user()).tz || this.env.context['tz'];
        userTz = allTimezones.includes(userTz) ? userTz : 'UTC';

        // meetingDts will contain one tuple of datetimes per meeting : (Start, Stop)
        // meetingsDts and nowDt are as per user time zone.
        const meetingDts = [];
        const nowDt = dateWithoutTz(dateSetTz(new Date(), userTz));

        // When creating an allday meeting, whatever the TZ, it will be stored the same e.g. 00.00.00->23.59.59 in utc or
        // 08.00.00->18.00.00. Therefore we must not put it back in the user tz but take it raw.
        for (const meeting of meetingResults) {
            if (meeting['allday']) {
                meetingDts.push([meeting['start'], meeting['stop']]);
            }
            else {
                meetingDts.push([
                    dateWithoutTz(dateSetTz(meeting['start'], userTz)),
                    dateWithoutTz(dateSetTz(meeting['stop'], userTz))
                ]);
            }
        }
        // If there are meetings that are still ongoing or to come, only take those.
        const unfinishedMeetingDts = meetingDts.filter(meetingDt => meetingDt[1] >= nowDt);
        const relevantMeetingDts = unfinishedMeetingDts.length ? unfinishedMeetingDts : meetingDts;
        const relevantMeetingCount = relevantMeetingDts.length;

        if (relevantMeetingCount == 1) {
            return ["week", _Date.today(relevantMeetingDts[0][0])];
        }
        else {
            // Range of meetings
            const earliestStartDt = dateMin(relevantMeetingDts.map(relevantMeetingDt => relevantMeetingDt[0]));
            const latestStopDt = dateMax(relevantMeetingDts.map(relevantMeetingDt => relevantMeetingDt[1]));

            // The week start day depends on language. We fetch the weekStart of user's language. 1 is monday.
            const langWeekStart = await this.env.items("res.lang").searchRead([['code', '=', await (await this.env.user()).lang]], ['weekStart']);
            // We substract one to make weekStartIndex range 0-6 instead of 1-7
            const weekStartIndex = parseInt(langWeekStart[0].get('weekStart', '1')) - 1;

            // We compute the weekday of earliestStartDt according to weekStartIndex. earliestStartDtIndex will be 0 if we are on the
            // first day of the week and 6 on the last. weekday() returns 0 for monday and 6 for sunday. For instance, Tuesday in UK is the
            // third day of the week, so earliestStartDtIndex is 2, and remainingDaysInWeek includes tuesday, so it will be 5.
            // The first term 7 is there to avoid negative left side on the modulo, improving readability.
            const earliestStartDtWeekday = (7 + earliestStartDt.getDay() - weekStartIndex) % 7;
            const remainingDaysInWeek = 7 - earliestStartDtWeekday;

            // We compute the start of the week following the one containing the start of the first meeting.
            const nextWeekStartDate = addDate(_Date.today(earliestStartDt), { days: remainingDaysInWeek });

            // LatestStopDt must be before the start of following week. Limit is therefore set at midnight of first day, included.
            const meetingsInSameWeek = latestStopDt <= new Date(nextWeekStartDate.getFullYear(), nextWeekStartDate.getMonth(), nextWeekStartDate.getDate(), 0, 0, 0, 0);
            if (meetingsInSameWeek) {
                return ["week", _Date.today(earliestStartDt)];
            }
            else {
                return ["month", _Date.today(earliestStartDt)];
            }
        }
    }

    async actionRescheduleMeeting() {
        this.ensureOne();
        const action = await this.actionScheduleMeeting(false);
        const nextActivity = (await (await this['activityIds']).filtered(async (activity) => (await activity.userId).eq(await this.env.user()))).slice(0, 1);
        const calendarEvent = await nextActivity.calendarEventId;
        if (bool(calendarEvent)) {
            action['context']['initialDate'] = await calendarEvent.start;
        }
        return action;
    }

    /**
     * Open kanban view to display duplicate leads or opportunity.
            :return dict: dictionary value for created kanban view
     * @returns 
     */
    async actionShowPotentialDuplicates() {
        this.ensureOne();
        const action = await this.env.items("ir.actions.actions")._forXmlid("crm.crmLeadOpportunities");
        action['domain'] = [['id', 'in', (await this['duplicateLeadIds']).ids]];
        action['context'] = {
            'activeTest': false,
            'create': false
        }
        return action;
    }

    async actionSnooze() {
        this.ensureOne();
        const today = _Date.today();
        const myNextActivity = (await (await this['activityIds']).filtered(async (activity) => (await activity.userId).eq(await this.env.user()))).slice(0, 1);
        if (bool(myNextActivity)) {
            let dateDeadline;
            if (await myNextActivity.dateDeadline < today) {
                dateDeadline = addDate(today, { days: 7 });
            }
            else {
                dateDeadline = addDate(await myNextActivity.dateDeadline, { days: 7 });
            }
            await myNextActivity.write({
                'dateDeadline': dateDeadline
            });
        }
        return true;
    }

    // ------------------------------------------------------------
    // VIEWS
    // ------------------------------------------------------------

    async redirectLeadOpportunityView() {
        this.ensureOne();
        return {
            'label': await this._t('Lead or Opportunity'),
            'viewMode': 'form',
            'resModel': 'crm.lead',
            'domain': [['type', '=', await this['type']]],
            'resId': this.id,
            'viewId': false,
            'type': 'ir.actions.actwindow',
            'context': { 'default_type': await this['type'] }
        }
    }

    /**
     * This method returns the action helpers for the leads. If help is already provided
            on the action, the same is returned. Otherwise, we build the help message which
            contains the alias responsible for creating the lead (if available) and return it.
     * @param help 
     * @returns 
     */
    @api.model()
    async getEmptyListHelp(help) {
        if (!isHtmlEmpty(help)) {
            return help;
        }

        let [helpTitle, subTitle] = ['', ''];
        if (this._context['default_type'] === 'lead') {
            helpTitle = await this._t('Create a new lead');
        }
        else {
            helpTitle = await this._t('Create an opportunity to start playing with your pipeline.');
        }
        const aliasRecord = await this.env.items('mail.alias').search([
            ['aliasName', '!=', false],
            ['aliasName', '!=', ''],
            ['aliasModelId.model', '=', 'crm.lead'],
            ['aliasParentModelId.model', '=', 'crm.team'],
            ['aliasForceThreadId', '=', false]
        ], { limit: 1 });
        if (aliasRecord && await aliasRecord.aliasDomain && await aliasRecord.aliasName) {
            const email = f('%s@%s', await aliasRecord.aliasName, await aliasRecord.aliasDomain);
            const emailLink = f("<b><a href='mailto:%s'>%s</a></b>", email, email);
            subTitle = await this._t('Use the top left <i>Create</i> button, or send an email to %s to test the email gateway.', emailLink);
        }
        return f('<p class="o-view-nocontent-smiling-face">%s</p><p class="oe-view-nocontent-alias">%s</p>', helpTitle, subTitle);
    }

    // ------------------------------------------------------------
    // BUSINESS
    // ------------------------------------------------------------

    async logMeeting(meetingSubject, meetingDate, duration) {
        if (!duration) {
            duration = await this._t('unknown');
        }
        else {
            duration = String(duration);
        }
        const meetDate = _Datetime.toDatetime(meetingDate) as Date;
        const meetingUsertime = _Datetime.toString(await _Datetime.contextTimestamp(this, meetDate));
        const htmlTime = f("<time datetime='%s+00:00'>%s</time>", meetingDate, meetingUsertime);
        const message = await this._t("Meeting scheduled at '%s'<br> Subject: %s <br> Duration: %s hours", htmlTime, meetingSubject, duration);
        return (this as any).messagePost({ body: message });
    }

    // ------------------------------------------------------------
    // MERGE AND CONVERT LEADS / OPPORTUNITIES
    // ------------------------------------------------------------

    /**
     * Prepare lead/opp data into a dictionary for merging. Different types
            of fields are processed in different ways:
                - text: all the values are concatenated
                - m2m and o2m: those fields aren't processed
                - m2o: the first not null value prevails (the other are dropped)
                - any other type of field: same as m2o
 
            :param fields: list of fields to process
            :return dict data: contains the merged values of the new opportunity
     * @param fnames 
     * @returns 
     */
    async _mergeData(fnames?: any) {
        if (fnames == null) {
            fnames = await this._mergeGetFields();
        }
        const fcallables = await this._mergeGetFieldsSpecific();

        // helpers
        async function _getFirstNotNull(attr, opportunities) {
            let value = false;
            for (const opp of opportunities) {
                const oppAttr = await opp[attr]
                if (bool(oppAttr)) {
                    value = isInstance(oppAttr, models.BaseModel) ? oppAttr.id : oppAttr;
                    break;
                }
            }
            return value;
        }

        // process the field's values
        const data = {}
        for (const fieldName of fnames) {
            const field = this._fields[fieldName];
            if (field == null) {
                continue;
            }

            const fcallable = fcallables[fieldName];
            if (fcallable && isCallable(fcallable)) {
                data[fieldName] = await fcallable(fieldName, this);
            }
            else if (!fcallable && ['many2many', 'one2many'].includes(field.type)) {
                continue;
            }
            else {
                data[fieldName] = await _getFirstNotNull(fieldName, this);  // take the first not null
            }
        }
        return data;
    }

    /**
     * Generate the message body with the changed values
 
        :param fields : list of fields to track
        :returns a list of message bodies for the corresponding leads
     * @returns 
     */
    async _mergeNotifyGetMergedFieldsMessage() {
        const bodies = [];
        for (const lead of this) {
            const [type, label] = await lead('type', 'label');
            const title = f("%s : %s\n", type === 'opportunity' ? await this._t('Merged opportunity') : await this._t('Merged lead'), name);
            const body = [title];
            const _fields = await (await this.env.items('ir.model.fields').sudo()).search([
                ['label', 'in', await this._mergeGetFields()],
                ['modelId.model', '=', lead._name],
            ])
            for (const field of _fields) {
                const ttype = await field.ttype;
                let value = lead[await field.label] ?? false;
                if (ttype === 'selection') {
                    const selections = (await lead.fieldsGet())[await field.label]['selection'];
                    value = next(selections.filter(v => v[0] == value).map(v => v[1]), value);
                }
                else if (ttype === 'many2one') {
                    if (bool(value)) {
                        value = await (await value.sudo()).displayName;
                    }
                }
                else if (ttype === 'many2many') {
                    if (bool(value)) {
                        value = (await (await value.sudo()).map(val => val.displayName)).join(',');
                    }
                }
                body.push(f("%s: %s", await field.fieldDescription, value || ''));
            }
            bodies.push(body.concat(['<br/>']).join('<br/>'));
        }
        return bodies;
    }

    /**
     * Post a message gathering merged leads/opps informations. It explains
        which fields has been merged and their new value. `self` is the resulting
        merge crm.lead record.
 
        :param opportunities: see ``_mergeDependences``
     * @param opportunities 
     * @returns 
     */
    async _mergeNotify(opportunities) {
        // TODO JEM: mail template should be used instead of fix body, subject text
        this.ensureOne();
        const mergeMessage = await this['type'] == 'lead' ? await this._t('Merged leads') : await this._t('Merged opportunities');
        const subject = mergeMessage + ": " + (await opportunities.mapped('label')).join(', ');
        // message bodies
        const messageBodies = await opportunities._mergeNotifyGetMergedFieldsMessage();
        const messageBody = messageBodies.join('\n\n');
        return (this as any).messagePost({ body: messageBody, subject: subject });
    }

    /**
     * Merge opportunities in one. Different cases of merge:
                - merge leads together = 1 new lead
                - merge at least 1 opp with anything else (lead or opp) = 1 new opp
            The resulting lead/opportunity will be the most important one (based on its confidence level)
            updated with values from other opportunities to merge.
 
        :param userId : the id of the saleperson. If not given, will be determined by `_mergeData`.
        :param team : the id of the Sales Team. If not given, will be determined by `_mergeData`.
 
        :return crm.lead record resulting of th merge
     * @param userId 
     * @param teamId 
     * @param autoUnlink 
     * @returns 
     */
    async mergeOpportunity({ userId = false, teamId = false, autoUnlink = true } = {}) {
        return this._mergeOpportunity({ userId, teamId, autoUnlink });
    }

    /**
     * Private merging method. This one allows to relax rules on record set
        length allowing to merge more than 5 opportunities at once if requested.
        This should not be called by action buttons.
 
        See ``mergeOpportunity`` for more details.
     * @param userId 
     * @param teamId 
     * @param autoUnlink 
     * @param maxLength 
     * @returns 
     */
    async _mergeOpportunity({ userId = false, teamId = false, autoUnlink = true, maxLength = 5 } = {}) {
        if (len(this.ids) <= 1) {
            throw new UserError(await this._t('Please select more than one element (lead or opportunity) from the list view.'));
        }

        if (maxLength && len(this.ids) > maxLength && ! await this.env.isSuperuser()) {
            throw new UserError(_f(await this._t("To prevent data loss, Leads and Opportunities can only be merged by groups of {maxLength}."), { maxLength: maxLength }));
        }

        const opportunities = await this._sortByConfidenceLevel(true);

        // get SORTED recordset of head and tail, and complete list
        const opportunitiesHead = opportunities[0];
        const opportunitiesTail = opportunities.slice(1);

        // merge all the sorted opportunity. This means the value of
        // the first (head opp) will be a priority.
        const mergedData = await opportunities._mergeData(await this._mergeGetFields());

        // force value for saleperson and Sales Team
        if (bool(userId)) {
            mergedData['userId'] = userId;
        }
        if (bool(teamId)) {
            mergedData['teamId'] = teamId;
        }
        // log merge message
        await opportunitiesHead._mergeNotify(opportunitiesTail);
        // merge other data (mail.message, attachments, ...) from tail into head
        await opportunitiesHead._mergeDependences(opportunitiesTail);

        // check if the stage is in the stages of the Sales Team. If not, assign the stage with the lowest sequence
        if (mergedData['teamId']) {
            const teamStageIds = await this.env.items('crm.stage').search(['|', ['teamId', '=', mergedData['teamId']], ['teamId', '=', false]], { order: 'sequence, id' });
            if (!teamStageIds.ids.includes(mergedData['stageId'])) {
                mergedData['stageId'] = bool(teamStageIds) ? teamStageIds[0].id : false;
            }
        }
        // write merged data into first opportunity
        await opportunitiesHead.write(mergedData);

        // delete tail opportunities
        // we use the SUPERUSER to avoid access rights issues because as the user had the rights to see the records it should be safe to do so
        if (autoUnlink) {
            await (await opportunitiesTail.sudo()).unlink();
        }
        return opportunitiesHead;
    }

    async _mergeGetFieldsSpecific() {
        return {
            'description': async (fname, leads) => (await leads.mapped('description')).filter(desc => !isHtmlEmpty(desc)).join('<br/><br/>'),
            'type': async (fname, leads) => leads.some(async (lead) => await lead.type == 'opportunity') ? 'opportunity' : 'lead',
            'priority': async (fname, leads) => leads ? Math.max(...(await leads.mapped('priority'))) : false,
        }
    }

    async _mergeGetFields() {
        return CRM_LEAD_FIELDS_TO_MERGE.concat(Object.keys(await this._mergeGetFieldsSpecific()));
    }

    /**
     * Merge dependences (messages, attachments,activities, calendar events,
        ...). These dependences will be transfered to `self` considered as the
        master lead.
 
        :param opportunities : recordset of opportunities to transfer. Does not
          include `self` which is the target crm.lead being the result of the
          merge;
     * @param opportunities 
     */
    async _mergeDependences(opportunities) {
        this.ensureOne();
        await this._mergeDependencesHistory(opportunities);
        await this._mergeDependencesAttachments(opportunities);
        await this._mergeDependencesCalendarEvents(opportunities);
    }

    /**
     * Move history from the given opportunities to the current one. `self`
        is the crm.lead record destination for message of `opportunities`.
 
        This method moves
          * messages
          * activities
 
        :param opportunities: see ``_mergeDependences``
     * @param opportunities 
     * @returns 
     */
    async _mergeDependencesHistory(opportunities) {
        this.ensureOne();
        for (const opportunity of opportunities) {
            for (const message of await opportunity.messageIds) {
                let subject;
                if (await message.subject) {
                    subject = _f(await this._t("From {sourceName} : {sourceSubject}"), { sourceName: await opportunity.label, sourceSubject: await message.subject });
                }
                else {
                    subject = _f(await this._t("From {sourceName}"), { sourceName: await opportunity.label });
                }
                await message.write({
                    'resId': this.id,
                    'subject': subject,
                });
            }
        }

        await (await opportunities.activityIds).write({
            'resId': this.id,
        })

        return true;
    }

    /**
     * Move attachments of given opportunities to the current one `self`, and rename
            the attachments having same name than native ones.
 
        :param opportunities: see ``_mergeDependences``
     * @param opportunities 
     * @returns 
     */
    async _mergeDependencesAttachments(opportunities) {
        this.ensureOne();

        const allAttachments = await this.env.items('ir.attachment').search([
            ['resModel', '=', this._name],
            ['resId', 'in', opportunities.ids]
        ]);

        for (const opportunity of opportunities) {
            const attachments = await allAttachments.filtered(async (attach) => await attach.resId == opportunity.id);
            for (const attachment of attachments) {
                await attachment.write({
                    'resId': this.id,
                    'label': _f(await this._t("{attachName} (from {leadName})"), {
                        attachName: await attachment.label,
                        leadName: (await opportunity.label).slice(0, 20)
                    })
                })
            }
        }
        return true;
    }

    /**
     * Move calender.event from the given opportunities to the current one. `self` is the
            crm.lead record destination for event of `opportunities`.
        :param opportunities: see ``mergeDependences``
     * @param opportunities 
     * @returns 
     */
    async _mergeDependencesCalendarEvents(opportunities) {
        this.ensureOne();
        const meetings = await this.env.items('calendar.event').search([['opportunityId', 'in', opportunities.ids]]);
        return meetings.write({
            'resId': this.id,
            'opportunityId': this.id,
        });
    }

    // CONVERT
    // ----------------------------------------------------------------------

    /**
     * Extract the data from a lead to create the opportunity
            :param customer : res.partner record
            :param teamId : identifier of the Sales Team to determine the stage
     * @param customer 
     * @param teamId 
     * @returns 
     */
    async _convertOpportunityData(customer, teamId: any = false) {
        const newTeamId = bool(teamId) ? teamId : (await this['teamId']).id;
        const updValues = {
            'type': 'opportunity',
            'dateOpen': _Datetime.now(),
            'dateConversion': _Datetime.now(),
        }
        if (!customer.eq(await this['partnerId'])) {
            updValues['partnerId'] = bool(customer) ? customer.id : false;
        }
        if (!(await this['stageId']).ok) {
            const stage = await this._stageFind({ teamId: newTeamId });
            updValues['stageId'] = stage.id;
        }
        return updValues;
    }

    async convertOpportunity(partnerId, userIds: any = false, teamId: any = false) {
        let customer = false;
        if (bool(partnerId)) {
            customer = this.env.items('res.partner').browse(partnerId);
        }
        for (const lead of this) {
            if (!await lead.active || await lead.probability == 100) {
                continue;
            }
            const vals = await lead._convertOpportunityData(customer, teamId);
            await lead.write(vals);
        }
        if (bool(userIds) || bool(teamId)) {
            await this._handleSalesmenAssignment(userIds, teamId);
        }
        return true;
    }

    /**
     * Update customer (partnerId) of leads. Purpose is to set the same
        partner on most leads; either through a newly created partner either
        through a given partnerId.
 
        :param int forcePartnerId: if set, update all leads to that customer;
        :param createMissing: for leads without customer, create a new one
          based on lead information;
     * @param forcePartnerId 
     * @param createMissing 
     */
    async _handlePartnerAssignment(forcePartnerId: any = false, createMissing: any = true) {
        for (const lead of this) {
            if (bool(forcePartnerId)) {
                await lead.set('partnerId', forcePartnerId);
            }
            if (!(await lead.partnerId).ok && createMissing) {
                const partner = await lead._createCustomer();
                await lead.set('partnerId', partner.id);
            }
        }
    }

    /**
     * Assign salesmen and salesteam to a batch of leads.  If there are more
        leads than salesmen, these salesmen will be assigned in round-robin. E.g.
        4 salesmen (S1, S2, S3, S4) for 6 leads (L1, L2, ... L6) will assigned as
        following: L1 - S1, L2 - S2, L3 - S3, L4 - S4, L5 - S1, L6 - S2.
 
        :param list userIds: salesmen to assign
        :param int teamId: salesteam to assign
     * @param userIds 
     * @param teamId 
     */
    async _handleSalesmenAssignment(userIds: any = false, teamId: any = false) {
        const updateVals = bool(teamId) ? { 'teamId': teamId } : {}
        if (!bool(userIds) && bool(teamId)) {
            await this.write(updateVals);
        }
        else {
            const leadIds = this.ids;
            const steps = len(userIds);
            // pass 1 : leadIds[0:6:3] = [L1,L4]
            // pass 2 : leadIds[1:6:3] = [L2,L5]
            // pass 3 : leadIds[2:6:3] = [L3,L6]
            // ...
            for (const idx of range(0, steps)) {
                const subsetIds = islice(leadIds, idx, len(leadIds), steps);
                updateVals['userId'] = userIds[idx];
                await this.env.items('crm.lead').browse(subsetIds).write(updateVals);
            }
        }
    }

    // ------------------------------------------------------------
    // MERGE / CONVERT TOOLS
    // ---------------------------------------------------------

    // CLASSIFICATION TOOLS
    // --------------------------------------------------

    /**
     * Search for leads that seem duplicated based on partner / email.
 
        :param partner : optional customer when searching duplicated
        :param email: email (possibly formatted) to search
        :param boolean includeLost: if True, search includes archived opportunities
          (still only active leads are considered). If False, search for active
          and not won leads and opportunities;
     * @param partner 
     * @param email 
     * @param includeLost 
     * @returns 
     */
    async _getLeadDuplicates(partner?: any, email?: any, includeLost: boolean = false) {
        if (!email && !bool(partner)) {
            return this.env.items('crm.lead');
        }
        let domain = [];
        for (const normalizedEmail of emailSplit(email).map(email => emailNormalize(email))) {
            domain.push(['emailNormalized', '=', normalizedEmail]);
        }
        if (bool(partner)) {
            domain.push(['partnerId', '=', partner.id]);
        }
        if (!domain.length) {
            return this.env.items('crm.lead');
        }
        domain = _.fill(Array(len(domain) - 1), '|').concat(domain);
        if (includeLost) {
            extend(domain, ['|', ['type', '=', 'opportunity'], ['active', '=', true]]);
        }
        else {
            extend(domain, ['&', ['active', '=', true], '|', ['stageId', '=', false], ['stageId.isWon', '=', false]]);
        }
        return (await this.withContext({ activeTest: false })).search(domain);
    }

    /**
     * Sorting the leads/opps according to the confidence level to it
        being won. It is sorted following this incremental heuristics :
 
          * "not lost" first (inactive leads are lost); normally all leads
            should be active but in case lost one, they are always last.
            Inactive opportunities are considered as valid;
          * opportunity is more reliable than a lead which is a pre-stage
            used mainly for first classification;
          * stage sequence: the higher the better as it indicates we are moving
            towards won stage;
          * probability: the higher the better as it is more likely to be won;
          * ID: the higher the better when all other parameters are equal. We
            consider newer leads to be more reliable;
     * @param reverse 
     * @returns 
     */
    async _sortByConfidenceLevel(reverse: boolean) {
        async function oppsKey(opportunity) {
            return [await opportunity.type === 'opportunity' || await opportunity.active,
            await opportunity.type == 'opportunity',
            await (await opportunity.stageId).sequence,
            await opportunity.probability,
            - opportunity._origin.id];
        }

        return this.sorted(async (item) => oppsKey(item), reverse);
    }

    // CUSTOMER TOOLS
    // --------------------------------------------------

    /**
     * Try to find a matching partner with available information on the
        lead, using notably customer's name, email, ...
 
        :param emailOnly: Only find a matching based on the email. To use
            for automatic process where ilike based on name can be too dangerous
        :return: partner browse record
     * @param emailOnly 
     * @returns 
     */
    async _findMatchingPartner(emailOnly: boolean = false) {
        this.ensureOne();
        let [partner, emailFrom] = await this('partnerId', 'emailFrom');

        if (!bool(partner) && emailFrom) {
            partner = await this.env.items('res.partner').search([['email', '=', emailFrom]], { limit: 1 });
        }

        if (!bool(partner) && !emailOnly) {
            // search through the existing partners based on the lead's partner or contact name
            // to be aligned with _createCustomer, search on lead's name as last possibility
            for (const customerPotentialName of (await Promise.all(['partnerName', 'contactName', 'label'].map(async (fieldName) => await this[fieldName]))).filter(value => bool(value))) {
                partner = this.env.items('res.partner').search([['label', 'ilike', '%' + customerPotentialName + '%']], { limit: 1 });
                if (bool(partner)) {
                    break;
                }
            }
        }
        return partner;
    }

    /**
     * Create a partner from lead data and link it to the lead.
 
        :return: newly-created partner browse record
     */
    async _createCustomer() {
        let partner = this.env.items('res.partner');
        let [partnerName, contactName, emailFrom] = await this('partnerName', 'contactName', 'emailFrom');
        if (!contactName) {
            contactName = emailFrom ? (await partner._parsePartnerName(emailFrom))[0] : false;
        }
        let partnerCompany;
        if (partnerName) {
            partnerCompany = await partner.create(await this._prepareCustomerValues(partnerName, true));
        }
        else if ((await this['partnerId']).ok) {
            partnerCompany = await this['partnerId'];
        }
        else {
            partnerCompany = null;
        }

        if (contactName) {
            return partner.create(await this._prepareCustomerValues(contactName, false, bool(partnerCompany) ? partnerCompany.id : false));
        }
        if (bool(partnerCompany)) {
            return partnerCompany;
        }
        return partner.create(await this._prepareCustomerValues(await this['label'], false));
    }

    /**
     * Extract data from lead to create a partner.
 
        :param name : furtur name of the partner
        :param isCompany : True if the partner is a company
        :param parentId : id of the parent partner (False if no parent)
 
        :return: dictionary of values to give at resPartner.create()
     * @param partnerName 
     * @param isCompany 
     * @param parentId 
     * @returns 
     */
    async _prepareCustomerValues(partnerName, isCompany: boolean = false, parentId: any = false) {
        const [emailFrom, user, description, team, phone, mobile, title, position, street, street2, zip, city, country, state, website, lang] = await this('emailFrom', 'userId', 'description', 'teamId', 'phone', 'mobile', 'title', 'position', 'street', 'street2', 'zip', 'city', 'countryId', 'stateId', 'website', 'langId');
        const emailParts = emailSplit(emailFrom);
        const res = {
            'label': partnerName,
            'userId': this.env.context['default_userId'] || user.id,
            'comment': description,
            'teamId': team.id,
            'parentId': parentId,
            'phone': phone,
            'mobile': mobile,
            'email': len(emailParts) ? emailParts[0] : false,
            'title': title.id,
            'position': position,
            'street': street,
            'street2': street2,
            'zip': zip,
            'city': city,
            'countryId': country.id,
            'stateId': state.id,
            'website': website,
            'isCompany': isCompany,
            'type': 'contact'
        }
        if (lang.ok) {
            res['lang'] = await lang.code;
        }
        return res;
    }

    // ------------------------------------------------------------
    // MAILING
    // ------------------------------------------------------------

    async _creationSubtype() {
        return this.env.ref('crm.mtLeadCreate');
    }

    async _trackSubtype(initValues) {
        this.ensureOne();
        const [probability, stage, active] = await this('probability', 'stageId', 'active');
        if ('stageId' in initValues && probability == 100 && stage.ok) {
            return this.env.ref('crm.mtLeadWon');
        }
        else if ('lostReason' in initValues && await this['lostReason']) {
            return this.env.ref('crm.mtLeadLost');
        }
        else if ('stageId' in initValues) {
            return this.env.ref('crm.mtLeadStage');
        }
        else if ('active' in initValues && active) {
            return this.env.ref('crm.mtLeadRestored');
        }
        else if ('active' in initValues && !active) {
            return this.env.ref('crm.mtLeadLost');
        }
        return _super(Lead, this)._trackSubtype(initValues);
    }

    /**
     * Handle salesman recipients that can convert leads into opportunities
        and set opportunities as won / lost.
     * @param msgVals 
     */
    async _notifyGetGroups(msgVals?: any) {
        const groups = await _super(Lead, this)._notifyGetGroups(msgVals);
        const localMsgVals = Object.assign({}, msgVals);

        this.ensureOne();
        let salesmanActions;
        if (await this['type'] === 'lead') {
            const convertAction = await (this as any)._notifyGetActionLink('controller', { controller: '/lead/convert', ...localMsgVals });
            salesmanActions = [{ 'url': convertAction, 'title': _('Convert to opportunity') }];
        }
        else {
            const wonAction = await (this as any)._notifyGetActionLink('controller', { controller: '/lead/caseMarkWon', ...localMsgVals });
            const lostAction = await (this as any)._notifyGetActionLink('controller', { controller: '/lead/caseMarkLost', ...localMsgVals });
            salesmanActions = [
                { 'url': wonAction, 'title': await this._t('Won') },
                { 'url': lostAction, 'title': await this._t('Lost') }]
        }

        const team = await this['teamId'];
        if (team.ok) {
            const customParams = Object.assign({}, localMsgVals, { resId: team.id, model: team._name });
            salesmanActions.push({
                'url': await (this as any)._notifyGetActionLink('view', customParams),
                'title': await this._t('Sales Team Settings')
            });
        }

        const salesmanGroupId = (await this.env.ref('sales_team.groupSaleSalesman')).id;
        const newGroup = [
            'groupSaleSalesman',
            (pdata) => pdata['type'] === 'user' && pdata['groups'].includes(salesmanGroupId),
            { 'actions': salesmanActions }
        ];

        return [newGroup].concat(groups);
    }

    /**
     * Override to set alias of lead and opportunities to their sales team if any.
     * @param defaultValue 
     * @param records 
     * @param company 
     * @param docNames 
     */
    async _notifyGetReplyTo(defaultValue, records?: any, company?: any, docNames?: any) {
        const aliases = await (await (await this.mapped('teamId')).sudo())._notifyGetReplyTo(defaultValue, null, company, null);
        const res = {}
        for (const lead of this) {
            res[lead.id] = aliases.get((await lead.teamId).id);
        }
        const leftover = await this.filtered(async (rec) => !bool(await rec.teamId));
        if (bool(leftover)) {
            update(res, await _super(Lead, leftover)._notifyGetReplyTo(defaultValue, null, company, docNames));
        }
        return res;
    }

    async _messageGetDefaultRecipients() {
        const res = {}
        for (const r of this) {
            res[r.id] = {
                'partnerIds': [],
                'emailTo': emailNormalizeAll(await r.emailFrom).join(',') || await r.emailFrom,
                'emailCc': false,
            }
        }
        return res;
    }

    async _messageGetSuggestedRecipients() {
        const recipients = await _super(Lead, this)._messageGetSuggestedRecipients();
        try {
            for (const lead of this) {
                const [partner, emailFrom] = await lead('partnerId', 'emailFrom')
                if (partner.ok) {
                    await lead._messageAddSuggestedRecipient(recipients, { partner: partner, reason: await this._t('Customer') });
                }
                else if (emailFrom) {
                    await lead._messageAddSuggestedRecipient(recipients, { email: emailFrom, reason: await this._t('Customer Email') });
                }
            }
        } catch (e) {
            if (!isInstance(e, AccessError)) {  // no read access rights -> just ignore suggested recipients because this imply modifying followers
                throw e;
            }
        }
        return recipients;
    }

    /**
     * Overrides mailThread messageNew that is called by the mailgateway
            through messageProcess.
            This override updates the document according to the email.
     * @param msgDict 
     * @param customValues 
     */
    @api.model()
    async messageNew(msgDict, customValues?: any) {
        // remove default author when going through the mail gateway. Indeed we
        // do not want to explicitly set an user as responsible. We prefer that
        // assignment is done automatically (scoring) or manually. Otherwise it
        // would always be either root (gateway user) either alias owner (through
        // aliasUserId). It also allows to exclude portal / public users.
        const self = await this.withContext({ default_userId: false });

        if (customValues == null) {
            customValues = {};
        }
        const defaults = {
            'label': msgDict.get('subject') || await this._t("No Subject"),
            'emailFrom': msgDict.get('from'),
            'partnerId': msgDict.get('authorId', false),
        }
        if (msgDict.get('priority') in Object.fromEntries(AVAILABLE_PRIORITIES)) {
            defaults['priority'] = msgDict.get('priority');
        }
        update(defaults, customValues);

        return _super(Lead, self).messageNew(msgDict, defaults);
    }

    async _messagePostAfterHook(message, msgVals) {
        const [emailFrom, emailNormalized] = await this('emailFrom', 'emailNormalized');
        if (emailFrom && !(await this['partnerId']).ok) {
            // we consider that posting a message with a specified recipient (not a follower, a specific one)
            // on a document without customer means that it was created through the chatter using
            // suggested recipients. This heuristic allows to avoid ugly hacks in JS.
            const newPartner = await (await message.partnerIds).filtered(
                async (partner) => await partner.email === emailFrom || (emailNormalized && await partner.emailNormalized === emailNormalized)
            );
            if (newPartner.ok) {
                let emailDomain;
                if (await newPartner[0].emailNormalized) {
                    emailDomain = ['emailNormalized', '=', await newPartner[0].emailNormalized];
                }
                else {
                    emailDomain = ['emailFrom', '=', await newPartner[0].email];
                }
                await (await this.search([
                    ['partnerId', '=', false], emailDomain, ['stageId.fold', '=', false]
                ])).write({ 'partnerId': newPartner[0].id });
            }
        }
        return _super(Lead, this)._messagePostAfterHook(message, msgVals);
    }

    /**
     * Try to propose a better recipient when having only an email by populating
        it with the partnerName / contactName field of the lead e.g. if lead
        contactName is "Raoul" and email is "raoul@raoul.fr", suggest
        "Raoul" <raoul@raoul.fr> as recipient.
     * @param emails 
     * @param linkMail 
     * @returns 
     */
    async _messagePartnerInfoFromEmails(emails, linkMail?: boolean) {
        const result = await _super(Lead, this)._messagePartnerInfoFromEmails(emails, linkMail);
        for (const [email, partnerInfo] of _.zip([...emails], [...result])) {
            if (partnerInfo['partnerId'] || !email || !(await this['partnerName'] || await this['contactName'])) {
                continue;
            }
            // reformat email if no name information
            const nameEmails = emailSplitTuples(email);
            let nameFromEmail = nameEmails.length ? nameEmails[0][0] : false;
            if (nameFromEmail) {
                continue;  // already containing name + email
            }
            nameFromEmail = await this['partnerName'] || await this['contactName'];
            const emailsNormalized = emailNormalizeAll(email);
            const emailNormalized = emailsNormalized.length ? emailsNormalized[0] : false;
            if (email.toLowerCase() === (await this['emailFrom']).toLowerCase() || (emailNormalized && await this['emailNormalized'] === emailNormalized)) {
                partnerInfo['fullName'] = formataddr([
                    nameFromEmail,
                    emailsNormalized ? emailsNormalized.join(',') : email]);
                break;
            }
        }
        return result;
    }

    /**
     * Use mobile or phone fields to compute sanitized phone number
     * @returns 
     */
    _phoneGetNumberFields() {
        return ['mobile', 'phone'];
    }

    @api.model()
    async getImportTemplates() {
        return [{
            'label': await this._t('Import Template for Leads & Opportunities'),
            'template': '/crm/static/xls/crm_lead.xls'
        }];
    }

    // ------------------------------------------------------------
    // PLS
    // ------------------------------------------------------------
    // Predictive lead scoring is computing the lead probability, based on won and lost leads from the past
    // Each won/lost lead increments a frequency table, where we store, for each field/value couple, the number of
    // won and lost leads.
    //   E.g. : A won lead from Belgium will increase the won count of the frequency countryId='Belgium' by 1.
    // The frequencies are split by teamId, so each team has his own frequencies environment. (Team A doesn't impact B)
    // There are two main ways to build the frequency table:
    //   - Live Increment: At each Won/lost, we increment directly the frequencies based on the lead values.
    //       Done right BEFORE writing the lead as won or lost.
    //       We consider a lead that will be marked as won or lost.
    //       Used each time a lead is won or lost, to ensure frequency table is always up to date
    //   - One shot Rebuild: empty the frequency table and rebuild it from scratch, based on every already won/lost leads
    //       Done during cron process.
    //       We consider all the leads that have been already won or lost.
    //       Used in one shot, when modifying the criteria to take into account (fields or reference date)

    // ---------------------------------
    // PLS: Probability Computation
    // ---------------------------------
    /**
        In machine learning, naive Bayes classifiers (NBC) are a family of simple "probabilistic classifiers" based on
        applying Bayes theorem with strong (naive) independence assumptions between the variables taken into account.
        E.g: will TDE eat m&m's depending on his sleep status, the amount of work he has and the fullness of his stomach?
        As we use experience to compute the statistics, every day, we will register the variables state + the result.
        As the days pass, we will be able to determine, with more and more precision, if TDE will eat m&m's
        for a specific combination :
            - did sleep very well, a lot of work and stomach full > Will never happen !
            - didn't sleep at all, no work at all and empty stomach > for sure !
        Following Bayes' Theorem: the probability that an event occurs (to win) under certain conditions is proportional
        to the probability to win under each condition separately and the probability to win. We compute a 'Win score'
        -> P(Won | A∩B) ∝ P(A∩B | Won)*P(Won) OR S(Won | A∩B) = P(A∩B | Won)*P(Won)
        To compute a percentage of probability to win, we also compute the 'Lost score' that is proportional to the
        probability to lose under each condition separately and the probability to lose.
        -> Probability =  S(Won | A∩B) / ( S(Won | A∩B) + S(Lost | A∩B) )
        See https://www.youtube.com/watch?v=CPqOCI0ahss can help to get a quick and simple example.
        One issue about NBC is when a event occurence is never observed.
        E.g: if when TDE has an empty stomach, he always eat m&m's, than the "not eating m&m's when empty stomach' event
        will never be observed.
        This is called 'zero frequency' and that leads to division (or at least multiplication) by zero.
        To avoid this, we add 0.1 in each frequency. With few data, the computation is than not really realistic.
        The more we have records to analyse, the more the estimation will be precise.
        :return: probability in percent (and integer rounded) that the lead will be won at the current stage.
     * @param batchMode 
     * @returns 
    */
    async _plsGetNaiveBayesProbabilities(batchMode: boolean = false) {
        const leadProbabilities = {};
        if (!bool(this)) {
            return leadProbabilities;
        }
        // Get all leads values, no matter the teamId
        let domain = [];
        if (batchMode) {
            domain = [
                '&',
                ['active', '=', true], ['id', 'in', this.ids],
                '|',
                ['probability', '=', null],
                '&',
                ['probability', '<', 100], ['probability', '>', 0]
            ]
        }
        const leadsValuesDict = await this._plsGetLeadPlsValues(domain);

        if (!bool(leadsValuesDict)) {
            return leadProbabilities;
        }

        // Get unique couples to search in frequency table and won leads.
        let leadsFields: any = new Set();  // keep unique fields, as a lead can have multiple tagIds
        const wonLeads = new Set();
        const wonStageIds = (await this.env.items('crm.stage').search([['isWon', '=', true]])).ids;
        for (const [leadId, values] of leadsValuesDict) {
            for (const [field, value] of Object.entries(values['values'])) {
                if (field === 'stageId' && wonStageIds.includes(value)) {
                    wonLeads.add(leadId);
                }
                leadsFields.add(field);
            }
        }
        leadsFields = sorted(leadsFields);
        // get all variable related records from frequency table, no matter the teamId
        const frequencies = await this.env.items('crm.lead.scoring.frequency').search([['variable', 'in', leadsFields]], { order: "teamId asc, id" });

        // get all teamIds from frequencies
        const frequencyTeams = await frequencies.mapped('teamId');
        const frequencyTeamIds = await frequencyTeams.map(team => team.id);

        // 1. Compute each variable value count individually
        // regroup each variable to be able to compute their own probabilities
        // As all the variable does not enter into account (as we reject unset values in the process)
        // each value probability must be computed only with their own variable related total count
        // special case: for lead for which teamId is not in frequency table or lead with no teamId,
        // we consider all the records, independently from teamId (this is why we add a result[-1])
        const result = Dict.from<any>(frequencyTeamIds.map(teamId => [teamId, Object.fromEntries(leadsFields.map(field => [field, { wonTotal: 0, lostTotal: 0 }]))]));
        const lastIndex = result.length - 1;
        result[-1] = Object.fromEntries(leadsFields.map(field => [field, { wonTotal: 0, lostTotal: 0 }]));
        for (const frequency of frequencies) {
            const [field, value, wonCount, lostCount] = await frequency('variable', 'value', 'wonCount', 'lostCount');

            // To avoid that a tag take to much importance if his subset is too small,
            // we ignore the tag frequencies if we have less than 50 won or lost for this tag.
            if (field === 'tagId' && (wonCount + lostCount) < 50) {
                continue;
            }

            const team = await frequency.teamId;
            if (team.ok) {
                const teamResult = result[team.id][field];
                teamResult[value] = { 'won': wonCount, 'lost': lostCount }
                teamResult['wonTotal'] += wonCount;
                teamResult['lostTotal'] += lostCount;
            }

            const lastResult = result[lastIndex][field];
            if (!(value in lastResult)) {
                lastResult[value] = { 'won': 0, 'lost': 0 }
            }
            lastResult[value]['won'] += wonCount;
            lastResult[value]['lost'] += lostCount;
            lastResult['wonTotal'] += wonCount;
            lastResult['lostTotal'] += lostCount;
        }

        // Get all won, lost and total count for all records in frequencies per teamId
        for (const teamId of Object.keys(result)) {
            [result[teamId]['teamWon'],
            result[teamId]['teamLost'],
            result[teamId]['teamTotal']] = await this._plsGetWonLostTotalCount(result[teamId]);
        }
        let saveTeamId;
        let [pWon, pLost] = [1, 1];
        for (const [leadId, leadValues] of leadsValuesDict) {
            // if stageId is null, return 0 and bypass computation
            const leadFields = leadValues.get('values', []).map(value => value[0]);
            if (!leadFields.includes('stageId')) {
                leadProbabilities[leadId] = 0;
                continue;
            }
            // if lead stage is won, return 100
            else if (wonLeads.has(leadId)) {
                leadProbabilities[leadId] = 100;
                continue;
            }

            // teamId not in frequency Table -> convert to -1
            const leadTeamId = leadValues['teamId'] in result ? leadValues['teamId'] : -1;
            let teamWon, teamLost;
            if (leadTeamId != saveTeamId) {
                let saveTeamId = leadTeamId;
                teamWon = result[saveTeamId]['teamWon'];
                teamLost = result[saveTeamId]['teamLost'];
                const teamTotal = result[saveTeamId]['teamTotal'];
                // if one count = 0, we cannot compute lead probability
                if (!teamWon || !teamLost) {
                    continue;
                }
                pWon = teamWon / teamTotal;
                pLost = teamLost / teamTotal;
            }

            // 2. Compute won and lost score using each variable's individual probability
            let [sLeadWon, sLeadLost] = [pWon, pLost];
            for (let [field, value] of leadValues['values']) {
                const fieldResult = result.get(saveTeamId, {})[field];
                value = hasattr(value, 'origin') ? value.origin : value;
                const valueResult = fieldResult ? fieldResult[String(value)] : false;
                if (valueResult) {
                    const totalWon = field === 'stageId' ? teamWon : fieldResult['wonTotal'];
                    const totalLost = field === 'stageId' ? teamLost : fieldResult['lostTotal'];

                    // if one count = 0, we cannot compute lead probability
                    if (!totalWon || !totalLost) {
                        continue;
                    }
                    sLeadWon *= valueResult['won'] / totalWon;
                    sLeadLost *= valueResult['lost'] / totalLost;
                }
            }

            // 3. Compute Probability to win
            const probability = sLeadWon / (sLeadWon + sLeadLost);
            leadProbabilities[leadId] = Math.min(Math.max(floatRound(100 * probability, { precisionRounding: 2 }), 0.01), 99.99);
        }
        return leadProbabilities;
    }

    // ---------------------------------
    // PLS: Live Increment
    // ---------------------------------
    /**
     * When losing or winning a lead, this method is called to increment each PLS parameter related to the lead
        in wonCount (if won) or in lostCount (if lost).
 
        This method is also used when reactivating a mistakenly lost lead (using the decrement argument).
        In this case, the lost count should be de-increment by 1 for each PLS parameter linked ot the lead.
 
        Live increment must be done before writing the new values because we need to know the state change (from and to).
        This would not be an issue for the reach won or reach lost as we just need to increment the frequencies with the
        final state of the lead.
        This issue is when the lead leaves a closed state because once the new values have been writen, we do not know
        what was the previous state that we need to decrement.
        This is why 'isWon' and 'decrement' parameters are used to describe the from / to change of his state.
     * @param fromState 
     * @param toState 
     */
    async _plsIncrementFrequencies(fromState?: any, toState?: any) {
        const [newFrequenciesByTeam, existingFrequenciesByTeam] = await this._plsPrepareUpdateFrequencyTable(null, fromState || toState);

        // update frequency table
        await this._plsUpdateFrequencyTable(newFrequenciesByTeam, toState ? 1 : -1, existingFrequenciesByTeam);
    }

    // ---------------------------------
    // PLS: One shot rebuild
    // ---------------------------------
    /**
     * This cron will :
          - rebuild the lead scoring frequency table
          - recompute all the automatedProbability and align probability if both were aligned
     */
    async _cronUpdateAutomatedProbabilities() {
        const cronStartDate = _Datetime.now();
        await this._rebuildPlsFrequencyTable();
        await this._updateAutomatedProbabilities();
        console.info("Predictive Lead Scoring : Cron duration = %s seconds", diffDate(_Datetime.now(), cronStartDate, 'seconds').seconds);
    }

    async _rebuildPlsFrequencyTable() {
        // Clear the frequencies table (in sql to speed up the cron)
        let err;
        try {
            await this.checkAccessRights('unlink');
        } catch (e) {
            err = e;
            if (isInstance(e, AccessError)) {
                throw new UserError(await this._t("You don't have the access needed to run this cron."));
            }
        }
        if (!err) {
            await this._cr.execute('TRUNCATE TABLE "crmLeadScoringFrequency"');
        }
        const [newFrequenciesByTeam, unused] = await this._plsPrepareUpdateFrequencyTable(true);
        // update frequency table
        await this._plsUpdateFrequencyTable(newFrequenciesByTeam, 1);

        console.info("Predictive Lead Scoring : crm.lead.scoring.frequency table rebuilt");
    }

    /**
     * Recompute all the automatedProbability (and align probability if both were aligned) for all the leads
        that are active (not won, nor lost).
 
        For performance matter, as there can be a huge amount of leads to recompute, this cron proceed by batch.
        Each batch is performed into its own transaction, in order to minimise the lock time on the lead table
        (and to avoid complete lock if there was only 1 transaction that would last for too long -> several minutes).
        If a concurrent update occurs, it will simply be put in the queue to get the lock.
     * @returns 
     */
    async _updateAutomatedProbabilities() {
        const plsStartDate = await this._plsGetSafeStartDate();
        if (!plsStartDate) {
            return;
        }

        // 1. Get all the leads to recompute created after plsStartDate that are nor won nor lost
        // (Won : probability = 100 | Lost : probability = 0 or inactive. Here, inactive won't be returned anyway)
        // Get also all the lead without probability --> These are the new leads. Activate auto probability on them.
        const pendingLeadDomain = [
            '&',
            '&',
            ['stageId', '!=', false], ['createdAt', '>=', plsStartDate],
            '|',
            ['probability', '=', false],
            '&',
            ['probability', '<', 100], ['probability', '>', 0]
        ];
        const leadsToUpdate = await this.env.items('crm.lead').search(pendingLeadDomain);
        const leadsToUpdateCount = len(leadsToUpdate);

        // 2. Compute by batch to avoid memory error
        const leadProbabilities = {};
        for (const i of range(0, leadsToUpdateCount, PLS_COMPUTE_BATCH_STEP)) {
            const leadsToUpdatePart = leadsToUpdate.slice(i, i + PLS_COMPUTE_BATCH_STEP);
            update(leadProbabilities, await leadsToUpdatePart._plsGetNaiveBayesProbabilities(true));
        }
        console.info("Predictive Lead Scoring : New automated probabilities computed");

        // 3. Group by new probability to reduce server roundtrips when executing the update
        const probabilityLeads = new DefaultDict2(() => []);
        for (const [leadId, probability] of sorted(Object.entries(leadProbabilities))) {
            probabilityLeads[probability].push(leadId);
        }

        // 4. Update automatedProbability (+ probability if both were equal)
        const updateSql = `UPDATE "crmLead"
                            SET "automatedProbability" = %s,
                                probability = CASE WHEN (probability = "automatedProbability" OR probability is null)
                                                   THEN (%s)
                                                   ELSE (probability)
                                              END
                            WHERE id in (%s)`;

        // Update by a maximum number of leads at the same time, one batch by transaction :
        // - avoid memory errors
        // - avoid blocking the table for too long with a too big transaction
        let [transactionsCount, transactionsFailedCount] = [0, 0];
        const cronUpdateLeadStartDate = _Datetime.now();
        const autoCommit = !getattr(this.env, 'testing', false);
        for (const [probability, probabilityLeadIds] of probabilityLeads) {
            for (const leadIdsCurrent of splitEvery(PLS_UPDATE_BATCH_STEP, probabilityLeadIds)) {
                transactionsCount += 1;
                try {
                    await this.env.cr.execute(updateSql, [probability, probability, String(leadIdsCurrent) || 'NULL']);
                    // auto-commit except in testing mode
                    if (autoCommit) {
                        await this.env.cr.commit();
                    }
                } catch (e) {
                    console.warn("Predictive Lead Scoring : update transaction failed. Error: %s", e);
                    transactionsFailedCount += 1;
                }
            }
        }
        console.info(
            "Predictive Lead Scoring : All automated probabilities updated (%s leads / %s transactions (%s failed) / %s seconds)",
            leadsToUpdateCount,
            transactionsCount,
            transactionsFailedCount,
            diffDate(_Datetime.now(), cronUpdateLeadStartDate, 'seconds').seconds,
        );
    }

    // ---------------------------------
    // PLS: Common parts for both mode
    // ---------------------------------
    /**
     * This method is common to Live Increment or Full Rebuild mode, as it shares the main steps.
        This method will prepare the frequency dict needed to update the frequency table:
            - New frequencies: frequencies that we need to add in the frequency table.
            - Existing frequencies: frequencies that are already in the frequency table.
        In rebuild mode, only the new frequencies are needed as existing frequencies are truncated.
        For each team, each dict contains the frequency in won and lost for each field/value couple
        of the target leads.
        Target leads are :
            - in Live increment mode : given ongoing leads (self)
            - in Full rebuild mode : all the closed (won and lost) leads in the DB.
        During the frequencies update, with both new and existing frequencies, we can split frequencies to update
        and frequencies to add. If a field/value couple already exists in the frequency table, we just update it.
        Otherwise, we need to insert a new one.
     * @param rebuild 
     * @param targetState 
     * @returns 
     */
    async _plsPrepareUpdateFrequencyTable(rebuild: boolean = false, targetState: boolean = false) {
        // Keep eligible leads
        const plsStartDate = await this._plsGetSafeStartDate();
        if (!plsStartDate) {
            return [{}, {}];
        }

        let plsLeads;
        if (rebuild) {  // rebuild will treat every closed lead in DB, increment will treat current ongoing leads
            plsLeads = this;
        }
        else {
            // Only treat leads created after the PLS start Date
            plsLeads = await this.filtered(
                async (lead) => _Date.toDate(plsStartDate) <= _Date.toDate(await lead.createdAt));
            if (!bool(plsLeads)) {
                return [{}, {}];
            }
        }

        // Extract target leads values
        let domain, teamIds;
        if (rebuild) {  // rebuild is ok
            domain = [
                '&',
                ['createdAt', '>=', plsStartDate],
                '|',
                ['probability', '=', 100],
                '&',
                ['probability', '=', 0], ['active', '=', false]
            ];
            teamIds = (await (await this.env.items('crm.team').withContext({ activeTest: false })).search([])).ids.concat([0])  // If teamId is unset, consider it as team 0
        }
        else {  // increment
            domain = [['id', 'in', plsLeads.ids]];
            teamIds = (await plsLeads.mapped('teamId')).ids.concat([0]);
        }

        const leadsValuesDict = await plsLeads._plsGetLeadPlsValues(domain);

        // split leads values by teamId
        // get current frequencies related to the target leads
        const leadsFrequencyValuesByTeam = Object.fromEntries(teamIds.map(teamId => [teamId, []]));
        let leadsPlsFields: any = new Set();  // ensure to keep each field unique (can have multiple tagId leadsValuesDict)
        for (const [leadId, values] of leadsValuesDict) {
            const teamId = values.get('teamId', 0);  // If teamId is unset, consider it as team 0
            const leadFrequencyValues = { 'count': 1 }
            for (const [field, value] of values['values']) {
                let leadProbability;
                if (field !== "probability") {  // was added to lead values in batch mode to know won/lost state, but is not a pls Fields.
                    leadsPlsFields.add(field);
                }
                else {  // extract lead probability - needed to increment tagId frequency. (proba always before tagId)
                    leadProbability = value;
                }
                if (field === 'tagId') { // handle tagId separatelly (as in One Shot rebuild mode)
                    leadsFrequencyValuesByTeam[teamId].push({ field: value, 'count': 1, 'probability': leadProbability });
                }
                else {
                    leadFrequencyValues[field] = value;
                }
            }
            leadsFrequencyValuesByTeam[teamId].push(leadFrequencyValues);
        }
        leadsPlsFields = Array.from(leadsPlsFields).sort();

        // get new frequencies
        const newFrequenciesByTeam = {};
        for (const teamId of teamIds) {
            // prepare fields and tag values for leads by team
            newFrequenciesByTeam[teamId] = await this._plsPrepareFrequencies(
                leadsFrequencyValuesByTeam[teamId], leadsPlsFields, targetState);
        }
        // get existing frequencies
        const existingFrequenciesByTeam = {};
        if (!rebuild) {  // there is no existing frequency in rebuild mode as they were all deleted.
            // read all fields to get everything in memory in one query (instead of having query + prefetch)
            const existingFrequencies = await this.env.items('crm.lead.scoring.frequency').searchRead(['&', ['variable', 'in', leadsPlsFields], '|', ['teamId', 'in', (await plsLeads.mapped('teamId')).ids], ['teamId', '=', false]]);
            for (const frequency of existingFrequencies) {
                const teamId = frequency['teamId'] ? frequency['teamId'][0] : 0;
                if (!(teamId in existingFrequenciesByTeam)) {
                    existingFrequenciesByTeam[teamId] = Dict.from(leadsPlsFields.map(field => [field, {}]));
                }
                existingFrequenciesByTeam[teamId][frequency['variable']][frequency['value']] = {
                    'frequencyId': frequency['id'],
                    'won': frequency['wonCount'],
                    'lost': frequency['lostCount']
                }
            }
        }

        return [newFrequenciesByTeam, existingFrequenciesByTeam];
    }

    /**
     * Create / update the frequency table in a cross company way, per teamId
     * @param newFrequenciesByTeam 
     * @param step 
     * @param existingFrequenciesByTeam 
     */
    async _plsUpdateFrequencyTable(newFrequenciesByTeam: {}, step, existingFrequenciesByTeam?: any) {
        const valuesToUpdate = {};
        const valuesToCreate = [];
        if (!existingFrequenciesByTeam) {
            existingFrequenciesByTeam = {}
        }
        // build the create multi + frequencies to update
        for (const [teamId, newFrequencies] of Object.entries<any>(newFrequenciesByTeam)) {
            for (const [field, value] of newFrequencies) {
                // frequency already present ?
                const currentFrequencies = existingFrequenciesByTeam[teamId] ?? {};
                for (const [param, result] of Object.entries<any>(value)) {
                    const currentFrequencyForCouple = (currentFrequencies[field] ?? {})[param] ?? {};
                    // If frequency already present : UPDATE IT
                    if (bool(currentFrequencyForCouple)) {
                        const newWon = currentFrequencyForCouple['won'] + (result['won'] * step);
                        const newLost = currentFrequencyForCouple['lost'] + (result['lost'] * step);
                        // ensure to have always positive frequencies
                        valuesToUpdate[currentFrequencyForCouple['frequencyId']] = {
                            'wonCount': newWon > 0 ? newWon : 0.1,
                            'lostCount': newLost > 0 ? newLost : 0.1
                        }
                        continue;
                    }
                    // Else, CREATE a new frequency record.
                    // We add + 0.1 in won and lost counts to avoid zero frequency issues
                    // should be +1 but it weights too much on small recordset.
                    valuesToCreate.push({
                        'variable': field,
                        'value': param,
                        'wonCount': result['won'] + 0.1,
                        'lostCount': result['lost'] + 0.1,
                        'teamId': teamId ? teamId : null  // teamId = 0 means no teamId
                    });
                }
            }
        }

        const leadScoringFrequency = await this.env.items('crm.lead.scoring.frequency').sudo();
        for (const [frequencyId, values] of Object.entries(valuesToUpdate)) {
            await leadScoringFrequency.browse(frequencyId).write(values);
        }
        if (valuesToCreate.length) {
            await leadScoringFrequency.create(valuesToCreate);
        }
    }

    // ---------------------------------
    // Utility Tools for PLS
    // ---------------------------------

    // PLS:  Config Parameters
    // ---------------------
    /**
     * As configParameters does not accept Date field,
            we get directly the date formated string stored into the Char config field,
            as we directly use this string in the sql queries.
            To avoid sql injections when using this config param,
            we ensure the date string can be effectively a date.
     * @returns 
     */
    async _plsGetSafeStartDate() {
        const strDate = (await this.env.items('ir.config.parameter').sudo()).getParam('crm.plsStartDate');
        if (!_Date.toDate(strDate)) {
            return false;
        }
        return strDate;
    }

    /**
     * As configParameters does not accept M2M field,
            we the fields from the formated string stored into the Char config field.
            To avoid sql injections when using that list, we return only the fields
            that are defined on the model.
     * @returns 
     */
    async _plsGetSafeFields() {
        const plsFieldsConfig = await (await this.env.items('ir.config.parameter').sudo()).getParam('crm.plsFields');
        const plsFields = plsFieldsConfig ? plsFieldsConfig.split(',') : [];
        const plsSafeFields = plsFields.filter(field => field in this._fields);
        return plsSafeFields;
    }

    // Compute Automated Probability Tools
    // -----------------------------------
    /**
     * Get all won and all lost + total :
               first stage can be used to know how many lost and won there is
               as won count are equals for all stage
               and first stage is always incremented in lostCount
        :param frequencies: leadScoringFrequencies
        :return: won count, lost count and total count for all records in frequencies
     */
    async _plsGetWonLostTotalCount(teamResults) {
        // TODO : check if we need to handle specific teamId stages [for lost count] (if first stage in sequence is teamSpecific)
        const firstStageId = await this.env.items('crm.stage').search([['teamId', '=', false]], { order: 'sequence, id', limit: 1 });
        if (!(teamResults['stageId'] ?? []).includes(String(firstStageId.id))) {
            return [0, 0, 0];
        }
        const stageResult = teamResults['stageId'][String(firstStageId.id)];
        return [stageResult['won'], stageResult['lost'], stageResult['won'] + stageResult['lost']];
    }

    // PLS: Rebuild Frequency Table Tools
    // ----------------------------------
    /**
     * new state is used when getting frequencies for leads that are changing to lost or won.
        Stays none if we are checking frequencies for leads already won or lost.
     */
    async _plsPrepareFrequencies(leadValues, leadsPlsFields: string[], targetState?: any) {
        const plsFields = Array.from(leadsPlsFields);
        let frequencies = Dict.from(plsFields.map(field => [field, {}]));

        const stageIds = await this.env.items('crm.stage').searchRead([], ['sequence', 'label', 'id'], { order: 'sequence, id' });
        const stageSequences = Object.fromEntries(stageIds.map(stage => [stage['id'], stage['sequence']]));

        // Increment won / lost frequencies by criteria (field / value couple)
        for (const values of leadValues) {
            let wonCount, lostCount;
            if (targetState) {  // ignore probability values if target state (as probability is the old value)
                wonCount = targetState === 'won' ? values['count'] : 0;
                lostCount = targetState === 'lost' ? values['count'] : 0;
            }
            else {
                wonCount = (values['probability'] ?? 0) == 100 ? values['count'] : 0;
                lostCount = (values['probability'] ?? 1) == 0 ? values['count'] : 0;
            }

            if ('tagId' in values) {
                frequencies = await this._plsIncrementFrequencyDict(frequencies, 'tagId', values['tagId'], wonCount, lostCount);
                continue;
            }

            // Else, treat other fields
            if (plsFields.includes('tagId')) {  // tagId already treated here above.
                remove(plsFields, 'tagId');
            }
            for (const field of plsFields) {
                if (!(field in values)) {
                    continue;
                }
                const value = values[field];
                if (value || ['emailState', 'phoneState'].includes(field)) {
                    if (field === 'stageId') {
                        let stagesToIncrement;
                        if (wonCount) {  // increment all stages if won
                            stagesToIncrement = stageIds.map((stage => stage['id']));
                        }
                        else {  // increment only current + previous stages if lost
                            const currentStageSequence = stageSequences[value];
                            stagesToIncrement = stageIds.filter(stage => stage['sequence'] <= currentStageSequence).map(stage => stage['id']);
                        }
                        for (const stageId of stagesToIncrement) {
                            frequencies = await this._plsIncrementFrequencyDict(frequencies, field, stageId, wonCount, lostCount);
                        }
                    }
                    else {
                        frequencies = await this._plsIncrementFrequencyDict(frequencies, field, value, wonCount, lostCount);
                    }
                }
            }
        }

        return frequencies;
    }

    async _plsIncrementFrequencyDict(frequencies, field, value, won, lost) {
        value = String(value);  // Ensure we will always compare strings.
        if (!(value in frequencies[field])) {
            frequencies[field][value] = Dict.from({ 'won': won, 'lost': lost });
        }
        else {
            frequencies[field][value]['won'] += won;
            frequencies[field][value]['lost'] += lost;
        }
        return frequencies;
    }

    // Common PLS Tools
    // ----------------
    /**
     * This methods builds a dict where, for each lead in self or matching the given domain,
        we will get a list of field/value couple.
        Due to onchange and create, we don't always have the id of the lead to recompute.
        When we update few records (one, typically) with onchanges, we build the leadValues (= couple field/value)
        using the ORM.
        To speed up the computation and avoid making too much DB read inside loops,
        we can give a domain to make sql queries to bypass the ORM.
        This domain will be used in sql queries to get the values for every lead matching the domain.
        :param domain: If set, we get all the leads values via unique sql queries (one for tags, one for other fields),
                            using the given domain on leads.
                       If not set, get lead values lead by lead using the ORM.
        :return: {leadId: [[field1: value1], [field2: value2], ...], ...}
     * @param domain 
     */
    async _plsGetLeadPlsValues(domain = []) {
        const leadsValuesDict = new OrderedDict<any>();
        const plsFields = ["stageId", "teamId"].concat(await this._plsGetSafeFields());

        // Check if tagIds is in the plsFields and removed it from the list. The tags will be managed separately.
        const useTags = plsFields.includes('tagIds');
        if (useTags) {
            remove(plsFields, 'tagIds');
        }

        if (bool(domain)) {
            // activeTest = False as domain should take active into 'active' field it self
            const [fromClause, whereClause, whereParams] = await (await (await this.env.items('crm.lead').withContext({ activeTest: false }))._whereCalc(domain)).getSql();
            const strFields = _.fill(Array(len(plsFields)), '%s').join(', ');
            const args = plsFields.map(field => dbFactory.name(field));

            // Get leads values
            await this.flush(['probability']);
            let query = `SELECT id, probability, %s
                        FROM %s
                        WHERE %s order by "teamId" asc, id desc`;
            query = f(f(query, strFields, fromClause, whereClause), ...args);
            const leadResults = await this._cr.execute(query, whereParams);

            let tagResults;
            if (useTags) {
                // Get tags values
                query = `SELECT "crmLead".id as "leadId", t.id as "tagId"
                            FROM %s
                            LEFT JOIN "crmTagRel" rel ON "crmLead".id = rel."leadId"
                            LEFT JOIN "crmTag" t ON rel."tagId" = t.id
                            WHERE %s order by "crmLead"."teamId" asc, "crmLead".id`;
                args.push(dbFactory.name('tagId'));
                query = f(f(query, fromClause, whereClause), ...args);
                tagResults = await this._cr.execute(query, whereParams);
            }
            else {
                tagResults = [];
            }

            // get all (variable, value) couple for all in self
            for (const lead of leadResults) {
                const leadValues = [];
                for (const field of plsFields.concat(['probability'])) {  // add probability as used in _plsPrepareFrequencies (needed in rebuild mode)
                    const value = lead[field];
                    if (field === 'teamId') {  // ignore teamId as stored separately in leadsValuesDict[leadId][teamId]
                        continue;
                    }
                    if (value || field === 'probability') {  // 0 is a correct value for probability
                        leadValues.push([field, value]);
                    }
                    else if (['emailState', 'phoneState'].includes(field)) {  // As ORM reads 'None' as 'False', do the same here
                        leadValues.push([field, false]);
                    }
                    leadsValuesDict[lead['id']] = Dict.from({ 'values': leadValues, 'teamId': lead['teamId'] || 0 })
                }
            }

            for (const tag of tagResults) {
                if (tag['tagId']) {
                    leadsValuesDict[tag['leadId']]['values'].push(['tagId', tag['tagId']]);
                }
            }
            return leadsValuesDict;
        }
        else {
            for (const lead of this) {
                const leadValues = [];
                for (const field of plsFields) {
                    if (field === 'teamId') {  // ignore teamId as stored separately in leadsValuesDict[leadId][teamId]
                        continue;
                    }
                    const value = isInstance(lead[field], models.BaseModel) ? lead[field].id : lead[field];
                    if (bool(value) || ['emailState', 'phoneState'].includes(field)) {
                        leadValues.push([field, value]);
                    }
                }
                if (useTags) {
                    for (const tag of await lead.tagIds) {
                        leadValues.push(['tagId', tag.id]);
                    }
                }
                leadsValuesDict[lead.id] = Dict.from({ 'values': leadValues, 'teamId': lead['teamId'].id });
            }
            return leadsValuesDict;
        }
    }
}