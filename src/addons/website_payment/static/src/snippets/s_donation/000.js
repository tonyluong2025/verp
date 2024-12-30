/** @verp-module **/

import {_t} from 'web.core';
import publicWidget from 'web.public.widget';

const CUSTOM_BUTTON_EXTRA_WIDTH = 10;

publicWidget.registry.DonationSnippet = publicWidget.Widget.extend({
    selector: '.s-donation',
    disabledInEditableMode: false,
    events: {
        'click .s-donation-btn': '_onClickPrefilledButton',
        'click .s-donation-donate-btn': '_onClickDonateNowButton',
        'input #sDonationRangeSlider': '_onInputRangeSlider',
    },

    /**
     * @override
     */
    async start() {
        await this._super(...arguments);
        this.$rangeSlider = this.$('#sDonationRangeSlider');
        this.defaultAmount = this.$target[0].dataset.defaultAmount;
        if (this.$rangeSlider.length) {
            this.$rangeSlider.val(this.defaultAmount);
            this._setBubble(this.$rangeSlider);
        }
        await this._displayCurrencies();
        const customButtonEl = this.el.querySelector("#sDonationAmountInput");
        if (customButtonEl) {
            const canvasEl = document.createElement("canvas");
            const context = canvasEl.getContext("2d");
            context.font = window.getComputedStyle(customButtonEl).font;
            const width = context.measureText(customButtonEl.placeholder).width;
            customButtonEl.style.maxWidth = `${Math.ceil(width) + CUSTOM_BUTTON_EXTRA_WIDTH}px`;
        }
    },
    /**
     * @override
     */
    destroy() {
        const customButtonEl = this.el.querySelector("#sDonationAmountInput");
        if (customButtonEl) {
            customButtonEl.style.maxWidth = "";
        }
        this.$target.find('.s-donation-currency').remove();
        this._deselectPrefilledButtons();
        this.$('.alert-danger').remove();
        this._super(...arguments);
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * @private
     */
    _deselectPrefilledButtons() {
        this.$('.s-donation-btn').removeClass('active');
    },
    /**
     * @private
     * @param {jQuery} $range
     */
    _setBubble($range) {
        const $bubble = this.$('.s-range-bubble');
        const val = $range.val();
        const min = $range[0].min || 0;
        const max = $range[0].max || 100;
        const newVal = Number(((val - min) * 100) / (max - min));
        const tipOffsetLow = 8 - (newVal * 0.16); // the range thumb size is 16px*16px. The '8' and the '0.16' are related to that 16px (50% and 1% of 16px)
        $bubble.contents().filter(function () {
            return this.nodeType === 3;
        }).replaceWith(val);

        // Sorta magic numbers based on size of the native UI thumb (source: https://css-tricks.com/value-bubbles-for-range-inputs/)
        $bubble[0].style.left = `calc(${newVal}% + (${tipOffsetLow}px))`;
    },
    /**
     * @private
     */
    _displayCurrencies() {
        return this._rpc({
            route: '/website/getCurrentCurrency',
        }).then((result) => {
            this.currency = result;
            this.$('.s-donation-currency').remove();
            const $prefilledButtons = this.$('.s-donation-btn, .s-range-bubble');
            _.each($prefilledButtons, button => {
                const before = result.position === "before";
                const $currencySymbol = document.createElement('span');
                $currencySymbol.innerText = result.symbol;
                $currencySymbol.classList.add('s-donation-currency', before ? "pr-1" : "pl-1");
                if (before) {
                    $(button).prepend($currencySymbol);
                } else {
                    $(button).append($currencySymbol);
                }
            });
        });
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * @private
     */
    _onClickPrefilledButton(ev) {
        const $button = $(ev.currentTarget);
        this._deselectPrefilledButtons();
        $button.addClass('active');
        if (this.$rangeSlider.length) {
            this.$rangeSlider.val($button[0].dataset.donationValue);
            this._setBubble(this.$rangeSlider);
        }
    },
    /**
     * @private
     */
    _onClickDonateNowButton(ev) {
        if (this.editableMode) {
            return;
        };
        this.$('.alert-danger').remove();
        const $buttons = this.$('.s-donation-btn');
        const $selectedButton = $buttons.filter('.active');
        let amount = $selectedButton.length ? $selectedButton[0].dataset.donationValue : 0;
        if (this.$target[0].dataset.displayOptions && !amount) {
            if (this.$rangeSlider.length) {
                amount = this.$rangeSlider.val();
            } else if ($buttons.length) {
                amount = parseFloat(this.$('#sDonationAmountInput').val());
                let errorMessage = '';
                const minAmount = this.$target[0].dataset.minimumAmount;
                if (!amount) {
                    errorMessage = _t("Please select or enter an amount");
                } else if (amount < parseFloat(minAmount)) {
                    const before = this.currency.position === "before" ? this.currency.symbol : "";
                    const after = this.currency.position === "after" ? this.currency.symbol : "";
                    errorMessage = _.str.sprintf(_t("The minimum donation amount is %s%s%s"), before, minAmount, after);
                }
                if (errorMessage) {
                    $(ev.currentTarget).before($('<p>', {
                        class: 'alert alert-danger',
                        text: errorMessage,
                    }));
                    return;
                }
            }
        }
        if (!amount) {
            amount = this.defaultAmount;
        }
        const $form = this.$('.s_donation_form');
        $('<input>').attr({type: 'hidden', name: 'amount', value: amount}).appendTo($form);
        $('<input>').attr({type: 'hidden', name: 'currencyId', value: this.currency.id}).appendTo($form);
        $('<input>').attr({type: 'hidden', name: 'csrfToken', value: verp.csrf_token}).appendTo($form);
        $('<input>').attr({type: 'hidden', name: 'donationOptions', value: JSON.stringify(this.el.dataset)}).appendTo($form);
        $form.submit();
    },
    /**
     * @private
     */
    _onInputRangeSlider(ev) {
        this._deselectPrefilledButtons();
        this._setBubble($(ev.currentTarget));
    },
});

export default {
    DonationSnippet: publicWidget.registry.DonationSnippet,
};