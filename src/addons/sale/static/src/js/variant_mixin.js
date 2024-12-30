verp.define('sale.VariantMixin', function (require) {
'use strict';

var concurrency = require('web.concurrency');
var core = require('web.core');
var utils = require('web.utils');
var ajax = require('web.ajax');
var _t = core._t;

var VariantMixin = {
    events: {
        'change .css-attribute-color input': '_onChangeColorAttribute',
        'change .main-product:not(.in-cart) input.js-quantity': 'onChangeAddQuantity',
        'change [data-attribute-exclusions]': 'onChangeVariant'
    },

    //--------------------------------------------------------------------------
    // Public
    //--------------------------------------------------------------------------

    /**
     * When a variant is changed, this will check:
     * - If the selected combination is available or not
     * - The extra price if applicable
     * - The display name of the product ("Customizable desk (White, Steel)")
     * - The new total price
     * - The need of adding a "custom value" input
     *   If the custom value is the only available value
     *   (defined by its data 'isSingleAndCustom'),
     *   the custom value will have it's own input & label
     *
     * 'change' events triggered by the user entered custom values are ignored since they
     * are not relevant
     *
     * @param {MouseEvent} ev
     */
    onChangeVariant: function (ev) {
        var $parent = $(ev.target).closest('.js-product');
        if (!$parent.data('uniqueId')) {
            $parent.data('uniqueId', _.uniqueId());
        }
        this._throttledGetCombinationInfo($parent.data('uniqueId'))(ev);
    },
    /**
     * @see onChangeVariant
     *
     * @private
     * @param {Event} ev
     * @returns {Deferred}
     */
    _getCombinationInfo: function (ev) {
        if ($(ev.target).hasClass('variant-custom-value')) {
            return Promise.resolve();
        }

        const $parent = $(ev.target).closest('.js-product');
        const combination = this.getSelectedVariantValues($parent);
        let parentCombination;

        if ($parent.hasClass('main-product')) {
            parentCombination = $parent.find('ul[data-attribute-exclusions]').data('attribute-exclusions').parentCombination;
            const $optProducts = $parent.parent().find(`[data-parent-unique-id='${$parent.data('uniqueId')}']`);

            for (const optionalProduct of $optProducts) {
                const $currentOptionalProduct = $(optionalProduct);
                const childCombination = this.getSelectedVariantValues($currentOptionalProduct);
                const productTemplateId = parseInt($currentOptionalProduct.find('.productTemplateId').val());
                ajax.jsonRpc(this._getUri('/sale/getCombinationInfo'), 'call', {
                    'productTemplateId': productTemplateId,
                    'productId': this._getProductId($currentOptionalProduct),
                    'combination': childCombination,
                    'addQty': parseInt($currentOptionalProduct.find('input[name="addQty"]').val()),
                    'pricelistId': this.pricelistId || false,
                    'parentCombination': combination,
                }).then((combinationData) => {
                    this._onChangeCombination(ev, $currentOptionalProduct, combinationData);
                    this._checkExclusions($currentOptionalProduct, childCombination, combinationData.parentExclusions);
                });
            }
        } else {
            parentCombination = this.getSelectedVariantValues(
                $parent.parent().find('.js-product.in-cart.main-product')
            );
        }

        return ajax.jsonRpc(this._getUri('/sale/getCombinationInfo'), 'call', {
            'productTemplateId': parseInt($parent.find('.productTemplateId').val()),
            'productId': this._getProductId($parent),
            'combination': combination,
            'addQty': parseInt($parent.find('input[name="addQty"]').val()),
            'pricelistId': this.pricelistId || false,
            'parentCombination': parentCombination,
        }).then((combinationData) => {
            this._onChangeCombination(ev, $parent, combinationData);
            this._checkExclusions($parent, combination, combinationData.parentExclusions);
        });
    },

    /**
     * Will add the "custom value" input for this attribute value if
     * the attribute value is configured as "custom" (see productAttributeValue.isCustom)
     *
     * @private
     * @param {MouseEvent} ev
     */
    handleCustomValues: function ($target) {
        var $variantContainer;
        var $customInput = false;
        if ($target.is('input[type=radio]') && $target.is(':checked')) {
            $variantContainer = $target.closest('ul').closest('li');
            $customInput = $target;
        } else if ($target.is('select')) {
            $variantContainer = $target.closest('li');
            $customInput = $target
                .find('option[value="' + $target.val() + '"]');
        }

        if ($variantContainer) {
            if ($customInput && $customInput.data('isCustom') === 'True') {
                var attributeValueId = $customInput.data('valueId');
                var attributeValueName = $customInput.data('valueName');

                if ($variantContainer.find('.variant-custom-value').length === 0
                        || $variantContainer
                              .find('.variant-custom-value')
                              .data('customProductTemplateAttributeValueId') !== parseInt(attributeValueId)) {
                    $variantContainer.find('.variant-custom-value').remove();

                    const previousCustomValue = $customInput.attr("previousCustomValue");
                    var $input = $('<input>', {
                        type: 'text',
                        'data-customProductTemplateAttributeValueId': attributeValueId,
                        'data-attributeValueName': attributeValueName,
                        class: 'variant-custom-value form-control mt-2'
                    });

                    $input.attr('placeholder', attributeValueName);
                    $input.addClass('custom-value-radio');
                    $variantContainer.append($input);
                    if (previousCustomValue) {
                        $input.val(previousCustomValue);
                    }
                }
            } else {
                $variantContainer.find('.variant-custom-value').remove();
            }
        }
    },

    /**
     * Hack to add and remove from cart with json
     *
     * @param {MouseEvent} ev
     */
    onClickAddCartJSON: function (ev) {
        ev.preventDefault();
        var $link = $(ev.currentTarget);
        var $input = $link.closest('.input-group').find("input");
        var min = parseFloat($input.data("min") || 0);
        var max = parseFloat($input.data("max") || Infinity);
        var previousQty = parseFloat($input.val() || 0, 10);
        var quantity = ($link.has(".fa-minus").length ? -1 : 1) + previousQty;
        var newQty = quantity > min ? (quantity < max ? quantity : max) : min;

        if (newQty !== previousQty) {
            $input.val(newQty).trigger('change');
        }
        return false;
    },

    /**
     * When the quantity is changed, we need to query the new price of the product.
     * Based on the price list, the price might change when quantity exceeds X
     *
     * @param {MouseEvent} ev
     */
    onChangeAddQuantity: function (ev) {
        var $parent;

        if ($(ev.currentTarget).closest('.oe-advanced-configurator-modal').length > 0){
            $parent = $(ev.currentTarget).closest('.oe-advanced-configurator-modal');
        } else if ($(ev.currentTarget).closest('form').length > 0){
            $parent = $(ev.currentTarget).closest('form');
        }  else {
            $parent = $(ev.currentTarget).closest('.o-product-configurator');
        }

        this.triggerVariantChange($parent);
    },

    /**
     * Triggers the price computation and other variant specific changes
     *
     * @param {$.Element} $container
     */
    triggerVariantChange: function ($container) {
        var self = this;
        $container.find('ul[data-attribute-exclusions]').trigger('change');
        $container.find('input.js-variant-change:checked, select.js-variant-change').each(function () {
            self.handleCustomValues($(this));
        });
    },

    /**
     * Will look for user custom attribute values
     * in the provided container
     *
     * @param {$.Element} $container
     * @returns {Array} array of custom values with the following format
     *   {integer} customProductTemplateAttributeValueId
     *   {string} attributeValueName
     *   {string} customValue
     */
    getCustomVariantValues: function ($container) {
        var variantCustomValues = [];
        $container.find('.variant-custom-value').each(function (){
            var $variantCustomValueInput = $(this);
            if ($variantCustomValueInput.length !== 0){
                variantCustomValues.push({
                    'customProductTemplateAttributeValueId': $variantCustomValueInput.data('customProductTemplateAttributeValueId'),
                    'attributeValueName': $variantCustomValueInput.data('attributeValueName'),
                    'customValue': $variantCustomValueInput.val(),
                });
            }
        });

        return variantCustomValues;
    },

    /**
     * Will look for attribute values that do not create product variant
     * (see productAttribute.createVariant "dynamic")
     *
     * @param {$.Element} $container
     * @returns {Array} array of attribute values with the following format
     *   {integer} customProductTemplateAttributeValueId
     *   {string} attributeValueName
     *   {integer} value
     *   {string} attributeName
     *   {boolean} isCustom
     */
    getNoVariantAttributeValues: function ($container) {
        var noVariantAttributeValues = [];
        var variantsValuesSelectors = [
            'input.noVariant.js-variant-change:checked',
            'select.noVariant.js-variant-change'
        ];

        $container.find(variantsValuesSelectors.join(',')).each(function (){
            var $variantValueInput = $(this);
            var singleNoCustom = $variantValueInput.data('issingle') && !$variantValueInput.data('isCustom');

            if ($variantValueInput.is('select')){
                $variantValueInput = $variantValueInput.find('option[value=' + $variantValueInput.val() + ']');
            }

            if ($variantValueInput.length !== 0 && !singleNoCustom){
                noVariantAttributeValues.push({
                    'customProductTemplateAttributeValueId': $variantValueInput.data('valueId'),
                    'attributeValueName': $variantValueInput.data('valueName'),
                    'value': $variantValueInput.val(),
                    'attributeName': $variantValueInput.data('attributeName'),
                    'isCustom': $variantValueInput.data('isCustom')
                });
            }
        });

        return noVariantAttributeValues;
    },

    /**
     * Will return the list of selected product.template.attribute.value ids
     * For the modal, the "main product"'s attribute values are stored in the
     * "unchangedValueIds" data
     *
     * @param {$.Element} $container the container to look into
     */
    getSelectedVariantValues: function ($container) {
        var values = [];
        var unchangedValues = $container
            .find('div.oe-unchanged-value-ids')
            .data('unchanged-value-ids') || [];

        var variantsValuesSelectors = [
            'input.js-variant-change:checked',
            'select.js-variant-change'
        ];
        _.each($container.find(variantsValuesSelectors.join(', ')), function (el) {
            values.push(+$(el).val());
        });

        return values.concat(unchangedValues);
    },

    /**
     * Will return a promise:
     *
     * - If the product already exists, immediately resolves it with the productId
     * - If the product does not exist yet ("dynamic" variant creation), this method will
     *   create the product first and then resolve the promise with the created product's id
     *
     * @param {$.Element} $container the container to look into
     * @param {integer} productId the product id
     * @param {integer} productTemplateId the corresponding product template id
     * @param {boolean} useAjax wether the rpc call should be done using ajax.jsonRpc or using _rpc
     * @returns {Promise} the promise that will be resolved with a {integer} productId
     */
    selectOrCreateProduct: function ($container, productId, productTemplateId, useAjax) {
        var self = this;
        productId = parseInt(productId);
        productTemplateId = parseInt(productTemplateId);
        var productReady = Promise.resolve();
        if (productId) {
            productReady = Promise.resolve(productId);
        } else {
            var params = {
                productTemplateId: productTemplateId,
                productTemplateAttributeValueIds:
                    JSON.stringify(self.getSelectedVariantValues($container)),
            };

            var route = '/sale/createProductVariant';
            if (useAjax) {
                productReady = ajax.jsonRpc(route, 'call', params);
            } else {
                productReady = this._rpc({route: route, params: params});
            }
        }

        return productReady;
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * Will disable attribute value's inputs based on combination exclusions
     * and will disable the "add" button if the selected combination
     * is not available
     *
     * This will check both the exclusions within the product itself and
     * the exclusions coming from the parent product (meaning that this product
     * is an option of the parent product)
     *
     * It will also check that the selected combination does not exactly
     * match a manually archived product
     *
     * @private
     * @param {$.Element} $parent the parent container to apply exclusions
     * @param {Array} combination the selected combination of product attribute values
     * @param {Array} parentExclusions the exclusions induced by the variant selection of the parent product
     * For example chair cannot have steel legs if the parent Desk doesn't have steel legs
     */
    _checkExclusions: function ($parent, combination, parentExclusions) {
        var self = this;
        var combinationData = $parent
            .find('ul[data-attribute-exclusions]')
            .data('attribute-exclusions');

        if (parentExclusions && combinationData.parentExclusions) {
            combinationData.parentExclusions = parentExclusions;
        }
        $parent
            .find('option, input, label, .o-variant-pills')
            .removeClass('css-not-available')
            .attr('title', function () { return $(this).data('valuename') || ''; })
            .data('excluded-by', '');

        // exclusion rules: array of ptav
        // for each of them, contains array with the other ptav they exclude
        if (combinationData.exclusions) {
            // browse all the currently selected attributes
            _.each(combination, function (currentPtav) {
                if (combinationData.exclusions.hasOwnProperty(currentPtav)) {
                    // for each exclusion of the current attribute:
                    _.each(combinationData.exclusions[currentPtav], function (excludedPtav) {
                        // disable the excluded input (even when not already selected)
                        // to give a visual feedback before click
                        self._disableInput(
                            $parent,
                            excludedPtav,
                            currentPtav,
                            combinationData.mappedAttributeNames
                        );
                    });
                }
            });
        }

        // parent exclusions (tell which attributes are excluded from parent)
        _.each(combinationData.parentExclusions, function (exclusions, excludedby){
            // check that the selected combination is in the parent exclusions
            _.each(exclusions, function (ptav) {

                // disable the excluded input (even when not already selected)
                // to give a visual feedback before click
                self._disableInput(
                    $parent,
                    ptav,
                    excludedBy,
                    combinationData.mappedAttributeNames,
                    combinationData.parentProductName
                );
            });
        });
    },
    /**
     * Extracted to a method to be extendable by other modules
     *
     * @param {$.Element} $parent
     */
    _getProductId: function ($parent) {
        return parseInt($parent.find('.productId').val());
    },
    /**
     * Will disable the input/option that refers to the passed attributeValueId.
     * This is used for showing the user that some combinations are not available.
     *
     * It will also display a message explaining why the input is not selectable.
     * Based on the "excludedBy" and the "productName" params.
     * e.g: Not available with Color: Black
     *
     * @private
     * @param {$.Element} $parent
     * @param {integer} attributeValueId
     * @param {integer} excludedBy The attribute value that excludes this input
     * @param {Object} attributeNames A dict containing all the names of the attribute values
     *   to show a human readable message explaining why the input is disabled.
     * @param {string} [productName] The parent product. If provided, it will be appended before
     *   the name of the attribute value that excludes this input
     *   e.g: Not available with Customizable Desk (Color: Black)
     */
    _disableInput: function ($parent, attributeValueId, excludedBy, attributeNames, productName) {
        var $input = $parent
            .find('option[value=' + attributeValueId + '], input[value=' + attributeValueId + ']');
        $input.addClass('css-not-available');
        $input.closest('label').addClass('css-not-available');
        $input.closest('.o-variant-pills').addClass('css-not-available');

        if (excludedBy && attributeNames) {
            var $target = $input.is('option') ? $input : $input.closest('label').add($input);
            var excludedByData = [];
            if ($target.data('excluded-by')) {
                excludedByData = JSON.parse($target.data('excluded-by'));
            }

            var excludedByName = attributeNames[excludedBy];
            if (productName) {
                excludedByName = productName + ' (' + excludedByName + ')';
            }
            excludedByData.push(excludedByName);

            $target.attr('title', _.str.sprintf(_t('Not available with %s'), excludedByData.join(', ')));
            $target.data('excluded-by', JSON.stringify(excludedByData));
        }
    },
    /**
     * @see onChangeVariant
     *
     * @private
     * @param {MouseEvent} ev
     * @param {$.Element} $parent
     * @param {Array} combination
     */
    _onChangeCombination: function (ev, $parent, combination) {
        var self = this;
        var $price = $parent.find(".oe-price:first .oe-currency-value");
        var $defaultPrice = $parent.find(".oe-default-price:first .oe-currency-value");
        var $optionalPrice = $parent.find(".oe-optional:first .oe-currency-value");
        $price.text(self._priceToStr(combination.price));
        $defaultPrice.text(self._priceToStr(combination.listPrice));

        var isCombinationPossible = true;
        if (!_.isUndefined(combination.isCombinationPossible)) {
            isCombinationPossible = combination.isCombinationPossible;
        }
        this._toggleDisable($parent, isCombinationPossible);

        if (combination.hasDiscountedPrice) {
            $defaultPrice
                .closest('.oe-website-sale')
                .addClass("discount");
            $optionalPrice
                .closest('.oe-optional')
                .removeClass('d-none')
                .css('text-decoration', 'line-through');
            $defaultPrice.parent().removeClass('d-none');
        } else {
            $defaultPrice
                .closest('.oe-website-sale')
                .removeClass("discount");
            $optionalPrice.closest('.oe-optional').addClass('d-none');
            $defaultPrice.parent().addClass('d-none');
        }

        var rootComponentSelectors = [
            'tr.js-product',
            '.oe-website-sale',
            '.o-product-configurator'
        ];

        // update images only when changing product
        // or when either ids are 'false', meaning dynamic products.
        // Dynamic products don't have images BUT they may have invalid
        // combinations that need to disable the image.
        if (!combination.productId ||
            !this.lastProductId ||
            combination.productId !== this.lastProductId) {
            this.lastProductId = combination.productId;
            self._updateProductImage(
                $parent.closest(rootComponentSelectors.join(', ')),
                combination.displayImage,
                combination.productId,
                combination.productTemplateId,
                combination.carousel,
                isCombinationPossible
            );
        }

        $parent
            .find('.productId')
            .first()
            .val(combination.productId || 0)
            .trigger('change');

        $parent
            .find('.product-display-name')
            .first()
            .text(combination.displayName);

        $parent
            .find('.js-raw-price')
            .first()
            .text(combination.price)
            .trigger('change');

        this.handleCustomValues($(ev.target));
    },

    /**
     * returns the formatted price
     *
     * @private
     * @param {float} price
     */
    _priceToStr: function (price) {
        var l10n = _t.database.parameters;
        var precision = 2;

        if ($('.decimal-precision').length) {
            precision = parseInt($('.decimal-precision').last().data('precision'));
        }
        var formatted = _.str.sprintf('%.' + precision + 'f', price).split('.');
        formatted[0] = utils.insertThousandSeps(formatted[0]);
        return formatted.join(l10n.decimalPoint);
    },
    /**
     * Returns a throttled `_getCombinationInfo` with a leading and a trailing
     * call, which is memoized per `uniqueId`, and for which previous results
     * are dropped.
     *
     * The uniqueId is needed because on the configurator modal there might be
     * multiple elements triggering the rpc at the same time, and we need each
     * individual product rpc to be executed, but only once per individual
     * product.
     *
     * The leading execution is to keep good reactivity on the first call, for
     * a better user experience. The trailing is because ultimately only the
     * information about the last selected combination is useful. All
     * intermediary rpc can be ignored and are therefore best not done at all.
     *
     * The DropMisordered is to make sure slower rpc are ignored if the result
     * of a newer rpc has already been received.
     *
     * @private
     * @param {string} uniqueId
     * @returns {function}
     */
    _throttledGetCombinationInfo: _.memoize(function (uniqueId) {
        var dropMisordered = new concurrency.DropMisordered();
        var _getCombinationInfo = _.throttle(this._getCombinationInfo.bind(this), 500);
        return function (ev, params) {
            return dropMisordered.add(_getCombinationInfo(ev, params));
        };
    }),
    /**
     * Toggles the disabled class depending on the $parent element
     * and the possibility of the current combination.
     *
     * @private
     * @param {$.Element} $parent
     * @param {boolean} isCombinationPossible
     */
    _toggleDisable: function ($parent, isCombinationPossible) {
        $parent.toggleClass('css-not-available', !isCombinationPossible);
        if ($parent.hasClass('in-cart')) {
            const primaryButton = $parent.parents('.modal-content').find('.modal-footer .btn-primary');
            primaryButton.prop('disabled', !isCombinationPossible);
            primaryButton.toggleClass('disabled', !isCombinationPossible);
        }
    },
    /**
     * Updates the product image.
     * This will use the productId if available or will fallback to the productTemplateId.
     *
     * @private
     * @param {$.Element} $productContainer
     * @param {boolean} displayImage will hide the image if true. It will use the 'invisible' class
     *   instead of d-none to prevent layout change
     * @param {integer} productId
     * @param {integer} productTemplateId
     */
    _updateProductImage: function ($productContainer, displayImage, productId, productTemplateId) {
        var model = productId ? 'product.product' : 'product.template';
        var modelId = productId || productTemplateId;
        var imageUrl = '/web/image/{0}/{1}/' + (this._productImageField ? this._productImageField : 'image1024');
        var imageSrc = imageUrl
            .replace("{0}", model)
            .replace("{1}", modelId);

        var imagesSelectors = [
            'span[data-oe-model^="product."][data-oe-type="image"] img:first',
            'img.product-detail-img',
            'span.variant-image img',
            'img.variant-image',
        ];

        var $img = $productContainer.find(imagesSelectors.join(', '));

        if (displayImage) {
            $img.removeClass('invisible').attr('src', imageSrc);
        } else {
            $img.addClass('invisible');
        }
    },

    /**
     * Highlight selected color
     *
     * @private
     * @param {MouseEvent} ev
     */
    _onChangeColorAttribute: function (ev) {
        var $parent = $(ev.target).closest('.js-product');
        $parent.find('.css-attribute-color')
            .removeClass("active")
            .filter(':has(input:checked)')
            .addClass("active");
    },

    /**
     * Extension point for website_sale
     *
     * @private
     * @param {string} uri The uri to adapt
     */
    _getUri: function (uri) {
        return uri;
    }
};

return VariantMixin;

});
