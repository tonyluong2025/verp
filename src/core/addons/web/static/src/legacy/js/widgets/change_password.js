verp.define('web.ChangePassword', function (require) {
"use strict";

/**
 * This file defines a client action that opens in a dialog (target='new') and
 * allows the user to change his password.
 */

var AbstractAction = require('web.AbstractAction');
var core = require('web.core');
var Dialog = require('web.Dialog');
var webClient = require('web.webClient');

var _t = core._t;

var ChangePassword = AbstractAction.extend({
    template: "ChangePassword",

    /**
     * @fixme: weird interaction with the parent for the $buttons handling
     *
     * @override
     * @returns {Promise}
     */
    start: function () {
        var self = this;
        webClient.setTitle(_t("Change Password"));
        var $button = self.$('.oe-form-button');
        $button.appendTo(this.getParent().$footer);
        $button.eq(1).click(function () {
            self.$el.parents('.modal').modal('hide');
        });
        $button.eq(0).click(function () {
            self._rpc({
                    route: '/web/session/changePassword',
                    params: {
                        fields: $('form[name=changePasswordForm]').serializeArray()
                    }
                })
                .then(function (result) {
                    if (result.error) {
                        self.displayNotification({
                            message: result.error,
                            type: 'danger'
                        });
                    } else {
                        self.doAction('logout');
                    }
                });
        });
    },
});

core.actionRegistry.add("changePassword", ChangePassword);

return ChangePassword;

});
