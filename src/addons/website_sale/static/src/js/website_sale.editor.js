verp.define('website_sale.addProduct', function (require) {
'use strict';

var core = require('web.core');
var wUtils = require('website.utils');
var WebsiteNewMenu = require('website.newMenu');

var _t = core._t;

WebsiteNewMenu.include({
    actions: _.extend({}, WebsiteNewMenu.prototype.actions || {}, {
        newProduct: '_createNewProduct',
    }),

    //--------------------------------------------------------------------------
    // Actions
    //--------------------------------------------------------------------------

    /**
     * Asks the user information about a new product to create, then creates it
     * and redirects the user to this new product.
     *
     * @private
     * @returns {Promise} Unresolved if there is a redirection
     */
    _createNewProduct: function () {
        var self = this;
        return wUtils.prompt({
            id: "editor-new-product",
            windowTitle: _t("New Product"),
            input: _t("Product Name"),
        }).then(function (result) {
            if (!result.val) {
                return;
            }
            return self._rpc({
                route: '/shop/addProduct',
                params: {
                    name: result.val,
                },
            }).then(function (url) {
                window.location.href = url;
                return new Promise(function () {});
            });
        });
    },
});
});

verp.define('website_sale.editMenu', function (require) {
    'use strict';

var WebsiteEditMenu = require('website.editMenu');

// TODO this whole include actually seems unnecessary. The bug it solved seems
// to stay solved if this is removed. To investigate.
WebsiteEditMenu.include({
    /**
     * @override
     */
    _getContentEditableAreas() {
        const array = this._super(...arguments);
        return array.filter(el => {
            // TODO should really review this system of "ContentEditableAreas +
            // ReadOnlyAreas", here the "productsHeader" stuff is duplicated in
            // both but this system is also duplicated with o-not-editable and
            // maybe even other systems (like preserving contenteditable="false"
            // with oe-keep-contenteditable).
            return !el.closest('.oe-website-sale .productsHeader');
        });
    },
    /**
     * @override
     */
    _getReadOnlyAreas () {
        const readOnlyEls = this._super(...arguments);
        return [...readOnlyEls].concat(
            $("#wrapwrap").find('.oe-website-sale .productsHeader, .oe-website-sale .productsHeader a').toArray()
        );
    },
});
});

//==============================================================================

