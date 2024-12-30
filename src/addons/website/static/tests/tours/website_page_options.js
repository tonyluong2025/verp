/** @verp-module **/

import tour from 'web_tour.tour';
import wTourUtils from 'website.tourUtils';

tour.register("website_page_options", {
    test: true,
    url: "/?enable_editor=1",
}, [
    wTourUtils.clickOnSnippet({id: 'o-header-standard', name: 'Header'}),
    wTourUtils.changeOption('TopMenuVisibility', 'we-select:has([data-visibility]) we-toggler'),
    wTourUtils.changeOption('TopMenuVisibility', 'we-button[data-visibility="transparent"]'),
    // It's important to test saving right after changing that option only as
    // this is why this test was made in the first place: the page was not
    // marked as dirty when that option was the only one that was changed.
    ...wTourUtils.clickOnSave(),
    {
        content: "Check that the header is transparent",
        trigger: '#wrapwrap.o-header-overlay',
        run: () => null, // it's a check
    },
    wTourUtils.clickOnEdit(),
    wTourUtils.clickOnSnippet({id: 'o-header-standard', name: 'Header'}),
    wTourUtils.changeOption('topMenuColor', 'we-select.o-we-so-color-palette'),
    wTourUtils.changeOption('topMenuColor', 'button[data-color="black-50"]'),
    ...wTourUtils.clickOnSave(),
    {
        content: "Check that the header is in black-50",
        trigger: 'header#top.bg-black-50',
        run: () => null, // it's a check
    },
    wTourUtils.clickOnEdit(),
    wTourUtils.clickOnSnippet({id: 'o-header-standard', name: 'Header'}),
    wTourUtils.changeOption('TopMenuVisibility', 'we-select:has([data-visibility]) we-toggler'),
    wTourUtils.changeOption('TopMenuVisibility', 'we-button[data-visibility="hidden"]'),
    ...wTourUtils.clickOnSave(),
    {
        content: "Check that the header is hidden",
        trigger: '#wrapwrap:has(header#top.d-none.o-snippet-invisible)',
        run: () => null, // it's a check
    },
    wTourUtils.clickOnEdit(),
    {
        content: "Click on 'header' in the invisible elements list",
        extraTrigger: '#oeSnippets.o-loaded',
        trigger: '.o-we-invisible-el-panel .o-we-invisible-entry',
    },
    wTourUtils.clickOnSnippet({id: 'o-footer', name: 'Footer'}),
    wTourUtils.changeOption('HideFooter', 'we-button[data-name="hide_footer_page_opt"] we-checkbox'),
    ...wTourUtils.clickOnSave(),
    {
        content: "Check that the footer is hidden and the header is visible",
        trigger: '#wrapwrap:has(.o-footer.d-none.o-snippet-invisible)',
        extraTrigger: '#wrapwrap header#top:not(.d-none)',
        run: () => null, // it's a check
    },
]);
