verp.define('point_of_sale.OrderWidget', function(require) {
    'use strict';

    const { useState, useRef } = owl.hooks;
    const { useListener } = require('web.customHooks');
    const { onChangeOrder } = require('point_of_sale.customHooks');
    const PosComponent = require('point_of_sale.PosComponent');
    const Registries = require('point_of_sale.Registries');
    const { useEffect } = require('@web/core/utils/hooks');

    class OrderWidget extends PosComponent {
        constructor() {
            super(...arguments);
            useListener('select-line', this._selectLine);
            useListener('edit-pack-lot-lines', this._editPackLotLines);
            onChangeOrder(this._onPrevOrder, this._onNewOrder);
            this.scrollableRef = useRef('scrollable');
            useEffect(
                () => {
                    const selectedLineEl = this.scrollableRef.el && this.scrollableRef.el.querySelector(".orderline.selected");
                    if(selectedLineEl) {
                        selectedLineEl.scrollIntoView({ behavior: "smooth", block: "start" });
                    }
                },
                () => [this.order.selectedOrderline]
            );
            this.state = useState({ total: 0, tax: 0 });
            this._updateSummary();
        }
        get order() {
            return this.env.pos.getOrder();
        }
        get orderlinesArray() {
            return this.order ? this.order.getOrderlines() : [];
        }
        _selectLine(event) {
            this.order.selectOrderline(event.detail.orderline);
        }
        // IMPROVEMENT: Might be better to lift this to ProductScreen
        // because there is similar operation when clicking a product.
        //
        // Furthermore, what if a number different from 1 (or -1) is specified
        // to an orderline that has product tracked by lot. Lot tracking (based
        // on the current implementation) requires that 1 item per orderline is
        // allowed.
        async _editPackLotLines(event) {
            const orderline = event.detail.orderline;
            const isAllowOnlyOneLot = orderline.product.isAllowOnlyOneLot();
            const packLotLinesToEdit = orderline.getPackLotLinesToEdit(isAllowOnlyOneLot);
            const { confirmed, payload } = await this.showPopup('EditListPopup', {
                title: this.env._t('Lot/Serial Number(s) Required'),
                isSingleItem: isAllowOnlyOneLot,
                array: packLotLinesToEdit,
            });
            if (confirmed) {
                // Segregate the old and new packlot lines
                const modifiedPackLotLines = Object.fromEntries(
                    payload.newArray.filter(item => item.id).map(item => [item.id, item.text])
                );
                const newPackLotLines = payload.newArray
                    .filter(item => !item.id)
                    .map(item => ({ lotName: item.text }));

                orderline.setPackLotLines({ modifiedPackLotLines, newPackLotLines });
            }
            this.order.selectOrderline(event.detail.orderline);
        }
        _onNewOrder(order) {
            if (order) {
                order.orderlines.on(
                    'new-orderline-selected',
                    () => this.trigger('new-orderline-selected'),
                    this
                );
                order.orderlines.on('change', this._updateSummary, this);
                order.orderlines.on(
                    'add remove',
                    () => {
                        this._updateSummary();
                    },
                    this
                );
                order.on('change', this.render, this);
            }
            this._updateSummary();
            this.trigger('new-orderline-selected');
        }
        _onPrevOrder(order) {
            if (order) {
                order.orderlines.off('new-orderline-selected', null, this);
                order.orderlines.off('change', null, this);
                order.orderlines.off('add remove', null, this);
                order.off('change', null, this);
            }
        }
        _updateSummary() {
            const total = this.order ? this.order.getTotalWithTax() : 0;
            const tax = this.order ? total - this.order.getTotalWithoutTax() : 0;
            this.state.total = this.env.pos.formatCurrency(total);
            this.state.tax = this.env.pos.formatCurrency(tax);
            this.render();
        }
    }
    OrderWidget.template = 'OrderWidget';

    Registries.Component.add(OrderWidget);

    return OrderWidget;
});
