/** @verp-module **/

import { createWebClient, getActionManagerServerData } from "@web/../tests/webclient/helpers";
import { browser } from "@web/core/browser/browser";
import { registry } from "@web/core/registry";
import { click, nextTick, patchWithCleanup, triggerHotkey } from "../../helpers/utils";
import { editSearchBar } from "./command_service_tests";

let serverData;
QUnit.module("Menu Command Provider", {
    async beforeEach() {
        patchWithCleanup(browser, {
            clearTimeout: () => {},
            setTimeout: (later, wait) => {
                later();
            },
        });
        const commandCategoryRegistry = registry.category("commandCategories");
        commandCategoryRegistry.add("apps", { namespace: "/" }, { sequence: 10 });
        commandCategoryRegistry.add("menu_items", { namespace: "/" }, { sequence: 20 });
        serverData = getActionManagerServerData();
        serverData.menus = {
            root: { id: "root", children: [0, 1, 2], name: "root", appID: "root" },
            0: { id: 0, children: [], name: "UglyHack", appID: 0, xmlid: "menu_0" },
            1: { id: 1, children: [], name: "Contact", appID: 1, actionId: 1001, xmlid: "menu_1" },
            2: {
                id: 2,
                children: [3, 4],
                name: "Sales",
                appID: 2,
                actionId: 1002,
                xmlid: "menu_2",
            },
            3: {
                id: 3,
                children: [],
                name: "Info",
                appID: 2,
                actionId: 1003,
                xmlid: "menu_3",
            },
            4: {
                id: 4,
                children: [],
                name: "Report",
                appID: 2,
                actionId: 1004,
                xmlid: "menu_4",
            },
        };
        serverData.actions[1003] = {
            id: 1003,
            tag: "__test__client__action__",
            target: "main",
            type: "ir.actions.client",
            params: { description: "Info" },
        };
        serverData.actions[1004] = {
            id: 1004,
            tag: "__test__client__action__",
            target: "main",
            type: "ir.actions.client",
            params: { description: "Report" },
        };
    },
    afterEach() {},
});

QUnit.test("displays only apps if the search value is '/'", async (assert) => {
    const webClient = await createWebClient({ serverData });
    assert.containsNone(webClient, ".o-menu-brand");

    triggerHotkey("control+k");
    await nextTick();
    await editSearchBar("/");
    assert.containsOnce(webClient, ".o-command-palette");
    assert.containsOnce(webClient, ".o-command-category");
    assert.containsN(webClient, ".o-command", 2);
    assert.deepEqual(
        [...webClient.el.querySelectorAll(".o-command")].map((el) => el.textContent),
        ["Contact", "Sales"]
    );
});

QUnit.test("displays apps and menu items if the search value is not only '/'", async (assert) => {
    const webClient = await createWebClient({ serverData });

    triggerHotkey("control+k");
    await nextTick();
    await editSearchBar("/sal");
    assert.containsOnce(webClient, ".o-command-palette");
    assert.containsN(webClient, ".o-command", 3);
    assert.deepEqual(
        [...webClient.el.querySelectorAll(".o-command")].map((el) => el.textContent),
        ["Sales", "Sales / Info", "Sales / Report"]
    );
});

QUnit.test("opens an app", async (assert) => {
    const webClient = await createWebClient({ serverData });
    assert.containsNone(webClient, ".o-menu-brand");

    triggerHotkey("control+k");
    await nextTick();
    await editSearchBar("/");
    assert.containsOnce(webClient, ".o-command-palette");

    triggerHotkey("enter");
    await nextTick();
    await nextTick();
    assert.strictEqual(webClient.el.querySelector(".o-menu-brand").textContent, "Contact");
    assert.strictEqual(
        webClient.el.querySelector(".test_client_action").textContent,
        " ClientAction_Id 1"
    );
});

QUnit.test("opens a menu items", async (assert) => {
    const webClient = await createWebClient({ serverData });
    assert.containsNone(webClient, ".o-menu-brand");

    triggerHotkey("control+k");
    await nextTick();
    await editSearchBar("/sal");
    assert.containsOnce(webClient, ".o-command-palette");
    assert.containsN(webClient, ".o-command-category", 2);

    click(webClient.el, "#o-command-2");
    await nextTick();
    await nextTick();
    assert.strictEqual(webClient.el.querySelector(".o-menu-brand").textContent, "Sales");
    assert.strictEqual(
        webClient.el.querySelector(".test_client_action").textContent,
        " ClientAction_Report"
    );
});
