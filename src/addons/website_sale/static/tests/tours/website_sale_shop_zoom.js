verp.define('website_sale.tour_shop_zoom', function (require) {
'use strict';

var tour = require('web_tour.tour');

var imageSelector = '#oCarouselProduct .carousel-item.active img';
var imageName = "A Colorful Image";
var nameGreen = "Forest Green";

// This tour relies on a data created from the javascript test.
tour.register('shop_zoom', {
    test: true,
    url: '/shop?search=' + imageName,
},
[
    {
        content: "select " + imageName,
        trigger: '.oe_product_cart a:containsExact("' + imageName + '")',
    },
    {
        content: "click on the image",
        trigger: imageSelector,
        run: 'clicknoleave',
    },
    {
        content: "check there is no zoom on that small image",
        trigger: 'body:not(:has(.zoomverp-flyout img))',
    },
    {
        content: "change variant",
        trigger: 'input[data-attribute_name="Beautiful Color"][data-value_name="' + nameGreen + '"]',
        run: 'click',
    },
    {
        content: "wait for variant to be loaded",
        trigger: '.oe-currency-value:contains("21.00")'
    },
    {
        content: "click on the image",
        trigger: imageSelector,
        run: 'clicknoleave',
    },
    {
        content: "check there is a zoom on that big image",
        trigger: '.zoomverp-flyout img',
    },
]);
});
