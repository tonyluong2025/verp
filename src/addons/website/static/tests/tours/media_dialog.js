/** @verp-module */

import tour from 'web_tour.tour';
import wTourUtils from 'website.tourUtils';

tour.register('website_media_dialog_undraw', {
    test: true,
    url: '/',
}, [
{
    trigger: 'a[data-action=edit]',
},
wTourUtils.dragNDrop({
    id: 'sTextImage',
    name: 'Text - Image',
}),
{
    trigger: '.s-text-image img',
    run: "dblclick",
},
{
    trigger: '.o-select-media-dialog:has(.o-we-search-select option[value="media-library"])',
},
]);
