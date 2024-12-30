verp.define('website_sale.sDynamicSnippetProductsOptions', function (require) {
'use strict';

const options = require('web_editor.snippets.options');
const sDynamicSnippetCarouselOptions = require('website.sDynamicSnippetCarouselOptions');

var wUtils = require('website.utils');

const dynamicSnippetProductsOptions = sDynamicSnippetCarouselOptions.extend({

    /**
     *
     * @override
     */
    init: function () {
        this._super.apply(this, arguments);
        this.modelNameFilter = 'product.product';
        const productTemplateId = $("input.productTemplateId");
        this.hasProductTemplateId = productTemplateId.val();
        if (!this.hasProductTemplateId) {
            this.contextualFilterDomain.push(['productCrossSelling', '=', false]);
        }
        this.productCategories = {};
    },
    /**
     * @override
     */
    onBuilt() {
        this._super.apply(this, arguments);
        // TODO Remove in master.
        this.$target[0].dataset['snippet'] = 'sDynamicSnippetProducts';
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * Fetches product categories.
     * @private
     * @returns {Promise}
     */
    _fetchProductCategories: function () {
        return this._rpc({
            model: 'product.public.category',
            method: 'searchRead',
            kwargs: {
                domain: wUtils.websiteDomain(this),
                fields: ['id', 'label'],
            }
        });
    },
    /**
     *
     * @override
     * @private
     */
    _renderCustomXML: async function (uiFragment) {
        await this._super.apply(this, arguments);
        await this._renderProductCategorySelector(uiFragment);
    },
    /**
     * Renders the product categories option selector content into the provided uiFragment.
     * @private
     * @param {HTMLElement} uiFragment
     */
    _renderProductCategorySelector: async function (uiFragment) {
        const productCategories = await this._fetchProductCategories();
        for (let index in productCategories) {
            this.productCategories[productCategories[index].id] = productCategories[index];
        }
        const productCategoriesSelectorEl = uiFragment.querySelector('[data-name="productCategoryOpt"]');
        return this._renderSelectUserValueWidgetButtons(productCategoriesSelectorEl, this.productCategories);
    },
    /**
     * @override
     * @private
     */
    _setOptionsDefaultValues: function () {
        this._setOptionValue('productCategoryId', 'all');
        this._super.apply(this, arguments);
    },
});

options.registry.dynamicSnippetProducts = dynamicSnippetProductsOptions;

return dynamicSnippetProductsOptions;
});
