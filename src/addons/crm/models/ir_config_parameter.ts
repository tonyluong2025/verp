import { api } from "../../../core";
import { MODULE_UNINSTALL_FLAG } from "../../../core/addons/base";
import { MetaModel, Model, _super } from "../../../core/models";
import { bool } from "../../../core/tools";

@MetaModel.define()
class IrConfigParameter extends Model {
    static _module = module;
    static _parents = 'ir.config.parameter';

    async write(vals) {
        const result = await _super(IrConfigParameter, this).write(vals);
        if (await this.some(async (record) => await record.key === "crm.plsFields")) {
            await this.flush();
            await this.env.registry.setupModels(this.env.cr);
        }
        return result;
    }

    @api.modelCreateMulti()
    async create(valsList) {
        const records = await _super(IrConfigParameter, this).create(valsList);
        if (await this.some(async (record) => await record.key === "crm.plsFields")) {
            await this.flush();
            await this.env.registry.setupModels(this.env.cr);
        }
        return records;
    }

    async unlink() {
        const plsEmptied = await this.some(async (record) => await record.key === "crm.plsFields");
        const result = await _super(IrConfigParameter, this).unlink();
        if (bool(plsEmptied) && !this._context[MODULE_UNINSTALL_FLAG]) {
            await this.flush();
            await this.env.registry.setupModels(this.env.cr);
        }
        return result;
    }
}