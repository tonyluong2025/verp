/** @verp-module */

import tour from 'web_tour.tour';

tour.register('configurator_translation', {
    test: true,
    url: '/website/configurator',
},
[
    // Configurator first screen
    {
        content: "click next",
        trigger: 'button.o-configurator-show',
    },
    // Description screen
    {
        content: "select a website type",
        trigger: 'a.o_change_website_type',
    }, {
        content: "insert a website industry",
        trigger: '.o-configurator-industry input',
        run: 'text ab',
    }, {
        content: "select a website industry from the autocomplete",
        trigger: '.o-configurator-industry ul li a:contains(in fr)',
        extraTrigger: 'html[lang*=fr]',
    }, {
        content: "select an objective",
        trigger: '.o-configurator-purpose-dd a',
    }, {
        content: "choose from the objective list",
        trigger: 'a.o_change_website_purpose',
    },
    // Palette screen
    {
        content: "chose a palette card",
        trigger: '.palette-card',
    },
    // Features screen
    {
        content: "select confidentialité",
        trigger: '.card:contains(confidentialité)',
    }, {
        content: "Click on build my website",
        trigger: 'button.btn-primary',
    }, {
        content: "Loader should be shown",
        trigger: '.o-theme-install-loader-container',
        run: function () {}, // it's a check
    }, {
        content: "Wait untill the configurator is finished",
        trigger: 'body.editor-started',
        timeout: 30000,
    }, {
        content: "exit edit mode",
        trigger: '.o-we-website-top-actions button.btn-primary:contains("Sauver")',
    }, {
         content: "wait for editor to be closed",
         trigger: 'body:not(.editor-enable)',
         run: function () {}, // It's a check.
    }
]);
