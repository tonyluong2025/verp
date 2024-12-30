/** @verp-module **/

import { registry } from "@web/core/registry";

export function manageMessages({ action, component, env }) {
    const selectedIds = component.widget.getSelectedIds();
    if (!selectedIds.length) {
        return null; // No record
    }
    const description = env._t("Manage Messages");
    return {
        type: "item",
        description,
        callback: () => {
            env.services.action.doAction({
                resModel: "mail.message",
                name: description,
                views: [
                    [false, "list"],
                    [false, "form"],
                ],
                type: "ir.actions.actwindow",
                domain: [
                    ["resId", "=", selectedIds[0]],
                    ["model", "=", action.resModel],
                ],
                context: {
                    default_resModel: action.resModel,
                    default_resId: selectedIds[0],
                },
            });
        },
        sequence: 325,
    };
}

registry.category("debug").category("form").add("mail.manageMessages", manageMessages);
