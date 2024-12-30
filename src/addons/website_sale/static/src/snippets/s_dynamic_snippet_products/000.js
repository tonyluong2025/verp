verp.define('website_sale.sDynamicSnippetProducts', function (require) {
'use strict';

const config = require('web.config');
const core = require('web.core');
const publicWidget = require('web.public.widget');
const DynamicSnippetCarousel = require('website.sDynamicSnippetCarousel');
var wSaleUtils = require('website_sale.utils');

const DynamicSnippetProducts = DynamicSnippetCarousel.extend({
    selector: '.s-dynamic-snippet-products',
    readEvents: {
        'click .js-add-cart': '_onAddToCart',
        'click .js-remove': '_onRemoveFromRecentlyViewed',
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * Method to be overridden in child components in order to provide a search
     * domain if needed.
     * @override
     * @private
     */
    _getSearchDomain: function () {
        const searchDomain = this._super.apply(this, arguments);
        let productCategoryId = this.$el.get(0).dataset.productCategoryId;
        if (productCategoryId && productCategoryId !== 'all') {
            if (productCategoryId === 'current') {
                productCategoryId = undefined;
                const productCategoryField = $("#productDetails").find(".product-category-id");
                if (productCategoryField && productCategoryField.length) {
                    productCategoryId = parseInt(productCategoryField[0].value);
                }
                if (!productCategoryId) {
                    this.triggerUp('mainObjectRequest', {
                        callback: function (value) {
                            if (value.model === "product.public.category") {
                                productCategoryId = value.id;
                            }
                        },
                    });
                }
                if (!productCategoryId) {
                    // Try with categories from product, unfortunately the category hierarchy is not matched with this approach
                    const productTemplateId = $("#productDetails").find(".product-template-id");
                    if (productTemplateId && productTemplateId.length) {
                        searchDomain.push(['publicCategIds.productTemplateIds', '=', parseInt(productTemplateId[0].value)]);
                    }
                }
            }
            if (productCategoryId) {
                searchDomain.push(['publicCategIds', 'childOf', parseInt(productCategoryId)]);
            }
        }
        const productNames = this.$el.get(0).dataset.productNames;
        if (productNames) {
            const nameDomain = [];
            for (const productName of productNames.split(',')) {
                if (nameDomain.length) {
                    nameDomain.unshift('|');
                }
                nameDomain.push(['label', 'ilike', productName]);
            }
            searchDomain.push(...nameDomain);
        }
        return searchDomain;
    },
    /**
     * @override
     */
    _getRpcParameters: function () {
        const productTemplateId = $("#productDetails").find(".product-template-id");
        return Object.assign(this._super.apply(this, arguments), {
            productTemplateId: productTemplateId && productTemplateId.length ? productTemplateId[0].value : undefined,
        });
    },
    /**
     * Add product to cart and reload the carousel.
     * @private
     * @param {Event} ev
     */
    _onAddToCart: function (ev) {
        var self = this;
        var $card = $(ev.currentTarget).closest('.card');
        this._rpc({
            route: "/shop/cart/updateJson",
            params: {
                productId: $card.find('input[data-product-id]').data('product-id'),
                addQty: 1
            },
        }).then(function (data) {
            var $navButton = $('header .o-wsale-my-cart').first();
            var fetch = self._fetchData();
            var animation = wSaleUtils.animateClone($navButton, $(ev.currentTarget).parents('.card'), 25, 40);
            Promise.all([fetch, animation]).then(function (values) {
                wSaleUtils.updateCartNavBar(data);
                if (self.add2cartRerender) {
                     self._render();
                }
            });
        });
    },
    /**
     * @override 
     * @private
     */
    _renderContent() {
        this._super(...arguments);
        this.add2cartRerender = !!this.el.querySelector('[data-add2cart-rerender="True"]');
    },
    /**
     * Remove product from recently viewed products.
     * @private
     * @param {Event} ev
     */
    _onRemoveFromRecentlyViewed: function (ev) {
        var self = this;
        var $card = $(ev.currentTarget).closest('.card');
        this._rpc({
            route: "/shop/products/recentlyViewedDelete",
            params: {
                productId: $card.find('input[data-product-id]').data('product-id'),
            },
        }).then(function (data) {
            self._fetchData().then(() => self._render());
        });
    },

});
publicWidget.registry.dynamicSnippetProducts = DynamicSnippetProducts;

return DynamicSnippetProducts;
});
