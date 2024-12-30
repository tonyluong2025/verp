import { allTimezones, groupbyAsync, md5, update } from './../../../tools/misc';
import _ from 'lodash';
import { DateTime } from 'luxon';
import { TextEncoder } from 'node:util';
import * as xpath from 'xpath';
import { api, tools } from '../../..';
import { Command, Fields } from "../../../fields";
import { DefaultDict, Dict, MapKey } from '../../../helper';
import { RedirectWarning, UserError, ValidationError, ValueError } from '../../../helper/errors';
import { AbstractModel, BaseModel, MetaModel, Model, _super } from "../../../models";
import { getUnaccentWrapper } from '../../../osv/expression';
import { Query } from '../../../osv/query';
import { urlParse } from '../../../service/middleware/utils';
import { b64encode } from '../../../tools';
import { bool } from '../../../tools/bool';
import { isInstance } from '../../../tools/func';
import { len, next } from '../../../tools/iterable';
import { emailNormalizeAll, formataddr } from '../../../tools/mail';
import { _convert$, _f, _format, f } from '../../../tools/utils';
import { parseHtml, serializeHtml } from '../../../tools/xml';

export const WARNING_MESSAGE = [
  ['no-message', 'No Message'],
  ['warning', 'Warning'],
  ['block', 'Blocking Message']
];

export const WARNING_HELP = 'Selecting the "Warning" option will notify user with the message, Selecting "Blocking Message" will throw an exception with the message and block the flow. The Message has to be written in the next field.';

const ADDRESS_FIELDS = new Set(['street', 'street2', 'zip', 'city', 'stateId', 'countryId']);

@MetaModel.define()
class FormatAddressMixin extends AbstractModel {
  static _module = module;
  static _name = 'format.address.mixin';
  static _description = 'Address Format';

  async _fieldsViewGetAddress(arch) {
    // consider the country of the user, not the country of the partner we want to display
    const doc = parseHtml(arch);
    const addressViewId = await (await (await (await this.env.company()).countryId).addressViewId).sudo();
    if (addressViewId.ok && !this._context['noAddressFormat'] && (!await addressViewId.model || await addressViewId.model === this._name)) {
      //render the partner address accordingly to addressViewId
      const nodes: Element[] = xpath.select('//div[contains(@class,"o-address-format")]', doc) as any ?? [];
      for (const addressNode of nodes) {
        const Partner = await this.env.items('res.partner').withContext({ noAddressFormat: true });
        const subView = await Partner.fieldsViewGet({ viewId: addressViewId.id, viewType: 'form', toolbar: false, submenu: false });
        const subViewNode = subView['dom'];
        //if the model is different than res.partner, there are chances that the view won't work
        //(e.g fields not present on the model). In that case we just return arch
        if (this._name !== 'res.partner') {
          try {
            await this.env.items('ir.ui.view').postprocessAndFields(subViewNode, this._name);
          } catch (e) {
            if (isInstance(e, ValueError)) {
              return [doc, arch];
            }
          }
        }
        addressNode.parentNode.replaceChild(subViewNode, addressNode);
      }
      arch = serializeHtml(doc);
    }
    return [doc, arch];
  }
}

export function _tzGet(self) {
  let tzs = Array.from(allTimezones.filter((e) => !e.startsWith('Etc/')));
  tzs.sort();
  tzs = tzs.concat(allTimezones.filter((e) => e.startsWith('Etc/')))
  return tzs.map((e) => [e, e]);
}

function _getDefaultColor() {
  return Math.floor(Math.random() * 11);
}

@MetaModel.define()
class PartnerCategory extends Model {
  static _module = module;
  static _description = 'Partner Tags';
  static _name = 'res.partner.category';
  static _order = 'label';
  static _parentStore = true;

  static label = Fields.Char({ string: 'Tag Name', required: true, translate: true });
  static color = Fields.Integer({ string: 'Color', default: self => _getDefaultColor() });
  static parentId = Fields.Many2one('res.partner.category', { string: 'Parent Category', index: true, ondelete: 'CASCADE' });
  static childIds = Fields.One2many('res.partner.category', 'parentId', { string: 'Child Tags', recursive: true });
  static active = Fields.Boolean({ default: true, help: "The active field allows you to hide the category without removing it." });
  static parentPath = Fields.Char({ index: true });
  static partnerIds = Fields.Many2many('res.partner', { column1: 'categoryId', column2: 'partnerId', string: 'Partners' });

  @api.constrains('parentId')
  async _checkParentId() {
    if (! await this._checkRecursion()) {
      throw new ValidationError(await this._t('You can not create recursive tags.'));
    }
  }

  /**
   * Return the categories' display name, including their direct
    parent by default.

    If ``context['partnerCategoryDisplay']`` is ``'short'``, the short
    version of the category name (without the direct parent) is used.
    The default is the long version.
   * @returns 
   */
  async nameGet() {
    if (this._context['partnerCategoryDisplay'] === 'short')
      return _super(PartnerCategory, this).nameGet();

    const res = [];
    const self: any = this;
    for (const category of self) {
      const names = [];
      let current = category;
      while (current.ok) {
        names.push(await current.label);
        current = await current.parentId;
      }
      res.push([category.id, names.reverse().join(' / ')]);
    }
    return res;
  }

  @api.model()
  async _nameSearch(name: string, args?: any, operator = 'ilike', { limit = 100, nameGetUid = false } = {}) {
    args = args || [];
    if (name) {
      // Be sure nameSearch is symetric to nameGet
      name = name.split(' / ').slice(-1)[0];
      args = [['label', operator, name]].concat(args);
    }
    return this._search(args, { limit, accessRightsUid: nameGetUid });
  }
}

@MetaModel.define()
class PartnerTitle extends Model {
  static _module = module;
  static _name = 'res.partner.title';
  static _order = 'label';
  static _description = 'Partner Title';

  static label = Fields.Char({ string: 'Title', required: true, translate: true });
  static shortcut = Fields.Char({ string: 'Abbreviation', translate: true });
}

@MetaModel.define()
class Partner extends Model {
  static _module = module;
  static _description = 'Contact';
  static _parents = ['format.address.mixin', 'avatar.mixin'];
  static _name = "res.partner";
  static _order = "displayName";

