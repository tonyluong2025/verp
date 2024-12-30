import { AbstractModel } from "../../../core/models";
import { MetaModel, _super } from "../../../core/models";
import { bool } from "../../../core/tools/bool";

@MetaModel.define()
class MailThread extends AbstractModel {
  static _module = module;
  static _parents = 'mail.thread';

  /**
   * This method extension ensures that, when using the "Send & Print" feature, if the user
      adds an attachment, the latter will be linked to the record. 
   * @param attachments 
   * @param attachmentIds 
   * @param messageValues 
   * @returns 
   */
  async _messagePostProcessAttachments(attachments, attachmentIds, messageValues) {
    const record = this.env.context['attachedTo'];
    // link mail.compose.message attachments to attached_to
    if (bool(record) && record._name === 'account.move') {
      messageValues['model'] = record._name
      messageValues['resId'] = record.id
    }
    const res = await _super(MailThread, this)._messagePostProcessAttachments(attachments, attachmentIds, messageValues);
    // link account.invoice.send attachments to attached_to
    const model = messageValues['model'];
    const resId = messageValues['resId'];
    const attIds = (res['attachmentIds'] || []).map(att => att[1]);
    if (attIds.length && model === 'account.move') {
      const filteredAttachmentIds = await (await this.env.items('ir.attachment').sudo()).browse(attIds).filtered(
        async (a) => ['account.invoice.send',].includes(await a.resModel) && (await a.createdUid).id == this._uid);
      if (filteredAttachmentIds.ok) {
        await filteredAttachmentIds.write({ 'resModel': model, 'resId': resId });
      }
    }
    return res;
  }
}