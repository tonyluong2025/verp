/** @verp-module **/

import { registry } from "@web/core/registry";
import testUtils from "web.testUtils";
import { clearRegistryWithCleanup } from "../../helpers/mock_env";
import { click, legacyExtraNextTick, nextTick, patchWithCleanup } from "../../helpers/utils";
import { createWebClient, doAction, getActionManagerServerData } from "./../helpers";
import { session } from "@web/session";

let serverData;

const mainComponentRegistry = registry.category("mainComponents");

QUnit.module("ActionManager", (hooks) => {
    hooks.beforeEach(() => {
        serverData = getActionManagerServerData();
    });

    QUnit.module("Effects");

    QUnit.test("rainbowman integrated to webClient", async function (assert) {
        assert.expect(10);
        patchWithCleanup(session, { showEffect: true });
        clearRegistryWithCleanup(mainComponentRegistry);

        const webClient = await createWebClient({ serverData });
        await doAction(webClient, 1);
        assert.containsOnce(webClient.el, ".o-kanban-view");
        assert.containsNone(webClient.el, ".o-reward");
        webClient.env.services.effect.add({ type: "rainbowMan", message: "", fadeout: "no" });
        await nextTick();
        await legacyExtraNextTick();
        assert.containsOnce(webClient.el, ".o-reward");
        assert.containsOnce(webClient.el, ".o-kanban-view");
        await testUtils.dom.click(webClient.el.querySelector(".o-kanban-record"));
        await legacyExtraNextTick();
        assert.containsNone(webClient.el, ".o-reward");
        assert.containsOnce(webClient.el, ".o-kanban-view");
        webClient.env.services.effect.add({ type: "rainbowMan", message: "", fadeout: "no" });
        await nextTick();
        await legacyExtraNextTick();
        assert.containsOnce(webClient.el, ".o-reward");
        assert.containsOnce(webClient.el, ".o-kanban-view");
        // Do not force rainbow man to destroy on doAction
        // we let it die either after its animation or on user click
        await doAction(webClient, 3);
        assert.containsOnce(webClient.el, ".o-reward");
        assert.containsOnce(webClient.el, ".o-list-view");
    });

    QUnit.test("on close with effect from server", async function (assert) {
        assert.expect(1);
        patchWithCleanup(session, { showEffect: true });
        const mockRPC = async (route) => {
            if (route === "/web/dataset/call_button") {
                return Promise.resolve({
                    type: "ir.actions.actwindow_close",
                    effect: {
                        type: "rainbowMan",
                        message: "button called",
                    },
                });
            }
        };
        clearRegistryWithCleanup(mainComponentRegistry);

        const webClient = await createWebClient({ serverData, mockRPC });
        await doAction(webClient, 6);
        await click(webClient.el.querySelector('button[name="object"]'));
        assert.containsOnce(webClient, ".o-reward");
    });

    QUnit.test("on close with effect in xml", async function (assert) {
        assert.expect(2);
        serverData.views["partner,false,form"] = `
            <form>
              <header>
                <button string="Call method" name="object" type="object"
                 effect="{'type': 'rainbowMan', 'message': 'rainBowInXML'}"
                />
              </header>
              <field name="displayName"/>
            </form>`;
        patchWithCleanup(session, { showEffect: true });
        const mockRPC = async (route) => {
            if (route === "/web/dataset/call_button") {
                return Promise.resolve(false);
            }
        };
        clearRegistryWithCleanup(mainComponentRegistry);

        const webClient = await createWebClient({ serverData, mockRPC });
        await doAction(webClient, 6);
        await click(webClient.el.querySelector('button[name="object"]'));
        await legacyExtraNextTick();
        assert.containsOnce(webClient.el, ".o-reward");
        assert.strictEqual(
            webClient.el.querySelector(".o-reward .o-reward-msg-content").textContent,
            "rainBowInXML"
        );
    });
});
