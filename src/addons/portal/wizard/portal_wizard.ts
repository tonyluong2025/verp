import _ from "lodash";
import { api } from "../../../core";
import { Command, Fields } from "../../../core/fields";
import { UserError } from "../../../core/helper/errors";
import { MetaModel, TransientModel } from "../../../core/models";
import { len } from "../../../core/tools/iterable";
import { emailNormalize } from "../../../core/tools/mail";

@MetaModel.define()
class PortalWizard extends TransientModel {
  static _module = module;
  static _name = 'portal.wizard';
  static _description = 'Grant Portal Access';

  async _defaultPartnerIds() {
    const partnerIds = this.env.context['default_partnerIds'] ?? this.env.context['activeIds'] ?? [];
    let contactIds = [];
    for (const partner of (await this.env.items('res.partner').sudo()).browse(partnerIds)) {
      const contactPartners = (await (await partner.childIds).filtered(async (p) => ['contact', 'other'].includes(await p.type))).or(partner);
      contactIds = _.union(contactIds, contactPartners.ids);
    }
    return contactIds.map(contactId => Command.link(contactId));
  }
    
  static partnerIds = Fields.Many2many('res.partner', {string: 'Partners', default: self => self._defaultPartnerIds()});
  static userIds = Fields.One2many('portal.wizard.user', 'wizardId', { string: 'Users', compute: '_computeUserIds', store: true, readonly: false});
  static welcomeMessage = Fields.Text('Invitation Message', {help: "This text is included in the email sent to new users of the portal."});
  
  @api.depends('partnerIds')
  async _computeUserIds() {
    for (const portalWizard of this) {
      const userIds = [];
      for (const partner of await portalWizard.partnerIds) {
        userIds.push(Command.create({
          'partnerId': partner.id,
          'email': await partner.email,
        }));
      }
      await portalWizard.set('userIds', userIds);
    }
  }

  /**
   * Create a "portal.wizard" and open the form view.

    We need a server action for that because the one2many "user_ids" records need to exist to be able to execute an a button action on it. If they have no ID, the buttons will be disabled and we won't be able to click on them.

    That's why we need a server action, to create the records and then open the form view on them.
   * @returns 
   */
  @api.model()
  async actionOpenWizard() {
    const portalWizard = await this.create({});
    return portalWizard._actionOpenModal()
  }

  /**
   * Allow to keep the wizard modal open after executing the action.
   * @returns 
   */
  async _actionOpenModal() {
    return {
      'label': await this._t('Portal Access Management'),
      'type': 'ir.actions.actwindow',
      'resModel': 'portal.wizard',
      'viewType': 'form',
      'viewMode': 'form',
      'resId': this.id,
      'target': 'new',
    }
  }
}

/**
 * A model to configure users in the portal wizard.
 */
@MetaModel.define()
class PortalWizardUser extends TransientModel {
  static _module = module;
  static _name = 'portal.wizard.user';
  static _description = 'Portal User Config';

  static wizardId = Fields.Many2one('portal.wizard', {string: 'Wizard', required: true, ondelete: 'CASCADE'});
  static partnerId = Fields.Many2one('res.partner', {string: 'Contact', required: true, readonly: true, ondelete: 'CASCADE'});
  static email = Fields.Char('Email');
  static userId = Fields.Many2one('res.users', {string: 'User', compute: '_computeUserId', computeSudo: true});
  static loginDate = Fields.Datetime({related: 'userId.loginDate', string: 'Latest Authentication'});
  static isPortal = Fields.Boolean('Is Portal', {compute: '_computeGroupDetails'});
  static isInternal = Fields.Boolean('Is Internal', {compute: '_computeGroupDetails'});

  @api.depends('partnerId')
  async _computeUserId() {
    for (const portalWizardUser of this) {
      const user = await (await (await portalWizardUser.partnerId).withContext({activeTest: false})).userIds;
      await portalWizardUser.set('userId', user.ok ? user(0) : false);
    }
  }

  @api.depends('userId', 'userId.groupsId')
  async _computeGroupDetails() {
    for (const portalWizardUser of this) {
      const user = await portalWizardUser.userId;

      let isInternal, isPortal;
      if (user.ok && await user.hasGroup('base.groupUser')) {
        isInternal = true;
        isPortal = false;
      }
      else if (user.ok && await user.hasGroup('base.groupPortal')) {
        isInternal = false;
        isPortal = true;
      }
      else {
        isInternal = false;
        isPortal = false;
      }
      // await Promise.all([
        await portalWizardUser.set('isInternal', isInternal);
        await portalWizardUser.set('isPortal', isPortal);
      // ]);
    }
  }

