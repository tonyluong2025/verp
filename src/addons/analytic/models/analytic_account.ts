import { api } from "../../../core"
import { Fields, _Date } from "../../../core/fields"
import { DefaultDict } from "../../../core/helper/collections"
import { ValidationError } from "../../../core/helper/errors"
import { MetaModel, Model, _super } from "../../../core/models"
import { expression } from "../../../core/osv"
import { bool } from "../../../core/tools/bool"
import { sum } from "../../../core/tools/iterable"
import { f } from "../../../core/tools/utils"

@MetaModel.define()
class AccountAnalyticDistribution extends Model {
    static _module = module;
    static _name = 'account.analytic.distribution'
    static _description = 'Analytic Account Distribution'
    static _recName = 'accountId'

    static accountId = Fields.Many2one('account.analytic.account', {string: 'Analytic Account', required: true});
    static percentage = Fields.Float({string: 'Percentage', required: true, default: 100.0});
    static label = Fields.Char({string: 'Name', related: 'accountId.label', readonly: false});
    static tagId = Fields.Many2one('account.analytic.tag', {string: "Parent tag", required: true});

    static _sqlConstraints = [
        ['checkPercentage', 'CHECK(percentage >= 0 AND percentage <= 100)',
         'The percentage of an analytic distribution should be between 0 and 100.']
    ]
}

@MetaModel.define()
class AccountAnalyticTag extends Model {
    static _module = module;
    static _name = 'account.analytic.tag'
    static _description = 'Analytic Tags'
    
    static label = Fields.Char({string: 'Analytic Tag', index: true, required: true});
    static color = Fields.Integer('Color Index');
    static active = Fields.Boolean({default: true, help: "Set active to false to hide the Analytic Tag without removing it."});
    static activeAnalyticDistribution = Fields.Boolean('Analytic Distribution');
    static analyticDistributionIds = Fields.One2many('account.analytic.distribution', 'tagId', { string: "Analytic Accounts"});
    static companyId = Fields.Many2one('res.company', {string: 'Company'});
}

@MetaModel.define()
class AccountAnalyticGroup extends Model {
    static _module = module;
    static _name = 'account.analytic.group';
    static _description = 'Analytic Categories';
    static _parentStore = true;
    static _recName = 'completeName';

    static label = Fields.Char({required: true});
    static description = Fields.Text({string: 'Description'});
    static parentId = Fields.Many2one('account.analytic.group', {string: "Parent", ondelete: 'CASCADE', domain: "['|', ['companyId', '=', false], ['companyId', '=', companyId]]"});
    static parentPath = Fields.Char({index: true});
    static childrenIds = Fields.One2many('account.analytic.group', 'parentId', { string: "Childrens"});
    static completeName = Fields.Char('Complete Name', {compute: '_computeCompleteName', recursive: true, store: true});
    static companyId = Fields.Many2one('res.company', {string: 'Company', default: self => self.env.company()});

    @api.depends('label', 'parentId.completeName')
    async _computeCompleteName() {
        for (const group of this) {
          const parentId = await group.parentId;
            if (bool(parentId)) {
                await group.set('completeName', f('%s / %s', await parentId.completeName, await group.label));
            }
            else {
                await group.set('completeName', await group.label);
            }
        }
    }
}

@MetaModel.define()
class AccountAnalyticAccount extends Model {
    static _module = module;
    static _name = 'account.analytic.account';
    static _parents = ['mail.thread'];
    static _description = 'Analytic Account';
    static _order = 'code, label asc';
    static _checkCompanyAuto = true;

    /**
     * Override readGroup to calculate the sum of the non-stored fields that depend on the user context
     * @param domain 
     * @param fields 
     * @param groupby 
     * @param offset 
     * @param limit 
     * @param orderby 
     * @param lazy 
     */
    @api.model()
    async readGroup(domain, fields, groupby, options: {offset?: number, limit?: number, orderby?: string, lazy?: boolean}={}) {
      options.lazy = options.lazy ?? true;
        const res = await _super(AccountAnalyticAccount, this).readGroup(domain, fields, groupby, options);
        let accounts = this.env.items('account.analytic.account');
        for (const line of res) {
            if ('__domain' in line) {
                accounts = await this.search(line['__domain']);
            }
            if (fields.includes('balance')) {
                line['balance'] = sum(await accounts.mapped('balance'));
            }
            if (fields.includes('debit')) {
                line['debit'] = sum(await accounts.mapped('debit'));
            }
            if (fields.includes('credit')) {
                line['credit'] = sum(await accounts.mapped('credit'));
            }
        }
        return res;
    }

