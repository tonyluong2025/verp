import { Fields } from "../../../core/fields";
import { MetaModel, Model } from "../../../core/models";

@MetaModel.define()
class MailMessageReaction extends Model {
  static _module = module;
  static _name = 'mail.message.reaction';
  static _description = 'Message Reaction';
  static _order = 'id desc';
  static _logAccess = false;

  static messageId = Fields.Many2one('mail.message', {string: "Message", ondelete: 'CASCADE', required: true, readonly: true});
  static content = Fields.Char({string: "Content", required: true, readonly: true});
  static partnerId = Fields.Many2one('res.partner', {string: "Reacting Partner", ondelete: 'CASCADE', readonly: true});
  static guestId = Fields.Many2one('mail.guest', {string: "Reacting Guest", ondelete: 'CASCADE', readonly: true});

  async init() {
    // await Promise.all([
      await this.env.cr.execute(`CREATE UNIQUE INDEX IF NOT EXISTS "mailMessageReactionPartner_unique" ON "%s" ("messageId", "content", "partnerId") WHERE "partnerId" IS NOT NULL`, [this.cls._table]),
      await this.env.cr.execute(`CREATE UNIQUE INDEX IF NOT EXISTS "mailMessageReactionGuest_unique" ON "%s" ("messageId", "content", "guestId") WHERE "guestId" IS NOT NULL`, [this.cls._table])
    // ]);
  }

  static _sqlConstraints = [
    ['partnerOrGuest_exists', 'CHECK(("partnerId" IS NOT NULL AND "guestId" IS NULL) OR ("partnerId" IS NULL AND "guestId" IS NOT NULL))', 'A message reaction must be from a partner or from a guest.'],
  ]
}

