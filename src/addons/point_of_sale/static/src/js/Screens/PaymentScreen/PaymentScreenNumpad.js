verp.define('point_of_sale.PaymentScreenNumpad', function(require) {
    'use strict';

    const PosComponent = require('point_of_sale.PosComponent');
    const Registries = require('point_of_sale.Registries');

    class PaymentScreenNumpad extends PosComponent {
        constructor() {
            super(...arguments);
            this.decimalPoint = this.env._t.database.parameters.decimalPoint;
        }
    }
    PaymentScreenNumpad.template = 'PaymentScreenNumpad';

    Registries.Component.add(PaymentScreenNumpad);

    return PaymentScreenNumpad;
});
