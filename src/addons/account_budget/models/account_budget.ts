import { Fields, _Date, api } from "../../../core";
import { ValidationError } from "../../../core/helper";
import { MetaModel, Model, _super } from "../../../core/models";
import { Query } from "../../../core/osv";
import { extend, parseFloat, split } from "../../../core/tools";
import { bool } from "../../../core/tools/bool";
import { diffDate } from "../../../core/tools/date_utils";

// Budgets
@MetaModel.define()
class AccountBudgetPost extends Model {
    static _module = module;
    static _name = "account.budget.post";
    static _order = "label";
    static _description = "Budgetary Position";

    static label = Fields.Char('Label', {required: true});
    static accountIds = Fields.Many2many('account.account', {relation: 'accountBudgetRel', column1: 'budgetId', column2: 'accountId', string: 'Accounts', domain: [['deprecated', '=', false]]});
    static companyId = Fields.Many2one('res.company', {string: 'Company', required: true, default: self => self.env.company()});

    async _checkAccountIds(vals) {
        // Raise an error to prevent the account.budget.post to have not specified account_ids.
        // This check is done on create because require: true doesn't work on Many2many fields.
        let accountIds;
        if ('accountIds' in vals) {
            accountIds = await (await this.new({'accountIds': vals['accountIds']}, {origin: this})).accountIds;
        }
        else {
            accountIds = await this['accountIds'];
        }
        if (! bool(accountIds)) {
            throw new ValidationError(await this._t('The budget must have at least one account.'));
        }
    }

    @api.model()
    async create(vals) {
        await this._checkAccountIds(vals);
        return _super(AccountBudgetPost, this).create(vals);
    }

    async write(vals) {
        await this._checkAccountIds(vals);
        return _super(AccountBudgetPost, this).write(vals);
    }
}

@MetaModel.define()
class CrossoveredBudget extends Model {
    static _module = module;
    static _name = "crossovered.budget";
    static _description = "Budget";
    static _parents = ['mail.thread'];

    static label = Fields.Char('Budget Name', {required: true, states: {'done': [['readonly', true]]}});
    static userId = Fields.Many2one('res.users', {string: 'Responsible', default: self => self.env.user()});
    static dateFrom = Fields.Date('Start Date', {required: true, states: {'done': [['readonly', true]]}});
    static dateTo = Fields.Date('End Date', {required: true, states: {'done': [['readonly', true]]}});
    static state = Fields.Selection([
        ['draft', 'Draft'],
        ['cancel', 'Cancelled'],
        ['confirm', 'Confirmed'],
        ['validate', 'Validated'],
        ['done', 'Done']
        ], {string: 'Status', default: 'draft', index: true, required: true, readonly: true, copy: false, tracking: true});
    static crossoveredBudgetLine = Fields.One2many('crossovered.budget.lines', 'crossoveredBudgetId', { string: 'Budget Lines', states: {'done': [['readonly', true]]}, copy: true});
    static companyId = Fields.Many2one('res.company', {string: 'Company', required: true, default: self => self.env.company()});

    async actionBudgetConfirm() {
        await this.write({'state': 'confirm'});
    }

    async actionBudgetDraft() {
        await this.write({'state': 'draft'});
    }

    async actionBudgetValidate() {
        await this.write({'state': 'validate'});
    }

    async actionBudgetCancel() {
        await this.write({'state': 'cancel'});
    }

    async actionBudgetDone() {
        await this.write({'state': 'done'});
    }
}

@MetaModel.define()
class CrossoveredBudgetLines extends Model {
    static _module = module;
    static _name = "crossovered.budget.lines";
    static _description = "Budget Line";

    static label = Fields.Char({compute: '_computeLineName'});
    static crossoveredBudgetId = Fields.Many2one('crossovered.budget', {string: 'Budget', ondelete: 'CASCADE', index: true, required: true});
    static analyticAccountId = Fields.Many2one('account.analytic.account', {string: 'Analytic Account'});
    static analyticGroupId = Fields.Many2one('account.analytic.group', {string: 'Analytic Group', related: 'analyticAccountId.groupId', readonly: true});
    static generalBudgetId = Fields.Many2one('account.budget.post', {string: 'Budgetary Position'});
    static dateFrom = Fields.Date('Start Date', {required: true});
    static dateTo = Fields.Date('End Date', {required: true});
    static paidDate = Fields.Date('Paid Date');
    static currencyId = Fields.Many2one('res.currency', {related: 'companyId.currencyId', readonly: true});
    static plannedAmount = Fields.Monetary(
        'Planned Amount', {required: true,
        help: "Amount you plan to earn/spend. Record a positive amount if it is a revenue and a negative amount if it is a cost."});
    static practicalAmount = Fields.Monetary(
        {compute: '_computePracticalAmount', string: 'Practical Amount', help: "Amount really earned/spent."});
    static theoriticalAmount = Fields.Monetary(
        {compute: '_computeTheoriticalAmount', string: 'Theoretical Amount',
        help: "Amount you are supposed to have earned/spent at this date."});
    static percentage = Fields.Float(
        {compute: '_computePercentage', string: 'Achievement',
        help: "Comparison between practical and theoretical amount. This measure tells you if you are below or over budget."});
    static companyId = Fields.Many2one({related: 'crossoveredBudgetId.companyId', comodelName: 'res.company',
        string: 'Company', store: true, readonly: true});
    static isAboveBudget = Fields.Boolean({compute: '_isAboveBudget'});
    static crossoveredBudgetState = Fields.Selection({related: 'crossoveredBudgetId.state', string: 'Budget State', store: true, readonly: true});

