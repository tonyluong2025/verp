verp.define('stock.ReplenishReport', function (require) {
"use strict";

const { loadLegacyViews } = require("@web/legacy/legacy_views");

const clientAction = require('report.clientAction');
const core = require('web.core');
const dom = require('web.dom');

const qweb = core.qweb;
const _t = core._t;

const viewRegistry = require("web.viewRegistry");

const ReplenishReport = clientAction.extend({
    /**
     * @override
     */
    init: function (parent, action, options) {
        this._super.apply(this, arguments);
        this.context = action.context;
        this.productId = this.context.activeId;
        this.resModel = this.context.activeModel || this.context.params.activeModel || 'product.template';
        const isTemplate = this.resModel === 'product.template';
        this.actionMethod = `actionProduct${isTemplate ? 'Template' : ''}ForecastReport`;
        const reportName = `reportProduct${isTemplate ? 'Template' : 'Product'}Replenishment`;
        this.reportUrl = `/report/html/stock.${reportName}/${this.productId}`;
        this._title = action.label;
    },

    /**
     * @override
     */
    willStart: function() {
        var loadWarehouses = this._rpc({
            model: 'stock.report.productproductreplenishment',
            method: 'getWarehouses',
        }).then((res) => {
            this.warehouses = res;
            if (this.context.warehouse) {
                this.activeWarehouse = this.warehouses.find(w => w.id == this.context.warehouse);
            }
            else {
                this.activeWarehouse = this.warehouses[0];
                this.context.warehouse = this.activeWarehouse.id;
            }
            this.reportUrl += `?context=${JSON.stringify(this.context)}`;
        });
        return Promise.all([
            this._super.apply(this, arguments),
            loadWarehouses,
            loadLegacyViews({ rpc: this._rpc.bind(this) }),
        ]);
    },

    /**
     * @override
     */
    start: function () {
        return Promise.all([
            this._super(...arguments),
        ]).then(() => {
            this._renderWarehouseFilters();
            this._renderButtons();
        });
    },

    /**
     * @override
     */
    onAttachCallback: function () {
        this._super();
        this._createGraphView();
        this.iframe.addEventListener("load",
            () => this._bindAdditionalActionHandlers(),
            { once: true }
        );
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * @private
     * @param {Promise<GraphController>} graphPromise
     * @returns {Promise}
     */
    async _appendGraph(graphPromise) {
        const graphController = await graphPromise;
        const iframeDoc = this.iframe.contentDocument;
        const reportGraphDiv = iframeDoc.querySelector(".o-report-graph");
        dom.append(reportGraphDiv, graphController.el, {
            inDOM: true,
            callbacks: [{ widget: graphController }],
        });
        // Hack to put the resModel on the url. This way, the report always know on with resModel it refers.
        if (location.href.indexOf('activeModel') === -1) {
            const url = window.location.href + `&activeModel=${this.resModel}`;
            window.history.pushState({}, "", url);
        }
    },

    /**
     * @private
     * @returns {Promise<GraphController>}
     */
    async _createGraphController() {
        const model = "report.stock.quantity";
        const viewInfo = await this._rpc({
            model,
            method: "fieldsViewGet",
            kwargs: { viewType: "graph" }
        });
        const params = {
            domain: this._getReportDomain(),
            modelName: model,
            noContentHelp: _t("Try to add some incoming or outgoing transfers."),
            withControlPanel: false,
        };
        const GraphView = viewRegistry.get("graph");
        const graphView = new GraphView(viewInfo, params);
        const graphController = await graphView.getController(this);
        await graphController.appendTo(document.createDocumentFragment());

        // Since we render the container in a fragment, we may endup in this case:
        // https://github.com/chartjs/Chart.js/issues/2210#issuecomment-204984449
        // so, the canvas won't be resizing when it is relocated in the iframe.
        // Also, since the iframe's position is absolute, chartJS reiszing may not work
        //  (https://www.chartjs.org/docs/2.9.4/general/responsive.html -- #Important Note)
        // Finally, we do want to set a height for the canvas rendering in chartJS.
        // We do this via the chartJS API, that is legacy/graph_renderer.js:@_prepareOptions
        //  (maintainAspectRatio = false) and with the *attribute* height (not the style).
        //  (https://www.chartjs.org/docs/2.9.4/general/responsive.html -- #Responsive Charts)
        // Luckily, the chartJS is not fully rendered, so changing the height here is relevant.
        // It wouldn't be if we were after GraphRenderer@mounted.
        graphController.el.querySelector(".o-graph-canvas-container canvas").height = "300";

        return graphController;
    },

    /**
     * Instantiates a chart graph and moves it into the report's iframe.
     */
    _createGraphView() {
        const graphPromise = this._createGraphController();
        this.iframe.addEventListener("load",
            () => this._appendGraph(graphPromise),
            { once: true }
        );
    },

    /**
     * Return the action to open this report.
     *
     * @returns {Promise}
     */
    _getForecastedReportAction: function () {
        return this._rpc({
            model: this.resModel,
            method: this.actionMethod,
            args: [this.productId],
            context: this.context,
        });
    },

    /**
     * Returns a domain to filter on the product variant or product template
     * depending of the active model.
     *
     * @returns {Array}
     */
    _getReportDomain: function () {
        const domain = [
            ['state', '=', 'forecast'],
            ['warehouseId', '=', this.activeWarehouse.id],
        ];
        if (this.resModel === 'product.template') {
            domain.push(['productTemplateId', '=', this.productId]);
        } else if (this.resModel === 'product.product') {
            domain.push(['productId', '=', this.productId]);
        }
        return domain;
    },

    /**
     * TODO
     *
     * @param {Object} additionnalContext
     */
    _reloadReport: function (additionnalContext) {
        return this._getForecastedReportAction().then((action) => {
            action.context = Object.assign({
                activeId: this.productId,
                activeModel: this.resModel,
            }, this.context, additionnalContext);
            return this.doAction(action, {replaceLastAction: true});
        });
    },

    /**
     * Renders the 'Replenish' button and replaces the default 'Print' button by this new one.
     */
    _renderButtons: function () {
        const $newButtons = $(qweb.render('replenishReportButtons', {}));
        this.$buttons.find('.o-report-print').replaceWith($newButtons);
        this.$buttons.on('click', '.o-report-replenish-buy', this._onClickReplenish.bind(this));
        this.controlPanelProps.cpContent = {
            $buttons: this.$buttons,
        };
    },

    /**
     * Renders the Warehouses filter
     */
    _renderWarehouseFilters: function () {
        const $filters = $(qweb.render('warehouseFilter', {
            activeWarehouse: this.activeWarehouse,
            warehouses: this.warehouses,
            displayWarehouseFilter: (this.warehouses.length > 1),
        }));
        // Bind handlers.
        $filters.on('click', '.warehouse-filter', this._onClickFilter.bind(this));
        this.$('.o-search-options').append($filters);
    },

    /**
     * Bind additional action handlers (<button>, <a>)
     * 
     * @returns {Promise}
     */
    _bindAdditionalActionHandlers: function () {
        let rr = this.$el.find('iframe').contents().find('.o-report-replenishment');
        rr.on('click', '.o-report-replenish-change-priority', this._onClickChangePriority.bind(this));
        rr.on('mouseenter', '.o-report-replenish-change-priority', this._onMouseEnterPriority.bind(this));
        rr.on('mouseleave', '.o-report-replenish-change-priority', this._onMouseLeavePriority.bind(this));
        rr.on('click', '.o-report-replenish-unreserve', this._onClickUnreserve.bind(this));
        rr.on('click', '.o-report-replenish-reserve', this._onClickReserve.bind(this));
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * Opens the product replenish wizard. Could re-open the report if pending
     * forecasted quantities need to be updated.
     *
     * @returns {Promise}
     */
    _onClickReplenish: function () {
        const context = Object.assign({}, this.context);
        if (this.resModel === 'product.product') {
            context.default_productId = this.productId;
        } else if (this.resModel === 'product.template') {
            context.default_productTemplateId = this.productId;
        }
        context.default_warehouseId = this.activeWarehouse.id;

        const onClose = function (res) {
            if (res && res.special) {
                // Do nothing when the wizard is discarded.
                return;
            }
            // Otherwise, opens again the report.
            return this._reloadReport();
        };

        const action = {
            resModel: 'product.replenish',
            name: _t('Product Replenish'),
            type: 'ir.actions.actwindow',
            views: [[false, 'form']],
            target: 'new',
            context: context,
        };

        return this.doAction(action, {
            onClose: onClose.bind(this),
        });
    },

    /**
     * Re-opens the report with data for the specified warehouse.
     *
     * @returns {Promise}
     */
    _onClickFilter: function (ev) {
        const data = ev.target.dataset;
        const warehouseId = Number(data.warehouseId);
        return this._reloadReport({warehouse: warehouseId});
    },

    /**
     * Change the priority of the specified model/id, then reload this report.
     *
     * @returns {Promise}
     */
    _onClickChangePriority: function(ev) {
        const model = ev.target.getAttribute('model');
        const modelId = parseInt(ev.target.getAttribute('model-id'));
        const value = ev.target.classList.contains('zero')?'1':'0';
        this._rpc( {
            model: model,
            args: [[modelId], {priority: value}],
            method: 'write'
        }).then((result) => {
            return this._reloadReport();
        });
    },
    _onMouseEnterPriority: function(ev) {
        ev.target.classList.toggle('fa-star');
        ev.target.classList.toggle('fa-star-o');
    },
    _onMouseLeavePriority: function(ev) {
        ev.target.classList.toggle('fa-star');
        ev.target.classList.toggle('fa-star-o');
    },

    /**
     * Unreserve the specified model/id, then reload this report.
     *
     * @returns {Promise}
     */
    _onClickUnreserve: function(ev) {
        const model = ev.target.getAttribute('model');
        const modelId = parseInt(ev.target.getAttribute('model-id'));
        return this._rpc( {
            model,
            args: [[modelId]],
            method: 'doUnreserve'
        }).then(() => this._reloadReport());
    },

    /**
     * Reserve the specified model/id, then reload this report.
     *
     * @returns {Promise}
     */
    _onClickReserve: function(ev) {
        const model = ev.target.getAttribute('model');
        const modelId = parseInt(ev.target.getAttribute('model-id'));
        return this._rpc( {
            model,
            args: [[modelId]],
            method: 'actionAssign'
        }).then(() => this._reloadReport());
    }

});

core.actionRegistry.add('replenishReport', ReplenishReport);

return(ReplenishReport);

});
