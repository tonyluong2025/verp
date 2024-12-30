/** @verp-module */

import GraphView from 'web.GraphView';
import viewRegistry from 'web.viewRegistry';

/**
 * Graph view to be used for a Forecast @see ForecastModelExtension
 * requires:
 * - context key `forecastField` on a date/datetime field
 * - special filter "Forecast" (which must set the `forecastFilter:1` context key)
 */
const ForecastGraphView = GraphView.extend({
    /**
     * @private
     * @override
     */
    _createSearchModel(params, extraExtensions = {}) {
        Object.assign(extraExtensions, { Forecast: {} });
        return this._super(params, extraExtensions);
    },
});
viewRegistry.add('forecastGraph', ForecastGraphView);
