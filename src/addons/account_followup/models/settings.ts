import { MetaModel, TransientModel } from "../../../core/models"
import { bool } from "../../../core/tools";

@MetaModel.define()
class AccountConfigSettings extends TransientModel {
    static _module = module;
    static _parents = 'res.config.settings';

    async openFollowupLevelForm() {
        const resIds = await this.env.items('followup.followup').search([], {limit: 1});
        return {
            'type': 'ir.actions.actwindow',
            'label': 'Follow-up Levels',
            'resModel': 'followup.followup',
            'resId': bool(resIds) && resIds.id || false,
            'viewMode': 'form,tree',
        }
    }
}