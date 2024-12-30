import { conf } from "../../../core";
import { HomeStaticTemplateHelpers } from "../../../core/addons/web/controllers";
import { WebRequest } from "../../../core/http"
import { MetaModel, AbstractModel, _super } from "../../../core/models"

@MetaModel.define()
class IrHttp extends AbstractModel {
  static _module = module;
  static _parents = 'ir.http';

  async sessionInfo(req: WebRequest) {
    const env = await req.getEnv();
    const user = await env.user();
    const result = await _super(IrHttp, this).sessionInfo(req);
    if (await user.hasGroup('base.groupUser')) {
      result['notificationType'] = await user.notificationType;
    }
    const assetsDiscussPublicHash = await HomeStaticTemplateHelpers.getQwebTemplatesChecksum(req, {debug: req.session.debug, bundle: 'mail.assetsDiscusspublic'});
    result['cacheHashes']['assetsDiscussPublic'] = assetsDiscussPublicHash;
    const guest = this.env.context['guest'];
    if (! req.session.uid && guest) {
      const userContext = {'lang': await guest.lang};
      const mods = conf.serverWideModules ?? [];
      const lang = userContext["lang"];
      const translationHash = await (await env.items('ir.translation').sudo()).getWebTranslationsHash(mods, lang);
      result['cacheHashes']['translations'] = translationHash;
      Object.assign(result, {
        'label': await guest.label,
        'userContext': userContext,
      })
    }
    return result;
  }
}