  static label = Fields.Char({ index: true })
  static displayName = Fields.Char({ compute: '_computeDisplayName', recursive: true, store: true, index: true })
  static date = Fields.Date({ index: true })
  static title = Fields.Many2one('res.partner.title')
  static parentId = Fields.Many2one('res.partner', { string: 'Related Company', index: true })
  static parentName = Fields.Char({ related: 'parentId.label', readonly: true, string: 'Parent name' })
  static childIds = Fields.One2many('res.partner', 'parentId', { recursive: true, string: 'Contact', domain: [['active', '=', true]] })  // force "activeTest" domain to bypass _search() override
  static ref = Fields.Char({ string: 'Reference', index: true })
  static lang = Fields.Selection(Partner._langGet, { string: 'Language', help: "All the emails and documents sent to this contact will be translated in this language." })
  static activeLangCount = Fields.Integer({ compute: '_computeActiveLangCount' })
  static tz = Fields.Selection(_tzGet, { string: 'TimeZone', default: self => self._context['tz'], help: "When printing documents and exporting/importing data, time values are computed according to this timeZone.\nIf the timeZone is not set, UTC (Coordinated Universal Time) is used.\nAnywhere else, time values are computed according to the time offset of your web client." })
  static tzOffset = Fields.Char({ compute: '_computeTzOffset', string: 'TimeZone offset', invisible: true })
  static userId = Fields.Many2one('res.users', { string: 'Salesperson', help: 'The internal user in charge of this contact.' })
  static vat = Fields.Char({ string: 'Tax ID', index: true, help: "The Tax Identification Number. Complete it if the contact is subjected to government taxes. Used in some legal statements." })
  static sameVatPartnerId = Fields.Many2one('res.partner', { string: 'Partner with same Tax ID', compute: '_computeSameVatPartnerId', store: false })
  static bankIds = Fields.One2many('res.partner.bank', 'partnerId', { string: 'Banks' })
  static website = Fields.Char('Website Link')
  static comment = Fields.Html({ string: 'Notes' })

  static categoryId = Fields.Many2many('res.partner.category', { column1: 'partnerId', column2: 'categoryId', string: 'Tags', default: self => self._defaultCategory() })
  static creditLimit = Fields.Float({ string: 'Credit Limit' })
  static active = Fields.Boolean({ default: true })
  static employee = Fields.Boolean({ help: "Check this box if this contact is an Employee." })
  static position = Fields.Char({ string: 'Job Position' })
  static type = Fields.Selection(
    [['contact', 'Contact'],
    ['invoice', 'Invoice Address'],
    ['delivery', 'Delivery Address'],
    ['other', 'Other Address'],
    ["private", "Private Address"],
    ], { string: 'Address Type', default: 'contact', help: "Invoice & Delivery addresses are used in sales orders. Private addresses are only visible by authorized users." })
  // address fields
  static street = Fields.Char()
  static street2 = Fields.Char()
  static zip = Fields.Char({ changeDefault: true })
  static city = Fields.Char()
  static stateId = Fields.Many2one("res.country.state", { string: 'State', ondelete: 'RESTRICT', domain: "[['countryId', '=?', countryId]]" })
  static countryId = Fields.Many2one('res.country', { string: 'Country', ondelete: 'RESTRICT' })
  static countryCode = Fields.Char({ related: 'countryId.code', string: "Country Code" })
  static partnerLatitude = Fields.Float({ string: 'Geo Latitude', digits: [10, 7] })
  static partnerLongitude = Fields.Float({ string: 'Geo Longitude', digits: [10, 7] })
  static email = Fields.Char()
  static emailFormatted = Fields.Char('Formatted Email', { compute: '_computeEmailFormatted', help: 'Format email address "Name <email@domain>"' })
  static phone = Fields.Char()
  static mobile = Fields.Char()
  static isCompany = Fields.Boolean({ string: 'Is a Company', default: false, help: "Check if the contact is a company, otherwise it is a person" })
  static industryId = Fields.Many2one('res.partner.industry', { string: 'Industry' })
  // companyType is only an interface field, do not use it in business logic
  static companyType = Fields.Selection([['person', 'Individual'], ['company', 'Company']], { string: 'Company Type', compute: '_computeCompanyType', inverse: '_writeCompanyType' })
  static companyId = Fields.Many2one('res.company', { string: 'Company', index: true })
  static color = Fields.Integer({ string: 'Color Index', default: 0 })
  static userIds = Fields.One2many('res.users', 'partnerId', { string: 'Users', autojoin: true })
  static partnerShare = Fields.Boolean('Share Partner', { compute: '_computePartnerShare', store: true, help: "Either customer (not a user), either shared user. Indicated the current partner is a customer without access or with a limited access created for sharing data." })
  static contactAddress = Fields.Char({ compute: '_computeContactAddress', string: 'Complete Address' })

  // technical field used for managing commercial fields
  static commercialPartnerId = Fields.Many2one('res.partner', { string: 'Commercial Entity', compute: '_computeCommercialPartner', recursive: true, store: true, index: true })
  static commercialCompanyName = Fields.Char('Company Name Entity', { compute: '_computeCommercialCompanyName', store: true })
  static companyName = Fields.Char('Company Name')
  static barcode = Fields.Char({ help: "Use a barcode to identify this contact.", copy: false, companyDependent: true })

  // hack to allow using plain browse record in qweb views, and used in ir.qweb.field.contact
  static self = Fields.Many2one(Partner._name, { compute: '_computeGetIds' })

  static _sqlConstraints = [
    ['check_label', "CHECK( (type='contact' AND label IS NOT NULL) or (type!='contact') )", 'Contacts require a label'],
  ]

  _defaultCategory() {
    return this.env.items('res.partner.category').browse(this._context['categoryId']);
  }

  async defaultGet(defaultFields: any) {
    const values = await _super(Partner, this).defaultGet(defaultFields);
    let parent = this.env.items("res.partner");
    if ('parentId' in defaultFields && values.get('parentId')) {
      parent = this.browse(values.get('parentId'));
      values['companyId'] = (await parent.companyId).id;
    }
    if ('lang' in defaultFields) {
      values['lang'] = values.get('lang') || await parent.lang || this.env.lang;
    }
    // protection for `defaultType` values leaking from menu action context (e.g. for crm's email)
    if ('type' in defaultFields && values.get('type')) {
      if (!(await this._fields['type'].getValues(this.env)).includes(values['type'])) {
        values['type'] = null;
      }
    }
    return values;
  }

