verp.define('website.wysiwyg', function (require) {
'use strict';

var Wysiwyg = require('web_editor.wysiwyg');
var snippetsEditor = require('web_editor.snippet.editor');
const weWidgets = require('wysiwyg.widgets');

/**
 * Show/hide the dropdowns associated to the given toggles and allows to wait
 * for when it is fully shown/hidden.
 *
 * Note: this also takes care of the fact the 'toggle' method of bootstrap does
 * not properly work in all cases.
 *
 * @param {jQuery} $toggles
 * @param {boolean} [show]
 * @returns {Promise<jQuery>}
 */
function toggleDropdown($toggles, show) {
    return Promise.all(_.map($toggles, toggle => {
        var $toggle = $(toggle);
        var $dropdown = $toggle.parent();
        var shown = $dropdown.hasClass('show');
        if (shown === show) {
            return;
        }
        var toShow = !shown;
        return new Promise(resolve => {
            $dropdown.one(
                toShow ? 'shown.bs.dropdown' : 'hidden.bs.dropdown',
                () => resolve()
            );
            $toggle.dropdown(toShow ? 'show' : 'hide');
        });
    })).then(() => $toggles);
}

/**
 * HtmlEditor
 * Intended to edit HTML content. This widget uses the Wysiwyg editor
 * improved by verp.
 *
 * class editable: o-editable
 * class non editable: o-not-editable
 *
 */
Wysiwyg.include({
    /**
     * @override
     */
    start: function () {
        this.options.toolbarHandler = $('#webEditorTopEdit');

        // Dropdown menu initialization: handle dropdown openings by hand
        var $dropdownMenuToggles = this.$('.o-mega-menu-toggle, #topMenuContainer .dropdown-toggle');
        $dropdownMenuToggles.removeAttr('data-toggle').dropdown('dispose');
        $dropdownMenuToggles.on('click.wysiwygMegamenu', ev => {
            this.verpEditor.observerUnactive();
            var $toggle = $(ev.currentTarget);

            // Each time we toggle a dropdown, we will destroy the dropdown
            // behavior afterwards to keep manual control of it
            var dispose = ($els => $els.dropdown('dispose'));

            // First hide all other dropdown menus
            toggleDropdown($dropdownMenuToggles.not($toggle), false).then(dispose);

            // Then toggle the clicked one
            toggleDropdown($toggle)
                .then(dispose)
                .then(() => {
                    if (!this.options.enableTranslation) {
                        this._toggleMegaMenu($toggle[0]);
                    }
                })
                .then(() => this.verpEditor.observerActive());
        });

        // Ensure :blank oe-structure elements are in fact empty as ':blank'
        // does not really work with all browsers.
        for (const el of this.$('.oe-structure')) {
            if (!el.innerHTML.trim()) {
                $(el).empty();
            }
        }

        return this._super.apply(this, arguments);
    },
    /**
     * @override
     * @returns {Promise}
     */
    _saveViewBlocks: async function () {
        await this._super.apply(this, arguments);
        if (this.isDirty()) {
            return this._restoreMegaMenus();
        }
    },
    /**
     * @override
     */
    destroy: function () {
        this._restoreMegaMenus();
        this._super.apply(this, arguments);
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * @private
     * @param {HTMLElement} editable
     */
    _saveCoverProperties: function ($elementToSave) {
        var el = $elementToSave.closest('.o-record-cover-container')[0];
        if (!el) {
            return;
        }

        var resModel = el.dataset.resModel;
        var resID = parseInt(el.dataset.resId);
        if (!resModel || !resID) {
            throw new Error('There should be a model and id associated to the cover');
        }

        // The cover might be dirty for another reason than cover properties
        // values only (like an editable text inside). In that case, do not
        // update the cover properties values.
        if (!('coverClass' in el.dataset)) {
            return;
        }

        this.__savedCovers = this.__savedCovers || {};
        this.__savedCovers[resModel] = this.__savedCovers[resModel] || [];

        if (this.__savedCovers[resModel].includes(resID)) {
            return;
        }
        this.__savedCovers[resModel].push(resID);

        var cssBgImage = $(el.querySelector('.o-record-cover-image')).css('background-image');
        var coverProps = {
            'background-image': cssBgImage.replace(/"/g, '').replace(window.location.protocol + "//" + window.location.host, ''),
            'backgroundColorClass': el.dataset.bgColorClass,
            'backgroundColorStyle': el.dataset.bgColorStyle,
            'opacity': el.dataset.filterValue,
            'resizeClass': el.dataset.coverClass,
            'textAlignClass': el.dataset.textAlignClass,
        };

        return this._rpc({
            model: resModel,
            method: 'write',
            args: [
                resID,
                {'coverProperties': JSON.stringify(coverProps)}
            ],
        });
    },
    /**
     * @override
     */
    _saveElement: async function ($el, context, withLang) {
        var promises = [];

        // Saving a view content
        await this._super.apply(this, arguments);

        // Saving mega menu options
        if ($el.data('oe-field') === 'megaMenuContent') {
            // On top of saving the mega menu content like any other field
            // content, we must save the custom classes that were set on the
            // menu itself.
            // FIXME normally removing the 'show' class should not be necessary here
            // TODO check that editor classes are removed here as well
            var classes = _.without($el.attr('class').split(' '), 'dropdown-menu', 'o-mega-menu', 'show');
            promises.push(this._rpc({
                model: 'website.menu',
                method: 'write',
                args: [
                    [parseInt($el.data('oe-id'))],
                    {
                        'megaMenuClasses': classes.join(' '),
                    },
                ],
            }));
        }

        // Saving cover properties on related model if any
        var prom = this._saveCoverProperties($el);
        if (prom) {
            promises.push(prom);
        }

        return Promise.all(promises);
    },
    /**
     * Restores mega menu behaviors and closes them (important to do before
     * saving otherwise they would be saved opened).
     *
     * @private
     * @returns {Promise}
     */
    _restoreMegaMenus: function () {
        var $megaMenuToggles = this.$('.o-mega-menu-toggle');
        $megaMenuToggles.off('.wysiwygMegamenu')
            .attr('data-toggle', 'dropdown')
            .dropdown({});
        return toggleDropdown($megaMenuToggles, false);
    },
    /**
     * Toggles the mega menu.
     *
     * @private
     * @returns {Promise}
     */
    _toggleMegaMenu: function (toggleEl) {
        const megaMenuEl = toggleEl.parentElement.querySelector('.o-mega-menu');
        if (!megaMenuEl || !megaMenuEl.classList.contains('show')) {
            return this.snippetsMenu.activateSnippet(false);
        }
        megaMenuEl.classList.add('o-no-parent-editor');
        return this.snippetsMenu.activateSnippet($(megaMenuEl));
    },
});

snippetsEditor.SnippetsMenu.include({
    /**
     * @override
     */
    init: function () {
        this._super(...arguments);
        this._notActivableElementsSelector += ', .o-mega-menu-toggle';
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * @override
     */
    _insertDropzone: function ($hook) {
        var $hookParent = $hook.parent();
        var $dropzone = this._super(...arguments);
        $dropzone.attr('data-editor-message', $hookParent.attr('data-editor-message'));
        $dropzone.attr('data-editor-sub-message', $hookParent.attr('data-editor-sub-message'));
        return $dropzone;
    },
});
});
