verp.define('web.pivot_tests', function (require) {
"use strict";

var core = require('web.core');
var PivotView = require('web.PivotView');
const PivotController = require("web.PivotController");
var testUtils = require('web.testUtils');
var testUtilsDom = require('web.test_utils_dom');
const { browser } = require('@web/core/browser/browser');
const { patchWithCleanup } = require('@web/../tests/helpers/utils');
const { registry } = require('@web/core/registry');
const legacyViewRegistry = require('web.viewRegistry');

const { createWebClient, doAction } = require('@web/../tests/webclient/helpers');

var _t = core._t;
const cpHelpers = require('@web/../tests/search/helpers');
var createView = testUtils.createView;
var patchDate = testUtils.mock.patchDate;

/**
 * Helper function that returns, given a pivot instance, the values of the
 * table, separated by ','.
 *
 * @returns {string}
 */
var getCurrentValues = function (pivot) {
    return pivot.$('.o-pivot-cell-value div').map(function () {
        return $(this).text();
    }).get().join();
};


let serverData;

QUnit.module('Views', {
    beforeEach: function () {
        registry.category("views").remove("pivot"); // remove new pivot from registry
        legacyViewRegistry.add("pivot", PivotView); // add legacy pivot -> will be wrapped and added to new registry

        this.data = {
            partner: {
                fields: {
                    foo: {string: "Foo", type: "integer", searchable: true, groupOperator: 'sum'},
                    bar: {string: "bar", type: "boolean", store: true, sortable: true},
                    date: {string: "Date", type: "date", store: true, sortable: true},
                    productId: {string: "Product", type: "many2one", relation: 'product', store: true},
                    other_product_id: {string: "Other Product", type: "many2one", relation: 'product', store: true},
                    non_stored_m2o: {string: "Non Stored M2O", type: "many2one", relation: 'product'},
                    customer: {string: "Customer", type: "many2one", relation: 'customer', store: true},
                    computed_field: {string: "Computed and not stored", type: 'integer', compute: true, groupOperator: 'sum'},
                    company_type: {
                        string: "Company Type", type: "selection",
                        selection: [["company", "Company"], ["individual", "individual"]],
                        searchable: true, sortable: true, store: true,
                    },
                },
                records: [
                    {
                        id: 1,
                        foo: 12,
                        bar: true,
                        date: '2016-12-14',
                        productId: 37,
                        customer: 1,
                        computed_field: 19,
                        company_type: 'company',
                    }, {
                        id: 2,
                        foo: 1,
                        bar: true,
                        date: '2016-10-26',
                        productId: 41,
                        customer: 2,
                        computed_field: 23,
                        company_type: 'individual',
                    }, {
                        id: 3,
                        foo: 17,
                        bar: true,
                        date: '2016-12-15',
                        productId: 41,
                        customer: 2,
                        computed_field: 26,
                        company_type: 'company',
                    }, {
                        id: 4,
                        foo: 2,
                        bar: false,
                        date: '2016-04-11',
                        productId: 41,
                        customer: 1,
                        computed_field: 19,
                        company_type: 'individual',
                    },
                ]
            },
            product: {
                fields: {
                    name: {string: "Product Name", type: "char"}
                },
                records: [{
                    id: 37,
                    displayName: "xphone",
                }, {
                    id: 41,
                    displayName: "xpad",
                }]
            },
            customer: {
                fields: {
                    name: {string: "Customer Name", type: "char"}
                },
                records: [{
                    id: 1,
                    displayName: "First",
                }, {
                    id: 2,
                    displayName: "Second",
                }]
            },
        };

        serverData = { models: this.data };
        patchWithCleanup(browser, { setTimeout: (fn) => fn() });
    },
}, function () {
    QUnit.module('Legacy PivotView');

    QUnit.test('simple pivot rendering', async function (assert) {
        assert.expect(3);

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot string="Partners">' +
                        '<field name="foo" type="measure"/>' +
                '</pivot>',
            mockRPC: function (route, args) {
                assert.strictEqual(args.kwargs.lazy, false,
                    "the readGroup should be done with the lazy=false option");
                return this._super.apply(this, arguments);
            },
        });

        assert.hasClass(pivot.$('table'), 'o-enable-linking',
            "table should have classname 'o-enable-linking'");
        assert.strictEqual(pivot.$('td.o-pivot-cell-value:contains(32)').length, 1,
                    "should contain a pivot cell with the sum of all records");
        pivot.destroy();
    });

    QUnit.test('pivot rendering with widget', async function (assert) {
        assert.expect(1);

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot string="Partners">' +
                        '<field name="foo" type="measure" widget="floatTime"/>' +
                '</pivot>',
        });

        assert.strictEqual(pivot.$('td.o-pivot-cell-value:contains(32:00)').length, 1,
                    "should contain a pivot cell with the sum of all records");
        pivot.destroy();
    });

    QUnit.test('pivot rendering with string attribute on field', async function (assert) {
        assert.expect(1);

        this.data.partner.fields.foo = {string: "Foo", type: "integer", store: true, groupOperator: 'sum'};

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot string="Partners">' +
                        '<field name="foo" string="BAR" type="measure"/>' +
                '</pivot>',
        });

        assert.strictEqual(pivot.$('.o-pivot-measure-row').text(), "BAR",
                    "the displayed name should be the one set in the string attribute");
        pivot.destroy();
    });

    QUnit.test('pivot rendering with string attribute on non stored field', async function (assert) {
        assert.expect(1);

        this.data.partner.fields.fubar = {string: "Fubar", type: "integer", store: false, groupOperator: 'sum'};

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot string="Partners">' +
                        '<field name="fubar" string="fubar" type="measure"/>' +
                '</pivot>',
        });
        assert.containsOnce(pivot, '.o-legacy-pivot', 'Non stored fields can have a string attribute');
        pivot.destroy();
    });

    QUnit.test('pivot rendering with invisible attribute on field', async function (assert) {
        assert.expect(3);
        // when invisible, a field should neither be an active measure,
        // nor be a selectable measure.
        _.extend(this.data.partner.fields, {
            foo: {string: "Foo", type: "integer", store: true, groupOperator: 'sum'},
            foo2: {string: "Foo2", type: "integer", store: true, groupOperator: 'sum'}
        });

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot string="Partners">' +
                        '<field name="foo" type="measure"/>' +
                        '<field name="foo2" type="measure" invisible="true"/>' +
                '</pivot>',
        });

        // there should be only one displayed measure as the other one is invisible
        assert.containsOnce(pivot, '.o-pivot-measure-row');
        // there should be only one measure besides count, as the other one is invisible
        assert.containsN(pivot, '.o-cp-bottom-left .dropdown-item', 2);
        // the invisible field souldn't be in the groupable fields neither
        await testUtils.dom.click(pivot.$('.o-pivot-header-cell-closed:first'));
        assert.containsNone(pivot, '.o-pivot-field-menu a[data-field="foo2"]');

        pivot.destroy();
    });

    QUnit.test('pivot view without "string" attribute', async function (assert) {
        assert.expect(1);

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot>' +
                        '<field name="foo" type="measure"/>' +
                '</pivot>',
        });

        // this is important for export functionality.
        assert.strictEqual(pivot.title, _t("Untitled"), "should have a valid title");
        pivot.destroy();
    });

    QUnit.test('group headers should have a tooltip', async function (assert) {
        assert.expect(2);

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot>' +
                        '<field name="productId" type="col"/>' +
                        '<field name="date" type="row"/>' +
                '</pivot>',
        });

        assert.strictEqual(pivot.$('tbody .o-pivot-header-cell-closed:first').attr('data-original-title'), 'Date');
        assert.strictEqual(pivot.$('thead .o-pivot-header-cell-closed:first').attr('data-original-title'), 'Product');

        pivot.destroy();
    });

    QUnit.test('pivot view add computed fields explicitly defined as measure', async function (assert) {
        assert.expect(1);

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot>' +
                        '<field name="computed_field" type="measure"/>' +
                '</pivot>',
        });

        assert.ok(pivot.measures.computed_field, "measures contains the field 'computed_field'");
        pivot.destroy();
    });

    QUnit.test('clicking on a cell triggers a doAction', async function (assert) {
        assert.expect(2);

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot>' +
                        '<field name="productId" type="row"/>' +
                        '<field name="foo" type="measure"/>' +
                '</pivot>',
            intercepts: {
                doAction: function (ev) {
                    assert.deepEqual(ev.data.action, {
                        context: {someKey: true, userContextKey: true},
                        domain: [['productId', '=', 37]],
                        name: 'Partners',
                        resModel: 'partner',
                        target: 'current',
                        type: 'ir.actions.actwindow',
                        viewMode: 'list',
                        views: [[false, 'list'], [2, 'form']],
                    }, "should trigger doAction with the correct args");
                },
            },
            session: {
                userContext: {userContextKey: true},
            },
            viewOptions: {
                action: {
                    views: [
                        { viewID: 2, type: 'form' },
                        { viewID: 5, type: 'kanban' },
                        { viewID: false, type: 'list' },
                        { viewID: false, type: 'pivot' },
                    ],
                },
                context: {someKey: true, search_default_test: 3},
                title: 'Partners',
            }
        });

        assert.hasClass(pivot.$('table'), 'o-enable-linking',
            "table should have classname 'o-enable-linking'");
        await testUtils.dom.click(pivot.$('.o-pivot-cell-value:contains(12)')); // should trigger a doAction

        pivot.destroy();
    });

    QUnit.test('row and column are highlighted when hovering a cell', async function (assert) {
        assert.expect(11);

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot string="Partners">' +
                        '<field name="foo" type="col"/>' +
                        '<field name="productId" type="row"/>' +
                '</pivot>',
        });

        // check row highlighting
        assert.hasClass(pivot.$('table'), 'table-hover',
            "with className 'table-hover', rows are highlighted (bootstrap)");

        // check column highlighting
        // hover third measure
        await testUtils.dom.triggerEvents(pivot.$('th.o-pivot-measure-row:nth(2)'), 'mouseover');
        assert.containsN(pivot, '.o-cell-hover', 3);
        for (var i = 0; i < 3; i++) {
            assert.hasClass(pivot.$('tbody tr:nth(' + i + ') td:nth(2)'), 'o-cell-hover');
        }
        await testUtils.dom.triggerEvents(pivot.$('th.o-pivot-measure-row:nth(2)'), 'mouseout');
        assert.containsNone(pivot, '.o-cell-hover');

        // hover second cell, second row
        await testUtils.dom.triggerEvents(pivot.$('tbody tr:nth(1) td:nth(1)'), 'mouseover');
        assert.containsN(pivot, '.o-cell-hover', 3);
        for (i = 0; i < 3; i++) {
            assert.hasClass(pivot.$('tbody tr:nth(' + i + ') td:nth(1)'), 'o-cell-hover');
        }
        await testUtils.dom.triggerEvents(pivot.$('tbody tr:nth(1) td:nth(1)'), 'mouseout');
        assert.containsNone(pivot, '.o-cell-hover');

        pivot.destroy();
    });

    QUnit.test('pivot view with disable_linking="true"', async function (assert) {
        assert.expect(2);

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot disable_linking="true">' +
                        '<field name="foo" type="measure"/>' +
                '</pivot>',
            intercepts: {
                doAction: function () {
                    assert.ok(false, "should not trigger doAction");
                },
            },
        });

        assert.doesNotHaveClass(pivot.$('table'), 'o-enable-linking',
            "table should not have classname 'o-enable-linking'");
        assert.containsOnce(pivot, '.o-pivot-cell-value',
            "should have one cell");
        await testUtils.dom.click(pivot.$('.o-pivot-cell-value')); // should not trigger a doAction

        pivot.destroy();
    });

    QUnit.test('clicking on the "Total" Cell with time range activated gives the right action domain', async function (assert) {
        assert.expect(2);

        var unpatchDate = patchDate(2016, 11, 20, 1, 0, 0);
        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot/>',
            archs: {
                'partner,false,search': `
                    <search>
                        <filter name="date_filter" date="date" domain="[]" default_period='this_month'/>
                    </search>
                `,
            },
            intercepts: {
                doAction: function (ev) {
                    assert.deepEqual(
                        ev.data.action.domain,
                        ["&",["date",">=","2016-12-01"],["date","<=","2016-12-31"]],
                        "should trigger doAction with the correct action domain"
                    );
                },
            },
            viewOptions: {
                context: { search_default_date_filter: true, },
                title: 'Partners',
            },
        });

        assert.hasClass(pivot.$('table'), 'o-enable-linking',
            "root node should have classname 'o-enable-linking'");
        await testUtilsDom.click(pivot.$('.o-pivot-cell-value'));

        unpatchDate();
        pivot.destroy();
    });

    QUnit.test('clicking on a fake cell value ("empty group") in comparison mode gives an action domain equivalent to [[0,"=",1]]', async function (assert) {
        assert.expect(3);

        var unpatchDate = patchDate(2016, 11, 20, 1, 0, 0);

        this.data.partner.records[0].date = '2016-11-15';
        this.data.partner.records[1].date = '2016-11-17';
        this.data.partner.records[2].date = '2016-11-22';
        this.data.partner.records[3].date = '2016-11-03';

        var firstDoAction = true;
        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot>' +
                        '<field name="productId" type="row"/>' +
                    '</pivot>',
            intercepts: {
                doAction: function (ev) {
                    if (firstDoAction) {
                        assert.deepEqual(
                            ev.data.action.domain,
                            ["&",["date",">=","2016-12-01"],["date","<=","2016-12-31"]],
                            "should trigger doAction with the correct action domain"
                        );
                    } else {
                        assert.deepEqual(
                            ev.data.action.domain,
                            [[0, "=", 1]],
                            "should trigger doAction with the correct action domain"
                        );
                    }
                    firstDoAction = false;
                },
            },
            archs: {
                'partner,false,search': `
                    <search>
                        <filter name="date_filter" date="date" domain="[]" default_period='this_month'/>
                    </search>
                `,
            },
            viewOptions: {
                context: { search_default_date_filter: true, },
                title: 'Partners',
            },
        });

        await cpHelpers.toggleComparisonMenu(pivot.el);
        await cpHelpers.toggleMenuItem(pivot.el, 'Date: Previous period');

        assert.hasClass(pivot.$('table'), 'o-enable-linking',
            "root node should have classname 'o-enable-linking'");
        // here we click on the group corresponding to Total/Total/This Month
        pivot.$('.o-pivot-cell-value').eq(1).click(); // should trigger a doAction with appropriate domain
        // here we click on the group corresponding to xphone/Total/This Month
        pivot.$('.o-pivot-cell-value').eq(4).click(); // should trigger a doAction with appropriate domain

        unpatchDate();
        pivot.destroy();
    });

    QUnit.test('pivot view grouped by date field', async function (assert) {
        assert.expect(2);

        var data = this.data;
        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot>' +
                        '<field name="date" interval="month" type="col"/>' +
                        '<field name="foo" type="measure"/>' +
                '</pivot>',
            mockRPC: function (route, params) {
                var wrong_fields = _.filter(params.kwargs.fields, function (field) {
                    return !(field.split(':')[0] in data.partner.fields);
                });
                assert.ok(!wrong_fields.length, 'fields given to readGroup should exist on the model');
                return this._super.apply(this, arguments);
            },
        });
        pivot.destroy();
    });

    QUnit.test('without measures, pivot view uses __count by default', async function (assert) {
        assert.expect(2);

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot></pivot>',
            mockRPC: function (route, args) {
                if (args.method === 'readGroup') {
                    assert.deepEqual(args.kwargs.fields, ['__count'],
                        "should make a readGroup with no valid fields");
                }
                return this._super(route, args);
            }
        });

        var $countMeasure = pivot.$buttons.find('.dropdown-item[data-field=__count]:first');
        assert.hasClass($countMeasure, 'selected', "The count measure should be activated");
        pivot.destroy();
    });

    QUnit.test('pivot view can be reloaded', async function (assert) {
        assert.expect(4);
        var readGroupCount = 0;

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot></pivot>',
            mockRPC: function (route, args) {
                if (args.method === 'readGroup') {
                    readGroupCount++;
                }
                return this._super(route, args);
            }
        });

        assert.strictEqual(pivot.$('td.o-pivot-cell-value:contains(4)').length, 1,
                    "should contain a pivot cell with the number of all records");
        assert.strictEqual(readGroupCount, 1, "should have done 1 rpc");

        await testUtils.pivot.reload(pivot, {domain: [['foo', '>', 10]]});
        assert.strictEqual(pivot.$('td.o-pivot-cell-value:contains(2)').length, 1,
                    "should contain a pivot cell with the number of remaining records");
        assert.strictEqual(readGroupCount, 2, "should have done 2 rpcs");
        pivot.destroy();
    });

    QUnit.test('pivot view grouped by many2one field', async function (assert) {
        assert.expect(3);

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot>' +
                        '<field name="productId" type="row"/>' +
                        '<field name="foo" type="measure"/>' +
                '</pivot>',
        });

        assert.containsOnce(pivot, '.o-pivot-header-cell-opened',
            "should have one opened header");
        assert.strictEqual(pivot.$('.o-pivot-header-cell-closed:contains(xphone)').length, 1,
            "should display one header with 'xphone'");
        assert.strictEqual(pivot.$('.o-pivot-header-cell-closed:contains(xpad)').length, 1,
            "should display one header with 'xpad'");
        pivot.destroy();
    });

    QUnit.test('basic folding/unfolding', async function (assert) {
        assert.expect(7);

        var rpcCount = 0;

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot>' +
                        '<field name="productId" type="row"/>' +
                        '<field name="foo" type="measure"/>' +
                '</pivot>',
            mockRPC: function () {
                rpcCount++;
                return this._super.apply(this, arguments);
            },
        });
        assert.containsN(pivot, 'tbody tr', 3,
            "should have 3 rows: 1 for the opened header, and 2 for data");

        // click on the opened header to close it
        await testUtils.dom.click(pivot.el.querySelector('.o-pivot-header-cell-opened'));

        assert.containsOnce(pivot, 'tbody tr', "should have 1 row");

        // click on closed header to open dropdown
        await testUtils.dom.click(pivot.el.querySelector('tbody .o-pivot-header-cell-closed'));
        assert.containsOnce(pivot, ".o-legacy-pivot .dropdown-menu");
        assert.strictEqual(
            pivot.el.querySelector(".o-legacy-pivot .dropdown-menu").innerText.replace(/\s/g, ""),
            "CompanyTypeCustomerDateOtherProductProductbar"
        );

        // open the Date sub dropdown
        await testUtils.dom.triggerEvent(pivot.el.querySelector(".o-legacy-pivot .dropdown-menu .dropdown-toggle.o-menu-item"), "mouseenter");
        assert.strictEqual(
            pivot.el
                .querySelector(".o-legacy-pivot .dropdown-menu .dropdown-menu")
                .innerText.replace(/\s/g, ""),
            "YearQuarterMonthWeekDay"
        );

        await testUtils.dom.click(
            pivot.el.querySelectorAll(
                ".o-legacy-pivot .dropdown-menu .dropdown-menu .dropdown-item"
            )[2]
        );

        assert.containsN(pivot, 'tbody tr', 4,
            "should have 4 rows: one for header, 3 for data");
        assert.strictEqual(rpcCount, 3,
            "should have done 3 rpcs (initial load) + open header with different groupbys");

        pivot.destroy();
    });

    QUnit.test('more folding/unfolding', async function (assert) {
        assert.expect(1);

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot>' +
                        '<field name="productId" type="row"/>' +
                        '<field name="foo" type="measure"/>' +
                '</pivot>',
        });

        // open dropdown to zoom into first row
        await testUtils.dom.click(pivot.el.querySelector("tbody .o-pivot-header-cell-closed"));
        // click on date by day
        await testUtils.dom.triggerEvent(pivot.el.querySelector("tbody .dropdown-menu .dropdown-toggle"), "mouseenter");
        await testUtils.dom.click(
            pivot.el.querySelector("tbody .dropdown-menu .dropdown-menu span:nth-child(5)")
        );

        // open dropdown to zoom into second row
        await testUtils.dom.click(pivot.el.querySelectorAll("tbody th.o-pivot-header-cell-closed")[1]);

        assert.containsN(pivot, 'tbody tr', 7,
            "should have 7 rows (1 for total, 1 for xphone, 1 for xpad, 4 for data)");

        pivot.destroy();
    });

    QUnit.test('fold and unfold header group', async function (assert) {
        assert.expect(3);

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot>' +
                        '<field name="productId" type="col"/>' +
                        '<field name="foo" type="measure"/>' +
                '</pivot>',
        });

        assert.containsN(pivot, 'thead tr', 3);

        // fold opened col group
        await testUtils.dom.click(pivot.$('thead .o-pivot-header-cell-opened'));
        assert.containsN(pivot, 'thead tr', 2);

        // unfold it
        await testUtils.dom.click(pivot.$('thead .o-pivot-header-cell-closed'));
        await testUtils.dom.click(pivot.el.querySelector(".dropdown-menu span:nth-child(5)"));
        assert.containsN(pivot, 'thead tr', 3);

        pivot.destroy();
    });

    QUnit.test('unfold second header group', async function (assert) {
        assert.expect(4);

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot>' +
                        '<field name="productId" type="col"/>' +
                        '<field name="foo" type="measure"/>' +
                '</pivot>',
        });

        assert.containsN(pivot, 'thead tr', 3);
        var values = ['12', '20', '32'];
        assert.strictEqual(getCurrentValues(pivot), values.join(','));

        // unfold it
        await testUtils.dom.click(pivot.$('thead .o-pivot-header-cell-closed:nth(1)'));
        await testUtils.dom.click(pivot.el.querySelector(".dropdown-menu span:nth-child(1)"));
        assert.containsN(pivot, 'thead tr', 4);
        values = ['12', '3', '17', '32'];
        assert.strictEqual(getCurrentValues(pivot), values.join(','));

        pivot.destroy();
    });

    QUnit.test('pivot renders group dropdown same as search groupby dropdown if group bys are specified in search arch', async function (assert) {
        assert.expect(6);

        const pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: `
                <pivot>
                    <field name="productId" type="row"/>
                    <field name="bar" type="col"/>
                    <field name="foo" type="measure"/>
                </pivot>`,
            archs: {
                'partner,false,search': `
                    <search>
                        <filter name="bar" string="bar" context="{'groupby': 'bar'}"/>
                        <field name="foo" string="foo" context="{'groupby': 'foo'}"/>
                        <filter name="productId" string="product" context="{'groupby': 'productId'}"/>
                    </search>
                `,
            },
        });

        // open group by dropdown
        await cpHelpers.toggleGroupByMenu(pivot.el);
        assert.containsN(pivot, '.o-control-panel .o-cp-bottom-right .dropdown-menu .o-menu-item', 3,
            "should have 3 dropdown items in searchView groupby");
        assert.containsOnce(pivot, '.o-control-panel .o-cp-bottom-right .dropdown-menu .o-add-custom_group_menu',
            "should have custom group generator in searchView groupby");

        // click on closed header to open dropdown
        await testUtils.dom.click(pivot.el.querySelector('tbody  tr:last-child .o-pivot-header-cell-closed'));
        assert.containsN(pivot, '.o-pivot-field-menu .o-menu-item', 3,
            "should have 3 dropdown items same as searchView groupby");
        assert.containsOnce(pivot, '.o-pivot-field-menu .o-add-custom_group_menu',
            "should have custom group generator same as searchView groupby");
        // check custom groupby selection has groupable fields only
        await testUtils.dom.triggerEvent(pivot.$('.o-pivot-field-menu .o-add-custom_group_menu .dropdown-toggle'), "mouseenter");
        assert.containsN(pivot, '.o-pivot-field-menu .o-add-custom_group_menu .dropdown-menu option', 6,
            "should have 6 fields in custom groupby");
        const optionDescriptions = [...pivot.$('.o-pivot-field-menu .o-add-custom_group_menu .dropdown-menu option')]
            .map(option => option.innerText.trim());
        assert.deepEqual(
            optionDescriptions,
            [
                "Company Type",
                "Customer",
                "Date",
                "Other Product",
                "Product",
                "bar"
            ],
            "should only have groupable fields in custom groupby");

        pivot.destroy();
    });

    QUnit.test('pivot group dropdown sync with search groupby dropdown', async function (assert) {
        assert.expect(6);

        const pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: `
                <pivot>
                    <field name="productId" type="row"/>
                    <field name="foo" type="measure"/>
                </pivot>`,
            archs: {
                'partner,false,search': `
                    <search>
                        <filter name="bar" string="bar" context="{'groupby': 'bar'}"/>
                        <filter name="productId" string="product" context="{'groupby': 'productId'}"/>
                    </search>
                `,
            },
        });

        // open group by dropdown
        await cpHelpers.toggleGroupByMenu(pivot.el);
        assert.containsN(pivot, '.o-control-panel .o-cp-bottom-right .dropdown-menu .o-menu-item', 2,
            "should have 2 dropdown items in searchView groupby");

        // click on closed header to open dropdown
        await testUtils.dom.click(pivot.el.querySelector('tbody tr:last-child .o-pivot-header-cell-closed'));
        assert.containsN(
            pivot.el,
            ".dropdown-menu .o-menu-item",
            2,
            "should have 2 dropdown items in pivot groupby"
        );

        await cpHelpers.toggleGroupByMenu(pivot.el);
        await cpHelpers.toggleAddCustomGroup(pivot.el);
        await cpHelpers.applyGroup(pivot.el);
        assert.containsN(pivot, '.o-control-panel .o-cp-bottom-right .dropdown-menu .o-menu-item', 3,
            "should have 3 dropdown items in searchView groupby now");

        // click on closed header to open dropdown
        await testUtils.dom.click(pivot.el.querySelector('tbody tr:last-child .o-pivot-header-cell-closed'));
        // applying groupby/custom groupby will update pivot groupby dropdown while reverse is not true
        assert.containsN(pivot, '.o-pivot-field-menu .o-menu-item', 3,
            "should have 3 dropdown items same as searchView groupby");

        // add a custom group in pivot groupby
        await testUtils.dom.triggerEvent(pivot.$('.o-pivot-field-menu .o-add-custom_group_menu .dropdown-toggle'), "mouseenter");
        await testUtils.fields.editSelect(pivot.$('.o-pivot-field-menu .o-add-custom_group_menu select'), 'date');
        await testUtils.dom.click(pivot.$('.o-pivot-field-menu .o-add-custom_group_menu .dropdown-menu button'));
        // click on closed header to open groupby selection dropdown
        await testUtils.dom.click(pivot.el.querySelector('tbody tr:last-child .o-pivot-header-cell-closed'));
        assert.containsN(pivot, '.o-pivot-field-menu .o-menu-item', 4,
            "should have 4 dropdown items pivot groupby dropdown");

        // applying custom groupby in pivot groupby dropdown will not update search dropdown
        await cpHelpers.toggleGroupByMenu(pivot.el);
        assert.containsN(pivot, '.o-control-panel .o-cp-bottom-right .dropdown-menu .o-menu-item', 3,
            "should have 3 dropdown items in searchView groupby dropdown");

        pivot.destroy();
    });

    QUnit.test('pivot groupby dropdown renders custom search at the end with separator', async function (assert) {
        assert.expect(5);

        const pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: `
                <pivot>
                    <field name="productId" type="row"/>
                    <field name="foo" type="measure"/>
                </pivot>`,
            archs: {
                'partner,false,search': `
                    <search>
                        <filter name="bar" string="bar" context="{'groupby': 'bar'}"/>
                        <filter name="productId" string="product" context="{'groupby': 'productId'}"/>
                    </search>
                `,
            },
        });

        // open group by dropdown
        await cpHelpers.toggleGroupByMenu(pivot.el);
        assert.containsN(pivot, '.o-control-panel .o-cp-bottom-right .dropdown-menu .o-menu-item', 2,
            "should have 2 dropdown items in searchView groupby");
        await cpHelpers.toggleAddCustomGroup(pivot.el);
        await cpHelpers.applyGroup(pivot.el);
        assert.containsN(pivot, '.o-control-panel .o-cp-bottom-right .dropdown-menu .o-menu-item', 3,
            "should have 3 dropdown items in searchView groupby now");

        // click on closed header to open dropdown
        await testUtils.dom.click(pivot.el.querySelector('tbody tr:last-child .o-pivot-header-cell-closed'));
        const items = pivot.el.querySelectorAll(".o-menu-item");
        assert.deepEqual([...items].map((el) => el.innerText), ["bar", "product", "Company Type"]);
        assert.containsN(
            pivot,
            "tbody .dropdown-menu .dropdown-divider", 2,
            "pivot groupby menu should have two separators"
        );
        assert.hasClass(
            items[items.length - 1].nextSibling,
            "dropdown-divider",
            "pivot groupby menu separator is placed after all menu items"
        );

        pivot.destroy();
    });

    QUnit.test('pivot custom groupby: grouping on date field use default interval month', async function (assert) {
        assert.expect(1);

        let checkReadGroup = false;

        const pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: `
            <pivot>
                <field name="productId" type="row"/>
                <field name="foo" type="measure"/>
            </pivot>`,
            archs: {
                'partner,false,search': `
                    <search>
                        <filter name="bar" string="bar" context="{'groupby': 'bar'}"/>
                    </search>
                `,
            },
            mockRPC: function (route, args) {
                if (args.method === 'readGroup' && checkReadGroup) {
                    assert.deepEqual(args.kwargs.groupby, ['date:month'],
                        "should use default month as an interval in readGroup");
                    checkReadGroup = false;
                }
                return this._super(route, args);
            },
        });

        // click on closed header to open dropdown and apply groupby on date field
        await testUtils.dom.click(pivot.$('thead .o-pivot-header-cell-closed'));
        await testUtils.dom.triggerEvent(pivot.$('.o-pivot-field-menu .o-add-custom_group_menu .dropdown-toggle'), "mouseenter");
        await testUtils.fields.editSelect(pivot.$('.o-pivot-field-menu .o-add-custom_group_menu select'), 'date');
        checkReadGroup = true;
        await testUtils.dom.click(pivot.$('.o-pivot-field-menu .o-add-custom_group_menu .btn-primary'));

        pivot.destroy();
    });

    QUnit.test('pivot view without group by specified in search arch', async function (assert) {
        assert.expect(3);

        const pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: `
            <pivot>
                <field name="productId" type="row"/>
                <field name="foo" type="measure"/>
            </pivot>`,
            archs: {
                'partner,false,search': `<search/>`,
            },
        });

        // open group by dropdown
        await cpHelpers.toggleGroupByMenu(pivot.el);
        assert.containsNone(pivot, '.o-control-panel .o-cp-bottom-right .dropdown-menu .o-menu-item',
            "should not have any dropdown item in searchView groupby");
        // click on closed header to open dropdown
        await testUtils.dom.click(pivot.el.querySelector('tbody tr:last-child .o-pivot-header-cell-closed'));
        assert.containsN(pivot, '.o-pivot-field-menu .o-menu-item', 6,
            "should have 6 dropdown items i.e. all groupable fields available");
        assert.containsNone(pivot, '.o-pivot-field-menu .o-add-custom_group_menu',
            "should not have custom group generator in groupby dropdown");

        pivot.destroy();
    });

    QUnit.test('pivot view do not show custom group selection if there are no groupable fields', async function (assert) {
        assert.expect(4);

        for (const fieldName of ["bar", "company_type", "customer", "date", "other_product_id"]) {
            delete this.data.partner.fields[fieldName];
        }

        this.data.partner.records = [{
            id: 1,
            foo: 12,
            productId: 37,
            computed_field: 19,
        }];

        const pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: `
            <pivot>
                <field name="foo" type="measure"/>
                <field name="productId" invisible="1"/>
            </pivot>`,
            archs: {
                'partner,false,search': `
                    <search>
                        <filter name="productId" string="product" context="{'groupby': 'productId'}"/>
                    </search>
                `,
            },
        });

        // open group by dropdown
        await cpHelpers.toggleGroupByMenu(pivot.el);
        assert.containsOnce(pivot, '.o-control-panel .o-cp-bottom-right .dropdown-menu .o-menu-item',
            "should have 1 dropdown item in searchView groupby");
        assert.containsNone(pivot, '.o-control-panel .o-cp-bottom-right .dropdown-menu .o-add-custom_group_menu',
            "should not have custom group generator in searchView groupby");

        // click on closed header to open dropdown
        await testUtils.dom.click(pivot.el.querySelector('tbody .o-pivot-header-cell-closed'));
        assert.containsOnce(pivot, '.o-pivot-field-menu .o-menu-item',
            "should have 1 dropdown items");
        assert.containsNone(pivot, '.o-pivot-field-menu .o-add-custom_group_menu',
            "should not have custom group generator in groupby dropdown");

        pivot.destroy();
    });

    QUnit.test('pivot custom groupby: adding a custom group close the pivot groupby menu', async function (assert) {
        assert.expect(2);

        const pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: `
            <pivot>
                <field name="productId" type="row"/>
                <field name="foo" type="measure"/>
            </pivot>`,
            archs: {
                'partner,false,search': `
                <search>
                    <filter name="bar" string="bar" context="{'groupby': 'bar'}"/>
                </search>
            `,
            },
        });

        // click on closed header to open dropdown and apply groupby on date field
        await testUtils.dom.click(pivot.$('thead .o-pivot-header-cell-closed'));
        await testUtils.dom.triggerEvent(pivot.$('.o-pivot-field-menu .o-add-custom_group_menu .dropdown-toggle'), "mouseenter");
        assert.containsOnce(pivot, '.o-pivot-field-menu .o-add-custom_group_menu',
            "should have custom group generator in groupby dropdown");

        // click on apply button should close dropdown
        await testUtils.dom.click(pivot.$('.o-pivot-field-menu .o-add-custom_group_menu button.btn-primary'));
        assert.containsNone(pivot, '.o-pivot-field-menu .o-add-custom_group_menu',
            "should not have custom group generator in groupby dropdown");

        pivot.destroy();
    });

    QUnit.test('can toggle extra measure', async function (assert) {
        assert.expect(8);

        var rpcCount = 0;

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot>' +
                        '<field name="productId" type="row"/>' +
                        '<field name="foo" type="measure"/>' +
                '</pivot>',
            mockRPC: function () {
                rpcCount++;
                return this._super.apply(this, arguments);
            },
        });

        assert.containsN(pivot, '.o-pivot-cell-value', 3,
            "should have 3 cells: 1 for the open header, and 2 for data");
        assert.doesNotHaveClass(pivot.$buttons.find('.dropdown-item[data-field=__count]:first'), 'selected',
            "the __count measure should not be selected");

        rpcCount = 0;
        await testUtils.pivot.toggleMeasuresDropdown(pivot);
        await testUtils.pivot.clickMeasure(pivot, '__count');

        assert.hasClass(pivot.$buttons.find('.dropdown-item[data-field=__count]:first'), 'selected',
            "the __count measure should be selected");
        assert.containsN(pivot, '.o-pivot-cell-value', 6,
            "should have 6 cells: 2 for the open header, and 4 for data");
        assert.strictEqual(rpcCount, 2,
            "should have done 2 rpcs to reload data");

        await testUtils.pivot.clickMeasure(pivot, '__count');

        assert.doesNotHaveClass(pivot.$buttons.find('.dropdown-item[data-field=__count]:first'), 'selected',
            "the __count measure should not be selected");
        assert.containsN(pivot, '.o-pivot-cell-value', 3,
            "should have 3 cells: 1 for the open header, and 2 for data");
        assert.strictEqual(rpcCount, 2,
            "should not have done any extra rpcs");

        pivot.destroy();
    });

    QUnit.test('no content helper when no active measure', async function (assert) {
        assert.expect(4);

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot string="Partners">' +
                '</pivot>',
        });

        assert.containsNone(pivot, '.o-view-nocontent',
            "should not have a no-content_helper");
        assert.containsOnce(pivot, 'table',
            "should have a table in DOM");

        await testUtils.pivot.toggleMeasuresDropdown(pivot);
        await testUtils.pivot.clickMeasure(pivot, '__count');

        assert.containsOnce(pivot, '.o-view-nocontent',
            "should have a no-content_helper");
        assert.containsNone(pivot, 'table',
            "should not have a table in DOM");
        pivot.destroy();
    });

    QUnit.test('no content helper when no data', async function (assert) {
        assert.expect(4);

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot string="Partners">' +
                '</pivot>',
        });

        assert.containsNone(pivot, '.o-view-nocontent',
            "should not have a no-content_helper");
        assert.containsOnce(pivot, 'table',
            "should have a table in DOM");

        await testUtils.pivot.reload(pivot, {domain: [['foo', '=', 12345]]});

        assert.containsOnce(pivot, '.o-view-nocontent',
            "should have a no-content_helper");
        assert.containsNone(pivot, 'table',
            "should not have a table in DOM");
        pivot.destroy();
    });

    QUnit.test('no content helper when no data, part 2', async function (assert) {
        assert.expect(1);

        this.data.partner.records = [];

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot string="Partners"></pivot>',
        });

        assert.containsOnce(pivot, '.o-view-nocontent',
            "should have a no-content_helper");
        pivot.destroy();
    });

    QUnit.test('no content helper when no data, part 3', async function (assert) {
        assert.expect(4);

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot string="Partners"></pivot>',
            viewOptions: {
                domain: [['foo', '=', 12345]]
            },
        });

        assert.containsOnce(pivot, '.o-view-nocontent',
            "should have a no-content_helper");
        await testUtils.pivot.reload(pivot, {domain: [['foo', '=', 12345]]});
        assert.containsOnce(pivot, '.o-view-nocontent',
            "should still have a no-content_helper");
        await testUtils.pivot.reload(pivot, {domain: []});
        assert.containsNone(pivot, '.o-view-nocontent',
            "should not have a no-content_helper");

        // tries to open a field selection menu, to make sure it was not
        // removed from the dom.
        await testUtils.dom.clickFirst(pivot.$('.o-pivot-header-cell-closed'));
        assert.containsOnce(pivot, '.o-legacy-pivot .dropdown-menu',
            "the field selector menu exists");
        pivot.destroy();
    });

    QUnit.test('tries to restore previous state after domain change', async function (assert) {
        assert.expect(5);

        var rpcCount = 0;

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot>' +
                        '<field name="productId" type="row"/>' +
                        '<field name="foo" type="measure"/>' +
                '</pivot>',
            mockRPC: function () {
                rpcCount++;
                return this._super.apply(this, arguments);
            },
        });

        assert.containsN(pivot, '.o-pivot-cell-value', 3,
            "should have 3 cells: 1 for the open header, and 2 for data");
        assert.strictEqual(pivot.$('.o-pivot-measure-row:contains(Foo)').length, 1,
            "should have 1 row for measure Foo");

        await testUtils.pivot.reload(pivot, {domain: [['foo', '=', 12345]]});

        rpcCount = 0;
        await testUtils.pivot.reload(pivot, {domain: []});

        assert.equal(rpcCount, 2, "should have reloaded data");
        assert.containsN(pivot, '.o-pivot-cell-value', 3,
            "should still have 3 cells: 1 for the open header, and 2 for data");
        assert.strictEqual(pivot.$('.o-pivot-measure-row:contains(Foo)').length, 1,
            "should still have 1 row for measure Foo");
        pivot.destroy();
    });

    QUnit.test('can be grouped with the update function', async function (assert) {
        assert.expect(4);

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot>' +
                        '<field name="foo" type="measure"/>' +
                '</pivot>',
        });

        assert.containsOnce(pivot, '.o-pivot-cell-value',
            "should have only 1 cell");
        assert.containsOnce(pivot, 'tbody tr',
            "should have 1 rows");

        await testUtils.pivot.reload(pivot, {groupBy: ['productId']});

        assert.containsN(pivot, '.o-pivot-cell-value', 3,
            "should have 3 cells");
        assert.containsN(pivot, 'tbody tr', 3,
            "should have 3 rows");
        pivot.destroy();
    });

    QUnit.test('can sort data in a column by clicking on header', async function (assert) {
        assert.expect(3);

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot>' +
                        '<field name="foo" type="measure"/>' +
                        '<field name="productId" type="row"/>' +
                '</pivot>',
        });

        assert.strictEqual($('td.o-pivot-cell-value').text(), "321220",
            "should have proper values in cells (total, result 1, result 2");

        await testUtils.dom.click(pivot.$('th.o-pivot-measure-row'));

        assert.strictEqual($('td.o-pivot-cell-value').text(), "321220",
            "should have proper values in cells (total, result 1, result 2");

        await testUtils.dom.click(pivot.$('th.o-pivot-measure-row'));

        assert.strictEqual($('td.o-pivot-cell-value').text(), "322012",
            "should have proper values in cells (total, result 2, result 1");

        pivot.destroy();
    });

    QUnit.test('can expand all rows', async function (assert) {
        assert.expect(7);

        var nbReadGroups = 0;
        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot>' +
                        '<field name="foo" type="measure"/>' +
                        '<field name="productId" type="row"/>' +
                '</pivot>',
            mockRPC: function (route, args) {
                if (args.method === 'readGroup') {
                    nbReadGroups++;
                }
                return this._super.apply(this, arguments);
            },
        });

        assert.strictEqual(nbReadGroups, 2, "should have done 2 readGroup RPCS");
        assert.strictEqual(pivot.$('td.o-pivot-cell-value').text(), "321220",
            "should have proper values in cells (total, result 1, result 2)");

        // expand on date:days, product
        nbReadGroups = 0;
        await testUtils.pivot.reload(pivot, {groupBy: ['date:days', 'productId']});

        assert.strictEqual(nbReadGroups, 3, "should have done 3 readGroup RPCS");
        assert.containsN(pivot, 'tbody tr', 8,
            "should have 7 rows (total + 3 for December and 2 for October and April)");

        // collapse the last two rows
        await testUtils.dom.clickLast(pivot.$('.o-pivot-header-cell-opened'));
        await testUtils.dom.clickLast(pivot.$('.o-pivot-header-cell-opened'));

        assert.containsN(pivot, 'tbody tr', 6,
            "should have 6 rows now");

        // expand all
        nbReadGroups = 0;
        await testUtils.dom.click(pivot.$buttons.find('.o-pivot-expand_button'));

        assert.strictEqual(nbReadGroups, 3, "should have done 3 readGroup RPCS");
        assert.containsN(pivot, 'tbody tr', 8,
            "should have 8 rows again");

        pivot.destroy();
    });

    QUnit.test('expand all with a delay', async function (assert) {
        assert.expect(3);

        var def;
        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot>' +
                        '<field name="foo" type="measure"/>' +
                        '<field name="productId" type="row"/>' +
                '</pivot>',
            mockRPC: function (route, args) {
                var result = this._super.apply(this, arguments);
                if (args.method === 'readGroup') {
                    return Promise.resolve(def).then(_.constant(result));
                }
                return result;
            },
        });

        // expand on date:days, product
        await testUtils.pivot.reload(pivot, {groupBy: ['date:days', 'productId']});
        assert.containsN(pivot, 'tbody tr', 8,
            "should have 7 rows (total + 3 for December and 2 for October and April)");

        // collapse the last two rows
        await testUtils.dom.clickLast(pivot.$('.o-pivot-header-cell-opened'));
        await testUtils.dom.clickLast(pivot.$('.o-pivot-header-cell-opened'));

        assert.containsN(pivot, 'tbody tr', 6,
            "should have 6 rows now");

        // expand all
        def = testUtils.makeTestPromise();
        await testUtils.dom.click(pivot.$buttons.find('.o-pivot-expand_button'));
        await testUtils.nextTick();
        def.resolve();
        // await testUtils.returnAfterNextAnimationFrame();
        await testUtils.nextTick();
        assert.containsN(pivot, 'tbody tr', 8,
            "should have 8 rows again");

       pivot.destroy();
    });

    QUnit.test('can download a file', async function (assert) {
        assert.expect(1);

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot>' +
                        '<field name="date" interval="month" type="col"/>' +
                        '<field name="foo" type="measure"/>' +
                '</pivot>',
            session: {
                getFile: function (args) {
                    assert.strictEqual(args.url, '/web/pivot/export_xlsx',
                        "should call getFile with correct parameters");
                    args.complete();
                },
            },
        });

        await testUtils.dom.click(pivot.$buttons.find('.o-pivot-download'));
        pivot.destroy();
    });

    QUnit.test('download a file with single measure, measure row displayed in table', async function (assert) {
        assert.expect(1);

        const pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot>' +
                '<field name="date" interval="month" type="col"/>' +
                '<field name="foo" type="measure"/>' +
                '</pivot>',
            session: {
                getFile: function (args) {
                    const data = JSON.parse(args.data.data);
                    assert.strictEqual(data.measure_headers.length, 4,
                        "should have measure_headers in data");
                    args.complete();
                },
            },
        });

        await testUtils.dom.click(pivot.$buttons.find('.o-pivot-download'));
        pivot.destroy();
    });

    QUnit.test('download button is disabled when there is no data', async function (assert) {
        assert.expect(1);

        this.data.partner.records = [];

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot>' +
                        '<field name="date" interval="month" type="col"/>' +
                        '<field name="foo" type="measure"/>' +
                '</pivot>',
        });

        assert.hasAttrValue(pivot.$buttons.find('.o-pivot-download'), 'disabled', 'disabled',
            "download button should be disabled");
        pivot.destroy();
    });

    QUnit.test('getOwnedQueryParams correctly returns measures and groupbys', async function (assert) {
        assert.expect(3);

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot>' +
                        '<field name="date" interval="day" type="col"/>' +
                        '<field name="foo" type="measure"/>' +
                '</pivot>',
        });

        assert.deepEqual(pivot.getOwnedQueryParams(), {
            context: {
                pivot_column_groupby: ['date:day'],
                pivot_measures: ['foo'],
                pivot_row_groupby: [],
            },
        }, "context should be correct");

        // expand header on field customer
        await testUtils.dom.click(pivot.$('thead .o-pivot-header-cell-closed:nth(1)'));
        await testUtils.dom.click(pivot.el.querySelectorAll("thead .dropdown-menu .dropdown-item")[1]);
        assert.deepEqual(pivot.getOwnedQueryParams(), {
            context: {
                pivot_column_groupby: ['date:day', 'customer'],
                pivot_measures: ['foo'],
                pivot_row_groupby: [],
            },
        }, "context should be correct");

        // expand row on field productId
        await testUtils.dom.click(pivot.el.querySelector('tbody .o-pivot-header-cell-closed'));
        await testUtils.dom.click(pivot.el.querySelectorAll("tbody .dropdown-menu .dropdown-item")[4]);
        assert.deepEqual(pivot.getOwnedQueryParams(), {
            context: {
                pivot_column_groupby: ['date:day', 'customer'],
                pivot_measures: ['foo'],
                pivot_row_groupby: ['productId'],
            },
        }, "context should be correct");

        pivot.destroy();
    });

    QUnit.test('correctly remove pivot_ keys from the context', async function (assert) {
        assert.expect(5);

        this.data.partner.fields.amount = {string: "Amount", type: "float", groupOperator: 'sum'};

        // Equivalent to loading with default filter
        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot>' +
                        '<field name="date" interval="day" type="col"/>' +
                        '<field name="amount" type="measure"/>' +
                '</pivot>',
            viewOptions: {
                context: {
                    pivot_measures: ['foo'],
                    pivot_column_groupby: ['customer'],
                    pivot_row_groupby: ['productId'],
                },
            },
        });

        // Equivalent to unload the filter
        var reloadParams = {
            context: {},
        };
        await pivot.reload(reloadParams);

        assert.deepEqual(pivot.getOwnedQueryParams(), {
            context: {
                pivot_column_groupby: ['customer'],
                pivot_measures: ['foo'],
                pivot_row_groupby: ['productId'],
            },
        }, "context should be correct");

        // Let's get rid of the rows groupBy
        await testUtils.dom.click(pivot.$('tbody .o-pivot-header-cell-opened'));

        assert.deepEqual(pivot.getOwnedQueryParams(), {
            context: {
                pivot_column_groupby: ['customer'],
                pivot_measures: ['foo'],
                pivot_row_groupby: [],
            },
        }, "context should be correct");

        // And now, get rid of the col groupby
        await testUtils.dom.click(pivot.$('thead .o-pivot-header-cell-opened'));

        assert.deepEqual(pivot.getOwnedQueryParams(), {
            context: {
                pivot_column_groupby: [],
                pivot_measures: ['foo'],
                pivot_row_groupby: [],
            },
        }, "context should be correct");

        await testUtils.dom.click(pivot.el.querySelector('tbody .o-pivot-header-cell-closed'));
        await testUtils.dom.click(pivot.$('.dropdown-menu span:nth-child(5)'));

        assert.deepEqual(pivot.getOwnedQueryParams(), {
            context: {
                pivot_column_groupby: [],
                pivot_measures: ['foo'],
                pivot_row_groupby: ['productId'],
            },
        }, "context should be correct");

        await testUtils.dom.click(pivot.$('thead .o-pivot-header-cell-closed'));
        await testUtils.dom.click(pivot.$('.dropdown-menu span:nth-child(2)'));

        assert.deepEqual(pivot.getOwnedQueryParams(), {
            context: {
                pivot_column_groupby: ['customer'],
                pivot_measures: ['foo'],
                pivot_row_groupby: ['productId'],
            },
        }, "context should be correct");

        pivot.destroy();
    });

    QUnit.test('Unload Filter, reset display, load another filter', async function (assert) {
        assert.expect(18);

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot>' +
                        '<field name="foo" type="measure"/>' +
                '</pivot>',
            viewOptions: {
                context: {
                    pivot_measures: ['foo'],
                    pivot_column_groupby: ['customer'],
                    pivot_row_groupby: ['productId'],
                },
            },
        });

        // Check Columns
        assert.strictEqual(pivot.$('thead .o-pivot-header-cell-opened').length, 1,
            'The column should be grouped');
        assert.strictEqual(pivot.$('thead tr:contains("First")').length, 1,
            'There should be a column "First"');
        assert.strictEqual(pivot.$('thead tr:contains("Second")').length, 1,
            'There should be a column "Second"');

        // Check Rows
        assert.strictEqual(pivot.$('tbody .o-pivot-header-cell-opened').length, 1,
            'The row should be grouped');
        assert.strictEqual(pivot.$('tbody tr:contains("xphone")').length, 1,
            'There should be a row "xphone"');
        assert.strictEqual(pivot.$('tbody tr:contains("xpad")').length, 1,
            'There should be a row "xpad"');

        // Equivalent to unload the filter
        var reloadParams = {
            context: {},
        };
        await pivot.reload(reloadParams);
        // collapse all headers
        await testUtils.dom.click(pivot.$('.o-pivot-header-cell-opened:first'));
        await testUtils.dom.click(pivot.el.querySelector('.o-pivot-header-cell-opened'));

        // Check Columns
        assert.strictEqual(pivot.$('thead .o-pivot-header-cell-closed').length, 1,
            'The column should not be grouped');
        assert.strictEqual(pivot.$('thead tr:contains("First")').length, 0,
            'There should not be a column "First"');
        assert.strictEqual(pivot.$('thead tr:contains("Second")').length, 0,
            'There should not be a column "Second"');

        // Check Rows
        assert.strictEqual(pivot.$('tbody .o-pivot-header-cell-closed').length, 1,
            'The row should not be grouped');
        assert.strictEqual(pivot.$('tbody tr:contains("xphone")').length, 0,
            'There should not be a row "xphone"');
        assert.strictEqual(pivot.$('tbody tr:contains("xpad")').length, 0,
            'There should not be a row "xpad"');

        // Equivalent to load another filter
        reloadParams = {
            context: {
                pivot_measures: ['foo'],
                pivot_column_groupby: ['customer'],
                pivot_row_groupby: ['productId'],
            },
        };
        await pivot.reload(reloadParams);

        // Check Columns
        assert.strictEqual(pivot.$('thead .o-pivot-header-cell-opened').length, 1,
            'The column should be grouped');
        assert.strictEqual(pivot.$('thead tr:contains("First")').length, 1,
            'There should be a column "First"');
        assert.strictEqual(pivot.$('thead tr:contains("Second")').length, 1,
            'There should be a column "Second"');

        // Check Rows
        assert.strictEqual(pivot.$('tbody .o-pivot-header-cell-opened').length, 1,
            'The row should be grouped');
        assert.strictEqual(pivot.$('tbody tr:contains("xphone")').length, 1,
            'There should be a row "xphone"');
        assert.strictEqual(pivot.$('tbody tr:contains("xpad")').length, 1,
            'There should be a row "xpad"');

        pivot.destroy();
    });

    QUnit.test('Reload, group by columns, reload', async function (assert) {
        assert.expect(2);

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot/>',
        });

        // Set a column groupby
        await testUtils.dom.click(pivot.$('thead .o-pivot-header-cell-closed'));
        await testUtils.dom.click(pivot.el.querySelectorAll("thead .dropdown-menu .dropdown-item")[1]);

        // Set a domain
        await pivot.update({domain: [['productId', '=', 37]], groupBy: [], context: {}});

        var expectedContext = {pivot_column_groupby: ['customer'],
                               pivot_measures: ['__count'],
                               pivot_row_groupby: []};

        // Check that column groupbys were not lost
        assert.deepEqual(pivot.getOwnedQueryParams(), {context: expectedContext},
            'Column groupby not lost after first reload');

        // Set a column groupby
        await testUtils.dom.click(pivot.$('thead .o-pivot-header-cell-closed'));
        await testUtils.dom.click(pivot.el.querySelectorAll("thead .dropdown-menu .dropdown-item")[4]);

        // Set a domain
        await pivot.update({domain: [['productId', '=', 41]], groupBy: [], context: {}});

        expectedContext = {pivot_column_groupby: ['customer', 'productId'],
                           pivot_measures: ['__count'],
                           pivot_row_groupby: []};

        assert.deepEqual(pivot.getOwnedQueryParams(), {context: expectedContext},
            'Column groupby not lost after second reload');

        pivot.destroy();
    });

    QUnit.test('folded groups remain folded at reload', async function (assert) {
        assert.expect(5);

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot>' +
                        '<field name="productId" type="row"/>' +
                        '<field name="company_type" type="col"/>' +
                        '<field name="foo" type="measure"/>' +
                '</pivot>',
        });

        var values = [
            "29", "3", "32",
            "12",      "12",
            "17", "3", "20",
        ];
        assert.strictEqual(getCurrentValues(pivot), values.join(','));

        // expand a col group
        await testUtils.dom.click(pivot.$('thead .o-pivot-header-cell-closed:nth(1)'));
        await testUtils.dom.click(pivot.el.querySelectorAll("thead .dropdown-menu .dropdown-item")[1]);

        values = [
            "29", "1", "2", "32",
            "12",           "12",
            "17", "1", "2", "20",
        ];
        assert.strictEqual(getCurrentValues(pivot), values.join(','));

        // expand a row group
        await testUtils.dom.click(pivot.el.querySelector('tbody tr:last-child .o-pivot-header-cell-closed'));
        await testUtils.dom.click(pivot.el.querySelectorAll("tbody .dropdown-menu .dropdown-item")[3]);

        values = [
            "29", "1", "2", "32",
            "12",           "12",
            "17", "1", "2", "20",
            "17", "1", "2", "20",
        ];
        assert.strictEqual(getCurrentValues(pivot), values.join(','));

        // reload (should keep folded groups folded as col/row groupbys didn't change)
        await testUtils.pivot.reload(pivot, {context: {}, domain: [], groupBy: []});

        assert.strictEqual(getCurrentValues(pivot), values.join(','));

        await testUtils.dom.click(pivot.$('.o-pivot-expand_button'));

        // sanity check of what the table should look like if all groups are
        // expanded, to ensure that the former asserts are pertinent
        values = [
            "12", "17", "1", "2", "32",
            "12",                 "12",
            "12",                 "12",
                  "17", "1", "2", "20",
                  "17", "1", "2", "20",
        ];
        assert.strictEqual(getCurrentValues(pivot), values.join(','));

        pivot.destroy();
    });

    QUnit.test('Empty results keep groupbys', async function (assert) {
        assert.expect(2);

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot/>',
        });

        // Set a column groupby
        await testUtils.dom.click(pivot.$('thead .o-pivot-header-cell-closed'));
        await testUtils.dom.click(pivot.el.querySelectorAll("thead .dropdown-menu .dropdown-item")[1]);

        // Set a domain for empty results
        await pivot.update({domain: [['id', '=', false]]});

        var expectedContext = {pivot_column_groupby: ['customer'],
                               pivot_measures: ['__count'],
                               pivot_row_groupby: []};
        assert.deepEqual(pivot.getOwnedQueryParams(), {context: expectedContext},
            'Column groupby not lost after empty results');

        // Set a domain for not empty results
        await pivot.update({domain: [['productId', '=', 37]]});

        assert.deepEqual(pivot.getOwnedQueryParams(), {context: expectedContext},
            'Column groupby not lost after reload after empty results');

        pivot.destroy();
    });

    QUnit.test('correctly uses pivot_ keys from the context', async function (assert) {
        assert.expect(7);

        this.data.partner.fields.amount = {string: "Amount", type: "float", groupOperator: 'sum'};

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot>' +
                        '<field name="date" interval="day" type="col"/>' +
                        '<field name="amount" type="measure"/>' +
                '</pivot>',
            viewOptions: {
                context: {
                    pivot_measures: ['foo'],
                    pivot_column_groupby: ['customer'],
                    pivot_row_groupby: ['productId'],
                },
            },
        });

        assert.containsOnce(pivot, 'thead .o-pivot-header-cell-opened',
            "column: should have one opened header");
        assert.strictEqual(pivot.$('thead .o-pivot-header-cell-closed:contains(First)').length, 1,
            "column: should display one closed header with 'First'");
        assert.strictEqual(pivot.$('thead .o-pivot-header-cell-closed:contains(Second)').length, 1,
            "column: should display one closed header with 'Second'");

        assert.containsOnce(pivot, 'tbody .o-pivot-header-cell-opened',
            "row: should have one opened header");
        assert.strictEqual(pivot.$('tbody .o-pivot-header-cell-closed:contains(xphone)').length, 1,
            "row: should display one closed header with 'xphone'");
        assert.strictEqual(pivot.$('tbody .o-pivot-header-cell-closed:contains(xpad)').length, 1,
            "row: should display one closed header with 'xpad'");

        assert.strictEqual(pivot.$('tbody tr:first td:nth(2)').text(), '32',
            "selected measure should be foo, with total 32");

        pivot.destroy();
    });

    QUnit.test('clear table cells data after closeGroup', async function (assert) {
        assert.expect(2);

        const pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot/>',
            groupBy: ['productId'],
        });

        await testUtils.dom.click(pivot.el.querySelector('thead .o-pivot-header-cell-closed'));
        await testUtils.dom.triggerEvent(pivot.el.querySelector('thead .dropdown-menu .dropdown-toggle'), "mouseenter");
        await testUtils.dom.click(pivot.el.querySelectorAll("thead .dropdown-menu .dropdown-menu .dropdown-item")[3]);

        // close and reopen row groupings after changing value
        this.data.partner.records.find(r => r.productId === 37).date = '2016-10-27';
        await testUtils.dom.click(pivot.el.querySelector('tbody .o-pivot-header-cell-opened'));
        await testUtils.dom.click(pivot.el.querySelector('tbody .o-pivot-header-cell-closed'));
        await testUtils.dom.click(pivot.el.querySelectorAll("tbody .dropdown-menu .dropdown-item")[4]);
        assert.strictEqual(pivot.el.querySelectorAll('.o-pivot-cell-value')[4].innerText, ''); // xphone December 2016

        // invert axis, and reopen column groupings
        await testUtils.dom.click(pivot.el.querySelector('.o-cp-buttons .o-pivot-flip_button'));
        await testUtils.dom.click(pivot.el.querySelector('thead .o-pivot-header-cell-opened'));
        await testUtils.dom.click(pivot.el.querySelector('thead .o-pivot-header-cell-closed'));
        await testUtils.dom.click(pivot.el.querySelectorAll("thead .dropdown-menu .dropdown-item")[4]);
        assert.strictEqual(pivot.el.querySelectorAll('.o-pivot-cell-value')[3].innerText, ''); // December 2016 xphone

        pivot.destroy();
    });

    QUnit.test('correctly group data after flip (1)', async function (assert) {
        assert.expect(4);

        serverData.views = {
            'partner,false,pivot': "<pivot/>",
            'partner,false,search': `<search><filter name="bayou" string="Bayou" domain="[[1,'=',1]]"/></search>`,
            'partner,false,list': '<tree><field name="foo"/></tree>',
            'partner,false,form': '<form><field name="foo"/></form>',
        };

        const webClient = await createWebClient({ serverData });

        await doAction(webClient, {
            resModel: 'partner',
            type: 'ir.actions.actwindow',
            views: [[false, 'pivot']],
            context: { groupby: ["productId"] },
        });

        assert.deepEqual(
            [...webClient.el.querySelectorAll("tbody th")].map(e => e.innerText),
            [
                "Total",
                    "xphone",
                    "xpad"
            ]
        );

        // flip axis
        await testUtils.dom.click(webClient.el.querySelector('.o-cp-buttons .o-pivot-flip_button'));
        await testUtils.nextTick();

        assert.deepEqual(
            [...webClient.el.querySelectorAll("tbody th")].map(e => e.innerText),
            [
                "Total",
            ]
        );

        // select filter "Bayou" in control panel
        await cpHelpers.toggleFilterMenu(webClient);
        await cpHelpers.toggleMenuItem(webClient, "Bayou");
        await testUtils.nextTick();

        assert.deepEqual(
            [...webClient.el.querySelectorAll("tbody th")].map(e => e.innerText),
            [
                "Total",
                    "xphone",
                    "xpad"
            ]
        );

        // close row header "Total"
        await testUtils.dom.click(webClient.el.querySelector('tbody .o-pivot-header-cell-opened'));
        await testUtils.nextTick();

        assert.deepEqual(
            [...webClient.el.querySelectorAll("tbody th")].map(e => e.innerText),
            [
                "Total"
            ]
        );

        webClient.destroy();
    });

    QUnit.test('correctly group data after flip (2)', async function (assert) {
        assert.expect(5);

        serverData.views = {
            'partner,false,pivot': "<pivot/>",
            'partner,false,search': `<search><filter name="bayou" string="Bayou" domain="[[1,'=',1]]"/></search>`,
            'partner,false,list': '<tree><field name="foo"/></tree>',
            'partner,false,form': '<form><field name="foo"/></form>',
        };

        const webClient = await createWebClient({ serverData });

        await doAction(webClient, {
            resModel: 'partner',
            type: 'ir.actions.actwindow',
            views: [[false, 'pivot']],
            context: { groupby: ["productId"] },
        });

        assert.deepEqual(
            [...webClient.el.querySelectorAll("tbody th")].map(e => e.innerText),
            [
                "Total",
                    "xphone",
                    "xpad"
            ]
        );

        // select filter "Bayou" in control panel
        await cpHelpers.toggleFilterMenu(webClient);
        await cpHelpers.toggleMenuItem(webClient, "Bayou");

        assert.deepEqual(
            [...webClient.el.querySelectorAll("tbody th")].map(e => e.innerText),
            [
                "Total",
                    "xphone",
                    "xpad"
            ]
        );

        // flip axis
        await testUtils.dom.click(webClient.el.querySelector('.o-cp-buttons .o-pivot-flip_button'));
        await testUtils.nextTick();

        assert.deepEqual(
            [...webClient.el.querySelectorAll("tbody th")].map(e => e.innerText),
            [
                "Total"
            ]
        );

        // unselect filter "Bayou" in control panel
        await cpHelpers.toggleFilterMenu(webClient);
        await cpHelpers.toggleMenuItem(webClient, "Bayou");
        await testUtils.nextTick();

        assert.deepEqual(
            [...webClient.el.querySelectorAll("tbody th")].map(e => e.innerText),
            [
                "Total",
                    "xphone",
                    "xpad" 
            ]
        );

        // close row header "Total"
        await testUtils.dom.click(webClient.el.querySelector('tbody .o-pivot-header-cell-opened'));
        await testUtils.nextTick();

        assert.deepEqual(
            [...webClient.el.querySelectorAll("tbody th")].map(e => e.innerText),
            [
                "Total"
            ]
        );

        webClient.destroy();
    });

    QUnit.test('correctly group data after flip (3))', async function (assert) {
        assert.expect(10);
        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: `
                <pivot>
                    <field name="productId" type="row"/>
                    <field name="company_type" type="col"/>
                </pivot>
            `,
            archs: {
                'partner,false,search': `<search><filter name="bayou" string="Bayou" domain="[[1,'=',1]]"/></search>`,
            }
        });

        assert.deepEqual(
            [...pivot.el.querySelectorAll("thead th")].map(e => e.innerText),
            [
                "", "Total",                 "",
                    "Company", "individual",
                    "Count",   "Count",      "Count"
            ]
        );

        assert.deepEqual(
            [...pivot.el.querySelectorAll("tbody th")].map(e => e.innerText),
            [
                "Total",
                    "xphone",
                    "xpad"
            ]
        );

        // close col header "Total"
        await testUtils.dom.click(pivot.el.querySelector('thead .o-pivot-header-cell-opened'));
        await testUtils.nextTick();

        assert.deepEqual(
            [...pivot.el.querySelectorAll("thead th")].map(e => e.innerText),
            [
                "", "Total",
                    "Count"
              ]
        );
        assert.deepEqual(
            [...pivot.el.querySelectorAll("tbody th")].map(e => e.innerText),
            [
                "Total",
                    "xphone",
                    "xpad"
            ]
        );

        // flip axis
        await testUtils.dom.click(pivot.el.querySelector('.o-cp-buttons .o-pivot-flip_button'));
        await testUtils.nextTick();

        assert.deepEqual(
            [...pivot.el.querySelectorAll("thead th")].map(e => e.innerText),
            [
                "", "Total",           "",
                    "xphone", "xpad",
                    "Count",  "Count", "Count"
            ]
        );
        assert.deepEqual(
            [...pivot.el.querySelectorAll("tbody th")].map(e => e.innerText),
            [
                "Total"
            ]
        );

        // select filter "Bayou" in control panel
        await cpHelpers.toggleFilterMenu(pivot.el);
        await cpHelpers.toggleMenuItem(pivot.el, "Bayou");
        await testUtils.nextTick();

        assert.deepEqual(
            [...pivot.el.querySelectorAll("thead th")].map(e => e.innerText),
            [
                "", "Total",           "",
                    "xphone", "xpad",
                    "Count",  "Count", "Count"
            ]
        );
        assert.deepEqual(
            [...pivot.el.querySelectorAll("tbody th")].map(e => e.innerText),
            [
                "Total",
                    "xphone",
                    "xpad"
            ]
        );

        // close row header "Total"
        await testUtils.dom.click(pivot.el.querySelector('tbody .o-pivot-header-cell-opened'));
        await testUtils.nextTick();

        assert.deepEqual(
            [...pivot.el.querySelectorAll("thead th")].map(e => e.innerText),
            [
                "", "Total",           "",
                    "xphone", "xpad",
                    "Count",  "Count", "Count"
            ]
        );
        assert.deepEqual(
            [...pivot.el.querySelectorAll("tbody th")].map(e => e.innerText),
            [
                "Total"
            ]
        );

        pivot.destroy();
    });

    QUnit.test('correctly uses pivot_ keys from the context (at reload)', async function (assert) {
        assert.expect(8);

        this.data.partner.fields.amount = {string: "Amount", type: "float", groupOperator: 'sum'};

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot>' +
                        '<field name="date" interval="day" type="col"/>' +
                        '<field name="amount" type="measure"/>' +
                '</pivot>',
        });

        assert.strictEqual(pivot.$('tbody tr:first td.o-pivot-cell-value:last').text(), '0.00',
            "the active measure should be amount");

        var reloadParams = {
            context: {
                pivot_measures: ['foo'],
                pivot_column_groupby: ['customer'],
                pivot_row_groupby: ['productId'],
            },
        };
        await testUtils.pivot.reload(pivot, reloadParams);

        assert.containsOnce(pivot, 'thead .o-pivot-header-cell-opened',
            "column: should have one opened header");
        assert.strictEqual(pivot.$('thead .o-pivot-header-cell-closed:contains(First)').length, 1,
            "column: should display one closed header with 'First'");
        assert.strictEqual(pivot.$('thead .o-pivot-header-cell-closed:contains(Second)').length, 1,
            "column: should display one closed header with 'Second'");

        assert.containsOnce(pivot, 'tbody .o-pivot-header-cell-opened',
            "row: should have one opened header");
        assert.strictEqual(pivot.$('tbody .o-pivot-header-cell-closed:contains(xphone)').length, 1,
            "row: should display one closed header with 'xphone'");
        assert.strictEqual(pivot.$('tbody .o-pivot-header-cell-closed:contains(xpad)').length, 1,
            "row: should display one closed header with 'xpad'");

        assert.strictEqual(pivot.$('tbody tr:first td:nth(2)').text(), '32',
            "selected measure should be foo, with total 32");

        pivot.destroy();
    });

    QUnit.test('correctly use groupby key from the context', async function (assert) {
        assert.expect(7);

        var pivot = await createView({
            View: PivotView,
            model: 'partner',
            data: this.data,
            arch: '<pivot>' +
                        '<field name="customer" type="col" />' +
                        '<field name="foo" type="measure" />' +
                '</pivot>',
            groupBy: ['productId'],
        });

        assert.containsOnce(pivot, 'thead .o-pivot-header-cell-opened',
            'column: should have one opened header');
        assert.strictEqual(pivot.$('thead .o-pivot-header-cell-closed:contains(First)').length, 1,
            'column: should display one closed header with "First"');
        assert.strictEqual(pivot.$('thead .o-pivot-header-cell-closed:contains(Second)').length, 1,
            'column: should display one closed header with "Second"');

        assert.containsOnce(pivot, 'tbody .o-pivot-header-cell-opened',
            'row: should have one opened header');
        assert.strictEqual(pivot.$('tbody .o-pivot-header-cell-closed:contains(xphone)').length, 1,
            'row: should display one closed header with "xphone"');
        assert.strictEqual(pivot.$('tbody .o-pivot-header-cell-closed:contains(xpad)').length, 1,
            'row: should display one closed header with "xpad"');

        assert.strictEqual(pivot.$('tbody tr:first td:nth(2)').text(), '32',
            'selected measure should be foo, with total 32');

        pivot.destroy();
    });

    QUnit.test('correctly uses pivot_row_groupby key with default groupBy from the context', async function (assert) {
        assert.expect(6);

        this.data.partner.fields.amount = {string: "Amount", type: "float", groupOperator: 'sum'};

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot>' +
                        '<field name="customer" type="col"/>' +
                        '<field name="date" interval="day" type="row"/>' +
                '</pivot>',
            groupBy: ['customer'],
            viewOptions: {
                context: {
                    pivot_row_groupby: ['productId'],
                },
            },
        });

        assert.strictEqual(pivot.$('thead .o-pivot-header-cell-opened').length, 1,
            "column: should have one opened header");
        assert.strictEqual(pivot.$('thead .o-pivot-header-cell-closed:contains(First)').length, 1,
            "column: should display one closed header with 'First'");
        assert.strictEqual(pivot.$('thead .o-pivot-header-cell-closed:contains(Second)').length, 1,
            "column: should display one closed header with 'Second'");

        // With pivot_row_groupby, groupBy customer should replace and eventually display productId
        assert.strictEqual(pivot.$('tbody .o-pivot-header-cell-opened').length, 1,
            "row: should have one opened header");
        assert.strictEqual(pivot.$('tbody .o-pivot-header-cell-closed:contains(xphone)').length, 1,
            "row: should display one closed header with 'xphone'");
        assert.strictEqual(pivot.$('tbody .o-pivot-header-cell-closed:contains(xpad)').length, 1,
            "row: should display one closed header with 'xpad'");

        pivot.destroy();
    });

    QUnit.test('pivot still handles __count__ measure', async function (assert) {
        // for retro-compatibility reasons, the pivot view still handles
        // '__count__' measure.
        assert.expect(2);

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot></pivot>',
            mockRPC: function (route, args) {
                if (args.method === 'readGroup') {
                    assert.deepEqual(args.kwargs.fields, ['__count'],
                        "should make a readGroup with field __count");
                }
                return this._super(route, args);
            },
            viewOptions: {
                context: {
                    pivot_measures: ['__count__'],
                },
            },
        });

        var $countMeasure = pivot.$buttons.find('.dropdown-item[data-field=__count]:first');
        assert.hasClass($countMeasure,'selected', "The count measure should be activated");

        pivot.destroy();
    });

    QUnit.test('not use a many2one as a measure by default', async function (assert) {
        assert.expect(1);

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot>' +
                        '<field name="productId"/>' +
                        '<field name="date" interval="month" type="col"/>' +
                '</pivot>',
        });
        assert.notOk(pivot.measures.productId,
            "should not have productId as measure");
        pivot.destroy();
    });

    QUnit.test('use a many2one as a measure with specified additional measure', async function (assert) {
        assert.expect(1);

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot>' +
                        '<field name="productId"/>' +
                        '<field name="date" interval="month" type="col"/>' +
                '</pivot>',
            viewOptions: {
                additionalMeasures: ['productId'],
            },
        });
        assert.ok(pivot.measures.productId,
            "should have productId as measure");
        pivot.destroy();
    });

    QUnit.test('pivot view with many2one field as a measure', async function (assert) {
        assert.expect(1);

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot>' +
                        '<field name="productId" type="measure"/>' +
                        '<field name="date" interval="month" type="col"/>' +
                '</pivot>',
        });

        assert.strictEqual(pivot.$('table tbody tr').text().trim(), "Total2112",
            "should display productId count as measure");
        pivot.destroy();
    });

    QUnit.test('m2o as measure, drilling down into data', async function (assert) {
        assert.expect(1);

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot>' +
                        '<field name="productId" type="measure"/>' +
                '</pivot>',
        });
        await testUtils.dom.click(pivot.el.querySelector('tbody .o-pivot-header-cell-closed'));
        // click on date by month
        await testUtils.dom.triggerEvent(pivot.el.querySelector("tbody .dropdown-menu .dropdown-toggle"), "mouseenter");
        await testUtils.dom.click(
            pivot.el.querySelectorAll("tbody .dropdown-menu .dropdown-menu .dropdown-item")[3]
        );

        assert.strictEqual(pivot.$('.o-pivot-cell-value').text(), '2211',
            'should have loaded the proper data');
        pivot.destroy();
    });

    QUnit.test('pivot view with same many2one field as a measure and grouped by', async function (assert) {
        assert.expect(1);

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot>' +
                        '<field name="productId" type="row"/>' +
                '</pivot>',
            viewOptions: {
                additionalMeasures: ['productId'],
            },
        });

        await testUtils.pivot.toggleMeasuresDropdown(pivot);
        await testUtils.pivot.clickMeasure(pivot, 'productId');
        assert.strictEqual(pivot.$('.o-pivot-cell-value').text(), '421131',
            'should have loaded the proper data');
        pivot.destroy();
    });

    QUnit.test('pivot view with same many2one field as a measure and grouped by (and drill down)', async function (assert) {
        assert.expect(1);

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot>' +
                        '<field name="productId" type="measure"/>' +
                '</pivot>',
        });

        await testUtils.dom.click(pivot.el.querySelector('tbody .o-pivot-header-cell-closed'));

        await testUtils.dom.click(pivot.el.querySelectorAll("tbody .dropdown-item")[4]);

        assert.strictEqual(pivot.$('.o-pivot-cell-value').text(), '211',
            'should have loaded the proper data');
        pivot.destroy();
    });

    QUnit.test('Row and column groupbys plus a domain', async function (assert) {
        assert.expect(3);

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot>' +
                        '<field name="foo" type="measure"/>' +
                '</pivot>',
        });

        // Set a column groupby
        await testUtils.dom.click(pivot.$('thead .o-pivot-header-cell-closed'));
        await testUtils.dom.click(pivot.el.querySelectorAll("thead .dropdown-item")[1]);

        // Set a Row groupby
        await testUtils.dom.click(pivot.el.querySelector('tbody .o-pivot-header-cell-closed'));
        await testUtils.dom.click(pivot.el.querySelectorAll("tbody .dropdown-item")[4]);

        // Set a domain
        await testUtils.pivot.reload(pivot, {domain: [['productId', '=', 41]]});

        var expectedContext = {
            context: {
                pivot_column_groupby: ['customer'],
                pivot_measures: ['foo'],
                pivot_row_groupby: ['productId'],
            },
        };

        // Mock 'save as favorite'
        assert.deepEqual(pivot.getOwnedQueryParams(), expectedContext,
            'The pivot view should have the right context');

        assert.containsOnce(
            pivot,
            "tbody .o-pivot-header-cell-closed",
            "There should be only one product line because of the domain"
        );
        assert.strictEqual(
            pivot.el.querySelector("tbody .o-pivot-header-cell-closed").innerText,
            "xpad",
            "The product should be the right one"
        );

        pivot.destroy();
    });

    QUnit.test('parallel data loading should discard all but the last one', async function (assert) {
        assert.expect(2);

        var def;

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot>' +
                      '<field name="foo" type="measure"/>' +
                  '</pivot>',
            mockRPC: function (route, args) {
                var result = this._super.apply(this, arguments);
                if (args.method === 'readGroup') {
                    return Promise.resolve(def).then(_.constant(result));
                }
                return result;
            },
        });

        def = testUtils.makeTestPromise();
        testUtils.pivot.reload(pivot, {groupBy: ['productId']});
        testUtils.pivot.reload(pivot, {groupBy: ['productId', 'customer']});
        await def.resolve();
        await testUtils.nextTick();
        assert.containsN(pivot, '.o-pivot-cell-value', 6,
            "should have 6 cells");
        assert.containsN(pivot, 'tbody tr', 6,
            "should have 6 rows");
        pivot.destroy();
    });

    QUnit.test('pivot measures should be alphabetically sorted', async function (assert) {
        assert.expect(2);

        var data = this.data;
        // It's important to compare capitalized and lowercased words
        // to be sure the sorting is effective with both of them
        data.partner.fields.bouh = {string: "bouh", type: "integer", groupOperator: 'sum'};
        data.partner.fields.modd = {string: "modd", type: "integer", groupOperator: 'sum'};
        data.partner.fields.zip = {string: "Zip", type: "integer", groupOperator: 'sum'};

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: data,
            arch: '<pivot>' +
                        '<field name="zip" type="measure"/>' +
                        '<field name="foo" type="measure"/>' +
                        '<field name="bouh" type="measure"/>' +
                        '<field name="modd" type="measure"/>' +
                  '</pivot>',
        });
        assert.strictEqual(pivot.$buttons.find('.o-pivot-measures_list .dropdown-item:first').data('field'), 'bouh',
            "Bouh should be the first measure");
        assert.strictEqual(pivot.$buttons.find('.o-pivot-measures_list .dropdown-item:last').data('field'), '__count',
            "Count should be the last measure");

        pivot.destroy();
    });

    QUnit.test('pivot view should use default order for auto sorting', async function (assert) {
        assert.expect(1);

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot defaultOrder="foo asc">' +
                        '<field name="foo" type="measure"/>' +
                  '</pivot>',
        });

        assert.hasClass(pivot.$('thead tr:last th:last'), 'o-pivot-sort-order-asc',
                        "Last thead should be sorted in ascending order");

        pivot.destroy();
    });

    QUnit.test('pivot view can be flipped', async function (assert) {
        assert.expect(5);

        var rpcCount = 0;

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot>' +
                        '<field name="productId" type="row"/>' +
                '</pivot>',
            mockRPC: function () {
                rpcCount++;
                return this._super.apply(this, arguments);
            },
        });

        assert.containsN(pivot, 'tbody tr', 3,
            "should have 3 rows: 1 for the open header, and 2 for data");
        var values = [
            "4",
            "1",
            "3"
        ];
        assert.strictEqual(getCurrentValues(pivot), values.join());

        rpcCount = 0;
        await testUtils.dom.click(pivot.$buttons.find('.o-pivot-flip_button'));

        assert.strictEqual(rpcCount, 0, "should not have done any rpc");
        assert.containsOnce(pivot, 'tbody tr',
            "should have 1 rows: 1 for the main header");

        values = [
            "1", "3", "4"
        ];
        assert.strictEqual(getCurrentValues(pivot), values.join());

        pivot.destroy();
    });

    QUnit.test('rendering of pivot view with comparison', async function (assert) {
        assert.expect(8);

        this.data.partner.records[0].date = '2016-12-15';
        this.data.partner.records[1].date = '2016-12-17';
        this.data.partner.records[2].date = '2016-11-22';
        this.data.partner.records[3].date = '2016-11-03';


        var unpatchDate = patchDate(2016, 11, 20, 1, 0, 0);

        var pivot = await createView({
            View: PivotView,
            model: 'partner',
            data: this.data,
            arch: '<pivot>' +
                    '<field name="date" interval="month" type="col"/>' +
                    '<field name="foo" type="measure"/>' +
              '</pivot>',
            archs: {
                'partner,false,search': `
                    <search>
                        <filter name="date_filter" date="date" domain="[]" default_period='last_year'/>
                    </search>
                `,
            },
            viewOptions: {
                additionalMeasures: ['productId'],
                context: { search_default_date_filter: 1 },
            },
            mockRPC: function () {
                return this._super.apply(this, arguments);
            },
            env: {
                dataManager: {
                    create_filter: async function (filter) {
                        assert.deepEqual(filter.context, {
                            pivot_measures: ['__count'],
                            pivot_column_groupby: [],
                            pivot_row_groupby: ['productId'],
                            groupby: [],
                            comparison: {
                                comparisonId: "previous_period",
                                comparisonRange: "[\"&\", [\"date\", \">=\", \"2016-11-01\"], [\"date\", \"<=\", \"2016-11-30\"]]",
                                comparisonRangeDescription: "November 2016",
                                fieldDescription: "Date",
                                fieldName: "date",
                                range: "[\"&\", [\"date\", \">=\", \"2016-12-01\"], [\"date\", \"<=\", \"2016-12-31\"]]",
                                rangeDescription: "December 2016"
                              },
                        });
                    }
                }
            },
        });

        // with no data
        await cpHelpers.toggleComparisonMenu(pivot.el);
        await cpHelpers.toggleMenuItem(pivot.el, 'Date: Previous period');

        assert.strictEqual(pivot.$('.o-legacy-pivot p.o-view-nocontent-empty-folder').length, 1);

        await cpHelpers.toggleFilterMenu(pivot.el);
        await cpHelpers.toggleMenuItem(pivot.el, 'Date');
        await cpHelpers.toggleMenuItemOption(pivot.el, 'Date', 'December');
        await cpHelpers.toggleMenuItemOption(pivot.el, 'Date', '2016');
        await cpHelpers.toggleMenuItemOption(pivot.el, 'Date', '2015');

        assert.containsN(pivot, '.o-legacy-pivot thead tr:last th', 9,
            "last header row should contains 9 cells (3*[December 2016, November 2016, Variation]");
        var values = [
            "19", "0", "-100%", "0", "13", "100%", "19", "13", "-31.58%"
        ];
        assert.strictEqual(getCurrentValues(pivot), values.join());

        // with data, with row groupby
        await testUtils.dom.click(pivot.$('.o-legacy-pivot .o-pivot-header-cell-closed').eq(2));
        await testUtils.dom.click(pivot.el.querySelectorAll("tbody .dropdown-menu .dropdown-item")[4]);
        values = [
            "19", "0", "-100%", "0", "13", "100%", "19", "13", "-31.58%",
            "19", "0", "-100%", "0", "1" , "100%", "19", "1", "-94.74%",
                                "0", "12", "100%", "0" , "12", "100%"
        ];
        assert.strictEqual(getCurrentValues(pivot), values.join());

        await testUtils.pivot.toggleMeasuresDropdown(pivot);
        await testUtils.dom.click(pivot.$('.o-control-panel div.o-pivot-measures_list a[data-field="foo"]'));
        await testUtils.dom.click(pivot.$('.o-control-panel div.o-pivot-measures_list a[data-field="productId"]'));
        values = [
            "1", "0", "-100%", "0", "2", "100%", "1", "2", "100%",
            "1", "0", "-100%", "0", "1", "100%", "1", "1", "0%",
                               "0", "1", "100%", "0", "1", "100%"
        ];
        assert.strictEqual(getCurrentValues(pivot), values.join());

        await testUtils.dom.click(pivot.$('.o-control-panel div.o-pivot-measures_list a[data-field="__count"]'));
        await testUtils.dom.click(pivot.$('.o-control-panel div.o-pivot-measures_list a[data-field="productId"]'));
        values = [
            "2", "0", "-100%", "0", "2", "100%", "2", "2", "0%",
            "2", "0", "-100%", "0", "1", "100%", "2", "1", "-50%",
                               "0", "1", "100%", "0", "1", "100%"
        ];
        assert.strictEqual(getCurrentValues(pivot), values.join());

        await testUtils.dom.clickFirst(pivot.$('.o-legacy-pivot .o-pivot-header-cell-opened'));
        values = [
            "2", "2", "0%",
            "2", "1", "-50%",
            "0", "1", "100%"
        ];
        assert.strictEqual(getCurrentValues(pivot), values.join());

        await cpHelpers.toggleFavoriteMenu(pivot.el);
        await cpHelpers.toggleSaveFavorite(pivot.el);
        await cpHelpers.editFavoriteName(pivot.el, 'Fav');
        await cpHelpers.saveFavorite(pivot.el);

        unpatchDate();
        pivot.destroy();
    });

    QUnit.test('export data in excel with comparison', async function (assert) {
        assert.expect(11);

        this.data.partner.records[0].date = '2016-12-15';
        this.data.partner.records[1].date = '2016-12-17';
        this.data.partner.records[2].date = '2016-11-22';
        this.data.partner.records[3].date = '2016-11-03';

        var unpatchDate = patchDate(2016, 11, 20, 1, 0, 0);

        var pivot = await createView({
            View: PivotView,
            model: 'partner',
            data: this.data,
            arch: '<pivot>' +
                    '<field name="date" interval="month" type="col"/>' +
                    '<field name="foo" type="measure"/>' +
              '</pivot>',
            archs: {
                'partner,false,search': `
                    <search>
                        <filter name="date_filter" date="date" domain="[]" default_period='antepenultimate_month'/>
                    </search>
                `,
            },
            viewOptions: {
                context: { search_default_date_filter: 1 },
            },
            session: {
                getFile: function (args) {
                    var data = JSON.parse(args.data.data);
                    _.each(data.col_group_headers, function (l) {
                        var titles = l.map(function (o) {
                            return o.title;
                        });
                        assert.step(JSON.stringify(titles));
                    });
                    var measures = data.measure_headers.map(function (o) {
                        return o.title;
                    });
                    assert.step(JSON.stringify(measures));
                    var origins = data.origin_headers.map(function (o) {
                        return o.title;
                    });
                    assert.step(JSON.stringify(origins));
                    assert.step(String(data.measure_count));
                    assert.step(String(data.origin_count));
                    var valuesLength = data.rows.map(function (o) {
                        return o.values.length;
                    });
                    assert.step(JSON.stringify(valuesLength));
                    assert.strictEqual(args.url, '/web/pivot/export_xlsx',
                        "should call getFile with correct parameters");
                    args.complete();
                },
            },
        });

        // open comparison menu
        await cpHelpers.toggleComparisonMenu(pivot.el);
        // compare October 2016 to September 2016
        await cpHelpers.toggleMenuItem(pivot.el, 'Date: Previous period');

        // With the data above, the time ranges contain no record.
        assert.strictEqual(pivot.$('.o-legacy-pivot p.o-view-nocontent-empty-folder').length, 1, "there should be no data");
        // export data should be impossible since the pivot buttons
        // are deactivated (exception: the 'Measures' button).
        assert.ok(pivot.$('.o-control-panel button.o-pivot-download').prop('disabled'));

        await cpHelpers.toggleFilterMenu(pivot.el);
        await cpHelpers.toggleMenuItem(pivot.el, 'Date');
        await cpHelpers.toggleMenuItemOption(pivot.el, 'Date', 'December');
        await cpHelpers.toggleMenuItemOption(pivot.el, 'Date', 'October');

        // With the data above, the time ranges contain some records.
        // export data. Should execute 'getFile'
        await testUtils.dom.click(pivot.$('.o-control-panel button.o-pivot-download'));

        assert.verifySteps([
            // col group headers
            '["Total",""]',
            '["November 2016","December 2016"]',
            // measure headers
            '["Foo","Foo","Foo"]',
            // origin headers
            '["November 2016","December 2016","Variation","November 2016","December 2016"' +
                ',"Variation","November 2016","December 2016","Variation"]',
            // number of 'measures'
            '1',
            // number of 'origins'
            '2',
            // rows values length
            '[9]',
        ]);

        unpatchDate();
        pivot.destroy();
    });

    QUnit.test('rendering of pivot view with comparison and count measure', async function (assert) {
        assert.expect(2);

        var mockMock = false;
        var nbReadGroup = 0;

        this.data.partner.records[0].date = '2016-12-15';
        this.data.partner.records[1].date = '2016-12-17';
        this.data.partner.records[2].date = '2016-12-22';
        this.data.partner.records[3].date = '2016-12-03';

        var unpatchDate = patchDate(2016, 11, 20, 1, 0, 0);

        var pivot = await createView({
            View: PivotView,
            model: 'partner',
            data: this.data,
            arch: '<pivot><field name="customer" type="row"/></pivot>',
            archs: {
                'partner,false,search': `
                    <search>
                        <filter name="date_filter" date="date" domain="[]" default_period='this_month'/>
                    </search>
                `,
            },
            viewOptions: {
                context: { search_default_date_filter: 1 },
            },
            mockRPC: function (route, args) {
                var result = this._super.apply(this, arguments);
                if (args.method === 'readGroup' && mockMock) {
                    nbReadGroup++;
                    if (nbReadGroup === 4) {
                        // this modification is necessary because mockReadGroup does not
                        // properly reflect the server response when there is no record
                        // and a groupby list of length at least one.
                        return Promise.resolve([{}]);
                    }
                }
                return result;
            },
        });

        mockMock = true;

        // compare December 2016 to November 2016
        await cpHelpers.toggleComparisonMenu(pivot.el);
        await cpHelpers.toggleMenuItem(pivot.el, 'Date: Previous period');

        var values = [
            "0", "4", "100%",
            "0", "2", "100%",
            "0", "2", "100%"
        ];
        assert.strictEqual(getCurrentValues(pivot), values.join(','));
        assert.strictEqual(pivot.$('.o-pivot-header-cell-closed').length, 3,
            "there should be exactly three closed header ('Total','First', 'Second')");

        unpatchDate();
        pivot.destroy();
    });

    QUnit.test('can sort a pivot view with comparison by clicking on header', async function (assert) {
        assert.expect(6);

        this.data.partner.records[0].date = '2016-12-15';
        this.data.partner.records[1].date = '2016-12-17';
        this.data.partner.records[2].date = '2016-11-22';
        this.data.partner.records[3].date = '2016-11-03';

        var unpatchDate = patchDate(2016, 11, 20, 1, 0, 0);
        var pivot = await createView({
            View: PivotView,
            model: 'partner',
            data: this.data,
            arch: '<pivot>' +
                    '<field name="date" interval="day" type="row"/>' +
                    '<field name="company_type" type="col"/>' +
                    '<field name="foo" type="measure"/>' +
                '</pivot>',
            archs: {
                'partner,false,search': `
                    <search>
                        <filter name="date_filter" date="date" domain="[]" default_period='this_month'/>
                    </search>
                `,
            },
            viewOptions: {
                additionalMeasures: ['productId'],
                context: { search_default_date_filter: 1 },
            },
        });

        // compare December 2016 to November 2016
        await cpHelpers.toggleComparisonMenu(pivot.el);
        await cpHelpers.toggleMenuItem(pivot.el, 'Date: Previous period');

        // initial sanity check
        var values = [
            "17", "12", "-29.41%", "2", "1", "-50%", "19", "13", "-31.58%",
            "17", "0", "-100%",                      "17", "0", "-100%",
                                   "2", "0", "-100%", "2", "0", "-100%",
            "0", "12" , "100%",                       "0", "12" , "100%",
                                   "0", "1", "100%" , "0" , "1" , "100%"
        ];
        assert.strictEqual(getCurrentValues(pivot), values.join());

        // click on 'Foo' in column Total/Company (should sort by the period of interest, ASC)
        await testUtils.dom.click(pivot.$('.o-pivot-measure-row').eq(0));
        values = [
            "17", "12", "-29.41%", "2", "1", "-50%" , "19", "13", "-31.58%",
                                   "2", "0", "-100%", "2", "0", "-100%",
            "0", "12", "100%",                        "0", "12", "100%",
                                   "0", "1", "100%", "0", "1", "100%",
            "17", "0", "-100%",                      "17", "0", "-100%"
        ];
        assert.strictEqual(getCurrentValues(pivot), values.join());

        // click again on 'Foo' in column Total/Company (should sort by the period of interest, DESC)
        await testUtils.dom.click(pivot.$('.o-pivot-measure-row').eq(0));
        values = [
            "17", "12", "-29.41%", "2", "1", "-50%", "19", "13", "-31.58%",
            "17", "0", "-100%",                      "17", "0", "-100%",
                                   "2", "0", "-100%", "2", "0", "-100%",
            "0", "12", "100%",                       "0", "12", "100%",
                                   "0", "1", "100%", "0", "1", "100%"
        ];
        assert.strictEqual(getCurrentValues(pivot), values.join());

        // click on 'This Month' in column Total/Individual/Foo
        await testUtils.dom.click(pivot.$('.o-pivot-origin-row').eq(3));
        values = [
            "17", "12", "-29.41%", "2", "1", "-50%", "19", "13", "-31.58%",
            "17", "0", "-100%",                      "17", "0", "-100%",
            "0", "12", "100%",                       "0", "12" , "100%",
                                   "0", "1", "100%", "0", "1", "100%",
                                   "2", "0", "-100%",  "2", "0",  "-100%"
        ];
        assert.strictEqual(getCurrentValues(pivot), values.join());

        // click on 'Previous Period' in column Total/Individual/Foo
        await testUtils.dom.click(pivot.$('.o-pivot-origin-row').eq(4));
        values = [
            "17", "12", "-29.41%", "2", "1", "-50%", "19", "13", "-31.58%",
            "17", "0", "-100%",                      "17", "0", "-100%",
                                   "2", "0", "-100%", "2", "0", "-100%",
            "0", "12", "100%",                       "0", "12", "100%",
                                   "0", "1", "100%", "0", "1", "100%"
        ];
        assert.strictEqual(getCurrentValues(pivot), values.join());

        // click on 'Variation' in column Total/Foo
        await testUtils.dom.click(pivot.$('.o-pivot-origin-row').eq(8));
        values = [
            "17", "12", "-29.41%", "2", "1", "-50%",  "19", "13", "-31.58%",
            "17",  "0", "-100%",                      "17",  "0", "-100%",
                                   "2", "0", "-100%", "2" , "0" , "-100%",
            "0", "12",  "100%",                       "0", "12" , "100%",
                                   "0", "1", "100%",  "0" , "1",  "100%"
        ];
        assert.strictEqual(getCurrentValues(pivot), values.join());

        unpatchDate();
        pivot.destroy();
    });

    QUnit.test('Click on the measure list but not on a menu item', async function (assert) {
        assert.expect(2);

        const pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            // have at least a measure to have a separator in the Measures dropdown:
            //
            // Foo
            // -----
            // Count
            arch: `<pivot><field name="foo" type="measure"/></pivot>`,
        });

        // open the "Measures" menu
        await testUtils.dom.click(pivot.el.querySelector('.o-cp-buttons button'));

        // click on the divider in the "Measures" menu does not crash
        await testUtils.dom.click(pivot.el.querySelector('.o-pivot-measures_list .dropdown-divider'));
        // the menu should still be open
        assert.isVisible(pivot.el.querySelector('.o-pivot-measures_list'));

        // click on the measure list but not on a menu item or the separator
        await testUtils.dom.click(pivot.el.querySelector('.o-pivot-measures_list'));
        // the menu should still be open
        assert.isVisible(pivot.el.querySelector('.o-pivot-measures_list'));

        pivot.destroy();
    });

    QUnit.test('Cell values are kept when flippin a pivot view in comparison mode', async function (assert) {
        assert.expect(2);

        this.data.partner.records[0].date = '2016-12-15';
        this.data.partner.records[1].date = '2016-12-17';
        this.data.partner.records[2].date = '2016-11-22';
        this.data.partner.records[3].date = '2016-11-03';

        var unpatchDate = patchDate(2016, 11, 20, 1, 0, 0);
        var pivot = await createView({
            View: PivotView,
            model: 'partner',
            data: this.data,
            arch: '<pivot>' +
                    '<field name="date" interval="day" type="row"/>' +
                    '<field name="company_type" type="col"/>' +
                    '<field name="foo" type="measure"/>' +
                '</pivot>',
            archs: {
                'partner,false,search': `
                    <search>
                        <filter name="date_filter" date="date" domain="[]" default_period='this_month'/>
                    </search>
                `,
            },
            viewOptions: {
                additionalMeasures: ['productId'],
                context: { search_default_date_filter: 1 },
            },
        });

        // compare December 2016 to November 2016
        await cpHelpers.toggleComparisonMenu(pivot.el);
        await cpHelpers.toggleMenuItem(pivot.el, 'Date: Previous period');

        // initial sanity check
        var values = [
            "17", "12", "-29.41%", "2", "1", "-50%", "19", "13", "-31.58%",
            "17", "0", "-100%",                      "17", "0", "-100%",
                                   "2", "0", "-100%", "2", "0", "-100%",
            "0", "12", "100%",                       "0", "12", "100%",
                                   "0", "1", "100%", "0", "1", "100%",


        ];
        assert.strictEqual(getCurrentValues(pivot), values.join());

        // flip table
        await testUtils.dom.click(pivot.$buttons.find('.o-pivot-flip_button'));

        values = [
            "17", "0", "-100%", "2", "0", "-100%", "0", "12", "100%", "0", "1", "100%", "19", "13", "-31.58%",
            "17", "0", "-100%",                    "0", "12", "100%",                   "17", "12", "-29.41%",
                                "2", "0", "-100%",                    "0",  "1", "100%", "2",  "1",  "-50%"
        ];
        assert.strictEqual(getCurrentValues(pivot), values.join());

        unpatchDate();
        pivot.destroy();
    });

    QUnit.test('Flip then compare, table col groupbys are kept', async function (assert) {
        assert.expect(6);

        this.data.partner.records[0].date = '2016-12-15';
        this.data.partner.records[1].date = '2016-12-17';
        this.data.partner.records[2].date = '2016-11-22';
        this.data.partner.records[3].date = '2016-11-03';

        var unpatchDate = patchDate(2016, 11, 20, 1, 0, 0);
        var pivot = await createView({
            View: PivotView,
            model: 'partner',
            data: this.data,
            arch: '<pivot>' +
                    '<field name="date" interval="day" type="row"/>' +
                    '<field name="company_type" type="col"/>' +
                    '<field name="foo" type="measure"/>' +
                '</pivot>',
            archs: {
                'partner,false,search': `
                    <search>
                        <filter name="date_filter" date="date" domain="[]" default_period='this_month'/>
                    </search>
                `,
            },
            viewOptions: {
                additionalMeasures: ['productId'],
            },
        });


        assert.strictEqual(
            pivot.$('th').slice(0, 5).text(),
            [
                '', 'Total',                 '',
                    'Company', 'individual',
            ].join(''),
            "The col headers should be as expected"
        );
        assert.strictEqual(
            pivot.$('th').slice(8).text(),
            [
                'Total',
                    '2016-12-15',
                    '2016-12-17',
                    '2016-11-22',
                    '2016-11-03'
            ].join(''),
            "The row headers should be as expected"
        );

        // flip
        await testUtils.dom.click(pivot.$buttons.find('.o-pivot-flip_button'));

        assert.strictEqual(
            pivot.$('th').slice(0, 7).text(),
            [
                '', 'Total',                                                '',
                    '2016-12-15', '2016-12-17', '2016-11-22', '2016-11-03',
            ].join(''),
            "The col headers should be as expected"
        );
        assert.strictEqual(
            pivot.$('th').slice(12).text(),
            [
                'Total',
                    'Company',
                    'individual'

            ].join(''),
            "The row headers should be as expected"
        );

        // Filter on December 2016
        await cpHelpers.toggleFilterMenu(pivot.el);
        await cpHelpers.toggleMenuItem(pivot.el, 'Date');
        await cpHelpers.toggleMenuItemOption(pivot.el, 'Date', 'December');

        // compare December 2016 to November 2016
        await cpHelpers.toggleComparisonMenu(pivot.el);
        await cpHelpers.toggleMenuItem(pivot.el, 'Date: Previous period');

        assert.strictEqual(
            pivot.$('th').slice(0, 7).text(),
            [
                '', 'Total',                                                '',
                    '2016-11-22', '2016-11-03', '2016-12-15', '2016-12-17',
            ].join(''),
            "The col headers should be as expected"
        );
        assert.strictEqual(
            pivot.$('th').slice(27).text(),
            [
                'Total',
                    'Company',
                    'individual'

            ].join(''),
            "The row headers should be as expected"
        );
        unpatchDate();
        pivot.destroy();
    });

    QUnit.test('correctly compute group domain when a date field has false value', async function (assert) {
        assert.expect(1);

        this.data.partner.records.forEach(r => r.date = false);

        var unpatchDate = patchDate(2016, 11, 20, 1, 0, 0);
        var pivot = await createView({
            View: PivotView,
            model: 'partner',
            data: this.data,
            arch: '<pivot o-enable-linking="1">' +
                    '<field name="date" interval="day" type="row"/>' +
                '</pivot>',
            intercepts: {
                doAction: function (ev) {
                    assert.deepEqual(ev.data.action.domain, [['date', '=', false]]);
                },
            },
        });

        await testUtils.dom.click($('div .o-value')[1]);

        unpatchDate();
        pivot.destroy();
    });
    QUnit.test('Does not identify "false" with false as keys when creating group trees', async function (assert) {
        assert.expect(2);

        this.data.partner.fields.favorite_animal = {string: "Favorite animal", type: "char", store: true};
        this.data.partner.records[0].favorite_animal = 'Dog';
        this.data.partner.records[1].favorite_animal = 'false';
        this.data.partner.records[2].favorite_animal = 'Undefined';

        var unpatchDate = patchDate(2016, 11, 20, 1, 0, 0);
        var pivot = await createView({
            View: PivotView,
            model: 'partner',
            data: this.data,
            arch: '<pivot o-enable-linking="1">' +
                    '<field name="favorite_animal" type="row"/>' +
                '</pivot>',

        });

        assert.strictEqual(
            pivot.$('th').slice(0, 2).text(),
            [
                '', 'Total',                                                '',
            ].join(''),
            "The col headers should be as expected"
        );
        assert.strictEqual(
            pivot.$('th').slice(3).text(),
            [
                'Total',
                    'Dog',
                    'false',
                    'Undefined',
                    'Undefined'

            ].join(''),
            "The row headers should be as expected"
        );

        unpatchDate();
        pivot.destroy();
    });

    QUnit.test('group bys added via control panel and expand Header do not stack', async function (assert) {
        assert.expect(8);

        var pivot = await createView({
            View: PivotView,
            model: 'partner',
            data: this.data,
            arch: '<pivot>' +
                    '<field name="foo" type="measure"/>' +
                '</pivot>',
            viewOptions: {
                additionalMeasures: ['productId'],
            },
        });

        assert.strictEqual(
            pivot.$('th').slice(0, 2).text(),
            [
                '', 'Total',
            ].join(''),
            "The col headers should be as expected"
        );
        assert.strictEqual(
            pivot.$('th').slice(3).text(),
            [
                'Total',
            ].join(''),
            "The row headers should be as expected"
        );


        // open group by menu and add new groupby
        await cpHelpers.toggleGroupByMenu(pivot.el);
        await cpHelpers.toggleAddCustomGroup(pivot.el);
        await cpHelpers.applyGroup(pivot.el);

        assert.strictEqual(
            pivot.$('th').slice(0, 2).text(),
            [
                '', 'Total',
            ].join(''),
            "The col headers should be as expected"
        );
        assert.strictEqual(
            pivot.$('th').slice(3).text(),
            [
                'Total',
                    'Company',
                    'individual'
            ].join(''),
            "The row headers should be as expected"
        );

        // Set a Row groupby
        await testUtils.dom.click(pivot.el.querySelector('tbody tr:nth-child(2) .o-pivot-header-cell-closed'));
        await testUtils.dom.click(pivot.el.querySelectorAll("tbody .dropdown-item")[4]);

        assert.strictEqual(
            pivot.$('th').slice(0, 2).text(),
            [
                '', 'Total',
            ].join(''),
            "The col headers should be as expected"
        );
        assert.strictEqual(
            pivot.$('th').slice(3).text(),
            [
                'Total',
                    'Company',
                        'xphone',
                        'xpad',
                    'individual'
            ].join(''),
            "The row headers should be as expected"
        );

        // open groupby menu generator and add a new groupby
        await cpHelpers.toggleGroupByMenu(pivot.el);
        await cpHelpers.toggleAddCustomGroup(pivot.el);
        await cpHelpers.selectGroup(pivot.el, 'bar');
        await cpHelpers.applyGroup(pivot.el);

        assert.strictEqual(
            pivot.$('th').slice(0, 2).text(),
            [
                '', 'Total',
            ].join(''),
            "The col headers should be as expected"
        );
        assert.strictEqual(
            pivot.$('th').slice(3).text(),
            [
                'Total',
                    'Company',
                        'true',
                    'individual',
                        'true',
                        'Undefined'
            ].join(''),
            "The row headers should be as expected"
        );

        pivot.destroy();
    });

    QUnit.test('display only one dropdown menu', async function (assert) {
        assert.expect(1);

        var pivot = await createView({
            View: PivotView,
            model: 'partner',
            data: this.data,
            arch: '<pivot>' +
                    '<field name="foo" type="measure"/>' +
                '</pivot>',
            viewOptions: {
                additionalMeasures: ['productId'],
            },
        });
        await testUtils.dom.click(pivot.el.querySelector("thead th.o-pivot-header-cell-closed"));
        await testUtils.dom.click(pivot.el.querySelectorAll("thead .dropdown-menu .dropdown-item")[5]);

        // Click on the two dropdown
        await testUtils.dom.click(pivot.el.querySelectorAll("thead th.o-pivot-header-cell-closed")[0]);
        await testUtils.dom.click(pivot.el.querySelectorAll("thead th.o-pivot-header-cell-closed")[1]);

        assert.containsOnce(pivot, 'thead .dropdown-menu', 'Only one dropdown should be displayed at a time');

        pivot.destroy();
    });

    QUnit.test('Server order is kept by default', async function (assert) {
        assert.expect(1);

        let isSecondReadGroup = false;

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot>' +
                    '<field name="customer" type="row"/>' +
                    '<field name="foo" type="measure"/>' +
                '</pivot>',
            mockRPC: function (route, args) {
                if (args.method === 'readGroup' && isSecondReadGroup) {
                    return Promise.resolve([
                        {
                            customer: [2, 'Second'],
                            foo: 18,
                            __count: 2,
                            __domain :[["customer", "=", 2]],
                        },
                        {
                            customer: [1, 'First'],
                            foo: 14,
                            __count: 2,
                            __domain :[["customer", "=", 1]],
                        }
                    ]);
                }
                var result = this._super.apply(this, arguments);
                isSecondReadGroup = true;
                return result;
            },
        });

        const values = [
            "32", // Total Value
            "18", // Second
            "14", // First
        ];
        assert.strictEqual(getCurrentValues(pivot), values.join());

        pivot.destroy();
    });

    QUnit.test('comparison with two groupbys: rows from reference period should be displayed', async function (assert) {
        assert.expect(3);

        this.data.partner.records = [
            { id: 1, date: "2021-10-10", productId: 1, customer: 1 },
            { id: 2, date: "2020-10-10", productId: 2, customer: 1 },
        ]
        this.data.product.records = [
            { id: 1, displayName: "A" },
            { id: 2, displayName: "B" },
        ]
        this.data.customer.records = [
            { id: 1, displayName: "P" },
        ]

        const pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot><field name="customer" type="row"/><field name="productId" type="row"/></pivot>',
            archs: {
                "partner,false,search": "<search><filter name='date' date='date'/></search>"
            },
        });

        // compare 2021 to 2020
        await cpHelpers.toggleFilterMenu(pivot.el);
        await cpHelpers.toggleMenuItem(pivot.el, "Date");
        await cpHelpers.toggleMenuItemOption(pivot.el, "Date", "2021");
        await cpHelpers.toggleComparisonMenu(pivot.el);
        await cpHelpers.toggleMenuItem(pivot.el, 0);

        assert.strictEqual(
            pivot.$('th').slice(0, 6).text(),
            [
                        "Total",
                        "Count",
                "2020", "2021", "Variation"
            ].join(''),
            "The col headers should be as expected"
        );

        assert.strictEqual(
            pivot.$('th').slice(6).text(),
            [
                'Total',
                    'P',
                        'B',
                        'A',
            ].join(''),
            "The row headers should be as expected"
        );

        const values = [
            "1", "1", "0%",
            "1", "1", "0%",
            "1", "0", "-100%",
            "0", "1", "100%",
        ];
        assert.strictEqual(getCurrentValues(pivot), values.join());

        pivot.destroy();
    });

    QUnit.test('pivot rendering with boolean field', async function (assert) {
        assert.expect(4);

        this.data.partner.fields.bar = {string: "bar", type: "boolean", store: true, searchable: true, groupOperator: 'bool_or'};
        this.data.partner.records = [{id: 1, bar: true, date: '2019-12-14'}, {id: 2, bar: false, date: '2019-05-14'}];

        var pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot>' +
                        '<field name="date" type="row" interval="day"/>' +
                        '<field name="bar" type="col"/>' +
                        '<field name="bar" string="SLA status Failed" type="measure"/>' +
                '</pivot>',
        });

        assert.strictEqual(pivot.$('tbody tr:contains("2019-12-14")').length, 1, 'There should be a first column');
        assert.ok(pivot.$('tbody tr:contains("2019-12-14") [type="checkbox"]').is(':checked'), 'first column contains checkbox and value should be ticked');
        assert.strictEqual(pivot.$('tbody tr:contains("2019-05-14")').length, 1, 'There should be a second column');
        assert.notOk(pivot.$('tbody tr:contains("2019-05-14") [type="checkbox"]').is(':checked'), "second column should have checkbox that is not checked by default");

        pivot.destroy();
    });

    QUnit.test('Allow to add behaviour to buttons on pivot', async function (assert) {
        assert.expect(2);

        let _testButtons = (ev) => {
            if ($(ev.target).hasClass("o-pivot-flip_button")) {
                assert.step("o-pivot-flip_button")
            }
        }

        PivotController.include({
            _addIncludedButtons: async function (ev) {
                await this._super(...arguments);
                _testButtons(ev);
            },
        });

        const pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: '<pivot>' +
                        '<field name="date" type="row" interval="day"/>' +
                        '<field name="bar" type="col"/>' +
                '</pivot>',
        });
        await testUtils.dom.click(pivot.$buttons.find('.o-pivot-flip_button'));
        assert.verifySteps(["o-pivot-flip_button"]);
        _testButtons = () => true;
        pivot.destroy();
    });

    QUnit.test('empty pivot view with action helper', async function (assert) {
        assert.expect(4);

        const pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: `
                <pivot>
                    <field name="productId" type="measure"/>
                    <field name="date" interval="month" type="col"/>
                </pivot>`,
            domain: [['id', '<', 0]],
            viewOptions: {
                action: {
                    help: '<p class="abc">click to add a foo</p>'
                }
            },
        });

        assert.containsOnce(pivot, '.o-view-nocontent .abc');
        assert.containsNone(pivot, 'table');

        await pivot.reload({ domain: [] });

        assert.containsNone(pivot, '.o-view-nocontent .abc');
        assert.containsOnce(pivot, 'table');

        pivot.destroy();
    });

    QUnit.test('empty pivot view with sample data', async function (assert) {
        assert.expect(7);

        const pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: `
                <pivot sample="1">
                    <field name="productId" type="measure"/>
                    <field name="date" interval="month" type="col"/>
                </pivot>`,
            domain: [['id', '<', 0]],
            viewOptions: {
                action: {
                    help: '<p class="abc">click to add a foo</p>'
                }
            },
        });

        assert.hasClass(pivot.el, 'o-view-sample-data');
        assert.containsOnce(pivot, '.o-view-nocontent .abc');
        assert.containsOnce(pivot, 'table.o-sample-data-disabled');

        await pivot.reload({ domain: [] });

        assert.doesNotHaveClass(pivot.el, 'o-view-sample-data');
        assert.containsNone(pivot, '.o-view-nocontent .abc');
        assert.containsOnce(pivot, 'table');
        assert.doesNotHaveClass(pivot.$('table'), 'o-sample-data-disabled');

        pivot.destroy();
    });

    QUnit.test('non empty pivot view with sample data', async function (assert) {
        assert.expect(7);

        const pivot = await createView({
            View: PivotView,
            model: "partner",
            data: this.data,
            arch: `
                <pivot sample="1">
                    <field name="productId" type="measure"/>
                    <field name="date" interval="month" type="col"/>
                </pivot>`,
            viewOptions: {
                action: {
                    help: '<p class="abc">click to add a foo</p>'
                }
            },
        });

        assert.doesNotHaveClass(pivot.el, 'o-view-sample-data');
        assert.containsNone(pivot, '.o-view-nocontent .abc');
        assert.containsOnce(pivot, 'table');
        assert.doesNotHaveClass(pivot.$('table'), 'o-sample-data-disabled');

        await pivot.reload({ domain: [['id', '<', 0]] });

        assert.doesNotHaveClass(pivot.el, 'o-view-sample-data');
        assert.containsOnce(pivot, '.o-view-nocontent .abc');
        assert.containsNone(pivot, 'table');

        pivot.destroy();
    });
});
});
