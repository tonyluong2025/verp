verp.define('website.editMenu', function (require) {
'use strict';

var core = require('web.core');
var dom = require('web.dom');
var wysiwygLoader = require('web_editor.loader');
var websiteNavbarData = require('website.navbar');
var Dialog = require('web.Dialog');

const { registry } = require("@web/core/registry");

var _t = core._t;

/**
 * Adds the behavior when clicking on the 'edit' button (+ editor interaction)
 */
var EditPageMenu = websiteNavbarData.WebsiteNavbarActionWidget.extend({
    assetLibs: ['web_editor.compiledAssetsWysiwyg', 'website.compiledAssetsWysiwyg'],

    xmlDependencies: ['/website/static/src/xml/website.editor.xml'],
    actions: _.extend({}, websiteNavbarData.WebsiteNavbarActionWidget.prototype.actions, {
        edit: '_startEditMode',
        onSave: '_onSave',
    }),
    customEvents: _.extend({}, websiteNavbarData.WebsiteNavbarActionWidget.customEvents || {}, {
        contentWillBeDestroyed: '_onContentWillBeDestroyed',
        contentWasRecreated: '_onContentWasRecreated',
        snippetWillBeCloned: '_onSnippetWillBeCloned',
        snippetCloned: '_onSnippetCloned',
        snippetDropped: '_onSnippetDropped',
        snippetRemoved: '_onSnippetRemoved',
        editionWillStopped: '_onEditionWillStop',
        editionWasStopped: '_onEditionWasStopped',
        requestSave: '_onSnippetRequestSave',
        requestCancel: '_onSnippetRequestCancel',
    }),

    /**
     * @constructor
     */
    init: function (parent, options = {}) {
        this._super.apply(this, arguments);
        this.options = options;
        this.wysiwygOptions = options.wysiwygOptions || {};
        var context;
        this.triggerUp('contextGet', {
            extra: true,
            callback: function (ctx) {
                context = ctx;
            },
        });
        this.oeStructureSelector = '#wrapwrap .oe-structure[data-oe-xpath][data-oe-id]';
        this.oeFieldSelector = '#wrapwrap [data-oe-field]';
        this.oeCoverSelector = '#wrapwrap .s-cover[data-res-model], #wrapwrap .o-record-cover-container[data-res-model]';
        if (options.savableSelector) {
            this.savableSelector = options.savableSelector;
        } else {
            this.savableSelector = `${this.oeStructureSelector}, ${this.oeFieldSelector}, ${this.oeCoverSelector}`;
        }
        this.editableFromEditorMenu = options.editableFromEditorMenu || this.editableFromEditorMenu;
        this._editorAutoStart = (context.editable && window.location.search.indexOf('enableEditor') >= 0);
        var url = new URL(window.location.href);
        url.searchParams.delete('enableEditor');
        url.searchParams.delete('withLoader');
        window.history.replaceState({}, null, url);
    },
    /**
     * Auto-starts the editor if necessary or add the welcome message otherwise.
     *
     * @override
     */
    start() {
        var def = this._super.apply(this, arguments);

        // If we auto start the editor, do not show a welcome message
        if (this._editorAutoStart) {
            return Promise.all([def, this._startEditMode()]);
        }

        // Check that the page is empty
        var $wrap = this._targetForEdition().filter('#wrapwrap.homepage').find('#wrap');

        if ($wrap.length && $wrap.html().trim() === '') {
            // If readonly empty page, show the welcome message
            this.$welcomeMessage = $(core.qweb.render('website.homepageEditorWelcomeMessage'));
            this.$welcomeMessage.addClass('oHomepageEditorWelcomeMessage');
            this.$welcomeMessage.css('min-height', $wrap.parent('main').height() - ($wrap.outerHeight(true) - $wrap.height()));
            $wrap.empty().append(this.$welcomeMessage);
        }

        return def;
    },

    /**
     * Asks the snippets to clean themself, then saves the page, then reloads it
     * if asked to.
     *
     * @param {boolean} [reload=true]
     *        true if the page has to be reloaded after the save
     * @returns {Promise}
     */
    save: async function (reload = true) {
        if (this._saving) {
            return false;
        }
        if (this.observer) {
            this.observer.disconnect();
            this.observer = undefined;
        }
        var self = this;
        this._saving = true;
        this.triggerUp('editionWillStopped', {
            // TODO adapt in master, this was added as a stable fix. This
            // trigger to 'editionWillStopped' was left by mistake
            // during an editor refactoring + revert fail. It stops the public
            // widgets at the wrong time, potentially dead-locking the editor.
            // 'readyToCleanForSave' is the one in charge of stopping the
            // widgets at the proper time.
            noWidgetsStop: true,
        });
        const destroy = () => {
            self.wysiwyg.destroy();
            self.triggerUp('editionWasStopped');
            self.destroy();
        };
        if (!this.wysiwyg.isDirty()) {
            destroy();
            if (reload) {
                window.location.reload();
            }
            return;
        }
        this.wysiwyg.__editionWillStoppedAlreadyDone = true; // TODO adapt in master, see above
        return this.wysiwyg.saveContent(false).then((result) => {
            delete this.wysiwyg.__editionWillStoppedAlreadyDone;
            var $wrapwrap = $('#wrapwrap');
            self.editableFromEditorMenu($wrapwrap).removeClass('o-editable');
            if (reload) {
                // remove top padding because the connected bar is not visible
                $('body').removeClass('o-connected-user');
                return self._reload();
            } else {
                destroy();
            }
            return true;
        }).guardedCatch(() => {
            this._saving = false;
        });
    },
    /**
     * Asks the user if they really wants to discard their changes (if any),
     * then simply reloads the page if they want to.
     *
     * @param {boolean} [reload=true]
     *        true if the page has to be reloaded when the user answers yes
     *        (do nothing otherwise but add this to allow class extension)
     * @returns {Deferred}
     */
    cancel: function (reload = true) {
        var self = this;
        var def = new Promise(function (resolve, reject) {
            if (!self.wysiwyg.isDirty()) {
                resolve();
            } else {
                var confirm = Dialog.confirm(self, _t("If you discard the current edits, all unsaved changes will be lost. You can cancel to return to edit mode."), {
                    confirmCallback: resolve,
                });
                confirm.on('closed', self, reject);
            }
        });

        return def.then(function () {
            self.triggerUp('editionWillStopped');
            var $wrapwrap = $('#wrapwrap');
            self.editableFromEditorMenu($wrapwrap).removeClass('o-editable');
            if (reload) {
                window.onbeforeunload = null;
                self.wysiwyg.destroy();
                return self._reload();
            } else {
                self.wysiwyg.destroy();
                self.triggerUp('readonlyMode');
                self.triggerUp('editionWasStopped');
                self.destroy();
            }
        });
    },
    /**
     * Returns the editable areas on the page.
     *
     * @param {DOM} $wrapwrap
     * @returns {jQuery}
     */
    editableFromEditorMenu: function ($wrapwrap) {
        return $wrapwrap.find('[data-oe-model]')
            .not('.o-not-editable')
            .filter(function () {
                var $parent = $(this).closest('.o-editable, .o-not-editable');
                return !$parent.length || $parent.hasClass('o-editable');
            })
            .not('link, script')
            .not('[data-oe-readonly]')
            .not('img[data-oe-field="arch"], br[data-oe-field="arch"], input[data-oe-field="arch"]')
            .not('.oe-snippet-editor')
            .not('hr, br, input, textarea')
            .add('.o-editable');
    },

    //--------------------------------------------------------------------------
    // Actions
    //--------------------------------------------------------------------------

    /**
     * Creates an editor instance and appends it to the DOM. Also remove the
     * welcome message if necessary.
     *
     * @private
     * @returns {Promise}
     */
    _startEditMode: async function () {
        var self = this;
        if (this.editModeEnable) {
            return;
        }

        $.blockUI({overlayCSS: {
            backgroundColor: '#000',
            opacity: 0,
            zIndex: 1050
        }, message: false});

        this.triggerUp('widgetsStopRequest', {
            $target: this._targetForEdition(),
        });
        if (this.$welcomeMessage) {
            this.$welcomeMessage.detach(); // detach from the readonly rendering before the clone by wysiwyg.
        }
        this.editModeEnable = true;

        await this._createWysiwyg();

        var res = await new Promise(function (resolve, reject) {
            self.triggerUp('widgetsStartRequest', {
                editableMode: true,
                onSuccess: resolve,
                onFailure: reject,
            });
        });

        const $loader = $('div.o-theme-install-loader-container');
        if ($loader) {
            $loader.remove();
        }

        $.unblockUI();

        return res;
    },
    /**
     * On save, the editor will ask to parent widgets if something needs to be
     * done first. The website navbar will receive that demand and asks to its
     * action-capable components to do something. For example, the content menu
     * handles page-related options saving. However, some users with limited
     * access rights do not have the content menu... but the website navbar
     * expects that the save action is performed. So, this empty action is
     * defined here so that all users have an 'onSave' related action.
     *
     * @private
     * @todo improve the system to somehow declare required/optional actions
     */
    _onSave: function () {},

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    async _createWysiwyg() {
        var $wrapwrap = $('#wrapwrap');
        $wrapwrap.removeClass('o-editable'); // clean the dom before edition
        this.editableFromEditorMenu($wrapwrap).addClass('o-editable');

        this.wysiwyg = await this._wysiwygInstance();

        await this.wysiwyg.attachTo($('#wrapwrap'));
        this.triggerUp('editMode'); // Tony check
        this.$el.css({width: ''});

        // Only make the verp structure and fields editable.
        this.wysiwyg.verpEditor.observerUnactive();
        $('#wrapwrap').on('click.verp-website-editor', '*', this, this._preventDefault);
        this._addEditorMessages(); // Insert editor messages in the DOM without observing.
        if (this.options.beforeEditorActive) {
            this.options.beforeEditorActive();
        }
        this.wysiwyg.verpEditor.observerActive();

        // 1. Make sure every .o-not-editable is not editable.
        // 2. Observe changes to mark dirty structures and fields.
        const processRecords = (records) => {
            records = this.wysiwyg.verpEditor.filterMutationRecords(records);
            // Skip the step for this stack because if the editor undo the first
            // step that has a dirty element, the following code would have
            // generated a new stack and break the "redo" of the editor.
            this.wysiwyg.verpEditor.automaticStepSkipStack();

            for (const record of records) {
                const $savable = $(record.target).closest(this.savableSelector);

                if (record.attributeName === 'contenteditable') {
                    continue;
                }
                $savable.not('.o-dirty').each(function () {
                    if (!this.hasAttribute('data-oe-readonly')) {
                        this.classList.add('o-dirty');
                    }
                });
            }
        };
        this.observer = new MutationObserver(processRecords);
        const observe = () => {
            if (this.observer) {
                this.observer.observe(document.body, {
                    childList: true,
                    subtree: true,
                    attributes: true,
                    attributeOldValue: true,
                    characterData: true,
                });
            }
        };
        observe();

        this.wysiwyg.verpEditor.addEventListener('observerUnactive', () => {
            if (this.observer) {
                processRecords(this.observer.takeRecords());
                this.observer.disconnect();
            }
        });
        this.wysiwyg.verpEditor.addEventListener('observerActive', observe);

        $('body').addClass('editor-started');
    },

    _getContentEditableAreas() {
        const $savableZones = $(this.savableSelector);
        const $editableSavableZones = $savableZones
            .not('input, [data-oe-readonly], ' +
                 '[data-oe-type="monetary"], [data-oe-many2one-id], [data-oe-field="arch"]:empty')
            .filter((_, el) => {
                return !$(el).closest('.o-not-editable').length;
            });

        // TODO review in master. This stable fix restores the possibility to
        // edit the company team snippet images on subsequent editions. Indeed
        // this badly relies on the contenteditable="true" attribute being on
        // those images but it is rightfully lost after the first save.
        // grep: COMPANY_TEAM_CONTENTEDITABLE
        const $extraEditableZones = $editableSavableZones.find('.s-company-team .o-not-editable img');

        return $editableSavableZones.add($extraEditableZones).toArray();
    },

    _getReadOnlyAreas () {
        return [];
    },
    _getUnremovableElements () {
        return this._targetForEdition()[0].querySelectorAll("#topMenu a:not(.oe-unremovable)");
    },
    /**
     * Call preventDefault of an event.
     *
     * @private
     */
    _preventDefault(e) {
        e.preventDefault();
    },
    /**
     * Adds automatic editor messages on drag&drop zone elements.
     *
     * @private
     */
    _addEditorMessages: function () {
        const $editable = this._targetForEdition().find('.oe-structure.oe-empty, [data-oe-type="html"]');
        this.$editorMessageElements = $editable
            .not('[data-editor-message]')
            .attr('data-editor-message', _t('DRAG BUILDING BLOCKS HERE'));
        $editable.filter(':empty').attr('contenteditable', false);
    },
    /**
     * Returns the target for edition.
     *
     * @private
     * @returns {JQuery}
     */
    _targetForEdition: function () {
        return $('#wrapwrap'); // TODO should know about this element another way
    },
    /**
     * Reloads the page in non-editable mode, with the right scrolling.
     *
     * @private
     * @returns {Deferred} (never resolved, the page is reloading anyway)
     */
    _reload: function () {
        $('body').addClass('o-wait-reload');
        this.wysiwyg.destroy();
        this.$el.hide();
        window.location.hash = 'scrollTop=' + window.document.body.scrollTop;
        window.location.reload(true);
        return new Promise(function () {});
    },
    /**
     * @private
     */
    _wysiwygInstance: function () {
        // todo: retrieve other config if there is no #wrap element on the page (eg. product, blog, ect.)
        let collaborationConfig = {};
        // todo: To uncomment when enabling the collaboration on website.
        // const $wrap = $('#wrapwrap #wrap[data-oe-model][data-oe-field][data-oe-id]');
        // if ($wrap.length) {
        //     collaborationConfig = {
        //         collaborationChannel: {
        //             collaborationModelName: $wrap.attr('data-oe-model'),
        //             collaborationFieldName: $wrap.attr('data-oe-field'),
        //             collaborationResId: parseInt($wrap.attr('data-oe-id')),
        //         }
        //     };
        // }

        var context;
        this.triggerUp('contextGet', {
            callback: function (ctx) {
                context = ctx;
            },
        });
        const params = Object.assign({
            snippets: 'website.snippets',
            recordInfo: {
                context: context,
                dataResModel: 'website',
                dataResId: context.websiteId,
            },
            enableWebsite: true,
            discardButton: true,
            saveButton: true,
            devicePreview: true,
            savableSelector: this.savableSelector,
            isRootEditable: false,
            controlHistoryFromDocument: true,
            getContentEditableAreas: this._getContentEditableAreas.bind(this),
            powerboxCommands: this._getSnippetsCommands(),
            bindLinkTool: true,
            showEmptyElementHint: false,
            getReadOnlyAreas: this._getReadOnlyAreas.bind(this),
            getUnremovableElements: this._getUnremovableElements.bind(this),
        }, collaborationConfig);
        return wysiwygLoader.createWysiwyg(this,
            Object.assign(params, this.wysiwygOptions),
            ['website.compiledAssetsWysiwyg']
        );
    },
    _getSnippetsCommands: function () {
        const snippetCommandCallback = (selector) => {
            const $separatorBody = $(selector);
            const $clonedBody = $separatorBody.clone().removeClass('oe-snippet-body');
            const range = this.wysiwyg.getDeepRange();
            const block = this.wysiwyg.closestElement(range.endContainer, 'p, div, ol, ul, cl, h1, h2, h3, h4, h5, h6');
            if (block) {
                block.after($clonedBody[0]);
                this.wysiwyg.snippetsMenu.callPostSnippetDrop($clonedBody);
            }
        };
        return [
            {
                groupName: _t('Website'),
                title: _t('Alert'),
                description: _t('Insert an alert snippet.'),
                fontawesome: 'fa-info',
                callback: () => {
                    snippetCommandCallback('.oe-snippet-body[data-snippet="sAlert"]');
                },
            },
            {
                groupName: _t('Website'),
                title: _t('Rating'),
                description: _t('Insert a rating snippet.'),
                fontawesome: 'fa-star-half-o',
                callback: () => {
                    snippetCommandCallback('.oe-snippet-body[data-snippet="sRating"]');
                },
            },
            {
                groupName: _t('Website'),
                title: _t('Card'),
                description: _t('Insert a card snippet.'),
                fontawesome: 'fa-sticky-note',
                callback: () => {
                    snippetCommandCallback('.oe-snippet-body[data-snippet="sCard"]');
                },
            },
            {
                groupName: _t('Website'),
                title: _t('Share'),
                description: _t('Insert a share snippet.'),
                fontawesome: 'fa-share-square-o',
                callback: () => {
                    snippetCommandCallback('.oe-snippet-body[data-snippet="sShare"]');
                },
            },
            {
                groupName: _t('Website'),
                title: _t('Text Highlight'),
                description: _t('Insert a text Highlight snippet.'),
                fontawesome: 'fa-sticky-note',
                callback: () => {
                    snippetCommandCallback('.oe-snippet-body[data-snippet="sTextHighlight"]');
                },
            },
            {
                groupName: _t('Website'),
                title: _t('Chart'),
                description: _t('Insert a chart snippet.'),
                fontawesome: 'fa-bar-chart',
                callback: () => {
                    snippetCommandCallback('.oe-snippet-body[data-snippet="sChart"]');
                },
            },
            {
                groupName: _t('Website'),
                title: _t('Progress Bar'),
                description: _t('Insert a progress bar snippet.'),
                fontawesome: 'fa-spinner',
                callback: () => {
                    snippetCommandCallback('.oe-snippet-body[data-snippet="sProgressBar"]');
                },
            },
            {
                groupName: _t('Website'),
                title: _t('Badge'),
                description: _t('Insert a badge snippet.'),
                fontawesome: 'fa-tags',
                callback: () => {
                    snippetCommandCallback('.oe-snippet-body[data-snippet="sBadge"]');
                },
            },
            {
                groupName: _t('Website'),
                title: _t('Blockquote'),
                description: _t('Insert a blockquote snippet.'),
                fontawesome: 'fa-quote-left',
                callback: () => {
                    snippetCommandCallback('.oe-snippet-body[data-snippet="sBlockquote"]');
                },
            },
            {
                groupName: _t('Website'),
                title: _t('Separator'),
                description: _t('Insert an horizontal separator sippet.'),
                fontawesome: 'fa-minus',
                callback: () => {
                    snippetCommandCallback('.oe-snippet-body[data-snippet="sHr"]');
                },
            },
        ];
    },


    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * Called when content will be destroyed in the page. Notifies the
     * WebsiteRoot that is should stop the public widgets.
     *
     * @private
     * @param {VerpEvent} ev
     */
    _onContentWillBeDestroyed: function (ev) {
        this.triggerUp('widgetsStopRequest', {
            $target: ev.data.$target,
        });
    },
    /**
     * Called when content was recreated in the page. Notifies the
     * WebsiteRoot that is should start the public widgets.
     *
     * @private
     * @param {VerpEvent} ev
     */
    _onContentWasRecreated: function (ev) {
        this.triggerUp('widgetsStartRequest', {
            editableMode: true,
            $target: ev.data.$target,
        });
    },
    /**
     * Called when edition will stop.
     *
     * @private
     * @param {VerpEvent} ev
     */
    _onEditionWillStop: function (ev) {
        this.$editorMessageElements && this.$editorMessageElements.removeAttr('data-editor-message');

        if (!ev.data.noWidgetsStop) { // TODO adapt in master, this was added as a stable fix.
            this.triggerUp('widgetsStopRequest', {
                $target: this._targetForEdition(),
            });
        }

        if (this.observer) {
            this.observer.disconnect();
            this.observer = undefined;
        }
    },
    /**
     * Called when edition was stopped. Notifies the
     * WebsiteRoot that is should start the public widgets.
     *
     * @private
     * @param {VerpEvent} ev
     */
    _onEditionWasStopped: function (ev) {
        this.editModeEnable = false;
    },
    /**
     * Called when a snippet is about to be cloned in the page. Notifies the
     * WebsiteRoot that is should destroy the animations for this snippet.
     *
     * @private
     * @param {VerpEvent} ev
     */
    _onSnippetWillBeCloned: function (ev) {
        this.triggerUp('widgetsStopRequest', {
            $target: ev.data.$target,
        });
    },
    /**
     * Called when a snippet is cloned in the page. Notifies the WebsiteRoot
     * that is should start the public widgets for this snippet and the snippet it
     * was cloned from.
     *
     * @private
     * @param {VerpEvent} ev
     */
    _onSnippetCloned: function (ev) {
        this.triggerUp('widgetsStartRequest', {
            editableMode: true,
            $target: ev.data.$target,
        });
        // TODO: remove in saas-12.5, undefined $origin will restart #wrapwrap
        if (ev.data.$origin) {
            this.triggerUp('widgetsStartRequest', {
                editableMode: true,
                $target: ev.data.$origin,
            });
        }
    },
    /**
     * Called when a snippet is dropped in the page. Notifies the WebsiteRoot
     * that is should start the public widgets for this snippet. Also marks the
     * wrapper element as non-empty and makes it editable.
     *
     * @private
     * @param {VerpEvent} ev
     */
    _onSnippetDropped: function (ev) {
        this._targetForEdition().find('.oe-structure.oe-empty, [data-oe-type="html"]')
            .attr('contenteditable', true);
        ev.data.addPostDropAsync(new Promise(resolve => {
            this.triggerUp('widgetsStartRequest', {
                editableMode: true,
                $target: ev.data.$target,
                onSuccess: () => resolve(),
            });
        }));
    },
    /**
     * Called when a snippet is removed from the page. If the wrapper element is
     * empty, marks it as such and shows the editor messages.
     *
     * @private
     * @param {VerpEvent} ev
     */
    _onSnippetRemoved: function (ev) {
        const $editable = this._targetForEdition().find('.oe-structure.oe-empty, [data-oe-type="html"]');
        if (!$editable.children().length) {
            $editable.empty(); // remove any superfluous whitespace
            this._addEditorMessages();
        }
    },
    /**
     * Snippet (menuData) can request to save the document to leave the page
     *
     * @private
     * @param {VerpEvent} ev
     * @param {object} ev.data
     * @param {function} ev.data.onSuccess
     * @param {function} ev.data.onFailure
     */
    _onSnippetRequestSave: function (ev) {
        ev.stopPropagation();
        const restore = dom.addButtonLoadingEffect($('button[data-action=save]')[0]);
        this.save(ev.data.reload).then(ev.data.onSuccess, ev.data.onFailure).then(restore).guardedCatch(restore);
    },
    /**
     * Asks the user if they really wants to discard their changes (if any),
     * then simply reloads the page if they want to.
     *
     * @private
     * @param {VerpEvent} ev
     */
    _onSnippetRequestCancel: function (ev) {
        ev.stopPropagation();
        this.cancel();
    },
});

registry.category("websiteNavbarWidgets").add("EditPageMenu", {
    Widget: EditPageMenu,
    selector: '#editPageMenu',
});

return EditPageMenu;
});
