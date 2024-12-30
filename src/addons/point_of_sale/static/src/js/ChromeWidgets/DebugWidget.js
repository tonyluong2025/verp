verp.define('point_of_sale.DebugWidget', function (require) {
    'use strict';

    const { useState } = owl;
    const { useRef } = owl.hooks;
    const { getFileAsText } = require('point_of_sale.utils');
    const { parse } = require('web.fieldUtils');
    const NumberBuffer = require('point_of_sale.NumberBuffer');
    const PosComponent = require('point_of_sale.PosComponent');
    const Registries = require('point_of_sale.Registries');

    class DebugWidget extends PosComponent {
        constructor() {
            super(...arguments);
            this.state = useState({
                barcodeInput: '',
                weightInput: '',
                isPaidOrdersReady: false,
                isUnpaidOrdersReady: false,
                buffer: NumberBuffer.get(),
            });

            // NOTE: Perhaps this can still be improved.
            // What we do here is loop thru the `event` elements
            // then we assign animation that happens when the event is triggered
            // in the proxy. E.g. if openCashbox is sent, the openCashbox element
            // changes color from '#6CD11D' to '#1E1E1E' for a duration of 2sec.
            this.eventElementsRef = {};
            this.animations = {};
            for (let eventName of ['openCashbox', 'printReceipt', 'scaleRead']) {
                this.eventElementsRef[eventName] = useRef(eventName);
                this.env.pos.proxy.addNotification(
                    eventName,
                    (() => {
                        if (this.animations[eventName]) {
                            this.animations[eventName].cancel();
                        }
                        const eventElement = this.eventElementsRef[eventName].el;
                        eventElement.style.backgroundColor = '#6CD11D';
                        this.animations[eventName] = eventElement.animate(
                            { backgroundColor: ['#6CD11D', '#1E1E1E'] },
                            2000
                        );
                    }).bind(this)
                );
            }
        }
        mounted() {
            NumberBuffer.on('buffer-update', this, this._onBufferUpdate);
        }
        willUnmount() {
            NumberBuffer.off('buffer-update', this, this._onBufferUpdate);
        }
        toggleWidget() {
            this.state.isShown = !this.state.isShown;
        }
        setWeight() {
            var weightInKg = parse.float(this.state.weightInput);
            if (!isNaN(weightInKg)) {
                this.env.pos.proxy.debugSetWeight(weightInKg);
            }
        }
        resetWeight() {
            this.state.weightInput = '';
            this.env.pos.proxy.debugResetWeight();
        }
        async barcodeScan() {
            await this.env.pos.barcodeReader.scan(this.state.barcodeInput);
        }
        async barcodeScanEAN() {
            const ean = this.env.pos.barcodeReader.barcodeParser.sanitizeEan(
                this.state.barcodeInput || '0'
            );
            this.state.barcodeInput = ean;
            await this.env.pos.barcodeReader.scan(ean);
        }
        async deleteOrders() {
            const { confirmed } = await this.showPopup('ConfirmPopup', {
                title: this.env._t('Delete Paid Orders ?'),
                body: this.env._t(
                    'This operation will permanently destroy all paid orders from the local storage. You will lose all the data. This operation cannot be undone.'
                ),
            });
            if (confirmed) {
                this.env.pos.db.removeAllOrders();
                this.env.pos.setSynch('connected', 0);
            }
        }
        async deleteUnpaidOrders() {
            const { confirmed } = await this.showPopup('ConfirmPopup', {
                title: this.env._t('Delete Unpaid Orders ?'),
                body: this.env._t(
                    'This operation will destroy all unpaid orders in the browser. You will lose all the unsaved data and exit the point of sale. This operation cannot be undone.'
                ),
            });
            if (confirmed) {
                this.env.pos.db.removeAllUnpaidOrders();
                window.location = '/';
            }
        }
        _createBlob(contents) {
            if (typeof contents !== 'string') {
                contents = JSON.stringify(contents, null, 2);
            }
            return new Blob([contents]);
        }
        // IMPROVEMENT: Duplicated codes for downloading paid and unpaid orders.
        // The implementation can be better.
        preparePaidOrders() {
            try {
                this.paidOrdersBlob = this._createBlob(this.env.pos.exportPaidOrders());
                this.state.isPaidOrdersReady = true;
            } catch (error) {
                console.warn(error);
            }
        }
        get paidOrdersFilename() {
            return `${this.env._t('paid orders')} ${moment().format('YYYY-MM-DD-HH-mm-ss')}.json`;
        }
        get paidOrdersURL() {
            var URL = window.URL || window.webkitURL;
            return URL.createObjectURL(this.paidOrdersBlob);
        }
        prepareUnpaidOrders() {
            try {
                this.unpaidOrdersBlob = this._createBlob(this.env.pos.exportUnpaidOrders());
                this.state.isUnpaidOrdersReady = true;
            } catch (error) {
                console.warn(error);
            }
        }
        get unpaidOrdersFilename() {
            return `${this.env._t('unpaid orders')} ${moment().format('YYYY-MM-DD-HH-mm-ss')}.json`;
        }
        get unpaidOrdersURL() {
            var URL = window.URL || window.webkitURL;
            return URL.createObjectURL(this.unpaidOrdersBlob);
        }
        async importOrders(event) {
            const file = event.target.files[0];
            if (file) {
                const report = this.env.pos.importOrders(await getFileAsText(file));
                await this.showPopup('OrderImportPopup', { report });
            }
        }
        refreshDisplay() {
            this.env.pos.proxy.message('displayRefresh', {});
        }
        _onBufferUpdate(buffer) {
            this.state.buffer = buffer;
        }
        get bufferRepr() {
            return `"${this.state.buffer}"`;
        }
    }
    DebugWidget.template = 'DebugWidget';

    Registries.Component.add(DebugWidget);

    return DebugWidget;
});
