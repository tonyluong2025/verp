verp.define('point_of_sale.ScaleScreen', function(require) {
    'use strict';

    const { useState, useExternalListener } = owl.hooks;
    const PosComponent = require('point_of_sale.PosComponent');
    const { roundPrecision: roundPr } = require('web.utils');
    const Registries = require('point_of_sale.Registries');

    class ScaleScreen extends PosComponent {
        /**
         * @param {Object} props
         * @param {Object} props.product The product to weight.
         */
        constructor() {
            super(...arguments);
            useExternalListener(document, 'keyup', this._onHotkeys);
            this.state = useState({ weight: 0 });
        }
        mounted() {
            // start the scale reading
            this._readScale();
        }
        willUnmount() {
            // stop the scale reading
            this.env.pos.proxyQueue.clear();
        }
        back() {
            this.props.resolve({ confirmed: false, payload: null });
            this.trigger('close-temp-screen');
        }
        confirm() {
            this.props.resolve({
                confirmed: true,
                payload: { weight: this.state.weight },
            });
            this.trigger('close-temp-screen');
        }
        _onHotkeys(event) {
            if (event.key === 'Escape') {
                this.back();
            } else if (event.key === 'Enter') {
                this.confirm();
            }
        }
        _readScale() {
            this.env.pos.proxyQueue.schedule(this._setWeight.bind(this), {
                duration: 500,
                repeat: true,
            });
        }
        async _setWeight() {
            const reading = await this.env.pos.proxy.scaleRead();
            this.state.weight = reading.weight;
        }
        get _activePricelist() {
            const currentOrder = this.env.pos.getOrder();
            let currentPricelist = this.env.pos.defaultPricelist;
            if (currentOrder) {
                currentPricelist = currentOrder.pricelist;
            }
            return currentPricelist;
        }
        get productWeightString() {
            const defaultstr = (this.state.weight || 0).toFixed(3) + ' Kg';
            if (!this.props.product || !this.env.pos) {
                return defaultstr;
            }
            const unitId = this.props.product.uomId;
            if (!unitId) {
                return defaultstr;
            }
            const unit = this.env.pos.unitsById[unitId[0]];
            const weight = roundPr(this.state.weight || 0, unit.rounding);
            let weightstr = weight.toFixed(Math.ceil(Math.log(1.0 / unit.rounding) / Math.log(10)));
            weightstr += ' ' + unit.label;
            return weightstr;
        }
        get computedPriceString() {
            return this.env.pos.formatCurrency(this.productPrice * this.state.weight);
        }
        get productPrice() {
            const product = this.props.product;
            return (product ? product.getPrice(this._activePricelist, this.state.weight) : 0) || 0;
        }
        get productName() {
            return (
                (this.props.product ? this.props.product.displayName : undefined) ||
                'Unnamed Product'
            );
        }
        get productUom() {
            return this.props.product
                ? this.env.pos.unitsById[this.props.product.uomId[0]].label
                : '';
        }
    }
    ScaleScreen.template = 'ScaleScreen';

    Registries.Component.add(ScaleScreen);

    return ScaleScreen;
});
