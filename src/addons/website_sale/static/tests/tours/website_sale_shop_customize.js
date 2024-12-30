verp.define('website_sale.tour_shop_customize', function (require) {
    'use strict';

    var tour = require("web_tour.tour");
    const tourUtils = require('website_sale.tour_utils');

    tour.register('shop_customize', {
        test: true,
        url: '/shop',
    },
        [
            {
                content: "open customize menu",
                trigger: '#customize-menu > a',
            },
            {
                content: "click on 'Attributes & Variants filters'",
                trigger: "#customize-menu label:contains(Attributes & Variants filters)",
            },
            {
                content: "select product attribute Steel",
                extraTrigger: 'body:not(:has(#customize-menu:visible .dropdown-menu:visible))',
                trigger: 'form.js-attributes input:not(:checked) + label:contains(Steel - Test)',
            },
            {
                content: "check the selection",
                trigger: 'form.js-attributes input:checked + label:contains(Steel - Test)',
                run: function () {}, // it's a check
            },
            {
                content: "select product",
                extraTrigger: 'body:not(:has(.oe-website-sale .oe_product_cart:eq(3)))',
                trigger: '.oe_product_cart a:contains("Test Product")',
            },
            {
                content: "open customize menu",
                trigger: '#customize-menu > a',
                extraTrigger: '#product_detail',
            },
            {
                content: "check page loaded after enable  variant group",
                trigger: '#customize-menu label:contains(List View of Variants)',
                run: function () {}, // it's a check
            },
            {
                content: "check list view of variants is disabled initially",
                trigger: 'body:not(:has(.js-product-change))',
                run: function () {},
            },
            {
                content: "click on 'List View of Variants'",
                trigger: "#customize-menu label:contains(List View of Variants)",
            },
            {
                content: "check page loaded after list of variant customization enabled",
                trigger: '.js-product-change',
                run: function () {}, // it's a check
            },
            {
                context: "check variant price",
                trigger: '.custom-radio:contains("Aluminium") .badge:contains("+") .oe-currency-value:contains("50.4")',
                run: function () {},
            },
            {
                content: "check price is 750",
                trigger: ".product_price .oe-price .oe-currency-value:containsExact(750.00)",
                run: function () {},
            },
            {
                content: "switch to another variant",
                trigger: ".js-product label:contains('Aluminium')",
            },
            {
                content: "verify that price has changed when changing variant",
                trigger: ".product_price .oe-price .oe-currency-value:containsExact(800.40)",
                run: function () {},
            },
            {
                content: "open customize menu",
                trigger: '#customize-menu > a',
            },
            {
                content: "remove 'List View of Variants'",
                trigger: "#customize-menu label:contains(List View of Variants):has(input:checked)",
            },
            {
                content: "check page loaded after list of variant customization disabled",
                trigger: ".js-product:not(:has(.js-product-change))",
                run: function () {}, // it's a check
            },
            {
                content: "check price is 750",
                trigger: ".product_price .oe-price .oe-currency-value:containsExact(750.00)",
                run: function () {},
            },
            {
                content: "switch to Aluminium variant",
                trigger: '.js-product input[data-value_name="Aluminium"]',
            },
            {
                content: "verify that price has changed when changing variant",
                trigger: ".product_price .oe-price .oe-currency-value:containsExact(800.40)",
                run: function () {}, // it's a check
            },
            {
                content: "switch back to Steel variant",
                trigger: ".js-product label:contains('Steel - Test')",
            },
            {
                content: "check price is 750",
                trigger: ".product_price .oe-price .oe-currency-value:containsExact(750.00)",
                run: function () {},
            },
            {
                content: "click on 'Add to Cart' button",
                trigger: "a:contains(ADD TO CART)",
            },
            {
                content: "check quantity",
                trigger: '.my_cart_quantity:containsExact(1),.o_extra_menu_items .fa-plus',
                run: function () {}, // it's a check
            },
                tourUtils.goToCart(),
            {
                content: "click on shop",
                trigger: "a:contains(Continue Shopping)",
                extraTrigger: 'body:not(:has(#products_grid_before .js-attributes))',
            },
            {
                content: "open customize menu bis",
                extraTrigger: '#products_grid_before .js-attributes',
                trigger: '#customize-menu > a',
            },
            {
                content: "remove 'Attributes & Variants filters'",
                trigger: "#customize-menu label:contains(Attributes & Variants filters):has(input:checked)",
            },
            {
                content: "finish",
                extraTrigger: 'body:not(:has(#products_grid_before .js-attributes))',
                trigger: '#wrap:not(:has(li:has(.my_cart_quantity):visible))',
                run: function () {}, // it's a check
            },
        ]
    );

    });
