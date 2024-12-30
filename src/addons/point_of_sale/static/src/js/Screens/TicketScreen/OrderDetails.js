verp.define('point_of_sale.OrderDetails', function (require) {
    'use strict';

    const PosComponent = require('point_of_sale.PosComponent');
    const Registries = require('point_of_sale.Registries');

    /**
     * @props {models.Order} order
     */
    class OrderDetails extends PosComponent {
        get order() {
            return this.props.order;
        }
        get orderlines() {
            return this.order ? this.order.orderlines.models : [];
        }
        get total() {
            return this.env.pos.formatCurrency(this.order ? this.order.getTotalWithTax() : 0);
        }
        get tax() {
            return this.env.pos.formatCurrency(this.order ? this.order.getTotalTax() : 0)
        }
    }
    OrderDetails.template = 'OrderDetails';

    Registries.Component.add(OrderDetails);

    return OrderDetails;
});
