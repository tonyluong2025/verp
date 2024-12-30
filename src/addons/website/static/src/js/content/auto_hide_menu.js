/** @verp-module **/

import { initAutoMoreMenu } from '@web/legacy/js/core/menu';

/**
 * Auto adapt the header layout so that elements are not wrapped on a new line.
 */
document.addEventListener('DOMContentLoaded', async () => {
    const header = document.querySelector('header#top');
    if (header) {
        const topMenu = header.querySelector('#topMenu');
        if (header.classList.contains('o-no-autohide-menu')) {
            topMenu.classList.remove('o-menu-loading');
            return;
        }
        const unfoldable = '.divider, .divider ~ li, .o-no-autohide-item, .js-language-selector';
        const excludedImagesSelector = '.o-mega-menu, .o-offcanvas-logo-container, .o-lang-flag';
        const excludedImages = [...header.querySelectorAll(excludedImagesSelector)];
        const images = [...header.querySelectorAll('img')].filter((img) => {
            excludedImages.forEach(node => {
                if (node.contains(img)) {
                    return false;
                }
            });
            return img.matches && !img.matches(excludedImagesSelector);
        });
        initAutoMoreMenu(topMenu, {
            unfoldable: unfoldable,
            images: images,
            loadingStyleClasses: ['o-menu-loading']
        });
    }
});
