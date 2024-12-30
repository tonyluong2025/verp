/** @verp-module */

import wTourUtils from 'website.tourUtils';
import tour from 'web_tour.tour';

const clickOnSave = {
   content: "Clicks on the menu edition dialog save button",
   trigger: '.modal-dialog .btn-primary span:contains("Save")',
};

tour.register('edit_menus', {
    test: true,
    url: '/',
}, [
    // Add a megamenu item from the menu.
    {
        content: "Open Pages menu",
        trigger: '.o-menu-sections a:contains("Pages")',
    },
    {
        content: "Click on Edit Menu",
        trigger: 'a.dropdown-item:contains("Edit Menu")',
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
    clickOnSave,
    {
        content: "Click save and wait for the page to be reloaded",
        trigger: '.modal-dialog .btn-primary span:contains("Save")',
    },
    wTourUtils.clickOnExtraMenuItem({extraTrigger: 'body:not(.o-wait-reload)'}),
    {
        content: "There should be a new megamenu item.",
        trigger: '#topMenu .nav-item a.o-mega-menu-toggle:contains("Megaaaaa!")',
        run: () => {}, // It's a check.
    },
    // Add a menu item in edit mode.
    wTourUtils.clickOnEdit(),
    {
        content: "Click on a menu item",
        trigger: '#topMenu .nav-item a',
        extraTrigger: '#oeSnippets.o-loaded',
    },
    {
        content: "Click on Edit Menu",
        trigger: '.o-edit-menu-popover a.js-edit-menu',
    },
    {
        content: "Trigger the link dialog (click 'Add Menu Item')",
        extraTrigger: '.o-web-editor-dialog:visible',
        trigger: '.modal-body a.js-add-menu',
    },
    clickOnSave,
    {
        content: "It didn't save without a label. Fill label input.",
        extraTrigger: '.o-link-dialog',
        trigger: '.o-link-dialog #oLinkDialogLabelInput',
        run: 'text Random!',
    },
    clickOnSave,
    {
        content: "It didn't save without a url. Fill url input.",
        extraTrigger: '.o-link-dialog',
        trigger: '.o-link-dialog #oLinkDialogUrlInput',
        run: 'text #',
    },
    clickOnSave,
    clickOnSave,
    wTourUtils.clickOnEdit(),
    // Edit the new menu item from the "edit link" popover button
    wTourUtils.clickOnExtraMenuItem({extraTrigger: '#oeSnippets.o-loaded'}),
    {
        content: "Menu should have a new link item",
        trigger: '#topMenu .nav-item a:contains("Random!")',
    },
    {
        content: "Click on Edit Link",
        trigger: '.o-edit-menu-popover a.o-we-edit-link',
    },
    {
        content: "Change the label",
        trigger: '.o-link-dialog #oLinkDialogLabelInput',
        run: 'text Modnar',
    },
    clickOnSave,
    ...wTourUtils.clickOnSave(),
    // Edit the menu item from the "edit menu" popover button
    wTourUtils.clickOnEdit(),
    wTourUtils.clickOnExtraMenuItem({extraTrigger: '#oeSnippets.o-loaded'}),
    {
        content: "Label should have changed",
        trigger: '#topMenu .nav-item a:contains("Modnar")',
    },
    {
        content: "Click on the popover Edit Menu button",
        trigger: '.o-edit-menu-popover a.js-edit-menu',
    },
    {
        content: "Click on the dialog Edit Menu button",
        trigger: '.oe-menu-editor .js-menu-label:contains("Modnar")',
        run: function () {
            const liEl = this.$anchor[0].closest('[data-menu-id]');
            liEl.querySelector('button.js-edit-menu').click();
        },
    },
    {
        content: "Change the label",
        trigger: '.o-link-dialog #oLinkDialogLabelInput',
        run: 'text Modnar !!',
    },
    clickOnSave,
    clickOnSave,
    wTourUtils.clickOnExtraMenuItem({extraTrigger: 'a[data-action=edit]'}),
    {
        content: "Label should have changed",
        trigger: '#topMenu .nav-item a:contains("Modnar !!")',
        run: () => {}, // It's a check.
    },
]);
