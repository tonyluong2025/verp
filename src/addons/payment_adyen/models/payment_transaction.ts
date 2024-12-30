import { api } from "../../../core";
import { UserError, ValidationError } from "../../../core/helper";
import { _super, MetaModel, Model } from "../../../core/models"
import { bool } from "../../../core/tools";
import { stringify } from "../../../core/tools/json";
import { buildTokenName, generateAccessToken, getCustomerIpAddress, toMajorCurrencyUnits, toMinorCurrencyUnits } from "../../payment/utils";
import { CURRENCY_DECIMALS, RESULT_CODES_MAPPING } from "../const";
import { formatPartnerName, includePartnerAddresses } from "../utils";

@MetaModel.define()
class PaymentTransaction extends Model {
    static _module = module;
    static _parents = 'payment.transaction';

    //=== BUSINESS METHODS ===#

    /**
     * Override of payment to return Adyen-specific processing values.

        Note: this.ensureOne() from `_getProcessingValues`

        :param dict processingValues: The generic processing values of the transaction
        :return: The dict of acquirer-specific processing values
        :rtype: dict
     * @param processingValues 
     * @returns 
     */
    async _getSpecificProcessingValues(processingValues) {
        const res = await _super(PaymentTransaction, this)._getSpecificProcessingValues(processingValues);
        if (await this['provider'] !== 'adyen') {
            return res;
        }

        const convertedAmount = await toMinorCurrencyUnits(
            await this['amount'], await this['currencyId'], CURRENCY_DECIMALS[await (await this['currencyId']).label]
        );
        return {
            'convertedAmount': convertedAmount,
            'accessToken': await generateAccessToken(
                this.env,
                processingValues['reference'],
                convertedAmount,
                processingValues['partnerId']
            )
        }
    }

    /**
     * Override of payment to send a payment request to Adyen.

        Note: this.ensureOne()

        :return: void
        :raise: UserError if the transaction is not linked to a token
     * @returns 
     */
    async _sendPaymentRequest(req) {
        await _super(PaymentTransaction, this)._sendPaymentRequest(req);
        if (await this['provider'] !== 'adyen') {
            return;
        }

        // Make the payment request to Adyen
        if (! bool(await this['tokenId'])) {
            throw new UserError("Adyen: " + await this._t("The transaction is not linked to a token."));
        }
        const convertedAmount = await toMinorCurrencyUnits(
            await this['amount'], await this['currencyId'], CURRENCY_DECIMALS[await (await this['currencyId']).lable]
        );
        const data = {
            'merchantAccount': await (await this['acquirerId']).adyenMerchantAccount,
            'amount': {
                'value': convertedAmount,
                'currency': await (await this['currencyId']).label,
            },
            'reference': await this['reference'],
            'paymentMethod': {
                'recurringDetailReference': await (await this['tokenId']).acquirerRef,
            },
            'shopperReference': await (await this['tokenId']).adyenShopperReference,
            'recurringProcessingModel': 'Subscription',
            'shopperIP': await getCustomerIpAddress(req),
            'shopperInteraction': 'ContAuth',
            'shopperEmail': await this['partnerEmail'],
            'shopperName': formatPartnerName(await this['partnerName']),
            'telephoneNumber': await this['partnerPhone'],
            ... await includePartnerAddresses(this),
        }
        const responseContent = await (await this['acquirerId'])._adyenMakeRequest('adyenCheckoutApiUrl', '/payments', null, data, 'POST');

        // Handle the payment request response
        console.info("payment request response:\n%s", responseContent);
        await (this as any)._handleFeedbackData('adyen', responseContent);
    }

