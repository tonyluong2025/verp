import { api } from "../../../core";
import { MetaModel, Model, _super } from "../../../core/models";
import { slug, unslugUrl } from "../../../core/tools/slug";

@MetaModel.define()
class IrUiView extends Model {
  static _module = module;
  static _parents = ["ir.ui.view"]

  @api.model()
  async _prepareQcontext() {
    const qcontext = await _super(IrUiView, this)._prepareQcontext();
    qcontext['slug'] = slug;
    qcontext['unslugUrl'] = unslugUrl;
    return qcontext;
  }
}