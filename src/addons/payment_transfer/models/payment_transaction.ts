import { api } from "../../../core";
import { ValidationError } from "../../../core/helper";
import { _super, MetaModel, Model } from "../../../core/models"
import { _f, bool } from "../../../core/tools";
import { TransferController } from "../controllers/main";

@MetaModel.define()
class PaymentTransaction extends Model {
    static _module = module;
    static _parents = 'payment.transaction';

    /**
     * Override of payment to return Transfer-specific rendering values.

        Note: this.ensureOne() from `_get_processing_values`

        :param dict processing_values: The generic and specific processing values of the transaction
        :return: The dict of acquirer-specific processing values
        :rtype: dict
     * @param processingValues 
     * @returns 
     */
    async _getSpecificRenderingValues(processingValues) {
        const res = await _super(PaymentTransaction, this)._getSpecificRenderingValues(processingValues);
        if (await this['provider'] !== 'transfer') {
            return res;
        }

        return {
            'apiurl': TransferController._acceptUrl,
            'reference': await this['reference'],
        }
    }

    /**
     * Override of payment to find the transaction based on transfer data.

        :param str provider: The provider of the acquirer that handled the transaction
        :param dict data: The transfer feedback data
        :return: The transaction if found
        :rtype: recordset of `payment.transaction`
        :raise: ValidationError if the data match no transaction
     * @param provider 
     * @param data 
     * @returns 
     */
    @api.model()
    async _getTxFromFeedbackData(provider, data) {
        let tx = await _super(PaymentTransaction, this)._getTxFromFeedbackData(provider, data);
        if (provider != 'transfer') {
            return tx;
        }

        const reference = data['reference'];
        tx = await this.search([['reference', '=', reference], ['provider', '=', 'transfer']]);
        if (! bool(tx)) {
            throw new ValidationError(
                "Wire Transfer: " + await this._t("No transaction found matching reference %s.", reference)
            );
        }
        return tx;
    }

    /**
     * Override of payment to process the transaction based on transfer data.

        Note: this.ensureOne()

        :param dict data: The transfer feedback data
        :return: void
     * @param data 
     * @returns 
     */
    async _processFeedbackData(data) {
        await _super(PaymentTransaction, this)._processFeedbackData(data);
        if (await this['provider'] != 'transfer') {
            return;
        }

        console.info(
            "validated transfer payment for tx with reference %s: set as pending", await this['reference']
        )
        await (this as any)._setPending();
    }

    /**
     * Override of payment to remove transfer acquirer from the recordset.

        :return: void
     * @returns 
     */
    async _logReceivedMessage() {
        const otherProviderTxs = await this.filtered(async (t)=> await t.provider !== 'transfer');
        await _super(PaymentTransaction, otherProviderTxs)._logReceivedMessage();
    }

    /**
     * Override of payment to return a different message.

        :return: The 'transaction sent' message
        :rtype: str
     * @returns 
     */
    async _getSentMessage() {
        let message = await _super(PaymentTransaction, this)._getSentMessage();
        if (await this['provider'] === 'transfer') {
            message = _f(await this._t(
                "The customer has selected {acqName} to make the payment."),
                {acqName: await (await this['acquirerId']).label}
            );
        }
        return message;
    }
}