  @api.depends('label', 'userIds.share', 'image1920', 'isCompany', 'type')
  async _computeAvatar1920() {
    await _super(Partner, this)._computeAvatar1920();
  }

  @api.depends('label', 'userIds.share', 'image1024', 'isCompany', 'type')
  async _computeAvatar1024() {
    await _super(Partner, this)._computeAvatar1024();
  }

  @api.depends('label', 'userIds.share', 'image512', 'isCompany', 'type')
  async _computeAvatar512() {
    await _super(Partner, this)._computeAvatar512();
  }

  @api.depends('label', 'userIds.share', 'image256', 'isCompany', 'type')
  async _computeAvatar256() {
    await _super(Partner, this)._computeAvatar256();
  }

  @api.depends('label', 'userIds.share', 'image128', 'isCompany', 'type')
  async _computeAvatar128() {
    await _super(Partner, this)._computeAvatar128();
  }

  async _computeAvatar(avatarField, imageField) {
    const partnersWithInternalUser = await this.filtered(async (partner) => {
      const userIds = await partner.userIds;
      const shareIds = await userIds.filtered('share');
      return userIds.sub(shareIds);
    });
    await _super(Partner, partnersWithInternalUser)._computeAvatar(avatarField, imageField);
    const partnersWithoutImage = await this.sub(partnersWithInternalUser).filtered(async (p) => !bool(await p[imageField]));
    for (const [_, group] of await groupbyAsync(partnersWithoutImage, (p) => p._avatarGetPlaceholderPath())) {
      const groupPartners = this.env.items('res.partner').concat(group);
      await groupPartners.set(avatarField, await groupPartners[0]._avatarGetPlaceholder());
    }
    for (const partner of this.sub(partnersWithInternalUser).sub(partnersWithoutImage)) {
      await partner.set(avatarField, await partner[imageField]);
    }
  }

  async _avatarGetPlaceholderPath() {
    if (await this['isCompany']) {
      return "base/static/img/company_image.png";
    }
    if (await this['type'] === 'delivery') {
      return "base/static/img/truck.png";
    }
    if (await this['type'] === 'invoice') {
      return "base/static/img/money.png";
    }
    return _super(Partner, this)._avatarGetPlaceholderPath();
  }

  @api.depends('isCompany', 'label', 'parentId.displayName', 'type', 'companyName')
  async _computeDisplayName() {
    const diff = { showAddress: null, showAddressOnly: null, showEmail: null, htmlFormat: null, showVat: null }
    const names = Dict.from(await (await this.withContext(diff)).nameGet());
    for (const partner of this as any) {
      await partner.set('displayName', names.get(partner.id));
    }
  }

  @api.depends('lang')
  async _computeActiveLangCount() {
    const langCount = (await this.env.items('res.lang').getInstalled())._length;
    for (const partner of this) {
      await partner.set('activeLangCount', langCount);
    }
  }

  @api.depends('tz')
  async _computeTzOffset() {
    for (const partner of this) {
      await partner.set('tzOffset', DateTime.now().setZone(await partner.tz || 'GMT').toFormat('ZZZZ'));
    }
  }

  @api.depends('userIds.share', 'userIds.active')
  async _computePartnerShare() {
    const superPartner = await this.env.items('res.users').browse(global.SUPERUSER_ID).partnerId;
    if (this.includes(superPartner)) {
      await superPartner.set('partnerShare', false);
    }
    for (const partner of this.sub(superPartner)) {
      const userIds = await partner.userIds;
      await partner.set('partnerShare', !userIds.ok || !(await userIds.some((user) => user.share)));
    }
  }

  @api.depends('vat', 'companyId')
  async _computeSameVatPartnerId() {
    for (const partner of this) {
      // use _origin to deal with onchange()
      const partnerId = partner._origin.id;
      // activeTest = false because if a partner has been deactivated you still want to raise the error,
      // so that you can reactivate it instead of creating a new one, which would loose its history.
      const Partner = await (await this.withContext({ activeTest: false })).sudo();
      let domain = [
        ['vat', '=', await partner.vat],
      ]
      if ((await partner.companyId).ok) {
        domain = domain.concat([['companyId', 'in', [false, (await partner.companyId).id]]]);
      }
      if (bool(partnerId)) {
        domain = domain.concat([['id', '!=', partnerId], '!', ['id', 'childOf', partnerId]]);
      }
      await partner.set('sameVatPartnerId', bool(await partner.vat) && !(await partner.parentId).ok && bool(await Partner.search(domain, { limit: 1 })));
    }
  }

  @api.depends((self) => self._displayAddressDepends())
  async _computeContactAddress() {
    for (const partner of this) {
      await partner.set('contactAddress', await partner._displayAddress());
    }
  }

  async _computeGetIds() {
    for (const partner of this) {
      await partner.set('self', partner.id);
    }
  }

  @api.depends('isCompany', 'parentId.commercialPartnerId')
  async _computeCommercialPartner() {
    for (const partner of this as any) {
      const parentId = await partner.parentId;
      if (await partner.isCompany || !bool(parentId)) {
        await partner.set('commercialPartnerId', partner);
      }
      else {
        await partner.set('commercialPartnerId', await parentId.commercialPartnerId);
      }
    }
  }

  @api.depends('companyName', 'parentId.isCompany', 'commercialPartnerId.label')
  async _computeCommercialCompanyName() {
    for (const partner of this) {
      const p = await partner.commercialPartnerId;
      await partner.set('commercialCompanyName', await p.isCompany && await p.label || await partner.companyName);
    }
  }

  @api.model()
  async _fieldsViewGet(viewId?: number, viewType: string = 'form', toolbar: boolean = false, submenu: boolean = false) {
    if (!viewId && (viewType === 'form') && this._context['forceEmail']) {
      viewId = (await this.env.ref('base.viewPartnerSimpleForm')).id;
    }
    const res = await _super(Partner, this)._fieldsViewGet(viewId, viewType, toolbar, submenu);
    if (viewType === 'form') {
      [res['dom'], res['arch']] = await (this as any)._fieldsViewGetAddress(res['arch']);
    }
    return res;
  }

