/** @verp-module **/

import { browser } from "@web/core/browser/browser";
import { registry } from "@web/core/registry";
import { WebClient } from "@web/webclient/webclient";
import testUtils from "web.testUtils";
import core from "web.core";
import AbstractAction from "web.AbstractAction";
import { registerCleanup } from "../../helpers/cleanup";
import { makeTestEnv } from "../../helpers/mock_env";
import {
    click,
    getFixture,
    legacyExtraNextTick,
    patchWithCleanup,
    nextTick,
} from "../../helpers/utils";
import { toggleFilterMenu, toggleMenuItem } from "@web/../tests/search/helpers";
import { session } from "@web/session";
import {
    createWebClient,
    doAction,
    getActionManagerServerData,
    loadState,
    setupWebClientRegistries,
} from "./../helpers";
import { errorService } from "@web/core/errors/error_service";

const { Component, mount, tags } = owl;

let serverData;

const actionRegistry = registry.category("actions");

QUnit.module("ActionManager", (hooks) => {
    hooks.beforeEach(() => {
        serverData = getActionManagerServerData();
    });

    QUnit.module("Load State");

    QUnit.test("action loading", async (assert) => {
        assert.expect(2);
        const webClient = await createWebClient({ serverData });
        await loadState(webClient, { action: 1001 });
        assert.containsOnce(webClient, ".test_client_action");
        assert.strictEqual(webClient.el.querySelector(".o-menu-brand").textContent, "App1");
    });

    QUnit.test("menu loading", async (assert) => {
        assert.expect(2);
        const webClient = await createWebClient({ serverData });
        await loadState(webClient, { menuId: 2 });
        assert.strictEqual(
            webClient.el.querySelector(".test_client_action").textContent.trim(),
            "ClientAction_Id 2"
        );
        assert.strictEqual(webClient.el.querySelector(".o-menu-brand").textContent, "App2");
    });

    QUnit.test("action and menu loading", async (assert) => {
        assert.expect(3);
        const webClient = await createWebClient({ serverData });
        await loadState(webClient, {
            action: 1001,
            menuId: 2,
        });
        assert.strictEqual(
            webClient.el.querySelector(".test_client_action").textContent.trim(),
            "ClientAction_Id 1"
        );
        assert.strictEqual(webClient.el.querySelector(".o-menu-brand").textContent, "App2");
        assert.deepEqual(webClient.env.services.router.current.hash, {
            action: 1001,
            menuId: 2,
        });
    });

    QUnit.test("initial loading with action id", async (assert) => {
        assert.expect(4);
        const hash = "#action=1001";
        Object.assign(browser.location, { hash });
        setupWebClientRegistries();

        const mockRPC = (route) => assert.step(route);
        const env = await makeTestEnv({ serverData, mockRPC });

        assert.verifySteps(["/web/action/load", "/web/webclient/loadMenus"]);

        const wc = await mount(WebClient, { env, target: getFixture() });
        registerCleanup(() => wc.destroy());

        assert.verifySteps([]);
    });

    QUnit.test("initial loading with action tag", async (assert) => {
        assert.expect(3);
        const hash = "#action=__test__client__action__";
        Object.assign(browser.location, { hash });
        setupWebClientRegistries();

        const mockRPC = (route) => assert.step(route);
        const env = await makeTestEnv({ serverData, mockRPC });

        assert.verifySteps(["/web/webclient/loadMenus"]);

        const wc = await mount(WebClient, { env, target: getFixture() });
        registerCleanup(() => wc.destroy());

        assert.verifySteps([]);
    });

    QUnit.test("fallback on home action if no action found", async (assert) => {
        assert.expect(2);
        patchWithCleanup(session, { homeActionId: 1001 });

        const wc = await createWebClient({ serverData });
        await testUtils.nextTick(); // wait for the navbar to be updated

        assert.containsOnce(wc, ".test_client_action");
        assert.strictEqual(wc.el.querySelector(".o-menu-brand").innerText, "App1");
    });

    QUnit.test("correctly sends additional context", async (assert) => {
        assert.expect(1);
        const hash = "#action=1001&activeId=4&activeIds=4,8";
        Object.assign(browser.location, { hash });
        function mockRPC(route, params) {
            if (route === "/web/action/load") {
                assert.deepEqual(params, {
                    actionId: 1001,
                    additionalContext: {
                        activeId: 4,
                        activeIds: [4, 8],
                        activeModel: undefined,
                    },
                });
            }
        }
        await createWebClient({ serverData, mockRPC });
    });

    QUnit.test("supports action as xmlid", async (assert) => {
        assert.expect(2);
        const webClient = await createWebClient({ serverData });
        await loadState(webClient, {
            action: "wowl.client_action",
        });
        assert.strictEqual(
            webClient.el.querySelector(".test_client_action").textContent.trim(),
            "ClientAction_xmlid"
        );
        assert.containsNone(webClient, ".o-menu-brand");
    });

    QUnit.test("supports opening action in dialog", async (assert) => {
        assert.expect(3);
        serverData.actions["wowl.client_action"].target = "new";
        const webClient = await createWebClient({ serverData });
        await loadState(webClient, {
            action: "wowl.client_action",
        });
        assert.containsOnce(webClient, ".test_client_action");
        assert.containsOnce(webClient, ".modal .test_client_action");
        assert.containsNone(webClient, ".o-menu-brand");
    });

    QUnit.test("should not crash on invalid state", async function (assert) {
        assert.expect(3);
        const mockRPC = async function (route, args) {
            assert.step((args && args.method) || route);
        };
        const webClient = await createWebClient({ serverData, mockRPC });
        await loadState(webClient, {
            resModel: "partner",
        });
        assert.strictEqual($(webClient.el).text(), "", "should display nothing");
        assert.verifySteps(["/web/webclient/loadMenus"]);
    });

    QUnit.test("properly load client actions", async function (assert) {
        assert.expect(3);
        class ClientAction extends Component {}
        ClientAction.template = tags.xml`<div class="o_client_action_test">Hello World</div>`;
        actionRegistry.add("HelloWorldTest", ClientAction);
        const mockRPC = async function (route, args) {
            assert.step((args && args.method) || route);
        };
        const webClient = await createWebClient({ serverData, mockRPC });
        webClient.env.bus.trigger("test:hashchange", {
            action: "HelloWorldTest",
        });
        await testUtils.nextTick();
        assert.strictEqual(
            $(webClient.el).find(".o_client_action_test").text(),
            "Hello World",
            "should have correctly rendered the client action"
        );
        assert.verifySteps(["/web/webclient/loadMenus"]);
    });

    QUnit.test("properly load act window actions", async function (assert) {
        assert.expect(7);
        const mockRPC = async function (route, args) {
            assert.step((args && args.method) || route);
        };
        const webClient = await createWebClient({ serverData, mockRPC });
        webClient.env.bus.trigger("test:hashchange", {
            action: 1,
        });
        await testUtils.nextTick();
        await legacyExtraNextTick();
        assert.containsOnce(webClient, ".o-control-panel");
        assert.containsOnce(webClient, ".o-kanban-view");
        assert.verifySteps([
            "/web/webclient/loadMenus",
            "/web/action/load",
            "load_views",
            "/web/dataset/searchRead",
        ]);
    });

    QUnit.test("properly load records", async function (assert) {
        assert.expect(6);
        const mockRPC = async function (route, args) {
            assert.step((args && args.method) || route);
        };
        const webClient = await createWebClient({ serverData, mockRPC });
        webClient.env.bus.trigger("test:hashchange", {
            id: 2,
            model: "partner",
        });
        await testUtils.nextTick();
        await legacyExtraNextTick();
        assert.containsOnce(webClient, ".o-form-view");
        assert.strictEqual(
            $(webClient.el).find(".o-control-panel .breadcrumb-item").text(),
            "Second record",
            "should have opened the second record"
        );
        assert.verifySteps(["/web/webclient/loadMenus", "load_views", "read"]);
    });

    QUnit.test("properly load records with existing first APP", async function (assert) {
        assert.expect(7);
        const mockRPC = async function (route, args) {
            assert.step((args && args.method) || route);
        };
        // simulate a real scenario with a first app (e.g. Discuss), to ensure that we don't
        // fallback on that first app when only a model and resId are given in the url
        serverData.menus = {
            root: { id: "root", children: [1, 2], name: "root", appID: "root" },
            1: { id: 1, children: [], name: "App1", appID: 1, actionId: 1001, xmlid: "menu_1" },
            2: { id: 2, children: [], name: "App2", appID: 2, actionId: 1002, xmlid: "menu_2" },
        };
        const hash = "#id=2&model=partner";
        Object.assign(browser.location, { hash });
        const webClient = await createWebClient({ serverData, mockRPC });

        await testUtils.nextTick();
        assert.containsOnce(webClient, ".o-form-view");
        assert.strictEqual(
            $(webClient.el).find(".o-control-panel .breadcrumb-item").text(),
            "Second record",
            "should have opened the second record"
        );
        assert.containsNone(webClient.el, ".o-menu-brand");
        assert.verifySteps(["/web/webclient/loadMenus", "load_views", "read"]);
    });

    QUnit.test("properly load default record", async function (assert) {
        assert.expect(6);
        const mockRPC = async function (route, args) {
            assert.step((args && args.method) || route);
        };
        const webClient = await createWebClient({ serverData, mockRPC });
        webClient.env.bus.trigger("test:hashchange", {
            action: 3,
            id: "",
            model: "partner",
            viewType: "form",
        });
        await testUtils.nextTick();
        await legacyExtraNextTick();
        assert.containsOnce(webClient, ".o-form-view");
        assert.verifySteps([
            "/web/webclient/loadMenus",
            "/web/action/load",
            "load_views",
            "onchange",
        ]);
    });

    QUnit.test("load requested view for act window actions", async function (assert) {
        assert.expect(7);
        const mockRPC = async function (route, args) {
            assert.step((args && args.method) || route);
        };
        const webClient = await createWebClient({ serverData, mockRPC });
        webClient.env.bus.trigger("test:hashchange", {
            action: 3,
            viewType: "kanban",
        });
        await testUtils.nextTick();
        await legacyExtraNextTick();
        assert.containsNone(webClient, ".o-list-view");
        assert.containsOnce(webClient, ".o-kanban-view");
        assert.verifySteps([
            "/web/webclient/loadMenus",
            "/web/action/load",
            "load_views",
            "/web/dataset/searchRead",
        ]);
    });

    QUnit.test(
        "lazy load multi record view if mono record one is requested",
        async function (assert) {
            assert.expect(12);
            const mockRPC = async function (route, args) {
                assert.step((args && args.method) || route);
            };
            const webClient = await createWebClient({ serverData, mockRPC });
            webClient.env.bus.trigger("test:hashchange", {
                action: 3,
                id: 2,
                viewType: "form",
            });
            await testUtils.nextTick();
            await legacyExtraNextTick();
            assert.containsNone(webClient, ".o-list-view");
            assert.containsOnce(webClient, ".o-form-view");
            assert.containsN(webClient, ".o-control-panel .breadcrumb-item", 2);
            assert.strictEqual(
                $(webClient.el).find(".o-control-panel .breadcrumb-item:last").text(),
                "Second record",
                "breadcrumbs should contain the displayName of the opened record"
            );
            // go back to List
            await testUtils.dom.click($(webClient.el).find(".o-control-panel .breadcrumb a"));
            await legacyExtraNextTick();
            assert.containsOnce(webClient, ".o-list-view");
            assert.containsNone(webClient, ".o-form-view");
            assert.verifySteps([
                "/web/webclient/loadMenus",
                "/web/action/load",
                "load_views",
                "read",
                "/web/dataset/searchRead",
            ]);
        }
    );

    QUnit.test("lazy load multi record view with previous action", async function (assert) {
        assert.expect(6);
        const webClient = await createWebClient({ serverData });
        await doAction(webClient, 4);
        assert.containsOnce(
            webClient.el,
            ".o-control-panel .breadcrumb li",
            "there should be one controller in the breadcrumbs"
        );
        assert.strictEqual(
            $(webClient.el).find(".o-control-panel .breadcrumb li").text(),
            "Partners Action 4",
            "breadcrumbs should contain the displayName of the opened record"
        );
        await doAction(webClient, 3, {
            props: { resId: 2 },
            viewType: "form",
        });
        assert.containsN(
            webClient.el,
            ".o-control-panel .breadcrumb li",
            3,
            "there should be three controllers in the breadcrumbs"
        );
        assert.strictEqual(
            $(webClient.el).find(".o-control-panel .breadcrumb li").text(),
            "Partners Action 4PartnersSecond record",
            "the breadcrumb elements should be correctly ordered"
        );
        // go back to List
        await testUtils.dom.click($(webClient.el).find(".o-control-panel .breadcrumb a:last"));
        await legacyExtraNextTick();
        assert.containsN(
            webClient.el,
            ".o-control-panel .breadcrumb li",
            2,
            "there should be two controllers in the breadcrumbs"
        );
        assert.strictEqual(
            $(webClient.el).find(".o-control-panel .breadcrumb li").text(),
            "Partners Action 4Partners",
            "the breadcrumb elements should be correctly ordered"
        );
    });

    QUnit.test(
        "lazy loaded multi record view with failing mono record one",
        async function (assert) {
            assert.expect(3);
            const mockRPC = async function (route, args) {
                if (args && args.method === "read") {
                    return Promise.reject();
                }
            };
            const webClient = await createWebClient({ serverData, mockRPC });
            await loadState(webClient, {
                action: 3,
                id: 2,
                viewType: "form",
            });
            assert.containsNone(webClient, ".o-form-view");
            assert.containsNone(webClient, ".o-list-view");
            await doAction(webClient, 1);
            assert.containsOnce(webClient, ".o-kanban-view");
        }
    );

    QUnit.test("change the viewType of the current action", async function (assert) {
        assert.expect(14);
        const mockRPC = async function (route, args) {
            assert.step((args && args.method) || route);
        };
        const webClient = await createWebClient({ serverData, mockRPC });
        await doAction(webClient, 3);
        assert.containsOnce(webClient, ".o-list-view");
        // switch to kanban view
        webClient.env.bus.trigger("test:hashchange", {
            action: 3,
            viewType: "kanban",
        });
        await testUtils.nextTick();
        await legacyExtraNextTick();
        assert.containsNone(webClient, ".o-list-view");
        assert.containsOnce(webClient, ".o-kanban-view");
        // switch to form view, open record 4
        webClient.env.bus.trigger("test:hashchange", {
            action: 3,
            id: 4,
            viewType: "form",
        });
        await testUtils.nextTick();
        await legacyExtraNextTick();
        assert.containsNone(webClient, ".o-kanban-view");
        assert.containsOnce(webClient, ".o-form-view");
        assert.containsN(
            webClient.el,
            ".o-control-panel .breadcrumb-item",
            2,
            "there should be two controllers in the breadcrumbs"
        );
        assert.strictEqual(
            $(webClient.el).find(".o-control-panel .breadcrumb-item:last").text(),
            "Fourth record",
            "should have opened the requested record"
        );
        // verify steps to ensure that the whole action hasn't been re-executed
        // (if it would have been, /web/action/load and load_views would appear
        // several times)
        assert.verifySteps([
            "/web/webclient/loadMenus",
            "/web/action/load",
            "load_views",
            "/web/dataset/searchRead",
            "/web/dataset/searchRead",
            "read",
        ]);
    });

    QUnit.test("change the id of the current action", async function (assert) {
        assert.expect(12);
        const mockRPC = async function (route, args) {
            assert.step((args && args.method) || route);
        };
        const webClient = await createWebClient({ serverData, mockRPC });
        // execute action 3 and open the first record in a form view
        await doAction(webClient, 3);
        await testUtils.dom.click($(webClient.el).find(".o-list-view .o-data-row:first"));
        await legacyExtraNextTick();
        assert.containsOnce(webClient, ".o-form-view");
        assert.strictEqual(
            $(webClient.el).find(".o-control-panel .breadcrumb-item:last").text(),
            "First record",
            "should have opened the first record"
        );
        // switch to record 4
        webClient.env.bus.trigger("test:hashchange", {
            action: 3,
            id: 4,
            viewType: "form",
        });
        await testUtils.nextTick();
        await legacyExtraNextTick();
        assert.containsOnce(webClient, ".o-form-view");
        assert.containsN(
            webClient.el,
            ".o-control-panel .breadcrumb-item",
            2,
            "there should be two controllers in the breadcrumbs"
        );
        assert.strictEqual(
            $(webClient.el).find(".o-control-panel .breadcrumb-item:last").text(),
            "Fourth record",
            "should have switched to the requested record"
        );
        // verify steps to ensure that the whole action hasn't been re-executed
        // (if it would have been, /web/action/load and load_views would appear
        // twice)
        assert.verifySteps([
            "/web/webclient/loadMenus",
            "/web/action/load",
            "load_views",
            "/web/dataset/searchRead",
            "read",
            "read",
        ]);
    });

    QUnit.test("should push the correct state at the right time", async function (assert) {
        // formerly "should not push a loaded state"
        assert.expect(7);
        const pushState = browser.history.pushState;
        patchWithCleanup(browser, {
            history: Object.assign({}, browser.history, {
                pushState() {
                    pushState(...arguments);
                    assert.step("pushState");
                },
            }),
        });
        const webClient = await createWebClient({ serverData });
        let currentHash = webClient.env.services.router.current.hash;
        assert.deepEqual(currentHash, {});
        await loadState(webClient, { action: 3 });
        currentHash = webClient.env.services.router.current.hash;
        assert.deepEqual(currentHash, {
            action: 3,
            model: "partner",
            viewType: "list",
        });
        assert.verifySteps(["pushState"], "should have pushed the final state");
        await testUtils.dom.click($(webClient.el).find("tr.o-data-row:first"));
        await legacyExtraNextTick();
        currentHash = webClient.env.services.router.current.hash;
        assert.deepEqual(currentHash, {
            action: 3,
            id: 1,
            model: "partner",
            viewType: "form",
        });
        assert.verifySteps(["pushState"], "should push the state of it changes afterwards");
    });

    QUnit.test("should not push a loaded state of a legacy client action", async function (assert) {
        assert.expect(6);
        const ClientAction = AbstractAction.extend({
            init: function (parent, action, options) {
                this._super.apply(this, arguments);
                this.controllerID = options.controllerID;
            },
            start: function () {
                const $button = $("<button id='client_action_button'>").text("Click Me!");
                $button.on("click", () => {
                    this.triggerUp("pushState", {
                        controllerID: this.controllerID,
                        state: { someValue: "X" },
                    });
                });
                this.$el.append($button);
                return this._super.apply(this, arguments);
            },
        });
        const pushState = browser.history.pushState;
        patchWithCleanup(browser, {
            history: Object.assign({}, browser.history, {
                pushState() {
                    pushState(...arguments);
                    assert.step("pushState");
                },
            }),
        });
        core.actionRegistry.add("ClientAction", ClientAction);
        const webClient = await createWebClient({ serverData });
        let currentHash = webClient.env.services.router.current.hash;
        assert.deepEqual(currentHash, {});
        await loadState(webClient, { action: 9 });
        currentHash = webClient.env.services.router.current.hash;
        assert.deepEqual(currentHash, {
            action: 9,
        });
        assert.verifySteps([], "should not push the loaded state");
        await testUtils.dom.click($(webClient.el).find("#client_action_button"));
        await legacyExtraNextTick();
        assert.verifySteps(["pushState"], "should push the state of it changes afterwards");
        currentHash = webClient.env.services.router.current.hash;
        assert.deepEqual(currentHash, {
            action: 9,
            someValue: "X",
        });
        delete core.actionRegistry.map.ClientAction;
    });

    QUnit.test("change a param of an ir.actions.client in the url", async function (assert) {
        assert.expect(12);
        const ClientAction = AbstractAction.extend({
            hasControlPanel: true,
            init: function (parent, action) {
                this._super.apply(this, arguments);
                const context = action.context;
                this.a = (context.params && context.params.a) || "default value";
            },
            start: function () {
                assert.step("start");
                this.$(".o-content").text(this.a);
                this.$el.addClass("o_client_action");
                this.triggerUp("pushState", {
                    controllerID: this.controllerID,
                    state: { a: this.a },
                });
                return this._super.apply(this, arguments);
            },
        });
        const pushState = browser.history.pushState;
        patchWithCleanup(browser, {
            history: Object.assign({}, browser.history, {
                pushState() {
                    pushState(...arguments);
                    assert.step("pushState");
                },
            }),
        });
        core.actionRegistry.add("ClientAction", ClientAction);
        const webClient = await createWebClient({ serverData });
        let currentHash = webClient.env.services.router.current.hash;
        assert.deepEqual(currentHash, {});
        // execute the client action
        await doAction(webClient, 9);
        assert.verifySteps(["start", "pushState"]);
        currentHash = webClient.env.services.router.current.hash;
        assert.deepEqual(currentHash, {
            action: 9,
            a: "default value",
        });
        assert.strictEqual(
            $(webClient.el).find(".o_client_action .o-content").text(),
            "default value",
            "should have rendered the client action"
        );
        assert.containsN(
            webClient.el,
            ".o-control-panel .breadcrumb-item",
            1,
            "there should be one controller in the breadcrumbs"
        );
        // update param 'a' in the url
        await loadState(webClient, {
            action: 9,
            a: "new value",
        });
        assert.verifySteps(["start"]); // No push state since the hash hasn't changed
        currentHash = webClient.env.services.router.current.hash;
        assert.deepEqual(currentHash, {
            action: 9,
            a: "new value",
        });
        assert.strictEqual(
            $(webClient.el).find(".o_client_action .o-content").text(),
            "new value",
            "should have rerendered the client action with the correct param"
        );
        assert.containsN(
            webClient.el,
            ".o-control-panel .breadcrumb-item",
            1,
            "there should still be one controller in the breadcrumbs"
        );
        delete core.actionRegistry.map.ClientAction;
    });

    QUnit.test("load a window action without id (in a multi-record view)", async function (assert) {
        assert.expect(14);
        patchWithCleanup(browser.sessionStorage, {
            getItem(k) {
                assert.step(`getItem session ${k}`);
                return this._super(k);
            },
            setItem(k, v) {
                assert.step(`setItem session ${k}`);
                return this._super(k, v);
            },
        });
        const mockRPC = async (route, args) => {
            assert.step((args && args.method) || route);
        };
        const webClient = await createWebClient({ serverData, mockRPC });
        await doAction(webClient, 4);
        assert.containsOnce(webClient, ".o-kanban-view", "should display a kanban view");
        assert.strictEqual(
            $(webClient.el).find(".o-control-panel .breadcrumb-item").text(),
            "Partners Action 4",
            "breadcrumbs should display the displayName of the action"
        );
        await loadState(webClient, {
            model: "partner",
            viewType: "list",
        });
        assert.strictEqual(
            $(webClient.el).find(".o-control-panel .breadcrumb-item").text(),
            "Partners Action 4",
            "should still be in the same action"
        );
        assert.containsNone(webClient, ".o-kanban-view", "should no longer display a kanban view");
        assert.containsOnce(webClient, ".o-list-view", "should display a list view");
        assert.verifySteps([
            "/web/webclient/loadMenus",
            "/web/action/load",
            "load_views",
            "/web/dataset/searchRead",
            "setItem session current_action",
            "getItem session current_action",
            "/web/dataset/searchRead",
            "setItem session current_action",
        ]);
    });

    QUnit.test("load state supports being given menuId alone", async function (assert) {
        assert.expect(7);
        serverData.menus[666] = {
            id: 666,
            children: [],
            name: "App1",
            appID: 1,
            actionId: 1,
        };
        const mockRPC = async function (route) {
            assert.step(route);
        };
        const webClient = await createWebClient({ serverData, mockRPC });
        await loadState(webClient, { menuId: 666 });
        assert.containsOnce(webClient, ".o-kanban-view", "should display a kanban view");
        assert.strictEqual(
            $(webClient.el).find(".o-control-panel .breadcrumb-item").text(),
            "Partners Action 1",
            "breadcrumbs should display the displayName of the action"
        );
        assert.verifySteps([
            "/web/webclient/loadMenus",
            "/web/action/load",
            "/web/dataset/callKw/partner/load_views",
            "/web/dataset/searchRead",
        ]);
    });

    QUnit.test("load state supports #home", async function (assert) {
        assert.expect(6);
        serverData.menus = {
            root: { id: "root", children: [1], name: "root", appID: "root" },
            1: { id: 1, children: [], name: "App1", appID: 1, actionId: 1 },
        };
        const webClient = await createWebClient({ serverData });
        await legacyExtraNextTick();
        assert.containsOnce(webClient, ".o-kanban-view"); // action 1 (default app)
        assert.strictEqual(
            $(webClient.el).find(".o-control-panel .breadcrumb-item").text(),
            "Partners Action 1"
        );
        await loadState(webClient, { action: 3 });
        assert.containsOnce(webClient, ".o-list-view"); // action 3
        assert.strictEqual(
            $(webClient.el).find(".o-control-panel .breadcrumb-item").text(),
            "Partners"
        );
        await loadState(webClient, { home: 1 });
        assert.containsOnce(webClient, ".o-kanban-view"); // action 1 (default app)
        assert.strictEqual(
            $(webClient.el).find(".o-control-panel .breadcrumb-item").text(),
            "Partners Action 1"
        );
    });

    QUnit.test("load state supports #home as initial state", async function (assert) {
        assert.expect(7);
        serverData.menus = {
            root: { id: "root", children: [1], name: "root", appID: "root" },
            1: { id: 1, children: [], name: "App1", appID: 1, actionId: 1 },
        };
        const hash = "#home=1";
        Object.assign(browser.location, { hash });
        const mockRPC = async function (route) {
            assert.step(route);
        };
        const webClient = await createWebClient({ serverData, mockRPC });
        await legacyExtraNextTick();
        assert.containsOnce(webClient, ".o-kanban-view", "should display a kanban view");
        assert.strictEqual(
            $(webClient.el).find(".o-control-panel .breadcrumb-item").text(),
            "Partners Action 1"
        );
        assert.verifySteps([
            "/web/webclient/loadMenus",
            "/web/action/load",
            "/web/dataset/callKw/partner/load_views",
            "/web/dataset/searchRead",
        ]);
    });

    QUnit.test("load state: in a form view, remove the id from the state", async function (assert) {
        assert.expect(13);
        serverData.actions[999] = {
            id: 999,
            name: "Partner",
            resModel: "partner",
            type: "ir.actions.actwindow",
            views: [
                [false, "list"],
                [666, "form"],
            ],
        };
        const mockRPC = async (route) => {
            assert.step(route);
        };
        const webClient = await createWebClient({ serverData, mockRPC });
        await doAction(webClient, 999, { viewType: "form", props: { resId: 2 } });
        assert.containsOnce(webClient, ".o-form-view");
        assert.containsN(webClient, ".breadcrumb-item", 2);
        assert.strictEqual(
            $(webClient.el).find(".o-control-panel .breadcrumb-item.active").text(),
            "Second record"
        );
        assert.verifySteps([
            "/web/webclient/loadMenus",
            "/web/action/load",
            "/web/dataset/callKw/partner/load_views",
            "/web/dataset/callKw/partner/read",
        ]);
        await loadState(webClient, {
            action: 999,
            viewType: "form",
            id: "",
        });
        assert.verifySteps(["/web/dataset/callKw/partner/onchange"]);
        assert.containsOnce(webClient, ".o-form-view.o-form-editable");
        assert.containsN(webClient, ".breadcrumb-item", 2);
        assert.strictEqual(
            $(webClient.el).find(".o-control-panel .breadcrumb-item.active").text(),
            "New"
        );
    });

    QUnit.test("hashchange does not trigger canberemoved right away", async function (assert) {
        assert.expect(9);
        const ClientAction = AbstractAction.extend({
            start() {
                this.$el.text("Hello World");
                this.$el.addClass("o_client_action_test");
            },
            canBeRemoved() {
                assert.step("canBeRemoved");
                return this._super.apply(this, arguments);
            },
        });
        const ClientAction2 = AbstractAction.extend({
            start() {
                this.$el.text("Hello World");
                this.$el.addClass("o_client_action_test_2");
            },
            canBeRemoved() {
                assert.step("canBeRemoved_2");
                return this._super.apply(this, arguments);
            },
        });
        const pushState = browser.history.pushState;
        patchWithCleanup(browser, {
            history: Object.assign({}, browser.history, {
                pushState() {
                    pushState(...arguments);
                    assert.step("hashSet");
                },
            }),
        });
        core.actionRegistry.add("ClientAction", ClientAction);
        core.actionRegistry.add("ClientAction2", ClientAction2);
        const webClient = await createWebClient({ serverData });
        assert.verifySteps([]);
        await doAction(webClient, 9);
        assert.verifySteps(["hashSet"]);
        assert.containsOnce(webClient.el, ".o_client_action_test");
        assert.verifySteps([]);
        await doAction(webClient, "ClientAction2");
        assert.containsOnce(webClient.el, ".o_client_action_test_2");
        assert.verifySteps(["canBeRemoved", "hashSet"]);
        delete core.actionRegistry.map.ClientAction;
        delete core.actionRegistry.map.ClientAction2;
    });

    QUnit.test("state with integer activeIds should not crash", async function (assert) {
        assert.expect(2);

        const mockRPC = async (route, args) => {
            if (route === "/web/action/run") {
                assert.strictEqual(args.actionId, 2);
                assert.deepEqual(args.context.activeIds, [3]);
                return new Promise(() => {});
            }
        };
        const webClient = await createWebClient({ serverData, mockRPC });
        await loadState(webClient, {
            action: 2,
            activeIds: 3,
        });
    });

    QUnit.test(
        "url form view type switch from list or kanban doesn't timeout",
        async function (assert) {
            assert.expect(3);
            const webClient = await createWebClient({ serverData });
            await doAction(webClient, 3);
            assert.containsOnce(webClient, ".o-list-view", "should now display the list view");

            await testUtils.controlPanel.switchView(webClient, "kanban");
            await legacyExtraNextTick();
            assert.containsOnce(webClient, ".o-kanban-view", "should now display the kanban view");

            const hash = webClient.env.services.router.current.hash;
            hash.viewType = "form";
            await loadState(webClient.env, hash);
            assert.containsOnce(
                webClient,
                ".o-form-view.o-form-editable",
                "should now display the form view in edit mode"
            );
        }
    );

    QUnit.test(
        "charge a form view via url, then switch to view list, the search view is correctly initialized",
        async function (assert) {
            assert.expect(2);

            serverData.views = {
                ...serverData.views,
                "partner,false,search":`
                    <search>
                        <filter name="filter" string="Filter" domain="[('foo', '=', 'yop')]"/>
                    </search>
                `,
            }

            const webClient = await createWebClient({ serverData });

            await loadState(webClient.env, {
                action: 3,
                model: "partner",
                viewType: "form",
            });

            await click(webClient.el.querySelector(".o-control-panel .breadcrumb-item"));
            await legacyExtraNextTick();

            assert.containsN(webClient, ".o-list-view .o-data-row", 5);

            await toggleFilterMenu(webClient);
            await toggleMenuItem(webClient, "Filter");

            assert.containsN(webClient, ".o-list-view .o-data-row", 1);
        }
    );

    QUnit.test("initial action crashes", async (assert) => {
        assert.expect(8);

        const handler = (ev) => {
            // need to preventDefault to remove error from console (so javascript test pass)
            ev.preventDefault();
        };
        window.addEventListener("unhandledrejection", handler);
        registerCleanup(() => window.removeEventListener("unhandledrejection", handler));

        patchWithCleanup(QUnit, {
            onUnhandledRejection: () => {},
        });

        browser.location.hash = "#action=__test__client__action__&menuId=1";
        const ClientAction = registry.category("actions").get("__test__client__action__");
        class Override extends ClientAction {
            setup() {
                super.setup();
                assert.step("clientAction setup");
                throw new Error("my error");
            }
        }
        registry.category("actions").add("__test__client__action__", Override, { force: true });

        registry.category("services").add("error", errorService);

        const webClient = await createWebClient({ serverData });
        assert.verifySteps(["clientAction setup"]);
        await nextTick();
        assert.containsOnce(webClient, ".o-dialog-error");
        await click(webClient.el, ".modal-header .close");
        assert.containsNone(webClient, ".o-dialog-error");
        await click(webClient.el, "nav .o-navbar-apps-menu .dropdown-toggle ");
        assert.containsN(webClient, ".dropdown-item.o-app", 3);
        assert.containsNone(webClient, ".o-menu-brand");
        assert.strictEqual(webClient.el.querySelector(".o-action-manager").innerHTML, "");
        assert.deepEqual(webClient.env.services.router.current.hash, {
            action: "__test__client__action__",
            menuId: 1,
        });
    });

    QUnit.test("concurrent hashchange during action mounting -- 1", async (assert) => {
        assert.expect(5);

        class MyAction extends Component {
            mounted() {
                assert.step("myAction mounted");
                browser.location.hash = "#action=__test__client__action__&menuId=1";
            }
        }
        MyAction.template = tags.xml`<div class="not-here" />`;
        registry.category("actions").add("myAction", MyAction);

        browser.location.hash = "#action=myAction";

        const webClient = await createWebClient({ serverData });
        assert.verifySteps(["myAction mounted"]);

        await nextTick();
        assert.containsNone(webClient, ".not-here");
        assert.containsOnce(webClient, ".test_client_action");

        assert.deepEqual(webClient.env.services.router.current.hash, {
            action: "__test__client__action__",
            menuId: 1,
        });
    });

    QUnit.test("concurrent hashchange during action mounting -- 2", async (assert) => {
        assert.expect(5);

        const baseURL = new URL(browser.location.href).toString();

        class MyAction extends Component {
            mounted() {
                assert.step("myAction mounted");
                const newURL = baseURL + "#action=__test__client__action__&menuId=1";
                // immediate triggering
                window.dispatchEvent(new HashChangeEvent("hashchange", { newURL }));
            }
        }
        MyAction.template = tags.xml`<div class="not-here" />`;
        registry.category("actions").add("myAction", MyAction);

        browser.location.hash = "#action=myAction";
        const webClient = await createWebClient({ serverData });
        assert.verifySteps(["myAction mounted"]);

        await nextTick();
        assert.containsNone(webClient, ".not-here");
        assert.containsOnce(webClient, ".test_client_action");

        assert.deepEqual(webClient.env.services.router.current.hash, {
            action: "__test__client__action__",
            menuId: 1,
        });
    });
});
