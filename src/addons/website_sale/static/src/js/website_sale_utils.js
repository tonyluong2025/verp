verp.define('website_sale.utils', function (require) {
'use strict';

const wUtils = require('website.utils');

const cartHandlerMixin = {
    getRedirectOption() {
        const html = document.documentElement;
        this.stayOnPageOption = html.dataset.add2cartRedirect !== '0';
    },
    getCartHandlerOptions(ev) {
        this.isBuyNow = ev.currentTarget.classList.contains('o-we-buy-now');
        const targetSelector = ev.currentTarget.dataset.animationSelector || 'img';
        this.$itemImgContainer = this.$(ev.currentTarget).closest(`:has(${targetSelector})`);
    },
    /**
     * Used to add product depending on stayOnPageOption value.
     */
    addToCart(params) {
        if (this.isBuyNow) {
            params.express = true;
        } else if (this.stayOnPageOption) {
            return this._addToCartInPage(params);
        }
        return wUtils.sendRequest('/shop/cart/update', params);
    },
    /**
     * @private
     */
    _addToCartInPage(params) {
        params.forceCreate = true;
        return this._rpc({
            route: "/shop/cart/updateJson",
            params: params,
        }).then(async data => {
            if (data.cartQuantity && (data.cartQuantity !== parseInt($(".my-cart-quantity").text()))) {
                await animateClone($('header .o-wsale-my-cart').first(), this.$itemImgContainer, 25, 40);
                updateCartNavBar(data);
            }
        });
    },
};

function animateClone($cart, $elem, offsetTop, offsetLeft) {
    if (!$cart.length) {
        return Promise.resolve();
    }
    $cart.find('.o-animate-blink').addClass('o-red-highlight o-shadow-animation').delay(500).queue(function () {
        $(this).removeClass("o-shadow-animation").dequeue();
    }).delay(2000).queue(function () {
        $(this).removeClass("o-red-highlight").dequeue();
    });
    return new Promise(function (resolve, reject) {
        var $imgtodrag = $elem.find('img').eq(0);
        if ($imgtodrag.length) {
            var $imgclone = $imgtodrag.clone()
                .offset({
                    top: $imgtodrag.offset().top,
                    left: $imgtodrag.offset().left
                })
                .removeClass()
                .addClass('o-website-sale-animate')
                .appendTo(document.body)
                .css({
                    // Keep the same size on cloned img.
                    width: $imgtodrag.width(),
                    height: $imgtodrag.height(),
                })
                .animate({
                    top: $cart.offset().top + offsetTop,
                    left: $cart.offset().left + offsetLeft,
                    width: 75,
                    height: 75,
                }, 1000, 'easeInOutExpo');

            $imgclone.animate({
                width: 0,
                height: 0,
            }, function () {
                resolve();
                $(this).detach();
            });
        } else {
            resolve();
        }
    });
}

/**
 * Updates both navbar cart
 * @param {Object} data
 */
function updateCartNavBar(data) {
    $(".my-cart-quantity")
        .parents('li.o-wsale-my-cart').removeClass('d-none').end()
        .addClass('o-mycart-zoom-animation').delay(300)
        .queue(function () {
            $(this)
                .toggleClass('fa fa-warning', !data.cartQuantity)
                .attr('title', data.warning)
                .text(data.cartQuantity || '')
                .removeClass('o-mycart-zoom-animation')
                .dequeue();
        });

    $(".js-cart-lines").first().before(data['website_sale.cartLines']).end().remove();
    $(".js-cart-summary").first().before(data['website_sale.shortCartSummary']).end().remove();
}

/**
 * Displays `message` in an alert box at the top of the page if it's a
 * non-empty string.
 *
 * @param {string | null} message
 */
function showWarning(message) {
    if (!message) {
        return;
    }
    var $page = $('.oe-website-sale');
    var cartAlert = $page.children('#data_warning');
    if (!cartAlert.length) {
        cartAlert = $(
            '<div class="alert alert-danger alert-dismissible" role="alert" id="dataWarning">' +
                '<button type="button" class="close" data-dismiss="alert">&times;</button> ' +
                '<span></span>' +
            '</div>').prependTo($page);
    }
    cartAlert.children('span:last-child').text(message);
}

return {
    animateClone: animateClone,
    updateCartNavBar: updateCartNavBar,
    cartHandlerMixin: cartHandlerMixin,
    showWarning: showWarning,
};
});
