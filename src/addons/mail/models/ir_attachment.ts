import _ from "lodash";
import { AccessError, MissingError, UserError } from "../../../core/helper/errors";
import { MetaModel, Model, _super, isSubclass } from "../../../core/models";
import { bool, consteq, isInstance } from "../../../core/tools";
import { len } from "../../../core/tools/iterable";

@MetaModel.define()
class IrAttachment extends Model {
  static _module = module;
  static _parents = 'ir.attachment';

  /**
   * This method relies on access rules/rights and therefore it should not be called from a sudo env.
   * @param attachmentTokens 
   */
  async _checkAttachmentsAccess(attachmentTokens?: any[]) {
    let self = await this.sudo(false);
    attachmentTokens = attachmentTokens ?? _.fill(Array(self._length), null);
    if (len(attachmentTokens) != len(self)) {
      throw new UserError(await this._t("An access token must be provided for each attachment."));
    }
    for (const [attachment, accessToken] of _.zip([...self], attachmentTokens)) {
      try {
        const attachmentSudo = await (await attachment.withUser(global.SUPERUSER_ID)).exists();
        if (!bool(attachmentSudo)) {
          throw new MissingError(await this._t("The attachment %s does not exist.", attachment.id));
        }
        try {
          await attachment.check('write');
        } catch (e) {
          if (isInstance(e, AccessError)) {
            if (!accessToken || ! await attachmentSudo.accessToken || !consteq(attachmentSudo.accessToken, accessToken)) {
              const messageSudo = await (await self.env.items('mail.message').sudo()).search([['attachmentIds', 'in', attachmentSudo.ids]], { limit: 1 });
              if (!messageSudo.ok || ! await messageSudo.isCurrentUserOrGuestAuthor) {
                throw e;
              }
            }
          }
          else {
            throw e;
          }
        }
      } catch (e) {
        if (isInstance(e, AccessError, MissingError)) {
          throw new UserError(await this._t("The attachment %s does not exist or you do not have the rights to access it.", attachment.id))
        }
        else {
          throw e;
        }
      }
    }
  }

  /**
   * Overrides behaviour when the attachment is created through the controller
   */
  async _postAddCreate() {
    await _super(IrAttachment, this)._postAddCreate();
    for (const record of this) {
      await record.registerAsMainAttachment(false);
    }
  }

  /**
   * Registers this attachment as the main one of the model it is
    attached to.
   * @param force 
   * @returns 
   */
  async registerAsMainAttachment(force = true) {
    this.ensureOne();
    const resModel = await (this as any).resModel;
    if (!resModel) {
      return;
    }
    const relatedRecord = this.env.items(resModel).browse(await (this as any).resId);
    if (! await relatedRecord.checkAccessRights('write', false)) {
      return;
    }
    // message_main_attachmentId field can be empty, that's why we compare to false;
    // we are just checking that it exists on the model before writing it
    if (relatedRecord.ok && relatedRecord._fields['messageMainAttachmentId']) {
      //hasattr(related_record, 'messageMainAttachmentId'))
      if (force || ! await relatedRecord.messageMainAttachmentId) {
        //Ignore AccessError, if you don't have access to modify the document
        //Just don't set the value
        try {
          await relatedRecord.set('messageMainAttachmentId', this);
        } catch (e) {
          // except AccessError:
          //     pass
        }
      }
    }
  }

  async _deleteAndNotify() {
    for (const attachment of this) {
      let target;
      if (await attachment.resModel === 'mail.channel' && await attachment.resId) {
        target = this.env.items('mail.channel').browse(attachment.resId);
      }
      else {
        target = await (await this.env.user()).partnerId;
      }
      await this.env.items('bus.bus')._sendone(target, 'ir.attachment/delete', {
        'id': attachment.id,
      });
    }
    await this.unlink();
  }

  async _attachmentFormat(commands = false) {
    const req = this.env.req; 
    const safari = req && req.httpRequest.headers['user-agent'].indexOf('safari');
    const resList = [];
    for (const attachment of this) {
      const res = {
        'checksum': await attachment.checksum,
        'id': attachment.id,
        'filename': await attachment.label,
        'label': await attachment.label,
        'mimetype': safari && (await attachment.mimetype || '').includes('video') ? 'application/octet-stream' : await attachment.mimetype,
      }
      const [resId, resModel] = await attachment('resId', 'resModel');
      if (resId && isSubclass(this.env.items(resModel), this.pool.models['mail.thread'])) {
        const mainAttachment = await (await this.env.items(resModel).sudo()).browse(resId).messageMainAttachmentId;
        res['isMain'] = attachment.eq(mainAttachment);
      }
      if (commands) {
        res['originThread'] = [['insert', {
          'id': resId,
          'model': resModel,
        }]]
      }
      else {
        Object.assign(res, {
          'resId': resId,
          'resModel': resModel,
        })
      }
      resList.push(res);
    }
    return resList;
  }
}
