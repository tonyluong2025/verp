verp.define('web.PieChart', function (require) {
"use strict";

/**
 * This widget render a Pie Chart. It is used in the dashboard view.
 */

var core = require('web.core');
var Domain = require('web.Domain');
var viewRegistry = require('web.viewRegistry');
var Widget = require('web.Widget');
var widgetRegistry = require('web.widgetRegistryOld');
const { loadLegacyViews } = require("@web/legacy/legacy_views");

var qweb = core.qweb;

var PieChart = Widget.extend({
    className: 'o-pie-chart',
    xmlDependencies: ['/web/static/src/legacy/xml/chart.xml'],

    /**
     * @override
     * @param {Widget} parent
     * @param {Object} record
     * @param {Object} node node from arch
     */
    init: function (parent, record, node) {
        this._super.apply(this, arguments);

        var modifiers = node.attrs.modifiers;
        var domain = record.domain.concat(
            Domain.prototype.stringToArray(modifiers.domain || '[]'));
        var arch = qweb.render('web.PieChart', {
            modifiers: modifiers,
            title: node.attrs.title || modifiers.title || modifiers.measure,
        });

        var pieChartContext = JSON.parse(JSON.stringify(record.context));
        delete pieChartContext.graphMode;
        delete pieChartContext.graphMeasure;
        delete pieChartContext.graphGroupbys;

        this.subViewParams = {
            modelName: record.model,
            withButtons: false,
            withControlPanel: false,
            withSearchPanel: false,
            isEmbedded: true,
            useSampleModel: record.isSample,
            mode: 'pie',
        };
        this.subViewParams.searchQuery = {
            context: pieChartContext,
            domain: domain,
            groupby: [],
            timeRanges: record.timeRanges || {},
        };

        this.viewInfo = {
            arch: arch,
            fields: record.fields,
            viewFields: record.fieldsInfo.dashboard,
        };
    },
    /**
     * Instantiates the pie chart view and starts the graph controller.
     *
     * @override
     */
    willStart: async function () {
        var self = this;
        const _super = this._super.bind(this, ...arguments);
        await loadLegacyViews({ rpc: this._rpc.bind(this) });
        var def1 = _super();

        var SubView = viewRegistry.get('graph');
        var subView = new SubView(this.viewInfo, this.subViewParams);
        var def2 = subView.getController(this).then(function (controller) {
            self.controller = controller;
            return self.controller.appendTo(document.createDocumentFragment());
        });
        return Promise.all([def1, def2]);
    },
    /**
     * @override
     */
    start: function () {
        this.$el.append(this.controller.$el);
        return this._super.apply(this, arguments);
    },
    /**
     * Call `onAttachCallback` for each subview
     *
     * @override
     */
    onAttachCallback: function () {
        this.controller.onAttachCallback();
    },
});

widgetRegistry.add('pieChart', PieChart);

return PieChart;

});
