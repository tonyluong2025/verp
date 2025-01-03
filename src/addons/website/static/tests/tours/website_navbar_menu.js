verp.define("website.tour.website_navbar_menu", function (require) {
"use strict";

var tour = require("web_tour.tour");

tour.register("website_navbar_menu", {
    test: true,
    url: "/",
}, [
    {
        content: "Ensure menus are in DOM",
        trigger: '#topMenu .nav-item a:contains("Test Tour Menu")',
        run: function () {}, // it's a check
    }, {
        content: "Ensure menus loading is done (so they are actually visible)",
        trigger: 'body:not(:has(.o-menu-loading))',
        run: function () {}, // it's a check
    }
]);
});
