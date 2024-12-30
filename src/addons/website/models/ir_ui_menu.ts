import { api, tools } from "../../../core";
import { MetaModel, Model, _super } from "../../../core/models";

@MetaModel.define()
class IrUiMenu extends Model {
  static _module = module;
  static _parents = 'ir.ui.menu';

  @api.model()
  @tools.ormcacheContext('self._uid', ['lang', 'forceAction'])
  async loadMenusRoot() {
    const rootMenus = await _super(IrUiMenu, this).loadMenusRoot();
    if (this.env.context['forceAction']) {
      const req = this.env.req;
      const webMenus = await (this as any).loadWebMenus(req ? req.session.debug : false);
      for (const menu of rootMenus['children']) {
        // Force the action.
        if (
          !menu['action']
          && webMenus[menu['id']]['actionModel']
          && webMenus[menu['id']]['actionId']
        ) {
          menu['action'] = `${webMenus[menu['id']]['actionModel']},${webMenus[menu['id']]['actionId']}`;
        }
      }
    }
    return rootMenus;
  }
}