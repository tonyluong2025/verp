import { Fields, api } from "../../../core";
import { MetaModel, Model } from "../../../core/models";

@MetaModel.define()
class Message extends Model {
  static _module = module;
  static _parents = 'mail.message';

  static snailmailError = Fields.Boolean("Snailmail message in error", { compute: "_computeSnailmailError", search: "_searchSnailmailError" });
  static letterIds = Fields.One2many('snailmail.letter', 'messageId');
  static messageType = Fields.Selection({
    selectionAdd: [
      ['snailmail', 'Snailmail']
    ], ondelete: { 'snailmail': async (recs) => recs.write({ 'messageType': 'email' }) }
  });

  @api.depends('letterIds', 'letterIds.state')
  async _computeSnailmailError() {
    for (const message of this) {
      if (await message.messageType === 'snailmail' && (await message.letterIds).ok) {
        await message.set('snailmailError', await (await message.letterIds)[0].state === 'error');
      }
      else {
        await message.set('snailmailError', false);
      }
    }
  }

  async _searchSnailmailError(operator, operand) {
    if (operator === '=' && operand) {
      return ['&', ['letterIds.state', '=', 'error'], ['letterIds.userId', '=', (await this.env.user()).id]];
    }
    return ['!', '&', ['letterIds.state', '=', 'error'], ['letterIds.userId', '=', (await this.env.user()).id]];
  }

  async cancelLetter() {
    await (await this.mapped('letterIds')).cancel();
  }

  async sendLetter() {
    await (await this.mapped('letterIds'))._snailmailPrint();
  }
}
