import { api } from "../../../core"
import { Fields } from "../../../core/fields"
import { MetaModel, Model } from "../../../core/models"
import { urlQuote } from "../../../core/service/middleware/utils"
import { ImageProcess } from "../../../core/tools/image"
import { f } from "../../../core/tools/utils"

export const SUPPORTED_IMAGE_MIMETYPES = ['image/gif', 'image/jpe', 'image/jpeg', 'image/jpg', 'image/png', 'image/svg+xml'];
export const SUPPORTED_IMAGE_EXTENSIONS = ['.gif', '.jpe', '.jpeg', '.jpg', '.png', '.svg'];

@MetaModel.define()
class IrAttachment extends Model {
  static _module = module;
  static _parents = "ir.attachment";

  static localUrl = Fields.Char("Attachment URL", {compute: '_computeLocalUrl'});
  static imageSrc = Fields.Char({compute: '_computeImageSrc'});
  static imageWidth = Fields.Integer({compute: '_computeImageSize'});
  static imageHeight = Fields.Integer({compute: '_computeImageSize'});
  static originalId = Fields.Many2one('ir.attachment', {string: "Original (unoptimized, unresized) attachment", index: true});

  async _computeLocalUrl() {
    for (const attachment of this) {
      if (await attachment.url) {
        await attachment.set('localUrl', await attachment.url);
      }
      else {
        await attachment.set('localUrl', f('/web/image/%s?unique=%s', attachment.id, await attachment.checksum));
      }
    }
  }

  @api.depends('mimetype', 'url', 'label')
  async _computeImageSrc() {
    for (const attachment of this) {
      // Only add a src for supported images
      if (! SUPPORTED_IMAGE_MIMETYPES.includes(await attachment.mimetype)) {
        await attachment.set('imageSrc', false);
        continue;
      }

      if (await attachment.type === 'url') {
        await attachment.set('imageSrc', await attachment.url);
      }
      else {
        // Adding unique in URLs for cache-control
        const unique = (await attachment.checksum).slice(0,8);
        const attachmentUrl = await attachment.url;
        if (attachmentUrl) {
          // For attachments-by-url, unique is used as a cachebuster. They currently do not leverage max-age headers.
          const separator = attachmentUrl.includes('?') ? '&' : '?'
          await attachment.set('imageSrc', f('%s%sunique=%s', attachmentUrl, separator, unique));
        }
        else {
          const name = urlQuote(await attachment.label);
          await attachment.set('imageSrc', f('/web/image/%s-%s/%s', attachment.id, unique, name));
        }
      }
    }
  }

  @api.depends('datas')
  async _computeImageSize() {
    for (const attachment of this) {
      try {
        const image = await ImageProcess.new(await attachment.datas);
        const meta = await image.image.metadata();
        await attachment.set('imageWidth', meta.width),
        await attachment.set('imageHeight', meta.height)
      } catch(e) {
        await attachment.set('imageWidth', 0),
        await attachment.set('imageHeight', 0)
      }
    }
  }

  /**
   * Return a dict with the values that we need ozn the media dialog.
   * @returns 
   */
  async _getMediaInfo() {
    this.ensureOne();
    return (await this._readFormat(['id', 'label', 'description', 'mimetype', 'checksum', 'url', 'type', 'resId', 'resModel', 'isPublic', 'accessToken', 'imageSrc', 'imageWidth', 'imageHeight', 'originalId']))[0];
  }
}