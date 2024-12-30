verp.define("website_sale.tourShop", function (require) {
    "use strict";

    const {_t} = require("web.core");
    const {Markup} = require('web.utils');

    // return the steps, used for backend and frontend

    return [{
        trigger: "body:has(#oNewContentMenuChoices.o-hidden) #new-content-menu > a",
        content: _t("Let's create your first product."),
        extraTrigger: ".js-sale",
        consumeVisibleOnly: true,
        position: "bottom",
    }, {
        trigger: "a[data-action=newProduct]",
        content: Markup(_t("Select <b>New Product</b> to create it and manage its properties to boost your sales.")),
        position: "bottom",
    }, {
        trigger: ".modal-dialog #editorNewProduct input[type=text]",
        content: _t("Enter a name for your new product"),
        position: "left",
    }, {
        trigger: ".modal-footer button.btn-primary.btn-continue",
        content: Markup(_t("Click on <em>Continue</em> to create the product.")),
        position: "right",
    }, {
        trigger: ".product-price .oe-currency-value:visible",
        extraTrigger: ".editor-enable",
        content: _t("Edit the price of this product by clicking on the amount."),
        position: "bottom",
        run: "text 1.99",
    }, {
        trigger: "#wrap img.product-detail-img",
        extraTrigger: ".product-price .o-dirty .oe-currency-value:not(:containsExact(1.00))",
        content: _t("Double click here to set an image describing your product."),
        position: "top",
        run: function (actions) {
            actions.dblclick();
        },
    }, {
        trigger: ".o-select-media-dialog .o-upload-media-button",
        content: _t("Upload a file from your local library."),
        position: "bottom",
        run: function (actions) {
            actions.auto(".modal-footer .btn-secondary");
        },
        auto: true,
    }, {
        trigger: "button.o-we-add-snippet-btn",
        auto: true,
    }, {
        trigger: "#snippetStructure .oe-snippet:eq(3) .oe-snippet-thumbnail",
        extraTrigger: "body:not(.modal-open)",
        content: _t("Drag this website block and drop it in your page."),
        position: "bottom",
        run: "dragAndDrop",
    }, {
        trigger: "button[data-action=save]",
        content: Markup(_t("Once you click on <b>Save</b>, your product is updated.")),
        position: "bottom",
    }, {
        trigger: ".js-publish-management .js-publish-btn .css-publish",
        extraTrigger: "body:not(.editor-enable)",
        content: _t("Click on this button so your customers can see it."),
        position: "bottom",
    }, {
        trigger: ".o-main-navbar .o-menu-toggle, #oeApplications .dropdown-toggle",
        content: _t("Let's now take a look at your administration dashboard to get your eCommerce website ready in no time."),
        position: "bottom",
    }, { // backend
        trigger: '.o-apps > a[data-menu-xmlid="website.menuWebsiteConfiguration"], #oeMainMenuNavbar a[data-menu-xmlid="website.menuWebsiteConfiguration"]',
        content: _t("Open your website app here."),
        extraTrigger: ".o-apps,#oeApplications",
        position: "bottom",
        timeout: 30000, // ~ 10 secondes to be redirected, due to slow assets generation
    }];
});
