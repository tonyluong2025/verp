/** @verp-module **/

import { registry } from "@web/core/registry";

/**
 * @typedef {Object} IrFilter
 * @property {[number, string] | false} userId
 * @property {string} sort
 * @property {string} context
 * @property {string} name
 * @property {string} domain
 * @property {number} id
 * @property {boolean} isDefault
 * @property {string} modelId
 * @property {[number, string] | false} actionId
 */

/**
 * @typedef {Object} ViewDescription
 * @property {string} arch
 * @property {Object} fields
 * @property {string} model
 * @property {string} [name] is returned by the server ("default" or real name)
 * @property {string} type
 * @property {number} [viewId]
 * @property {Object} [actionMenus] // for views other than search
 * @property {IrFilter[]} [irFilters] // for search view
 */

/**
 * @typedef {Object} LoadViewsParams
 * @property {string} resModel
 * @property {[number, string][]} views
 * @property {Object} context
 */

/**
 * @typedef {Object} LoadViewsOptions
 * @property {number|false} actionId
 * @property {boolean} loadActionMenus
 * @property {boolean} loadIrFilters
 */

export const viewService = {
    name: "view",
    dependencies: ["orm"],
    start(env, { orm }) {
        let cache = {};

        env.bus.on("CLEAR-CACHES", null, () => {
            cache = {};
            const processedArchs = registry.category("__processed_archs__");
            processedArchs.content = {};
            processedArchs.trigger("UPDATE");
        });

        /**
         * Loads various information concerning views: fieldsView for each view,
         * fields of the corresponding model, and optionally the filters.
         *
         * @param {LoadViewsParams} params
         * @param {LoadViewsOptions} options
         * @returns {Promise<ViewDescriptions>}
         */
        async function loadViews(params, options) {
            const key = JSON.stringify([params.resModel, params.views, params.context, options]);
            if (!cache[key]) {
                cache[key] = orm
                    .call(params.resModel, "loadViews", [], {
                        views: params.views,
                        options: {
                            actionId: options.actionId || false,
                            loadFilters: options.loadIrFilters || false,
                            toolbar: options.loadActionMenus || false,
                        },
                        context: params.context,
                    })
                    .then((result) => {
                        const viewDescriptions = {
                            __legacy__: result,
                        }; // for legacy purpose, keys in result are left in viewDescriptions
                        for (const [, viewType] of params.views) {
                            const viewDescription = JSON.parse(
                                JSON.stringify(result.fieldsViews[viewType])
                            );
                            viewDescription.viewId = viewDescription.viewId;
                            delete viewDescription.viewId;
                            if (viewDescription.toolbar) {
                                viewDescription.actionMenus = viewDescription.toolbar;
                                delete viewDescription.toolbar;
                            }
                            viewDescription.fields = Object.assign(
                                {},
                                result.fields,
                                viewDescription.fields
                            ); // before a deep freeze was done.
                            delete viewDescription.basemodel; // unused
                            delete viewDescription.fieldparent; // unused
                            if (viewType === "search" && options.loadIrFilters) {
                                viewDescription.irFilters = result.filters;
                            }
                            viewDescriptions[viewType] = viewDescription;
                        }
                        return viewDescriptions;
                    })
                    .catch((error) => {
                        delete cache[key];
                        return Promise.reject(error);
                    });
            }
            return cache[key];
        }
        return { loadViews };
    },
};

registry.category("services").add("view", viewService);