  @api.constrains('parentId')
  async _checkParentId() {
    if (! await this._checkRecursion()) {
      throw new ValidationError(await this._t('You cannot create recursive Partner hierarchies.'));
    }
  }

  async copy(defaultValue?: any) {
    this.ensureOne();
    const chosenName = defaultValue ? defaultValue['label'] : '';
    const newName = chosenName || await this._t('%s (copy)', await this['label']);
    defaultValue = Object.assign({}, defaultValue, { label: newName });
    return _super(Partner, this).copy(defaultValue);
  }

  @api.onchange('parentId')
  async _onchangeParentIdForLang() {
    // While creating / updating child contact, take the parent lang by default if any
    // otherwise, fallback to default context / DB lang
    const parentId = await this['parentId'];
    if (parentId.ok) {
      await this.set('lang', await parentId.lang || this.env.context['default_lang'] || this.env.lang);
    }
  }

  @api.onchange('countryId')
  async _onchangeCountryId() {
    const [countryId, stateId] = await this('countryId', 'stateId');
    if (countryId.ok && !countryId.eq(await stateId.countryId)) {
      await this.set('stateId', false);
    }
  }

  @api.onchange('stateId')
  async _onchangeState() {
    const countryId = await (await this['stateId']).countryId;
    if (countryId.ok) {
      await this.set('countryId', countryId);
    }
  }

  @api.onchange('email')
  async onchangeEmail() {
    if (!bool(await this['image1920']) && this._context['gravatarImage'] && await this['email']) {
      await this.set('image1920', await this._getGravatarImage(await this['email']));
    }
  }

  @api.onchange('parentId', 'companyId')
  async _onchangeCompanyId() {
    const parentId = await this['parentId'];
    if (parentId.ok) {
      await this.set('companyId', (await parentId.companyId).id);
    }
  }

  /**
    * Compute formatted email for partner, using formataddr. Be defensive
            in computation, notably
    
    * double format: if email already holds a formatted email like
      'Name' <email@domain.com> we should not use it as it to compute
      email formatted like "Name <'Name' <email@domain.com>>";
    * multi emails: sometimes this field is used to hold several addresses
      like email1@domain.com, email2@domain.com. We currently let this value
      untouched, but remove any formatting from multi emails;
    * invalid email: if something is wrong, keep it in email_formatted as
      this eases management and understanding of failures at mail.mail,
      mail.notification and mailing.trace level;
    * void email: emailFormatted is false, as we cannot do anything with
      it;
   */
  @api.depends('label', 'email')
  async _computeEmailFormatted() {
    await this.set('emailFormatted', false);
    for (const partner of this) {
      const [label, email] = await partner('label', 'email');
      const emailsNormalized = emailNormalizeAll(email);
      if (emailsNormalized.length) {
        // note: multi-email input leads to invalid email like "Name" <email1, email2>
        // but this is current behavior in Verp 14+ and some servers allow it
        await partner.set('emailFormatted', formataddr([label || "false", emailsNormalized.join(',')]));
      }
      else if (email) {
        await partner.set('emailFormatted', formataddr([label || "false", email]));
      }
    }
  }

  @api.depends('isCompany')
  async _computeCompanyType() {
    for (const partner of this) {
      await partner.set('companyType', await partner.isCompany ? 'company' : 'person');
    }
  }

  async _writeCompanyType() {
    for (const partner of this) {
      await partner.set('isCompany', await partner.companyType === 'company');
    }
  }

  @api.onchange('companyType')
  async onchangeCompanyType() {
    await this.set('isCompany', await this['companyType'] === 'company');
  }

  @api.constrains('barcode')
  async _checkBarcodeUnicity() {
    const barcode = await this['barcode'];
    if (barcode && this.env.items('res.partner').searchCount([['barcode', '=', barcode]]) > 1) {
      throw new ValidationError('An other user already has this barcode');
    }
  }

  /**
   * Returns dict of write() values for synchronizing ``fields``
   * @param fields 
   */
  async _updateFieldsValues(fields) {
    const values = {};
    for (const fname of fields) {
      const field = this._fields[fname];
      if (field.type === 'many2one') {
        values[fname] = (await this[fname]).id;
      }
      else if (field.type === 'one2many') {
        throw new Error(await this._t('One2Many fields cannot be synchronized as part of `commercialFields` or `address fields`'));
      }
      else if (field.type === 'many2many') {
        values[fname] = [Command.set((await this[fname]).ids)];
      }
      else {
        values[fname] = await this[fname];
      }
    }
    return values;
  }

  @api.model()
  _addressFields() {
    return Array.from(ADDRESS_FIELDS);
  }

  /**
   * Returns the list of address fields usable to format addresses.
   * @returns 
   */
  @api.model()
  _formattingAddressFields() {
    return this._addressFields();
  }

  async updateAddress(vals) {
    const addrVals = Object.fromEntries(this._addressFields().filter(key => key in vals).map(key => [key, vals[key]]));
    if (len(addrVals)) {
      return _super(Partner, this).write(addrVals);
    }
  }

  /**
   * Returns the list of fields that are managed by the commercial entity
      to which a partner belongs. These fields are meant to be hidden on
      partners that aren't `commercial entities` themselves, and will be
      delegated to the parent `commercial entity`. The list is meant to be
      extended by inheriting classes.
   * @returns 
   */
  @api.model()
  _commercialFields() {
    return ['vat', 'creditLimit', 'industryId'];
  }

  /**
   * Handle sync of commercial fields when a new parent commercial entity is set, as if they were related fields
   */
  async _commercialSyncFromCompany() {
    const commercialPartner = await (this as any).commercialPartnerId;
    if (!commercialPartner.eq(this)) {
      const syncVals = await commercialPartner._updateFieldsValues(this._commercialFields());
      await this.write(syncVals);
    }
  }

  /**
   * Handle sync of commercial fields to descendants
   * @returns 
   */
  async _commercialSyncToChildren() {
    const self: any = this;
    const commercialPartner = await self.commercialPartnerId;
    const childIds = await self.childIds;
    const syncVals = await commercialPartner._updateFieldsValues(self._commercialFields());
    const syncChildren = await childIds.filtered(async (c) => ! await c.isCompany);
    for (const child of syncChildren) {
      await child._commercialSyncToChildren();
    }
    const res = await syncChildren.write(syncVals);
    await syncChildren._computeCommercialPartner();
    return res
  }


