import { Fields, api } from "../../../core";
import { MetaModel, Model } from "../../../core/models"
import { len, sum } from "../../../core/tools";
import * as payment_utils from '../utils';

@MetaModel.define()
class AccountMove extends Model {
    static _module = module;
    static _parents = 'account.move';

    static transactionIds = Fields.Many2many({
        string: "Transactions", comodelName: 'payment.transaction',
        relation: 'accountInvoiceTransactionRel', column1: 'invoiceId', column2: 'transactionId',
        readonly: true, copy: false});
    static authorizedTransactionIds = Fields.Many2many({
        string: "Authorized Transactions", comodelName: 'payment.transaction',
        compute: '_computeAuthorizedTransactionIds', readonly: true, copy: false});
    static amountPaid = Fields.Monetary({
        string: "Amount paid",
        help: "The amount already paid for this invoice.",
        compute: '_computeAmountPaid'
    });

    @api.depends('transactionIds')
    async _computeAuthorizedTransactionIds() {
        for (const invoice of this) {
            await invoice.set('authorizedTransactionIds', await (await invoice.transactionIds).filtered(
                async (tx) => await tx.state === 'authorized'
            ));
        }
    }

    /**
     * Sum all the transaction amount for which state is in 'authorized' or 'done'
     */
    @api.depends('transactionIds')
    async _computeAmountPaid() {
        for (const invoice of this) {
            await invoice.set('amountPaid', sum(
                await (await (await invoice.transactionIds).filtered(
                    async (tx) => ['authorized', 'done'].includes(await tx.state)
                )).mapped('amount')
            ));
        }
    }

    async getPortalLastTransaction() {
        this.ensureOne();
        return await (await (await this.withContext({activeTest: false})).transactionIds)._getLast();
    }

    /**
     * Capture all transactions linked to this invoice.
     */
    async paymentActionCapture() {
        await payment_utils.checkRightsOnRecordset(this);
        // In sudo mode because we need to be able to read on acquirer fields.
        await (await (await this['authorizedTransactionIds']).sudo()).actionCapture();
    }

    /**
     * Void all transactions linked to this invoice.
     */
    async paymentActionVoid() {
        await payment_utils.checkRightsOnRecordset(this);
        // In sudo mode because we need to be able to read on acquirer fields.
        await (await (await this['authorizedTransactionIds']).sudo()).actionVoid();
    }

    async actionViewPaymentTransactions() {
        const action = await this.env.items('ir.actions.actions')._forXmlid('payment.actionPaymentTransaction');
        const transactionIds = await this['transactionIds'];
        if (len(transactionIds) == 1) {
            action['viewMode'] = 'form';
            action['resId'] = transactionIds.id;
            action['views'] = [];
        }
        else {
            action['domain'] = [['id', 'in', transactionIds.ids]];
        }
        return action;
    }
}