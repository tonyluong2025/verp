import { api } from "../../../core";
import { MetaModel, Model, _super } from "../../../core/models"
import { getModuleIcon } from "../../../core/modules";

@MetaModel.define()
class Users extends Model {
    static _module = module;
    static _name = 'res.users';
    static _parents = ['res.users'];

    /**
     * Update the systray icon of res.partner activities to use the
        contact application one instead of base icon.
     * @returns 
     */
    @api.model()
    async systrayGetActivities() {
        const activities = await _super(Users, this).systrayGetActivities();
        for (const activity of activities) {
            if (await activity['model'] !== 'res.partner') {
                continue;
            }
            activity['icon'] = getModuleIcon('contacts');
        }
        return activities;
    }
}