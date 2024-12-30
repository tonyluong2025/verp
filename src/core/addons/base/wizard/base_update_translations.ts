import { api } from "../../..";
import { Fields } from "../../../fields";
import { UserError } from "../../../helper/errors";
import { MetaModel, TransientModel } from "../../../models";

const tarfile: any = {}

@MetaModel.define()
class BaseUpdateTranslations extends TransientModel {
  static _module = module;
  static _name = 'base.update.translations';
  static _description = 'Update Translations';

  static lang = Fields.Selection('_getLanguages', { string: 'Language', required: true });

  @api.model()
  async _getLanguages() {
    return this.env.items('res.lang').getInstalled();
  }

  @api.model()
  async _getLangName(langCode) {
    const lang = await this.env.items('res.lang')._langGet(langCode);
    if (!lang.ok) {
      throw new UserError(await this._t('No language with code "%s" exists', langCode));
    }
    return lang.label;
  }

  async actUpdate() {
    console.warn('Not implemented tarfile');
    // const dataFile: temp.OpenFile = await temp.open({ suffix: '.html', prefix: 'report.header.tmp.' });
    // const buf = Buffer.from([]);
    // await transExport(await this['lang'], ['all'], buf, 'tgz', this._cr);
    // const tar = tarfile.open({ fileobj: buf });
    // for (const fileInfo of tar) {
    //   const moduleFile = tar.extractfile(fileInfo);
    //   await transLoadData(this._cr, moduleFile, 'po', await this['lang'], { createEmptyTranslation: true });
    // }
    // tar.close();
    return { 'type': 'ir.actions.actwindow.close' }
  }
}