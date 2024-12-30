import { MetaModel, Model, _super } from "../../../core/models"
import { bool } from "../../../core/tools";

@MetaModel.define()
class StockRule extends Model {
    static _module = module;
    static _parents = 'stock.rule';

    async _getStockMoveValues(productId, productQty, productUom, locationId, label, origin, companyId, values) {
        const moveValues = await _super(StockRule, this)._getStockMoveValues(productId, productQty, productUom, locationId, label, origin, companyId, values);
        if (values['productDescriptionVariants'] && values['groupId'] && bool(await values['groupId'].posOrderId)) {
            moveValues['descriptionPicking'] = values['productDescriptionVariants'];
        }
        return moveValues;
    }
}