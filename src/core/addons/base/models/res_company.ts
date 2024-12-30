import fs from "fs/promises";
import _ from 'lodash';
import path from 'path';
import sharp from 'sharp';
import ico from 'sharp-ico';
import { api, tools } from '../../..';
import { Command, Fields } from "../../../fields";
import { UserError, ValidationError, ValueError } from '../../../helper/errors';
import { MetaModel, Model, _super } from "../../../models";
import { getResourcePath } from '../../../modules/modules';
import { b64encode, filePath } from '../../../tools';
import { bool } from '../../../tools/bool';
import { isInstance } from '../../../tools/func';
import { isFile, pop } from '../../../tools/misc';
import { ModelRecords } from './../../../models';

@MetaModel.define()
class Company extends Model {
  static _module = module;
  static _name = "res.company";
  static _description = 'Companies';
  static _order = 'sequence, label';

  async _getLogo() {
    const filename = path.join(tools.config.get('rootPath'), 'addons', 'base', 'static', 'img', 'res_company_logo.png');
    const data = await fs.readFile(filePath(filename));
    return b64encode(data);
  }

  async copy(defaultValue) {
    throw new UserError(await this._t('Duplicating a company is not allowed. Please create a new company instea]d.'));
  }

  async _defaultCurrencyId() {
    const companyId = await (await this.env.user()).companyId;
    const currencyId = await companyId.currencyId;
    return currencyId;
  }

  async _getDefaultFavicon(original?: boolean): Promise<any> {
    const imgPath = getResourcePath('web', 'static/img/favicon.ico');
    if (!isFile(imgPath)) {
      return;
    }
    const buffer = await fs.readFile(filePath(imgPath));
    if (original) {
      return b64encode(buffer);
    }
    const icons = ico.decode(buffer);
    const icon = icons[0];
    let image = icon.type === "png"
      ? sharp(icon.data)
      : sharp(icon.data, {
        raw: {
          width: icon.width,
          height: icon.height,
          channels: 4,
        },
      });
    image = image
      // If the image has alpha transparency channel
      .flatten({ background: "#ffffff" })
      // If the image has no alpha transparency channel
      .ensureAlpha()
      .raw();

    const res = await image.toBuffer({ resolveWithObject: true });
    return b64encode(res.data);
  }

  static label = Fields.Char({ related: 'partnerId.label', string: 'Company Name', required: true, store: true, readonly: false })
  static sequence = Fields.Integer({ help: 'Used to order Companies in the company switcher', default: 10 })
  static parentId = Fields.Many2one('res.company', { string: 'Parent Company', index: true })
  static childIds = Fields.One2many('res.company', 'parentId', { string: 'Child Companies' })
  static partnerId = Fields.Many2one('res.partner', { string: 'Partner', required: true })
  static reportHeader = Fields.Html({ string: 'Company Tagline', help: "Appears by default on the top right corner of your printed documents (report header)." })
  static reportFooter = Fields.Html({ string: 'Report Footer', translate: true, help: "Footer text displayed at the bottom of all reports." })
  static companyDetails = Fields.Html({ string: 'Company Details', help: "Header text displayed at the top of all reports." })
  static logo = Fields.Binary({ related: 'partnerId.image1920', default: self => self._getLogo(), string: "Company Logo", readonly: false })
  // # logo_web: do not store in attachments, since the image is retrieved in SQL for
  // # performance reasons (see addons/web/controllers/main.js, Binary.companyLogo)
  static logoWeb = Fields.Binary({ compute: '_computeLogoWeb', store: true, attachment: false })
  static currencyId = Fields.Many2one('res.currency', { string: 'Currency', required: true, default: async (self) => await self._defaultCurrencyId() })
  static userIds = Fields.Many2many('res.users', { relation: 'resCompanyUsersRel', column1: 'cid', column2: 'userId', string: 'Accepted Users' })
  static street = Fields.Char({ compute: '_computeAddress', inverse: '_inverseStreet' })
  static street2 = Fields.Char({ compute: '_computeAddress', inverse: '_inverseStreet2' })
  static zip = Fields.Char({ compute: '_computeAddress', inverse: '_inverseZip' })
  static city = Fields.Char({ compute: '_computeAddress', inverse: '_inverseCity' })
  static stateId = Fields.Many2one('res.country.state', { compute: '_computeAddress', inverse: '_inverseState', string: "Fed. State", domain: "[['countryId', '=?', countryId]]" })
  static bankIds = Fields.One2many({ related: 'partnerId.bankIds', readonly: false })
  static countryId = Fields.Many2one('res.country', { compute: '_computeAddress', inverse: '_inverseCountry', string: "Country" })
  static email = Fields.Char({ related: 'partnerId.email', store: true, readonly: false })
  static phone = Fields.Char({ related: 'partnerId.phone', store: true, readonly: false })
  static mobile = Fields.Char({ related: 'partnerId.mobile', store: true, readonly: false })
  static website = Fields.Char({ related: 'partnerId.website', readonly: false })
  static vat = Fields.Char({ related: 'partnerId.vat', string: "Tax ID", readonly: false })
  static companyRegistry = Fields.Char({ compute: '_computeCompanyRegistry', store: true, readonly: false })
  static paperformatId = Fields.Many2one('report.paperformat', { string: 'Paper format', default: async (self) => await self.env.ref('base.paperformatEuro', false) })
  static externalReportLayoutId = Fields.Many2one('ir.ui.view', { string: 'Document Template' })
  static baseOnboardingCompanyState = Fields.Selection([
    ['notDone', "Not done"], ['justDone', "Just done"], ['done', "Done"]], { string: "State of the onboarding company step", default: 'notDone' })
  static favicon = Fields.Binary({ string: "Company Favicon", help: "This field holds the image used to display a favicon for a given company.", default: self => self._getDefaultFavicon() })
  static font = Fields.Selection([["Lato", "Lato"], ["Roboto", "Roboto"], ["Open_Sans", "Open Sans"], ["Montserrat", "Montserrat"], ["Oswald", "Oswald"], ["Raleway", "Raleway"]], { default: "Lato" })
  static primaryColor = Fields.Char()
  static secondaryColor = Fields.Char()
  static layoutBackground = Fields.Selection([['Blank', 'Blank'], ['Geometric', 'Geometric'], ['Custom', 'Custom']], { default: "Blank", required: true })
  static layoutBackgroundImage = Fields.Binary("Background Image")

