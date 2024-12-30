/* global html2canvas */
verp.define('point_of_sale.Printer', function (require) {
"use strict";

var Session = require('web.Session');
var core = require('web.core');
const { Gui } = require('point_of_sale.Gui');
var _t = core._t;

// IMPROVEMENT: This is too much. We can get away from this class.
class PrintResult {
    constructor({ successful, message }) {
        this.successful = successful;
        this.message = message;
    }
}

class PrintResultGenerator {
    IoTActionError() {
        return new PrintResult({
            successful: false,
            message: {
                title: _t('Connection to IoT Box failed'),
                body: _t('Please check if the IoT Box is still connected.'),
            },
        });
    }
    IoTResultError() {
        return new PrintResult({
            successful: false,
            message: {
                title: _t('Connection to the printer failed'),
                body: _t('Please check if the printer is still connected. \n' +
                    'Some browsers don\'t allow HTTP calls from websites to devices in the network (for security reasons). ' +
                    'If it is the case, you will need to follow Verp\'s documentation for ' +
                    '\'Self-signed certificate for ePOS printers\' and \'Secure connection (HTTPS)\' to solve the issue'
                ),
            },
        });
    }
    Successful() {
        return new PrintResult({
            successful: true,
        });
    }
}

var PrinterMixin = {
    init: function (pos) {
        this.receiptQueue = [];
        this.printResultGenerator = new PrintResultGenerator();
        this.pos = pos;
    },

    /**
     * Add the receipt to the queue of receipts to be printed and process it.
     * We clear the print queue if printing is not successful.
     * @param {String} receipt: The receipt to be printed, in HTML
     * @returns {PrintResult}
     */
    printReceipt: async function(receipt) {
        if (receipt) {
            this.receiptQueue.push(receipt);
        }
        let image, sendPrintResult;
        while (this.receiptQueue.length > 0) {
            receipt = this.receiptQueue.shift();
            image = await this.htmlToImg(receipt);
            try {
                sendPrintResult = await this.sendPrintingJob(image);
            } catch (error) {
                // Error in communicating to the IoT box.
                this.receiptQueue.length = 0;
                return this.printResultGenerator.IoTActionError();
            }
            // rpc call is okay but printing failed because
            // IoT box can't find a printer.
            if (!sendPrintResult || sendPrintResult.result === false) {
                this.receiptQueue.length = 0;
                return this.printResultGenerator.IoTResultError(sendPrintResult.printerErrorCode);
            }
        }
        return this.printResultGenerator.Successful();
    },

    /**
     * Generate a jpeg image from a canvas
     * @param {DOMElement} canvas
     */
    processCanvas: function (canvas) {
        return canvas.toDataURL('image/jpeg').replace('data:image/jpeg;base64,','');
    },

    /**
     * Renders the html as an image to print it
     * @param {String} receipt: The receipt to be printed, in HTML
     */
    htmlToImg: function (receipt) {
        var self = this;
        $('.pos-receipt-print').html(receipt);
        var promise = new Promise(function (resolve, reject) {
            self.receipt = $('.pos-receipt-print>.pos-receipt');
            html2canvas(self.receipt[0], {
                onparsed: function(queue) {
                    queue.stack.ctx.height = Math.ceil(self.receipt.outerHeight() + self.receipt.offset().top);
                    queue.stack.ctx.width = Math.ceil(self.receipt.outerWidth() + 2 * self.receipt.offset().left);
                },
                onrendered: function (canvas) {
                    $('.pos-receipt-print').empty();
                    resolve(self.processCanvas(canvas));
                },
                letterRendering: self.pos.htmlToImgLetterRendering(),
            })
        });
        return promise;
    },

    _onIoTActionResult: function (data){
        if (this.pos && (data === false || data.result === false)) {
            Gui.showPopup('ErrorPopup',{
                'title': _t('Connection to the printer failed'),
                'body':  _t('Please check if the printer is still connected.'),
            });
        }
    },

    _onIoTActionFail: function () {
        if (this.pos) {
            Gui.showPopup('ErrorPopup',{
                'title': _t('Connection to IoT Box failed'),
                'body':  _t('Please check if the IoT Box is still connected.'),
            });
        }
    },
}

var Printer = core.Class.extend(PrinterMixin, {
    init: function (url, pos) {
        PrinterMixin.init.call(this, pos);
        this.connection = new Session(undefined, url || 'http://localhost:8069', { useCors: true});
    },

    /**
     * Sends a command to the connected proxy to open the cashbox
     * (the physical box where you store the cash). Updates the status of
     * the printer with the answer from the proxy.
     */
    openCashbox: function () {
        var self = this;
        return this.connection.rpc('/hw_proxy/defaultPrinterAction', {
            data: {
                action: 'cashbox'
            }
        }).then(self._onIoTActionResult.bind(self))
            .guardedCatch(self._onIoTActionFail.bind(self));
    },

    /**
     * Sends the printing command the connected proxy
     * @param {String} img : The receipt to be printed, as an image
     */
    sendPrintingJob: function (img) {
        return this.connection.rpc('/hw_proxy/defaultPrinterAction', {
            data: {
                action: 'printReceipt',
                receipt: img,
            }
        });
    },
});

return {
    PrinterMixin: PrinterMixin,
    Printer: Printer,
    PrintResult,
    PrintResultGenerator,
}
});
