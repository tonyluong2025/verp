/** @verp-module alias=web.clickEverywhere **/

import { registry } from "../../core/registry";

const { loadJS } = owl.utils;

export default async function startClickEverywhere(xmlid, appsMenusOnly) {
    await loadJS("web/static/src/webclient/clickbot/clickbot.js");
    window.clickEverywhere(xmlid, appsMenusOnly);
}

function runClickTestItem({ env }) {
    return {
        type: "item",
        description: env._t("Run Click Everywhere Test"),
        callback: () => {
            startClickEverywhere();
        },
        sequence: 30,
    };
}

registry.category("debug").category("default").add("runClickTestItem", runClickTestItem);
