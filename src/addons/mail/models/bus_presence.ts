import { Fields } from "../../../core/fields";
import { MetaModel, Model } from "../../../core/models";

@MetaModel.define()
class BusPresence extends Model {
  static _module = module;
  static _parents = ['bus.presence'];

  static guestId = Fields.Many2one('mail.guest', {string: 'Guest', ondelete: 'CASCADE'});

  async init() {
    await this.env.cr.execute('CREATE UNIQUE INDEX IF NOT EXISTS "busPresenceGuest_unique" ON "%s" ("guestId") WHERE "guestId" IS NOT NULL', [this.cls._table]);
  }

  static _sqlConstraints = [
    ["partnerOrGuestExists", 'CHECK(("userId" IS NOT NULL AND "guestId" IS NULL) OR ("userId" IS NULL AND "guestId" IS NOT NULL))', "A bus presence must have a user or a guest."],
  ]
}