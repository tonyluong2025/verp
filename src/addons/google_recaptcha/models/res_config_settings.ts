import { Fields } from "../../../core";
import { MetaModel, TransientModel } from "../../../core/models"

@MetaModel.define()
class ResConfigSettings extends TransientModel {
    static _module = module;
    static _parents = 'res.config.settings';

    static recaptchaPublicKey = Fields.Char("Site Key", {configParameter: 'recaptchaPublicKey', groups: 'base.groupSystem'});
    static recaptchaPrivateKey = Fields.Char("Secret Key", {configParameter: 'recaptchaPrivateKey', groups: 'base.groupSystem'});
    static recaptchaMinScore = Fields.Float(
        "Minimum score",
        {configParameter: 'recaptchaMinScore',
        groups: 'base.groupSystem',
        default: "0.5",
        help: "Should be between 0.0 and 1.0.\n1.0 is very likely a good interaction, 0.0 is very likely a bot"});
}