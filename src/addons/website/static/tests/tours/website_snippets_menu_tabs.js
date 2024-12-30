/** @verp-module **/

import tour from 'web_tour.tour';
import wTourUtils from 'website.tourUtils';

tour.register("website_snippets_menu_tabs", {
    test: true,
    url: "/?enable_editor=1",
}, [
    wTourUtils.goToTheme(),
    {
        content: "Click on the empty 'DRAG BUILDING BLOCKS HERE' area.",
        extraTrigger: 'we-customizeblock-option.snippet-option-ThemeColors',
        trigger: 'main > .oe-structure.oe-empty',
        run: 'click',
    },
    wTourUtils.goToTheme(),
    {
        content: "Verify that the customize panel is not empty.",
        trigger: '.o-we-customize-panel > we-customizeblock-options',
        run: () => null, // it's a check
    },
    {
        content: "Click on the style tab.",
        trigger: '#snippetsMenu .o-we-customize_snippet_btn',
    },
    wTourUtils.goToTheme(),
    {
        content: "Verify that the customize panel is not empty.",
        trigger: '.o-we-customize-panel > we-customizeblock-options',
        run: () => null, // it's a check
    },
]);
