verp.define('sale_management.saleManagement', function (require) {
'use strict';

var publicWidget = require('web.public.widget');

publicWidget.registry.SaleUpdateLineButton = publicWidget.Widget.extend({
    selector: '.o-portal-sale-sidebar',
    events: {
        'click a.js-update-line-json': '_onClick',
        'click a.js-add-optional-products': '_onClickOptionalProduct',
        'change .js-quantity': '_onChangeQuantity'
    },
    /**
     * @override
     */
    async start() {
        await this._super(...arguments);
        this.orderDetail = this.$el.find('table#salesOrderTable').data();
    },
    /**
     * Process the change in line quantity
     *
     * @private
     * @param {Event} ev
     */
    _onChangeQuantity(ev) {
        ev.preventDefault();
        let self = this,
            $target = $(ev.currentTarget),
            quantity = parseInt($target.val());

        this._callUpdateLineRoute(self.orderDetail.orderId, {
            'lineId': $target.data('lineId'),
            'inputQuantity': quantity >= 0 ? quantity : false,
            'accessToken': self.orderDetail.token
        }).then((data) => {
            window.location.reload();
        });
    },
    /**
     * Reacts to the click on the -/+ buttons
     *
     * @param {Event} ev
     */
    _onClick(ev) {
        ev.preventDefault();
        let self = this,
            $target = $(ev.currentTarget);
        this._callUpdateLineRoute(self.orderDetail.orderId, {
            'lineId': $target.data('lineId'),
            'remove': $target.data('remove'),
            'unlink': $target.data('unlink'),
            'accessToken': self.orderDetail.token
        }).then((data) => {
            window.location.reload();
        });
    },
    /**
     * trigger when optional product added to order from portal.
     *
     * @private
     * @param {Event} ev
     */
    _onClickOptionalProduct(ev) {
        ev.preventDefault();
        let self = this,
            $target = $(ev.currentTarget);
        // to avoid double click on link with href.
        $target.css('pointer-events', 'none');

        this._rpc({
            route: "/my/orders/" + self.orderDetail.orderId + "/addOption/" + $target.data('optionId'),
            params: {accessToken: self.orderDetail.token}
        }).then((data) => {
            window.location.reload();
        });
    },
    /**
     * Calls the route to get updated values of the line and order
     * when the quantity of a product has changed
     *
     * @private
     * @param {integer} orderId
     * @param {Object} params
     * @return {Deferred}
     */
    _callUpdateLineRoute(orderId, params) {
        return this._rpc({
            route: "/my/orders/" + orderId + "/updateLineDict",
            params: params,
        });
    },
});
});
