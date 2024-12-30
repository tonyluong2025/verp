import { Fields } from "../../../core/fields";
import { MetaModel, Model } from "../../../core/models";
import { bool } from "../../../core/tools/bool";

/**
 * Represents the volume of the sound that the user of user_setting_id will receive from partnerId.
 */
@MetaModel.define()
class ResUsersSettingsVolumes extends Model {
    static _module = module;
    static _name = 'res.users.settings.volumes';
    static _description = 'User Settings Volumes';

    static userSettingId = Fields.Many2one('res.users.settings', {string: 'User settings', required: true, ondelete: 'CASCADE', index: true});
    static partnerId = Fields.Many2one('res.partner', {string:'Partner', ondelete: 'CASCADE', index: true});
    static guestId = Fields.Many2one('res.partner', {string: 'Guest', ondelete: 'CASCADE', index: true});
    static volume = Fields.Float({default: 0.5, help: "Ranges between 0.0 and 1.0, scale depends on the browser implementation"});

    async init() {
        await this.env.cr.execute(`CREATE UNIQUE INDEX IF NOT EXISTS "resUsersSettingsVolumesPartner_unique_index" ON "${this.cls._table}" ("userSettingId", "partnerId") WHERE "partnerId" IS NOT NULL`);
        await this.env.cr.execute(`CREATE UNIQUE INDEX IF NOT EXISTS "resUsersSettingsVolumesGuest_unique_index" ON "${this.cls._table}" ("userSettingId", "guestId") WHERE "guestId" IS NOT NULL`);
    }

    static _sqlConstraints = [
        ['partner_or_guest_exists', 'CHECK(("partnerId" IS NOT NULL AND "guestId" IS NULL) OR ("partnerId" IS NULL AND "guestId" IS NOT NULL))', "A volume setting must have a partner or a guest."],
    ]

    async _discussUsersSettingsVolumeFormat() {
        const res = [];
        for (const volumeSetting of this) {
            const guestId = await volumeSetting.guestId;
            const partnerId = await volumeSetting.partnerId;
            res.push({
                'id': volumeSetting.id,
                'volume': await volumeSetting.volume,
                'guest': bool(guestId) ? [['insert-and-replace', {
                    'id': guestId.id,
                    'label': await guestId.label,
                }]] : [['clear',]],
                'partner': bool(partnerId) ? [['insert-and-replace', {
                    'id': partnerId.id,
                    'label': await partnerId.label,
                }]] : [['clear',]]
            });
        }
        return res;
    }
}