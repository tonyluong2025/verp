import { api } from "../../..";
import { Fields } from "../../../fields";
import { MetaModel, TransientModel } from "../../../models";
import { bool, f, getIsoCodes, len, sortedAsync } from "../../../tools";
import { transExport } from "../../../tools/translate";

const NEW_LANG_KEY = '__new__';

@MetaModel.define()
class BaseLanguageExport extends TransientModel {
  static _module = module;
  static _name = "base.language.export";
  static _description = "Language Export";

  /**
   * Display the selected language when using the 'Update Terms' action from the language list view
   * @returns 
   */
  @api.model()
  async _defaultLanguage() {
    if (this._context['activeModel'] === 'res.lang') {
      const lang = this.env.items('res.lang').browse(this._context['activeId']);
      return lang.code;
    }
    return false;
  }

  @api.model()
  async _getLanguages() {
    const langs = this.env.items('res.lang').getInstalled();
    return [[NEW_LANG_KEY, await this._t('New Language (Empty translation template)')]].concat(langs);
  }

  static label = Fields.Char('File Name', {readonly: true});
  static lang = Fields.Selection('_getLanguages', {string: 'Language', required: true, default: NEW_LANG_KEY});
  static format = Fields.Selection([['csv','CSV File'], ['po','PO File'], ['tgz', 'TGZ Archive']], {string: 'File Format', required: true, default: 'po'});
  static modules = Fields.Many2many('ir.module.module', {relation: 'relModulesLangExport', column1: 'wizId', column2: 'moduleId', recursive: true, string: 'Apps To Export', domain: [['state', '=', 'installed']]});
  static data = Fields.Binary('File', {readonly: true, attachment: false});
  static state = Fields.Selection([['choose', 'choose'], ['take', 'take']], // choose language or take the file
  {default: 'choose'});

  async actGetfile() {
        const self = this[0];
        const lang = await self.lang !== NEW_LANG_KEY ? await self.lang : false;
        let mods = await sortedAsync(await self.mapped('modules.label'));
        mods = bool(mods) ? mods : ['all'];

        const buf = Buffer.from('');
        await transExport(lang, mods, buf, await self.format, this._cr);
        const out = buf.values();

        let filename = 'new';
        if (lang) {
            filename = getIsoCodes(lang);
        }
        else if (len(mods) == 1) {
            filename = mods[0];
        }
        let extension = await self.format;
        if (! lang && extension === 'po') {
            extension = 'pot';
        }
        const name = f("%s.%s", filename, extension);
        await self.write({'state': 'get', 'data': out, 'name': name});
        return {
            'type': 'ir.actions.actwindow',
            'resModel': 'base.language.export',
            'viewMode': 'form',
            'resId': self.id,
            'views': [[false, 'form']],
            'target': 'new',
        }
      }
}