verp.define('stock.SingletonListView', function (require) {
'use strict';

var InventoryReportListView = require('stock.InventoryReportListView');
var SingletonListController = require('stock.SingletonListController');
var SingletonListRenderer = require('stock.SingletonListRenderer');
var viewRegistry = require('web.viewRegistry');

var SingletonListView = InventoryReportListView.extend({
    config: _.extend({}, InventoryReportListView.prototype.config, {
        Controller: SingletonListController,
        Renderer: SingletonListRenderer,
    }),
});

viewRegistry.add('singletonList', SingletonListView);

return SingletonListView;

});
