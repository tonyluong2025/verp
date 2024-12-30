verp.define('website.viewHierarchy', function (require) {
"use strict";

const core = require('web.core');
const qweb = require('web.qweb');
const viewRegistry = require('web.viewRegistry');

const _t = core._t;

const Renderer = qweb.Renderer.extend({
    events: _.extend({}, qweb.Renderer.prototype.events, {
        'click .js-fold': '_onCollapseClick',
        'click .o-website-filter a': '_onWebsiteFilterClick',
        'click .o-search button': '_onSearchButtonClick',
        'click .o-show-diff': '_onShowDiffClick',
        'click .o-load-hierarchy': '_onLoadHierarchyClick',
        'keydown .o-search input': '_onSearchInputKeyDown',
        'input .o-search input': '_onSearchInputKeyInput',
        'change #oShowInactive': '_onShowActiveClick',
    }),
    /**
     * @override
     */
    init: function () {
        this._super(...arguments);

        // Search
        this.cptFound = 0;
        this.prevSearch = '';
    },
    /**
     * @override
     */
    onAttachCallback: function () {
        this._super(...arguments);

        const self = this;
        this._handleLastVisibleChild();
        // Fixed Navbar
        this.$('.o-tree-container').css({
            'padding-top': this.$('.o-tree-nav').outerHeight() + 10,
        });
        // Website Filters
        this.$wNodes = this.$("li[data-websiteName]");
        this.$notwNodes = this.$("li:not([data-websiteName])");
        const websiteNames = _.uniq($.map(self.$wNodes, el => el.getAttribute('data-websiteName')));
        for (const websiteName of websiteNames) {
            this.$('.o-website-filter').append($('<a/>', {
                'class': 'dropdown-item',
                'data-websiteName': websiteName,
                'text': websiteName,
            }));
        }
        this.$(`.o-website-filter a[data-websiteName="${websiteNames[0] || '*'}"]`).click();
        // Highlight requested view as google does
        const reqViewId = this.$('.o-tree-container').data('requested-view-id');
        const $reqView = $(`[data-id="${reqViewId}"] span.js-fold`).first();
        $reqView.css({'background-color': 'yellow'});
        $('.o-content').scrollTo($reqView[0], 300, {offset: -200});
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * @private
     * @param {Event} ev
     */
    _onCollapseClick: function (ev) {
        const $parent = $(ev.currentTarget).parent();
        const folded = $parent.find('.o-fold-icon').hasClass('fa-plus-square-o');
        let $ul, $oFoldIcon;
        if (folded) { // Unfold only self
            $ul = $parent.siblings('ul');
            $oFoldIcon = $parent.find('.o-fold-icon');
        } else { // Fold all
            $ul = $parent.parent().find('ul');
            $oFoldIcon = $parent.parent().find('.o-fold-icon');
        }
        $ul.toggleClass('d-none', !folded);
        $oFoldIcon.toggleClass('fa-minus-square-o', folded).toggleClass('fa-plus-square-o', !folded);
        this._handleLastVisibleChild();
    },
    /**
     * @private
     * @param {Event} ev
     */
    _onShowActiveClick: function (ev) {
        this.$('.o-is-inactive').toggleClass('d-none', !ev.currentTarget.checked);
        this._handleLastVisibleChild();
    },
    /**
     * @private
     * @param {Event} ev
     */
    _onWebsiteFilterClick: function (ev) {
        ev.preventDefault();
        // Update Dropdown Filter
        const $el = $(ev.currentTarget);
        $el.addClass('active').siblings().removeClass('active');
        $el.parent().siblings('.dropdown-toggle').text($el.text());
        // Show all views
        const websiteName = $el.data('websiteName');
        this.$wNodes.add(this.$notwNodes).removeClass('d-none');
        if (websiteName !== '*') {
            // Hide all website views
            this.$wNodes.addClass('d-none');
            // Show selected website views
            const $selectedWebsiteNodes = this.$(`li[data-websiteName="${websiteName}"]`);
            $selectedWebsiteNodes.removeClass('d-none');
            // Hide generic siblings
            $selectedWebsiteNodes.each(function () {
                $(this).siblings(`li[data-key="${$(this).data('key')}"]:not([data-websiteName])`).addClass('d-none');
            });
        }
        // Preserve current inactive toggle state
        this.$('.o-is-inactive').toggleClass('d-none', !$('#oShowInactive').prop('checked'));
        this._handleLastVisibleChild();
    },
    /**
     * @private
     * @param {Event} ev
     */
    _onSearchInputKeyDown: function (ev) {
        // <Tab> or <Enter>
        if (ev.which === 13 || ev.which === 9) {
            this._searchScrollTo($(ev.currentTarget).val(), !ev.shiftKey);
            ev.preventDefault();
        }
    },
    /**
     * @private
     * @param {Event} ev
     */
    _onSearchInputKeyInput: function (ev) {
        // Useful for input empty either with ms-clear or by typing
        if (ev.currentTarget.value === "") {
            this._searchScrollTo("");
        }
    },
    /**
     * @private
     * @param {Event} ev
     */
    _onSearchButtonClick: function (ev) {
        this._searchScrollTo(this.$('.o-search input').val());
    },
    /**
     * @private
     * @param {Event} ev
     */
    _onShowDiffClick: function (ev) {
        ev.preventDefault();
        this.doAction('base.resetViewArchWizardAction', {
            additionalContext: {
                'activeModel': 'ir.ui.view',
                'activeIds': [parseInt(ev.currentTarget.dataset['viewId'])],
            }
        });
    },
    /**
     * @private
     * @param {Event} ev
     */
    _onLoadHierarchyClick: function (ev) {
        ev.preventDefault();
        this.doAction('website.actionShowViewhierarchy', {
            additionalContext: {
                'activeModel': 'ir.ui.view',
                'activeId': parseInt(ev.currentTarget.dataset['viewId']),
            }
        });
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * Adds a class to the last visible element of every lists.
     * This is purely cosmetic to add a right angle dashed `:before` style in
     * css. This can't be done in css as there is no way to target a last
     * element by class.
     *
     * @private
     */
    _handleLastVisibleChild: function () {
        this.$('.o-last-visible-child').removeClass('o-last-visible-child');
        const lastElements = _.filter(_.map(
            this.$('ul'), el => $(el).find('> li:visible').last()[0]
        ));
        $(lastElements).addClass('o-last-visible-child');

        const selector = $('#oShowInactive').prop('checked') ? '> li' : '> li:not(.o-is-inactive)';
        this.$('.o-fold-icon').map(function () {
            let $ico = $(this);
            let childs = $ico.parent().parent().first().find('ul').find(selector);
            $ico.toggleClass('d-none', !childs.length);
        });
    },
    /**
     * Searches and scrolls to view entries matching the given text. Exact
     * matches will be returned first. Search is done on `key`, `id` and `name`
     * for exact matches, and `key`, `name` for simple matches.
     *
     * @private
     * @param {string} search text to search and scroll to
     * @param {boolean} [forward] set to false to go to previous find
     */
    _searchScrollTo: function (search, forward = true) {
        const foundClasses = 'o-search-found border border-info rounded px-2';
        this.$('.o-search-found').removeClass(foundClasses);
        this.$('.o-not-found').removeClass('o-not-found');
        this.$('.o-tab-hint').remove();
        if (search !== this.prevSearch) {
            this.prevSearch = search;
            this.cptFound = -1;
        }

        if (search) {
            // Exact match first
            const exactMatches = $(`[data-key="${search}" i], [data-id="${search}" i], [data-name="${search}" i]`).not(':hidden').get();
            let matches = $(`[data-key*="${search}" i], [data-name*="${search}" i]`).not(':hidden').not(exactMatches).get();
            matches = exactMatches.concat(matches);
            if (!matches.length) {
                this.$('.o-search input').addClass('o-not-found');
            } else {
                if (forward) {
                    this.cptFound++;
                    if (this.cptFound > matches.length - 1) {
                        this.cptFound = 0;
                    }
                } else {
                    this.cptFound--;
                    if (this.cptFound < 0) {
                        this.cptFound = matches.length - 1;
                    }
                }
                const el = matches[this.cptFound];
                $(el).children('p').addClass(foundClasses).append($('<span/>', {
                    class: 'o-tab-hint text-info ml-auto small font-italic pr-2',
                    text: _.str.sprintf(_t("Press %s for next %s"), "<Tab>", `[${this.cptFound + 1}/${matches.length}]`),
                }));
                $('.o-content').scrollTo(el, 0, {offset: -200});

                this.prevSearch = search;
                this.$('.o-search input').focus();
            }
        }
    },
});

const ViewHierarchy = qweb.View.extend({
    withSearchBar: false,
    config: _.extend({}, qweb.View.prototype.config, {
        Renderer: Renderer,
    }),
});

viewRegistry.add('viewHierarchy', ViewHierarchy);
});
