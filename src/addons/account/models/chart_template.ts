import _ from "lodash";
import { Fields, api } from "../../../core";
import { Environment } from "../../../core/api";
import { AccessError, DefaultDict2, Dict, MapKey, UserError, ValidationError } from "../../../core/helper";
import { MetaModel, Model, _super } from "../../../core/models";
import { Registry } from "../../../core/modules/registry";
import { Cursor } from "../../../core/sql_db";
import { bool } from "../../../core/tools/bool";
import { split } from "../../../core/tools/func";
import { enumerate, extend, len, range } from "../../../core/tools/iterable";
import { update } from "../../../core/tools/misc";
import { f } from "../../../core/tools/utils";
import { escapeHtml } from "../../../core/tools/xml";
import { TYPE_TAX_USE } from "./account_tax";

/**
 * This is a utility function used to manually set the flag noupdate to false on tags and account tax templates on localization modules
    that need migration (for example in case of VAT report improvements)
 * @param cr 
 * @param registry 
 * @param module 
 */
async function migrateSetTagsAndTaxesUpdatable(cr: Cursor, registry: Registry, module: string) {
  const env = await Environment.new(cr, global.SUPERUSER_ID);
  const xmlRecordIds = (await env.items('ir.model.data').search([
    ['model', 'in', ['account.tax.template', 'account.account.tag']],
    ['module', 'like', module]
  ])).ids;
  if (bool(xmlRecordIds)) {
    await cr.execute(`update "irModelData" set noupdate = 'f' where id in (%s)`, [String(xmlRecordIds)]);
  }
}

/**
 * This is a utility function used to preserve existing previous tags during upgrade of the module.
 * @param cr 
 * @param registry 
 * @param module 
 */
async function preserveExistingTagsOnTaxes(cr: Cursor, registry: Registry, module: string) {
  const env = await Environment.new(cr, global.SUPERUSER_ID);
  const xmlRecords = await env.items('ir.model.data').search([
    ['model', '=', 'account.account.tag'],
    ['module', 'like', module]
  ]);
  if (bool(xmlRecords)) {
    await cr.execute(`update "irModelData" set noupdate = 't' where id in (%s)`, [String(xmlRecords.ids)]);
  }
}

/**
 * This method will try to update taxes based on their template.
    Schematically there are three possible execution path:
    [do the template xmlid matches one tax xmlid ?]
    -NO--> we *create* a new tax based on the template values
    -YES-> [are the tax template and the matching tax similar enough (details see `_is-tax_and_template_same`) ?]
            -YES-> We *update* the existing tax's tag (and only tags).
            -NO--> We *create* a duplicated tax with template value, and related fiscal positions.
    This method is mainly used as a local upgrade script.
    Returns a list of tuple (template_id, taxId) of newly created records.
 * @param cr 
 * @param chartTemplateXmlid 
 * @returns 
 */
async function updateTaxesFromTemplates(cr: Cursor, chartTemplateXmlid: string) {
  /**
   * Create a new taxes from templates. If an old tax already used the same xmlid, we
      remove the xmlid from it but don't modify anything else.
      :param company: the company of the tax to instantiate
      :param template2tax_mapping: a list of tuples (template, existing_tax) where existing_tax can be None
      :return: a list of tuples of ids (template.id, newly_created_tax.id)
   * @param company 
   * @param template2taxMapping 
   * @param template2taxToUpdate 
   * @returns 
   */
  async function _createTaxesFromTemplate(company, template2taxMapping, template2taxToUpdate?: any) {
    async function _removeXmlid(xmlid: string) {
      const [module, name] = split(xmlid, '.', 1);
      await (await env.items('ir.model.data').search([['module', '=', module], ['label', '=', name]])).unlink();
    }

    async function _avoidNameConflict(company, template) {
      const conflictTaxes = await env.items('account.tax').search([
        ['label', '=', await template.label], ['companyId', '=', company.id],
        ['typeTaxUse', '=', await template.typeTaxUse], ['taxScope', '=', await template.taxScope]
      ]);
      if (bool(conflictTaxes)) {
        for (const [index, taxes] of enumerate(conflictTaxes)) {
          await taxes.set('label', `[old${index > 0 ? index : ''}] ${await taxes.label}`);
        }
      }
    }

    let templatesToCreate = await env.items('account.tax.template').withContext({ activeTest: false });
    for (const [template, oldTax] of template2taxMapping) {
      if (bool(oldTax)) {
        const xmlid = (await oldTax.getExternalId())[oldTax.id];
        if (xmlid) {
          await _removeXmlid(xmlid);
        }
      }
      await _avoidNameConflict(company, template);
      templatesToCreate = templatesToCreate.add(template);
    }
    const newTemplate2taxCompany = (await templatesToCreate._generateTax(
      company, true, template2taxToUpdate
    ))['taxTemplateToTax'];
    return newTemplate2taxCompany.entries().map(([template, tax]) => [template.id, tax.id]);
  }

  /**
   * Update the taxes' tags (and only tags!) based on their corresponding template values.
      :param template2tax_mapping: a list of tuples (template, existing_taxes)
   * @param template2taxMapping 
   */
  async function _updateTaxesFromTemplate(template2taxMapping) {
    for (const [template, existingTax] of template2taxMapping) {
      const taxRepLines = (await existingTax.invoiceRepartitionLineIds).add(await existingTax.refundRepartitionLineIds);
      const templateRepLines = (await template.invoiceRepartitionLineIds).add(await template.refundRepartitionLineIds);
      for (const [taxLine, templateLine] of _.zip([...taxRepLines], [...templateRepLines])) {
        const tagsToAdd = await templateLine._getTagsToAdd();
        const tagsToUnlink = await taxLine.tagIds;
        if (!tagsToAdd.eq(tagsToUnlink)) {
          await taxLine.write({ 'tagIds': [[6, 0, tagsToAdd.ids]] });
          await _cleanupTags(tagsToUnlink);
        }
      }
    }
  }

  /**
   * This function uses ir_model_data to return a mapping between the templates and the data, using their xmlid
      :returns: {
          companyId: { model.template.id1: model.id1, model.template.id2: model.id2 },
          ...
      }
   * @param model 
   * @param templates 
   * @returns 
   */
  async function _getTemplateToRealXmlidMapping(model, templates) {
    const templateXmlids = Object.values<any>(await templates.getExternalId()).map(xmlid => split(xmlid, '.', 1)[1]);
    const result = new Dict();
    if (!bool(templateXmlids)) {
      return result;
    }
    await env.items('ir.model.data').flush();
    const res = await env.cr.execute(
      `
            SELECT  substr(data.label, 0, strpos(data.label, '_'))::INTEGER AS "companyId",
                    template."resId" AS "templateId",
                    data."resId" AS "modelId"
            FROM "irModelData" data
            JOIN "irModelData" template
            ON template.label = substr(data.label, strpos(data.label, '_') + 1)
            WHERE data.model = '%s'
            AND template.label IN (%s)
            -- tax.label is of the form: {companyId}_{account.tax.template.label}
            `,
      [model, String(templateXmlids)],
    );
    for (const { companyId, templateId, modelId } of res) {
      result[companyId] = result[companyId] ?? new Dict();
      result[companyId][templateId] = modelId;
    }
    return result;
  }

  /**
   * This function compares account.tax and account.tax.template repartition lines.
      A tax is considered the same as the template if they have the same:
          - amountType
          - amount
          - repartition lines percentages in the same order
   */
  async function _isTaxAndTemplateSame(template, tax) {
    const [taxAmountType, taxAmount] = await tax('amountType', 'amount');
    const [templateAmountType, templateAmount] = await template('amountType', 'amount');
    if (taxAmountType === 'group') {
      // if the amountType is group we don't do checks on rep. lines nor amount
      return taxAmountType === templateAmountType;
    }
    else {
      const taxRepLines = (await tax.invoiceRepartitionLineIds).add(await tax.refundRepartitionLineIds);
      const templateRepLines = (await template.invoiceRepartitionLineIds).add(await template.refundRepartitionLineIds);
      return taxAmountType === templateAmountType
        && taxAmount === templateAmount
        && (
          len(taxRepLines) == len(templateRepLines)
          && (await Promise.all(_.zip<any, any>(taxRepLines, templateRepLines).map(async ([repLineTax, repLineTemplate]) => await repLineTax.factorPercent == await repLineTemplate.factorPercent))).every(e => e === true)
        );
    }
  }

  /**
   * Checks if the tags are still used in taxes or move lines. If not we delete it.
   * @param tags 
   */
  async function _cleanupTags(tags) {
    for (const tag of tags) {
      const taxUsingTag = await (await env.items('account.tax.repartition.line').sudo()).search([['tagIds', 'in', tag.id]], { limit: 1 });
      const amlUsingTag = await (await env.items('account.move.line').sudo()).search([['taxTagIds', 'in', tag.id]], { limit: 1 });
      const reportLineUsingTag = await (await env.items('account.tax.report.line').sudo()).search([['tagIds', 'in', tag.id]], { limit: 1 });
      if (!(amlUsingTag.ok || taxUsingTag.ok || reportLineUsingTag.ok)) {
        await tag.unlink();
      }
    }
  }

  async function _updateFiscalPositionsFromTemplates(chartTemplate, newTaxTemplateByCompany, allTaxTemplates) {
    const fpTemplates = await env.items('account.fiscal.position.template').search([['chartTemplateId', '=', chartTemplate.id]]);
    const template2tax = await _getTemplateToRealXmlidMapping('account.tax', allTaxTemplates);
    const template2fp = await _getTemplateToRealXmlidMapping('account.fiscal.position', fpTemplates);

    for (const companyId of Object.keys(newTaxTemplateByCompany)) {
      const fpTaxTemplateVals = [];
      const template2fpCompany = template2fp[companyId];
      for (const positionTemplate of fpTemplates) {
        const fp = bool(template2fpCompany) ? env.items('account.fiscal.position').browse(template2fpCompany[positionTemplate.id]) : null;
        if (!bool(fp)) {
          continue;
        }
        for (const positionTax of await positionTemplate.taxIds) {
          const [taxSrcId, taxDestId] = await positionTax('taxSrcId', 'taxDestId');
          const positionTaxTemplateExist = await (await fp.taxIds).filtered(
            async (taxFp) => (await taxFp.taxSrcId).id == template2tax[companyId][taxSrcId.id]
              && (await taxFp.taxDestId).id == (taxDestId.ok ? template2tax[companyId][(await positionTax.taxDestId).id] : false)
          );
          if (!bool(positionTaxTemplateExist) && (
            newTaxTemplateByCompany[companyId].includes(taxSrcId)
            || newTaxTemplateByCompany[companyId].includes(taxDestId)
          )) {
            fpTaxTemplateVals.push([positionTax, {
              'taxSrcId': template2tax[companyId][taxSrcId.id],
              'taxDestId': bool(taxDestId) ? template2tax[companyId][taxDestId.id] : false,
              'positionId': fp.id,
            }]);
          }
        }
      }
      await chartTemplate._createRecordsWithXmlid('account.fiscal.position.tax', fpTaxTemplateVals, env.items('res.company').browse(companyId));
    }
  }

  /**
   * Retrieve translations for newly created taxes' name and description
      for languages of the chart_template.
      Those languages are the intersection of the spoken_languages of the chart_template
      and installed languages.
   * @param chartTemplate 
   * @param newTemplateXTaxes 
   * @returns 
   */
  async function _processTaxesTranslations(chartTemplate, newTemplateXTaxes) {
    if (!bool(newTemplateXTaxes)) {
      return;
    }
    const langs = await chartTemplate._getLangs();
    if (bool(langs)) {
      const [templateIds, taxIds] = _.zip(...newTemplateXTaxes);
      const inIds = env.items('account.tax.template').browse(templateIds);
      const outIds = env.items('account.tax').browse(taxIds);
      await chartTemplate.processTranslations(langs, 'label', inIds, outIds);
      await chartTemplate.processTranslations(langs, 'description', inIds, outIds);
    }
  }

  async function _notifyAccountantManagers(taxesToCheck) {
    const accountantManagerGroup = await env.ref("account.groupAccountManager");
    const partnerManagersIds = (await (await accountantManagerGroup.users).partnerId).ids;
    const verpbotId = (await env.ref('base.partnerRoot')).id;
    let messageBody = await this._t(
      `Please check these taxes. They might be outdated. We did not update them.
            Indeed, they do not exactly match the taxes of the original version of the localization module.<br/>
            You might want to archive or adapt them.<br/><ul>`
    );
    for (const accountTax of taxesToCheck) {
      messageBody += `<li>${escapeHtml(await accountTax.label)}</li>`;
    }
    messageBody += "</ul>"
    await env.items('mail.thread').messageNotify({
      subject: await this._t('Your taxes have been updated !'),
      authorId: verpbotId,
      body: messageBody,
      partnerIds: partnerManagersIds,
    });
  }

  async function _validateTaxesCountry(chartTemplate, template2tax) {
    for (const companyId of template2tax) {
      const company = env.items('res.company').browse(companyId);
      for (const templateId of Object.keys(template2tax[companyId])) {
        const chartCountryId = await chartTemplate.countryId;
        const tax = env.items('account.tax').browse(template2tax[companyId][templateId]);
        if ((!chartCountryId.ok || !(await tax.countryId).eq(chartCountryId)) && !tax.countryId.eq(await company.accountFiscalCountryId)) {
          throw new ValidationError(await this._t("Please check the fiscal country of company %s. (Settings > Accounting > Fiscal Country) Taxes can only be updated if they are in the company's fiscal country (%s) or the localization's country (%s).", await company.label, await (await company.accountFiscalCountryId).label, await chartCountryId.label));
        }
      }
    }
  }

  const env = await api.Environment.new(cr, global.SUPERUSER_ID);
  const chartTemplate = await env.ref(chartTemplateXmlid);
  let companies = await env.items('res.company').search([['chartTemplateId', 'childOf', chartTemplate.id]]);
  const templates = await (await env.items('account.tax.template').withContext({ activeTest: false })).search([['chartTemplateId', '=', chartTemplate.id]]);
  const template2tax = await _getTemplateToRealXmlidMapping('account.tax', templates);
  // adds companies that use the chart_template through fiscal position system
  companies = companies.union(env.items('res.company').browse(Object.keys(template2tax)));
  let outdatedTaxes = env.items('account.tax');
  const newTaxTemplateByCompany = new DefaultDict2(() => env.items('account.tax.template'))  // only contains completely new taxes (not previous taxe had the xmlid)
  const newTemplate2tax = [];  // contains all created taxes
  await _validateTaxesCountry(chartTemplate, template2tax);
  for (const company of companies) {
    const templatesToTaxCreate = [];
    const templatesToTaxUpdate = [];
    const template2oldtaxCompany = template2tax[company.id];
    for (const template of templates) {
      const tax = bool(template2oldtaxCompany) ? env.items('account.tax').browse(template2oldtaxCompany[template.id]) : null;
      if (!bool(tax) || ! await _isTaxAndTemplateSame(template, tax)) {
        templatesToTaxCreate.push([template, tax]);
        if (bool(tax)) {
          outdatedTaxes = outdatedTaxes.add(tax);
        }
        else {
          // we only want to update fiscal position if there is no previous tax with the mapping
          newTaxTemplateByCompany[company.id] = newTaxTemplateByCompany[company.id].add(template);
        }
      }
      else {
        templatesToTaxUpdate.push([template, tax])
      }
    }
    extend(newTemplate2tax, await _createTaxesFromTemplate(company, templatesToTaxCreate, templatesToTaxUpdate));
    await _updateTaxesFromTemplate(templatesToTaxUpdate);
  }
  await _updateFiscalPositionsFromTemplates(chartTemplate, newTaxTemplateByCompany, templates);
  if (bool(outdatedTaxes)) {
    await _notifyAccountantManagers(outdatedTaxes);
  }
  if (chartTemplate._fields['spokenLanguages'] && await chartTemplate.spokenLanguages) {
    await _processTaxesTranslations(chartTemplate, newTemplate2tax);
  }
  return newTemplate2tax;
}

