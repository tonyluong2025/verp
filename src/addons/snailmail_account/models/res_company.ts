import { Fields } from "../../../core";
import { MetaModel, Model } from "../../../core/models"

@MetaModel.define()
class Company extends Model {
    static _module = module;
    static _parents = "res.company";

    static invoiceIsSnailmail = Fields.Boolean({string: 'Send by Post', default: false});
}