  /**
   * Grant the portal access to the partner.

    If the partner has no linked user, we will create a new one in the same company as the partner (or in the current company if not set).

    An invitation email will be sent to the partner.
   * @returns 
   */
  async actionGrantAccess() {
    this.ensureOne();
    this._assertUserEmailUniqueness();

    const partnerId = await this['partnerId'];

    if (await this['isPortal'] || await this['isInternal']) {
      throw new UserError(await this._t('The partner "%s" already has the portal access.', await partnerId.label));
    }

    const groupPortal = await this.env.ref('base.groupPortal');
    const groupPublic = await this.env.ref('base.groupPublic');

    // update partner email, if a new one was introduced
    if (await partnerId.email !== await this['email']) {
      await partnerId.write({'email': await this['email']});
    }

    let userSudo = await (await this['userId']).sudo();

    if (! userSudo.ok) {
      // create a user if necessary and make sure it is in the portal group
      const companyId = await partnerId.companyId;
      const company = companyId.ok ? companyId : await this.env.company();
      userSudo = await (await (await this.sudo()).withCompany(company.id))._createUser();
    }
    if (! await userSudo['active'] || ! await this['isPortal']) {
      await userSudo.write({'active': true, 'groupsId': [[4, groupPortal.id], [3, groupPublic.id]]});
      // prepare for the signup process
      await (await userSudo.partnerId).signupPrepare();
    }

    await (await this.withContext({activeTest: true}))._sendEmail();

    return await (await this['wizardId'])._actionOpenModal();
  }

  /**
   * Remove the user of the partner from the portal group.

    If the user was only in the portal group, we archive it.
   * @returns 
   */
  async actionRevokeAccess() {
    this.ensureOne();
    this._assertUserEmailUniqueness();

    const partnerId = await this['partnerId'];
    if (! await this['isPortal']) {
      throw new UserError(await this._t('The partner "%s" has no portal access.', await partnerId.label));
    }

    const groupPortal = await this.env.ref('base.groupPortal');
    const groupPublic = await this.env.ref('base.groupPublic');

    // update partner email, if a new one was introduced
    if (await partnerId.email !== await this['email']) {
      await partnerId.write({'email': await this['email']});
    }

    // Remove the sign up token, so it can not be used
    await (await partnerId.sudo()).set('signupToken', false);

    let userSudo = await (await this['userId']).sudo();

    // remove the user from the portal group
    if (userSudo.ok && await userSudo.hasGroup('base.groupPortal')) {
      // if user belongs to portal only, deactivate it
      if (len(await userSudo.groupsId) <= 1) {
        await userSudo.write({'groupsId': [[3, groupPortal.id], [4, groupPublic.id]], 'active': false});
      }
      else {
        await userSudo.write({'groupsId': [[3, groupPortal.id], [4, groupPublic.id]]});
      }
    }
    return (await this['wizardId'])._actionOpenModal();
  }

  /**
   * Re-send the invitation email to the partner.
   * @returns 
   */
  async actionInviteAgain() {
    this.ensureOne();

    const partnerId = await this['partnerId'];

    if (! await this['isPortal']) {
      throw new UserError(await this._t('You should first grant the portal access to the partner "%s".', await partnerId.label));
    }
    // update partner email, if a new one was introduced
    if (await partnerId.email !== await this['email']) {
      await partnerId.write({'email': await this['email']});
    }

    await (await this.withContext({activeTest: true}))._sendEmail();

    return (await this['wizardId'])._actionOpenModal();
  }

  /**
   * create a new user for wizard_user.partnerId
        :returns record of res.users
   * @returns 
   */
  async _createUser() {
    return (await this.env.items('res.users').withContext({noResetPassword: true}))._createUserFromTemplate({
      'email': emailNormalize(await this['email']),
      'login': emailNormalize(await this['email']),
      'partnerId': (await this['partnerId']).id,
      'companyId': (await this.env.company()).id,
      'companyIds': [[6, 0, (await this.env.company()).ids]],
    })
  }

  /**
   * send notification email to a new portal user
   * @returns 
   */
  async _sendEmail() {
    this.ensureOne();

    // determine subject and body in the portal user's language
    const template = await this.env.ref('portal.mailTemplateDataPortalWelcome');
    if (! template) {
      throw new UserError(await this._t('The template "Portal: new user" not found for sending email to the portal user.'));
    }
    const userSudo = await (await this['userId']).sudo();
    const lang = await userSudo.lang;
    const partner = await userSudo.partnerId;

    const portalUrl = (await (await partner.withContext({signupForceTypeInUrl: '', lang: lang}))._getSignupUrlForAction())[partner.id];
    await partner.signupPrepare();

    await (await template.withContext({dbname: this._cr.dbName, portalUrl: portalUrl, lang: lang})).sendMail(this.id, true);

    return true;
  }

  /**
   * Check that the email can be used to create a new user.
   */
  async _assertUserEmailUniqueness() {
    this.ensureOne();

    const email = emailNormalize(await this['email']);

    if (!email) {
      throw new UserError(await this._t('The contact "%s" does not have a valid email.', (await this['partnerId']).label));
    }
    const user = await (await (await this.env.items('res.users').sudo()).withContext({activeTest: false})).search([
      ['id', '!=', (await this['userId']).id],
      ['login', '=ilike', email],
    ]);

    if (user.ok) {
      throw new UserError(await this._t('The contact "%s" has the same email has an existing user (%s).', await (await this['partnerId']).label, await user.label));
    }
  }
}