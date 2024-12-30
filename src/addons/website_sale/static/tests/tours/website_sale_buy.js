verp.define('website_sale.tour', function (require) {
'use strict';

var tour = require("web_tour.tour");
const tourUtils = require('website_sale.tour_utils');

tour.register('shop_buy_product', {
    test: true,
    url: '/shop',
},
    [
        {
            content: "search conference chair",
            trigger: 'form input[name="search"]',
            run: "text conference chair",
        },
        {
            content: "search conference chair",
            trigger: 'form:has(input[name="search"]) .oe_search_button',
        },
        {
            content: "select conference chair",
            trigger: '.oe_product_cart:first a:contains("Conference Chair")',
        },
        {
            content: "select Conference Chair Aluminium",
            extraTrigger: '#product_detail',
            trigger: 'label:contains(Aluminium) input',
        },
        {
            content: "select Conference Chair Steel",
            extraTrigger: '#product_detail',
            trigger: 'label:contains(Steel) input',
        },
        {
            id: 'add_cart_step',
            content: "click on add to cart",
            extraTrigger: 'label:contains(Steel) input:propChecked',
            trigger: '#product_detail form[action^="/shop/cart/update"] #add_to_cart',
        },
            tourUtils.goToCart(),
        {
            content: "add suggested",
            extraTrigger: '#wrap:not(:has(#cart_products:contains("Storage Box")))',
            trigger: '.oe-cart:has(tr:contains("Storage Box")) a:contains("Add to Cart")',
        },
        {
            content: "add one more",
            extraTrigger: '#cart_products tr:contains("Storage Box")',
            trigger: '#cart_products tr:contains("Steel") a.js-add-cart-json:eq(1)',
        },
        {
            content: "remove Storage Box",
            extraTrigger: '#cart_products tr:contains("Steel") input.js-quantity:propValue(2)',
            trigger: '#cart_products tr:contains("Storage Box") a.js-add-cart-json:first',
        },
        {
            content: "set one",
            extraTrigger: '#wrap:not(:has(#cart_products tr:contains("Storage Box")))',
            trigger: '#cart_products input.js-quantity',
            run: 'text 1',
        },
        {
            content: "go to checkout",
            extraTrigger: '#cart_products input.js-quantity:propValue(1)',
            trigger: 'a[href*="/shop/checkout"]',
        },
        {
            content: "select payment",
            trigger: '#payment_method label:contains("Wire Transfer")',
        },
        {
            content: "Pay Now",
            //Either there are multiple payment methods, and one is checked, either there is only one, and therefore there are no radio inputs
            extraTrigger: '#payment_method label:contains("Wire Transfer") input:checked,#payment_method:not(:has("input:radio:visible"))',
            trigger: 'button[name="o_payment_submit_button"]:visible:not(:disabled)',
        },
        {
            content: "finish",
            trigger: '.oe-website-sale:contains("Please use the following transfer details")',
            // Leave /shop/confirmation to prevent RPC loop to /shop/payment/get_status.
            // The RPC could be handled in javascript while the tour is killed (and the session), leading to crashes
            run: function () {
                window.location.href = '/contactus'; // Redirect in JS to avoid the RPC loop (20x1sec)
            },
            timeout: 30000,
        },
        {
            content: "wait page loaded",
            trigger: 'h1:contains("Contact us")',
            run: function () {}, // it's a check
        },
    ]
);

});
