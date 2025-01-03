/** @verp-module **/

import { patchWithCleanup, triggerEvent } from "@web/../tests/helpers/utils";
import { browser } from "@web/core/browser/browser";
import { dialogService } from "@web/core/dialog/dialog_service";
import { registry } from "@web/core/registry";
import { ControlPanel } from "@web/search/control_panel/control_panel";
import { FavoriteMenu } from "@web/search/favorite_menu/favorite_menu";
import { useSetupAction } from "@web/webclient/actions/action_hook";
import {
    editFavoriteName,
    editSearch,
    getFacetTexts,
    makeWithSearch,
    saveFavorite,
    setupControlPanelFavoriteMenuRegistry,
    setupControlPanelServiceRegistry,
    toggleFavoriteMenu,
    toggleSaveFavorite,
    validateSearch,
} from "./helpers";

const serviceRegistry = registry.category("services");

/**
 * @param {Component} comp
 */
async function toggleDefaultCheckBox(comp) {
    const checkbox = comp.el.querySelector("input[type='checkbox']");
    checkbox.checked = !checkbox.checked;
    await triggerEvent(checkbox, null, "change");
}

/**
 * @param {Component} comp
 */
async function toggleShareCheckBox(comp) {
    const checkbox = comp.el.querySelectorAll("input[type='checkbox']")[1];
    checkbox.checked = !checkbox.checked;
    await triggerEvent(checkbox, null, "change");
}

