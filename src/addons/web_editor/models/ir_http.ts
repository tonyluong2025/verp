import { ServerResponse } from "http";
import { Dict } from "../../../core/helper/collections";
import { WebRequest } from "../../../core/http";
import { MetaModel, AbstractModel, _super } from "../../../core/models"

@MetaModel.define()
class IrHttp extends AbstractModel {
  static _module = module;
  static _parents = 'ir.http';

  async _dispatch(req: WebRequest, res: ServerResponse) {
    const context = Object.assign({}, req.context);
    if ('editable' in req.params && !('editable' in context)) {
      context['editable'] = true;
    }
    if ('editTranslations' in req.params && !('editTranslations' in context)) {
      context['editTranslations'] = true
    }
    if (context['editTranslations'] && !('translatable' in context)) {
      context['translatable'] = true;
    }
    req.context = context;
    return _super(IrHttp, this)._dispatch(req, res);
  }

  async _getTranslationFrontendModulesName(req) {
    const mods = await _super(IrHttp, this)._getTranslationFrontendModulesName(req);
    return mods.concat(['web_editor']);
  }
}