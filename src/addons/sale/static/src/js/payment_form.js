verp.define('sale.paymentForm', require => {
    'use strict';

    const checkoutForm = require('payment.checkoutForm');
    const manageForm = require('payment.manageForm');

    const salePaymentMixin = {

        //--------------------------------------------------------------------------
        // Private
        //--------------------------------------------------------------------------

        /**
         * Add `saleOrderId` to the transaction route params if it is provided.
         *
         * @override method from payment.paymentFormMixin
         * @private
         * @param {string} provider - The provider of the selected payment option's acquirer
         * @param {number} paymentOptionId - The id of the selected payment option
         * @param {string} flow - The online payment flow of the selected payment option
         * @return {object} The extended transaction route params
         */
        _prepareTransactionRouteParams: function (provider, paymentOptionId, flow) {
            const transactionRouteParams = this._super(...arguments);
            return {
                ...transactionRouteParams,
                'saleOrderId': this.txContext.saleOrderId
                    ? parseInt(this.txContext.saleOrderId) : undefined,
            };
        },

    };

    checkoutForm.include(salePaymentMixin);
    manageForm.include(salePaymentMixin);

});
