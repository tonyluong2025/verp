import { Fields, api } from "../../../core";
import { ValidationError } from "../../../core/helper";
import { MetaModel, TransientModel } from "../../../core/models"

@MetaModel.define()
class PaymentRefundWizard extends TransientModel {
    static _module = module;
    static _name = 'payment.refund.wizard';
    static _description = "Payment Refund Wizard";

    static paymentId = Fields.Many2one({
        string: "Payment",
        comodelName: 'account.payment',
        readonly: true,
        default: (self) => self.env.context['activeId']
    });
    static transactionId = Fields.Many2one({string: "Payment Transaction", related: 'paymentId.paymentTransactionId'});
    static paymentAmount = Fields.Monetary({string: "Payment Amount", related: 'paymentId.amount'});
    static refundedAmount = Fields.Monetary({string: "Refunded Amount", compute: '_computeRefundedAmount'});
    static amountAvailableForRefund = Fields.Monetary({string: "Maximum Refund Allowed", related: 'paymentId.amountAvailableForRefund'});
    static amountToRefund = Fields.Monetary({string: "Refund Amount", compute: '_computeAmountToRefund', store: true, readonly: false});
    static currencyId = Fields.Many2one({string: "Currency", related: 'transactionId.currencyId'});
    static supportRefund = Fields.Selection({related: 'transactionId.acquirerId.supportRefund'});
    static hasPendingRefund = Fields.Boolean({string: "Has a pending refund", compute: '_computeHasPendingRefund'});

    @api.constrains('amountToRefund')
    async _checkAmountToRefundWithinBoundaries() {
        for (const wizard of this) {
            const [amountToRefund, amountAvailableForRefund] = await wizard('amountToRefund', 'amountAvailableForRefund');
            if (! (0 < amountToRefund && amountToRefund <= amountAvailableForRefund)) {
                throw new ValidationError(await this._t(
                    "The amount to be refunded must be positive and cannot be superior to %s.",
                    amountAvailableForRefund
                ));
            }
        }
    }

    @api.depends('amountAvailableForRefund')
    async _computeRefundedAmount() {
        for (const wizard of this) {
            await wizard.set('refundedAmount', await wizard.paymentAmount - await wizard.amountAvailableForRefund);
        }
    }

    /**
     * Set the default amount to refund to the amount available for refund.
     */
    @api.depends('amountAvailableForRefund')
    async _computeAmountToRefund() {
        for (const wizard of this) {
            await wizard.set('amountToRefund', await wizard.amountAvailableForRefund);
        }
    }

    @api.depends('paymentId')  // To always trigger the compute
    async _compute_has_pending_refund() {
        for (const wizard of this) {
            const pendingRefundsCount = await this.env.items('payment.transaction').searchCount([
                ['sourceTransactionId', '=', (await (await wizard.paymentId).paymentTransactionId).id],
                ['operation', '=', 'refund'],
                ['state', 'in', ['draft', 'pending', 'authorized']],
            ]);
            await wizard.set('hasPendingRefund', pendingRefundsCount > 0);
        }
    }

    async actionRefund() {
        for (const wizard of this) {
            await (await wizard.transactionId).actionRefund(await wizard.amountToRefund);
        }
    }
}