    @api.depends('lineIds.amount')
    async _computeDebitCreditBalance() {
        const Curr = this.env.items('res.currency');
        const analyticLineObj = this.env.items('account.analytic.line');
        let domain: any[] = [
            ['accountId', 'in', this.ids],
            ['companyId', 'in', [false].concat((await this.env.companies()).ids)]
        ];
        if (this._context['fromDate'] ?? false) {
            domain.push(['date', '>=', this._context['fromDate']]);
        }
        if (this._context['toDate'] ?? false) {
            domain.push(['date', '<=', this._context['toDate']]);
        }
        if (this._context['tagIds']) {
            const tagDomain = expression.OR(this._context['tagIds'].map(tag => [['tagIds', 'in', [tag]]]));
            domain = expression.AND([domain, tagDomain]);
        }

        const company = await this.env.company();
        const userCurrency = await company.currencyId;
        const creditGroups = await analyticLineObj.readGroup(
            domain.concat([['amount', '>=', 0.0]]),
            ['accountId', 'currencyId', 'amount'],
            ['accountId', 'currencyId'],
            {lazy: false},
        )
        const dataCredit = new DefaultDict(); //(float)
        for (const l of creditGroups) {
          const key = l['accountId'][0];
          dataCredit[key] = dataCredit[key] || 0.0;
            dataCredit[key] += await Curr.browse(l['currencyId'][0])._convert(l['amount'], userCurrency, company, _Date.today());
        }
        const debitGroups = await analyticLineObj.readGroup(
            domain.concat([['amount', '<', 0.0]]),
            ['accountId', 'currencyId', 'amount'],
            ['accountId', 'currencyId'],
            {lazy: false},
        )
        const dataDebit = new DefaultDict(); //float
        for (const l of debitGroups) {
          const key = l['accountId'][0];
          dataDebit[key] = dataDebit[key] || 0.0;
            dataDebit[key] += await Curr.browse(l['currencyId'][0])._convert(l['amount'], userCurrency, company, _Date.today())
        }
        for (const account of this) {
          const debit = Math.abs(dataDebit.get(account.id, 0.0));
          const credit = dataCredit.get(account.id, 0.0);
            // await Promise.all([
                await account.set('debit', debit),
                await account.set('credit', credit), 
                await account.set('balance', credit - debit)
            // ]);
        }
    }

    static label = Fields.Char({string: 'Analytic Account', index: true, required: true, tracking: true});
    static code = Fields.Char({string: 'Reference', index: true, tracking: true});
    static active = Fields.Boolean('Active', {help: "If the active field is set to false, it will allow you to hide the account without removing it.", default: true});

    static groupId = Fields.Many2one('account.analytic.group', {string: 'Group', checkCompany: true});

    static lineIds = Fields.One2many('account.analytic.line', 'accountId', { string: "Analytic Lines"});

    static companyId = Fields.Many2one('res.company', {string: 'Company', default: self => self.env.company()});

    // use auto_join to speed up nameSearch call
    static partnerId = Fields.Many2one('res.partner', {string: 'Customer', autojoin: true, tracking: true, checkCompany: true});

    static balance = Fields.Monetary({compute: '_computeDebitCreditBalance', string: 'Balance',  groups: 'account.groupAccountReadonly'});
    static debit = Fields.Monetary({compute: '_computeDebitCreditBalance', string: 'Debit', groups: 'account.groupAccountReadonly'});
    static credit = Fields.Monetary({compute: '_computeDebitCreditBalance', string: 'Credit', groups: 'account.groupAccountReadonly'});