  static _sqlConstraints = [
    ['label_uniq', 'unique (label)', 'The company name must be unique !']
  ]

  async init() {
    const res = await this.search([['paperformatId', '=', false]]) as ModelRecords;
    for (const company of res) {
      const paperformatEuro = await this.env.ref('base.paperformatEuro', false);
      if (paperformatEuro) {
        await company.write({ 'paperformatId': paperformatEuro.id })
      }
    }
    const sup = Object.getPrototypeOf(Model);
    if (sup && sup.prototype && 'init' in sup.prototype) {
      const func: Function = sup.prototype['init'];
      await func.apply(this);
    }
  }

  /**
   * Return a list of fields coming from the address partner to match
    on company address fields. Fields are labeled same on both models.
   * @returns 
   */
  _getCompanyAddressFieldNames() {
    return ['street', 'street2', 'city', 'zip', 'stateId', 'countryId'];
  }

  async _getCompanyAddressUpdate(partner) {
    return partner.getDict(this._getCompanyAddressFieldNames());
  }

  async _computeCompanyRegistry() {
    // exists to allow overrides
    for (const company of this) {
      await company.set('companyRegistry', await company.companyRegistry);
    }
  }

  // TODO @api.depends(): currently now way to formulate the dependency on the partner's contact address
  async _computeAddress() {
    for (const company of await this.filtered(async (company) => await company.partnerId)) {
      const partnerId = await company.partnerId;
      const addressData = await (await partnerId.sudo()).addressGet(['contact']);
      if (addressData['contact']) {
        const partner = await partnerId.browse(addressData['contact']).sudo();
        await company.update(await company._getCompanyAddressUpdate(partner))
      }
    }
  }

  async _inverseStreet() {
    for (const company of this) {
      await (await company.partnerId).set('street', await company.street);
    }
  }

  async _inverseStreet2() {
    for (const company of this) {
      await (await company.partnerId).set('street2', await company.street2);
    }
  }

  async _inverseZip() {
    for (const company of this) {
      await (await company.partnerId).set('zip', await company.zip);
    }
  }

  async _inverseCity() {
    for (const company of this) {
      await (await company.partnerId).set('city', await company.city);
    }
  }

  async _inverseState() {
    for (const company of this) {
      await (await company.partnerId).set('stateId', await company.stateId);
    }
  }

  async _inverseCountry() {
    for (const company of this) {
      await (await company.partnerId).set('countryId', await company.countryId);
    }
  }

  @api.depends('partnerId.image1920')
  async _computeLogoWeb() {
    for (const company of this) {
      await company.set('logoWeb', await tools.imageProcess(await (await company.partnerId).image1920, { size: [180, 0] }));
    }
  }

  @api.onchange('stateId')
  async _onchangeState() {
    const countryId = await (await this['stateId']).countryId;
    if (countryId.ok) {
      await this.set('countryId', countryId);
    }
  }

  @api.onchange('countryId')
  async _onchangeCountryId() {
    const countryId = await this['countryId'];
    if (countryId.ok) {
      await this.set('currencyId', await countryId.currencyId);
    }
  }

