import { Fields } from "../../../core";
import { MetaModel, TransientModel } from "../../../core/models"

@MetaModel.define()
class ResConfigSettings extends TransientModel {
    static _module = module;
    static _parents = 'res.config.settings';	

    static snailmailColor = Fields.Boolean({string: 'Print In Color', related: 'companyId.snailmailColor', readonly: false});
    static snailmailCover = Fields.Boolean({string: 'Add a Cover Page', related: 'companyId.snailmailCover', readonly: false});
    static snailmailDuplex = Fields.Boolean({string: 'Print Both sides', related: 'companyId.snailmailDuplex', readonly: false});
}