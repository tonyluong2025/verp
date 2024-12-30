verp.define("website.tour.snippet_empty_parent_autoremove", function (require) {
"use strict";

const tour = require('web_tour.tour');
const wTourUtils = require('website.tourUtils');

function removeSelectedBlock() {
    return {
        content: "Remove selected block",
        trigger: '#oeSnippets we-customizeblock-options:nth-last-child(3) .oe-snippet-remove',
    };
}

tour.register('snippet_empty_parent_autoremove', {
    test: true,
    url: '/?enable_editor=1',
}, [
    // Base case: remove both columns from text - image
    wTourUtils.dragNDrop({
        id: 'sTextImage',
        name: 'Text - Image',
    }),
    {
        content: "Click on second column",
        trigger: '#wrap .s-text-image .row > :nth-child(2)',
    },
    removeSelectedBlock(),
    {
        content: "Click on first column",
        trigger: '#wrap .s-text-image .row > :first-child',
    },
    removeSelectedBlock(),
    {
        content: "Check that #wrap is empty",
        trigger: '#wrap:empty',
    },

    // Banner: test that parallax, bg-filter and shape are not treated as content
    wTourUtils.dragNDrop({
        id: 'sBanner',
        name: 'Banner',
    }),
    wTourUtils.clickOnSnippet({
        id: 'sBanner',
        name: 'Banner',
    }),
    {
        content: "Check that parallax is present",
        trigger: '#wrap .s-banner .s-parallax-bg',
        run: () => null,
    },
    wTourUtils.changeOption('ColoredLevelBackground', 'Shape'),
    {
        content: "Check that shape is present",
        trigger: '#wrap .s-banner .o-we-shape',
        run: () => null,
    },
    {
        content: "Click on first column",
        trigger: '#wrap .s-banner .row > :first-child',
    },
    removeSelectedBlock(),
    {
        content: "Check that #wrap is empty",
        trigger: '#wrap:empty',
        run: () => null,
    },
]);
});
