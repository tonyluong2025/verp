import { api } from "../../../core";
import { MODULE_UNINSTALL_FLAG } from "../../../core/addons/base";
import { MetaModel, Model, _super } from "../../../core/models";

@MetaModel.define()
class IrModelData extends Model {
    static _module = module;
    static _parents = 'ir.model.data';

    @api.model()
    async _processEndUnlinkRecord(record) {
        if (record._context['module'].startsWith('theme_')) {
            const themeRecords = this.env.models['ir.module.module']._themeModelNames.values();
            if (themeRecords.includes(record._name)) {
                // use activeTest to also unlink archived models
                // and use MODULE_UNINSTALL_FLAG to also unlink inherited models
                let copyIds = (await record.withContext({
                    'activeTest': false,
                    [MODULE_UNINSTALL_FLAG]: true
                })).copyIds;
                if (this.env.req) {
                    // we are in a website context, see `write()` override of
                    // ir.module.module in website
                    const currentWebsite = await this.env.items('website').getCurrentWebsite();
                    copyIds = await copyIds.filtered(async (c) => (await c.websiteId).eq(currentWebsite));
                }

                console.info('Deleting %s@%s (theme `copyIds`) for website %s',
                    copyIds.ids, record._name, await copyIds.mapped('websiteId'));
                await copyIds.unlink();
            }
        }
        return _super(IrModelData, this)._processEndUnlinkRecord(record);
    }
}