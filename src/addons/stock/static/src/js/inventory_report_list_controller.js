verp.define('stock.InventoryReportListController', function (require) {
"use strict";

var ListController = require('web.ListController');

var InventoryReportListController = ListController.extend({
    buttonsTemplate: 'StockInventoryReport.Buttons',

    // -------------------------------------------------------------------------
    // Public
    // -------------------------------------------------------------------------

    init: function (parent, model, renderer, params) {
        this.context = renderer.state.getContext();
        return this._super.apply(this, arguments);
    },

    /**
     * @override
     */
    renderButtons: function ($node) {
        this._super.apply(this, arguments);
        if (this.context.noAtDate) {
            this.$buttons.find('button.o-button-at-date').hide();
        }
        this.$buttons.on('click', '.o-button-at-date', this._onOpenWizard.bind(this));
    },

    // -------------------------------------------------------------------------
    // Handlers
    // -------------------------------------------------------------------------

    /**
     * Handler called when the user clicked on the 'Inventory at Date' button.
     * Opens wizard to display, at choice, the products inventory or a computed
     * inventory at a given date.
     */
    _onOpenWizard: function () {
        var state = this.model.get(this.handle, {raw: true});
        var stateContext = state.getContext();
        var context = {
            activeModel: this.modelName,
        };
        if (stateContext.default_productId) {
            context.productId = stateContext.default_productId;
        } else if (stateContext.productTemplateId) {
            context.productTemplateId = stateContext.productTemplateId;
        }
        this.doAction({
            resModel: 'stock.quantity.history',
            views: [[false, 'form']],
            target: 'new',
            type: 'ir.actions.actwindow',
            context: context,
        });
    },
});

return InventoryReportListController;

});
