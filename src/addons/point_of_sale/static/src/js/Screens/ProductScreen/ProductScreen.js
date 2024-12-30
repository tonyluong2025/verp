verp.define('point_of_sale.ProductScreen', function(require) {
    'use strict';

    const PosComponent = require('point_of_sale.PosComponent');
    const ControlButtonsMixin = require('point_of_sale.ControlButtonsMixin');
    const NumberBuffer = require('point_of_sale.NumberBuffer');
    const { useListener } = require('web.customHooks');
    const Registries = require('point_of_sale.Registries');
    const { onChangeOrder, useBarcodeReader } = require('point_of_sale.customHooks');
    const { isConnectionError, posbus } = require('point_of_sale.utils');
    const { useState, onMounted } = owl.hooks;
    const { parse } = require('web.fieldUtils');

    class ProductScreen extends ControlButtonsMixin(PosComponent) {
        constructor() {
            super(...arguments);
            useListener('update-selected-orderline', this._updateSelectedOrderline);
            useListener('new-orderline-selected', this._newOrderlineSelected);
            useListener('set-numpad-mode', this._setNumpadMode);
            useListener('click-product', this._clickProduct);
            useListener('click-customer', this._onClickCustomer);
            useListener('click-pay', this._onClickPay);
            useBarcodeReader({
                product: this._barcodeProductAction,
                quantity: this._barcodeProductAction,
                weight: this._barcodeProductAction,
                price: this._barcodeProductAction,
                client: this._barcodeClientAction,
                discount: this._barcodeDiscountAction,
                error: this._barcodeErrorAction,
            })
            onChangeOrder(null, (newOrder) => newOrder && this.render());
            NumberBuffer.use({
                nonKeyboardInputEvent: 'numpad-click-input',
                triggerAtInput: 'update-selected-orderline',
                useWithBarcode: true,
            });
            // Call `reset` when the `onMounted` callback in `NumberBuffer.use` is done.
            // We don't do this in the `mounted` lifecycle method because it is called before
            // the callbacks in `onMounted` hook.
            onMounted(() => NumberBuffer.reset());
            this.state = useState({
                numpadMode: 'quantity',
                mobilePane: this.props.mobilePane || 'right',
            });
        }
        mounted() {
            posbus.trigger('start-cash-control');
            this.env.pos.on('change:selectedClient', this.render, this);
        }
        willUnmount() {
            this.env.pos.off('change:selectedClient', null, this);
        }
        /**
         * To be overridden by modules that checks availability of
         * connected scale.
         * @see _onScaleNotAvailable
         */
        get isScaleAvailable() {
            return true;
        }
        get client() {
            return this.env.pos.getClient();
        }
        get currentOrder() {
            return this.env.pos.getOrder();
        }
        async _getAddProductOptions(product, baseCode) {
            let priceExtra = 0.0;
            let draftPackLotLines, weight, description, packLotLinesToEdit;

            if (this.env.pos.config.productConfigurator && _.some(product.attributeLineIds, (id) => id in this.env.pos.attributesByPtalId)) {
                let attributes = _.map(product.attributeLineIds, (id) => this.env.pos.attributesByPtalId[id])
                                  .filter((attr) => attr !== undefined);
                let { confirmed, payload } = await this.showPopup('ProductConfiguratorPopup', {
                    product: product,
                    attributes: attributes,
                });

                if (confirmed) {
                    description = payload.selectedAttributes.join(', ');
                    priceExtra += payload.priceExtra;
                } else {
                    return;
                }
            }

            // Gather lot information if required.
            if (['serial', 'lot'].includes(product.tracking) && (this.env.pos.pickingType.useCreateLots || this.env.pos.pickingType.useExistingLots)) {
                const isAllowOnlyOneLot = product.isAllowOnlyOneLot();
                if (isAllowOnlyOneLot) {
                    packLotLinesToEdit = [];
                } else {
                    const orderline = this.currentOrder
                        .getOrderlines()
                        .filter(line => !line.getDiscount())
                        .find(line => line.product.id === product.id);
                    if (orderline) {
                        packLotLinesToEdit = orderline.getPackLotLinesToEdit();
                    } else {
                        packLotLinesToEdit = [];
                    }
                }
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

                    draftPackLotLines = { modifiedPackLotLines, newPackLotLines };
                } else {
                    // We don't proceed on adding product.
                    return;
                }
            }

            // Take the weight if necessary.
            if (product.toWeight && this.env.pos.config.ifaceElectronicScale) {
                // Show the ScaleScreen to weigh the product.
                if (this.isScaleAvailable) {
                    const { confirmed, payload } = await this.showTempScreen('ScaleScreen', {
                        product,
                    });
                    if (confirmed) {
                        weight = payload.weight;
                    } else {
                        // do not add the product;
                        return;
                    }
                } else {
                    await this._onScaleNotAvailable();
                }
            }

            if (baseCode && this.env.pos.db.productPackagingByBarcode[baseCode.code]) {
                weight = this.env.pos.db.productPackagingByBarcode[baseCode.code].qty;
            }

            return { draftPackLotLines, quantity: weight, description, priceExtra };
        }
        async _clickProduct(event) {
            if (!this.currentOrder) {
                this.env.pos.addNewOrder();
            }
            const product = event.detail;
            const options = await this._getAddProductOptions(product);
            // Do not add product if options is undefined.
            if (!options) return;
            // Add the product after having the extra information.
            await this.currentOrder.addProduct(product, options);
            NumberBuffer.reset();
        }
        _setNumpadMode(event) {
            const { mode } = event.detail;
            NumberBuffer.capture();
            NumberBuffer.reset();
            this.state.numpadMode = mode;
        }
        async _updateSelectedOrderline(event) {
            const order = this.env.pos.getOrder();
            const selectedLine = order.getSelectedOrderline();
            // This validation must not be affected by `disallowLineQuantityChange`
            if (selectedLine && selectedLine.isTipLine() && this.state.numpadMode !== "price") {
                /**
                 * You can actually type numbers from your keyboard, while a popup is shown, causing
                 * the number buffer storage to be filled up with the data typed. So we force the
                 * clean-up of that buffer whenever we detect this illegal action.
                 */
                NumberBuffer.reset();
                if (event.detail.key === "Backspace") {
                    this._setValue("remove");
                } else {
                    this.showPopup("ErrorPopup", {
                        title: this.env._t("Cannot modify a tip"),
                        body: this.env._t("Customer tips, cannot be modified directly"),
                    });
                }
            } else if (this.state.numpadMode === 'quantity' && this.env.pos.disallowLineQuantityChange()) {
                if(!order.orderlines.length)
                    return;
                let lastId = order.orderlines.last().cid;
                let currentQuantity = this.env.pos.getOrder().getSelectedOrderline().getQuantity();

                if(selectedLine.noDecrease) {
                    this.showPopup('ErrorPopup', {
                        title: this.env._t('Invalid action'),
                        body: this.env._t('You are not allowed to change this quantity'),
                    });
                    return;
                }
                const parsedInput = event.detail.buffer && parse.float(event.detail.buffer) || 0;
                if(lastId != selectedLine.cid)
                    await this._showDecreaseQuantityPopup();
                else if(currentQuantity < parsedInput)
                    this._setValue(event.detail.buffer);
                else if(parsedInput < currentQuantity)
                    await this._showDecreaseQuantityPopup();
            } else {
                let { buffer } = event.detail;
                let val = buffer === null ? 'remove' : buffer;
                this._setValue(val);
            }
            if (this.env.pos.config.ifaceCustomerFacingDisplay) {
                this.env.pos.sendCurrentOrderToCustomerFacingDisplay();
            }
        }
        async _newOrderlineSelected() {
            NumberBuffer.reset();
            this.state.numpadMode = 'quantity';
        }
        _setValue(val) {
            if (this.currentOrder.getSelectedOrderline()) {
                if (this.state.numpadMode === 'quantity') {
                    const result = this.currentOrder.getSelectedOrderline().setQuantity(val);
                    if (!result) NumberBuffer.reset();
                } else if (this.state.numpadMode === 'discount') {
                    this.currentOrder.getSelectedOrderline().setDiscount(val);
                } else if (this.state.numpadMode === 'price') {
                    var selectedOrderline = this.currentOrder.getSelectedOrderline();
                    selectedOrderline.priceManuallySet = true;
                    selectedOrderline.setUnitPrice(val);
                }
            }
        }
        async _barcodeProductAction(code) {
            let product = this.env.pos.db.getProductByBarcode(code.baseCode);
            if (!product) {
                // find the barcode in the backend
                let foundProductIds = [];
                try {
                    foundProductIds = await this.rpc({
                        model: 'product.product',
                        method: 'search',
                        args: [[
                            ['barcode', '=', code.baseCode],
                            ['saleOk', '=', true],
                            ['availableInPos', '=', true]
                        ]],
                        context: this.env.session.userContext,
                    });
                } catch (error) {
                    if (isConnectionError(error)) {
                        return this.showPopup('OfflineErrorPopup', {
                            title: this.env._t('Network Error'),
                            body: this.env._t("Product is not loaded. Tried loading the product from the server but there is a network error."),
                        });
                    } else {
                        throw error;
                    }
                }
                if (foundProductIds.length) {
                    await this.env.pos._addProducts(foundProductIds, false);
                    // assume that the result is unique.
                    product = this.env.pos.db.getProductById(foundProductIds[0]);
                } else {
                    return this._barcodeErrorAction(code);
                }
            }
            const options = await this._getAddProductOptions(product, code);
            // Do not proceed on adding the product when no options is returned.
            // This is consistent with _clickProduct.
            if (!options) return;

            // update the options depending on the type of the scanned code
            if (code.type === 'price') {
                Object.assign(options, {
                    price: code.value,
                    extras: {
                        priceManuallySet: true,
                    },
                });
            } else if (code.type === 'weight' || code.type === 'quantity') {
                Object.assign(options, {
                    quantity: code.value,
                    merge: false,
                });
            } else if (code.type === 'discount') {
                Object.assign(options, {
                    discount: code.value,
                    merge: false,
                });
            }
            await this.currentOrder.addProduct(product,  options);
        }
        _barcodeClientAction(code) {
            const partner = this.env.pos.db.getPartnerByBarcode(code.code);
            if (partner) {
                if (this.currentOrder.getClient() !== partner) {
                    this.currentOrder.setClient(partner);
                    this.currentOrder.updatePricelist(partner);
                }
                return true;
            }
            this._barcodeErrorAction(code);
            return false;
        }
        _barcodeDiscountAction(code) {
            var lastOrderline = this.currentOrder.getLastOrderline();
            if (lastOrderline) {
                lastOrderline.setDiscount(code.value);
            }
        }
        // IMPROVEMENT: The following two methods should be in PosScreenComponent?
        // Why? Because once we start declaring barcode actions in different
        // screens, these methods will also be declared over and over.
        _barcodeErrorAction(code) {
            this.showPopup('ErrorBarcodePopup', { code: this._codeRepr(code) });
        }
        _codeRepr(code) {
            if (code.code.length > 32) {
                return code.code.substring(0, 29) + '...';
            } else {
                return code.code;
            }
        }
        async _displayAllControlPopup() {
            await this.showPopup('ControlButtonPopup', {
                controlButtons: this.controlButtons
            });
        }
        /**
         * override this method to perform procedure if the scale is not available.
         * @see isScaleAvailable
         */
        async _onScaleNotAvailable() {}
        async _showDecreaseQuantityPopup() {
            const { confirmed, payload: inputNumber } = await this.showPopup('NumberPopup', {
                startingValue: 0,
                title: this.env._t('Set the new quantity'),
            });
            let newQuantity = inputNumber && inputNumber !== "" ? parse.float(inputNumber) : null;
            if (confirmed && newQuantity !== null) {
                let order = this.env.pos.getOrder();
                let selectedLine = this.env.pos.getOrder().getSelectedOrderline();
                let currentQuantity = selectedLine.getQuantity()
                if(selectedLine.isLastLine() && currentQuantity === 1 && newQuantity < currentQuantity)
                    selectedLine.setQuantity(newQuantity);
                else if(newQuantity >= currentQuantity)
                    selectedLine.setQuantity(newQuantity);
                else {
                    let newLine = selectedLine.clone();
                    let decreasedQuantity = currentQuantity - newQuantity
                    newLine.order = order;

                    newLine.setQuantity( - decreasedQuantity, true);
                    order.addOrderline(newLine);
                }
            }
        }
        async _onClickCustomer() {
            // IMPROVEMENT: This code snippet is very similar to selectClient of PaymentScreen.
            const currentClient = this.currentOrder.getClient();
            if (currentClient && this.currentOrder.getHasRefundLines()) {
                this.showPopup('ErrorPopup', {
                    title: this.env._t("Can't change customer"),
                    body: _.str.sprintf(
                        this.env._t(
                            "This order already has refund lines for %s. We can't change the customer associated to it. Create a new order for the new customer."
                        ),
                        currentClient.label
                    ),
                });
                return;
            }
            const { confirmed, payload: newClient } = await this.showTempScreen(
                'ClientListScreen',
                { client: currentClient }
            );
            if (confirmed) {
                this.currentOrder.setClient(newClient);
                this.currentOrder.updatePricelist(newClient);
            }
        }
        async _onClickPay() {
            if (this.env.pos.getOrder().orderlines.any(line => line.getProduct().tracking !== 'none' && !line.hasValidProductLot() && (this.env.pos.pickingType.useCreateLots || this.env.pos.pickingType.useExistingLots))) {
                const { confirmed } = await this.showPopup('ConfirmPopup', {
                    title: this.env._t('Some Serial/Lot Numbers are missing'),
                    body: this.env._t('You are trying to sell products with serial/lot numbers, but some of them are not set.\nWould you like to proceed anyway?'),
                    confirmText: this.env._t('Yes'),
                    cancelText: this.env._t('No')
                });
                if (confirmed) {
                    this.showScreen('PaymentScreen');
                }
            } else {
                this.showScreen('PaymentScreen');
            }
        }
        switchPane() {
            this.state.mobilePane = this.state.mobilePane === "left" ? "right" : "left";
        }
    }
    ProductScreen.template = 'ProductScreen';

    Registries.Component.add(ProductScreen);

    return ProductScreen;
});