//   Account Templates: Account, Tax, Tax Code and chart. + Wizard

@MetaModel.define()
class AccountGroupTemplate extends Model {
  static _module = module;
  static _name = "account.group.template";
  static _description = 'Template for Account Groups';
  static _order = 'codePrefixStart';

  static parentId = Fields.Many2one('account.group.template', { index: true, ondelete: 'CASCADE' });
  static label = Fields.Char({ required: true });
  static codePrefixStart = Fields.Char();
  static codePrefixEnd = Fields.Char();
  static chartTemplateId = Fields.Many2one('account.chart.template', { string: 'Chart Template', required: true });
}

@MetaModel.define()
class AccountAccountTemplate extends Model {
  static _module = module;
  static _name = "account.account.template";
  static _parents = ['mail.thread'];
  static _description = 'Templates for Accounts';
  static _order = "code";

  static label = Fields.Char({ required: true, index: true });
  static currencyId = Fields.Many2one('res.currency', { string: 'Account Currency', help: "Forces all moves for this account to have this secondary currency." });
  static code = Fields.Char({ size: 64, required: true, index: true });
  static userTypeId = Fields.Many2one('account.account.type', {
    string: 'Type', required: true,
    help: "These types are defined according to your country. The type contains more information about the account and its specificities."
  });
  static reconcile = Fields.Boolean({
    string: 'Allow Invoices & payments Matching', default: false,
    help: "Check this option if you want the user to reconcile entries in this account."
  });
  static note = Fields.Text();
  static taxIds = Fields.Many2many('account.tax.template', { relation: 'accountAccountTemplateTaxRel', column1: 'accountId', column2: 'taxId', string: 'Default Taxes' });
  static noCreate = Fields.Boolean({
    string: 'Optional Create', default: false,
    help: "If checked, the new chart of accounts will not contain this by default."
  });
  static chartTemplateId = Fields.Many2one('account.chart.template', {
    string: 'Chart Template',
    help: "This optional field allow you to link an account template to a specific chart template that may differ from the one its root parent belongs to. This allow you to define chart templates that extend another and complete it with few new accounts (You don't need to define the whole structure that is common to both several times)."
  });
  static tagIds = Fields.Many2many('account.account.tag', { relation: 'accountAccountTemplateAccountTag', string: 'Account tag', help: "Optional tags you may want to assign for custom reporting" });

  @api.depends('label', 'code')
  async nameGet() {
    const res = [];
    for (const record of this) {
      let [label, code] = await record('label', 'code');
      if (code) {
        label = code + ' ' + label;
      }
      res.push([record.id, label]);
    }
    return res;
  }
}

@MetaModel.define()
class AccountChartTemplate extends Model {
  static _module = module;
  static _name = "account.chart.template";
  static _description = "Account Chart Template";

  static label = Fields.Char({ required: true });
  static parentId = Fields.Many2one('account.chart.template', { string: 'Parent Chart Template' });
  static codeDigits = Fields.Integer({ string: '# of Digits', required: true, default: 6, help: "No. of Digits to use for account code" });
  static visible = Fields.Boolean({
    string: 'Can be Visible?', default: true,
    help: "Set this to false if you don't want this template to be used actively in the wizard that generate Chart of Accounts from templates, this is useful when you want to generate accounts of this template only when loading its child template."
  });
  static currencyId = Fields.Many2one('res.currency', { string: 'Currency', required: true });
  static useAngloSaxon = Fields.Boolean({ string: "Use Anglo-Saxon accounting", default: false });
  static completeTaxSet = Fields.Boolean({
    string: 'Complete Set of Taxes', default: true,
    help: "This boolean helps you to choose if you want to propose to the user to encode the sale and purchase rates or choose from list of taxes. This last choice assumes that the set of tax defined on this template is complete"
  });
  static accountIds = Fields.One2many('account.account.template', 'chartTemplateId', { string: 'Associated Account Templates' });
  static taxTemplateIds = Fields.One2many('account.tax.template', 'chartTemplateId', { string: 'Tax Template List', help: 'List of all the taxes that have to be installed by the wizard' });
  static bankAccountCodePrefix = Fields.Char({ string: 'Prefix of the bank accounts', required: true });
  static cashAccountCodePrefix = Fields.Char({ string: 'Prefix of the main cash accounts', required: true });
  static transferAccountCodePrefix = Fields.Char({ string: 'Prefix of the main transfer accounts', required: true });
  static incomeCurrencyExchangeAccountId = Fields.Many2one('account.account.template',
    { string: "Gain Exchange Rate Account", domain: [['internalType', '=', 'other'], ['deprecated', '=', false]] });
  static expenseCurrencyExchangeAccountId = Fields.Many2one('account.account.template',
    { string: "Loss Exchange Rate Account", domain: [['internalType', '=', 'other'], ['deprecated', '=', false]] });
  static countryId = Fields.Many2one({ string: "Country", comodelName: 'res.country', help: "The country this chart of accounts belongs to. None if it's generic." });

  static accountJournalSuspenseAccountId = Fields.Many2one('account.account.template', { string: 'Journal Suspense Account' });
  static accountJournalPaymentDebitAccountId = Fields.Many2one('account.account.template', { string: 'Journal Outstanding Receipts Account' });
  static accountJournalPaymentCreditAccountId = Fields.Many2one('account.account.template', { string: 'Journal Outstanding Payments Account' });

  static defaultCashDifferenceIncomeAccountId = Fields.Many2one('account.account.template', { string: "Cash Difference Income Account" });
  static defaultCashDifferenceExpenseAccountId = Fields.Many2one('account.account.template', { string: "Cash Difference Expense Account" });
  static defaultPosReceivableAccountId = Fields.Many2one('account.account.template', { string: "PoS receivable account" });

  static propertyAccountReceivableId = Fields.Many2one('account.account.template', { string: 'Receivable Account' });
  static propertyAccountPayableId = Fields.Many2one('account.account.template', { string: 'Payable Account' });
  static propertyAccountExpenseCategId = Fields.Many2one('account.account.template', { string: 'Category of Expense Account' });
  static propertyAccountIncomeCategId = Fields.Many2one('account.account.template', { string: 'Category of Income Account' });
  static propertyAccountExpenseId = Fields.Many2one('account.account.template', { string: 'Expense Account on Product Template' });
  static propertyAccountIncomeId = Fields.Many2one('account.account.template', { string: 'Income Account on Product Template' });
  static propertyStockAccountInputCategId = Fields.Many2one('account.account.template', { string: "Input Account for Stock Valuation" });
  static propertyStockAccountOutputCategId = Fields.Many2one('account.account.template', { string: "Output Account for Stock Valuation" });
  static propertyStockValuationAccountId = Fields.Many2one('account.account.template', { string: "Account Template for Stock Valuation" });
  static propertyTaxPayableAccountId = Fields.Many2one('account.account.template', { string: "Tax current account (payable)" });
  static propertyTaxReceivableAccountId = Fields.Many2one('account.account.template', { string: "Tax current account (receivable)" });
  static propertyAdvanceTaxPaymentAccountId = Fields.Many2one('account.account.template', { string: "Advance tax payment account" });
  static propertyCashBasisBaseAccountId = Fields.Many2one({
    comodelName: 'account.account.template',
    domain: [['deprecated', '=', false]],
    string: "Base Tax Received Account",
    help: "Account that will be set on lines created in cash basis journal entry and used to keep track of the tax base amount."
  });

  /**
   * Prepare values to create the transfer account that is an intermediary account used when moving money
      from a liquidity account to another.

      :return:    A dictionary of values to create a new account.account.
   * @param prefix 
   * @returns 
   */
  @api.model()
  async _prepareTransferAccountTemplate(prefix?: string) {
    const digits = await this['codeDigits'];
    prefix = prefix || await this['transferAccountCodePrefix'] || '';
    // Flatten the hierarchy of chart templates.
    let chartTemplate: any = this;
    let chartTemplates: any = this;
    let parentId = await chartTemplate.parentId;
    while (bool(parentId)) {
      chartTemplates = chartTemplates.add(parentId);
      chartTemplate = chartTemplate.add(parentId);
      parentId = await chartTemplate.parentId;
    }
    let newCode = '';
    let done = true;
    for (const num of range(1, 100)) {
      newCode = prefix.padEnd(digits - 1, '0') + String(num);
      const rec = await this.env.items('account.account.template').search(
        [['code', '=', newCode], ['chartTemplateId', 'in', chartTemplates.ids]], { limit: 1 });
      if (!rec.ok) {
        done = false;
        break;
      }
    }
    if (done) {
      throw new UserError(await this._t('Cannot generate an unused account code.'));
    }
    const currentAssetsType = await this.env.ref('account.dataAccountTypeCurrentAssets', false);
    return {
      'label': await this._t('Liquidity Transfer'),
      'code': newCode,
      'userTypeId': bool(currentAssetsType) && bool(currentAssetsType.id) ? currentAssetsType.id : false,
      'reconcile': true,
      'chartTemplateId': this.id,
    }
  }

