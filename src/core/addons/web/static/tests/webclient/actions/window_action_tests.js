/** @verp-module **/

import { browser } from "@web/core/browser/browser";
import { registry } from "@web/core/registry";
import { editView } from "@web/views/debug_items";
import { clearUncommittedChanges } from "@web/webclient/actions/action_service";
import AbstractView from "web.AbstractView";
import FormView from "web.FormView";
import ListController from "web.ListController";
import testUtils from "web.testUtils";
import legacyViewRegistry from "web.viewRegistry";
import { session } from "@web/session";
import {
    click,
    legacyExtraNextTick,
    makeDeferred,
    nextTick,
    patchWithCleanup,
} from "../../helpers/utils";
import { createWebClient, doAction, getActionManagerServerData, loadState } from "./../helpers";
import { errorService } from "../../../src/core/errors/error_service";
import { RPCError } from "@web/core/network/rpc_service";
import { registerCleanup } from "../../helpers/cleanup";
import { WarningDialog } from "@web/core/errors/error_dialogs";
import { makeFakeUserService } from "@web/../tests/helpers/mock_services";
import * as cpHelpers from "@web/../tests/search/helpers";

let serverData;
const serviceRegistry = registry.category("services");

QUnit.module("ActionManager", (hooks) => {
    hooks.beforeEach(() => {
        serverData = getActionManagerServerData();
    });

    QUnit.module("Window Actions");

    QUnit.test("can execute actwindow actions from db ID", async function (assert) {
        assert.expect(7);
        const mockRPC = async (route, args) => {
            assert.step((args && args.method) || route);
        };
        const webClient = await createWebClient({ serverData, mockRPC });
        await doAction(webClient, 1);
        assert.containsOnce(
            document.body,
            ".o-control-panel",
            "should have rendered a control panel"
        );
        assert.containsOnce(webClient, ".o-kanban-view", "should have rendered a kanban view");
        assert.verifySteps([
            "/web/webclient/loadMenus",
            "/web/action/load",
            "loadViews",
            "/web/dataset/searchRead",
        ]);
    });

    QUnit.test("sidebar is present in list view", async function (assert) {
        assert.expect(4);
        serverData.models.partner.toolbar = {
            print: [{ label: "Print that record" }],
        };
        const mockRPC = async (route, args) => {
            if (args && args.method === "loadViews") {
                assert.strictEqual(
                    args.kwargs.options.toolbar,
                    true,
                    "should ask for toolbar information"
                );
            }
        };
        const webClient = await createWebClient({ serverData, mockRPC });
        await doAction(webClient, 3);
        assert.containsNone(webClient, ".o-cp-action-menus");
        await testUtils.dom.clickFirst($(webClient.el).find("input.custom-control-input"));
        assert.isVisible(
            $(webClient.el).find('.o-cp-action-menus button.dropdown-toggle:contains("Print")')[0]
        );
        assert.isVisible(
            $(webClient.el).find('.o-cp-action-menus button.dropdown-toggle:contains("Action")')[0]
        );
    });

    QUnit.test("can switch between views", async function (assert) {
        assert.expect(19);
        const mockRPC = async (route, args) => {
            assert.step((args && args.method) || route);
        };
        const webClient = await createWebClient({ serverData, mockRPC });
        await doAction(webClient, 3);
        assert.containsOnce(webClient, ".o-list-view", "should display the list view");
        // switch to kanban view
        await cpHelpers.switchView(webClient.el, "kanban");
        await legacyExtraNextTick();
        assert.containsNone(webClient, ".o-list-view", "should no longer display the list view");
        assert.containsOnce(webClient, ".o-kanban-view", "should display the kanban view");
        // switch back to list view
        await cpHelpers.switchView(webClient.el, "list");
        await legacyExtraNextTick();
        assert.containsOnce(webClient, ".o-list-view", "should display the list view");
        assert.containsNone(
            webClient.el,
            ".o-kanban-view",
            "should no longer display the kanban view"
        );
        // open a record in form view
        await testUtils.dom.click(webClient.el.querySelector(".o-list-view .o-data-row"));
        await legacyExtraNextTick();
        assert.containsNone(webClient, ".o-list-view", "should no longer display the list view");
        assert.containsOnce(webClient, ".o-form-view", "should display the form view");
        assert.strictEqual(
            $(webClient.el).find(".o-field-widget[name=foo]").text(),
            "yop",
            "should have opened the correct record"
        );
        // go back to list view using the breadcrumbs
        await testUtils.dom.click(webClient.el.querySelector(".o-control-panel .breadcrumb a"));
        await legacyExtraNextTick();
        assert.containsOnce(webClient, ".o-list-view", "should display the list view");
        assert.containsNone(webClient, ".o-form-view", "should no longer display the form view");
        assert.verifySteps([
            "/web/webclient/loadMenus",
            "/web/action/load",
            "load_views",
            "/web/dataset/searchRead",
            "/web/dataset/searchRead",
            "/web/dataset/searchRead",
            "read",
            "/web/dataset/searchRead",
        ]);
    });

    QUnit.test("switching into a view with mode=edit lands in edit mode", async function (assert) {
        serverData.views["partner,1,kanban"] = `
    <kanban onCreate="quick_create" defaultGroupby="m2o">
      <templates>
        <t t-name="kanban-box">
          <div class="oe-kanban-global-click"><field name="foo"/></div>
        </t>
      </templates>
    </kanban>
    `;
        serverData.actions[1] = {
            id: 1,
            xmlid: "action_1",
            label: "Partners Action 1 patched",
            resModel: "partner",
            type: "ir.actions.actwindow",
            views: [
                [false, "kanban"],
                [false, "form"],
            ],
        };
        const mockRPC = async (route, args) => {
            assert.step((args && args.method) || route);
        };
        assert.expect(14);
        const webClient = await createWebClient({ serverData, mockRPC });
        await doAction(webClient, 1);
        assert.containsOnce(webClient, ".o-kanban-view", "should display the kanban view");
        // quick create record
        await testUtils.dom.click(webClient.el.querySelector(".o-kanban-button-new"));
        await testUtils.fields.editInput(
            webClient.el.querySelector(".o-field-widget[name=displayName]"),
            "New name"
        );
        await legacyExtraNextTick();
        // edit quick-created record
        await testUtils.dom.click(webClient.el.querySelector(".o-kanban-edit"));
        assert.containsOnce(
            webClient,
            ".o-form-view.o-form-editable",
            "should display the form view in edit mode"
        );
        assert.verifySteps([
            "/web/webclient/loadMenus",
            "/web/action/load",
            "load_views",
            "webReadGroup",
            "/web/dataset/searchRead",
            "/web/dataset/searchRead",
            "onchange",
            "nameCreate",
            "read",
            "onchange",
            "read",
        ]);
    });

    QUnit.test(
        "orderedBy in context is not propagated when executing another action",
        async function (assert) {
            assert.expect(6);
            serverData.models.partner.fields.foo.sortable = true;
            serverData.views["partner,false,form"] = `
        <form>
          <header>
            <button name="8" string="Execute action" type="action"/>
          </header>
        </form>`;
            serverData.models.partner.filters = [
                {
                    id: 1,
                    context: "{}",
                    domain: "[]",
                    sort: "[]",
                    is_default: true,
                    label: "My filter",
                },
            ];
            let searchReadCount = 1;
            const mockRPC = async (route, args) => {
                if (route === "/web/dataset/searchRead") {
                    args = args || {};
                    if (searchReadCount === 1) {
                        assert.strictEqual(args.model, "partner");
                        assert.notOk(args.sort);
                    }
                    if (searchReadCount === 2) {
                        assert.strictEqual(args.model, "partner");
                        assert.strictEqual(args.sort, "foo ASC");
                    }
                    if (searchReadCount === 3) {
                        assert.strictEqual(args.model, "pony");
                        assert.notOk(args.sort);
                    }
                    searchReadCount += 1;
                }
            };
            const webClient = await createWebClient({ serverData, mockRPC });
            await doAction(webClient, 3);
            // Sort records
            await testUtils.dom.click($(webClient.el).find(".o-list-view th.o-column-sortable"));
            await legacyExtraNextTick();
            // Get to the form view of the model, on the first record
            await testUtils.dom.click($(webClient.el).find(".o-data-cell:first"));
            await legacyExtraNextTick();
            // Execute another action by clicking on the button within the form
            await testUtils.dom.click($(webClient.el).find("button[name=8]"));
            await legacyExtraNextTick();
        }
    );

    QUnit.test("breadcrumbs are updated when switching between views", async function (assert) {
        assert.expect(15);
        const webClient = await createWebClient({ serverData });
        await doAction(webClient, 3);
        assert.containsOnce(
            webClient.el,
            ".o-control-panel .breadcrumb-item",
            "there should be one controller in the breadcrumbs"
        );
        assert.strictEqual(
            $(webClient.el).find(".o-control-panel .breadcrumb-item").text(),
            "Partners",
            "breadcrumbs should display the displayName of the action"
        );
        // switch to kanban view
        await cpHelpers.switchView(webClient.el, "kanban");
        await legacyExtraNextTick();
        assert.containsOnce(
            webClient.el,
            ".o-control-panel .breadcrumb-item",
            "there should still be one controller in the breadcrumbs"
        );
        assert.strictEqual(
            $(webClient.el).find(".o-control-panel .breadcrumb-item").text(),
            "Partners",
            "breadcrumbs should still display the displayName of the action"
        );
        // open a record in form view
        await testUtils.dom.click(webClient.el.querySelector(".o-kanban-view .o-kanban-record"));
        await legacyExtraNextTick();
        assert.containsN(
            webClient.el,
            ".o-control-panel .breadcrumb-item",
            2,
            "there should be two controllers in the breadcrumbs"
        );
        assert.strictEqual(
            $(webClient.el).find(".o-control-panel .breadcrumb-item:last").text(),
            "First record"
        );
        // go back to kanban view using the breadcrumbs
        await testUtils.dom.click(webClient.el.querySelector(".o-control-panel .breadcrumb a"));
        await legacyExtraNextTick();
        assert.containsOnce(
            webClient.el,
            ".o-control-panel .breadcrumb-item",
            "there should be one controller in the breadcrumbs"
        );
        assert.strictEqual(
            $(webClient.el).find(".o-control-panel .breadcrumb-item").text(),
            "Partners",
            "breadcrumbs should display the displayName of the action"
        );
        // switch back to list view
        await cpHelpers.switchView(webClient.el, "list");
        await legacyExtraNextTick();
        assert.containsOnce(
            webClient.el,
            ".o-control-panel .breadcrumb-item",
            "there should still be one controller in the breadcrumbs"
        );
        assert.strictEqual(
            $(webClient.el).find(".o-control-panel .breadcrumb-item").text(),
            "Partners",
            "breadcrumbs should still display the displayName of the action"
        );
        // open a record in form view
        await testUtils.dom.click(webClient.el.querySelector(".o-list-view .o-data-row"));
        await legacyExtraNextTick();
        assert.containsN(
            webClient.el,
            ".o-control-panel .breadcrumb-item",
            2,
            "there should be two controllers in the breadcrumbs"
        );
        assert.strictEqual(
            $(webClient.el).find(".o-control-panel .breadcrumb-item:last").text(),
            "First record"
        );
        // go back to list view using the breadcrumbs
        await testUtils.dom.click(webClient.el.querySelector(".o-control-panel .breadcrumb a"));
        await legacyExtraNextTick();
        assert.containsOnce(webClient, ".o-list-view", "should be back on list view");
        assert.containsOnce(
            webClient.el,
            ".o-control-panel .breadcrumb-item",
            "there should be one controller in the breadcrumbs"
        );
        assert.strictEqual(
            $(webClient.el).find(".o-control-panel .breadcrumb-item").text(),
            "Partners",
            "breadcrumbs should display the displayName of the action"
        );
    });

    QUnit.test("switch buttons are updated when switching between views", async function (assert) {
        assert.expect(13);
        const webClient = await createWebClient({ serverData });
        await doAction(webClient, 3);
        assert.containsN(
            webClient.el,
            ".o-control-panel button.o-switch-view",
            2,
            "should have two switch buttons (list and kanban)"
        );
        assert.containsOnce(
            webClient.el,
            ".o-control-panel button.o-switch-view.active",
            "should have only one active button"
        );
        assert.hasClass(
            webClient.el.querySelector(".o-control-panel .o-switch-view"),
            "o_list",
            "list switch button should be the first one"
        );
        assert.hasClass(
            webClient.el.querySelector(".o-control-panel .o-switch-view.o_list"),
            "active",
            "list should be the active view"
        );
        // switch to kanban view
        await cpHelpers.switchView(webClient.el, "kanban");
        await legacyExtraNextTick();
        assert.containsN(
            webClient.el,
            ".o-control-panel .o-switch-view",
            2,
            "should still have two switch buttons (list and kanban)"
        );
        assert.containsOnce(
            webClient.el,
            ".o-control-panel .o-switch-view.active",
            "should still have only one active button"
        );
        assert.hasClass(
            webClient.el.querySelector(".o-control-panel .o-switch-view"),
            "o_list",
            "list switch button should still be the first one"
        );
        assert.hasClass(
            webClient.el.querySelector(".o-control-panel .o-switch-view.o_kanban"),
            "active",
            "kanban should now be the active view"
        );
        // switch back to list view
        await cpHelpers.switchView(webClient.el, "list");
        await legacyExtraNextTick();
        assert.containsN(
            webClient.el,
            ".o-control-panel .o-switch-view",
            2,
            "should still have two switch buttons (list and kanban)"
        );
        assert.hasClass(
            webClient.el.querySelector(".o-control-panel .o-switch-view.o_list"),
            "active",
            "list should now be the active view"
        );
        // open a record in form view
        await testUtils.dom.click(webClient.el.querySelector(".o-list-view .o-data-row"));
        await legacyExtraNextTick();
        assert.containsNone(
            webClient.el,
            ".o-control-panel .o-switch-view",
            "should not have any switch buttons"
        );
        // go back to list view using the breadcrumbs
        await testUtils.dom.click($(webClient.el).find(".o-control-panel .breadcrumb a"));
        await legacyExtraNextTick();
        assert.containsN(
            webClient.el,
            ".o-control-panel .o-switch-view",
            2,
            "should have two switch buttons (list and kanban)"
        );
        assert.hasClass(
            webClient.el.querySelector(".o-control-panel .o-switch-view.o_list"),
            "active",
            "list should be the active view"
        );
    });
    QUnit.test("pager is updated when switching between views", async function (assert) {
        assert.expect(10);
        const webClient = await createWebClient({ serverData });
        await doAction(webClient, 4);
        assert.strictEqual(
            $(webClient.el).find(".o-control-panel .o-pager-value").text(),
            "1-5",
            "value should be correct for kanban"
        );
        assert.strictEqual(
            $(webClient.el).find(".o-control-panel .o-pager-limit").text(),
            "5",
            "limit should be correct for kanban"
        );
        // switch to list view
        await cpHelpers.switchView(webClient.el, "list");
        await legacyExtraNextTick();
        assert.strictEqual(
            $(webClient.el).find(".o-control-panel .o-pager-value").text(),
            "1-3",
            "value should be correct for list"
        );
        assert.strictEqual(
            $(webClient.el).find(".o-control-panel .o-pager-limit").text(),
            "5",
            "limit should be correct for list"
        );
        // open a record in form view
        await testUtils.dom.click(webClient.el.querySelector(".o-list-view .o-data-row"));
        await legacyExtraNextTick();
        assert.strictEqual(
            $(webClient.el).find(".o-control-panel .o-pager-value").text(),
            "1",
            "value should be correct for form"
        );
        assert.strictEqual(
            $(webClient.el).find(".o-control-panel .o-pager-limit").text(),
            "3",
            "limit should be correct for form"
        );
        // go back to list view using the breadcrumbs
        await testUtils.dom.click(webClient.el.querySelector(".o-control-panel .breadcrumb a"));
        await legacyExtraNextTick();
        assert.strictEqual(
            $(webClient.el).find(".o-control-panel .o-pager-value").text(),
            "1-3",
            "value should be correct for list"
        );
        assert.strictEqual(
            $(webClient.el).find(".o-control-panel .o-pager-limit").text(),
            "5",
            "limit should be correct for list"
        );
        // switch back to kanban view
        await cpHelpers.switchView(webClient.el, "kanban");
        await legacyExtraNextTick();
        assert.strictEqual(
            $(webClient.el).find(".o-control-panel .o-pager-value").text(),
            "1-5",
            "value should be correct for kanban"
        );
        assert.strictEqual(
            $(webClient.el).find(".o-control-panel .o-pager-limit").text(),
            "5",
            "limit should be correct for kanban"
        );
    });

    QUnit.test("domain is kept when switching between views", async function (assert) {
        assert.expect(5);
        serverData.actions[3].searchViewId = [4, "a custom search view"];
        const webClient = await createWebClient({ serverData });
        await doAction(webClient, 3);
        assert.containsN(webClient, ".o-data-row", 5);
        // activate a domain
        await cpHelpers.toggleFilterMenu(webClient.el);
        await cpHelpers.toggleMenuItem(webClient.el, "Bar");
        await legacyExtraNextTick();
        assert.containsN(webClient, ".o-data-row", 2);
        // switch to kanban
        await cpHelpers.switchView(webClient.el, "kanban");
        await legacyExtraNextTick();
        assert.containsN(webClient, ".o-kanban-record:not(.o-kanban-ghost)", 2);
        // remove the domain
        await testUtils.dom.click(webClient.el.querySelector(".o-searchview .o-facet-remove"));
        await legacyExtraNextTick();
        assert.containsN(webClient, ".o-kanban-record:not(.o-kanban-ghost)", 5);
        // switch back to list
        await cpHelpers.switchView(webClient.el, "list");
        await legacyExtraNextTick();
        assert.containsN(webClient, ".o-data-row", 5);
    });

    QUnit.test("A new form view can be reloaded after a failed one", async function (assert) {
        assert.expect(5);
        const webClient = await createWebClient({serverData});

        await doAction(webClient, 3);
        await cpHelpers.switchView(webClient.el, "list");
        assert.containsOnce(webClient, ".o-list-view", "The list view should be displayed");

        // Click on the first record
        await testUtils.dom.click($(webClient.el).find(".o-list-view .o-data-row:first"));
        await legacyExtraNextTick();
        assert.containsOnce(webClient, ".o-form-view", "The form view should be displayed");

        // Delete the current record
        await testUtils.controlPanel.toggleActionMenu(document);
        await testUtils.controlPanel.toggleMenuItem(document, "Delete");
        assert.ok($('.modal').length, 'a confirm modal should be displayed');
        await testUtils.dom.click($('.modal-footer button.btn-primary'));
        await legacyExtraNextTick();

        // The form view is automatically switched to the next record
        // Go back to the previous (now deleted) record
        webClient.env.bus.trigger("test:hashchange", {
            model: "partner",
            id: 1,
            action: 3,
            viewType: "form",
        });
        await legacyExtraNextTick();

        // Go back to the list view
        webClient.env.bus.trigger("test:hashchange", {
            model: "partner",
            action: 3,
            viewType: "list",
        });
        await legacyExtraNextTick();
        await legacyExtraNextTick();
        assert.containsOnce(webClient, ".o-list-view", "should still display the list view");

        await testUtils.dom.click($(webClient.el).find(".o-list-view .o-data-row:first"));
        await legacyExtraNextTick();
        assert.containsOnce(webClient, ".o-form-view",
            "The form view should still load after a previous failed update | reload");
    });

    QUnit.test("there is no flickering when switching between views", async function (assert) {
        assert.expect(20);
        let def;
        const mockRPC = async (route, args) => {
            await def;
        };
        const webClient = await createWebClient({ serverData, mockRPC });
        await doAction(webClient, 3);
        // switch to kanban view
        def = testUtils.makeTestPromise();
        await cpHelpers.switchView(webClient.el, "kanban");
        await legacyExtraNextTick();
        assert.containsOnce(webClient, ".o-list-view", "should still display the list view");
        assert.containsNone(webClient, ".o-kanban-view", "shouldn't display the kanban view yet");
        def.resolve();
        await testUtils.nextTick();
        await legacyExtraNextTick();
        assert.containsNone(webClient, ".o-list-view", "shouldn't display the list view anymore");
        assert.containsOnce(webClient, ".o-kanban-view", "should now display the kanban view");
        // switch back to list view
        def = testUtils.makeTestPromise();
        await cpHelpers.switchView(webClient.el, "list");
        await legacyExtraNextTick();
        assert.containsOnce(webClient, ".o-kanban-view", "should still display the kanban view");
        assert.containsNone(webClient, ".o-list-view", "shouldn't display the list view yet");
        def.resolve();
        await testUtils.nextTick();
        await legacyExtraNextTick();
        assert.containsNone(
            webClient.el,
            ".o-kanban-view",
            "shouldn't display the kanban view anymore"
        );
        assert.containsOnce(webClient, ".o-list-view", "should now display the list view");
        // open a record in form view
        def = testUtils.makeTestPromise();
        await testUtils.dom.click($(webClient.el).find(".o-list-view .o-data-row:first"));
        await legacyExtraNextTick();
        assert.containsOnce(webClient, ".o-list-view", "should still display the list view");
        assert.containsNone(webClient, ".o-form-view", "shouldn't display the form view yet");
        assert.containsOnce(
            webClient.el,
            ".o-control-panel .breadcrumb-item",
            "there should still be one controller in the breadcrumbs"
        );
        def.resolve();
        await testUtils.nextTick();
        await legacyExtraNextTick();
        assert.containsNone(webClient, ".o-list-view", "should no longer display the list view");
        assert.containsOnce(webClient, ".o-form-view", "should display the form view");
        assert.containsN(
            webClient.el,
            ".o-control-panel .breadcrumb-item",
            2,
            "there should be two controllers in the breadcrumbs"
        );
        // go back to list view using the breadcrumbs
        def = testUtils.makeTestPromise();
        await testUtils.dom.click($(webClient.el).find(".o-control-panel .breadcrumb a"));
        await legacyExtraNextTick();
        assert.containsOnce(webClient, ".o-form-view", "should still display the form view");
        assert.containsNone(webClient, ".o-list-view", "shouldn't display the list view yet");
        assert.containsN(
            webClient.el,
            ".o-control-panel .breadcrumb-item",
            2,
            "there should still be two controllers in the breadcrumbs"
        );
        def.resolve();
        await testUtils.nextTick();
        await legacyExtraNextTick();
        assert.containsNone(webClient, ".o-form-view", "should no longer display the form view");
        assert.containsOnce(webClient, ".o-list-view", "should display the list view");
        assert.containsOnce(
            webClient.el,
            ".o-control-panel .breadcrumb-item",
            "there should be one controller in the breadcrumbs"
        );
    });

    QUnit.test("breadcrumbs are updated when displayName changes", async function (assert) {
        assert.expect(4);
        const webClient = await createWebClient({ serverData });
        await doAction(webClient, 3);
        // open a record in form view
        await testUtils.dom.click(webClient.el.querySelector(".o-list-view .o-data-row"));
        await legacyExtraNextTick();
        assert.containsN(
            webClient.el,
            ".o-control-panel .breadcrumb-item",
            2,
            "there should be two controllers in the breadcrumbs"
        );
        assert.strictEqual(
            $(webClient.el).find(".o-control-panel .breadcrumb-item:last").text(),
            "First record",
            "breadcrumbs should contain the displayName of the opened record"
        );
        // switch to edit mode and change the displayName
        await testUtils.dom.click($(webClient.el).find(".o-control-panel .o-form-button_edit"));
        await testUtils.fields.editInput(
            webClient.el.querySelector(".o-field-widget[name=displayName]"),
            "New name"
        );
        await testUtils.dom.click(
            webClient.el.querySelector(".o-control-panel .o-form-button-save")
        );
        assert.containsN(
            webClient.el,
            ".o-control-panel .breadcrumb-item",
            2,
            "there should still be two controllers in the breadcrumbs"
        );
        assert.strictEqual(
            $(webClient.el).find(".o-control-panel .breadcrumb-item:last").text(),
            "New name",
            "breadcrumbs should contain the displayName of the opened record"
        );
    });

    QUnit.test('reverse breadcrumb works on accesskey "b"', async function (assert) {
        assert.expect(4);
        const webClient = await createWebClient({ serverData });
        await doAction(webClient, 3);
        // open a record in form view
        await testUtils.dom.click($(webClient.el).find(".o-list-view .o-data-row:first"));
        await legacyExtraNextTick();
        await testUtils.dom.click(
            $(webClient.el).find(".o-form-view button:contains(Execute action)")
        );
        await legacyExtraNextTick();
        assert.containsN(webClient, ".o-control-panel .breadcrumb li", 3);
        var $previousBreadcrumb = $(webClient.el)
            .find(".o-control-panel .breadcrumb li.active")
            .prev();
        assert.strictEqual(
            $previousBreadcrumb.attr("accesskey"),
            "b",
            "previous breadcrumb should have accessKey 'b'"
        );
        await testUtils.dom.click($previousBreadcrumb);
        await legacyExtraNextTick();
        assert.containsN(webClient, ".o-control-panel .breadcrumb li", 2);
        var $previousBreadcrumb = $(webClient.el)
            .find(".o-control-panel .breadcrumb li.active")
            .prev();
        assert.strictEqual(
            $previousBreadcrumb.attr("accesskey"),
            "b",
            "previous breadcrumb should have accessKey 'b'"
        );
    });

    QUnit.test("reload previous controller when discarding a new record", async function (assert) {
        assert.expect(9);
        const mockRPC = async (route, args) => {
            assert.step((args && args.method) || route);
        };
        const webClient = await createWebClient({ serverData, mockRPC });
        await doAction(webClient, 3);
        // create a new record
        await testUtils.dom.click($(webClient.el).find(".o-control-panel .o-list-button-add"));
        await legacyExtraNextTick();
        assert.containsOnce(
            webClient.el,
            ".o-form-view.o-form-editable",
            "should have opened the form view in edit mode"
        );
        // discard
        await testUtils.dom.click($(webClient.el).find(".o-control-panel .o-form-button_cancel"));
        await legacyExtraNextTick();
        assert.containsOnce(
            webClient.el,
            ".o-list-view",
            "should have switched back to the list view"
        );
        assert.verifySteps([
            "/web/webclient/loadMenus",
            "/web/action/load",
            "load_views",
            "/web/dataset/searchRead",
            "onchange",
            "/web/dataset/searchRead",
        ]);
    });

    QUnit.test("requests for execute_action of type object are handled", async function (assert) {
        assert.expect(11);
        patchWithCleanup(session.userContext, { some_key: 2 });
        const mockRPC = async (route, args) => {
            assert.step((args && args.method) || route);
            if (route === "/web/dataset/call_button") {
                assert.deepEqual(
                    args,
                    {
                        args: [[1]],
                        kwargs: {
                            context: {
                                lang: "en",
                                uid: 7,
                                tz: "taht",
                                some_key: 2,
                            },
                        },
                        method: "object",
                        model: "partner",
                    },
                    "should call route with correct arguments"
                );
                const record = serverData.models.partner.records.find(
                    (r) => r.id === args.args[0][0]
                );
                record.foo = "value changed";
                return Promise.resolve(false);
            }
        };
        const webClient = await createWebClient({ serverData, mockRPC });
        await doAction(webClient, 3);
        // open a record in form view
        await testUtils.dom.click($(webClient.el).find(".o-list-view .o-data-row:first"));
        await legacyExtraNextTick();
        assert.strictEqual(
            $(webClient.el).find(".o-field-widget[name=foo]").text(),
            "yop",
            "check initial value of 'yop' field"
        );
        // click on 'Call method' button (should call an Object method)
        await testUtils.dom.click(
            $(webClient.el).find(".o-form-view button:contains(Call method)")
        );
        await legacyExtraNextTick();
        assert.strictEqual(
            $(webClient.el).find(".o-field-widget[name=foo]").text(),
            "value changed",
            "'yop' has been changed by the server, and should be updated in the UI"
        );
        assert.verifySteps([
            "/web/webclient/loadMenus",
            "/web/action/load",
            "load_views",
            "/web/dataset/searchRead",
            "read",
            "object",
            "read",
        ]);
    });

    QUnit.test(
        "requests for execute_action of type object: disable buttons (2)",
        async function (assert) {
            assert.expect(6);
            serverData.views["pony,44,form"] = `
    <form>
    <field name="label"/>
    <button string="Cancel" class="cancel-btn" special="cancel"/>
    </form>`;
            serverData.actions[4] = {
                id: 4,
                label: "Create a Partner",
                resModel: "pony",
                target: "new",
                type: "ir.actions.actwindow",
                views: [[44, "form"]],
            };
            const def = testUtils.makeTestPromise();
            const mockRPC = async (route, args) => {
                if (args.method === "onchange") {
                    // delay the opening of the dialog
                    await def;
                }
            };
            const webClient = await createWebClient({ serverData, mockRPC });
            await doAction(webClient, 3);
            assert.containsOnce(webClient.el, ".o-list-view");
            // open first record in form view
            await testUtils.dom.click(webClient.el.querySelector(".o-list-view .o-data-row"));
            await legacyExtraNextTick();
            assert.containsOnce(webClient.el, ".o-form-view");
            // click on 'Execute action', to execute action 4 in a dialog
            await testUtils.dom.click(webClient.el.querySelector('.o-form-view button[name="4"]'));
            await legacyExtraNextTick();
            assert.ok(
                webClient.el.querySelector(".o-cp-buttons .o-form-button_edit").disabled,
                "control panel buttons should be disabled"
            );
            def.resolve();
            await nextTick();
            await legacyExtraNextTick();
            assert.containsOnce(webClient.el, ".modal .o-form-view");
            assert.notOk(
                webClient.el.querySelector(".o-cp-buttons .o-form-button_edit").disabled,
                "control panel buttons should have been re-enabled"
            );
            await testUtils.dom.click(webClient.el.querySelector(".modal .cancel-btn"));
            await legacyExtraNextTick();
            assert.notOk(
                webClient.el.querySelector(".o-cp-buttons .o-form-button_edit").disabled,
                "control panel buttons should still be enabled"
            );
        }
    );

    QUnit.test(
        "requests for execute_action of type object raises error: re-enables buttons",
        async function (assert) {
            assert.expect(3);
            const mockRPC = async (route, args) => {
                if (route === "/web/dataset/call_button") {
                    return Promise.reject();
                }
            };
            const webClient = await createWebClient({ serverData, mockRPC });
            await doAction(webClient, 3, { viewType: "form" });
            assert.containsOnce(webClient.el, ".o-form-view");
            // click on 'Execute action', to execute action 4 in a dialog
            testUtils.dom.click(webClient.el.querySelector('.o-form-view button[name="object"]'));
            assert.ok(webClient.el.querySelector(".o-cp-buttons button").disabled);
            await nextTick();
            await legacyExtraNextTick();
            assert.notOk(webClient.el.querySelector(".o-cp-buttons button").disabled);
        }
    );

    QUnit.test(
        "requests for execute_action of type object raises error in modal: re-enables buttons",
        async function (assert) {
            assert.expect(5);
            serverData.views["partner,false,form"] = `
        <form>
          <field name="displayName"/>
          <footer>
            <button name="object" string="Call method" type="object"/>
          </footer>
        </form>
      `;
            const mockRPC = async (route, args) => {
                if (route === "/web/dataset/call_button") {
                    return Promise.reject();
                }
            };
            const webClient = await createWebClient({ serverData, mockRPC });
            await doAction(webClient, 5);
            assert.containsOnce(webClient.el, ".modal .o-form-view");
            testUtils.dom.click(webClient.el.querySelector('.modal footer button[name="object"]'));
            assert.containsOnce(webClient.el, ".modal .o-form-view");
            assert.ok(webClient.el.querySelector(".modal footer button").disabled);
            await testUtils.nextTick();
            await legacyExtraNextTick();
            assert.containsOnce(webClient.el, ".modal .o-form-view");
            assert.notOk(webClient.el.querySelector(".modal footer button").disabled);
        }
    );

    QUnit.test("requests for execute_action of type action are handled", async function (assert) {
        assert.expect(12);
        const mockRPC = async (route, args) => {
            assert.step((args && args.method) || route);
        };
        const webClient = await createWebClient({ serverData, mockRPC });
        await doAction(webClient, 3);
        // open a record in form view
        await testUtils.dom.click($(webClient.el).find(".o-list-view .o-data-row:first"));
        await legacyExtraNextTick();
        // click on 'Execute action' button (should execute an action)
        assert.containsN(
            webClient.el,
            ".o-control-panel .breadcrumb-item",
            2,
            "there should be two parts in the breadcrumbs"
        );
        await testUtils.dom.click(
            $(webClient.el).find(".o-form-view button:contains(Execute action)")
        );
        await legacyExtraNextTick();
        assert.containsN(
            webClient.el,
            ".o-control-panel .breadcrumb-item",
            3,
            "the returned action should have been stacked over the previous one"
        );
        assert.containsOnce(
            webClient.el,
            ".o-kanban-view",
            "the returned action should have been executed"
        );
        assert.verifySteps([
            "/web/webclient/loadMenus",
            "/web/action/load",
            "load_views",
            "/web/dataset/searchRead",
            "read",
            "/web/action/load",
            "load_views",
            "/web/dataset/searchRead",
        ]);
    });

    QUnit.test("execute smart button and back", async function (assert) {
        assert.expect(8);
        const mockRPC = async (route, args) => {
            if (args.method === "read") {
                assert.notOk("default_partner" in args.kwargs.context);
            }
            if (route === "/web/dataset/searchRead") {
                assert.strictEqual(args.context.default_partner, 2);
            }
        };
        const webClient = await createWebClient({ serverData, mockRPC });
        await doAction(webClient, 24);
        assert.containsOnce(webClient.el, ".o-form-view");
        assert.containsN(webClient.el, ".o-form-buttons-view button:not([disabled])", 2);
        await testUtils.dom.click(webClient.el.querySelector(".oe-stat-button"));
        await legacyExtraNextTick();
        assert.containsOnce(webClient.el, ".o-kanban-view");
        await testUtils.dom.click(webClient.el.querySelector(".breadcrumb-item"));
        await legacyExtraNextTick();
        assert.containsOnce(webClient.el, ".o-form-view");
        assert.containsN(webClient.el, ".o-form-buttons-view button:not([disabled])", 2);
    });

    QUnit.test("execute smart button and fails", async function (assert) {
        assert.expect(12);
        const mockRPC = async (route, args) => {
            assert.step(route);
            if (route === "/web/dataset/searchRead") {
                return Promise.reject();
            }
        };
        const webClient = await createWebClient({ serverData, mockRPC });
        await doAction(webClient, 24);
        assert.containsOnce(webClient.el, ".o-form-view");
        assert.containsN(webClient.el, ".o-form-buttons-view button:not([disabled])", 2);
        await testUtils.dom.click(webClient.el.querySelector(".oe-stat-button"));
        await legacyExtraNextTick();
        assert.containsOnce(webClient.el, ".o-form-view");
        assert.containsN(webClient.el, ".o-form-buttons-view button:not([disabled])", 2);
        assert.verifySteps([
            "/web/webclient/loadMenus",
            "/web/action/load",
            "/web/dataset/callKw/partner/load_views",
            "/web/dataset/callKw/partner/read",
            "/web/action/load",
            "/web/dataset/callKw/partner/load_views",
            "/web/dataset/searchRead",
        ]);
    });

    QUnit.test(
        "requests for execute_action of type object: disable buttons",
        async function (assert) {
            assert.expect(2);
            let def;
            const mockRPC = async (route, args) => {
                if (route === "/web/dataset/call_button") {
                    return Promise.resolve(false);
                } else if (args && args.method === "read") {
                    await def; // block the 'read' call
                }
            };
            const webClient = await createWebClient({ serverData, mockRPC });
            await doAction(webClient, 3);
            // open a record in form view
            await testUtils.dom.click($(webClient.el).find(".o-list-view .o-data-row:first"));
            await legacyExtraNextTick();
            // click on 'Call method' button (should call an Object method)
            def = testUtils.makeTestPromise();
            await testUtils.dom.click(
                $(webClient.el).find(".o-form-view button:contains(Call method)")
            );
            await legacyExtraNextTick();
            // Buttons should be disabled
            assert.strictEqual(
                $(webClient.el).find(".o-form-view button:contains(Call method)").attr("disabled"),
                "disabled",
                "buttons should be disabled"
            );
            // Release the 'read' call
            def.resolve();
            await testUtils.nextTick();
            await legacyExtraNextTick();
            // Buttons should be enabled after the reload
            assert.strictEqual(
                $(webClient.el).find(".o-form-view button:contains(Call method)").attr("disabled"),
                undefined,
                "buttons should not be disabled anymore"
            );
        }
    );

    QUnit.test("can open different records from a multi record view", async function (assert) {
        assert.expect(12);
        const mockRPC = async (route, args) => {
            assert.step((args && args.method) || route);
        };
        const webClient = await createWebClient({ serverData, mockRPC });
        await doAction(webClient, 3);
        // open the first record in form view
        await testUtils.dom.click($(webClient.el).find(".o-list-view .o-data-row:first"));
        await legacyExtraNextTick();
        assert.strictEqual(
            $(webClient.el).find(".o-control-panel .breadcrumb-item:last").text(),
            "First record",
            "breadcrumbs should contain the displayName of the opened record"
        );
        assert.strictEqual(
            $(webClient.el).find(".o-field-widget[name=foo]").text(),
            "yop",
            "should have opened the correct record"
        );
        // go back to list view using the breadcrumbs
        await testUtils.dom.click($(webClient.el).find(".o-control-panel .breadcrumb a"));
        await legacyExtraNextTick();
        // open the second record in form view
        await testUtils.dom.click($(webClient.el).find(".o-list-view .o-data-row:nth(1)"));
        await legacyExtraNextTick();
        assert.strictEqual(
            $(webClient.el).find(".o-control-panel .breadcrumb-item:last").text(),
            "Second record",
            "breadcrumbs should contain the displayName of the opened record"
        );
        assert.strictEqual(
            $(webClient.el).find(".o-field-widget[name=foo]").text(),
            "blip",
            "should have opened the correct record"
        );
        assert.verifySteps([
            "/web/webclient/loadMenus",
            "/web/action/load",
            "load_views",
            "/web/dataset/searchRead",
            "read",
            "/web/dataset/searchRead",
            "read",
        ]);
    });

    QUnit.test("restore previous view state when switching back", async function (assert) {
        assert.expect(5);
        serverData.actions[3].views.unshift([false, "graph"]);
        serverData.views["partner,false,graph"] = "<graph/>";
        const webClient = await createWebClient({ serverData });
        await doAction(webClient, 3);
        assert.hasClass(
            $(webClient.el).find(".o-control-panel  .fa-bar-chart-o")[0],
            "active",
            "bar chart button is active"
        );
        assert.doesNotHaveClass(
            $(webClient.el).find(".o-control-panel  .fa-area-chart")[0],
            "active",
            "line chart button is not active"
        );
        // display line chart
        await testUtils.dom.click($(webClient.el).find(".o-control-panel  .fa-area-chart"));
        await legacyExtraNextTick();
        assert.hasClass(
            $(webClient.el).find(".o-control-panel  .fa-area-chart")[0],
            "active",
            "line chart button is now active"
        );
        // switch to kanban and back to graph view
        await cpHelpers.switchView(webClient.el, "kanban");
        await legacyExtraNextTick();
        assert.containsNone(
            webClient.el,
            ".o-control-panel  .fa-area-chart",
            "graph buttons are no longer in control panel"
        );
        await cpHelpers.switchView(webClient.el, "graph");
        await legacyExtraNextTick();
        assert.hasClass(
            $(webClient.el).find(".o-control-panel  .fa-area-chart")[0],
            "active",
            "line chart button is still active"
        );
    });

    QUnit.test("view switcher is properly highlighted in graph view", async function (assert) {
        assert.expect(4);
        serverData.actions[3].views.splice(1, 1, [false, "graph"]);
        serverData.views["partner,false,graph"] = "<graph/>";
        const webClient = await createWebClient({ serverData });
        await doAction(webClient, 3);
        assert.hasClass(
            $(webClient.el).find(".o-control-panel .o-switch-view.o_list")[0],
            "active",
            "list button in control panel is active"
        );
        assert.doesNotHaveClass(
            $(webClient.el).find(".o-control-panel .o-switch-view.o_graph")[0],
            "active",
            "graph button in control panel is not active"
        );
        // switch to graph view
        await cpHelpers.switchView(webClient.el, "graph");
        await legacyExtraNextTick();
        assert.doesNotHaveClass(
            $(webClient.el).find(".o-control-panel .o-switch-view.o_list")[0],
            "active",
            "list button in control panel is not active"
        );
        assert.hasClass(
            $(webClient.el).find(".o-control-panel .o-switch-view.o_graph")[0],
            "active",
            "graph button in control panel is active"
        );
    });

    QUnit.test("can interact with search view", async function (assert) {
        assert.expect(2);
        serverData.views["partner,false,search"] = `
      <search>
        <group>
          <filter name="foo" string="foo" context="{'groupby': 'foo'}"/>
        </group>
      </search>`;
        const webClient = await createWebClient({ serverData });
        await doAction(webClient, 3);
        assert.doesNotHaveClass(
            $(webClient.el).find(".o-list-table")[0],
            "o-list-table_grouped",
            "list view is not grouped"
        );
        // open group by dropdown
        await cpHelpers.toggleGroupByMenu(webClient);
        // click on foo link
        await cpHelpers.toggleMenuItem(webClient.el, "foo");
        await legacyExtraNextTick();
        assert.hasClass(
            $(webClient.el).find(".o-list-table")[0],
            "o-list-table_grouped",
            "list view is now grouped"
        );
    });

    QUnit.test("can open a many2one external window", async function (assert) {
        assert.expect(9);
        serverData.models.partner.records[0].bar = 2;
        serverData.views["partner,false,search"] = `
      <search>
        <group>
          <filter name="foo" string="foo" context="{'groupby': 'foo'}"/>
        </group>
      </search>`;
        serverData.views["partner,false,form"] = `
      <form>
        <field name="foo"/>
        <field name="bar"/>
      </form>`;
        const mockRPC = async (route, args) => {
            assert.step(route);
            if (args && args.method === "get_formview_id") {
                return Promise.resolve(false);
            }
        };
        const webClient = await createWebClient({ serverData, mockRPC });
        await doAction(webClient, 3);
        // open first record in form view
        await testUtils.dom.click($(webClient.el).find(".o-data-row:first"));
        await legacyExtraNextTick();
        // click on edit
        await testUtils.dom.click($(webClient.el).find(".o-control-panel .o-form-button_edit"));
        await legacyExtraNextTick();
        // click on external button for m2o
        await testUtils.dom.click($(webClient.el).find(".o-external-button"));
        await legacyExtraNextTick();
        assert.verifySteps([
            "/web/webclient/loadMenus",
            "/web/action/load",
            "/web/dataset/callKw/partner/load_views",
            "/web/dataset/searchRead",
            "/web/dataset/callKw/partner/read",
            "/web/dataset/callKw/partner/get_formview_id",
            "/web/dataset/callKw/partner",
            "/web/dataset/callKw/partner/read",
        ]);
    });

    QUnit.test('save when leaving a "dirty" view', async function (assert) {
        assert.expect(4);
        const mockRPC = async (route, { args, method, model }) => {
            if (model === "partner" && method === "write") {
                assert.deepEqual(args, [[1], { foo: "pinkypie" }]);
            }
        };
        const webClient = await createWebClient({ serverData, mockRPC });
        await doAction(webClient, 4);
        // open record in form view
        await testUtils.dom.click($(webClient.el).find(".o-kanban-record:first")[0]);
        await legacyExtraNextTick();
        // edit record
        await testUtils.dom.click(
            $(webClient.el).find(".o-control-panel button.o-form-button_edit")
        );
        await testUtils.fields.editInput($(webClient.el).find('input[name="foo"]'), "pinkypie");
        // go back to kanban view
        await testUtils.dom.click(
            $(webClient.el).find(".o-control-panel .breadcrumb-item:first a")
        );
        await legacyExtraNextTick();
        assert.containsNone(document.body, ".modal", "should not display a modal dialog");
        assert.containsNone(webClient, ".o-form-view", "should no longer be in form view");
        assert.containsOnce(webClient, ".o-kanban-view", "should be in kanban view");
    });

    QUnit.test("limit set in action is passed to each created controller", async function (assert) {
        assert.expect(2);
        serverData.actions[3].limit = 2;
        const webClient = await createWebClient({ serverData });
        await doAction(webClient, 3);
        assert.containsN(webClient, ".o-data-row", 2);
        // switch to kanban view
        await cpHelpers.switchView(webClient.el, "kanban");
        await legacyExtraNextTick();
        assert.containsN(webClient, ".o-kanban-record:not(.o-kanban-ghost)", 2);
    });

    QUnit.test("go back to a previous action using the breadcrumbs", async function (assert) {
        assert.expect(10);
        const webClient = await createWebClient({ serverData });
        await doAction(webClient, 3);
        // open a record in form view
        await testUtils.dom.click($(webClient.el).find(".o-list-view .o-data-row:first"));
        await legacyExtraNextTick();
        assert.containsN(
            webClient.el,
            ".o-control-panel .breadcrumb-item",
            2,
            "there should be two controllers in the breadcrumbs"
        );
        assert.strictEqual(
            $(webClient.el).find(".o-control-panel .breadcrumb-item:last").text(),
            "First record",
            "breadcrumbs should contain the displayName of the opened record"
        );
        // push another action on top of the first one, and come back to the form view
        await doAction(webClient, 4);
        assert.containsN(
            webClient.el,
            ".o-control-panel .breadcrumb-item",
            3,
            "there should be three controllers in the breadcrumbs"
        );
        assert.strictEqual(
            $(webClient.el).find(".o-control-panel .breadcrumb-item:last").text(),
            "Partners Action 4",
            "breadcrumbs should contain the name of the current action"
        );
        // go back using the breadcrumbs
        await testUtils.dom.click($(webClient.el).find(".o-control-panel .breadcrumb a:nth(1)"));
        await legacyExtraNextTick();
        assert.containsN(
            webClient.el,
            ".o-control-panel .breadcrumb-item",
            2,
            "there should be two controllers in the breadcrumbs"
        );
        assert.strictEqual(
            $(webClient.el).find(".o-control-panel .breadcrumb-item:last").text(),
            "First record",
            "breadcrumbs should contain the displayName of the opened record"
        );
        // push again the other action on top of the first one, and come back to the list view
        await doAction(webClient, 4);
        assert.containsN(
            webClient.el,
            ".o-control-panel .breadcrumb-item",
            3,
            "there should be three controllers in the breadcrumbs"
        );
        assert.strictEqual(
            $(webClient.el).find(".o-control-panel .breadcrumb-item:last").text(),
            "Partners Action 4",
            "breadcrumbs should contain the name of the current action"
        );
        // go back using the breadcrumbs
        await testUtils.dom.click($(webClient.el).find(".o-control-panel .breadcrumb a:first"));
        await legacyExtraNextTick();
        assert.containsN(
            webClient.el,
            ".o-control-panel .breadcrumb-item",
            1,
            "there should be one controller in the breadcrumbs"
        );
        assert.strictEqual(
            $(webClient.el).find(".o-control-panel .breadcrumb-item:last").text(),
            "Partners",
            "breadcrumbs should contain the name of the current action"
        );
    });

    QUnit.test(
        "form views are restored in readonly when coming back in breadcrumbs",
        async function (assert) {
            assert.expect(2);
            const webClient = await createWebClient({ serverData });
            await doAction(webClient, 3);
            // open a record in form view
            await testUtils.dom.click($(webClient.el).find(".o-list-view .o-data-row:first"));
            await legacyExtraNextTick();
            // switch to edit mode
            await testUtils.dom.click($(webClient.el).find(".o-control-panel .o-form-button_edit"));
            await legacyExtraNextTick();
            assert.hasClass($(webClient.el).find(".o-form-view")[0], "o-form-editable");
            // do some other action
            await doAction(webClient, 4);
            // go back to form view
            await testUtils.dom.clickLast($(webClient.el).find(".o-control-panel .breadcrumb a"));
            await legacyExtraNextTick();
            assert.hasClass($(webClient.el).find(".o-form-view")[0], "o-form-readonly");
        }
    );

    QUnit.test(
        "form views are restored with the correct id in its url when coming back in breadcrumbs",
        async function (assert) {
            assert.expect(3);
            const webClient = await createWebClient({ serverData });
            await doAction(webClient, 3);
            // open a record in form view
            await testUtils.dom.click($(webClient.el).find(".o-list-view .o-data-row:first"));
            await legacyExtraNextTick();
            assert.strictEqual(webClient.env.services.router.current.hash.id, 1);
            // do some other action
            await doAction(webClient, 4);
            assert.notOk(webClient.env.services.router.current.hash.id);
            // go back to form view
            await testUtils.dom.clickLast($(webClient.el).find(".o-control-panel .breadcrumb a"));
            await legacyExtraNextTick();
            assert.strictEqual(webClient.env.services.router.current.hash.id, 1);
        }
    );

    QUnit.test("honor groupby specified in actions context", async function (assert) {
        assert.expect(5);
        serverData.actions[3].context = "{'groupby': 'bar'}";
        serverData.views["partner,false,search"] = `
      <search>
        <group>
          <filter name="foo" string="foo" context="{'groupby': 'foo'}"/>
        </group>
      </search>`;
        const webClient = await createWebClient({ serverData });
        await doAction(webClient, 3);
        assert.containsOnce(webClient, ".o-list-table_grouped", "should be grouped");
        assert.containsN(
            webClient.el,
            ".o-group-header",
            2,
            "should be grouped by 'bar' (two groups) at first load"
        );
        // groupby 'bar' using the searchView
        await testUtils.dom.click(
            $(webClient.el).find(".o-control-panel .o-cp-bottom-right button:contains(Group By)")
        );
        await testUtils.dom.click(
            $(webClient.el).find(".o-control-panel .o-group-by-menu .o-menu-item:first")
        );
        await legacyExtraNextTick();
        assert.containsN(
            webClient.el,
            ".o-group-header",
            5,
            "should be grouped by 'foo' (five groups)"
        );
        // remove the groupby in the searchView
        await testUtils.dom.click(
            $(webClient.el).find(".o-control-panel .o-searchview .o-facet-remove")
        );
        await legacyExtraNextTick();
        assert.containsOnce(webClient, ".o-list-table_grouped", "should still be grouped");
        assert.containsN(
            webClient.el,
            ".o-group-header",
            2,
            "should be grouped by 'bar' (two groups) at reload"
        );
    });

    QUnit.test("switch request to unknown view type", async function (assert) {
        assert.expect(8);
        serverData.actions[33] = {
            id: 33,
            label: "Partners",
            resModel: "partner",
            type: "ir.actions.actwindow",
            views: [
                [false, "list"],
                [1, "kanban"],
            ],
        };
        const mockRPC = async (route, args) => {
            assert.step((args && args.method) || route);
        };
        const webClient = await createWebClient({ serverData, mockRPC });
        await doAction(webClient, 33);
        assert.containsOnce(webClient, ".o-list-view", "should display the list view");
        // try to open a record in a form view
        testUtils.dom.click($(webClient.el).find(".o-list-view .o-data-row:first"));
        await legacyExtraNextTick();
        assert.containsOnce(webClient, ".o-list-view", "should still display the list view");
        assert.containsNone(webClient, ".o-form-view", "should not display the form view");
        assert.verifySteps([
            "/web/webclient/loadMenus",
            "/web/action/load",
            "load_views",
            "/web/dataset/searchRead",
        ]);
    });

    QUnit.test("flags field of ir.actions.actwindow is used", async function (assert) {
        // more info about flags field : https://github.com/verp/verp/commit/c9b133813b250e89f1f61816b0eabfb9bee2009d
        assert.expect(7);
        serverData.actions[44] = {
            id: 33,
            label: "Partners",
            resModel: "partner",
            type: "ir.actions.actwindow",
            flags: {
                withControlPanel: false,
            },
            views: [[false, "form"]],
        };
        const mockRPC = async (route, args) => {
            assert.step((args && args.method) || route);
        };
        const webClient = await createWebClient({ serverData, mockRPC });
        await doAction(webClient, 44);
        assert.containsOnce(webClient, ".o-form-view", "should display the form view");
        assert.containsNone(
            document.body,
            ".o-control-panel",
            "should not display the control panel"
        );

        assert.verifySteps([
            "/web/webclient/loadMenus",
            "/web/action/load",
            "load_views",
            "onchange",
        ]);
    });

    QUnit.test("save current search", async function (assert) {
        assert.expect(4);
        testUtils.mock.patch(ListController, {
            getOwnedQueryParams: function () {
                return {
                    context: {
                        shouldBeInFilterContext: true,
                    },
                };
            },
        });
        serverData.actions[33] = {
            id: 33,
            context: {
                shouldNotBeInFilterContext: false,
            },
            label: "Partners",
            resModel: "partner",
            searchViewId: [4, "a custom search view"],
            type: "ir.actions.actwindow",
            views: [[false, "list"]],
        };
        const legacyParams = {
            dataManager: {
                create_filter: function (filter) {
                    assert.strictEqual(
                        filter.domain,
                        `[("bar", "=", 1)]`,
                        "should save the correct domain"
                    );
                    const expectedContext = {
                        groupby: [],
                        shouldBeInFilterContext: true,
                    };
                    assert.deepEqual(
                        filter.context,
                        expectedContext,
                        "should save the correct context"
                    );
                },
            },
        };
        patchWithCleanup(browser, { setTimeout: (fn) => fn() });
        const webClient = await createWebClient({ serverData, legacyParams });
        await doAction(webClient, 33);
        assert.containsN(webClient, ".o-data-row", 5, "should contain 5 records");
        // filter on bar
        await cpHelpers.toggleFilterMenu(webClient.el);
        await cpHelpers.toggleMenuItem(webClient.el, "Bar");
        assert.containsN(webClient, ".o-data-row", 2);
        // save filter
        await cpHelpers.toggleFavoriteMenu(webClient.el);
        await cpHelpers.toggleSaveFavorite(webClient.el);
        await cpHelpers.editFavoriteName(webClient.el, "some name");
        await cpHelpers.saveFavorite(webClient.el);
        await legacyExtraNextTick();
        testUtils.mock.unpatch(ListController);
    });

    QUnit.test(
        "list with defaultOrder and favorite filter with no orderedBy",
        async function (assert) {
            assert.expect(5);
            serverData.views["partner,1,list"] =
                '<tree defaultOrder="foo desc"><field name="foo"/></tree>';
            serverData.actions[100] = {
                id: 100,
                label: "Partners",
                resModel: "partner",
                type: "ir.actions.actwindow",
                views: [
                    [1, "list"],
                    [false, "form"],
                ],
            };
            serverData.models.partner.filters = [
                {
                    label: "favorite filter",
                    id: 5,
                    context: "{}",
                    sort: "[]",
                    domain: '[("bar", "=", 1)]',
                    is_default: false,
                },
            ];
            const webClient = await createWebClient({ serverData });
            await doAction(webClient, 100);
            assert.strictEqual(
                $(webClient.el).find(".o-list-view tr.o-data-row .o-data-cell").text(),
                "zoupyopplopgnapblip",
                "record should be in descending order as defaultOrder applies"
            );
            await cpHelpers.toggleFavoriteMenu(webClient.el);
            await cpHelpers.toggleMenuItem(webClient.el, "favorite filter");
            await legacyExtraNextTick();
            assert.strictEqual(
                $(webClient.el).find(".o-control-panel .o-facet-values").text().trim(),
                "favorite filter",
                "favorite filter should be applied"
            );
            assert.strictEqual(
                $(webClient.el).find(".o-list-view tr.o-data-row .o-data-cell").text(),
                "gnapblip",
                "record should still be in descending order after defaultOrder applied"
            );
            // go to formview and come back to listview
            await testUtils.dom.click($(webClient.el).find(".o-list-view .o-data-row:first"));
            await legacyExtraNextTick();
            await testUtils.dom.click($(webClient.el).find(".o-control-panel .breadcrumb a:eq(0)"));
            await legacyExtraNextTick();
            assert.strictEqual(
                $(webClient.el).find(".o-list-view tr.o-data-row .o-data-cell").text(),
                "gnapblip",
                "order of records should not be changed, while coming back through breadcrumb"
            );
            // remove filter
            await cpHelpers.removeFacet(webClient.el, 0);
            await legacyExtraNextTick();
            assert.strictEqual(
                $(webClient.el).find(".o-list-view tr.o-data-row .o-data-cell").text(),
                "zoupyopplopgnapblip",
                "order of records should not be changed, after removing current filter"
            );
        }
    );

    QUnit.test("pivot view with default favorite and context.activeId", async function (assert) {
        // note: we use a pivot view because we need a owl view
        assert.expect(4);

        serverData.views["partner,false,pivot"] = "<pivot/>";
        serverData.actions[3].views = [[false, "pivot"]];
        serverData.actions[3].context = { activeId: 4, activeIds: [4], activeModel: "whatever" };
        serverData.models.partner.filters = [
            {
                label: "favorite filter",
                id: 5,
                context: "{}",
                sort: "[]",
                domain: '[("bar", "=", 1)]',
                is_default: true,
            },
        ];
        registry.category("services").add("user", makeFakeUserService());
        const mockRPC = (route, args) => {
            if (args.method === "readGroup") {
                assert.deepEqual(args.kwargs.domain, [["bar", "=", 1]]);
            }
        };
        const webClient = await createWebClient({ serverData, mockRPC });
        await doAction(webClient, 3);

        assert.containsOnce(webClient.el, ".o-pivot-view");
        assert.containsOnce(webClient.el, ".o-searchview .o-searchview-facet");
        assert.strictEqual(
            webClient.el.querySelector(".o-facet-value").innerText,
            "favorite filter"
        );
    });

    QUnit.test(
        "search menus are still available when switching between actions",
        async function (assert) {
            assert.expect(3);
            const webClient = await createWebClient({ serverData });
            await doAction(webClient, 1);
            assert.isVisible(
                webClient.el.querySelector(".o-search-options .dropdown.o-filter-menu"),
                "the search options should be available"
            );
            await doAction(webClient, 3);
            assert.isVisible(
                webClient.el.querySelector(".o-search-options .dropdown.o-filter-menu"),
                "the search options should be available"
            );
            // go back using the breadcrumbs
            await testUtils.dom.click($(webClient.el).find(".o-control-panel .breadcrumb a:first"));
            await legacyExtraNextTick();
            assert.isVisible(
                webClient.el.querySelector(".o-search-options .dropdown.o-filter-menu"),
                "the search options should be available"
            );
        }
    );

    QUnit.test("current actwindow action is stored in session_storage", async function (assert) {
        assert.expect(1);
        const expectedAction = serverData.actions[3];
        patchWithCleanup(browser, {
            sessionStorage: Object.assign(Object.create(sessionStorage), {
                setItem(k, value) {
                    assert.deepEqual(
                        JSON.parse(value),
                        expectedAction,
                        "should store the executed action in the sessionStorage"
                    );
                },
            }),
        });
        const webClient = await createWebClient({ serverData });
        await doAction(webClient, 3);
    });

    QUnit.test("destroy action with lazy loaded controller", async function (assert) {
        assert.expect(6);
        const webClient = await createWebClient({ serverData });
        await loadState(webClient, {
            action: 3,
            id: 2,
            viewType: "form",
        });
        assert.containsNone(webClient, ".o-list-view");
        assert.containsOnce(webClient, ".o-form-view");
        assert.containsN(
            webClient.el,
            ".o-control-panel .breadcrumb-item",
            2,
            "there should be two controllers in the breadcrumbs"
        );
        assert.strictEqual(
            $(webClient.el).find(".o-control-panel .breadcrumb-item:last").text(),
            "Second record",
            "breadcrumbs should contain the displayName of the opened record"
        );
        await doAction(webClient, 1, { clearBreadcrumbs: true });
        assert.containsNone(webClient, ".o-form-view");
        assert.containsOnce(webClient, ".o-kanban-view");
    });

    QUnit.test("execute action from dirty, new record, and come back", async function (assert) {
        assert.expect(18);
        serverData.models.partner.fields.bar.default = 1;
        serverData.views["partner,false,form"] = `
      <form>
        <field name="displayName"/>
        <field name="foo"/>
        <field name="bar" readonly="1"/>
      </form>`;
        const mockRPC = async (route, args) => {
            assert.step((args && args.method) || route);
            if (args && args.method === "get_formview_action") {
                return Promise.resolve({
                    resId: 1,
                    resModel: "partner",
                    type: "ir.actions.actwindow",
                    views: [[false, "form"]],
                });
            }
        };
        const webClient = await createWebClient({ serverData, mockRPC });
        // execute an action and create a new record
        await doAction(webClient, 3);
        await testUtils.dom.click($(webClient.el).find(".o-list-button-add"));
        await legacyExtraNextTick();
        assert.containsOnce(webClient, ".o-form-view.o-form-editable");
        assert.containsOnce(webClient, ".o-form-uri:contains(First record)");
        assert.strictEqual(
            $(webClient.el).find(".o-control-panel .breadcrumb-item").text(),
            "PartnersNew"
        );
        // set form view dirty and open m2o record
        await testUtils.fields.editInput(
            $(webClient.el).find('input[name="displayName"]'),
            "test"
        );
        await testUtils.fields.editInput($(webClient.el).find("input[name=foo]"), "val");
        await testUtils.dom.click($(webClient.el).find(".o-form-uri:contains(First record)"));
        await legacyExtraNextTick();
        assert.containsOnce(webClient, ".o-form-view.o-form-readonly");
        assert.strictEqual(
            $(webClient.el).find(".o-control-panel .breadcrumb-item").text(),
            "PartnerstestFirst record"
        );
        // go back to test using the breadcrumbs
        await testUtils.dom.click(
            $(webClient.el).find(".o-control-panel .breadcrumb-item:nth(1) a")
        );
        await legacyExtraNextTick();
        // should be readonly and so saved
        assert.containsOnce(webClient, ".o-form-view.o-form-readonly");
        assert.strictEqual(
            $(webClient.el).find(".o-control-panel .breadcrumb-item").text(),
            "Partnerstest"
        );
        assert.verifySteps([
            "/web/webclient/loadMenus",
            "/web/action/load",
            "load_views",
            "/web/dataset/searchRead",
            "onchange",
            "get_formview_action",
            "create", // FIXME: to check with mcm
            "load_views",
            "read",
            "read",
        ]);
    });

    QUnit.test("execute a contextual action from a form view", async function (assert) {
        assert.expect(4);
        const contextualAction = serverData.actions[8];
        contextualAction.context = "{}"; // need a context to evaluate
        serverData.models.partner.toolbar = {
            action: [contextualAction],
            print: [],
        };
        const mockRPC = async (route, args) => {
            if (args && args.method === "load_views" && args.model === "partner") {
                assert.strictEqual(
                    args.kwargs.options.toolbar,
                    true,
                    "should ask for toolbar information"
                );
            }
        };
        const webClient = await createWebClient({ serverData, mockRPC });
        // execute an action and open a record
        await doAction(webClient, 3);
        assert.containsOnce(webClient, ".o-list-view");
        await testUtils.dom.click($(webClient.el).find(".o-data-row:first"));
        await legacyExtraNextTick();
        assert.containsOnce(webClient, ".o-form-view");
        // execute the custom action from the action menu
        await testUtils.controlPanel.toggleActionMenu(webClient.el);
        await testUtils.controlPanel.toggleMenuItem(webClient.el, "Favorite Ponies");
        await legacyExtraNextTick();
        assert.containsOnce(webClient, ".o-list-view");
    });

    QUnit.test(
        "go back to action with form view as main view, and resId",
        async function (assert) {
            assert.expect(7);
            serverData.actions[999] = {
                id: 999,
                label: "Partner",
                resModel: "partner",
                type: "ir.actions.actwindow",
                resId: 2,
                views: [[44, "form"]],
            };
            serverData.views["partner,44,form"] = '<form><field name="m2o"/></form>';
            const mockRPC = async (route, args) => {
                if (args.method === "get_formview_action") {
                    return Promise.resolve({
                        resId: 3,
                        resModel: "partner",
                        type: "ir.actions.actwindow",
                        views: [[false, "form"]],
                    });
                }
            };
            const webClient = await createWebClient({ serverData, mockRPC });
            await doAction(webClient, 999);
            assert.containsOnce(webClient.el, ".o-form-view");
            assert.hasClass(webClient.el.querySelector(".o-form-view"), "o-form-readonly");
            assert.strictEqual(
                webClient.el.querySelector(".o-control-panel .breadcrumb").textContent,
                "Second record"
            );
            // push another action in the breadcrumb
            await testUtils.dom.click($(webClient.el).find(".o-form-uri:contains(Third record)"));
            await legacyExtraNextTick();
            assert.strictEqual(
                webClient.el.querySelector(".o-control-panel .breadcrumb").textContent,
                "Second recordThird record"
            );
            // go back to the form view
            await testUtils.dom.click($(webClient.el).find(".o-control-panel .breadcrumb a:first"));
            await legacyExtraNextTick();
            assert.containsOnce(webClient.el, ".o-form-view");
            assert.hasClass(webClient.el.querySelector(".o-form-view"), "o-form-readonly");
            assert.strictEqual(
                webClient.el.querySelector(".o-control-panel .breadcrumb-item").textContent,
                "Second record"
            );
        }
    );

    QUnit.test("open a record, come back, and create a new record", async function (assert) {
        assert.expect(7);
        const webClient = await createWebClient({ serverData });
        // execute an action and open a record
        await doAction(webClient, 3);
        assert.containsOnce(webClient.el, ".o-list-view");
        assert.containsN(webClient.el, ".o-list-view .o-data-row", 5);
        await testUtils.dom.click($(webClient.el).find(".o-list-view .o-data-row:first"));
        await legacyExtraNextTick();
        assert.containsOnce(webClient.el, ".o-form-view");
        assert.hasClass(webClient.el.querySelector(".o-form-view"), "o-form-readonly");
        // go back using the breadcrumbs
        await testUtils.dom.click($(webClient.el).find(".o-control-panel .breadcrumb-item a"));
        await legacyExtraNextTick();
        assert.containsOnce(webClient.el, ".o-list-view");
        // create a new record
        await testUtils.dom.click($(webClient.el).find(".o-list-button-add"));
        await legacyExtraNextTick();
        assert.containsOnce(webClient.el, ".o-form-view");
        assert.hasClass(webClient.el.querySelector(".o-form-view"), "o-form-editable");
    });

    QUnit.test(
        "open form view, use the pager, execute action, and come back",
        async function (assert) {
            assert.expect(8);
            const webClient = await createWebClient({ serverData });
            // execute an action and open a record
            await doAction(webClient, 3);
            assert.containsOnce(webClient.el, ".o-list-view");
            assert.containsN(webClient.el, ".o-list-view .o-data-row", 5);
            await testUtils.dom.click($(webClient.el).find(".o-list-view .o-data-row:first"));
            await legacyExtraNextTick();
            assert.containsOnce(webClient.el, ".o-form-view");
            assert.strictEqual(
                $(webClient.el).find(".o-field-widget[name=displayName]").text(),
                "First record"
            );
            // switch to second record
            await testUtils.dom.click($(webClient.el).find(".o-pager-next"));
            assert.strictEqual(
                $(webClient.el).find(".o-field-widget[name=displayName]").text(),
                "Second record"
            );
            // execute an action from the second record
            await testUtils.dom.click($(webClient.el).find(".o-statusbar-buttons button[name=4]"));
            await legacyExtraNextTick();
            assert.containsOnce(webClient.el, ".o-kanban-view");
            // go back using the breadcrumbs
            await testUtils.dom.click(
                $(webClient.el).find(".o-control-panel .breadcrumb-item:nth(1) a")
            );
            await legacyExtraNextTick();
            assert.containsOnce(webClient.el, ".o-form-view");
            assert.strictEqual(
                $(webClient.el).find(".o-field-widget[name=displayName]").text(),
                "Second record"
            );
        }
    );

    QUnit.test(
        "create a new record in a form view, execute action, and come back",
        async function (assert) {
            assert.expect(8);
            const webClient = await createWebClient({ serverData });
            // execute an action and create a new record
            await doAction(webClient, 3);
            assert.containsOnce(webClient.el, ".o-list-view");
            await testUtils.dom.click($(webClient.el).find(".o-list-button-add"));
            await legacyExtraNextTick();
            assert.containsOnce(webClient.el, ".o-form-view");
            assert.hasClass($(webClient.el).find(".o-form-view")[0], "o-form-editable");
            await testUtils.fields.editInput(
                $(webClient.el).find(".o-field-widget[name=displayName]"),
                "another record"
            );
            await testUtils.dom.click($(webClient.el).find(".o-form-button-save"));
            assert.hasClass($(webClient.el).find(".o-form-view")[0], "o-form-readonly");
            // execute an action from the second record
            await testUtils.dom.click($(webClient.el).find(".o-statusbar-buttons button[name=4]"));
            await legacyExtraNextTick();
            assert.containsOnce(webClient.el, ".o-kanban-view");
            // go back using the breadcrumbs
            await testUtils.dom.click(
                $(webClient.el).find(".o-control-panel .breadcrumb-item:nth(1) a")
            );
            await legacyExtraNextTick();
            assert.containsOnce(webClient.el, ".o-form-view");
            assert.hasClass($(webClient.el).find(".o-form-view")[0], "o-form-readonly");
            assert.strictEqual(
                $(webClient.el).find(".o-field-widget[name=displayName]").text(),
                "another record"
            );
        }
    );

    QUnit.test("view with jsClass attribute (legacy)", async function (assert) {
        assert.expect(2);
        const TestView = AbstractView.extend({
            viewType: "testView",
        });
        const TestJsClassView = TestView.extend({
            init() {
                this._super.call(this, ...arguments);
                assert.step("init js class");
            },
        });
        serverData.views["partner,false,testView"] = `
      <div jsClass="test_jsClass"></div>
    `;
        serverData.actions[9999] = {
            id: 1,
            label: "Partners Action 1",
            resModel: "partner",
            type: "ir.actions.actwindow",
            views: [[false, "testView"]],
        };
        legacyViewRegistry.add("testView", TestView);
        legacyViewRegistry.add("test_jsClass", TestJsClassView);
        const webClient = await createWebClient({ serverData });
        await doAction(webClient, 9999);
        assert.verifySteps(["init js class"]);
        delete legacyViewRegistry.map.testView;
        delete legacyViewRegistry.map.test_jsClass;
    });

    QUnit.test(
        "onClose should be called only once with right parameters in jsClass form view",
        async function (assert) {
            assert.expect(4);
            // This test is quite specific but matches a real case in legacy: event_configurator_widget.js
            // Clicking on form view's action button triggers its own mechanism: it saves the record and closes the dialog.
            // Now it is possible that the dialog action wants to do something of its own at closing time, to, for instance
            // update the main action behind it, with specific parameters.
            // This test ensures that this flow is supported in legacy,
            const TestCustoFormController = FormView.prototype.config.Controller.extend({
                async saveRecord() {
                    await this._super.apply(this, arguments);
                    this.doAction({
                        type: "ir.actions.actwindow_close",
                        infos: { cantaloupe: "island" },
                    });
                },
            });
            const TestCustoFormView = FormView.extend({
                config: Object.assign({}, FormView.prototype.config, {
                    Controller: TestCustoFormController,
                }),
            });
            legacyViewRegistry.add("testView", TestCustoFormView);
            serverData.views["partner,3,form"] = `
      <form jsClass="testView">
        <field name="foo" />
        <footer>
          <button string="Echoes" special="save" />
        </footer>
      </form>`;
            const webClient = await createWebClient({ serverData });
            await doAction(webClient, 24); // main form view
            await doAction(webClient, 25, {
                // Custom jsClass form view in target new
                onClose(infos) {
                    assert.step("onClose");
                    assert.deepEqual(infos, { cantaloupe: "island" });
                },
            });
            // Close dialog by clicking on save button
            await testUtils.dom.click(
                webClient.el.querySelector(".o-dialog .modal-footer button[special=save]")
            );
            assert.verifySteps(["onClose"]);
            await legacyExtraNextTick();
            assert.containsNone(webClient.el, ".modal");
            delete legacyViewRegistry.map.testView;
        }
    );

    QUnit.test(
        "execute action without modal closes bootstrap tooltips anyway",
        async function (assert) {
            assert.expect(12);
            Object.assign(serverData.views, {
                "partner,666,form": `<form>
            <header>
              <button name="object" string="Call method" type="object" help="need somebody"/>
            </header>
            <field name="displayName"/>
          </form>`,
            });
            const mockRPC = async (route, args) => {
                assert.step(route);
                if (route === "/web/dataset/call_button") {
                    // Some business stuff server side, then return an implicit close action
                    return Promise.resolve(false);
                }
            };
            const webClient = await createWebClient({ serverData, mockRPC });
            await doAction(webClient, 24);
            assert.verifySteps([
                "/web/webclient/loadMenus",
                "/web/action/load",
                "/web/dataset/callKw/partner/load_views",
                "/web/dataset/callKw/partner/read",
            ]);
            assert.containsN(webClient.el, ".o-form-buttons-view button:not([disabled])", 2);
            const actionButton = webClient.el.querySelector("button[name=object]");
            const tooltipProm = new Promise((resolve) => {
                $(document.body).one("shown.bs.tooltip", () => {
                    $(actionButton).mouseleave();
                    resolve();
                });
            });
            $(actionButton).mouseenter();
            await tooltipProm;
            assert.containsN(document.body, ".tooltip", 2);
            await click(actionButton);
            await legacyExtraNextTick();
            assert.verifySteps(["/web/dataset/call_button", "/web/dataset/callKw/partner/read"]);
            assert.containsNone(document.body, ".tooltip"); // body different from webClient in tests !
            assert.containsN(webClient.el, ".o-form-buttons-view button:not([disabled])", 2);
        }
    );

    QUnit.test("search view should keep focus during doSearch", async function (assert) {
        assert.expect(5);
        // One should be able to type something in the search view, press on enter to
        // make the facet and trigger the search, then do this process
        // over and over again seamlessly.
        // Verifying the input's value is a lot trickier than verifying the searchRead
        // because of how native events are handled in tests
        const searchPromise = testUtils.makeTestPromise();
        const mockRPC = async (route, args) => {
            if (route === "/web/dataset/searchRead") {
                assert.step("searchRead " + args.domain);
                if (JSON.stringify(args.domain) === JSON.stringify([["foo", "ilike", "m"]])) {
                    await searchPromise;
                }
            }
        };
        const webClient = await createWebClient({ serverData, mockRPC });
        await doAction(webClient, 3);
        await cpHelpers.editSearch(webClient.el, "m");
        await cpHelpers.validateSearch(webClient.el);
        assert.verifySteps(["searchRead ", "searchRead foo,ilike,m"]);
        // Triggering the doSearch above will kill the current searchView Input
        await cpHelpers.editSearch(webClient.el, "o");
        // We have something in the input of the search view. Making the searchRead
        // return at this point will trigger the redraw of the view.
        // However we want to hold on to what we just typed
        searchPromise.resolve();
        await cpHelpers.validateSearch(webClient.el);
        assert.verifySteps(["searchRead |,foo,ilike,m,foo,ilike,o"]);
    });

    QUnit.test(
        "Call twice clearUncommittedChanges in a row does not save twice",
        async function (assert) {
            assert.expect(5);
            let writeCalls = 0;
            const mockRPC = async (route, { method }) => {
                if (method === "write") {
                    writeCalls += 1;
                }
            };
            const webClient = await createWebClient({ serverData, mockRPC });
            // execute an action and edit existing record
            await doAction(webClient, 3);
            await testUtils.dom.click($(webClient.el).find(".o-list-view .o-data-row:first"));
            await legacyExtraNextTick();
            assert.containsOnce(webClient, ".o-form-view.o-form-readonly");
            await testUtils.dom.click($(webClient.el).find(".o-control-panel .o-form-button_edit"));
            assert.containsOnce(webClient, ".o-form-view.o-form-editable");
            await testUtils.fields.editInput($(webClient.el).find("input[name=foo]"), "val");
            clearUncommittedChanges(webClient.env);
            await testUtils.nextTick();
            await legacyExtraNextTick();
            assert.containsNone(document.body, ".modal");
            clearUncommittedChanges(webClient.env);
            await testUtils.nextTick();
            await legacyExtraNextTick();
            assert.containsNone(document.body, ".modal");
            assert.strictEqual(writeCalls, 1);
        }
    );

    QUnit.test(
        "executing a window action with onchange warning does not hide it",
        async function (assert) {
            assert.expect(2);

            serverData.views["partner,false,form"] = `
            <form>
              <field name="foo"/>
            </form>`;
            const mockRPC = (route, args) => {
                if (args.method === "onchange") {
                    return Promise.resolve({
                        value: {},
                        warning: {
                            title: "Warning",
                            message: "Everything is alright",
                            type: "dialog",
                        },
                    });
                }
            };
            const webClient = await createWebClient({ serverData, mockRPC });

            await doAction(webClient, 3);

            await testUtils.dom.click(webClient.el.querySelector(".o-list-button-add"));
            assert.containsOnce(
                document.body,
                ".modal.o-technical-modal",
                "Warning modal should be opened"
            );

            await testUtils.dom.click(
                document.querySelector(".modal.o-technical-modal button.close")
            );
            assert.containsNone(
                document.body,
                ".modal.o-technical-modal",
                "Warning modal should be closed"
            );
        }
    );

    QUnit.test(
        "do not call clearUncommittedChanges() when target=new and dialog is opened",
        async function (assert) {
            assert.expect(2);
            const webClient = await createWebClient({ serverData });
            // Open Partner form view and enter some text
            await doAction(webClient, 3, { viewType: "form" });
            await legacyExtraNextTick();
            await testUtils.fields.editInput(
                webClient.el.querySelector(".o-input[name=displayName]"),
                "TEST"
            );
            // Open dialog without saving should not ask to discard
            await doAction(webClient, 5);
            await legacyExtraNextTick();
            assert.containsOnce(webClient, ".o-dialog");
            assert.containsOnce(webClient, ".o-dialog .o-actwindow .o-view-controller");
        }
    );

    QUnit.test("do not pushState when target=new and dialog is opened", async function (assert) {
        assert.expect(2);
        const TestCustoFormController = FormView.prototype.config.Controller.extend({
            _onButtonClicked() {
                assert.ok(true, "Button was clicked");
                this.triggerUp("pushState", { state: { id: 42 } });
            },
        });
        const TestCustoFormView = FormView.extend({
            config: Object.assign({}, FormView.prototype.config, {
                Controller: TestCustoFormController,
            }),
        });
        legacyViewRegistry.add("testView", TestCustoFormView);
        serverData.views["partner,3,form"] = `
        <form jsClass="testView">
            <field name="foo" />
            <footer>
            <button id="o_push_state_btn" special="special" />
            </footer>
        </form>`;
        const webClient = await createWebClient({ serverData });
        // Open Partner form in create mode
        await doAction(webClient, 3, { viewType: "form" });
        const prevHash = Object.assign({}, webClient.env.services.router.current.hash);
        // Edit another partner in a dialog
        await doAction(webClient, {
            label: "Edit a Partner",
            resModel: "partner",
            resId: 3,
            type: "ir.actions.actwindow",
            views: [[3, "form"]],
            target: "new",
            viewMode: "form",
        });
        await click(document.getElementById("o_push_state_btn"));
        assert.deepEqual(
            webClient.env.services.router.current.hash,
            prevHash,
            "pushState in dialog shouldn't change the hash"
        );
    });

    QUnit.test("do not restore after action button clicked", async function (assert) {
        assert.expect(5);
        const mockRPC = async (route, args) => {
            if (route === "/web/dataset/callButton" && args.method === "doSomething") {
                return true;
            }
        };
        serverData.views["partner,false,form"] = `
      <form>
        <header><button name="doSomething" string="Call button" type="object"/></header>
        <sheet>
          <field name="displayName"/>
        </sheet>
      </form>`;
        const webClient = await createWebClient({ serverData, mockRPC });
        await doAction(webClient, 3, { viewType: "form", props: { resId: 1 } });
        await legacyExtraNextTick();
        assert.isVisible(webClient.el.querySelector(".o-form-buttons-view .o-form-button_edit"));
        await click(webClient.el.querySelector(".o-form-buttons-view .o-form-button_edit"));
        await legacyExtraNextTick();
        assert.isVisible(webClient.el.querySelector(".o-form-buttons_edit .o-form-button-save"));
        assert.isVisible(
            webClient.el.querySelector(".o-statusbar-buttons button[name=doSomething]")
        );
        await click(webClient.el.querySelector(".o-statusbar-buttons button[name=doSomething]"));
        await legacyExtraNextTick();
        assert.isVisible(webClient.el.querySelector(".o-form-buttons_edit .o-form-button-save"));
        await click(webClient.el.querySelector(".o-form-buttons_edit .o-form-button-save"));
        await legacyExtraNextTick();
        assert.isVisible(webClient.el.querySelector(".o-form-buttons-view .o-form-button_edit"));
    });

    QUnit.test("debugManager is active for (legacy) views", async function (assert) {
        assert.expect(2);

        registry.category("debug").category("view").add("editView", editView);
        patchWithCleanup(verp, { debug: "1" });
        const mockRPC = async (route) => {
            if (route.includes("checkAccessRights")) {
                return true;
            }
        };
        const webClient = await createWebClient({ serverData, mockRPC });
        await doAction(webClient, 1);
        assert.containsNone(
            webClient.el,
            ".o-debug-manager .dropdown-item:contains('Edit View: Kanban')"
        );
        await click(webClient.el.querySelector(".o-debug-manager .dropdown-toggle"));
        assert.containsOnce(
            webClient.el,
            ".o-debug-manager .dropdown-item:contains('Edit View: Kanban')"
        );
    });

    QUnit.test("reload a view via the view switcher keep state", async function (assert) {
        assert.expect(6);
        serverData.actions[3].views.unshift([false, "pivot"]);
        serverData.views["partner,false,pivot"] = "<pivot/>";
        const mockRPC = async (route, args) => {
            if (args.method === "readGroup") {
                assert.step(args.method);
            }
        };

        registry.category("services").add("user", makeFakeUserService());
        const webClient = await createWebClient({ serverData, mockRPC });
        await doAction(webClient, 3);
        assert.doesNotHaveClass(
            webClient.el.querySelector(".o-pivot-measure-row"),
            "o-pivot-sort-order-asc"
        );
        await click(webClient.el.querySelector(".o-pivot-measure-row"));
        assert.hasClass(
            webClient.el.querySelector(".o-pivot-measure-row"),
            "o-pivot-sort-order-asc"
        );
        await cpHelpers.switchView(webClient.el, "pivot");
        await legacyExtraNextTick();
        assert.hasClass(
            webClient.el.querySelector(".o-pivot-measure-row"),
            "o-pivot-sort-order-asc"
        );
        assert.verifySteps([
            "readGroup", // initial readGroup
            "readGroup", // readGroup at reload after switch view
        ]);
    });

    QUnit.test("doAction supports being passed globalState prop", async function (assert) {
        assert.expect(1);
        const searchModel = JSON.stringify({
            nextGroupId: 2,
            nextGroupNumber: 2,
            nextId: 2,
            searchItems: {
                1: {
                    description: `ID is "99"`,
                    domain: `[("id","=",99)]`,
                    type: "filter",
                    groupId: 1,
                    groupNumber: 1,
                    id: 1,
                },
            },
            query: [{ searchItemId: 1 }],
            sections: [],
        });
        const mockRPC = async (route, args) => {
            if (route === "/web/dataset/searchRead") {
                assert.deepEqual(args.domain, [["id", "=", 99]]);
            }
        };

        const webClient = await createWebClient({ serverData, mockRPC });
        await doAction(webClient, 1, {
            props: {
                globalState: { searchModel },
            },
        });
    });

    QUnit.test("window action in target new fails (onchange)", async (assert) => {
        assert.expect(3);

        /*
         * By-pass QUnit's and test's error handling because the error service needs to be active
         */
        const handler = (ev) => {
            // need to preventDefault to remove error from console (so javascript test pass)
            ev.preventDefault();
        };
        window.addEventListener("unhandledrejection", handler);
        registerCleanup(() => window.removeEventListener("unhandledrejection", handler));

        patchWithCleanup(QUnit, {
            onUnhandledRejection: () => {},
        });

        const originOnunhandledrejection = window.onunhandledrejection;
        window.onunhandledrejection = () => {};
        registerCleanup(() => {
            window.onunhandledrejection = originOnunhandledrejection;
        });
        /*
         * End By pass error handling
         */

        const warningOpened = makeDeferred();
        class WarningDialogWait extends WarningDialog {
            setup() {
                super.setup();
                owl.hooks.onMounted(() => warningOpened.resolve());
            }
        }

        serviceRegistry.add("error", errorService);
        registry
            .category("errorDialogs")
            .add("verp.exceptions.ValidationError", WarningDialogWait);

        const mockRPC = (route, args) => {
            if (args.method === "onchange" && args.model === "partner") {
                const error = new RPCError();
                error.exceptionName = "verp.exceptions.ValidationError";
                error.code = 200;
                return Promise.reject(error);
            }
        };

        serverData.views["partner,666,form"] = /*xml*/ `
            <form>
                <header>
                    <button name="5" type="action"/>
                </header>
                <field name="displayName"/>
            </form>`;

        const webClient = await createWebClient({ serverData, mockRPC });
        await doAction(webClient, 24);
        await click(webClient.el, ".o-form-view button");

        await warningOpened;
        assert.containsOnce(webClient, ".modal");
        assert.containsOnce(webClient, ".modal .o-dialog-warning");
        assert.strictEqual(
            webClient.el.querySelector(".modal .modal-title").textContent,
            "Validation Error"
        );
    });

    QUnit.test("action and load_views rpcs are cached", async function (assert) {
        const mockRPC = async (route, args) => {
            assert.step(args.method || route);
        };
        const webClient = await createWebClient({ serverData, mockRPC });
        assert.verifySteps(["/web/webclient/loadMenus"]);

        await doAction(webClient, 1);
        assert.containsOnce(webClient, ".o-kanban-view");
        assert.verifySteps(["/web/action/load", "load_views", "/web/dataset/searchRead"]);

        await doAction(webClient, 1);
        assert.containsOnce(webClient, ".o-kanban-view");

        assert.verifySteps(["/web/dataset/searchRead"]);
    });

    QUnit.test("pushState also changes the title of the tab", async (assert) => {
        assert.expect(3);

        const webClient = await createWebClient({ serverData });
        await doAction(webClient, 3); // list view
        const titleService = webClient.env.services.title;
        assert.strictEqual(titleService.current, '{"zopenerp":"Verp","action":"Partners"}');
        await click(webClient.el.querySelector(".o-data-row"));
        await legacyExtraNextTick();
        assert.strictEqual(titleService.current, '{"zopenerp":"Verp","action":"First record"}');
        await click(webClient.el.querySelector(".o-pager-next"));
        assert.strictEqual(titleService.current, '{"zopenerp":"Verp","action":"Second record"}');
    });

    QUnit.test("action part of title is updated when an action is mounted", async (assert) => {
        // use a PivotView because we need a view converted to wowl
        // those two lines can be removed once the list view is converted to wowl
        serverData.actions[3].views.unshift([false, "pivot"]);
        serverData.views["partner,false,pivot"] = "<pivot/>";
        serviceRegistry.add("user", makeFakeUserService());

        const webClient = await createWebClient({ serverData });
        await doAction(webClient, 3);
        const titleService = webClient.env.services.title;
        assert.strictEqual(titleService.current, '{"zopenerp":"Verp","action":"Partners"}');
    });

    QUnit.test("action groupby of type string", async function (assert) {
        assert.expect(2);
        serverData.views["partner,false,pivot"] = `<pivot/>`;
        registry.category("services").add("user", makeFakeUserService());
        const webClient = await createWebClient({ serverData });
        await doAction(webClient, {
            label: "Partner",
            resModel: "partner",
            type: "ir.actions.actwindow",
            views: [[3, "pivot"]],
            context: { groupby: "foo" },
        });
        assert.containsOnce(webClient, ".o-pivot-view");
        assert.containsN(webClient, ".o-pivot-view tbody th", 6);
    });
});
