verp.define('report.clientAction', function (require) {
'use strict';

var AbstractAction = require('web.AbstractAction');
var core = require('web.core');
var session = require('web.session');
var utils = require('report.utils');

var QWeb = core.qweb;


var AUTHORIZED_MESSAGES = [
    'report:doAction',
];

var ReportAction = AbstractAction.extend({
    hasControlPanel: true,
    contentTemplate: 'report.clientAction',

    init: function (parent, action, options) {
        this._super.apply(this, arguments);

        options = options || {};

        this.actionManager = parent;
        this._title = options.displayName || options.name;

        this.reportUrl = options.reportUrl;

        // Extra info that will be useful to build a qweb-pdf action.
        this.reportName = options.reportName;
        this.reportFile = options.reportFile;
        this.data = options.data || {};
        this.context = options.context || {};
    },

    start: function () {
        var self = this;
        this.iframe = this.$('iframe')[0];
        this.$buttons = $(QWeb.render('report.clientAction.ControlButtons', {}));
        this.$buttons.on('click', '.o-report-print', this.onClickPrint);
        this.controlPanelProps.cpContent = {
            $buttons: this.$buttons,
        };
        return Promise.all([this._super.apply(this, arguments), session.isBound]).then(async function () {
            var webBaseUrl = window.origin;
            var trustedHost = utils.getHostFromUrl(webBaseUrl);
            var trustedProtocol = utils.getProtocolFromUrl(webBaseUrl);
            self.trustedOrigin = utils.buildOrigin(trustedProtocol, trustedHost);

            // Load the report in the iframe. Note that we use a relative URL.
            self.iframe.src = self.reportUrl;
        });
    },

    onAttachCallback: function () {
        // Register now the postMessage event handler. We only want to listen to ~trusted
        // messages and we can only filter them by their origin, so we chose to ignore the
        // messages that do not come from `web.base.url`.
        $(window).on('message', this, this.onMessageReceived);
        this._super();
    },

    onDetachCallback: function () {
        $(window).off('message', this.onMessageReceived);
        this._super();
    },

    /**
     * Event handler of the message post. We only handle them if they're from
     * `web.base.url` host and protocol and if they're part of `AUTHORIZED_MESSAGES`.
     */
    onMessageReceived: function (ev) {
        // Check the origin of the received message.
        var messageOrigin = utils.buildOrigin(ev.originalEvent.source.location.protocol, ev.originalEvent.source.location.host);
        if (messageOrigin === this.trustedOrigin) {

            // Check the syntax of the received message.
            var message = ev.originalEvent.data;
            if (_.isObject(message)) {
                message = message.message;
            }
            if (! _.isString(message) || (_.isString(message) && ! _.contains(AUTHORIZED_MESSAGES, message))) {
                return;
            }

            switch(message) {
                case 'report:doAction':
                    return this.doAction(ev.originalEvent.data.action);
                default:
            }
        }
    },

    /**
     * Helper allowing to send a message to the `this.el` iframe's window and
     * seting the `targetOrigin` as `this.trustedOrigin` (which is the
     * `web.base.url` ir.config.parameter key) - in other word, only when using
     * this method we only send the message to a trusted domain.
     */
    _postMessage: function (message) {
        this.iframe.contentWindow.postMessage(message, this.trustedOrigin);
    },

    onClickPrint: function () {
        var action = {
            'type': 'ir.actions.report',
            'reportType': 'qweb-pdf',
            'reportName': this.reportName,
            'reportFile': this.reportFile,
            'data': this.data,
            'context': this.context,
            'displayName': this.title,
        };
        return this.doAction(action);
    },

});

core.actionRegistry.add('report.clientAction', ReportAction);

return ReportAction;

});