  @api.model()
  async _createLiquidityJournalSuspenseAccount(company, codeDigits) {
    return this.env.items('account.account').create({
      'label': await this._t("Bank Suspense Account"),
      'code': await this.env.items('account.account')._searchNewAccountCode(company, codeDigits, await company.bankAccountCodePrefix || ''),
      'userTypeId': (await this.env.ref('account.dataAccountTypeCurrentAssets')).id,
      'companyId': company.id,
    });
  }

  /**
   * Installs this chart of accounts for the current company if not chart
      of accounts had been created for it yet.

      :param company (Model<res.company>): the company we try to load the chart template on.
          If not provided, it is retrieved from the context.
      :param install_demo (bool): whether or not we should load demo data right after loading the
          chart template.
   * @param company 
   * @param installDemo 
   */
  async tryLoading(opts: {req?: any, company?: any, installDemo?: boolean}={}) {
    const _debug = global.logDebug;
    global.logDebug = true;
    // do not use `request.env` here, it can cause deadlocks
    const req = opts.req;
    let company = opts.company;
    if (!bool(company)) {
      if (req && req['allowedCompanyIds']) {
        company = this.env.items('res.company').browse(req.allowedCompanyIds[0]);
      }
      else {
        company = await this.env.company();
      }
    }
    // If we don't have any chart of account on this company, install this chart of account
    if (!(await company.chartTemplateId).ok && ! await this.existingAccounting(company)) {
      for (const template of this) {
        await (await template.withContext({ default_companyId: company.id }))._load(15.0, 15.0, company);
      }
      // Install the demo data when the first localization is instanciated on the company
      if (opts.installDemo && await (await this.env.ref('base.module_account')).demo) {
        await (await this.withContext({
          default_companyId: company.id,
          allowedCompanyIds: [company.id],
        }))._createDemoData();
      }
    }
    global.logDebug = _debug;
  }

  async _createDemoData() {
    try {
      // with this.env.cr.savepoint():
      const demoData = this['_getDemoData'];
      for await (const [model, data] of demoData) {
        const created = await this.env.items(model)._loadRecords(Object.entries(data).map(([xmlid, record]) => {
          return {
            'xmlid': !xmlid.includes('.') ? f("account.%s", xmlid) : xmlid,
            'values': record,
            'noupdate': true,
          }
        }));
        await this['_postCreateDemoData'](created);
      }
    } catch (e) {
      // Do not rollback installation of CoA if demo data failed
      console.error('Error while loading accounting demo data', e);
    }
  }

  /**
   * Installs this chart of accounts on the current company, replacing
      the existing one if it had already one defined. If some accounting entries
      had already been made, this function fails instead, triggering a UserError.

      Also, note that this function can only be run by someone with administration
      rights.
   * @param saleTaxRate 
   * @param purchaseTaxRate 
   * @param company 
   */
  async _load(saleTaxRate, purchaseTaxRate, company) {
    this.ensureOne();
    // do not use `request.env` here, it can cause deadlocks
    // Ensure everything is translated to the company's language, not the user's one.
    let self = this;
    self = await (await self.withContext({ lang: await (await company.partnerId).lang })).withCompany(company);
    if (! await self.env.isAdmin()) {
      throw new AccessError(await this._t("Only administrators can load a chart of accounts"));
    }
    const existingAccounts = await self.env.items('account.account').search([['companyId', '=', company.id]]);
    if (existingAccounts.ok) {
      // we tolerate switching from accounting package (localization module) as long as there isn't yet any accounting
      // entries created for the company.
      if (await self.existingAccounting(company)) {
        throw new UserError(await this._t('Could not install new chart of account as there are already accounting entries existing.'));
      }

      // delete accounting properties
      const propValues = existingAccounts.ids.map(accountId => f('account.account,%s', accountId,));
      const existingJournals = await self.env.items('account.journal').search([['companyId', '=', company.id]]);
      if (existingJournals) {
        extend(propValues, existingJournals.ids.map(journalId => f('account.journal,%s', journalId)));
      }
      await (await (await self.env.items('ir.property').sudo()).search(
        [['valueReference', 'in', propValues]]
      )).unlink();

      // delete account, journal, tax, fiscal position and reconciliation model
      const modelsToDelete = ['account.reconcile.model', 'account.fiscal.position', 'account.move.line', 'account.move', 'account.journal', 'account.tax', 'account.group'];
      for (const model of modelsToDelete) {
        const res = await (await self.env.items(model).sudo()).search([['companyId', '=', company.id]]);
        if (len(res)) {
          await (await res.withContext({ forceDelete: true })).unlink();
        }
      }
      await existingAccounts.unlink();
    }
    const [codeDigits, bankAccountCodePrefix, cashAccountCodePrefix, transferAccountCodePrefix, currencyId, useAngloSaxon, countryId] = await self('codeDigits', 'bankAccountCodePrefix', 'cashAccountCodePrefix', 'transferAccountCodePrefix', 'currencyId', 'useAngloSaxon', 'countryId');

    await company.write({
      'currencyId': currencyId.id,
      'angloSaxonAccounting': useAngloSaxon,
      'bankAccountCodePrefix': bankAccountCodePrefix,
      'cashAccountCodePrefix': cashAccountCodePrefix,
      'transferAccountCodePrefix': transferAccountCodePrefix,
      'chartTemplateId': self.id
    });

    //set the coa currency to active
    await currencyId.write({ 'active': true });

    // When we install the CoA of first company, set the currency to price types and pricelists
    if (company.id == 1) {
      for (const reference of ['product.listPrice', 'product.standardPrice', 'product.list0']) {
        try {
          const tmp2 = await (await self.env.ref(reference)).write({ 'currencyId': currencyId.id });
        } catch (e) {
          // except ValueError:
          // pass
        }
      }
    }

    // If the floats for sale/purchase rates have been filled, create templates from them
    await self._createTaxTemplatesFromRates(company.id, saleTaxRate, purchaseTaxRate);
    // Set the fiscal country before generating taxes in case the company does not have a countryId set yet
    if (countryId.ok) {
      // If this CoA is made for only one country, set it as the fiscal country of the company.
      await company.set('accountFiscalCountryId', countryId);
    }
    else if (!(await company.accountFiscalCountryId).ok) {
      await company.set('accountFiscalCountryId', await self.env.ref('base.us'));
    }

    // Install all the templates objects and generate the real objects
    const [accTemplateRef] = await self._installTemplate(company, { codeDigits: codeDigits });

    // Set default cash difference account on company
    if (!(await company.accountJournalSuspenseAccountId).ok) {
      await company.set('accountJournalSuspenseAccountId', await self._createLiquidityJournalSuspenseAccount(company, codeDigits));
    }

    const accountTypeCurrentAssets = await self.env.ref('account.dataAccountTypeCurrentAssets');
    if (!(await company.accountJournalPaymentDebitAccountId).ok) {
      await company.set('accountJournalPaymentDebitAccountId', await self.env.items('account.account').create({
        'label': await this._t("Outstanding Receipts"),
        'code': await self.env.items('account.account')._searchNewAccountCode(company, codeDigits, await company.bankAccountCodePrefix || ''),
        'reconcile': true,
        'userTypeId': accountTypeCurrentAssets.id,
        'companyId': company.id,
      }));
    }

    if (!(await company.accountJournalPaymentCreditAccountId).ok) {
      await company.set('accountJournalPaymentCreditAccountId', await self.env.items('account.account').create({
        'label': await this._t("Outstanding Payments"),
        'code': await self.env.items('account.account')._searchNewAccountCode(company, codeDigits, await company.bankAccountCodePrefix || ''),
        'reconcile': true,
        'userTypeId': accountTypeCurrentAssets.id,
        'companyId': company.id,
      }));
    }

    if (!(await company.defaultCashDifferenceExpenseAccountId).ok) {
      await company.set('defaultCashDifferenceExpenseAccountId', await self.env.items('account.account').create({
        'label': await this._t('Cash Difference Loss'),
        'code': await self.env.items('account.account')._searchNewAccountCode(company, codeDigits, '999'),
        'userTypeId': (await self.env.ref('account.dataAccountTypeExpenses')).id,
        'tagIds': [[6, 0, (await self.env.ref('account.accountTagInvesting')).ids]],
        'companyId': company.id,
      }));
    }

    if (!(await company.defaultCashDifferenceIncomeAccountId).ok) {
      await company.set('defaultCashDifferenceIncomeAccountId', await self.env.items('account.account').create({
        'label': await this._t('Cash Difference Gain'),
        'code': await self.env.items('account.account')._searchNewAccountCode(company, codeDigits, '999'),
        'userTypeId': (await self.env.ref('account.dataAccountTypeRevenue')).id,
        'tagIds': [[6, 0, (await self.env.ref('account.accountTagInvesting')).ids]],
        'companyId': company.id,
      }));
    }

    // Set the transfer account on the company
    await company.set('transferAccountId', await self.env.items('account.account').search([
      ['code', '=like', transferAccountCodePrefix + '%'], ['companyId', '=', company.id]], { limit: 1 }));

    // Create Bank journals
    await self._createBankJournals(company, accTemplateRef);

    // Create the current year earning account if it wasn't present in the CoA
    await company.getUnaffectedEarningsAccount();

    // set the default taxes on the company
    await company.set('accountSaleTaxId', (await self.env.items('account.tax').search([['typeTaxUse', 'in', ['sale', 'all']], ['companyId', '=', company.id]], { limit: 1 })).id);
    await company.set('accountPurchaseTaxId', (await self.env.items('account.tax').search([['typeTaxUse', 'in', ['purchase', 'all']], ['companyId', '=', company.id]], { limit: 1 })).id);

    return {};
  }

  /**
   * Returns true iff some accounting entries have already been made for
      the provided company (meaning hence that its chart of accounts cannot
      be changed anymore).
   * @param companyId 
   */
  @api.model()
  async existingAccounting(companyId) {
    const modelToCheck = ['account.payment', 'account.bank.statement'];
    for (const model of modelToCheck) {
      if ((await (await this.env.items(model).sudo()).search([['companyId', '=', companyId.id]], { order: "id DESC", limit: 1 })).ok) {
        return true;
      }
    }
    if ((await (await this.env.items('account.move').sudo()).search([['companyId', '=', companyId.id], ['state', '!=', 'draft']], { order: "id DESC", limit: 1 })).ok) {
      return true;
    }
    return false;
  }

  /**
   * This function checks if this chart template is configured as containing a full set of taxes, and if
      it's not the case, it creates the templates for account.tax object accordingly to the provided sale/purchase rates.
      Then it saves the new tax templates as default taxes to use for this chart template.

      :param companyId: id of the company for which the wizard is running
      :param saleTaxRate: the rate to use for created sales tax
      :param purchaseTaxRate: the rate to use for created purchase tax
      :return: true
   * @param companyId 
   * @param saleTaxRate 
   * @param purchaseTaxRate 
   * @returns 
   */
  async _createTaxTemplatesFromRates(companyId, saleTaxRate: number, purchaseTaxRate: number) {
    this.ensureOne();
    const objTaxTemp = this.env.items('account.tax.template');
    const allParents = await this._getChartParentIds();
    // create tax templates from purchase_tax_rate and sale_tax_rate fields
    if (! await this['completeTaxSet']) {
      let refTaxs = await objTaxTemp.search([['typeTaxUse', '=', 'sale'], ['chartTemplateId', 'in', allParents]], { order: "sequence, id desc", limit: 1 });
      await refTaxs.write({ 'amount': saleTaxRate, 'label': await this._t('Tax %s%', saleTaxRate.toFixed(2)), 'description': f('%s%', saleTaxRate.toFixed(2)) });
      refTaxs = await objTaxTemp.search([['typeTaxUse', '=', 'purchase'], ['chartTemplateId', 'in', allParents]], { order: "sequence, id desc", limit: 1 });
      await refTaxs.write({ 'amount': purchaseTaxRate, 'label': await this._t('Tax %s%', purchaseTaxRate.toFixed(2)), 'description': f('%s%', purchaseTaxRate.toFixed(2)) });
    }
    return true;
  }

