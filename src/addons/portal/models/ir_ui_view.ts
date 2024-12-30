import { api } from "../../../core";
import { getattr } from "../../../core/api";
import { Fields } from "../../../core/fields";
import { MetaModel, Model, _super } from "../../../core/models"
import { isHtmlEmpty } from "../../../core/tools";
import { urlFor } from "../../../core/tools/slug";

@MetaModel.define()
class View extends Model {
  static _module = module;
  static _parents = "ir.ui.view";

  static customizeShow = Fields.Boolean("Show As Optional Inherit", {default: false});

  /**
   * Returns the qcontext : rendering context with portal specific value (required to render portal layout template)
   * @returns 
   */
  @api.model()
  async _prepareQcontext() {
    const req = this.env.req;
    const qcontext = await _super(View, this)._prepareQcontext();
    if (req && getattr(req, 'isFrontend', false)) {
      const env = await req.getEnv();
      const lang = env.items('res.lang');
      const portalLangCode = await env.items('ir.http')._getFrontendLangs(req);
      const languages = await lang.getAvailable();
      Object.assign(qcontext, this._context, {
        languages: languages.filter(lang => portalLangCode.includes(lang[0])),
        urlFor: urlFor,
        isHtmlEmpty: isHtmlEmpty
      });
    }
    return qcontext;
  }
}