let serverData;
QUnit.module("Search", (hooks) => {
    hooks.beforeEach(async () => {
        serverData = {
            models: {
                foo: {
                    fields: {
                        bar: { string: "Bar", type: "many2one", relation: "partner" },
                        birthday: { string: "Birthday", type: "date", store: true, sortable: true },
                        date_field: { string: "Date", type: "date", store: true, sortable: true },
                        float_field: { string: "Float", type: "float", groupOperator: "sum" },
                        foo: { string: "Foo", type: "char", store: true, sortable: true },
                    },
                    records: {},
                },
            },
            views: {
                "foo,false,search": `<search/>`,
            },
        };
        setupControlPanelFavoriteMenuRegistry();
        setupControlPanelServiceRegistry();
        serviceRegistry.add("dialog", dialogService);
        patchWithCleanup(browser, {
            setTimeout: (fn) => fn(),
            clearTimeout: () => {},
        });
    });

    QUnit.module("CustomFavoriteItem");

    QUnit.test("simple rendering", async function (assert) {
        assert.expect(3);

        const controlPanel = await makeWithSearch({
            serverData,
            resModel: "foo",
            Component: ControlPanel,
            searchMenuTypes: ["favorite"],
            searchViewId: false,
            config: {
                displayName: "Action Name",
            },
        });

        await toggleFavoriteMenu(controlPanel);
        await toggleSaveFavorite(controlPanel);
        assert.strictEqual(
            controlPanel.el.querySelector('.o-add-favorite input[type="text"]').value,
            "Action Name"
        );
        assert.containsN(
            controlPanel,
            '.o-add-favorite .custom-checkbox input[type="checkbox"]',
            2
        );
        const labelEls = controlPanel.el.querySelectorAll(".o-add-favorite .custom-checkbox label");
        assert.deepEqual(
            [...labelEls].map((e) => e.innerText.trim()),
            ["Use by default", "Share with all users"]
        );
    });

    QUnit.test("favorites use by default and share are exclusive", async function (assert) {
        assert.expect(11);

        const controlPanel = await makeWithSearch({
            serverData,
            resModel: "foo",
            Component: ControlPanel,
            searchMenuTypes: ["favorite"],
            searchViewId: false,
        });

        await toggleFavoriteMenu(controlPanel);
        await toggleSaveFavorite(controlPanel);
        const checkboxes = controlPanel.el.querySelectorAll('input[type="checkbox"]');

        assert.strictEqual(checkboxes.length, 2, "2 checkboxes are present");

        assert.notOk(checkboxes[0].checked, "Start: None of the checkboxes are checked (1)");
        assert.notOk(checkboxes[1].checked, "Start: None of the checkboxes are checked (2)");

        await toggleDefaultCheckBox(controlPanel);

        assert.ok(checkboxes[0].checked, "The first checkbox is checked");
        assert.notOk(checkboxes[1].checked, "The second checkbox is not checked");

        await toggleShareCheckBox(controlPanel);

        assert.notOk(
            checkboxes[0].checked,
            "Clicking on the second checkbox checks it, and unchecks the first (1)"
        );
        assert.ok(
            checkboxes[1].checked,
            "Clicking on the second checkbox checks it, and unchecks the first (2)"
        );

        await toggleDefaultCheckBox(controlPanel);

        assert.ok(
            checkboxes[0].checked,
            "Clicking on the first checkbox checks it, and unchecks the second (1)"
        );
        assert.notOk(
            checkboxes[1].checked,
            "Clicking on the first checkbox checks it, and unchecks the second (2)"
        );

        await toggleDefaultCheckBox(controlPanel);

        assert.notOk(checkboxes[0].checked, "End: None of the checkboxes are checked (1)");
        assert.notOk(checkboxes[1].checked, "End: None of the checkboxes are checked (2)");
    });

    QUnit.test("save filter", async function (assert) {
        assert.expect(4);

        class TestComponent extends owl.Component {
            setup() {
                useSetupAction({
                    getContext: () => {
                        return { someKey: "foo" };
                    },
                });
            }
        }
        TestComponent.components = { FavoriteMenu };
        TestComponent.template = owl.tags.xml`<div><FavoriteMenu/></div>`;

        const comp = await makeWithSearch({
            serverData,
            mockRPC: (_, args) => {
                if (args.model === "ir.filters" && args.method === "create_or_replace") {
                    const irFilter = args.args[0];
                    assert.deepEqual(irFilter.context, { groupby: [], someKey: "foo" });
                    return 7; // fake serverSideId
                }
            },
            resModel: "foo",
            context: { someOtherKey: "bar" }, // should not end up in filter's context
            Component: TestComponent,
            searchViewId: false,
        });
        comp.env.bus.on("CLEAR-CACHES", comp, () => assert.step("CLEAR-CACHES"));

        assert.verifySteps([]);

        await toggleFavoriteMenu(comp);
        await toggleSaveFavorite(comp);
        await editFavoriteName(comp, "aaa");
        await saveFavorite(comp);

        assert.verifySteps(["CLEAR-CACHES"]);
    });

    QUnit.test("dynamic filters are saved dynamic", async function (assert) {
        assert.expect(3);

        const controlPanel = await makeWithSearch({
            serverData,
            mockRPC: (_, args) => {
                if (args.model === "ir.filters" && args.method === "create_or_replace") {
                    const irFilter = args.args[0];
                    assert.deepEqual(
                        irFilter.domain,
                        '[("date_field", ">=", (contextToday() + relativedelta()).strftime("%Y-%m-%d"))]'
                    );
                    return 7; // fake serverSideId
                }
            },
            resModel: "foo",
            Component: ControlPanel,
            searchMenuTypes: ["favorite"],
            searchViewId: false,
            searchViewArch: `
                    <search>
                        <filter string="Filter" name="filter" domain="[('date_field', '>=', (contextToday() + relativedelta()).strftime('%Y-%m-%d'))]"/>
                    </search>
                `,
            context: { search_default_filter: 1 },
        });

        assert.deepEqual(getFacetTexts(controlPanel), ["Filter"]);

        await toggleFavoriteMenu(controlPanel);
        await toggleSaveFavorite(controlPanel);
        await editFavoriteName(controlPanel, "My favorite");
        await saveFavorite(controlPanel);

        assert.deepEqual(getFacetTexts(controlPanel), ["My favorite"]);
    });

    QUnit.test("save filters created via autocompletion works", async function (assert) {
        assert.expect(4);

        const controlPanel = await makeWithSearch({
            serverData,
            mockRPC: (_, args) => {
                if (args.model === "ir.filters" && args.method === "create_or_replace") {
                    const irFilter = args.args[0];
                    assert.deepEqual(irFilter.domain, '[("foo", "ilike", "a")]');
                    return 7; // fake serverSideId
                }
            },
            resModel: "foo",
            Component: ControlPanel,
            searchMenuTypes: ["favorite"],
            searchViewId: false,
            searchViewArch: `
                    <search>
                        <field name="foo"/>
                    </search>
                `,
        });

        assert.deepEqual(getFacetTexts(controlPanel), []);

        await editSearch(controlPanel, "a");
        await validateSearch(controlPanel);

        assert.deepEqual(getFacetTexts(controlPanel), ["Foo\na"]);

        await toggleFavoriteMenu(controlPanel);
        await toggleSaveFavorite(controlPanel);
        await editFavoriteName(controlPanel, "My favorite");
        await saveFavorite(controlPanel);

        assert.deepEqual(getFacetTexts(controlPanel), ["My favorite"]);
    });

    QUnit.test(
        "favorites have unique descriptions (the submenus of the favorite menu are correctly updated)",
        async function (assert) {
            assert.expect(5);

            serviceRegistry.add(
                "notification",
                {
                    start() {
                        return {
                            add(message, options) {
                                assert.strictEqual(
                                    message,
                                    "A filter with same name already exists."
                                );
                                assert.deepEqual(options, { type: "danger" });
                            },
                        };
                    },
                },
                { force: true }
            );

            const controlPanel = await makeWithSearch({
                serverData,
                mockRPC: (route, args) => {
                    if (args.model === "ir.filters" && args.method === "create_or_replace") {
                        const irFilter = args.args[0];
                        assert.deepEqual(irFilter, {
                            actionId: undefined,
                            context: { groupby: [] },
                            domain: "[]",
                            is_default: false,
                            modelId: "foo",
                            name: "My favorite 2",
                            sort: "[]",
                            userId: 7,
                        });
                        return 2; // serverSideId
                    }
                },
                resModel: "foo",
                Component: ControlPanel,
                searchMenuTypes: ["favorite"],
                searchViewId: false,
                irFilters: [
                    {
                        context: "{}",
                        domain: "[]",
                        id: 1,
                        is_default: false,
                        name: "My favorite",
                        sort: "[]",
                        userId: [2, "Mitchell Admin"],
                    },
                ],
            });

            await toggleFavoriteMenu(controlPanel);
            await toggleSaveFavorite(controlPanel);

            // first try: should fail
            await editFavoriteName(controlPanel, "My favorite");
            await saveFavorite(controlPanel);

            // second try: should succeed
            await editFavoriteName(controlPanel, "My favorite 2");
            await saveFavorite(controlPanel);

            // third try: should fail
            await editFavoriteName(controlPanel, "My favorite 2");
            await saveFavorite(controlPanel);
        }
    );

    QUnit.skip("save search filter in modal", async function (assert) {
        /** @todo I don't know yet how to convert this test */
        // assert.expect(5);
        // serverData.models = {
        //     partner: {
        //         fields: {
        //             date_field: {
        //                 string: "Date",
        //                 type: "date",
        //                 store: true,
        //                 sortable: true,
        //                 searchable: true,
        //             },
        //             birthday: { string: "Birthday", type: "date", store: true, sortable: true },
        //             foo: { string: "Foo", type: "char", store: true, sortable: true },
        //             bar: { string: "Bar", type: "many2one", relation: "partner" },
        //             float_field: { string: "Float", type: "float", groupOperator: "sum" },
        //         },
        //         records: [
        //             {
        //                 id: 1,
        //                 displayName: "First record",
        //                 foo: "yop",
        //                 bar: 2,
        //                 date_field: "2017-01-25",
        //                 birthday: "1983-07-15",
        //                 float_field: 1,
        //             },
        //             {
        //                 id: 2,
        //                 displayName: "Second record",
        //                 foo: "blip",
        //                 bar: 1,
        //                 date_field: "2017-01-24",
        //                 birthday: "1982-06-04",
        //                 float_field: 2,
        //             },
        //             {
        //                 id: 3,
        //                 displayName: "Third record",
        //                 foo: "gnap",
        //                 bar: 1,
        //                 date_field: "2017-01-13",
        //                 birthday: "1985-09-13",
        //                 float_field: 1.618,
        //             },
        //             {
        //                 id: 4,
        //                 displayName: "Fourth record",
        //                 foo: "plop",
        //                 bar: 2,
        //                 date_field: "2017-02-25",
        //                 birthday: "1983-05-05",
        //                 float_field: -1,
        //             },
        //             {
        //                 id: 5,
        //                 displayName: "Fifth record",
        //                 foo: "zoup",
        //                 bar: 2,
        //                 date_field: "2016-01-25",
        //                 birthday: "1800-01-01",
        //                 float_field: 13,
        //             },
        //             { id: 7, displayName: "Partner 6" },
        //             { id: 8, displayName: "Partner 7" },
        //             { id: 9, displayName: "Partner 8" },
        //             { id: 10, displayName: "Partner 9" },
        //         ],
        //     },
        // };
        // const form = await createView({
        //     arch: `
        //     <form string="Partners">
        //         <sheet>
        //             <group>
        //                 <field name="bar"/>
        //             </group>
        //         </sheet>
        //     </form>`,
        //     archs: {
        //         "partner,false,list": '<tree><field name="displayName"/></tree>',
        //         "partner,false,search": '<search><field name="date_field"/></search>',
        //     },
        //     data,
        //     model: "partner",
        //     resId: 1,
        //     View: FormView,
        //     env: {
        //         dataManager: {
        //             create_filter(filter) {
        //                 assert.strictEqual(
        //                     filter.name,
        //                     "Awesome Test Customer Filter",
        //                     "filter name should be correct"
        //                 );
        //             },
        //         },
        //     },
        // });
        // await testUtils.form.clickEdit(form);
        // await testUtils.fields.many2one.clickOpenDropdown("bar");
        // await testUtils.fields.many2one.clickItem("bar", "Search");
        // assert.containsN(document.body, "tr.o-data-row", 9, "should display 9 records");
        // await toggleFilterMenu(".modal");
        // await toggleAddCustomFilter(".modal");
        // assert.strictEqual(
        //     document.querySelector(".o-filter-condition select.o-generator-menu-field").value,
        //     "date_field",
        //     "date field should be selected"
        // );
        // await applyFilter(".modal");
        // assert.containsNone(document.body, "tr.o-data-row", "should display 0 records");
        // // Save this search
        // await toggleFavoriteMenu(".modal");
        // await toggleSaveFavorite(".modal");
        // const filterNameInput = document.querySelector('.o-add-favorite input[type="text"]');
        // assert.isVisible(filterNameInput, "should display an input field for the filter name");
        // await testUtils.fields.editInput(filterNameInput, "Awesome Test Customer Filter");
        // await click(document.querySelector(".o-add-favorite button.btn-primary"));
        // form.destroy();
    });
});
