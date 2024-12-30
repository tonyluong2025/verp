verp.define('base_setup.ResConfigDevTool', function (require) {
    "use strict";

    var config = require('web.config');
    var Widget = require('web.Widget');
    var widgetRegistry = require('web.widgetRegistryOld');

    var ResConfigDevTool = Widget.extend({
        template: 'resConfigDevTool',
        events: {
            'click .o-web-settings-force-demo': '_onClickForceDemo',
        },

        init: function () {
            this._super.apply(this, arguments);
            this.isDebug = config.isDebug();
            this.isAssets = config.isDebug("assets");
            this.isTests = config.isDebug("tests");
        },

        willStart: function () {
            var self = this;
            return this._super.apply(this, arguments).then(function () {
                return self._rpc({
                    route: '/base_setup/demoActive',
                }).then(function (demoAction) {
                    self.demoAction = demoAction;
                });
            });
        },

        //--------------------------------------------------------------------------
        // Handlers
        //--------------------------------------------------------------------------

        /**
         * Forces demo data to be installed in a database without demo data installed.
         *
         * @private
         * @param {MouseEvent} ev
         */
        _onClickForceDemo: function (ev) {
            ev.preventDefault();
            this.doAction('base.demoForceInstallAction');
        },
    });

    widgetRegistry.add('resConfigDevTool', ResConfigDevTool);
});
