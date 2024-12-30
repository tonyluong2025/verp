import { Fields } from "../../../core";
import { MetaModel, Model } from "../../../core/models"

@MetaModel.define()
class ResourceResource extends Model {
    static _module = module;
    static _parents = "resource.resource";

    static userId = Fields.Many2one({copy: false});
}