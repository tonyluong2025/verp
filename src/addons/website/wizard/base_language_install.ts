import { Fields, api } from "../../../core";
import { MetaModel, TransientModel, _super } from "../../../core/models";
import { bool } from "../../../core/tools";

@MetaModel.define()
class BaseLanguageInstall extends TransientModel {
    static _module = module;
    static _parents = "base.language.install";

    static websiteIds = Fields.Many2many('website', {string: 'Websites to translate'});

    @api.model()
    async defaultGet(fields) {
        const defaults = await _super(BaseLanguageInstall, this).defaultGet(fields);
        const websiteId = (this._context['params'] ?? {})['websiteId'];
        if (bool(websiteId)) { 
            if (!('websiteIds' in defaults)) {
                defaults['websiteIds'] = [];
            }
            defaults['websiteIds'].push(websiteId);
        }
        return defaults;
    }

    async langInstall() {
        const action = await _super(BaseLanguageInstall, this).langInstall();
        const lang = await this.env.items('res.lang')._langGet(await this['lang']);
        if ((await this['websiteIds']).ok && bool(lang)) {
            await (await this['websiteIds']).write({'languageIds': [[4, lang.id]]});
        }
        const params = this._context['params'] ?? {};
        if ('urlReturn' in params) {
            return {
                'url': params['urlReturn'].replace('[lang]', await this['lang']),
                'type': 'ir.actions.acturl',
                'target': 'self'
            }
        }
        return action;
    }
}