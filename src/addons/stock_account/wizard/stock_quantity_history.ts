import { MetaModel, TransientModel, _super } from "../../../core/models"
import { formatDatetime } from "../../../core/tools";

@MetaModel.define()
class StockQuantityHistory extends TransientModel {
    static _module = module;
    static _parents = 'stock.quantity.history';

    async openAtDate() {
        const activeModel = this.env.context['activeModel'];
        const inventoryDatetime = await this['inventoryDatetime'];
        if (activeModel === 'stock.valuation.layer') {
            const action = await this.env.items("ir.actions.actions")._forXmlid("stock_account.stockValuationLayerAction");
            action['domain'] = [['createdAt', '<=', inventoryDatetime], ['productId.type', '=', 'product']];
            action['displayName'] = await formatDatetime(this.env, inventoryDatetime);
            return action;
        }

        return _super(StockQuantityHistory, this).openAtDate();
    }
}