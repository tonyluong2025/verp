verp.define('point_of_sale.OrderlineCustomerNoteButton', function(require) {
    'use strict';

    const PosComponent = require('point_of_sale.PosComponent');
    const ProductScreen = require('point_of_sale.ProductScreen');
    const { useListener } = require('web.customHooks');
    const Registries = require('point_of_sale.Registries');

    class OrderlineCustomerNoteButton extends PosComponent {
        constructor() {
            super(...arguments);
            useListener('click', this.onClick);
        }
        async onClick() {
            const selectedOrderline = this.env.pos.getOrder().getSelectedOrderline();
            if (!selectedOrderline) return;

            const { confirmed, payload: inputNote } = await this.showPopup('TextAreaPopup', {
                startingValue: selectedOrderline.getCustomerNote(),
                title: this.env._t('Add Customer Note'),
            });

            if (confirmed) {
                selectedOrderline.setCustomerNote(inputNote);
            }
        }
    }
    OrderlineCustomerNoteButton.template = 'OrderlineCustomerNoteButton';

    ProductScreen.addControlButton({
        component: OrderlineCustomerNoteButton,
        condition: function() {
            return this.env.pos.config.ifaceOrderlineCustomerNotes;
        },
    });

    Registries.Component.add(OrderlineCustomerNoteButton);

    return OrderlineCustomerNoteButton;
});
