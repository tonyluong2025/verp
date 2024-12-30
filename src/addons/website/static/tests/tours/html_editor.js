/* global ace */
verp.define('website.test.htmlEditor', function (require) {
'use strict';

var tour = require('web_tour.tour');

const adminCssModif = '#wrap {display: none;}';
const demoCssModif = '// demo_edition';

tour.register('html_editor_multiple_templates', {
    test: true,
    url: '/generic',
},
    [
        // 1. Edit the page through Edit Mode, it will COW the view
        {
            content: "enter edit mode",
            trigger: 'a[data-action=edit]',
        },
        {
            content: "drop a snippet",
            trigger: '#oeSnippets .oe-snippet:has(.s_cover) .oe-snippet-thumbnail',
            // id starting by 'oe-structure..' will actually create an inherited view
            run: "dragAndDrop #oe_structure_test_ui",
        },
        {
            content: "save the page",
            extraTrigger: '#oe_structure_test_ui.o-dirty',
            trigger: "button[data-action=save]",
        },
        // 2. Edit generic view
        {
            content: "open customize menu",
            extraTrigger: "body:not(.editor-enable)",
            trigger: '#customizeMenu > a',
        },
        {
            content: "open html editor",
            trigger: '#htmlEditor',
        },
        {
            content: "add something in the generic view",
            trigger: 'div.ace-line .ace_xml:contains("Generic")',
            run: function () {
                ace.edit('ace-view-editor').getSession().insert({row: 3, column: 1}, '<p>somenewcontent</p>\n');
            },
        },
        // 3. Edit oe-structure specific view
        {
            content: "select oe-structure specific view",
            trigger: 'div.ace-line .ace_xml:contains("somenewcontent")',
            run: function () {
                var viewId = $('#ace-view-list option:contains("oe_structure_test_ui")').val();
                $('#ace-view-list').val(viewId).trigger('change');
            },
        },
        {
            content: "add something in the oe-structure specific view",
            extraTrigger: '#aceViewId:contains("test.generic_view_oe_structure_test_ui")', // If no xmlid it should show key
            trigger: 'div.ace-line .ace_xml:contains("s_cover")',
            run: function () {
                ace.edit('ace-view-editor').getSession().insert({row: 2, column: 1}, '<p>anothernewcontent</p>\n');
            },
        },
        {
            content: "save the html editor",
            extraTrigger: 'div.ace-line .ace_xml:contains("anothernewcontent")',
            trigger: ".o-ace-view-editor button[data-action=save]",
        },
        {
           content: "check that the page has both modification",
           extraTrigger: '#wrapwrap:contains("anothernewcontent")',
           trigger: '#wrapwrap:contains("somenewcontent")',
           run: function () {}, // it's a check
       },
    ]
);

tour.register('test_html_editor_scss', {
    test: true,
    url: '/contactus',
},
    [
        // 1. Open Html Editor and select a scss file
        {
            content: "open customize menu",
            extraTrigger: '#wrap:visible', // ensure state for later
            trigger: '#customizeMenu > a',
        },
        {
            content: "open html editor",
            trigger: '#htmlEditor',
        },
        {
            content: "open type switcher",
            trigger: '.o-ace-type-switcher button',
        },
        {
            content: "select scss files",
            trigger: '.o_ace_type_switcher_choice[data-type="scss"]',
        },
        {
            content: "select 'user_custom_rules'",
            trigger: 'body:has(#ace-scss-list option:contains("user_custom_rules"))',
            run: function () {
                var scssId = $('#ace-scss-list option:contains("user_custom_rules")').val();
                $('#ace-scss-list').val(scssId).trigger('change');
            },
        },
        // 2. Edit that file and ensure it was saved then reset it
        {
            content: "add some scss content in the file",
            trigger: 'div.ace-line .ace_comment:contains("footer {")',
            run: function () {
                ace.edit('ace-view-editor').getSession().insert({row: 2, column: 0}, `${adminCssModif}\n`);
            },
        },
        {
            content: "save the html editor",
            extraTrigger: `div.ace-line:contains("${adminCssModif}")`,
            trigger: ".o-ace-view-editor button[data-action=save]",
        },
         {
            content: "check that the scss modification got applied",
            trigger: 'body:has(#wrap:hidden)',
            run: function () {}, // it's a check
            timeout: 30000, // SCSS compilation might take some time
        },
        {
            content: "reset view (after reload, html editor should have been reopened where it was)",
            trigger: '#aceViewId button[data-action="reset"]',
        },
        {
            content: "confirm reset warning",
            trigger: '.modal-footer .btn-primary',
        },
        {
            content: "check that the scss file was reset correctly, wrap content should now be visible again",
            trigger: '#wrap:visible',
            run: function () {}, // it's a check
            timeout: 30000, // SCSS compilation might take some time
        },
        // 3. Customize again that file (will be used in second part of the test
        //    to ensure restricted user can still use the HTML Editor)
        {
            content: "add some scss content in the file",
            trigger: 'div.ace-line .ace_comment:contains("footer {")',
            run: function () {
                ace.edit('ace-view-editor').getSession().insert({row: 2, column: 0}, `${adminCssModif}\n`);
            },
        },
        {
            content: "save the html editor",
            extraTrigger: `div.ace-line:contains("${adminCssModif}")`,
            trigger: '.o-ace-view-editor button[data-action=save]',
        },
        {
            content: "check that the scss modification got applied",
            trigger: 'body:has(#wrap:hidden)',
            run: function () {
                window.location.href = '/web/session/logout?redirect=/web/login';
            },
            timeout: 30000, // SCSS compilation might take some time
        },

        // This part of the test ensures that a restricted user can still use
        // the HTML Editor if someone else made a customization previously.

        {
            content: "Submit login",
            trigger: '.oe-login-form',
            run: function () {
                $('.oe-login-form input[name="login"]').val("demo");
                $('.oe-login-form input[name="password"]').val("demo");
                $('.oe-login-form input[name="redirect"]').val("/");
                $('.oe-login-form').submit();
            },
        },
        // 4. Open Html Editor and select a scss file
        {
            content: "open customize menu",
            trigger: '#customizeMenu > a',
        },
        {
            content: "open html editor",
            trigger: '#htmlEditor',
        },
        {
            content: "open type switcher",
            trigger: '.o-ace-type-switcher button',
        },
        {
            content: "select scss files",
            trigger: '.o_ace_type_switcher_choice[data-type="scss"]',
        },
        {
            content: "select 'user_custom_rules'",
            trigger: 'body:has(#ace-scss-list option:contains("user_custom_rules"))',
            run: function () {
                var scssId = $('#ace-scss-list option:contains("user_custom_rules")').val();
                $('#ace-scss-list').val(scssId).trigger('change');
            },
        },
        // 5. Edit that file and ensure it was saved then reset it
        {
            content: "add some scss content in the file",
            trigger: `div.ace-line:contains("${adminCssModif}")`, // ensure the admin modification is here
            run: function () {
                ace.edit('ace-view-editor').getSession().insert({row: 2, column: 0}, `${demoCssModif}\n`);
            },
        },
        {
            content: "save the html editor",
            extraTrigger: `div.ace-line:contains("${demoCssModif}")`,
            trigger: ".o-ace-view-editor button[data-action=save]",
        },
        {
            content: "wait for reload",
            trigger: "body:not(:has(div.o-ace-view-editor))",
            run: function () {}, // it's a check
            timeout: 30000, // SCSS compilation might take some time
        },
        {
            content: "reset view (after reload, html editor should have been reopened where it was)",
            trigger: '#aceViewId button[data-action="reset"]',
        },
        {
            content: "confirm reset warning",
            trigger: '.modal-footer .btn-primary',
        },
        {
            content: "check that the scss file was reset correctly",
            extraTrigger: `body:not(:has(div.ace-line:contains("${adminCssModif}")))`,
            trigger: `body:not(:has(div.ace-line:contains("${demoCssModif}")))`,
            run: function () {}, // it's a check
            timeout: 30000, // SCSS compilation might take some time
        },
    ]
);

});
