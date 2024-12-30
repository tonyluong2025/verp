verp.define('point_of_sale.MobileOrderWidget', function(require) {
    'use strict';

    const PosComponent = require('point_of_sale.PosComponent');
    const Registries = require('point_of_sale.Registries');

    class MobileOrderWidget extends PosComponent {
        constructor() {
            super(...arguments);
            this.update();
        }
        get order() {
            return this.env.pos.getOrder();
        }
        mounted() {
          this.order.on('change', () => {
              this.update();
              this.render();
          });
          this.order.orderlines.on('change', () => {
              this.update();
              this.render();
          });
        }
        update() {
            const total = this.order ? this.order.getTotalWithTax() : 0;
            const tax = this.order ? total - this.order.getTotalWithoutTax() : 0;
            this.total = this.env.pos.formatCurrency(total);
            this.itemsNumber = this.order ? this.order.orderlines.reduce((itemsNumber,line) => itemsNumber + line.quantity, 0) : 0;
        }
    }

    MobileOrderWidget.template = 'MobileOrderWidget';

    Registries.Component.add(MobileOrderWidget);

    return MobileOrderWidget;
});
