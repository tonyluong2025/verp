verp.define("website_sale.tourShopBackend", function (require) {
"use strict";

var tour = require("web_tour.tour");
var steps = require("website_sale.tourShop");
tour.register("shop", {url: "/shop"}, steps);

});
