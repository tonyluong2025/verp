verp.define('wysiwyg.widgets.LinkTools', function (require) {
'use strict';

const Link = require('wysiwyg.widgets.Link');
const {ColorPaletteWidget} = require('web_editor.ColorPalette');
const {ColorpickerWidget} = require('web.Colorpicker');
const {
    computeColorClasses,
    getCSSVariableValue,
    getColorClass,
    getNumericAndUnit,
    isColorGradient,
} = require('web_editor.utils');

/**
 * Allows to customize link content and style.
 */
const LinkTools = Link.extend({
    template: 'wysiwyg.widgets.linkTools',
    events: _.extend({}, Link.prototype.events, {
        'click we-select we-button': '_onPickSelectOption',
        'click we-checkbox': '_onClickCheckbox',
        'change .link-custom-color-border input': '_onchangeCustomBorderWidth',
        'keypress .link-custom-color-border input': '_onKeyPressCustomBorderWidth',
        'click we-select [name="linkBorderStyle"] we-button': '_onBorderStyleSelectOption',
    }),

    /**
     * @override
     */
    init: function (parent, options, editable, data, $button, link) {
        this._link = link;
        this._observer = new MutationObserver(() =>{
            this._setLinkContent = false;
            this._observer.disconnect();
        });
        this._observer.observe(this._link, {subtree: true, childList: true, characterData: true});
        this._super(parent, options, editable, data, $button, this._link);
        // Keep track of each selected custom color and colorpicker.
        this.customColors = {};
        this.colorpickers = {};
        this.colorpickersPromises = {};
    },
    /**
     * @override
     */
    start: function () {
        const titleEls = this.el.querySelectorAll('we-title');
        for (const titleEl of titleEls) {
            // See _buildTitleElement for explanation
            titleEl.textContent = titleEl.textContent.replace(/⌙/g, '└');
        }
        this._addHintClasses();
        return this._super(...arguments);
    },
    destroy: function () {
        if (!this.el) {
            return this._super(...arguments);
        }
        const $contents = this.$link.contents();
        if (this.shouldUnlink()) {
            $contents.unwrap();
        }
        this._observer.disconnect();
        this._super(...arguments);
        this._removeHintClasses();
    },
    shouldUnlink: function () {
        return !this.$link.attr('href') && !this.colorCombinationClass
    },
    applyLinkToDom() {
        this._observer.disconnect();
        this._removeHintClasses();
        this._super(...arguments);
        this.options.wysiwyg.verpEditor.historyStep();
        this._addHintClasses();
        this._observer.observe(this._link, {subtree: true, childList: true, characterData: true});
    },

    //--------------------------------------------------------------------------
    // Public
    //--------------------------------------------------------------------------

    /**
     * @override
     */
    focusUrl() {
        this.el.scrollIntoView();
        this._super();
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * @override
     */
    _adaptPreview: function () {
        var data = this._getData();
        if (data === null) {
            return;
        }
        this.applyLinkToDom(data);
    },
    /**
     * @override
     */
    _doStripDomain: function () {
        return this.$('we-checkbox[name="doStripDomain"]').closest('we-button.o-we-checkbox-wrapper').hasClass('active');
    },
    /**
     * @override
     */
    _getLinkOptions: function () {
        const options = [
            'we-selection-items[name="linkStyleColor"] > we-button',
            'we-selection-items[name="linkStyleSize"] > we-button',
            'we-selection-items[name="linkStyleShape"] > we-button',
        ];
        return this.$(options.join(','));
    },
    /**
     * @override
     */
    _getLinkShape: function () {
        return this.$('we-selection-items[name="linkStyleShape"] we-button.active').data('value') || '';
    },
    /**
     * @override
     */
    _getLinkSize: function () {
        return this.$('we-selection-items[name="linkStyleSize"] we-button.active').data('value') || '';
    },
    /**
     * @override
     */
    _getLinkType: function () {
        return this.$('we-selection-items[name="linkStyleColor"] we-button.active').data('value') || '';
    },
    /**
     * @override
     */
    _getLinkCustomTextColor: function () {
        return this.customColors['color'];
    },
    /**
     * @override
     */
    _getLinkCustomBorder: function () {
        return this.customColors['border-color'];
    },
    /**
     * @override
     */
    _getLinkCustomBorderWidth: function () {
        return this.$('.link-custom-color-border input').val() || '';
    },
    /**
     * @override
     */
    _getLinkCustomBorderStyle: function () {
        return this.$('.link-custom-color-border we-button.active').data('value') || '';
    },
    /**
     * @override
     */
    _getLinkCustomFill: function () {
        return this.customColors['background-color'];
    },
    /**
     * @override
     */
    _getLinkCustomClasses: function () {
        let textClass = this.customColors['color'];
        const colorPickerFg = this.colorpickers['color'];
        if (
            !textClass ||
            !colorPickerFg ||
            !computeColorClasses(colorPickerFg.getColorNames(), 'text-').includes(textClass)
        ) {
            textClass = '';
        }
        let fillClass = this.customColors['background-color'];
        const colorPickerBg = this.colorpickers['background-color'];
        if (
            !fillClass ||
            !colorPickerBg ||
            !computeColorClasses(colorPickerBg.getColorNames(), 'bg-').includes(fillClass)
        ) {
            fillClass = '';
        }
        return ` ${textClass} ${fillClass}`;
    },
    /**
     * @override
     */
    _isNewWindow: function () {
        return this.$('we-checkbox[name="isNewWindow"]').closest('we-button.o-we-checkbox-wrapper').hasClass('active');
    },
    /**
     * @override
     */
    _setSelectOption: function ($option, active) {
        $option.toggleClass('active', active);
        if (active) {
            $option.closest('we-select').find('we-toggler').text($option.text());
            // ensure only one option is active in the dropdown
            $option.siblings('we-button').removeClass("active");
        }
    },
    /**
     * @override
     */
    _updateOptionsUI: function () {
        const el = this.el.querySelector('[name="linkStyleColor"] we-button.active');
        if (el) {
            this.colorCombinationClass = el.dataset.value;
            // Hide the size and shape options if the link is an unstyled anchor.
            this.$('.link-size-row, .link-shape-row').toggleClass('d-none', !this.colorCombinationClass);
            // Show custom colors only for Custom style.
            this.$('.link-custom-color').toggleClass('d-none', el.dataset.value !== 'custom');

            this._updateColorpicker('color');
            this._updateColorpicker('background-color');
            this._updateColorpicker('border-color');

            const borderWidth = this.linkEl.style['border-width'];
            const numberAndUnit = getNumericAndUnit(borderWidth);
            this.$('.link-custom-color-border input').val(numberAndUnit ? numberAndUnit[0] : "1");
            let borderStyle = this.linkEl.style['border-style'];
            if (!borderStyle || borderStyle === 'none') {
                borderStyle = 'solid';
            }
            const $activeBorderStyleButton = this.$(`.link-custom-color-border [name="linkBorderStyle"] we-button[data-value="${borderStyle}"]`);
            $activeBorderStyleButton.addClass('active');
            $activeBorderStyleButton.siblings('we-button').removeClass("active");
            const $activeBorderStyleToggler = $activeBorderStyleButton.closest('we-select').find('we-toggler');
            $activeBorderStyleToggler.empty();
            $activeBorderStyleButton.find('div').clone().appendTo($activeBorderStyleToggler);
        }
    },
    /**
     * Updates the colorpicker associated to a given property - updated with its selected color.
     *
     * @private
     * @param {string} cssProperty
     */
    _updateColorpicker: async function (cssProperty) {
        const prefix = {
            'color': 'text-',
            'background-color': 'bg-',
        }[cssProperty];

        let colorpicker = this.colorpickers[cssProperty];
        await this.colorpickersPromises[cssProperty];
        if (!colorpicker) {
            colorpicker = new ColorPaletteWidget(this, {
                excluded: ['transparentGrayscale'],
                $editable: $(this.options.wysiwyg.verpEditor.editable),
                withGradients: cssProperty === 'background-color',
            });
            this.colorpickers[cssProperty] = colorpicker;
            const target = this.el.querySelector({
                'color': '.link-custom-color-text .dropdown-menu',
                'background-color': '.link-custom-color-fill .dropdown-menu',
                'border-color': '.link-custom-color-border .o-we-so-color-palette .dropdown-menu',
            }[cssProperty]);
            this.colorpickersPromises[cssProperty] = colorpicker.appendTo($(target));
            await this.colorpickersPromises[cssProperty];
            colorpicker.on('customColorPicked colorPicked colorHover colorLeave', this, (ev) => {
                // Reset color styles in link content to make sure new color is not hidden.
                // Only done when applied to avoid losing state during preview.
                if (['customColorPicked', 'colorPicked'].includes(ev.name)) {
                    const selection = window.getSelection();
                    const range = document.createRange();
                    range.selectNodeContents(this.linkEl);
                    selection.removeAllRanges();
                    selection.addRange(range);
                    this.options.wysiwyg.verpEditor.execCommand('applyColor', '', 'color');
                    this.options.wysiwyg.verpEditor.execCommand('applyColor', '', 'backgroundColor');
                }

                let color = ev.data.color;
                const colorNames = colorpicker.getColorNames();
                const colorClasses = prefix ? computeColorClasses(colorNames, prefix) : [];
                const colorClass = `${prefix}${color}`;
                if (colorClasses.includes(colorClass)) {
                    color = colorClass;
                } else if (colorNames.includes(color)) {
                    // Store as color value.
                    color = getCSSVariableValue(color);
                }
                this.customColors[cssProperty] = color;
                this.applyLinkToDom(this._getData());
                if (['customColorPicked', 'colorPicked'].includes(ev.name)) {
                    this.options.wysiwyg.verpEditor.historyStep();
                    this._updateOptionsUI();
                }
            });
        }

        // Update selected color.
        const colorNames = colorpicker.getColorNames();
        let color = this.linkEl.style[cssProperty];
        const colorClasses = prefix ? computeColorClasses(colorNames, prefix) : [];
        const colorClass = prefix && getColorClass(this.linkEl, colorNames, prefix);
        const isColorClass = colorClasses.includes(colorClass);
        if (isColorClass) {
            color = colorClass;
        } else if (cssProperty === 'background-color') {
            const gradientColor = this.linkEl.style['background-image'];
            if (isColorGradient(gradientColor)) {
                color = gradientColor;
            }
        }
        this.customColors[cssProperty] = color;
        if (cssProperty === 'border-color') {
            // Highlight matching named color if any.
            const colorName = colorpicker.colorToColorNames[ColorpickerWidget.normalizeCSSColor(color)];
            colorpicker.setSelectedColor(null, colorName || color, false);
        } else {
            colorpicker.setSelectedColor(null, isColorClass ? color.replace(prefix, '') : color, false);
        }

        // Update preview.
        const $colorPreview = this.$('.link-custom-color-' + (cssProperty === 'border-color' ? 'border' : cssProperty === 'color' ? 'text' : 'fill') + ' .o-we-color-preview');
        const previewClasses = computeColorClasses(colorNames, 'bg-');
        $colorPreview[0].classList.remove(...previewClasses);
        if (isColorClass) {
            $colorPreview.addClass(`bg-${color.replace(prefix, '')}`);
            $colorPreview.css('background-color', '');
            $colorPreview.css('background-image', '');
        } else {
            $colorPreview.css('background-color', isColorGradient(color) ? 'rgba(0, 0, 0, 0)' : color);
            $colorPreview.css('background-image', isColorGradient(color) ? color : '');
        }
    },
    /**
     * Add hint to the classes of the link and button.
     */
    _addHintClasses () {
        this.options.wysiwyg.verpEditor.observerUnactive("hintClasses");
        this.$link.addClass('oe-edited-link');
        this.$button.addClass('active');
        this.options.wysiwyg.verpEditor.observerActive("hintClasses");
    },
    /**
     * Remove hint to the classes of the link and button.
     */
    _removeHintClasses () {
        this.options.wysiwyg.verpEditor.observerUnactive("hintClasses");
        $(this.options.wysiwyg.verpEditor.document).find('.oe-edited-link').removeClass('oe-edited-link');
        this.$button.removeClass('active');
        this.options.wysiwyg.verpEditor.observerActive("hintClasses");
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    _onClickCheckbox: function (ev) {
        const $target = $(ev.target);
        $target.closest('we-button.o-we-checkbox-wrapper').toggleClass('active');
        this._adaptPreview();
    },
    _onPickSelectOption: function (ev) {
        const $target = $(ev.target);
        if ($target.closest('[name="linkBorderStyle"]').length) {
            return;
        }
        const $select = $target.closest('we-select');
        $select.find('we-selection-items we-button').toggleClass('active', false);
        this._setSelectOption($target, true);
        this._updateOptionsUI();
        this._adaptPreview();
    },
    /**
     * Sets the border width on the link.
     *
     * @private
     * @param {Event} ev
     */
    _onchangeCustomBorderWidth: function (ev) {
        const value = ev.target.value;
        if (parseInt(value) >= 0) {
            this.$link.css('border-width', value + 'px');
        }
    },
    /**
     * Sets the border width on the link when enter is pressed.
     *
     * @private
     * @param {Event} ev
     */
    _onKeyPressCustomBorderWidth: function (ev) {
        if (ev.keyCode === $.ui.keyCode.ENTER) {
            this._onchangeCustomBorderWidth(ev);
        }
    },
    /**
     * Sets the border style on the link.
     *
     * @private
     * @param {Event} ev
     */
    _onBorderStyleSelectOption: function (ev) {
        const value = ev.currentTarget.dataset.value;
        if (value) {
            this.$link.css('border-style', value);
            const $target = $(ev.currentTarget);
            const $activeBorderStyleToggler = $target.closest('we-select').find('we-toggler');
            $activeBorderStyleToggler.empty();
            $target.find('div').clone().appendTo($activeBorderStyleToggler);
            // Ensure only one option is active in the dropdown.
            $target.addClass('active');
            $target.siblings('we-button').removeClass("active");
            this.options.wysiwyg.verpEditor.historyStep();
        }
    },
});

return LinkTools;
});
