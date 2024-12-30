/** @verp-module */
import { ForecastKanbanController } from './forecast_controllers';
import { ForecastKanbanModel } from './forecast_models';
import { ForecastKanbanRenderer } from './forecast_renderers';
import { ForecastSearchModel } from "./forecast_search_model";
import { GraphView } from "@web/views/graph/graph_view";
import KanbanView from 'web.KanbanView';
import ListView from 'web.ListView';
import { PivotView } from "@web/views/pivot/pivot_view";
import { registry } from "@web/core/registry";
import viewRegistry from 'web.viewRegistry';

/**
 * Graph view to be used for a Forecast @see ForecastSearchModel
 * requires:
 * - context key `forecastField` on a date/datetime field
 * - special filter "Forecast" (which must set the `forecastFilter:1` context key)
 */
class ForecastGraphView extends GraphView {}
ForecastGraphView.SearchModel = ForecastSearchModel;

registry.category("views").add("forecastGraph", ForecastGraphView);

/**
 * Kanban view to be used for a Forecast
 * @see ForecastModelExtension
 * @see FillTemporalService
 * @see ForecastKanbanColumnQuickCreate
 * requires:
 * - context key `forecastField` on a date/datetime field
 * - special filter "Forecast" (which must set the `forecastFilter:1` context key)
 */
const ForecastKanbanView = KanbanView.extend({
    config: _.extend({}, KanbanView.prototype.config, {
        Renderer: ForecastKanbanRenderer,
        Model: ForecastKanbanModel,
        Controller: ForecastKanbanController,
    }),
    /**
     * @private
     * @override
     */
    _createSearchModel(params, extraExtensions={}) {
        Object.assign(extraExtensions, { forecast: {} });
        return this._super(params, extraExtensions);
    },
});
viewRegistry.add('forecastKanban', ForecastKanbanView);

/**
 * List view to be used for a Forecast @see ForecastModelExtension
 * requires:
 * - context key `forecastField` on a date/datetime field
 * - special filter "Forecast" (which must set the `forecastFilter:1` context key)
 */
const ForecastListView = ListView.extend({
    /**
     * @private
     * @override
     */
    _createSearchModel(params, extraExtensions = {}) {
        Object.assign(extraExtensions, { forecast: {} });
        return this._super(params, extraExtensions);
    },
});
viewRegistry.add('forecastList', ForecastListView);

/**
 * Pivot view to be used for a Forecast @see ForecastSearchModel
 * requires:
 * - context key `forecastField` on a date/datetime field
 * - special filter "Forecast" (which must set the `forecastFilter:1` context key)
 */
class ForecastPivotView extends PivotView {}
ForecastPivotView.SearchModel = ForecastSearchModel;

registry.category("views").add("forecastPivot", ForecastPivotView);

export {
    ForecastGraphView,
    ForecastKanbanView,
    ForecastListView,
    ForecastPivotView,
};