  /**
   * Returns the IDs of all ancestor charts, including the chart itself.
          (inverse of childOf operator)

          :return: the IDS of all ancestor charts, including the chart itself.
   * @returns 
   */
  async _getChartParentIds() {
    let chartTemplate: any = this;
    const result = [chartTemplate.id];
    while ((await chartTemplate.parentId).ok) {
      chartTemplate = chartTemplate.parentId;
      result.push(chartTemplate.id);
    }
    return result;
  }

  /**
   *         This function creates bank journals and their account for each line
      data returned by the function _get_default_bank_journals_data.

      :param company: the company for which the wizard is running.
      :param acc_template_ref: the dictionary containing the mapping between the ids of account templates and the ids
          of the accounts that have been generated from them.

   * @param company 
   * @param accTemplateRef 
   * @returns 
   */
  async _createBankJournals(company, accTemplateRef) {
    this.ensureOne();
    let bankJournals = this.env.items('account.journal');
    // Create the journals that will trigger the account.account creation
    for (const acc of await this._getDefaultBankJournalsData()) {
      bankJournals = bankJournals.add(await this.env.items('account.journal').create({
        'label': acc['accName'],
        'type': acc['accountType'],
        'companyId': company.id,
        'currencyId': (acc['currencyId'] ?? this.env.items('res.currency')).id,
        'sequence': 10,
      }));
    }

    return bankJournals;
  }

  /**
   * Returns the data needed to create the default bank journals when
      installing this chart of accounts, in the form of a list of dictionaries.
      The allowed keys in these dictionaries are:
          - accName: string (mandatory)
          - accountType: 'cash' or 'bank' (mandatory)
          - currencyId (optional, only to be specified if != company.currencyId)
   * @returns 
   */
  @api.model()
  async _getDefaultBankJournalsData() {
    return [{ 'accName': await this._t('Cash'), 'accountType': 'cash' }, { 'accName': await this._t('Bank'), 'accountType': 'bank' }];
  }

  /**
   * Prepare values to create a transfer account directly, based on the
      method _prepare_transfer_account_template().

      This is needed when dealing with installation of payment modules
      that requires the creation of their own transfer account.

      :param name:        The transfer account name.
      :param company:     The company owning this account.
      :return:            A dictionary of values to create a new account.account.
   * @param name 
   * @param company 
   * @returns 
   */
  @api.model()
  async _prepareTransferAccountForDirectCreation(name, company) {
    const vals = await this._prepareTransferAccountTemplate();
    const digits = await this['codeDigits'] || 6;
    const prefix = await this['transferAccountCodePrefix'] || '';
    update(vals, {
      'code': await this.env.items('account.account')._searchNewAccountCode(company, digits, prefix),
      'label': name,
      'companyId': company.id,
    })
    delete vals['chartTemplateId'];
    return vals;
  }

  /**
   * This method is used for creating journals.

      :param acc_template_ref: Account templates reference.
      :param companyId: company to generate journals for.
      :returns: true
   * @param accTemplateRef 
   * @param company 
   * @param journalsDict 
   * @returns 
   */
  @api.model()
  async generateJournals(accTemplateRef, company, journalsDict?: any) {
    const journalObj = this.env.items('account.journal');
    for (const valsJournal of await this._prepareAllJournals(accTemplateRef, company, journalsDict)) {
      const journal = await journalObj.create(valsJournal);
      if (valsJournal['type'] === 'general' && valsJournal['code'] === await this._t('EXCH')) {
        await company.write({ 'currencyExchangeJournalId': journal.id });
      }
      if (valsJournal['type'] === 'general' && valsJournal['code'] === await this._t('CABA')) {
        await company.write({ 'taxCashBasisJournalId': journal.id });
      }
    }
    return true;
  }

  async _prepareAllJournals(accTemplateRef, company, journalsDict?: any) {
    const self = this;
    async function _getDefaultAccount(journal, type: string = 'debit') {
      // Get the default accounts
      let defaultAccount = false;
      if (journal['type'] === 'sale') {
        defaultAccount = accTemplateRef.get(await self['propertyAccountIncomeCategId']).id;
      }
      else if (journal['type'] === 'purchase') {
        defaultAccount = accTemplateRef.get(await self['propertyAccountExpenseCategId']).id;
      }
      return defaultAccount;
    }

    const journals = [{ 'label': await this._t('Customer Invoices'), 'type': 'sale', 'code': await this._t('INV'), 'favorite': true, 'color': 11, 'sequence': 5 },
    { 'label': await this._t('Vendor Bills'), 'type': 'purchase', 'code': await this._t('BILL'), 'favorite': true, 'color': 11, 'sequence': 6 },
    { 'label': await this._t('Miscellaneous Operations'), 'type': 'general', 'code': await this._t('MISC'), 'favorite': true, 'sequence': 7 },
    { 'label': await this._t('Exchange Difference'), 'type': 'general', 'code': await this._t('EXCH'), 'favorite': false, 'sequence': 9 },
    { 'label': await this._t('Cash Basis Taxes'), 'type': 'general', 'code': await this._t('CABA'), 'favorite': false, 'sequence': 10 }];
    if (journalsDict != null) {
      extend(journals, journalsDict);
    }
    this.ensureOne();
    const journalData = [];
    for (const journal of journals) {
      const vals = {
        'type': journal['type'],
        'label': journal['label'],
        'code': journal['code'],
        'companyId': company.id,
        'defaultAccountId': await _getDefaultAccount(journal),
        'showOnDashboard': journal['favorite'],
        'color': journal['color'] || false,
        'sequence': journal['sequence']
      }
      journalData.push(vals);
    }
    return journalData;
  }

  /**
   * This method used for creating properties.

      :param acc_template_ref: Mapping between ids of account templates and real accounts created from them
      :param companyId: company to generate properties for.
      :returns: true
   * @param accTemplateRef 
   * @param company 
   * @returns 
   */
  async generateProperties(accTemplateRef, company) {
    this.ensureOne();
    const propertyObj = this.env.items('ir.property');
    const todoList = [
      ['propertyAccountReceivableId', 'res.partner'],
      ['propertyAccountPayableId', 'res.partner'],
      ['propertyAccountExpenseCategId', 'product.category'],
      ['propertyAccountIncomeCategId', 'product.category'],
      ['propertyAccountExpenseId', 'product.template'],
      ['propertyAccountIncomeId', 'product.template'],
      ['propertyTaxPayableAccountId', 'account.tax.group'],
      ['propertyTaxReceivableAccountId', 'account.tax.group'],
      ['propertyAdvanceTaxPaymentAccountId', 'account.tax.group'],
    ]
    for (const [field, model] of todoList) {
      const account = await this[field];
      let value = bool(account) && accTemplateRef.get(account).id;
      value = bool(value) ? value : false;
      if (value) {
        await propertyObj._setDefault(field, model, value, company);
      }
    }
    const stockProperties = [
      'propertyStockAccountInputCategId',
      'propertyStockAccountOutputCategId',
      'propertyStockValuationAccountId',
    ]
    for (const stockProperty of stockProperties) {
      const account = await this[stockProperty];
      const value = bool(account) ? accTemplateRef.get(account).id : false;
      if (value) {
        await company.write({ [stockProperty]: value });
      }
    }
    return true;
  }


  /**
   * Recursively load the template objects and create the real objects from them.

          :param company: company the wizard is running for
          :param code_digits: number of digits the accounts code should have in the COA
          :param obj_wizard: the current wizard for generating the COA from the templates
          :param acc_ref: Mapping between ids of account templates and real accounts created from them
          :param taxes_ref: Mapping between ids of tax templates and real taxes created from them
          :returns: tuple with a dictionary containing
              * the mapping between the account template ids and the ids of the real accounts that have been generated
                from them, as first item,
              * a similar dictionary for mapping the tax templates and taxes, as second item,
          :rtype: tuple(dict, dict, dict)
   * @param company 
   * @param options 
   * @returns 
   */
  async _installTemplate(company, options: { codeDigits?: any, objWizard?: any, accRef?: any, taxesRef?: any } = {}) {
    this.ensureOne();
    if (options.accRef == null) {
      options.accRef = new MapKey<any, any>();
    }
    if (options.taxesRef == null) {
      options.taxesRef = new MapKey<any, any>();
    }
    if ((await this['parentId']).ok) {
      const [tmp1, tmp2] = await (await this['parentId'])._installTemplate(company, options);
      update(options.accRef, tmp1);
      update(options.taxesRef, tmp2);
    }
    // Ensure, even if individually, that everything is translated according to the company's language.
    const [tmp1, tmp2] = await (await this.withContext({ lang: await (await company.partnerId).lang }))._loadTemplate(company, options);
    update(options.accRef, tmp1);
    update(options.taxesRef, tmp2);
    return [options.accRef, options.taxesRef];
  }

  /**
   * Generate all the objects from the templates

          :param company: company the wizard is running for
          :param codeDigits: number of digits the accounts code should have in the COA
          :param accRef: Mapping between ids of account templates and real accounts created from them
          :param taxesRef: Mapping between ids of tax templates and real taxes created from them
          :returns: tuple with a dictionary containing
              * the mapping between the account template ids and the ids of the real accounts that have been generated
                from them, as first item,
              * a similar dictionary for mapping the tax templates and taxes, as second item,
          :rtype: tuple(dict, dict, dict)
   * @param company 
   * @param options 
   * @returns 
   */
  async _loadTemplate(company, options: { codeDigits?: any, objWizard?: any, accRef?: any, taxesRef?: any } = {}) {
    this.ensureOne();
    if (options.accRef == null) {
      options.accRef = new MapKey();
    }
    if (options.taxesRef == null) {
      options.taxesRef = new MapKey();
    }
    if (!options.codeDigits) {
      options.codeDigits = await this['codeDigits'];
    }
    // const accountTaxObj = this.env.items('account.tax');

    // Generate taxes from templates.
    const generatedTaxRes = await (await (await this.withContext({ activeTest: false })).taxTemplateIds)._generateTax(company);
    update(options.taxesRef, generatedTaxRes['taxTemplateToTax']);

    // Generating Accounts from templates.
    const accountTemplateRef = await this.generateAccount(options.taxesRef, options.accRef, options.codeDigits, company);
    update(options.accRef, accountTemplateRef);

    // Generate account groups, from template
    await this.generateAccountGroups(company);

    // writing account values after creation of accounts
    for (const [tax, value] of generatedTaxRes['accountDict']['account.tax']) {
      if (bool(value['cashBasisTransitionAccountId'])) {
        await tax.set('cashBasisTransitionAccountId', options.accRef.get(value['cashBasisTransitionAccountId']));
      }
    }
    for (const [repartitionLine, value] of generatedTaxRes['accountDict']['account.tax.repartition.line']) {
      if (bool(value['accountId'])) {
        await repartitionLine.set('accountId', options.accRef.get(value['accountId']));
      }
    }

    // Set the company accounts
    await this._loadCompanyAccounts(options.accRef, company);

    // Create Journals - Only done for root chart template
    if (!(await this['parentId']).ok) {
      await this.generateJournals(options.accRef, company);
    }

    // generate properties function
    await this.generateProperties(options.accRef, company);

    // Generate Fiscal Position , Fiscal Position Accounts and Fiscal Position Taxes from templates
    await this.generateFiscalPosition(options.taxesRef, options.accRef, company);

    // Generate account operation template templates
    await this.generateAccountReconcileModel(options.taxesRef, options.accRef, company);

    return [options.accRef, options.taxesRef];
  }

