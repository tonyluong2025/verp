import { api, Fields } from "../../../core";
import { _super, MetaModel, TransientModel } from "../../../core/models";
import { bool, update } from "../../../core/tools";

@MetaModel.define()
class ResConfigSettings extends TransientModel {
    static _module = module;
    static _parents = "res.config.settings";

    static googleDriveAuthorizationCode = Fields.Char({ string: 'Authorization Code', configParameter: 'google_drive_authorizationCode' });
    static googleDriveUri = Fields.Char({ compute: '_computeDriveUri', string: 'URI', help: "The URL to generate the authorization code from Google" });
    static isGoogleDriveTokenGenerated = Fields.Boolean({ string: 'Refresh Token Generated' });

    @api.depends('googleDriveAuthorizationCode')
    async _computeDriveUri() {
        const googleDriveUri = await this.env.items('google.service')._getGoogleTokenUri('drive', await this.env.items('google.drive.config').getGoogleScope());
        for (const config of this) {
            await config.set('googleDriveUri', googleDriveUri);
        }
    }

    async getValues() {
        const res = await _super(ResConfigSettings, this).getValues();
        const refreshToken = await (await this.env.items('ir.config.parameter').sudo()).getParam('googleDriveRefreshToken', false);
        update(res, { isGoogleDriveTokenGenerated: bool(refreshToken) });
        return res;
    }

    async confirmSetupToken() {
        const params = await this.env.items('ir.config.parameter').sudo();
        const authorizationCodeBefore = await params.getParam('googleDriveAuthorizationCode');
        const authorizationCode = await this['googleDriveAuthorizationCode'];
        if (authorizationCode != authorizationCodeBefore) {
            const refreshToken = authorizationCode ? await this.env.items('google.service').generateRefreshToken('drive', authorizationCode) : false;
            await params.setParam('googleDriveRefreshToken', refreshToken);
        }
    }

    async actionSetupToken() {
        this.ensureOne();
        if (this.env.items('google.drive.config')._moduleDeprecated()) {
            return;
        }

        const template = await this.env.ref('google_drive.googleDriveAuthCodeWizard');
        return {
            'label': await this._t('Set up refresh token'),
            'type': 'ir.actions.actwindow',
            'resModel': 'res.config.settings',
            'views': [[template.id, 'form']],
            'target': 'new',
        }
    }
}
