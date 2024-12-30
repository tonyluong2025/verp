verp.define('account.tour', function(require) {
"use strict";

var core = require('web.core');
const {Markup} = require('web.utils');
var tour = require('web_tour.tour');

var _t = core._t;

tour.register('account_tour', {
    url: "/web",
    sequence: 60,
}, [
    ...tour.stepUtils.goToAppSteps('account.menu_finance', _t('Send invoices to your customers in no time with the <b>Invoicing app</b>.')),
    {
        trigger: "a.o-onboarding-step-action[data-method=actionOpenBaseOnboardingCompany]",
        content: _t("Start by checking your company's data."),
        position: "bottom",
    }, {
        trigger: "button[name=actionSaveOnboardingCompanyStep]",
        extraTrigger: "a.o-onboarding-step-action[data-method=actionOpenBaseOnboardingCompany]",
        content: _t("Looks good. Let's continue."),
        position: "left",
    }, {
        trigger: "a.o-onboarding-step-action[data-method=actionOpenBaseDocumentLayout]",
        content: _t("Customize your layout."),
        position: "bottom",
    }, {
        trigger: "button[name=documentLayoutSave]",
        extraTrigger: "a.o-onboarding-step-action[data-method=actionOpenBaseDocumentLayout]",
        content: _t("Once everything is as you want it, validate."),
        position: "left",
    }, {
        trigger: "a.o-onboarding-step-action[data-method=actionOpenAccountOnboardingCreateInvoice]",
        content: _t("Now, we'll create your first invoice."),
        position: "bottom",
    }, {
        trigger: "div[name=partnerId] input",
        extraTrigger: "[name=moveType][raw-value=outInvoice]",
        content: Markup(_t("Write a company name to <b>create one</b> or <b>see suggestions</b>.")),
        position: "right",
    }, {
        trigger: ".o-m2o-dropdown-option a:contains('Create')",
        extraTrigger: "[name=moveType][raw-value=outInvoice]",
        content: _t("Select first partner"),
        auto: true,
    }, {
        trigger: ".modal-content button.btn-primary",
        extraTrigger: "[name=moveType][raw-value=outInvoice]",
        content: Markup(_t("Once everything is set, you are good to continue. You will be able to edit this later in the <b>Customers</b> menu.")),
        auto: true,
    }, {
        trigger: "div[name=invoiceLineIds] .o-field-x2many-list-row-add a:not([data-context])",
        extraTrigger: "[name=moveType][raw-value=outInvoice]",
        content: _t("Add a line to your invoice"),
    }, {
        trigger: "div[name=invoiceLineIds] textarea[name=label]",
        extraTrigger: "[name=moveType][raw-value=outInvoice]",
        content: _t("Fill in the details of the line."),
        position: "bottom",
    }, {
        trigger: "div[name=invoiceLineIds] input[name=priceUnit]",
        extraTrigger: "[name=moveType][raw-value=outInvoice]",
        content: _t("Set a price"),
        position: "bottom",
        run: 'text 100',
    }, {
        trigger: "button[name=actionPost]",
        extraTrigger: "[name=moveType][raw-value=outInvoice]",
        content: _t("Once your invoice is ready, press CONFIRM."),
    }, {
        trigger: "button[name=actionInvoiceSent]",
        extraTrigger: "[name=moveType][raw-value=outInvoice]",
        content: _t("Send the invoice and check what the customer will receive."),
    }, {
        trigger: "input[name=email]",
        extraTrigger: "[name=moveType][raw-value=outInvoice]",
        content: Markup(_t("Write here <b>your own email address</b> to test the flow.")),
        run: 'text customer@example.com',
        auto: true,
    }, {
        trigger: ".modal-content button.btn-primary",
        extraTrigger: "[name=moveType][raw-value=outInvoice]",
        content: _t("Validate."),
        auto: true,
    }, {
        trigger: "button[name=sendAndPrintAction]",
        extraTrigger: "[name=moveType][raw-value=outInvoice]",
        content: _t("Let's send the invoice."),
        position: "left"
    }
]);

});
