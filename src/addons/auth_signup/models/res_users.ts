import assert from "assert";
import _ from "lodash";
import { DateTime } from "luxon";
import { MailDeliveryException } from "../../../core/addons/base/models/ir_mail_server";
import * as api from "../../../core/api";
import { Fields } from "../../../core/fields";
import { DefaultDict } from "../../../core/helper/collections";
import { UserError, ValueError } from "../../../core/helper/errors";
import { MetaModel, Model, ModelRecords, _super } from "../../../core/models";
import { FALSE_DOMAIN, NEGATIVE_TERM_OPERATORS, TERM_OPERATORS_NEGATION, TRUE_DOMAIN } from "../../../core/osv/expression";
import { isInstance, pop, update } from "../../../core/tools";
import { literalEval } from "../../../core/tools/ast";
import { bool } from "../../../core/tools/bool";
import { len } from "../../../core/tools/iterable";
import { SignupError } from "./res_partner";

@MetaModel.define()
class ResUsers extends Model {
  static _module = module;
  static _parents = 'res.users';

  static state = Fields.Selection([['new', 'Never Connected'], ['active', 'Confirmed']], { compute: '_computeState', search: '_searchState', string: 'Status' });

  async _searchState(operator, value) {
    let negative = NEGATIVE_TERM_OPERATORS.includes(operator);

    // In case we have no value
    if (!bool(value)) {
      return negative ? TRUE_DOMAIN : FALSE_DOMAIN;
    }

    if (['in', 'not in'].includes(operator)) {
      if (len(value) > 1) {
        return negative ? FALSE_DOMAIN : TRUE_DOMAIN;
      }
      let comp;
      if (value[0] === 'new') {
        comp = negative ? '!=' : '=';
      }
      if (value[0] === 'active') {
        comp = negative ? '=' : '!=';
      }
      return [['logIds', comp, false]];
    }

    if (['=', '!='].includes(operator)) {
      // In case we search against anything else than new, we have to invert the operator
      if (value !== 'new') {
        operator = TERM_OPERATORS_NEGATION[operator];
      }

      return [['logIds', operator, false]];
    }

    return TRUE_DOMAIN;
  }

  async _computeState() {
    for (const user of this) {
      await user.set('state', await user.loginDate ? 'active' : 'new');
    }
  }

  /**
   * signup a user, to either:
          - create a new user (no token), or
          - create a user for a partner (with token, but no user for partner), or
          - change the password of a user (with token, and existing user).
          :param values: a dictionary with field values that are written on user
          :param token: signup token (optional)
          :return: (dbname, login, password) for the signed up user
   * @param values 
   * @param token 
   * @returns 
   */
  @api.model()
  async signup(values, token?: any) {
    if (token) {
      // signup with a token: find the corresponding partner id
      const partner = await this.env.items('res.partner')._signupRetrievePartner(token, true, true);
      // invalidate signup token
      await partner.write({ 'signupToken': false, 'signupType': false, 'signupExpiration': false });

      const [userIds, countryId, companyId, zip, city, lang] = await partner('userIds', 'countryId', 'companyId', 'zip', 'city', 'lang');
      let partnerUser = userIds.ok && bool(userIds[0]) ? userIds[0] : false;

      // avoid overwriting existing (presumably correct) values with geolocation data
      if (countryId.ok || zip || city) {
        pop(values, 'city', null);
        pop(values, 'countryId', null);
      }
      if (lang) {
        pop(values, 'lang', null);
      }

      if (bool(partnerUser)) {
        // user exists, modify it according to values
        pop(values, 'login', null);
        pop(values, 'label', null);
        await partnerUser.write(values);
        if (! await partnerUser.loginDate) {
          await partnerUser._notifyInviter();
        }
        return [this.env.cr.dbName, await partnerUser.login, values['password']];
      }
      else {
        // user does not exist: sign up invited user
        update(values, {
          'label': await partner.label,
          'partnerId': partner.id,
          'email': values['email'] || values['login'],
        })
        if (companyId.ok) {
          values['companyId'] = companyId.id;
          values['companyIds'] = [[6, 0, [companyId.id]]];
        }
        partnerUser = await this._signupCreateUser(values);
        await partnerUser._notifyInviter();
      }
    }
    else {
      // no token, sign up an external user
      values['email'] = values['email'] || values['login'];
      await this._signupCreateUser(values);
    }

    return [this.env.cr.dbName, values['login'], values['password']];
  }

  @api.model()
  async _getSignupInvitationScope() {
    return (await this.env.items('ir.config.parameter').sudo()).getParam('auth_signup.invitationScope', 'b2b');
  }

  /**
   * signup a new user using the template user
   * @param values 
   * @returns 
   */
  @api.model()
  async _signupCreateUser(values) {
    // check that uninvited users may sign up
    if (!('partnerId' in values)) {
      if (await this._getSignupInvitationScope() !== 'b2c') {
        throw new SignupError(await this._t('Signup is not allowed for uninvited users'));
      }
    }
    return this._createUserFromTemplate(values);
  }

  async _notifyInviter() {
    for (const user of this) {
      const invitePartner = await (await user.createdUid).partnerId;
      if (invitePartner) {
        // notify invite user that new user is connected
        this.env.items('bus.bus')._sendone(invitePartner, 'res.users/connection', {
          'username': await user.label,
          'partnerId': (await user.partnerId).id,
        });
      }
    }
  }

