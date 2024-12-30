import { Fields } from "../../../core/fields";
import { MetaModel, TransientModel } from "../../../core/models"

@MetaModel.define()
class MailBlacklistRemove extends TransientModel {
  static _module = module;
  static _name = 'mail.blacklist.remove';
  static _description = 'Remove email from blacklist wizard';

  static email = Fields.Char({string: "Email", readonly: true, required: true});
  static reason = Fields.Char({string: "Reason"})

  async actionUnblacklistApply() {
    const self: any = this;
    return this.env.items('mail.blacklist').actionRemoveWithReason(await self.email, await self.reason);
  }
}