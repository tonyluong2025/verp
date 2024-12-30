import { api } from "../../../core"
import { Command, Fields } from "../../../core/fields"
import { UserError } from "../../../core/helper/errors"
import { MetaModel, TransientModel, _super } from "../../../core/models"
import { bool } from "../../../core/tools/bool"

@MetaModel.define()
class MailResendMessage extends TransientModel {
  static _module = module;
  static _name = 'mail.resend.message';
  static _description = 'Email resend wizard';

  static mailMessageId = Fields.Many2one('mail.message', {string: 'Message', readonly: true});
  static partnerIds = Fields.One2many('mail.resend.partner', 'resendWizardId', { string: 'Recipients'});
  static notificationIds = Fields.Many2many('mail.notification', {string: 'Notifications', readonly: true});
  static hasCancel = Fields.Boolean({compute: '_computeHasCancel'});
  static partnerReadonly = Fields.Boolean({compute: '_computePartnerReadonly'});

  @api.depends("partnerIds")
  async _computeHasCancel() {
    await this.set('hasCancel', await (await (this as any).partnerIds).filtered(async (p) => ! await p.resend));
  }

  async _computePartnerReadonly() {
    await this.set('partnerReadonly', ! await this.env.items('res.partner').checkAccessRights('write', false));
  }

  @api.model()
  async defaultGet(fields) {
    const rec = await _super(MailResendMessage, this).defaultGet(fields);
    const messageId = this._context['mailMessageToResend'];
    if (messageId) {
      const mailMessageId = this.env.items('mail.message').browse(messageId);
      const notificationIds = await (await mailMessageId.notificationIds).filtered(async (notif) => await notif.notificationType === 'email' && ['exception', 'bounce'].includes(await notif.notificationStatus));

      const partnerIds = [];
      for (const notif of notificationIds) {
        const resPartnerId = await notif.resPartnerId;
        partnerIds.push(Command.create({
          "partnerId": resPartnerId.id,
          "label": await resPartnerId.label,
          "email": await resPartnerId.email,
          "resend": true,
          "message": await notif.formatFailureReason(),
        }))
      }
      let hasUser; 
      for (const notif of notificationIds) {
        if (bool(await (await notif.resPartnerId).userIds)) {
          hasUser = true;
          break;
        }
      }
      let partnerReadonly;
      if (hasUser) {
        partnerReadonly = ! await this.env.items('res.users').checkAccessRights('write', false);
      }
      else {
        partnerReadonly = ! await this.env.items('res.partner').checkAccessRights('write', false);
      }
      rec['partnerReadonly'] = partnerReadonly;
      rec['notificationIds'] = [Command.set(notificationIds.ids)];
      rec['mailMessageId'] = mailMessageId.id;
      rec['partnerIds'] = partnerIds;
    }
    else {
      throw new UserError(await this._t('No messageId found in context'))
    }
    return rec;
  }

  /**
   * Process the wizard content and proceed with sending the related email(s), rendering any template patterns on the fly if needed.
   */
  async resendMailAction() {
    for (const wizard of this) {
      //"If a partner disappeared from partner list, we cancel the notification"
      const partnerIds = await wizard.partnerIds;
      const toCancel = await (await partnerIds.filtered(async (p) => ! await p.resend)).mapped("partnerId");
      const toSend = await (await partnerIds.filtered(async (p) => p.resend)).mapped("partnerId");
      const notifToCancel = await (await wizard.notificationIds).filtered(async (notif) => await notif.notificationType === 'email' && toCancel.includes(await notif.resPartnerId) && ['exception', 'bounce'].includes(notif.notificationStatus));
      await (await notifToCancel.sudo()).write({'notificationStatus': 'canceled'});
      if (toSend.ok) {
        const message = await wizard.mailMessageId;
        const record = await message.isThreadMessage() ? this.env.items(message.model).browse(await message.resId) : this.env.items('mail.thread');

        const emailPartnersData = [];
        for (const [pid, active, pshare, notif, groups] of this.env.items('mail.followers')._getRecipientData(null, 'comment', false, toSend.ids)) {
          if (pid && notif === 'email' || ! notif) {
            const pdata = {'id': pid, 'share': pshare, 'active': active, 'notif': 'email', 'groups': groups ?? []}
            if (! pshare && notif) { // has an user and is not shared, is therefore user
              emailPartnersData.push({...pdata, type: 'user'});
            }
            else if (pshare && notif) {  // has an user and is shared, is therefore portal
              emailPartnersData.push({...pdata, type: 'portal'});
            }
            else {  // has no user, is therefore customer
              emailPartnersData.push({...pdata, type: 'customer'});
            }
          }
        }
        await record._notifyRecordByEmail(message, emailPartnersData, true, false);
      }
      await (await (this as any).mailMessageId)._notifyMessageNotificationUpdate();
    }
    return {'type': 'ir.actions.actwindow.close'}
  }

  async cancelMailAction() {
    for (const wizard of this) {
      for (const notif of await wizard.notificationIds) {
        await (await (await notif.filtered(async (notif) => await notif.notificationType === 'email' && ['exception', 'bounce'].includes(await notif.notificationStatus))).sudo()).write({'notificationStatus': 'canceled'})
      }
      await (await wizard.mailMessageId)._notifyMessageNotificationUpdate();
    }
    return {'type': 'ir.actions.actwindow.close'}
  }
}

@MetaModel.define()
class PartnerResend extends TransientModel {
  static _module = module;
  static _name = 'mail.resend.partner'
  static _description = 'Partner with additional information for mail resend'

  static partnerId = Fields.Many2one('res.partner', {string: 'Partner', required: true, ondelete: 'CASCADE'});
  static label = Fields.Char({related: "partnerId.label", relatedSudo: false, readonly: false})
  static email = Fields.Char({related: "partnerId.email", relatedSudo: false, readonly: false})
  static resend = Fields.Boolean({string: "Send Again", default: true})
  static resendWizardId = Fields.Many2one('mail.resend.message', {string: "Resend wizard"})
  static message = Fields.Char({string: "Help message"})
}