verp.define("website.tour.default_shape_gets_palette_colors", function (require) {
"use strict";

var tour = require("web_tour.tour");
const wTourUtils = require('website.tourUtils');

tour.register("default_shape_gets_palette_colors", {
    test: true,
    url: "/?enable_editor=1",
}, [
    wTourUtils.dragNDrop({
        id: 'sTextImage',
        name: 'Text - Image',
    }),
    wTourUtils.clickOnSnippet({
        id: 'sTextImage',
        name: 'Text - Image',
    }),
    wTourUtils.changeOption('ColoredLevelBackground', 'Shape'),
    {
        content: "Check that shape does not have a background-image in its inline style",
        trigger: '#wrap .s-text-image .o-we-shape',
        run: () => {
            const shape = $('#wrap .s-text-image .o-we-shape')[0];
            if (shape.style.backgroundImage) {
                console.error("error The default shape has a background-image in its inline style (should rely on the class)");
            }
        },
    },
]);
});
