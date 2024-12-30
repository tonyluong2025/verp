/** @verp-module */
import KanbanController from 'web.KanbanController';

const ForecastKanbanController = KanbanController.extend({
    customEvents: _.extend({}, KanbanController.prototype.customEvents, {
        forecastKanbanAddColumn: '_onAddColumnForecast',
    }),

    /**
     * Expand the fillTemporal period after the ForecastColumnQuickCreate has been used, then
     * reload the view to refetch updated data
     *
     * @private
     * @param {VerpEvent} ev
     */
    _onAddColumnForecast(ev) {
        ev.stopPropagation();
        this.call('fillTemporalService', 'getFillTemporalPeriod', {
            modelName: this.model.loadParams.modelName,
            field: {
                name: this.model.forecastField,
                type: this.model.loadParams.fields[this.model.forecastField].type,
            },
            granularity: this.model.granularity,
        }).expand();
        this.mutex.exec(() => this.update(
            { groupby: [`${this.model.forecastField}:${this.model.granularity}`] },
            { reload: true }
        ));
    },
});

export {
    ForecastKanbanController,
};
