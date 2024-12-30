import { MetaModel, Model } from "../../../core/models"

@MetaModel.define()
class MailMessage extends Model {
  static _module = module;
  static _parents = 'mail.message';

  async portalMessageFormat() {
    return this._portalMessageFormat([
      'id', 'body', 'date', 'authorId', 'emailFrom',  // base message fields
      'messageType', 'subtypeId', 'isInternal', 'subject',  // message specific
      'model', 'resId', 'recordName',  // document related
    ])
  }

  async _portalMessageFormat(fieldsList) {
    const valsList = await (this as any)._messageFormat(fieldsList);
    const messageSubtypeNoteId = await this.env.items('ir.model.data')._xmlidToResId('mail.mtNote');
    const IrAttachmentSudo = await this.env.items('ir.attachment').sudo();
    for (const vals of valsList) {
      vals['isMessageSubtypeNote'] = messageSubtypeNoteId && (vals['subtypeId'] ?? [false])[0] == messageSubtypeNoteId;
      for (const attachment of (vals['attachmentIds'] ?? [])) {
        if (!attachment['accessToken']) {
          attachment['accessToken'] = (await IrAttachmentSudo.browse(attachment['id']).generateAccessToken())[0];
        }
      }
    }
    return valsList;
  }
}