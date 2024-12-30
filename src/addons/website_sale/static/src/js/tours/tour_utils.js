verp.define("website_sale.tourUtils", function (require) {
    "use strict";
    
    const core = require("web.core");
    const _t = core._t;


    function goToCart(quantity = 1, position = "bottom") {
        return {
            content: _t("Go to cart"),
            trigger: `a:has(.my-cart-quantity:containsExact(${quantity}))`,
            position: position,
            run: "click",
        };
    }

    return {
        goToCart,
    };
});
