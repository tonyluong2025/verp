verp.define('rating.portal.composer', function (require) {
'use strict';

var core = require('web.core');
var portalComposer = require('portal.composer');

var _t = core._t;

var PortalComposer = portalComposer.PortalComposer;

/**
 * PortalComposer
 *
 * Extends Portal Composer to handle rating submission
 */
PortalComposer.include({
    events: _.extend({}, PortalComposer.prototype.events, {
        'click .stars i': '_onClickStar',
        'mouseleave .stars': '_onMouseleaveStarBlock',
        'mousemove .stars i': '_onMoveStar',
        'mouseleave .stars i': '_onMoveLeaveStar',
    }),

    /**
     * @constructor
     */
    init: function (parent, options) {
        this._super.apply(this, arguments);

        // apply ratio to default rating value
        if (options.defaultRatingValue) {
            options.defaultRatingValue = parseFloat(options.defaultRatingValue);
        }

        // default options
        this.options = _.defaults(this.options, {
            'defaultMessage': false,
            'defaultMessageId': false,
            'defaultRatingValue': 0.0,
            'forceSubmitUrl': false,
        });
        // star input widget
        this.labels = {
            '0': "",
            '1': _t("I hate it"),
            '2': _t("I don't like it"),
            '3': _t("It's okay"),
            '4': _t("I like it"),
            '5': _t("I love it"),
        };
        this.userClick = false; // user has click or not
        this.set("starValue", this.options.defaultRatingValue);
        this.on("change:starValue", this, this._onChangeStarValue);
    },
    /**
     * @override
     */
    start: function () {
        var self = this;
        return this._super.apply(this, arguments).then(function () {
            // rating stars
            self.$input = self.$('input[name="ratingValue"]');
            self.$starList = self.$('.stars').find('i');

            // set the default value to trigger the display of star widget and update the hidden input value.
            self.set("starValue", self.options.defaultRatingValue); 
            self.$input.val(self.options.defaultRatingValue);
        });
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * @override
     * @private
     */
    _prepareMessageData: function () {
        return Object.assign(this._super(...arguments) || {}, {
            'messageId': this.options.defaultMessageId,
            'ratingValue': this.$input.val()
        });
    },
    /**
     * @private
     */
    _onChangeStarValue: function () {
        var val = this.get("starValue");
        var index = Math.floor(val);
        var decimal = val - index;
        // reset the stars
        this.$starList.removeClass('fa-star fa-star-half-o').addClass('fa-star-o');

        this.$('.stars').find("i:lt(" + index + ")").removeClass('fa-star-o fa-star-half-o').addClass('fa-star');
        if (decimal) {
            this.$('.stars').find("i:eq(" + index + ")").removeClass('fa-star-o fa-star fa-star-half-o').addClass('fa-star-half-o');
        }
        this.$('.rate-text .badge').text(this.labels[index]);
    },
    /**
     * @private
     */
    _onClickStar: function (ev) {
        var index = this.$('.stars i').index(ev.currentTarget);
        this.set("starValue", index + 1);
        this.user_click = true;
        this.$input.val(this.get("starValue"));
    },
    /**
     * @private
     */
    _onMouseleaveStarBlock: function () {
        this.$('.rate-text').hide();
    },
    /**
     * @private
     * @param {MouseEvent} ev
     */
    _onMoveStar: function (ev) {
        var index = this.$('.stars i').index(ev.currentTarget);
        this.$('.rate-text').show();
        this.set("starValue", index + 1);
    },
    /**
     * @private
     */
    _onMoveLeaveStar: function () {
        if (!this.userClick) {
            this.set("starValue", parseInt(this.$input.val()));
        }
        this.userClick = false;
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * @override
     * @private
     */
    _onSubmitButtonClick: function (ev) {
        return this._super(...arguments).then((result) => {
            const $modal = this.$el.closest('#ratingpopupcomposer');
            $modal.on('hidden.bs.modal', () => {
              this.triggerUp('reloadRatingPopupComposer', result);
            });
            $modal.modal('hide');
        });
    },
});
});
