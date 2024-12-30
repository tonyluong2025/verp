verp.define("website.tour.edit_megamenu", function (require) {
"use strict";

const tour = require('web_tour.tour');
const wTourUtils = require('website.tourUtils');

const toggleMegaMenu = (stepOptions) => Object.assign({}, {
    content: "Toggles the mega menu.",
    trigger: '#topMenu .nav-item a.o-mega-menu-toggle',
    run: function () {
        // If the mega menu is displayed inside the extra menu items, it should
        // already be displayed.
        if (!this.$anchor[0].closest('.o-extra-menu-items')) {
            this.$anchor.click();
        }
    },
}, stepOptions);

tour.register('edit_megamenu', {
    test: true,
    url: '/?enable_editor=1',
}, [
    // Add a megamenu item to the top menu.
    {
        content: "Click on a menu item",
        trigger: '#topMenu .nav-item a',
    },
    {
        content: "Click on 'Link' to open Link Dialog",
        trigger: '.o-edit-menu-popover a.js-edit-menu',
    },
    {
        content: "Trigger the link dialog (click 'Add Mega Menu Item')",
        extraTrigger: '.o-web-editor-dialog:visible',
        trigger: '.modal-body a.js-add-menu[data-type="mega"]',
    },
    {
        content: "Write a label for the new menu item",
        extraTrigger: '.o-link-dialog',
        trigger: '.o-link-dialog #oLinkDialogLabelInput',
        run: 'text Megaaaaa!'
    },
    {
        content: "Save the new menu item",
        trigger: '.modal-dialog .btn-primary span:contains("Save")',
        run: 'click',
    },
    {
        content: "Save the changes to the menu",
        trigger: '.modal-dialog .btn-primary span:contains("Save")',
        run: 'click',
    },
    // Edit a menu item
    wTourUtils.clickOnEdit(),
    wTourUtils.clickOnExtraMenuItem({extraTrigger: '#oeSnippets.o-loaded'}),
    toggleMegaMenu({extraTrigger: '#topMenu .nav-item a.o-mega-menu-toggle:contains("Megaaaaa!")'}),
    {
        content: "Clicks on the first title item.",
        trigger: '.o-mega-menu h4',
    },
    {
        content: "Press enter.",
        trigger: '.o-mega-menu h4',
        run: function (actions) {
            this.$anchor[0].dispatchEvent(new window.InputEvent('input', {bubbles: true, inputType: 'insertParagraph'}));
        },
    },
    {
        content: "The menu should still be visible. Edit a menu item.",
        trigger: '.o-mega-menu h4',
        run: 'text New Menu Item',
    },
    ...wTourUtils.clickOnSave(),
    wTourUtils.clickOnExtraMenuItem({extraTrigger: 'a[data-action=edit]'}),
    toggleMegaMenu(),
    {
        content: "The menu item should have been renamed.",
        trigger: '.o-mega-menu h4:contains("New Menu Item")',
        run: function () {}, // it's a check
    },
]);
});
