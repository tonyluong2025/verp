/** @verp-module **/

import ActionModel from "@web/legacy/js/views/action_model";
import { makeContext } from "@web/core/context";

/**
 * @param {string} state
 * @returns {string}
 */
function searchModelStateFromLegacy(state) {
    /**
     * Possible problem if only one of ControlPanelModelExtension or SearchPanelModelExtension is installed.
     * We might need to do something in SearchModel.
     * @todo (DAM) check when search panel is reworked.
     */
    const parsedState = JSON.parse(state);
    const newState = {};

    if (parsedState.ControlPanelModelExtension) {
        const {
            query,
            filters,
            nextGroupId,
            nextGroupNumber,
            nextId,
        } = parsedState.ControlPanelModelExtension;

        newState.nextGroupId = nextGroupId;
        newState.nextGroupNumber = nextGroupNumber;
        newState.nextId = nextId;
        newState.query = [];
        newState.searchItems = {};

        for (const queryElem of query) {
            const filterId = queryElem.filterId;
            const filter = filters[filterId];
            const newQueryElem = { searchItemId: filterId };
            switch (filter.type) {
                case "filter":
                    if (filter.hasOptions) {
                        newQueryElem.generatorId = queryElem.optionId;
                    }
                    break;
                case "groupby":
                    if (filter.hasOptions) {
                        newQueryElem.intervalId = queryElem.optionId;
                    }
                    break;
                case "field":
                    newQueryElem.autocompleteValue = {
                        value: queryElem.value,
                        label: queryElem.label,
                        operator: queryElem.operator,
                    };
                    break;
            }
            newState.query.push(newQueryElem);
        }

        for (const filter of Object.values(filters)) {
            const item = Object.assign({}, filter);
            switch (item.type) {
                case "groupby":
                    if (filter.hasOptions) {
                        item.type = "dateGroupBy";
                        item.defaultIntervalId = item.defaultOptionId;
                        delete item.hasOptions;
                        delete item.defaultOptionId;
                    }
                    break;
                case "filter":
                    if (filter.hasOptions) {
                        item.type = "dateFilter";
                        item.defaultGeneratorId = item.defaultOptionId;
                        delete item.hasOptions;
                        delete item.isDateFilter;
                        delete item.defaultOptionId;
                    }
                    break;
                case "favorite":
                    item.orderby = item.orderedBy;
                    delete item.orderedBy;
                    break;
            }
            newState.searchItems[filter.id] = item;
        }
    }

    if (parsedState.SearchPanelModelExtension) {
        const { sections, searchpanelInfo } = parsedState.SearchPanelModelExtension;
        newState.sections = sections;
        //! Can be undefined. See search_model.__legacyParseSearchPanelArchAnyway
        newState.searchpanelInfo = searchpanelInfo;
    }

    for (const [key, extension] of Object.entries(ActionModel.registry.entries())) {
        if (
            !["ControlPanel", "SearchPanel"].includes(key) &&
            parsedState[extension.name] !== undefined
        ) {
            newState[key] = parsedState[extension.name];
        }
    }

    if (!Object.keys(newState).length) {
        return;
    }

    return JSON.stringify(newState);
}

/**
 * @param {string} state
 * @returns {string}
 */
