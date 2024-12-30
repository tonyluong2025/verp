verp.define("website.tour.website_style_edition", function (require) {
"use strict";

const tour = require("web_tour.tour");

const TARGET_FONT_SIZE = 30;

tour.register("website_style_edition", {
    test: true,
    url: "/",
}, [{
    content: "Enter edit mode",
    trigger: 'a[data-action=edit]',
}, {
    content: "Go to theme options",
    trigger: '.o-we-customize-theme-btn',
}, {
    content: "Change font size",
    trigger: '[data-variable="font-size-base"] input',
    run: `textBlur ${TARGET_FONT_SIZE}`,
}, {
    content: "Save",
    trigger: '[data-action="save"]',
}, {
    content: "Check the font size was properly adapted",
    trigger: 'body:not(.editor-enable) #wrapwrap',
    run: function (actions) {
        const style = window.getComputedStyle(this.$anchor[0]);
        if (style.fontSize !== `${TARGET_FONT_SIZE}px`) {
            console.error(`Expected the font-size to be equal to ${TARGET_FONT_SIZE}px but found ${style.fontSize} instead`);
        }
    },
}]);
});
