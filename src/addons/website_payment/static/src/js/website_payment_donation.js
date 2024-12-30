/** @verp-module **/

import publicWidget from 'web.public.widget';

publicWidget.registry.WebsitePaymentDonation = publicWidget.Widget.extend({
    selector: '.o-donation-payment-form',
    events: {
        'focus .o-amount-input': '_onFocusAmountInput',
        'change #donationCommentCheckbox': '_onChangeDonationComment'
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * @private
     * @param {Event} ev
     */
    _onFocusAmountInput(ev) {
        this.$target.find('#otherAmount').prop("checked", true);
    },
    /**
     * @private
     * @param {Event} ev
     */
    _onChangeDonationComment(ev) {
        const $donationComment = this.$target.find('#donationComment');
        const checked = $(ev.currentTarget).is(':checked');
        $donationComment.toggleClass('d-none', !checked);
        if (!checked) {
            $donationComment.val('');
        }
    },
});
