verp.define('iap.buyMoreCredits', function (require) {
'use strict';

var widgetRegistry = require('web.widgetRegistryOld');
var Widget = require('web.Widget');

var core = require('web.core');
const utils = require('web.utils');

var QWeb = core.qweb;

var IAPBuyMoreCreditsWidget = Widget.extend({
    className: 'o-field-iap-buy-more-credits',

    /**
     * @constructor
     * Prepares the basic rendering of edit mode by setting the root to be a
     * div.dropdown.open.
     * @see FieldChar.init
     */
    init: function (parent, data, options) {
        this._super.apply(this, arguments);
        this.serviceName = options.attrs.serviceName;
        this.hideService = utils.toBoolElse(options.attrs.hideService || '', false);
    },

    /**
     * @override
     */
    start: function () {
        this.$widget = $(QWeb.render('iap.buyMoreCredits', {'hideService': this.hideService}));
        this.$buyLink = this.$widget.find('.buy-credits');
        this.$widget.appendTo(this.$el);
        this.$buyLink.click(this._getLink.bind(this));
        if (!this.hideService) {
            this.el.querySelector('.o-iap-view-my-services').addEventListener('click', this._getMyServices.bind(this));
        }
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------
    _getLink: function () {
        var self = this;
        return this._rpc({
            model: 'iap.account',
            method: 'getCreditsUrl',
            args: [this.serviceName],
        }, {
            shadow: true,
        }).then(function (url) {
            return self.doAction({
                type: 'ir.actions.acturl',
                url: url,
            });
        });
    },

    /**
     * @private
     */
    _getMyServices() {
        return this._rpc({
            model: 'iap.account',
            method: 'getAccountUrl',
        }).then(url => {
            this.doAction({type: 'ir.actions.acturl', url: url});
        });
    },
});

widgetRegistry.add('iapBuyMoreCredits', IAPBuyMoreCreditsWidget);

return IAPBuyMoreCreditsWidget;
});
