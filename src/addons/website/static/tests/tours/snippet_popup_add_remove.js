/** @verp-module */

import tour from 'web_tour.tour';

tour.register('snippet_popup_add_remove', {
    test: true,
    url: '/?enable_editor=1',
}, [{
    content: 'Drop sPopup snippet',
    trigger: '#oeSnippets .oe-snippet:has( > [data-snippet="sPopup"]) .oe-snippet-thumbnail',
    run: "dragAndDrop #wrap",
}, {
    content: 'Edit sPopup snippet',
    inModal: false,
    trigger: '#wrap.o-editable [data-snippet="sPopup"] .row > div', // Click deep in the snippet structure
}, {
    content: 'Check sPopup setting are loaded, wait panel is visible',
    inModal: false,
    trigger: '.o-we-customize-panel',
    run: () => null,
}, {
    content: `Remove the sPopup snippet`,
    inModal: false,
    trigger: '.o-we-customize-panel we-button.oe-snippet-remove:first',
}, {
    content: 'Check the sPopup was removed',
    inModal: false,
    trigger: '#wrap.o-editable:not(:has([data-snippet="sPopup"]))',
    run: () => null,
},
// Test that undoing dropping the snippet removes the invisible elements panel.
{
    content: "Drop the snippet again.",
    trigger: '#oeSnippets .oe-snippet:has(> [data-snippet="sPopup"]) .oe-snippet-thumbnail',
    run: "dragAndDrop #wrap",
}, {
    content: "The popup should be in the invisible elements panel.",
    inModal: false,
    trigger: '.o-we-invisible-el-panel .o-we-invisible-entry',
    run: () => null, // It's a check.
}, {
    content: "Click on the 'undo' button.",
    inModal: false,
    trigger: '#oeSnippets button[data-action="undo"]',
}, {
    content: "Check that the sPopup was removed.",
    inModal: false,
    trigger: '#wrap.o-editable:not(:has([data-snippet="sPopup"]))',
    run: () => null, // It's a check.
}, {
    content: "The invisible elements panel should also be removed.",
    trigger: '#oeSnippets:has(.o-we-invisible-el-panel.d-none)',
    run: () => null, // It's a check.
}]);
