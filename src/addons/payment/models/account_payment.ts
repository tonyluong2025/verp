import { Command, Fields, api } from "../../../core";
import { ValidationError } from "../../../core/helper";
import { MetaModel, Model, _super } from "../../../core/models"
import { bool, sum } from "../../../core/tools";

@MetaModel.define()
class AccountPayment extends Model {
    static _module = module;
    static _parents = 'account.payment';

    // == Business fields ==
    static paymentTransactionId = Fields.Many2one({
        string: "Payment Transaction",
        comodelName: 'payment.transaction',
        readonly: true,
        autojoin: true,  // No access rule bypass since access to payments means access to txs too
    });
    static paymentTokenId = Fields.Many2one({
        string: "Saved Payment Token", comodelName: 'payment.token', domain: `[
            ['id', 'in', suitablePaymentTokenIds],
        ]`,
        help: "Note that only tokens from acquirers allowing to capture the amount are available."
    });
    static amountAvailableForRefund = Fields.Monetary({ compute: '_computeAmountAvailableForRefund' });

    // == Display purpose fields ==
    static suitablePaymentTokenIds = Fields.Many2many({
        comodelName: 'payment.token',
        compute: '_computeSuitablePaymentTokenIds',
        computeSudo: true,
    });
    static useElectronicPaymentMethod = Fields.Boolean({
        compute: '_computeUseElectronicPaymentMethod',
        help: 'Technical field used to hide or show the paymentTokenId if needed.'
    });

    // == Fields used for traceability ==
    static sourcePaymentId = Fields.Many2one({
        string: "Source Payment",
        comodelName: 'account.payment',
        help: "The source payment of related refund payments",
        related: 'paymentTransactionId.sourceTransactionId.paymentId',
        readonly: true,
        store: true,  // Stored for the group by in `_computeRefundsCount`
    });
    static refundsCount = Fields.Integer({ string: "Refunds Count", compute: '_computeRefundsCount' });

    async _computeAmountAvailableForRefund() {
        for (const payment of this) {
            const txSudo = await (await payment.paymentTransactionId).sudo();
            if (await (await txSudo.acquirerId).supportRefund && await txSudo.operation != 'refund') {
                // Only consider refund transactions that are confirmed by summing the amounts of
                // payments linked to such refund transactions. Indeed, should a refund transaction
                // be stuck forever in a transient state (due to webhook failure, for example), the
                // user would never be allowed to refund the source transaction again.
                const refundPayments = await this.search([['sourcePaymentId', '=', this.id]]);
                const refundedAmount = Math.abs(sum(await refundPayments.mapped('amount')));
                await payment.set('amountAvailableForRefund', await payment.amount - refundedAmount);
            }
            else {
                await payment.set('amountAvailableForRefund', 0);
            }
        }
    }

    @api.depends('paymentMethodLineId')
    async _computeSuitablePaymentTokenIds() {
        for (const payment of this) {
            let partner = await payment.partnerId;
            partner = partner.or(await partner.commercialPartnerId);
            partner = partner.or(await partner.childIds);
            const relatedPartnerIds = partner._origin;

            if (await payment.useElectronicPaymentMethod) {
                await payment.set('suitablePaymentTokenIds', await (await this.env.items('payment.token').sudo()).search([
                    ['companyId', '=', (await payment.companyId).id],
                    ['acquirerId.captureManually', '=', false],
                    ['partnerId', 'in', relatedPartnerIds.ids],
                    ['acquirerId', '=', (await (await payment.paymentMethodLineId).paymentAcquirerId).id],
                ]));
            }
            else {
                await payment.set('suitablePaymentTokenIds', [Command.clear()]);
            }
        }
    }

    @api.depends('paymentMethodLineId')
    async _computeUseElectronicPaymentMethod() {
        const field = this.env.models['payment.acquirer']._fields['provider'];
        for (const payment of this) {
            // Get a list of all electronic payment method codes.
            // These codes are comprised of 'electronic' and the providers of each payment acquirer.
            const codes = (await field._descriptionSelection(field, this.env)).map(([key]) => key);
            await payment.set('useElectronicPaymentMethod', codes.includes(await payment.paymentMethodCode));
        }
    }

    async _computeRefundsCount() {
        const rgData = await this.env.items('account.payment').readGroup(
            [
                ['sourcePaymentId', 'in', this.ids],
                ['paymentTransactionId.operation', '=', 'refund']
            ],
            ['sourcePaymentId'],
            ['sourcePaymentId']
        );
        const data = Object.fromEntries(rgData.map(x => [x['sourcePaymentId'][0], x['sourcePaymentIdCount']]));
        for (const payment of this) {
            await payment.set('refundsCount', data[payment.id] ?? 0);
        }
    }

