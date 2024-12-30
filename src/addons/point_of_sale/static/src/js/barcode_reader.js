verp.define('point_of_sale.BarcodeReader', function (require) {
"use strict";

var concurrency = require('web.concurrency');
var core = require('web.core');
var Mutex = concurrency.Mutex;

// this module interfaces with the barcode reader. It assumes the barcode reader
// is set-up to act like  a keyboard. Use connect() and disconnect() to activate
// and deactivate the barcode reader. Use setActionCallbacks to tell it
// what to do when it reads a barcode.
var BarcodeReader = core.Class.extend({
    actions:[
        'product',
        'cashier',
        'client',
    ],

    init: function (attributes) {
        this.mutex = new Mutex();
        this.pos = attributes.pos;
        this.actionCallbacks = {};
        this.exclusiveCallbacks = {};
        this.proxy = attributes.proxy;
        this.remoteScanning = false;
        this.remoteActive = 0;

        this.barcodeParser = attributes.barcodeParser;

        this.actionCallbackStack = [];

        core.bus.on('barcodeScanned', this, function (barcode) {
            // use mutex to make sure scans are done one after the other
            this.mutex.exec(async () => {
                await this.scan(barcode);
            });
        });
    },

    setBarcodeParser: function (barcodeParser) {
        this.barcodeParser = barcodeParser;
    },

    // when a barcode is scanned and parsed, the callback corresponding
    // to its type is called with the parsedBarcode as a parameter.
    // (parsedBarcode is the result of parseBarcode(barcode))
    //
    // callbacks is a Map of 'actions' : callback(parsedBarcode)
    // that sets the callback for each action. if a callback for the
    // specified action already exists, it is replaced.
    //
    // possible actions include :
    // 'product' | 'cashier' | 'client' | 'discount'
    setActionCallback: function (name, callback) {
        if (this.actionCallbacks[name]) {
            this.actionCallbacks[name].add(callback);
        } else {
            this.actionCallbacks[name] = new Set([callback]);
        }
    },

    removeActionCallback: function(name, callback) {
        if (!callback) {
            delete this.actionCallbacks[name];
            return;
        }
        const callbacks = this.actionCallbacks[name];
        if (callbacks) {
            callbacks.delete(callback);
            if (callbacks.size === 0) {
                delete this.actionCallbacks[name];
            }
        }
    },

    /**
     * Allow setting of exclusive callbacks. If there are exclusive callbacks,
     * these callbacks are called neglecting the regular callbacks. This is
     * useful for rendered Components that wants to take exclusive access
     * to the barcode reader.
     *
     * @param {String} name
     * @param {Function} callback function that takes parsed barcode
     */
    setExclusiveCallback: function (name, callback) {
        if (this.exclusiveCallbacks[name]) {
            this.exclusiveCallbacks[name].add(callback);
        } else {
            this.exclusiveCallbacks[name] = new Set([callback]);
        }
    },

    removeExclusiveCallback: function (name, callback) {
        if (!callback) {
            delete this.exclusiveCallbacks[name];
            return;
        }
        const callbacks = this.exclusiveCallbacks[name];
        if (callbacks) {
            callbacks.delete(callback);
            if (callbacks.size === 0) {
                delete this.exclusiveCallbacks[name];
            }
        }
    },

    scan: async function (code) {
        if (!code) return;

        const callbacks = Object.keys(this.exclusiveCallbacks).length
            ? this.exclusiveCallbacks
            : this.actionCallbacks;
        let parsedResults = this.barcodeParser.parseBarcode(code);
        if (! Array.isArray(parsedResults)) {
            parsedResults = [parsedResults];
        }
        for (const parsedResult of parsedResults) {
            if (callbacks[parsedResult.type]) {
                for (const cb of callbacks[parsedResult.type]) {
                    await cb(parsedResult);
                }
            } else if (callbacks.error) {
                [...callbacks.error].map(cb => cb(parsedResult));
            } else {
                console.warn('Ignored Barcode Scan:', parsedResult);
            }
        }
    },

    // the barcode scanner will listen on the hw_proxy/scanner interface for
    // scan events until disconnectFromProxy is called
    connectToProxy: function () {
        var self = this;
        this.remoteScanning = true;
        if (this.remoteActive >= 1) {
            return;
        }
        this.remoteActive = 1;

        function waitforbarcode(){
            return self.proxy.connection.rpc('/hw_proxy/scanner',{},{shadow: true, timeout:7500})
                .then(function (barcode) {
                    if (!self.remoteScanning) {
                        self.remoteActive = 0;
                        return;
                    }
                    self.scan(barcode);
                    waitforbarcode();
                },
                function () {
                    if (!self.remoteScanning) {
                        self.remoteActive = 0;
                        return;
                    }
                    waitforbarcode();
                });
        }
        waitforbarcode();
    },

    // the barcode scanner will stop listening on the hw_proxy/scanner remote interface
    disconnectFromProxy: function () {
        this.remoteScanning = false;
    },
});

return BarcodeReader;

});
