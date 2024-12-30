verp.define('point_of_sale.ProductConfiguratorPopup', function(require) {
    'use strict';

    const { useState, useSubEnv } = owl.hooks;
    const PosComponent = require('point_of_sale.PosComponent');
    const AbstractAwaitablePopup = require('point_of_sale.AbstractAwaitablePopup');
    const Registries = require('point_of_sale.Registries');

    class ProductConfiguratorPopup extends AbstractAwaitablePopup {
        constructor() {
            super(...arguments);
            useSubEnv({ attributeComponents: [] });
        }

        getPayload() {
            var selectedAttributes = [];
            var priceExtra = 0.0;

            this.env.attributeComponents.forEach((attributeComponent) => {
                let { value, extra } = attributeComponent.getValue();
                selectedAttributes.push(value);
                priceExtra += extra;
            });

            return {
                selectedAttributes,
                priceExtra,
            };
        }
    }
    ProductConfiguratorPopup.template = 'ProductConfiguratorPopup';
    Registries.Component.add(ProductConfiguratorPopup);

    class BaseProductAttribute extends PosComponent {
        constructor() {
            super(...arguments);

            this.env.attributeComponents.push(this);

            this.attribute = this.props.attribute;
            this.values = this.attribute.values;
            this.state = useState({
                selectedValue: parseFloat(this.values[0].id),
                customValue: '',
            });
        }

        getValue() {
            let selectedValue = this.values.find((val) => val.id === parseFloat(this.state.selectedValue));
            let value = selectedValue.label;
            if (selectedValue.isCustom && this.state.customValue) {
                value += `: ${this.state.customValue}`;
            }

            return {
                value,
                extra: selectedValue.priceExtra
            };
        }
    }

    class RadioProductAttribute extends BaseProductAttribute {
        mounted() {
            // With radio buttons `t-model` selects the default input by searching for inputs with
            // a matching `value` attribute. In our case, we use `t-att-value` so `value` is
            // not found yet and no radio is selected by default.
            // We then manually select the first input of each radio attribute.
            $(this.el).find('input[type="radio"]:first').prop('checked', true);
        }
    }
    RadioProductAttribute.template = 'RadioProductAttribute';
    Registries.Component.add(RadioProductAttribute);

    class SelectProductAttribute extends BaseProductAttribute { }
    SelectProductAttribute.template = 'SelectProductAttribute';
    Registries.Component.add(SelectProductAttribute);

    class ColorProductAttribute extends BaseProductAttribute {}
    ColorProductAttribute.template = 'ColorProductAttribute';
    Registries.Component.add(ColorProductAttribute);

    return {
        ProductConfiguratorPopup,
        BaseProductAttribute,
        RadioProductAttribute,
        SelectProductAttribute,
        ColorProductAttribute,
    };
});
