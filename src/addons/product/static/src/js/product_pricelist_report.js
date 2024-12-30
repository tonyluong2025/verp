verp.define('product.generatePricelist', function (require) {
'use strict';

var AbstractAction = require('web.AbstractAction');
var core = require('web.core');
var FieldMany2One = require('web.relationalFields').FieldMany2One;
var StandaloneFieldManagerMixin = require('web.StandaloneFieldManagerMixin');
var Widget = require('web.Widget');

var QWeb = core.qweb;
var _t = core._t;

var QtyTagWidget = Widget.extend({
    template: 'product.reportPricelistQty',
    events: {
        'click .o_remove_qty': '_onClickRemoveQty',
    },
    /**
     * @override
     */
    init: function (parent, defaulQuantities) {
        this._super.apply(this, arguments);
        this.quantities = defaulQuantities;
        this.MAX_QTY = 5;
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * Add a quantity when add(+) button clicked.
     *
     * @private
     */
    _onClickAddQty: function () {
        if (this.quantities.length >= this.MAX_QTY) {
            this.displayNotification({ message: _.str.sprintf(
                _t("At most %d quantities can be displayed simultaneously. Remove a selected quantity to add others."),
                this.MAX_QTY
            ) });
            return;
        }
        const qty = parseInt(this.$('.o_product_qty').val());
        if (qty && qty > 0) {
            // Check qty already exist
            if (this.quantities.indexOf(qty) === -1) {
                this.quantities.push(qty);
                this.quantities = this.quantities.sort((a, b) => a - b);
                this.triggerUp('qtyChanged', {quantities: this.quantities});
                this.renderElement();
            } else {
                this.displayNotification({
                    message: _.str.sprintf(_t("Quantity already present (%d)."), qty),
                    type: 'info'
                });
            }
        } else {
            this.displayNotification({ message: _t("Please enter a positive whole number") });
        }
    },
    /**
     * Remove quantity.
     *
     * @private
     * @param {jQueryEvent} ev
     */
    _onClickRemoveQty: function (ev) {
        const qty = parseInt($(ev.currentTarget).closest('.badge').data('qty'));
        this.quantities = this.quantities.filter(q => q !== qty);
        this.triggerUp('qtyChanged', {quantities: this.quantities});
        this.renderElement();
    },
});

var GeneratePriceList = AbstractAction.extend(StandaloneFieldManagerMixin, {
    hasControlPanel: true,
    events: {
        'click .o-action': '_onClickAction',
        'submit form': '_onSubmitForm',
    },
    customEvents: Object.assign({}, StandaloneFieldManagerMixin.customEvents, {
        fieldChanged: '_onFieldChanged',
        qtyChanged: '_onQtyChanged',
    }),
    /**
     * @override
     */
    init: function (parent, params) {
        this._super.apply(this, arguments);
        StandaloneFieldManagerMixin.init.call(this);
        this.context = params.context;
        // in case the window got refreshed
        if (params.params && params.params.activeIds && typeof(params.params.activeIds === 'string')) {
            try {
                this.context.activeIds = params.params.activeIds.split(',').map(id => parseInt(id));
                this.context.activeModel = params.params.activeModel;
            } catch(e) {
                console.log('unable to load ids from the url fragment 🙁');
            }
        }
        if (!this.context.activeModel) {
            // started without an active module, assume product templates
            this.context.activeModel = 'product.template';
        }
        this.context.quantities = [1, 5, 10];
    },
    /**
     * @override
     */
    willStart: function () {
        let getPricelist;
        // started without a selected pricelist in context? just get the first one
        if (this.context.default_pricelist) {
            getPricelist = Promise.resolve([this.context.default_pricelist]);
        } else {
            getPricelist = this._rpc({
                model: 'product.pricelist',
                method: 'search',
                args: [[]],
                kwargs: {limit: 1}
            });
        }
        const fieldSetup = getPricelist.then(pricelistIds => {
            return this.model.makeRecord('report.product.reportPricelist', [{
                name: 'pricelistId',
                type: 'many2one',
                relation: 'product.pricelist',
                value: pricelistIds[0],
            }]);
        }).then(recordId => {
            const record = this.model.get(recordId);
            this.many2one = new FieldMany2One(this, 'pricelistId', record, {
                mode: 'edit',
                attrs: {
                    canCreate: false,
                    canWrite: false,
                    options: {noOpen: true},
                },
            });
            this._registerWidget(recordId, 'pricelistId', this.many2one);
        });
        return Promise.all([fieldSetup, this._getHtml(), this._super()]);
    },
    /**
     * @override
     */
    start: function () {
        this.controlPanelProps.cpContent = this._renderComponent();
        const $content = this.controlPanelProps.cpContent;
        $content["$searchView"][0].querySelector('.o_is_visible_title').addEventListener('click', this._onClickVisibleTitle.bind(this));
        return this._super.apply(this, arguments).then(() => {
            this.$('.o-content').html(this.reportHtml);
        });
    },
    /**
     * Include the current model (template/variant) in the state to allow refreshing without losing
     * the proper context.
     * @override
     */
    getState: function () {
        return {
            activeModel: this.context.activeModel,
        };
    },
    getTitle: function () {
        return _t('Pricelist Report');
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * Returns the expected data for the report rendering call (html or pdf)
     *
     * @private
     * @returns {Object}
     */
    _prepareActionReportParams: function () {
        return {
            activeModel: this.context.activeModel,
            activeIds: this.context.activeIds || '',
            is_visible_title: this.context.is_visible_title || '',
            pricelistId: this.context.pricelistId || '',
            quantities: this.context.quantities || [1],
        };
    },
    /**
     * Get template to display report.
     *
     * @private
     * @returns {Promise}
     */
    _getHtml: function () {
        return this._rpc({
            model: 'report.product.reportPricelist',
            method: 'getHtml',
            kwargs: {
                data: this._prepareActionReportParams(),
                context: this.context,
            },
        }).then(result => {
            this.reportHtml = result;
        });
    },
    /**
     * Reload report.
     *
     * @private
     * @returns {Promise}
     */
    _reload: function () {
        return this._getHtml().then(() => {
            this.$('.o-content').html(this.reportHtml);
        });
    },
    /**
     * Render search view and print button.
     *
     * @private
     */
    _renderComponent: function () {
        const $buttons = $('<button>', {
            class: 'btn btn-primary',
            text: _t("Print"),
        }).on('click', this._onClickPrint.bind(this));

        const $searchView = $(QWeb.render('product.reportPricelistSearch'));
        this.many2one.appendTo($searchView.find('.o_pricelist'));

        this.qtyTagWidget = new QtyTagWidget(this, this.context.quantities);
        this.qtyTagWidget.replace($searchView.find('.o_product_qty'));
        return { $buttons, $searchView };
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * Checkbox is checked, the report title will show.
     *
     * @private
     * @param {Event} ev
     */
    _onClickVisibleTitle(ev) {
        this.context.is_visible_title = ev.currentTarget.checked;
        this._reload();
    },

    /**
     * Open form view of particular record when link clicked.
     *
     * @private
     * @param {jQueryEvent} ev
     */
    _onClickAction: function (ev) {
        ev.preventDefault();
        this.doAction({
            type: 'ir.actions.actwindow',
            resModel: $(ev.currentTarget).data('model'),
            resId: $(ev.currentTarget).data('res-id'),
            views: [[false, 'form']],
            target: 'self',
        });
    },
    /**
     * Print report in PDF when button clicked.
     *
     * @private
     */
    _onClickPrint: function () {
        return this.doAction({
            type: 'ir.actions.report',
            reportType: 'qweb-pdf',
            reportName: 'product.reportPricelist',
            reportFile: 'product.reportPricelist',
            data: this._prepareActionReportParams(),
        });
    },
    /**
     * Reload report when pricelist changed.
     *
     * @override
     */
    _onFieldChanged: function (event) {
        this.context.pricelistId = event.data.changes.pricelistId.id;
        StandaloneFieldManagerMixin._onFieldChanged.apply(this, arguments);
        this._reload();
    },
    /**
     * Reload report when quantities changed.
     *
     * @private
     * @param {VerpEvent} ev
     * @param {integer[]} event.data.quantities
     */
    _onQtyChanged: function (ev) {
        this.context.quantities = ev.data.quantities;
        this._reload();
    },
    _onSubmitForm: function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        this.qtyTagWidget._onClickAddQty();
    },
});

core.actionRegistry.add('generatePricelist', GeneratePriceList);

return {
    GeneratePriceList,
    QtyTagWidget
};

});
