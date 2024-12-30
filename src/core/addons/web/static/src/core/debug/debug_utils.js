/** @verp-module **/

export function editModelDebug(env, title, model, id) {
    return env.services.action.doAction({
        resModel: model,
        resId: id,
        label: title,
        type: "ir.actions.actwindow",
        views: [[false, "form"]],
        viewMode: "form",
        target: "new",
        flags: { actionButtons: true, headless: true },
    });
}
