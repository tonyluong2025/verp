verp.define('website_sale.backend', function (require) {
"use strict";

var WebsiteBackend = require('website.backend.dashboard');
var COLORS = ['#875a7b', '#21b799', '#E4A900', '#D5653E', '#5B899E', '#E46F78', '#8F8F8F'];

WebsiteBackend.include({
    jsLibs: [
        '/web/static/lib/Chart/Chart.js',
    ],

    events: _.defaults({
        'click tr.o-product-template': 'onProductTemplate',
        'click .js-utm-selector': '_onClickUtmButton',
    }, WebsiteBackend.prototype.events),

    init: function (parent, context) {
        this._super(parent, context);

        this.graphs.push({'label': 'sales', 'group': 'saleSalesman'});
    },

    /**
     * @override method from website backendDashboard
     * @private
     */
    renderGraphs: function() {
        this._super();
        this.utmGraphData = this.dashboardsData.sales.utmGraph;
        this.utmGraphData && this._renderUtmGraph();
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * Method used to generate Pie chart, depending on user selected UTM option(campaign, medium, source)
     *
     * @private
     */
    _renderUtmGraph: function() {
        var self = this;
        this.$(".utm-button-name").html(this.btnName); // change drop-down button name
        var utmDataType = this.utmType || 'campaignId';
        var graphData = this.utmGraphData[utmDataType];
        if (graphData.length) {
            this.$(".o-utm-no-data-img").hide();
            this.$(".o-utm-data-graph").empty().show();
            var $canvas = $('<canvas/>');
            this.$(".o-utm-data-graph").append($canvas);
            var context = $canvas[0].getContext('2d');
            console.log(graphData);

            var data = [];
            var labels = [];
            graphData.forEach(function(pt) {
                data.push(pt.amountTotal);
                labels.push(pt.utmType);
            });
            var config = {
                type: 'pie',
                data: {
                    labels: labels,
                    datasets: [{
                        data: data,
                        backgroundColor: COLORS,
                    }]
                },
                options: {
                    tooltips: {
                        callbacks: {
                            label: function(tooltipItem, data) {
                                var label = data.labels[tooltipItem.index] || '';
                                if (label) {
                                    label += ': ';
                                }
                                var amount = data.datasets[0].data[tooltipItem.index];
                                amount = self.renderMonetaryField(amount, self.data.currency);
                                label += amount;
                                return label;
                            }
                        }
                    },
                    legend: {display: false}
                }
            };
            new Chart(context, config);
        } else {
            this.$(".o-utm-no-data-img").show();
            this.$(".o-utm-data-graph").hide();
        }
    },

    //--------------------------------------------------------------------------
        // Handlers
        //--------------------------------------------------------------------------

        /**
         * Onchange on UTM dropdown button, this method is called.
         *
         * @private
         */
    _onClickUtmButton: function(ev) {
        this.utmType = $(ev.currentTarget).attr('name');
        this.btnName = $(ev.currentTarget).text();
        this._renderUtmGraph();
    },

    onProductTemplate: function (ev) {
        ev.preventDefault();

        var productTemplateId = $(ev.currentTarget).data('productId');
        this.doAction({
            type: 'ir.actions.actwindow',
            resModel: 'product.template',
            resId: productTemplateId,
            views: [[false, 'form']],
            target: 'current',
        }, {
            onReverseBreadcrumb: this.onReverseBreadcrumb,
        });
    },
});
return WebsiteBackend;

});
