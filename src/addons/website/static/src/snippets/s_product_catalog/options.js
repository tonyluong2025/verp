
verp.define('website.sProductCatalogOptions', function (require) {
'use strict';

const core = require('web.core');
const options = require('web_editor.snippets.options');

const _t = core._t;

options.registry.ProductCatalog = options.Class.extend({

    //--------------------------------------------------------------------------
    // Options
    //--------------------------------------------------------------------------

    /**
     * Show/hide descriptions.
     *
     * @see this.selectClass for parameters
     */
    toggleDescription: function (previewMode, widgetValue, params) {
        const $dishes = this.$('.s-product-catalog-dish');
        const $name = $dishes.find('.s-product-catalog-dish-name');
        $name.toggleClass('s-product-catalog-dish-dot-leaders', !widgetValue);
        if (widgetValue) {
            _.each($dishes, el => {
                const $description = $(el).find('.s-product-catalog-dish-description');
                if ($description.length) {
                    $description.removeClass('d-none');
                } else {
                    const descriptionEl = document.createElement('p');
                    descriptionEl.classList.add('s-product-catalog-dish-description', 'border-top', 'text-muted', 'pt-1', 'o-default-snippet-text');
                    const iEl = document.createElement('i');
                    iEl.textContent = _t("Add a description here");
                    descriptionEl.appendChild(iEl);
                    el.appendChild(descriptionEl);
                }
            });
        } else {
            _.each($dishes, el => {
                const $description = $(el).find('.s-product-catalog-dish-description');
                if ($description.hasClass('o-default-snippet-text') || $description.find('.o-default-snippet-text').length) {
                    $description.remove();
                } else {
                    $description.addClass('d-none');
                }
            });
        }
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * @override
     */
    _computeWidgetState: function (methodName, params) {
        if (methodName === 'toggleDescription') {
            const $description = this.$('.s-product-catalog-dish-description');
            return $description.length && !$description.hasClass('d-none');
        }
        return this._super(...arguments);
    },
});
});
