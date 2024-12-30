verp.define('sale.productDiscount', function (require) {
    "use strict";

    const BasicFields = require('web.basicFields');
    const FieldsRegistry = require('web.fieldRegistry');

    /**
     * The sale.productDiscount widget is a simple widget extending FieldFloat
     *
     *
     * !!! WARNING !!!
     *
     * This widget is only designed for saleOrderLine creation/updates.
     * !!! It should only be used on a discount field !!!
     */
    const ProductDiscountWidget = BasicFields.FieldFloat.extend({

        /**
         * Override changes at a discount.
         *
         * @override
         * @param {VerpEvent} ev
         *
         */
        async reset(record, ev) {
            if (ev && ev.data.changes && ev.data.changes.discount >= 0) {
               this.triggerUp('openDiscountWizard');
            }
            this._super(...arguments);
        },
    });

    FieldsRegistry.add('productDiscount', ProductDiscountWidget);

    return ProductDiscountWidget;

});
