verp.define('web_editor.wysiwyg.iframe', function (require) {
'use strict';

var Wysiwyg = require('web_editor.wysiwyg');
var ajax = require('web.ajax');
var core = require('web.core');
var config = require('web.config');

var qweb = core.qweb;
var promiseCommon;
var promiseWysiwyg;


/**
 * Add option (inIframe) to load Wysiwyg in an iframe.
 **/
Wysiwyg.include({
    /**
     * Add options to load Wysiwyg in an iframe.
     *
     * @override
     * @param {boolean} options.inIframe
     **/
    init: function (parent, options) {
        this._super.apply(this, arguments);
        if (this.options.inIframe) {
            this._onupdateIframeId = 'onLoad' + _.upperFirst(this.id); // Tony
        }
    },
    /**
     * Load assets to inject into iframe.
     *
     * @override
     **/
    willStart: async function () {
        if (!this.options.inIframe) {
            return this._super();
        }

        var defAsset;
        if (this.options.iframeCssAssets) {
            defAsset = ajax.loadAsset(this.options.iframeCssAssets);
        } else {
            defAsset = Promise.resolve({
                cssLibs: [],
                cssContents: []
            });
        }

        promiseWysiwyg = promiseWysiwyg || ajax.loadAsset('web_editor.wysiwygIframeEditorAssets');
        this.defAsset = Promise.all([promiseWysiwyg, defAsset]);

        this.$target = this.$el;
        const _super = this._super.bind(this);

        await this.defAsset;
        await _super();
    },

    /**
     * @override
     **/
    start: async function () {
        const _super = this._super.bind(this);
        if (!this.options.inIframe) {
            return _super();
        } else {
            await this._loadIframe();
            return _super();
        }
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * @override
     **/
    _editorOptions: function () {
        let options = this._super.apply(this, arguments);
        options.getContextFromParentRect = () => {
            return this.$iframe && this.$iframe.length ? this.$iframe[0].getBoundingClientRect() : { top: 0, left: 0 };
        };
        return options;
    },
    /**
     * Create iframe, inject css and create a link with the content,
     * then inject the target inside.
     *
     * @private
     * @returns {Promise}
     */
    _loadIframe: function () {
        var self = this;
        this.$iframe = $('<iframe class="wysiwyg-iframe">').css({
            'min-height': '55vh',
            width: '100%'
        });
        var avoidDoubleLoad = 0; // this bug only appears on some configurations.

        // resolve promise on load
        var def = new Promise(function (resolve) {
            window.top[self._onupdateIframeId] = function (_avoidDoubleLoad) {
                if (_avoidDoubleLoad !== avoidDoubleLoad) {
                    console.warn('Wysiwyg iframe double load detected');
                    return;
                }
                delete window.top[self._onupdateIframeId];
                var $iframeTarget = self.$iframe.contents().find('#iframeTarget');
                // copy the html in itself to have the node prototypes relative
                // to this window rather than the iframe window.
                const $targetClone = $iframeTarget.clone();
                $targetClone.find('script').remove();
                $iframeTarget.html($targetClone.html());
                self.$iframeBody = $iframeTarget;
                $iframeTarget.attr("isMobile", config.device.isMobile);
                const $utilsZone = $('<div class="iframe-utils-zone">');
                self.$utilsZone = $utilsZone;

                const $iframeWrapper = $('<div class="iframe-editor-wrapper verp-editor">');
                const $codeview = $('<textarea class="o-codeview d-none"/>');
                self.$editable.addClass('o-editable oe-structure');

                $iframeTarget.append($codeview);
                $iframeTarget.append($iframeWrapper);
                $iframeTarget.append($utilsZone);
                $iframeWrapper.append(self.$editable);

                self.options.toolbarHandler = $('#webEditorTopEdit', self.$iframe[0].contentWindow.document);
                $iframeTarget.on('click', '.o-fullscreen-btn', function () {
                    $("body").toggleClass("o-field-widget-text-html-fullscreen");
                    var full = $("body").hasClass("o-field-widget-text-html-fullscreen");
                    self.$iframe.parents().toggleClass('o-form-fullscreen-ancestor', full);
                    $(window).trigger("resize"); // induce a resize() call and let other backend elements know (the navbar extra items management relies on this)
                });
                resolve();
            };
        });
        this.$iframe.data('loadDef', def); // for unit test

        // inject content in iframe

        this.$iframe.on('load', function onLoad (ev) {
            var _avoidDoubleLoad = ++avoidDoubleLoad;
            self.defAsset.then(function (assets) {
                if (_avoidDoubleLoad !== avoidDoubleLoad) {
                    console.warn('Wysiwyg immediate iframe double load detected');
                    return;
                }

                var iframeContent = qweb.render('wysiwyg.iframeContent', {
                    assets: assets,
                    updateIframeId: self._onupdateIframeId,
                    avoidDoubleLoad: _avoidDoubleLoad
                });
                self.$iframe[0].contentWindow.document
                    .open("text/html", "replace")
                    .write(`<!DOCTYPE html><html>${iframeContent}</html>`);
            });
            self.options.document = self.$iframe[0].contentWindow.document;
        });

        this.$iframe.insertAfter(this.$editable);

        return def;
    },

    _insertSnippetMenu: function () {
        if (this.options.inIframe) {
            return this.snippetsMenu.appendTo(this.$utilsZone);
        } else {
            return this._super.apply(this, arguments);
        }
    },
});

});
