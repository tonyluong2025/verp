//
// This file is meant to allow to switch the type of an input #password
// from password to text on mousedown on an input group.
// On mouse down, we see the password in clear text
// On mouse up, we hide it again.
//
verp.define('website.showPassword', function (require) {
'use strict';

var publicWidget = require('web.public.widget');

publicWidget.registry.ShowPassword = publicWidget.Widget.extend({
    selector: '#showPass',
    events: {
        'mousedown': '_onShowText',
        'touchstart': '_onShowText',
    },

    /**
     * @override
     */
    destroy: function () {
        this._super(...arguments);
        $('body').off(".ShowPassword");
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * @private
     */
    _onShowPassword: function () {
        this.$el.closest('.input-group').find('#password').attr('type', 'password');
    },
    /**
     * @private
     */
    _onShowText: function () {
        $('body').one('mouseup.ShowPassword touchend.ShowPassword', this._onShowPassword.bind(this));
        this.$el.closest('.input-group').find('#password').attr('type', 'text');
    },
});

return publicWidget.registry.ShowPassword;

});
