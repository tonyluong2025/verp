verp.define('snailmail_account.NotificationManager', function (require) {
"use strict";

var AbstractService = require('web.AbstractService');
var core = require("web.core");

var SnailmailAccountNotificationManager =  AbstractService.extend({
    dependencies: ['busService'],

    /**
     * @override
     */
    start: function () {
        this._super.apply(this, arguments);
        this.call('busService', 'onNotification', this, this._onNotification);
    },

    _onNotification: function(notifications) {
        for (const { payload, type } of notifications) {
            if (type === "snailmailInvalidAddress") {
                this.displayNotification({ title: payload.title, message: payload.message, type: 'danger' });
            }
        }
    }

});

core.serviceRegistry.add('snailmailAccountNotificationService', SnailmailAccountNotificationManager);

return SnailmailAccountNotificationManager;

});