  @api.model()
  async _nameSearch(name: any, args?: any, operator: string = 'ilike', { limit=100, nameGetUid=false } = {}) {
    const context = Object.assign({}, this.env.context);
    let newself = this;
    if (pop(context, 'userPreference', null)) {
      // We browse as superuser. Otherwise, the user would be able to select only the currently visible companies (according to rules,  which are probably to allow to see the child companies) even if  she belongs to some other companies.
      const companies = await (await this.env.user()).companyIds;
      args = (args ?? []).concat([['id', 'in', companies.ids]]);
      newself = await newself.sudo();
    }
    return _super(Company, await newself.withContext(context))._nameSearch(name, args, operator, {limit, nameGetUid});
  }

  @api.model()
  async create(vals) {
    if (!vals['favicon']) {
      vals['favicon'] = await this._getDefaultFavicon();
    }
    if (!vals['label'] || vals['partnerId']) {
      this.clearCaches();
      return _super(Company, this).create(vals);
    }
    const partner = await this.env.items('res.partner').create({
      'label': vals['label'],
      'isCompany': true,
      'image1920': vals['logo'],
      'email': vals['email'],
      'phone': vals['phone'],
      'website': vals['website'],
      'vat': vals['vat'],
      'countryId': vals['countryId'],
    });
    // compute stored fields, for example address dependent fields
    await partner.flush();
    vals['partnerId'] = partner.id
    this.clearCaches()
    const company = await _super(Company, this).create(vals)
    // The write is made on the user to set it automatically in the multi company group.
    await (await this.env.user()).write({ 'companyIds': [Command.link(company.id)] });

    // Make sure that the selected currency is enabled
    if (vals['currencyId']) {
      const currency = this.env.items('res.currency').browse(vals['currencyId']);
      if (! await currency.active)
        await currency.write({ 'active': true });
    }
    return company;
  }

  async write(values) {
    this.clearCaches();
    // Make sure that the selected currency is enabled
    if (values['currencyId']) {
      const currency = this.env.items('res.currency').browse(values['currencyId']);
      if (! await currency.active) {
        await currency.write({ 'active': true });
      }
    }

    const res = await _super(Company, this).write(values);

    // invalidate company cache to recompute address based on updated partner
    const companyAddressFields = this._getCompanyAddressFieldNames();
    const companyAddressFieldsUpd = _.intersection(Array.from(new Set(companyAddressFields)), Array.from(new Set(Object.keys(values))));
    if (companyAddressFieldsUpd.length) {
      this.invalidateCache(companyAddressFields);
    }
    return res;
  }

  @api.constrains('parentId')
  async _checkParentId() {
    if (! await this._checkRecursion()) {
      throw new ValidationError(await this._t('You cannot create recursive companies.'));
    }
  }

  async openCompanyEditReport() {
    this.ensureOne();
    return this.env.items('res.config.settings').openCompany();
  }

  async writeCompanyAndPrintReport() {
    const context = this.env.context;
    const reportName = context['default_reportName'];
    const activeIds = context['activeIds'];
    const activeModel = context['activeModel'];
    if (reportName && activeIds && activeModel) {
      const docIds = this.env.items(activeModel).browse(activeIds);
      return (await this.env.items('ir.actions.report').search([['reportName', '=', reportName]], { limit: 1 }))
        .reportAction(docIds);
    }
  }

  /**
   * Onboarding step for company basic information.
   * @returns 
   */
  @api.model()
  async actionOpenBaseOnboardingCompany() {
    const action = await this.env.items("ir.actions.actions")._forXmlid("base.actionOpenBaseOnboardingCompany");
    action['resId'] = (await this.env.company()).id;
    return action;
  }

  async setOnboardingStepDone(stepName) {
    if (await this[stepName] === 'notDone') {
      await this.set(stepName, 'justDone');
    }
  }

  /**
   * Needed to display onboarding animations only one time.
   * @param onboardingState 
   * @param stepsStates 
   */
  async getAndUpdateOnbardingState(onboardingState, stepsStates) {
    const oldValues = {};
    let allDone = true;
    for (const stepState of stepsStates) {
      oldValues[stepState] = await this[stepState];
      if (await this[stepState] === 'justDone') {
        await this.set(stepState, 'done');
      }
      allDone = allDone && await this[stepState] === 'done';
    }
    if (allDone) {
      if (await this[onboardingState] === 'notDone') {
        // string `onboardingState` instead of variable name is not an error
        oldValues['onboardingState'] = 'justDone';
      }
      else {
        oldValues['onboardingState'] = 'done';
      }
      await this.set(onboardingState, 'done');
    }
    return oldValues;
  }

  async actionSaveOnboardingCompanyStep() {
    if (bool(await this['street'])) {
      await this.setOnboardingStepDone('baseOnboardingCompanyState');
    }
  }

  @api.model()
  async _getMainCompany() {
    let mainCompany;
    try {
      mainCompany = await (await this.sudo()).env.ref('base.mainCompany');
    }
    catch (e) {
      if (isInstance(e, ValueError)) {
        mainCompany = await (await this.env.items('res.company').sudo()).search([], { limit: 1, order: "id" });
      }
      throw e;
    }
    return mainCompany
  }
}