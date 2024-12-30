verp.define('point_of_sale.OrderlineDetails', function (require) {
    'use strict';

    const PosComponent = require('point_of_sale.PosComponent');
    const Registries = require('point_of_sale.Registries');
    const { format } = require('web.fieldUtils');
    const { roundPrecision: roundPr } = require('web.utils');

    /**
     * @props {pos.order.line} line
     */
    class OrderlineDetails extends PosComponent {
        get line() {
            const line = this.props.line;
            const formatQty = (line) => {
                const quantity = line.getQuantity();
                const unit = line.getUnit();
                const decimals = this.env.pos.dp['Product Unit of Measure'];
                const rounding = Math.max(unit.rounding, Math.pow(10, -decimals));
                const roundedQuantity = roundPr(quantity, rounding);
                return format.float(roundedQuantity, { digits: [69, decimals] });
            };
            return {
                productName: line.getFullProductName(),
                totalPrice: line.getPriceWithTax(),
                quantity: formatQty(line),
                unit: line.getUnit().label,
                unitPrice: line.getUnitPrice(),
            };
        }
        get productName() {
            return this.line.productName;
        }
        get totalPrice() {
            return this.env.pos.formatCurrency(this.line.totalPrice);
        }
        get quantity() {
            return this.line.quantity;
        }
        get unitPrice() {
            return this.env.pos.formatCurrency(this.line.unitPrice);
        }
        get unit() {
            return this.line.unit;
        }
        get pricePerUnit() {
            return ` ${this.unit} at ${this.unitPrice} / ${this.unit}`;
        }
        get customerNote() {
            return this.props.line.getCustomerNote();
        }
        getToRefundDetail() {
            return this.env.pos.toRefundLines[this.props.line.id];
        }
        hasRefundedQty() {
            return !this.env.pos.isProductQtyZero(this.props.line.refundedQty);
        }
        getFormattedRefundedQty() {
            return this.env.pos.formatProductQty(this.props.line.refundedQty);
        }
        hasToRefundQty() {
            const toRefundDetail = this.getToRefundDetail();
            return !this.env.pos.isProductQtyZero(toRefundDetail && toRefundDetail.qty);
        }
        getFormattedToRefundQty() {
            const toRefundDetail = this.getToRefundDetail();
            return this.env.pos.formatProductQty(toRefundDetail && toRefundDetail.qty);
        }
        getRefundingMessage() {
            return _.str.sprintf(this.env._t('Refunding %s in '), this.getFormattedToRefundQty());
        }
        getToRefundMessage() {
            return _.str.sprintf(this.env._t('To Refund: %s'), this.getFormattedToRefundQty());
        }
    }
    OrderlineDetails.template = 'OrderlineDetails';

    Registries.Component.add(OrderlineDetails);

    return OrderlineDetails;
});