    @api.model()
    async readGroup(domain, fields, groupby, options: {offset?: number, limit?: number, orderby?: string, lazy?: boolean}={}) {
        // overrides the default read_group in order to compute the computed fields manually for the group
        const fieldsList = ['practicalAmount', 'theoriticalAmount', 'percentage'];
        fields = fields.map(field => fieldsList.includes(split(field, ':', 1)[0]) ? split(field, ':', 1)[0] : field);
        const result = await _super(CrossoveredBudgetLines, this).readGroup(domain, fields, groupby, options);
        if (fieldsList.some(x => fields.includes(x))) {
            for (const groupLine of result) {
                // initialise fields to compute to 0 if they are requested
                if (fields.includes('practicalAmount')) {
                    groupLine['practicalAmount'] = 0;
                }
                if (fields.includes('theoriticalAmount')) {
                    groupLine['theoriticalAmount'] = 0;
                }
                if (fields.includes('percentage')) {
                    groupLine['percentage'] = 0;
                    groupLine['practicalAmount'] = 0;
                    groupLine['theoriticalAmount'] = 0;
                }

                let allBudgetLinesThatComposeGroup;
                if (groupLine['__domain']) {
                    allBudgetLinesThatComposeGroup = await this.search(groupLine['__domain']);
                }
                else {
                    allBudgetLinesThatComposeGroup = await this.search([]);
                }
                for (const budgetLineOfGroup of allBudgetLinesThatComposeGroup) {
                    if (fields.includes('practicalAmount') || fields.includes('percentage')) {
                        groupLine['practicalAmount'] += await budgetLineOfGroup.practicalAmount;
                    }

                    if (fields.includes('theoriticalAmount') || fields.includes('percentage')) {
                        groupLine['theoriticalAmount'] += await budgetLineOfGroup.theoriticalAmount;
                    }

                    if (fields.includes('percentage')) {
                        if (groupLine['theoriticalAmount']) {
                            // use a weighted average
                            groupLine['percentage'] = parseFloat((groupLine['practicalAmount'] || 0.0) / groupLine['theoriticalAmount']) * 100;
                        }
                    }
                }
            }
        }

        return result;
    }

    async _isAboveBudget() {
        for (const line of this) {
            const [theoriticalAmount, practicalAmount] = await line('theoriticalAmount', 'practicalAmount');
            if (theoriticalAmount >= 0) {
                await line.set('isAboveBudget', practicalAmount > theoriticalAmount);
            }
            else {
                await line.set('isAboveBudget', practicalAmount < theoriticalAmount);
            }
        }
    }

    async _computeLineName() {
        //just in case someone opens the budget line in form view
        for (const line of this) {
            const [crossoveredBudgetId, generalBudgetId, analyticAccountId] = await line('crossoveredBudgetId', 'generalBudgetId', 'analyticAccountId')
            let computedName = await crossoveredBudgetId.label;
            if (generalBudgetId.ok) {
                computedName += ' - ' + await generalBudgetId.label;
            }
            if (analyticAccountId.ok) {
                computedName += ' - ' + await analyticAccountId.label;
            }
            await line.set('label', computedName);
        }
    }

    async _computePracticalAmount() {
        for (const line of this) {
            const [generalBudget, analyticAccount, dateTo, dateFrom] = await line('generalBudgetId', 'analyticAccountId', 'dateTo', 'dateFrom');
            const accIds = (await generalBudget.accountIds).ids;
            let query, fromClause, whereClause, whereClauseParams;
            if (bool(analyticAccount.id)) {
                const analyticLineObj = this.env.items('account.analytic.line');
                const domain = [['accountId', '=', analyticAccount.id],
                          ['date', '>=', dateFrom],
                          ['date', '<=', dateTo],
                          ];
                if (bool(accIds)) {
                    extend(domain, [['generalAccountId', 'in', accIds]]);
                }
                const whereQuery: Query = await analyticLineObj._whereCalc(domain);
                await analyticLineObj._applyIrRules(whereQuery, 'read');
                [fromClause, whereClause, whereClauseParams] = whereQuery.getSql();
                query = "SELECT SUM(amount) AS amount FROM " + fromClause + " WHERE " + whereClause;
            }
            else {
                const amlObj = this.env.items('account.move.line');
                const domain = [['accountId', 'in',
                           (await generalBudget.accountIds).ids],
                          ['date', '>=', dateFrom],
                          ['date', '<=', dateTo]
                          ];
                const whereQuery = await amlObj._whereCalc(domain);
                await amlObj._applyIrRules(whereQuery, 'read');
                [fromClause, whereClause, whereClauseParams] = whereQuery.getSql();
                query = "SELECT sum(credit)-sum(debit) AS amount FROM " + fromClause + " WHERE " + whereClause;
            }
            const result = await this.env.cr.execute(query, whereClauseParams);
            await line.set('practicalAmount', result[0]['amount'] || 0.0);
        }
    }

