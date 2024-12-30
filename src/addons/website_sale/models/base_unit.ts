import { Fields } from "../../../core";
import { MetaModel, Model } from "../../../core/models"

@MetaModel.define()
class BaseUnit extends Model {
    static _module = module;
    static _name = "website.base.unit";
    static _description = "Unit of Measure for price per unit on eCommerce products.";
    static _order = "label";

    static label = Fields.Char({help: "Define a custom unit to display in the price per unit of measure field.",
                       required: true, translate: true});
}
