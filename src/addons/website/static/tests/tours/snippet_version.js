verp.define("website.tour.snippetVersion", function (require) {
"use strict";

var tour = require("web_tour.tour");

tour.register("snippetVersion", {
    test: true,
    url: "/",
}, [{
    content: "Enter edit mode",
    trigger: 'a[data-action=edit]',
}, {
    content: "Drop sTestSnip snippet",
    trigger: '#oeSnippets .oe-snippet:has(.s-test-snip) .oe-snippet-thumbnail',
    run: "dragAndDrop #wrap",
}, {
    content: "Drop sTextImage snippet",
    trigger: '#oeSnippets .oe-snippet:has(.s-text-image) .oe-snippet-thumbnail:not(.o-we-already-dragging)',
    run: "dragAndDrop #wrap",
}, {
    content: "Test t-snippet and t-snippet-call: snippets have data-snippet set",
    trigger: '#oeSnippets .o-panel-body > .oe-snippet.ui-draggable',
    run: function () {
        // Tests done here as all these are not visible on the page
        const draggableSnippets = document.querySelectorAll('#oeSnippets .o-panel-body > .oe-snippet.ui-draggable > :nth-child(2)');
        if (![...draggableSnippets].every(el => el.dataset.snippet)) {
            console.error("error Some t-snippet are missing their template name");
        }
        if (!document.querySelector('#oeSnippets [data-snippet="sTestSnip"] [data-snippet="sShare"]')) {
            console.error("error sShare t-called inside sTestSnip is missing template name");
        }
        if (!document.querySelector('#wrap [data-snippet="sTestSnip"] [data-snippet="sShare"]')) {
            console.error("error Dropped a sTestSnip snippet but missing sShare template name in it");
        }
    },
}, {
    content: "Enter edit mode",
    trigger: 'button[data-action="save"]',
}, {
    content: "Enter edit mode",
    extraTrigger: 'body:not(.editor-enable)',
    trigger: 'a[data-action=edit]',
}, {
    content: "Modify the version of snippets",
    trigger: '#oeSnippets .o-panel-body > .oe-snippet',
    run: function () {
        document.querySelector('#oeSnippets .oe-snippet > [data-snippet="sTestSnip"]').dataset.vjs = '999';
        document.querySelector('#oeSnippets .oe-snippet > [data-snippet="sShare"]').dataset.vcss = '999';
        document.querySelector('#oeSnippets .oe-snippet > [data-snippet="sTextImage"]').dataset.vxml = '999';
    },
}, {
    content: "Edit sTestSnip",
    trigger: '#wrap.o-editable .s-test-snip',
}, {
    content: "Edit textImage",
    extraTrigger: 'we-customizeblock-options:contains(Test snip) .snippet-option-VersionControl > we-alert',
    trigger: '#wrap.o-editable .s-text-image',
}, {
    content: "Edit sShare",
    extraTrigger: 'we-customizeblock-options:contains(Text - Image) .snippet-option-VersionControl  > we-alert',
    trigger: '#wrap.o-editable .s-share',
}, {
    content: "sShare is outdated",
    extraTrigger: 'we-customizeblock-options:contains(Share) .snippet-option-VersionControl > we-alert',
    trigger: 'body',
}]);
});
