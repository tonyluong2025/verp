verp.define('barcodes.field', function(require) {
"use strict";

var AbstractField = require('web.AbstractField');
var basicFields = require('web.basicFields');
var fieldRegistry = require('web.fieldRegistry');
var BarcodeEvents = require('barcodes.BarcodeEvents').BarcodeEvents;

// Field in which the user can both type normally and scan barcodes

var FieldFloatScannable = basicFields.FieldFloat.extend({
    events: _.extend({}, basicFields.FieldFloat.prototype.events, {
        // The barcodeEvents component intercepts keypresses and releases them when it
        // appears they are not part of a barcode. But since released keypresses don't
        // trigger native behaviour (like characters input), we must simulate it.
        keypress: '_onKeypress',
    }),

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * @override
     * @private
     */
    _renderEdit: function () {
        var self = this;
        return Promise.resolve(this._super()).then(function () {
            self.$input.data('enableBarcode', true);
        });
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * @private
     * @param {KeyboardEvent} e
     */
    _onKeypress: function (e) {
        /* only simulate a keypress if it has been previously prevented */
        if (e.dispatchedByBarcodeReader !== true) {
            if (!BarcodeEvents.isSpecialKey(e)) {
                e.preventDefault();
            }
            return;
        }
        var character = String.fromCharCode(e.which);
        var currentStr = e.target.value;
        var strBeforeCarret = currentStr.substring(0, e.target.selectionStart);
        var strAfterCarret = currentStr.substring(e.target.selectionEnd);
        e.target.value = strBeforeCarret + character + strAfterCarret;
        var newCarretIndex = strBeforeCarret.length + character.length;
        e.target.setSelectionRange(newCarretIndex, newCarretIndex);
        // trigger an 'input' event to notify the widget that it's value changed
        $(e.target).trigger('input');
    },
});

// Field to use scan barcodes
var FormViewBarcodeHandler = AbstractField.extend({
    /**
     * @override
     */
    init: function() {
        this._super.apply(this, arguments);

        this.triggerUp('activeBarcode', {
            name: this.name,
            commands: {
                barcode: '_barcodeAddX2MQuantity',
            }
        });
    },
});

fieldRegistry.add('fieldFloatScannable', FieldFloatScannable);
fieldRegistry.add('barcodeHandler', FormViewBarcodeHandler);

return {
    FieldFloatScannable: FieldFloatScannable,
    FormViewBarcodeHandler: FormViewBarcodeHandler,
};

});
