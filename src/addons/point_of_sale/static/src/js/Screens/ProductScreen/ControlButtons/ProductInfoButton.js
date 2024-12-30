verp.define('point_of_sale.ProductInfoButton', function(require) {
    'use strict';

    const PosComponent = require('point_of_sale.PosComponent');
    const ProductScreen = require('point_of_sale.ProductScreen');
    const { useListener } = require('web.customHooks');
    const Registries = require('point_of_sale.Registries');

    class ProductInfoButton extends PosComponent {
        constructor() {
            super(...arguments);
            useListener('click', this.onClick);
        }
        mounted() {
            this.env.pos.get('orders').on('add remove change', () => this.render(), this);
            this.env.pos.on('change:selectedOrder', () => this.render(), this);
        }
        willUnmount() {
            this.env.pos.get('orders').off('add remove change', null, this);
            this.env.pos.off('change:selectedOrder', null, this);
        }
        async onClick() {
            const orderline = this.env.pos.getOrder().getSelectedOrderline();
            if (orderline) {
                const product = orderline.getProduct();
                const quantity = orderline.getQuantity();
                const info = await this.env.pos.getProductInfo(product, quantity);
                this.showPopup('ProductInfoPopup', { info: info , product: product });
            }
        }
    }
    ProductInfoButton.template = 'ProductInfoButton';

    ProductScreen.addControlButton({
        component: ProductInfoButton,
        condition: () => true,
        position: ['before', 'SetFiscalPositionButton'],
    });

    Registries.Component.add(ProductInfoButton);

    return ProductInfoButton;
});
