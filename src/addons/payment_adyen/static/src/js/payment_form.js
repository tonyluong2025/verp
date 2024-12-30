/* global AdyenCheckout */
verp.define('payment_adyen.paymentForm', require => {
    'use strict';

    const core = require('web.core');
    const checkoutForm = require('payment.checkoutForm');
    const manageForm = require('payment.manageForm');

    const _t = core._t;

    const adyenMixin = {

        //--------------------------------------------------------------------------
        // Private
        //--------------------------------------------------------------------------

        /**
         * Handle the additional details event of the Adyen drop-in.
         *
         * @private
         * @param {object} state - The state of the drop-in
         * @param {object} dropin - The drop-in
         * @return {Promise}
         */
        _dropinOnAdditionalDetails: function (state, dropin) {
            return this._rpc({
                route: '/payment/adyen/paymentDetails',
                params: {
                    'acquirerId': dropin.acquirerId,
                    'reference': this.adyenDropin.reference,
                    'paymentDetails': state.data,
                },
            }).then(paymentDetails => {
                if (paymentDetails.action) { // Additional action required from the shopper
                    dropin.handleAction(paymentDetails.action);
                } else { // The payment reached a final state, redirect to the status page
                    window.location = '/payment/status';
                }
            }).guardedCatch((error) => {
                error.event.preventDefault();
                this._displayError(
                    _t("Server Error"),
                    _t("We are not able to process your payment."),
                    error.message.data.message
                );
            });
        },

        /**
         * Handle the error event of the Adyen drop-in.
         *
         * @private
         * @param {object} error - The error in the drop-in
         * @return {undefined}
         */
        _dropinOnError: function (error) {
            this._displayError(
                _t("Incorrect Payment Details"),
                _t("Please verify your payment details.")
            );
        },

        /**
         * Handle the submit event of the Adyen drop-in and initiate the payment.
         *
         * @private
         * @param {object} state - The state of the drop-in
         * @param {object} dropin - The drop-in
         * @return {Promise}
         */
        _dropinOnSubmit: function (state, dropin) {
            // Create the transaction and retrieve the processing values
            return this._rpc({
                route: this.txContext.transactionRoute,
                params: this._prepareTransactionRouteParams('adyen', dropin.acquirerId, 'direct'),
            }).then(processingValues => {
                this.adyenDropin.reference = processingValues.reference; // Store final reference
                // Initiate the payment
                return this._rpc({
                    route: '/payment/adyen/payments',
                    params: {
                        'acquirerId': dropin.acquirerId,
                        'reference': processingValues.reference,
                        'convertedAmount': processingValues.convertedAmount,
                        'currencyId': processingValues.currencyId,
                        'partnerId': processingValues.partnerId,
                        'paymentMethod': state.data.paymentMethod,
                        'accessToken': processingValues.accessToken,
                        'browserInfo': state.data.browserInfo,
                    },
                });
            }).then(paymentResponse => {
                if (paymentResponse.action) { // Additional action required from the shopper
                    this._hideInputs(); // Only the inputs of the inline form should be used
                    $('body').unblock(); // The page is blocked at this point, unblock it
                    dropin.handleAction(paymentResponse.action);
                } else { // The payment reached a final state, redirect to the status page
                    window.location = '/payment/status';
                }
            }).guardedCatch((error) => {
                error.event.preventDefault();
                this._displayError(
                    _t("Server Error"),
                    _t("We are not able to process your payment."),
                    error.message.data.message
                );
            });
        },

        /**
         * Prepare the inline form of Adyen for direct payment.
         *
         * @override method from payment.paymentFormMixin
         * @private
         * @param {string} provider - The provider of the selected payment option's acquirer
         * @param {number} paymentOptionId - The id of the selected payment option
         * @param {string} flow - The online payment flow of the selected payment option
         * @return {Promise}
         */
        _prepareInlineForm: function (provider, paymentOptionId, flow) {
            if (provider !== 'adyen') {
                return this._super(...arguments);
            }

            // Check if instantiation of the drop-in is needed
            if (flow === 'token') {
                return Promise.resolve(); // No drop-in for tokens
            } else if (this.adyenDropin && this.adyenDropin.acquirerId === paymentOptionId) {
                this._setPaymentFlow('direct'); // Overwrite the flow even if no re-instantiation
                return Promise.resolve(); // Don't re-instantiate if already done for this acquirer
            }

            // Overwrite the flow of the select payment option
            this._setPaymentFlow('direct');

            // Get public information on the acquirer (state, clientKey)
            return this._rpc({
                route: '/payment/adyen/acquirerInfo',
                params: {
                    'acquirerId': paymentOptionId,
                },
            }).then(acquirerInfo => {
                // Get the available payment methods
                return this._rpc({
                    route: '/payment/adyen/paymentMethods',
                    params: {
                        'acquirerId': paymentOptionId,
                        'partnerId': parseInt(this.txContext.partnerId),
                        'amount': this.txContext.amount
                            ? parseFloat(this.txContext.amount)
                            : undefined,
                        'currencyId': this.txContext.currencyId
                            ? parseInt(this.txContext.currencyId)
                            : undefined,
                    },
                }).then(paymentMethodsResult => {
                    // Instantiate the drop-in
                    const configuration = {
                        paymentMethodsResponse: paymentMethodsResult,
                        clientKey: acquirerInfo.clientKey,
                        locale: (this._getContext().lang || 'en-US').replace('_', '-'),
                        environment: acquirerInfo.state === 'enabled' ? 'live' : 'test',
                        onAdditionalDetails: this._dropinOnAdditionalDetails.bind(this),
                        onError: this._dropinOnError.bind(this),
                        onSubmit: this._dropinOnSubmit.bind(this),
                    };
                    const checkout = new AdyenCheckout(configuration);
                    this.adyenDropin = checkout.create(
                        'dropin', {
                            openFirstPaymentMethod: true,
                            openFirstStoredPaymentMethod: false,
                            showStoredPaymentMethods: false,
                            showPaymentMethods: true,
                            showPayButton: false,
                            setStatusAutomatically: true,
                            onSelect: component => {
                                if (component.props.name === "PayPal") {
                                    if (!this.paypalForm) {
                                        // create div element to render PayPal component
                                        this.paypalForm = document.createElement("div");
                                        document.getElementById(
                                            `oAdyenDropinContainer${paymentOptionId}`
                                        ).appendChild(this.paypalForm);
                                        this.paypalForm.classList.add("mt-2");
                                        // create and mount PayPal button in the component
                                        checkout.create("paypal",
                                            {
                                                style: {
                                                    disableMaxWidth: true
                                                },
                                                blockPayPalCreditButton: true,
                                                blockPayPalPayLaterButton: true
                                            }
                                        ).mount(this.paypalForm).acquirerId = paymentOptionId;
                                        this.txContext.tokenizationRequested = false;
                                    }
                                    // Hide Pay button and show PayPal component
                                    this._hideInputs();
                                    this.paypalForm.classList.remove('d-none');
                                } else if (this.paypalForm) {
                                    this.paypalForm.classList.add('d-none');
                                    this._showInputs();
                                }
                            },
                        }
                    ).mount(`#oAdyenDropinContainer${paymentOptionId}`);
                    this.adyenDropin.acquirerId = paymentOptionId;
                });
            }).guardedCatch((error) => {
                error.event.preventDefault();
                this._displayError(
                    _t("Server Error"),
                    _t("An error occurred when displayed this payment form."),
                    error.message.data.message
                );
            });
        },

        /**
         * Trigger the payment processing by submitting the drop-in.
         *
         * @override method from payment.paymentFormMixin
         * @private
         * @param {string} provider - The provider of the payment option's acquirer
         * @param {number} paymentOptionId - The id of the payment option handling the transaction
         * @param {string} flow - The online payment flow of the transaction
         * @return {Promise}
         */
        async _processPayment(provider, paymentOptionId, flow) {
            if (provider !== 'adyen' || flow === 'token') {
                return this._super(...arguments); // Tokens are handled by the generic flow
            }
            if (this.adyenDropin === undefined) { // The drop-in has not been properly instantiated
                this._displayError(
                    _t("Server Error"), _t("We are not able to process your payment.")
                );
            } else {
                return await this.adyenDropin.submit();
            }
        },

    };

    checkoutForm.include(adyenMixin);
    manageForm.include(adyenMixin);
});
