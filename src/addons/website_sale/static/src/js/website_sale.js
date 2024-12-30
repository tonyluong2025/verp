verp.define('website_sale.cart', function (require) {
'use strict';

var publicWidget = require('web.public.widget');
var core = require('web.core');
var _t = core._t;

var timeout;

publicWidget.registry.websiteSaleCartLink = publicWidget.Widget.extend({
    // TODO in master: remove the second selector.
    selector: '#top a[href$="/shop/cart"]:not(.js-change-lang), #topMenu a[href$="/shop/cart"]:not(.js-change-lang)',
    events: {
        'mouseenter': '_onMouseEnter',
        'mouseleave': '_onMouseLeave',
        'click': '_onClick',
    },

    /**
     * @constructor
     */
    init: function () {
        this._super.apply(this, arguments);
        this._popoverRPC = null;
    },
    /**
     * @override
     */
    start: function () {
        this.$el.popover({
            trigger: 'manual',
            animation: true,
            html: true,
            title: function () {
                return _t("My Cart");
            },
            container: 'body',
            placement: 'auto',
            template: '<div class="popover mycart-popover" role="tooltip"><div class="arrow"></div><h3 class="popover-header"></h3><div class="popover-body"></div></div>'
        });
        return this._super.apply(this, arguments);
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * @private
     * @param {Event} ev
     */
    _onMouseEnter: function (ev) {
        var self = this;
        clearTimeout(timeout);
        $(this.selector).not(ev.currentTarget).popover('hide');
        timeout = setTimeout(function () {
            if (!self.$el.is(':hover') || $('.mycart-popover:visible').length) {
                return;
            }
            self._popoverRPC = $.get("/shop/cart", {
                type: 'popover',
            }).then(function (data) {
                self.$el.data("bs.popover").config.content = data;
                self.$el.popover("show");
                $('.popover').on('mouseleave', function () {
                    self.$el.trigger('mouseleave');
                });
            });
        }, 300);
    },
    /**
     * @private
     * @param {Event} ev
     */
    _onMouseLeave: function (ev) {
        var self = this;
        setTimeout(function () {
            if ($('.popover:hover').length) {
                return;
            }
            if (!self.$el.is(':hover')) {
               self.$el.popover('hide');
            }
        }, 1000);
    },
    /**
     * @private
     * @param {Event} ev
     */
    _onClick: function (ev) {
        // When clicking on the cart link, prevent any popover to show up (by
        // clearing the related setTimeout) and, if a popover rpc is ongoing,
        // wait for it to be completed before going to the link's href. Indeed,
        // going to that page may perform the same computation the popover rpc
        // is already doing.
        clearTimeout(timeout);
        if (this._popoverRPC && this._popoverRPC.state() === 'pending') {
            ev.preventDefault();
            var href = ev.currentTarget.href;
            this._popoverRPC.then(function () {
                window.location.href = href;
            });
        }
    },
});
});

verp.define('website_sale.websiteSaleCategory', function (require) {
'use strict';

var publicWidget = require('web.public.widget');

publicWidget.registry.websiteSaleCategory = publicWidget.Widget.extend({
    selector: '#oShopCollapseCategory',
    events: {
        'click .fa-chevron-right': '_onOpenClick',
        'click .fa-chevron-down': '_onCloseClick',
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * @private
     * @param {Event} ev
     */
    _onOpenClick: function (ev) {
        var $fa = $(ev.currentTarget);
        $fa.parent().siblings().find('.fa-chevron-down:first').click();
        $fa.parents('li').find('ul:first').show('normal');
        $fa.toggleClass('fa-chevron-down fa-chevron-right');
    },
    /**
     * @private
     * @param {Event} ev
     */
    _onCloseClick: function (ev) {
        var $fa = $(ev.currentTarget);
        $fa.parent().find('ul:first').hide('normal');
        $fa.toggleClass('fa-chevron-down fa-chevron-right');
    },
});
});

verp.define('website_sale.websiteSale', function (require) {
'use strict';

var core = require('web.core');
var config = require('web.config');
var publicWidget = require('web.public.widget');
var VariantMixin = require('website_sale.VariantMixin');
var wSaleUtils = require('website_sale.utils');
const cartHandlerMixin = wSaleUtils.cartHandlerMixin;
require("web.zoomverp");
const {extraMenuUpdateCallbacks} = require('website.content.menu');
const dom = require('web.dom');

publicWidget.registry.WebsiteSale = publicWidget.Widget.extend(VariantMixin, cartHandlerMixin, {
    selector: '.oe-website-sale',
    events: _.extend({}, VariantMixin.events || {}, {
        'change form .js-product:first input[name="addQty"]': '_onChangeAddQuantity',
        'mouseup .js-publish': '_onMouseupPublish',
        'touchend .js-publish': '_onMouseupPublish',
        'change .oe-cart input.js-quantity[data-product-id]': '_onChangeCartQuantity',
        'click .oe-cart a.js-add-suggested-products': '_onClickSuggestedProduct',
        'click a.js-add-cart-json': '_onClickAddCartJSON',
        'click .a-submit': '_onClickSubmit',
        'change form.js-attributes input, form.js-attributes select': '_onChangeAttribute',
        'mouseup form.js-add-cart-json label': '_onMouseupAddCartLabel',
        'touchend form.js-add-cart-json label': '_onMouseupAddCartLabel',
        'click .show-coupon': '_onClickShowCoupon',
        'submit .o-wsale-products-searchbar-form': '_onSubmitSaleSearch',
        'change select[name="countryId"]': '_onChangeCountry',
        'change #shippingUseSame': '_onChangeShippingUseSame',
        'click .toggle-summary': '_onToggleSummary',
        'click #addToCart, .o-we-buy-now, #productsGrid .o-wsale-product-btn .a-submit': 'async _onClickAdd',
        'click input.js-product-change': 'onChangeVariant',
        'change .js-main-product [data-attribute-exclusions]': 'onChangeVariant',
        'change oe-advanced-configurator-modal [data-attribute-exclusions]': 'onChangeVariant',
        'click .o-product-page-reviews-link': '_onClickReviewsLink',
    }),

    /**
     * @constructor
     */
    init: function () {
        this._super.apply(this, arguments);

        this._changeCartQuantity = _.debounce(this._changeCartQuantity.bind(this), 500);
        this._changeCountry = _.debounce(this._changeCountry.bind(this), 500);

        this.isWebsite = true;

        delete this.events['change .main-product:not(.in-cart) input.js-quantity'];
        delete this.events['change [data-attribute-exclusions]'];
    },
    /**
     * @override
     */
    start() {
        const def = this._super(...arguments);

        this._applyHashFromSearch();

        _.each(this.$('div.js-product'), function (product) {
            $('input.js-product-change', product).first().trigger('change');
        });

        // This has to be triggered to compute the "out of stock" feature and the hash variant changes
        this.triggerVariantChange(this.$el);

        this.$('select[name="countryId"]').change();

        core.bus.on('resize', this, function () {
            if (config.device.sizeClass === config.device.SIZES.XL) {
                $('.toggle-summary-div').addClass('d-none d-xl-block');
            }
        });

        this._startZoom();

        window.addEventListener('hashchange', () => {
            this._applyHash();
            this.triggerVariantChange(this.$el);
        });

        this.getRedirectOption();
        return def;
    },
    /**
     * The selector is different when using list view of variants.
     *
     * @override
     */
    getSelectedVariantValues: function ($container) {
        var combination = $container.find('input.js-product-change:checked')
            .data('combination');

        if (combination) {
            return combination;
        }
        return VariantMixin.getSelectedVariantValues.apply(this, arguments);
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    _applyHash: function () {
        var hash = window.location.hash.substring(1);
        if (hash) {
            var params = $.deparam(hash);
            if (params['attr']) {
                var attributeIds = params['attr'].split(',');
                var $inputs = this.$('input.js-variant-change, select.js-variant-change option');
                _.each(attributeIds, function (id) {
                    var $toSelect = $inputs.filter('[data-value-id="' + id + '"]');
                    if ($toSelect.is('input[type="radio"]')) {
                        $toSelect.prop('checked', true);
                    } else if ($toSelect.is('option')) {
                        $toSelect.prop('selected', true);
                    }
                });
                this._changeAttribute(['.css-attribute-color', '.o-variant-pills']);
            }
        }
    },

    /**
     * Sets the url hash from the selected product options.
     *
     * @private
     */
    _setUrlHash: function ($parent) {
        var $attributes = $parent.find('input.js-variant-change:checked, select.js-variant-change option:selected');
        var attributeIds = _.map($attributes, function (elem) {
            return $(elem).data('valueId');
        });
        history.replaceState(undefined, undefined, '#attr=' + attributeIds.join(','));
    },
    /**
     * Set the checked values active.
     *
     * @private
     * @param {Array} valueSelectors Selectors
     */
    _changeAttribute: function (valueSelectors) {
        _.each(valueSelectors, function (selector) {
            $(selector).removeClass("active")
                       .filter(':has(input:checked)')
                       .addClass("active");
        });
    },
    /**
     * @private
     */
    _changeCartQuantity: function ($input, value, $domOptional, lineId, productIDs) {
        _.each($domOptional, function (elem) {
            $(elem).find('.js-quantity').text(value);
            productIDs.push($(elem).find('span[data-product-id]').data('product-id'));
        });
        $input.data('updateChange', true);

        this._rpc({
            route: "/shop/cart/updateJson",
            params: {
                lineId: lineId,
                productId: parseInt($input.data('product-id'), 10),
                setQty: value
            },
        }).then(function (data) {
            $input.data('updateChange', false);
            var checkValue = parseInt($input.val() || 0, 10);
            if (isNaN(checkValue)) {
                checkValue = 1;
            }
            if (value !== checkValue) {
                $input.trigger('change');
                return;
            }
            if (!data.cartQuantity) {
                return window.location = '/shop/cart';
            }
            $input.val(data.quantity);
            $('.js-quantity[data-line-id='+lineId+']').val(data.quantity).text(data.quantity);

            wSaleUtils.updateCartNavBar(data);
            wSaleUtils.showWarning(data.warning);
        });
    },
    /**
     * @private
     */
    _changeCountry: function () {
        if (!$("#countryId").val()) {
            return;
        }
        this._rpc({
            route: "/shop/countryInfos/" + $("#countryId").val(),
            params: {
                mode: $("#countryId").attr('mode'),
            },
        }).then(function (data) {
            // placeholder phoneCode
            $("input[name='phone']").attr('placeholder', data.phoneCode !== 0 ? '+'+ data.phoneCode : '');

            // populate states and display
            var selectStates = $("select[name='stateId']");
            // dont reload state at first loading (done in qweb)
            if (selectStates.data('init')===0 || selectStates.find('option').length===1) {
                if (data.states.length || data.stateRequired) {
                    selectStates.html('');
                    _.each(data.states, function (x) {
                        var opt = $('<option>').text(x[1])
                            .attr('value', x[0])
                            .attr('data-code', x[2]);
                        selectStates.append(opt);
                    });
                    selectStates.parent('div').show();
                } else {
                    selectStates.val('').parent('div').hide();
                }
                selectStates.data('init', 0);
            } else {
                selectStates.data('init', 0);
            }

            // manage fields order / visibility
            if (data.fields) {
                if ($.inArray('zip', data.fields) > $.inArray('city', data.fields)){
                    $(".div-zip").before($(".div-city"));
                } else {
                    $(".div-zip").after($(".div-city"));
                }
                var allFields = ["street", "zip", "city", "countryName"]; // "stateCode"];
                _.each(allFields, function (field) { // Tony must check
                    $(".checkout-autoformat .div-" + field.split('_')[0]).toggle($.inArray(field, data.fields)>=0);
                });
            }

            if ($("label[for='zip']").length) {
                $("label[for='zip']").toggleClass('label-optional', !data.zipRequired);
                $("label[for='zip']").get(0).toggleAttribute('required', !!data.zipRequired);
            }
            if ($("label[for='zip']").length) {
                $("label[for='stateId']").toggleClass('label-optional', !data.stateRequired);
                $("label[for='stateId']").get(0).toggleAttribute('required', !!data.stateRequired);
            }
        });
    },
    /**
     * This is overridden to handle the "List View of Variants" of the web shop.
     * That feature allows directly selecting the variant from a list instead of selecting the
     * attribute values.
     *
     * Since the layout is completely different, we need to fetch the productId directly
     * from the selected variant.
     *
     * @override
     */
    _getProductId: function ($parent) {
        if ($parent.find('input.js-product-change').length !== 0) {
            return parseInt($parent.find('input.js-product-change:checked').val());
        }
        else {
            return VariantMixin._getProductId.apply(this, arguments);
        }
    },
    /**
     * @private
     */
    _startZoom: function () {
        // Do not activate image zoom for mobile devices, since it might prevent users from scrolling the page
        if (!config.device.isMobile) {
            var autoZoom = $('.ecom-zoomable').data('ecom-zoom-auto') || false,
            attach = '#oCarouselProduct';
            _.each($('.ecom-zoomable img[data-zoom]'), function (el) {
                onImageLoaded(el, function () {
                    var $img = $(el);
                    $img.zoomVerp({event: autoZoom ? 'mouseenter' : 'click', attach: attach});
                    $img.attr('data-zoom', 1);
                });
            });
        }

        function onImageLoaded(img, callback) {
            // On Chrome the load event already happened at this point so we
            // have to rely on complete. On Firefox it seems that the event is
            // always triggered after this so we can rely on it.
            //
            // However on the "complete" case we still want to keep listening to
            // the event because if the image is changed later (eg. product
            // configurator) a new load event will be triggered (both browsers).
            $(img).on('load', function () {
                callback();
            });
            if (img.complete) {
                callback();
            }
        }
    },
    /**
     * On website, we display a carousel instead of only one image
     *
     * @override
     * @private
     */
    _updateProductImage: function ($productContainer, displayImage, productId, productTemplateId, newCarousel, isCombinationPossible) {
        var $carousel = $productContainer.find('#oCarouselProduct');
        // When using the web editor, don't reload this or the images won't
        // be able to be edited depending on if this is done loading before
        // or after the editor is ready.
        if (window.location.search.indexOf('enableEditor') === -1) {
            var $newCarousel = $(newCarousel);
            $carousel.after($newCarousel);
            $carousel.remove();
            $carousel = $newCarousel;
            $carousel.carousel(0);
            this._startZoom();
            // fix issue with carousel height
            this.triggerUp('widgetsStartRequest', {$target: $carousel});
        }
        $carousel.toggleClass('css-not-available', !isCombinationPossible);
    },
    /**
     * @private
     * @param {MouseEvent} ev
     */
    _onClickAdd: function (ev) {
        ev.preventDefault();
        var def = () => {
            this.getCartHandlerOptions(ev);
            return this._handleAdd($(ev.currentTarget).closest('form'));
        };
        if ($('.js-add-cart-variants').children().length) {
            return this._getCombinationInfo(ev).then(() => {
                return !$(ev.target).closest('.js-product').hasClass("css-not-available") ? def() : Promise.resolve();
            });
        }
        return def();
    },
    /**
     * Initializes the optional products modal
     * and add handlers to the modal events (confirm, back, ...)
     *
     * @private
     * @param {$.Element} $form the related webshop form
     */
    _handleAdd: function ($form) {
        var self = this;
        this.$form = $form;

        var productSelector = [
            'input[type="hidden"][name="productId"]',
            'input[type="radio"][name="productId"]:checked'
        ];

        var productReady = this.selectOrCreateProduct(
            $form,
            parseInt($form.find(productSelector.join(', ')).first().val(), 10),
            $form.find('.productTemplateId').val(),
            false
        );

        return productReady.then(function (productId) {
            $form.find(productSelector.join(', ')).val(productId);

            self.rootProduct = {
                productId: productId,
                quantity: parseFloat($form.find('input[name="addQty"]').val() || 1),
                productCustomAttributeValues: self.getCustomVariantValues($form.find('.js-product')),
                variantValues: self.getSelectedVariantValues($form.find('.js-product')),
                noVariantAttributeValues: self.getNoVariantAttributeValues($form.find('.js-product'))
            };

            return self._onProductReady();
        });
    },

    _onProductReady: function () {
        return this._submitForm();
    },

    /**
     * Add custom variant values and attribute values that do not generate variants
     * in the params to submit form if 'stay on page' option is disabled, or call
     * '_addToCartInPage' otherwise.
     *
     * @private
     * @returns {Promise}
     */
    _submitForm: function () {
        const params = this.rootProduct;

        const $product = $('#productDetail');
        const productTrackingInfo = $product.data('product-tracking-info');
        if (productTrackingInfo) {
            productTrackingInfo.quantity = params.quantity;
            $product.trigger('addToCartEvent', [productTrackingInfo]);
        }

        params.addQty = params.quantity;
        params.productCustomAttributeValues = JSON.stringify(params.productCustomAttributeValues);
        params.noVariantAttributeValues = JSON.stringify(params.noVariantAttributeValues);
        return this.addToCart(params);
    },
    /**
     * @private
     * @param {MouseEvent} ev
     */
    _onClickAddCartJSON: function (ev){
        this.onClickAddCartJSON(ev);
    },
    /**
     * @private
     * @param {Event} ev
     */
    _onChangeAddQuantity: function (ev) {
        this.onChangeAddQuantity(ev);
    },
    /**
     * @private
     * @param {Event} ev
     */
    _onMouseupPublish: function (ev) {
        $(ev.currentTarget).parents('.thumbnail').toggleClass('disabled');
    },
    /**
     * @private
     * @param {Event} ev
     */
    _onChangeCartQuantity: function (ev) {
        var $input = $(ev.currentTarget);
        if ($input.data('updateChange')) {
            return;
        }
        var value = parseInt($input.val() || 0, 10);
        if (isNaN(value)) {
            value = 1;
        }
        var $dom = $input.closest('tr');
        // var defaultPrice = parseFloat($dom.find('.text-danger > span.oe-currency-value').text());
        var $domOptional = $dom.nextUntil(':not(.optional-product.info)');
        var lineId = parseInt($input.data('line-id'), 10);
        var productIDs = [parseInt($input.data('product-id'), 10)];
        this._changeCartQuantity($input, value, $domOptional, lineId, productIDs);
    },
    /**
     * @private
     * @param {Event} ev
     */
    _onClickSuggestedProduct: function (ev) {
        $(ev.currentTarget).prev('input').val(1).trigger('change');
    },
    /**
     * @private
     * @param {Event} ev
     */
    _onClickSubmit: function (ev, forceSubmit) {
        if ($(ev.currentTarget).is('#addToCart, #productsGrid .a-submit') && !forceSubmit) {
            return;
        }
        var $aSubmit = $(ev.currentTarget);
        if (!ev.isDefaultPrevented() && !$aSubmit.is(".disabled")) {
            ev.preventDefault();
            $aSubmit.closest('form').submit();
        }
        if ($aSubmit.hasClass('a-submit-disable')){
            $aSubmit.addClass("disabled");
        }
        if ($aSubmit.hasClass('a-submit-loading')){
            var loading = '<span class="fa fa-cog fa-spin"/>';
            var faSpan = $aSubmit.find('span[class*="fa"]');
            if (faSpan.length){
                faSpan.replaceWith(loading);
            } else {
                $aSubmit.append(loading);
            }
        }
    },
    /**
     * @private
     * @param {Event} ev
     */
    _onChangeAttribute: function (ev) {
        if (!ev.isDefaultPrevented()) {
            ev.preventDefault();
            $(ev.currentTarget).closest("form").submit();
        }
    },
    /**
     * @private
     * @param {Event} ev
     */
    _onMouseupAddCartLabel: function (ev) { // change price when they are variants
        var $label = $(ev.currentTarget);
        var $price = $label.parents("form:first").find(".oe-price .oe-currency-value");
        if (!$price.data("price")) {
            $price.data("price", parseFloat($price.text()));
        }
        var value = $price.data("price") + parseFloat($label.find(".badge span").text() || 0);

        var dec = value % 1;
        $price.html(value + (dec < 0.01 ? ".00" : (dec < 1 ? "0" : "") ));
    },
    /**
     * @private
     * @param {Event} ev
     */
    _onClickShowCoupon: function (ev) {
        $(ev.currentTarget).hide();
        $('.couponForm').removeClass('d-none');
    },
    /**
     * @private
     * @param {Event} ev
     */
    _onSubmitSaleSearch: function (ev) {
        if (!this.$('.dropdown-sorty-by').length) {
            return;
        }
        var $this = $(ev.currentTarget);
        if (!ev.isDefaultPrevented() && !$this.is(".disabled")) {
            ev.preventDefault();
            var oldurl = $this.attr('action');
            oldurl += (oldurl.indexOf("?")===-1) ? "?" : "";
            if ($this.find('[name=noFuzzy]').val() === "true") {
                oldurl += '&noFuzzy=true';
            }
            var search = $this.find('input.search-query');
            window.location = oldurl + '&' + search.attr('name') + '=' + encodeURIComponent(search.val());
        }
    },
    /**
     * @private
     * @param {Event} ev
     */
    _onChangeCountry: function (ev) {
        if (!this.$('.checkout-autoformat').length) {
            return;
        }
        this._changeCountry();
    },
    /**
     * @private
     * @param {Event} ev
     */
    _onChangeShippingUseSame: function (ev) {
        $('.ship-to-other').toggle(!$(ev.currentTarget).prop('checked'));
    },
    /**
     * Toggles the add to cart button depending on the possibility of the
     * current combination.
     *
     * @override
     */
    _toggleDisable: function ($parent, isCombinationPossible) {
        VariantMixin._toggleDisable.apply(this, arguments);
        $parent.find("#addToCart").toggleClass('disabled', !isCombinationPossible);
        $parent.find(".o-we-buy-now").toggleClass('disabled', !isCombinationPossible);
    },
    /**
     * Write the properties of the form elements in the DOM to prevent the
     * current selection from being lost when activating the web editor.
     *
     * @override
     */
    onChangeVariant: function (ev) {
        var $component = $(ev.currentTarget).closest('.js-product');
        $component.find('input').each(function () {
            var $el = $(this);
            $el.attr('checked', $el.is(':checked'));
        });
        $component.find('select option').each(function () {
            var $el = $(this);
            $el.attr('selected', $el.is(':selected'));
        });

        this._setUrlHash($component);

        return VariantMixin.onChangeVariant.apply(this, arguments);
    },
    /**
     * @private
     */
    _onToggleSummary: function () {
        $('.toggle-summary-div').toggleClass('d-none');
        $('.toggle-summary-div').removeClass('d-xl-block');
    },
    /**
     * @private
     */
    _applyHashFromSearch() {
        const params = $.deparam(window.location.search.slice(1));
        if (params.attrib) {
            const dataValueIds = [];
            for (const attrib of [].concat(params.attrib)) {
                const attribSplit = attrib.split('-');
                const attribValueSelector = `.js-variant-change[name="ptal-${attribSplit[0]}"][value="${attribSplit[1]}"]`;
                const attribValue = this.el.querySelector(attribValueSelector);
                if (attribValue !== null) {
                    dataValueIds.push(attribValue.dataset.valueId);
                }
            }
            if (dataValueIds.length) {
                history.replaceState(undefined, undefined, `#attr=${dataValueIds.join(',')}`);
            }
        }
        this._applyHash();
    },
    /**
     * @private
     */
    _onClickReviewsLink: function () {
        $('#oProductPageReviewsContent').collapse('show');
    },
});

publicWidget.registry.WebsiteSaleLayout = publicWidget.Widget.extend({
    selector: '.oe-website-sale',
    disabledInEditableMode: false,
    events: {
        'change .o-wsale-apply-layout': '_onApplyShopLayoutChange',
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * @private
     * @param {Event} ev
     */
    _onApplyShopLayoutChange: function (ev) {
        const wysiwyg = this.options.wysiwyg;
        if (wysiwyg) {
            wysiwyg.verpEditor.observerUnactive('_onApplyShopLayoutChange');
        }
        var switchToList = $(ev.currentTarget).find('.o-wsale-apply-list input').is(':checked');
        if (!this.editableMode) {
            this._rpc({
                route: '/shop/saveShopLayoutMode',
                params: {
                    'layoutMode': switchToList ? 'list' : 'grid',
                },
            });
        }
        var $grid = this.$('#productsGrid');
        // Disable transition on all list elements, then switch to the new
        // layout then reenable all transitions after having forced a redraw
        // TODO should probably be improved to allow disabling transitions
        // altogether with a class/option.
        $grid.find('*').css('transition', 'none');
        $grid.toggleClass('o-wsale-layout-list', switchToList);
        void $grid[0].offsetWidth;
        $grid.find('*').css('transition', '');
        if (wysiwyg) {
            wysiwyg.verpEditor.observerActive('_onApplyShopLayoutChange');
        }
    },
});

publicWidget.registry.websiteSaleCart = publicWidget.Widget.extend({
    selector: '.oe-website-sale .oe-cart',
    events: {
        'click .js-change-shipping': '_onClickChangeShipping',
        'click .js-edit-address': '_onClickEditAddress',
        'click .js-delete-product': '_onClickDeleteProduct',
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * @private
     * @param {Event} ev
     */
    _onClickChangeShipping: function (ev) {
        var $old = $('.all-shipping').find('.card.border.border-primary');
        $old.find('.btn-ship').toggle();
        $old.addClass('js-change-shipping');
        $old.removeClass('border border-primary');

        var $new = $(ev.currentTarget).parent('div.one-kanban').find('.card');
        $new.find('.btn-ship').toggle();
        $new.removeClass('js-change-shipping');
        $new.addClass('border border-primary');

        var $form = $(ev.currentTarget).parent('div.one-kanban').find('form.d-none');
        $.post($form.attr('action'), $form.serialize()+'&xhr=1');
    },
    /**
     * @private
     * @param {Event} ev
     */
    _onClickEditAddress: function (ev) {
        ev.preventDefault();
        $(ev.currentTarget).closest('div.one-kanban').find('form.d-none').attr('action', '/shop/address').submit();
    },
    /**
     * @private
     * @param {Event} ev
     */
    _onClickDeleteProduct: function (ev) {
        ev.preventDefault();
        $(ev.currentTarget).closest('tr').find('.js-quantity').val(0).trigger('change');
    },
});

publicWidget.registry.websiteSaleCarouselProduct = publicWidget.Widget.extend({
    selector: '#oCarouselProduct',
    disabledInEditableMode: false,
    events: {
        'wheel .o-carousel-product-indicators': '_onMouseWheel',
    },

    /**
     * @override
     */
    async start() {
        await this._super(...arguments);
        this._updateCarouselPosition();
        extraMenuUpdateCallbacks.push(this._updateCarouselPosition.bind(this));
        if (this.$target.find('.carousel-indicators').length > 0) {
            this.$target.on('slide.bs.carousel.carousel-product-slider', this._onSlideCarouselProduct.bind(this));
            $(window).on('resize.carousel-product-slider', _.throttle(this._onSlideCarouselProduct.bind(this), 150));
            this._updateJustifyContent();
        }
    },
    /**
     * @override
     */
    destroy() {
        this.$target.css('top', '');
        this.$target.off('.carousel-product-slider');
        this._super(...arguments);
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * @private
     */
    _updateCarouselPosition() {
        this.$target.css('top', dom.scrollFixedOffset() + 5);
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * Center the selected indicator to scroll the indicators list when it
     * overflows.
     *
     * @private
     * @param {Event} ev
     */
    _onSlideCarouselProduct: function (ev) {
        const isReversed = this.$target.css('flex-direction') === "column-reverse";
        const isLeftIndicators = this.$target.hasClass('o-carousel-product-left-indicators');
        const $indicatorsDiv = isLeftIndicators ? this.$target.find('.o-carousel-product-indicators') : this.$target.find('.carousel-indicators');
        let indicatorIndex = $(ev.relatedTarget).index();
        indicatorIndex = indicatorIndex > -1 ? indicatorIndex : this.$target.find('li.active').index();
        const $indicator = $indicatorsDiv.find('[data-slide-to=' + indicatorIndex + ']');
        const indicatorsDivSize = isLeftIndicators && !isReversed ? $indicatorsDiv.outerHeight() : $indicatorsDiv.outerWidth();
        const indicatorSize = isLeftIndicators && !isReversed ? $indicator.outerHeight() : $indicator.outerWidth();
        const indicatorPosition = isLeftIndicators && !isReversed ? $indicator.position().top : $indicator.position().left;
        const scrollSize = isLeftIndicators && !isReversed ? $indicatorsDiv[0].scrollHeight : $indicatorsDiv[0].scrollWidth;
        let indicatorsPositionDiff = (indicatorPosition + (indicatorSize/2)) - (indicatorsDivSize/2);
        indicatorsPositionDiff = Math.min(indicatorsPositionDiff, scrollSize - indicatorsDivSize);
        this._updateJustifyContent();
        const indicatorsPositionX = isLeftIndicators && !isReversed ? '0' : '-' + indicatorsPositionDiff;
        const indicatorsPositionY = isLeftIndicators && !isReversed ? '-' + indicatorsPositionDiff : '0';
        const translate3D = indicatorsPositionDiff > 0 ? "translate3d(" + indicatorsPositionX + "px," + indicatorsPositionY + "px,0)" : '';
        $indicatorsDiv.css("transform", translate3D);
    },
    /**
     * @private
     */
     _updateJustifyContent: function () {
        const $indicatorsDiv = this.$target.find('.carousel-indicators');
        $indicatorsDiv.css('justify-content', 'start');
        if (config.device.sizeClass <= config.device.SIZES.MD) {
            if (($indicatorsDiv.children().last().position().left + this.$target.find('li').outerWidth()) < $indicatorsDiv.outerWidth()) {
                $indicatorsDiv.css('justify-content', 'center');
            }
        }
    },
    /**
     * @private
     * @param {Event} ev
     */
    _onMouseWheel: function (ev) {
        ev.preventDefault();
        if (ev.originalEvent.deltaY > 0) {
            this.$target.carousel('next');
        } else {
            this.$target.carousel('prev');
        }
    },
});

publicWidget.registry.websiteSaleProductPageReviews = publicWidget.Widget.extend({
    selector: '#oProductPageReviews',
    disabledInEditableMode: false,

    /**
     * @override
     */
    async start() {
        await this._super(...arguments);
        this._updateChatterComposerPosition();
        extraMenuUpdateCallbacks.push(this._updateChatterComposerPosition.bind(this));
    },
    /**
     * @override
     */
    destroy() {
        this.$target.find('.o-portal-chatter-composer').css('top', '');
        this._super(...arguments);
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * @private
     */
    _updateChatterComposerPosition() {
        this.$target.find('.o-portal-chatter-composer').css('top', dom.scrollFixedOffset() + 20);
    },
});

return {
    WebsiteSale: publicWidget.registry.WebsiteSale,
    WebsiteSaleLayout: publicWidget.registry.WebsiteSaleLayout,
    websiteSaleCart: publicWidget.registry.websiteSaleCart,
    WebsiteSaleCarouselProduct: publicWidget.registry.websiteSaleCarouselProduct,
    WebsiteSaleProductPageReviews: publicWidget.registry.websiteSaleProductPageReviews,
};

});

verp.define('website_sale.priceRangeOption', function (require) {
'use strict';

const publicWidget = require('web.public.widget');

publicWidget.registry.multirangePriceSelector = publicWidget.Widget.extend({
    selector: '#oWsalePriceRangeOption',
    events: {
        'newRangeValue input[type="range"]': '_onPriceRangeSelected',
    },

    //----------------------------------------------------------------------
    // Handlers
    //----------------------------------------------------------------------

    /**
     * @private
     * @param {Event} ev
     */
    _onPriceRangeSelected(ev) {
        const range = ev.currentTarget;
        const searchParams = new URLSearchParams(window.location.search);
        searchParams.delete("minPrice");
        searchParams.delete("maxPrice");
        if (parseFloat(range.min) !== range.valueLow) {
            searchParams.set("minPrice", range.valueLow);
        }
        if (parseFloat(range.max) !== range.valueHigh) {
            searchParams.set("maxPrice", range.valueHigh);
        }
        window.location.search = searchParams.toString();
    },
});
});
