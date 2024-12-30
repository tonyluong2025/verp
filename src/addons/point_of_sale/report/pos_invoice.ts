import _ from "lodash";
import { api } from "../../../core";
import { AbstractModel } from "../../../core/models"
import { MetaModel } from "../../../core/models"
import { UserError } from "../../../core/helper";

@MetaModel.define()
class PosInvoiceReport extends AbstractModel {
    static _module = module;
    static _name = 'report.pos.invoice';
    static _description = 'Point of Sale Invoice Report'

    @api.model()
    async _getReportValues(docids, data?: any) {
        const posOrder = this.env.items('pos.order'),
        idsToPrint = [],
        invoicedPosordersIds = [];
        const selectedOrders = posOrder.browse(docids);
        
        for (const order of await selectedOrders.filtered(o => o.accountMove)) {
            idsToPrint.push((await order.accountMove).id);
            invoicedPosordersIds.push(order.id);
        }
        const notInvoicedOrdersIds = _.difference(docids, invoicedPosordersIds);
        if (notInvoicedOrdersIds.length) {
            const notInvoicedPosorders = posOrder.browse(notInvoicedOrdersIds);
            const notInvoicedOrdersNames = await notInvoicedPosorders.map(a => a.label);
            throw new UserError(await this._t('No link to an invoice for %s.', String(notInvoicedOrdersNames)));
        }

        return {
            'docs': await (await this.env.items('account.move').sudo()).browse(idsToPrint),
            'qrCodeUrls': (await (await this.env.items('report.account.invoice').sudo())._getReportValues(idsToPrint))['qrCodeUrls']
        }
    }
}