    static currencyId = Fields.Many2one({related: "companyId.currencyId", string: "Currency", readonly: true});

    async nameGet() {
        const res = [];
        for (const analytic of this) {
            let [label, code, partnerId] = await analytic('label', 'code', 'partnerId');
            if (code) {
                label = '[' + code + '] ' + label;
            }
            const partnerLabel = await (await partnerId.commercialPartnerId).label;
            if (partnerLabel) {
                label = label + ' - ' + partnerLabel;
            }
            res.push([analytic.id, label]);
        }
        return res;
    }

    @api.model()
    async _nameSearch(name, args?: any, operator: string='ilike', {limit=100, nameGetUid=false}={}) {
      if (!['ilike', 'like', '=', '=like', '=ilike', 'not ilike'].includes(operator)) {
          return _super(AccountAnalyticAccount, this)._nameSearch(name, args, operator, {limit, nameGetUid});
      }
      args = args ?? [];
      let domain: any[];
      if (operator === 'ilike' && !(name || '').trim()) {
          domain = [];
      }
      else {
            // `partnerId` is in auto_join and the searches using ORs with auto_join fields doesn't work we have to cut the search in two searches ... https://github.com/verp/verp/issues/25175
            const partnerIds = this.env.items('res.partner')._search([['label', operator, name]], {limit, accessRightsUid: nameGetUid});
            const domainOperator = operator === 'not ilike' ? '&' : '|';
            domain = [domainOperator, domainOperator, ['code', operator, name], ['label', operator, name], ['partnerId', 'in', partnerIds]];
      }
      return this._search(expression.AND([domain, args]), {limit, accessRightsUid: nameGetUid});
      
    }
}

@MetaModel.define()
class AccountAnalyticLine extends Model {
    static _module = module;
    static _name = 'account.analytic.line';
    static _description = 'Analytic Line';
    static _order = 'date desc, id desc';
    static _checkCompanyAuto = true;

    @api.model()
    async _defaultUser() {
        return this.env.context['userId'] ?? (await this.env.user()).id;
    }

    static label = Fields.Char('Description', {required: true});
    static date = Fields.Date('Date', {required: true, index: true, default: self => _Date.contextToday(self)});
    static amount = Fields.Monetary('Amount', {required: true, default: 0.0});
    static unitAmount = Fields.Float('Quantity', {default: 0.0});
    static productUomId = Fields.Many2one('uom.uom', {string: 'Unit of Measure', domain: "[['categoryId', '=', productUomCategoryId]]"});
    static productUomCategoryId = Fields.Many2one({related: 'productUomId.categoryId', string: 'UoM Category', readonly: true});
    static accountId = Fields.Many2one('account.analytic.account', {string: 'Analytic Account', required: true, ondelete: 'RESTRICT', index: true, checkCompany: true});
    static partnerId = Fields.Many2one('res.partner', {string: 'Partner', checkCompany: true});
    static userId = Fields.Many2one('res.users', {string: 'User', default: self => self._defaultUser()});
    static tagIds = Fields.Many2many('account.analytic.tag', {relation: 'accountAnalyticLineTagRel', column1: 'lineId', column2: 'tagId', string: 'Tags', copy: true, checkCompany: true});
    static companyId = Fields.Many2one('res.company', {string: 'Company', required: true, readonly: true, default: self => self.env.company()});
    static currencyId = Fields.Many2one({related: "companyId.currencyId", string: "Currency", readonly: true, store: true, computeSudo: true});
    static groupId = Fields.Many2one('account.analytic.group', {related: 'accountId.groupId', store: true, readonly: true, computeSudo: true});
    static category = Fields.Selection([['other', 'Other']], {default: 'other'});

    @api.constrains('companyId', 'accountId')
    async _checkCompanyId() {
        for (const line of this) {
          const [accountId, companyId] = await line('accountId', 'companyId');
          const accountCompanyId = await accountId.companyId;
            if (bool(accountCompanyId) && companyId.id != accountCompanyId.id) {
                throw new ValidationError(await this._t('The selected account belongs to another company than the one you\'re trying to create an analytic item for'));
            }
        }
    }
}