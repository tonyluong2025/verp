import { Fields } from "../../../core";
import { MetaModel, TransientModel } from "../../../core/models"

@MetaModel.define()
class ResConfigSettings extends TransientModel {
    static _module = module;
    static _parents = 'res.config.settings';

    static moduleStockLandedCosts = Fields.Boolean("Landed Costs",
        {help: "Affect landed costs on reception operations and split them among products to update their cost price."});
    static groupLotOnInvoice = Fields.Boolean("Display Lots & Serial Numbers on Invoices",
                                          {impliedGroup: 'stock_account.groupLotOnInvoice'});
}