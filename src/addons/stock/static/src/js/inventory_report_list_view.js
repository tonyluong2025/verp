verp.define('stock.InventoryReportListView', function (require) {
"use strict";

var ListView = require('web.ListView');
var InventoryReportListController = require('stock.InventoryReportListController');
var viewRegistry = require('web.viewRegistry');


var InventoryReportListView = ListView.extend({
    config: _.extend({}, ListView.prototype.config, {
        Controller: InventoryReportListController,
    }),
});

viewRegistry.add('inventoryReportList', InventoryReportListView);

return InventoryReportListView;

});
