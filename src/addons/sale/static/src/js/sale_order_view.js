verp.define('sale.SaleOrderView', function (require) {
    "use strict";

    const FormController = require('web.FormController');
    const FormView = require('web.FormView');
    const viewRegistry = require('web.viewRegistry');
    const Dialog = require('web.Dialog');
    const core = require('web.core');
    const _t = core._t;

    const SaleOrderFormController = FormController.extend({
        customEvents: _.extend({}, FormController.prototype.customEvents, {
            openDiscountWizard: '_onOpenDiscountWizard',
        }),

        // -------------------------------------------------------------------------
        // Handlers
        // -------------------------------------------------------------------------

        /**
         * Handler called if user changes the discount field in the sale order line.
         * The wizard will open only if
         *  (1) Sale order line is 3 or more
         *  (2) First sale order line is changed to discount
         *  (3) Discount is the same in all sale order line
         */
        _onOpenDiscountWizard(ev) {
            const orderLines = this.renderer.state.data.orderLine.data.filter(line => !line.data.displayType);
            const recordData = ev.target.recordData;
            if (recordData.discount === orderLines[0].data.discount) return;
            const isEqualDiscount = orderLines.slice(1).every(line => line.data.discount === recordData.discount);
            if (orderLines.length >= 3 && recordData.sequence === orderLines[0].data.sequence && isEqualDiscount) {
                Dialog.confirm(this, _t("Do you want to apply this discount to all order lines?"), {
                    confirmCallback: () => {
                        orderLines.slice(1).forEach((line) => {
                            this.triggerUp('fieldChanged', {
                                dataPointID: this.renderer.state.id,
                                changes: {orderLine: {operation: "UPDATE", id: line.id, data: {discount: orderLines[0].data.discount}}},
                            });
                        });
                    },
                });
            }
        },
    });

    const SaleOrderView = FormView.extend({
        config: _.extend({}, FormView.prototype.config, {
            Controller: SaleOrderFormController,
        }),
    });

    viewRegistry.add('saleDiscountForm', SaleOrderView);

    return SaleOrderView;

});
