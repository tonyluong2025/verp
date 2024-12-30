import { Fields } from "../../../core";
import { MetaModel, Model } from "../../../core/models"
import { bool } from "../../../core/tools";

@MetaModel.define()
class StockLocation extends Model {
    static _module = module;
    static _parents = "stock.location";

    static valuationInAccountId = Fields.Many2one(
        'account.account', {string: 'Stock Valuation Account (Incoming)',
        domain: [['internalType', '=', 'other'], ['deprecated', '=', false]],
        help: "Used for real-time inventory valuation. When set on a virtual location (non internal type), "+
             "this account will be used to hold the value of products being moved from an internal location "+
             "into this location, instead of the generic Stock Output Account set on the product. "+
             "This has no effect for internal locations."});
    static valuationOutAccountId = Fields.Many2one(
        'account.account', {string: 'Stock Valuation Account (Outgoing)',
        domain: [['internalType', '=', 'other'], ['deprecated', '=', false]],
        help: "Used for real-time inventory valuation. When set on a virtual location (non internal type), "+
             "this account will be used to hold the value of products being moved out of this location "+
             "and into an internal location, instead of the generic Stock Output Account set on the product. "+
             "This has no effect for internal locations."});

    /**
     * This method returns a boolean reflecting whether the products stored in `self` should
        be considered when valuating the stock of a company.
     * @returns 
     */
    async _shouldBeValued() {
        this.ensureOne();
        if (await this['usage'] === 'internal' || (await this['usage'] === 'transit' && bool(await this['companyId']))) {
            return true;
        }
        return false;
    }
}
