verp.define('stock.PopoverStockPicking', function (require) {
"use strict";

var core = require('web.core');

var PopoverWidgetField = require('stock.popoverWidget');
var registry = require('web.fieldRegistry');
var _lt = core._lt;

var PopoverStockPicking = PopoverWidgetField.extend({
    title: _lt('Planning Issue'),
    trigger: 'focus',
    color: 'text-danger',
    icon: 'fa-exclamation-triangle',

    _render: function () {
        this._super();
        if (this.$popover) {
            var self = this;
            this.$popover.find('a').on('click', function (ev) {
                ev.preventDefault();
                ev.stopPropagation();
                self.doAction({
                    type: 'ir.actions.actwindow',
                    resModel: ev.currentTarget.getAttribute('element-model'),
                    resId: parseInt(ev.currentTarget.getAttribute('element-id'), 10),
                    views: [[false, 'form']],
                    target: 'current'
                });
            });
        }
    },

});

registry.add('stockReschedulingPopover', PopoverStockPicking);

return PopoverStockPicking;
});