  async _fieldsSync(values: {}) {
    const self: any = this;
    // 1. From UPSTREAM: sync from parent
    if (values['parentId'] || values['type'] === 'contact') {
      // 1a. Commercial fields: sync if parent changed
      if (values['parentId']) {
        await this._commercialSyncFromCompany()
      }
      // 1b. Address fields: sync if parent or use_parent changed *and* both are now set
      if ((await self.parentId).ok && await self.type === 'contact') {
        const onchangeVals = (await this.onchangeParentId())['value'] ?? {};
        await this.updateAddress(onchangeVals);
      }
    }
    // 2. To DOWNSTREAM: sync children
    await this._childrenSync(values);
  }

  async _childrenSync(values) {
    const self: any = this;
    const _childIds = await self.childIds;
    if (!_childIds._length) {
      return
    }
    // 2a. Commercial Fields: sync if commercial entity
    const _commercialPartnerId = await self.commercialPartnerId;
    if (_commercialPartnerId.eq(self)) {
      const commercialFields = self._commercialFields();
      for (const field of commercialFields) {
        if (field in values) {
          await self._commercialSyncToChildren();
          break;
        }
      }
    }
    for (const child of await _childIds.filtered(async (c) => ! await c.isCompany)) {
      if (!_commercialPartnerId.eq(await child.commercialPartnerId)) {
        await self._commercialSyncToChildren();
        break;
      }
    }
    // 2b. Address fields: sync if address changed
    const addressFields = self._addressFields();
    for (const field of addressFields) {
      if (field in values) {
        const contacts = await _childIds.filtered(async (c) => await c.type === 'contact');
        await contacts.updateAddress(values);
        break;
      }
    }
  }

  /**
   * On creation of first contact for a company (or root) that has no address, assume contact address
    was meant to be company address
   */
  async _handleFirstContactCreation() {
    const parent = await (this as any).parentId;
    const addressFields = this._addressFields();
    let someAddress = false;
    let pSomeAddress = false;
    for (const f of addressFields) {
      if (await this[f]) {
        someAddress = true;
      }
      if (await parent[f]) {
        pSomeAddress = true;
      }
    }
    if ((await parent.isCompany || !(await parent.parentId).ok) && len(await parent.childIds) == 1 && someAddress && !pSomeAddress) {
      const addrVals = await this._updateFieldsValues(addressFields);
      await parent.updateAddress(addrVals);
    }
  }

  @api.model()
  static async _langGet(self) {
    return self.env.items('res.lang').getInstalled();
  }

  async write(values: {}): Promise<any> {
    if (values['active'] === false) {
      this.invalidateCache(['userIds'], this._ids);
      const users = await (await this.env.items('res.users').sudo()).search([['partnerId', 'in', this.ids]]);
      if (users.ok) {
        const names = [];
        for (const u of users) {
          names.push(await u.displayName);
        }
        if (await (await this.env.items('res.users').sudo(false)).checkAccessRights('write', false)) {
          const errorMsg = await this._t(`You cannot archive contacts linked to an active user.\n
          You first need to archive their associated user.\n\n
          Linked active users : %s`, names.join(', '));
        }
        else {
          throw new ValidationError(await this._t(`You cannot archive contacts linked to an active user.\n
          Ask an administrator to archive their associated user first.\n\n
          Linked active users :\n%s`, names));
        }
      }
    }
    if (values['website']) {
      values['website'] = await this._cleanWebsite(values['website']);
    }
    if (values['parentId']) {
      values['companyName'] = false;
    }
    if ('companyId' in values) {
      const companyId = values['companyId'];
      for (const partner of this) {
        const userIds = await partner.userIds;
        if (companyId && userIds.ok) {
          const company = this.env.items('res.company').browse(companyId);
          const companies = new Set();
          for (const user of userIds) {
            companies.add((await user.companyId).id);
          }
          if (companies.size > 1 || !companies.has(company.id)) {
            throw new UserError("The selected company is not compatible with the companies of the related user(s)");
          }
        }
        const childIds = await partner.childIds;
        if (childIds._length) {
          await childIds.write({ 'companyId': companyId });
        }
      }
    }
    let result = true;
    // To write in SUPERUSER on field is_company and avoid access rights problems.
    if ('isCompany' in values && await this.userHasGroups('base.groupPartnerManager') && !this.env.su) {
      result = await (await _super(Partner, this).sudo()).write({ 'isCompany': values['isCompany'] });
      delete values['isCompany'];
    }
    result = result && await _super(Partner, this).write(values);
    for (const _partner of this) {
      const partner: any = _partner;
      const userIds = await partner.userIds;
      for (const u of userIds) {
        if (await u.hasGroup('base.groupUser')) {
          await this.env.items('res.users').checkAccessRights('write');
          break;
        }
      }
      await partner._fieldsSync(values);
    }
    return result;
  }

  @api.modelCreateMulti()
  async create(valsList: any): Promise<any> {
    if (this.env.context['importFile']) {
      await this._checkImportConsistency(valsList);
    }
    for (const vals of valsList) {
      if (vals['website'])
        vals['website'] = this._cleanWebsite(vals['website']);
      if (vals['parentId'])
        vals['companyName'] = false;
    }
    const partners = await _super(Partner, this).create(valsList);

    if (this.env.context['_partnersSkipFieldsSync'])
      return partners;

    for (const [partner, vals] of _.zip<any, any>([...partners], valsList)) {
      await partner._fieldsSync(vals);
      // Lang: propagate from parent if no value was given
      if (!('lang' in vals) && (await partner.parentId).ok) {
        await partner._onchangeParentIdForLang();
      }
      await partner._handleFirstContactCreation();
    }
    return partners;
  }


  @api.ondelete(false)
  async _unlinkExceptUser() {
    const users = await (await this.env.items('res.users').sudo()).search([['partnerId', 'in', this.ids]]);
    if (!users.ok) {
      return;  // no linked user, operation is allowed
    }
    if (await (await this.env.items('res.users').sudo(false)).checkAccessRights('write', false)) {
      const errorMsg = _f(await this._t(`You cannot delete contacts linked to an active user.\n
                            You should rather archive them after archiving their associated user.\n\n
                            Linked active users : {names}`), { names: (await users.map(u => u.displayName)).join(", ") });
      const actionError = await users._actionShow()
      throw new RedirectWarning(errorMsg, actionError, await this._t('Go to users'));
    }
    else {
      throw new ValidationError(_f(await this._t(`You cannot delete contacts linked to an active user.\n
                                      Ask an administrator to archive their associated user first.\n\n
                                      Linked active users :\n{names}`), { names: (await users.map(u => u.displayName)).join(", ") }));
    }
  }