  async _loadCompanyAccounts(accRef, company) {
    // Set the default accounts on the company
    const self: any = this;
    const accounts = {
      'defaultCashDifferenceIncomeAccountId': await self.defaultCashDifferenceIncomeAccountId,
      'defaultCashDifferenceExpenseAccountId': await self.defaultCashDifferenceExpenseAccountId,
      'accountJournalSuspenseAccountId': await self.accountJournalSuspenseAccountId,
      'accountJournalPaymentDebitAccountId': await self.accountJournalPaymentDebitAccountId,
      'accountJournalPaymentCreditAccountId': await self.accountJournalPaymentCreditAccountId,
      'accountCashBasisBaseAccountId': await self.propertyCashBasisBaseAccountId,
      'accountDefaultPosReceivableAccountId': await self.defaultPosReceivableAccountId,
      'incomeCurrencyExchangeAccountId': await self.incomeCurrencyExchangeAccountId,
      'expenseCurrencyExchangeAccountId': await self.expenseCurrencyExchangeAccountId,
    }

    const values = {};

    // The loop is to avoid writing when we have no values, thus avoiding erasing the account from the parent
    for (const [key, account] of Object.entries(accounts)) {
      if (bool(accRef.get(account))) {
        values[key] = accRef.get(account);
      }
    }

    await company.write(values);
  }

  async createRecordWithXmlid(company, template, model, vals) {
    return (await this._createRecordsWithXmlid(model, [[template, vals]], company)).id;
  }

  /**
   * Create records for the given model name with the given vals, and
          create xml ids based on each record's template and company id.
   * @param model 
   * @param templateVals 
   * @param company 
   * @returns 
   */
  async _createRecordsWithXmlid(model: string, templateVals: [any, any][], company: any) {
    if (!templateVals.length) {
      return this.env.items(model);
    }
    const templateModel = templateVals[0][0];
    const templateIds = templateVals.map(([template, vals]) => template.id);
    const templateXmlids = await templateModel.browse(templateIds).getExternalId();
    const dataList = [];
    for (const [template, vals] of templateVals) {
      const [module, name] = split(templateXmlids[template.id], '.', 1);
      const xmlid = f("%s.%s_%s", module, company.id, name);
      dataList.push({ xmlid: xmlid, values: vals, noupdate: true });
    }
    return this.env.items(model)._loadRecords(dataList);
  }

  @api.model()
  async _loadRecords(dataList, update: boolean = false) {
    // When creating a chart template create, for the liquidity transfer account
    //  - an account.account.template: this allow to define account.reconcile.model.template objects refering that liquidity transfer
    //    account although it's not existing in any xml file
    //  - an entry in ir_model_data: this allow to still use the method create_record_with_xmlid() and don't make any difference between
    //    regular accounts created and that liquidity transfer account
    const records = await _super(AccountChartTemplate, this)._loadRecords(dataList, update);
    const accountDataList = [];
    for (const [data, record] of _.zip(dataList, [...records])) {
      // Create the transfer account only for leaf chart template in the hierarchy.
      if (bool(await record.parentId)) {
        continue;
      }
      if (data['xmlid']) {
        const accountXmlid = data['xmlid'] + '_liquidityTransfer';
        if (!bool(await this.env.ref(accountXmlid, false))) {
          const accountVals = await record._prepareTransferAccountTemplate();
          accountDataList.push({
            xmlid: accountXmlid,
            values: accountVals,
            noupdate: data['noupdate'],
          });
        }
      }
    }
    await this.env.items('account.account.template')._loadRecords(accountDataList, update);
    return records;
  }

  /**
   * This method generates a dictionary of all the values for the account that will be created.
   * @param company 
   * @param accountTemplate 
   * @param codeAcc 
   * @param taxTemplateRef 
   * @returns 
   */
  async _getAccountVals(company, accountTemplate, codeAcc, taxTemplateRef: MapKey<any, any>) {
    this.ensureOne();
    const taxIds = [];
    for (const tax of await accountTemplate.taxIds) {
      taxIds.push(taxTemplateRef.get(tax).id);
    }
    const currencyId = (await accountTemplate.currencyId).id; 
    const userTypeId = (await accountTemplate.userTypeId).id;
    const val = {
      'label': await accountTemplate.label,
      'currencyId': bool(currencyId) ? currencyId : false,
      'code': codeAcc,
      'userTypeId': bool(userTypeId) ? userTypeId : false,
      'reconcile': await accountTemplate.reconcile,
      'note': await accountTemplate.note,
      'taxIds': [[6, 0, taxIds]],
      'companyId': company.id,
      'tagIds': [[6, 0, await (await accountTemplate.tagIds).map(t => t.id)]],
    }
    return val;
  }


  /**
   * This method generates accounts from account templates.

      :param tax_template_ref: Taxes templates reference for write taxesId in account_account.
      :param acc_template_ref: dictionary containing the mapping between the account templates and generated accounts (will be populated)
      :param code_digits: number of digits to use for account code.
      :param companyId: company to generate accounts for.
      :returns: return acc_template_ref for reference purpose.
      :rtype: dict
   * @param taxTemplateRef 
   * @param accTemplateRef 
   * @param codeDigits 
   * @param company 
   * @returns 
   */
  async generateAccount(taxTemplateRef, accTemplateRef, codeDigits, company) {
    this.ensureOne();
    const accountTmplObj = this.env.items('account.account.template');
    const accTemplate = await accountTmplObj.search([['noCreate', '!=', true], ['chartTemplateId', '=', this.id]], { order: 'id' });
    const templateVals = [];
    for (const accountTemplate of accTemplate) {
      const codeMain = await accountTemplate.code ? len(await accountTemplate.code) : 0;
      let codeAcc: string = await accountTemplate.code || '';
      if (codeMain > 0 && codeMain <= codeDigits) {
        codeAcc = codeAcc.padEnd(codeDigits - codeMain, '0');
      }
      const vals = await this._getAccountVals(company, accountTemplate, codeAcc, taxTemplateRef);
      templateVals.push([accountTemplate, vals]);
    }
    const accounts = await this._createRecordsWithXmlid('account.account', templateVals, company);
    for (const [template, account] of _.zip<any, any>([...accTemplate], [...accounts])) {
      accTemplateRef.set(template, account);
    }
    return accTemplateRef;
  }

  /**
   * This method generates account groups from account groups templates.
      :param company: company to generate the account groups for
   * @param company 
   */
  async generateAccountGroups(company) {
    this.ensureOne();
    const groupTemplates = await this.env.items('account.group.template').search([['chartTemplateId', '=', this.id]]);
    const templateVals = [];
    for (const groupTemplate of groupTemplates) {
      const vals = {
        'label': await groupTemplate.label,
        'codePrefixStart': await groupTemplate.codePrefixStart,
        'codePrefixEnd': await groupTemplate.codePrefixEnd,
        'companyId': company.id,
      }
      templateVals.push([groupTemplate, vals]);
    }
    const groups = await this._createRecordsWithXmlid('account.group', templateVals, company);
  }

  /**
   * This method generates a dictionary of all the values for the account.reconcile.model that will be created.
   * @param company 
   * @param accountReconcileModel 
   * @param accTemplateRef 
   * @param taxTemplateRef 
   * @returns 
   */
  async _prepareReconcileModelVals(company, accountReconcileModel, accTemplateRef: MapKey<any, any>, taxTemplateRef: MapKey<any, any>) {
    this.ensureOne();
    const accountReconcileModelLines = await this.env.items('account.reconcile.model.line.template').search([
      ['modelId', '=', accountReconcileModel.id]
    ]);
    return {
      'label': await accountReconcileModel.label,
      'sequence': await accountReconcileModel.sequence,
      'companyId': company.id,
      'ruleType': await accountReconcileModel.ruleType,
      'autoReconcile': await accountReconcileModel.autoReconcile,
      'toCheck': accountReconcileModel.to_check,
      'matchJournalIds': [[6, null, (await accountReconcileModel.matchJournalIds).ids]],
      'matchNature': await accountReconcileModel.matchNature,
      'matchAmount': await accountReconcileModel.matchAmount,
      'matchAmountMin': await accountReconcileModel.matchAmountMin,
      'matchAmountMax': await accountReconcileModel.matchAmountMax,
      'matchLabel': await accountReconcileModel.matchLabel,
      'matchLabelParam': await accountReconcileModel.matchLabelParam,
      'matchNote': await accountReconcileModel.matchNote,
      'matchNoteParam': await accountReconcileModel.matchNoteParam,
      'matchTransactionType': await accountReconcileModel.matchTransactionType,
      'matchTransactionTypeParam': await accountReconcileModel.matchTransactionTypeParam,
      'matchSameCurrency': await accountReconcileModel.matchSameCurrency,
      'allowPaymentTolerance': await accountReconcileModel.allowPaymentTolerance,
      'paymentToleranceType': await accountReconcileModel.paymentToleranceType,
      'paymentToleranceParam': await accountReconcileModel.paymentToleranceParam,
      'matchPartner': await accountReconcileModel.matchPartner,
      'matchPartnerIds': [[6, null, (await accountReconcileModel.matchPartnerIds).ids]],
      'matchPartnerCategoryIds': [[6, null, (await accountReconcileModel.matchPartnerCategoryIds).ids]],
      'lineIds': await accountReconcileModelLines.map(async line => [0, 0, {
        'accountId': accTemplateRef.get(await line.accountId).id,
        'label': await line.label,
        'amountType': await line.amountType,
        'forceTaxIncluded': await line.forceTaxIncluded,
        'amountString': await line.amountString,
        'taxIds': await (await line.taxIds).map(async (tax) => [4, taxTemplateRef.get(tax).id, 0]),
      }]),
    }
  }

  /**
   * This method creates account reconcile models

      :param tax_template_ref: Taxes templates reference for write taxesId in account_account.
      :param acc_template_ref: dictionary with the mapping between the account templates and the real accounts.
      :param companyId: company to create models for
      :returns: return new_account_reconcile_model for reference purpose.
      :rtype: dict
   * @param taxTemplateRef 
   * @param accTemplateRef 
   * @param company 
   */
  async generateAccountReconcileModel(taxTemplateRef: MapKey<any, any>, accTemplateRef: MapKey<any, any>, company) {
    this.ensureOne();
    const accountReconcileModels = await this.env.items('account.reconcile.model.template').search([
      ['chartTemplateId', '=', this.id]
    ]);
    for (const accountReconcileModel of accountReconcileModels) {
      const vals = await this._prepareReconcileModelVals(company, accountReconcileModel, accTemplateRef, taxTemplateRef);
      await this.createRecordWithXmlid(company, accountReconcileModel, 'account.reconcile.model', vals);
    }

    // Create default rules for the reconciliation widget matching invoices automatically.
    if (!(await this['parentId']).ok) {
      await (await this.env.items('account.reconcile.model').sudo()).create({
        "label": await this._t('Invoices/Bills Perfect Match'),
        "sequence": '1',
        "ruleType": 'invoiceMatching',
        "autoReconcile": true,
        "matchNature": 'both',
        "matchSameCurrency": true,
        "allowPaymentTolerance": true,
        "paymentToleranceType": 'percentage',
        "paymentToleranceParam": 0,
        "matchPartner": true,
        "companyId": company.id,
      });

      await (await this.env.items('account.reconcile.model').sudo()).create({
        "label": await this._t('Invoices/Bills Partial Match if Underpaid'),
        "sequence": '2',
        "ruleType": 'invoiceMatching',
        "autoReconcile": false,
        "matchNature": 'both',
        "matchSameCurrency": true,
        "allowPaymentTolerance": false,
        "matchPartner": true,
        "companyId": company.id,
      })
    }

    return true;
  }

  async _getFpVals(company, position) {
    return {
      'companyId': company.id,
      'sequence': await position.sequence,
      'label': await position.label,
      'note': await position.note,
      'autoApply': await position.autoApply,
      'vatRequired': await position.vatRequired,
      'countryId': (await position.countryId).id,
      'countryGroupId': (await position.countryGroupId).id,
      'stateIds': (await position.stateIds).ok ? [[6, 0, (await position.stateIds).ids]] : [],
      'zipFrom': await position.zipFrom,
      'zipTo': await position.zipTo,
    }
  }

