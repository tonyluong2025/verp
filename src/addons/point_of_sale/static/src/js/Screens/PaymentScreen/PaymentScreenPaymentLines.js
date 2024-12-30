verp.define('point_of_sale.PaymentScreenPaymentLines', function(require) {
    'use strict';

    const PosComponent = require('point_of_sale.PosComponent');
    const Registries = require('point_of_sale.Registries');

    class PaymentScreenPaymentLines extends PosComponent {
        formatLineAmount(paymentline) {
            return this.env.pos.formatCurrencyNoSymbol(paymentline.getAmount());
        }
        selectedLineClass(line) {
            return { 'payment-terminal': line.getPaymentStatus() };
        }
        unselectedLineClass(line) {
            return {};
        }
    }
    PaymentScreenPaymentLines.template = 'PaymentScreenPaymentLines';

    Registries.Component.add(PaymentScreenPaymentLines);

    return PaymentScreenPaymentLines;
});