export function searchModelStateToLegacy(state) {
    if (!state) {
        return;
    }

    const parsedState = JSON.parse(state);
    const query = [];
    for (const queryElem of parsedState.query) {
        const searchItemId = queryElem.searchItemId;
        const searchItem = parsedState.searchItems[searchItemId];
        const groupId = searchItem.groupId;
        const legacyQueryElem = { filterId: searchItemId, groupId };
        switch (searchItem.type) {
            case "dateFilter":
                legacyQueryElem.optionId = queryElem.generatorId;
                break;
            case "dateGroupBy":
                legacyQueryElem.optionId = queryElem.intervalId;
                break;
            case "comparison":
                legacyQueryElem.type = "comparison";
                legacyQueryElem.dateFilterId = searchItem.dateFilterId;
                break;
            case "field":
                legacyQueryElem.value = queryElem.autocompleteValue.value;
                legacyQueryElem.label = queryElem.autocompleteValue.label;
                legacyQueryElem.operator = queryElem.autocompleteValue.operator;
                break;
        }
        query.push(legacyQueryElem);
    }

    const filters = {};
    for (const item of Object.values(parsedState.searchItems)) {
        const filter = Object.assign({}, item);
        switch (item.type) {
            case "dateGroupBy":
                filter.type = "groupby";
                filter.hasOptions = true;
                filter.defaultOptionId = item.defaultIntervalId;
                delete filter.defaultIntervalId;
                break;
            case "dateFilter":
                filter.type = "filter";
                filter.isDateFilter = true;
                filter.hasOptions = true;
                filter.defaultOptionId = item.defaultGeneratorId;
                delete filter.defaultGeneratorId;
                break;
            case "favorite":
                filter.orderedBy = item.orderby;
                delete filter.orderby;
                break;
            case "filter":
                let context = item.context;
                try {
                    context = makeContext([context]);
                } catch (e) {}
                filter.context = context;
        }
        filters[item.id] = filter;
    }

    const { nextGroupId, nextGroupNumber, nextId, sections, searchpanelInfo } = parsedState;
    const legacyState = {};
    legacyState.ControlPanelModelExtension = {
        query,
        filters,
        nextGroupId,
        nextGroupNumber,
        nextId,
    };
    legacyState.SearchPanelModelExtension = { sections, searchpanelInfo };

    for (const [key, extension] of Object.entries(ActionModel.registry.entries())) {
        if (!["ControlPanel", "SearchPanel"].includes(key) && parsedState[key] !== undefined) {
            legacyState[extension.name] = parsedState[key];
        }
    }

    return JSON.stringify(legacyState);
}

export function getGlobalState(legacyControllerState) {
    const { resIds, searchModel, searchpanel } = legacyControllerState;
    const globalState = {};
    if (searchpanel) {
        globalState.searchpanel = searchpanel;
    }
    if (resIds) {
        globalState.resIds = resIds;
    }
    const newSearchModel = searchModelStateFromLegacy(searchModel);
    if (newSearchModel) {
        globalState.searchModel = newSearchModel;
    }
    return globalState;
}

export function getLocalState(legacyControllerState) {
    const state = Object.assign({}, legacyControllerState);
    delete state.searchModel;
    delete state.searchpanel;
    delete state.resIds;
    return state;
}

export function mapDoActionOptionAPI(legacyOptions) {
    legacyOptions = legacyOptions || {};
    // use camelCase instead of snake_case for some keys
    Object.assign(legacyOptions, {
        additionalContext: legacyOptions.additionalContext,
        clearBreadcrumbs: legacyOptions.clearBreadcrumbs,
        viewType: legacyOptions.viewType,
        onClose: legacyOptions.onClose,
        props: Object.assign({ resId: legacyOptions.resId }, legacyOptions.props),
    });
    if (legacyOptions.controllerState) {
        legacyOptions.props.globalState = getGlobalState(legacyOptions.controllerState);
    }
    delete legacyOptions.additionalContext;
    delete legacyOptions.clearBreadcrumbs;
    delete legacyOptions.viewType;
    delete legacyOptions.resId;
    delete legacyOptions.onClose;
    return legacyOptions;
}

export function makeLegacyActionManagerService(legacyEnv) {
    // add a service to redirect 'do-action' events triggered on the bus in the
    // legacy env to the action-manager service in the wowl env
    return {
        dependencies: ["action"],
        start(env) {
            function doAction(action, options) {
                const legacyOptions = mapDoActionOptionAPI(options);
                return env.services.action.doAction(action, legacyOptions);
            }
            legacyEnv.bus.on("do-action", null, (payload) => {
                const { action, options } = payload;
                doAction(action, options);
            });
            return { doAction };
        },
    };
}

export function breadcrumbsToLegacy(breadcrumbs) {
    if (!breadcrumbs) {
        return;
    }
    return breadcrumbs.slice().map((bc) => {
        return { title: bc.name, controllerID: bc.jsId };
    });
}
