verp.define('auth_signup.signup', function (require) {
'use strict';

var publicWidget = require('web.public.widget');

publicWidget.registry.SignUpForm = publicWidget.Widget.extend({
    selector: '.oe-signup-form',
    events: {
        'submit': '_onSubmit',
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * @private
     */
    _onSubmit: function () {
        var $btn = this.$('.oe-login-buttons > button[type="submit"]');
        $btn.attr('disabled', 'disabled');
        $btn.prepend('<i class="fa fa-refresh fa-spin"/> ');
    },
});
});
