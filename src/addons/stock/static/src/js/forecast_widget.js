verp.define('stock.forecastWidget', function (require) {
'use strict';

const AbstractField = require('web.AbstractField');
const fieldRegistry = require('web.fieldRegistry');
const fieldUtils = require('web.fieldUtils');
const utils = require('web.utils');
const core = require('web.core');
const QWeb = core.qweb;

const ForecastWidgetField = AbstractField.extend({
    supportedFieldTypes: ['float'],

    _render: function () {
        var data = Object.assign({}, this.record.data, {
            forecastAvailabilityStr: fieldUtils.format.float(
                this.record.data.forecastAvailability,
                this.record.fields.forecastAvailability,
                this.nodeOptions
            ),
            reservedAvailabilityStr: fieldUtils.format.float(
                this.record.data.reservedAvailability,
                this.record.fields.reservedAvailability,
                this.nodeOptions
            ),
            forecastExpectedDateStr: fieldUtils.format.date(
                this.record.data.forecastExpectedDate,
                this.record.fields.forecastExpectedDate
            ),
        });
        if (data.forecastExpectedDate && data.dateDeadline) {
            data.forecastIsLate = data.forecastExpectedDate > data.dateDeadline;
        }
        data.willBeFulfilled = utils.roundDecimals(data.forecastAvailability, this.record.fields.forecastAvailability.digits[1]) >= utils.roundDecimals(data.productQty, this.record.fields.forecastAvailability.digits[1]);

        this.$el.html(QWeb.render('stock.forecastWidget', data));
        this.$('.o-forecast-report-button').on('click', this._onOpenReport.bind(this));
    },

    isSet: function () {
        return true;
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * Opens the Forecast Report for the `stock.move` product.
     *
     * @param {MouseEvent} ev
     */
    _onOpenReport: function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        if (!this.recordData.id) {
            return;
        }
        this._rpc({
            model: 'stock.move',
            method: 'actionProductForecastReport',
            args: [this.recordData.id],
        }).then(action => {
            action.context = Object.assign(action.context || {}, {
                activeModel: 'product.product',
                activeId: this.recordData.productId.resId,
            });
            this.doAction(action);
        });
    },
});

const JsonWidget = AbstractField.extend({
    supportedFieldTypes: ['char'],

    _render: function () {
        var value = JSON.parse(this.value);
        if (!value || !value.template) {
            this.$el.html('');
            return;
        }
        $(QWeb.render(value.template, value)).appendTo(this.$el);
    },
});

fieldRegistry.add('forecastWidget', ForecastWidgetField);
fieldRegistry.add('jsonWidget', JsonWidget);

return ForecastWidgetField;
});
