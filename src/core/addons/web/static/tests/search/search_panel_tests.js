/** @verp-module **/

import { makeFakeUserService } from "@web/../tests/helpers/mock_services";
import { click, legacyExtraNextTick, makeDeferred, nextTick } from "@web/../tests/helpers/utils";
import {
    makeWithSearch,
    setupControlPanelServiceRegistry,
    switchView,
    toggleFilterMenu,
    toggleMenuItem,
} from "@web/../tests/search/helpers";
import { createWebClient, doAction } from "@web/../tests/webclient/helpers";
import { registry } from "@web/core/registry";
import { FilterMenu } from "@web/search/filter_menu/filter_menu";
import { GroupByMenu } from "@web/search/group_by_menu/group_by_menu";
import { SearchPanel } from "@web/search/search_panel/search_panel";

const { Component, tags } = owl;
const { xml } = tags;

const serviceRegistry = registry.category("services");

//-----------------------------------------------------------------------------
// Helpers
//-----------------------------------------------------------------------------

const getValues = (comp, type) => {
    const el = comp instanceof Component ? comp.el : comp;
    switch (type) {
        case "category": {
            return [...el.querySelectorAll(".o-searchpanel-category-value header")];
        }
        case "filter": {
            return [...el.getElementsByClassName("o-searchpanel-filter-value")];
        }
        case "filterGroup": {
            return [...el.getElementsByClassName("o-searchpanel-filter-group")];
        }
        case "groupHeader": {
            return [...el.getElementsByClassName("o-searchpanel-group-header")];
        }
    }
};

const getValue = (comp, type, content = 0, additionalSelector = null) => {
    const values = getValues(comp, type);
    let match = null;
    if (Number.isInteger(content) && content < values.length) {
        match = values[content];
    } else {
        const re = new RegExp(content, "i");
        match = values.find((v) => re.test(v.innerText.trim()));
    }
    if (match && additionalSelector) {
        match = match.querySelector(additionalSelector);
    }
    return match;
};

const parseContent = ([value, counter]) => (counter ? `${value}: ${counter}` : value);
const getContent = (comp, type, parse = parseContent) => {
    return getValues(comp, type)
        .map((v) => parse(v.innerText.trim().split(/\s+/)))
        .filter((v) => v !== null);
};

// Categories
const getCategory = (comp, ...args) => getValue(comp, "category", ...args);
const getCategoriesContent = (comp, ...args) => getContent(comp, "category", ...args);

// Filters
const getFilter = (comp, ...args) => getValue(comp, "filter", ...args);
const getFiltersContent = (comp, ...args) => getContent(comp, "filter", ...args);

// Filter groups
const getFilterGroup = (comp, ...args) => getValue(comp, "filterGroup", ...args);
const getFilterGroupContent = (comp, ...args) => {
    const group = getFilterGroup(comp, ...args);
    return [getContent(group, "groupHeader")[0], getFiltersContent(group)];
};

const getCounters = (v) => (isNaN(v[1]) ? null : Number(v[1]));

const makeTestComponent = ({ onWillStart, onWillUpdateProps } = {}) => {
    let domain;
    class TestComponent extends Component {
        async willStart() {
            if (onWillStart) {
                await onWillStart();
            }
            domain = this.props.domain;
        }
        async willUpdateProps(nextProps) {
            if (onWillUpdateProps) {
                await onWillUpdateProps();
            }
            domain = nextProps.domain;
        }
    }

    TestComponent.components = { FilterMenu, GroupByMenu, SearchPanel };
    TestComponent.template = xml`
        <div class="o_test_component">
            <SearchPanel t-if="env.searchModel.display.searchPanel" />
            <FilterMenu />
            <GroupByMenu />
        </div>`;

    return { TestComponent, getDomain: () => domain };
};

let serverData;

