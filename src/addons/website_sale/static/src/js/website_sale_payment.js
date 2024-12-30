verp.define('website_sale.payment', require => {
    'use strict';

    const checkoutForm = require('payment.checkoutForm');
    const publicWidget = require('web.public.widget');

    const websiteSalePaymentMixin = {

        /**
         * @override
         */
        init: function () {
            this._onClickTCCheckbox = _.debounce(this._onClickTCCheckbox, 100, true);
            this._super(...arguments);
        },

        /**
         * @override
         */
        start: function () {
            this.$checkbox = this.$('#checkboxTc');
            this.$submitButton = this.$('button[name="oPaymentSubmitButton"]');
            this._adaptConfirmButton();
            return this._super(...arguments);
        },

        //--------------------------------------------------------------------------
        // Private
        //--------------------------------------------------------------------------

        /**
         * Update the data on the submit button with the status of the Terms and Conditions input.
         *
         * @private
         * @return {undefined}
         */
        _adaptConfirmButton: function () {
            if (this.$checkbox.length > 0) {
                const disabledReasons = this.$submitButton.data('disabledReasons') || {};
                disabledReasons.tc = !this.$checkbox.prop('checked');
                this.$submitButton.data('disabledReasons', disabledReasons);
            }
        },

    };

    checkoutForm.include(Object.assign({}, websiteSalePaymentMixin, {
        events: Object.assign({}, checkoutForm.prototype.events, {
            'change #checkboxTc': '_onClickTCCheckbox',
        }),

        //----------------------------------------------------------------------
        // Private
        //----------------------------------------------------------------------

        /**
         * Verify that the Terms and Condition checkbox is checked.
         *
         * @override method from payment.paymentFormMixin
         * @private
         * @return {boolean} Whether the submit button can be enabled
         */
        _isButtonReady: function () {
            const disabledReasonFound = _.contains(
                this.$submitButton.data('disabledReasons'), true
            );
            return !disabledReasonFound && this._super();
        },

        //--------------------------------------------------------------------------
        // Handlers
        //--------------------------------------------------------------------------

        /**
         * Enable the submit button if it all conditions are met.
         *
         * @private
         * @return {undefined}
         */
        _onClickTCCheckbox: function () {
            this._adaptConfirmButton();

            if (!this._enableButton()) {
                this._disableButton(false);
            }
        },

    }));

    publicWidget.registry.WebsiteSalePayment = publicWidget.Widget.extend(
        Object.assign({}, websiteSalePaymentMixin, {
            selector: 'div[name="oWebsiteSaleFreeCart"]',
            events: {
                'change #checkboxTc': '_onClickTCCheckbox',
            },

            /**
             * @override
             */
            start: function () {
                this.$checkbox = this.$('#checkboxTc');
                this.$submitButton = this.$('button[name="oPaymentSubmitButton"]');
                this._onClickTCCheckbox();
                return this._super(...arguments);
            },

            //--------------------------------------------------------------------------
            // Handlers
            //--------------------------------------------------------------------------

            /**
             * Enable the submit button if it all conditions are met.
             *
             * @private
             * @return {undefined}
             */
            _onClickTCCheckbox: function () {
                this._adaptConfirmButton();

                const disabledReasonFound = _.contains(
                    this.$submitButton.data('disabledReasons'), true
                );
                this.$submitButton.prop('disabled', disabledReasonFound);
            },
        }));
});
