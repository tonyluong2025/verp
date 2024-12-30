verp.define('portal.rating.composer', function (require) {
'use strict';

const publicWidget = require('web.public.widget');
const session = require('web.session');
const portalComposer = require('portal.composer');
const {_t, qweb} = require('web.core');

const PortalComposer = portalComposer.PortalComposer;

/**
 * RatingPopupComposer
 *
 * Display the rating average with a static star widget, and open
 * a popup with the portal composer when clicking on it.
 **/
const RatingPopupComposer = publicWidget.Widget.extend({
    selector: '.o-rating-popup-composer',
    customEvents: {
        reloadRatingPopupComposer: '_onReloadRatingPopupComposer',
    },
    xmlDependencies: [
        '/portal/static/src/xml/portal_chatter.xml',
        '/portal_rating/static/src/xml/portal_chatter.xml',
        '/portal_rating/static/src/xml/portal_tools.xml',
        '/portal_rating/static/src/xml/portal_rating_composer.xml',
    ],

    willStart: function (parent) {
        const def = this._super.apply(this, arguments);

        const options = this.$el.data();
        this.ratingAvg = Math.round(options['ratingAvg'] * 100) / 100 || 0.0;
        this.ratingCount = options['ratingCount'] || 0.0;

        this.options = _.defaults({}, options, {
            'token': false,
            'resModel': false,
            'resId': false,
            'pid': 0,
            'displayRating': true,
            'csrfToken': verp.csrfToken,
            'userId': session.userId,
        });

        return def;
    },

    /**
     * @override
     */
    start: function () {
        return Promise.all([
            this._super.apply(this, arguments),
            this._reloadRatingPopupComposer(),
        ]);
    },

    /**
     * Destroy existing ratingPopup and insert new ratingPopup widget
     *
     * @private
     * @param {Object} data
     */
    _reloadRatingPopupComposer: function () {
        if (this.options.hideRatingAvg) {
            this.$('.o-rating-popup-composer-stars').empty();
        } else {
            const ratingAverage = qweb.render(
                'portal_rating.ratingStarsStatic', {
                inline_mode: true,
                widget: this,
                val: this.ratingAvg,
            });
            this.$('.o-rating-popup-composer-stars').empty().html(ratingAverage);
        }

        // Append the modal
        const modal = qweb.render(
            'portal_rating.PopupComposer', {
            inlineMode: true,
            widget: this,
            val: this.ratingAvg,
        });
        this.$('.o-rating-popup-composer-modal').html(modal);

        if (this._composer) {
            this._composer.destroy();
        }

        // Instantiate the "Portal Composer" widget and insert it into the modal
        this._composer = new PortalComposer(this, this.options);
        return this._composer.appendTo(this.$('.o-rating-popup-composer-modal .o-portal-chatter-composer')).then(() => {
            // Change the text of the button
            this.$('.o-rating-popup-composer-text').text(
                this.options.defaultMessageId ?
                _t('Modify your review') : _t('Add a review')
            );
        });
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * @private
     * @param {VerpEvent} event
     */
    _onReloadRatingPopupComposer: function (event) {
        const data = event.data;

        // Refresh the internal state of the widget
        this.ratingAvg = data.ratingAvg;
        this.ratingCount = data.ratingCount;
        this.ratingValue = data.ratingValue;

        // Clean the dictionary
        delete data.ratingAvg;
        delete data.ratingCount;
        delete data.ratingValue;

        this.options = _.extend(this.options, data);

        this._reloadRatingPopupComposer();
    }
});

publicWidget.registry.RatingPopupComposer = RatingPopupComposer;

return RatingPopupComposer;

});
