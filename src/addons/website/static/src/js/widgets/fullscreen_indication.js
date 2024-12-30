/** @verp-module **/

import Widget from 'web.Widget';

export const FullscreenIndication = Widget.extend({
    xmlDependencies: ['/website/static/src/xml/website.xml'],
    template: 'website.fullscreenIndication', 

    init: function () {
        this.visible = false;
        this.displayTime = 2000;
        this._super(...arguments);
    },

    //--------------------------------------------------------------------------
    // Public
    //--------------------------------------------------------------------------

    /**
     * Displays the fullscreen indication modal
     */
    show: function () {
        clearTimeout(this.autofade);
        this.visible = true;
        this.el.classList.add('o-transition', 'o-visible');
        this.autofade = setTimeout(() => {
            this.hide(true);
        }, this.displayTime);
    },
    /**
     * Hides the fullscreen indication modal with optionnal transition
     * 
     * @param {boolean} [withTransition=false]
     */
    hide: function (withTransition = false) {
        this.el.classList.toggle('o-transition', withTransition);
        this.el.classList.remove('o-visible');
        this.visible = false;
    },
});
