verp.define('website_sale.VariantMixin', function (require) {
'use strict';

var VariantMixin = require('sale.VariantMixin');

/**
 * Website behavior is slightly different from backend so we append
 * "Website" to URLs to lead to a different route
 *
 * @private
 * @param {string} uri The uri to adapt
 */
VariantMixin._getUri = function (uri) {
    if (this.isWebsite) {
        return uri + 'Website';
    } else {
        return uri;
    }
};
const originalOnChangeCombination = VariantMixin._onChangeCombination;
VariantMixin._onChangeCombination = function (ev, $parent, combination) {
    const $pricePerUom = $parent.find(".o-base-unit-price:first .oe-currency-value");
    if ($pricePerUom) {
        if (combination.isCombinationPossible !== false && combination.baseUnitPrice != 0) {
            $pricePerUom.parents(".o-base-unit-price-wrapper").removeClass("d-none");
            $pricePerUom.text(this._priceToStr(combination.baseUnitPrice));
            $parent.find(".oe-custom-base-unit:first").text(combination.baseUnitName);
        } else {
            $pricePerUom.parents(".o-base-unit-price-wrapper").addClass("d-none");
        }
    }

    // Triggers a new JS event with the correct payload, which is then handled
    // by the google analytics tracking code.
    // Indeed, every time another variant is selected, a new viewItem event
    // needs to be tracked by google analytics.
    if ('productTrackingInfo' in combination) {
        const $product = $('#productDetail');
        $product.data('product-tracking-info', combination['productTrackingInfo']);
        $product.trigger('viewItemEvent', combination['productTrackingInfo']);
    }

    originalOnChangeCombination.apply(this, [ev, $parent, combination]);
};

const originalToggleDisable = VariantMixin._toggleDisable;
/**
 * Toggles the disabled class depending on the $parent element
 * and the possibility of the current combination. This override
 * allows us to disable the secondary button in the website
 * sale product configuration modal.
 *
 * @private
 * @param {$.Element} $parent
 * @param {boolean} isCombinationPossible
 */
VariantMixin._toggleDisable = function ($parent, isCombinationPossible) {
    if ($parent.hasClass('in-cart')) {
        const secondaryButton = $parent.parents('.modal-content').find('.modal-footer .btn-secondary');
        secondaryButton.prop('disabled', !isCombinationPossible);
        secondaryButton.toggleClass('disabled', !isCombinationPossible);
    }
    originalToggleDisable.apply(this, [$parent, isCombinationPossible]);
};

return VariantMixin;

});
