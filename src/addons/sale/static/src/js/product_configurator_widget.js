verp.define('sale.productConfigurator', function (require) {
var relationalFields = require('web.relationalFields');
var FieldsRegistry = require('web.fieldRegistry');
var core = require('web.core');
var _t = core._t;

/**
 * The sale.productConfigurator widget is a simple widget extending FieldMany2One
 * It allows the development of configuration strategies in other modules through
 * widget extensions.
 *
 *
 * !!! WARNING !!!
 *
 * This widget is only designed for saleOrderLine creation/updates.
 * !!! It should only be used on a productProduct or productTemplate field !!!
 */
var ProductConfiguratorWidget = relationalFields.FieldMany2One.extend({
    events: _.extend({}, relationalFields.FieldMany2One.prototype.events, {
        'click .o-edit-product-configuration': '_onEditConfiguration'
    }),

     /**
      * @override
      */
    _render: function () {
        this._super.apply(this, arguments);
        if (this.mode === 'edit' && this.value &&
        (this._isConfigurableProduct() || this._isConfigurableLine())) {
            this._addProductLinkButton();
            this._addConfigurationEditButton();
        } else if (this.mode === 'edit' && this.value) {
            this._addProductLinkButton();
            this.$('.o-edit-product-configuration').hide();
        } else {
            this.$('.o-external-button').hide();
            this.$('.o-edit-product-configuration').hide();
        }
    },

    /**
     * Add button linking to productId/productTemplateId form.
     */
    _addProductLinkButton: function () {
        if (this.$('.o-external-button').length === 0) {
            var $productLinkButton = $('<button>', {
                type: 'button',
                class: 'fa fa-external-link btn btn-secondary o-external-button',
                tabindex: '-1',
                draggable: false,
                'aria-label': _t('External Link'),
                title: _t('External Link')
            });

            var $inputDropdown = this.$('.o-input-dropdown');
            $inputDropdown.after($productLinkButton);
        }
    },

    /**
     * If current product is configurable,
     * Show edit button (in Edit Mode) after the product/productTemplate
     */
    _addConfigurationEditButton: function () {
        var $inputDropdown = this.$('.o-input-dropdown');

        if ($inputDropdown.length !== 0 &&
            this.$('.o-edit-product-configuration').length === 0) {
            var $editConfigurationButton = $('<button>', {
                type: 'button',
                class: 'fa fa-pencil btn btn-secondary o-edit-product-configuration',
                tabindex: '-1',
                draggable: false,
                'aria-label': _t('Edit Configuration'),
                title: _t('Edit Configuration')
            });

            $inputDropdown.after($editConfigurationButton);
        }
    },

    /**
     * Hook to override with _onEditProductConfiguration
     * to know if edit pencil button has to be put next to the field
     *
     * @private
     */
    _isConfigurableProduct: function () {
        return false;
    },

    /**
     * Hook to override with _onEditProductConfiguration
     * to know if edit pencil button has to be put next to the field
     *
     * @private
     */
    _isConfigurableLine: function () {
        return false;
    },

    /**
     * Override catching changes on productId or productTemplateId.
     * Calls _onTemplateChange in case of productTemplate change.
     * Calls _onProductChange in case of product change.
     * Shouldn't be overridden by product configurators
     * or only to setup some data for further computation
     * before calling super.
     *
     * @override
     * @param {VerpEvent} ev
     * @param {boolean} ev.data.preventProductIdCheck prevent the product configurator widget
     *     from looping forever when it needs to change the 'productTemplateId'
     *
     * @private
     */
    reset: async function (record, ev) {
        await this._super(...arguments);
        if (ev && ev.target === this) {
            if (ev.data.changes && !ev.data.preventProductIdCheck && ev.data.changes.productTemplateId) {
                this._onTemplateChange(record.data.productTemplateId.data.id, ev.data.dataPointID);
            } else if (ev.data.changes && ev.data.changes.productId) {
                this._onProductChange(record.data.productId.data && record.data.productId.data.id, ev.data.dataPointID).then(wizardOpened => {
                    if (!wizardOpened) {
                        this._onLineConfigured();
                    }
                });
            }
        }
    },

    /**
     * Hook for productTemplate based configurators
     * (product configurator, matrix, ...).
     *
     * @param {integer} productTemplateId
     * @param {String} dataPointID
     *
     * @private
     */
    _onTemplateChange: function (productTemplateId, dataPointId) {
        return Promise.resolve(false);
    },

    /**
     * Hook for productProduct based configurators
     * (event, rental, ...).
     * Should return
     *    true if product has been configured through wizard or
     *        the result of the super call for other wizard extensions
     *    false if the product wasn't configurable through the wizard
     *
     * @param {integer} productId
     * @param {String} dataPointID
     * @returns {Promise<Boolean>} stopPropagation true if a suitable configurator has been found.
     *
     * @private
     */
    _onProductChange: function (productId, dataPointId) {
        return Promise.resolve(false);
    },

    /**
     * Hook for configurator happening after line has been set
     * (options, ...).
     * Allows sale_product_configurator module to apply its options
     * after line configuration has been done.
     *
     * @private
     */
    _onLineConfigured: function () {

    },

    /**
     * Triggered on click of the configuration button.
     * It is only shown in Edit mode,
     * when _isConfigurableProduct or _isConfigurableLine is True.
     *
     * After reflexion, when a line was configured through two wizards,
     * only the line configuration will open.
     *
     * Two hooks are available depending on configurator category:
     * _onEditLineConfiguration : line configurators
     * _onEditProductConfiguration : product configurators
     *
     * @private
     */
    _onEditConfiguration: function () {
        if (this._isConfigurableLine()) {
            this._onEditLineConfiguration();
        } else if (this._isConfigurableProduct()) {
            this._onEditProductConfiguration();
        }
    },

    /**
     * Hook for line configurators (rental, event)
     * on line edition (pencil icon inside product field)
     */
    _onEditLineConfiguration: function () {

    },

    /**
     * Hook for product configurators (matrix, product)
     * on line edition (pencil icon inside product field)
     */
    _onEditProductConfiguration: function () {

    },

    /**
     * Utilities for recordData conversion
     */

    /**
     * Will convert the values contained in the recordData parameter to
     * a list of '4' operations that can be passed as a 'default_' parameter.
     *
     * @param {Object} recordData
     *
     * @private
     */
    _convertFromMany2Many: function (recordData) {
        if (recordData) {
            var convertedValues = [];
            _.each(recordData.resIds, function (resId) {
                convertedValues.push([4, parseInt(resId)]);
            });

            return convertedValues;
        }

        return null;
    },

    /**
     * Will convert the values contained in the recordData parameter to
     * a list of '0' or '4' operations (based on wether the record is already persisted or not)
     * that can be passed as a 'default_' parameter.
     *
     * @param {Object} recordData
     *
     * @private
     */
    _convertFromOne2Many: function (recordData) {
        if (recordData) {
            var convertedValues = [];
            _.each(recordData.resIds, function (resId) {
                if (isNaN(resId)) {
                    _.each(recordData.data, function (record) {
                        if (record.ref === resId) {
                            convertedValues.push([0, 0, {
                                customProductTemplateAttributeValueId: record.data.customProductTemplateAttributeValueId.data.id,
                                customValue: record.data.customValue
                            }]);
                        }
                    });
                } else {
                    convertedValues.push([4, resId]);
                }
            });

            return convertedValues;
        }

        return null;
    }
});

FieldsRegistry.add('productConfigurator', ProductConfiguratorWidget);

return ProductConfiguratorWidget;

});
