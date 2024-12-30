verp.define('backend_web_theme.FormView', function (require) {
"use strict";

const config = require("web.config");

const FormView = require('web.FormView');
const QuickCreateFormView = require('web.QuickCreateFormView');

FormView.include({
    init() {
        this._super(...arguments);
        if (config.device.isMobile) {
            this.controllerParams.disableAutofocus = true;
        }
    },
});

QuickCreateFormView.include({
    init() {
        this._super(...arguments);
        if (config.device.isMobile) {
            this.controllerParams.disableAutofocus = true;
        }
    },
});

});
