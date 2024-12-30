/** @verp-module **/

import contentMenu from 'website.contentMenu';
import weWidgets from 'wysiwyg.widgets';
import {_t} from 'web.core';

weWidgets.LinkPopoverWidget.include({
    /**
     * @override
     */
    start() {
        // hide popover while typing on mega menu
        if (this.target.closest('.o-mega-menu')) {
            let timeoutID = undefined;
            this.$target.on('keydown.linkPopover', () => {
                this.$target.popover('hide');
                clearTimeout(timeoutID);
                timeoutID = setTimeout(() => this.$target.popover('show'), 1500);
            });
        }

        return this._super(...arguments);
    },
});

const NavbarLinkPopoverWidget = weWidgets.LinkPopoverWidget.extend({
    events: _.extend({}, weWidgets.LinkPopoverWidget.prototype.events, {
        'click .js-edit-menu': '_onEditMenuClick',
    }),
    /**
     *
     * @override
     */
    start() {
        // remove link has no sense on navbar menu links, instead show edit menu
        const $anchor = $('<a/>', {
            href: '#', class: 'ml-2 js-edit-menu', title: _t('Edit Menu'),
            'data-placement': 'top', 'data-toggle': 'tooltip',
        }).append($('<i/>', {class: 'fa fa-sitemap text-secondary'}));
        this.$('.o-we-remove-link').replaceWith($anchor);
        return this._super(...arguments);
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * Opens the menu item editor.
     *
     * @override
     * @param {Event} ev
     */
    _onEditLinkClick(ev) {
        var self = this;
        var $menu = this.$target.find('[data-oe-id]');
        var dialog = new contentMenu.MenuEntryDialog(this, {}, null, {
            name: $menu.text(),
            url: $menu.parent().attr('href'),
        });
        dialog.on('save', this, link => {
            let websiteId;
            this.triggerUp('contextGet', {
                callback: function (ctx) {
                    websiteId = ctx['websiteId'];
                },
            });
            const data = {
                id: $menu.data('oe-id'),
                name: link.content,
                url: link.url,
            };
            return this._rpc({
                model: 'website.menu',
                method: 'save',
                args: [websiteId, {'data': [data]}],
            }).then(function () {
                self.options.wysiwyg.verpEditor.observerUnactive();
                self.$target.attr('href', link.url);
                $menu.text(link.content);
                self.options.wysiwyg.verpEditor.observerActive();
            });
        });
        dialog.open();
    },
    /**
     * Opens the menu tree editor. On menu editor save, current page changes
     * will also be saved.
     *
     * @private
     * @param {Event} ev
     */
     _onEditMenuClick(ev) {
        this.triggerUp('actionDemand', {
            actionName: 'edit_menu',
            params: [
                () => {
                    const prom = new Promise((resolve, reject) => {
                        this.triggerUp('requestSave', {
                            onSuccess: resolve,
                            onFailure: reject,
                        });
                    });
                    return prom;
                },
            ],
        });
    },
});

// Exact same static method but instantiating the specialized class.
NavbarLinkPopoverWidget.createFor = weWidgets.LinkPopoverWidget.createFor;

export default NavbarLinkPopoverWidget;
