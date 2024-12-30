import { api } from "../../../core";
import { Fields } from "../../../core/fields";
import { MetaModel, TransientModel } from "../../../core/models";

@MetaModel.define()
class MailResendCancel extends TransientModel {
  static _module = module;
  static _name = 'mail.resend.cancel';
  static _description = 'Dismiss notification for resend by model';

  static model = Fields.Char({string: 'Model'})
  static helpMessage = Fields.Char({string: 'Help message', compute: '_computeHelpMessage'})

  @api.depends('model')
  async _computeHelpMessage() {
    for (const wizard of this) {
      await wizard.set('helpMessage', await this._t("Are you sure you want to discard %s mail delivery failures? You won't be able to re-send these mails later!", wizard._context['unreadCounter']));
    }
  }

  async cancelResendAction() {
    const authorId = (await (await this.env.user()).partnerId).id
    for (const wizard of this) {
      const res = await this._cr.execute(`
        SELECT notif.id AS id, mes.id AS msgid
        FROM "mailNotification" notif
        JOIN "mailMessage" mes
            ON notif."mailMessageId" = mes.id
        WHERE notif."notificationType" = 'email' AND notif."notificationStatus" IN ('bounce', 'exception')
            AND mes.model = '%s'
            AND mes."authorId" = %s
      `, [await wizard.model, authorId]);
      const notifIds = res.map(row => row['id']);
      const messagesIds = res.map(row => row['msgid']);
      if (notifIds.length) {
        await (await this.env.items("mail.notification").browse(notifIds).sudo()).write({'notificationStatus': 'canceled'});
        await this.env.items("mail.message").browse(messagesIds).NotifyMessageNotificationUpdate();
      }
    }
    return {'type': 'ir.actions.actwindow_close'}
  }
}