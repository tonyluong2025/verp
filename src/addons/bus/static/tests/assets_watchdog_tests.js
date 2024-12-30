/** @verp-module */

import * as legacyRegistry from "web.Registry";
import * as BusService from "bus.BusService";
import * as RamStorage from "web.RamStorage";
import * as AbstractStorageService from "web.AbstractStorageService";

import { createWebClient } from "@web/../tests/webclient/helpers";
import { assetsWatchdogService } from "@bus/js/services/assets_watchdog_service";
import { click, nextTick, patchWithCleanup } from "@web/../tests/helpers/utils";
import { browser } from "@web/core/browser/browser";
import { registry } from "@web/core/registry";

const LocalStorageService = AbstractStorageService.extend({
    storage: new RamStorage(),
});
const mainComponentRegistry = registry.category("mainComponents");
const serviceRegistry = registry.category("services");

QUnit.module("Bus Assets WatchDog", (hooks) => {
    let legacyServicesRegistry;
    hooks.beforeEach((assert) => {
        legacyServicesRegistry = new legacyRegistry();
        legacyServicesRegistry.add("busService", BusService);
        legacyServicesRegistry.add("localStorage", LocalStorageService);

        serviceRegistry.add("assetsWatchdog", assetsWatchdogService);

        patchWithCleanup(browser, {
            setTimeout: (fn) => fn(),
            clearTimeout: () => {},
            location: {
                reload: () => assert.step("reloadPage"),
            },
        });
    });

    QUnit.test("can listen on bus and displays notifications in DOM", async (assert) => {
        assert.expect(4);

        let pollNumber = 0;
        const mockRPC = async (route, args) => {
            if (route === "/longpolling/poll") {
                if (pollNumber > 0) {
                    return new Promise(() => {}); // let it hang to avoid further calls
                }
                pollNumber++;
                return [{
                    message: {
                        type: 'bundleChanged',
                        payload: { serverVersion: "NEW_MAJOR_VERSION" },
                    },
                }];
            }
        };

        const webClient = await createWebClient({
            legacyParams: { serviceRegistry: legacyServicesRegistry },
            mockRPC,
        });

        await nextTick();

        assert.containsOnce(webClient.el, ".o-notification-body");
        assert.strictEqual(
            webClient.el.querySelector(".o-notification-body .o-notification-content").textContent,
            "The page appears to be out of date."
        );

        // reload by clicking on the reload button
        await click(webClient.el, ".o-notification-buttons .btn-primary");
        assert.verifySteps(["reloadPage"]);
    });
});
