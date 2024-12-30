verp.define('sale.salesTeamDashboard', function (require) {
"use strict";

var core = require('web.core');
var KanbanRecord = require('web.KanbanRecord');
var session = require('web.session');
var _t = core._t;

KanbanRecord.include({
    events: _.defaults({
        'click .sales-team-target-definition': '_onSalesTeamTargetClick',
    }, KanbanRecord.prototype.events),

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * @param {MouseEvent} ev
     */
    _onSalesTeamTargetClick: function (ev) {
        ev.preventDefault();
        var self = this;

        this.$targetInput = $('<input>');
        this.$('.o-kanban-primary-bottom:last').html(this.$targetInput);
        this.$targetInput.focus();
        let preLabel = _t("Set an invoicing target: ");
        let postLabel = _t(" / Month");
        const kanbanBottomBlock = this.$el.find('.o-kanban-primary-bottom.bottom-block:last-child');
        if (this.recordData.currencyId) {
            const currency = session.getCurrency(this.recordData.currencyId.resId);
            if (currency.position === "after") {
                postLabel = ` ${' ' + currency.symbol}${postLabel}`;
            } else {
               preLabel = `${preLabel} ${currency.symbol + ' '}`;
            }
        }
        kanbanBottomBlock.prepend($('<span/>').text(preLabel));
        kanbanBottomBlock.append($('<span/>').text(postLabel));

        this.$targetInput.on({
            blur: this._onSalesTeamTargetSet.bind(this),
            keydown: function (ev) {
                if (ev.keyCode === $.ui.keyCode.ENTER) {
                    self._onSalesTeamTargetSet();
                }
            },
        });
    },
    /**
     * Mostly a handler for what happens to the input "this.$targetInput"
     *
     * @private
     *
     */
    _onSalesTeamTargetSet: function () {
        var self = this;
        var value = Number(this.$targetInput.val());
        if (isNaN(value)) {
            this.displayNotification({ message: _t("Please enter an integer value"), type: 'danger' });
        } else {
            this.triggerUp('kanbanRecordUpdate', {
                invoicedTarget: value,
                onSuccess: function () {
                    self.triggerUp('reload');
                },
            });
        }
    },
});

});
