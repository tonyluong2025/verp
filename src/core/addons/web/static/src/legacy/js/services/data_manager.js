verp.define('web.DataManager', function (require) {
"use strict";

var config = require('web.config');
var core = require('web.core');
var rpc = require('web.rpc');
var session = require('web.session');
var utils = require('web.utils');

return core.Class.extend({
    init: function () {
        this._initCache();
        core.bus.on('clearCache', this, this.invalidate.bind(this));
    },

    _initCache: function () {
        this._cache = {
            actions: {},
            filters: {},
            views: {},
        };
    },

    /**
     * Invalidates the whole cache. Only works when not triggered by itself.
     * Suggestion: could be refined to invalidate some part of the cache
     *
     * @param {Object} [dataManager]
     */
    invalidate: function (dataManager) {
        if (dataManager === this) {
            return;
        }
        session.invalidateCacheKey('loadMenus');
        this._initCache();
    },

    /**
     * Loads an action from its id or xmlid.
     *
     * @param {int|string} [actionId] the action id or xmlid
     * @param {Object} [additionalContext] used to load the action
     * @return {Promise} resolved with the action whose id or xmlid is actionId
     */
    loadAction: function (actionId, additionalContext) {
        var self = this;
        var key = this._genKey(actionId, additionalContext || {});

        if (config.isDebug('assets') || !this._cache.actions[key]) {
            this._cache.actions[key] = rpc.query({
                route: "/web/action/load",
                params: {
                    actionId: actionId,
                    additionalContext: additionalContext,
                },
            }).then(function (action) {
                self._cache.actions[key] = action.noCache ? null : self._cache.actions[key];
                return action;
            }).guardedCatch(() => this._invalidate('actions', key));
        }

        return this._cache.actions[key].then(function (action) {
            return $.extend(true, {}, action);
        });
    },

    /**
     * Loads various information concerning views: fieldsView for each view,
     * the fields of the corresponding model, and optionally the filters.
     *
     * @param {Object} params
     * @param {String} params.model
     * @param {Object} params.context
     * @param {Array} params.viewsDescr array of [viewId, viewType]
     * @param {Object} [options={}] dictionary of various options:
     *     - options.loadFilters: whether or not to load the filters,
     *     - options.actionId: the actionId (required to load filters),
     *     - options.toolbar: whether or not a toolbar will be displayed,
     * @return {Promise} resolved with the requested views information
     */
    loadViews: async function ({ model, context, viewsDescr } , options = {}) {
        const viewsKey = this._genKey(model, viewsDescr, options, context);
        const filtersKey = this._genKey(model, options.actionId);
        const withFilters = Boolean(options.loadFilters);
        const shouldLoadViews = config.isDebug('assets') || !this._cache.views[viewsKey];
        const shouldLoadFilters = config.isDebug('assets') || (
            withFilters && !this._cache.filters[filtersKey]
        );
        if (shouldLoadViews) {
            // Views info should be loaded
            options.loadFilters = shouldLoadFilters;
            this._cache.views[viewsKey] = rpc.query({
                args: [],
                kwargs: { context, options, views: viewsDescr },
                model,
                method: 'loadViews',
            }).then(result => {
                // Freeze the fields dict as it will be shared between views and
                // no one should edit it
                utils.deepFreeze(result.fields);
                for (const [viewId, viewType] of viewsDescr) {
                    const fvg = result.fieldsViews[viewType];
                    fvg.viewFields = fvg.fields;
                    fvg.fields = result.fields;
                }

                // Insert filters, if any, into the filters cache
                if (shouldLoadFilters) {
                    this._cache.filters[filtersKey] = Promise.resolve(result.filters);
                }
                return result.fieldsViews;
            }).guardedCatch(() => this._invalidate('views', viewsKey));
        }
        const result = await this._cache.views[viewsKey];
        if (withFilters && result.search) {
            if (shouldLoadFilters) {
                await this.loadFilters({
                    actionId: options.actionId,
                    context,
                    forceReload: false,
                    modelName: model,
                });
            }
            result.search.favoriteFilters = await this._cache.filters[filtersKey];
        }
        return result;
    },

    /**
     * Loads the filters of a given model and optional action id.
     *
     * @param {Object} params
     * @param {number} params.actionId
     * @param {Object} params.context
     * @param {boolean} [params.forceReload=true] can be set to false to prevent forceReload
     * @param {string} params.modelName
     * @return {Promise} resolved with the requested filters
     */
    loadFilters: function (params) {
        const key = this._genKey(params.modelName, params.actionId);
        const forceReload = params.forceReload !== false && config.isDebug('assets');
        if (forceReload || !this._cache.filters[key]) {
            this._cache.filters[key] = rpc.query({
                args: [params.modelName, params.actionId],
                kwargs: {
                    context: params.context || {},
                    // getContext() de dataset
                },
                model: 'ir.filters',
                method: 'getFilters',
            }).guardedCatch(() => this._invalidate('filters', key));
        }
        return this._cache.filters[key];
    },

    /**
     * Calls 'createOrReplace' on 'irFilters'.
     *
     * @param {Object} [filter] the filter description
     * @return {Promise} resolved with the id of the created or replaced filter
     */
    createFilter: function (filter) {
        return rpc.query({
                args: [filter],
                model: 'ir.filters',
                method: 'createOrReplace',
            })
            .then(filterId => {
                const filtersKey = this._genKey(filter.modelId, filter.actionId);
                this._invalidate('filters', filtersKey);
                return filterId;
            });
    },

    /**
     * Calls 'unlink' on 'irFilters'.
     *
     * @param {integer} filterId Id of the filter to remove
     * @return {Promise}
     */
    deleteFilter: function (filterId) {
        return rpc.query({
                args: [filterId],
                model: 'ir.filters',
                method: 'unlink',
            })
            // Invalidate the whole cache since we have no idea where the filter came from.
            .then(() => this._invalidate('filters'));
    },

    /**
     * Private function that generates a cache key from its arguments
     */
    _genKey: function () {
        return _.map(Array.prototype.slice.call(arguments), function (arg) {
            if (!arg) {
                return false;
            }
            return _.isObject(arg) ? JSON.stringify(arg) : arg;
        }).join(',');
    },

    /**
     * Invalidate a cache entry or a whole cache section.
     *
     * @private
     * @param {string} section
     * @param {string} key
     */
    _invalidate(section, key) {
        core.bus.trigger("clearCache", this);
        if (key) {
            delete this._cache[section][key];
        } else {
            this._cache[section] = {};
        }
    },
});

});

verp.define('web.dataManager', function (require) {
"use strict";

var DataManager = require('web.DataManager');

var dataManager = new DataManager();

return dataManager;

});
