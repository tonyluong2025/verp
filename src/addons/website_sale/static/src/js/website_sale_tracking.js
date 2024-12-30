verp.define('website_sale.tracking', function (require) {

var publicWidget = require('web.public.widget');

publicWidget.registry.websiteSaleTracking = publicWidget.Widget.extend({
    selector: '.oe-website-sale',
    events: {
        'click form[action="/shop/cart/update"] a.a-submit': '_onAddProductIntoCart',
        'click a[href="/shop/checkout"]': '_onCheckoutStart',
        'click div.oe-cart a[href^="/web?redirect"][href$="/shop/checkout"]': '_onCustomerSignin',
        'click form[action="/shop/confirmOrder"] a.a-submit': '_onOrder',
        'click form[target="_self"] button[type=submit]': '_onOrderPayment',
        'viewItemEvent': '_onViewItem',
        'addToCartEvent': '_onAddToCart',
    },

    /**
     * @override
     */
    start: function () {
        var self = this;

        // ...
        const $confirmation = this.$('div.oe-website-sale-tx-status');
        if ($confirmation.length) {
            const orderID = $confirmation.data('order-id');
            const json = $confirmation.data('order-tracking-info');
            this._vpv('/stats/ecom/orderConfirmed/' + orderID);
            self._trackGA('event', 'purchase', json);
        }

        return this._super.apply(this, arguments);
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * @private
     */
    _trackGA: function () {
        const websiteGA = window.gtag || function () {};
        websiteGA.apply(this, arguments);
    },
    /**
     * @private
     */
    _vpv: function (page) { //virtual page view
        this._trackGA('event', 'pageView', {
            'pagePath': page,
        });
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * @private
     */
    _onViewItem(event, productTrackingInfo) {
        const trackingInfo = {
            'currency': productTrackingInfo['currency'],
            'value': productTrackingInfo['price'],
            'items': [productTrackingInfo],
        };
        this._trackGA('event', 'viewItem', trackingInfo);
    },

    /**
     * @private
     */
    _onAddToCart(event, ...productsTrackingInfo) {
        const trackingInfo = {
            'currency': productsTrackingInfo[0]['currency'],
            'value': productsTrackingInfo.reduce((acc, val) => acc + val['price'] * val['quantity'], 0),
            'items': productsTrackingInfo,
        };
        this._trackGA('event', 'addToCart', trackingInfo);
    },

    /**
     * @private
     */
    _onAddProductIntoCart: function () {
        var productID = this.$('input[name="productId"]').attr('value');
        this._vpv('/stats/ecom/productAddToCart/' + productID);
    },
    /**
     * @private
     */
    _onCheckoutStart: function () {
        this._vpv('/stats/ecom/customerCheckout');
    },
    /**
     * @private
     */
    _onCustomerSignin: function () {
        this._vpv('/stats/ecom/customerSignin');
    },
    /**
     * @private
     */
    _onOrder: function () {
        if ($('#topMenu [href="/web/login"]').length) {
            this._vpv('/stats/ecom/customerSignup');
        }
        this._vpv('/stats/ecom/orderCheckout');
    },
    /**
     * @private
     */
    _onOrderPayment: function () {
        var method = $('#paymentMethod input[name=acquirer]:checked').nextAll('span:first').text();
        this._vpv('/stats/ecom/orderPayment/' + method);
    },
});

return publicWidget.registry.websiteSaleTracking;

});
