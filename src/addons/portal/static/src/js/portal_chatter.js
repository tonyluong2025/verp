verp.define('portal.chatter', function (require) {
'use strict';

var core = require('web.core');
const dom = require('web.dom');
var publicWidget = require('web.public.widget');
var time = require('web.time');
var portalComposer = require('portal.composer');
const {Markup} = require('web.utils');

var qweb = core.qweb;
var _t = core._t;

/**
 * Widget PortalChatter
 *
 * - Fetch message fron controller
 * - Display chatter: pager, total message, composer (according to access right)
 * - Provider API to filter displayed messages
 */
var PortalChatter = publicWidget.Widget.extend({
    template: 'portal.Chatter',
    xmlDependencies: ['/portal/static/src/xml/portal_chatter.xml'],
    events: {
        'click .o-portal-chatter-pager-btn': '_onClickPager',
        'click .o-portal-chatter-js-is-internal': 'async _onClickUpdateIsInternal',
    },

    /**
     * @constructor
     */
    init: function (parent, options) {
        var self = this;
        this.options = {};
        this._super.apply(this, arguments);

        this._setOptions(options);

        this.set('messages', []);
        this.set('messageCount', this.options['messageCount']);
        this.set('pager', {});
        this.set('domain', this.options['domain']);
        this._currentPage = this.options['pagerStart'];
    },
    /**
     * @override
     */
    willStart: function () {
        return Promise.all([
            this._super.apply(this, arguments),
            this._chatterInit()
        ]);
    },
    /**
     * @override
     */
    start: function () {
        // bind events
        this.on("change:messages", this, this._renderMessages);
        this.on("change:messageCount", this, function () {
            this._renderMessageCount();
            this.set('pager', this._pager(this._currentPage));
        });
        this.on("change:pager", this, this._renderPager);
        this.on("change:domain", this, this._onchangeDomain);
        // set options and parameters
        this.set('messageCount', this.options['messageCount']);
        this.set('messages', this.preprocessMessages(this.result['messages']));
        // bind bus event: this (portal.chatter) and 'portal.rating.composer' in portal_rating
        // are separate and sibling widgets, this event is to be triggered from portal.rating.composer,
        // hence bus event is bound to achieve usage of the event in another widget.
        core.bus.on('reloadChatterContent', this, this._reloadChatterContent);

        return Promise.all([this._super.apply(this, arguments), this._reloadComposer()]);
    },

    //--------------------------------------------------------------------------
    // Public
    //--------------------------------------------------------------------------

    /**
     * Fetch the messages and the message count from the server for the
     * current page and current domain.
     *
     * @param {Array} domain
     * @returns {Promise}
     */
    messageFetch: function (domain) {
        var self = this;
        return this._rpc({
            route: '/mail/chatterFetch',
            params: self._messageFetchPrepareParams(),
        }).then(function (result) {
            self.set('messages', self.preprocessMessages(result['messages']));
            self.set('messageCount', result['messageCount']);
            return result;
        });
    },
    /**
     * Update the messages format
     *
     * @param {Array<Object>} messages
     * @returns {Array}
     */
    preprocessMessages(messages) {
        _.each(messages, function (m) {
            m['authorAvatarUrl'] = _.str.sprintf('/web/image/%s/%s/author_avatar/50x50', 'mail.message', m.id);
            m['publishedDateStr'] = _.str.sprintf(_t('Published on %s'), moment(time.strToDatetime(m.date)).format('MMMM Do YYYY, h:mm:ss a'));
            m['body'] = Markup(m.body);
        });
        return messages;
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * Set options
     *
     * @param {Array<string>} options: new options to set
     */
    _setOptions: function (options) {
        // underscorize the camelcased option keys
        const defaultOptions = {
            'allowComposer': true,
            'displayComposer': false,
            'csrfToken': verp.csrfToken,
            'messageCount': 0,
            'pagerStep': 10,
            'pagerScope': 5,
            'pagerStart': 1,
            'isUserPublic': true,
            'isUserEmployee': false,
            'isUserPublisher': false,
            'hash': false,
            'pid': false,
            'domain': [],
            'twoColumns': false,
        };

        this.options = Object.entries(options).reduce(
            (acc, [key, value]) => {
                acc[_.str.underscored(key)] = value;
                return acc;
            },
            defaultOptions);
    },

    /**
     * Reloads chatter and message count after posting message
     *
     * @private
     */
    _reloadChatterContent: function (data) {
        this.messageFetch();
        this._reloadComposer();
    },
    _createComposerWidget: function () {
        return new portalComposer.PortalComposer(this, this.options);
    },
    /**
     * Destroy current composer widget and initialize and insert new widget
     *
     * @private
     */
    _reloadComposer: async function () {
        if (this._composer) {
            this._composer.destroy();
        }
        if (this.options.displayComposer) {
            this._composer = this._createComposerWidget();
            await this._composer.appendTo(this.$('.o-portal-chatter-composer'));
        }
    },
    /**
     * @private
     * @returns {Deferred}
     */
    _chatterInit: function () {
        var self = this;
        return this._rpc({
            route: '/mail/chatterInit',
            params: this._messageFetchPrepareParams()
        }).then(function (result) {
            self.result = result;
            self.options = _.extend(self.options, self.result['options'] || {});
            return result;
        });
    },
    /**
     * Change the current page by refreshing current domain
     *
     * @private
     * @param {Number} page
     * @param {Array} domain
     */
    _changeCurrentPage: function (page, domain) {
        this._currentPage = page;
        var d = domain ? domain : _.clone(this.get('domain'));
        this.set('domain', d); // trigger fetch message
    },
    _messageFetchPrepareParams: function () {
        var self = this;
        var data = {
            'resModel': this.options['resModel'],
            'resId': this.options['resId'],
            'limit': this.options['pagerStep'],
            'offset': (this._currentPage - 1) * this.options['pagerStep'],
            'allowComposer': this.options['allowComposer'],
        };
        // add token field to allow to post comment without being logged
        if (self.options['token']) {
            data['token'] = self.options['token'];
        }
        // add domain
        if (this.get('domain')) {
            data['domain'] = this.get('domain');
        }
        return data;
    },
    /**
     * Generate the pager data for the given page number
     *
     * @private
     * @param {Number} page
     * @returns {Object}
     */
    _pager: function (page) {
        page = page || 1;
        var total = this.get('messageCount');
        var scope = this.options['pagerScope'];
        var step = this.options['pagerStep'];

        // Compute Pager
        var pageCount = Math.ceil(parseFloat(total) / step);

        page = Math.max(1, Math.min(parseInt(page), pageCount));
        scope -= 1;

        var pmin = Math.max(page - parseInt(Math.floor(scope / 2)), 1);
        var pmax = Math.min(pmin + scope, pageCount);

        if (pmax - scope > 0) {
            pmin = pmax - scope;
        } else {
            pmin = 1;
        }

        var pages = [];
        _.each(_.range(pmin, pmax + 1), function (index) {
            pages.push(index);
        });

        return {
            "pageCount": pageCount,
            "offset": (page - 1) * step,
            "page": page,
            "pageStart": pmin,
            "pagePrevious": Math.max(pmin, page - 1),
            "pageNext": Math.min(pmax, page + 1),
            "pageEnd": pmax,
            "pages": pages
        };
    },
    _renderMessages: function () {
        this.$('.o-portal-chatter-messages').html(qweb.render("portal.chatterMessages", {widget: this}));
    },
    _renderMessageCount: function () {
        this.$('.o-message-counter').replaceWith(qweb.render("portal.chatterMessageCount", {widget: this}));
    },
    _renderPager: function () {
        this.$('.o-portal-chatter-pager').replaceWith(qweb.render("portal.pager", {widget: this}));
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    _onchangeDomain: function () {
        var self = this;
        this.messageFetch().then(function () {
            var p = self._currentPage;
            self.set('pager', self._pager(p));
        });
    },
    /**
     * @private
     * @param {MouseEvent} event
     */
    _onClickPager: function (ev) {
        ev.preventDefault();
        var page = $(ev.currentTarget).data('page');
        this._changeCurrentPage(page);
    },

    /**
     * Toggle isInternal state of message. Update both node data and
     * classes to ensure DOM is updated accordingly to RPC call result.
     * @private
     * @returns {Promise}
     */
    _onClickUpdateIsInternal: function (ev) {
        ev.preventDefault();

        var $elem = $(ev.currentTarget);
        return this._rpc({
            route: '/mail/updateIsInternal',
            params: {
                messageId: $elem.data('message-id'),
                isInternal: ! $elem.data('is-internal'),
            },
        }).then(function (result) {
            $elem.data('is-internal', result);
            if (result === true) {
                $elem.addClass('o-portal-message-internal-on');
                $elem.removeClass('o-portal-message-internal-off');
            } else {
                $elem.addClass('o-portal-message-internal-off');
                $elem.removeClass('o-portal-message-internal-on');
            }
        });
    },
});

publicWidget.registry.portalChatter = publicWidget.Widget.extend({
    selector: '.o-portal-chatter',

    /**
     * @override
     */
    async start() {
        const proms = [this._super.apply(this, arguments)];
        const chatter = new PortalChatter(this, this.$el.data());
        proms.push(chatter.appendTo(this.$el));
        await Promise.all(proms);
        // scroll to the right place after chatter loaded
        if (window.location.hash === `#${this.el.id}`) {
            dom.scrollTo(this.el, {duration: 0});
        }
    },
});

return {
    PortalChatter: PortalChatter,
};
});
