/** @verp-module **/

import { registry } from "@web/core/registry";
import { uiService } from "@web/core/ui/ui_service";
import testUtils from "web.testUtils";
import ReportClientAction from "report.client_action";
import { makeFakeNotificationService } from "../../helpers/mock_services";
import { patchWithCleanup, click } from "../../helpers/utils";
import { createWebClient, doAction, getActionManagerServerData } from "./../helpers";
import { mockDownload } from "@web/../tests/helpers/utils";
import { clearRegistryWithCleanup } from "../../helpers/mock_env";
import { session } from "@web/session";

let serverData;

const serviceRegistry = registry.category("services");

QUnit.module("ActionManager", (hooks) => {
    hooks.beforeEach(() => {
        serverData = getActionManagerServerData();
        clearRegistryWithCleanup(registry.category("mainComponents"));
    });

    QUnit.module("Report actions");

    QUnit.test("can execute report actions from db ID", async function (assert) {
        assert.expect(6);
        mockDownload((options) => {
            assert.step(options.url);
            return Promise.resolve();
        });
        const mockRPC = async (route, args) => {
            assert.step((args && args.method) || route);
            if (route === "/report/checkHtmltoPdf") {
                return Promise.resolve("ok");
            }
        };
        const webClient = await createWebClient({ serverData, mockRPC });
        await doAction(webClient, 7, { onClose: () => assert.step("onClose") });
        assert.verifySteps([
            "/web/webclient/loadMenus",
            "/web/action/load",
            "/report/checkHtmltoPdf",
            "/report/download",
            "onClose",
        ]);
    });

    QUnit.test("report actions can close modals and reload views", async function (assert) {
        assert.expect(8);
        mockDownload((options) => {
            assert.step(options.url);
            return Promise.resolve();
        });
        const mockRPC = async (route) => {
            if (route === "/report/checkHtmltoPdf") {
                return Promise.resolve("ok");
            }
        };
        const webClient = await createWebClient({ serverData, mockRPC });
        await doAction(webClient, 5, { onClose: () => assert.step("onClose") });
        assert.containsOnce(
            document.body,
            ".o-technical-modal .o-form-view",
            "should have rendered a form view in a modal"
        );
        await doAction(webClient, 7, { onClose: () => assert.step("on_printed") });
        assert.containsOnce(
            document.body,
            ".o-technical-modal .o-form-view",
            "The modal should still exist"
        );
        await doAction(webClient, 11);
        assert.containsNone(
            document.body,
            ".o-technical-modal .o-form-view",
            "the modal should have been closed after the action report"
        );
        assert.verifySteps(["/report/download", "on_printed", "/report/download", "onClose"]);
    });

    QUnit.test(
        "should trigger a notification if wkhtmltopdf is to upgrade",
        async function (assert) {
            serviceRegistry.add(
                "notification",
                makeFakeNotificationService(
                    () => {
                        assert.step("notify");
                    },
                    () => {}
                )
            );
            mockDownload((options) => {
                assert.step(options.url);
                return Promise.resolve();
            });
            const mockRPC = async (route, args) => {
                assert.step((args && args.method) || route);
                if (route === "/report/checkHtmltoPdf") {
                    return Promise.resolve("upgrade");
                }
            };
            const webClient = await createWebClient({ serverData, mockRPC });
            await doAction(webClient, 7);
            assert.verifySteps([
                "/web/webclient/loadMenus",
                "/web/action/load",
                "/report/checkHtmltoPdf",
                "notify",
                "/report/download",
            ]);
        }
    );

    QUnit.test(
        "should open the report client action if wkhtmltopdf is broken",
        async function (assert) {
            mockDownload(() => {
                assert.step("download"); // should not be called
                return Promise.resolve();
            });
            serviceRegistry.add(
                "notification",
                makeFakeNotificationService(
                    () => {
                        assert.step("notify");
                    },
                    () => {}
                )
            );
            const mockRPC = async (route, args) => {
                assert.step(args.method || route);
                if (route === "/report/checkHtmltoPdf") {
                    return Promise.resolve("broken");
                }
                if (route.includes("/report/html/some_report")) {
                    return Promise.resolve(true);
                }
            };
            // patch the report client action to override its iframe's url so that
            // it doesn't trigger an RPC when it is appended to the DOM (for this
            // usecase, using removeSRCAttribute doesn't work as the RPC is
            // triggered as soon as the iframe is in the DOM, even if its src
            // attribute is removed right after)
            testUtils.mock.patch(ReportClientAction, {
                async start() {
                    await this._super(...arguments);
                    this._rpc({ route: this.iframe.getAttribute("src") });
                    this.iframe.setAttribute("src", "about:blank");
                },
            });
            const webClient = await createWebClient({ serverData, mockRPC });
            await doAction(webClient, 7);
            assert.containsOnce(
                webClient,
                ".o-report-iframe",
                "should have opened the report client action"
            );
            assert.containsOnce(webClient, ".o-cp-buttons .o-report-buttons .o-report-print");
            assert.verifySteps([
                "/web/webclient/loadMenus",
                "/web/action/load",
                "/report/checkHtmltoPdf",
                "notify",
                // context={"lang":'en',"uid":7,"tz":'taht'}
                "/report/html/some_report?context=%7B%22lang%22%3A%22en%22%2C%22uid%22%3A7%2C%22tz%22%3A%22taht%22%7D",
            ]);
            testUtils.mock.unpatch(ReportClientAction);
        }
    );

    QUnit.test("send context in case of html report", async function (assert) {
        assert.expect(5);
        mockDownload(() => {
            assert.step("download"); // should not be called
            return Promise.resolve();
        });
        serviceRegistry.add(
            "notification",
            makeFakeNotificationService(
                (message, options) => {
                    assert.step(options.type || "notification");
                },
                () => {}
            )
        );
        patchWithCleanup(session.userContext, { some_key: 2 });
        const mockRPC = async (route, args) => {
            assert.step(args.method || route);
            if (route.includes("/report/html/some_report")) {
                return Promise.resolve(true);
            }
        };
        // patch the report client action to override its iframe's url so that
        // it doesn't trigger an RPC when it is appended to the DOM (for this
        // usecase, using removeSRCAttribute doesn't work as the RPC is
        // triggered as soon as the iframe is in the DOM, even if its src
        // attribute is removed right after)
        testUtils.mock.patch(ReportClientAction, {
            async start() {
                await this._super(...arguments);
                this._rpc({ route: this.iframe.getAttribute("src") });
                this.iframe.setAttribute("src", "about:blank");
            },
        });
        const webClient = await createWebClient({ serverData, mockRPC });
        await doAction(webClient, 12);
        assert.containsOnce(webClient, ".o-report-iframe", "should have opened the client action");
        assert.verifySteps([
            "/web/webclient/loadMenus",
            "/web/action/load",
            // context={"lang":'en',"uid":7,"tz":'taht',"some_key":2}
            "/report/html/some_report?context=%7B%22lang%22%3A%22en%22%2C%22uid%22%3A7%2C%22tz%22%3A%22taht%22%2C%22some_key%22%3A2%7D",
        ]);
        testUtils.mock.unpatch(ReportClientAction);
    });

    QUnit.test(
        "UI unblocks after downloading the report even if it threw an error",
        async function (assert) {
            assert.expect(8);
            let timesDownloasServiceHasBeenCalled = 0;
            mockDownload(() => {
                if (timesDownloasServiceHasBeenCalled === 0) {
                    assert.step("successful download");
                    timesDownloasServiceHasBeenCalled++;
                    return Promise.resolve();
                }
                if (timesDownloasServiceHasBeenCalled === 1) {
                    assert.step("failed download");
                    return Promise.reject();
                }
            });
            serviceRegistry.add("ui", uiService);
            const mockRPC = async (route) => {
                if (route === "/report/checkHtmltoPdf") {
                    return Promise.resolve("ok");
                }
            };
            const webClient = await createWebClient({ serverData, mockRPC });
            const ui = webClient.env.services.ui;
            ui.bus.on("BLOCK", webClient, () => {
                assert.step("block");
            });
            ui.bus.on("UNBLOCK", webClient, () => {
                assert.step("unblock");
            });
            await doAction(webClient, 7);
            try {
                await doAction(webClient, 7);
            } catch (e) {
                assert.step("error caught");
            }
            assert.verifySteps([
                "block",
                "successful download",
                "unblock",
                "block",
                "failed download",
                "unblock",
                "error caught",
            ]);
            ui.bus.off("BLOCK", webClient);
            ui.bus.off("UNBLOCK", webClient);
        }
    );

    QUnit.test("can use custom handlers for report actions", async function (assert) {
        assert.expect(8);
        mockDownload((options) => {
            assert.step(options.url);
            return Promise.resolve();
        });
        const mockRPC = async (route, args) => {
            assert.step((args && args.method) || route);
            if (route === "/report/checkHtmltoPdf") {
                return "ok";
            }
        };
        const webClient = await createWebClient({ serverData, mockRPC });
        let customHandlerCalled = false;
        registry.category("ir.actions.report handlers").add("custom_handler", async (action) => {
            if (action.id === 7 && !customHandlerCalled) {
                customHandlerCalled = true;
                assert.step("calling custom handler");
                return true;
            }
            assert.step("falling through to default handler");
        });
        await doAction(webClient, 7);
        assert.step("first doAction finished");
        await doAction(webClient, 7);

        assert.verifySteps([
            "/web/webclient/loadMenus",
            "/web/action/load",
            "calling custom handler",
            "first doAction finished",
            "falling through to default handler",
            "/report/checkHtmltoPdf",
            "/report/download",
        ]);
    });

    QUnit.test("context is correctly passed to the client action report", async (assert) => {
        assert.expect(8);

        mockDownload((options) => {
            assert.step(options.url);
            assert.deepEqual(JSON.parse(options.data.data), [
                "/report/pdf/ennio.morricone/99",
                "qweb-pdf",
            ]);
            return Promise.resolve();
        });
        const mockRPC = async (route, args) => {
            assert.step((args && args.method) || route);
            if (route === "/report/checkHtmltoPdf") {
                return "ok";
            }
            if (route.includes("/report/html")) {
                return true;
            }
        };

        testUtils.mock.patch(ReportClientAction, {
            async start() {
                await this._super(...arguments);
                this._rpc({ route: this.iframe.getAttribute("src") });
                this.iframe.setAttribute("src", "about:blank");
            },
        });
        const webClient = await createWebClient({ serverData, mockRPC });

        const action = {
            context: {
                rabbia: "E Tarantella",
                activeIds: [99],
            },
            data: null,
            name: "Ennio Morricone",
            report_name: "ennio.morricone",
            reportType: "qweb-html",
            type: "ir.actions.report",
        };
        assert.verifySteps(["/web/webclient/loadMenus"]);

        await doAction(webClient, action);
        assert.verifySteps([
            "/report/html/ennio.morricone/99?context=%7B%22lang%22%3A%22en%22%2C%22uid%22%3A7%2C%22tz%22%3A%22taht%22%7D",
        ]);
        await click(webClient.el.querySelector(".o-report-print"));
        assert.verifySteps(["/report/checkHtmltoPdf", "/report/download"]);
        testUtils.mock.unpatch(ReportClientAction);
    });

    QUnit.test("url is valid", async (assert) => {
        assert.expect(2);

        patchWithCleanup(ReportClientAction.prototype, {
            init() {
                this._super(...arguments);
                this.report_url = "about:blank";
            },
        });

        const webClient = await createWebClient({ serverData });

        await doAction(webClient, 12); // 12 is a html report action in serverData

        const hash = webClient.router.current.hash;
        // used to put report.client_action in the url
        assert.strictEqual(hash.action === "report.client_action", false);
        assert.strictEqual(hash.action === 12, true);
    });
});