    async _computeTheoriticalAmount() {
        const today = _Date.today();
        for (const line of this) {
            const [paidDate, plannedAmount] = await line('paidDate', 'plannedAmount');
            let theoAmt;
            if (paidDate) {
                if (today <= paidDate) {
                    theoAmt = 0.00;
                }
                else {
                    theoAmt = plannedAmount;
                }
            }
            else {
                const [dateTo, dateFrom] = await line('dateTo', 'dateFrom');
                const lineTimedelta = diffDate(dateFrom, dateTo, ['days', 'seconds']);
                const elapsedTimedelta = diffDate(dateFrom, today, ['days', 'seconds']);

                if (elapsedTimedelta.days < 0) {
                    // If the budget line has not started yet, theoretical amount should be zero
                    theoAmt = 0.00;
                }
                else if (lineTimedelta.days > 0 && today < dateTo) {
                    // If today is between the budget line dateFrom and dateTo
                    theoAmt = (elapsedTimedelta.seconds / lineTimedelta.seconds) * plannedAmount;
                }
                else {
                    theoAmt = plannedAmount;
                }
            }
            await line.set('theoriticalAmount', theoAmt);
        }
    }

    async _computePercentage() {
        for (const line of this) {
            const [theoriticalAmount, practicalAmount] = await line('theoriticalAmount', 'practicalAmount');
            if (theoriticalAmount != 0.00) {
                await line.set('percentage', parseFloat((practicalAmount || 0.0) / theoriticalAmount));
            }
            else {
                await line.set('percentage', 0.00);
            }
        }
    }

    @api.constrains('generalBudgetId', 'analyticAccountId')
    async _mustHaveAnalyticalOrBudgetaryOrBoth() {
        if (! (await this['analyticAccountId']).ok && ! (this['generalBudgetId']).ok) {
            throw new ValidationError(await this._t("You have to enter at least a budgetary position or analytic account on a budget line."));
        }
    }
    
    async actionOpenBudgetEntries() {
        const [analyticAccount, generalBudget, dateFrom, dateTo] = await this('analyticAccountId', 'generalBudgetId', 'dateFrom', 'dateTo');
        let action;
        if (analyticAccount.ok) {
            // if there is an analytic account, then the analytic items are loaded
            action = await this.env.items('ir.actions.actions')._forXmlid('analytic.accountAnalyticLineActionEntries');
            action['domain'] = [['accountId', '=', analyticAccount.id],
                                ['date', '>=', dateFrom],
                                ['date', '<=', dateTo]
                                ];
            if (generalBudget.ok) {
                extend(action['domain'], [['generalAccountId', 'in', (await generalBudget.accountIds).ids]]);
            }
        }
        else {
            // otherwise the journal entries booked on the accounts of the budgetary postition are opened
            action = await this.env.items('ir.actions.actions')._forXmlid('account.actionAccountMovesAllA');
            action['domain'] = [['accountId', 'in',
                                 (await generalBudget.accountIds).ids],
                                ['date', '>=', dateFrom],
                                ['date', '<=', dateTo]
                                ];
        }
        return action;
    }

    @api.constrains('dateFrom', 'dateTo')
    async _lineDatesBetweenBudgetDates() {
        for (const rec of this) {
            let [crossoveredBudget, dateFrom, dateTo] = await rec('crossoveredBudgetId', 'dateFrom', 'dateTo');
            const [budgetDateFrom, budgetDateTo] = await crossoveredBudget('dateFrom', 'dateTo');
            if (dateFrom) {
                if (dateFrom < budgetDateFrom || dateFrom > budgetDateTo) {
                    throw new ValidationError(await this._t('"Start Date" of the budget line should be included in the Period of the budget'));
                }
            }
            if (dateTo) {
                if (dateTo < budgetDateFrom || dateTo > budgetDateTo) {
                    throw new ValidationError(await this._t('"End Date" of the budget line should be included in the Period of the budget'));
                }
            }
        }
    }
}
