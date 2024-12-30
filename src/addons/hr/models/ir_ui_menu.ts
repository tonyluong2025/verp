import { MetaModel, Model, _super } from "../../../core/models"

@MetaModel.define()
class IrUiMenu extends Model {
    static _module = module;
    static _parents = 'ir.ui.menu';

    async _loadMenusBlacklist() {
        const res = await _super(IrUiMenu, this)._loadMenusBlacklist();
        if (await (await this.env.user()).hasGroup('hr.groupHrUser')) {
            res.push((await this.env.ref('hr.menuHrEmployee')).id);
        }
        return res;
    }
}