    /**
     * Override of payment to send a refund request to Adyen.

        Note: this.ensureOne()

        :param float amountToRefund: The amount to refund
        :param bool createRefundTransaction: Whether a refund transaction should be created or not
        :return: The refund transaction if any
        :rtype: recordset of `payment.transaction`
     * @param amountToRefund 
     * @param createRefundTransaction 
     * @returns 
     */
    async _sendRefundRequest(amountToRefund?: any, createRefundTransaction=true) {
        if (await this['provider'] !== 'adyen') {
            return _super(PaymentTransaction, this)._sendRefundRequest(amountToRefund, createRefundTransaction);
        }
        const refundTx = await _super(PaymentTransaction, this)._sendRefundRequest(amountToRefund, true);

        // Make the refund request to Adyen
        const convertedAmount = await toMinorCurrencyUnits(
            -await refundTx.amount,  // The amount is negative for refund transactions
            await refundTx.currencyId,
            CURRENCY_DECIMALS[await (await refundTx.currencyId).label]
        );
        const data = {
            'merchantAccount': await (await this['acquirerId']).adyenMerchantAccount,
            'amount': {
                'value': convertedAmount,
                'currency': await (await refundTx.currencyId).label,
            },
            'reference': await refundTx.reference,
        }
        const responseContent = await (await refundTx.acquirerId)._adyenMakeRequest(
            'adyenCheckoutApiUrl',
            '/payments/{param}/refunds',
            await this['acquirerReference'],
            data,
            'POST'
        )
        console.info("refund request response:\n%s", responseContent);

        // Handle the refund request response
        const pspReference = responseContent['pspReference'];
        status = responseContent['status'];
        if (pspReference && status === 'received') {
            // The PSP reference associated with this /refunds request is different from the psp
            // reference associated with the original payment request.
            await refundTx.set('acquirerReference', pspReference);
        }
        return refundTx;
    }

    /**
     * Override of payment to find the transaction based on Adyen data.

        :param str provider: The provider of the acquirer that handled the transaction
        :param dict data: The feedback data sent by the provider
        :return: The transaction if found
        :rtype: recordset of `payment.transaction`
        :raise: ValidationError if inconsistent data were received
        :raise: ValidationError if the data match no transaction
     * @param provider 
     * @param data 
     * @returns 
     */
    @api.model()
    async _getTxFromFeedbackData(provider, data) {
        let tx = await _super(PaymentTransaction, this)._getTxFromFeedbackData(provider, data);
        if (provider != 'adyen') {
            return tx;
        }

        const reference = data['merchantReference'];
        if (! reference) {
            throw new ValidationError("Adyen: " + await this._t("Received data with missing merchant reference"));
        }
        const eventCode = data['eventCode'];

        tx = await this.search([['reference', '=', reference], ['provider', '=', 'adyen']]);
        if (eventCode == 'REFUND' && (!bool(tx) || await tx.operation !== 'refund')) {
            // If a refund is initiated from Adyen, the merchant reference can be personalized. We
            // need to get the source transaction and manually create the refund transaction.
            const sourceAcquirerReference = data['originalReference'];
            const sourceTx = await this.search(
                [['acquirerReference', '=', sourceAcquirerReference], ['provider', '=', 'adyen']]
            );
            if (bool(sourceTx)) {
                // Manually create a refund transaction with a new reference. The reference of
                // the refund transaction was personalized from Adyen and could be identical to
                // that of an existing transaction.
                tx = await this._adyenCreateRefundTxFromFeedbackData(sourceTx, data);
            }
            else {  // The refund was initiated for an unknown source transaction
                // pass  // Don't do anything with the refund notification
            }
        }
        if (!bool(tx)) {
            throw new ValidationError("Adyen: " + await this._t("No transaction found matching reference %s.", reference));
        }
        return tx;
    }

