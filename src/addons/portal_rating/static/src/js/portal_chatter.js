verp.define('rating.portal.chatter', function (require) {
'use strict';

var core = require('web.core');
var portalChatter = require('portal.chatter');
var utils = require('web.utils');
var time = require('web.time');

var _t = core._t;
var PortalChatter = portalChatter.PortalChatter;
var qweb = core.qweb;

/**
 * PortalChatter
 *
 * Extends Frontend Chatter to handle rating
 */
PortalChatter.include({
    events: _.extend({}, PortalChatter.prototype.events, {
        // star based control
        'click .o-website-rating-select': '_onClickStarDomain',
        'click .o-website-rating-select_text': '_onClickStarDomainReset',
        // publisher comments
        'click .o-wrating-js-publisher-comment-btn': '_onClickPublisherComment',
        'click .o-wrating-js-publisher-comment-edit': '_onClickPublisherComment',
        'click .o-wrating-js-publisher-comment-delete': '_onClickPublisherCommentDelete',
        'click .o-wrating-js-publisher-comment-submit': '_onClickPublisherCommentSubmit',
        'click .o-wrating-js-publisher-comment-cancel': '_onClickPublisherCommentCancel',
    }),
    xmlDependencies: (PortalChatter.prototype.xmlDependencies || [])
        .concat([
            '/portal_rating/static/src/xml/portal_tools.xml',
            '/portal_rating/static/src/xml/portal_chatter.xml'
        ]),

    /**
     * @constructor
     */
    init: function (parent, options) {
        this._super.apply(this, arguments);
        // options
        if (!_.contains(this.options, 'displayRating')) {
            this.options = _.defaults(this.options, {
                'displayRating': false,
                'ratingDefaultValue': 0.0,
            });
        }
        // rating card
        this.set('ratingCardValues', {});
        this.set('ratingValue', false);
        this.on("change:ratingValue", this, this._onChangeRatingDomain);
    },
    /**
     * @override
     */
    start: function () {
        this._super.apply(this, arguments);
        this.on("change:ratingCardValues", this, this._renderRatingCard);
    },

    //--------------------------------------------------------------------------
    // Public
    //--------------------------------------------------------------------------

    /**
     * Update the messages format
     *
     * @param {Array<Object>} messages
     * @returns {Array}
     */
    preprocessMessages: function (messages) {
        var self = this;
        messages = this._super.apply(this, arguments);
        if (this.options['displayRating']) {
            _.each(messages, function (m, i) {
                m.ratingValue = self.roundToHalf(m['rating_value']);
                m.rating = self._preprocessCommentData(m.rating, i);
            });
        }
        // save messages in the widget to process correctly the publisher comment templates
        this.messages = messages;
        return messages;
    },
    /**
     * Round the given value with a precision of 0.5.
     *
     * Examples:
     * - 1.2 --> 1.0
     * - 1.7 --> 1.5
     * - 1.9 --> 2.0
     *
     * @param {Number} value
     * @returns Number
     **/
    roundToHalf: function (value) {
        var converted = parseFloat(value); // Make sure we have a number
        var decimal = (converted - parseInt(converted, 10));
        decimal = Math.round(decimal * 10);
        if (decimal === 5) {
            return (parseInt(converted, 10) + 0.5);
        }
        if ((decimal < 3) || (decimal > 7)) {
            return Math.round(converted);
        } else {
            return (parseInt(converted, 10) + 0.5);
        }
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * @override
     * @returns {Promise}
     */
    _chatterInit: async function () {
        const result = await this._super(...arguments);
        this._updateRatingCardValues(result);
        return result;
    },
    /**
     * @override
     * @param {Array} domain
     * @returns {Promise}
     */
    messageFetch: async function (domain) {
        const result = await this._super(...arguments);
        this._updateRatingCardValues(result);
        return result;
    },
    /**
     * Calculates and Updates rating values i.e. average, percentage
     *
     * @private
     */
    _updateRatingCardValues: function (result) {
        if (!result['ratingStats']) {
            return;
        }
        const ratingData = {
            'avg': Math.round(result['ratingStats']['avg'] * 100) / 100,
            'percent': [],
        };
        _.each(_.keys(result['ratingStats']['percent']).reverse(), function (rating) {
            ratingData['percent'].push({
                'num': rating,
                'percent': utils.roundPrecision(result['ratingStats']['percent'][rating], 0.01),
            });
        });
        this.set('ratingCardValues', ratingData);
    },
    /**
     * @override
     */
    _messageFetchPrepareParams: function () {
        var params = this._super.apply(this, arguments);
        if (this.options['displayRating']) {
            params['ratingInclude'] = true;
        }
        return params;
    },

    /**
     * render rating card
     *
     * @private
     */
    _renderRatingCard: function () {
        this.$('.o-website-rating-card-container').replaceWith(qweb.render("portal_rating.ratingCard", {widget: this}));
    },
    /**
     * Default rating data for publisher comment qweb template
     * @private
     * @param {Integer} messageIndex 
     */
    _newPublisherCommentData: function (messageIndex) {
        return {
            mesIndex: messageIndex,
            publisherId: this.options.partnerId,
            publisherAvatar: _.str.sprintf('/web/image/res.partner/%s/avatar_128/50x50', this.options.partnerId),
            publisherName: _t("Write your comment"),
            publisherDatetime: '',
            publisherComment: '',
        };
    }, 

     /**
     * preprocess the rating data comming from /website/rating/comment or the chatter_init
     * Can be also use to have new rating data for a new publisher comment
     * @param {JSON} rawRating 
     * @returns {JSON} the process rating data
     */
    _preprocessCommentData: function (rawRating, messageIndex) {
        var ratingData = {
            id: rawRating.id,
            mesIndex: messageIndex,
            publisherDatetime: rawRating.publisherDatetime ? moment(time.strToDatetime(rawRating.publisherDatetime)).format('MMMM Do YYYY, h:mm:ss a') : "",
            publisherComment: rawRating.publisherComment ? rawRating.publisherComment : '',
        };

        // split array (id, displayName) of publisherId into publisherId and publisherName
        if (rawRating.publisherId && rawRating.publisherId.length >= 2) {
            ratingData.publisherId = rawRating.publisherId[0];
            ratingData.publisherName = rawRating.publisherId[1];
            ratingData.publisherAvatar = _.str.sprintf('/web/image/res.partner/%s/avatar_128/50x50', ratingData.publisherId);
        }
        var commentData = _.extend(this._newPublisherCommentData(messageIndex), ratingData);
        return commentData;
    },

    /** ---------------
     * Selection of elements for the publisher comment feature
     * Only available from a source in a publisherComment or publisherCommentForm template
     */

    _getCommentContainer: function ($source) {
        return $source.parents(".o-wrating-publisher-container").first().find(".o-wrating-publisher-comment").first();
    },

    _getCommentButton: function ($source) {
        return $source.parents(".o-wrating-publisher-container").first().find(".o-wrating-js-publisher-comment-btn").first();
    },

    _getCommentTextarea: function ($source) {
        return $source.parents(".o-wrating-publisher-container").first().find(".o-portal-rating-comment-input").first();
    },

    _focusTextComment: function ($source) {
        this._getCommentTextarea($source).focus();
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * @private
     * @param {MouseEvent} ev
     */
    _onClickStarDomain: function (ev) {
        var $tr = this.$(ev.currentTarget);
        var num = $tr.data('star');
        if ($tr.css('opacity') === '1') {
            this.set('ratingValue', num);
            this.$('.o-website-rating-select').css({
                'opacity': 0.5,
            });
            this.$('.o-website-rating-select-text[data-star="' + num + '"]').css({
                'visibility': 'visible',
                'opacity': 1,
            });
            this.$('.o-website-rating-select[data-star="' + num + '"]').css({
                'opacity': 1,
            });
        }
    },
    /**
     * @private
     * @param {MouseEvent} ev
     */
    _onClickStarDomainReset: function (ev) {
        ev.stopPropagation();
        ev.preventDefault();
        this.set('ratingValue', false);
        this.$('.o-website-rating-select-text').css('visibility', 'hidden');
        this.$('.o-website-rating-select').css({
            'opacity': 1,
        });
    },

    /**
     * @private
     * @param {MouseEvent} ev
     */
    _onClickPublisherComment: function (ev) {
        var $source = this.$(ev.currentTarget);
        // If the form is already present => like cancel remove the form
        if (this._getCommentTextarea($source).length === 1) {
            this._getCommentContainer($source).empty();
            return;
        }
        var messageIndex = $source.data("mesIndex");
        var data = {isPublisher: this.options['isUserPublisher']}; 
        data.rating = this._newPublisherCommentData(messageIndex);
        
        var oldRating = this.messages[messageIndex].rating;
        data.rating.publisherComment = oldRating.publisherComment ? oldRating.publisherComment : '';
        this._getCommentContainer($source).html($(qweb.render("portal_rating.chatterRatingPublisherForm", data)));
        this._focusTextComment($source);
    },

    /**
     * @private
     * @param {MouseEvent} ev
     */
    _onClickPublisherCommentDelete: function (ev) {
        var self = this;
        var $source = this.$(ev.currentTarget);

        var messageIndex = $source.data("mesIndex");
        var ratingId = this.messages[messageIndex].rating.id;

        this._rpc({
            route: '/website/rating/comment',
            params: {
                "ratingId": ratingId,
                "publisherComment": '' // Empty publisher comment means no comment
            }
        }).then(function (res) {
            self.messages[messageIndex].rating = self._preprocessCommentData(res, messageIndex);
            self._getCommentButton($source).removeClass("d-none");
            self._getCommentContainer($source).empty();
        });
    },  

     /**
     * @private
     * @param {MouseEvent} ev
     */
    _onClickPublisherCommentSubmit: function (ev) {
        var self = this;
        var $source = this.$(ev.currentTarget);

        var messageIndex = $source.data("mesIndex");
        var comment = this._getCommentTextarea($source).val();
        var ratingId = this.messages[messageIndex].rating.id;

        this._rpc({
            route: '/website/rating/comment',
            params: {
                "ratingId": ratingId,
                "publisherComment": comment
            }
        }).then(function (res) {

            // Modify the related message
            self.messages[messageIndex].rating = self._preprocessCommentData(res, messageIndex);
            if (self.messages[messageIndex].rating.publisherComment !== '') {
                // Remove the button comment if exist and render the comment
                self._getCommentButton($source).addClass('d-none');
                self._getCommentContainer($source).html($(qweb.render("portal_rating.chatterRatingPublisherComment", { 
                    rating: self.messages[messageIndex].rating,
                    isPublisher: self.options.isUserPublisher
                })));
            } else {
                // Empty string or false considers as no comment
                self._getCommentButton($source).removeClass("d-none");
                self._getCommentContainer($source).empty();       
            }
        });
    },

     /**
     * @private
     * @param {MouseEvent} ev
     */
    _onClickPublisherCommentCancel: function (ev) {
        var $source = this.$(ev.currentTarget);
        var messageIndex = $source.data("mesIndex");

        var comment = this.messages[messageIndex].rating.publisherComment;
        if (comment) {
            var data = {
                rating: this.messages[messageIndex].rating,
                isPublisher: this.options.isUserPublisher
            };
            this._getCommentContainer($source).html($(qweb.render("portal_rating.chatterRatingPublisherComment", data)));
        } else {
            this._getCommentContainer($source).empty();
        }
    },

    /**
     * @private
     */
    _onChangeRatingDomain: function () {
        var domain = [];
        if (this.get('ratingValue')) {
            domain = [['ratingValue', '=', this.get('ratingValue')]];
        }
        this._changeCurrentPage(1, domain);
    },
});
});
