import { http } from "../../../core";
import { Home, Session, WebClient } from "../../../core/addons/web";

@http.define()
class Routing extends Home {
  static _module = module;

  @http.route('/website/translations/<string:unique>', {type: 'http', auth: "public", website: true})
  async getWebsiteTranslations(req, res, opts: {unique?: any, lang?: string, mods?: string}={}) {
    const irHttp = await (await req.getEnv()).items('ir.http').sudo();
    let modules = await irHttp.getTranslationFrontendModules(req);
    if (opts.mods) {
      modules += opts.mods.split(',');
    }
    return (new WebClient()).translations(req, res, {unique: opts.unique, mods: modules.join(','), lang: opts.lang});
  }
}

@http.define()
class SessionWebsite extends Session {
  static _module = module;

  @http.route('/web/session/logout', {type: 'http', auth: "none", website: true, multilang: false, sitemap: false})
  async logout(req, res, opts: {redirect?: string}={}) {
    return super.logout(req, res, {redirect: opts.redirect});
  }
}