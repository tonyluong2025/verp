import { api } from "../../../core";
import { _super, MetaModel, TransientModel } from "../../../core/models"
import { urlQuote } from "../../../core/service/middleware/utils";
import { bool, sum, update } from "../../../core/tools";

@MetaModel.define()
class PaymentLinkWizard extends TransientModel {
    static _module = module;
    static _parents = 'payment.link.wizard';
    static _description = 'Generate Sales Payment Link';

    @api.model()
    async defaultGet(fields) {
        const res = _super(PaymentLinkWizard, this).defaultGet(fields);
        if (res['resId'] && res['resModel'] === 'sale.order') {
            const record = this.env.items(res['resModel']).browse(res['resId']);
            update(res, {
                'description': await record.label,
                'amount': await record.amountTotal - sum(await (await (await record.invoiceIds).filtered(async (x) => await x.state !== 'cancel')).mapped('amountTotal')),
                'currencyId': (await record.currencyId).id,
                'partnerId': (await record.partnerInvoiceId).id,
                'amountMax': await record.amountTotal
            });
        }
        return res;
    }

    /**
     * Select and return the acquirers matching the criteria.

        :param int companyId: The company to which acquirers must belong, as a `res.company` id
        :param int partnerId: The partner making the payment, as a `res.partner` id
        :param int currencyId: The payment currency if known beforehand, as a `res.currency` id
        :param int saleOrderId: The sale order currency if known beforehand, as a `sale.order` id
        :return: The compatible acquirers
        :rtype: recordset of `payment.acquirer`
     * @param companyId 
     * @param partnerId 
     * @param currencyId 
     * @param saleOrderId 
     * @returns 
     */
    async _getPaymentAcquirerAvailable(companyId?: any, partnerId?: any, currencyId?: any, saleOrderId?: any) {
        return (await this.env.items('payment.acquirer').sudo())._getCompatibleAcquirers(
            bool(companyId) ? companyId : (await this['companyId']).id,
            bool(partnerId) ? partnerId : (await this['partnerId']).id,
            {currencyId: bool(currencyId) ? currencyId : (await this['currencyId']).id,
            saleOrderId: bool(saleOrderId) ? saleOrderId : await this['resId']}
        );
    }

    /**
     * Override of payment to add the sale_order_id in the link.
     */
    async _generateLink() {
        for (const paymentLink of this) {
            // The sale_order_id field only makes sense if the document is a sales order
            if (await paymentLink.resModel === 'sale.order') {
                const relatedDocument = this.env.items(await paymentLink.resModel).browse(await paymentLink.resId);
                const baseUrl = await relatedDocument.getBaseUrl();
                await paymentLink.set('link', `${baseUrl}/payment/pay`+
                                    `?reference=${urlQuote(await paymentLink.description)}`+
                                    `&amount=${await paymentLink.amount}`+
                                    `&saleOrderId=${await paymentLink.resId}`+
                                    `${"&acquirerId=" + await paymentLink.paymentAcquirerSelection != "all" ? String(await paymentLink.paymentAcquirerSelection) : "" }`+
                                    `&accessToken=${await paymentLink.accessToken}`);
                // Order-related fields are retrieved in the controller
            }
            else {
                await _super(PaymentLinkWizard, paymentLink)._generateLink();
            }
        }
    }
}