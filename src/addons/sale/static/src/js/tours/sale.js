verp.define('sale.tour', function(require) {
"use strict";

const {_t} = require('web.core');
const {Markup} = require('web.utils');
var tour = require('web_tour.tour');

tour.register("sale_tour", {
    url: "/web",
    rainbowMan: false,
    sequence: 20,
}, [tour.stepUtils.showAppsMenuItem(), {
    trigger: ".o-app[data-menu-xmlid='sale.saleMenuRoot']",
    content: _t("Open Sales app to send your first quotation in a few clicks."),
    position: "right",
    edition: "community"
}, {
    trigger: ".o-app[data-menu-xmlid='sale.saleMenuRoot']",
    content: _t("Open Sales app to send your first quotation in a few clicks."),
    position: "bottom",
    edition: "enterprise"
}, {
    trigger: 'a.o-onboarding-step-action.btn[data-method=actionOpenBaseOnboardingCompany]',
    extraTrigger: ".o-sale-order",
    content: _t("Start by checking your company's data."),
    position: "bottom",
}, {
    trigger: ".modal-content button[name='actionSaveOnboardingCompanyStep']",
    content: _t("Looks good. Let's continue."),
    position: "left",
}, {
    trigger: 'a.o-onboarding-step-action.btn[data-method=actionOpenBaseDocumentLayout]',
    extraTrigger: ".o-sale-order",
    content: _t("Customize your quotes and orders."),
    position: "bottom",
}, {
    trigger: "button[name='documentLayoutSave']",
    extraTrigger: ".o-sale-order",
    content: _t("Good job, let's continue."),
    position: "top", // dot NOT move to bottom, it would cause a resize flicker
}, {
    trigger: 'a.o-onboarding-step-action.btn[data-method=actionOpenSaleOnboardingPaymentAcquirer]',
    extraTrigger: ".o-sale-order",
    content: _t("To speed up order confirmation, we can activate electronic signatures or payments."),
    position: "bottom",
}, {
    trigger: "button[name='addPaymentMethods']",
    extraTrigger: ".o-sale-order",
    content: _t("Lets keep electronic signature for now."),
    position: "bottom",
}, {
    trigger: 'a.o-onboarding-step-action.btn[data-method=actionOpenSaleOnboardingSampleQuotation]',
    extraTrigger: ".o-sale-order",
    content: _t("Now, we'll create a sample quote."),
    position: "bottom",
}]);

tour.register("saleQuoteTour", {
        url: "/web#action=sale.actionQuotationsWithOnboarding&viewType=form",
        rainbowMan: true,
        rainbowManMessage: "<b>Congratulations</b>, your first quotation is sent!<br>Check your email to validate the quote.",
        sequence: 30,
    }, [{
        trigger: ".o-form-editable .o-field-many2one[name='partnerId']",
        extraTrigger: ".o-sale-order",
        content: _t("Write a company name to create one, or see suggestions."),
        position: "right",
        run: function (actions) {
            actions.text("Agrolait", this.$anchor.find("input"));
        },
    }, {
        trigger: ".ui-menu-item > a",
        auto: true,
        inModal: false,
    }, {
        trigger: ".o-field-x2many-list-row-add > a",
        extraTrigger: ".o-field-many2one[name='partnerId'] .o-external-button",
        content: _t("Click here to add some products or services to your quotation."),
        position: "bottom",
    }, {
        trigger: ".o-field-widget[name='productId'], .o-field-widget[name='productTemplateId']",
        extraTrigger: ".o-sale-order",
        content: _t("Select a product, or create a new one on the fly."),
        position: "right",
        run: function (actions) {
            var $input = this.$anchor.find("input");
            actions.text("DESK0001", $input.length === 0 ? this.$anchor : $input);
            // fake keydown to trigger search
            var keyDownEvent = jQuery.Event("keydown");
            keyDownEvent.which = 42;
            this.$anchor.trigger(keyDownEvent);
            var $descriptionElement = $(".o-form-editable textarea[name='name']");
            // when description changes, we know the product has been created
            $descriptionElement.change(function () {
                $descriptionElement.addClass("productCreationSuccess");
            });
        },
        id: "productSelectionStep"
    }, {
        trigger: ".ui-menu.ui-widget .ui-menu-item a:contains('DESK0001')",
        auto: true,
    }, {
        trigger: ".o-form-editable textarea[name='label'].productCreationSuccess",
        auto: true,
        run: function () {
        } // wait for product creation
    }, {
        trigger: ".o-field-widget[name='priceUnit'] ",
        extraTrigger: ".o-sale-order",
        content: Markup(_t("<b>Set a price</b>.")),
        position: "right",
        run: "text 10.0"
    },
    ...tour.stepUtils.statusbarButtonsSteps("Send by Email", Markup(_t("<b>Send the quote</b> to yourself and check what the customer will receive.")), ".o-statusbar-buttons button[name='actionQuotationSend']"),
    {
        trigger: ".modal-footer button.btn-primary",
        auto: true,
    }, {
        trigger: ".modal-footer button[name='actionSendMail']",
        extraTrigger: ".modal-footer button[name='actionSendMail']",
        content: _t("Let's send the quote."),
        position: "bottom",
    }]);

});
