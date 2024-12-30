verp.define('webKanbanGauge.widget', function (require) {
"use strict";

var AbstractField = require('web.AbstractField');
var core = require('web.core');
var fieldRegistry = require('web.fieldRegistry');
var utils = require('web.utils');

var _t = core._t;

/**
 * options
 *
 * - maxValue: maximum value of the gauge [default: 100]
 * - maxField: get the maxValue from the field that must be present in the
 *   view; takes over maxValue
 * - gaugeValueField: if set, the value displayed below the gauge is taken
 *   from this field instead of the base field used for
 *   the gauge. This allows to display a number different
 *   from the gauge.
 * - label: label of the gauge, displayed below the gauge value
 * - labelField: get the label from the field that must be present in the
 *   view; takes over label
 * - title: title of the gauge, displayed on top of the gauge
 * - style: custom style
 */

var GaugeWidget = AbstractField.extend({
    className: "oe-gauge",
    jsLibs: [
        '/web/static/lib/Chart/Chart.js',
    ],

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * @override
     * @private
     */
    _render: function () {
        // current value
        var val = this.value;
        if (_.isArray(JSON.parse(val))) {
            val = JSON.parse(val);
        }
        var gaugeValue = _.isArray(val) && val.length ? val[val.length-1].value : val;
        if (this.nodeOptions.gaugeValueField) {
            gaugeValue = this.recordData[this.nodeOptions.gaugeValueField];
        }

        // maxValue
        var maxValue = this.nodeOptions.maxValue || 100;
        if (this.nodeOptions.maxField) {
            maxValue = this.recordData[this.nodeOptions.maxField];
        }
        maxValue = Math.max(gaugeValue, maxValue);

        // label
        var label = this.nodeOptions.label || "";
        if (this.nodeOptions.labelField) {
            label = this.recordData[this.nodeOptions.labelField];
        }

        // title
        var title = this.nodeOptions.title || this.field.string;

        var maxLabel = maxValue;
        if (gaugeValue === 0 && maxValue === 0) {
            maxValue = 1;
            maxLabel = 0;
        }
		var config = {
			type: 'doughnut',
			data: {
				datasets: [{
					data: [
                        gaugeValue,
                        maxValue - gaugeValue
					],
					backgroundColor: [
                        "#1f77b4", "#dddddd"
					],
					label: title
				}],
			},
			options: {
				circumference: Math.PI,
				rotation: -Math.PI,
				responsive: true,
                tooltips: {
                    displayColors: false,
                    callbacks: {
                        label: function(tooltipItems) {
                            if (tooltipItems.index === 0) {
                                return _t('Value: ') + gaugeValue;
                            }
                            return _t('Max: ') + maxLabel;
                        },
                    },
                },
				title: {
					display: true,
					text: title,
                    padding: 4,
				},
                layout: {
                    padding: {
                        bottom: 5
                    }
                },
                maintainAspectRatio: false,
                cutoutPercentage: 70,
            }
		};
        this.$canvas = $('<canvas/>');
        this.$el.empty();
        this.$el.append(this.$canvas);
        this.$el.attr('style', this.nodeOptions.style);
        this.$el.css({position: 'relative'});
        var context = this.$canvas[0].getContext('2d');
        this.chart = new Chart(context, config);

        var humanValue = utils.humanNumber(gaugeValue, 1);
        var $value = $('<span class="o-gauge-value">').text(humanValue);
        $value.css({'text-align': 'center', position: 'absolute', left: 0, right: 0, bottom: '6px', 'font-weight': 'bold'});
        this.$el.append($value);
    },
});

fieldRegistry.add("gauge", GaugeWidget);

return GaugeWidget;

});
