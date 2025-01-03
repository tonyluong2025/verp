/** @verp-module alias=website.root */

import ajax from 'web.ajax';
import { _t } from 'web.core';
import KeyboardNavigationMixin from 'web.KeyboardNavigationMixin';
import {Markup} from 'web.utils';
import session from 'web.session';
import publicRootData from 'web.public.root';
import "web.zoomverp";
import { FullscreenIndication } from '@website/js/widgets/fullscreen_indication';

export const WebsiteRoot = publicRootData.PublicRoot.extend(KeyboardNavigationMixin, {
    // TODO remove KeyboardNavigationMixin in master
    events: _.extend({}, KeyboardNavigationMixin.events, publicRootData.PublicRoot.prototype.events || {}, {
        'click .js-change-lang': '_onLangChangeClick',
        'click .js-publish-management .js-publish-btn': '_onPublishBtnClick',
        'click .js-multi-website-switch': '_onWebsiteSwitch',
        'shown.bs.modal': '_onModalShown',
    }),
    customEvents: _.extend({}, publicRootData.PublicRoot.prototype.customEvents || {}, {
        'gmapApiRequest': '_onGMapAPIRequest',
        'gmapApiKeyRequest': '_onGMapAPIKeyRequest',
        'readyToCleanForSave': '_onWidgetsStopRequest',
        'seoObjectRequest': '_onSeoObjectRequest',
        'willRemoveSnippet': '_onWidgetsStopRequest',
    }),

    /**
     * @override
     */
    init() {
        this.isFullscreen = false;
        KeyboardNavigationMixin.init.call(this, {
            autoAccessKeys: false,
            skipRenderOverlay: true,
        });
        return this._super(...arguments);
    },
    /**
     * @override
     */
    willStart: async function () {
        this.fullscreenIndication = new FullscreenIndication(this);
        return Promise.all([
            this._super(...arguments),
            this.fullscreenIndication.appendTo(document.body),
        ]);
    },
    /**
     * @override
     */
    start: function () {
        KeyboardNavigationMixin.start.call(this);
        // Compatibility lang change ?
        if (!this.$('.js-change-lang').length) {
            var $links = this.$('.js-language-selector a:not([data-oe-id])');
            var m = $(_.min($links, function (l) {
                return $(l).attr('href').length;
            })).attr('href');
            $links.each(function () {
                var $link = $(this);
                var t = $link.attr('href');
                var l = (t === m) ? "default" : t.split('/')[1];
                $link.data('lang', l).addClass('js-change-lang');
            });
        }

        // Enable magnify on zommable img
        this.$('.zoomable img[data-zoom]').zoomVerp();

        return this._super.apply(this, arguments);
    },
    /**
     * @override
     */
    destroy() {
        KeyboardNavigationMixin.destroy.call(this);
        return this._super(...arguments);
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * @override
     */
    _getContext: function (context) {
        var html = document.documentElement;
        return _.extend({
            'websiteId': html.getAttribute('data-website-id') | 0,
        }, this._super.apply(this, arguments));
    },
    /**
     * @override
     */
    _getExtraContext: function (context) {
        var html = document.documentElement;
        return _.extend({
            'editable': !!(html.dataset.editable || $('[data-oe-model]').length), // temporary hack, this should be done in javascript
            'translatable': !!html.dataset.translatable,
            'editTranslations': !!html.dataset.editTranslations,
        }, this._super.apply(this, arguments));
    },
    /**
     * @private
     * @param {boolean} [refetch=false]
     */
    async _getGMapAPIKey(refetch) {
        if (refetch || !this._gmapAPIKeyProm) {
            this._gmapAPIKeyProm = new Promise(async resolve => {
                const data = await this._rpc({
                    route: '/website/googleMapsApiKey',
                });
                resolve(JSON.parse(data).googleMapsApiKey || '');
            });
        }
        return this._gmapAPIKeyProm;
    },
    /**
     * @override
     */
    _getPublicWidgetsRegistry: function (options) {
        var registry = this._super.apply(this, arguments);
        if (options.editableMode) {
            return _.pick(registry, function (PublicWidget) {
                return !PublicWidget.prototype.disabledInEditableMode;
            });
        }
        return registry;
    },
    /**
     * @private
     * @param {boolean} [editableMode=false]
     * @param {boolean} [refetch=false]
     */
    async _loadGMapAPI(editableMode, refetch) {
        // Note: only need refetch to reload a configured key and load the
        // library. If the library was loaded with a correct key and that the
        // key changes meanwhile... it will not work but we can agree the user
        // can bother to reload the page at that moment.
        if (refetch || !this._gmapAPILoading) {
            this._gmapAPILoading = new Promise(async resolve => {
                const key = await this._getGMapAPIKey(refetch);

                window.verpGmapApiPostLoad = (async function verpGmapApiPostLoad() {
                    await this._startWidgets(undefined, {editableMode: editableMode});
                    resolve(key);
                }).bind(this);

                if (!key) {
                    if (!editableMode && session.isAdmin) {
                        const message = _t("Cannot load google map.");
                        const urlTitle = _t("Check your configuration.");
                        this.displayNotification({
                            type: 'warning',
                            sticky: true,
                            message:
                                Markup`<div>
                                    <span>${message}</span><br/>
                                    <a href="/web#action=website.actionWebsiteConfiguration">${urlTitle}</a>
                                </div>`,
                        });
                    }
                    resolve(false);
                    this._gmapAPILoading = false;
                    return;
                }
                await ajax.loadJS(`https://maps.googleapis.com/maps/api/js?v=3.exp&libraries=places&callback=verpGmapApiPostLoad&key=${key}`);
            });
        }
        return this._gmapAPILoading;
    },
    /**
     * Toggles the fullscreen mode.
     *
     * @private
     * @param {boolean} state toggle fullscreen on/off (true/false)
     */
    _toggleFullscreen(state) {
        this.isFullscreen = state;
        if (this.isFullscreen) {
            this.fullscreenIndication.show();
        } else {
            this.fullscreenIndication.hide();
        }
        document.body.classList.add('o-fullscreen-transition');
        document.body.classList.toggle('o-fullscreen', this.isFullscreen);
        document.body.style.overflowX = 'hidden';
        let resizing = true;
        window.requestAnimationFrame(function resizeFunction() {
            window.dispatchEvent(new Event('resize'));
            if (resizing) {
                window.requestAnimationFrame(resizeFunction);
            }
        });
        let stopResizing;
        const onTransitionEnd = ev => {
            if (ev.target === document.body && ev.propertyName === 'padding-top') {
                stopResizing();
            }
        };
        stopResizing = () => {
            resizing = false;
            document.body.style.overflowX = '';
            document.body.removeEventListener('transitionend', onTransitionEnd);
            document.body.classList.remove('o-fullscreen-transition');
        };
        document.body.addEventListener('transitionend', onTransitionEnd);
        // Safeguard in case the transitionend event doesn't trigger for whatever reason.
        window.setTimeout(() => stopResizing(), 500);
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * @override
     */
    _onWidgetsStartRequest: function (ev) {
        ev.data.options = _.clone(ev.data.options || {});
        ev.data.options.editableMode = ev.data.editableMode;
        this._super.apply(this, arguments);
    },
    /**
     * @todo review
     * @private
     */
    _onLangChangeClick: function (ev) {
        ev.preventDefault();

        var $target = $(ev.currentTarget);
        // retrieve the hash before the redirect
        var redirect = {
            lang: $target.data('urlCode'),
            url: encodeURIComponent($target.attr('href').replace(/[&?]editTranslations[^&?]+/, '')),
            hash: encodeURIComponent(window.location.hash)
        };
        window.location.href = _.str.sprintf("/website/lang/%(lang)s?r=%(url)s%(hash)s", redirect);
    },
    /**
     * @private
     * @param {VerpEvent} ev
     */
    async _onGMapAPIRequest(ev) {
        ev.stopPropagation();
        const apiKey = await this._loadGMapAPI(ev.data.editableMode, ev.data.refetch);
        ev.data.onSuccess(apiKey);
    },
    /**
     * @private
     * @param {VerpEvent} ev
     */
    async _onGMapAPIKeyRequest(ev) {
        ev.stopPropagation();
        const apiKey = await this._getGMapAPIKey(ev.data.refetch);
        ev.data.onSuccess(apiKey);
    },
    /**
    /**
     * Checks information about the page SEO object.
     *
     * @private
     * @param {VerpEvent} ev
     */
    _onSeoObjectRequest: function (ev) {
        var res = this._unslugHtmlDataObject('seo-object');
        ev.data.callback(res);
    },
    /**
     * Returns a model/id object constructed from html data attribute.
     *
     * @private
     * @param {string} dataAttr
     * @returns {Object} an object with 2 keys: model and id, or null
     * if not found
     */
    _unslugHtmlDataObject: function (dataAttr) {
        var repr = $('html').data(dataAttr);
        var match = repr && repr.match(/(.+)\((\d+),(.*)\)/);
        if (!match) {
            return null;
        }
        return {
            model: match[1],
            id: match[2] | 0,
        };
    },
    /**
     * @todo review
     * @private
     */
    _onPublishBtnClick: function (ev) {
        ev.preventDefault();
        if (document.body.classList.contains('editor-enable')) {
            return;
        }

        var self = this;
        var $data = $(ev.currentTarget).parents(".js-publish-management:first");
        this._rpc({
            route: $data.data('controller') || '/website/publish',
            params: {
                id: +$data.data('id'),
                object: $data.data('object'),
            },
        })
        .then(function (result) {
            $data.toggleClass("css-published", result).toggleClass("css-unpublished", !result);
            $data.find('input').prop("checked", result);
            $data.parents("[data-publish]").attr("data-publish", +result ? 'on' : 'off');
        });
    },
    /**
     * @private
     * @param {Event} ev
     */
    _onWebsiteSwitch: function (ev) {
        var websiteId = ev.currentTarget.getAttribute('website-id');
        var websiteDomain = ev.currentTarget.getAttribute('domain');
        let url = `/website/force/${websiteId}`;
        if (websiteDomain && window.location.hostname !== websiteDomain) {
            url = websiteDomain + url;
        }
        const path = window.location.pathname + window.location.search + window.location.hash;
        window.location.href = $.param.querystring(url, {'path': path});
    },
    /**
     * @private
     * @param {Event} ev
     */
    _onModalShown: function (ev) {
        $(ev.target).addClass('modal-shown');
    },
    /**
     * @override
     */
    _onKeyDown(ev) {
        if (!session.userId) {
            return;
        }
        // If document.body doesn't contain the element, it was probably removed as a consequence of pressing Esc.
        // we don't want to toggle fullscreen as the removal (eg, closing a modal) is the intended action.
        if (ev.keyCode !== $.ui.keyCode.ESCAPE || !document.body.contains(ev.target) || ev.target.closest('.modal')) {
            return KeyboardNavigationMixin._onKeyDown.apply(this, arguments);
        }
        this._toggleFullscreen(!this.isFullscreen);
    },
});

export default {
    WebsiteRoot: WebsiteRoot,
};
