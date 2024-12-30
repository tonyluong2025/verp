import { Fields } from "../../../fields";
import { MetaModel, TransientModel } from "../../../models";

@MetaModel.define()
class BaseModuleUpdate extends TransientModel {
  static _module = module;
  static _name = "base.module.update";
  static _description = "Module Update";

  static updated = Fields.Integer('Number of modules updated', { readonly: true });
  static added = Fields.Integer('Number of modules added', { readonly: true });
  static state = Fields.Selection([['init', 'init'], ['done', 'done']], { string: 'Status', readonly: true, default: 'init' });

  async updateModule() {
    for (const self of this) {
      const [updated, added] = await this.env.items('ir.module.module').updateList();
      await self.write({ 'updated': updated, 'added': added, 'state': 'done' });
    }
    return false;
  }

  async actionModuleOpen() {
    const res = {
      'domain': String([]),
      'label': 'Modules',
      'viewMode': 'tree,form',
      'resModel': 'ir.module.module',
      'viewId': false,
      'type': 'ir.actions.actwindow',
    }
    return res;
  }
}