  async _createUserFromTemplate(values) {
    const templateUserId = literalEval(await (await this.env.items('ir.config.parameter').sudo()).getParam('base.templatePortalUserId', 'false'));
    const templateUser = this.browse(templateUserId);
    if (!bool(await templateUser.exists())) {
      throw new ValueError(await this._t('Signup: invalid template user'));
    }

    if (!values['login']) {
      throw new ValueError(await this._t('Signup: no login given for new user'));
    }
    if (!values['partnerId'] && !values['label']) {
      throw new ValueError(await this._t('Signup: no name or partner given for new user'));
    }

    // create a copy of the template user (attached to a specific partnerId if given)
    values['active'] = true;
    try {
      // with await this.env.cr.savepoint():
      return await (await templateUser.withContext({ noResetPassword: true })).copy(values);
    } catch (e) {
      // except Exception as e:
      // copy may failed if asked login is not available.
      throw new SignupError(String(e));
    }
  }

  /**
   * retrieve the user corresponding to login (login or email), and reset their password
   * @param self 
   * @param login 
   */
  async resetPassword(login) {
    let users = await this.search([['login', '=', login]]);
    if (!users.ok) {
      users = await this.search([['email', '=', login]]);
    }
    if (users._length != 1) {
      throw new Error(await this._t('Reset password: invalid username or email'));
    }
    return users.actionResetPassword();
  }

  /**
   * create signup token for each user, and send their signup url by email
   * @returns 
   */
  async actionResetPassword() {
    if (this.env.context['installMode'] ?? false) {
      return;
    }
    if (bool(await this.filtered(async (user) => ! await user.active))) {
      throw new UserError(await this._t("You cannot perform this action on an archived user."));
    }
    // prepare reset password signup
    const createMode = bool(this.env.context['createUser']);

    // no time limit for initial invitation, only for reset password
    const expiration = createMode ? false : DateTime.now().plus({ days: 1 }).toJSDate();

    await (await this.mapped('partnerId')).signupPrepare("reset", expiration);

    // send email to users with their signup url
    let template = null;
    if (createMode) {
      try {
        template = await this.env.ref('auth_signup.setPasswordEmail', false);
      } catch (e) {
        if (!isInstance(e, ValueError)) {
          throw e;
        }
      }
    }
    if (!template) {
      template = await this.env.ref('auth_signup.resetPasswordEmail');
    }
    assert(template._name === 'mail.template');

    const emailValues = {
      'emailCc': false,
      'autoDelete': true,
      'recipientIds': [],
      'partnerIds': [],
      'scheduledDate': false,
    }

    for (const user of this) {
      const userEmail = await user.email;
      if (!userEmail) {
        throw new UserError(await this._t("Cannot send email: user %s has no email address.", await user.label));
      }
      emailValues['emailTo'] = userEmail;
      // TDE FIXME: make this template technical (qweb)
      // with self.env.cr.savepoint():
      {
        const forceSend = !(this.env.context['importFile'] ?? false);
        await template.sendMail(user.id, { forceSend: forceSend, raiseException: true, emailValues: emailValues });
      }
      console.info("Password reset email sent for user <%s> to <%s>", await user.login, userEmail);
    }
  }

  async sendUnregisteredUserReminder(afterDays = 5) {
    const datetimeMin = DateTime.now().minus({ days: afterDays });
    const datetimeMax = datetimeMin.plus({ hours: 23, minutes: 59, seconds: 59 });

    const resUsersWithDetails = await this.env.items('res.users').searchRead(
      [
        ['share', '=', false],
        ['createdUid.email', '!=', false],
        ['createdAt', '>=', datetimeMin.toJSDate()],
        ['createdAt', '<=', datetimeMax.toJSDate()],
        ['logIds', '=', false]
      ], ['createdUid', 'label', 'login']
    );

    // group by invited by
    const invitedUsers = new DefaultDict<any, ModelRecords>()//list)
    for (const user of resUsersWithDetails) {
      const createdUid = user['createdUid'][0]
      invitedUsers[createdUid] = invitedUsers[createdUid] || [];
      invitedUsers[createdUid].push(`${user['label']} (${user['login']})`);
    }

    // For sending mail to all the invitors about their invited users
    for (const user of invitedUsers.keys()) {
      const template = await (await this.env.ref('auth_signup.mailTemplateDataUnregisteredUsers')).withContext({ dbName: this._cr.dbName, invitedUsers: invitedUsers[user] });
      template.sendMail(user, { notifLayout: 'mail.mailNotificationLight', forceSend: false });
    }
  }

  @api.model()
  async webCreateUsers(emails) {
    const inactiveUsers = await this.search([['state', '=', 'new'], '|', ['login', 'in', emails], ['email', 'in', emails]]);
    const newEmails = new Set(_.difference(emails, await inactiveUsers.mapped('email')));
    const res = await _super(ResUsers, this).webCreateUsers(Array.from(newEmails));
    if (inactiveUsers.ok) {
      await (await inactiveUsers.withContext({ createdUser: true })).actionResetPassword();
    }
    return res;
  }

  @api.modelCreateMulti()
  async create(valsList) {
    // overridden to automatically invite user to sign up
    const users = await _super(ResUsers, this).create(valsList);
    if (!this.env.context['noResetPassword']) {
      const usersWithEmail = await users.filtered('email');
      if (usersWithEmail.ok) {
        try {
          await (await usersWithEmail.withContext({ createUser: true })).actionResetPassword();
        } catch (e) {
          if (isInstance(e, MailDeliveryException)) {
            await (await (await usersWithEmail.partnerId).withContext({ createUser: true })).signupCancel();
          }
          throw e;
        }
      }
    }
    return users;
  }

  @api.returns('self', (value) => value.id)
  async copy(defaultValue?: any) {
    this.ensureOne();
    let sup = _super(ResUsers, this);
    if (!defaultValue || !defaultValue['email']) {
      // avoid sending email to the user we are duplicating
      sup = await _super(ResUsers, await this.withContext({ noResetPassword: true }));
    }
    return sup.copy({ defaultValue: defaultValue });
  }
}