QUnit.module("Search", (hooks) => {
    hooks.beforeEach(() => {
        serverData = {
            models: {
                partner: {
                    fields: {
                        foo: { string: "Foo", type: "char" },
                        bar: { string: "Bar", type: "boolean" },
                        int_field: { string: "Int Field", type: "integer", groupOperator: "sum" },
                        companyId: { string: "company", type: "many2one", relation: "company" },
                        companyIds: {
                            string: "Companies",
                            type: "many2many",
                            relation: "company",
                        },
                        categoryId: { string: "category", type: "many2one", relation: "category" },
                        state: {
                            string: "State",
                            type: "selection",
                            selection: [
                                ["abc", "ABC"],
                                ["def", "DEF"],
                                ["ghi", "GHI"],
                            ],
                        },
                    },
                    records: [
                        {
                            id: 1,
                            bar: true,
                            foo: "yop",
                            int_field: 1,
                            companyIds: [3],
                            companyId: 3,
                            state: "abc",
                            categoryId: 6,
                        },
                        {
                            id: 2,
                            bar: true,
                            foo: "blip",
                            int_field: 2,
                            companyIds: [3],
                            companyId: 5,
                            state: "def",
                            categoryId: 7,
                        },
                        {
                            id: 3,
                            bar: true,
                            foo: "gnap",
                            int_field: 4,
                            companyIds: [],
                            companyId: 3,
                            state: "ghi",
                            categoryId: 7,
                        },
                        {
                            id: 4,
                            bar: false,
                            foo: "blip",
                            int_field: 8,
                            companyIds: [5],
                            companyId: 5,
                            state: "ghi",
                            categoryId: 7,
                        },
                    ],
                },
                company: {
                    fields: {
                        name: { string: "Display Name", type: "char" },
                        parentId: {
                            string: "Parent company",
                            type: "many2one",
                            relation: "company",
                        },
                        categoryId: { string: "Category", type: "many2one", relation: "category" },
                    },
                    records: [
                        { id: 3, name: "asustek", categoryId: 6 },
                        { id: 5, name: "agrolait", categoryId: 7 },
                    ],
                },
                category: {
                    fields: {
                        name: { string: "Category Name", type: "char" },
                    },
                    records: [
                        { id: 6, name: "gold" },
                        { id: 7, name: "silver" },
                    ],
                },
            },
            actions: {
                1: {
                    id: 1,
                    name: "Partners",
                    resModel: "partner",
                    type: "ir.actions.actwindow",
                    views: [
                        [false, "kanban"],
                        [false, "list"],
                        [false, "pivot"],
                        [false, "form"],
                    ],
                },
                2: {
                    id: 2,
                    name: "Partners",
                    resModel: "partner",
                    type: "ir.actions.actwindow",
                    views: [[false, "form"]],
                },
            },
            views: {
                "partner,false,toy": /* xml */ `<toy />`,
                "partner,false,list": /* xml */ `
                    <tree>
                        <field name="foo"/>
                    </tree>`,
                "partner,false,kanban": /* xml */ `
                    <kanban>
                        <templates>
                            <div t-name="kanban-box" class="oe-kanban-global-click">
                                <field name="foo"/>
                            </div>
                        </templates>
                    </kanban>`,
                "partner,false,form": /* xml */ `
                    <form>
                        <button name="1" type="action" string="multi view"/>
                        <field name="foo"/>
                        <field name="companyId"/>
                    </form>`,
                "partner,false,pivot": /* xml */ `<pivot><field name="int_field" type="measure"/></pivot>`,
                "partner,false,search": /* xml */ `
                    <search>
                        <filter name="false_domain" string="false Domain" domain="[(0, '=', 1)]"/>
                        <filter name="filter" string="Filter" domain="[('bar', '=', true)]"/>
                        <filter name="true_domain" string="true Domain" domain="[[1,'=',1]]"/>
                        <filter name="groupby_bar" string="Bar" context="{ 'groupby': 'bar' }"/>
                        <searchpanel view_types="kanban,tree,toy">
                            <field name="companyId" enableCounters="1" expand="1"/>
                            <field name="categoryId" select="multi" enableCounters="1" expand="1"/>
                        </searchpanel>
                    </search>`,
            },
        };
        setupControlPanelServiceRegistry();
        serviceRegistry.add("user", makeFakeUserService());
    });

    QUnit.module("SearchPanel");

    QUnit.test("basic rendering of a component without search panel", async (assert) => {
        assert.expect(2);

        const { TestComponent, getDomain } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            async mockRPC(route, { method }) {
                if (/search_panel_/.test(method || route)) {
                    throw new Error("No search panel section should be loaded");
                }
            },
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
            display: { searchPanel: false },
        });
        assert.containsNone(comp, ".o-searchpanel");
        assert.deepEqual(getDomain(), []); // initial domain
    });

    QUnit.test("basic rendering of a component with empty search panel", async (assert) => {
        assert.expect(2);

        serverData.views["partner,false,search"] = `<search><searchpanel /></search>`;

        const { TestComponent, getDomain } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            async mockRPC(route, { method, model }) {
                if (/search_panel_/.test(method || route)) {
                    assert.step(`${method || route} on ${model}`);
                }
            },
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        assert.containsNone(comp, ".o-searchpanel");
        assert.deepEqual(getDomain(), []); // initial domain
    });

    QUnit.test("basic rendering of a component with search panel", async (assert) => {
        assert.expect(15);
        const { TestComponent, getDomain } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            async mockRPC(route, { method, model }) {
                if (/search_panel_/.test(method || route)) {
                    assert.step(`${method || route} on ${model}`);
                }
            },
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        assert.containsOnce(comp, ".o-searchpanel");
        assert.containsN(comp, ".o-searchpanel-section", 2);

        const sections = comp.el.querySelectorAll(".o-searchpanel-section");

        const firstSection = sections[0];
        assert.hasClass(
            firstSection.querySelector(".o-searchpanel-section-header i"),
            "fa-folder"
        );
        assert.containsOnce(firstSection, ".o-searchpanel-section-header:contains(company)");
        assert.containsN(firstSection, ".o-searchpanel-category-value", 3);
        assert.containsOnce(firstSection, ".o-searchpanel-category-value:first .active");
        assert.deepEqual(
            [...firstSection.querySelectorAll(".o-searchpanel-category-value")].map((el) =>
                el.innerText.replace(/\s/g, " ")
            ),
            ["All", "asustek 2", "agrolait 2"]
        );

        const secondSection = sections[1];
        assert.hasClass(
            secondSection.querySelector(".o-searchpanel-section-header i"),
            "fa-filter"
        );
        assert.containsOnce(secondSection, ".o-searchpanel-section-header:contains(category)");
        assert.containsN(secondSection, ".o-searchpanel-filter-value", 2);
        assert.deepEqual(
            [...secondSection.querySelectorAll(".o-searchpanel-filter-value")].map((el) =>
                el.innerText.replace(/\s/g, " ")
            ),
            ["gold 1", "silver 3"]
        );

        assert.verifySteps([
            "searchpanelSelectRange on partner",
            "search_panel_select_multi_range on partner",
        ]);
        assert.deepEqual(getDomain(), []); // initial domain (does not need the sections to be loaded)
    });

    QUnit.test("sections with custom icon and color", async (assert) => {
        assert.expect(5);

        const { TestComponent, getDomain } = makeTestComponent();

        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel view_types="toy">
                    <field name="companyId" icon="fa-car" color="blue" enableCounters="1"/>
                    <field name="state" select="multi" icon="fa-star" color="#000" enableCounters="1"/>
                </searchpanel>
            </search>`;

        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
            config: { viewType: "toy" },
        });

        const sectionHeaderIcons = comp.el.querySelectorAll(".o-searchpanel-section-header i");
        assert.hasClass(sectionHeaderIcons[0], "fa-car");
        assert.hasAttrValue(sectionHeaderIcons[0], 'style="{color: blue}"');
        assert.hasClass(sectionHeaderIcons[1], "fa-star");
        assert.hasAttrValue(sectionHeaderIcons[1], 'style="{color: #000}"');

        assert.deepEqual(getDomain(), []);
    });

    QUnit.test('sections with attr invisible="1" are ignored', async (assert) => {
        // 'groups' attributes are converted server-side into invisible="1" when the user doesn't
        // belong to the given group
        assert.expect(3);

        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="companyId" enableCounters="1"/>
                    <field name="state" select="multi" invisible="1" enableCounters="1"/>
                </searchpanel>
            </search>`;

        const { TestComponent } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            async mockRPC(route, { method }) {
                if (/search_panel_/.test(method || route)) {
                    assert.step(method || route);
                }
            },
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
            config: { viewType: "kanban" },
        });

        assert.containsOnce(comp, ".o-searchpanel-section");
        assert.verifySteps(["searchpanelSelectRange"]);
    });

    QUnit.test("categories and filters order is kept", async (assert) => {
        assert.expect(4);

        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="companyId" enableCounters="1"/>
                    <field name="categoryId" select="multi" enableCounters="1"/>
                    <field name="state" enableCounters="1"/>
                </searchpanel>
            </search>`;

        const { TestComponent } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
            config: { viewType: "kanban" },
        });

        const headers = comp.el.getElementsByClassName("o-searchpanel-section-header");
        assert.containsN(comp, ".o-searchpanel-section", 3);
        assert.strictEqual(headers[0].innerText.trim(), "COMPANY");
        assert.strictEqual(headers[1].innerText.trim(), "CATEGORY");
        assert.strictEqual(headers[2].innerText.trim(), "STATE");
    });

    QUnit.test(
        "specify active category value in context and manually change category",
        async (assert) => {
            assert.expect(4);

            serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="companyId" enableCounters="1"/>
                    <field name="state" enableCounters="1"/>
                </searchpanel>
            </search>`;

            const { TestComponent, getDomain } = makeTestComponent();
            const comp = await makeWithSearch({
                serverData,
                Component: TestComponent,
                resModel: "partner",
                searchViewId: false,
                context: {
                    searchpanelDefault_company_id: false,
                    searchpanelDefault_state: "ghi",
                },
            });

            assert.deepEqual(
                [
                    ...comp.el.querySelectorAll(
                        ".o-searchpanel-category-value header.active label"
                    ),
                ].map((el) => el.innerText),
                ["All", "GHI"]
            );
            assert.deepEqual(getDomain(), [["state", "=", "ghi"]]);

            // select 'ABC' in the category 'state'
            await click(comp.el.querySelectorAll(".o-searchpanel-category-value header")[4]);

            assert.deepEqual(
                [
                    ...comp.el.querySelectorAll(
                        ".o-searchpanel-category-value header.active label"
                    ),
                ].map((el) => el.innerText),
                ["All", "ABC"]
            );

            assert.deepEqual(getDomain(), [["state", "=", "abc"]]);
        }
    );

    QUnit.test("use category (on many2one) to refine search", async (assert) => {
        assert.expect(10);

        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="companyId" enableCounters="1"/>
                </searchpanel>
            </search>
        `;

        const { TestComponent, getDomain } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
            domain: [["bar", "=", true]],
            context: {
                searchpanelDefault_company_id: false,
                searchpanelDefault_state: "ghi",
            },
        });

        assert.deepEqual(getDomain(), [["bar", "=", true]]);

        // select "asustek"
        await click(comp.el.querySelectorAll(".o-searchpanel-category-value header")[1]);

        assert.containsOnce(comp, ".o-searchpanel-category-value .active");
        assert.containsOnce(comp, ".o-searchpanel-category-value:nth(1) .active");

        assert.deepEqual(getDomain(), ["&", ["bar", "=", true], ["companyId", "childOf", 3]]);

        // select "agrolait"
        await click(comp.el.querySelectorAll(".o-searchpanel-category-value header")[2]);

        assert.containsOnce(comp, ".o-searchpanel-category-value .active");
        assert.containsOnce(comp, ".o-searchpanel-category-value:nth(2) .active");

        assert.deepEqual(getDomain(), ["&", ["bar", "=", true], ["companyId", "childOf", 5]]);

        // select "All"
        await click(comp.el.querySelector(".o-searchpanel-category-value header"));

        assert.containsOnce(comp, ".o-searchpanel-category-value .active");
        assert.containsOnce(comp, ".o-searchpanel-category-value:first .active");

        assert.deepEqual(getDomain(), [["bar", "=", true]]);
    });

    QUnit.test("use category (on selection) to refine search", async (assert) => {
        assert.expect(10);

        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="state" enableCounters="1"/>
                </searchpanel>
            </search>`;

        const { TestComponent, getDomain } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        assert.deepEqual(getDomain(), []);

        // select 'abc'
        await click(comp.el, ".o-searchpanel-category-value:nth-of-type(2) header");

        assert.containsOnce(comp, ".o-searchpanel-category-value .active");
        assert.containsOnce(comp, ".o-searchpanel-category-value:nth-of-type(2) .active");

        assert.deepEqual(getDomain(), [["state", "=", "abc"]]);

        // select 'ghi'
        await click(comp.el, ".o-searchpanel-category-value:nth-of-type(4) header");

        assert.containsOnce(comp, ".o-searchpanel-category-value .active");
        assert.containsOnce(comp, ".o-searchpanel-category-value:nth-of-type(4) .active");

        assert.deepEqual(getDomain(), [["state", "=", "ghi"]]);

        // select 'All' again
        await click(comp.el, ".o-searchpanel-category-value:nth-of-type(1) header");

        assert.containsOnce(comp, ".o-searchpanel-category-value:nth-of-type(1) .active");
        assert.containsOnce(comp, ".o-searchpanel-category-value:first .active");

        assert.deepEqual(getDomain(), []);
    });

    QUnit.test("category has been archived", async (assert) => {
        assert.expect(2);

        serverData.models.company.fields.active = { type: "boolean", string: "Archived" };
        serverData.models.company.records = [
            {
                name: "Company 5",
                id: 5,
                active: true,
            },
            {
                name: "child of 5 archived",
                parentId: 5,
                id: 666,
                active: false,
            },
            {
                name: "child of 666",
                parentId: 666,
                id: 777,
                active: true,
            },
        ];
        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="companyId" enableCounters="1"/>
                </searchpanel>
            </search>`;

        const { TestComponent } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        assert.containsN(
            comp,
            ".o-searchpanel-category-value",
            2,
            "The number of categories should be 2: All and Company 5"
        );

        assert.containsNone(
            comp,
            ".o-toggle-fold > i",
            "None of the categories should have children"
        );
    });

    QUnit.test("use two categories to refine search", async (assert) => {
        assert.expect(7);

        serverData.views["partner,false,search"] = /* xml */ `
        <search>
            <searchpanel>
                <field name="companyId" enableCounters="1"/>
                <field name="state" enableCounters="1"/>
            </searchpanel>
        </search>
    `;

        const { TestComponent, getDomain } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
            domain: [["bar", "=", true]],
        });

        assert.deepEqual(getDomain(), [["bar", "=", true]]);

        assert.containsN(comp, ".o-searchpanel-section", 2);

        // select 'asustek'
        await click(
            [
                ...comp.el.querySelectorAll(
                    ".o-searchpanel-category-value header .o-searchpanel-label-title"
                ),
            ].find((el) => el.innerText === "asustek")
        );
        assert.deepEqual(getDomain(), ["&", ["bar", "=", true], ["companyId", "childOf", 3]]);

        // select 'abc'
        await click(
            [
                ...comp.el.querySelectorAll(
                    ".o-searchpanel-category-value header .o-searchpanel-label-title"
                ),
            ].find((el) => el.innerText === "ABC")
        );
        assert.deepEqual(getDomain(), [
            "&",
            ["bar", "=", true],
            "&",
            ["companyId", "childOf", 3],
            ["state", "=", "abc"],
        ]);

        // select 'ghi'
        await click(
            [
                ...comp.el.querySelectorAll(
                    ".o-searchpanel-category-value header .o-searchpanel-label-title"
                ),
            ].find((el) => el.innerText === "GHI")
        );
        assert.deepEqual(getDomain(), [
            "&",
            ["bar", "=", true],
            "&",
            ["companyId", "childOf", 3],
            ["state", "=", "ghi"],
        ]);

        // select 'All' in first category (companyId)
        let firstSection = comp.el.querySelector(".o-searchpanel-section");
        await click(firstSection.querySelector(".o-searchpanel-category-value header"));
        assert.deepEqual(getDomain(), ["&", ["bar", "=", true], ["state", "=", "ghi"]]);

        firstSection = comp.el.querySelectorAll(".o-searchpanel-section")[1];
        // select 'All' in second category (state)
        await click(firstSection.querySelector(".o-searchpanel-category-value header"));
        assert.deepEqual(getDomain(), [["bar", "=", true]]);
    });

    QUnit.test("category with parent_field", async (assert) => {
        assert.expect(25);

        serverData.models.company.records.push(
            { id: 40, name: "child company 1", parentId: 5 },
            { id: 41, name: "child company 2", parentId: 5 }
        );
        serverData.models.partner.records[1].companyId = 40;
        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="companyId" enableCounters="1" expand="1"/>
                </searchpanel>
            </search>`;

        const { TestComponent, getDomain } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        // 'All' is selected by default
        assert.containsOnce(comp, ".o-searchpanel-category-value .active");
        assert.containsOnce(comp, ".o-searchpanel-category-value:first .active");
        assert.containsN(comp, ".o-searchpanel-category-value", 3);
        assert.containsOnce(comp, ".o-searchpanel-category-value .o-toggle-fold > i");

        // unfold parent category and select 'All' again
        await click(getCategory(comp, 2));
        await click(getCategory(comp, 0));

        assert.containsOnce(comp, ".o-searchpanel-category-value .active");
        assert.containsOnce(comp, ".o-searchpanel-category-value:first .active");
        assert.containsN(comp, ".o-searchpanel-category-value", 5);
        assert.containsN(comp, ".o-searchpanel-category-value .o-searchpanel-category-value", 2);

        assert.deepEqual(getDomain(), []);

        // click on first child company
        await click(getCategory(comp, 3));

        assert.containsOnce(comp, ".o-searchpanel-category-value .active");
        assert.containsOnce(
            comp,
            ".o-searchpanel-category-value .o-searchpanel-category-value:first .active"
        );

        assert.deepEqual(getDomain(), [["companyId", "childOf", 40]]);

        // click on parent company
        await click(getCategory(comp, 2));

        assert.containsOnce(comp, ".o-searchpanel-category-value .active");
        assert.containsOnce(comp, ".o-searchpanel-category-value:nth(2) .active");

        assert.deepEqual(getDomain(), [["companyId", "childOf", 5]]);

        // fold parent company by clicking on it
        await click(getCategory(comp, 2));

        assert.containsOnce(comp, ".o-searchpanel-category-value .active");
        assert.containsOnce(comp, ".o-searchpanel-category-value:nth(2) .active");

        // parent company should be folded
        assert.containsOnce(comp, ".o-searchpanel-category-value .active");
        assert.containsOnce(comp, ".o-searchpanel-category-value:nth(2) .active");
        assert.containsN(comp, ".o-searchpanel-category-value", 3);

        assert.deepEqual(getDomain(), [["companyId", "childOf", 5]]);

        // fold category with children
        await click(getCategory(comp, 2));
        await click(getCategory(comp, 2));

        assert.containsOnce(comp, ".o-searchpanel-category-value .active");
        assert.containsOnce(comp, ".o-searchpanel-category-value:nth(2) .active");
        assert.containsN(comp, ".o-searchpanel-category-value", 3);

        assert.deepEqual(getDomain(), [["companyId", "childOf", 5]]);
    });

    QUnit.test("category with no parent_field", async (assert) => {
        assert.expect(7);

        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="categoryId" enableCounters="1"/>
                </searchpanel>
            </search>
        `;

        const { TestComponent, getDomain } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        assert.deepEqual(getDomain(), []);

        // 'All' is selected by default
        assert.containsOnce(comp, ".o-searchpanel-category-value .active");
        assert.containsOnce(comp, ".o-searchpanel-category-value:first .active");
        assert.containsN(comp, ".o-searchpanel-category-value", 3);

        // click on 'gold' category
        await click(comp.el.querySelectorAll(".o-searchpanel-category-value header")[1]);

        assert.containsOnce(comp, ".o-searchpanel-category-value .active");
        assert.containsOnce(comp, ".o-searchpanel-category-value:nth(1) .active");

        assert.deepEqual(getDomain(), [["categoryId", "=", 6]]); // must use '=' operator (instead of 'childOf')
    });

    QUnit.test("can (un)fold parent category values", async (assert) => {
        assert.expect(7);

        serverData.models.company.records.push(
            { id: 40, name: "child company 1", parentId: 5 },
            { id: 41, name: "child company 2", parentId: 5 }
        );
        serverData.models.partner.records[1].companyId = 40;
        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="companyId" enableCounters="1" expand="1"/>
                </searchpanel>
            </search>`;

        const { TestComponent } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        assert.containsOnce(
            comp,
            ".o-searchpanel-category-value:contains(agrolait) .o-toggle-fold > i"
        );
        assert.hasClass(getCategory(comp, "agrolait", ".o-toggle-fold > i"), "fa-caret-right");
        assert.containsN(comp, ".o-searchpanel-category-value", 3);

        // unfold agrolait
        await click(getCategory(comp, "agrolait", ".o-toggle-fold > i"));
        assert.hasClass(getCategory(comp, "agrolait", ".o-toggle-fold > i"), "fa-caret-down");
        assert.containsN(comp, ".o-searchpanel-category-value", 5);

        // fold agrolait
        await click(getCategory(comp, "agrolait", ".o-toggle-fold > i"));
        assert.hasClass(getCategory(comp, "agrolait", ".o-toggle-fold > i"), "fa-caret-right");
        assert.containsN(comp, ".o-searchpanel-category-value", 3);
    });

    QUnit.test("fold status is kept at reload", async (assert) => {
        assert.expect(4);

        serverData.models.company.records.push(
            { id: 40, name: "child company 1", parentId: 5 },
            { id: 41, name: "child company 2", parentId: 5 }
        );
        serverData.models.partner.records[1].companyId = 40;

        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <filter name="true Domain" domain="[[1,'=',1]]"/>
                <searchpanel>
                    <field name="companyId" enableCounters="1" expand="1"/>
                </searchpanel>
            </search>
        `;

        const { TestComponent } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        // unfold agrolait
        function getAgrolaitElement() {
            return [
                ...comp.el.querySelectorAll(".o-searchpanel-category-value > header"),
            ].find((el) => el.innerText.includes("agrolait"));
        }

        await click(getAgrolaitElement());
        assert.hasClass(
            getAgrolaitElement().querySelector(".o-toggle-fold > i"),
            "fa-caret-down",
            "'agrolait' should be open"
        );
        assert.containsN(comp, ".o-searchpanel-category-value", 5);

        await toggleFilterMenu(comp);
        await toggleMenuItem(comp, "true Domain");

        assert.hasClass(
            getAgrolaitElement().querySelector(".o-toggle-fold > i"),
            "fa-caret-down",
            "'agrolait' should be open"
        );
        assert.containsN(comp, ".o-searchpanel-category-value", 5);
    });

    QUnit.test("concurrency: delayed component update", async (assert) => {
        assert.expect(15);

        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="companyId" enableCounters="1"/>
                </searchpanel>
            </search>`;

        let promise = makeDeferred();
        const { TestComponent, getDomain } = makeTestComponent({
            onWillUpdateProps: () => promise,
        });
        const comp = await makeWithSearch({
            serverData,
            async mockRPC(route) {
                if (route === "/web/dataset/searchRead") {
                    await promise;
                }
            },
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
            domain: [["bar", "=", true]],
        });

        // 'All' should be selected by default
        assert.containsOnce(comp, ".o-searchpanel-category-value .active");
        assert.containsOnce(comp, ".o-searchpanel-category-value:first .active");

        assert.deepEqual(getDomain(), [["bar", "=", true]]);

        // select 'asustek' (delay the reload)
        const asustekPromise = promise;
        await click(getCategory(comp, 1));

        // 'asustek' should be selected, but there should still be 3 records
        assert.containsOnce(comp, ".o-searchpanel-category-value .active");
        assert.containsOnce(comp, ".o-searchpanel-category-value:nth(1) .active");

        assert.deepEqual(getDomain(), [["bar", "=", true]]);

        // select 'agrolait' (delay the reload)
        promise = makeDeferred();
        const agrolaitPromise = promise;
        await click(getCategory(comp, 2));

        // 'agrolait' should be selected, but there should still be 3 records
        assert.containsOnce(comp, ".o-searchpanel-category-value .active");
        assert.containsOnce(comp, ".o-searchpanel-category-value:nth(2) .active");

        assert.deepEqual(getDomain(), [["bar", "=", true]]);

        // unlock asustek search (should be ignored, so there should still be 3 records)
        asustekPromise.resolve();
        await nextTick();

        assert.containsOnce(comp, ".o-searchpanel-category-value .active");
        assert.containsOnce(comp, ".o-searchpanel-category-value:nth(2) .active");

        assert.deepEqual(getDomain(), ["&", ["bar", "=", true], ["companyId", "childOf", 3]]);

        // unlock agrolait search, there should now be 1 record
        agrolaitPromise.resolve();
        await nextTick();

        assert.containsOnce(comp, ".o-searchpanel-category-value .active");
        assert.containsOnce(comp, ".o-searchpanel-category-value:nth(2) .active");

        assert.deepEqual(getDomain(), ["&", ["bar", "=", true], ["companyId", "childOf", 5]]);
    });

    QUnit.test("concurrency: single category", async (assert) => {
        assert.expect(10);

        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <filter name="Filter" domain="[('id', '=', 1)]"/>
                <searchpanel>
                    <field name="companyId" enableCounters="1"/>
                </searchpanel>
            </search>`;

        let promise = makeDeferred();
        const { TestComponent } = makeTestComponent();
        const compPromise = makeWithSearch({
            serverData,
            async mockRPC(route, { method }) {
                await promise;
                assert.step(method || route);
            },
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
            context: {
                searchpanelDefault_company_id: [5],
            },
        });

        // Case 1: search panel is awaited to build the query with search defaults
        await nextTick();
        assert.verifySteps([]);

        promise.resolve();
        const comp = await compPromise;

        assert.verifySteps(["load_views", "searchpanelSelectRange"]);

        // Case 2: search domain changed so we wait for the search panel once again
        promise = makeDeferred();

        await toggleFilterMenu(comp);
        await toggleMenuItem(comp, 0);

        assert.verifySteps([]);

        promise.resolve();
        await nextTick();

        assert.verifySteps(["searchpanelSelectRange"]);

        // Case 3: search domain is the same and default values do not matter anymore
        promise = makeDeferred();

        await click(getCategory(comp, 1));

        // The search read is executed right away in this case
        assert.verifySteps([]);

        promise.resolve();
        await nextTick();

        assert.verifySteps(["searchpanelSelectRange"]);
    });

    QUnit.test("concurrency: category and filter", async (assert) => {
        assert.expect(5);

        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="categoryId" enableCounters="1"/>
                    <field name="companyId" select="multi" enableCounters="1"/>
                </searchpanel>
            </search>`;

        let promise = makeDeferred();
        const { TestComponent } = makeTestComponent();
        const compPromise = makeWithSearch({
            serverData,
            async mockRPC(route, { method }) {
                await promise;
                assert.step(method || route);
            },
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
            context: {
                searchpanelDefault_company_id: [5],
            },
        });

        await nextTick();
        assert.verifySteps([]);

        promise.resolve();
        await compPromise;

        assert.verifySteps([
            "load_views",
            "searchpanelSelectRange",
            "search_panel_select_multi_range",
        ]);
    });

    QUnit.test("concurrency: category and filter with a domain", async (assert) => {
        assert.expect(5);

        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="categoryId"/>
                    <field name="companyId" select="multi" domain="[['categoryId', '=', categoryId]]" enableCounters="1"/>
                </searchpanel>
            </search>`;

        let promise = makeDeferred();
        const { TestComponent } = makeTestComponent();
        const compPromise = makeWithSearch({
            serverData,
            async mockRPC(route, { method }) {
                await promise;
                assert.step(method || route);
            },
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        await nextTick();
        assert.verifySteps([]);

        promise.resolve();
        await compPromise;

        assert.verifySteps([
            "load_views",
            "searchpanelSelectRange",
            "search_panel_select_multi_range",
        ]);
    });

    QUnit.test("concurrency: misordered get_filters", async (assert) => {
        assert.expect(15);

        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="state" enableCounters="1"/>
                    <field name="companyId" select="multi" enableCounters="1"/>
                </searchpanel>
            </search>`;

        let promise;
        const { TestComponent, getDomain } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            async mockRPC(route, { method }) {
                if (method === "search_panel_select_multi_range") {
                    await promise;
                }
            },
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        assert.containsOnce(comp, ".o-searchpanel-category-value .active");
        assert.containsOnce(comp, ".o-searchpanel-category-value:first .active");

        assert.deepEqual(getDomain(), []);

        // select 'abc' (delay the reload)
        promise = makeDeferred();
        const abcDef = promise;
        await click(getCategory(comp, 1));

        // 'All' should still be selected
        assert.containsOnce(comp, ".o-searchpanel-category-value .active");
        assert.containsOnce(comp, ".o-searchpanel-category-value:first .active");

        assert.deepEqual(getDomain(), [["state", "=", "abc"]]);

        // select 'ghi' (delay the reload)
        promise = makeDeferred();
        const ghiDef = promise;
        await click(getCategory(comp, 3));

        // 'All' should still be selected
        assert.containsOnce(comp, ".o-searchpanel-category-value .active");
        assert.containsOnce(comp, ".o-searchpanel-category-value:first .active");

        assert.deepEqual(getDomain(), [["state", "=", "ghi"]]);

        // unlock ghi search
        ghiDef.resolve();
        await nextTick();

        assert.containsOnce(comp, ".o-searchpanel-category-value .active");
        assert.containsOnce(comp, ".o-searchpanel-category-value:nth(3) .active");

        assert.deepEqual(getDomain(), [["state", "=", "ghi"]]);

        // unlock abc search (should be ignored)
        abcDef.resolve();
        await nextTick();

        assert.containsOnce(comp, ".o-searchpanel-category-value .active");
        assert.containsOnce(comp, ".o-searchpanel-category-value:nth(3) .active");

        assert.deepEqual(getDomain(), [["state", "=", "ghi"]]);
    });

    QUnit.test("concurrency: delayed get_filter", async (assert) => {
        assert.expect(3);

        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <filter name="Filter" domain="[('id', '=', 1)]"/>
                <searchpanel>
                    <field name="companyId" select="multi" enableCounters="1"/>
                </searchpanel>
            </search>`;

        let promise;
        const { TestComponent, getDomain } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            async mockRPC(route, { method }) {
                if (method === "search_panel_select_multi_range") {
                    await promise;
                }
            },
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        assert.deepEqual(getDomain(), []);

        // trigger a reload and delay the get_filter
        promise = makeDeferred();

        await toggleFilterMenu(comp);
        await toggleMenuItem(comp, 0);

        assert.deepEqual(getDomain(), []);

        promise.resolve();
        await nextTick();

        assert.deepEqual(getDomain(), [["id", "=", 1]]);
    });

    QUnit.test("use filter (on many2one) to refine search", async (assert) => {
        assert.expect(16);

        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <filter name="Filter" domain="[('id', '=', 1)]"/>
                <searchpanel>
                    <field name="companyId" select="multi" enableCounters="1"/>
                </searchpanel>
            </search>`;

        const { TestComponent, getDomain } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
            domain: [["bar", "=", true]],
        });

        assert.containsN(comp, ".o-searchpanel-filter-value", 2);
        assert.containsNone(comp, ".o-searchpanel-filter-value input:checked");
        assert.deepEqual(getFiltersContent(comp), ["asustek: 2", "agrolait: 1"]);
        assert.deepEqual(getDomain(), [["bar", "=", true]]);

        // check 'asustek'
        await click(getFilter(comp, 0, "input"));

        assert.containsOnce(comp, ".o-searchpanel-filter-value input:checked");
        assert.deepEqual(getFiltersContent(comp), ["asustek: 2", "agrolait: 1"]);
        assert.deepEqual(getDomain(), ["&", ["bar", "=", true], ["companyId", "in", [3]]]);

        // check 'agrolait'
        await click(getFilter(comp, 1, "input"));

        assert.containsN(comp, ".o-searchpanel-filter-value input:checked", 2);
        assert.deepEqual(getFiltersContent(comp), ["asustek: 2", "agrolait: 1"]);
        assert.deepEqual(getDomain(), ["&", ["bar", "=", true], ["companyId", "in", [3, 5]]]);

        // uncheck 'asustek'
        await click(getFilter(comp, 0, "input"));

        assert.containsOnce(comp, ".o-searchpanel-filter-value input:checked");
        assert.deepEqual(getFiltersContent(comp), ["asustek: 2", "agrolait: 1"]);
        assert.deepEqual(getDomain(), ["&", ["bar", "=", true], ["companyId", "in", [5]]]);

        // uncheck 'agrolait'
        await click(getFilter(comp, 1, "input"));

        assert.containsNone(comp, ".o-searchpanel-filter-value input:checked");
        assert.deepEqual(getFiltersContent(comp), ["asustek: 2", "agrolait: 1"]);
        assert.deepEqual(getDomain(), [["bar", "=", true]]);
    });

    QUnit.test("use filter (on selection) to refine search", async (assert) => {
        assert.expect(16);

        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <filter name="Filter" domain="[('id', '=', 1)]"/>
                <searchpanel>
                    <field name="state" select="multi" enableCounters="1" expand="1"/>
                </searchpanel>
            </search>`;

        const { TestComponent, getDomain } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
            domain: [["bar", "=", true]],
        });

        assert.containsN(comp, ".o-searchpanel-filter-value", 3);
        assert.containsNone(comp, ".o-searchpanel-filter-value input:checked");
        assert.deepEqual(getFiltersContent(comp), ["ABC: 1", "DEF: 1", "GHI: 1"]);
        assert.deepEqual(getDomain(), [["bar", "=", true]]);

        // check 'abc'
        await click(getFilter(comp, 0, "input"));

        assert.containsOnce(comp, ".o-searchpanel-filter-value input:checked");
        assert.deepEqual(getFiltersContent(comp), ["ABC: 1", "DEF: 1", "GHI: 1"]);
        assert.deepEqual(getDomain(), ["&", ["bar", "=", true], ["state", "in", ["abc"]]]);

        // check 'def'
        await click(getFilter(comp, 1, "input"));

        assert.containsN(comp, ".o-searchpanel-filter-value input:checked", 2);
        assert.deepEqual(getFiltersContent(comp), ["ABC: 1", "DEF: 1", "GHI: 1"]);
        assert.deepEqual(getDomain(), ["&", ["bar", "=", true], ["state", "in", ["abc", "def"]]]);

        // uncheck 'abc'
        await click(getFilter(comp, 0, "input"));

        assert.containsOnce(comp, ".o-searchpanel-filter-value input:checked");
        assert.deepEqual(getFiltersContent(comp), ["ABC: 1", "DEF: 1", "GHI: 1"]);
        assert.deepEqual(getDomain(), ["&", ["bar", "=", true], ["state", "in", ["def"]]]);

        // uncheck 'def'
        await click(getFilter(comp, 1, "input"));

        assert.containsNone(comp, ".o-searchpanel-filter-value input:checked");
        assert.deepEqual(getFiltersContent(comp), ["ABC: 1", "DEF: 1", "GHI: 1"]);
        assert.deepEqual(getDomain(), [["bar", "=", true]]);
    });

    QUnit.test(
        "only reload categories and filters when domains change (counters disabled, selection)",
        async (assert) => {
            assert.expect(7);

            serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <filter name="Filter" domain="[('id', '&lt;', 5)]"/>
                <searchpanel>
                    <field name="state" expand="1"/>
                    <field name="companyId" select="multi" enableCounters="1" expand="1"/>
                </searchpanel>
                </search>`;

            const { TestComponent } = makeTestComponent();
            const comp = await makeWithSearch({
                serverData,
                async mockRPC(route, { method }) {
                    if (/search_panel_/.test(method || route)) {
                        assert.step(method || route);
                    }
                },
                Component: TestComponent,
                resModel: "partner",
                searchViewId: false,
            });

            assert.verifySteps(["searchpanelSelectRange", "search_panel_select_multi_range"]);

            // reload with another domain, so the filters should be reloaded
            await toggleFilterMenu(comp);
            await toggleMenuItem(comp, 0);

            assert.verifySteps(["search_panel_select_multi_range"]);

            // change category value, so the filters should be reloaded
            await click(getCategory(comp, 1));

            assert.verifySteps(["search_panel_select_multi_range"]);
        }
    );

    QUnit.test(
        "only reload categories and filters when domains change (counters disabled, many2one)",
        async (assert) => {
            assert.expect(7);

            serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <filter name="domain" domain="[('id', '&lt;', 5)]"/>
                <searchpanel>
                    <field name="categoryId" expand="1"/>
                    <field name="companyId" select="multi" enableCounters="1" expand="1"/>
                </searchpanel>
                </search>`;

            const { TestComponent } = makeTestComponent();
            const comp = await makeWithSearch({
                serverData,
                async mockRPC(route, { method }) {
                    if (/search_panel_/.test(method || route)) {
                        assert.step(method || route);
                    }
                },
                Component: TestComponent,
                resModel: "partner",
                searchViewId: false,
            });

            assert.verifySteps(["searchpanelSelectRange", "search_panel_select_multi_range"]);

            // reload with another domain, so the filters should be reloaded
            await toggleFilterMenu(comp);
            await toggleMenuItem(comp, 0);

            assert.verifySteps(["search_panel_select_multi_range"]);

            // change category value, so the filters should be reloaded
            await click(getCategory(comp, 1));

            assert.verifySteps(["search_panel_select_multi_range"]);
        }
    );

    QUnit.test("category counters", async (assert) => {
        assert.expect(14);

        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <filter name="Filter" domain="[('id', '&lt;', 3)]"/>
                <searchpanel>
                    <field name="state" enableCounters="1" expand="1"/>
                    <field name="companyId" expand="1"/>
                </searchpanel>
            </search>`;

        const { TestComponent } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            async mockRPC(route, { args, method }) {
                if (/search_panel_/.test(method || route)) {
                    assert.step(method || route);
                }
                if (route === "/web/dataset/callKw/partner/searchpanelSelectRange") {
                    assert.step(args[0]);
                }
            },
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        assert.verifySteps([
            "searchpanelSelectRange",
            "state",
            "searchpanelSelectRange",
            "companyId",
        ]);
        assert.deepEqual(getCategoriesContent(comp), [
            "All",
            "ABC: 1",
            "DEF: 1",
            "GHI: 2",
            "All",
            "asustek",
            "agrolait",
        ]);

        // reload with another domain, so the categories 'state' and 'companyId' should be reloaded
        await toggleFilterMenu(comp);
        await toggleMenuItem(comp, 0);

        assert.verifySteps(["searchpanelSelectRange", "state"]);
        assert.deepEqual(getCategoriesContent(comp), [
            "All",
            "ABC: 1",
            "DEF: 1",
            "GHI",
            "All",
            "asustek",
            "agrolait",
        ]);

        // change category value, so the category 'state' should be reloaded
        await click(getCategory(comp, 1));

        assert.verifySteps(["searchpanelSelectRange", "state"]);
        assert.deepEqual(getCategoriesContent(comp), [
            "All",
            "ABC: 1",
            "DEF: 1",
            "GHI",
            "All",
            "asustek",
            "agrolait",
        ]);
    });

    QUnit.test("category selection without counters", async (assert) => {
        assert.expect(8);

        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <filter name="Filter" domain="[('id', '&lt;', 3)]"/>
                <searchpanel>
                    <field name="state" expand="1"/>
                </searchpanel>
            </search>`;

        const { TestComponent } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            async mockRPC(route, { args, method }) {
                if (/search_panel_/.test(method || route)) {
                    assert.step(method || route);
                }
                if (route === "/web/dataset/callKw/partner/searchpanelSelectRange") {
                    assert.step(args[0]);
                }
            },
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        assert.verifySteps(["searchpanelSelectRange", "state"]);
        assert.deepEqual(getCategoriesContent(comp), ["All", "ABC", "DEF", "GHI"]);

        // reload with another domain, so the category 'state' should be reloaded
        await toggleFilterMenu(comp);
        await toggleMenuItem(comp, 0);

        assert.verifySteps([]);
        assert.deepEqual(getCategoriesContent(comp), ["All", "ABC", "DEF", "GHI"]);

        // change category value, so the category 'state' should be reloaded
        await click(getCategory(comp, 1));

        assert.verifySteps([]);
        assert.deepEqual(getCategoriesContent(comp), ["All", "ABC", "DEF", "GHI"]);
    });

    QUnit.test("filter with groupby", async (assert) => {
        assert.expect(26);

        serverData.models.company.records.push({ id: 11, name: "camptocamp", categoryId: 7 });
        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="companyId" select="multi" groupby="categoryId" enableCounters="1" expand="1"/>
                </searchpanel>
            </search>`;

        const { TestComponent, getDomain } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
            domain: [["bar", "=", true]],
        });

        assert.containsN(comp, ".o-searchpanel-filter-group", 2);
        assert.containsOnce(
            comp,
            ".o-searchpanel-filter-group:first .o-searchpanel-filter-value"
        );
        assert.containsN(
            comp,
            ".o-searchpanel-filter-group:nth(1) .o-searchpanel-filter-value",
            2
        );
        assert.containsNone(comp, ".o-searchpanel-filter-value input:checked");
        assert.deepEqual(getFilterGroupContent(comp, 0), ["gold", ["asustek: 2"]]);
        assert.deepEqual(getFilterGroupContent(comp, 1), ["silver", ["agrolait: 1", "camptocamp"]]);
        assert.deepEqual(getDomain(), [["bar", "=", true]]);

        // check 'asustek'
        await click(getFilter(comp, 0, "input"));

        const firstGroupCheckbox = getFilterGroup(comp, 0, "header > div > input");

        assert.containsOnce(comp, ".o-searchpanel-filter-value input:checked");
        assert.strictEqual(
            firstGroupCheckbox.checked,
            true,
            "first group checkbox should be checked"
        );
        assert.deepEqual(getFiltersContent(comp), ["asustek: 2", "agrolait", "camptocamp"]);
        assert.deepEqual(getDomain(), ["&", ["bar", "=", true], ["companyId", "in", [3]]]);

        // check 'agrolait'
        await click(getFilter(comp, 1, "input"));

        assert.containsN(comp, ".o-searchpanel-filter-value input:checked", 2);

        const secondGroupCheckbox = getFilterGroup(comp, 1, "header > div > input");

        assert.strictEqual(
            secondGroupCheckbox.checked,
            false,
            "second group checkbox should not be checked"
        );
        assert.strictEqual(
            secondGroupCheckbox.indeterminate,
            true,
            "second group checkbox should be indeterminate"
        );
        assert.deepEqual(getFiltersContent(comp), ["asustek", "agrolait", "camptocamp"]);
        assert.deepEqual(getDomain(), [
            "&",
            ["bar", "=", true],
            "&",
            ["companyId", "in", [3]],
            ["companyId", "in", [5]],
        ]);

        // check 'camptocamp'
        await click(getFilter(comp, 2, "input"));

        assert.containsN(comp, ".o-searchpanel-filter-value input:checked", 3);
        assert.strictEqual(
            secondGroupCheckbox.checked,
            true,
            "second group checkbox should be checked"
        );
        assert.strictEqual(
            secondGroupCheckbox.indeterminate,
            false,
            "second group checkbox should not be indeterminate"
        );
        assert.deepEqual(getFiltersContent(comp), ["asustek", "agrolait", "camptocamp"]);
        assert.deepEqual(getDomain(), [
            "&",
            ["bar", "=", true],
            "&",
            ["companyId", "in", [3]],
            ["companyId", "in", [5, 11]],
        ]);

        // uncheck second group
        await click(getFilterGroup(comp, 1, "header > div > input"));

        assert.containsOnce(comp, ".o-searchpanel-filter-value input:checked");
        assert.strictEqual(
            secondGroupCheckbox.checked,
            false,
            "second group checkbox should not be checked"
        );
        assert.strictEqual(
            secondGroupCheckbox.indeterminate,
            false,
            "second group checkbox should not be indeterminate"
        );
        assert.deepEqual(getFiltersContent(comp), ["asustek: 2", "agrolait", "camptocamp"]);
        assert.deepEqual(getDomain(), ["&", ["bar", "=", true], ["companyId", "in", [3]]]);
    });

    QUnit.test("filter with domain", async (assert) => {
        assert.expect(3);

        serverData.models.company.records.push({ id: 40, name: "child company 1", parentId: 3 });
        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="companyId" select="multi" domain="[('parentId','=',false)]" enableCounters="1" expand="1"/>
                </searchpanel>
            </search>`;

        const { TestComponent } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            async mockRPC(route, { kwargs, method }) {
                if (method === "search_panel_select_multi_range") {
                    const toCompare = { ...kwargs, context: {} };
                    assert.deepEqual(toCompare, {
                        groupby: false,
                        category_domain: [],
                        context: {},
                        expand: true,
                        filterDomain: [],
                        search_domain: [],
                        comodel_domain: [["parentId", "=", false]],
                        group_domain: [],
                        enableCounters: true,
                        limit: 200,
                    });
                }
            },
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        assert.containsN(comp, ".o-searchpanel-filter-value", 2);
        assert.deepEqual(getFiltersContent(comp), ["asustek: 2", "agrolait: 2"]);
    });

    QUnit.test("filter with domain depending on category", async (assert) => {
        assert.expect(22);

        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="categoryId"/>
                    <field name="companyId" select="multi" domain="[['categoryId', '=', categoryId]]" enableCounters="1"/>
                </searchpanel>
            </search>`;

        const { TestComponent } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            async mockRPC(route, { kwargs, method }) {
                if (method === "search_panel_select_multi_range") {
                    if (method === "search_panel_select_multi_range") {
                        // the following keys should have same value for all calls to this route
                        const { groupby, search_domain, filterDomain } = kwargs;
                        assert.deepEqual(
                            { groupby, search_domain, filterDomain },
                            {
                                groupby: false,
                                filterDomain: [],
                                search_domain: [],
                            }
                        );
                        assert.step(JSON.stringify(kwargs.category_domain));
                        assert.step(JSON.stringify(kwargs.comodel_domain));
                    }
                }
            },
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        // select 'gold' category
        await click(getCategory(comp, 1));

        assert.containsOnce(comp, ".o-searchpanel-category-value .active");
        assert.containsOnce(comp, ".o-searchpanel-category-value:nth(1) .active");
        assert.containsOnce(comp, ".o-searchpanel-filter-value");
        assert.deepEqual(getFiltersContent(comp), ["asustek: 1"]);

        // select 'silver' category
        await click(getCategory(comp, 2));

        assert.containsOnce(comp, ".o-searchpanel-category-value:nth(2) .active");
        assert.containsOnce(comp, ".o-searchpanel-filter-value");
        assert.deepEqual(getFiltersContent(comp), ["agrolait: 2"]);

        // select All
        await click(getCategory(comp, 0));

        assert.containsOnce(comp, ".o-searchpanel-category-value:first .active");
        assert.containsNone(comp, ".o-searchpanel-filter-value");

        assert.verifySteps([
            "[]", // category_domain (All)
            '[["categoryId","=",false]]', // comodel_domain (All)
            '[["categoryId","=",6]]', // category_domain ('gold')
            '[["categoryId","=",6]]', // comodel_domain ('gold')
            '[["categoryId","=",7]]', // category_domain ('silver')
            '[["categoryId","=",7]]', // comodel_domain ('silver')
            "[]", // category_domain (All)
            '[["categoryId","=",false]]', // comodel_domain (All)
        ]);
    });

    QUnit.test("specify active filter values in context", async (assert) => {
        assert.expect(4);

        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="companyId" select="multi" enableCounters="1"/>
                    <field name="state" select="multi" enableCounters="1"/>
                </searchpanel>
            </search>`;

        const { TestComponent, getDomain } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
            context: {
                searchpanelDefault_company_id: [5],
                searchpanelDefault_state: ["abc", "ghi"],
            },
        });

        assert.containsN(comp, ".o-searchpanel-filter-value input:checked", 3);
        assert.deepEqual(getDomain(), [
            "&",
            ["companyId", "in", [5]],
            ["state", "in", ["abc", "ghi"]],
        ]);

        // manually untick a default value
        await click(getFilter(comp, 1, "input"));

        assert.containsN(comp, ".o-searchpanel-filter-value input:checked", 2);
        assert.deepEqual(getDomain(), [["state", "in", ["abc", "ghi"]]]);
    });

    QUnit.test("retrieved filter value from context does not exist", async (assert) => {
        assert.expect(1);

        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="companyId" select="multi" enableCounters="1"/>
                </searchpanel>
            </search>`;

        const { TestComponent, getDomain } = makeTestComponent();
        await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
            context: {
                searchpanelDefault_company_id: [1, 3],
            },
        });

        assert.deepEqual(getDomain(), [["companyId", "in", [3]]]);
    });

    QUnit.test("filter with groupby and default values in context", async (assert) => {
        assert.expect(2);

        serverData.models.company.records.push({ id: 11, name: "camptocamp", categoryId: 7 });
        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="companyId" select="multi" groupby="categoryId" enableCounters="1" expand="1"/>
                </searchpanel>
            </search>`;

        const { TestComponent, getDomain } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
            context: {
                searchpanelDefault_company_id: [5],
            },
        });

        const secondGroupCheckbox = getFilterGroup(comp, 1, "header > div > input");

        assert.strictEqual(secondGroupCheckbox.indeterminate, true);
        assert.deepEqual(getDomain(), [["companyId", "in", [5]]]);
    });

    QUnit.test('Does not confuse false and "false" groupby values', async (assert) => {
        assert.expect(6);

        serverData.models.company.fields.char_field = { string: "Char Field", type: "char" };
        serverData.models.company.records = [
            { id: 3, name: "A", char_field: false },
            { id: 5, name: "B", char_field: "false" },
        ];
        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="companyId" select="multi" groupby="char_field"/>
                </searchpanel>
            </search>`;

        const { TestComponent } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
            context: {
                searchpanelDefault_company_id: [5],
            },
        });

        assert.containsOnce(comp, ".o-searchpanel-section");

        // There should be a group 'false' displayed with only value B inside it.
        assert.containsOnce(comp, ".o-searchpanel-filter-group");
        assert.deepEqual(getFilterGroupContent(comp), ["false", ["B"]]);
        assert.containsOnce(getFilterGroup(comp), ".o-searchpanel-filter-value");

        // Globally, there should be two values, one displayed in the group 'false', and one at the end of the section
        // (the group false is not displayed and its values are displayed at the first level)
        assert.containsN(comp, ".o-searchpanel-filter-value", 2);
        assert.deepEqual(getFiltersContent(comp), ["B", "A"]);
    });

    QUnit.test("tests conservation of category record order", async (assert) => {
        assert.expect(1);

        serverData.models.company.records.push(
            { id: 56, name: "highID", categoryId: 6 },
            { id: 2, name: "lowID", categoryId: 6 }
        );
        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="companyId" enableCounters="1" expand="1"/>
                    <field name="categoryId" select="multi" enableCounters="1" expand="1"/>
                </searchpanel>
            </search>`;

        const { TestComponent } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        assert.deepEqual(getCategoriesContent(comp), [
            "All",
            "asustek: 2",
            "agrolait: 2",
            "highID",
            "lowID",
        ]);
    });

    QUnit.test("search panel is available on list and kanban by default", async (assert) => {
        assert.expect(8);

        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <filter name="false_domain" string="false Domain" domain="[(0, '=', 1)]"/>
                <filter name="filter" string="Filter" domain="[('bar', '=', true)]"/>
                <filter name="true_domain" string="true Domain" domain="[[1,'=',1]]"/>
                <filter name="groupby_bar" string="Bar" context="{ 'groupby': 'bar' }"/>
                <searchpanel>
                    <field name="companyId" enableCounters="1" expand="1"/>
                    <field name="categoryId" select="multi" enableCounters="1" expand="1"/>
                </searchpanel>
            </search>`;

        const webclient = await createWebClient({ serverData });

        await doAction(webclient, 1);

        assert.containsOnce(webclient, ".o-content.o-controller-with-searchpanel .o-kanban-view");
        assert.containsOnce(webclient, ".o-content.o-controller-with-searchpanel .o-searchpanel");

        await switchView(webclient, "pivot");

        assert.containsOnce(webclient, ".o-content .o-pivot");
        assert.containsNone(webclient, ".o-content .o-searchpanel");

        await switchView(webclient, "list");
        await legacyExtraNextTick();

        assert.containsOnce(webclient, ".o-content.o-controller-with-searchpanel .o-list-view");
        assert.containsOnce(webclient, ".o-content.o-controller-with-searchpanel .o-searchpanel");

        await click(webclient.el.querySelector(".o-data-row .o-data-cell"));
        await legacyExtraNextTick();

        assert.containsOnce(webclient, ".o-content .o-form-view");
        assert.containsNone(webclient, ".o-content .o-searchpanel");
    });

    QUnit.test("search panel with view_types attribute", async (assert) => {
        assert.expect(6);

        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <filter name="false_domain" string="false Domain" domain="[(0, '=', 1)]"/>
                <filter name="filter" string="Filter" domain="[('bar', '=', true)]"/>
                <filter name="true_domain" string="true Domain" domain="[[1,'=',1]]"/>
                <filter name="groupby_bar" string="Bar" context="{ 'groupby': 'bar' }"/>
                <searchpanel view_types="kanban,pivot">
                    <field name="companyId" enableCounters="1" expand="1"/>
                    <field name="categoryId" select="multi" enableCounters="1" expand="1"/>
                </searchpanel>
            </search>`;

        const webclient = await createWebClient({ serverData });

        await doAction(webclient, 1);

        assert.containsOnce(webclient, ".o-content.o-controller-with-searchpanel .o-kanban-view");
        assert.containsOnce(webclient, ".o-content.o-controller-with-searchpanel .o-searchpanel");

        await switchView(webclient, "list");
        await legacyExtraNextTick();

        assert.containsOnce(webclient, ".o-content .o-list-view");
        assert.containsNone(webclient, ".o-content .o-searchpanel");

        await switchView(webclient, "pivot");

        assert.containsOnce(webclient, ".o-content.o-component-with-searchpanel .o-pivot");
        assert.containsOnce(webclient, ".o-content.o-component-with-searchpanel .o-searchpanel");
    });

    QUnit.test("search panel state is shared between views", async (assert) => {
        assert.expect(16);

        const webclient = await createWebClient({
            serverData,
            async mockRPC(route, { domain }) {
                if (route === "/web/dataset/searchRead") {
                    assert.step(JSON.stringify(domain));
                }
            },
        });

        await doAction(webclient, 1);

        assert.hasClass(getCategory(webclient, 0), "active");
        assert.containsN(webclient, ".o-kanban-record:not(.o-kanban-ghost)", 4);

        // select 'asustek' company
        await click(getCategory(webclient, 1));

        assert.hasClass(getCategory(webclient, 1), "active");
        assert.containsN(webclient, ".o-kanban-record:not(.o-kanban-ghost)", 2);

        await switchView(webclient, "list");
        await legacyExtraNextTick();

        assert.hasClass(getCategory(webclient, 1), "active");
        assert.containsN(webclient, ".o-data-row", 2);

        // select 'agrolait' company
        await click(getCategory(webclient, 2));

        assert.hasClass(getCategory(webclient, 2), "active");
        assert.containsN(webclient, ".o-data-row", 2);

        await switchView(webclient, "kanban");
        await legacyExtraNextTick();

        assert.hasClass(getCategory(webclient, 2), "active");
        assert.containsN(webclient, ".o-kanban-record:not(.o-kanban-ghost)", 2);

        assert.verifySteps([
            "[]", // initial searchRead
            '[["companyId","childOf",3]]', // kanban, after selecting the first company
            '[["companyId","childOf",3]]', // list
            '[["companyId","childOf",5]]', // list, after selecting the other company
            '[["companyId","childOf",5]]', // kanban
        ]);
    });

    QUnit.test("search panel filters are kept between switch views", async (assert) => {
        assert.expect(17);

        const webclient = await createWebClient({
            serverData,
            async mockRPC(route, { domain }) {
                if (route === "/web/dataset/searchRead") {
                    assert.step(JSON.stringify(domain));
                }
            },
        });

        await doAction(webclient, 1);

        assert.containsNone(webclient, ".o-searchpanel-filter-value input:checked");
        assert.containsN(webclient, ".o-kanban-record:not(.o-kanban-ghost)", 4);

        // select gold filter
        await click(getFilter(webclient, 0, "input"));

        assert.containsOnce(webclient, ".o-searchpanel-filter-value input:checked");
        assert.containsN(webclient, ".o-kanban-record:not(.o-kanban-ghost)", 1);

        await switchView(webclient, "list");
        await legacyExtraNextTick();

        assert.containsOnce(webclient, ".o-searchpanel-filter-value input:checked");
        assert.containsN(webclient, ".o-data-row", 1);

        // select silver filter
        await click(getFilter(webclient, 1, "input"));

        assert.containsN(webclient, ".o-searchpanel-filter-value input:checked", 2);
        assert.containsN(webclient, ".o-data-row", 4);

        await switchView(webclient, "kanban");
        await legacyExtraNextTick();

        assert.containsN(webclient, ".o-searchpanel-filter-value input:checked", 2);
        assert.containsN(webclient, ".o-kanban-record:not(.o-kanban-ghost)", 4);

        await click(webclient.el.querySelector(".o-kanban-record"));
        await legacyExtraNextTick();
        await click(webclient.el.querySelector(".breadcrumb-item"));
        await legacyExtraNextTick();

        assert.verifySteps([
            "[]", // initial searchRead
            '[["categoryId","in",[6]]]', // kanban, after selecting the gold filter
            '[["categoryId","in",[6]]]', // list
            '[["categoryId","in",[6,7]]]', // list, after selecting the silver filter
            '[["categoryId","in",[6,7]]]', // kanban
            '[["categoryId","in",[6,7]]]', // kanban, after switching back from form view
        ]);
    });

    QUnit.test(
        "search panel filters are kept when switching to a view with no search panel",
        async (assert) => {
            assert.expect(13);

            const webclient = await createWebClient({ serverData });

            await doAction(webclient, 1);

            assert.containsOnce(
                webclient,
                ".o-content.o-controller-with-searchpanel .o-kanban-view"
            );
            assert.containsOnce(
                webclient,
                ".o-content.o-controller-with-searchpanel .o-searchpanel"
            );
            assert.containsNone(webclient, ".o-searchpanel-filter-value input:checked");
            assert.containsN(webclient, ".o-kanban-record:not(.o-kanban-ghost)", 4);

            // select gold filter
            await click(getFilter(webclient, 0, "input"));

            assert.containsOnce(webclient, ".o-searchpanel-filter-value input:checked");
            assert.containsN(webclient, ".o-kanban-record:not(.o-kanban-ghost)", 1);

            // switch to pivot
            await switchView(webclient, "pivot");

            assert.containsOnce(webclient, ".o-content .o-pivot");
            assert.containsNone(webclient, ".o-content .o-searchpanel");
            assert.strictEqual(
                webclient.el.querySelector(".o-pivot-cell-value").innerText.trim(),
                "15"
            );

            // switch to list
            await switchView(webclient, "list");
            await legacyExtraNextTick();

            assert.containsOnce(webclient, ".o-content.o-controller-with-searchpanel .o-list-view");
            assert.containsOnce(
                webclient,
                ".o-content.o-controller-with-searchpanel .o-searchpanel"
            );
            assert.containsOnce(webclient, ".o-searchpanel-filter-value input:checked");
            assert.containsN(webclient, ".o-data-row", 1);
        }
    );

    QUnit.test('after onExecuteAction, selects "All" as default category value', async (assert) => {
        assert.expect(3);

        const webclient = await createWebClient({ serverData });

        await doAction(webclient, 1, { viewType: "form" });
        await click(webclient.el.querySelector(".o-form-view button"));
        await legacyExtraNextTick();

        assert.containsOnce(webclient, ".o-kanban-view");
        assert.containsOnce(webclient, ".o-searchpanel");
        assert.containsOnce(webclient, ".o-searchpanel-category-value:first .active");
    });

    QUnit.test(
        "categories and filters are not reloaded when switching between views",
        async (assert) => {
            assert.expect(3);

            const webclient = await createWebClient({
                serverData,
                async mockRPC(route, { method }) {
                    if (/search_panel_/.test(method || route)) {
                        assert.step(method || route);
                    }
                },
            });

            await doAction(webclient, 1);

            await switchView(webclient, "list");
            await legacyExtraNextTick();
            await switchView(webclient, "kanban");
            await legacyExtraNextTick();

            assert.verifySteps([
                "searchpanelSelectRange", // kanban: categories
                "search_panel_select_multi_range", // kanban: filters
            ]);
        }
    );

    QUnit.test(
        "categories and filters are loaded when switching from a view without the search panel",
        async (assert) => {
            assert.expect(5);

            // set the pivot view as the default view
            serverData.actions[1].views = [
                [false, "pivot"],
                [false, "kanban"],
                [false, "list"],
            ];

            const webclient = await createWebClient({
                serverData,
                async mockRPC(route, {method}) {
                    if (/search_panel_/.test(method || route)) {
                        assert.step(method || route);
                    }
                },
            });

            await doAction(webclient, 1);
            assert.verifySteps([]);

            await switchView(webclient, "list");
            await legacyExtraNextTick();
            assert.verifySteps(["searchpanelSelectRange", "search_panel_select_multi_range"]);

            await switchView(webclient, "kanban");
            await legacyExtraNextTick();
            assert.verifySteps([]);
        }
    );

    QUnit.test("scroll position is kept when switching between controllers", async (assert) => {
        assert.expect(6);

        for (let i = 10; i < 20; i++) {
            serverData.models.category.records.push({ id: i, name: "Cat " + i });
        }

        const webclient = await createWebClient({ serverData });

        await doAction(webclient, 1);

        webclient.el.style = "max-height: 300px";

        const getSearchPanel = () => webclient.el.querySelector(".o-searchpanel");

        assert.containsOnce(webclient, ".o-content .o-kanban-view");
        assert.strictEqual(getSearchPanel().scrollTop, 0);

        // simulate a scroll in the search panel and switch into list
        getSearchPanel().scrollTo(0, 100);
        await switchView(webclient, "list");
        await legacyExtraNextTick();

        assert.containsOnce(webclient, ".o-content .o-list-view");
        assert.strictEqual(getSearchPanel().scrollTop, 100);

        // simulate another scroll and switch back to kanban
        getSearchPanel().scrollTo(0, 25);
        await switchView(webclient, "kanban");
        await legacyExtraNextTick();

        assert.containsOnce(webclient, ".o-content .o-kanban-view");
        assert.strictEqual(getSearchPanel().scrollTop, 25);
    });

    QUnit.test("search panel is not instantiated in dialogs", async (assert) => {
        assert.expect(2);

        serverData.models.company.records = Array.from(Array(8), (_, i) => ({
            id: i + 1,
            name: `Company${i + 1}`,
        }));
        serverData.views["company,false,list"] = /* xml */ `<tree><field name="label"/></tree>`;
        serverData.views["company,false,search"] = /* xml */ `
            <search>
                <field name="label"/>
                <searchpanel>
                    <field name="categoryId" enableCounters="1"/>
                </searchpanel>
            </search>`;

        const webclient = await createWebClient({ serverData });

        await doAction(webclient, 1, { viewType: "form" });

        await click(webclient.el, "[name=companyId] .o-input");
        await click(webclient.el, "[name=companyId] .o-input");
        await click(document, ".o-m2o-dropdown-option");
        await legacyExtraNextTick();

        assert.containsOnce(document.body, ".modal .o-list-view");
        assert.containsNone(document.body, ".modal .o-searchpanel");
    });

    QUnit.test(
        "Reload categories with counters when filter values are selected",
        async (assert) => {
            assert.expect(10);

            serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="categoryId" enableCounters="1"/>
                    <field name="state" select="multi" enableCounters="1"/>
                </searchpanel>
            </search>`;

            const { TestComponent } = makeTestComponent();
            const comp = await makeWithSearch({
                serverData,
                async mockRPC(route, { method }) {
                    if (/search_panel_/.test(method || route)) {
                        assert.step(method || route);
                    }
                },
                Component: TestComponent,
                resModel: "partner",
                searchViewId: false,
            });

            assert.verifySteps(["searchpanelSelectRange", "search_panel_select_multi_range"]);

            assert.deepEqual(getCategoriesContent(comp, getCounters), [1, 3]);
            assert.deepEqual(getFiltersContent(comp, getCounters), [1, 1, 2]);

            await click(getFilter(comp, 0, "input"));

            assert.deepEqual(getCategoriesContent(comp, getCounters), [1]);
            assert.deepEqual(getFiltersContent(comp, getCounters), [1, 1, 2]);

            assert.verifySteps(["searchpanelSelectRange", "search_panel_select_multi_range"]);
        }
    );

    QUnit.test("many2one: select one, expand, hierarchize, counters", async (assert) => {
        assert.expect(5);

        serverData.models.company.records.push(
            { id: 50, name: "agrobeurre", parentId: 5 },
            { id: 51, name: "agrocrèmefraiche", parentId: 5 }
        );
        serverData.models.partner.records[1].companyId = 50;
        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="companyId" enableCounters="1" expand="1"/>
                </searchpanel>
            </search>`;

        const { TestComponent } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        assert.containsN(comp, ".o-searchpanel-field .o-searchpanel-category-value", 3);
        assert.containsOnce(comp, ".o-toggle-fold > i");
        assert.deepEqual(getCategoriesContent(comp, getCounters), [2, 1]);

        await click(getCategory(comp, "agrolait"));

        assert.containsN(comp, ".o-searchpanel-field .o-searchpanel-category-value", 5);
        assert.deepEqual(getCategoriesContent(comp, getCounters), [2, 1, 1]);
    });

    QUnit.test("many2one: select one, no expand, hierarchize, counters", async (assert) => {
        assert.expect(5);

        serverData.models.company.records.push(
            { id: 50, name: "agrobeurre", parentId: 5 },
            { id: 51, name: "agrocrèmefraiche", parentId: 5 }
        );
        serverData.models.partner.records[1].companyId = 50;
        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="companyId" enableCounters="1"/>
                </searchpanel>
            </search>`;

        const { TestComponent } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        assert.containsN(comp, ".o-searchpanel-field .o-searchpanel-category-value", 3);
        assert.containsOnce(comp, ".o-toggle-fold > i");
        assert.deepEqual(getCategoriesContent(comp, getCounters), [2, 1]);

        await click(getCategory(comp, "agrolait"));

        assert.containsN(comp, ".o-searchpanel-field .o-searchpanel-category-value", 4);
        assert.deepEqual(getCategoriesContent(comp, getCounters), [2, 1, 1]);
    });

    QUnit.test("many2one: select one, expand, no hierarchize, counters", async (assert) => {
        assert.expect(3);

        serverData.models.company.records.push(
            { id: 50, name: "agrobeurre", parentId: 5 },
            { id: 51, name: "agrocrèmefraiche", parentId: 5 }
        );
        serverData.models.partner.records[1].companyId = 50;
        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="companyId" hierarchize="0" enableCounters="1" expand="1"/>
                </searchpanel>
            </search>`;

        const { TestComponent } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        assert.containsN(comp, ".o-searchpanel-field .o-searchpanel-category-value", 5);
        assert.containsNone(comp, ".o-toggle-fold > i");
        assert.deepEqual(getCategoriesContent(comp, getCounters), [2, 1, 1]);
    });

    QUnit.test("many2one: select one, no expand, no hierarchize, counters", async (assert) => {
        assert.expect(3);

        serverData.models.company.records.push(
            { id: 50, name: "agrobeurre", parentId: 5 },
            { id: 51, name: "agrocrèmefraiche", parentId: 5 }
        );
        serverData.models.partner.records[1].companyId = 50;
        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="companyId" hierarchize="0" enableCounters="1"/>
                </searchpanel>
            </search>`;

        const { TestComponent } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        assert.containsN(comp, ".o-searchpanel-field .o-searchpanel-category-value", 4);
        assert.containsNone(comp, ".o-toggle-fold > i");
        assert.deepEqual(getCategoriesContent(comp, getCounters), [2, 1, 1]);
    });

    QUnit.test("many2one: select one, expand, hierarchize, no counters", async (assert) => {
        assert.expect(5);

        serverData.models.company.records.push(
            { id: 50, name: "agrobeurre", parentId: 5 },
            { id: 51, name: "agrocrèmefraiche", parentId: 5 }
        );
        serverData.models.partner.records[1].companyId = 50;
        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="companyId" expand="1"/>
                </searchpanel>
            </search>`;

        const { TestComponent } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        assert.containsN(comp, ".o-searchpanel-field .o-searchpanel-category-value", 3);
        assert.containsOnce(comp, ".o-toggle-fold > i");
        assert.deepEqual(getCategoriesContent(comp, getCounters), []);

        await click(getCategory(comp, "agrolait"));

        assert.containsN(comp, ".o-searchpanel-field .o-searchpanel-category-value", 5);
        assert.deepEqual(getCategoriesContent(comp, getCounters), []);
    });

    QUnit.test("many2one: select one, no expand, hierarchize, no counters", async (assert) => {
        assert.expect(5);

        serverData.models.company.records.push(
            { id: 50, name: "agrobeurre", parentId: 5 },
            { id: 51, name: "agrocrèmefraiche", parentId: 5 }
        );
        serverData.models.partner.records[1].companyId = 50;
        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="companyId"/>
                </searchpanel>
            </search>`;

        const { TestComponent } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        assert.containsN(comp, ".o-searchpanel-field .o-searchpanel-category-value", 3);
        assert.containsOnce(comp, ".o-toggle-fold > i");
        assert.deepEqual(getCategoriesContent(comp, getCounters), []);

        await click(getCategory(comp, "agrolait"));

        assert.containsN(comp, ".o-searchpanel-field .o-searchpanel-category-value", 4);
        assert.deepEqual(getCategoriesContent(comp, getCounters), []);
    });

    QUnit.test("many2one: select one, expand, no hierarchize, no counters", async (assert) => {
        assert.expect(3);

        serverData.models.company.records.push(
            { id: 50, name: "agrobeurre", parentId: 5 },
            { id: 51, name: "agrocrèmefraiche", parentId: 5 }
        );
        serverData.models.partner.records[1].companyId = 50;
        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="companyId" hierarchize="0" expand="1"/>
                </searchpanel>
            </search>`;

        const { TestComponent } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        assert.containsN(comp, ".o-searchpanel-field .o-searchpanel-category-value", 5);
        assert.containsNone(comp, ".o-toggle-fold > i");
        assert.deepEqual(getCategoriesContent(comp, getCounters), []);
    });

    QUnit.test("many2one: select one, no expand, no hierarchize, no counters", async (assert) => {
        assert.expect(3);

        serverData.models.company.records.push(
            { id: 50, name: "agrobeurre", parentId: 5 },
            { id: 51, name: "agrocrèmefraiche", parentId: 5 }
        );
        serverData.models.partner.records[1].companyId = 50;
        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="companyId" hierarchize="0"/>
                </searchpanel>
            </search>`;

        const { TestComponent } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        assert.containsN(comp, ".o-searchpanel-field .o-searchpanel-category-value", 4);
        assert.containsNone(comp, ".o-toggle-fold > i");
        assert.deepEqual(getCategoriesContent(comp, getCounters), []);
    });

    QUnit.test("many2one: select multi, expand, groupby, counters", async (assert) => {
        assert.expect(3);

        serverData.models.company.records.push({ id: 666, name: "Mordor Inc.", categoryId: 6 });
        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="companyId" select="multi" groupby="categoryId" enableCounters="1" expand="1"/>
                </searchpanel>
            </search>`;

        const { TestComponent } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        assert.containsN(comp, ".o-searchpanel-label", 5);
        assert.containsNone(comp, ".o-toggle-fold > i");
        assert.deepEqual(getFiltersContent(comp, getCounters), [2, 2]);
    });

    QUnit.test("many2one: select multi, no expand, groupby, counters", async (assert) => {
        assert.expect(3);

        serverData.models.company.records.push({ id: 666, name: "Mordor Inc.", categoryId: 6 });
        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="companyId" select="multi" groupby="categoryId" enableCounters="1"/>
                </searchpanel>
            </search>`;

        const { TestComponent } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        assert.containsN(comp, ".o-searchpanel-label", 4);
        assert.containsNone(comp, ".o-toggle-fold > i");
        assert.deepEqual(getFiltersContent(comp, getCounters), [2, 2]);
    });

    QUnit.test("many2one: select multi, expand, no groupby, counters", async (assert) => {
        assert.expect(3);

        serverData.models.company.records.push({ id: 666, name: "Mordor Inc.", categoryId: 6 });
        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="companyId" select="multi" enableCounters="1" expand="1"/>
                </searchpanel>
            </search>`;

        const { TestComponent } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        assert.containsN(comp, ".o-searchpanel-label", 3);
        assert.containsNone(comp, ".o-toggle-fold > i");
        assert.deepEqual(getFiltersContent(comp, getCounters), [2, 2]);
    });

    QUnit.test("many2one: select multi, no expand, no groupby, counters", async (assert) => {
        assert.expect(3);

        serverData.models.company.records.push({ id: 666, name: "Mordor Inc.", categoryId: 6 });
        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="companyId" select="multi" enableCounters="1"/>
                </searchpanel>
            </search>`;

        const { TestComponent } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        assert.containsN(comp, ".o-searchpanel-label", 2);
        assert.containsNone(comp, ".o-toggle-fold > i");
        assert.deepEqual(getFiltersContent(comp, getCounters), [2, 2]);
    });

    QUnit.test("many2one: select multi, expand, groupby, no counters", async (assert) => {
        assert.expect(3);

        serverData.models.company.records.push({ id: 666, name: "Mordor Inc.", categoryId: 6 });
        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="companyId" select="multi" groupby="categoryId" expand="1"/>
                </searchpanel>
            </search>`;

        const { TestComponent } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        assert.containsN(comp, ".o-searchpanel-label", 5);
        assert.containsNone(comp, ".o-toggle-fold > i");
        assert.deepEqual(getFiltersContent(comp, getCounters), []);
    });

    QUnit.test("many2one: select multi, no expand, groupby, no counters", async (assert) => {
        assert.expect(3);

        serverData.models.company.records.push({ id: 666, name: "Mordor Inc.", categoryId: 6 });
        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="companyId" select="multi" groupby="categoryId"/>
                </searchpanel>
            </search>`;

        const { TestComponent } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        assert.containsN(comp, ".o-searchpanel-label", 4);
        assert.containsNone(comp, ".o-toggle-fold > i");
        assert.deepEqual(getFiltersContent(comp, getCounters), []);
    });

    QUnit.test("many2one: select multi, expand, no groupby, no counters", async (assert) => {
        assert.expect(3);

        serverData.models.company.records.push({ id: 666, name: "Mordor Inc.", categoryId: 6 });
        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="companyId" select="multi" expand="1"/>
                </searchpanel>
            </search>`;

        const { TestComponent } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        assert.containsN(comp, ".o-searchpanel-label", 3);
        assert.containsNone(comp, ".o-toggle-fold > i");
        assert.deepEqual(getFiltersContent(comp, getCounters), []);
    });

    QUnit.test("many2one: select multi, no expand, no groupby, no counters", async (assert) => {
        assert.expect(3);

        serverData.models.company.records.push({ id: 666, name: "Mordor Inc.", categoryId: 6 });
        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="companyId" select="multi"/>
                </searchpanel>
            </search>`;

        const { TestComponent } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        assert.containsN(comp, ".o-searchpanel-label", 2);
        assert.containsNone(comp, ".o-toggle-fold > i");
        assert.deepEqual(getFiltersContent(comp, getCounters), []);
    });

    QUnit.test("many2many: select multi, expand, groupby, counters", async (assert) => {
        assert.expect(3);

        serverData.models.company.records.push({ id: 666, name: "Mordor Inc.", categoryId: 6 });
        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="companyIds" select="multi" groupby="categoryId" enableCounters="1" expand="1"/>
                </searchpanel>
            </search>`;

        const { TestComponent } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        assert.containsN(comp, ".o-searchpanel-label", 5);
        assert.containsNone(comp, ".o-toggle-fold > i");
        assert.deepEqual(getFiltersContent(comp, getCounters), [2, 1]);
    });

    QUnit.test("many2many: select multi, no expand, groupby, counters", async (assert) => {
        assert.expect(3);

        serverData.models.company.records.push({ id: 666, name: "Mordor Inc.", categoryId: 6 });
        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="companyIds" select="multi" groupby="categoryId" enableCounters="1"/>
                </searchpanel>
            </search>`;

        const { TestComponent } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        assert.containsN(comp, ".o-searchpanel-label", 4);
        assert.containsNone(comp, ".o-toggle-fold > i");
        assert.deepEqual(getFiltersContent(comp, getCounters), [2, 1]);
    });

    QUnit.test("many2many: select multi, expand, no groupby, counters", async (assert) => {
        assert.expect(3);

        serverData.models.company.records.push({ id: 666, name: "Mordor Inc.", categoryId: 6 });
        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="companyIds" select="multi" enableCounters="1" expand="1"/>
                </searchpanel>
            </search>`;

        const { TestComponent } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        assert.containsN(comp, ".o-searchpanel-label", 3);
        assert.containsNone(comp, ".o-toggle-fold > i");
        assert.deepEqual(getFiltersContent(comp, getCounters), [2, 1]);
    });

    QUnit.test("many2many: select multi, no expand, no groupby, counters", async (assert) => {
        assert.expect(3);

        serverData.models.company.records.push({ id: 666, name: "Mordor Inc.", categoryId: 6 });
        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="companyIds" select="multi" enableCounters="1"/>
                </searchpanel>
            </search>`;

        const { TestComponent } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        assert.containsN(comp, ".o-searchpanel-label", 2);
        assert.containsNone(comp, ".o-toggle-fold > i");
        assert.deepEqual(getFiltersContent(comp, getCounters), [2, 1]);
    });

    QUnit.test("many2many: select multi, expand, groupby, no counters", async (assert) => {
        assert.expect(3);

        serverData.models.company.records.push({ id: 666, name: "Mordor Inc.", categoryId: 6 });
        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="companyIds" select="multi" groupby="categoryId" expand="1"/>
                </searchpanel>
            </search>`;

        const { TestComponent } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        assert.containsN(comp, ".o-searchpanel-label", 5);
        assert.containsNone(comp, ".o-toggle-fold > i");
        assert.deepEqual(getFiltersContent(comp, getCounters), []);
    });

    QUnit.test("many2many: select multi, no expand, groupby, no counters", async (assert) => {
        assert.expect(3);

        serverData.models.company.records.push({ id: 666, name: "Mordor Inc.", categoryId: 6 });
        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="companyIds" select="multi" groupby="categoryId"/>
                </searchpanel>
            </search>`;

        const { TestComponent } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        assert.containsN(comp, ".o-searchpanel-label", 4);
        assert.containsNone(comp, ".o-toggle-fold > i");
        assert.deepEqual(getFiltersContent(comp, getCounters), []);
    });

    QUnit.test("many2many: select multi, expand, no groupby, no counters", async (assert) => {
        assert.expect(3);

        serverData.models.company.records.push({ id: 666, name: "Mordor Inc.", categoryId: 6 });
        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="companyIds" select="multi" expand="1"/>
                </searchpanel>
            </search>`;

        const { TestComponent } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        assert.containsN(comp, ".o-searchpanel-label", 3);
        assert.containsNone(comp, ".o-toggle-fold > i");
        assert.deepEqual(getFiltersContent(comp, getCounters), []);
    });

    QUnit.test("many2many: select multi, no expand, no groupby, no counters", async (assert) => {
        assert.expect(3);

        serverData.models.company.records.push({ id: 666, name: "Mordor Inc.", categoryId: 6 });
        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="companyIds" select="multi"/>
                </searchpanel>
            </search>`;

        const { TestComponent } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        assert.containsN(comp, ".o-searchpanel-label", 2);
        assert.containsNone(comp, ".o-toggle-fold > i");
        assert.deepEqual(getFiltersContent(comp, getCounters), []);
    });

    QUnit.test("selection: select one, expand, counters", async (assert) => {
        assert.expect(3);

        serverData.models.partner.records.shift();
        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="state" enableCounters="1" expand="1"/>
                </searchpanel>
            </search>`;

        const { TestComponent } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        assert.containsN(comp, ".o-searchpanel-field .o-searchpanel-category-value", 4);
        assert.containsNone(comp, ".o-toggle-fold > i");
        assert.deepEqual(getCategoriesContent(comp, getCounters), [1, 2]);
    });

    QUnit.test("selection: select one, no expand, counters", async (assert) => {
        assert.expect(3);

        serverData.models.partner.records.shift();
        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="state" enableCounters="1"/>
                </searchpanel>
            </search>`;

        const { TestComponent } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        assert.containsN(comp, ".o-searchpanel-field .o-searchpanel-category-value", 3);
        assert.containsNone(comp, ".o-toggle-fold > i");
        assert.deepEqual(getCategoriesContent(comp, getCounters), [1, 2]);
    });

    QUnit.test("selection: select one, expand, no counters", async (assert) => {
        assert.expect(3);

        serverData.models.partner.records.shift();
        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="state" expand="1"/>
                </searchpanel>
            </search>`;

        const { TestComponent } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        assert.containsN(comp, ".o-searchpanel-field .o-searchpanel-category-value", 4);
        assert.containsNone(comp, ".o-toggle-fold > i");
        assert.deepEqual(getCategoriesContent(comp, getCounters), []);
    });

    QUnit.test("selection: select one, no expand, no counters", async (assert) => {
        assert.expect(3);

        serverData.models.partner.records.shift();
        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="state"/>
                </searchpanel>
            </search>`;

        const { TestComponent } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        assert.containsN(comp, ".o-searchpanel-field .o-searchpanel-category-value", 3);
        assert.containsNone(comp, ".o-toggle-fold > i");
        assert.deepEqual(getCategoriesContent(comp, getCounters), []);
    });

    QUnit.test("selection: select multi, expand, counters", async (assert) => {
        assert.expect(3);

        serverData.models.partner.records.shift();
        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="state" select="multi" enableCounters="1" expand="1"/>
                </searchpanel>
            </search>`;

        const { TestComponent } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        assert.containsN(comp, ".o-searchpanel-label", 3);
        assert.containsNone(comp, ".o-toggle-fold > i");
        assert.deepEqual(getFiltersContent(comp, getCounters), [1, 2]);
    });

    QUnit.test("selection: select multi, no expand, counters", async (assert) => {
        assert.expect(3);

        serverData.models.partner.records.shift();
        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="state" select="multi" enableCounters="1"/>
                </searchpanel>
            </search>`;

        const { TestComponent } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        assert.containsN(comp, ".o-searchpanel-label", 2);
        assert.containsNone(comp, ".o-toggle-fold > i");
        assert.deepEqual(getFiltersContent(comp, getCounters), [1, 2]);
    });

    QUnit.test("selection: select multi, expand, no counters", async (assert) => {
        assert.expect(3);

        serverData.models.partner.records.shift();
        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="state" select="multi" expand="1"/>
                </searchpanel>
            </search>`;

        const { TestComponent } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        assert.containsN(comp, ".o-searchpanel-label", 3);
        assert.containsNone(comp, ".o-toggle-fold > i");
        assert.deepEqual(getFiltersContent(comp, getCounters), []);
    });

    QUnit.test("selection: select multi, no expand, no counters", async (assert) => {
        assert.expect(3);

        serverData.models.partner.records.shift();
        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="state" select="multi"/>
                </searchpanel>
            </search>`;

        const { TestComponent } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        assert.containsN(comp, ".o-searchpanel-label", 2);
        assert.containsNone(comp, ".o-toggle-fold > i");
        assert.deepEqual(getFiltersContent(comp, getCounters), []);
    });

    //-------------------------------------------------------------------------
    // Model domain and count domain distinction
    //-------------------------------------------------------------------------

    QUnit.test("selection: select multi, no expand, counters, extra_domain", async (assert) => {
        assert.expect(5);

        serverData.models.partner.records.shift();
        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="companyId"/>
                    <field name="state" select="multi" enableCounters="1"/>
                </searchpanel>
            </search>`;

        const { TestComponent } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        assert.containsN(comp, ".o-searchpanel-label", 5);
        assert.containsNone(comp, ".o-toggle-fold > i");
        assert.deepEqual(getFiltersContent(comp, getCounters), [1, 2]);

        await click(getCategory(comp, "asustek"));

        assert.containsN(comp, ".o-searchpanel-label", 5);
        assert.deepEqual(getFiltersContent(comp, getCounters), [1]);
    });

    //-------------------------------------------------------------------------
    // Limit
    //-------------------------------------------------------------------------

    QUnit.test("reached limit for a category", async (assert) => {
        assert.expect(6);
        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="companyId" limit="2"/>
                </searchpanel>
            </search>`;

        const { TestComponent } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        assert.containsOnce(comp, ".o-searchpanel-section");
        assert.containsOnce(comp, ".o-searchpanel-section-header");
        assert.strictEqual(
            comp.el.querySelector(".o-searchpanel-section-header").innerText,
            "COMPANY"
        );
        assert.containsOnce(comp, "section div.alert.alert-warning");
        assert.strictEqual(
            comp.el.querySelector("section div.alert.alert-warning").innerText,
            "Too many items to display."
        );
        assert.containsNone(comp, ".o-searchpanel-category-value");
    });

    QUnit.test("reached limit for a filter", async (assert) => {
        assert.expect(6);
        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="companyId" select="multi" limit="2"/>
                </searchpanel>
            </search>`;

        const { TestComponent } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        assert.containsOnce(comp, ".o-searchpanel-section");
        assert.containsOnce(comp, ".o-searchpanel-section-header");
        assert.strictEqual(
            comp.el.querySelector(".o-searchpanel-section-header").innerText,
            "COMPANY"
        );
        assert.containsOnce(comp, "section div.alert.alert-warning");
        assert.strictEqual(
            comp.el.querySelector("section div.alert.alert-warning").innerText,
            "Too many items to display."
        );
        assert.containsNone(comp, ".o-searchpanel-filter-value");
    });

    QUnit.test(
        "a selected value becomming invalid should no more impact the view",
        async (assert) => {
            assert.expect(8);
            serverData.views["partner,false,search"] = /* xml */ `
                <search>
                    <filter name="filter_on_def" string="DEF" domain="[('state', '=', 'def')]"/>
                    <searchpanel>
                        <field name="state" enableCounters="1"/>
                    </searchpanel>
                </search>`;

            const { TestComponent } = makeTestComponent();
            const comp = await makeWithSearch({
                serverData,
                async mockRPC(route, { method }) {
                    if (/search_panel_/.test(method || route)) {
                        assert.step(method || route);
                    }
                },
                Component: TestComponent,
                resModel: "partner",
                searchViewId: false,
            });

            assert.verifySteps(["searchpanelSelectRange"]);

            // select 'ABC' in search panel
            await click(getCategory(comp, 1));

            assert.verifySteps(["searchpanelSelectRange"]);

            // select DEF in filter menu
            await toggleFilterMenu(comp);
            await toggleMenuItem(comp, "DEF");

            assert.verifySteps(["searchpanelSelectRange"]);

            const firstCategoryValue = getCategory(comp, 0);
            assert.strictEqual(firstCategoryValue.innerText, "All");
            assert.hasClass(
                firstCategoryValue,
                "active",
                "the value 'All' should be selected since ABC is no longer a valid value with respect to search domain"
            );
        }
    );

    QUnit.test(
        "Categories with default attributes should be udpated when external domain changes",
        async (assert) => {
            assert.expect(8);

            serverData.views["partner,false,search"] = /* xml */ `
                <search>
                    <filter name="filter_on_def" string="DEF" domain="[('state', '=', 'def')]"/>
                    <searchpanel>
                        <field name="state"/>
                    </searchpanel>
                </search>`;

            const { TestComponent } = makeTestComponent();
            const comp = await makeWithSearch({
                serverData,
                async mockRPC(route, { method }) {
                    if (/search_panel_/.test(method || route)) {
                        assert.step(method || route);
                    }
                },
                Component: TestComponent,
                resModel: "partner",
                searchViewId: false,
            });

            assert.verifySteps(["searchpanelSelectRange"]);
            assert.deepEqual(getCategoriesContent(comp), ["All", "ABC", "DEF", "GHI"]);

            // select 'ABC' in search panel --> no need to update the category value
            await click(getCategory(comp, 1));

            assert.verifySteps([]);
            assert.deepEqual(getCategoriesContent(comp), ["All", "ABC", "DEF", "GHI"]);

            // select DEF in filter menu --> the external domain changes --> the values should be updated
            await toggleFilterMenu(comp);
            await toggleMenuItem(comp, "DEF");

            assert.verifySteps(["searchpanelSelectRange"]);
            assert.deepEqual(getCategoriesContent(comp), ["All", "DEF"]);
        }
    );

    QUnit.test("Category with counters and filter with domain", async (assert) => {
        assert.expect(1);

        serverData.views["partner,false,search"] = /* xml */ `
            <search>
                <searchpanel>
                    <field name="categoryId"/>
                    <field name="companyId" select="multi" domain="[['categoryId', '=', categoryId]]"/>
                </searchpanel>
            </search>`;

        const { TestComponent } = makeTestComponent();
        const comp = await makeWithSearch({
            serverData,
            Component: TestComponent,
            resModel: "partner",
            searchViewId: false,
        });

        assert.deepEqual(getCategoriesContent(comp), ["All", "gold", "silver"]);
    });
});
