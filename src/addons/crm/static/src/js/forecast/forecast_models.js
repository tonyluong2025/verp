/** @verp-module */
import KanbanModel from 'web.KanbanModel';

const ForecastKanbanModel = KanbanModel.extend({
    /**
     * Checks whether to apply the forecast logic to a load or a reload, depending on the groupby
     * and the forecastField. Sets the current granularity if the forecast applies
     *
     * @private
     * @param {Object} element what to load (params) / reload (localData from id)
     * @param {Object} params optional reload params
     * @returns {boolean}
     */
    _isForecast(element, params={}) {
        let groupby, granularity;
        if (!element) {
            return false;
        }
        if ("groupby" in params) {
            [groupby, granularity] = params.groupby[0].split(':');
        } else if (element.groupedBy.length != 0) {
            [groupby, granularity] = element.groupedBy[0].split(':');
        } else if (element.groupby.length != 0) {
            [groupby, granularity] = element.groupby[0].split(':');
        }
        granularity = granularity || "month";
        if (!this.forecastField || groupby != this.forecastField) {
            return false;
        }
        this.granularity = granularity;
        return true;
    },

    /**
     * At every __load/__reload, we have to check the range of the last group received from the
     * readGroup, and update the fillTemporalPeriod from the FillTemporalService accordingly
     *
     * @private
     */
    _updateFillTemporalPeriodEnd(fillTemporalPeriod) {
        let lastGroup = this.get(this.handle).data.filter(group => group.value).slice(-1)[0];
        if (lastGroup) {
            lastGroup = this.localData[lastGroup.id];
            fillTemporalPeriod.setEnd(moment.utc(lastGroup.range[this.forecastField].to));
        }
    },

    /**
     * Applies the forecast logic to the domain and context if needed before the readGroup.
     * After the readGroup, checks the end date of the last displayed group in order to be able to
     * add the next group with the ForecastColumnQuickCreate widget
     *
     * @private
     * @override
     */
    async __load(params) {
        this.loadDomain = params.domain;
        this.loadContext = params.context;
        this.forecastField = params.context.forecastField;
        if (!this._isForecast(params)) {
            return this._super(...arguments);
        }
        this.minGroups =
            params.context.fillTemporal && params.context.fillTemporal.minGroups || undefined;
        const fillTemporalPeriod = this.call('fillTemporalService', 'getFillTemporalPeriod', {
            modelName: params.modelName,
            field: {
                name: this.forecastField,
                type: params.fields[this.forecastField].type,
            },
            granularity: this.granularity,
            minGroups: this.minGroups,
            forceRecompute: true,
        });
        params.domain = fillTemporalPeriod.getDomain({
            domain: this.loadDomain,
            forceStartBound: false
        });
        params.context = fillTemporalPeriod.getContext({ context: this.loadContext });
        this.handle = await this._super(...arguments);
        this._updateFillTemporalPeriodEnd(fillTemporalPeriod);
        return this.handle;
    },

    /**
     * In order to display the sample data, the context and domain need to be the same as before a
     * reload. If the user switches to another view (list, pivot, ...) and comes back without
     * adding any record or modifying the search bar, we still want to display the sample data, but
     * the actual domain and context won't be the same because load and reload are modifying them.
     *
     * As such, we will only compare the original domain and context (without the use of the
     * FillTemporalService) to determine whether the sample data should be enabled or not.
     *
     * The behavior for timeRanges and groupby is unchanged from the original
     *
     * @private
     * @override
     * @param {Object} [params={}]
     * @param {Object} [params.context]
     * @param {Array[]} [params.domain]
     * @param {Object} [params.timeRanges]
     * @param {string[]} [params.groupby]
     * @returns {boolean}
     */
    _haveParamsChanged(params = {}) {
        const originalParams = [this.loadContext, this.loadDomain];
        const currentParams = [this.reloadContext, this.reloadDomain];
        if (JSON.stringify(originalParams) !== JSON.stringify(currentParams)) {
            return true;
        }
        if ('timeRanges' in params) {
            const diff = JSON.stringify(params.timeRanges) !== JSON.stringify(this.loadParams.timeRanges);
            if (diff) {
                return true;
            }
        }
        if (this.useSampleModel && 'groupby' in params) {
            return JSON.stringify(params.groupby) !== JSON.stringify(this.loadParams.groupedBy);
        }
    },

    /**
     * Applies the forecast logic to the domain and context if needed before the readGroup.
     * After the readGroup, checks the end date of the last displayed group in order to be able to
     * add the next group with the ForecastColumnQuickCreate widget
     *
     * @private
     * @override
     */
    async __reload(id, params) {
        if (this.handle !== id || this.isSampleModel) {
            // the forecast logic should only apply when the whole view is reloading on real data
            return this._super(...arguments);
        }
        if ("domain" in params) {
            this.reloadDomain = params.domain;
        }
        if ("context" in params) {
            this.reloadContext = params.context;
            this.forecastField = params.context.forecastField;
            this.minGroups =
                params.context.fillTemporal && params.context.fillTemporal.minGroups || this.minGroups;
        }
        const element = this.localData[id];
        if (!this._isForecast(element, params)) {
            return this._super(...arguments);
        }
        const fillTemporalPeriod = this.call('fillTemporalService', 'getFillTemporalPeriod', {
            modelName: this.loadParams.modelName,
            field: {
                name: this.forecastField,
                type: this.loadParams.fields[this.forecastField].type,
            },
            granularity: this.granularity,
            minGroups: this.minGroups,
        });
        params.domain = fillTemporalPeriod.getDomain({
            domain: this.reloadDomain || this.loadDomain,
            forceStartBound: false
        });
        params.context = fillTemporalPeriod.getContext({ context: this.reloadContext || this.loadContext });
        const reload = await this._super(...arguments);
        this._updateFillTemporalPeriodEnd(fillTemporalPeriod);
        return reload;
    },
});

export {
    ForecastKanbanModel,
};
