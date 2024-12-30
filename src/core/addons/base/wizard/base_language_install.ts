import { api } from "../../..";
import { Fields } from "../../../fields";
import { MetaModel, TransientModel } from "../../../models";


@MetaModel.define()
class BaseLanguageInstall extends TransientModel {
  static _module = module;
  static _name = "base.language.install";
  static _description = "Install Language";

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
    const res = [];
    for (const [code, _, label] of await this.env.items('res.lang').getAvailable()) {
      res.push([code, label]);
    }
    return res;
  }

  static lang = Fields.Selection('_getLanguages', {string: 'Language', required: true, default: self => self._defaultLanguage()});
  static overwrite = Fields.Boolean('Overwrite Existing Terms', {default: true, help: "If you check this box, your customized translations will be overwritten and replaced by the official ones."});
  static state = Fields.Selection([['init', 'init'], ['done', 'done']], {string: 'Status', readonly: true, default: 'init'});

  async langInstall() {
    this.ensureOne();
    const mods = await this.env.items('ir.module.module').search([['state', '=', 'installed']]);
    const lang = await this['lang'];
    await this.env.items('res.lang')._activateLang(lang);
    await mods._updateTranslations(lang, await this['overwrite']);
    await this.set('state', 'done');
    await this.env.cr.execute('ANALYZE "irTranslation"');

    return {
      'label': await this._t('Language Pack'),
      'viewMode': 'form',
      'viewId': false,
      'resModel': 'base.language.install',
      'domain': [],
      'context': Object.assign({}, this._context, {activeIds: this.ids}),
      'type': 'ir.actions.actwindow',
      'target': 'new',
      'resId': this.id,
    }
  }
  
  reload() {
    return {
      'type': 'ir.actions.client',
      'tag': 'reload',
    }
  }

  async switchLang() {
    const user = await this.env.user(); 
    user.lang = await (this as any).lang;
    return {
      'type': 'ir.actions.client',
      'tag': 'reloadContext',
    }
  }
}