  /**
   * This method generates Fiscal Position, Fiscal Position Accounts
      and Fiscal Position Taxes from templates.

      :param taxesIds: Taxes templates reference for generating account.fiscal.position.tax.
      :param acc_template_ref: Account templates reference for generating account.fiscal.position.account.
      :param companyId: the company to generate fiscal position data for
      :returns: true
   * @param taxTemplateRef 
   * @param accTemplateRef 
   * @param company 
   * @returns 
   */
  async generateFiscalPosition(taxTemplateRef, accTemplateRef, company) {
    this.ensureOne();
    const positions = await this.env.items('account.fiscal.position.template').search([['chartTemplateId', '=', this.id]]);

    // first create fiscal positions in batch
    const templateVals = [];
    for (const position of positions) {
      const fpVals = await this._getFpVals(company, position);
      templateVals.push([position, fpVals]);
    }
    const fps = await this._createRecordsWithXmlid('account.fiscal.position', templateVals, company);

    // then create fiscal position taxes and accounts
    const taxTemplateVals = [];
    const accountTemplateVals = [];
    for (const [position, fp] of _.zip<any, any>([...positions], [...fps])) {
      for (const tax of await position.taxIds) {
        const taxDestId = (await tax.taxDestId).ok && taxTemplateRef.get(await tax.taxDestId).id;
        taxTemplateVals.push([tax, {
          'taxSrcId': taxTemplateRef[await tax.taxSrcId].id,
          'taxDestId': bool(taxDestId) ? taxDestId : false,
          'positionId': fp.id,
        }]);
      }
      for (const acc of await position.accountIds) {
        accountTemplateVals.push([acc, {
          'accountSrcId': accTemplateRef.get(await acc.accountSrcId).id,
          'accountDestId': accTemplateRef.get(await acc.accountDestId).id,
          'positionId': fp.id,
        }]);
      }
    }
    await this._createRecordsWithXmlid('account.fiscal.position.tax', taxTemplateVals, company);
    await this._createRecordsWithXmlid('account.fiscal.position.account', accountTemplateVals, company);

    return true
  }
}

@MetaModel.define()
class AccountTaxTemplate extends Model {
  static _module = module;
  static _name = 'account.tax.template';
  static _description = 'Templates for Taxes';
  static _order = 'id';

  static chartTemplateId = Fields.Many2one('account.chart.template', { string: 'Chart Template', required: true });

  static label = Fields.Char({ string: 'Tax Name', required: true });
  static typeTaxUse = Fields.Selection(TYPE_TAX_USE, {
    string: 'Tax Type', required: true, default: "sale",
    help: "Determines where the tax is selectable. Note : 'None' means a tax can't be used by itself, however it can still be used in a group."
  });
  static taxScope = Fields.Selection([['service', 'Service'], ['consu', 'Consumable']], { help: "Restrict the use of taxes to a type of product." });
  static amountType = Fields.Selection({
    default: 'percent', string: "Tax Computation", required: true,
    selection: [['group', 'Group of Taxes'], ['fixed', 'Fixed'], ['percent', 'Percentage of Price'], ['division', 'Percentage of Price Tax Included']]
  });
  static active = Fields.Boolean({ default: true, help: "Set active to false to hide the tax without removing it." });
  static childrenTaxIds = Fields.Many2many('account.tax.template', { relation: 'accountTaxTemplateFiliationRel', column1: 'parentTax', column2: 'childTax', string: 'Children Taxes' });
  static sequence = Fields.Integer({
    required: true, default: 1,
    help: "The sequence field is used to define order in which the tax lines are applied."
  });
  static amount = Fields.Float({ required: true, digits: [16, 4], default: 0 });
  static description = Fields.Char({ string: 'Display on Invoices' });
  static priceInclude = Fields.Boolean({
    string: 'Included in Price', default: false,
    help: "Check this if the price you use on the product and invoices includes this tax."
  });
  static includeBaseAmount = Fields.Boolean({
    string: 'Affect Subsequent Taxes', default: false,
    help: "If set, taxes with a higher sequence than this one will be affected by it, provided they accept it."
  });
  static isBaseAffected = Fields.Boolean({
    string: "Base Affected by Previous Taxes",
    default: true,
    help: "If set, taxes with a lower sequence might affect this one, provided they try to do it."
  });
  static analytic = Fields.Boolean({ string: "Analytic Cost", help: "If set, the amount computed by this tax will be assigned to the same analytic account as the invoice line (if any)" });
  static invoiceRepartitionLineIds = Fields.One2many("account.tax.repartition.line.template", "invoiceTaxId", { string: "Repartition for Invoices", copy: true, help: "Repartition when the tax is used on an invoice" });
  static refundRepartitionLineIds = Fields.One2many("account.tax.repartition.line.template", "refundTaxId", { string: "Repartition for Refund Invoices", copy: true, help: "Repartition when the tax is used on a refund" });
  static taxGroupId = Fields.Many2one('account.tax.group', { string: "Tax Group" });
  static taxExigibility = Fields.Selection(
    [['onInvoice', 'Based on Invoice'],
    ['onPayment', 'Based on Payment'],
    ], {
      string: 'Tax Due', default: 'onInvoice',
    help: "Based on Invoice: the tax is due as soon as the invoice is validated.\nBased on Payment: the tax is due as soon as the payment of the invoice is received."
  });
  static cashBasisTransitionAccountId = Fields.Many2one({
    comodelName: 'account.account.template',
    string: "Cash Basis Transition Account",
    domain: [['deprecated', '=', false]],
    help: "Account used to transition the tax amount for cash basis taxes. It will contain the tax amount as long as the original invoice has not been reconciled ; at reconciliation, this amount cancelled on this account and put on the regular tax account."
  });

  static _sqlConstraints = [
    ['label_company_uniq', 'unique(label, "typeTaxUse", "taxScope", "chartTemplateId")', 'Tax labels must be unique !'],
  ];

  @api.depends('label', 'description')
  async nameGet() {
    const res = [];
    for (const record of this) {
      const description = await record.description;
      const label = description ? description : await record.label;
      res.push([record.id, label]);
    }
    return res;
  }


  /**
   * This function is called in multivat setup, when a company needs to submit a
      tax report in a foreign country.

      It searches for tax templates in the provided countries and instantiates the
      ones it find in the provided company.

      Tax accounts are not kept from the templates (this wouldn't make sense,
      as they don't belong to the same CoA as the one installed on the company).
      Instead, we search existing tax accounts for approximately equivalent accounts
      and use their prefix to create new accounts. Doing this gives a roughly correct suggestion
      that then needs to be reviewed by the user to ensure its consistency.
      It is intended as a shortcut to avoid hours of encoding, not as an out-of-the-box, always
      correct solution.
   * @param country 
   * @param company 
   * @returns 
   */
  @api.model()
  async _tryInstantiatingForeignTaxes(country, company) {
    const self = this;
    async function createForeignTaxAccount(existingAccount, additionalLabel) {
      const [companyId, code, label, userTypeId] = await existingAccount('companyId', 'code', 'label', 'userTypeId');
      const newCode = await self.env.items('account.account')._searchNewAccountCode(companyId, len(code), code.slice(0, -2));
      return self.env.items('account.account').create({
        'label': `${label} - ${additionalLabel}`,
        'code': newCode,
        'userTypeId': userTypeId.id,
        'companyId': companyId.id,
      });
    }

    async function getExistingTaxAccount(foreignTaxRepLine, forceTax?: any) {
      const company = await foreignTaxRepLine.companyId;
      const signComparator = await foreignTaxRepLine.factorPercent < 0 ? '<' : '>';

      let searchDomain = [
        ['accountId', '!=', false],
        ['factorPercent', signComparator, 0],
        ['companyId', '=', company.id],
        '|',
        '&', ['invoiceTaxId.typeTaxUse', '=', await (await foreignTaxRepLine.invoiceTaxId).typeTaxUse],
        ['invoiceTaxId.countryId', '=', (await company.accountFiscalCountryId).id],
        '&', ['refundTaxId.typeTaxUse', '=', await (await foreignTaxRepLine.refundTaxId).typeTaxUse],
        ['refundTaxId.countryId', '=', (await company.accountFiscalCountryId).id],
      ];

      if (bool(forceTax)) {
        searchDomain = searchDomain.concat([
          '|', ['invoiceTaxId.id', 'in', forceTax.ids],
          ['refundTaxId.id', 'in', forceTax.ids],
        ]);
      }
      return (await self.env.items('account.tax.repartition.line').search(searchDomain, { limit: 1 })).accountId;
    }

    const taxesInCountry = await self.env.items('account.tax').search([
      ['countryId', '=', country.id],
      ['companyId', '=', company.id]
    ]);

    if (taxesInCountry.ok) {
      return;
    }

    const templatesToInstantiate = await (await self.env.items('account.tax.template').withContext({ activeTest: false })).search([['chartTemplateId.countryId', '=', country.id]]);
    const defaultCompanyTaxes = (await company.accountSaleTaxId).add(await company.accountPurchaseTaxId);
    const repLinesAccounts = (await templatesToInstantiate._generateTax(company))['accountDict'];

    const newAccountsMap = new MapKey<any, any>();

    // Handle tax repartition line accounts
    const taxRepLinesAccountsDict: Map<any, any> = repLinesAccounts['account.tax.repartition.line'];
    for (const [taxRepLine, accountDict] of taxRepLinesAccountsDict) {
      const accountTemplate = accountDict['accountId'];
      const repAccount = newAccountsMap.get(accountTemplate);

      if (!bool(repAccount)) {

        let existingAccount = await getExistingTaxAccount(taxRepLine, defaultCompanyTaxes);

        if (!bool(existingAccount)) {
          // If the default taxes were not enough to provide the account
          // we need, search on all other taxes.
          existingAccount = await getExistingTaxAccount(taxRepLine);
        }
        if (bool(existingAccount)) {
          const repAccount = await createForeignTaxAccount(existingAccount, await this._t("Foreign tax account (%s)", country.code));
          newAccountsMap.set(accountTemplate, repAccount);
        }
      }
      await taxRepLine.set('accountId', repAccount);
    }
    // Handle cash basis taxes transtion account
    const cabaTransitionDict = repLinesAccounts['account.tax'];
    for (const [tax, accountDict] of cabaTransitionDict) {
      const transitionAccountTemplate = accountDict['cashBasisTransitionAccountId'];

      if (transitionAccountTemplate.ok) {
        let transitionAccount = newAccountsMap.get(transitionAccountTemplate);

        if (!transitionAccount.ok) {
          const repLines = (await tax.invoiceRepartitionLineIds).add(await tax.refundRepartitionLineIds);
          const taxAccounts = await repLines.accountId;

          if (taxAccounts.ok) {
            transitionAccount = await createForeignTaxAccount(taxAccounts[0], await this._t("Cash basis transition account"));
          }
        }
        await tax.set('cashBasisTransitionAccountId', transitionAccount);
      }
    }
    // Setup tax closing accounts on foreign tax groups ; we don't want to use the domestic accounts
    const groups = await self.env.items('account.tax.group').search([['countryId', '=', country.id]]);
    const groupPropertyFields = [
      'propertyTaxPayableAccountId',
      'propertyTaxReceivableAccountId',
      'propertyAdvanceTaxPaymentAccountId'
    ];

    const propertyCompany = await self.env.items('ir.property').withCompany(company);
    const groupsCompany = await groups.withCompany(company);
    for (const propertyField of groupPropertyFields) {
      const defaultAcc = await propertyCompany._get(propertyField, 'account.tax.group');
      if (bool(defaultAcc)) {
        await groupsCompany.write({
          propertyField: await createForeignTaxAccount(defaultAcc, await this._t("Foreign account (%s)", await country.code))
        });
      }
    }
  }

