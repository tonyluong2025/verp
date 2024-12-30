verp.define('website_sale.recentlyViewed', function (require) {

var publicWidget = require('web.public.widget');
var utils = require('web.utils');

publicWidget.registry.productsRecentlyViewedUpdate = publicWidget.Widget.extend({
    selector: '#productDetail',
    events: {
        'change input.productId[name="productId"]': '_onProductChange',
    },
    debounceValue: 8000,

    /**
     * @constructor
     */
    init: function () {
        this._super.apply(this, arguments);
        this._onProductChange = _.debounce(this._onProductChange, this.debounceValue);
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * Debounced method that wait some time before marking the product as viewed.
     * @private
     * @param {HTMLInputElement} $input
     */
    _updateProductView: function ($input) {
        var productId = parseInt($input.val());
        var cookieName = 'seenProductId_' + productId;
        if (! parseInt(this.el.dataset.viewTrack, 10)) {
            return; // Is not tracked
        }
        if (utils.getCookie(cookieName)) {
            return; // Already tracked in the last 30min
        }
        if ($(this.el).find('.js-product.css-not-available').length) {
            return; // Variant not possible
        }
        this._rpc({
            route: '/shop/products/recentlyViewedUpdate',
            params: {
                productId: productId,
            }
        }).then(function (res) {
            if (res && res.visitorUuid) {
                utils.setCookie('visitorUuid', res.visitorUuid);
            }
            utils.setCookie(cookieName, productId, 30 * 60);
        });
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * Call debounced method when product change to reset timer.
     * @private
     * @param {Event} ev
     */
    _onProductChange: function (ev) {
        this._updateProductView($(ev.currentTarget));
    },
});
});
