import { api, Fields } from "../../../core";
import { MetaModel, TransientModel } from "../../../core/models";
import { bool } from "../../../core/tools";

@MetaModel.define()
class SaleOrderCancel extends TransientModel {
    static _module = module;
    static _name = 'sale.order.cancel';
    static _description = "Sales Order Cancel";

    static orderId = Fields.Many2one('sale.order', { string: 'Sale Order', required: true, ondelete: 'CASCADE' });
    static displayInvoiceAlert = Fields.Boolean('Invoice Alert', { compute: '_computeDisplayInvoiceAlert' });

    @api.depends('orderId')
    async _computeDisplayInvoiceAlert() {
        for (const wizard of this) {
            await wizard.set('displayInvoiceAlert', bool(await (await (await wizard.orderId).invoiceIds).filtered(async (inv) => await inv.state === 'draft')));
        }
    }

    async actionCancel() {
        return (await (await this['orderId']).withContext({ 'disableCancelWarning': true })).actionCancel();
    }
}