  /**
   * This method generates a dictionary of all the values for the tax that will be created.
   * @param company 
   * @param taxTemplateToTax 
   */
  async _getTaxVals(company, taxTemplateToTax: MapKey<any, any>) {
    // Compute children tax ids
    const childrenIds = [];
    for (const childTax of await this['childrenTaxIds']) {
      if (taxTemplateToTax.get(childTax)) {
        childrenIds.push(taxTemplateToTax.get(childTax).id);
      }
    }
    this.ensureOne();
    const [label, typeTaxUse, taxScope, amountType, active, sequence, amount, description, priceInclude, includeBaseAmount, isBaseAffected, analytic, taxExigibility, invoiceRepartitionLineIds, refundRepartitionLineIds, taxGroupId] = await this('label', 'typeTaxUse', 'taxScope', 'amountType', 'active', 'sequence', 'amount', 'description', 'priceInclude', 'includeBaseAmount', 'isBaseAffected', 'analytic', 'taxExigibility', 'invoiceRepartitionLineIds', 'refundRepartitionLineIds', 'taxGroupId');
    const val = {
      'label': label,
      'typeTaxUse': typeTaxUse,
      'taxScope': taxScope,
      'amountType': amountType,
      'active': active,
      'companyId': company.id,
      'sequence': sequence,
      'amount': amount,
      'description': description,
      'priceInclude': priceInclude,
      'includeBaseAmount': includeBaseAmount,
      'isBaseAffected': isBaseAffected,
      'analytic': analytic,
      'childrenTaxIds': [[6, 0, childrenIds]],
      'taxExigibility': taxExigibility,
    }

    // We add repartition lines if there are some, so that if there are none,
    // defaultGet is called and creates the default ones properly.
    if (invoiceRepartitionLineIds.ok) {
      val['invoiceRepartitionLineIds'] = await invoiceRepartitionLineIds.getRepartitionLineCreateVals(company);
    }
    if (refundRepartitionLineIds.ok) {
      val['refundRepartitionLineIds'] = await refundRepartitionLineIds.getRepartitionLineCreateVals(company);
    }
    if (taxGroupId.ok) {
      val['taxGroupId'] = taxGroupId.id;
    }
    return val;
  }

  /**
   * Returns a dict of values to be used to create the tax corresponding to the template, assuming the
      account.account objects were already created.
      It differs from function _get_tax_vals because here, we replace the references to account.template by their
      corresponding account.account ids ('cash_basis_transition_account_id' and 'accountId' in the invoice and
      refund repartition lines)
   * @param company 
   * @param taxTemplateToTax 
   * @returns 
   */
  async _getTaxValsComplete(company, taxTemplateToTax: MapKey<any, any>) {
    const vals = await this._getTaxVals(company, taxTemplateToTax);
    const [cashBasisTransitionAccountId, invoiceRepartitionLineIds, refundRepartitionLineIds] = await this('cashBasisTransitionAccountId', 'invoiceRepartitionLineIds', 'refundRepartitionLineIds');
    const code = await cashBasisTransitionAccountId.code;
    if (code) {
      const cashBasisAccountId = await this.env.items('account.account').search([
        ['code', '=like', code + '%'],
        ['companyId', '=', company.id]
      ], { limit: 1 });
      if (cashBasisAccountId.ok) {
        update(vals, { "cashBasisTransitionAccountId": cashBasisAccountId.id });
      }
    }

    update(vals, {
      "invoiceRepartitionLineIds": await invoiceRepartitionLineIds._getRepartitionLineCreateValsComplete(company),
      "refundRepartitionLineIds": await refundRepartitionLineIds._getRepartitionLineCreateValsComplete(company),
    })
    return vals;
  }

  /**
   * This method generate taxes from templates.

          :param company: the company for which the taxes should be created from templates in self
          :accountExist: whether accounts have already been created
          :existingTemplateToTax: mapping of already existing templates to taxes [(template, tax), ...]
          :returns: {
              'taxTemplateToTax': mapping between tax template and the newly generated taxes corresponding,
              'accountDict': dictionary containing a to-do list with all the accounts to assign on new taxes
          }
   * @param company 
   * @param accountsExist 
   * @param existingTemplateToTax 
   */
  async _generateTax(company, accountsExist: boolean = false, existingTemplateToTax?: any[]) {
    // default_company_id is needed in context to allow creation of default
    // repartition lines on taxes
    const ChartTemplate = await this.env.items('account.chart.template').withContext({ default_companyId: company.id });
    const todoDict = { 'account.tax': new Map(), 'account.tax.repartition.line': new Map() };
    if (!bool(existingTemplateToTax)) {
      existingTemplateToTax = [];
    }
    const taxTemplateToTax = MapKey.fromEntries(existingTemplateToTax);

    let templatesTodo = [...this];
    while (templatesTodo.length) {
      const templates = templatesTodo;
      templatesTodo = [];

      // create taxes in batch
      const taxTemplateVals = [];
      for (const template of templates) {
        if (await (await template.childrenTaxIds).all(child => taxTemplateToTax.has(child))) {
          let vals;
          if (accountsExist) {
            vals = await template._getTaxValsComplete(company, taxTemplateToTax);
          }
          else {
            vals = await template._getTaxVals(company, taxTemplateToTax);
          }

          const countryId = await (await this['chartTemplateId']).countryId;
          if (countryId.ok) {
            vals['countryId'] = countryId.id;
          }
          else if ((await company.accountFiscalCountryId).ok) {
            vals['countryId'] = (await company.accountFiscalCountryId).id;
          }
          else {
            // Will happen for generic CoAs such as syscohada (they are available for multiple countries, and don't have any countryId)
            throw new UserError(await this._t("Please first define a fiscal country for company %s.", await company.label));
          }
          taxTemplateVals.push([template, vals]);
        }
        else {
          // defer the creation of this tax to the next batch
          templatesTodo.push(template);
        }
      }
      const taxes = await ChartTemplate._createRecordsWithXmlid('account.tax', taxTemplateVals, company);

      // fill in tax_template_to_tax and todo_dict
      for (const [tax, [template, vals]] of _.zip([...taxes], taxTemplateVals)) {
        taxTemplateToTax.set(template, tax);
        // Since the accounts have not been created yet, we have to wait before filling these fields
        todoDict['account.tax'].set(tax, {
          'cashBasisTransitionAccountId': await template.cashBasisTransitionAccountId,
        });
        for (const [existingTemplate, existingTax] of existingTemplateToTax) {
          if ((await existingTemplate.childrenTaxIds).includes(template) && !(await existingTax.childrenTaxIds).includes(tax)) {
            await existingTax.write({ 'childrenTaxIds': [[4, tax.id, false]] });
          }
        }

        if (!accountsExist) {
          // We also have to delay the assignation of accounts to repartition lines
          // The below code assigns the accountId to the repartition lines according
          // to the corresponding repartition line in the template, based on the order.
          // As we just created the repartition lines, tax.invoice_repartition_line_ids is not well sorted.
          // But we can force the sort by calling sort()
          const allTaxRepLines = (await (await tax.invoiceRepartitionLineIds).sorted()).add(await (await tax.refundRepartitionLineIds).sorted());
          const allTemplateRepLines = (await template.invoiceRepartitionLineIds).add(await template.refundRepartitionLineIds);
          for (const [index, templateRepLine] of enumerate(allTemplateRepLines)) {
            // We assume template and tax repartition lines are in the same order
            const templateAccount = await templateRepLine.accountId;
            if (bool(templateAccount)) {
              todoDict['account.tax.repartition.line'].set(allTaxRepLines[index], {
                'accountId': templateAccount,
              })
            }
          }
        }
      }
    }

    if (await this.some(async (template) => await template.taxExigibility === 'onPayment')) {
      // When a CoA is being installed automatically and if it is creating account tax(es) whose field `Use Cash Basis`(tax_exigibility) is set to true by default
      // (example of such CoA's are l10n_fr and l10n_mx) then in the `Accounting Settings` the option `Cash Basis` should be checked by default.
      await company.set('taxExigibility', true);
    }

    return {
      'taxTemplateToTax': taxTemplateToTax,
      'accountDict': todoDict
    }
  }
}
// Tax Repartition Line Template

@MetaModel.define()
class AccountTaxRepartitionLineTemplate extends Model {
  static _module = module;
  static _name = "account.tax.repartition.line.template";
  static _description = "Tax Repartition Line Template";

  static factorPercent = Fields.Float({ string: "%", required: true, help: "Factor to apply on the account move lines generated from this distribution line, in percents" });
  static repartitionType = Fields.Selection({ string: "Based On", selection: [['base', 'Base'], ['tax', 'of tax']], required: true, default: 'tax', help: "Base on which the factor will be applied." });
  static accountId = Fields.Many2one({ string: "Account", comodelName: 'account.account.template', help: "Account on which to post the tax amount" });
  static invoiceTaxId = Fields.Many2one({ comodelName: 'account.tax.template', help: "The tax set to apply this distribution on invoices. Mutually exclusive with refundTaxId" });
  static refundTaxId = Fields.Many2one({ comodelName: 'account.tax.template', help: "The tax set to apply this distribution on refund invoices. Mutually exclusive with invoiceTaxId" });
  static tagIds = Fields.Many2many({ string: "Financial Tags", relation: 'accountTaxRepartitionFinancialTags', comodelName: 'account.account.tag', copy: true, help: "Additional tags that will be assigned by this repartition line for use in financial reports" });
  static useInTaxClosing = Fields.Boolean({ string: "Tax Closing Entry" });

  // These last two fields are helpers used to ease the declaration of account.account.tag objects in XML.
  // They are directly linked to account.tax.report.line objects, which create corresponding + and - tags
  // at creation. This way, we avoid declaring + and - separately every time.
  static plusReportLineIds = Fields.Many2many({ string: "Plus Tax Report Lines", relation: 'accountTaxRepartitionPlusReportLine', comodelName: 'account.tax.report.line', copy: true, help: "Tax report lines whose '+' tag will be assigned to move lines by this repartition line" });
  static minusReportLineIds = Fields.Many2many({ string: "Minus Report Lines", relation: 'accountTaxRepartitionMinusReportLine', comodelName: 'account.tax.report.line', copy: true, help: "Tax report lines whose '-' tag will be assigned to move lines by this repartition line" });

  @api.model()
  async create(vals) {
    if (vals['plusReportLineIds']) {
      vals['plusReportLineIds'] = await this._convertTagSyntaxToOrm(vals['plusReportLineIds']);
    }
    if (vals['minusReportLineIds']) {
      vals['minusReportLineIds'] = await this._convertTagSyntaxToOrm(vals['minusReportLineIds']);
    }
    if (vals['tagIds']) {
      vals['tagIds'] = await this._convertTagSyntaxToOrm(vals['tagIds']);
    }
    if (vals['useInTaxClosing'] == null) {
      if (!vals['accountId']) {
        vals['useInTaxClosing'] = false;
      }
      else {
        const internalGroup = await (await this.env.items('account.account.template').browse(vals['accountId']).userTypeId).internalGroup;
        vals['useInTaxClosing'] = !(internalGroup === 'income' || internalGroup === 'expense');
      }
    }
    return _super(AccountTaxRepartitionLineTemplate, this).create(vals);
  }

  /**
   * Repartition lines give the possibility to directly give
      a list of ids to create for tags instead of a list of ORM commands.

      This function checks that tags_list uses this syntactic sugar and returns
      an ORM-compliant version of it if it does.
   * @param tagsList 
   * @returns 
   */
  @api.model()
  async _convertTagSyntaxToOrm(tagsList) {
    if (bool(tagsList) && tagsList.every(elem => Number.isInteger(elem))) {
      return [[6, false, tagsList]];
    }
    return tagsList;
  }

  @api.constrains('invoiceTaxId', 'refundTaxId')
  async validateTaxTemplateLink() {
    for (const record of this) {
      if ((await record.invoiceTaxId).ok && (await record.refundTaxId).ok) {
        throw new ValidationError(await this._t("Tax distribution line templates should apply to either invoices or refunds, not both at the same time. invoiceTaxId and refundTaxId should not be set together."));
      }
    }
  }

  @api.constrains('plusReportLineIds', 'minusReportLineIds')
  async validateTags() {
    const allTaxRepLines = (await this.mapped('plusReportLineIds')).concat(await this.mapped('minusReportLineIds'));
    const linesWithoutTag = await allTaxRepLines.filtered(async (x) => ! await x.tagName);
    if (bool(linesWithoutTag)) {
      throw new ValidationError(await this._t("The following tax report lines are used in some tax distribution template though they don't generate any tag: %s . This probably means you forgot to set a tagName on these lines.", String(await linesWithoutTag.mapped('label'))));
    }
  }

