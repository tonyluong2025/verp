import { Fields } from "../../../core";
import { MetaModel, TransientModel } from "../../../core/models"

@MetaModel.define()
class ResConfigSettings extends TransientModel {
    static _module = module;
    static _parents = 'res.config.settings';

    static unsplashAccessKey = Fields.Char("Access Key", {configParameter: 'unsplash.accessKey'});
}
