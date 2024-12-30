verp.define('point_of_sale.ProductItem', function(require) {
    'use strict';

    const PosComponent = require('point_of_sale.PosComponent');
    const Registries = require('point_of_sale.Registries');
    const models = require('point_of_sale.models');

    class ProductItem extends PosComponent {
        /**
         * For accessibility, pressing <space> should be like clicking the product.
         * <enter> is not considered because it conflicts with the barcode.
         *
         * @param {KeyPressEvent} event
         */
        spaceClickProduct(event) {
            if (event.which === 32) {
                this.trigger('click-product', this.props.product);
            }
        }
        get imageUrl() {
            const product = this.props.product;
            return `/web/image?model=product.product&field=image128&id=${product.id}&updatedAt=${product.updatedAt}&unique=1`;
        }
        get pricelist() {
            const currentOrder = this.env.pos.getOrder();
            if (currentOrder) {
                return currentOrder.pricelist;
            }
            return this.env.pos.defaultPricelist;
        }
        get price() {
            const formattedUnitPrice = this.env.pos.formatCurrency(
                this.props.product.getDisplayPrice(this.pricelist, 1),
                'Product Price'
            );
            if (this.props.product.toWeight) {
                return `${formattedUnitPrice}/${
                    this.env.pos.unitsById[this.props.product.uomId[0]].label
                }`;
            } else {
                return formattedUnitPrice;
            }
        }
        async onProductInfoClick() {
            const info = await this.env.pos.getProductInfo(this.props.product, 1);
            this.showPopup('ProductInfoPopup', { info: info , product: this.props.product });
        }
    }
    ProductItem.template = 'ProductItem';

    Registries.Component.add(ProductItem);

    return ProductItem;
});