    /**
     * Create a refund transaction based on Adyen data.

        :param recordset sourceTx: The source transaction for which a refund is initiated, as a
                                    `payment.transaction` recordset
        :param dict data: The feedback data sent by the provider
        :return: The created refund transaction
        :rtype: recordset of `payment.transaction`
        :raise: ValidationError if inconsistent data were received
     * @param sourceTx 
     * @param data 
     * @returns 
     */
    async _adyenCreateRefundTxFromFeedbackData(sourceTx, data) {
        const refundAcquirerReference = data['pspReference'];
        const amountToRefund = (data['amount'] ?? {})['value'];
        if (! refundAcquirerReference || ! amountToRefund) {
            throw new ValidationError("Adyen: " + await this._t("Received refund data with missing transaction values"));
        }

        const convertedAmount = await toMajorCurrencyUnits(amountToRefund, await sourceTx.currencyId);
        return sourceTx._createRefundTransaction(convertedAmount, {acquirerReference: refundAcquirerReference});
    }

    /**
     * Override of payment to process the transaction based on Adyen data.

        Note: this.ensureOne()

        :param dict data: The feedback data sent by the provider
        :return: void
        :raise: ValidationError if inconsistent data were received
     * @param data 
     * @returns 
     */
    async _processFeedbackData(data) {
        const self: any = this;
        await _super(PaymentTransaction, self)._processFeedbackData(data);
        if (await self.provider !== 'adyen') {
            return;
        }

        // Handle the acquirer reference
        if ('pspReference' in data) {
            await self.set('acquirerReference', data['pspReference']);
        }
        // Handle the payment state
        const paymentState = data['resultCode'];
        const refusalReason = data['refusalReason'] || data['reason'];
        if (! paymentState) {
            throw new ValidationError("Adyen: " + await self._t("Received data with missing payment state."));
        }
        if (RESULT_CODES_MAPPING['pending'].includes(paymentState)) {
            await self._setPending();
        }
        else if (RESULT_CODES_MAPPING['done'].includes(paymentState)) {
            const hasTokenData = 'recurring.recurringDetailReference' in (data['additionalData'] ?? {});
            if (await self.tokenize && hasTokenData) {
                await self._adyenTokenizeFromFeedbackData(data);
            }
            await self._setDone();
            if (await self.operation === 'refund') {
                await (await self.env.ref('payment.cronPostProcessPaymentTx'))._trigger();
            }
        }
        else if (RESULT_CODES_MAPPING['cancel'].includes(paymentState)) {
            console.warn("The transaction with reference %s was cancelled (reason: %s)", await self.reference, refusalReason);
            await self._setCanceled();
        }
        else if (RESULT_CODES_MAPPING['error'].includes(paymentState)) {
            console.warn("An error occurred on transaction with reference %s (reason: %s)", await self.reference, refusalReason);
            await self._setError(await self._t("An error occurred during the processing of your payment. Please try again."));
        }
        else if (RESULT_CODES_MAPPING['refused'].includes(paymentState)) {
            console.warn("The transaction with reference %s was refused (reason: %s)", await self.reference, refusalReason);
            await self._setError(await self._t("Your payment was refused. Please try again."));
        }
        else {  // Classify unsupported payment state as `error` tx state
            console.warn("received data with invalid payment state: %s", paymentState);
            await self._setError("Adyen: " + await self._t("Received data with invalid payment state: %s", paymentState));
        }
    }

    /**
     * Create a new token based on the feedback data.

        Note: this.ensureOne()

        :param dict data: The feedback data sent by the provider
        :return: void
     * @param data 
     */
    async _adyenTokenizeFromFeedbackData(data) {
        this.ensureOne();

        const token = await this.env.items('payment.token').create({
            'acquirerId': (await this['acquirerId']).id,
            'label': buildTokenName(data['additionalData']['cardSummary']),
            'partnerId': (await this['partnerId']).id,
            'acquirerRef': data['additionalData']['recurring.recurringDetailReference'],
            'adyenShopperReference': data['additionalData']['recurring.shopperReference'],
            'verified': true,  // The payment is authorized, so the payment method is valid
        })
        await this.write({
            'tokenId': token,
            'tokenize': false,
        })
        console.info(
            "created token with id %s for partner with id %s", token.id, (await this['partnerId']).id
        );
    }
}