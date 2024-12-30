verp.define('website.tour.automatic_editor', function (require) {
'use strict';

const tour = require('web_tour.tour');

tour.register('automatic_editor_on_new_website', {
    test: true,
    url: '/',
},
[
    {
        content: "Select the language dropdown",
        trigger: '.js-language-selector .dropdown-toggle'
    },
    {
        content: "click on Add a language",
        trigger: 'a.o-add-language',
    },
    {
        content: "Select dropdown",
        trigger: 'select[name=lang]',
        run: () => {
            $('select[name="lang"]').val('"pa_GB"').change();
        }
    },
    {
        content: "load parseltongue",
        extraTrigger: '.modal select[name="lang"]:propValueContains(pa_GB)',
        trigger: '.modal-footer button:first',
    },
    {
        content: "Select the language dropdown",
        trigger: '.js-language-selector .dropdown-toggle',
    },
    {
        content: "Select parseltongue",
        trigger: 'a.js-change-lang[data-urlCode=pa_GB]',
    },
    {
        content: "Check that we're on parseltongue and then go to settings",
        trigger: 'html[lang=pa-GB]',
        run: () => {
            // Now go through the settings for a new website. A frontend_lang
            // cookie was set during previous steps. It should not be used when
            // redirecting to the frontend in the following steps.
            window.location.href = '/web#action=website.actionWebsiteConfiguration';
        }
    },
    {
        content: "create a new website",
        trigger: 'button[name="actionWebsiteCreateNew"]',
    },
    {
        content: "insert website name",
        trigger: 'input[name="label"]',
        run: 'text Website EN'
    },
    {
        content: "validate the website creation modal",
        trigger: 'button.btn-primary'
    },
    {
        content: "skip configurator",
        // This trigger targets the skip button, it doesn't have a more
        // explicit class or ID.
        trigger: '.o-configurator-container .container-fluid .btn.btn-link'
    },
    {
        content: "make hover button appear",
        trigger: '.o-theme-preview',
        run: () => {
            $('.o-theme-preview .o-button-area').attr('style', 'visibility: visible; opacity: 1;');
        },
    },
    {
        content: "Install a theme",
        trigger: 'button[data-name="buttonChooseTheme"]'
    },
    {
        content: "Check that the editor is loaded",
        trigger: 'body.editor-enable',
        timeout: 30000,
        run: () => null, // it's a check
    },
    {
        content: "exit edit mode",
        trigger: '.o-we-website-top-actions button.btn-primary:contains("Save")',
    },
    {
        content: "wait for editor to close",
        trigger: 'body:not(.editor-enable)',
        run: () => null, // It's a check
    }
]);
});
