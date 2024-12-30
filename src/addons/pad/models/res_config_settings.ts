import { Fields } from "../../../core";
import { MetaModel, TransientModel } from "../../../core/models"

@MetaModel.define()
class ResConfigSettings extends TransientModel {
    static _module = module;
    static _parents = 'res.config.settings';

    static padServer = Fields.Char({configParameter: 'pad.padServer', string: "Pad Server"});
    static padKey = Fields.Char({configParameter: 'pad.padKey', string: "Pad API Key"});
}
