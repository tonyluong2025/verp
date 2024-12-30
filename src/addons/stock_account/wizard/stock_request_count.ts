import { Fields } from "../../../core";
import { MetaModel, TransientModel, _super } from "../../../core/models"

@MetaModel.define()
class StockRequestCount extends TransientModel {
    static _module = module;
    static _parents = 'stock.request.count';

    static accountingDate = Fields.Date('Accounting Date');

    async _getValuesToWrite() {
        const res = await _super(StockRequestCount, this)._getValuesToWrite();
        const accountingDate = await this['accountingDate'];
        if (accountingDate) {
            res['accountingDate'] = accountingDate;
        }
        return res;
    }
}