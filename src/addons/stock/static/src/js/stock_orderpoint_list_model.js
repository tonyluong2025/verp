verp.define('stock.StockOrderpointListModel', function (require) {
"use strict";

var core = require('web.core');
var ListModel = require('web.ListModel');

var qweb = core.qweb;


var StockOrderpointListModel = ListModel.extend({

    // -------------------------------------------------------------------------
    // Public
    // -------------------------------------------------------------------------
    /**
     */
    replenish: function (records) {
      var self = this;
      var model = records[0].model;
      var recordResIds = _.pluck(records, 'resId');
      var context = records[0].getContext();
      return this._rpc({
          model: model,
          method: 'actionReplenish',
          args: [recordResIds],
          context: context,
      }).then(function () {
          return self.doAction('stock.actionReplenishment');
      });
    },

    snooze: function (records) {
      var recordResIds = _.pluck(records, 'resId');
      var self = this;
      return this.doAction('stock.actionOrderpointSnooze', {
          additionalContext: {
              default_orderpointIds: recordResIds
          },
          onClose: () => self.doAction('stock.actionReplenishment')
      });
    },
});

return StockOrderpointListModel;

});
