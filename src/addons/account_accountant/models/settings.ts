import { Fields } from "../../../core";
import { MetaModel, TransientModel } from "../../../core/models"

@MetaModel.define()
class ResConfigSettings extends TransientModel {
    static _module = module;
    static _parents = "res.config.settings";

    static angloSaxonAccounting = Fields.Boolean({related: "companyId.angloSaxonAccounting", readonly: false, string: "Use anglo-saxon accounting", help: "Record the cost of a good as an expense when this good is invoiced to a final customer."});
}
