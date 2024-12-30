/** @verp-module alias=stock.countedQuantityWidget **/

import BasicFields from 'web.basicFields';
import fieldRegistry from 'web.fieldRegistry';

const CountedQuantityWidgetField = BasicFields.FieldFloat.extend({
    supportedFieldTypes: ['float'],

     _renderReadonly: function () {
        if (this.recordData.inventoryQuantitySet) {
            this.el.textContent = this._formatValue(this.recordData.inventoryQuantity);
        } else {
            this.el.textContent = "";
        }
    },

    _onchange: function () {
        if (!this.recordData.inventoryQuantitySet) {
            this.recordData.inventoryQuantitySet = true;
        }
        this._super.apply(this);
    },

    _isSameValue: function(value) {
        // We want to trigger the update of the view when inserting 0
        if (value == 0) {
            return false;
        }
        return this._super(...arguments);
    }

});

fieldRegistry.add('countedQuantityWidget', CountedQuantityWidgetField);

export default CountedQuantityWidgetField;
