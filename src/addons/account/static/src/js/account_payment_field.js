verp.define('account.payment', function (require) {
"use strict";

var AbstractField = require('web.AbstractField');
var core = require('web.core');
var fieldRegistry = require('web.fieldRegistry');
var fieldUtils = require('web.fieldUtils');

var QWeb = core.qweb;
var _t = core._t;

var ShowPaymentLineWidget = AbstractField.extend({
    events: _.extend({
        'click .outstanding-credit-assign': '_onOutstandingCreditAssign',
    }, AbstractField.prototype.events),
    supportedFieldTypes: ['char'],

    //--------------------------------------------------------------------------
    // Public
    //--------------------------------------------------------------------------

    /**
     * @override
     * @returns {boolean}
     */
    isSet: function() {
        return true;
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * @private
     * @override
     */
    _render: function() {
        var self = this;
        var info = JSON.parse(this.value);
        if (!info) {
            this.$el.html('');
            return;
        }
        _.each(info.content, function (k, v){
            k.index = v;
            k.amount = fieldUtils.format.float(k.amount, {digits: k.digits});
            if (k.date){
                k.date = fieldUtils.format.date(fieldUtils.parse.date(k.date, {}, {isUTC: true}));
            }
        });
        this.$el.html(QWeb.render('ShowPaymentInfo', {
            lines: info.content,
            outstanding: info.outstanding,
            title: info.title
        }));
        _.each(this.$('.js-payment-info'), function (k, v){
            var isRTL = _t.database.parameters.direction === "rtl";
            var content = info.content[v];
            var options = {
                content: function () {
                    var $content = $(QWeb.render('PaymentPopOver', content));
                    var unreconcileButton = $content.filter('.js-unreconcile-payment').on('click', self._onRemoveMoveReconcile.bind(self));

                    $content.filter('.js-open-payment').on('click', self._onOpenPayment.bind(self));
                    return $content;
                },
                html: true,
                placement: isRTL ? 'bottom' : 'left',
                title: 'Payment Information',
                trigger: 'focus',
                delay: { "show": 0, "hide": 100 },
                container: $(k).parent(), // FIXME Ugly, should use the default body container but system & tests to adapt to properly destroy the popover
            };
            $(k).popover(options);
        });
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * @private
     * @override
     * @param {MouseEvent} event
     */
    _onOpenPayment: function (event) {
        var paymentId = parseInt($(event.target).attr('payment-id'));
        var moveId = parseInt($(event.target).attr('move-id'));
        var resModel;
        var id;
        if (paymentId !== undefined && !isNaN(paymentId)){
            resModel = "account.payment";
            id = paymentId;
        } else if (moveId !== undefined && !isNaN(moveId)){
            resModel = "account.move";
            id = moveId;
        }
        //Open form view of account.move with id = moveId
        if (resModel && id) {
            this.doAction({
                type: 'ir.actions.actwindow',
                resModel: resModel,
                resId: id,
                views: [[false, 'form']],
                target: 'current'
            });
        }
    },
    /**
     * @private
     * @override
     * @param {MouseEvent} event
     */
    _onOutstandingCreditAssign: function (event) {
        event.stopPropagation();
        event.preventDefault();
        var self = this;
        var id = $(event.target).data('id') || false;
        this._rpc({
                model: 'account.move',
                method: 'jsAssignOutstandingLine',
                args: [JSON.parse(this.value).moveId, id],
            }).then(function () {
                self.triggerUp('reload');
            });
    },
    /**
     * @private
     * @override
     * @param {MouseEvent} event
     */
    _onRemoveMoveReconcile: function (event) {
        var self = this;
        var moveId = parseInt($(event.target).attr('move-id'));
        var partialId = parseInt($(event.target).attr('partial-id'));
        if (partialId !== undefined && !isNaN(partialId)){
            this._rpc({
                model: 'account.move',
                method: 'jsRemoveOutstandingPartial',
                args: [moveId, partialId],
            }).then(function () {
                self.triggerUp('reload');
            });
        }
    },
});

fieldRegistry.add('payment', ShowPaymentLineWidget);

return {
    ShowPaymentLineWidget: ShowPaymentLineWidget
};

});
