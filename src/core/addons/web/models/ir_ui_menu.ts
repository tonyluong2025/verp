import { MetaModel, Model } from "../../../models";
import { bool } from "../../../tools/bool";

@MetaModel.define()
class IrUiMenu extends Model {
  static _module = module;
  static _parents = "ir.ui.menu";

  /**
   * Loads all menu items (all applications and their sub-menus) and
    processes them to be used by the webclient. Mainly, it associates with
    each application (top level menu) the action of its first child menu
    that is associated with an action (recursively), i.e. with the action
    to execute when the opening the app.

    @returns the menus (including the images in Base64)
   */
  async loadWebMenus(debug) {
    const menus = await (this as any).loadMenus(debug);

    const webMenus = {};
    for (const menu of Object.values<any>(menus)) {
      if (! menu['id']) {
        // special root menu case
        webMenus['root'] = {
          "id": 'root',
          "label": menu['label'],
          "children": menu['children'],
          "appId": false,
          "xmlid": "",
          "actionId": false,
          "actionModel": false,
          "webIcon": null,
          "webIconData": null,
          "backgroundImage": menu['backgroundImage'],
        }
      } else {
        let action = menu['action'];

        if (menu['id'] === menu['appId']) {
          // if it's an app take action of first (sub)child having one defined
          let child = menu;
          while (bool(child) && ! action) {
            action = child['action'];
            child = child['children'].length ? menus[child['children'][0]] : false;
          }
        }
        let [actionModel, actionId] = action ? action.split(',') : [false, false];
        actionId = actionId ? parseInt(actionId) : false;

        webMenus[menu['id']] = {
          "id": menu['id'],
          "label": menu['label'],
          "children": menu['children'],
          "appId": menu['appId'],
          "xmlid": menu['xmlid'],
          "actionId": actionId,
          "actionModel": actionModel,
          "webIcon": menu['webIcon'],
          "webIconData": menu['webIconData'],
        }
      }
    }
    return webMenus;
  }
}