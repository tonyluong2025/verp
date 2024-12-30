/** @verp-module */

import tour from 'web_tour.tour';
import wTourUtils from 'website.tourUtils';

const snippets = [
    {
        id: 'sTextImage',
        name: 'Text - Image',
    },
];
tour.register('conditional_visibility_1', {
    test: true,
    url: '/',
},
[{
    content: "enter edit mode",
    trigger: 'a[data-action=edit]',
},
wTourUtils.dragNDrop(snippets[0]),
wTourUtils.clickOnSnippet(snippets[0]),
wTourUtils.changeOption('ConditionalVisibility', 'we-toggler'),
{
    content: 'click on conditional visibility',
    trigger: '[data-name="visibility_conditional"]',
    run: 'click',
},
{
    content: 'click on utm medium toggler',
    trigger: '[data-save-attribute="visibilityValueUtmMedium"] we-toggler',
    run: 'click',
},
{
    trigger: '[data-save-attribute="visibilityValueUtmMedium"] we-selection-items [data-add-record="Email"]',
    content: 'click on Email',
    run: 'click',
},
...wTourUtils.clickOnSave(),
{
    content: 'Check if the rule was applied',
    trigger: 'body:not(.editor-enable) #wrap',
    run: function (actions) {
        const style = window.getComputedStyle(this.$anchor[0].getElementsByClassName('s-text-image')[0]);
        if (style.display !== 'none') {
            console.error('error This item should be invisible and only visible if utmMedium === email');
        }
    },
},
wTourUtils.clickOnEdit(),
{
    content: 'Check if the element is visible as it should always be visible in edit view',
    trigger: 'body.editor-enable #wrap .s-text-image',
    run: function (actions) {
        const style = window.getComputedStyle((this.$anchor[0]));
        if (style.display === 'none') {
            console.error('error This item should now be visible because utmMedium === email');
        }
    },
},
]);

tour.register('conditional_visibility_2', {
    test: true,
    url: '/?utmMedium=Email',
},
[{
    content: 'The content previously hidden should now be visible',
    trigger: 'body #wrap',
    run: function (actions) {
        const style = window.getComputedStyle(this.$anchor[0].getElementsByClassName('s-text-image')[0]);
        if (style.display === 'none') {
            console.error('error This item should now be visible because utmMedium === email');
        }
    },
},
]);