  async _loadRecordsCreate(valsList) {
    if (!len(valsList)) {
      return;
    }
    const partners = await _super(Partner, await this.withContext({ _partnersSkipFieldsSync: true }))._loadRecordsCreate(valsList);

    // batch up first part of _fieldsSync
    // group partners by commercialPartnerId (if not this) and parentId (if type == contact)
    const groups = new DefaultDict(); //list)
    for (const [partner, vals] of _.zip([...partners], valsList)) {
      let cpId;// = None
      const [commercialPartnerId, parentId] = await partner('commercialPartnerId', 'parentId');
      if (vals['parentId'] && !commercialPartnerId.eq(partner)) {
        cpId = commercialPartnerId.id;
      }

      let addId;
      if (parentId.ok && await partner.type === 'contact') {
        addId = parentId.id;
      }
      const key = `${cpId}@${addId}`;
      groups[key] = groups[key] ?? [];
      groups[key].push(partner.id);
    }

    for (const [key, children] of Object.entries(groups)) {
      let [cpId, addId] = key.split('@').map(id => tools.parseInt(id));
      // values from parents (commercial, regular) written to their common children
      let toWrite = {};
      // commercial fields from commercial partner
      if (cpId) {
        toWrite = await this.browse(cpId)._updateFieldsValues(this._commercialFields());
      }
      // address fields from parent
      if (addId) {
        const parent = this.browse(addId);
        for (const f of this._addressFields()) {
          const v = await parent[f];
          if (bool(v)) {
            toWrite[f] = isInstance(v, BaseModel) ? v.id : v;
          }
        }
      }
      if (bool(toWrite)) {
        await this.browse(children).write(toWrite);
      }
    }
    // do the second half of _fieldsSync the "normal" way
    for (const [partner, vals] of _.zip([...partners], valsList)) {
      await partner._childrenSync(vals);
      await partner._handleFirstContactCreation();
    }
    return partners;
  }

  async createCompany() {
    this.ensureOne();
    const [companyName, vat, childIds] = await this('companyName', 'vat', 'childIds');
    if (companyName) {
      // Create parent company
      const values = { label: companyName, isCompany: true, vat: vat };
      update(values, await this._updateFieldsValues(this._addressFields()));
      const newCompany = await this.create(values);
      // Set new company as my parent
      await this.write({
        'parentId': newCompany.id,
        'childIds': childIds.ids.map(partnerId => Command.update(partnerId, { parentId: newCompany.id }))
      })
    }
    return true;
  }

  /**
   * Utility method used to add an "Open Company" button in partner views
   * @returns 
   */
  async openCommercialEntity() {
    this.ensureOne();
    return {
      'type': 'ir.actions.actwindow',
      'resModel': 'res.partner',
      'viewMode': 'form',
      'resId': (await this['commercialPartnerId']).id,
      'target': 'current',
      'flags': { 'form': { 'actionButtons': true } }
    }
  }

  /**
   * Utility method used to add an "Open Parent" button in partner views
   * @returns 
   */
  async openParent() {
    this.ensureOne();
    const addressFormId = (await this.env.ref('base.viewPartnerAddressForm')).id;
    return {
      'type': 'ir.actions.actwindow',
      'resModel': 'res.partner',
      'viewMode': 'form',
      'views': [[addressFormId, 'form']],
      'resId': (await this['parentId']).id,
      'target': 'new',
      'flags': { 'form': { 'actionButtons': true } }
    }
  }

  @api.model()
  async _search(args: any, options?: { offset?: 0, limit?: number, order?: string, count?: boolean, accessRightsUid?: boolean }): Promise<number | Query | any[]> {
    let self: any = this;
    if (len(args) == 1 && len(args[0]) == 3 && _.eq(args[0].slice(0, 2), ['parentId', 'in']) && !_.eq(args[0][2], [false])) {
      self = await this.withContext({ activeTest: false });
    }
    return _super(Partner, self)._search(args, options);
  }

  async _getNameSearchOrderByFields() {
    return '';
  }

  @api.model()
  async _nameSearch(name?: string, args?: any, operator?: string, { limit = 100, nameGetUid = false } = {}): Promise<any> {
    let self = nameGetUid ? await this.withUser(nameGetUid) : this;
    // as the implementation is in SQL, we force the recompute of fields if necessary
    await self.recompute(['displayName']);
    await self.flush();
    if (args == null) {
      args = []
    }
    const orderByRank = self.env.context['resPartnerSearchMode'];
    if ((name || orderByRank) && ['=', 'ilike', '=ilike', 'like', '=like'].includes(operator)) {
      await self.checkAccessRights('read');
      const whereQuery = await self._whereCalc(args);
      await self._applyIrRules(whereQuery, 'read');
      let [fromClause, whereClause, whereClauseParams] = whereQuery.getSql();
      const fromStr = fromClause ? fromClause : '"resPartner"';
      const whereStr = (whereClause && (` WHERE ${whereClause} AND `)) ?? ' WHERE ';

      // search on the name of the contacts and of its company
      let searchName = name;
      if (['ilike', 'like'].includes(operator))
        searchName = `%${name}%`;
      if (['=ilike', '=like'].includes(operator))
        operator = operator.slice(1);

      const unaccent = await getUnaccentWrapper(self.env.cr);

      const fields = await self._getNameSearchOrderByFields();

      let query = `SELECT "resPartner".id
                    FROM {fromStr}
                {where} ({email} {operator} {percent}
                      OR {displayName} {operator} {percent}
                      OR {reference} {operator} {percent}
                      OR {vat} {operator} {percent})
                      -- don't panic, trust postgres bitmap
                ORDER BY {fields} {displayName} {operator} {percent} desc, {displayName}
              `;
      query = _format(query, {
        fromStr: fromStr,
        fields: fields,
        where: whereStr,
        operator: operator,
        email: unaccent('"resPartner"."email"'),
        displayName: unaccent('"resPartner"."displayName"'),
        reference: unaccent('"resPartner"."ref"'),
        percent: unaccent(`%s`),
        vat: unaccent('"resPartner"."vat"')
      });

      whereClauseParams = whereClauseParams.concat(_.fill(Array(3), searchName));  // for email / displayName, reference
      whereClauseParams = whereClauseParams.concat([searchName.replace(/[^a-zA-Z0-9\-\.]+/g, '') ?? null]);  // for vat
      whereClauseParams = whereClauseParams.concat([searchName]);  // for order by
      if (limit) {
        query += ' limit %s';
        whereClauseParams.push(limit);
      }
      const res = await self.env.cr.execute(_convert$(query), { bind: whereClauseParams });
      return res.map(row => row['id']);
    }
    return _super(Partner, self)._nameSearch(name, args, operator, { limit, nameGetUid });
  }

