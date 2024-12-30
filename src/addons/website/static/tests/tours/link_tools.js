/** @verp-module */

import tour from 'web_tour.tour';
import wTourUtils from 'website.tourUtils';

const clickOnImgStep = {
    content: "Click somewhere else to save.",
    trigger: '#wrap .s-text-image img',
};

tour.register('link_tools', {
    test: true,
    url: '/?enable_editor=1',
}, [
    // 1. Create a new link from scratch.
    wTourUtils.dragNDrop({
        id: 'sTextImage',
        name: 'Text - Image',
    }),
    {
        content: "Replace first paragraph, to insert a new link",
        trigger: '#wrap .s-text-image p',
        run: 'text Go to verp: '
    },
    {
        content: "Open link tools",
        trigger: "#toolbar #create-link",
    },
    {
        content: "Type the link URL theverp.com",
        trigger: '#oLinkDialogUrlInput',
        run: 'text theverp.com'
    },
    clickOnImgStep,
    // 2. Edit the link with the link tools.
    {
        content: "Click on the newly created link, change content to verp website",
        trigger: '.s-text-image a[href="http://theverp.com"]:contains("theverp.com")',
        run: 'text verp website',
    },
    {
        content: "Link tools, should be open, change the url",
        trigger: '#oLinkDialogUrlInput',
        run: 'text theverp.com'
    },
    clickOnImgStep,
    ...wTourUtils.clickOnSave(),
    // 3. Edit a link after saving the page.
    wTourUtils.clickOnEdit(),
    {
        content: "The new link content should be verp website and url theverp.com",
        extraTrigger: "#oeSnippets.o-loaded",
        trigger: '.s-text-image a[href="http://theverp.com"]:contains("verp website")',
    },
    {
        content: "The new link content should be verp website and url theverp.com",
        trigger: '#toolbar button[data-original-title="Link Style"]',
    },
    {
        trigger: 'body',
        run: () => {
            // When doing automated testing, the link popover takes time to
            // hide. While hidding, the editor observer is unactive in order to
            // prevent the popover mutation to be recorded. In a manual
            // scenario, the popover has plenty of time to be hidden and the
            // obsever would be re-activated in time. As this problem arise only
            // in test, we activate the observer here for the popover.
            $('#wrapwrap').data('wysiwyg').verpEditor.observerActive('hide.bs.popover');
        },
    },
    {
        content: "Click on the secondary style button.",
        trigger: '#toolbar we-button[data-value="secondary"]',
    },
    ...wTourUtils.clickOnSave(),
    {
        content: "The link should have the secondary button style.",
        trigger: '.s-text-image a.btn.btn-secondary[href="http://theverp.com"]:contains("verp website")',
        run: () => {}, // It's a check.
    },
    // 4. Add link on image.
    wTourUtils.clickOnEdit(),
    {
        content: "Click on image.",
        trigger: '.s-text-image img',
        extraTrigger: '#oeSnippets.o-loaded',
    },
    {
        content: "Activate link.",
        trigger: '.o-we-customize-panel we-row:contains("Media") we-button.fa-link',
    },
    {
        content: "Set URL.",
        trigger: '.o-we-customize-panel we-input:contains("Your URL") input',
        run: 'text theverp.com',
    },
    {
        content: "Deselect image.",
        trigger: '.s-text-image p',
    },
    {
        content: "Re-select image.",
        trigger: '.s-text-image img',
    },
    {
        content: "Check that link tools appear.",
        trigger: '.popover div a:contains("http://theverp.com")',
        run: () => {}, // It's a check.
    },
    // 5. Remove link from image.
    {
        content: "Remove link.",
        trigger: '.popover:contains("http://theverp.com") a .fa-chain-broken',
    },
    {
        content: "Check that image is not within a link anymore.",
        trigger: '.s-text-image div > img',
        run: () => {}, // It's a check.
    },
]);