verp.define('website_sale.editor', function (require) {
'use strict';

var options = require('web_editor.snippets.options');
var publicWidget = require('web.public.widget');
const Wysiwyg = require('web_editor.wysiwyg');
const {qweb, _t} = require('web.core');
const {Markup} = require('web.utils');

Wysiwyg.include({
    customEvents: Object.assign(Wysiwyg.prototype.customEvents, {
        getRibbons: '_onGetRibbons',
        getRibbonClasses: '_onGetRibbonClasses',
        deleteRibbon: '_onDeleteRibbon',
        setRibbon: '_onSetRibbon',
        setProductRibbon: '_onSetProductRibbon',
    }),

    /**
     * @override
     */
    async willStart() {
        const _super = this._super.bind(this);
        let ribbons = [];
        if (this._isProductListPage()) {
            ribbons = await this._rpc({
                model: 'product.ribbon',
                method: 'searchRead',
                fields: ['id', 'html', 'bgcolor', 'textColor', 'htmlClass'],
            });
        }
        this.ribbons = Object.fromEntries(ribbons.map(ribbon => {
            ribbon.html = Markup(ribbon.html);
            return [ribbon.id, ribbon];
        }));
        this.originalRibbons = Object.assign({}, this.ribbons);
        this.productTemplatesRibbons = [];
        this.deletedRibbonClasses = '';
        return _super(...arguments);
    },
    /**
     * @override
     */
    async _saveViewBlocks() {
        const _super = this._super.bind(this);
        await this._saveRibbons();
        return _super(...arguments);
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * Saves the ribbons in the database.
     *
     * @private
     */
    async _saveRibbons() {
        if (!this._isProductListPage()) {
            return;
        }
        const originalIds = Object.keys(this.originalRibbons).map(id => parseInt(id));
        const currentIds = Object.keys(this.ribbons).map(id => parseInt(id));

        const ribbons = Object.values(this.ribbons);
        const created = ribbons.filter(ribbon => !originalIds.includes(ribbon.id));
        const deletedIds = originalIds.filter(id => !currentIds.includes(id));
        const modified = ribbons.filter(ribbon => {
            if (created.includes(ribbon)) {
                return false;
            }
            const original = this.originalRibbons[ribbon.id];
            return Object.entries(ribbon).some(([key, value]) => value !== original[key]);
        });

        const proms = [];
        let createdRibbonIds;
        if (created.length > 0) {
            proms.push(this._rpc({
                method: 'create',
                model: 'product.ribbon',
                args: [created.map(ribbon => {
                    ribbon = Object.assign({}, ribbon);
                    delete ribbon.id;
                    return ribbon;
                })],
            }).then(ids => createdRibbonIds = ids));
        }

        modified.forEach(ribbon => proms.push(this._rpc({
            method: 'write',
            model: 'product.ribbon',
            args: [[ribbon.id], ribbon],
        })));

        if (deletedIds.length > 0) {
            proms.push(this._rpc({
                method: 'unlink',
                model: 'product.ribbon',
                args: [deletedIds],
            }));
        }

        await Promise.all(proms);
        const localToServer = Object.assign(
            this.ribbons,
            Object.fromEntries(created.map((ribbon, index) => [ribbon.id, {id: createdRibbonIds[index]}])),
            {'false': {id: false}},
        );

        // Building the final template to ribbon-id map
        const finalTemplateRibbons = this.productTemplatesRibbons.reduce((acc, {templateId, ribbonId}) => {
            acc[templateId] = ribbonId;
            return acc;
        }, {});
        // Inverting the relationship so that we have all templates that have the same ribbon to reduce RPCs
        const ribbonTemplates = Object.entries(finalTemplateRibbons).reduce((acc, [templateId, ribbonId]) => {
            if (!acc[ribbonId]) {
                acc[ribbonId] = [];
            }
            acc[ribbonId].push(parseInt(templateId));
            return acc;
        }, {});
        const setProductTemplateRibbons = Object.entries(ribbonTemplates)
            // If the ribbonId that the template had no longer exists, remove the ribbon (id = false)
            .map(([ribbonId, templateIds]) => {
                const id = currentIds.includes(parseInt(ribbonId)) ? ribbonId : false;
                return [id, templateIds];
            }).map(([ribbonId, templateIds]) => this._rpc({
                method: 'write',
                model: 'product.template',
                args: [templateIds, {'websiteRibbonId': localToServer[ribbonId].id}],
            }));
        return Promise.all(setProductTemplateRibbons);
    },
    /**
     * Checks whether the current page is the product list.
     *
     * @private
     */
    _isProductListPage() {
        return $('#productsGrid').length !== 0;
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * Returns a copy of this.ribbons through a callback.
     *
     * @private
     */
    _onGetRibbons(ev) {
        ev.data.callback(Object.assign({}, this.ribbons));
    },
    /**
     * Returns all ribbon classes, current and deleted, so they can be removed.
     *
     * @private
     */
    _onGetRibbonClasses(ev) {
        const classes = Object.values(this.ribbons).reduce((classes, ribbon) => {
            return classes + ` ${ribbon.htmlClass}`;
        }, '') + this.deletedRibbonClasses;
        ev.data.callback(classes);
    },
    /**
     * Deletes a ribbon.
     *
     * @private
     */
    _onDeleteRibbon(ev) {
        this.deletedRibbonClasses += ` ${this.ribbons[ev.data.id].htmlClass}`;
        delete this.ribbons[ev.data.id];
    },
    /**
     * Sets a ribbon;
     *
     * @private
     */
    _onSetRibbon(ev) {
        const {ribbon} = ev.data;
        const previousRibbon = this.ribbons[ribbon.id];
        if (previousRibbon) {
            this.deletedRibbonClasses += ` ${previousRibbon.htmlClass}`;
        }
        this.ribbons[ribbon.id] = ribbon;
    },
    /**
     * Sets which ribbon is used by a product template.
     *
     * @private
     */
    _onSetProductRibbon(ev) {
        const {templateId, ribbonId} = ev.data;
        this.productTemplatesRibbons.push({templateId, ribbonId});
    },
});

function reload() {
    if (window.location.href.match(/\?enableEditor/)) {
        window.location.reload();
    } else {
        window.location.href = window.location.href.replace(/\?(enableEditor=1&)?|#.*|$/, '?enableEditor=1&');
    }
}

options.registry.WebsiteSaleGridLayout = options.Class.extend({

    /**
     * @override
     */
    start: function () {
        this.ppg = parseInt(this.$target.closest('[data-ppg]').data('ppg'));
        this.ppr = parseInt(this.$target.closest('[data-ppr]').data('ppr'));
        return this._super.apply(this, arguments);
    },
    /**
     * @override
     */
    onFocus: function () {
        var listLayoutEnabled = this.$target.closest('#productsGrid').hasClass('o-wsale-layout-list');
        this.$el.filter('.o-wsale-ppr-submenu').toggleClass('d-none', listLayoutEnabled);
    },

    //--------------------------------------------------------------------------
    // Options
    //--------------------------------------------------------------------------

    /**
     * @see this.selectClass for params
     */
    setPpg: function (previewMode, widgetValue, params) {
        const PPG_LIMIT = 10000;
        const ppg = parseInt(widgetValue);
        if (!ppg || ppg < 1) {
            return false;
        }
        this.ppg = Math.min(ppg, PPG_LIMIT);
        return this._rpc({
            route: '/shop/changePpg',
            params: {
                'ppg': this.ppg,
            },
        }).then(() => reload());
    },
    /**
     * @see this.selectClass for params
     */
    setPpr: function (previewMode, widgetValue, params) {
        this.ppr = parseInt(widgetValue);
        this._rpc({
            route: '/shop/changePpr',
            params: {
                'ppr': this.ppr,
            },
        }).then(reload);
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * @override
     */
    _computeWidgetState: function (methodName, params) {
        switch (methodName) {
            case 'setPpg': {
                return this.ppg;
            }
            case 'setPpr': {
                return this.ppr;
            }
        }
        return this._super(...arguments);
    },
});

options.registry.WebsiteSaleProductsItem = options.Class.extend({
    xmlDependencies: (options.Class.prototype.xmlDependencies || []).concat(['/website_sale/static/src/xml/website_sale_utils.xml']),
    events: _.extend({}, options.Class.prototype.events || {}, {
        'mouseenter .o-wsale-soptions-menu-sizes table': '_onTableMouseEnter',
        'mouseleave .o-wsale-soptions-menu-sizes table': '_onTableMouseLeave',
        'mouseover .o-wsale-soptions-menu-sizes td': '_onTableItemMouseEnter',
        'click .o-wsale-soptions-menu-sizes td': '_onTableItemClick',
    }),

    /**
     * @override
     */
    willStart: async function () {
        const _super = this._super.bind(this);
        this.ppr = this.$target.closest('[data-ppr]').data('ppr');
        this.productTemplateID = parseInt(this.$target.find('[data-oe-model="product.template"]').data('oe-id'));
        this.ribbons = await new Promise(resolve => this.triggerUp('getRibbons', {callback: resolve}));
        return _super(...arguments);
    },
    /**
     * @override
     */
    start: function () {
        this._resetRibbonDummy();
        return this._super(...arguments);
    },
    /**
     * @override
     */
    onFocus: function () {
        var listLayoutEnabled = this.$target.closest('#productsGrid').hasClass('o-wsale-layout-list');
        this.$el.find('.o-wsale-soptions-menu-sizes')
            .toggleClass('d-none', listLayoutEnabled);
        // Ribbons may have been edited or deleted in another products' option, need to make sure they're up to date
        this.rerender = true;
    },
    /**
     * @override
     */
    onBlur: function () {
        // Since changes will not be saved unless they are validated, reset the
        // previewed ribbon onBlur to communicate that to the user
        this._resetRibbonDummy();
        this._toggleEditingUI(false);
    },

    //--------------------------------------------------------------------------
    // Options
    //--------------------------------------------------------------------------

    /**
     * @override
     */
    selectStyle(previewMode, widgetValue, params) {
        const proms = [this._super(...arguments)];
        if (params.cssProperty === 'background-color' && params.colorNames.includes(widgetValue)) {
            // Reset text-color when choosing a background-color class, so it uses the automatic text-color of the class.
            proms.push(this.selectStyle(previewMode, '', {applyTo: '.o-wsale-ribbon-dummy', cssProperty: 'color'}));
        }
        return Promise.all(proms);
    },
    /**
     * @see this.selectClass for params
     */
    async setRibbon(previewMode, widgetValue, params) {
        if (previewMode === 'reset') {
            widgetValue = this.prevRibbonId;
        } else {
            this.prevRibbonId = this.$target[0].dataset.ribbonId;
        }
        this.$target[0].dataset.ribbonId = widgetValue;
        this.triggerUp('setProductRibbon', {
            templateId: this.productTemplateID,
            ribbonId: widgetValue || false,
        });
        const ribbon = this.ribbons[widgetValue] || {html: '', bgcolor: '', textColor: '', htmlClass: ''};
        const $ribbons = $(`[data-ribbon-id="${widgetValue}"] .o-ribbon:not(.o-wsale-ribbon-dummy)`);
        $ribbons.html(ribbon.html);
        let htmlClasses;
        this.triggerUp('getRibbonClasses', {callback: classes => htmlClasses = classes});
        $ribbons.removeClass(htmlClasses);

        $ribbons.addClass(ribbon.htmlClass || '');
        $ribbons.css('color', ribbon.textColor || '');
        $ribbons.css('background-color', ribbon.bgcolor || '');

        if (!this.ribbons[widgetValue]) {
            $(`[data-ribbon-id="${widgetValue}"]`).each((index, product) => delete product.dataset.ribbonId);
        }
        this._resetRibbonDummy();
        this._toggleEditingUI(false);
    },
    /**
     * @see this.selectClass for params
     */
    editRibbon(previewMode, widgetValue, params) {
        this.saveMethod = 'modify';
        this._toggleEditingUI(true);
    },
    /**
     * @see this.selectClass for params
     */
    createRibbon(previewMode, widgetValue, params) {
        this.saveMethod = 'create';
        this.setRibbon(false);
        this.$ribbon.html('Ribbon text');
        this.$ribbon.addClass('bg-primary o-ribbon-left');
        this._toggleEditingUI(true);
        this.isCreating = true;
    },
    /**
     * @see this.selectClass for params
     */
    async deleteRibbon(previewMode, widgetValue, params) {
        if (this.isCreating) {
            // Ribbon doesn't exist yet, simply discard.
            this.isCreating = false;
            this._resetRibbonDummy();
            return this._toggleEditingUI(false);
        }
        const {ribbonId} = this.$target[0].dataset;
        this.triggerUp('deleteRibbon', {id: ribbonId});
        this.ribbons = await new Promise(resolve => this.triggerUp('getRibbons', {callback: resolve}));
        this.rerender = true;
        await this.setRibbon(false, ribbonId);
    },
    /**
     * @see this.selectClass for params
     */
    async saveRibbon(previewMode, widgetValue, params) {
        const text = this.$ribbon.html().trim();
        if (!text) {
            return;
        }
        const ribbon = {
            'html': text,
            'bgcolor': this.$ribbon[0].style.backgroundColor,
            'textColor': this.$ribbon[0].style.color,
            'htmlClass': this.$ribbon.attr('class').split(' ')
                .filter(c => !['d-none', 'o-wsale-ribbon-dummy', 'o-ribbon'].includes(c))
                .join(' '),
        };
        ribbon.id = this.saveMethod === 'modify' ? parseInt(this.$target[0].dataset.ribbonId) : Date.now();
        this.triggerUp('setRibbon', {ribbon: ribbon});
        this.ribbons = await new Promise(resolve => this.triggerUp('getRibbons', {callback: resolve}));
        this.rerender = true;
        await this.setRibbon(false, ribbon.id);
    },
    /**
     * @see this.selectClass for params
     */
    setRibbonHtml(previewMode, widgetValue, params) {
        this.$ribbon.html(widgetValue);
    },
    /**
     * @see this.selectClass for params
     */
    setRibbonMode(previewMode, widgetValue, params) {
        this.$ribbon[0].className = this.$ribbon[0].className.replace(/o-(ribbon|tag)-(left|right)/, `o-${widgetValue}-$2`);
    },
    /**
     * @see this.selectClass for params
     */
    setRibbonPosition(previewMode, widgetValue, params) {
        this.$ribbon[0].className = this.$ribbon[0].className.replace(/o-(ribbon|tag)-(left|right)/, `o-$1-${widgetValue}`);
    },
    /**
     * @see this.selectClass for params
     */
    changeSequence: function (previewMode, widgetValue, params) {
        this._rpc({
            route: '/shop/changeSequence',
            params: {
                id: this.productTemplateID,
                sequence: widgetValue,
            },
        }).then(reload);
    },

    //--------------------------------------------------------------------------
    // Public
    //--------------------------------------------------------------------------

    /**
     * @override
     */
    updateUI: async function () {
        await this._super.apply(this, arguments);

        var sizeX = parseInt(this.$target.attr('colspan') || 1);
        var sizeY = parseInt(this.$target.attr('rowspan') || 1);

        var $size = this.$el.find('.o-wsale-soptions-menu-sizes');
        $size.find('tr:nth-child(-n + ' + sizeY + ') td:nth-child(-n + ' + sizeX + ')')
             .addClass('selected');

        // Adapt size array preview to fit ppr
        $size.find('tr td:nth-child(n + ' + parseInt(this.ppr + 1) + ')').hide();
        if (this.rerender) {
            this.rerender = false;
            return this._rerenderXML();
        }
    },
    /**
     * @override
     */
    updateUIVisibility: async function () {
        // Main updateUIVisibility will remove the d-none class because there are visible widgets
        // inside of it. TODO: update this once updateUIVisibility can be used to compute visibility
        // of arbitrary DOM elements and not just widgets.
        const isEditing = this.$el.find('[data-name="ribbonOptions"]').hasClass('d-none');
        await this._super(...arguments);
        this._toggleEditingUI(isEditing);
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * @override
     */
    async _renderCustomXML(uiFragment) {
        const $select = $(uiFragment.querySelector('.o-wsale-ribbon-select'));
        this.ribbons = await new Promise(resolve => this.triggerUp('getRibbons', {callback: resolve}));
        if (!this.$ribbon) {
            this._resetRibbonDummy();
        }
        const classes = this.$ribbon[0].className;
        this.$ribbon[0].className = '';
        const defaultTextColor = window.getComputedStyle(this.$ribbon[0]).color;
        this.$ribbon[0].className = classes;
        Object.values(this.ribbons).forEach(ribbon => {
            const colorClasses = ribbon.htmlClass
                .split(' ')
                .filter(className => !/^o-(ribbon|tag)-(left|right)$/.test(className))
                .join(' ');
            $select.append(qweb.render('website_sale.ribbonSelectItem', {
                ribbon,
                colorClasses,
                isTag: /o-tag-(left|right)/.test(ribbon.htmlClass),
                isLeft: /o-(tag|ribbon)-left/.test(ribbon.htmlClass),
                textColor: ribbon.textColor || (colorClasses ? 'currentColor' : defaultTextColor),
            }));
        });
    },
    /**
     * @override
     */
    async _computeWidgetState(methodName, params) {
        const classList = this.$ribbon[0].classList;
        switch (methodName) {
            case 'setRibbon':
                return this.$target.attr('data-ribbon-id') || '';
            case 'setRibbonHtml':
                return this.$ribbon.html();
            case 'setRibbonMode': {
                if (classList.contains('o-ribbon-left') || classList.contains('o-ribbon-right')) {
                    return 'ribbon';
                }
                return 'tag';
            }
            case 'setRibbonPosition': {
                if (classList.contains('o-tag-left') || classList.contains('o-ribbon-left')) {
                    return 'left';
                }
                return 'right';
            }
        }
        return this._super(methodName, params);
    },
    /**
     * Toggles the UI mode between select and create/edit mode.
     *
     * @private
     * @param {Boolean} state true to activate editing UI, false to deactivate.
     */
    _toggleEditingUI(state) {
        this.$el.find('[data-name="ribbonOptions"]').toggleClass('d-none', state);
        this.$el.find('[data-name="ribbonCustomizeOpt"]').toggleClass('d-none', !state);
        this.$('.o-ribbon:not(.o-wsale-ribbon-dummy)').toggleClass('d-none', state);
        this.$ribbon.toggleClass('d-none', !state);
    },
    /**
     * Creates a copy of current ribbon to manipulate for edition/creation.
     *
     * @private
     */
    _resetRibbonDummy() {
        if (this.$ribbon) {
            this.$ribbon.remove();
        }
        const $original = this.$('.o-ribbon');
        this.$ribbon = $original.clone().addClass('d-none o-wsale-ribbon-dummy').appendTo($original.parent());
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * @private
     */
    _onTableMouseEnter: function (ev) {
        $(ev.currentTarget).addClass('oe-hover');
    },
    /**
     * @private
     */
    _onTableMouseLeave: function (ev) {
        $(ev.currentTarget).removeClass('oe-hover');
    },
    /**
     * @private
     */
    _onTableItemMouseEnter: function (ev) {
        var $td = $(ev.currentTarget);
        var $table = $td.closest("table");
        var x = $td.index() + 1;
        var y = $td.parent().index() + 1;

        var tr = [];
        for (var yi = 0; yi < y; yi++) {
            tr.push("tr:eq(" + yi + ")");
        }
        var $selectTr = $table.find(tr.join(","));
        var td = [];
        for (var xi = 0; xi < x; xi++) {
            td.push("td:eq(" + xi + ")");
        }
        var $selectTd = $selectTr.find(td.join(","));

        $table.find("td").removeClass("select");
        $selectTd.addClass("select");
    },
    /**
     * @private
     */
    _onTableItemClick: function (ev) {
        var $td = $(ev.currentTarget);
        var x = $td.index() + 1;
        var y = $td.parent().index() + 1;
        this._rpc({
            route: '/shop/changeSize',
            params: {
                id: this.productTemplateID,
                x: x,
                y: y,
            },
        }).then(reload);
    },
});
});
