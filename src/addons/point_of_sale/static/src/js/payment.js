verp.define('point_of_sale.PaymentInterface', function (require) {
"use strict";

var core = require('web.core');

/**
 * Implement this interface to support a new payment method in the POS:
 *
 * var PaymentInterface = require('point_of_sale.PaymentInterface');
 * var MyPayment = PaymentInterface.extend({
 *     ...
 * })
 *
 * To connect the interface to the right payment methods register it:
 *
 * var models = require('point_of_sale.models');
 * models.registerPaymentMethod('myPayment', MyPayment);
 *
 * myPayment is the technical name of the added selection in
 * usePaymentTerminal.
 *
 * If necessary new fields can be loaded on any model:
 *
 * models.loadFields('pos.payment.method', ['newField1', 'newField2']);
 */
var PaymentInterface = core.Class.extend({
    init: function (pos, paymentMethod) {
        this.pos = pos;
        this.paymentMethod = paymentMethod;
        this.supportsReversals = false;
    },

    /**
     * Call this function to enable UI elements that allow a user to
     * reverse a payment. This requires that you implement
     * sendPaymentReversal.
     */
    enableReversals: function () {
        this.supportsReversals = true;
    },

    /**
     * Called when a user clicks the "Send" button in the
     * interface. This should initiate a payment request and return a
     * Promise that resolves when the final status of the payment line
     * is set with setPaymentStatus.
     *
     * For successful transactions setReceiptInfo() should be used
     * to set info that should to be printed on the receipt. You
     * should also set cardType and transactionId on the line for
     * successful transactions.
     *
     * @param {string} cid - The id of the paymentline
     * @returns {Promise} resolved with a boolean that is false when
     * the payment should be retried. Rejected when the status of the
     * paymentline will be manually updated.
     */
    sendPaymentRequest: function (cid) {},

    /**
     * Called when a user removes a payment line that's still waiting
     * on sendPaymentRequest to complete. Should execute some
     * request to ensure the current payment request is
     * cancelled. This is not to refund payments, only to cancel
     * them. The payment line being cancelled will be deleted
     * automatically after the returned promise resolves.
     *
     * @param {} order - The order of the paymentline
     * @param {string} cid - The id of the paymentline
     * @returns {Promise}
     */
    setndPaymentCancel: function (order, cid) {},

    /**
     * This is an optional method. When implementing this make sure to
     * call enableReversals() in the constructor of your
     * interface. This should reverse a previous payment with status
     * 'done'. The paymentline will be removed based on returned
     * Promise.
     *
     * @param {string} cid - The id of the paymentline
     * @returns {Promise} returns true if the reversal was successful.
     */
    sendPaymentReversal: function (cid) {},

    /**
     * Called when the payment screen in the POS is closed (by
     * e.g. clicking the "Back" button). Could be used to cancel in
     * progress payments.
     */
    close: function () {},
});

return PaymentInterface;
});
