/** @verp-module **/

import Dialog from 'web.Dialog';

Dialog.include({

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * @override
     */
    _isBlocking(index, el) {
        if (el.parentElement && el.parentElement.id === 'websiteCookiesBar'
                && !el.classList.contains('o-cookies-popup')) {
            return false;
        }
        return this._super(...arguments);
    },
});
