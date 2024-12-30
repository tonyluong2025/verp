verp.define('website.postLink', function (require) {
'use strict';

const publicWidget = require('web.public.widget');
const wUtils = require('website.utils');

publicWidget.registry.postLink = publicWidget.Widget.extend({
    selector: '.postLink',
    events: {
        'click': '_onClickPost',
    },

    /**
     * @override
     */
    start() {
        // Allows the link to be interacted with only when Javascript is loaded.
        this.el.classList.add('o-post-link-js-loaded');
        return this._super(...arguments);
    },
    /**
     * @override
     */
    destroy() {
        this._super(...arguments);
        this.el.classList.remove('o-post-link-js-loaded');
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    _onClickPost: function (ev) {
        ev.preventDefault();
        const url = this.el.dataset.post || this.el.href;
        let data = {};
        for (let [key, value] of Object.entries(this.el.dataset)) {
            if (key.startsWith('post')) {
                data[_.lowerFirst(key.slice(4))] = value; // Tony
            }
        }
        wUtils.sendRequest(url, data);
    },
});

});
