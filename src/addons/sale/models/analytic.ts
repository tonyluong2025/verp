import { Fields } from "../../../core";
import { MetaModel, Model } from "../../../core/models"

@MetaModel.define()
class AccountAnalyticLine extends Model {
    static _module = module;
    static _parents = "account.analytic.line";

    /**
     * This is only used for delivered quantity of SO line based on analytic line, and timesheet
            (see saleTimesheet). This can be override to allow further customization.
     * @returns 
     */
    async _defaultSaleLineDomain() {
        return [['qtyDeliveredMethod', '=', 'analytic']];
    }

    static soLine = Fields.Many2one('sale.order.line', {string: 'Sales Order Item', domain: self => self._defaultSaleLineDomain()});
}
