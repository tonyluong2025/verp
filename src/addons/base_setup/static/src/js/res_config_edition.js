verp.define('base_setup.ResConfigEdition', function (require) {
    "use strict";

    var Widget = require('web.Widget');
    var widgetRegistry = require('web.widgetRegistryOld');
    var session = require ('web.session');

    var ResConfigEdition = Widget.extend({
        template: 'resConfigEdition',

       /**
        * @override
        */
        init: function () {
            this._super.apply(this, arguments);
            this.serverVersion = session.serverVersion;
            this.expirationDate = session.expirationDate
                ? moment(session.expirationDate)
                : moment().add(30, 'd');
        },
   });

   widgetRegistry.add('resConfigEdition', ResConfigEdition);

    return ResConfigEdition;
});
