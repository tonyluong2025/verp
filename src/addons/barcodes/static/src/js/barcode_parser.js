verp.define('barcodes.BarcodeParser', function (require) {
"use strict";

var Class = require('web.Class');
var rpc = require('web.rpc');

// The BarcodeParser is used to detect what is the category
// of a barcode (product, partner, ...) and extract an encoded value
// (like weight, price, etc.)
var BarcodeParser = Class.extend({
    init: function(attributes) {
        this.nomenclatureId = attributes.nomenclatureId;
        this.nomenclature = attributes.nomenclature;
        this.loaded = this.load();
    },

    // This loads the barcode nomenclature and barcode rules which are
    // necessary to parse the barcodes. The BarcodeParser is operational
    // only when those data have been loaded
    load: function(){
        if (!this.nomenclatureId) {
            return this.nomenclature ? Promise.resolve() : Promise.reject();
        }
        var id = this.nomenclatureId[0];
        return rpc.query({
                model: 'barcode.nomenclature',
                method: 'read',
                args: [[id], this._barcodeNomenclatureFields()],
            }).then(nomenclatures => {
                this.nomenclature = nomenclatures[0];
                var args = [
                    [['barcodeNomenclatureId', '=', this.nomenclature.id]],
                    this._barcodeRuleFields(),
                ];
                return rpc.query({
                    model: 'barcode.rule',
                    method: 'searchRead',
                    args: args,
                });
            }).then(rules => {
                rules = rules.sort(function(a, b){ return a.sequence - b.sequence; });
                this.nomenclature.rules = rules;
            });
    },

    // resolves when the barcode parser is operational.
    isLoaded: function() {
        return this.loaded;
    },

    /**
     * This algorithm is identical for all fixed length numeric GS1 data structures.
     *
     * It is also valid for EAN-8, EAN-12 (UPC-A), EAN-13 check digit after sanitizing.
     * https://www.gs1.org/sites/default/files/docs/barcodes/GS1_General_Specifications.pdf
     *
     * @param {String} numericBarcode Need to have a length of 18
     * @returns {number} Check Digit
     */
    getBarcodeCheckDigit(numericBarcode) {
        let oddsum = 0, evensum = 0, total = 0;
        // Reverses the barcode to be sure each digit will be in the right place
        // regardless the barcode length.
        const code = numericBarcode.split('').reverse();
        // Removes the last barcode digit (should not be took in account for its own computing).
        code.shift();

        // Multiply value of each position by
        // N1  N2  N3  N4  N5  N6  N7  N8  N9  N10 N11 N12 N13 N14 N15 N16 N17 N18
        // x3  X1  x3  x1  x3  x1  x3  x1  x3  x1  x3  x1  x3  x1  x3  x1  x3  CHECK_DIGIT
        for (let i = 0; i < code.length; i++) {
            if (i % 2 === 0) {
                evensum += parseInt(code[i]);
            } else {
                oddsum += parseInt(code[i]);
            }
        }
        total = evensum * 3 + oddsum;
        return (10 - total % 10) % 10;
    },

    /**
     * Checks if the barcode string is encoded with the provided encoding.
     *
     * @param {String} barcode
     * @param {String} encoding could be 'any' (no encoding rules), 'ean8', 'upca' or 'ean13'
     * @returns {boolean}
     */
    checkEncoding: function(barcode, encoding) {
        if (encoding === 'any') {
            return true;
        }
        const barcodeSizes = {
            ean8: 8,
            ean13: 13,
            upca: 12,
        };
        return barcode.length === barcodeSizes[encoding] && /^\d+$/.test(barcode) &&
            this.getBarcodeCheckDigit(barcode) === parseInt(barcode[barcode.length - 1]);
    },

    /**
     * Sanitizes a EAN-13 prefix by padding it with chars zero.
     *
     * @param {String} ean
     * @returns {String}
     */
    sanitizeEan: function(ean){
        ean = ean.substr(0, 13);
        ean = "0".repeat(13 - ean.length) + ean;
        return ean.substr(0, 12) + this.getBarcodeCheckDigit(ean);
    },

    /**
     * Sanitizes a UPC-A prefix by padding it with chars zero.
     *
     * @param {String} upc
     * @returns {String}
     */
    sanitizeUpc: function(upc) {
        return this.sanitizeEan(upc).substr(1, 12);
    },

    // Checks if barcode matches the pattern
    // Additionnaly retrieves the optional numerical content in barcode
    // Returns an object containing:
    // - value: the numerical value encoded in the barcode (0 if no value encoded)
    // - baseCode: the barcode in which numerical content is replaced by 0's
    // - match: boolean
    matchPattern: function (barcode, pattern, encoding){
        var match = {
            value: 0,
            baseCode: barcode,
            match: false,
        };
        barcode = barcode.replace("\\", "\\\\").replace("{", '\{').replace("}", "\}").replace(".", "\.");

        var numericalContent = pattern.match(/[{][N]*[D]*[}]/); // look for numerical content in pattern
        var base_pattern = pattern;
        if(numericalContent){ // the pattern encodes a numerical content
            var numStart = numericalContent.index; // start index of numerical content
            var numLength = numericalContent[0].length; // length of numerical content
            var valueString = barcode.substr(numStart, numLength-2); // numerical content in barcode
            var wholePartMatch = numericalContent[0].match("[{][N]*[D}]"); // looks for whole part of numerical content
            var decimalPartMatch = numericalContent[0].match("[{N][D]*[}]"); // looks for decimal part
            var wholePart = valueString.substr(0, wholePartMatch.index+wholePartMatch[0].length-2); // retrieve whole part of numerical content in barcode
            var decimalPart = "0." + valueString.substr(decimalPartMatch.index, decimalPartMatch[0].length-1); // retrieve decimal part
            if (wholePart === ''){
                wholePart = '0';
            }
            match.value = parseInt(wholePart) + parseFloat(decimalPart);

            // replace numerical content by 0's in barcode and pattern
            match.baseCode = barcode.substr(0, numStart);
            basePattern = pattern.substr(0, numStart);
            for(var i=0;i<(numLength-2);i++) {
                match.baseCode += "0";
                basePattern += "0";
            }
            match.baseCode += barcode.substr(numStart + numLength - 2, barcode.length - 1);
            basePattern += pattern.substr(numStart + numLength, pattern.length - 1);

            match.baseCode = match.baseCode
                .replace("\\\\", "\\")
                .replace("\{", "{")
                .replace("\}","}")
                .replace("\.",".");

            var baseCode = match.baseCode.split('');
            if (encoding === 'ean13') {
                baseCode[12] = '' + this.getBarcodeCheckDigit(match.baseCode);
            } else if (encoding === 'ean8') {
                baseCode[7]  = '' + this.getBarcodeCheckDigit(match.baseCode);
            } else if (encoding === 'upca') {
                baseCode[11] = '' + this.getBarcodeCheckDigit(match.baseCode);
            }
            match.baseCode = baseCode.join('');
        }

        if (basePattern[0] !== '^') {
            basePattern = "^" + basePattern;
        }
        match.match = match.baseCode.match(basePattern);

        return match;
    },

    /**
     * Attempts to interpret a barcode (string encoding a barcode Code-128)
     *
     * @param {string} barcode
     * @returns {Object} the returned object containing informations about the barcode:
     *      - code: the barcode
     *      - type: the type of the barcode (e.g. alias, unit product, weighted product...)
     *      - value: if the barcode encodes a numerical value, it will be put there
     *      - baseCode: the barcode with all the encoding parts set to zero; the one put on the product in the backend
     */
    parseBarcode: function(barcode){
        var parsedResult = {
            encoding: '',
            type:'error',
            code:barcode,
            baseCode: barcode,
            value: 0,
        };

        if (!this.nomenclature) {
            return parsedResult;
        }

        var rules = this.nomenclature.rules;
        for (var i = 0; i < rules.length; i++) {
            var rule = rules[i];
            var curBarcode = barcode;

            if (    rule.encoding === 'ean13' &&
                    this.checkEncoding(barcode,'upca') &&
                    this.nomenclature.upcEanConv in {'upc2ean':'','always':''} ){
                curBarcode = '0' + curBarcode;
            } else if (rule.encoding === 'upca' &&
                    this.checkEncoding(barcode,'ean13') &&
                    barcode[0] === '0' &&
                    this.upcEanConv in {'ean2upc':'','always':''} ){
                curBarcode = curBarcode.substr(1,12);
            }

            if (!this.checkEncoding(curBarcode,rule.encoding)) {
                continue;
            }

            var match = this.matchPattern(curBarcode, rules[i].pattern, rule.encoding);
            if (match.match) {
                if(rules[i].type === 'alias') {
                    barcode = rules[i].alias;
                    parsedResult.code = barcode;
                    parsedResult.type = 'alias';
                }
                else {
                    parsedResult.encoding  = rules[i].encoding;
                    parsedResult.type      = rules[i].type;
                    parsedResult.value     = match.value;
                    parsedResult.code      = curBarcode;
                    if (rules[i].encoding === "ean13"){
                        parsedResult.baseCode = this.sanitizeEan(match.baseCode);
                    }
                    else{
                        parsedResult.baseCode = match.baseCode;
                    }
                    return parsedResult;
                }
            }
        }
        return parsedResult;
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    _barcodeNomenclatureFields: function () {
        return [
            'label',
            'ruleIds',
            'upcEanConv',
        ];
    },

    _barcodeRuleFields: function () {
        return [
            'label',
            'sequence',
            'type',
            'encoding',
            'pattern',
            'alias',
        ];
    },
});

return BarcodeParser;
});