  @api.onchange('parentId')
  async onchangeParentId() {
    // return values in result, as this method is used by _fieldsSync()
    const self: any = this;
    const parentId = await self.parentId;
    if (!parentId._length)
      return
    const result = {}
    const partner = self._origin;
    const _parentId = await partner.parentId;
    if (_parentId._length && !_parentId.eq(await self.parentId)) {
      result['warning'] = {
        'title': await this._t('Warning'),
        'message': await this._t('Changing the company of a contact should only be done if it was never correctly set. If an existing contact starts working for a new company then a new contact should be created under that new company. You can use the "Discard" button to abandon this change.')
      }
    }
    if (await partner.type === 'contact' || await self.type === 'contact') {
      // for contacts: copy the parent address, if set (aka, at least one value is set in the address: otherwise, keep the one from the contact)
      const addressFields = self._addressFields();
      let found = false;
      for (const key of addressFields) {
        const k = await parentId[key];
        if (k) {
          found = true;
          break;
        }
      }
      if (found) {
        function convert(value) {
          return isInstance(value, BaseModel) ? value.id : value;
        }
        const res = result['value'] = {};
        for (const key of addressFields) {
          res[key] = convert(await parentId[key]);
        }
      }
    }
    return result;
  }

  _cleanWebsite(website: string) {
    const url = urlParse(website);
    if (!url.protocol) {
      url.protocol = 'http';
      website = url.toString();
    }
    return website;
  }

  async _getContactName(partner, name) {
    return f("%s, %s", await partner.commercialCompanyName || await (await (await partner.sudo()).parentId).label, name);
  }

  /**
   * Utility method to allow nameGet to be overrided without re-browse the partner
   * @returns 
   */
  async _getName() {
    const partner: any = this;;
    let name = await partner.label || '';

    if (await partner.companyName ?? bool(await partner.parentId)) {
      const type = await partner.type;
      if (!name && ['invoice', 'delivery', 'other'].includes(type)) {
        name = Dict.from((await this.fieldsGet(['type']))['type']['selection'])[type];
      }
      if (! await partner.isCompany) {
        name = await this._getContactName(partner, name);
      }
    }
    if (this._context['showAddressOnly']) {
      name = await partner._displayAddress(true);
    }
    if (this._context['showAddress']) {
      name = name + "\n" + await partner._displayAddress(true);
    }
    name = name.replace('\n\n', '\n');
    name = name.replace('\n\n', '\n');
    if (this._context['partnerShowDbId']) {
      name = f("%s (%s)", name, partner.id);
    }
    let splittedNames;
    if (this._context['addressInline']) {
      splittedNames = name.split("\n");
      name = splittedNames.filter(n => n.trim()).join(', ');
    }
    if (this._context['showEmail'] && await partner.email) {
      name = f("%s <%s>", name, await partner.email);
    }
    if (this._context['htmlFormat']) {
      name = name.replace('\n', '<br/>');
    }
    if (this._context['showVat'] && await partner.vat) {
      name = f("%s ‒ %s", name, await partner.vat);
    }
    return name;
  }

  async nameGet() {
    const res = [];
    for (const partner of this) {
      const name = await partner._getName();
      res.push([partner.id, name]);
    }
    return res;
  }

  /**
   * Parse partner name (given by text) in order to find a name and an
    email. Supported syntax:

      * Raoul <raoul@grosbedon.fr>
      * "Raoul le Grand" <raoul@grosbedon.fr>
      * Raoul raoul@grosbedon.fr (strange fault tolerant support from
        df40926d2a57c101a3e2d221ecfd08fbb4fea30e now supported directly
        in 'email_split_tuples';

    Otherwise: default, everything is set as the name. Starting from 13.3
    returned email will be normalized to have a coherent encoding.
   * @param text 
   * @returns 
   */
  _parsePartnerName(text: string) {
    let [name, email] = ['', ''];
    const splitResults = tools.emailSplitTuples(text);
    if (splitResults.length) {
      [name, email] = splitResults[0];
    }
    if (email) {
      email = tools.emailNormalize(email) as string;
    }
    else {
      [name, email] = [text, ''];
    }
    return [name, email]
  }

  /**
   * Find a partner with the given ``email`` or use method `~.nameCreate`
          to create a new one.
  
   * @param email email-like string, which should contain at least one email,
              e.g. ``"Raoul Grosbedon <r.g@grosbedon.fr>"``
   * @param assertValidEmail raise if no valid email is found
   * @returns newly created record
   */
  @api.model()
  @api.returns('self', (value) => value.id)
  async findOrCreate(email, assertValidEmail = false) {
    if (!email) {
      throw new ValueError(await this._t('An email is required for find_or_create to work'));
    }

    const [parsedName, parsedEmail] = this._parsePartnerName(email);
    if (!parsedEmail && assertValidEmail) {
      throw new ValueError(await this._t('A valid email is required for find_or_create to work properly.'));
    }

    const partners = await this.search([['email', '=ilike', parsedEmail]], { limit: 1 });
    if (partners.ok) {
      return partners;
    }

    const createValues = { [this.cls._recName]: parsedName || parsedEmail }
    if (parsedEmail) { // keep default_email in context
      createValues['email'] = parsedEmail;
    }
    return this.create(createValues);
  }

