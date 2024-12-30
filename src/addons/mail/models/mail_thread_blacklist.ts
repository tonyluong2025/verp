import { api } from "../../../core";
import { Fields } from "../../../core/fields";
import { AccessError, NotImplementedError, UserError } from "../../../core/helper/errors";
import { AbstractModel, MetaModel, _super } from "../../../core/models";
import { len } from "../../../core/tools/iterable";
import { emailNormalize } from "../../../core/tools/mail";

/**
 * Mixin that is inherited by all model with opt out. This mixin stores a normalized
    email based on primary_email field.

    A normalized email is considered as :
        - having a left part + @ + a right part (the domain can be without '.something')
        - being lower case
        - having no name before the address. Typically, having no 'Name <>'
    Ex:
        - Formatted Email : 'Name <NaMe@DoMaIn.CoM>'
        - Normalized Email : 'name@domain.com'

    The primary email field can be specified on the parent model, if it differs from the default one ('email')
    The email_normalized field can than be used on that model to search quickly on emails (by simple comparison
    and not using time consuming regex anymore).

    Using this email_normalized field, blacklist status is computed.

    Mail Thread capabilities are required for this mixin.
 */
@MetaModel.define()
class MailBlackListMixin extends AbstractModel {
  static _module = module;
  static _name = 'mail.thread.blacklist';
  static _parents = ['mail.thread'];
  static _description = 'Mail Blacklist mixin';

  static emailNormalized = Fields.Char(
    {string: 'Normalized Email', compute: "_computeEmailNormalized", computeSudo: true, store: true, invisible: true, help: "This field is used to search on email address as the primary email field can contain more than strictly an email address."})
  // Note : is_blacklisted sould only be used for display. As the compute is not depending on the blacklist,
  // once read, it won't be re-computed again if the blacklist is modified in the same request.
  static isBlacklisted = Fields.Boolean(
    {string: 'Blacklist', compute: "_computeIsBlacklisted", computeSudo: true, store: false, search: "_searchIsBlacklisted", groups: "base.groupUser", help: "If the email address is on the blacklist, the contact won't receive mass mailing anymore, from any list"})
  // messaging
  static messageBounce = Fields.Integer('Bounce', {help: "Counter of the number of bounced emails for this contact", default: 0})

  get _primaryEmail() {
    return 'email';
  }

  @api.depends((self) => [self._primaryEmail])
  async _computeEmailNormalized() {
    await this._assertPrimaryEmail();
    for (const record of this) {
      await record.set('emailNormalized', emailNormalize(await record[this._primaryEmail]));
    }
  }

  @api.model()
  async _searchIsBlacklisted(operator, value) {
    // Assumes operator is '=' or '!=' and value is true or false
    await this.flush(['emailNormalized']);
    await this.env.items('mail.blacklist').flush(['email', 'active']);
    await this._assertPrimaryEmail();
    if (operator !== '=') {
      if (operator === '!=' && typeof(value) === 'boolean') {
        value = !value;
      }
      else {
        throw new NotImplementedError();
      }
    }
    let query;
    if (value) {
      query = `
        SELECT m.id
          FROM "mailBlacklist" bl
          JOIN "%s" m
          ON m."emailNormalized" = bl.email AND bl.active
      `
    }
    else {
      query = `
        SELECT m.id
          FROM "%s" m
          LEFT JOIN "mailBlacklist" bl
          ON m."emailNormalized" = bl.email AND bl.active
          WHERE bl.id IS NULL
      `
    }
    const res = await this._cr.execute(query, [this.cls._table]);
    if (! len(res)) {
      return [[0, '=', 1]]
    }
    return [['id', 'in', res.map(r => r['id'])]];
  }

  @api.depends('emailNormalized')
  async _computeIsBlacklisted() {
    // TODO : Should remove the sudo as computeSudo defined on methods.
    // But if user doesn't have access to mail.blacklist, doen't work without sudo().
    const blacklist = new Set(await (await (await this.env.items('mail.blacklist').sudo()).search([
      ['email', 'in', await this.mapped('emailNormalized')]
    ])).mapped('email'));
    for (const record of this) {
      await record.set('isBlacklisted', blacklist.has(await record.emailNormalized));
    }
  }

  async _assertPrimaryEmail() {
    if (!this._primaryEmail || typeof(this._primaryEmail) !== 'string') {
      throw new UserError(await this._t('Invalid primary email field on model %s', this._name));
    }
    if (!(this._primaryEmail in this._fields) || this._fields[this._primaryEmail].type !== 'char') {
      throw new UserError(await this._t('Invalid primary email field on model %s', this._name));
    }
  }

  /**
   * Override of mail.thread generic method. Purpose is to increment the
    bounce counter of the record.
   * @param email 
   * @param partner 
   */
  async _messageReceiveBounce(email, partner) {
    await _super(MailBlackListMixin, this)._messageReceiveBounce(email, partner);
    for (const record of this) {
      await record.set('messageBounce', await record.messageBounce + 1);
    }
  }

  /**
   * Override of mail.thread generic method. Purpose is to reset the
    bounce counter of the record.
   * @param email 
   */
  async _messageResetBounce(email) {
    await _super(MailBlackListMixin, this)._messageResetBounce(email);
    await this.write({'messageBounce': 0});
  }

  async mailActionBlacklistRemove() {
    // wizard access rights currently not working as expected and allows users without access to
    // open this wizard, therefore we check to make sure they have access before the wizard opens.
    const canAccess = await this.env.items('mail.blacklist').checkAccessRights('write', false);
    if (canAccess) {
      return {
        'label': await this._t('Are you sure you want to unblacklist this Email Address?'),
        'type': 'ir.actions.actwindow',
        'viewMode': 'form',
        'resModel': 'mail.blacklist.remove',
        'target': 'new',
      }
    }
    else {
      throw new AccessError(await this._t("You do not have the access right to unblacklist emails. Please contact your administrator."));
    }
  }
}