import fs from "fs/promises";
import { api } from "../../..";
import { setattr } from '../../../api/func';
import { Fields } from "../../../fields";
import { AbstractModel, MetaModel, findProperty } from "../../../models";
import { b64encode, bool, filePath, getHslFromSeed, stringBase64 } from "../../../tools";
import { escapeHtml } from "../../../tools/xml";

@MetaModel.define()
class AvatarMixin extends AbstractModel {
  static _module = module;
  static _name = 'avatar.mixin';
  static _parents = ['image.mixin'];
  static _description = "Avatar Mixin";

  static _avatarNameField = "label";

  // all image fields are base64 encoded and PIL-supported
  static avatar1920 = Fields.Image("Avatar", { maxWidth: 1920, maxHeight: 1920, compute: "_computeAvatar1920" });
  static avatar1024 = Fields.Image("Avatar 1024", { maxWidth: 1024, maxHeight: 1024, compute: "_computeAvatar1024" });
  static avatar512 = Fields.Image("Avatar 512", { maxWidth: 512, maxHeight: 512, compute: "_computeAvatar512" });
  static avatar256 = Fields.Image("Avatar 256", { maxWidth: 256, maxHeight: 256, compute: "_computeAvatar256" });
  static avatar128 = Fields.Image("Avatar 128", { maxWidth: 128, maxHeight: 128, compute: "_computeAvatar128" });

  getAvatarNameField() {
    if (this.cls['_avatarNameField'] !== undefined) {
      return this.cls['_avatarNameField'];
    }
    else {
      const value = findProperty(this.cls, '_avatarNameField');
      setattr(this.cls, '_avatarNameField', value);
      return value;
    }
  }

  async _computeAvatar(avatarField, imageField) {
    for (const record of this) {
      let avatar = await record[imageField];
      if (!bool(avatar)) {
        if (bool(record.id) && bool(await record[record.getAvatarNameField()])) {
          avatar = await record._avatarGenerateSvg();
        }
        else {
          avatar = await record._avatarGetPlaceholder();
        }
      }
      await record.set(avatarField, avatar);
    }
  }

  @api.depends((self) => [self.getAvatarNameField(), 'image1920'])
  async _computeAvatar1920() {
    await this._computeAvatar('avatar1920', 'image1920');
  }

  @api.depends((self) => [self.getAvatarNameField(), 'image1024'])
  async _computeAvatar1024() {
    await this._computeAvatar('avatar1024', 'image1024');
  }

  @api.depends((self) => [self.getAvatarNameField(), 'image512'])
  async _computeAvatar512() {
    await this._computeAvatar('avatar512', 'image512');
  }

  @api.depends((self) => [self.getAvatarNameField(), 'image256'])
  async _computeAvatar256() {
    await this._computeAvatar('avatar256', 'image256');
  }

  @api.depends((self) => [self.getAvatarNameField(), 'image128'])
  async _computeAvatar128() {
    await this._computeAvatar('avatar128', 'image128');
  }

  async _avatarGenerateSvg() {
    const avatar = await this[this.getAvatarNameField()];
    const initial = escapeHtml(avatar[0].toUpperCase());
    const createdAt = await (this as any).createdAt;
    const bgcolor = getHslFromSeed((await this[this.getAvatarNameField()]) + String(createdAt ? Date.parse(createdAt).valueOf() : ""))
    return b64encode(stringBase64(
      "<svg height='180' width='180' xmlns='http://www.w3.org/2000/svg' xmlns:xlink='http://www.w3.org/1999/xlink'>"
      + `<rect fill='${bgcolor}' height='180' width='180'/>`
      + `<text fill='#ffffff' font-size='96' text-anchor='middle' x='90' y='125' font-family='sans-serif'>${initial}</text>`
      + "</svg>"
    ));
  }

  async _avatarGetPlaceholderPath() {
    return "base/static/img/avatar_grey.png";
  }

  async _avatarGetPlaceholder() {
    const data = await fs.readFile(filePath(await this._avatarGetPlaceholderPath()));
    return b64encode(data);
  }
}