    @api.onchange('partnerId', 'paymentMethodLineId', 'journalId')
    async _onchangeSetPaymentTokenId() {
        const field = this.env.models['payment.acquirer']._fields['provider'];
        const codes = (await field._descriptionSelection(field, this.env)).map(([key]) => key);
        if (!(codes.includes(await this['paymentMethodCode']) && (await this['partnerId']).ok && (await this['journalId']).ok)) {
            await this.set('paymentTokenId', false);
            return;
        }

        let partner = await this['partnerId'];
        partner = partner.or(await partner.commercialPartnerId);
        partner = partner.or(await partner.childIds);
        const relatedPartnerIds = partner._origin;

        await this.set('paymentTokenId', await (await this.env.items('payment.token').sudo()).search([
            ['companyId', '=', (await this['companyId']).id],
            ['partnerId', 'in', relatedPartnerIds.ids],
            ['acquirerId.captureManually', '=', false],
            ['acquirerId', '=', (await (await this['paymentMethodLineId']).paymentAcquirerId).id],
        ], { limit: 1 }));
    }

    async actionPost() {
        // Post the payments "normally" if no transactions are needed.
        // If not, let the acquirer update the state.

        const paymentsNeedTx = await this.filtered(
            async (p) => bool(await p.paymentTokenId) && !bool(await p.paymentTransactionId)
        );
        // creating the transaction require to access data on payment acquirers, not always accessible to users
        // able to create payments
        const transactions = await (await paymentsNeedTx.sudo())._createPaymentTransaction();

        const res = await _super(AccountPayment, this.sub(paymentsNeedTx)).actionPost();

        for (const tx of transactions) {  // Process the transactions with a payment by token
            await tx._sendPaymentRequest();
        }

        // Post payments for issued transactions
        await transactions._finalizePostProcessing();
        const paymentsTxDone = await paymentsNeedTx.filtered(
            async (p) => await (await p.paymentTransactionId).state === 'done'
        );
        await _super(AccountPayment, paymentsTxDone).actionPost();
        const paymentsTxNotDone = await paymentsNeedTx.filtered(
            async (p) => await (await p.paymentTransactionId).state !== 'done'
        );
        await paymentsTxNotDone.actionCancel();

        return res;
    }

    async actionRefundWizard() {
        this.ensureOne();
        return {
            'label': await this._t("Refund"),
            'type': 'ir.actions.actwindow',
            'viewMode': 'form',
            'resModel': 'payment.refund.wizard',
            'target': 'new',
        }
    }

    async actionViewRefunds() {
        this.ensureOne();
        const action = {
            'label': await this._t("Refund"),
            'resModel': 'account.payment',
            'type': 'ir.actions.actwindow',
        }
        if (await this['refundsCount'] == 1) {
            const refundTx = await this.env.items('account.payment').search([
                ['sourcePaymentId', '=', this.id]
            ], { limit: 1 });
            action['resId'] = refundTx.id
            action['viewMode'] = 'form'
        }
        else {
            action['viewMode'] = 'tree,form'
            action['domain'] = [['sourcePaymentId', '=', this.id]];
        }
        return action;
    }

    async _getPaymentChatterLink() {
        this.ensureOne();
        return `<a href=# data-oe-model="account.payment" data-oe-id={this.id}>${await this['label']}</a>`;
    }

    async _createPaymentTransaction(extraCreateValues) {
        for (const payment of this) {
            if (bool(await payment.paymentTransactionId)) {
                throw new ValidationError(await this._t(
                    "A payment transaction with reference %s already exists.",
                    await (await payment.paymentTransactionId).reference
                ));
            }
            else if (!bool(await payment.paymentTokenId)) {
                throw new ValidationError(await this._t("A token is required to create a new payment transaction."));
            }
        }
        let transactions = this.env.items('payment.transaction');
        for (const payment of this) {
            const transactionVals = await payment._preparePaymentTransactionVals(extraCreateValues);
            const transaction = await this.env.items('payment.transaction').create(transactionVals);
            transactions = transactions.add(transaction);
            await payment.set('paymentTransactionId', transaction);  // Link the transaction to the payment
        }
        return transactions;
    }

    async _preparePaymentTransactionVals(extraCreateValues) {
        this.ensureOne();
        return {
            'acquirerId': (await (await this['paymentTokenId']).acquirerId).id,
            'reference': await this['ref'],
            'amount': await this['amount'],
            'currencyId': (await this['currencyId']).id,
            'partnerId': (await this['partnerId']).id,
            'token_id': (await this['paymentTokenId']).id,
            'operation': 'offline',
            'payment_id': this.id,
            ...extraCreateValues,
        }
    }
}