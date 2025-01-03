verp.define('stock.StockOrderpointListController', function (require) {
"use strict";

var core = require('web.core');
var ListController = require('web.ListController');
var FormView = require('web.FormView');

var qweb = core.qweb;


var StockOrderpointListController = ListController.extend({

    // -------------------------------------------------------------------------
    // Public
    // -------------------------------------------------------------------------

    /**
     * @override
     */
    renderButtons: function () {
        this._super.apply(this, arguments);
        this.$buttons.find('.o-list-export-xlsx').addClass('d-none');
        this.$buttons.find('.o-list-button-add').removeClass('btn-primary').addClass('btn-secondary');
        var $buttons = $(qweb.render('StockOrderpoint.Buttons'));
        var $buttonOrder = $buttons.find('.o-button-order');
        var $buttonSnooze = $buttons.find('.o-button-snooze');
        $buttonOrder.on('click', this._onReplenish.bind(this));
        $buttonSnooze.on('click', this._onSnooze.bind(this));
        $buttons.prependTo(this.$buttons);
    },

    // -------------------------------------------------------------------------
    // Handlers
    // -------------------------------------------------------------------------

    _onButtonClicked: function (ev) {
        if (ev.data.attrs.class && ev.data.attrs.class.split(' ').includes('o-replenish-buttons')) {
            ev.stopPropagation();
            var self = this;
            this._callButtonAction(ev.data.attrs, ev.data.record).then(function () {
                self.reload();
            });
        } else {
            this._super.apply(this, arguments);
        }
    },

    _onReplenish: function () {
        var records = this.getSelectedRecords();
        this.model.replenish(records);
    },

    _onSelectionChanged: function (ev) {
        this._super(ev);
        var $buttonOrder = this.$el.find('.o-button-order');
        var $buttonSnooze = this.$el.find('.o-button-snooze');
        if (this.getSelectedIds().length === 0){
            $buttonOrder.addClass('d-none');
            $buttonSnooze.addClass('d-none');
        } else {
            $buttonOrder.removeClass('d-none');
            $buttonSnooze.removeClass('d-none');
        }
    },

    _onSnooze: function () {
        var records = this.getSelectedRecords();
        this.model.snooze(records);
    },
});

return StockOrderpointListController;

});
