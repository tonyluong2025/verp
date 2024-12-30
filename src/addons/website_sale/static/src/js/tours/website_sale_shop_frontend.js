verp.define("website_sale.tourShopFrontend", function (require) {
"use strict";

var tour = require("web_tour.tour");
var steps = require("website_sale.tourShop");
tour.register("shop", {
    url: "/shop",
    sequence: 130,
}, steps);

});
