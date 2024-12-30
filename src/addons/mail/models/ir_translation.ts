import { api } from "../../../core";
import { setdefault } from "../../../core/api/func";
import { AccessError } from "../../../core/helper/errors";
import { MetaModel, Model, _super, isSubclass } from "../../../core/models";
import { bool } from "../../../core/tools/bool";
import { _f, f } from "../../../core/tools/utils";

@MetaModel.define()
class IrTranslation extends Model {
  static _module = module;
  static _parents = 'ir.translation'

  @api.modelCreateMulti()
  async create(valsList) {
    const translations = await _super(IrTranslation, this).create(valsList);
    await translations._checkIsDynamic();
    return translations;
  }

  async write(vals) {
    const res = await _super(IrTranslation, this).write(vals);
    await this._checkIsDynamic();
    return res;
  }

  async _checkIsDynamic() {
    // if we don't modify translation of at least a model that inherits from mail.render.mixin, we ignore it
    // translation.label can be a path, and so not in the pool, so type(None) will exclude these translations.
    const translationsForMailRenderMixin = await this.filtered(
      async (translation) => isSubclass(this.env.items((await translation.label).split(',')[0]), this.pool.models['mail.render.mixin'])
    )
    if (!bool(translationsForMailRenderMixin)) {
      return;
    }

    // if we are admin, or that we can update mail.template we ignore
    if (await this.env.isAdmin() || await (await this.env.user()).hasGroup('mail.groupMailTemplateEditor')) {
      return;
    }

    // Check that we don't add qweb code in translation when you don't have the rights

    // prefill cache
    let idsByModelByLang = {}
    const tupleLangModelId = await translationsForMailRenderMixin.mapped(
      async (translation) => [await translation.lang, (await translation.label).split(',')[0], await translation.resIid]
    );
    for (const [lang, model, _id] of tupleLangModelId) {
      idsByModelByLang = setdefault(idsByModelByLang, lang, {})
      setdefault(idsByModelByLang[lang], model, new Set()).add(_id);
    }
    for (const lang of Object.keys(idsByModelByLang)) {
      for (const [resModel, resIds] of Object.entries(idsByModelByLang[lang])) {
        (await this.env.items(resModel).withContext({lang: lang})).browse(resIds);
      }
    }

    for (const trans of translationsForMailRenderMixin) {
      const [resModel, resId] = [(await trans.label).split(',')[0], await trans.resId];
      const rec = (await this.env.items(resModel).withContext({lang: await trans.lang})).browse(resId);

      if (await rec._isDynamic()) {
        const group = await this.env.ref('mail.groupMailTemplateEditor');
        const moreInfo = this._length > 1 && f(' [%s]', rec || '');
        throw new AccessError(
          _f(await this._t('Only users belonging to the "{group}" group can modify translation related to dynamic templates.{xtra}'),
            {group: await group.label, xtra: moreInfo}
          )
        )
      }
    }
  }
}