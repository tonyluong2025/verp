/** @verp-module **/

import { editModelDebug } from "@web/core/debug/debug_utils";
import { registry } from "@web/core/registry";

const debugRegistry = registry.category("debug");

function actionSeparator({ action }) {
    if (!action.id || !action.resModel) {
        return null;
    }
    return {
        type: "separator",
        sequence: 100,
    };
}

function accessSeparator({ accessRights, action }) {
    const { canSeeModelAccess, canSeeRecordRules } = accessRights;
    if (!action.resModel || (!canSeeModelAccess && !canSeeRecordRules)) {
        return null;
    }
    return {
        type: "separator",
        sequence: 200,
    };
}

function editAction({ action, env }) {
    if (!action.id) {
        return null;
    }
    const description = env._t("Edit Action");
    return {
        type: "item",
        description,
        callback: () => {
            editModelDebug(env, description, action.type, action.id);
        },
        sequence: 110,
    };
}

function viewFields({ action, env }) {
    if (!action.resModel) {
        return null;
    }
    const description = env._t("View Fields");
    return {
        type: "item",
        description,
        callback: async () => {
            const modelId = (
                await env.services.orm.search("ir.model", [["model", "=", action.resModel]], {
                    limit: 1,
                })
            )[0];
            env.services.action.doAction({
                resModel: "ir.model.fields",
                name: description,
                views: [
                    [false, "list"],
                    [false, "form"],
                ],
                domain: [["modelId", "=", modelId]],
                type: "ir.actions.actwindow",
                context: {
                    default_modelId: modelId,
                },
            });
        },
        sequence: 120,
    };
}

function manageFilters({ action, env }) {
    if (!action.resModel) {
        return null;
    }
    const description = env._t("Manage Filters");
    return {
        type: "item",
        description,
        callback: () => {
            // manage_filters
            env.services.action.doAction({
                resModel: "ir.filters",
                name: description,
                views: [
                    [false, "list"],
                    [false, "form"],
                ],
                type: "ir.actions.actwindow",
                context: {
                    searchDefault_myFilters: true,
                    searchDefault_modelId: action.resModel,
                },
            });
        },
        sequence: 130,
    };
}

function technicalTranslation({ action, env }) {
    if (!action.resModel) {
        return null;
    }
    return {
        type: "item",
        description: env._t("Technical Translation"),
        callback: async () => {
            const result = await env.services.orm.call(
                "ir.translation",
                "getTechnicalTranslations",
                [action.resModel]
            );
            env.services.action.doAction(result);
        },
        sequence: 140,
    };
}

function viewAccessRights({ accessRights, action, env }) {
    if (!action.resModel || !accessRights.canSeeModelAccess) {
        return null;
    }
    const description = env._t("View Access Rights");
    return {
        type: "item",
        description,
        callback: async () => {
            const modelId = (
                await env.services.orm.search("ir.model", [["model", "=", action.resModel]], {
                    limit: 1,
                })
            )[0];
            env.services.action.doAction({
                resModel: "ir.model.access",
                name: description,
                views: [
                    [false, "list"],
                    [false, "form"],
                ],
                domain: [["modelId", "=", modelId]],
                type: "ir.actions.actwindow",
                context: {
                    default_modelId: modelId,
                },
            });
        },
        sequence: 210,
    };
}

function viewRecordRules({ accessRights, action, env }) {
    if (!action.resModel || !accessRights.canSeeRecordRules) {
        return null;
    }
    const description = env._t("Model Record Rules");
    return {
        type: "item",
        description: env._t("View Record Rules"),
        callback: async () => {
            const modelId = (
                await env.services.orm.search("ir.model", [["model", "=", action.resModel]], {
                    limit: 1,
                })
            )[0];
            env.services.action.doAction({
                resModel: "ir.rule",
                name: description,
                views: [
                    [false, "list"],
                    [false, "form"],
                ],
                domain: [["modelId", "=", modelId]],
                type: "ir.actions.actwindow",
                context: {
                    default_modelId: modelId,
                },
            });
        },
        sequence: 220,
    };
}

debugRegistry
    .category("action")
    .add("actionSeparator", actionSeparator)
    .add("editAction", editAction)
    .add("viewFields", viewFields)
    .add("manageFilters", manageFilters)
    .add("technicalTranslation", technicalTranslation)
    .add("accessSeparator", accessSeparator)
    .add("viewAccessRights", viewAccessRights)
    .add("viewRecordRules", viewRecordRules);
