verp.define('point_of_sale.tour.ProductConfiguratorTourMethods', function (require) {
    'use strict';

    const { createTourMethods } = require('point_of_sale.tour.utils');

    class Do {
        pickRadio(name) {
            return [
                {
                    content: `picking radio attribute with name ${name}`,
                    trigger: `.product-configurator-popup .attribute-name-cell label:contains('${name}')`,
                },
            ];
        }

        pickSelect(name) {
            return [
                {
                    content: `picking select attribute with name ${name}`,
                    trigger: `.product-configurator-popup .configurator-select:has(option:contains('${name}'))`,
                    run: `text ${name}`,
                },
            ];
        }

        pickColor(name) {
            return [
                {
                    content: `picking color attribute with name ${name}`,
                    trigger: `.product-configurator-popup .configurator-color[data-color='${name}']`,
                },
            ];
        }

        fillCustomAttribute(value) {
            return [
                {
                    content: `filling custom attribute with value ${value}`,
                    trigger: `.product-configurator-popup .custom-value`,
                    run: `text ${value}`,
                },
            ];
        }

        confirmAttributes() {
            return [
                {
                    content: `confirming product configuration`,
                    trigger: `.product-configurator-popup .button.confirm`,
                },
            ];
        }

        cancelAttributes() {
            return [
                {
                    content: `canceling product configuration`,
                    trigger: `.product-configurator-popup .button.cancel`,
                },
            ];
        }
    }

    class Check {
        isShown() {
            return [
                {
                    content: 'product configurator is shown',
                    trigger: '.product-configurator-popup:not(:has(.oe-hidden))',
                    run: () => {},
                },
            ];
        }
    }

    return createTourMethods('ProductConfigurator', Do, Check);
});
