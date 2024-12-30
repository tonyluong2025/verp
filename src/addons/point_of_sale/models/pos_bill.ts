import { Fields, api } from "../../../core";
import { MetaModel, Model, _super } from "../../../core/models"
import { parseFloat } from "../../../core/tools";

@MetaModel.define()
class Bill extends Model {
    static _module = module;
    static _name = "pos.bill";
    static _order = "value";
    static _description = "Coins/Bills";

    static label = Fields.Char("Name");
    static value = Fields.Float("Coin/Bill Value", {required: true, digits: 0});
    static posConfigIds = Fields.Many2many("pos.config");

    @api.model()
    async nameCreate(name) {
        const result = await _super(Bill, this).create({"label": name, "value": parseFloat(name)});
        return (await result.nameGet())[0];
    }
}