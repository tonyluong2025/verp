import { DateTime } from "luxon"
import { api } from "../../../core"
import { Fields } from "../../../core/fields"
import { Dict } from "../../../core/helper/collections"
import { AccessError } from "../../../core/helper/errors"
import { MetaModel, Model, _super } from "../../../core/models"
import { f } from "../../../core/tools/utils"

@MetaModel.define()
class MailNotification extends Model {
  static _module = module;
  static _name = 'mail.notification'
  static _table = 'mailNotification'
  static _recName = 'resPartnerId'
  static _logAccess = false
  static _description = 'Message Notifications'

  // origin
  static mailMessageId = Fields.Many2one('mail.message', {string: 'Message', index: true, ondelete: 'CASCADE', required: true});
  static mailMailId = Fields.Many2one('mail.mail', {string: 'Mail', index: true, help: 'Optional mail_mail ID. Used mainly to optimize searches.'});
  // recipient
  static resPartnerId = Fields.Many2one('res.partner', {string: 'Recipient', index: true, ondelete: 'CASCADE'});
  // status
  static notificationType = Fields.Selection([
    ['inbox', 'Inbox'], ['email', 'Email']
    ], {string: 'Notification Type', default: 'inbox', index: true, required: true});
  static notificationStatus = Fields.Selection([
    ['ready', 'Ready to Send'],
    ['sent', 'Sent'],
    ['bounce', 'Bounced'],
    ['exception', 'Exception'],
    ['canceled', 'Canceled']
    ], {string: 'Status', default: 'ready', index: true});
  static isRead = Fields.Boolean('Is Read', {index: true});
  static readDate = Fields.Datetime('Read Date', {copy: false});
  static failureType = Fields.Selection([
    // generic
    ["unknown", "Unknown error"],
    // mail
    ["mailEmailInvalid", "Invalid email address"],
    ["mailEmailMissing", "Missing email addresss"],
    ["mailSmtp", "Connection failed (outgoing mail server problem)"],
    ], {string: 'Failure type'});
  static failureReason = Fields.Text('Failure reason', {copy: false});

  static _sqlConstraints = [
    // email notification;: partner is required
    ['notificationPartner_required',
      `CHECK("notificationType" NOT IN ('email', 'inbox') OR "resPartnerId" IS NOT NULL)`,
      'Customer is required for inbox / email notification'],
  ]

  // ------------------------------------------------------------
  // CRUD
  // ------------------------------------------------------------

  async init() {
    await this._cr.execute(`
      CREATE INDEX IF NOT EXISTS "mailNotificationResPartnerIdIsReadNotificationStatusMailMessageId"
        ON "mailNotification" ("resPartnerId", "isRead", "notificationStatus", "mailMessageId")
    `)
  }

  @api.modelCreateMulti()
  async create(valsList) {
    const messages = this.env.items('mail.message').browse(valsList.map(vals => vals['mailMessageId']));
    await messages.checkAccessRights('read');
    await messages.checkAccessRule('read');
    for (const vals of valsList) {
      if (vals['isRead']) {
        vals['readDate'] = Date.now();
      }
    }
    return _super(MailNotification, this).create(valsList);
  }

  async write(vals) {
    if (('mailMessageId' in vals || 'resPartnerId' in vals) && ! await this.env.isAdmin()) {
      throw new AccessError(await this._t("Can not update the message or recipient of a notification."))
    }
    if (vals['isRead']) {
      vals['readDate'] = Date.now();
    }
    return _super(MailNotification, this).write(vals);
  }

  @api.model()
  async _gcNotifications(maxAgeDays: number=180) {
    const domain = [
      ['isRead', '=', true],
      ['readDate', '<', DateTime.now().minus({days: maxAgeDays}).toJSDate()],
      ['resPartnerId.partnerShare', '=', false],
      ['notificationStatus', 'in', ['sent', 'canceled']]
    ]
    return (await this.search(domain)).unlink();
  }
  // ------------------------------------------------------------
  // TOOLS
  // ------------------------------------------------------------

  async formatFailureReason() {
    this.ensureOne();
    const failureType = await (this as any).failureType;
    if (failureType !== 'unknown') {
      return Dict.from(this.cls.failureType.selection).get(failureType, await this._t('No Error'));
    }
    else {
      return (await this._t("Unknown error")) + f(": %s", await (this as any).failureReason || '');
    }
  }

  // ------------------------------------------------------------
  // DISCUSS
  // ------------------------------------------------------------

  /**
   * Returns only the notifications to show on the web client.
   * @returns 
   */
  async _filteredForWebClient() {
    return this.filtered(async (n) =>
      await n.notificationType !== 'inbox' &&
        (['bounce', 'exception', 'canceled'].includes(await n.notificationStatus) || await (await n.resPartnerId).partnerShare)
    )
  }

  /**
   * Returns the current notifications in the format expected by the web client.
   * @returns 
   */
  async _notificationFormat() {
    const res = [];
    for (const notif of this) {
      const resPartnerId = await notif.resPartnerId;
      res.push({
        'id': notif.id,
        'notificationType': await notif.notificationType,
        'notificationStatus': await notif.notificationStatus,
        'failureType': await notif.failureType,
        'resPartnerId': resPartnerId.ok ? [resPartnerId.id, await resPartnerId.displayName] : false,
      });
    }
    return res;
  }
}