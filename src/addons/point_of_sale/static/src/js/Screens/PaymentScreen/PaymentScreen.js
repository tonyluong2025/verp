verp.define('point_of_sale.PaymentScreen', function (require) {
    'use strict';

    const { parse } = require('web.fieldUtils');
    const PosComponent = require('point_of_sale.PosComponent');
    const { useErrorHandlers, useAsyncLockedMethod } = require('point_of_sale.customHooks');
    const NumberBuffer = require('point_of_sale.NumberBuffer');
    const { useListener } = require('web.customHooks');
    const Registries = require('point_of_sale.Registries');
    const { onChangeOrder } = require('point_of_sale.customHooks');
    const { isConnectionError } = require('point_of_sale.utils');

    class PaymentScreen extends PosComponent {
        constructor() {
            super(...arguments);
            useListener('delete-payment-line', this.deletePaymentLine);
            useListener('select-payment-line', this.selectPaymentLine);
            useListener('new-payment-line', this.addNewPaymentLine);
            useListener('update-selected-paymentline', this._updateSelectedPaymentline);
            useListener('send-payment-request', this._sendPaymentRequest);
            useListener('send-payment-cancel', this._sendPaymentCancel);
            useListener('send-payment-reverse', this._sendPaymentReverse);
            useListener('send-force-done', this._sendForceDone);
            this.lockedValidateOrder = useAsyncLockedMethod(this.validateOrder);
            this.paymentMethodsFromConfig = this.env.pos.paymentMethods.filter(method => this.env.pos.config.paymentMethodIds.includes(method.id));
            NumberBuffer.use(this._getNumberBufferConfig);
            onChangeOrder(this._onPrevOrder, this._onNewOrder);
            useErrorHandlers();
            this.paymentInterface = null;
            this.error = false;
        }

        mounted() {
            this.env.pos.on('change:selectedClient', this.render, this);
        }
        willUnmount() {
            this.env.pos.off('change:selectedClient', null, this);
        }

        showMaxValueError() {
            this.showPopup('ErrorPopup', {
                title: this.env._t('Maximum value reached'),
                body: this.env._t('The amount cannot be higher than the due amount if you don\'t have a cash payment method configured.')
            });
        }
        get _getNumberBufferConfig() {
            let config = {
                // The numberBuffer listens to this event to update its state.
                // Basically means 'update the buffer when this event is triggered'
                nonKeyboardInputEvent: 'input-from-numpad',
                // When the buffer is updated, trigger this event.
                // Note that the component listens to it.
                triggerAtInput: 'update-selected-paymentline',
            };
            // Check if pos has a cash payment method
            const hasCashPaymentMethod = this.paymentMethodsFromConfig.some(
                (method) => method.type === 'cash'
            );

            if (!hasCashPaymentMethod) {
                config['maxValue'] = this.currentOrder.getDue();
                config['maxValueReached'] = this.showMaxValueError.bind(this);
            }

            return config;
        }
        get currentOrder() {
            return this.env.pos.getOrder();
        }
        get paymentLines() {
            return this.currentOrder.getPaymentlines();
        }
        get selectedPaymentLine() {
            return this.currentOrder.selectedPaymentline;
        }
        async selectClient() {
            // IMPROVEMENT: This code snippet is repeated multiple times.
            // Maybe it's better to create a function for it.
            const currentClient = this.currentOrder.getClient();
            const { confirmed, payload: newClient } = await this.showTempScreen(
                'ClientListScreen',
                { client: currentClient }
            );
            if (confirmed) {
                this.currentOrder.setClient(newClient);
                this.currentOrder.updatePricelist(newClient);
            }
        }
        addNewPaymentLine({ detail: paymentMethod }) {
            // original function: clickPaymentmethods
            let result = this.currentOrder.addPaymentline(paymentMethod);
            if (result){
                NumberBuffer.reset();
                return true;
            }
            else{
                this.showPopup('ErrorPopup', {
                    title: this.env._t('Error'),
                    body: this.env._t('There is already an electronic payment in progress.'),
                });
                return false;
            }
        }
        _updateSelectedPaymentline() {
            if (this.paymentLines.every((line) => line.paid)) {
                this.currentOrder.addPaymentline(this.paymentMethodsFromConfig[0]);
            }
            if (!this.selectedPaymentLine) return; // do nothing if no selected payment line
            // disable changing amount on paymentlines with running or done payments on a payment terminal
            const paymentTerminal = this.selectedPaymentLine.paymentMethod.paymentTerminal;
            if (
                paymentTerminal &&
                !['pending', 'retry'].includes(this.selectedPaymentLine.getPaymentStatus())
            ) {
                return;
            }
            if (NumberBuffer.get() === null) {
                this.deletePaymentLine({ detail: { cid: this.selectedPaymentLine.cid } });
            } else {
                this.selectedPaymentLine.setAmount(NumberBuffer.getFloat());
            }
        }
        toggleIsToInvoice() {
            // clickInvoice
            this.currentOrder.setToInvoice(!this.currentOrder.isToInvoice());
            this.render();
        }
        openCashbox() {
            this.env.pos.proxy.printer.openCashbox();
        }
        async addTip() {
            // clickTip
            const tip = this.currentOrder.getTip();
            const change = this.currentOrder.getChange();
            let value = tip === 0 && change > 0 ? change : tip;

            const { confirmed, payload } = await this.showPopup('NumberPopup', {
                title: tip ? this.env._t('Change Tip') : this.env._t('Add Tip'),
                startingValue: value,
                isInputSelected: true,
            });

            if (confirmed) {
                this.currentOrder.setTip(parse.float(payload));
            }
        }
        toggleIsToShip() {
            // clickShip
            this.currentOrder.setToShip(!this.currentOrder.isToShip());
            this.render();
        }
        deletePaymentLine(event) {
            var self = this;
            const { cid } = event.detail;
            const line = this.paymentLines.find((line) => line.cid === cid);

            // If a paymentline with a payment terminal linked to
            // it is removed, the terminal should get a cancel
            // request.
            if (['waiting', 'waitingCard', 'timeout'].includes(line.getPaymentStatus())) {
                line.setPaymentStatus('waitingCancel');
                line.paymentMethod.paymentTerminal.setndPaymentCancel(this.currentOrder, cid).then(function() {
                    self.currentOrder.removePaymentline(line);
                    NumberBuffer.reset();
                    self.render();
                })
            }
            else if (line.getPaymentStatus() !== 'waitingCancel') {
                this.currentOrder.removePaymentline(line);
                NumberBuffer.reset();
                this.render();
            }
        }
        selectPaymentLine(event) {
            const { cid } = event.detail;
            const line = this.paymentLines.find((line) => line.cid === cid);
            this.currentOrder.selectPaymentline(line);
            NumberBuffer.reset();
            this.render();
        }
        /**
         * Returns false if the current order is empty and has no payments.
         * @returns {boolean}
         */
        _isValidEmptyOrder() {
            const order = this.currentOrder;
            if (order.getOrderlines().length == 0) {
                return order.getPaymentlines().length != 0;
            } else {
                return true;
            }
        }
        async validateOrder(isForceValidate) {
            if(this.env.pos.config.cashRounding) {
                if(!this.env.pos.getOrder().checkPaymentlinesRounding()) {
                    this.showPopup('ErrorPopup', {
                        title: this.env._t('Rounding error in payment lines'),
                        body: this.env._t("The amount of your payment lines must be rounded to validate the transaction."),
                    });
                    return;
                }
            }
            if (await this._isOrderValid(isForceValidate)) {
                // remove pending payments before finalizing the validation
                for (let line of this.paymentLines) {
                    if (!line.isDone()) this.currentOrder.removePaymentline(line);
                }
                await this._finalizeValidation();
            }
        }
        async _finalizeValidation() {
            if ((this.currentOrder.isPaidWithCash() || this.currentOrder.getChange()) && this.env.pos.config.ifaceCashdrawer) {
                this.env.pos.proxy.printer.openCashbox();
            }

            this.currentOrder.initializeValidationDate();
            this.currentOrder.finalized = true;

            let syncedOrderBackendIds = [];

            try {
                this.env.services.ui.block()
                if (this.currentOrder.isToInvoice()) {
                    syncedOrderBackendIds = await this.env.pos.pushAndInvoiceOrder(
                        this.currentOrder
                    );
                } else {
                    syncedOrderBackendIds = await this.env.pos.pushSingleOrder(this.currentOrder);
                }
            } catch (error) {
                if (error.code == 700 || error.code == 701)
                    this.error = true;

                if ('code' in error) {
                    // We started putting `code` in the rejected object for invoicing error.
                    // We can continue with that convention such that when the error has `code`,
                    // then it is an error when invoicing. Besides, _handlePushOrderError was
                    // introduce to handle invoicing error logic.
                    await this._handlePushOrderError(error);
                } else {
                    // We don't block for connection error. But we rethrow for any other errors.
                    if (isConnectionError(error)) {
                        this.showPopup('OfflineErrorPopup', {
                            title: this.env._t('Connection Error'),
                            body: this.env._t('Order is not synced. Check your internet connection'),
                        });
                    } else {
                        throw error;
                    }
                }
            } finally {
                this.env.services.ui.unblock()
            }
            if (syncedOrderBackendIds.length && this.currentOrder.waitForPushOrder()) {
                const result = await this._postPushOrderResolve(
                    this.currentOrder,
                    syncedOrderBackendIds
                );
                if (!result) {
                    await this.showPopup('ErrorPopup', {
                        title: this.env._t('Error: no internet connection.'),
                        body: this.env._t('Some, if not all, post-processing after syncing order failed.'),
                    });
                }
            }

            this.showScreen(this.nextScreen);

            // If we succeeded in syncing the current order, and
            // there are still other orders that are left unsynced,
            // we ask the user if he is willing to wait and sync them.
            if (syncedOrderBackendIds.length && this.env.pos.db.getOrders().length) {
                const { confirmed } = await this.showPopup('ConfirmPopup', {
                    title: this.env._t('Remaining unsynced orders'),
                    body: this.env._t(
                        'There are unsynced orders. Do you want to sync these orders?'
                    ),
                });
                if (confirmed) {
                    // NOTE: Not yet sure if this should be awaited or not.
                    // If awaited, some operations like changing screen
                    // might not work.
                    this.env.pos.pushOrders();
                }
            }
        }
        get nextScreen() {
            return !this.error? 'ReceiptScreen' : 'ProductScreen';
        }
        async _isOrderValid(isForceValidate) {
            if (this.currentOrder.getOrderlines().length === 0 && this.currentOrder.isToInvoice()) {
                this.showPopup('ErrorPopup', {
                    title: this.env._t('Empty Order'),
                    body: this.env._t(
                        'There must be at least one product in your order before it can be validated and invoiced.'
                    ),
                });
                return false;
            }

            if (this.currentOrder.electronicPaymentInProgress()) {
                this.showPopup('ErrorPopup', {
                    title: this.env._t('Pending Electronic Payments'),
                    body: this.env._t(
                        'There is at least one pending electronic payment.\n' +
                        'Please finish the payment with the terminal or ' +
                        'cancel it then remove the payment line.'
                    ),
                });
                return false;
            }

            const splitPayments = this.paymentLines.filter(payment => payment.paymentMethod.splitTransactions)
            if (splitPayments.length && !this.currentOrder.getClient()) {
                const paymentMethod = splitPayments[0].paymentMethod
                const { confirmed } = await this.showPopup('ConfirmPopup', {
                    title: this.env._t('Customer Required'),
                    body: _.str.sprintf(this.env._t('Customer is required for %s payment method.'), paymentMethod.label),
                });
                if (confirmed) {
                    this.selectClient();
                }
                return false;
            }

            if ((this.currentOrder.isToInvoice() || this.currentOrder.isToShip()) && !this.currentOrder.getClient()) {
                const { confirmed } = await this.showPopup('ConfirmPopup', {
                    title: this.env._t('Please select the Customer'),
                    body: this.env._t(
                        'You need to select the customer before you can invoice or ship an order.'
                    ),
                });
                if (confirmed) {
                    this.selectClient();
                }
                return false;
            }

            var customer = this.currentOrder.getClient()
            if (this.currentOrder.isToShip() && !(customer.label && customer.street && customer.city && customer.countryId)) {
                this.showPopup('ErrorPopup', {
                    title: this.env._t('Incorrect address for shipping'),
                    body: this.env._t('The selected customer needs an address.'),
                });
                return false;
            }

            if (!this.currentOrder.isPaid() || this.invoicing) {
                return false;
            }

            if (this.currentOrder.hasNotValidRounding()) {
                var line = this.currentOrder.hasNotValidRounding();
                this.showPopup('ErrorPopup', {
                    title: this.env._t('Incorrect rounding'),
                    body: this.env._t(
                        'You have to round your payments lines.' + line.amount + ' is not rounded.'
                    ),
                });
                return false;
            }

            //If this order is a refund, check if there is a cash payment
            if (this.currentOrder.getDue() < 0) {
                if (!this.paymentMethodsFromConfig.some(paymentMethod => paymentMethod.isCashCount)) {
                    this.showPopup('ErrorPopup', {
                        title: this.env._t('Cannot return change without a cash payment method'),
                        body: this.env._t('There is no cash payment method available in this point of sale to handle the change.\n\n Please add a cash payment method in the point of sale configuration.')
                    });
                    return false;
                }
            }

            // The exact amount must be paid if there is no cash payment method defined.
            if (
                Math.abs(
                    this.currentOrder.getTotalWithTax() - this.currentOrder.getTotalPaid()  + this.currentOrder.getRoundingApplied()
                ) > 0.00001
            ) {
                var cash = false;
                for (var i = 0; i < this.env.pos.paymentMethods.length; i++) {
                    cash = cash || this.env.pos.paymentMethods[i].isCashCount;
                }
                if (!cash) {
                    this.showPopup('ErrorPopup', {
                        title: this.env._t('Cannot return change without a cash payment method'),
                        body: this.env._t(
                            'There is no cash payment method available in this point of sale to handle the change.\n\n Please pay the exact amount or add a cash payment method in the point of sale configuration'
                        ),
                    });
                    return false;
                }
            }

            // if the change is too large, it's probably an input error, make the user confirm.
            if (
                !isForceValidate &&
                this.currentOrder.getTotalWithTax() > 0 &&
                this.currentOrder.getTotalWithTax() * 1000 < this.currentOrder.getTotalPaid()
            ) {
                this.showPopup('ConfirmPopup', {
                    title: this.env._t('Please Confirm Large Amount'),
                    body:
                        this.env._t('Are you sure that the customer wants to  pay') +
                        ' ' +
                        this.env.pos.formatCurrency(this.currentOrder.getTotalPaid()) +
                        ' ' +
                        this.env._t('for an order of') +
                        ' ' +
                        this.env.pos.formatCurrency(this.currentOrder.getTotalWithTax()) +
                        ' ' +
                        this.env._t('? Clicking "Confirm" will validate the payment.'),
                }).then(({ confirmed }) => {
                    if (confirmed) this.lockedValidateOrder(true);
                });
                return false;
            }

            if (!this._isValidEmptyOrder()) return false;

            return true;
        }
        async _postPushOrderResolve(order, orderServerIds) {
            return true;
        }
        async _sendPaymentRequest({ detail: line }) {
            // Other payment lines can not be reversed anymore
            this.paymentLines.forEach(function (line) {
                line.canBeReversed = false;
            });

            const paymentTerminal = line.paymentMethod.paymentTerminal;
            line.setPaymentStatus('waiting');

            const isPaymentSuccessful = await paymentTerminal.sendPaymentRequest(line.cid);
            if (isPaymentSuccessful) {
                line.setPaymentStatus('done');
                line.canBeReversed = paymentTerminal.supportsReversals;
            } else {
                line.setPaymentStatus('retry');
            }
        }
        async _sendPaymentCancel({ detail: line }) {
            const paymentTerminal = line.paymentMethod.paymentTerminal;
            line.setPaymentStatus('waitingCancel');
            const isCancelSuccessful = await paymentTerminal.setndPaymentCancel(this.currentOrder, line.cid);
            if (isCancelSuccessful) {
                line.setPaymentStatus('retry');
            } else {
                line.setPaymentStatus('waitingCard');
            }
        }
        async _sendPaymentReverse({ detail: line }) {
            const paymentTerminal = line.paymentMethod.paymentTerminal;
            line.setPaymentStatus('reversing');

            const isReversalSuccessful = await paymentTerminal.sendPaymentReversal(line.cid);
            if (isReversalSuccessful) {
                line.setAmount(0);
                line.setPaymentStatus('reversed');
            } else {
                line.canBeReversed = false;
                line.setPaymentStatus('done');
            }
        }
        async _sendForceDone({ detail: line }) {
            line.setPaymentStatus('done');
        }
        _onPrevOrder(prevOrder) {
            prevOrder.off('change', null, this);
            prevOrder.paymentlines.off('change', null, this);
            if (prevOrder) {
                prevOrder.stopElectronicPayment();
            }
        }
        async _onNewOrder(newOrder) {
            newOrder.on('change', this.render, this);
            newOrder.paymentlines.on('change', this.render, this);
            NumberBuffer.reset();
            await this.render();
        }
    }
    PaymentScreen.template = 'PaymentScreen';

    Registries.Component.add(PaymentScreen);

    return PaymentScreen;
});
