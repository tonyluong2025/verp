import { Fields } from "../../../core";
import { MetaModel, TransientModel } from "../../../core/models"

@MetaModel.define()
class ResConfigSettings extends TransientModel {
    static _module = module;
    static _parents = "res.config.settings";

    static googleDriveUriCopy = Fields.Char({related: 'googleDriveUri', string: 'URI Copy', help: "The URL to generate the authorization code from Google", readonly: false});
}
