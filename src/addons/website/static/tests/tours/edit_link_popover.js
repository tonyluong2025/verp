verp.define("website.tour.edit_link_popover", function (require) {
"use strict";

const tour = require('web_tour.tour');
const wTourUtils = require('website.tourUtils');

const FIRST_PARAGRAPH = '#wrap .s-text-image p:nth-child(2)';

const clickFooter = [{
    content: "Save the link by clicking outside the URL input (not on a link element)",
    trigger: 'footer h5:first',
}, {
    content: "Wait delayed click on footer",
    trigger: '.o-we-customize-panel we-title:contains("Footer")',
    run: function () {}, // it's a check
}];

const clickEditLink = [{
    content: "Click on Edit Link in Popover",
    trigger: '.o-edit-menu-popover .o-we-edit-link',
    // FIXME this run shouldnt be needed but click not working as real click
    run: (actions) => {
        actions.click();
        $('.o-edit-menu-popover').popover('hide');
    },
}, {
    content: "Ensure popover is closed",
    trigger: 'html:not(:has(.o-edit-menu-popover))', // popover should be closed
    run: function () {}, // it's a check
    inModal: false,
}];

tour.register('edit_link_popover', {
    test: true,
    url: '/?enable_editor=1',
}, [
    // 1. Test links in page content (web_editor)
    wTourUtils.dragNDrop({
        id: 'sTextImage',
        name: 'Text - Image',
    }),
    {
        content: "Click on a paragraph",
        trigger: FIRST_PARAGRAPH,
    },
    {
        content: "Click on 'Link' to open Link Dialog",
        trigger: "#toolbar #create-link",
    },
    {
        content: "Type the link URL /contactus",
        trigger: '#oLinkDialogUrlInput',
        run: 'text /contactus'
    },
    ...clickFooter,
    {
        content: "Click on newly created link",
        trigger: `${FIRST_PARAGRAPH} a`,
    },
    {
        content: "Popover should be shown",
        trigger: '.o-edit-menu-popover .o-we-url-link:contains("Contact Us")', // At this point preview is loaded
        run: function () {}, // it's a check
    },
    ...clickEditLink,
    {
        content: "Type the link URL /",
        trigger: '#oLinkDialogUrlInput',
        run: "text /"
    },
    ...clickFooter,
    {
        content: "Click on link",
        trigger: `${FIRST_PARAGRAPH} a`,
        // FIXME this run shouldnt be needed but click not working as real click
        run: function (actions) {
            actions.click();
            this.$anchor.popover('show');
        },
    },
    {
        content: "Popover should be shown with updated preview data",
        trigger: '.o-edit-menu-popover .o-we-url-link:contains("Home")',
        run: function () {}, // it's a check
    },
    {
        content: "Click on Remove Link in Popover",
        trigger: '.o-edit-menu-popover .o-we-remove-link',
    },
    {
        content: "Link should be removed",
        trigger: `${FIRST_PARAGRAPH}:not(:has(a))`,
        // run: function () {}, // it's a check
        // FIXME this run shouldnt be needed but click not working as real click
        run: (actions) => {
            $('.o-edit-menu-popover').popover('hide');
        },
    },
    {
        content: "Ensure popover is closed",
        trigger: 'html:not(:has(.o-edit-menu-popover))', // popover should be closed
        run: function () {}, // it's a check
    },
    // 2. Test links in navbar (website)
    {
        content: "Click navbar menu Home",
        trigger: '#topMenu a:contains("Home")',
    },
    {
        content: "Popover should be shown (2)",
        trigger: '.o-edit-menu-popover .o-we-url-link:contains("Home")',
        run: function () {}, // it's a check
    },
    ...clickEditLink,
    {
        content: "Change the URL",
        trigger: '#oLinkDialogUrlInput',
        run: "text /contactus"
    },
    {
        content: "Save the Link Dialog modal",
        trigger: '.modal-footer .btn-primary',
    },
    {
        content: "Click on the Home menu again",
        extraTrigger: '#topMenu a:contains("Home")[href="/contactus"]', // href should be changed
        trigger: '#topMenu a:contains("Home")',
        // FIXME this run shouldnt be needed but click not working as real click
        run: function (actions) {
            actions.click();
            this.$anchor.popover('show');
        },
    },
    {
        content: "Popover should be shown with updated preview data (2)",
        trigger: '.o-edit-menu-popover .o-we-url-link:contains("Contact Us")',
        run: function () {}, // it's a check
    },
    {
        content: "Click on Edit Menu in Popover",
        trigger: '.o-edit-menu-popover .js-edit-menu',
    },
    {
        content: "Edit Menu (tree) should open",
        trigger: '.js-add-menu',
        run: function () {}, // it's a check
    },
    {
        content: "Close modal",
        trigger: '.modal-footer .btn-secondary',
    },
    // 3. Test other links (CTA in navbar & links in footer)
    {
        content: "Click CTA in navbar",
        trigger: '#topMenuContainer a.btn-primary[href="/contactus"]',
    },
    {
        content: "Popover should be shown (3)",
        trigger: '.o-edit-menu-popover .o-we-url-link:contains("Contact Us")',
        run: function () {}, // it's a check
    },
    {
        content: "Toolbar should be shown (3)",
        trigger: '#toolbar:has(#oLinkDialogUrlInput:propValue(/contactus))',
        run: function () {}, // it's a check
    },
    {
        content: "Click 'Home' link in footer",
        trigger: 'footer a[href="/"]',
    },
    {
        content: "Popover should be shown (4)",
        trigger: '.o-edit-menu-popover .o-we-url-link:contains("Home")',
        run: function () {}, // it's a check
    },
    {
        content: "Toolbar should be shown (4)",
        trigger: '#toolbar:has(#oLinkDialogUrlInput:propValue(/))',
        run: function () {}, // it's a check
    },
    // 4. Popover should close when clicking non-link element
    ...clickFooter,
    // FIXME this step shouldnt be needed but click not working as real click
    {
        content: "REMOVEME",
        trigger: 'html', // Do not block if popover already hidden
        run: (actions) => {
            $('.o-edit-menu-popover').popover('hide');
        },
    },
    // 5. Double click should not open popover but should open toolbar link
    {
        content: "Double click on link",
        extraTrigger: 'html:not(:has(.o-edit-menu-popover))', // popover should be closed
        trigger: 'footer a[href="/"]',
        run: function (actions) {
            // Create range to simulate real double click, see pull request
            const range = document.createRange();
            range.selectNodeContents(this.$anchor[0]);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            actions.click();
            actions.dblclick();
            // FIXME this step shouldnt be needed but click not working as real click
            this.$anchor.popover('show');
        },
    },
    {
        content: "Ensure popover is opened on double click, and so is right panel edit link",
        trigger: 'html:has(#oLinkDialogUrlInput):has(.o-edit-menu-popover)',
        run: function () {}, // it's a check
    },
]);
});