  async _getGravatarImage(email: string) {
    const emailHash = md5(new TextEncoder().encode(email.toLocaleLowerCase()));
    const url = "https://www.gravatar.com/avatar/" + emailHash;
    let result;
    console.log('Not implemented');
    // try {
    //     result = requests.get(url, params={'d': '404', 's': '128'}, timeout=5)
    //     if ressult.status_code != requests.codes.ok:
    //         return false
    // } catch(e) {
    //   if (isInstance(e, ConnectionError)) {
    //     return false;
    //   }
    //   if (isInstance(e, Timeout)) {
    //     return false;
    //   }
    // }
    return b64encode(result.content);
  }

  async _emailSend(emailFrom, subject, body, onErrora: any) {
    console.log('Not implemented');
    for (const partner of await this.filtered('email')) {
      // emailSend(emailFrom, [await partner.email], subject, body, onError);
    }
    return true;
  }
  /**
   * Find contacts/addresses of the right type(s) by doing a depth-first-search through descendants within company boundaries (stop at entities flagged ``isCompany``) then continuing the search at the ancestors that are within the same company boundaries.
     Defaults to partners of type ``'default'`` when the exact type is not found, or to the provided partner itself if no type ``'default'`` is found either. 
   * @param adrPref 
   * @returns 
   */
  async addressGet(adrPref?: any) {
    adrPref = new Set(adrPref ?? []);
    if (!adrPref.has('contact')) {
      adrPref.add('contact');
    }
    const result = {};
    const visited = new MapKey();
    for (const partner of this) {
      let currentPartner = partner;
      while (currentPartner.ok) {
        let toScan = [currentPartner];
        // Scan descendants, DFS
        while (toScan.length) {
          const record = toScan.shift();
          visited.set(record, true);
          const type = await record.type;
          if (adrPref.has(type) && !result[type]) {
            result[type] = record.id;
          }
          if (len(result) == len(adrPref)) {
            return result;
          }
          const children = [];
          for (const child of await record.childIds) {
            if (!visited.has(child) && !await child.isCompany) {
              children.push(child);
            }
          }
          toScan = children.concat(toScan);
        }
        // Continue scanning at ancestor if current_partner is not a commercial entity
        const [isCompany, cParentId] = await currentPartner('isCompany', 'parentId');
        if (isCompany || !cParentId.ok) {
          break;
        }
        currentPartner = cParentId;
      }
    }

    // default to type 'contact' or the partner itself
    const defaultValue = result['contact'] || this.id || false;
    for (const adrType of adrPref) {
      result[adrType] = result[adrType] || defaultValue;
    }
    return result;
  }

  @api.model()
  async viewHeaderGet(viewId, viewType = 'form') {
    if (this.env.context['categoryId']) {
      return _f(
        await this._t('Partners: {category}'),
        { category: await (this.env.items('res.partner.category').browse(this.env.context['categoryId'])).label },
      )
    }
    return _super(Partner, this).viewHeaderGet(viewId, viewType)
  }

  /**
   * Return the main partner
   * @returns 
   */
  @api.model()
  @api.returns('self')
  async mainPartner() {
    return this.env.ref('base.mainPartner')
  }

  @api.model()
  _getDefaultAddressFormat() {
    return "{street}\n{street2}\n{city} {stateCode} {zip}\n{countryName}";
  }


  @api.model()
  async _getAddressFormat() {
    return await (await this['countryId']).addressFormat || this._getDefaultAddressFormat();
  }

  async _prepareDisplayAddress(withoutCompany: boolean = false) {
    // get the information that will be injected into the display format
    // get the address format
    let addressFormat = await this._getAddressFormat();
    const self: any = this;
    const args = {
      'stateCode': await (await self.stateId).code || '',
      'stateName': await (await self.stateId).label || '',
      'countryCode': await (await self.countryId).code || '',
      'countryName': await self._getCountryName(),
      'companyName': await self.commercialCompanyName || '',
    };
    for (const field of self._formattingAddressFields()) {
      args[field] = await self[field] || '';
    }
    if (withoutCompany) {
      args['companyName'] = '';
    }
    else if (await self.commercialCompanyName) {
      addressFormat = '{companyName}\n' + addressFormat;
    }
    return [addressFormat, args];
  }

  /**
   * The purpose of this function is to build and return an address formatted accordingly to the
  standards of the country where it belongs.
 
    @param withoutCompany if address contains company
    @returns the address formatted in a display that fit its country habits (or the default ones
      if not country is specified)
   */
  async _displayAddress(withoutCompany = false) {
    const [addressFormat, args] = await this._prepareDisplayAddress(withoutCompany);
    return _f(addressFormat, args);
  }

  _displayAddressDepends() {
    // field dependencies of method _displayAddress()
    return this._formattingAddressFields().concat([
      'countryId', 'companyName', 'stateId',
    ])
  }

  @api.model()
  async getImportTemplates() {
    return [{
      'label': await this._t('Import Template for Customers'),
      'template': '/base/static/xls/res_partner.xls'
    }];
  }

  /**
   * The values created by an import are generated by a name search, field by field.
    As a result there is no check that the field values are consistent with each others.
    We check that if the state is given a value, it does belong to the given country, or we remove it.

   * @param valsList 
   */
  @api.model()
  async _checkImportConsistency(valsList) {
    const States = this.env.items('res.country.state');
    const statesIds = new Set(valsList.filter(vals => vals['stateId']).map(vals => vals['stateId']));
    const stateToCountry = await (await States.search([['id', 'in', Array.from(statesIds)]])).read(['countryId']);
    for (const vals of valsList) {
      if (vals['stateId']) {
        const countryId = next(stateToCountry.filter(c => c['id'] == vals['stateId']).map(c => c['countryId'][0]));
        let state = States.browse(vals['stateId']);
        if ((await state.countryId).id != countryId) {
          const stateDomain = [['code', '=', await state.code], ['countryId', '=', countryId]];
          state = await States.search(stateDomain, { limit: 1 });
          vals['stateId'] = state.id  // replace state or remove it if not found
        }
      }
    }
  }

  async _getCountryName() {
    return await (await this['countryId']).name || '';
  }
}

@MetaModel.define()
class ResPartnerIndustry extends Model {
  static _module = module;
  static _description = 'Industry';
  static _name = "res.partner.industry";
  static _order = "label";

  static label = Fields.Char('Label', { translate: true });
  static fullName = Fields.Char('Full Name', { translate: true });
  static active = Fields.Boolean('Active', { default: true });
}