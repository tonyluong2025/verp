verp.define('stock.BasicModel', function (require) {
"use strict";

var BasicModel = require('web.BasicModel');
var localStorage = require('web.localStorage');

BasicModel.include({

    _invalidateCache: function (dataPoint) {
        this._super.apply(this, arguments);
        if (dataPoint.model === 'stock.warehouse' && !localStorage.getItem('runningTour')) {
            this.doAction('reloadContext');
        }
    }
});
});
