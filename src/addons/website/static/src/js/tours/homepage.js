verp.define("website.tour.homepage", function (require) {
"use strict";

const wTourUtils = require("website.tourUtils");

const snippets = [
    {
        id: 'sCover',
        name: 'Cover',
    },
    {
        id: 'sTextImage',
        name: 'Text - Image',
    },
    {
        id: 'sThreeColumns',
        name: 'Columns',
    },
    {
        id: 'sPicture',
        name: 'Picture',
    },
    {
        id: 'sQuotesCarousel',
        name: 'Quotes',
    },
    {
        id: 'sCallToAction',
        name: 'Call to Action',
    },
];

wTourUtils.registerThemeHomepageTour('homepage', [
    wTourUtils.dragNDrop(snippets[0]),
    wTourUtils.clickOnText(snippets[0], 'h1'),
    wTourUtils.goBackToBlocks(),
    wTourUtils.dragNDrop(snippets[1]),
    wTourUtils.dragNDrop(snippets[2]),
    wTourUtils.dragNDrop(snippets[3]),
    wTourUtils.dragNDrop(snippets[4]),
    wTourUtils.dragNDrop(snippets[5]),
    wTourUtils.clickOnSnippet(snippets[5], 'top'),
    wTourUtils.changeBackgroundColor(),
]);

});
