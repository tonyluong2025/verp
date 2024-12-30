/** @verp-module */

import tour from 'web_tour.tour';

tour.register("carousel_content_removal", {
    test: true,
    url: "/",
}, [{
    trigger: "a[data-action=edit]",
    content: "Click the Edit button.",
    extraTrigger: ".homepage",
}, {
    trigger: "#snippetStructure .oe-snippet:has(span:contains('Carousel')) .oe-snippet-thumbnail",
    content: "Drag the Carousel block and drop it in your page.",
    run: "dragAndDrop #wrap",
},
{
    trigger: ".carousel .carousel-item.active .carousel-content",
    content: "Select the active carousel item.",
}, {
    trigger: ".oe-overlay.oe-active .oe-snippet-remove",
    content: "Remove the active carousel item.",
},
{
    trigger: ".carousel .carousel-item.active .container:not(:has(*))",
    content: "Check for a carousel slide with an empty container tag",
    run: function () {},
}]);
