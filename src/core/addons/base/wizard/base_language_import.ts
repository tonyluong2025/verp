import fsPro from 'fs/promises';
import path from 'path';
import temp from 'temp';
import { Fields } from "../../../fields";
import { UserError } from "../../../helper";
import { MetaModel, TransientModel } from "../../../models";
import { dbConnect } from "../../../sql_db";
import { b64decode, bool, isInstance, transLoadData } from "../../../tools";

class ProgrammingError extends Error { }

@MetaModel.define()
class BaseLanguageImport extends TransientModel {
  static _module = module;
  static _name = "base.language.import";
  static _description = "Language Import";

  static label = Fields.Char('Language Name', { required: true });
  static code = Fields.Char('ISO Code', { size: 6, required: true, help: "ISO Language and Country code, e.g. en_US" });
  static data = Fields.Binary('File', { required: true, attachment: false });
  static filename = Fields.Char('File Name', { required: true });
  static overwrite = Fields.Boolean('Overwrite Existing Terms', { default: true, help: "If you enable this option, existing translations (including custom ones) will be overwritten and replaced by those in this file" });

  async importLang() {
    const self = this[0];
    const dataFile: temp.OpenFile = await temp.open({ suffix: '.html', prefix: 'report.header.tmp.' });
    try {
      await fsPro.writeFile(dataFile.path, b64decode(await this['data']));

      // now we determine the file format
      const fileformat = path.parse(await self['filename']).ext.slice(1).toLowerCase();

      const Lang = this.env.items("res.lang");
      let lang = await Lang._activateLang(await this['code']);
      lang = bool(lang) ? lang : await Lang._createLang(
        await this['code'], await this['label']
      );

      await transLoadData(
        self._cr, dataFile.path, fileformat, await self.code, { overwrite: await this['overwrite'] }
      )
    } catch (e) {
      if (isInstance(e, ProgrammingError)) {
        console.error('Could not import the file due to a format mismatch or it being malformed.');
        await dbConnect(this._cr.dbName).cursor().close();
        throw new UserError(await this._t(['File %r not imported due to a malformed file.\n\n',
          'This issue can be caused by duplicates entries who are referring to the same field. ',
          'Please check the content of the file you are trying to import.\n\n',
          'Technical Details:\n%s'].join(''), await this['filename'], String(e)));
      }
      else {
        console.warn('Could not import the file due to a format mismatch or it being malformed.');
        throw new UserError(
          await this._t(['File %r not imported due to format mismatch or a malformed file.',
            ' (Valid formats are .csv, .po, .pot)\n\nTechnical Details:\n%s'].join(''), await this['filename'], String(e))
        )
      }
    }
    return true;
  }
}