verp.define('point_of_sale.PaymentScreenStatus', function(require) {
    'use strict';

    const PosComponent = require('point_of_sale.PosComponent');
    const Registries = require('point_of_sale.Registries');

    class PaymentScreenStatus extends PosComponent {
        get changeText() {
            return this.env.pos.formatCurrency(this.currentOrder.getChange());
        }
        get totalDueText() {
            return this.env.pos.formatCurrency(
                this.currentOrder.getTotalWithTax() + this.currentOrder.getRoundingApplied()
            );
        }
        get remainingText() {
            return this.env.pos.formatCurrency(
                this.currentOrder.getDue() > 0 ? this.currentOrder.getDue() : 0
            );
        }
        get currentOrder() {
            return this.env.pos.getOrder();
        }
    }
    PaymentScreenStatus.template = 'PaymentScreenStatus';

    Registries.Component.add(PaymentScreenStatus);

    return PaymentScreenStatus;
});