  async getRepartitionLineCreateVals(company) {
    const rslt: any[] = [[5, 0, 0]];
    for (const record of this) {
      const tagsToAdd = await record._getTagsToAdd();

      rslt.push([0, 0, {
        'factorPercent': await record.factorPercent,
        'repartitionType': await record.repartitionType,
        'tagIds': [[6, 0, tagsToAdd.ids]],
        'companyId': company.id,
        'useInTaxClosing': await record.useInTaxClosing
      }]);
    }
    return rslt;
  }

  /**
   *  This function returns a list of values to create the repartition lines of a tax based on
      one or several account.tax.repartition.line.template. It mimicks the function get_repartition_line_create_vals
      but adds the missing field accountId (account.account)

      Returns a list of (0,0, x) ORM commands to create the repartition lines starting with a (5,0,0)
      command to clear the repartition.

   * @param company 
   * @returns 
   */
  async _getRepartitionLineCreateValsComplete(company) {
    const rslt = await this.getRepartitionLineCreateVals(company);
    for (const [idx, templateLine] of _.zip(Array.from(range(1, len(rslt))), [...this])) {  // ignore first ORM command ( (5, 0, 0) )
      const tempAccount = await templateLine.accountId;
      let accountId = false;
      if (bool(tempAccount)) {
        // take the first account.account which code begins with the correct code
        accountId = await this.env.items('account.account').search([
          ['code', '=like', await tempAccount.code + '%'],
          ['companyId', '=', company.id]
        ], { limit: 1 }).id
        if (!bool(accountId)) {
          console.warn("The account with code '%s' was not found but is supposed to be linked to a tax", await tempAccount.code);
        }
      }
      rslt[idx][2].update({
        "accountId": accountId,
      });
    }
    return rslt;
  }

  async _getTagsToAdd() {
    this.ensureOne();
    let tagsToAdd = this.env.items("account.account.tag");
    tagsToAdd = tagsToAdd.add(await (await (await this['plusReportLineIds']).mapped("tagIds")).filtered(async (x) => ! await x.taxNegate));
    tagsToAdd = tagsToAdd.add(await (await (await this['minusReportLineIds']).mapped("tagIds")).filtered((x) => x.taxNegate));
    tagsToAdd = tagsToAdd.add(await this['tagIds']);
    return tagsToAdd;
  }
}
// Fiscal Position Templates

@MetaModel.define()
class AccountFiscalPositionTemplate extends Model {
  static _module = module;
  static _name = 'account.fiscal.position.template';
  static _description = 'Template for Fiscal Position';

  static sequence = Fields.Integer();
  static label = Fields.Char({ string: 'Fiscal Position Template', required: true });
  static chartTemplateId = Fields.Many2one('account.chart.template', { string: 'Chart Template', required: true });
  static accountIds = Fields.One2many('account.fiscal.position.account.template', 'positionId', { string: 'Account Mapping' });
  static taxIds = Fields.One2many('account.fiscal.position.tax.template', 'positionId', { string: 'Tax Mapping' });
  static note = Fields.Text({ string: 'Notes' });
  static autoApply = Fields.Boolean({ string: 'Detect Automatically', help: "Apply automatically this fiscal position." });
  static vatRequired = Fields.Boolean({ string: 'VAT required', help: "Apply only if partner has a VAT number." });
  static countryId = Fields.Many2one('res.country', {
    string: 'Country',
    help: "Apply only if delivery country matches."
  });
  static countryGroupId = Fields.Many2one('res.country.group', {
    string: 'Country Group',
    help: "Apply only if delivery country matches the group."
  });
  static stateIds = Fields.Many2many('res.country.state', { string: 'Federal States' });
  static zipFrom = Fields.Char({ string: 'Zip Range From' });
  static zipTo = Fields.Char({ string: 'Zip Range To' });
}

@MetaModel.define()
class AccountFiscalPositionTaxTemplate extends Model {
  static _module = module;
  static _name = 'account.fiscal.position.tax.template';
  static _description = 'Tax Mapping Template of Fiscal Position';
  static _recName = 'positionId';

  static positionId = Fields.Many2one('account.fiscal.position.template', { string: 'Fiscal Position', required: true, ondelete: 'CASCADE' });
  static taxSrcId = Fields.Many2one('account.tax.template', { string: 'Tax Source', required: true });
  static taxDestId = Fields.Many2one('account.tax.template', { string: 'Replacement Tax' });
}

@MetaModel.define()
class AccountFiscalPositionAccountTemplate extends Model {
  static _module = module;
  static _name = 'account.fiscal.position.account.template';
  static _description = 'Accounts Mapping Template of Fiscal Position';
  static _recName = 'positionId';

  static positionId = Fields.Many2one('account.fiscal.position.template', { string: 'Fiscal Mapping', required: true, ondelete: 'CASCADE' });
  static accountSrcId = Fields.Many2one('account.account.template', { string: 'Account Source', required: true });
  static accountDestId = Fields.Many2one('account.account.template', { string: 'Account Destination', required: true });
}

@MetaModel.define()
class AccountReconcileModelTemplate extends Model {
  static _module = module;
  static _name = "account.reconcile.model.template";
  static _description = 'Reconcile Model Template';

  // Base fields.
  static chartTemplateId = Fields.Many2one('account.chart.template', { string: 'Chart Template', required: true });
  static label = Fields.Char({ string: 'Button Label', required: true });
  static sequence = Fields.Integer({ required: true, default: 10 });

  static ruleType = Fields.Selection({
    selection: [
      ['writeoffButton', 'Button to generate counterpart entry'],
      ['writeoffSuggestion', 'Rule to suggest counterpart entry'],
      ['invoiceMatching', 'Rule to match invoices/bills'],
    ], string: 'Type', default: 'writeoffButton', required: true
  });
  static autoReconcile = Fields.Boolean({
    string: 'Auto-validate',
    help: 'Validate the statement line automatically (reconciliation based on your rule).'
  });
  static toCheck = Fields.Boolean({ string: 'To Check', default: false, help: 'This matching rule is used when the user is not certain of all the information of the counterpart.' });
  static matchingOrder = Fields.Selection(
    {
      selection: [
        ['oldFirst', 'Oldest first'],
        ['newFirst', 'Newest first'],
      ]
    }
  );

  // ===== Conditions =====
  static matchTextLocationLabel = Fields.Boolean({
    default: true,
    help: "Search in the Statement's Label to find the Invoice/Payment's reference",
  });
  static matchTextLocationNote = Fields.Boolean({
    default: false,
    help: "Search in the Statement's Note to find the Invoice/Payment's reference",
  })
  static matchTextLocationReference = Fields.Boolean({
    default: false,
    help: "Search in the Statement's Reference to find the Invoice/Payment's reference",
  });
  static matchJournalIds = Fields.Many2many('account.journal', {
    string: 'Journals Availability',
    domain: "[['type', 'in', ['bank', 'cash']]]",
    help: 'The reconciliation model will only be available from the selected journals.'
  });
  static matchNature = Fields.Selection({
    selection: [
      ['amountReceived', 'Amount Received'],
      ['amountPaid', 'Amount Paid'],
      ['both', 'Amount Paid/Received']
    ], string: 'Amount Type', required: true, default: 'both',
    help: `The reconciliation model will only be applied to the selected transaction type:
        * Amount Received: Only applied when receiving an amount.
        * Amount Paid: Only applied when paying an amount.
        * Amount Paid/Received: Applied in both cases.`});
  static matchAmount = Fields.Selection({
    selection: [
      ['lower', 'Is Lower Than'],
      ['greater', 'Is Greater Than'],
      ['between', 'Is Between'],
    ], string: 'Amount Condition',
    help: 'The reconciliation model will only be applied when the amount being lower than, greater than or between specified amount(s).'
  });
  static matchAmountMin = Fields.Float({ string: 'Amount Min Parameter' });
  static matchAmountMax = Fields.Float({ string: 'Amount Max Parameter' });
  static matchLabel = Fields.Selection({
    selection: [
      ['contains', 'Contains'],
      ['notContains', 'Not Contains'],
      ['matchRegex', 'Match Regex'],
    ], string: 'Label', help: `The reconciliation model will only be applied when the label:
        * Contains: The proposition label must contains this string (case insensitive).
        * Not Contains: Negation of "Contains".
        * Match Regex: Define your own regular expression.`});
  static matchLabelParam = Fields.Char({ string: 'Label Parameter' });
  static matchNote = Fields.Selection({
    selection: [
      ['contains', 'Contains'],
      ['notContains', 'Not Contains'],
      ['matchRegex', 'Match Regex'],
    ], string: 'Note', help: `The reconciliation model will only be applied when the note:
        * Contains: The proposition note must contains this string (case insensitive).
        * Not Contains: Negation of "Contains".
        * Match Regex: Define your own regular expression.`});
  static matchNoteParam = Fields.Char({ string: 'Note Parameter' });
  static matchTransactionType = Fields.Selection({
    selection: [
      ['contains', 'Contains'],
      ['notContains', 'Not Contains'],
      ['matchRegex', 'Match Regex'],
    ], string: 'Transaction Type', help: `The reconciliation model will only be applied when the transaction type:
        * Contains: The proposition transaction type must contains this string (case insensitive).
        * Not Contains: Negation of "Contains".
        * Match Regex: Define your own regular expression.`});
  static matchTransactionTypeParam = Fields.Char({ string: 'Transaction Type Parameter' });
  static matchSameCurrency = Fields.Boolean({
    string: 'Same Currency', default: true,
    help: 'Restrict to propositions having the same currency as the statement line.'
  });
  static allowPaymentTolerance = Fields.Boolean({
    string: "Allow Payment Gap",
    default: true,
    help: "Difference accepted in case of underpayment.",
  });
  static paymentToleranceParam = Fields.Float({
    string: "Gap",
    default: 0.0,
    help: "The sum of total residual amount propositions matches the statement line amount under this amount/percentage.",
  })
  static paymentToleranceType = Fields.Selection({
    selection: [['percentage', "in percentage"], ['fixedAmount', "in amount"]],
    required: true,
    default: 'percentage',
    help: "The sum of total residual amount propositions and the statement line amount allowed gap type.",
  });
  static matchPartner = Fields.Boolean({
    string: 'Partner Is Set',
    help: 'The reconciliation model will only be applied when a customer/vendor is set.'
  });
  static matchPartnerIds = Fields.Many2many('res.partner', {
    string: 'Restrict Partners to',
    help: 'The reconciliation model will only be applied to the selected customers/vendors.'
  });
  static matchPartnerCategoryIds = Fields.Many2many('res.partner.category', {
    string: 'Restrict Partner Categories to',
    help: 'The reconciliation model will only be applied to the selected customer/vendor categories.'
  });

  static lineIds = Fields.One2many('account.reconcile.model.line.template', 'modelId');
  static decimalSeparator = Fields.Char({ help: "Every character that is nor a digit nor this separator will be removed from the matching string" });
}

@MetaModel.define()
class AccountReconcileModelLineTemplate extends Model {
  static _module = module;
  static _name = "account.reconcile.model.line.template";
  static _description = 'Reconcile Model Line Template';

  static modelId = Fields.Many2one('account.reconcile.model.template');
  static sequence = Fields.Integer({ required: true, default: 10 });
  static accountId = Fields.Many2one('account.account.template', { string: 'Account', ondelete: 'CASCADE', domain: [['deprecated', '=', false]] });
  static label = Fields.Char({ string: 'Journal Item Label' });
  static amountType = Fields.Selection([
    ['fixed', 'Fixed'],
    ['percentage', 'Percentage of balance'],
    ['regex', 'From label'],
  ], { required: true, default: 'percentage' });
  static amountString = Fields.Char({ string: "Amount" });
  static forceTaxIncluded = Fields.Boolean({ string: 'Tax Included in Price', help: 'Force the tax to be managed as a price included tax.' });
  static taxIds = Fields.Many2many('account.tax.template', { string: 'Taxes', ondelete: 'RESTRICT' });
}