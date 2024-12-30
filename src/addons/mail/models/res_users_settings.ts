import { api } from "../../../core";
import { Fields } from "../../../core/fields";
import { MetaModel, Model } from "../../../core/models"
import { bool } from "../../../core/tools/bool";
import { pop } from "../../../core/tools/misc";

@MetaModel.define()
class ResUsersSettings extends Model {
    static _module = module;
    static _name = 'res.users.settings';
    static _description = 'User Settings';

    static userId = Fields.Many2one('res.users', {string: "User", required: true, readonly: true, ondelete: 'CASCADE'});
    static isDiscussSidebarCategoryChannelOpen = Fields.Boolean({string: "Is discuss sidebar category channel open?", default: true});
    static isDiscussSidebarCategoryChatOpen = Fields.Boolean({string: "Is discuss sidebar category chat open?", default: true});

    // RTC
    static pushToTalkKey = Fields.Char({string: "Push-To-Talk shortcut", help: "String formatted to represent a key with modifiers following this pattern: shift.ctrl.alt.key, e.g: truthy.1.true.b"});
    static usePushToTalk = Fields.Boolean({string: "Use the push to talk feature", default: false});
    static voiceActiveDuration = Fields.Integer({string: "Duration of voice activity in ms", help: "How long the audio broadcast will remain active after passing the volume threshold"});
    static volumeSettingsIds = Fields.One2many('res.users.settings.volumes', 'userSettingId', { string: "Volumes of other partners"});

    static _sqlConstraints = [
        ['unique_user_id', 'UNIQUE("userId")', 'One user should only have one mail user settings.']
    ]

    @api.model()
    async _findOrCreateForUser(user) {
        let settings = await (await user.sudo()).resUsersSettingsIds;
        if (! bool(settings)) {
            settings = await (await this.sudo()).create({'userId': user.id});
        }
        return settings;
    }

    async _resUsersSettingsFormat() {
        this.ensureOne();
        const res = (await this._readFormat(this._fields.items().filter(([name, field]) => name === 'id' || !field.automatic).map(([name]) => name)))[0];
        pop(res, 'volumeSettingsIds');
        const volumeSettings = await (await (this as any).volumeSettingsIds)._discussUsersSettingsVolumeFormat();
        Object.assign(res, {
            'volumeSettings': volumeSettings ? [['insert', volumeSettings]] : [],
        })
        return res;
    }

    async setResUsersSettings(newSettings) {
        this.ensureOne();
        const changedSettings = {};
        for (const setting of Object.keys(newSettings)) {
            if (setting in this._fields && newSettings[setting] !== await this[setting]) {
                changedSettings[setting] = newSettings[setting];
            }
        }
        await this.write(changedSettings);
        await this.env.items('bus.bus')._sendone(await (await (this as any).userId).partnerId, 'res.users.settings/changed', changedSettings);
    }

    /**
     * Saves the volume of a guest or a partner.
        Either partnerId or guest_id must be specified.
        :param float volume: the selected volume between 0 and 1
        :param int partnerId:
        :param int guest_id:
     * @param partnerId 
     * @param volume 
     * @param guestId 
     */
    async setVolumeSetting(partnerId, volume, guestId?: any) {
        this.ensureOne();
        let volumeSetting = await this.env.items('res.users.settings.volumes').search([
            ['userSettingId', '=', this.id], ['partnerId', '=', partnerId], ['guestId', '=', guestId]
        ]);
        if (volumeSetting.ok) {
            await volumeSetting.set('volume', volume);
        }
        else {
            volumeSetting = await this.env.items('res.users.settings.volumes').create({
                'userSettingId': this.id,
                'volume': volume,
                'partnerId': partnerId,
                'guestId': guestId,
            })
        }
        await this.env.items('bus.bus')._sendone(await (await (this as any).userId).partnerId, 'res.users.settings/volumesUpdate', {
            'volumeSettings': [['insert', await volumeSetting._discussUsersSettingsVolumeFormat()]],
        })
    }
}