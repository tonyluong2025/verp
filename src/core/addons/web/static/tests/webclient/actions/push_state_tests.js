/** @verp-module **/

import { browser } from "@web/core/browser/browser";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import testUtils from "web.testUtils";
import { click, legacyExtraNextTick, nextTick, patchWithCleanup } from "../../helpers/utils";
import { createWebClient, doAction, getActionManagerServerData } from "./../helpers";

const { Component, tags } = owl;

let serverData;
const actionRegistry = registry.category("actions");

QUnit.module("ActionManager", (hooks) => {
    hooks.beforeEach(() => {
        serverData = getActionManagerServerData();
    });

    QUnit.module("Push State");

    QUnit.test("basic action as App", async (assert) => {
        assert.expect(5);
        const webClient = await createWebClient({ serverData });
        let urlState = webClient.env.services.router.current;
        assert.deepEqual(urlState.hash, {});
        await click(webClient.el, ".o-navbar-apps-menu button");
        await click(webClient.el, ".o-navbar-apps-menu .dropdown-item:nth-child(3)");
        await nextTick();
        await nextTick();
        urlState = webClient.env.services.router.current;
        assert.strictEqual(urlState.hash.action, 1002);
        assert.strictEqual(urlState.hash.menuId, 2);
        assert.strictEqual(
            webClient.el.querySelector(".test_client_action").textContent.trim(),
            "ClientAction_Id 2"
        );
        assert.strictEqual(webClient.el.querySelector(".o-menu-brand").textContent, "App2");
    });

    QUnit.test("do action keeps menu in url", async (assert) => {
        assert.expect(9);
        const webClient = await createWebClient({ serverData });
        let urlState = webClient.env.services.router.current;
        assert.deepEqual(urlState.hash, {});
        await click(webClient.el, ".o-navbar-apps-menu button");
        await click(webClient.el, ".o-navbar-apps-menu .dropdown-item:nth-child(3)");
        await nextTick();
        await nextTick();
        urlState = webClient.env.services.router.current;
        assert.strictEqual(urlState.hash.action, 1002);
        assert.strictEqual(urlState.hash.menuId, 2);
        assert.strictEqual(
            webClient.el.querySelector(".test_client_action").textContent.trim(),
            "ClientAction_Id 2"
        );
        assert.strictEqual(webClient.el.querySelector(".o-menu-brand").textContent, "App2");
        await doAction(webClient, 1001, { clearBreadcrumbs: true });
        urlState = webClient.env.services.router.current;
        assert.strictEqual(urlState.hash.action, 1001);
        assert.strictEqual(urlState.hash.menuId, 2);
        assert.strictEqual(
            webClient.el.querySelector(".test_client_action").textContent.trim(),
            "ClientAction_Id 1"
        );
        assert.strictEqual(webClient.el.querySelector(".o-menu-brand").textContent, "App2");
    });

    QUnit.test("actions can push state", async (assert) => {
        assert.expect(5);
        class ClientActionPushes extends Component {
            constructor() {
                super(...arguments);
                this.router = useService("router");
            }
            _actionPushState() {
                this.router.pushState({ arbitrary: "actionPushed" });
            }
        }
        ClientActionPushes.template = tags.xml`
      <div class="test_client_action" t-on-click="_actionPushState">
        ClientAction_<t t-esc="props.params and props.params.description" />
      </div>`;
        actionRegistry.add("client_action_pushes", ClientActionPushes);
        const webClient = await createWebClient({ serverData });
        let urlState = webClient.env.services.router.current;
        assert.deepEqual(urlState.hash, {});
        await doAction(webClient, "client_action_pushes");
        urlState = webClient.env.services.router.current;
        assert.strictEqual(urlState.hash.action, "client_action_pushes");
        assert.strictEqual(urlState.hash.menuId, undefined);
        await click(webClient.el, ".test_client_action");
        urlState = webClient.env.services.router.current;
        assert.strictEqual(urlState.hash.action, "client_action_pushes");
        assert.strictEqual(urlState.hash.arbitrary, "actionPushed");
    });

    QUnit.test("actions override previous state", async (assert) => {
        assert.expect(5);
        class ClientActionPushes extends Component {
            constructor() {
                super(...arguments);
                this.router = useService("router");
            }
            _actionPushState() {
                this.router.pushState({ arbitrary: "actionPushed" });
            }
        }
        ClientActionPushes.template = tags.xml`
      <div class="test_client_action" t-on-click="_actionPushState">
        ClientAction_<t t-esc="props.params and props.params.description" />
      </div>`;
        actionRegistry.add("client_action_pushes", ClientActionPushes);
        const webClient = await createWebClient({ serverData });
        let urlState = webClient.env.services.router.current;
        assert.deepEqual(urlState.hash, {});
        await doAction(webClient, "client_action_pushes");
        await click(webClient.el, ".test_client_action");
        urlState = webClient.env.services.router.current;
        assert.strictEqual(urlState.hash.action, "client_action_pushes");
        assert.strictEqual(urlState.hash.arbitrary, "actionPushed");
        await doAction(webClient, 1001);
        urlState = webClient.env.services.router.current;
        assert.strictEqual(urlState.hash.action, 1001);
        assert.strictEqual(urlState.hash.arbitrary, undefined);
    });

    QUnit.test("actions override previous state from menu click", async (assert) => {
        assert.expect(3);
        class ClientActionPushes extends Component {
            constructor() {
                super(...arguments);
                this.router = useService("router");
            }
            _actionPushState() {
                this.router.pushState({ arbitrary: "actionPushed" });
            }
        }
        ClientActionPushes.template = tags.xml`
      <div class="test_client_action" t-on-click="_actionPushState">
        ClientAction_<t t-esc="props.params and props.params.description" />
      </div>`;
        actionRegistry.add("client_action_pushes", ClientActionPushes);
        const webClient = await createWebClient({ serverData });
        let urlState = webClient.env.services.router.current;
        assert.deepEqual(urlState.hash, {});
        await doAction(webClient, "client_action_pushes");
        await click(webClient.el, ".test_client_action");
        await click(webClient.el, ".o-navbar-apps-menu button");
        await click(webClient.el, ".o-navbar-apps-menu .dropdown-item:nth-child(3)");
        await nextTick();
        await nextTick();
        urlState = webClient.env.services.router.current;
        assert.strictEqual(urlState.hash.action, 1002);
        assert.strictEqual(urlState.hash.menuId, 2);
    });

    QUnit.test("action in target new do not push state", async (assert) => {
        assert.expect(1);
        serverData.actions[1001].target = "new";
        patchWithCleanup(browser, {
            history: Object.assign({}, browser.history, {
                pushState() {
                    throw new Error("should not push state");
                },
            }),
        });
        const webClient = await createWebClient({ serverData });
        await doAction(webClient, 1001);
        assert.containsOnce(webClient, ".modal .test_client_action");
    });

    QUnit.test("properly push state", async function (assert) {
        assert.expect(3);
        const webClient = await createWebClient({ serverData });
        await doAction(webClient, 4);
        assert.deepEqual(webClient.env.services.router.current.hash, {
            action: 4,
            model: "partner",
            viewType: "kanban",
        });
        await doAction(webClient, 8);
        assert.deepEqual(webClient.env.services.router.current.hash, {
            action: 8,
            model: "pony",
            viewType: "list",
        });
        await testUtils.dom.click($(webClient.el).find("tr.o-data-row:first"));
        await legacyExtraNextTick();
        assert.deepEqual(webClient.env.services.router.current.hash, {
            action: 8,
            model: "pony",
            viewType: "form",
            id: 4,
        });
    });

    QUnit.test("push state after action is loaded, not before", async function (assert) {
        assert.expect(2);
        const def = testUtils.makeTestPromise();
        const mockRPC = async function (route) {
            if (route === "/web/dataset/searchRead") {
                await def;
            }
        };
        const webClient = await createWebClient({ serverData, mockRPC });
        doAction(webClient, 4);
        await testUtils.nextTick();
        await legacyExtraNextTick();
        assert.deepEqual(webClient.env.services.router.current.hash, {});
        def.resolve();
        await testUtils.nextTick();
        await legacyExtraNextTick();
        assert.deepEqual(webClient.env.services.router.current.hash, {
            action: 4,
            model: "partner",
            viewType: "kanban",
        });
    });

    QUnit.test("do not push state when action fails", async function (assert) {
        assert.expect(3);
        const mockRPC = async function (route, args) {
            if (args && args.method === "read") {
                return Promise.reject();
            }
        };
        const webClient = await createWebClient({ serverData, mockRPC });
        await doAction(webClient, 8);
        assert.deepEqual(webClient.env.services.router.current.hash, {
            action: 8,
            model: "pony",
            viewType: "list",
        });
        await testUtils.dom.click($(webClient.el).find("tr.o-data-row:first"));
        await legacyExtraNextTick();
        // we make sure here that the list view is still in the dom
        assert.containsOnce(webClient, ".o-list-view", "there should still be a list view in dom");
        assert.deepEqual(webClient.env.services.router.current.hash, {
            action: 8,
            model: "pony",
            viewType: "list",
        });
    });
});
