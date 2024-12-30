verp.define('web.form_tests', function (require) {
"use strict";

const AbstractField = require("web.AbstractField");
var AbstractStorageService = require('web.AbstractStorageService');
var BasicModel = require('web.BasicModel');
var concurrency = require('web.concurrency');
var core = require('web.core');
var fieldRegistry = require('web.fieldRegistry');
const fieldRegistryOwl = require('web.fieldRegistryOwl');
const FormRenderer = require('web.FormRenderer');
var FormView = require('web.FormView');
var mixins = require('web.mixins');
var vjUtils = require('web.vjUtils');
var RamStorage = require('web.RamStorage');
var testUtils = require('web.testUtils');
var ViewDialogs = require('web.viewDialogs');
var widgetRegistry = require('web.widgetRegistryOld');
const widgetRegistryOwl = require('web.widgetRegistry');
var Widget = require('web.Widget');

var _t = core._t;
var createView = testUtils.createView;

const { registerCleanup } = require("@web/../tests/helpers/cleanup");
const { getFixture, legacyExtraNextTick, patchWithCleanup } = require("@web/../tests/helpers/utils");
const { createWebClient, doAction } = require('@web/../tests/webclient/helpers');
const { makeTestEnv } = require("@web/../tests/helpers/mock_env");
const makeTestEnvironment = require("web.test_env");
const { mapLegacyEnvToWowlEnv } = require("@web/legacy/utils");
const { registry } = require("@web/core/registry");
const { scrollerService } = require("@web/core/scroller_service");

let serverData;
QUnit.module('Views', {
    beforeEach: async function () {
        registry.category("services").add("scroller", scrollerService);
        
        this.data = {
            partner: {
                fields: {
                    displayName: { string: "Displayed name", type: "char" },
                    foo: {string: "Foo", type: "char", default: "My little Foo Value"},
                    bar: {string: "Bar", type: "boolean"},
                    int_field: {string: "int_field", type: "integer", sortable: true},
                    qux: {string: "Qux", type: "float", digits: [16,1] },
                    p: {string: "one2many field", type: "one2many", relation: 'partner'},
                    trululu: {string: "Trululu", type: "many2one", relation: 'partner'},
                    timmy: { string: "pokemon", type: "many2many", relation: 'partner_type'},
                    productId: {string: "Product", type: "many2one", relation: 'product'},
                    priority: {
                        string: "Priority",
                        type: "selection",
                        selection: [[1, "Low"], [2, "Medium"], [3, "High"]],
                        default: 1,
                    },
                    state: {string: "State", type: "selection", selection: [["ab", "AB"], ["cd", "CD"], ["ef", "EF"]]},
                    date: {string: "Some Date", type: "date"},
                    datetime: {string: "Datetime Field", type: 'datetime'},
                    productIds: {string: "one2many product", type: "one2many", relation: "product"},
                    reference: {string: "Reference Field", type: 'reference', selection: [["product", "Product"], ["partner_type", "Partner Type"], ["partner", "Partner"]]},
                },
                records: [{
                    id: 1,
                    displayName: "first record",
                    bar: true,
                    foo: "yop",
                    int_field: 10,
                    qux: 0.44,
                    p: [],
                    timmy: [],
                    trululu: 4,
                    state: "ab",
                    date: "2017-01-25",
                    datetime: "2016-12-12 10:55:05",
                }, {
                    id: 2,
                    displayName: "second record",
                    bar: true,
                    foo: "blip",
                    int_field: 9,
                    qux: 13,
                    p: [],
                    timmy: [],
                    trululu: 1,
                    state: "cd",
                }, {
                    id: 4,
                    displayName: "aaa",
                    state: "ef",
                }, {
                    id: 5,
                    displayName: "aaa",
                    foo:'',
                    bar:false,
                    state: "ef",
                }],
                onchanges: {},
            },
            product: {
                fields: {
                    displayName: {string: "Product Name", type: "char"},
                    name: {string: "Product Name", type: "char"},
                    partner_type_id: {string: "Partner type", type: "many2one", relation: "partner_type"},
                },
                records: [{
                    id: 37,
                    displayName: "xphone",
                }, {
                    id: 41,
                    displayName: "xpad",
                }]
            },
            partner_type: {
                fields: {
                    name: {string: "Partner Type", type: "char"},
                    color: {string: "Color index", type: "integer"},
                },
                records: [
                    {id: 12, displayName: "gold", color: 2},
                    {id: 14, displayName: "silver", color: 5},
                ]
            },
            "ir.translation": {
                fields: {
                    lang_code: {type: "char"},
                    value: {type: "char"},
                    resId: {type: "integer"}
                },
                records: [{
                    id: 99,
                    resId: 12,
                    value: '',
                    lang_code: 'en_US'
                }]
            },
            user: {
                fields: {
                    name: {string: "Name", type: "char"},
                    partnerIds: {string: "one2many partners field", type: "one2many", relation: 'partner', relationField: 'userId'},
                },
                records: [{
                    id: 17,
                    name: "Aline",
                    partnerIds: [1],
                }, {
                    id: 19,
                    name: "Christine",
                }]
            },
            "res.company": {
                fields: {
                    name: { string: "Name", type: "char" },
                },
            },
        };
        this.actions = [{
            id: 1,
            name: 'Partners Action 1',
            resModel: 'partner',
            type: 'ir.actions.actwindow',
            views: [[false, 'kanban'], [false, 'form']],
        }];

        // map legacy test data
        const actions = {};
        this.actions.forEach((act) => {
          actions[act.xmlid || act.id] = act;
        });
        serverData = {
            actions,
            models: this.data,
        };
    },
}, function () {

    QUnit.module('FormView');

    QUnit.test('simple form rendering', async function (assert) {
        assert.expect(12);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<div class="test" style="opacity: 0.5;">some html<span>aa</span></div>' +
                    '<sheet>' +
                        '<group>' +
                            '<group style="background-color: red">' +
                                '<field name="foo" style="color: blue"/>' +
                                '<field name="bar"/>' +
                                '<field name="int_field" string="f3_description"/>' +
                                '<field name="qux"/>' +
                            '</group>' +
                            '<group>' +
                                '<div class="hello"></div>' +
                            '</group>' +
                        '</group>' +
                        '<notebook>' +
                            '<page string="Partner Yo">' +
                                '<field name="p">' +
                                    '<tree>' +
                                        '<field name="foo"/>' +
                                        '<field name="bar"/>' +
                                    '</tree>' +
                                '</field>' +
                            '</page>' +
                        '</notebook>' +
                    '</sheet>' +
                '</form>',
            resId: 2,
        });


        assert.containsOnce(form, 'div.test');
        assert.strictEqual(form.$('div.test').css('opacity'), '0.5',
            "should keep the inline style on html elements");
        assert.containsOnce(form, 'label:contains(Foo)');
        assert.containsOnce(form, 'span:contains(blip)');
        assert.hasAttrValue(form.$('.o-group .o-group:first'), 'style', 'background-color: red',
            "should apply style attribute on groups");
        assert.hasAttrValue(form.$('.o-field-widget[name=foo]'), 'style', 'color: blue',
            "should apply style attribute on fields");
        assert.containsNone(form, 'label:contains(something_id)');
        assert.containsOnce(form, 'label:contains(f3_description)');
        assert.containsOnce(form, 'div.o-field-one2many table');
        assert.containsOnce(form, 'tbody td:not(.o-list-record-selector) .custom-checkbox input:checked');
        assert.containsOnce(form, '.o-control-panel .breadcrumb:contains(second record)');
        assert.containsNone(form, 'label.o-form-label_empty:contains(timmy)');

        form.destroy();
    });

    QUnit.test('duplicate fields rendered properly', async function (assert) {
        assert.expect(6);
        this.data.partner.records.push({
            id: 6,
            bar: true,
            foo: "blip",
            int_field: 9,
        });
        var form = await createView({
            View: FormView,
            viewOptions: { mode: 'edit' },
            model: 'partner',
            data: this.data,
            arch: '<form>' +
                    '<group>' +
                        '<group>' +
                            '<field name="foo" attrs="{\'invisible\': [(\'bar\',\'=\',true)]}"/>' +
                            '<field name="foo" attrs="{\'invisible\': [(\'bar\',\'=\',false)]}"/>' +
                            '<field name="foo"/>' +
                            '<field name="int_field" attrs="{\'readonly\': [(\'bar\',\'=\',false)]}"/>' +
                            '<field name="int_field" attrs="{\'readonly\': [(\'bar\',\'=\',true)]}"/>' +
                            '<field name="bar"/>' +
                        '</group>' +
                    '</group>' +
                '</form>',
            resId: 6,
        });

        assert.hasClass(form.$('div.o-group input[name="foo"]:eq(0)'), 'o-invisible-modifier', 'first foo widget should be invisible');
        assert.containsOnce(form, 'div.o-group input[name="foo"]:eq(1):not(.o-invisible-modifier)', "second foo widget should be visible");
        assert.containsOnce(form, 'div.o-group input[name="foo"]:eq(2):not(.o-invisible-modifier)', "third foo widget should be visible");
        await testUtils.fields.editInput(form.$('div.o-group input[name="foo"]:eq(2)'), "hello");
        assert.strictEqual(form.$('div.o-group input[name="foo"]:eq(1)').val(), "hello", "second foo widget should be 'hello'");
        assert.containsOnce(form, 'div.o-group input[name="int_field"]:eq(0):not(.o-readonly-modifier)', "first int_field widget should not be readonly");
        assert.hasClass(form.$('div.o-group span[name="int_field"]:eq(0)'),'o-readonly-modifier', "second int_field widget should be readonly");
        form.destroy();
    });

    QUnit.test('duplicate fields rendered properly (one2many)', async function (assert) {
        assert.expect(7);
        this.data.partner.records.push({
            id: 6,
            p: [1],
        });
        var form = await createView({
            View: FormView,
            viewOptions: { mode: 'edit' },
            model: 'partner',
            data: this.data,
            arch: '<form>' +
                    '<notebook>' +
                        '<page>' +
                            '<field name="p">' +
                                '<tree editable="true">' +
                                    '<field name="foo"/>' +
                                '</tree>' +
                                '<form/>' +
                            '</field>' +
                        '</page>' +
                        '<page>' +
                            '<field name="p" readonly="true">' +
                                '<tree editable="true">' +
                                    '<field name="foo"/>' +
                                '</tree>' +
                                '<form/>' +
                            '</field>' +
                        '</page>' +
                    '</notebook>' +
                '</form>',
            resId: 6,
        });
        assert.containsOnce(form, 'div.o-field-one2many:eq(0):not(.o-readonly-modifier)', "first one2many widget should not be readonly");
        assert.hasClass(form.$('div.o-field-one2many:eq(1)'),'o-readonly-modifier', "second one2many widget should be readonly");
        await testUtils.dom.click(form.$('div.tab-content table.o-list-table:eq(0) tr.o-data-row td.o-data-cell:eq(0)'));
        assert.strictEqual(form.$('div.tab-content table.o-list-table tr.o-selected-row input[name="foo"]').val(), "yop",
            "first line in one2many of first tab contains yop");
        assert.strictEqual(form.$('div.tab-content table.o-list-table:eq(1) tr.o-data-row td.o-data-cell:eq(0)').text(),
            "yop", "first line in one2many of second tab contains yop");
        await testUtils.fields.editInput(form.$('div.tab-content table.o-list-table tr.o-selected-row input[name="foo"]'), "hello");
        assert.strictEqual(form.$('div.tab-content table.o-list-table:eq(1) tr.o-data-row td.o-data-cell:eq(0)').text(), "hello",
            "first line in one2many of second tab contains hello");
        await testUtils.dom.click(form.$('div.tab-content table.o-list-table:eq(0) a:contains(Add a line)'));
        assert.strictEqual(form.$('div.tab-content table.o-list-table tr.o-selected-row input[name="foo"]').val(), "My little Foo Value",
            "second line in one2many of first tab contains 'My little Foo Value'");
        assert.strictEqual(form.$('div.tab-content table.o-list-table:eq(1) tr.o-data-row:eq(1) td.o-data-cell:eq(0)').text(),
            "My little Foo Value", "first line in one2many of second tab contains hello");
        form.destroy();
    });

    QUnit.test('attributes are transferred on async widgets', async function (assert) {
        assert.expect(1);
        var done  = assert.async();

        var def = testUtils.makeTestPromise();

        var FieldChar = fieldRegistry.get('char');
        fieldRegistry.add('asyncwidget', FieldChar.extend({
            willStart: function () {
                return def;
            },
        }));

        createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<group>' +
                        '<field name="foo" style="color: blue" widget="asyncwidget"/>' +
                    '</group>' +
                '</form>',
            resId: 2,
        }).then(function (form) {
            assert.hasAttrValue(form.$('.o-field-widget[name=foo]'), 'style', 'color: blue',
                "should apply style attribute on fields");
            form.destroy();
            delete fieldRegistry.map.asyncwidget;
            done();
        });
        def.resolve();
        await testUtils.nextTick();
    });

    QUnit.test('placeholder attribute on input', async function (assert) {
        assert.expect(1);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<input placeholder="chimay"/>' +
                '</form>',
            resId: 2,
        });

        assert.containsOnce(form, 'input[placeholder="chimay"]');
        form.destroy();
    });

    QUnit.test('decoration works on widgets', async function (assert) {
        assert.expect(2);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<field name="int_field"/>' +
                    '<field name="displayName" decoration-danger="int_field &lt; 5"/>' +
                    '<field name="foo" decoration-danger="int_field &gt; 5"/>' +
                '</form>',
            resId: 2,
        });
        assert.doesNotHaveClass(form.$('span[name="displayName"]'), 'text-danger');
        assert.hasClass(form.$('span[name="foo"]'), 'text-danger');
        form.destroy();
    });

    QUnit.test('decoration on widgets are reevaluated if necessary', async function (assert) {
        assert.expect(2);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<field name="int_field"/>' +
                    '<field name="displayName" decoration-danger="int_field &lt; 5"/>' +
                '</form>',
            resId: 2,
            viewOptions: {mode: 'edit'},
        });
        assert.doesNotHaveClass(form.$('input[name="displayName"]'), 'text-danger');
        await testUtils.fields.editInput(form.$('input[name=int_field]'), 3);
        assert.hasClass(form.$('input[name="displayName"]'), 'text-danger');
        form.destroy();
    });

    QUnit.test('decoration on widgets works on same widget', async function (assert) {
        assert.expect(2);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<field name="int_field" decoration-danger="int_field &lt; 5"/>' +
                '</form>',
            resId: 2,
            viewOptions: {mode: 'edit'},
        });
        assert.doesNotHaveClass(form.$('input[name="int_field"]'), 'text-danger');
        await testUtils.fields.editInput(form.$('input[name=int_field]'), 3);
        assert.hasClass(form.$('input[name="int_field"]'), 'text-danger');
        form.destroy();
    });

    QUnit.test('only necessary fields are fetched with correct context', async function (assert) {
        assert.expect(2);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                        '<field name="foo"/>' +
                '</form>',
            resId: 1,
            mockRPC: function (route, args) {
                // NOTE: actually, the current web client always request the __last_update
                // field, not sure why.  Maybe this test should be modified.
                assert.deepEqual(args.args[1], ["foo", "displayName"],
                    "should only fetch requested fields");
                assert.deepEqual(args.kwargs.context, {binSize: true},
                    "binSize should always be in the context");
                return this._super(route, args);
            }
        });
        form.destroy();
    });

    QUnit.test('group rendering', async function (assert) {
        assert.expect(1);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<group>' +
                            '<field name="foo"/>' +
                        '</group>' +
                    '</sheet>' +
                '</form>',
            resId: 1,
        });

        assert.containsOnce(form, 'table.o-inner-group');

        form.destroy();
    });

    QUnit.test('group containing both a field and a group', async function (assert) {
        // The purpose of this test is to check that classnames defined in a
        // field widget and those added by the form renderer are correctly
        // combined. For instance, the renderer adds className 'o-group-col-x'
        // on outer group's children (an outer group being a group that contains
        // at least a group).
        assert.expect(4);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form>' +
                    '<group>' +
                        '<field name="foo"/>' +
                        '<group>' +
                            '<field name="int_field"/>' +
                        '</group>' +
                    '</group>' +
                '</form>',
            resId: 1,
        });

        assert.containsOnce(form, '.o-group .o-field-widget[name=foo]');
        assert.containsOnce(form, '.o-group .o-inner-group .o-field-widget[name=int_field]');

        assert.hasClass(form.$('.o-field-widget[name=foo]'), 'o-field-char');
        assert.hasClass(form.$('.o-field-widget[name=foo]'), 'o-group-col-6');

        form.destroy();
    });

    QUnit.test('Form and subview with _view_ref contexts', async function (assert) {
        assert.expect(3);

        serverData.models.product.fields.partner_type_ids = {string: "one2many field", type: "one2many", relation: "partner_type"},
        serverData.models.product.records = [{id: 1, name: 'Tromblon', partner_type_ids: [12,14]}];
        serverData.models.partner.records[0].productId = 1;

        serverData.views = {
            'product,false,form': '<form>'+
                                        '<field name="label"/>'+
                                        '<field name="partner_type_ids" context="{\'tree_view_ref\': \'some_other_tree_view\'}"/>' +
                                    '</form>',

            'partner_type,false,list': '<tree>'+
                                            '<field name="color"/>'+
                                        '</tree>',
            'product,false,search': '<search></search>',
            'partner,false,form': '<form>' +
                     '<field name="label"/>' +
                     '<field name="productId" context="{\'tree_view_ref\': \'some_tree_view\'}"/>' +
                  '</form>',
            'partner,false,search': '<search></search>',
        };

        const mockRPC = (route, args) => {
            if (args.method === 'load_views') {
                var context = args.kwargs.context;
                if (args.model === 'product') {
                    assert.strictEqual(context.tree_view_ref, 'some_tree_view',
                        'The correct _view_ref should have been sent to the server, first time');
                }
                if (args.model === 'partner_type') {
                    assert.strictEqual(context.baseModelName, 'product',
                        'The correct baseModelName should have been sent to the server for the subview');
                    assert.strictEqual(context.tree_view_ref, 'some_other_tree_view',
                        'The correct _view_ref should have been sent to the server for the subview');
                }
            }
            if (args.method === 'get_formview_action') {
                return Promise.resolve({
                    resId: 1,
                    type: 'ir.actions.actwindow',
                    target: 'current',
                    resModel: args.model,
                    context: args.kwargs.context,
                    'viewMode': 'form',
                    'views': [[false, 'form']],
                });
            }
        };

        const webClient = await createWebClient({serverData, mockRPC});
        await doAction(webClient, {
            resId: 1,
            type: 'ir.actions.actwindow',
            target: 'current',
            resModel: 'partner',
            'viewMode': 'form',
            'views': [[false, 'form']],
        });

        await testUtils.dom.click(webClient.el.querySelector('.o-field-widget[name="productId"]'));
    });

    QUnit.test('invisible fields are properly hidden', async function (assert) {
        assert.expect(4);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<group>' +
                            '<field name="foo" invisible="1"/>' +
                            '<field name="bar"/>' +
                        '</group>' +
                        '<field name="qux" invisible="1"/>' +
                        // x2many field without inline view: as it is always invisible, the view
                        // should not be fetched. we don't specify any view in this test, so if it
                        // ever tries to fetch it, it will crash, indicating that this is wrong.
                        '<field name="p" invisible="true"/>' +
                    '</sheet>' +
                '</form>',
            resId: 1,
        });

        assert.containsNone(form, 'label:contains(Foo)');
        assert.containsNone(form, '.o-field-widget[name=foo]');
        assert.containsNone(form, '.o-field-widget[name=qux]');
        assert.containsNone(form, '.o-field-widget[name=p]');

        form.destroy();
    });

    QUnit.test('invisible elements are properly hidden', async function (assert) {
        assert.expect(3);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<header invisible="1">' +
                        '<button name="myaction" string="coucou"/>' +
                    '</header>' +
                    '<sheet>' +
                        '<group>' +
                            '<group string="invgroup" invisible="1">' +
                                '<field name="foo"/>' +
                            '</group>' +
                        '</group>' +
                        '<notebook>' +
                            '<page string="visible"/>' +
                            '<page string="invisible" invisible="1"/>' +
                        '</notebook>' +
                    '</sheet>' +
                '</form>',
            resId: 1,
        });
        assert.containsOnce(form, '.o-form-statusbar.o-invisible-modifier button:contains(coucou)');
        assert.containsOnce(form, '.o-notebook li.o-invisible-modifier a:contains(invisible)');
        assert.containsOnce(form, 'table.o-inner-group.o-invisible-modifier td:contains(invgroup)');
        form.destroy();
    });

    QUnit.test('invisible attrs on fields are re-evaluated on field change', async function (assert) {
        assert.expect(3);

        // we set the value bar to simulate a falsy boolean value.
        this.data.partner.records[0].bar = false;

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet><group>' +
                        '<field name="productId"/>' +
                        '<field name="timmy" invisible="1"/>' +
                        '<field name="foo" class="foo_field" attrs=\'{"invisible": [["productId", "=", false]]}\'/>' +
                        '<field name="bar" class="bar_field" attrs=\'{"invisible":[("bar","=",false),("timmy","=",[])]}\'/>' +
                    '</group></sheet>' +
                '</form>',
            resId: 1,
            viewOptions: {
                mode:'edit'
            },
        });

        assert.hasClass(form.$('.foo_field'), 'o-invisible-modifier');
        assert.hasClass(form.$('.bar_field'), 'o-invisible-modifier');

        // set a value on the m2o
        await testUtils.fields.many2one.searchAndClickItem('productId');
        assert.doesNotHaveClass(form.$('.foo_field'), 'o-invisible-modifier');

        form.destroy();
    });

    QUnit.test('asynchronous fields can be set invisible', async function (assert) {
        assert.expect(1);
        var done = assert.async();

        var def = testUtils.makeTestPromise();

        // we choose this widget because it is a quite simple widget with a non
        // empty qweb template
        var PercentPieWidget = fieldRegistry.get('percentpie');
        fieldRegistry.add('asyncwidget', PercentPieWidget.extend({
            willStart: function () {
                return def;
            },
        }));

        createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet><group>' +
                        '<field name="foo"/>' +
                        '<field name="int_field" invisible="1" widget="asyncwidget"/>' +
                    '</group></sheet>' +
                '</form>',
            resId: 1,
        }).then(function (form) {
            assert.containsNone(form, '.o-field-widget[name="int_field"]');
            form.destroy();
            delete fieldRegistry.map.asyncwidget;
            done();
        });
        def.resolve();
    });

    QUnit.test('properly handle modifiers and attributes on notebook tags', async function (assert) {
        assert.expect(2);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<field name="productId"/>' +
                        '<notebook class="new_class" attrs=\'{"invisible": [["productId", "=", false]]}\'>' +
                            '<page string="Foo">' +
                                '<field name="foo"/>' +
                            '</page>' +
                        '</notebook>' +
                    '</sheet>' +
                '</form>',
            resId: 1,
        });

        assert.hasClass(form.$('.o-notebook'), 'o-invisible-modifier');
        assert.hasClass(form.$('.o-notebook'), 'new_class');
        form.destroy();
    });

    QUnit.test('empty notebook', async function (assert) {
        assert.expect(2);

        const form = await createView({
            arch: `
                <form string="Partners">
                    <sheet>
                        <notebook/>
                    </sheet>
                </form>`,
            data: this.data,
            model: 'partner',
            resId: 1,
            View: FormView,
        });

        // Does not change when switching state
        await testUtils.form.clickEdit(form);

        assert.containsNone(form, ':scope .o-notebook .nav');

        // Does not change when coming back to initial state
        await testUtils.form.clickSave(form);

        assert.containsNone(form, ':scope .o-notebook .nav');

        form.destroy();
    });

    QUnit.test('no visible page', async function (assert) {
        assert.expect(4);

        const form = await createView({
            arch: `
                <form string="Partners">
                    <sheet>
                        <notebook>
                            <page string="Foo" invisible="1">
                                <field name="foo"/>
                            </page>
                            <page string="Bar" invisible="1">
                                <field name="bar"/>
                            </page>
                        </notebook>
                    </sheet>
                </form>`,
            data: this.data,
            model: 'partner',
            resId: 1,
            View: FormView,
        });

        // Does not change when switching state
        await testUtils.form.clickEdit(form);

        for (const nav of form.el.querySelectorAll(':scope .o-notebook .nav')) {
            assert.containsNone(nav, '.nav-link.active');
            assert.containsN(nav, '.nav-item.o-invisible-modifier', 2);
        }

        // Does not change when coming back to initial state
        await testUtils.form.clickSave(form);

        for (const nav of form.el.querySelectorAll(':scope .o-notebook .nav')) {
            assert.containsNone(nav, '.nav-link.active');
            assert.containsN(nav, '.nav-item.o-invisible-modifier', 2);
        }

        form.destroy();
    });

    QUnit.test('notebook: pages with invisible modifiers', async function (assert) {
        assert.expect(10);

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `<form string="Partners">
                    <sheet>
                        <field name="bar"/>
                        <notebook>
                            <page string="First" attrs='{"invisible": [["bar", "=", false]]}'>
                                <field name="foo"/>
                            </page>
                            <page string="Second" attrs='{"invisible": [["bar", "=", true]]}'>
                                <field name="int_field"/>
                            </page>
                            <page string="Third">
                                <field name="qux"/>
                            </page>
                        </notebook>
                    </sheet>
                </form>`,
            resId: 1,
        });

        await testUtils.form.clickEdit(form);

        assert.containsOnce(form, ".o-notebook .nav .nav-link.active",
            "There should be only one active tab"
        );
        assert.isVisible(form.$(".o-notebook .nav .nav-item:first"));
        assert.hasClass(form.$(".o-notebook .nav .nav-link:first"), "active");

        assert.isNotVisible(form.$(".o-notebook .nav .nav-item:eq(1)"));
        assert.doesNotHaveClass(form.$(".o-notebook .nav .nav-link:eq(1)"), "active");

        await testUtils.dom.click(form.$(".o-field-widget[name=bar] input"));

        assert.containsOnce(form, ".o-notebook .nav .nav-link.active",
            "There should be only one active tab"
        );
        assert.isNotVisible(form.$(".o-notebook .nav .nav-item:first"));
        assert.doesNotHaveClass(form.$(".o-notebook .nav .nav-link:first"), "active");

        assert.isVisible(form.$(".o-notebook .nav .nav-item:eq(1)"));
        assert.hasClass(form.$(".o-notebook .nav .nav-link:eq(1)"), "active");

        form.destroy();
    });

    QUnit.test('invisible attrs on first notebook page', async function (assert) {
        assert.expect(6);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<field name="productId"/>' +
                        '<notebook>' +
                            '<page string="Foo" attrs=\'{"invisible": [["productId", "!=", false]]}\'>' +
                                '<field name="foo"/>' +
                            '</page>' +
                            '<page string="Bar">' +
                                '<field name="bar"/>' +
                            '</page>' +
                        '</notebook>' +
                    '</sheet>' +
                '</form>',
            resId: 1,
        });

        await testUtils.form.clickEdit(form);
        assert.hasClass(form.$('.o-notebook .nav .nav-link:first()'), 'active');
        assert.doesNotHaveClass(form.$('.o-notebook .nav .nav-item:first()'), 'o-invisible-modifier');

        // set a value on the m2o
        await testUtils.fields.many2one.searchAndClickItem('productId');
        assert.doesNotHaveClass(form.$('.o-notebook .nav .nav-link:first()'), 'active');
        assert.hasClass(form.$('.o-notebook .nav .nav-item:first()'), 'o-invisible-modifier');
        assert.hasClass(form.$('.o-notebook .nav .nav-link:nth(1)'), 'active');
        assert.hasClass(form.$('.o-notebook .tab-content .tab-pane:nth(1)'), 'active');
        form.destroy();
    });

    QUnit.test('invisible attrs on notebook page which has only one page', async function (assert) {
        assert.expect(4);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<field name="bar"/>' +
                        '<notebook>' +
                            '<page string="Foo" attrs=\'{"invisible": [["bar", "!=", false]]}\'>' +
                                '<field name="foo"/>' +
                            '</page>' +
                        '</notebook>' +
                    '</sheet>' +
                '</form>',
            resId: 1,
            viewOptions: {
                mode: 'edit',
            },
        });

        assert.notOk(form.$('.o-notebook .nav .nav-link:first()').hasClass('active'),
            'first tab should not be active');
        assert.ok(form.$('.o-notebook .nav .nav-item:first()').hasClass('o-invisible-modifier'),
            'first tab should be invisible');

        // enable checkbox
        await testUtils.dom.click(form.$('.o-field-boolean input'));
        assert.ok(form.$('.o-notebook .nav .nav-link:first()').hasClass('active'),
            'first tab should be active');
        assert.notOk(form.$('.o-notebook .nav .nav-item:first()').hasClass('o-invisible-modifier'),
            'first tab should be visible');

        form.destroy();
    });

    QUnit.test('first notebook page invisible', async function (assert) {
        assert.expect(2);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<field name="productId"/>' +
                        '<notebook>' +
                            '<page string="Foo" invisible="1">' +
                                '<field name="foo"/>' +
                            '</page>' +
                            '<page string="Bar">' +
                                '<field name="bar"/>' +
                            '</page>' +
                        '</notebook>' +
                    '</sheet>' +
                '</form>',
            resId: 1,
        });

        assert.notOk(form.$('.o-notebook .nav .nav-item:first()').is(':visible'),
            'first tab should be invisible');
        assert.hasClass(form.$('.o-notebook .nav .nav-link:nth(1)'), 'active');

        form.destroy();
    });

    QUnit.test('hide notebook element if all pages hidden', async function (assert) {
        assert.expect(4);

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `<form string="Partners">
                    <sheet>
                        <field name="bar"/>
                        <notebook class="new_class">
                            <page string="Foo" attrs="{'invisible': [['bar', '=', true]]}">
                                <field name="foo"/>
                            </page>
                        </notebook>
                    </sheet>
                </form>`,
        });

        assert.ok(form.$('.o-notebook .nav li:not(.o-invisible-modifier)').length,
            "there should be visible page");
        assert.notOk(form.$('.o-notebook .nav').hasClass('o-invisible-modifier'),
            'the notebook headers should not be hidden if one of the page is visible');

        await testUtils.dom.click(form.$('.o-field-boolean input'));
        assert.notOk(form.$('.o-notebook .nav li:not(.o-invisible-modifier)').length,
            "there should not be any visible page");
        assert.ok(form.$('.o-notebook .nav').hasClass('o-invisible-modifier'),
            'the notebook headers should be hidden if none of the page is visible');

        form.destroy();
    });

    QUnit.test('autofocus on second notebook page', async function (assert) {
        assert.expect(2);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<field name="productId"/>' +
                        '<notebook>' +
                            '<page string="Choucroute">' +
                                '<field name="foo"/>' +
                            '</page>' +
                            '<page string="Cassoulet" autofocus="autofocus">' +
                                '<field name="bar"/>' +
                            '</page>' +
                        '</notebook>' +
                    '</sheet>' +
                '</form>',
            resId: 1,
        });

        assert.doesNotHaveClass(form.$('.o-notebook .nav .nav-link:first()'), 'active');
        assert.hasClass(form.$('.o-notebook .nav .nav-link:nth(1)'), 'active');

        form.destroy();
    });

    QUnit.test("notebook page is changing when an anchor is clicked from another page", async (assert) => {
        assert.expect(6);

        // This should be removed as soon as the view is moved to owl
        const wowlEnv = await makeTestEnv();
        const legacyEnv = makeTestEnvironment({ bus: core.bus });
        mapLegacyEnvToWowlEnv(legacyEnv, wowlEnv);

        const scrollableParent = document.createElement("div");
        scrollableParent.style.overflow = "auto";
        const target = getFixture();
        target.append(scrollableParent);

        var form = await createView({
            View: FormView,
            model: "partner",
            data: {
                partner: {
                    fields: {},
                    records: [
                        {
                            id: 1,
                        },
                    ],
                },
            },
            arch: `<form string="Partners">
                        <sheet>
                            <notebook>
                                <page string="Non scrollable page">
                                    <div id="anchor1">No scrollbar!</div>
                                    <a href="#anchor2" class="link2">TO ANCHOR 2</a> 
                                </page>
                                <page string="Other scrollable page">
                                    <p style="font-size: large">
                                        Aliquam convallis sollicitudin purus. Praesent aliquam, enim at fermentum mollis,
                                        ligula massa adipiscing nisl, ac euismod nibh nisl eu lectus. Fusce vulputate sem
                                        at sapien. Vivamus leo. Aliquam euismod libero eu enim. Nulla nec felis sed leo
                                        placerat imperdiet. Aenean suscipit nulla in justo. Suspendisse cursus rutrum
                                        augue.
                                    </p>
                                    <p style="font-size: large">
                                        Aliquam convallis sollicitudin purus. Praesent aliquam, enim at fermentum mollis,
                                        ligula massa adipiscing nisl, ac euismod nibh nisl eu lectus. Fusce vulputate sem
                                        at sapien. Vivamus leo. Aliquam euismod libero eu enim. Nulla nec felis sed leo
                                        placerat imperdiet. Aenean suscipit nulla in justo. Suspendisse cursus rutrum
                                        augue.
                                    </p>
                                    <h2 id="anchor2">There is a scroll bar</h2>
                                    <a href="#anchor1" class="link1">TO ANCHOR 1</a>
                                    <p style="font-size: large">
                                        Aliquam convallis sollicitudin purus. Praesent aliquam, enim at fermentum mollis,
                                        ligula massa adipiscing nisl, ac euismod nibh nisl eu lectus. Fusce vulputate sem
                                        at sapien. Vivamus leo. Aliquam euismod libero eu enim. Nulla nec felis sed leo
                                        placerat imperdiet. Aenean suscipit nulla in justo. Suspendisse cursus rutrum
                                        augue.
                                    </p>   
                                </page>
                            </notebook>
                        </sheet>
                </form>`,
            resId: 1,
        });
        scrollableParent.append(form.el);

        // We set the height of the parent to the height of the second pane
        // We are then sure there will be no scrollable on this pane but a
        // only for the first pane
        scrollableParent.style.maxHeight =
            scrollableParent.querySelector(".o-action").getBoundingClientRect().height + "px";

        // The element must be contained in the scrollable parent (top and bottom)
        const isVisible = (el) => {
            return (
                el.getBoundingClientRect().bottom <= scrollableParent.getBoundingClientRect().bottom &&
                el.getBoundingClientRect().top >= scrollableParent.getBoundingClientRect().top
            );
        };

        assert.ok(
            scrollableParent
                .querySelector(".tab-pane.active")
                .contains(scrollableParent.querySelector("#anchor1")),
            "the first pane is visible"
        );
        assert.ok(
            !isVisible(scrollableParent.querySelector("#anchor2")),
            "the second anchor is not visible"
        );
        scrollableParent.querySelector(".link2").click();
        assert.ok(
            scrollableParent
                .querySelector(".tab-pane.active")
                .contains(scrollableParent.querySelector("#anchor2")),
            "the second pane is visible"
        );
        assert.ok(
            isVisible(scrollableParent.querySelector("#anchor2")),
            "the second anchor is visible"
        );
        scrollableParent.querySelector(".link1").click();
        assert.ok(
            scrollableParent
                .querySelector(".tab-pane.active")
                .contains(scrollableParent.querySelector("#anchor1")),
            "the first pane is visible"
        );
        assert.ok(isVisible(scrollableParent.querySelector("#anchor1")), "the first anchor is visible");
        form.destroy();
    });

    QUnit.test('invisible attrs on group are re-evaluated on field change', async function (assert) {
        assert.expect(2);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<field name="bar"/>' +
                        '<group attrs=\'{"invisible": [["bar", "!=", true]]}\'>' +
                            '<group>' +
                                '<field name="foo"/>' +
                            '</group>' +
                        '</group>' +
                    '</sheet>' +
                '</form>',
            resId: 1,
            viewOptions: {
                mode: 'edit'
            },
        });

        assert.containsOnce(form, 'div.o-group:visible');
        await testUtils.dom.click('.o-field-boolean input', form);
        assert.containsOnce(form, 'div.o-group:hidden');
        form.destroy();
    });

    QUnit.test('invisible attrs with zero value in domain and unset value in data', async function (assert) {
        assert.expect(1);

        this.data.partner.fields.int_field.type = 'monetary';

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<field name="foo"/>' +
                        '<group attrs=\'{"invisible": [["int_field", "=", 0.0]]}\'>' +
                            '<div class="hello">this should be invisible</div>' +
                            '<field name="int_field"/>' +
                        '</group>' +
                    '</sheet>' +
                '</form>',
        });

        assert.isNotVisible(form.$('div.hello'));
        form.destroy();
    });

    QUnit.test('reset local state when switching to another view', async function (assert) {
        assert.expect(3);

        serverData.views = {
            'partner,false,form': `<form>
                    <sheet>
                        <field name="productId"/>
                        <notebook>
                            <page string="Foo">
                                <field name="foo"/>
                            </page>
                            <page string="Bar">
                                <field name="bar"/>
                            </page>
                        </notebook>
                    </sheet>
                </form>`,
            'partner,false,list': '<tree><field name="foo"/></tree>',
            'partner,false,search': '<search></search>',
        };

        serverData.actions = {
            1: {
                id: 1,
                name: 'Partner',
                resModel: 'partner',
                type: 'ir.actions.actwindow',
                views: [[false, 'list'], [false, 'form']],
            }
        };

        const webClient = await createWebClient({ serverData });
        await doAction(webClient, 1);

        await testUtils.dom.click(webClient.el.querySelector('.o-list-button-add'));
        await legacyExtraNextTick();
        assert.containsOnce(webClient, '.o-form-view');

        // click on second page tab
        await testUtils.dom.click($(webClient.el).find('.o-notebook .nav-link:eq(1)'));

        await testUtils.dom.click('.o-control-panel .o-form-button_cancel');
        await legacyExtraNextTick();
        assert.containsNone(webClient, '.o-form-view');

        await testUtils.dom.click(webClient.el.querySelector('.o-list-button-add'));
        await legacyExtraNextTick();
        // check notebook active page is 0th page
        assert.hasClass($(webClient.el).find('.o-notebook .nav-link:eq(0)'), 'active');

    });

    QUnit.test('rendering stat buttons', async function (assert) {
        assert.expect(3);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch:'<form string="Partners">' +
                    '<sheet>' +
                        '<div name="buttonBox">' +
                            '<button class="oe-stat-button">' +
                                '<field name="int_field"/>' +
                            '</button>' +
                            '<button class="oe-stat-button" attrs=\'{"invisible": [["bar", "=", true]]}\'>' +
                                '<field name="bar"/>' +
                            '</button>' +
                        '</div>' +
                        '<group>' +
                            '<field name="foo"/>' +
                        '</group>' +
                    '</sheet>' +
                '</form>',
            resId: 2,
        });

        assert.containsN(form, 'button.oe-stat-button', 2);
        assert.containsOnce(form, 'button.oe-stat-button.o-invisible-modifier');

        var count = 0;
        await testUtils.mock.intercept(form, "execute_action", function () {
            count++;
        });
        await testUtils.dom.click('.oe-stat-button');
        assert.strictEqual(count, 1, "should have triggered a execute action");
        form.destroy();
    });

    QUnit.test('disabled stat buttons stays disabled', async function (assert) {
        assert.expect(4);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch:'<form string="Partners">' +
                    '<sheet>' +
                        '<div name="buttonBox" class="oe-button-box">' +
                            '<button class="oe-stat-button" disabled="disabled">' +
                                '<field name="int_field"/>' +
                            '</button>' +
                            '<button class="oe-stat-button" type="action" name="some_action">' +
                                '<field name="bar"/>' +
                            '</button>' +
                        '</div>' +
                        '<group>' +
                            '<button type="action" name="action_to_perform">Run an action</button>' +
                        '</group>' +
                    '</sheet>' +
                '</form>',
            resId: 2,
        });

        var count = 0;
        await testUtils.mock.intercept(form, "execute_action", function (event) {
            if (event.data.actionData.name == "action_to_perform") {
                assert.containsN(form, 'button.oe-stat-button[disabled]', 2, "While performing the action, both buttons should be disabled.");
                event.data.onSuccess();
            }
        });

        assert.containsN(form, 'button.oe-stat-button', 2);
        assert.containsN(form, 'button.oe-stat-button[disabled]', 1);
        await testUtils.dom.click('button[name=action_to_perform]');
        assert.containsN(form, 'button.oe-stat-button[disabled]', 1, "After performing the action, only one button should be disabled.");
        
        form.destroy();
    });

    QUnit.test('label uses the string attribute', async function (assert) {
        assert.expect(1);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch:'<form string="Partners">' +
                    '<sheet>' +
                        '<group>' +
                            '<label for="bar" string="customstring"/>' +
                            '<div><field name="bar"/></div>' +
                        '</group>' +
                    '</sheet>' +
                '</form>',
            resId: 2,
        });

        assert.containsOnce(form, 'label.o-form-label:contains(customstring)');
        form.destroy();
    });

    QUnit.test('input ids for multiple occurrences of fields in form view', async function (assert) {
        // A same field can occur several times in the view, but its id must be
        // unique by occurrence, otherwise there is a warning in the console (in
        // edit mode) as we get several inputs with the same "id" attribute, and
        // several labels the same "for" attribute.
        assert.expect(2);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `
                <form>
                    <group>
                        <field name="foo"/>
                        <label for="qux"/>
                        <div><field name="qux"/></div>
                    </group>
                    <group>
                        <field name="foo"/>
                        <label for="qux2"/>
                        <div><field name="qux" id="qux2"/></div>
                    </group>
                </form>`,
        });

        const fieldIdAttrs = [...form.$('.o-field-widget')].map(n => n.getAttribute('id'));
        const labelForAttrs = [...form.$('.o-form-label')].map(n => n.getAttribute('for'));

        assert.strictEqual([...new Set(fieldIdAttrs)].length, 4,
            "should have generated a unique id for each field occurrence");
        assert.deepEqual(fieldIdAttrs, labelForAttrs,
            "the for attribute of labels must coincide with field ids");

        form.destroy();
    });

    QUnit.test('input ids for multiple occurrences of fields in sub form view (inline)', async function (assert) {
        // A same field can occur several times in the view, but its id must be
        // unique by occurrence, otherwise there is a warning in the console (in
        // edit mode) as we get several inputs with the same "id" attribute, and
        // several labels the same "for" attribute.
        assert.expect(3);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `
                <form>
                    <field name="p">
                        <tree><field name="foo"/></tree>
                        <form>
                            <group>
                                <field name="foo"/>
                                <label for="qux"/>
                                <div><field name="qux"/></div>
                            </group>
                            <group>
                                <field name="foo"/>
                                <label for="qux2"/>
                                <div><field name="qux" id="qux2"/></div>
                            </group>
                        </form>
                    </field>
                </form>`,
        });

        await testUtils.dom.click(form.$('.o-field-x2many-list-row-add a'));

        assert.containsOnce(document.body, '.modal .o-form-view');

        const fieldIdAttrs = [...$('.modal .o-form-view .o-field-widget')].map(n => n.getAttribute('id'));
        const labelForAttrs = [...$('.modal .o-form-view .o-form-label')].map(n => n.getAttribute('for'));

        assert.strictEqual([...new Set(fieldIdAttrs)].length, 4,
            "should have generated a unique id for each field occurrence");
        assert.deepEqual(fieldIdAttrs, labelForAttrs,
            "the for attribute of labels must coincide with field ids");

        form.destroy();
    });

    QUnit.test('input ids for multiple occurrences of fields in sub form view (not inline)', async function (assert) {
        // A same field can occur several times in the view, but its id must be
        // unique by occurrence, otherwise there is a warning in the console (in
        // edit mode) as we get several inputs with the same "id" attribute, and
        // several labels the same "for" attribute.
        assert.expect(3);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form><field name="p"/></form>',
            archs: {
                'partner,false,list': '<tree><field name="foo"/></tree>',
                'partner,false,form': `
                    <form>
                        <group>
                            <field name="foo"/>
                            <label for="qux"/>
                            <div><field name="qux"/></div>
                        </group>
                        <group>
                            <field name="foo"/>
                            <label for="qux2"/>
                            <div><field name="qux" id="qux2"/></div>
                        </group>
                    </form>`
            },
        });

        await testUtils.dom.click(form.$('.o-field-x2many-list-row-add a'));

        assert.containsOnce(document.body, '.modal .o-form-view');

        const fieldIdAttrs = [...$('.modal .o-form-view .o-field-widget')].map(n => n.getAttribute('id'));
        const labelForAttrs = [...$('.modal .o-form-view .o-form-label')].map(n => n.getAttribute('for'));

        assert.strictEqual([...new Set(fieldIdAttrs)].length, 4,
            "should have generated a unique id for each field occurrence");
        assert.deepEqual(fieldIdAttrs, labelForAttrs,
            "the for attribute of labels must coincide with field ids");

        form.destroy();
    });

    QUnit.test('two occurrences of invalid field in form view', async function (assert) {
        assert.expect(2);

        this.data.partner.fields.trululu.required = true;

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `
                <form>
                    <group>
                        <field name="trululu"/>
                        <field name="trululu"/>
                    </group>
                </form>`,
        });

        await testUtils.form.clickSave(form);

        assert.containsN(form, '.o-form-label.o-field-invalid', 2);
        assert.containsN(form, '.o-field-many2one.o-field-invalid', 2);

        form.destroy();
    });

    QUnit.test('tooltips on multiple occurrences of fields and labels', async function (assert) {
        assert.expect(4);

        const initialDebugMode = verp.debug;
        verp.debug = false;

        this.data.partner.fields.foo.help = 'foo tooltip';
        this.data.partner.fields.bar.help = 'bar tooltip';

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `
                <form>
                    <group>
                        <field name="foo"/>
                        <label for="bar"/>
                        <div><field name="bar"/></div>
                    </group>
                    <group>
                        <field name="foo"/>
                        <label for="bar2"/>
                        <div><field name="bar" id="bar2"/></div>
                    </group>
                </form>`,
        });

        const $fooLabel1 = form.$('.o-form-label:nth(0)');
        $fooLabel1.tooltip('show', false);
        $fooLabel1.trigger($.Event('mouseenter'));
        assert.strictEqual($('.tooltip .oe-tooltip-help').text().trim(), "foo tooltip");
        $fooLabel1.trigger($.Event('mouseleave'));

        const $fooLabel2 = form.$('.o-form-label:nth(2)');
        $fooLabel2.tooltip('show', false);
        $fooLabel2.trigger($.Event('mouseenter'));
        assert.strictEqual($('.tooltip .oe-tooltip-help').text().trim(), "foo tooltip");
        $fooLabel2.trigger($.Event('mouseleave'));

        const $barLabel1 = form.$('.o-form-label:nth(1)');
        $barLabel1.tooltip('show', false);
        $barLabel1.trigger($.Event('mouseenter'));
        assert.strictEqual($('.tooltip .oe-tooltip-help').text().trim(), "bar tooltip");
        $barLabel1.trigger($.Event('mouseleave'));

        const $barLabel2 = form.$('.o-form-label:nth(3)');
        $barLabel2.tooltip('show', false);
        $barLabel2.trigger($.Event('mouseenter'));
        assert.strictEqual($('.tooltip .oe-tooltip-help').text().trim(), "bar tooltip");
        $barLabel2.trigger($.Event('mouseleave'));

        verp.debug = initialDebugMode;
        form.destroy();
    });

    QUnit.test('readonly attrs on fields are re-evaluated on field change', async function (assert) {
        assert.expect(4);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<group>' +
                            '<field name="foo" attrs="{\'readonly\': [[\'bar\', \'=\', true]]}"/>' +
                            '<field name="bar"/>' +
                        '</group>' +
                    '</sheet>' +
                '</form>',
            resId: 1,
        });
        await testUtils.form.clickEdit(form);

        assert.containsOnce(form, 'span[name="foo"]',
            "the foo field widget should be readonly");
        await testUtils.dom.click(form.$('.o-field-boolean input'));
        assert.containsOnce(form, 'input[name="foo"]',
            "the foo field widget should have been rerendered to now be editable");
        await testUtils.dom.click(form.$('.o-field-boolean input'));
        assert.containsOnce(form, 'span[name="foo"]',
            "the foo field widget should have been rerendered to now be readonly again");
        await testUtils.dom.click(form.$('.o-field-boolean input'));
        assert.containsOnce(form, 'input[name="foo"]',
            "the foo field widget should have been rerendered to now be editable again");

        form.destroy();
    });

    QUnit.test('readonly attrs on lines are re-evaluated on field change 2', async function (assert) {
        assert.expect(4);

        this.data.partner.records[0].productIds = [37];
        this.data.partner.records[0].trululu = false;
        this.data.partner.onchanges = {
            trululu(record) {
                // when trululu changes, push another record in productIds.
                // only push a second record once.
                if (record.productIds.map(command => command[1]).includes(41)) {
                    return;
                }
                // copy the list to force it as different from the original
                record.productIds = record.productIds.slice();
                record.productIds.push([4,41,false]);
            }
        };

        this.data.product.records[0].name = 'test';
        // This one is necessary to have a valid, rendered widget
        this.data.product.fields.int_field = { type:"integer", string: "intField" };

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `
            <form>
                <field name="trululu"/>
                <field name="productIds" attrs="{'readonly': [['trululu', '=', false]]}">
                    <tree editable="top"><field name="int_field" widget="handle" /><field name="label"/></tree>
                </field>
            </form>
            `,
            resId: 1,
            viewOptions: {
                mode: 'edit',
            },
        });

        for (let value of [true, false, true, false]) {
            if (value) {
                await testUtils.fields.many2one.clickOpenDropdown('trululu')
                await testUtils.fields.many2one.clickHighlightedItem('trululu')
                assert.notOk($('.o-field-one2many[name="productIds"]').hasClass("o-readonly-modifier"), 'lines should not be readonly')
            } else {
                await testUtils.fields.editAndTrigger(form.$('.o-field-many2one[name="trululu"] input'), '', ['keyup'])
                assert.ok($('.o-field-one2many[name="productIds"]').hasClass("o-readonly-modifier"), 'lines should be readonly')
            }
        }

        form.destroy();
    });

    QUnit.test('empty fields have o-form-empty class in readonly mode', async function (assert) {
        assert.expect(8);

        this.data.partner.fields.foo.default = false; // no default value for this test
        this.data.partner.records[1].foo = false;  // 1 is record with id=2
        this.data.partner.records[1].trululu = false;  // 1 is record with id=2
        this.data.partner.fields.int_field.readonly = true;
        this.data.partner.onchanges.foo = function (obj) {
            if (obj.foo === "hello") {
                obj.int_field = false;
            }
        };

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<group>' +
                            '<field name="foo"/>' +
                            '<field name="trululu" attrs="{\'readonly\': [[\'foo\', \'=\', false]]}"/>' +
                            '<field name="int_field"/>' +
                        '</group>' +
                    '</sheet>' +
                '</form>',
            resId: 2,
        });

        assert.containsN(form, '.o-field-widget.o-field-empty', 2,
            "should have 2 empty fields with correct class");
        assert.containsN(form, '.o-form-label_empty', 2,
            "should have 2 muted labels (for the empty fieds) in readonly");

        await testUtils.form.clickEdit(form);

        assert.containsOnce(form, '.o-field-empty',
            "in edit mode, only empty readonly fields should have the o-field-empty class");
        assert.containsOnce(form, '.o-form-label_empty',
            "in edit mode, only labels associated to empty readonly fields should have the o-form-label_empty class");

        await testUtils.fields.editInput(form.$('input[name=foo]'), 'test');

        assert.containsNone(form, '.o-field-empty',
            "after readonly modifier change, the o-field-empty class should have been removed");
        assert.containsNone(form, '.o-form-label_empty',
            "after readonly modifier change, the o-form-label_empty class should have been removed");

        await testUtils.fields.editInput(form.$('input[name=foo]'), 'hello');

        assert.containsOnce(form, '.o-field-empty',
            "after value changed to false for a readonly field, the o-field-empty class should have been added");
        assert.containsOnce(form, '.o-form-label_empty',
            "after value changed to false for a readonly field, the o-form-label_empty class should have been added");

        form.destroy();
    });

    QUnit.test('empty fields\' labels still get the empty class after widget rerender', async function (assert) {
        assert.expect(6);

        this.data.partner.fields.foo.default = false; // no default value for this test
        this.data.partner.records[1].foo = false;  // 1 is record with id=2
        this.data.partner.records[1].displayName = false;  // 1 is record with id=2

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form>' +
                    '<group>' +
                        '<field name="foo"/>' +
                        '<field name="displayName" attrs="{\'readonly\': [[\'foo\', \'=\', \'readonly\']]}"/>' +
                    '</group>' +
                '</form>',
            resId: 2,
        });

        assert.containsN(form, '.o-field-widget.o-field-empty', 2);
        assert.containsN(form, '.o-form-label_empty', 2,
            "should have 1 muted label (for the empty fied) in readonly");

        await testUtils.form.clickEdit(form);

        assert.containsNone(form, '.o-field-empty',
            "in edit mode, only empty readonly fields should have the o-field-empty class");
        assert.containsNone(form, '.o-form-label_empty',
            "in edit mode, only labels associated to empty readonly fields should have the o-form-label_empty class");

        await testUtils.fields.editInput(form.$('input[name=foo]'), 'readonly');
        await testUtils.fields.editInput(form.$('input[name=foo]'), 'edit');
        await testUtils.fields.editInput(form.$('input[name=displayName]'), 'some name');
        await testUtils.fields.editInput(form.$('input[name=foo]'), 'readonly');

        assert.containsNone(form, '.o-field-empty',
            "there still should not be any empty class on fields as the readonly one is now set");
        assert.containsNone(form, '.o-form-label_empty',
            "there still should not be any empty class on labels as the associated readonly field is now set");

        form.destroy();
    });

    QUnit.test('empty inner readonly fields don\'t have o-form-empty class in "create" mode', async function (assert) {
        assert.expect(2);

        this.data.partner.fields.productId.readonly = true;
        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<group>' +
                            '<group>' +
                                '<field name="productId"/>' +
                            '</group>' +
                        '</group>' +
                    '</sheet>' +
                '</form>',
        });
        assert.containsNone(form, '.o-form-label_empty',
                "no empty class on label");
        assert.containsNone(form, '.o-field-empty',
                "no empty class on field");
        form.destroy();
    });

    QUnit.test('label tag added for fields have o-form-empty class in readonly mode if field is empty', async function (assert) {
        assert.expect(8);

        this.data.partner.fields.foo.default = false; // no default value for this test
        this.data.partner.records[1].foo = false;  // 1 is record with id=2
        this.data.partner.records[1].trululu = false;  // 1 is record with id=2
        this.data.partner.fields.int_field.readonly = true;
        this.data.partner.onchanges.foo = function (obj) {
            if (obj.foo === "hello") {
                obj.int_field = false;
            }
        };

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `<form string="Partners">
                    <sheet>
                        <label for="foo" string="Foo"/>
                        <field name="foo"/>
                        <label for="trululu" string="Trululu" attrs="{'readonly': [['foo', '=', false]]}"/>
                        <field name="trululu" attrs="{'readonly': [['foo', '=', false]]}"/>
                        <label for="int_field" string="IntField" attrs="{'readonly': [['int_field', '=', false]]}"/>
                        <field name="int_field"/>
                    </sheet>
                </form>`,
            resId: 2,
        });

        assert.containsN(form, '.o-field-widget.o-field-empty', 2,
            "should have 2 empty fields with correct class");
        assert.containsN(form, '.o-form-label_empty', 2,
            "should have 2 muted labels (for the empty fieds) in readonly");

        await testUtils.form.clickEdit(form);

        assert.containsOnce(form, '.o-field-empty',
            "in edit mode, only empty readonly fields should have the o-field-empty class");
        assert.containsOnce(form, '.o-form-label_empty',
            "in edit mode, only labels associated to empty readonly fields should have the o-form-label_empty class");

        await testUtils.fields.editInput(form.$('input[name=foo]'), 'test');

        assert.containsNone(form, '.o-field-empty',
            "after readonly modifier change, the o-field-empty class should have been removed");
        assert.containsNone(form, '.o-form-label_empty',
            "after readonly modifier change, the o-form-label_empty class should have been removed");

        await testUtils.fields.editInput(form.$('input[name=foo]'), 'hello');

        assert.containsOnce(form, '.o-field-empty',
            "after value changed to false for a readonly field, the o-field-empty class should have been added");
        assert.containsOnce(form, '.o-form-label_empty',
            "after value changed to false for a readonly field, the o-form-label_empty class should have been added");

        form.destroy();
    });

    QUnit.test('form view can switch to edit mode', async function (assert) {
        assert.expect(9);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form>' +
                    '<field name="foo"/>' +
                '</form>',
            resId: 1,
        });

        assert.strictEqual(form.mode, 'readonly', 'form view should be in readonly mode');
        assert.hasClass(form.$('.o-form-view'), 'o-form-readonly');
        assert.isVisible(form.$buttons.find('.o-form-buttons-view'));
        assert.isNotVisible(form.$buttons.find('.o-form-buttons_edit'));

        await testUtils.form.clickEdit(form);

        assert.strictEqual(form.mode, 'edit', 'form view should be in edit mode');
        assert.hasClass(form.$('.o-form-view'), 'o-form-editable');
        assert.doesNotHaveClass(form.$('.o-form-view'), 'o-form-readonly');
        assert.isNotVisible(form.$buttons.find('.o-form-buttons-view'));
        assert.isVisible(form.$buttons.find('.o-form-buttons_edit'));
        form.destroy();
    });

    QUnit.test('required attrs on fields are re-evaluated on field change', async function (assert) {
        assert.expect(3);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<group>' +
                            '<field name="foo" attrs="{\'required\': [[\'bar\', \'=\', true]]}"/>' +
                            '<field name="bar"/>' +
                        '</group>' +
                    '</sheet>' +
                '</form>',
            resId: 1,
        });
        await testUtils.form.clickEdit(form);

        assert.containsOnce(form, 'input[name="foo"].o-required-modifier',
            "the foo field widget should be required");
        await testUtils.dom.click('.o-field-boolean input');
        assert.containsOnce(form, 'input[name="foo"]:not(.o-required-modifier)',
            "the foo field widget should now have been marked as non-required");
        await testUtils.dom.click('.o-field-boolean input');
        assert.containsOnce(form, 'input[name="foo"].o-required-modifier',
            "the foo field widget should now have been marked as required again");

        form.destroy();
    });

    QUnit.test('required fields should have o-required-modifier in readonly mode', async function (assert) {
        assert.expect(2);

        this.data.partner.fields.foo.required = true;
        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<group>' +
                            '<field name="foo"/>' +
                        '</group>' +
                    '</sheet>' +
                '</form>',
            resId: 1,
        });

        assert.containsOnce(form, 'span.o-required-modifier');

        await testUtils.form.clickEdit(form);
        assert.containsOnce(form, 'input.o-required-modifier',
                    "in edit mode, should have 1 input with o-required-modifier");
        form.destroy();
    });

    QUnit.test('required float fields works as expected', async function (assert) {
        assert.expect(10);

        this.data.partner.fields.qux.required = true;
        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<group>' +
                            '<field name="qux"/>' +
                        '</group>' +
                    '</sheet>' +
                '</form>',
            mockRPC: function (route, args) {
                assert.step(args.method);
                return this._super.apply(this, arguments);
            },
        });

        assert.hasClass(form.$('input[name="qux"]'), 'o-required-modifier');
        assert.strictEqual(form.$('input[name="qux"]').val(), "0.0",
            "qux input is 0 by default (float field)");

        await testUtils.form.clickSave(form);

        assert.containsNone(form.$('input[name="qux"]'), "should have switched to readonly");

        await testUtils.form.clickEdit(form);

        await testUtils.fields.editInput(form.$('input[name=qux]'), '1');

        await testUtils.form.clickSave(form);

        await testUtils.form.clickEdit(form);

                assert.strictEqual(form.$('input[name="qux"]').val(), "1.0",
            "qux input is properly formatted");

        assert.verifySteps(['onchange', 'create', 'read', 'write', 'read']);
        form.destroy();
    });

    QUnit.test('separators', async function (assert) {
        assert.expect(1);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<group>' +
                            '<separator string="Geolocation"/>' +
                            '<field name="foo"/>' +
                        '</group>' +
                    '</sheet>' +
                '</form>',
            resId: 1,
        });

        assert.containsOnce(form, 'div.o-horizontal-separator');
        form.destroy();
    });

    QUnit.test('invisible attrs on separators', async function (assert) {
        assert.expect(1);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<group>' +
                            '<separator string="Geolocation" attrs=\'{"invisible": [["bar", "=", true]]}\'/>'+
                            '<field name="bar"/>' +
                        '</group>' +
                    '</sheet>' +
                '</form>',
            resId: 1,
        });

        assert.hasClass(form.$('div.o-horizontal-separator'), 'o-invisible-modifier');

        form.destroy();
    });

    QUnit.test('buttons in form view', async function (assert) {
        assert.expect(8);

        var rpcCount = 0;

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<field name="state" invisible="1"/>' +
                    '<header>' +
                        '<button name="post" class="p" string="Confirm" type="object"/>' +
                        '<button name="some_method" class="s" string="Do it" type="object"/>' +
                        '<button name="some_other_method" states="ab,ef" string="Do not" type="object"/>' +
                    '</header>' +
                    '<sheet>' +
                        '<group>' +
                            '<button string="Geolocate" name="geo_localize" icon="fa-check" type="object"/>' +
                        '</group>' +
                    '</sheet>' +
                '</form>',
            resId: 2,
            mockRPC: function () {
                rpcCount++;
                return this._super.apply(this, arguments);
            },
        });
        assert.containsOnce(form, 'button.btn i.fa.fa-check');
        assert.containsN(form, '.o-form-statusbar button', 3);
        assert.containsOnce(form, 'button.p[name="post"]:contains(Confirm)');
        assert.containsN(form, '.o-form-statusbar button:visible', 2);

        await testUtils.mock.intercept(form, 'execute_action', function (ev) {
            assert.strictEqual(ev.data.actionData.name, 'post',
                "should trigger execute_action with correct method name");
            assert.deepEqual(ev.data.env.currentId, 2, "should have correct id in ev data");
            ev.data.onSuccess();
            ev.data.on_closed();
        });
        rpcCount = 0;
        await testUtils.dom.click('.o-form-statusbar button.p', form);

        assert.strictEqual(rpcCount, 1, "should have done 1 rpcs to reload");

        await testUtils.mock.intercept(form, 'execute_action', function (ev) {
            ev.data.onFail();
        });
        await testUtils.dom.click('.o-form-statusbar button.s', form);

        assert.strictEqual(rpcCount, 1,
            "should have done 1 rpc, because we do not reload anymore if the server action fails");

        form.destroy();
    });

    QUnit.test('buttons classes in form view', async function (assert) {
        assert.expect(16);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch:
                '<form string="Partners">' +
                    '<header>' +
                        '<button name="0"/>' +
                        '<button name="1" class="btn-primary"/>' +
                        '<button name="2" class="oe-highlight"/>' +
                        '<button name="3" class="btn-secondary"/>' +
                        '<button name="4" class="btn-link"/>' +
                        '<button name="5" class="oe_link"/>' +
                        '<button name="6" class="btn-success"/>' +
                        '<button name="7" class="o_this_is_a_button"/>' +
                    '</header>' +
                    '<sheet>' +
                        '<button name="8"/>' +
                        '<button name="9" class="btn-primary"/>' +
                        '<button name="10" class="oe-highlight"/>' +
                        '<button name="11" class="btn-secondary"/>' +
                        '<button name="12" class="btn-link"/>' +
                        '<button name="13" class="oe_link"/>' +
                        '<button name="14" class="btn-success"/>' +
                        '<button name="15" class="o_this_is_a_button"/>' +
                    '</sheet>' +
                '</form>',
            resId: 2,
        });

        assert.hasAttrValue(form.$('button[name="0"]'), 'class', 'btn btn-secondary');
        assert.hasAttrValue(form.$('button[name="1"]'), 'class', 'btn btn-primary');
        assert.hasAttrValue(form.$('button[name="2"]'), 'class', 'btn btn-primary');
        assert.hasAttrValue(form.$('button[name="3"]'), 'class', 'btn btn-secondary');
        assert.hasAttrValue(form.$('button[name="4"]'), 'class', 'btn btn-link');
        assert.hasAttrValue(form.$('button[name="5"]'), 'class', 'btn btn-link');
        assert.hasAttrValue(form.$('button[name="6"]'), 'class', 'btn btn-success');
        assert.hasAttrValue(form.$('button[name="7"]'), 'class', 'btn o_this_is_a_button btn-secondary');
        assert.hasAttrValue(form.$('button[name="8"]'), 'class', 'btn btn-secondary');
        assert.hasAttrValue(form.$('button[name="9"]'), 'class', 'btn btn-primary');
        assert.hasAttrValue(form.$('button[name="10"]'), 'class', 'btn btn-primary');
        assert.hasAttrValue(form.$('button[name="11"]'), 'class', 'btn btn-secondary');
        assert.hasAttrValue(form.$('button[name="12"]'), 'class', 'btn btn-link');
        assert.hasAttrValue(form.$('button[name="13"]'), 'class', 'btn btn-link');
        assert.hasAttrValue(form.$('button[name="14"]'), 'class', 'btn btn-success');
        assert.hasAttrValue(form.$('button[name="15"]'), 'class', 'btn o_this_is_a_button');

        form.destroy();
    });

    QUnit.test('button in form view and long willStart', async function (assert) {
        assert.expect(6);

        var rpcCount = 0;

        var FieldChar = fieldRegistry.get('char');
        fieldRegistry.add('asyncwidget', FieldChar.extend({
            willStart: function () {
                assert.step('load '+rpcCount);
                if (rpcCount === 2) {
                    return new Promise(() => {});
                }
                return Promise.resolve();
            },
        }));

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<field name="state" invisible="1"/>' +
                    '<header>' +
                        '<button name="post" class="p" string="Confirm" type="object"/>' +
                    '</header>' +
                    '<sheet>' +
                        '<group>' +
                            '<field name="foo" widget="asyncwidget"/>' +
                        '</group>' +
                    '</sheet>' +
                '</form>',
            resId: 2,
            mockRPC: function () {
                rpcCount++;
                return this._super.apply(this, arguments);
            },
        });
        assert.verifySteps(['load 1']);

        testUtils.mock.intercept(form, 'execute_action', function (ev) {
            ev.data.onSuccess();
            ev.data.on_closed();
        });

        await testUtils.dom.click('.o-form-statusbar button.p', form);
        assert.verifySteps(['load 2']);

        await testUtils.dom.click('.o-form-statusbar button.p', form);
        assert.verifySteps(['load 3']);

        form.destroy();
    });

    QUnit.test('buttons in form view, new record', async function (assert) {
        // this simulates a situation similar to the settings forms.
        assert.expect(7);

        var resID;

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<header>' +
                        '<button name="post" class="p" string="Confirm" type="object"/>' +
                        '<button name="some_method" class="s" string="Do it" type="object"/>' +
                    '</header>' +
                    '<sheet>' +
                        '<group>' +
                            '<button string="Geolocate" name="geo_localize" icon="fa-check" type="object"/>' +
                        '</group>' +
                    '</sheet>' +
                '</form>',
            mockRPC: function (route, args) {
                assert.step(args.method);
                if (args.method === 'create') {
                    return this._super.apply(this, arguments).then(function (result) {
                        resID = result;
                        return resID;
                    });
                }
                return this._super.apply(this, arguments);
            },
        });

        await testUtils.mock.intercept(form, 'execute_action', function (event) {
            assert.step('execute_action');
            assert.deepEqual(event.data.env.currentId, resID,
                "execute action should be done on correct record id");
            event.data.onSuccess();
            event.data.on_closed();
        });
        await testUtils.dom.click('.o-form-statusbar button.p', form);

        assert.verifySteps(['onchange', 'create', 'read', 'execute_action', 'read']);
        form.destroy();
    });

    QUnit.test('buttons in form view, new record, with field id in view', async function (assert) {
        assert.expect(7);
        // buttons in form view are one of the rare example of situation when we
        // save a record without reloading it immediately, because we only care
        // about its id for the next step.  But at some point, if the field id
        // is in the view, it was registered in the changes, and caused invalid
        // values in the record (data.id was set to null)

        var resID;

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<header>' +
                        '<button name="post" class="p" string="Confirm" type="object"/>' +
                    '</header>' +
                    '<sheet>' +
                        '<group>' +
                            '<field name="id" invisible="1"/>' +
                            '<field name="foo"/>' +
                        '</group>' +
                    '</sheet>' +
                '</form>',
            mockRPC: function (route, args) {
                assert.step(args.method);
                if (args.method === 'create') {
                    return this._super.apply(this, arguments).then(function (result) {
                        resID = result;
                        return resID;
                    });
                }
                return this._super.apply(this, arguments);
            },
        });

        await testUtils.mock.intercept(form, 'execute_action', function (event) {
            assert.step('execute_action');
            assert.deepEqual(event.data.env.currentId, resID,
                "execute action should be done on correct record id");
            event.data.onSuccess();
            event.data.on_closed();
        });
        await testUtils.dom.click('.o-form-statusbar button.p', form);

        assert.verifySteps(['onchange', 'create', 'read', 'execute_action', 'read']);
        form.destroy();
    });

    QUnit.test('change and save char', async function (assert) {
        assert.expect(6);
        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<group><field name="foo"/></group>' +
                '</form>',
            mockRPC: function (route, args) {
                if (args.method === 'write') {
                    assert.ok(true, "should call the /write route");
                }
                return this._super(route, args);
            },
            resId: 2,
        });

        assert.strictEqual(form.mode, 'readonly', 'form view should be in readonly mode');
        assert.containsOnce(form, 'span:contains(blip)',
                        "should contain span with field value");

        await testUtils.form.clickEdit(form);

        assert.strictEqual(form.mode, 'edit', 'form view should be in edit mode');
        await testUtils.fields.editInput(form.$('input[name=foo]'), 'tralala');
        await testUtils.form.clickSave(form);

        assert.strictEqual(form.mode, 'readonly', 'form view should be in readonly mode');
        assert.containsOnce(form, 'span:contains(tralala)',
                        "should contain span with field value");
        form.destroy();
    });

    QUnit.test('properly reload data from server', async function (assert) {
        assert.expect(1);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<group><field name="foo"/></group>' +
                '</form>',
            mockRPC: function (route, args) {
                if (args.method === 'write') {
                    args.args[1].foo = "apple";
                }
                return this._super(route, args);
            },
            resId: 2,
        });

        await testUtils.form.clickEdit(form);
        await testUtils.fields.editInput(form.$('input[name=foo]'), 'tralala');
        await testUtils.form.clickSave(form);
        assert.containsOnce(form, 'span:contains(apple)',
                        "should contain span with field value");
        form.destroy();
    });

    QUnit.test('disable buttons until reload data from server', async function (assert) {
        assert.expect(2);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<group><field name="foo"/></group>' +
                '</form>',
            mockRPC: function (route, args) {
                if (args.method === 'write') {
                    args.args[1].foo = "apple";
                } else if (args.method === 'read') {
                    // Block the 'read' call
                    var result = this._super.apply(this, arguments);
                    return Promise.resolve(def).then(result);
                }
                return this._super(route, args);
            },
            resId: 2,
        });

        var def = testUtils.makeTestPromise();
        await testUtils.form.clickEdit(form);
        await testUtils.fields.editInput(form.$('input[name=foo]'), 'tralala');
        await testUtils.form.clickSave(form);

        // Save button should be disabled
        assert.hasAttrValue(form.$buttons.find('.o-form-button-save'), 'disabled', 'disabled');
        // Release the 'read' call
        await def.resolve();
        await testUtils.nextTick();

        // Edit button should be enabled after the reload
        assert.hasAttrValue(form.$buttons.find('.o-form-button_edit'), 'disabled', undefined);

        form.destroy();
    });

    QUnit.test('properly apply onchange in simple case', async function (assert) {
        assert.expect(2);

        this.data.partner.onchanges = {
            foo: function (obj) {
                obj.int_field = obj.foo.length + 1000;
            },
        };
        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<group><field name="foo"/><field name="int_field"/></group>' +
                '</form>',
            resId: 2,
        });

        await testUtils.form.clickEdit(form);

        assert.strictEqual(form.$('input[name=int_field]').val(), "9",
                        "should contain input with initial value");

        await testUtils.fields.editInput(form.$('input[name=foo]'), 'tralala');

        assert.strictEqual(form.$('input[name=int_field]').val(), "1007",
                        "should contain input with onchange applied");
        form.destroy();
    });

    QUnit.test('properly apply onchange when changed field is active field', async function (assert) {
        assert.expect(3);

        this.data.partner.onchanges = {
            int_field: function (obj) {
                obj.int_field = 14;
            },
        };
        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<group><field name="int_field"/></group>' +
                '</form>',
            resId: 2,
            viewOptions: {mode: 'edit'},
        });


        assert.strictEqual(form.$('input[name=int_field]').val(), "9",
                        "should contain input with initial value");

        await testUtils.fields.editInput(form.$('input[name=int_field]'), '666');

        assert.strictEqual(form.$('input[name=int_field]').val(), "14",
                "value should have been set to 14 by onchange");

        await testUtils.form.clickSave(form);

                assert.strictEqual(form.$('.o-field-widget[name=int_field]').text(), "14",
            "value should still be 14");

        form.destroy();
    });

    QUnit.test('onchange send only the present fields to the server', async function (assert) {
        assert.expect(1);
        this.data.partner.records[0].productId = false;
        this.data.partner.onchanges.foo = function (obj) {
            obj.foo = obj.foo + " alligator";
        };

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<field name="foo"/>' +
                    '<field name="p">' +
                        '<tree>' +
                            '<field name="bar"/>' +
                            '<field name="productId"/>' +
                        '</tree>' +
                    '</field>' +
                    '<field name="timmy"/>' +
                '</form>',
            archs: {
                "partner_type,false,list": '<tree><field name="label"/></tree>'
            },
            resId: 1,
            mockRPC: function (route, args) {
                if (args.method === "onchange") {
                    assert.deepEqual(args.args[3],
                        {"foo": "1", "p": "", "p.bar": "", "p.productId": "", "timmy": "", "timmy.name": ""},
                        "should send only the fields used in the views");
                }
                return this._super(route, args);
            },
        });

        await testUtils.form.clickEdit(form);
        await testUtils.fields.editInput(form.$('input[name=foo]'), 'tralala');

        form.destroy();
    });

    QUnit.test('onchange only send present fields value', async function (assert) {
        assert.expect(1);
        this.data.partner.onchanges.foo = function (obj) {};

        let checkOnchange = false;
        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<field name="displayName"/>' +
                    '<field name="foo"/>' +
                    '<field name="p">' +
                        '<tree editable="top">' +
                            '<field name="displayName"/>' +
                            '<field name="qux"/>' +
                        '</tree>' +
                    '</field>' +
                '</form>',
            resId: 1,
            mockRPC: function (route, args) {
                if (args.method === "onchange" && checkOnchange) {
                    assert.deepEqual(args.args[1], {
                        displayName: "first record",
                        foo: "tralala",
                        id: 1,
                        p: [[0, args.args[1].p[0][1], {"displayName": "valid line", "qux": 12.4}]]
                    }, "should send the values for the present fields");
                }
                return this._super(route, args);
            },
        });

        await testUtils.form.clickEdit(form);

        // add a o2m row
        await testUtils.dom.click('.o-field-x2many-list-row-add a');
        form.$('.o-field-one2many input:first').focus();
        await testUtils.nextTick();
        await testUtils.fields.editInput(form.$('.o-field-one2many input[name=displayName]'), 'valid line');
        form.$('.o-field-one2many input:last').focus();
        await testUtils.nextTick();
        await testUtils.fields.editInput(form.$('.o-field-one2many input[name=qux]'), '12.4');

        // trigger an onchange by modifying foo
        checkOnchange = true;
        await testUtils.fields.editInput(form.$('input[name=foo]'), 'tralala');

        form.destroy();
    });

    QUnit.test('evaluate in javascript field options', async function (assert) {
        assert.expect(1);

        var isOk = false;
        var tmp = vj.eval;
        vj.eval = function (expr) {
            if (expr === "{'horizontal': true}") {
                isOk = true;
            }
            return tmp.apply(tmp, arguments);
        };
        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<field name="foo" options="{\'horizontal\': true}"/>' +
                '</form>',
            resId: 2,
        });

        vj.eval = tmp;

        assert.ok(isOk, "should have evaluated the field options");
        form.destroy();
    });

    QUnit.test('can create a record with default values', async function (assert) {
        assert.expect(5);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<group>' +
                            '<field name="foo"/>' +
                            '<field name="bar"/>' +
                        '</group>' +
                    '</sheet>' +
                '</form>',
            resId: 1,
            viewOptions: {
                context: {active_field: 2},
            },
            mockRPC: function (route, args) {
                if (args.method === 'create') {
                    assert.strictEqual(args.kwargs.context.active_field, 2,
                        "should have send the correct context");
                }
                return this._super.apply(this, arguments);
            },
        });
        var n = this.data.partner.records.length;

        await testUtils.form.clickCreate(form);
        assert.strictEqual(form.mode, 'edit', 'form view should be in edit mode');

        assert.strictEqual(form.$('input:first').val(), "My little Foo Value",
            "should have correct default_get value");
        await testUtils.form.clickSave(form);
        assert.strictEqual(form.mode, 'readonly', 'form view should be in readonly mode');
        assert.strictEqual(this.data.partner.records.length, n + 1, "should have created a record");
        form.destroy();
    });

    QUnit.test('default record with a one2many and an onchange on sub field', async function (assert) {
        assert.expect(3);

        this.data.partner.onchanges.foo = function () {};

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<field name="p">' +
                        '<tree>' +
                            '<field name="foo"/>' +
                        '</tree>' +
                    '</field>' +
                '</form>',
            mockRPC: function (route, args) {
                assert.step(args.method);
                if (args.method === 'onchange') {
                    assert.deepEqual(args.args[3], {
                        p: '',
                        'p.foo': '1'
                    }, "onchangeSpec should be correct (with sub fields)");
                }
                return this._super.apply(this, arguments);
            },
        });
        assert.verifySteps(['onchange']);
        form.destroy();
    });

    QUnit.test('remove default value in subviews', async function (assert) {
        assert.expect(2);

        this.data.product.onchanges = {}
        this.data.product.onchanges.name = function () {};

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            viewOptions: {
                context: {default_state: "ab"}
            },
            arch: '<form string="Partners">' +
                    '<field name="productIds" context="{\'default_product_uom_qty\': 68}">' +
                      '<tree editable="top">' +
                        '<field name="label"/>' +
                      '</tree>' +
                    '</field>' +
                  '</form>',
            mockRPC: function (route, args) {
                if (route === "/web/dataset/callKw/partner/onchange") {
                    assert.deepEqual(args.kwargs.context, {
                        default_state: 'ab',
                    })
                }
                else if (route === "/web/dataset/callKw/product/onchange") {
                    assert.deepEqual(args.kwargs.context, {
                        default_product_uom_qty: 68,
                    })
                }
                return this._super.apply(this, arguments);
            },
        });
        await testUtils.dom.click(form.$('.o-field-x2many-list-row-add a'));
        form.destroy();
    });

    QUnit.test('reference field in one2many list', async function (assert) {
        assert.expect(1);

        this.data.partner.records[0].reference = 'partner,2';

        var form = await createView({
            View: FormView,
            model: 'user',
            data: this.data,
            arch: `<form>
                        <field name="label"/>
                        <field name="partnerIds">
                            <tree editable="bottom">
                                <field name="displayName"/>
                                <field name="reference"/>
                            </tree>
                       </field>
                   </form>`,
            archs: {
                'partner,false,form': '<form><field name="displayName"/></form>',
            },
            mockRPC: function (route, args) {
                if (args.method === 'get_formview_id') {
                    return Promise.resolve(false);
                }
                return this._super(route, args);
            },
            resId: 17,
        });
        // current form
        await testUtils.form.clickEdit(form);

        // open the modal form view of the record pointed by the reference field
        await testUtils.dom.click(form.$('table td[title="first record"]'));
        await testUtils.dom.click(form.$('table td button.o-external-button'));

        // edit the record in the modal
        await testUtils.fields.editInput($('.modal-body input[name="displayName"]'), 'New name');
        await testUtils.dom.click($('.modal-dialog footer button:first-child'));

        assert.containsOnce(form, '.o-field-cell[title="New name"]', 'should not crash and value must be edited');

        form.destroy();
    });

    QUnit.test('toolbar is hidden when switching to edit mode', async function (assert) {
        assert.expect(3);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<field name="foo"/>' +
                    '</sheet>' +
                '</form>',
            viewOptions: {hasActionMenus: true},
            resId: 1,
        });

        assert.containsOnce(form, '.o-cp-action-menus');

        await testUtils.form.clickEdit(form);

        assert.containsNone(form, '.o-cp-action-menus');

        await testUtils.form.clickDiscard(form);

        assert.containsOnce(form, '.o-cp-action-menus');

        form.destroy();
    });

    QUnit.test('basic default record', async function (assert) {
        assert.expect(2);

        this.data.partner.fields.foo.default = "default foo value";

        var count = 0;
        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch:'<form string="Partners">' +
                    '<field name="foo"/>' +
                '</form>',
            mockRPC: function (route, args) {
                count++;
                return this._super(route, args);
            },
        });

        assert.strictEqual(form.$('input[name=foo]').val(), "default foo value", "should have correct default");
        assert.strictEqual(count, 1, "should do only one rpc");
        form.destroy();
    });

    QUnit.test('make default record with non empty one2many', async function (assert) {
        assert.expect(4);

        this.data.partner.fields.p.default = [
            [6, 0, []],                  // replace with zero ids
            [0, 0, {foo: "new foo1", productId: 41, p: [] }],   // create a new value
            [0, 0, {foo: "new foo2", productId: 37, p: [] }],   // create a new value
        ];

        var nameGetCount = 0;

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch:'<form string="Partners">' +
                    '<field name="p">' +
                        '<tree>' +
                            '<field name="foo"/>' +
                            '<field name="productId"/>' +
                        '</tree>' +
                    '</field>' +
                '</form>',
            mockRPC: function (route, args) {
                if (args.method === 'name_get') {
                    nameGetCount++;
                }
                return this._super(route, args);
            },
        });
        assert.containsOnce(form, 'td:contains(new foo1)',
            "should have new foo1 value in one2many");
        assert.containsOnce(form, 'td:contains(new foo2)',
            "should have new foo2 value in one2many");
        assert.containsOnce(form, 'td:contains(xphone)',
            "should have a cell with the name field 'productId', set to xphone");
        assert.strictEqual(nameGetCount, 0, "should have done no nameget");
        form.destroy();
    });

    QUnit.test('make default record with non empty many2one', async function (assert) {
        assert.expect(2);

        this.data.partner.fields.trululu.default = 4;

        var nameGetCount = 0;

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch:'<form string="Partners"><field name="trululu"/></form>',
            mockRPC: function (route, args) {
                if (args.method === 'name_get') {
                    nameGetCount++;
                }
                return this._super.apply(this, arguments);
            },
        });

        assert.strictEqual(form.$('.o-field-widget[name=trululu] input').val(), 'aaa',
            "default value should be correctly displayed");
        assert.strictEqual(nameGetCount, 0, "should have done no name_get");

        form.destroy();
    });

    QUnit.test('form view properly change its title', async function (assert) {
        assert.expect(2);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                        '<field name="foo"/>' +
                '</form>',
            resId: 1,
        });

        assert.strictEqual(form.$('.o-control-panel .breadcrumb').text(), 'first record',
            "should have the display name of the record as  title");

        await testUtils.form.clickCreate(form);
        assert.strictEqual(form.$('.o-control-panel .breadcrumb').text(), _t("New"),
            "should have the display name of the record as title");

        form.destroy();
    });

    QUnit.test('archive/unarchive a record', async function (assert) {
        assert.expect(10);

        // add active field on partner model to have archive option
        this.data.partner.fields.active = {string: 'Active', type: 'char', default: true};

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            resId: 1,
            viewOptions: { hasActionMenus: true },
            arch: '<form><field name="active"/><field name="foo"/></form>',
            mockRPC: function (route, args) {
                assert.step(args.method);
                if (args.method === 'actionArchive') {
                    this.data.partner.records[0].active = false;
                    return Promise.resolve();
                }
                if (args.method === 'actionUnarchive') {
                    this.data.partner.records[0].active = true;
                    return Promise.resolve();
                }
                return this._super(...arguments);
            },
        });

        await testUtils.controlPanel.toggleActionMenu(form);
        assert.containsOnce(form, '.o-cp-action-menus a:contains(Archive)');

        await testUtils.controlPanel.toggleMenuItem(form, "Archive");
        assert.containsOnce(document.body, '.modal');

        await testUtils.dom.click($('.modal-footer .btn-primary'));
        await testUtils.controlPanel.toggleActionMenu(form);
        assert.containsOnce(form, '.o-cp-action-menus a:contains(Unarchive)');

        await testUtils.controlPanel.toggleMenuItem(form, "Unarchive");
        await testUtils.controlPanel.toggleActionMenu(form);
        assert.containsOnce(form, '.o-cp-action-menus a:contains(Archive)');

        assert.verifySteps([
            'read',
            'actionArchive',
            'read',
            'actionUnarchive',
            'read',
        ]);

        form.destroy();
    });

    QUnit.test('archive action with active field not in view', async function (assert) {
        assert.expect(2);

        // add active field on partner model, but do not put it in the view
        this.data.partner.fields.active = {string: 'Active', type: 'char', default: true};

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            resId: 1,
            viewOptions: { hasActionMenus: true },
            arch: '<form><field name="foo"/></form>',
        });

        await testUtils.controlPanel.toggleActionMenu(form);
        assert.containsNone(form, '.o-cp-action-menus a:contains(Archive)');
        assert.containsNone(form, '.o-cp-action-menus a:contains(Unarchive)');

        form.destroy();
    });

    QUnit.test('can duplicate a record', async function (assert) {
        assert.expect(3);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                        '<field name="foo"/>' +
                '</form>',
            resId: 1,
            viewOptions: {hasActionMenus: true},
        });

        assert.strictEqual(form.$('.o-control-panel .breadcrumb').text(), 'first record',
            "should have the display name of the record as  title");

        await testUtils.controlPanel.toggleActionMenu(form);
        await testUtils.controlPanel.toggleMenuItem(form, "Duplicate");

        assert.strictEqual(form.$('.o-control-panel .breadcrumb').text(), 'first record (copy)',
            "should have duplicated the record");

        assert.strictEqual(form.mode, "edit", 'should be in edit mode');
        form.destroy();
    });

    QUnit.test('duplicating a record preserve the context', async function (assert) {
        assert.expect(2);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                        '<field name="foo"/>' +
                '</form>',
            resId: 1,
            viewOptions: {hasActionMenus: true, context: {hey: 'hoy'}},
            mockRPC: function (route, args) {
                if (args.method === 'read') {
                    // should have 2 read, one for initial load, second for
                    // read after duplicating
                    assert.strictEqual(args.kwargs.context.hey, 'hoy',
                        "should have send the correct context");
                }
                return this._super.apply(this, arguments);
            },
        });

        await testUtils.controlPanel.toggleActionMenu(form);
        await testUtils.controlPanel.toggleMenuItem(form, "Duplicate");

        form.destroy();
    });

    QUnit.test('cannot duplicate a record', async function (assert) {
        assert.expect(2);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners" duplicate="false">' +
                        '<field name="foo"/>' +
                '</form>',
            resId: 1,
            viewOptions: {hasActionMenus: true},
        });

        assert.strictEqual(form.$('.o-control-panel .breadcrumb').text(), 'first record',
            "should have the display name of the record as  title");
        assert.containsNone(form, '.o-cp-action-menus a:contains(Duplicate)',
            "should not contains a 'Duplicate' action");
        form.destroy();
    });

    QUnit.test('clicking on stat buttons in edit mode', async function (assert) {
        assert.expect(9);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch:'<form string="Partners">' +
                    '<sheet>' +
                        '<div name="buttonBox">' +
                            '<button class="oe-stat-button" name="some_action" type="action">' +
                                '<field name="bar"/>' +
                            '</button>' +
                        '</div>' +
                        '<group>' +
                            '<field name="foo"/>' +
                        '</group>' +
                    '</sheet>' +
                '</form>',
            resId: 2,
            mockRPC: function (route, args) {
                if (args.method === 'write') {
                    assert.strictEqual(args.args[1].foo, "tralala", "should have saved the changes");
                }
                assert.step(args.method);
                return this._super(route, args);
            },
        });

        await testUtils.form.clickEdit(form);

        var count = 0;
        await testUtils.mock.intercept(form, "execute_action", function (event) {
            event.stopPropagation();
            count++;
        });
        await testUtils.dom.click('.oe-stat-button');
        assert.strictEqual(count, 1, "should have triggered a execute action");
        assert.strictEqual(form.mode, "edit", "form view should be in edit mode");

        await testUtils.fields.editInput(form.$('input[name=foo]'), 'tralala');
        await testUtils.dom.click('.oe-stat-button:first');

                assert.strictEqual(form.mode, "edit", "form view should be in edit mode");
        assert.strictEqual(count, 2, "should have triggered a execute action");
        assert.verifySteps(['read', 'write', 'read']);
        form.destroy();
    });

    QUnit.test('clicking on stat buttons save and reload in edit mode', async function (assert) {
        assert.expect(2);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch:'<form string="Partners">' +
                    '<sheet>' +
                        '<div name="buttonBox">' +
                            '<button class="oe-stat-button" type="action">' +
                                '<field name="int_field" widget="statinfo" string="Some number"/>' +
                            '</button>' +
                        '</div>' +
                        '<group>' +
                            '<field name="label"/>' +
                        '</group>' +
                    '</sheet>' +
                '</form>',
            resId: 2,
            mockRPC: function (route, args) {
                if (args.method === 'write') {
                    // simulate an override of the model...
                    args.args[1].displayName = "GOLDORAK";
                    args.args[1].name = "GOLDORAK";
                }
                return this._super.apply(this, arguments);
            },
        });

        assert.strictEqual(form.$('.o-control-panel .breadcrumb').text(), 'second record',
            "should have correct displayName");
        await testUtils.form.clickEdit(form);
        await testUtils.fields.editInput(form.$('input[name=name]'), 'some other name');

        await testUtils.dom.click('.oe-stat-button');
        assert.strictEqual(form.$('.o-control-panel .breadcrumb').text(), 'GOLDORAK',
            "should have correct displayName");

        form.destroy();
    });

    QUnit.test('buttons with attr "special" do not trigger a save', async function (assert) {
        assert.expect(4);

        var executeActionCount = 0;
        var writeCount = 0;

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                        '<field name="foo"/>' +
                        '<button string="Do something" class="btn-primary" name="abc" type="object"/>' +
                        '<button string="Or discard" class="btn-secondary" special="cancel"/>' +
                '</form>',
            resId: 1,
            mockRPC: function (route, args) {
                if (args.method === 'write') {
                    writeCount++;
                }
                return this._super(route, args);
            },
        });
        await testUtils.mock.intercept(form, "execute_action", function () {
            executeActionCount++;
        });

        await testUtils.form.clickEdit(form);

        // make the record dirty
        await testUtils.fields.editInput(form.$('input[name=foo]'), 'tralala');

        await testUtils.dom.click(form.$('button:contains(Do something)'));
        //TODO: VSC: add a next tick ?
        assert.strictEqual(writeCount, 1, "should have triggered a write");
        assert.strictEqual(executeActionCount, 1, "should have triggered a execute action");

        await testUtils.fields.editInput(form.$('input[name=foo]'), 'abcdef');

        await testUtils.dom.click(form.$('button:contains(Or discard)'));
        assert.strictEqual(writeCount, 1, "should not have triggered a write");
        assert.strictEqual(executeActionCount, 2, "should have triggered a execute action");

        form.destroy();
    });

    QUnit.test('buttons with attr "special=save" save', async function (assert) {
        assert.expect(5);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                        '<field name="foo"/>' +
                        '<button string="Save" class="btn-primary" special="save"/>' +
                '</form>',
            resId: 1,
            intercepts: {
                execute_action: function () {
                    assert.step('execute_action');
                },
            },
            mockRPC: function (route, args) {
                assert.step(args.method);
                return this._super(route, args);
            },
            viewOptions: {
                mode: 'edit',
            },
        });

        await testUtils.fields.editInput(form.$('input[name=foo]'), 'tralala');
        await testUtils.dom.click(form.$('button[special="save"]'));
        assert.verifySteps(['read', 'write', 'read', 'execute_action']);

        form.destroy();
    });

    QUnit.test('missing widgets do not crash', async function (assert) {
        assert.expect(1);

        this.data.partner.fields.foo.type = 'new field type without widget';
        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                        '<field name="foo"/>' +
                '</form>',
            resId: 1,
        });
        assert.containsOnce(form, '.o-field-widget');
        form.destroy();
    });

    QUnit.test('nolabel', async function (assert) {
        assert.expect(6);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<group>' +
                            '<group class="firstgroup"><field name="foo" nolabel="1"/></group>' +
                            '<group class="secondgroup">'+
                                '<field name="productId"/>' +
                                '<field name="int_field" nolabel="1"/><field name="qux" nolabel="1"/>' +
                            '</group>' +
                            '<group><field name="bar"/></group>' +
                        '</group>' +
                    '</sheet>' +
                '</form>',
            resId: 1,
        });

        assert.containsN(form, "label.o-form-label", 2);
        assert.strictEqual(form.$("label.o-form-label").first().text(), "Product",
            "one should be the one for the product field");
        assert.strictEqual(form.$("label.o-form-label").eq(1).text(), "Bar",
            "one should be the one for the bar field");

        assert.hasAttrValue(form.$('.firstgroup td').first(), 'colspan', undefined,
            "foo td should have a default colspan (1)");
        assert.containsN(form, '.secondgroup tr', 2,
            "int_field and qux should have same tr");

        assert.containsN(form, '.secondgroup tr:first td', 2,
            "productId field should be on its own tr");
        form.destroy();
    });

    QUnit.test('many2one in a one2many', async function (assert) {
        assert.expect(1);

        this.data.partner.records[0].p = [2];
        this.data.partner.records[1].productId = 37;

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch:'<form string="Partners">' +
                    '<field name="p">' +
                        '<tree>' +
                            '<field name="productId"/>' +
                        '</tree>' +
                    '</field>' +
                '</form>',
            resId: 1,
        });
        assert.containsOnce(form, 'td:contains(xphone)', "should display the name of the many2one");
        form.destroy();
    });

    QUnit.test('circular many2many\'s', async function (assert) {
        assert.expect(4);
        this.data.partner_type.fields.partnerIds = {string: "partners", type: "many2many", relation: 'partner'};
        this.data.partner.records[0].timmy = [12];
        this.data.partner_type.records[0].partnerIds = [1];

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch:'<form string="Partners">' +
                    '<field name="timmy">' +
                        '<tree>' +
                            '<field name="displayName"/>' +
                        '</tree>' +
                        '<form>' +
                            '<field name="partnerIds">' +
                                '<tree>' +
                                    '<field name="displayName"/>' +
                                '</tree>' +
                                '<form>' +
                                    '<field name="displayName"/>' +
                                '</form>' +
                            '</field>' +
                        '</form>' +
                    '</field>' +
                '</form>',
            resId: 1,
        });

        assert.containsOnce(form, 'td:contains(gold)',
            "should display the name of the many2many on the original form");
        await testUtils.dom.click(form.$('td:contains(gold)'));
        await testUtils.nextTick(); // wait for quick edit

        assert.containsOnce(document.body, '.modal');
        assert.containsOnce($('.modal'), 'td:contains(first record)',
            "should display the name of the many2many on the modal form");

        await testUtils.dom.click('.modal td:contains(first record)');
        await testUtils.nextTick(); // wait for quick edit
        assert.containsN(document.body, '.modal', 2,
            "there should be 2 modals (partner on top of partner_type) opened");

        form.destroy();
    });

    QUnit.test('discard changes on a non dirty form view', async function (assert) {
        assert.expect(4);

        var nbWrite = 0;
        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners"><field name="foo"></field></form>',
            resId: 1,
            mockRPC: function (route) {
                if (route === '/web/dataset/callKw/partner/write') {
                    nbWrite++;
                }
                return this._super.apply(this, arguments);
            },
        });

        // switch to edit mode
        await testUtils.form.clickEdit(form);
        assert.strictEqual(form.$('input[name=foo]').val(), 'yop',
            "input should contain yop");

        // click on discard
        await testUtils.form.clickDiscard(form);
        assert.containsNone(document.body, '.modal', 'no confirm modal should be displayed');
        assert.strictEqual(form.$('.o-field-widget').text(), 'yop', 'field in readonly should display yop');

        assert.strictEqual(nbWrite, 0, "no write RPC should have been done");
        form.destroy();
    });

    QUnit.test('discard changes on a dirty form view', async function (assert) {
        assert.expect(5);

        var nbWrite = 0;
        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners"><field name="foo"></field></form>',
            resId: 1,
            mockRPC: function (route) {
                if (route === '/web/dataset/callKw/partner/write') {
                    nbWrite++;
                }
                return this._super.apply(this, arguments);
            },
        });

        // switch to edit mode and edit the foo field
        await testUtils.form.clickEdit(form);
        assert.strictEqual(form.$('input[name=foo]').val(), 'yop', "input should contain yop");
        await testUtils.fields.editInput(form.$('input[name=foo]'), 'new value');
        assert.strictEqual(form.$('input[name=foo]').val(), 'new value',
            "input should contain new value");

        // click on discard
        await testUtils.form.clickDiscard(form);
        assert.containsNone(document.body, '.modal', "no confirm modal should be displayed");
        assert.strictEqual(form.$('.o-field-widget').text(), 'yop', 'field in readonly should display yop');

        assert.strictEqual(nbWrite, 0, "no write RPC should have been done");
        form.destroy();
    });

    QUnit.test('discard changes on a dirty form view (for date field)', async function (assert) {
        assert.expect(1);

        // this test checks that the basic model properly handles date object
        // when they are discarded and saved.  This may be an issue because
        // dates are saved as moment object, and were at one point stringified,
        // then parsed into string, which is wrong.

        this.data.partner.fields.date.default = "2017-01-25";
        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners"><field name="date"></field></form>',
            intercepts: {
                historyBack: function () {
                    form.update({}, {reload: false});
                }
            },
        });

        // focus the buttons before clicking on them to precisely reproduce what
        // really happens (mostly because the datepicker lib need that focus
        // event to properly focusout the input, otherwise it crashes later on
        // when the 'blur' event is triggered by the re-rendering)
        form.$buttons.find('.o-form-button_cancel').focus();
        await testUtils.dom.click('.o-form-button_cancel');
        form.$buttons.find('.o-form-button-save').focus();
        await testUtils.dom.click('.o-form-button-save');
        assert.containsOnce(form, 'span:contains(2017)');

        form.destroy();
    });

    QUnit.test('discard changes on relational data on new record', async function (assert) {
        assert.expect(4);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners"><sheet><group>' +
                    '<field name="p">' +
                        '<tree editable="top">' +
                            '<field name="productId"/>' +
                        '</tree>' +
                    '</field>' +
                '</group></sheet></form>',
            intercepts: {
                historyBack: function () {
                    assert.ok(true, "should have sent correct event");
                    // simulate the response from the action manager, in the case
                    // where we have only one active view (the form).  If there
                    // was another view, we would have switched to that view
                    // instead
                    form.update({}, {reload: false});
                }
            },
        });

        // edit the p field
        await testUtils.dom.click(form.$('.o-field-x2many-list-row-add a'));
        await testUtils.fields.many2one.clickOpenDropdown('productId');
        await testUtils.fields.many2one.clickHighlightedItem('productId');

        assert.strictEqual(form.$('.o-field-widget[name=productId] input').val(), 'xphone',
            "input should contain xphone");

        // click on discard
        await testUtils.form.clickDiscard(form);
        assert.containsNone(form, '.modal', 'modal should not be displayed');

        assert.notOk(form.$el.prop('outerHTML').match('xphone'),
            "the string xphone should not be present after discarding");
        form.destroy();
    });

    QUnit.test('discard changes on a new (non dirty, except for defaults) form view', async function (assert) {
        assert.expect(3);

        this.data.partner.fields.foo.default = "ABC";

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners"><field name="foo"></field></form>',
            intercepts: {
                historyBack: function () {
                    assert.ok(true, "should have sent correct event");
                }
            }
        });

        // edit the foo field
        assert.strictEqual(form.$('input[name=foo]').val(), 'ABC',
            "input should contain ABC");

        await testUtils.form.clickDiscard(form);

        assert.containsNone(document.body, '.modal',
            "there should not be a confirm modal");

        form.destroy();
    });

    QUnit.test('discard changes on a new (dirty) form view', async function (assert) {
        assert.expect(7);

        this.data.partner.fields.foo.default = "ABC";

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners"><field name="foo"></field></form>',
            intercepts: {
                historyBack: function () {
                    assert.ok(true, "should have sent correct event");
                    // simulate the response from the action manager, in the case
                    // where we have only one active view (the form).  If there
                    // was another view, we would have switched to that view
                    // instead
                    form.update({}, {reload: false});
                }
            },
        });

        // edit the foo field
        assert.strictEqual(form.$('input').val(), 'ABC',  'input should contain ABC');
        await testUtils.fields.editInput(form.$('input[name=foo]'), 'DEF');

        // discard the changes and check it has properly been discarded
        assert.strictEqual(form.$('input').val(), 'DEF', 'input should be DEF');
        await testUtils.form.clickDiscard(form);
        assert.strictEqual(form.$('input').val(), 'ABC', 'input should now be ABC');

        // redirty and discard the field foo (to make sure initial changes haven't been lost)
        await testUtils.fields.editInput(form.$('input[name=foo]'), 'GHI');
        assert.strictEqual(form.$('input').val(), 'GHI', 'input should be GHI');
        await testUtils.form.clickDiscard(form);
        assert.strictEqual(form.$('input').val(), 'ABC', 'input should now be ABC');

        form.destroy();
    });

    QUnit.test('discard changes on a duplicated record', async function (assert) {
        assert.expect(2);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners"><field name="foo"></field></form>',
            resId: 1,
            viewOptions: {hasActionMenus: true},
        });
        await testUtils.form.clickEdit(form);
        await testUtils.fields.editInput(form.$('input[name=foo]'), 'tralala');
        await testUtils.form.clickSave(form);

        await testUtils.controlPanel.toggleActionMenu(form);
        await testUtils.controlPanel.toggleMenuItem(form, "Duplicate");

        assert.strictEqual(form.$('input[name=foo]').val(), 'tralala', 'input should contain ABC');

        await testUtils.form.clickDiscard(form);

        assert.containsNone(document.body, '.modal', "there should not be a confirm modal");

        form.destroy();
    });

    QUnit.test("switching to another record from a dirty one", async function (assert) {
        assert.expect(11);

        var nbWrite = 0;
        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners"><field name="foo"></field></form>',
            viewOptions: {
                ids: [1, 2],
                index: 0,
            },
            resId: 1,
            mockRPC: function (route) {
                if (route === '/web/dataset/callKw/partner/write') {
                    nbWrite++;
                }
                return this._super.apply(this, arguments);
            },
        });

        assert.strictEqual(testUtils.controlPanel.getPagerValue(form), '1', "pager value should be 1");
        assert.strictEqual(testUtils.controlPanel.getPagerSize(form), '2', "pager limit should be 2");

        // switch to edit mode
        await testUtils.form.clickEdit(form);
        assert.strictEqual(form.$('input[name=foo]').val(), 'yop', "input should contain yop");

        // edit the foo field
        await testUtils.fields.editInput(form.$('input[name=foo]'), 'new value');
        assert.strictEqual(form.$('input').val(), 'new value', 'input should contain new value');

        // click on the pager to switch to the next record (will save record)
        await testUtils.controlPanel.pagerNext(form);
        assert.containsNone(document.body, '.modal', "no confirm modal should be displayed");
        assert.strictEqual(testUtils.controlPanel.getPagerValue(form), '2', "pager value should be 2");
        assert.strictEqual(form.$('input[name=foo]').val(), 'blip', "input should contain blip");

        await testUtils.controlPanel.pagerPrevious(form);
        assert.containsNone(document.body, '.modal', "no confirm modal should be displayed");
        assert.strictEqual(testUtils.controlPanel.getPagerValue(form), '1', "pager value should be 1");
        assert.strictEqual(form.$('input[name=foo]').val(), 'new value', "input should contain new value");

        assert.strictEqual(nbWrite, 1, 'one write RPC should have been done');
        form.destroy();
    });

    QUnit.test('handling dirty state: switching to another record', async function (assert) {
        assert.expect(12);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<field name="foo"></field>' +
                    '<field name="priority" widget="priority"></field>' +
                '</form>',
            viewOptions: {
                ids: [1, 2],
                index: 0,
            },
            resId: 1,
        });

        assert.strictEqual(testUtils.controlPanel.getPagerValue(form), '1', "pager value should be 1");

        // switch to edit mode
        await testUtils.form.clickEdit(form);
        assert.strictEqual(form.$('input[name=foo]').val(), 'yop', "input should contain yop");

        // edit the foo field
        await testUtils.fields.editInput(form.$('input[name=foo]'), 'new value');
        assert.strictEqual(form.$('input[name=foo]').val(), 'new value',
            "input should contain new value");

        await testUtils.form.clickSave(form);

        // click on the pager to switch to the next record and cancel the confirm request
        await testUtils.controlPanel.pagerNext(form);
        assert.containsNone(document.body, '.modal:visible',
            "no confirm modal should be displayed");
        assert.strictEqual(testUtils.controlPanel.getPagerValue(form), '2', "pager value should be 2");

        assert.containsN(form, '.o-priority .fa-star-o', 2,
            'priority widget should have been rendered with correct value');

        // edit the value in readonly
        await testUtils.dom.click(form.$('.o-priority .fa-star-o:first')); // click on the first star
        assert.containsOnce(form, '.o-priority .fa-star',
            'priority widget should have been updated');

        await testUtils.controlPanel.pagerNext(form);
            assert.containsNone(document.body, '.modal:visible',
            "no confirm modal should be displayed");
        assert.strictEqual(testUtils.controlPanel.getPagerValue(form), '1', "pager value should be 1");

        // switch to edit mode
        await testUtils.form.clickEdit(form);
        assert.strictEqual(form.$('input[name=foo]').val(), 'new value',
            "input should contain yop");

        // edit the foo field
        await testUtils.fields.editInput(form.$('input[name=foo]'), 'wrong value');

        await testUtils.form.clickDiscard(form);
        assert.containsNone(document.body, '.modal', "no confirm modal should be displayed");
        await testUtils.controlPanel.pagerNext(form);
        assert.strictEqual(testUtils.controlPanel.getPagerValue(form), '2', "pager value should be 2");
        form.destroy();
    });

    QUnit.test('restore local state when switching to another record', async function (assert) {
        assert.expect(4);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                        '<notebook>' +
                            '<page string="First Page" name="first">' +
                                '<field name="foo"/>' +
                            '</page>' +
                            '<page string="Second page" name="second">' +
                                '<field name="bar"/>' +
                            '</page>' +
                        '</notebook>' +
                    '</form>',
            viewOptions: {
                ids: [1, 2],
                index: 0,
            },
            resId: 1,
        });

        // click on second page tab
        await testUtils.dom.click(form.$('.o-notebook .nav-link:eq(1)'));

        assert.doesNotHaveClass(form.$('.o-notebook .nav-link:eq(0)'), 'active');
        assert.hasClass(form.$('.o-notebook .nav-link:eq(1)'), 'active');

        // click on the pager to switch to the next record
        await testUtils.controlPanel.pagerNext(form);

        assert.doesNotHaveClass(form.$('.o-notebook .nav-link:eq(0)'), 'active');
        assert.hasClass(form.$('.o-notebook .nav-link:eq(1)'), 'active');
        form.destroy();
    });

    QUnit.test('pager is hidden in create mode', async function (assert) {
        assert.expect(7);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                        '<field name="foo"/>' +
                '</form>',
            resId: 1,
            viewOptions: {
                ids: [1, 2],
                index: 0,
            },
        });

        assert.containsOnce(form, '.o-pager');
        assert.strictEqual(testUtils.controlPanel.getPagerValue(form), "1",
            "current pager value should be 1");
        assert.strictEqual(testUtils.controlPanel.getPagerSize(form), "2",
            "current pager limit should be 1");

        await testUtils.form.clickCreate(form);

        assert.containsNone(form, '.o-pager');

        await testUtils.form.clickSave(form);

        assert.containsOnce(form, '.o-pager');
        assert.strictEqual(testUtils.controlPanel.getPagerValue(form), "3",
            "current pager value should be 3");
        assert.strictEqual(testUtils.controlPanel.getPagerSize(form), "3",
            "current pager limit should be 3");

        form.destroy();
    });

    QUnit.test('switching to another record, in readonly mode', async function (assert) {
        assert.expect(5);

        var pushStateCount = 0;

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners"><field name="foo"></field></form>',
            viewOptions: {
                ids: [1, 2],
                index: 0,
            },
            resId: 1,
            intercepts: {
                pushState: function (event) {
                    pushStateCount++;
                }
            }
        });

        assert.strictEqual(form.mode, 'readonly', 'form view should be in readonly mode');
        assert.strictEqual(testUtils.controlPanel.getPagerValue(form), "1", 'pager value should be 1');

        await testUtils.controlPanel.pagerNext(form);

        assert.strictEqual(testUtils.controlPanel.getPagerValue(form), "2", 'pager value should be 2');
        assert.strictEqual(form.mode, 'readonly', 'form view should be in readonly mode');

        assert.strictEqual(pushStateCount, 2, "should have triggered 2 pushState");
        form.destroy();
    });

    QUnit.test('modifiers are reevaluated when creating new record', async function (assert) {
        assert.expect(4);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet><group>' +
                        '<field name="foo" class="foo_field" attrs=\'{"invisible": [["bar", "=", true]]}\'/>' +
                        '<field name="bar"/>' +
                    '</group></sheet>' +
                '</form>',
            resId: 1,
        });

        assert.containsOnce(form, 'span.foo_field');
        assert.isNotVisible(form.$('span.foo_field'));

        await testUtils.form.clickCreate(form);

        assert.containsOnce(form, 'input.foo_field');
        assert.isVisible(form.$('input.foo_field'));

        form.destroy();
    });

    QUnit.test('empty readonly fields are visible on new records', async function (assert) {
        assert.expect(2);

        this.data.partner.fields.foo.readonly = true;
        this.data.partner.fields.foo.default = undefined;
        this.data.partner.records[0].foo = undefined;

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet><group>' +
                        '<field name="foo"/>' +
                    '</group></sheet>' +
                '</form>',
            resId: 1,
        });

        assert.containsOnce(form, '.o-field-empty');

        await testUtils.form.clickCreate(form);

        assert.containsNone(form, '.o-field-empty');
        form.destroy();
    });

    QUnit.test('all group children have correct layout classname', async function (assert) {
        assert.expect(2);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet><group>' +
                        '<group class="inner_group">' +
                            '<field name="label"/>' +
                        '</group>' +
                        '<div class="inner_div">' +
                            '<field name="foo"/>' +
                        '</div>' +
                    '</group></sheet>' +
                '</form>',
            resId: 1,
        });

        assert.hasClass(form.$('.inner_group'), 'o-group-col-6'),
        assert.hasClass(form.$('.inner_div'), 'o-group-col-6'),
        form.destroy();
    });

    QUnit.test('deleting a record', async function (assert) {
        assert.expect(8);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners"><field name="foo"></field></form>',
            viewOptions: {
                ids: [1, 2, 4],
                index: 0,
                hasActionMenus: true,
            },
            resId: 1,
        });

        assert.strictEqual(testUtils.controlPanel.getPagerValue(form), "1", 'pager value should be 1');
        assert.strictEqual(testUtils.controlPanel.getPagerSize(form), "3", 'pager limit should be 3');
        assert.strictEqual(form.$('span:contains(yop)').length, 1,
            'should have a field with foo value for record 1');
        assert.ok(!$('.modal:visible').length, 'no confirm modal should be displayed');

        // open action menu and delete
        await testUtils.controlPanel.toggleActionMenu(form);
        await testUtils.controlPanel.toggleMenuItem(form, "Delete");

        assert.ok($('.modal').length, 'a confirm modal should be displayed');

        // confirm the delete
        await testUtils.dom.click($('.modal-footer button.btn-primary'));

        assert.strictEqual(testUtils.controlPanel.getPagerValue(form), "1", 'pager value should be 1');
        assert.strictEqual(testUtils.controlPanel.getPagerSize(form), "2", 'pager limit should be 2');
        assert.strictEqual(form.$('span:contains(blip)').length, 1,
            'should have a field with foo value for record 2');
        form.destroy();
    });

    QUnit.test('deleting the last record', async function (assert) {
        assert.expect(6);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners"><field name="foo"></field></form>',
            viewOptions: {
                ids: [1],
                index: 0,
                hasActionMenus: true,
            },
            resId: 1,
            mockRPC: function (route, args) {
                assert.step(args.method);
                return this._super.apply(this, arguments);
            }
        });

        await testUtils.controlPanel.toggleActionMenu(form);
        await testUtils.controlPanel.toggleMenuItem(form, "Delete");

        await testUtils.mock.intercept(form, 'historyBack', function () {
            assert.step('historyBack');
        });
        assert.strictEqual($('.modal').length, 1, 'a confirm modal should be displayed');
        await testUtils.dom.click($('.modal-footer button.btn-primary'));
        assert.strictEqual($('.modal').length, 0, 'no confirm modal should be displayed');

        assert.verifySteps(['read', 'unlink', 'historyBack']);
        form.destroy();
    });

    QUnit.test('empty required fields cannot be saved', async function (assert) {
        assert.expect(5);

        this.data.partner.fields.foo.required = true;
        delete this.data.partner.fields.foo.default;

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                        '<group><field name="foo"/></group>' +
                '</form>',
            services: {
                notification: {
                    notify: function (params) {
                        if (params.type !== 'danger') {
                            return;
                        }
                        assert.strictEqual(params.title, 'Invalid fields:',
                            "should have a warning with correct title");
                        assert.strictEqual(params.message.toString(), '<ul><li>Foo</li></ul>',
                            "should have a warning with correct message");
                    }
                },
            },
        });

        await testUtils.form.clickSave(form);
        assert.hasClass(form.$('label.o-form-label'),'o-field-invalid');
        assert.hasClass(form.$('input[name=foo]'),'o-field-invalid');

        await testUtils.fields.editInput(form.$('input[name=foo]'), 'tralala');

        assert.containsNone(form, '.o-field-invalid');

        form.destroy();
    });

    QUnit.test('changes in a readonly form view are saved directly', async function (assert) {
        assert.expect(10);

        var nbWrite = 0;
        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                        '<group>' +
                            '<field name="foo"/>' +
                            '<field name="priority" widget="priority"/>' +
                        '</group>' +
                '</form>',
            mockRPC: function (route) {
                if (route === '/web/dataset/callKw/partner/write') {
                    nbWrite++;
                }
                return this._super.apply(this, arguments);
            },
            resId: 1,
        });

        assert.containsN(form, '.o-priority .o-priority-star', 2,
            'priority widget should have been rendered');
        assert.containsN(form, '.o-priority .fa-star-o', 2,
            'priority widget should have been rendered with correct value');

        // edit the value in readonly
        await testUtils.dom.click(form.$('.o-priority .fa-star-o:first'));
        assert.strictEqual(nbWrite, 1, 'should have saved directly');
        assert.containsOnce(form, '.o-priority .fa-star',
            'priority widget should have been updated');

        // switch to edit mode and edit the value again
        await testUtils.form.clickEdit(form);
        assert.containsN(form, '.o-priority .o-priority-star', 2,
            'priority widget should have been correctly rendered');
        assert.containsOnce(form, '.o-priority .fa-star',
            'priority widget should have correct value');
        await testUtils.dom.click(form.$('.o-priority .fa-star-o:first'));
        assert.strictEqual(nbWrite, 1, 'should not have saved directly');
        assert.containsN(form, '.o-priority .fa-star', 2,
            'priority widget should have been updated');

        // save
        await testUtils.form.clickSave(form);
        assert.strictEqual(nbWrite, 2, 'should not have saved directly');
        assert.containsN(form, '.o-priority .fa-star', 2,
            'priority widget should have correct value');
        form.destroy();
    });

    QUnit.test('display a dialog if onchange result is a warning', async function (assert) {
        assert.expect(5);

        this.data.partner.onchanges = { foo: true };

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<group><field name="foo"/><field name="int_field"/></group>' +
                '</form>',
            resId: 2,
            mockRPC: function (route, args) {
                if (args.method === 'onchange') {
                    return Promise.resolve({
                        value: { int_field: 10 },
                        warning: {
                            title: "Warning",
                            message: "You must first select a partner",
                            type: 'dialog',
                        }
                    });
                }
                return this._super.apply(this, arguments);
            },
            intercepts: {
                warning: function (event) {
                    assert.strictEqual(event.data.type, 'dialog',
                        "should have triggered an event with the correct data");
                    assert.strictEqual(event.data.title, "Warning",
                        "should have triggered an event with the correct data");
                    assert.strictEqual(event.data.message, "You must first select a partner",
                        "should have triggered an event with the correct data");
                },
            },
        });

        await testUtils.form.clickEdit(form);

        assert.strictEqual(form.$('input[name=int_field]').val(), '9');

        await testUtils.fields.editInput(form.$('input[name=foo]'), 'tralala');

        assert.strictEqual(form.$('input[name=int_field]').val(), '10');

        form.destroy();
    });

    QUnit.test('display a notificaton if onchange result is a warning with type notification', async function (assert) {
        assert.expect(5);

        this.data.partner.onchanges = { foo: true };

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<group><field name="foo"/><field name="int_field"/></group>' +
                '</form>',
            resId: 2,
            mockRPC: function (route, args) {
                if (args.method === 'onchange') {
                    return Promise.resolve({
                        value: { int_field: 10 },
                        warning: {
                            title: "Warning",
                            message: "You must first select a partner",
                            type: 'notification',
                        }
                    });
                }
                return this._super.apply(this, arguments);
            },
            intercepts: {
                warning: function (event) {
                    assert.strictEqual(event.data.type, 'notification',
                        "should have triggered an event with the correct data");
                    assert.strictEqual(event.data.title, "Warning",
                        "should have triggered an event with the correct data");
                    assert.strictEqual(event.data.message, "You must first select a partner",
                        "should have triggered an event with the correct data");
                },
            },
        });

        await testUtils.form.clickEdit(form);

        assert.strictEqual(form.$('input[name=int_field]').val(), '9');

        await testUtils.fields.editInput(form.$('input[name=foo]'), 'tralala');

        assert.strictEqual(form.$('input[name=int_field]').val(), '10');

        form.destroy();
    });

    QUnit.test('can create record even if onchange returns a warning', async function (assert) {
        assert.expect(2);

        this.data.partner.onchanges = { foo: true };

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<group><field name="foo"/><field name="int_field"/></group>' +
                '</form>',
            mockRPC: function (route, args) {
                if (args.method === 'onchange') {
                    return Promise.resolve({
                        value: { int_field: 10 },
                        warning: {
                            title: "Warning",
                            message: "You must first select a partner"
                        }
                    });
                }
                return this._super.apply(this, arguments);
            },
            intercepts: {
                warning: function (event) {
                    assert.ok(true, 'should trigger a warning');
                },
            },
        });
        assert.strictEqual(form.$('input[name="int_field"]').val(), "10",
            "record should have been created and rendered");

        form.destroy();
    });

    QUnit.test('do nothing if add a line in one2many result in a onchange with a warning', async function (assert) {
        assert.expect(3);

        this.data.partner.onchanges = { foo: true };

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<field name="p">' +
                        '<tree editable="top">' +
                            '<field name="foo"/>' +
                        '</tree>' +
                    '</field>' +
                '</form>',
            resId: 2,
            mockRPC: function (route, args) {
                if (args.method === 'onchange') {
                    return Promise.resolve({
                        value: {},
                        warning: {
                            title: "Warning",
                            message: "You must first select a partner",
                        }
                    });
                }
                return this._super.apply(this, arguments);
            },
            intercepts: {
                warning: function () {
                    assert.step("should have triggered a warning");
                },
            },
        });

        // go to edit mode, click to add a record in the o2m
        await testUtils.form.clickEdit(form);
        await testUtils.dom.click(form.$('.o-field-x2many-list-row-add a'));
        assert.containsNone(form, 'tr.o-data-row',
            "should not have added a line");
        assert.verifySteps(["should have triggered a warning"]);
        form.destroy();
    });

    QUnit.test('button box is rendered in create mode', async function (assert) {
        assert.expect(3);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form>' +
                    '<div name="buttonBox" class="oe-button-box">' +
                        '<button type="object" class="oe-stat-button" icon="fa-check-square">' +
                            '<field name="bar"/>' +
                        '</button>' +
                    '</div>' +
                '</form>',
            resId: 2,
        });

        // readonly mode
        assert.containsOnce(form, '.oe-stat-button',
            "button box should be displayed in readonly");

        // edit mode
        await testUtils.form.clickEdit(form);

        assert.containsOnce(form, '.oe-stat-button',
            "button box should be displayed in edit on an existing record");

        // create mode (leave edition first!)
        await testUtils.form.clickDiscard(form);
        await testUtils.form.clickCreate(form);
        assert.containsOnce(form, '.oe-stat-button',
            "button box should be displayed when creating a new record as well");

        form.destroy();
    });

    QUnit.test('properly apply onchange on one2many fields', async function (assert) {
        assert.expect(5);

        this.data.partner.records[0].p = [4];
        this.data.partner.onchanges = {
            foo: function (obj) {
                obj.p = [
                    [5],
                    [1, 4, {displayName: "updated record"}],
                    [0, null, {displayName: "created record"}],
                ];
            },
        };
        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<group><field name="foo"/></group>' +
                    '<field name="p">' +
                        '<tree>' +
                            '<field name="displayName"/>' +
                        '</tree>' +
                    '</field>' +
                '</form>',
            resId: 1,
        });

        assert.containsOnce(form, '.o-field-one2many .o-data-row',
            "there should be one one2many record linked at first");
        assert.strictEqual(form.$('.o-field-one2many .o-data-row td:first').text(), 'aaa',
            "the 'displayName' of the one2many record should be correct");

        // switch to edit mode
        await testUtils.form.clickEdit(form);
        await testUtils.fields.editInput(form.$('input[name=foo]'), 'let us trigger an onchange');
        var $o2m = form.$('.o-field-one2many');
        assert.strictEqual($o2m.find('.o-data-row').length, 2,
            "there should be two linked record");
        assert.strictEqual($o2m.find('.o-data-row:first td:first').text(), 'updated record',
            "the 'displayName' of the first one2many record should have been updated");
        assert.strictEqual($o2m.find('.o-data-row:nth(1) td:first').text(), 'created record',
            "the 'displayName' of the second one2many record should be correct");

        form.destroy();
    });

    QUnit.test('properly apply onchange on one2many fields direct click', async function (assert) {
        assert.expect(3);

        var def = testUtils.makeTestPromise();

        this.data.partner.records[0].p = [2, 4];
        this.data.partner.onchanges = {
            int_field: function (obj) {
                obj.p = [
                    [5],
                    [1, 2, {displayName: "updated record 1", int_field: obj.int_field}],
                    [1, 4, {displayName: "updated record 2", int_field: obj.int_field * 2}],
                ];
            },
        };

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<group>' +
                        '<field name="foo"/>' +
                        '<field name="int_field"/>' +
                    '</group>' +
                    '<field name="p">' +
                        '<tree>' +
                            '<field name="displayName"/>' +
                            '<field name="int_field"/>' +
                        '</tree>' +
                    '</field>' +
                '</form>',
            resId: 1,
            mockRPC: function (route, args) {
                if (args.method === 'onchange') {
                    var self = this;
                    var my_args = arguments;
                    var my_super = this._super;
                    return def.then(() => {
                        return my_super.apply(self, my_args)
                    });
                }
                return this._super.apply(this, arguments);
            },
            archs: {
                'partner,false,form': '<form><group><field name="displayName"/><field name="int_field"/></group></form>'
            },
            viewOptions: {
                mode: 'edit',
            },
        });
        // Trigger the onchange
        await testUtils.fields.editInput(form.$('input[name=int_field]'), '2');

        // Open first record in one2many
        await testUtils.dom.click(form.$('.o-data-row:first'));

        assert.containsNone(document.body, '.modal');

        def.resolve();
        await testUtils.nextTick();

        assert.containsOnce(document.body, '.modal');
        assert.strictEqual($('.modal').find('input[name=int_field]').val(), '2');

        form.destroy();
    });

    QUnit.test('update many2many value in one2many after onchange', async function (assert) {
        assert.expect(2);

        this.data.partner.records[1].p = [4];
        this.data.partner.onchanges = {
            foo: function (obj) {
                obj.p = [
                    [5],
                    [1, 4, {
                        displayName: "gold",
                        timmy: [[5]],
                    }],
                ];
            },
        };
        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form>' +
                    '<field name="foo"/>' +
                    '<field name="p">' +
                        '<tree editable="top">' +
                            '<field name="displayName" attrs="{\'readonly\': [(\'timmy\', \'=\', false)]}"/>' +
                            '<field name="timmy"/>' +
                        '</tree>' +
                    '</field>' +
                '</form>',
            resId: 2,
        });
        assert.strictEqual($('div[name="p"] .o-data-row td').text().trim(), "aaaNo records",
            "should have proper initial content");
        await testUtils.form.clickEdit(form);

        await testUtils.fields.editInput(form.$('input[name=foo]'), 'tralala');

        assert.strictEqual($('div[name="p"] .o-data-row td').text().trim(), "goldNo records",
            "should have proper initial content");
        form.destroy();
    });

    QUnit.test('delete a line in a one2many while editing another line', async function (assert) {
        assert.expect(2);

        this.data.partner.records[0].p = [1, 2];

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form>' +
                    '<field name="p">' +
                        '<tree editable="bottom">' +
                            '<field name="displayName" required="true"/>' +
                        '</tree>' +
                    '</field>' +
                '</form>',
            resId: 1,
        });

        await testUtils.form.clickEdit(form);
        await testUtils.dom.click(form.$('.o-data-cell').first());
        await testUtils.fields.editInput(form.$('input[name=displayName]'), '');
        await testUtils.dom.click(form.$('.fa-trash-o').eq(1));

        // use of owlCompatibilityExtraNextTick because there are two sequential updates of the
        // control panel (which is written in owl): each of them waits for the next animation frame
        // to complete
        await testUtils.owlCompatibilityExtraNextTick();
        assert.hasClass(form.$('.o-data-cell').first(), "o-invalid-cell",
            "Cell should be invalidated.");
        assert.containsN(form, '.o-data-row', 2,
            "The other line should not have been deleted.");
        form.destroy();
    });

    QUnit.test('properly apply onchange on many2many fields', async function (assert) {
        assert.expect(14);

        this.data.partner.onchanges = {
            foo: function (obj) {
                obj.timmy = [
                    [5],
                    [4, 12],
                    [4, 14],
                ];
            },
        };
        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<group><field name="foo"/></group>' +
                    '<field name="timmy">' +
                        '<tree>' +
                            '<field name="displayName"/>' +
                        '</tree>' +
                    '</field>' +
                '</form>',
            mockRPC: function (route, args) {
                assert.step(args.method);
                if (args.method === 'read' && args.model === 'partner_type') {
                    assert.deepEqual(args.args[0], [12, 14],
                        "should read both m2m with one RPC");
                }
                if (args.method === 'write') {
                    assert.deepEqual(args.args[1].timmy, [[6, false, [12, 14]]],
                        "should correctly save the changed m2m values");

                }
                return this._super.apply(this, arguments);
            },
            resId: 2,
        });

        assert.containsNone(form, '.o-field-many2many .o-data-row',
            "there should be no many2many record linked at first");

        // switch to edit mode
        await testUtils.form.clickEdit(form);
        await testUtils.fields.editInput(form.$('input[name=foo]'), 'let us trigger an onchange');
        var $m2m = form.$('.o-field-many2many');
        assert.strictEqual($m2m.find('.o-data-row').length, 2,
            "there should be two linked records");
        assert.strictEqual($m2m.find('.o-data-row:first td:first').text(), 'gold',
            "the 'displayName' of the first m2m record should be correctly displayed");
        assert.strictEqual($m2m.find('.o-data-row:nth(1) td:first').text(), 'silver',
            "the 'displayName' of the second m2m record should be correctly displayed");

        await testUtils.form.clickSave(form);

        assert.verifySteps(['read', 'onchange', 'read', 'write', 'read', 'read']);

        form.destroy();
    });

    QUnit.test('form with domain widget: opening a many2many form and save should not crash', async function (assert) {
        assert.expect(0);

        // We just test that there is no crash in this situation
        this.data.partner.records[0].timmy = [12];
        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch:
                `<form string="Partners">
                    <group>
                        <field name="foo" widget="domain"/>
                    </group>
                    <field name="timmy">
                        <tree>
                            <field name="displayName"/>
                        </tree>
                        <form>
                            <field name="label"/>
                            <field name="color"/>
                        </form>
                    </field>
                </form>`,
            resId: 1,
        });

        // switch to edit mode
        await testUtils.form.clickEdit(form);

        // open a form view and save many2many record
        await testUtils.dom.click(form.$('.o-data-row .o-data-cell:first'));
        await testUtils.dom.click($('.modal-dialog footer button:first-child'));

        form.destroy();
    });

    QUnit.test('displayName not sent for onchanges if not in view', async function (assert) {
        assert.expect(7);

        this.data.partner.records[0].timmy = [12];
        this.data.partner.onchanges = {
            foo: function () {},
        };
        this.data.partner_type.onchanges = {
            name: function () {},
        };
        var readInModal = false;
        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<group>' +
                        '<field name="foo"/>' +
                        '<field name="timmy">' +
                            '<tree>' +
                                '<field name="label"/>' +
                            '</tree>' +
                            '<form>' +
                                '<field name="label"/>' +
                                '<field name="color"/>' +
                            '</form>' +
                        '</field>' +
                    '</group>' +
                '</form>',
            mockRPC: function (route, args) {
                if (args.method === 'read' && args.model === 'partner') {
                    assert.deepEqual(args.args[1], ['foo', 'timmy', 'displayName'],
                        "should read displayName even if not in the view");
                }
                if (args.method === 'read' && args.model === 'partner_type') {
                    if (!readInModal) {
                        assert.deepEqual(args.args[1], ['name'],
                            "should not read displayName for records in the list");
                    } else {
                        assert.deepEqual(args.args[1], ['name', 'color', 'displayName'],
                            "should read displayName when opening the subrecord");
                    }
                }
                if (args.method === 'onchange' && args.model === 'partner') {
                    assert.deepEqual(args.args[1], {
                        id: 1,
                        foo: 'coucou',
                        timmy: [[6, false, [12]]],
                    }, "should only send the value of fields in the view (+ id)");
                    assert.deepEqual(args.args[3], {
                        foo: '1',
                        timmy: '',
                        'timmy.name': '1',
                        'timmy.color': '',
                    }, "only the fields in the view should be in the onchange spec");
                }
                if (args.method === 'onchange' && args.model === 'partner_type') {
                    assert.deepEqual(args.args[1], {
                        id: 12,
                        name: 'new name',
                        color: 2,
                    }, "should only send the value of fields in the view (+ id)");
                    assert.deepEqual(args.args[3], {
                        name: '1',
                        color: '',
                    }, "only the fields in the view should be in the onchange spec");
                }
                return this._super.apply(this, arguments);
            },
            resId: 1,
            viewOptions: {
                mode: 'edit',
            },
        });

        // trigger the onchange
        await testUtils.fields.editInput(form.$('.o-field-widget[name=foo]'), "coucou");

        // open a subrecord and trigger an onchange
        readInModal = true;
        await testUtils.dom.click(form.$('.o-data-row .o-data-cell:first'));
        await testUtils.fields.editInput($('.modal .o-field-widget[name=name]'), "new name");

        form.destroy();
    });

    QUnit.test('onchanges on date(time) fields', async function (assert) {
        assert.expect(6);

        this.data.partner.onchanges = {
            foo: function (obj) {
                obj.date = '2021-12-12';
                obj.datetime = '2021-12-12 10:55:05';
            },
        };
        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<group>' +
                        '<field name="foo"/>' +
                        '<field name="date"/>' +
                        '<field name="datetime"/>' +
                    '</group>' +
                '</form>',
            resId: 1,
            session: {
                getTZOffset: function () {
                    return 120;
                },
            },
        });

        assert.strictEqual(form.$('.o-field-widget[name=date]').text(),
            '01/25/2017', "the initial date should be correct");
        assert.strictEqual(form.$('.o-field-widget[name=datetime]').text(),
            '12/12/2016 12:55:05', "the initial datetime should be correct");

        await testUtils.form.clickEdit(form);

        assert.strictEqual(form.$('.o-field-widget[name=date] input').val(),
            '01/25/2017', "the initial date should be correct in edit");
        assert.strictEqual(form.$('.o-field-widget[name=datetime] input').val(),
            '12/12/2016 12:55:05', "the initial datetime should be correct in edit");

        // trigger the onchange
        await testUtils.fields.editInput(form.$('.o-field-widget[name="foo"]'), "coucou");

        assert.strictEqual(form.$('.o-field-widget[name=date] input').val(),
            '12/12/2021', "the initial date should be correct in edit");
        assert.strictEqual(form.$('.o-field-widget[name=datetime] input').val(),
            '12/12/2021 12:55:05', "the initial datetime should be correct in edit");

        form.destroy();
    });

    QUnit.test('onchanges are not sent for each keystrokes', async function (assert) {
        var done = assert.async();
        assert.expect(5);

        var onchangeNbr = 0;

        this.data.partner.onchanges = {
            foo: function (obj) {
                obj.int_field = obj.foo.length + 1000;
            },
        };
        var def = testUtils.makeTestPromise();
        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form>' +
                    '<group><field name="foo"/><field name="int_field"/></group>' +
                '</form>',
            resId: 2,
            fieldDebounce: 3,
            mockRPC: function (route, args) {
                var result = this._super.apply(this, arguments);
                if (args.method === 'onchange') {
                    onchangeNbr++;
                    return concurrency.delay(3).then(function () {
                        def.resolve();
                        return result;
                    });
                }
                return result;
            },
        });

        await testUtils.form.clickEdit(form);

        testUtils.fields.editInput(form.$('input[name=foo]'), '1');
        assert.strictEqual(onchangeNbr, 0, "no onchange has been called yet");
        testUtils.fields.editInput(form.$('input[name=foo]'), '12');
        assert.strictEqual(onchangeNbr, 0, "no onchange has been called yet");

        return waitForFinishedOnChange().then(async function () {
            assert.strictEqual(onchangeNbr, 1, "one onchange has been called");

            // add something in the input, then focus another input
            await testUtils.fields.editAndTrigger(form.$('input[name=foo]'), '123', ['change']);
            assert.strictEqual(onchangeNbr, 2, "one onchange has been called immediately");

            return waitForFinishedOnChange();
        }).then(function () {
            assert.strictEqual(onchangeNbr, 2, "no extra onchange should have been called");

            form.destroy();
            done();
        });

        function waitForFinishedOnChange() {
            return def.then(function () {
                def = testUtils.makeTestPromise();
                return concurrency.delay(0);
            });
        }
    });

    QUnit.test('onchanges are not sent for invalid values', async function (assert) {
        assert.expect(6);

        this.data.partner.onchanges = {
            int_field: function (obj) {
                obj.foo = String(obj.int_field);
            },
        };
        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form>' +
                    '<group><field name="foo"/><field name="int_field"/></group>' +
                '</form>',
            resId: 2,
            mockRPC: function (route, args) {
                assert.step(args.method);
                return this._super.apply(this, arguments);
            },
        });

        await testUtils.form.clickEdit(form);

        // edit int_field, and check that an onchange has been applied
        await testUtils.fields.editInput(form.$('input[name="int_field"]'), "123");
        assert.strictEqual(form.$('input[name="foo"]').val(), "123",
            "the onchange has been applied");

        // enter an invalid value in a float, and check that no onchange has
        // been applied
        await testUtils.fields.editInput(form.$('input[name="int_field"]'), "123a");
        assert.strictEqual(form.$('input[name="foo"]').val(), "123",
            "the onchange has not been applied");

        // save, and check that the int_field input is marked as invalid
        await testUtils.form.clickSave(form);
        assert.hasClass(form.$('input[name="int_field"]'),'o-field-invalid',
            "input int_field is marked as invalid");

        assert.verifySteps(['read', 'onchange']);
        form.destroy();
    });

    QUnit.test('rpc complete after destroying parent', async function (assert) {
        // We just test that there is no crash in this situation
        assert.expect(0);
        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form>' +
                    '<button name="update_module" type="object" class="o-form-button_update"/>' +
                '</form>',
            resId: 2,
            intercepts: {
                execute_action: function (event) {
                    form.destroy();
                    event.data.onSuccess();
                }
            }
        });
        await testUtils.dom.click(form.$('.o-form-button_update'));
    });

    QUnit.test('onchanges that complete after discarding', async function (assert) {
        assert.expect(6);

        var def1 = testUtils.makeTestPromise();

        this.data.partner.onchanges = {
            foo: function (obj) {
                obj.int_field = obj.foo.length + 1000;
            },
        };
        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form>' +
                    '<group><field name="foo"/><field name="int_field"/></group>' +
                '</form>',
            resId: 2,
            mockRPC: function (route, args) {
                var result = this._super.apply(this, arguments);
                if (args.method === 'onchange') {
                    assert.step('onchange is done');
                    return def1.then(function () {
                        return result;
                    });
                }
                return result;
            },
        });

        // go into edit mode
        assert.strictEqual(form.$('span[name="foo"]').text(), "blip",
            "field foo should be displayed to initial value");
        await testUtils.form.clickEdit(form);

        // edit a value
        await testUtils.fields.editInput(form.$('input[name=foo]'), '1234');

        // discard changes
        await testUtils.form.clickDiscard(form);
        assert.containsNone(form, '.modal');
        assert.strictEqual(form.$('span[name="foo"]').text(), "blip",
            "field foo should still be displayed to initial value");

        // complete the onchange
        def1.resolve();
        await testUtils.nextTick();
        assert.strictEqual(form.$('span[name="foo"]').text(), "blip",
            "field foo should still be displayed to initial value");
        assert.verifySteps(['onchange is done']);

        form.destroy();
    });

    QUnit.test('discarding before save returns', async function (assert) {
        assert.expect(4);

        var def = testUtils.makeTestPromise();

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form>' +
                    '<group><field name="foo"/></group>' +
                '</form>',
            resId: 2,
            mockRPC: function (route, args) {
                var result = this._super.apply(this, arguments);
                if (args.method === 'write') {
                    return def.then(_.constant(result));
                }
                return result;
            },
            viewOptions: {
                mode: 'edit',
            },
        });

        await testUtils.fields.editInput(form.$('input[name=foo]'), '1234');

        // save the value and discard directly
        await testUtils.form.clickSave(form);
        form.discardChanges();

        assert.strictEqual(form.$('.o-field-widget[name="foo"]').val(), "1234",
            "field foo should still contain new value");
        assert.strictEqual($('.modal').length, 0,
            "Confirm dialog should not be displayed");

        // complete the write
        def.resolve();
        await testUtils.nextTick();
        assert.strictEqual($('.modal').length, 0,
            "Confirm dialog should not be displayed");
        assert.strictEqual(form.$('.o-field-widget[name="foo"]').text(), "1234",
            "value should have been saved and rerendered in readonly");

        form.destroy();
    });

    QUnit.test('unchanged relational data is sent for onchanges', async function (assert) {
        assert.expect(1);

        this.data.partner.records[1].p = [4];
        this.data.partner.onchanges = {
            foo: function (obj) {
                obj.int_field = obj.foo.length + 1000;
            },
        };
        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form>' +
                    '<group>' +
                        '<field name="foo"/>' +
                        '<field name="int_field"/>' +
                        '<field name="p">' +
                            '<tree>' +
                                '<field name="foo"/>' +
                                '<field name="bar"/>' +
                            '</tree>' +
                        '</field>' +
                    '</group>' +
                '</form>',
            resId: 2,
            mockRPC: function (route, args) {
                if (args.method === 'onchange') {
                    assert.deepEqual(args.args[1].p, [[4, 4, false]],
                        "should send a command for field p even if it hasn't changed");
                }
                return this._super.apply(this, arguments);
            },
        });

        await testUtils.form.clickEdit(form);
        await testUtils.fields.editInput(form.$('input[name=foo]'), 'trigger an onchange');

        form.destroy();
    });

    QUnit.test('onchanges on unknown fields of o2m are ignored', async function (assert) {
        // many2one fields need to be postprocessed (the onchange returns [id,
        // displayName]), but if we don't know the field, we can't know it's a
        // many2one, so it isn't ignored, its value is an array instead of a
        // dataPoint id, which may cause errors later (e.g. when saving).
        assert.expect(2);

        this.data.partner.records[1].p = [4];
        this.data.partner.onchanges = {
            foo: function () {},
        };
        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form>' +
                    '<group>' +
                        '<field name="foo"/>' +
                        '<field name="int_field"/>' +
                        '<field name="p">' +
                            '<tree>' +
                                '<field name="foo"/>' +
                                '<field name="bar"/>' +
                            '</tree>' +
                            '<form>' +
                                '<field name="foo"/>' +
                                '<field name="productId"/>' +
                            '</form>' +
                        '</field>' +
                    '</group>' +
                '</form>',
            resId: 2,
            mockRPC: function (route, args) {
                if (args.method === 'onchange') {
                    return Promise.resolve({
                        value: {
                            p: [
                                [5],
                                [1, 4, {
                                    foo: 'foo changed',
                                    productId: [37, "xphone"],
                                }]
                            ],
                        },
                    });
                }
                if (args.method === 'write') {
                    assert.deepEqual(args.args[1].p, [[1, 4, {
                        foo: 'foo changed',
                    }]], "should only write value of known fields");
                }
                return this._super.apply(this, arguments);
            },
        });

        await testUtils.form.clickEdit(form);
        await testUtils.fields.editInput(form.$('input[name=foo]'), 'trigger an onchange');
        await testUtils.owlCompatibilityExtraNextTick();

        assert.strictEqual(form.$('.o-data-row td:first').text(), 'foo changed',
            "onchange should have been correctly applied on field in o2m list");

        await testUtils.form.clickSave(form);

        form.destroy();
    });

    QUnit.test('onchange value are not discarded on o2m edition', async function (assert) {
        assert.expect(4);

        this.data.partner.records[1].p = [4];
        this.data.partner.onchanges = {
            foo: function () {},
        };
        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form>' +
                    '<group>' +
                        '<field name="foo"/>' +
                        '<field name="int_field"/>' +
                        '<field name="p">' +
                            '<tree>' +
                                '<field name="foo"/>' +
                                '<field name="bar"/>' +
                            '</tree>' +
                            '<form>' +
                                '<field name="foo"/>' +
                                '<field name="productId"/>' +
                            '</form>' +
                        '</field>' +
                    '</group>' +
                '</form>',
            resId: 2,
            mockRPC: function (route, args) {
                if (args.method === 'onchange') {
                    return Promise.resolve({
                        value: {
                            p: [[5], [1, 4, {foo: 'foo changed'}]],
                        },
                    });
                }
                if (args.method === 'write') {
                    assert.deepEqual(args.args[1].p, [[1, 4, {
                        foo: 'foo changed',
                    }]], "should only write value of known fields");
                }
                return this._super.apply(this, arguments);
            },
        });

        await testUtils.form.clickEdit(form);

        assert.strictEqual(form.$('.o-data-row td:first').text(), 'My little Foo Value',
            "the initial value should be the default one");

        await testUtils.fields.editInput(form.$('input[name=foo]'), 'trigger an onchange');
        await testUtils.owlCompatibilityExtraNextTick();

        assert.strictEqual(form.$('.o-data-row td:first').text(), 'foo changed',
            "onchange should have been correctly applied on field in o2m list");

        await testUtils.dom.click(form.$('.o-data-row'));
        assert.strictEqual($('.modal .modal-title').text().trim(), 'Open: one2many field',
            "the field string is displayed in the modal title");
        assert.strictEqual($('.modal .o-field-widget').val(), 'foo changed',
            "the onchange value hasn't been discarded when opening the o2m");

        form.destroy();
    });

    QUnit.test('args of onchanges in o2m fields are correct (inline edition)', async function (assert) {
        assert.expect(3);

        this.data.partner.records[1].p = [4];
        this.data.partner.fields.p.relationField = 'rel_field';
        this.data.partner.fields.int_field.default = 14;
        this.data.partner.onchanges = {
            int_field: function (obj) {
                obj.foo = '[' + obj.rel_field.foo + '] ' + obj.int_field;
            },
        };
        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form>' +
                    '<group>' +
                        '<field name="foo"/>' +
                        '<field name="p">' +
                            '<tree editable="top">' +
                                '<field name="foo"/>' +
                                '<field name="int_field"/>' +
                            '</tree>' +
                        '</field>' +
                    '</group>' +
                '</form>',
            resId: 2,
        });

        await testUtils.form.clickEdit(form);

        assert.strictEqual(form.$('.o-data-row td:first').text(), 'My little Foo Value',
            "the initial value should be the default one");

        await testUtils.dom.click(form.$('.o-data-row td:nth(1)'));
        await testUtils.fields.editInput(form.$('.o-data-row input:nth(1)'), 77);

        assert.strictEqual(form.$('.o-data-row input:first').val(), '[blip] 77',
            "onchange should have been correctly applied");

        // create a new o2m record
        await testUtils.dom.click(form.$('.o-field-x2many-list-row-add a'));
        assert.strictEqual(form.$('.o-data-row input:first').val(), '[blip] 14',
            "onchange should have been correctly applied after default get");

        form.destroy();
    });

    QUnit.test('args of onchanges in o2m fields are correct (dialog edition)', async function (assert) {
        assert.expect(6);

        this.data.partner.records[1].p = [4];
        this.data.partner.fields.p.relationField = 'rel_field';
        this.data.partner.fields.int_field.default = 14;
        this.data.partner.onchanges = {
            int_field: function (obj) {
                obj.foo = '[' + obj.rel_field.foo + '] ' + obj.int_field;
            },
        };
        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form>' +
                    '<group>' +
                        '<field name="foo"/>' +
                        '<field name="p" string="custom label">' +
                            '<tree>' +
                                '<field name="foo"/>' +
                            '</tree>' +
                            '<form>' +
                                '<field name="foo"/>' +
                                '<field name="int_field"/>' +
                            '</form>' +
                        '</field>' +
                    '</group>' +
                '</form>',
            resId: 2,
        });

        await testUtils.form.clickEdit(form);

        assert.strictEqual(form.$('.o-data-row td:first').text(), 'My little Foo Value',
            "the initial value should be the default one");

        await testUtils.dom.click(form.$('.o-data-row td:first'));
        await testUtils.nextTick();
        await testUtils.fields.editInput($('.modal input:nth(1)'), 77);
        assert.strictEqual($('.modal input:first').val(), '[blip] 77',
            "onchange should have been correctly applied");
        await testUtils.dom.click($('.modal-footer .btn-primary'));
        assert.strictEqual(form.$('.o-data-row td:first').text(), '[blip] 77',
            "onchange should have been correctly applied");

        // create a new o2m record
        await testUtils.dom.click(form.$('.o-field-x2many-list-row-add a'));
        assert.strictEqual($('.modal .modal-title').text().trim(), 'Create custom label',
            "the custom field label is applied in the modal title");
        assert.strictEqual($('.modal input:first').val(), '[blip] 14',
            "onchange should have been correctly applied after default get");
        await testUtils.dom.clickFirst($('.modal-footer .btn-primary'));
        await testUtils.nextTick();
        assert.strictEqual(form.$('.o-data-row:nth(1) td:first').text(), '[blip] 14',
            "onchange should have been correctly applied after default get");

        form.destroy();
    });

    QUnit.test('context of onchanges contains the context of changed fields', async function (assert) {
        assert.expect(2);

        this.data.partner.onchanges = {
            foo: function () {},
        };
        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form>' +
                    '<group>' +
                        '<field name="foo" context="{\'test\': 1}"/>' +
                        '<field name="int_field" context="{\'int_ctx\': 1}"/>' +
                    '</group>' +
                '</form>',
            mockRPC: function (route, args) {
                if (args.method === 'onchange') {
                    assert.strictEqual(args.kwargs.context.test, 1,
                        "the context of the field triggering the onchange should be given");
                    assert.strictEqual(args.kwargs.context.int_ctx, undefined,
                        "the context of other fields should not be given");
                }
                return this._super.apply(this, arguments);
            },
            resId: 2,
        });

        await testUtils.form.clickEdit(form);
        await testUtils.fields.editInput(form.$('input[name=foo]'), 'coucou');

        form.destroy();
    });

    QUnit.test('navigation with tab key in form view', async function (assert) {
        assert.expect(3);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<group>' +
                            '<field name="foo" widget="email"/>' +
                            '<field name="bar"/>' +
                            '<field name="displayName" widget="url"/>' +
                        '</group>' +
                    '</sheet>' +
                '</form>',
            resId: 2,
        });

        // go to edit mode
        await testUtils.form.clickEdit(form);

        // focus first input, trigger tab
        form.$('input[name="foo"]').focus();

        const tabKey = { keyCode: $.ui.keyCode.TAB, which: $.ui.keyCode.TAB };
        await testUtils.dom.triggerEvent(form.$('input[name="foo"]'), 'keydown', tabKey);
        assert.ok($.contains(form.$('div[name="bar"]')[0], document.activeElement),
            "bar checkbox should be focused");

        await testUtils.dom.triggerEvent(document.activeElement, 'keydown', tabKey);
        assert.strictEqual(form.$('input[name="displayName"]')[0], document.activeElement,
            "displayName should be focused");

        // simulate shift+tab on active element
        const shiftTabKey = Object.assign({}, tabKey, { shiftKey: true });
        await testUtils.dom.triggerEvent(document.activeElement, 'keydown', shiftTabKey);
        await testUtils.dom.triggerEvent(document.activeElement, 'keydown', shiftTabKey);
        assert.strictEqual(document.activeElement, form.$('input[name="foo"]')[0],
            "first input should be focused");

        form.destroy();
    });

    QUnit.test('navigation with tab key in readonly form view', async function (assert) {
        assert.expect(3);

        this.data.partner.records[1].productId = 37;

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<group>' +
                            '<field name="trululu"/>' +
                            '<field name="foo"/>' +
                            '<field name="productId"/>' +
                            '<field name="foo" widget="phone"/>' +
                            '<field name="displayName" widget="url"/>' +
                        '</group>' +
                    '</sheet>' +
                '</form>',
            resId: 2,
        });

        // focus first field, trigger tab
        form.$('[name="trululu"]').focus();
        form.$('[name="trululu"]').trigger($.Event('keydown', {which: $.ui.keyCode.TAB}));
        form.$('[name="foo"]').trigger($.Event('keydown', {which: $.ui.keyCode.TAB}));
        assert.strictEqual(form.$('[name="productId"]')[0], document.activeElement,
            "productId should be focused");
        form.$('[name="productId"]').trigger($.Event('keydown', {which: $.ui.keyCode.TAB}));
        form.$('[name="foo"]:eq(1)').trigger($.Event('keydown', {which: $.ui.keyCode.TAB}));
        assert.strictEqual(form.$('div[name="displayName"].o-field-url > a')[0], document.activeElement,
            "displayName should be focused");

        // simulate shift+tab on active element
        $(document.activeElement).trigger($.Event('keydown', {which: $.ui.keyCode.TAB, shiftKey: true}));
        $(document.activeElement).trigger($.Event('keydown', {which: $.ui.keyCode.TAB, shiftKey: true}));
        $(document.activeElement).trigger($.Event('keydown', {which: $.ui.keyCode.TAB, shiftKey: true}));
        $(document.activeElement).trigger($.Event('keydown', {which: $.ui.keyCode.TAB, shiftKey: true}));
        assert.strictEqual(document.activeElement, form.$('[name="trululu"]')[0],
            "first many2one should be focused");

        form.destroy();
    });

    QUnit.test('skip invisible fields when navigating with TAB', async function (assert) {
        assert.expect(1);

        this.data.partner.records[0].bar = true;

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet><group>' +
                        '<field name="foo"/>' +
                        '<field name="bar" invisible="1"/>' +
                        '<field name="productId" attrs=\'{"invisible": [["bar", "=", true]]}\'/>' +
                        '<field name="int_field"/>' +
                    '</group></sheet>' +
                '</form>',
            resId: 1,
        });

        await testUtils.form.clickEdit(form);
        form.$('input[name="foo"]').focus();
        form.$('input[name="foo"]').trigger($.Event('keydown', {which: $.ui.keyCode.TAB}));
        assert.strictEqual(form.$('input[name="int_field"]')[0], document.activeElement,
            "int_field should be focused");

        form.destroy();
    });

    QUnit.test('navigation with tab key selects a value in form view', async function (assert) {
        assert.expect(5);

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `
                <form>
                    <field name="displayName"/>
                    <field name="int_field"/>
                    <field name="qux"/>
                    <field name="trululu"/>
                    <field name="date"/>
                    <field name="datetime"/>
                </form>`,
            resId: 1,
            viewOptions: {
                mode: 'edit',
            },
        });

        await testUtils.dom.click(form.el.querySelector('input[name="displayName"]'));
        await testUtils.fields.triggerKeydown(document.activeElement, 'tab');
        assert.strictEqual(document.getSelection().toString(), "10",
            "int_field value should be selected");

        await testUtils.fields.triggerKeydown(document.activeElement, 'tab');
        assert.strictEqual(document.getSelection().toString(), "0.4",
            "qux field value should be selected");

        await testUtils.fields.triggerKeydown(document.activeElement, 'tab');
        assert.strictEqual(document.getSelection().toString(), "aaa",
            "trululu field value should be selected");

        await testUtils.fields.triggerKeydown(document.activeElement, 'tab');
        assert.strictEqual(document.getSelection().toString(), "01/25/2017",
            "date field value should be selected");

        await testUtils.fields.triggerKeydown(document.activeElement, 'tab');
        assert.strictEqual(document.getSelection().toString(), "12/12/2016 10:55:05",
            "datetime field value should be selected");

        form.destroy();
    });

    QUnit.test('clicking on a stat button with a context', async function (assert) {
        assert.expect(1);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch:
                '<form string="Partners">' +
                    '<sheet>' +
                        '<div class="oe-button-box" name="buttonBox">' +
                            '<button class="oe-stat-button" type="action" name="1" context="{\'test\': activeId}">' +
                                '<field name="qux" widget="statinfo"/>' +
                            '</button>' +
                        '</div>' +
                    '</sheet>' +
                '</form>',
            resId: 2,
            viewOptions: {
                context: {some_context: true},
            },
            intercepts: {
                execute_action: function (e) {
                    assert.deepEqual(e.data.actionData.context, {
                        'test': 2
                    }, "button context should have been evaluated and given to the action, with magicc without previous context");
                },
            },
        });

        await testUtils.dom.click(form.$('.oe-stat-button'));

        form.destroy();
    });

    QUnit.test('clicking on a stat button with no context', async function (assert) {
        assert.expect(1);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch:
                '<form string="Partners">' +
                    '<sheet>' +
                        '<div class="oe-button-box" name="buttonBox">' +
                            '<button class="oe-stat-button" type="action" name="1">' +
                                '<field name="qux" widget="statinfo"/>' +
                            '</button>' +
                        '</div>' +
                    '</sheet>' +
                '</form>',
            resId: 2,
            viewOptions: {
                context: {some_context: true},
            },
            intercepts: {
                execute_action: function (e) {
                    assert.deepEqual(e.data.actionData.context, {
                    }, "button context should have been evaluated and given to the action, with magic keys but without previous context");
                },
            },
        });

        await testUtils.dom.click(form.$('.oe-stat-button'));

        form.destroy();
    });

    QUnit.test('diplay a stat button outside a buttonbox', async function (assert) {
        assert.expect(3);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch:
                '<form string="Partners">' +
                    '<sheet>' +
                        '<button class="oe-stat-button" type="action" name="1">' +
                            '<field name="int_field" widget="statinfo"/>' +
                        '</button>' +
                    '</sheet>' +
                '</form>',
            resId: 2,
        });

        assert.containsOnce(form, 'button .o-field-widget',
            "a field widget should be display inside the button");
        assert.strictEqual(form.$('button .o-field-widget').children().length, 2,
            "the field widget should have 2 children, the text and the value");
        assert.strictEqual(parseInt(form.$('button .o-field-widget .o-stat-value').text()), 9,
            "the value rendered should be the same as the field value");
        form.destroy();
    });

    QUnit.test('diplay something else than a button in a buttonbox', async function (assert) {
        assert.expect(3);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form>' +
                    '<div name="buttonBox" class="oe-button-box">' +
                        '<button type="object" class="oe-stat-button" icon="fa-check-square">' +
                            '<field name="bar"/>' +
                        '</button>' +
                        '<label/>' +
                    '</div>' +
                '</form>',
            resId: 2,
        });

        assert.strictEqual(form.$('.oe-button-box').children().length, 2,
            "button box should contain two children");
        assert.containsOnce(form, '.oe-button-box > .oe-stat-button',
            "button box should only contain one button");
        assert.containsOnce(form, '.oe-button-box > label',
            "button box should only contain one label");

        form.destroy();
    });

    QUnit.test('invisible fields are not considered as visible in a buttonbox', async function (assert) {
        assert.expect(2);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form>' +
                '<div name="buttonBox" class="oe-button-box">' +
                    '<field name="foo" invisible="1"/>' +
                    '<field name="bar" invisible="1"/>' +
                    '<field name="int_field" invisible="1"/>' +
                    '<field name="qux" invisible="1"/>' +
                    '<field name="displayName" invisible="1"/>' +
                    '<field name="state" invisible="1"/>' +
                    '<field name="date" invisible="1"/>' +
                    '<field name="datetime" invisible="1"/>' +
                    '<button type="object" class="oe-stat-button" icon="fa-check-square"/>' +
                '</div>' +
                '</form>',
            resId: 2,
        });

        assert.strictEqual(form.$('.oe-button-box').children().length, 1,
            "button box should contain only one child");
        assert.hasClass(form.$('.oe-button-box'), 'o-not-full',
            "the buttonbox should not be full");

        form.destroy();
    });

    QUnit.test('display correctly buttonbox, in large size class', async function (assert) {
        assert.expect(1);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form>' +
                    '<div name="buttonBox" class="oe-button-box">' +
                        '<button type="object" class="oe-stat-button" icon="fa-check-square">' +
                            '<field name="bar"/>' +
                        '</button>' +
                        '<button type="object" class="oe-stat-button" icon="fa-check-square">' +
                            '<field name="foo"/>' +
                        '</button>' +
                    '</div>' +
                '</form>',
            resId: 2,
            config: {
                device: {size_class: 5},
            },
        });

        assert.strictEqual(form.$('.oe-button-box').children().length, 2,
            "button box should contain two children");

        form.destroy();
    });

    QUnit.test('one2many default value creation', async function (assert) {
        assert.expect(1);

        this.data.partner.records[0].productIds = [37];
        this.data.partner.fields.productIds.default = [
            [0, 0, { name: 'xdroid', partner_type_id: 12 }]
        ];

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<group>' +
                            '<field name="productIds" nolabel="1">' +
                                '<tree editable="top" create="0">' +
                                    '<field name="label" readonly="1"/>' +
                                '</tree>' +
                            '</field>' +
                        '</group>' +
                    '</sheet>' +
                '</form>',
            mockRPC: function (route, args) {
                if (args.method === 'create') {
                    var command = args.args[0].productIds[0];
                    assert.strictEqual(command[2].partner_type_id, 12,
                        "the default partner_type_id should be equal to 12");
                }
                return this._super.apply(this, arguments);
            },
        });
        await testUtils.form.clickSave(form);
        form.destroy();
    });

    QUnit.test('many2manys inside one2manys are saved correctly', async function (assert) {
        assert.expect(1);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<field name="p">' +
                            '<tree editable="top">' +
                                '<field name="timmy" widget="many2manyTags"/>' +
                            '</tree>' +
                        '</field>' +
                    '</sheet>' +
                '</form>',
            mockRPC: function (route, args) {
                if (args.method === 'create') {
                    var command = args.args[0].p;
                    assert.deepEqual(command, [[0, command[0][1], {
                        timmy: [[6, false, [12]]],
                    }]], "the default partner_type_id should be equal to 12");
                }
                return this._super.apply(this, arguments);
            },
        });

        // add a o2m subrecord with a m2m tag
        await testUtils.dom.click(form.$('.o-field-x2many-list-row-add a'));
        await testUtils.fields.many2one.clickOpenDropdown('timmy');
        await testUtils.fields.many2one.clickHighlightedItem('timmy');

        await testUtils.form.clickSave(form);

        form.destroy();
    });

    QUnit.test('one2manys (list editable) inside one2manys are saved correctly', async function (assert) {
        assert.expect(3);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<field name="p">' +
                            '<tree>' +
                                '<field name="p"/>' +
                            '</tree>' +
                        '</field>' +
                    '</sheet>' +
                '</form>',
            archs: {
                "partner,false,form": '<form>' +
                        '<field name="p">' +
                            '<tree editable="top">' +
                                '<field name="displayName"/>' +
                            '</tree>' +
                        '</field>' +
                    '</form>'
            },
            mockRPC: function (route, args) {
                if (args.method === 'create') {
                    assert.deepEqual(args.args[0].p,
                        [[0, args.args[0].p[0][1], {
                            p: [[0, args.args[0].p[0][2].p[0][1], {displayName: "xtv"}]],
                        }]],
                        "create should be called with the correct arguments");
                }
                return this._super.apply(this, arguments);
            },
        });

        // add a o2m subrecord
        await testUtils.dom.click(form.$('.o-field-x2many-list-row-add a'));
        await testUtils.dom.click($('.modal-body .o-field-one2many .o-field-x2many-list-row-add a'));
        await testUtils.fields.editInput($('.modal-body input'), 'xtv');
        await testUtils.dom.click($('.modal-footer button:first'));
        assert.strictEqual($('.modal').length, 0,
            "dialog should be closed");

        var row = form.$('.o-field-one2many .o-list-view .o-data-row');
        assert.strictEqual(row.children()[0].textContent, '1 record',
            "the cell should contains the number of record: 1");

        await testUtils.form.clickSave(form);

        form.destroy();
    });

    QUnit.test('oe-read-only and oe-edit-only classNames on fields inside groups', async function (assert) {
        assert.expect(10);

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `
                <form>
                    <group>
                        <field name="foo" class="oe-read-only"/>
                        <field name="bar" class="oe-edit-only"/>
                    </group>
                </form>`,
            resId: 1,
        });

        assert.hasClass(form.$('.o-form-view'), 'o-form-readonly',
            'form should be in readonly mode');
        assert.isVisible(form.$('.o-field-widget[name=foo]'));
        assert.isVisible(form.$('label:contains(Foo)'));
        assert.isNotVisible(form.$('.o-field-widget[name=bar]'));
        assert.isNotVisible(form.$('label:contains(Bar)'));

        await testUtils.form.clickEdit(form);
        assert.hasClass(form.$('.o-form-view'), 'o-form-editable',
            'form should be in readonly mode');
        assert.isNotVisible(form.$('.o-field-widget[name=foo]'));
        assert.isNotVisible(form.$('label:contains(Foo)'));
        assert.isVisible(form.$('.o-field-widget[name=bar]'));
        assert.isVisible(form.$('label:contains(Bar)'));

        form.destroy();
    });

    QUnit.test('oe-read-only className is handled in list views', async function (assert) {
        assert.expect(7);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<field name="p">' +
                            '<tree editable="top">' +
                                '<field name="foo"/>' +
                                '<field name="displayName" class="oe-read-only"/>' +
                                '<field name="bar"/>' +
                            '</tree>' +
                        '</field>' +
                    '</sheet>' +
                '</form>',
            resId: 1,
        });

        assert.hasClass(form.$('.o-form-view'), 'o-form-readonly',
            'form should be in readonly mode');
        assert.isVisible(form.$('.o-field-one2many .o-list-view thead th[data-name="displayName"]'),
            'displayName cell should be visible in readonly mode');

        await testUtils.form.clickEdit(form);

        assert.strictEqual(form.el.querySelector('th[data-name="foo"]').style.width, '100%',
            'As the only visible char field, "foo" should take 100% of the remaining space');
        assert.strictEqual(form.el.querySelector('th.oe-read-only').style.width, '0px',
            '"oe-read-only" in edit mode should have a 0px width');

        assert.hasClass(form.$('.o-form-view'), 'o-form-editable',
            'form should be in edit mode');
        assert.isNotVisible(form.$('.o-field-one2many .o-list-view thead th[data-name="displayName"]'),
            'displayName cell should not be visible in edit mode');

        await testUtils.dom.click(form.$('.o-field-x2many-list-row-add a'));
        await testUtils.owlCompatibilityExtraNextTick();
        assert.hasClass(form.$('.o-form-view .o-list-view tbody tr:first input[name="displayName"]'),
            'oe-read-only', 'displayName input should have oe-read-only class');

        form.destroy();
    });

    QUnit.test('oe-edit-only className is handled in list views', async function (assert) {
        assert.expect(5);
        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<field name="p">' +
                            '<tree editable="top">' +
                                '<field name="foo"/>' +
                                '<field name="displayName" class="oe-edit-only"/>' +
                                '<field name="bar"/>' +
                            '</tree>' +
                        '</field>' +
                    '</sheet>' +
                '</form>',
            resId: 1,
        });

        assert.hasClass(form.$('.o-form-view'), 'o-form-readonly',
            'form should be in readonly mode');
        assert.isNotVisible(form.$('.o-field-one2many .o-list-view thead th[data-name="displayName"]'),
            'displayName cell should not be visible in readonly mode');

        await testUtils.form.clickEdit(form);
        assert.hasClass(form.$('.o-form-view'), 'o-form-editable',
            'form should be in edit mode');
        assert.isVisible(form.$('.o-field-one2many .o-list-view thead th[data-name="displayName"]'),
            'displayName cell should be visible in edit mode');

        await testUtils.dom.click(form.$('.o-field-x2many-list-row-add a'));
        await testUtils.owlCompatibilityExtraNextTick();
        assert.hasClass(form.$('.o-form-view .o-list-view tbody tr:first input[name="displayName"]'),
            'oe-edit-only', 'displayName input should have oe-edit-only class');

        form.destroy();
    });

    QUnit.test('*_view_ref in context are passed correctly', async function (assert) {
        var done = assert.async();
        assert.expect(3);

        createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<field name="p" context="{\'tree_view_ref\':\'module.tree_view_ref\'}"/>' +
                    '</sheet>' +
                '</form>',
            resId: 1,
            intercepts: {
                load_views: function (event) {
                    var context = event.data.context;
                    assert.strictEqual(context.tree_view_ref, 'module.tree_view_ref',
                        "context should contain tree_view_ref");
                    event.data.onSuccess();
                }
            },
            viewOptions: {
                context: {some_context: false},
            },
            mockRPC: function (route, args) {
                if (args.method === 'read') {
                    assert.strictEqual('some_context' in args.kwargs.context && !args.kwargs.context.some_context, true,
                        "the context should have been set");
                }
                return this._super.apply(this, arguments);
            },
        }).then(async function (form) {
            // reload to check that the record's context hasn't been modified
            await form.reload();
            form.destroy();
            done();
        });
    });

    QUnit.test('non inline subview and create=0 in action context', async function (assert) {
        // the create=0 should apply on the main view (form), but not on subviews
        assert.expect(2);

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form><field name="productIds" mode="kanban"/></form>',
            archs: {
                "product,false,kanban": `<kanban>
                                            <templates><t t-name="kanban-box">
                                                <div><field name="label"/></div>
                                            </t></templates>
                                        </kanban>`,
            },
            resId: 1,
            viewOptions: {
                context: {create: false},
                mode: 'edit',
            },
        });

        assert.containsNone(form, '.o-form-button_create');
        assert.containsOnce(form, '.o-kanban-button-new');

        form.destroy();
    });

    QUnit.test('readonly fields with modifiers may be saved', async function (assert) {
        // the readonly property on the field description only applies on view,
        // this is not a DB constraint. It should be seen as a default value,
        // that may be overridden in views, for example with modifiers. So
        // basically, a field defined as readonly may be edited.
        assert.expect(3);

        this.data.partner.fields.foo.readonly = true;
        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<field name="foo" attrs="{\'readonly\': [(\'bar\',\'=\',false)]}"/>' +
                        '<field name="bar"/>' +
                    '</sheet>' +
                '</form>',
            resId: 1,
            mockRPC: function (route, args) {
                if (args.method === 'write') {
                    assert.deepEqual(args.args[1], {foo: 'New foo value'},
                        "the new value should be saved");
                }
                return this._super.apply(this, arguments);
            },
        });

        // bar being set to true, foo shouldn't be readonly and thus its value
        // could be saved, even if in its field description it is readonly
        await testUtils.form.clickEdit(form);

        assert.containsOnce(form, 'input[name="foo"]',
            "foo field should be editable");
        await testUtils.fields.editInput(form.$('input[name="foo"]'), 'New foo value');

        await testUtils.form.clickSave(form);

        assert.strictEqual(form.$('.o-field-widget[name=foo]').text(), 'New foo value',
            "new value for foo field should have been saved");

        form.destroy();
    });

    QUnit.test('readonly set by modifier do not break many2manyTags', async function (assert) {
        assert.expect(0);

        this.data.partner.onchanges = {
            bar: function (obj) {
                obj.timmy = [[6, false, [12]]];
            },
        };
        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                      '<sheet>' +
                          '<field name="bar"/>' +
                          '<field name="timmy" widget="many2manyTags" attrs="{\'readonly\': [(\'bar\',\'=\',true)]}"/>' +
                      '</sheet>' +
                  '</form>',
            resId: 5,
        });

        await testUtils.form.clickEdit(form);
        await testUtils.dom.click(form.$('.o-field-widget[name=bar] input'));

        form.destroy();
    });

    QUnit.test('check if id and activeId are defined', async function (assert) {
        assert.expect(2);

        let checkOnchange = false;
        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<field name="p" context="{\'default_trululu\':activeId, \'current_id\':id}">' +
                            '<tree>' +
                                '<field name="trululu"/>' +
                            '</tree>' +
                        '</field>' +
                    '</sheet>' +
                '</form>',
            archs: {
                "partner,false,form": '<form><field name="trululu"/></form>'
            },
            mockRPC: function (route, args) {
                if (args.method === 'onchange' && checkOnchange) {
                    assert.strictEqual(args.kwargs.context.current_id, false,
                        "current_id should be false");
                    assert.strictEqual(args.kwargs.context.default_trululu, false,
                        "default_trululu should be false");
                }
                return this._super.apply(this, arguments);
            },
        });

        checkOnchange = true;
        await testUtils.dom.click(form.$('.o-field-x2many-list-row-add a'));
        form.destroy();
    });

    QUnit.test('modifiers are considered on multiple <footer/> tags', async function (assert) {
        assert.expect(2);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch:
                '<form>' +
                    '<field name="bar"/>' +
                    '<footer attrs="{\'invisible\': [(\'bar\',\'=\',false)]}">' +
                        '<button>Hello</button>' +
                        '<button>World</button>' +
                    '</footer>' +
                    '<footer attrs="{\'invisible\': [(\'bar\',\'!=\',false)]}">' +
                        '<button>Foo</button>' +
                    '</footer>' +
                '</form>',
            resId: 1,
            viewOptions: {
                footerToButtons: true,
                mode: 'edit',
            },
        });

        assert.deepEqual(getVisibleButtonTexts(), ["Hello", "World"],
            "only the first button section should be visible");

        await testUtils.dom.click(form.$(".o-field-boolean input"));

        assert.deepEqual(getVisibleButtonTexts(), ["Foo"],
            "only the second button section should be visible");

        form.destroy();

        function getVisibleButtonTexts() {
            var $visibleButtons = form.$buttons.find('button:visible');
            return _.map($visibleButtons, function (el) {
                return el.innerHTML.trim();
            });
        }
    });

    QUnit.test('buttons in footer are moved to $buttons if necessary', async function (assert) {
        assert.expect(4);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                        '<field name="foo"/>' +
                        '<footer>' +
                            '<button string="Create" type="object" class="infooter"/>' +
                        '</footer>' +
                '</form>',
            resId: 1,
            viewOptions: {footerToButtons: true},
        });

        assert.containsOnce(form.$('.o-control-panel'), 'button.infooter');
        assert.containsNone(form.$('.o-form-view'), 'button.infooter');

        // check that this still works after a reload
        await testUtils.form.reload(form);

        assert.containsOnce(form.$('.o-control-panel'), 'button.infooter');
        assert.containsNone(form.$('.o-form-view'), 'button.infooter');

        form.destroy();
    });

    QUnit.test('open new record even with warning message', async function (assert) {
        assert.expect(3);

        this.data.partner.onchanges = { foo: true };

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<group><field name="foo"/></group>' +
                '</form>',
            resId: 2,
            mockRPC: function (route, args) {
                if (args.method === 'onchange') {
                    return Promise.resolve({
                        warning: {
                            title: "Warning",
                            message: "Any warning."
                        }
                    });
                }
                return this._super.apply(this, arguments);
            },

        });
        await testUtils.form.clickEdit(form);
        assert.strictEqual(form.$('input').val(), 'blip', 'input should contain record value');
        await testUtils.fields.editInput(form.$('input[name="foo"]'), "tralala");
        assert.strictEqual(form.$('input').val(), 'tralala', 'input should contain new value');

        await form.reload({ currentId: false });
        assert.strictEqual(form.$('input').val(), '',
            'input should have no value after reload');

        form.destroy();
    });

    QUnit.test('render stat button with string inline', async function (assert) {
        assert.expect(1);

        var form = await createView({
            View: FormView,
            model: 'partner',
            resId: 1,
            data: this.data,
            arch: '<form string="Manufacturing Orders">' +
                    '<sheet>' +
                        '<div class="oe-button-box" name="buttonBox">' +
                            '<button string="Inventory Moves" class="oe-stat-button" icon="fa-arrows-v"/>' +
                        '</div>' +
                    '</sheet>' +
                '</form>',
        });
        var $button = form.$('.o-form-view .o-form-sheet .oe-button-box .oe-stat-button span');
        assert.strictEqual($button.text(), "Inventory Moves",
            "the stat button should contain a span with the string attribute value");
        form.destroy();
    });

    QUnit.test('renderer waits for asynchronous fields rendering', async function (assert) {
        assert.expect(1);
        var done = assert.async();

        testUtils.createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<field name="bar"/>' +
                    '<field name="foo" widget="ace"/>' +
                    '<field name="int_field"/>' +
                '</form>',
            resId: 1,
        }).then(function (form) {
            assert.containsOnce(form, '.ace-editor',
                "should have waited for ace to load its dependencies");
            form.destroy();
            done();
        });
    });

    QUnit.test('open one2many form containing one2many', async function (assert) {
        assert.expect(9);

        this.data.partner.records[0].productIds = [37];
        this.data.product.fields.partner_type_ids = {
            string: "one2many partner", type: "one2many", relation: "partner_type",
        };
        this.data.product.records[0].partner_type_ids = [12];

        var form = await createView({
            View: FormView,
            model: 'partner',
            resId: 1,
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<group>' +
                            '<field name="productIds">' +
                                '<tree create="0">' +
                                    '<field name="displayName"/>' +
                                    '<field name="partner_type_ids"/>' +
                                '</tree>' +
                            '</field>' +
                        '</group>' +
                    '</sheet>' +
                '</form>',
            archs: {
                'product,false,form':
                    '<form string="Products">' +
                        '<sheet>' +
                            '<group>' +
                                '<field name="partner_type_ids">' +
                                    '<tree create="0">' +
                                        '<field name="displayName"/>' +
                                        '<field name="color"/>' +
                                    '</tree>' +
                                '</field>' +
                            '</group>' +
                        '</sheet>' +
                    '</form>',
            },
            mockRPC: function (route, args) {
                assert.step(args.method);
                return this._super.apply(this, arguments);
            },
        });
        var row = form.$('.o-field-one2many .o-list-view .o-data-row');
        assert.strictEqual(row.children()[1].textContent, '1 record',
            "the cell should contains the number of record: 1");
        await testUtils.dom.click(row);
        await testUtils.nextTick(); // wait for quick edit
        var modal_row = $('.modal-body .o-form-sheet .o-field-one2many .o-list-view .o-data-row');
        assert.strictEqual(modal_row.children('.o-data-cell').length, 2,
            "the row should contains the 2 fields defined in the form view");
        assert.strictEqual($(modal_row).text(), "gold2",
            "the value of the fields should be fetched and displayed");
        assert.verifySteps(['read', 'read', 'load_views', 'read', 'read'],
            "there should be 4 read rpcs");
        form.destroy();
    });

    QUnit.test('in edit mode, first field is focused', async function (assert) {
        assert.expect(2);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                        '<field name="foo"/>' +
                        '<field name="bar"/>' +
                '</form>',
            resId: 1,
        });
        await testUtils.form.clickEdit(form);

        assert.strictEqual(document.activeElement, form.$('input[name="foo"]')[0],
            "foo field should have focus");
        assert.strictEqual(form.$('input[name="foo"]')[0].selectionStart, 3,
            "cursor should be at the end");

        form.destroy();
    });

    QUnit.test('autofocus fields are focused', async function (assert) {
        assert.expect(1);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                        '<field name="bar"/>' +
                        '<field name="foo" defaultFocus="1"/>' +
                '</form>',
            resId: 1,
        });
        await testUtils.form.clickEdit(form);
        assert.strictEqual(document.activeElement, form.$('input[name="foo"]')[0],
            "foo field should have focus");

        form.destroy();
    });

    QUnit.test('correct amount of buttons', async function (assert) {
        assert.expect(7);

        var self = this;
        var buttons = Array(8).join(
            '<button type="object" class="oe-stat-button" icon="fa-check-square">' +
                '<field name="bar"/>' +
            '</button>'
        );
        var statButtonSelector = '.oe-stat-button:not(.dropdown-item, .dropdown-toggle)';

        var createFormWithDeviceSizeClass = async function (size_class) {
            return await createView({
                View: FormView,
                model: 'partner',
                data: self.data,
                arch: '<form>' +
                    '<div name="buttonBox" class="oe-button-box">'
                        + buttons +
                    '</div>' +
                '</form>',
                resId: 2,
                config: {
                    device: {size_class: size_class},
                },
            });
        };

        var assertFormContainsNButtonsWithSizeClass = async function (size_class, n) {
            var form = await createFormWithDeviceSizeClass(size_class);
            assert.containsN(form, statButtonSelector, n, 'The form has the expected amount of buttons');
            form.destroy();
        };

        await assertFormContainsNButtonsWithSizeClass(0, 2);
        await assertFormContainsNButtonsWithSizeClass(1, 2);
        await assertFormContainsNButtonsWithSizeClass(2, 2);
        await assertFormContainsNButtonsWithSizeClass(3, 4);
        await assertFormContainsNButtonsWithSizeClass(4, 7);
        await assertFormContainsNButtonsWithSizeClass(5, 7);
        await assertFormContainsNButtonsWithSizeClass(6, 7);
    });

    QUnit.test('can set binSize to false in context', async function (assert){
        assert.expect(1);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<field name="foo"/>' +
                  '</form>',
            resId: 1,
            context: {
                binSize: false,
            },
            mockRPC: function (route, args) {
                assert.strictEqual(args.kwargs.context.binSize, false,
                    "binSize should always be in the context and should be false");
                return this._super(route, args);
            }
        });
        form.destroy();
    });

    QUnit.test('no focus set on form when closing many2one modal if lastActivatedFieldIndex is not set', async function (assert) {
        assert.expect(8);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<field name="displayName"/>' +
                    '<field name="foo"/>' +
                    '<field name="bar"/>' +
                    '<field name="p"/>' +
                    '<field name="timmy"/>' +
                    '<field name="productIds"/>' +
                    '<field name="trululu"/>' +
                '</form>',
            resId: 2,
            archs: {
                'partner,false,list': '<tree><field name="displayName"/></tree>',
                'partner_type,false,list': '<tree><field name="label"/></tree>',
                'partner,false,form': '<form><field name="trululu"/></form>',
                'product,false,list': '<tree><field name="label"/></tree>',
            },
            mockRPC: function (route, args) {
                if (args.method === 'get_formview_id') {
                    return Promise.resolve(false);
                }
                return this._super(route, args);
            },
        });

        // set max-height to have scroll forcefully so that we can test scroll position after modal close
        $('.o-content').css({'overflow': 'auto', 'max-height': '300px'});
        // Open many2one modal, lastActivatedFieldIndex will not set as we directly click on external button
        await testUtils.form.clickEdit(form);
        assert.strictEqual($(".o-content").scrollTop(), 0, "scroll position should be 0");

        form.$(".o-field-many2one[name='trululu'] .o-input").focus();
        assert.notStrictEqual($(".o-content").scrollTop(), 0, "scroll position should not be 0");

        await testUtils.dom.click(form.$('.o-external-button'));
        // Close modal
        await testUtils.dom.click($('.modal').last().find('button[class="close"]'));
        assert.notStrictEqual($(".o-content").scrollTop(), 0,
            "scroll position should not be 0 after closing modal");
        assert.containsNone(document.body, '.modal', 'There should be no modal');
        assert.doesNotHaveClass($('body'), 'modal-open', 'Modal is not said opened');
        assert.strictEqual(form.renderer.lastActivatedFieldIndex, -1,
            "lastActivatedFieldIndex is -1");
        assert.equal(document.activeElement, $('body')[0],
            'body is focused, should not set focus on form widget');
        assert.notStrictEqual(document.activeElement, form.$('.o-field-many2one[name="trululu"] .o-input'),
            'field widget should not be focused when lastActivatedFieldIndex is -1');

        form.destroy();
    });

    QUnit.test('in create mode, autofocus fields are focused', async function (assert) {
        assert.expect(1);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                        '<field name="int_field"/>' +
                        '<field name="foo" defaultFocus="1"/>' +
                '</form>',
        });
        assert.strictEqual(document.activeElement, form.$('input[name="foo"]')[0],
            "foo field should have focus");

        form.destroy();
    });

    QUnit.test('create with false values', async function (assert) {
        assert.expect(1);
        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<group><field name="bar"/></group>' +
                '</form>',
            mockRPC: function (route, args) {
                if (args.method === 'create') {
                    assert.strictEqual(args.args[0].bar, false,
                        "the false value should be given as parameter");
                }
                return this._super(route, args);
            },
        });

        await testUtils.form.clickSave(form);

        form.destroy();
    });

    QUnit.test('autofocus first visible field', async function (assert) {
        assert.expect(1);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                        '<field name="int_field" invisible="1"/>' +
                        '<field name="foo"/>' +
                '</form>',
        });
        assert.strictEqual(document.activeElement, form.$('input[name="foo"]')[0],
            "foo field should have focus");

        form.destroy();
    });

    QUnit.test('no autofocus with disable_autofocus option [REQUIRE FOCUS]', async function (assert) {
        assert.expect(2);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                        '<field name="int_field"/>' +
                        '<field name="foo"/>' +
                '</form>',
            viewOptions: {
                disable_autofocus: true,
            },
        });
        assert.notStrictEqual(document.activeElement, form.$('input[name="int_field"]')[0],
            "int_field field should not have focus");

        await form.update({});

        assert.notStrictEqual(document.activeElement, form.$('input[name="int_field"]')[0],
            "int_field field should not have focus");

        form.destroy();
    });

    QUnit.test('open one2many form containing many2manyTags', async function (assert) {
            assert.expect(4);

            this.data.partner.records[0].productIds = [37];
            this.data.product.fields.partner_type_ids = {
                string: "many2many partner_type", type: "many2many", relation: "partner_type",
            };
            this.data.product.records[0].partner_type_ids = [12, 14];

            var form = await createView({
                View: FormView,
                model: 'partner',
                resId: 1,
                data: this.data,
                arch: '<form string="Partners">' +
                        '<sheet>' +
                            '<group>' +
                                '<field name="productIds">' +
                                    '<tree create="0">' +
                                        '<field name="displayName"/>' +
                                        '<field name="partner_type_ids" widget="many2manyTags"/>' +
                                    '</tree>' +
                                    '<form string="Products">' +
                                        '<sheet>' +
                                            '<group>' +
                                                '<label for="partner_type_ids"/>' +
                                                '<div>' +
                                                    '<field name="partner_type_ids" widget="many2manyTags"/>' +
                                                '</div>' +
                                            '</group>' +
                                        '</sheet>' +
                                    '</form>' +
                                '</field>' +
                            '</group>' +
                        '</sheet>' +
                    '</form>',
                mockRPC: function (route, args) {
                    assert.step(args.method);
                    return this._super.apply(this, arguments);
                },
            });
            var row = form.$('.o-field-one2many .o-list-view .o-data-row');
            await testUtils.dom.click(row);
            assert.verifySteps(['read', 'read', 'read'],
                "there should be 3 read rpcs");
            form.destroy();
        });

    QUnit.test('onchanges are applied before checking if it can be saved', async function (assert) {
        assert.expect(4);

        this.data.partner.onchanges.foo = function (obj) {};
        this.data.partner.fields.foo.required = true;

        var def = testUtils.makeTestPromise();

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet><group>' +
                        '<field name="foo"/>' +
                    '</group></sheet>' +
                '</form>',
            resId: 2,
            mockRPC: function (route, args) {
                var result = this._super.apply(this, arguments);
                assert.step(args.method);
                if (args.method === 'onchange') {
                    return def.then(function () {
                        return result;
                    });
                }
                return result;
            },
            services: {
                notification: {
                    notify: function (params) {
                        assert.step(params.type);
                    }
                },
            },
        });

        await testUtils.form.clickEdit(form);
        await testUtils.fields.editInput(form.$('input[name="foo"]'), '');
        await testUtils.form.clickSave(form);

        def.resolve();
        await testUtils.nextTick();

        assert.verifySteps(['read', 'onchange', 'danger']);
        form.destroy();
    });

    QUnit.test('display toolbar', async function (assert) {
        assert.expect(8);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            resId: 1,
            arch: '<form string="Partners">' +
                    '<group><field name="bar"/></group>' +
                '</form>',
            toolbar: {
                action: [{
                    modelName: 'partner',
                    name: 'Action partner',
                    type: 'ir.actions.server',
                    usage: 'ir_actions_server',
                }],
                print: [],
            },
            viewOptions: {
                hasActionMenus: true,
            },
            mockRPC: function (route, args) {
                if (route === '/web/action/load') {
                    assert.strictEqual(args.context.activeId, 1,
                        "the activeId shoud be 1.");
                    assert.deepEqual(args.context.activeIds, [1],
                        "the activeIds should be an array with 1 inside.");
                    return Promise.resolve({});
                }
                return this._super.apply(this, arguments);
            },
        });

        assert.containsNone(form, '.o-cp-action-menus .dropdown:contains(Print)');
        assert.containsOnce(form, '.o-cp-action-menus .dropdown:contains(Action)');

        await testUtils.controlPanel.toggleActionMenu(form);

        assert.containsN(form, '.o-cp-action-menus .dropdown-item', 3, "there should be 3 actions");
        assert.strictEqual(form.$('.o-cp-action-menus .dropdown-item:last').text().trim(), 'Action partner',
            "the custom action should have 'Action partner' as name");

        await testUtils.mock.intercept(form, 'doAction', function (event) {
            var context = event.data.action.context.__contexts[1];
            assert.strictEqual(context.activeId, 1,
                "the activeId shoud be 1.");
            assert.deepEqual(context.activeIds, [1],
                "the activeIds should be an array with 1 inside.");
        });
        await testUtils.controlPanel.toggleMenuItem(form, "Action partner");

        form.destroy();
    });

    QUnit.test('check interactions between multiple FormViewDialogs', async function (assert) {
        assert.expect(8);

        this.data.product.fields.productIds = {
            string: "one2many product", type: "one2many", relation: "product",
        };

        this.data.partner.records[0].productId = 37;

        var form = await createView({
            View: FormView,
            model: 'partner',
            resId: 1,
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<group>' +
                            '<field name="productId"/>' +
                        '</group>' +
                    '</sheet>' +
                '</form>',
            archs: {
                'product,false,form':
                    '<form string="Products">' +
                        '<sheet>' +
                            '<group>' +
                                '<field name="displayName"/>' +
                                '<field name="productIds"/>' +
                            '</group>' +
                        '</sheet>' +
                    '</form>',
                'product,false,list': '<tree><field name="displayName"/></tree>'
            },
            mockRPC: function (route, args) {
                if (route === '/web/dataset/callKw/product/get_formview_id') {
                    return Promise.resolve(false);
                } else if (args.method === 'write') {
                    assert.strictEqual(args.model, 'product',
                        "should write on product model");
                    assert.strictEqual(args.args[1].productIds[0][2].displayName, 'xtv',
                        "displayName of the new object should be xtv");
                }
                return this._super.apply(this, arguments);
            },
        });

        await testUtils.form.clickEdit(form);
        // Open first dialog
        await testUtils.dom.click(form.$('.o-external-button'));
        assert.strictEqual($('.modal').length, 1,
            "One FormViewDialog should be opened");
        var $firstModal = $('.modal');
        assert.strictEqual($('.modal .modal-title').first().text().trim(), 'Open: Product',
            "dialog title should display the javascript field string as label");
        assert.strictEqual($firstModal.find('input').val(), 'xphone',
            "displayName should be correctly displayed");

        // Open second dialog
        await testUtils.dom.click($firstModal.find('.o-field-x2many-list-row-add a'));
        assert.strictEqual($('.modal').length, 2,
            "two FormViewDialogs should be opened");
        var $secondModal = $('.modal:nth(1)');
        // Add new value
        await testUtils.fields.editInput($secondModal.find('input'), 'xtv');
        await testUtils.dom.click($secondModal.find('.modal-footer button:first'));
        assert.strictEqual($('.modal').length, 1,
            "last opened dialog should be closed");

        // Check that data in first dialog is correctly updated
        assert.strictEqual($firstModal.find('tr.o-data-row td').text(), 'xtv',
            "should have added a line with xtv as new record");
        await testUtils.dom.click($firstModal.find('.modal-footer button:first'));
        form.destroy();
    });

    QUnit.test('fields and record contexts are not mixed', async function (assert) {
        assert.expect(2);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form>' +
                    '<group>' +
                        '<field name="trululu" context="{\'test\': 1}"/>' +
                    '</group>' +
                '</form>',
            mockRPC: function (route, args) {
                if (args.method === 'nameSearch') {
                    assert.strictEqual(args.kwargs.context.test, 1,
                        "field's context should be sent");
                    assert.notOk('mainContext' in args.kwargs.context,
                        "record's context should not be sent");
                }
                return this._super.apply(this, arguments);
            },
            resId: 2,
            viewOptions: {
                mode: 'edit',
                context: {mainContext: 3},
            },
        });

        await testUtils.dom.click(form.$('.o-field-widget[name=trululu] input'));

        form.destroy();
    });

    QUnit.test('do not activate an hidden tab when switching between records', async function (assert) {
        assert.expect(6);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<notebook>' +
                            '<page string="Foo" attrs=\'{"invisible": [["id", "=", 2]]}\'>' +
                                '<field name="foo"/>' +
                            '</page>' +
                            '<page string="Bar">' +
                                '<field name="bar"/>' +
                            '</page>' +
                        '</notebook>' +
                    '</sheet>' +
                '</form>',
            viewOptions: {
                ids: [1, 2],
                index: 0,
            },
            resId: 1,
        });

        assert.strictEqual(form.$('.o-notebook .nav-item:not(.o-invisible-modifier)').length, 2,
            "both tabs should be visible");
        assert.hasClass(form.$('.o-notebook .nav-link:first'),'active',
            "first tab should be active");

        // click on the pager to switch to the next record
        await testUtils.controlPanel.pagerNext(form);

        assert.strictEqual(form.$('.o-notebook .nav-item:not(.o-invisible-modifier)').length, 1,
            "only the second tab should be visible");
        assert.hasClass(form.$('.o-notebook .nav-item:not(.o-invisible-modifier) .nav-link'),'active',
            "the visible tab should be active");

        // click on the pager to switch back to the previous record
        await testUtils.controlPanel.pagerPrevious(form);

        assert.strictEqual(form.$('.o-notebook .nav-item:not(.o-invisible-modifier)').length, 2,
            "both tabs should be visible again");
        assert.hasClass(form.$('.o-notebook .nav-link:nth(1)'),'active',
            "second tab should be active");

        form.destroy();
    });

    QUnit.test('support anchor tags with action type', async function (assert) {
        assert.expect(1);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                            '<a type="action" name="42"><i class="fa fa-arrow-right"/> Click me !</a>' +
                    '</form>',
            resId: 1,
            intercepts: {
                doAction: function (event) {
                    assert.strictEqual(event.data.action, "42",
                        "should trigger doAction with correct action parameter");
                }
            }
        });
        await testUtils.dom.click(form.$('a[type="action"]'));

        form.destroy();
    });

    QUnit.test('do not perform extra RPC to read invisible many2one fields', async function (assert) {
        // This test isn't really meaningful anymore, since default_get and (first) onchange rpcs
        // have been merged in a single onchange rpc, returning nameget for many2one fields. But it
        // isn't really costly, and it still checks rpcs done when creating a new record with a m2o.
        assert.expect(2);

        this.data.partner.fields.trululu.default = 2;

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<field name="trululu" invisible="1"/>' +
                    '</sheet>' +
                '</form>',
            mockRPC: function (route, args) {
                assert.step(args.method);
                return this._super.apply(this, arguments);
            },
        });

        assert.verifySteps(['onchange'], "only one RPC should have been done");

        form.destroy();
    });

    QUnit.test('do not perform extra RPC to read invisible x2many fields', async function (assert) {
        assert.expect(2);

        this.data.partner.records[0].p = [2]; // one2many
        this.data.partner.records[0].productIds = [37]; // one2many
        this.data.partner.records[0].timmy = [12]; // many2many

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<field name="p" invisible="1"/>' + // no inline view
                        '<field name="productIds" invisible="1">' + // inline view
                            '<tree><field name="displayName"/></tree>' +
                        '</field>' +
                        '<field name="timmy" invisible="1" widget="many2manyTags"/>' + // no view
                    '</sheet>' +
                '</form>',
            mockRPC: function (route, args) {
                assert.step(args.method);
                return this._super.apply(this, arguments);
            },
            resId: 1,
        });

        assert.verifySteps(['read'], "only one read should have been done");

        form.destroy();
    });

    QUnit.test('defaultOrder on x2many embedded view', async function (assert) {
        assert.expect(11);

        this.data.partner.fields.displayName.sortable = true;
        this.data.partner.records[0].p = [1, 4];

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<field name="p">' +
                            '<tree defaultOrder="foo desc">' +
                                '<field name="displayName"/>' +
                                '<field name="foo"/>' +
                                '</tree>' +
                        '</field>' +
                    '</sheet>' +
                '</form>',
            archs: {
                'partner,false,form':
                    '<form string="Partner">' +
                        '<sheet>' +
                            '<group>' +
                                '<field name="foo"/>' +
                            '</group>' +
                        '</sheet>' +
                    '</form>',
            },
            resId: 1,
        });

        assert.ok(form.$('.o-field-one2many tbody tr:first td:contains(yop)').length,
            "record 1 should be first");
        await testUtils.form.clickEdit(form);
        await testUtils.dom.click(form.$('.o-field-x2many-list-row-add a'));
        assert.strictEqual($('.modal').length, 1,
            "FormViewDialog should be opened");
        await testUtils.fields.editInput($('.modal input[name="foo"]'), 'xop');
        await testUtils.dom.click($('.modal-footer button:eq(1)'));
        await testUtils.fields.editInput($('.modal input[name="foo"]'), 'zop');
        await testUtils.dom.click($('.modal-footer button:first'));

        // client-side sort
        assert.ok(form.$('.o-field-one2many tbody tr:eq(0) td:contains(zop)').length,
            "record zop should be first");
        assert.ok(form.$('.o-field-one2many tbody tr:eq(1) td:contains(yop)').length,
            "record yop should be second");
        assert.ok(form.$('.o-field-one2many tbody tr:eq(2) td:contains(xop)').length,
            "record xop should be third");

        // server-side sort
        await testUtils.form.clickSave(form);
        assert.ok(form.$('.o-field-one2many tbody tr:eq(0) td:contains(zop)').length,
            "record zop should be first");
        assert.ok(form.$('.o-field-one2many tbody tr:eq(1) td:contains(yop)').length,
            "record yop should be second");
        assert.ok(form.$('.o-field-one2many tbody tr:eq(2) td:contains(xop)').length,
            "record xop should be third");

        // client-side sort on edit
        await testUtils.form.clickEdit(form);
        await testUtils.dom.click(form.$('.o-field-one2many tbody tr:eq(1) td:contains(yop)'));
        await testUtils.fields.editInput($('.modal input[name="foo"]'), 'zzz');
        await testUtils.dom.click($('.modal-footer button:first'));
        assert.ok(form.$('.o-field-one2many tbody tr:eq(0) td:contains(zzz)').length,
            "record zzz should be first");
        assert.ok(form.$('.o-field-one2many tbody tr:eq(1) td:contains(zop)').length,
            "record zop should be second");
        assert.ok(form.$('.o-field-one2many tbody tr:eq(2) td:contains(xop)').length,
            "record xop should be third");

        form.destroy();
    });

    QUnit.test('action context is used when evaluating domains', async function (assert) {
        assert.expect(1);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<field name="trululu" domain="[(\'id\', \'in\', context.get(\'productIds\', []))]"/>' +
                    '</sheet>' +
                '</form>',
            resId: 1,
            viewOptions: {
                context: {productIds: [45,46,47]}
            },
            mockRPC: function (route, args) {
                if (args.method === 'nameSearch') {
                    assert.deepEqual(args.kwargs.args[0], ['id', 'in', [45,46,47]],
                        "domain should be properly evaluated");
                }
                return this._super.apply(this, arguments);
            },
        });
        await testUtils.form.clickEdit(form);
        await testUtils.dom.click(form.$('div[name="trululu"] input'));

        form.destroy();
    });

    QUnit.test('form rendering with groups with col/colspan', async function (assert) {
        assert.expect(45);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch:
                '<form>' +
                    '<sheet>' +
                        '<group col="6" class="parent_group">' +
                            '<group col="4" colspan="3" class="group_4">' +
                                '<div colspan="3"/>' +
                                '<div colspan="2"/><div/>' +
                                '<div colspan="4"/>' +
                            '</group>' +
                            '<group col="3" colspan="4" class="group_3">' +
                                '<group col="1" class="group_1">' +
                                    '<div/><div/><div/>' +
                                '</group>' +
                                '<div/>' +
                                '<group col="3" class="field_group">' +
                                    '<field name="foo" colspan="3"/>' +
                                    '<div/><field name="bar" nolabel="1"/>' +
                                    '<field name="qux"/>' +
                                    '<field name="int_field" colspan="3" nolabel="1"/>' +
                                    '<span/><field name="productId"/>' +
                                '</group>' +
                            '</group>' +
                        '</group>' +
                        '<group>' +
                            '<field name="p">' +
                                '<tree>' +
                                    '<field name="displayName"/>' +
                                    '<field name="foo"/>' +
                                    '<field name="int_field"/>' +
                                '</tree>' +
                            '</field>' +
                        '</group>' +
                    '</sheet>' +
                '</form>',
            resId: 1,
        });

        var $parentGroup = form.$('.parent_group');
        var $group4 = form.$('.group_4');
        var $group3 = form.$('.group_3');
        var $group1 = form.$('.group_1');
        var $fieldGroup = form.$('.field_group');

        // Verify outergroup/innergroup
        assert.strictEqual($parentGroup[0].tagName, 'DIV', ".parent_group should be an outergroup");
        assert.strictEqual($group4[0].tagName, 'TABLE', ".group_4 should be an innergroup");
        assert.strictEqual($group3[0].tagName, 'DIV', ".group_3 should be an outergroup");
        assert.strictEqual($group1[0].tagName, 'TABLE', ".group_1 should be an innergroup");
        assert.strictEqual($fieldGroup[0].tagName, 'TABLE', ".field_group should be an innergroup");

        // Verify .parent_group content
        var $parentGroupChildren = $parentGroup.children();
        assert.strictEqual($parentGroupChildren.length, 2, "there should be 2 groups in .parent_group");
        assert.ok($parentGroupChildren.eq(0).is('.o-group-col-6'), "first .parent_group group should be 1/2 parent width");
        assert.ok($parentGroupChildren.eq(1).is('.o-group-col-8'), "second .parent_group group should be 2/3 parent width");

        // Verify .group_4 content
        var $group4rows = $group4.find('> tbody > tr');
        assert.strictEqual($group4rows.length, 3, "there should be 3 rows in .group_4");
        var $group4firstRowTd = $group4rows.eq(0).children('td');
        assert.strictEqual($group4firstRowTd.length, 1, "there should be 1 td in first row");
        assert.hasAttrValue($group4firstRowTd, 'colspan', "3", "the first td colspan should be 3");
        assert.strictEqual($group4firstRowTd.attr('style').substr(0, 9), "width: 75", "the first td should be 75% width");
        assert.strictEqual($group4firstRowTd.children()[0].tagName, "DIV", "the first td should contain a div");
        var $group4secondRowTds = $group4rows.eq(1).children('td');
        assert.strictEqual($group4secondRowTds.length, 2, "there should be 2 tds in second row");
        assert.hasAttrValue($group4secondRowTds.eq(0), 'colspan', "2", "the first td colspan should be 2");
        assert.strictEqual($group4secondRowTds.eq(0).attr('style').substr(0, 9), "width: 50", "the first td be 50% width");
        assert.hasAttrValue($group4secondRowTds.eq(1), 'colspan', undefined, "the second td colspan should be default one (1)");
        assert.strictEqual($group4secondRowTds.eq(1).attr('style').substr(0, 9), "width: 25", "the second td be 75% width");
        var $group4thirdRowTd = $group4rows.eq(2).children('td');
        assert.strictEqual($group4thirdRowTd.length, 1, "there should be 1 td in third row");
        assert.hasAttrValue($group4thirdRowTd, 'colspan', "4", "the first td colspan should be 4");
        assert.strictEqual($group4thirdRowTd.attr('style').substr(0, 10), "width: 100", "the first td should be 100% width");

        // Verify .group_3 content
        assert.strictEqual($group3.children().length, 3, ".group_3 should have 3 children");
        assert.strictEqual($group3.children('.o-group-col-4').length, 3, ".group_3 should have 3 children of 1/3 width");

        // Verify .group_1 content
        assert.strictEqual($group1.find('> tbody > tr').length, 3, "there should be 3 rows in .group_1");

        // Verify .field_group content
        var $fieldGroupRows = $fieldGroup.find('> tbody > tr');
        assert.strictEqual($fieldGroupRows.length, 5, "there should be 5 rows in .field_group");
        var $fieldGroupFirstRowTds = $fieldGroupRows.eq(0).children('td');
        assert.strictEqual($fieldGroupFirstRowTds.length, 2, "there should be 2 tds in first row");
        assert.hasClass($fieldGroupFirstRowTds.eq(0),'o-td-label', "first td should be a label td");
        assert.hasAttrValue($fieldGroupFirstRowTds.eq(1), 'colspan', "2", "second td colspan should be given colspan (3) - 1 (label)");
        assert.strictEqual($fieldGroupFirstRowTds.eq(1).attr('style').substr(0, 10), "width: 100", "second td width should be 100%");
        var $fieldGroupSecondRowTds = $fieldGroupRows.eq(1).children('td');
        assert.strictEqual($fieldGroupSecondRowTds.length, 2, "there should be 2 tds in second row");
        assert.hasAttrValue($fieldGroupSecondRowTds.eq(0), 'colspan', undefined, "first td colspan should be default one (1)");
        assert.strictEqual($fieldGroupSecondRowTds.eq(0).attr('style').substr(0, 9), "width: 33", "first td width should be 33.3333%");
        assert.hasAttrValue($fieldGroupSecondRowTds.eq(1), 'colspan', undefined, "second td colspan should be default one (1)");
        assert.strictEqual($fieldGroupSecondRowTds.eq(1).attr('style').substr(0, 9), "width: 33", "second td width should be 33.3333%");
        var $fieldGroupThirdRowTds = $fieldGroupRows.eq(2).children('td'); // new row as label/field pair colspan is greater than remaining space
        assert.strictEqual($fieldGroupThirdRowTds.length, 2, "there should be 2 tds in third row");
        assert.hasClass($fieldGroupThirdRowTds.eq(0),'o-td-label', "first td should be a label td");
        assert.hasAttrValue($fieldGroupThirdRowTds.eq(1), 'colspan', undefined, "second td colspan should be default one (1)");
        assert.strictEqual($fieldGroupThirdRowTds.eq(1).attr('style').substr(0, 9), "width: 50", "second td should be 50% width");
        var $fieldGroupFourthRowTds = $fieldGroupRows.eq(3).children('td');
        assert.strictEqual($fieldGroupFourthRowTds.length, 1, "there should be 1 td in fourth row");
        assert.hasAttrValue($fieldGroupFourthRowTds, 'colspan', "3", "the td should have a colspan equal to 3");
        assert.strictEqual($fieldGroupFourthRowTds.attr('style').substr(0, 10), "width: 100", "the td should have 100% width");
        var $fieldGroupFifthRowTds = $fieldGroupRows.eq(4).children('td'); // label/field pair can be put after the 1-colspan span
        assert.strictEqual($fieldGroupFifthRowTds.length, 3, "there should be 3 tds in fourth row");
        assert.strictEqual($fieldGroupFifthRowTds.eq(0).attr('style').substr(0, 9), "width: 50", "the first td should 50% width");
        assert.hasClass($fieldGroupFifthRowTds.eq(1),'o-td-label', "the second td should be a label td");
        assert.strictEqual($fieldGroupFifthRowTds.eq(2).attr('style').substr(0, 9), "width: 50", "the third td should 50% width");

        form.destroy();
    });

    QUnit.test('outer and inner groups string attribute', async function (assert) {
        assert.expect(5);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<group string="parent group" class="parent_group">' +
                            '<group string="child group 1" class="group_1">' +
                                '<field name="bar"/>' +
                            '</group>' +
                            '<group string="child group 2" class="group-2">' +
                                '<field name="bar"/>' +
                            '</group>' +
                        '</group>' +
                    '</sheet>' +
                '</form>',
            resId: 1,
        });

        var $parentGroup = form.$('.parent_group');
        var $group1 = form.$('.group_1');
        var $group2 = form.$('.group-2');

        assert.containsN(form, 'table.o-inner-group', 2,
            "should contain two inner groups");
        assert.strictEqual($group1.find('.o-horizontal-separator').length, 1,
            "inner group should contain one string separator");
        assert.strictEqual($group1.find('.o-horizontal-separator:contains(child group 1)').length, 1,
            "first inner group should contain 'child group 1' string");
        assert.strictEqual($group2.find('.o-horizontal-separator:contains(child group 2)').length, 1,
            "second inner group should contain 'child group 2' string");
        assert.strictEqual($parentGroup.find('> div.o-horizontal-separator:contains(parent group)').length, 1,
            "outer group should contain 'parent group' string");

        form.destroy();
    });

    QUnit.test('form group with newline tag inside', async function (assert) {
        assert.expect(6);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch:
                '<form>' +
                    '<sheet>' +
                        '<group col="5" class="main_inner_group">' +
                            // col=5 otherwise the test is ok even without the
                            // newline code as this will render a <newline/> DOM
                            // element in the third column, leaving no place for
                            // the next field and its label on the same line.
                            '<field name="foo"/>' +
                            '<newline/>' +
                            '<field name="bar"/>' +
                            '<field name="qux"/>' +
                        '</group>' +
                        '<group col="3">' +
                            // col=3 otherwise the test is ok even without the
                            // newline code as this will render a <newline/> DOM
                            // element with the o-group-col-6 class, leaving no
                            // place for the next group on the same line.
                            '<group class="top_group">' +
                                '<div style="height: 200px;"/>' +
                            '</group>' +
                            '<newline/>' +
                            '<group class="bottom_group">' +
                                '<div/>' +
                            '</group>' +
                        '</group>' +
                    '</sheet>' +
                '</form>',
            resId: 1,
        });

        // Inner group
        assert.containsN(form, '.main_inner_group > tbody > tr', 2,
            "there should be 2 rows in the group");
        assert.containsOnce(form, '.main_inner_group > tbody > tr:first > .o-td-label',
            "there should be only one label in the first row");
        assert.containsOnce(form, '.main_inner_group > tbody > tr:first .o-field-widget',
            "there should be only one widget in the first row");
        assert.containsN(form, '.main_inner_group > tbody > tr:last > .o-td-label', 2,
            "there should be two labels in the second row");
        assert.containsN(form, '.main_inner_group > tbody > tr:last .o-field-widget', 2,
            "there should be two widgets in the second row");

        // Outer group
        assert.ok((form.$('.bottom_group').position().top - form.$('.top_group').position().top) >= 200,
            "outergroup children should not be on the same line");

        form.destroy();
    });

    QUnit.test('custom open record dialog title', async function (assert) {
        assert.expect(1);

        this.data.partner.records[0].p = [2];
        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch:'<form string="Partners">' +
                    '<field name="p" widget="many2many" string="custom label">' +
                        '<tree>' +
                            '<field name="displayName"/>' +
                        '</tree>' +
                        '<form>' +
                            '<field name="displayName"/>' +
                        '</form>' +
                    '</field>' +
                '</form>',
            session: {},
            resId: 1,
        });

        await testUtils.dom.click(form.$('.o-data-row:first'));
        assert.strictEqual($('.modal .modal-title').first().text().trim(), 'Open: custom label',
            "modal should use the javascript field string as title");

        form.destroy();
    });

    QUnit.test('display translation alert', async function (assert) {
        assert.expect(2);

        this.data.partner.fields.foo.translate = true;
        this.data.partner.fields.displayName.translate = true;

        var multi_lang = _t.database.multi_lang;
        _t.database.multi_lang = true;

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<group>' +
                            '<field name="foo"/>' +
                            '<field name="displayName"/>' +
                        '</group>' +
                    '</sheet>' +
                '</form>',
            resId: 1,
        });

        await testUtils.form.clickEdit(form);
        await testUtils.fields.editInput(form.$('input[name="foo"]'), "test");
        await testUtils.form.clickSave(form);
        assert.containsOnce(form, '.o-form-view .alert > div .oe_field_translate',
                            "should have single translation alert");

        await testUtils.form.clickEdit(form);
        await testUtils.fields.editInput(form.$('input[name="displayName"]'), "test2");
        await testUtils.form.clickSave(form);
        assert.containsN(form, '.o-form-view .alert > div .oe_field_translate', 2,
                         "should have two translate fields in translation alert");

        form.destroy();

        _t.database.multi_lang = multi_lang;
    });

    QUnit.test('translation alerts are preserved on pager change', async function (assert) {
        assert.expect(5);

        this.data.partner.fields.foo.translate = true;

        var multi_lang = _t.database.multi_lang;
        _t.database.multi_lang = true;

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<field name="foo"/>' +
                    '</sheet>' +
                '</form>',
            viewOptions: {
                ids: [1, 2],
                index: 0,
            },
            resId: 1,
        });

        await testUtils.form.clickEdit(form);
        await testUtils.fields.editInput(form.$('input[name="foo"]'), "test");
        await testUtils.form.clickSave(form);

        assert.containsOnce(form, '.o-form-view .alert > div', "should have a translation alert");

        // click on the pager to switch to the next record
        await testUtils.controlPanel.pagerNext(form);
        assert.containsNone(form, '.o-form-view .alert > div', "should not have a translation alert");

        // click on the pager to switch back to the previous record
        await testUtils.controlPanel.pagerPrevious(form);
        assert.containsOnce(form, '.o-form-view .alert > div', "should have a translation alert");

        // remove translation alert by click X and check alert even after form reload
        await testUtils.dom.click(form.$('.o-form-view .alert > .close'));
        assert.containsNone(form, '.o-form-view .alert > div', "should not have a translation alert");

        await form.reload();
        assert.containsNone(form, '.o-form-view .alert > div', "should not have a translation alert after reload");

        form.destroy();
        _t.database.multi_lang = multi_lang;
    });

    QUnit.test('translation alerts preserved on reverse breadcrumb', async function (assert) {
        assert.expect(2);

        serverData.models['ir.translation'] = {
            fields: {
                name: { string: "name", type: "char" },
                source: {string: "Source", type: "char"},
                value: {string: "Value", type: "char"},
            },
            records: [],
        };

        serverData.models.partner.fields.foo.translate = true;

        serverData.views = {
            'partner,false,form': '<form string="Partners">' +
                    '<sheet>' +
                        '<field name="foo"/>' +
                    '</sheet>' +
                '</form>',
            'partner,false,search': '<search></search>',
            'ir.translation,false,list': '<tree>' +
                        '<field name="label"/>' +
                        '<field name="source"/>' +
                        '<field name="value"/>' +
                    '</tree>',
            'ir.translation,false,search': '<search></search>',
        };

        serverData.actions = {
            1: {
                id: 1,
                name: 'Partner',
                resModel: 'partner',
                type: 'ir.actions.actwindow',
                views: [[false, 'form']],
            },
            2: {
                id: 2,
                name: 'Translate',
                resModel: 'ir.translation',
                type: 'ir.actions.actwindow',
                views: [[false, 'list']],
                target: 'current',
                flags: {'searchView': true, 'actionButtons': true},
            }
        };

        const webClient = await createWebClient({ serverData });
        patchWithCleanup(_t.database, {
            multi_lang: true,
        });
        await doAction(webClient, 1);
        $(webClient.el).find('input[name="foo"]').val("test").trigger("input");

        await testUtils.dom.click(webClient.el.querySelector('.o-form-button-save'));
        await legacyExtraNextTick();

        assert.containsOnce(webClient, '.o-form-view .alert > div',
            "should have a translation alert");

        await doAction(webClient, 2);

        await testUtils.dom.click($('.o-control-panel .breadcrumb a:first'));
        await legacyExtraNextTick();
        assert.containsOnce(webClient, '.o-form-view .alert > div',
            "should have a translation alert");
    });

    QUnit.test('translate event correctly handled with multiple controllers', async function (assert) {
        assert.expect(3);

        this.data.product.fields.name.translate = true;
        this.data.partner.records[0].productId = 37;
        var nbTranslateCalls = 0;

        var multi_lang = _t.database.multi_lang;
        _t.database.multi_lang = true;

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<group>' +
                            '<field name="productId"/>' +
                        '</group>' +
                    '</sheet>' +
                '</form>',
            archs: {
                'product,false,form': '<form>' +
                        '<sheet>' +
                            '<group>' +
                                '<field name="label"/>' +
                                '<field name="partner_type_id"/>' +
                            '</group>' +
                        '</sheet>' +
                    '</form>',
            },
            resId: 1,
            mockRPC: function (route, args) {
                if (route === '/web/dataset/callKw/product/get_formview_id') {
                    return Promise.resolve(false);
                }
                if (route === "/web/dataset/call_button" && args.method === 'translateFields') {
                    assert.deepEqual(args.args, ["product",37,"name"], 'should call "call_button" route');
                    nbTranslateCalls++;
                    return Promise.resolve({
                        domain: [],
                        context: {searchDefault_label: 'partnes,foo'},
                    });
                }
                if (route === "/web/dataset/callKw/res.lang/get_installed") {
                    return Promise.resolve([["en_US"], ["fr_BE"]]);
                }
                return this._super.apply(this, arguments);
            },
        });

        await testUtils.form.clickEdit(form);
        await testUtils.dom.click(form.$('[name="productId"] .o-external-button'));
        assert.containsOnce($('.modal-body'), 'span.o-field-translate',
            "there should be a translate button in the modal");

        await testUtils.dom.click($('.modal-body span.o-field-translate'));
        assert.strictEqual(nbTranslateCalls, 1, "should call_button translate once");

        form.destroy();
        _t.database.multi_lang = multi_lang;
    });

    QUnit.test('check the translate alert in the wizard', async function (assert) {
        assert.expect(1);

        // Check whether it is alert before the dialog closes
        testUtils.mock.patch(ViewDialogs.FormViewDialog, {
            close() {
                assert.containsNone(this.$el, '.o-notification-box');
                this._super(...arguments);
            },
        });

        this.data.product.fields.name.translate = true;

        const multi_lang = _t.database.multi_lang;
        _t.database.multi_lang = true;

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `<form><field name="productId"/></form>`,
            archs: {
                'product,false,form': `<form><field name="label"/></form>`,
            },
            resId: 1,
        });

        await testUtils.form.clickEdit(form);
        await testUtils.fields.many2one.createAndEdit('productId', "Ralts");
        await testUtils.dom.click($('.modal-footer button.btn-primary'));

        form.destroy();
        testUtils.mock.unpatch(ViewDialogs.FormViewDialog);
        _t.database.multi_lang = multi_lang;
    });

    QUnit.test('buttons are disabled until status bar action is resolved', async function (assert) {
        assert.expect(9);

        var def = testUtils.makeTestPromise();

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<header>' +
                        '<button name="post" class="p" string="Confirm" type="object"/>' +
                        '<button name="some_method" class="s" string="Do it" type="object"/>' +
                    '</header>' +
                    '<sheet>' +
                        '<div name="buttonBox" class="oe-button-box">' +
                            '<button class="oe-stat-button" name="some_action" type="action">' +
                                '<field name="bar"/>' +
                            '</button>' +
                        '</div>' +
                        '<group>' +
                            '<field name="foo"/>' +
                        '</group>' +
                    '</sheet>' +
                '</form>',
            resId: 1,
            intercepts: {
                execute_action: function (event) {
                    return def.then(function() {
                        event.data.onSuccess();
                    });
                }
            },
        });

        assert.strictEqual(form.$buttons.find('button:not(:disabled)').length, 4,
            "control panel buttons should be enabled");
        assert.strictEqual(form.$('.o-form-statusbar button:not(:disabled)').length, 2,
            "status bar buttons should be enabled");
        assert.strictEqual(form.$('.oe-button-box button:not(:disabled)').length, 1,
            "stat buttons should be enabled");

        await testUtils.dom.clickFirst(form.$('.o-form-statusbar button'));

        // The unresolved promise lets us check the state of the buttons
        assert.strictEqual(form.$buttons.find('button:disabled').length, 4,
            "control panel buttons should be disabled");
        assert.containsN(form, '.o-form-statusbar button:disabled', 2,
            "status bar buttons should be disabled");
        assert.containsOnce(form, '.oe-button-box button:disabled',
            "stat buttons should be disabled");

        def.resolve();
        await testUtils.nextTick();
        assert.strictEqual(form.$buttons.find('button:not(:disabled)').length, 4,
            "control panel buttons should be enabled");
        assert.strictEqual(form.$('.o-form-statusbar button:not(:disabled)').length, 2,
            "status bar buttons should be enabled");
        assert.strictEqual(form.$('.oe-button-box button:not(:disabled)').length, 1,
            "stat buttons should be enabled");

        form.destroy();
    });

    QUnit.test('buttons are disabled until button box action is resolved', async function (assert) {
        assert.expect(9);

        var def = testUtils.makeTestPromise();

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<header>' +
                        '<button name="post" class="p" string="Confirm" type="object"/>' +
                        '<button name="some_method" class="s" string="Do it" type="object"/>' +
                    '</header>' +
                    '<sheet>' +
                        '<div name="buttonBox" class="oe-button-box">' +
                            '<button class="oe-stat-button" name="some_action" type="action">' +
                                '<field name="bar"/>' +
                            '</button>' +
                        '</div>' +
                        '<group>' +
                            '<field name="foo"/>' +
                        '</group>' +
                    '</sheet>' +
                '</form>',
            resId: 1,
            intercepts: {
                execute_action: function (event) {
                    return def.then(function() {
                        event.data.onSuccess();
                    });
                }
            },
        });

        assert.strictEqual(form.$buttons.find('button:not(:disabled)').length, 4,
            "control panel buttons should be enabled");
        assert.strictEqual(form.$('.o-form-statusbar button:not(:disabled)').length, 2,
            "status bar buttons should be enabled");
        assert.strictEqual(form.$('.oe-button-box button:not(:disabled)').length, 1,
            "stat buttons should be enabled");

        await testUtils.dom.click(form.$('.oe-button-box button'));

        // The unresolved promise lets us check the state of the buttons
        assert.strictEqual(form.$buttons.find('button:disabled').length, 4,
            "control panel buttons should be disabled");
        assert.containsN(form, '.o-form-statusbar button:disabled', 2,
            "status bar buttons should be disabled");
        assert.containsOnce(form, '.oe-button-box button:disabled',
            "stat buttons should be disabled");

        def.resolve();
        await testUtils.nextTick();
        assert.strictEqual(form.$buttons.find('button:not(:disabled)').length, 4,
            "control panel buttons should be enabled");
        assert.strictEqual(form.$('.o-form-statusbar button:not(:disabled)').length, 2,
            "status bar buttons should be enabled");
        assert.strictEqual(form.$('.oe-button-box button:not(:disabled)').length, 1,
            "stat buttons should be enabled");

        form.destroy();
    });

    QUnit.test('buttons with "confirm" attribute save before calling the method', async function (assert) {
        assert.expect(9);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<header>' +
                        '<button name="post" class="p" string="Confirm" type="object" ' +
                            'confirm="Very dangerous. U sure?"/>' +
                    '</header>' +
                    '<sheet>' +
                        '<field name="foo"/>' +
                    '</sheet>' +
                '</form>',
            mockRPC: function (route, args) {
                assert.step(args.method);
                return this._super.apply(this, arguments);
            },
            intercepts: {
                execute_action: function (event) {
                    assert.step('execute_action');
                    event.data.onSuccess();
                },
            },
        });

        // click on button, and cancel in confirm dialog
        await testUtils.dom.click(form.$('.o-statusbar-buttons button'));
        assert.ok(form.$('.o-statusbar-buttons button').prop('disabled'),
            'button should be disabled');
        await testUtils.dom.click($('.modal-footer button.btn-secondary'));
        assert.ok(!form.$('.o-statusbar-buttons button').prop('disabled'),
            'button should no longer be disabled');

        assert.verifySteps(['onchange']);

        // click on button, and click on ok in confirm dialog
        await testUtils.dom.click(form.$('.o-statusbar-buttons button'));
        assert.verifySteps([]);
        await testUtils.dom.click($('.modal-footer button.btn-primary'));
        assert.verifySteps(['create', 'read', 'execute_action']);

        form.destroy();
    });

    QUnit.test('buttons with "confirm" attribute: click twice on "Ok"', async function (assert) {
        assert.expect(7);

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `
                <form>
                    <header>
                        <button name="post" class="p" string="Confirm" type="object" confirm="U sure?"/>
                    </header>
                </form>`,
            mockRPC: function (route, args) {
                assert.step(args.method);
                return this._super.apply(this, arguments);
            },
            intercepts: {
                execute_action: function (event) {
                    assert.step('execute_action'); // should be called only once
                    event.data.onSuccess();
                },
            },
        });

        assert.verifySteps(["onchange"]);

        await testUtils.dom.click(form.$('.o-statusbar-buttons button'));
        assert.verifySteps([]);

        testUtils.dom.click($('.modal-footer button.btn-primary'));
        await Promise.resolve();
        await testUtils.dom.click($('.modal-footer button.btn-primary'));
        assert.verifySteps(['create', 'read', 'execute_action']);

        form.destroy();
    });

    QUnit.test('buttons are disabled until action is resolved (in dialogs)', async function (assert) {
        assert.expect(3);

        var def = testUtils.makeTestPromise();

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form>' +
                    '<sheet>' +
                        '<field name="trululu"/>' +
                    '</sheet>' +
                '</form>',
            archs: {
                'partner,false,form': '<form>' +
                        '<sheet>' +
                            '<div name="buttonBox" class="oe-button-box">' +
                                '<button class="oe-stat-button" name="some_action" type="action">' +
                                    '<field name="bar"/>' +
                                '</button>' +
                            '</div>' +
                            '<group>' +
                                '<field name="foo"/>' +
                            '</group>' +
                        '</sheet>' +
                    '</form>',
            },
            resId: 1,
            intercepts: {
                execute_action: function (event) {
                    return def.then(function() {
                        event.data.onSuccess();
                    });
                }
            },
            mockRPC: function (route, args) {
                if (args.method === 'get_formview_id') {
                    return Promise.resolve(false);
                }
                return this._super.apply(this, arguments);
            },
            viewOptions: {
                mode: 'edit',
            },
        });

        await testUtils.dom.click(form.$('.o-external-button'));

        assert.notOk($('.modal .oe-button-box button').attr('disabled'),
            "stat buttons should be enabled");

        await testUtils.dom.click($('.modal .oe-button-box button'));

        assert.ok($('.modal .oe-button-box button').attr('disabled'),
            "stat buttons should be disabled");

        def.resolve();
        await testUtils.nextTick();
        assert.notOk($('.modal .oe-button-box button').attr('disabled'),
            "stat buttons should be enabled");

        form.destroy();
    });

    QUnit.test('multiple clicks on save should reload only once', async function (assert) {
        assert.expect(4);

        var def = testUtils.makeTestPromise();

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<group>' +
                            '<field name="foo"/>' +
                        '</group>' +
                    '</sheet>' +
                '</form>',
            resId: 1,
            mockRPC: function (route, args) {
                var result = this._super.apply(this, arguments);
                assert.step(args.method);
                if (args.method === "write") {
                    return def.then(function () {
                        return result;
                    });
                } else {
                    return result;
                }
            },
        });

        await testUtils.form.clickEdit(form);
        await testUtils.fields.editInput(form.$('input[name="foo"]'), "test");
        await testUtils.form.clickSave(form);
        await testUtils.form.clickSave(form);

        def.resolve();
        await testUtils.nextTick();
        assert.verifySteps([
            'read', // initial read to render the view
            'write', // write on save
            'read' // read on reload
        ]);

        form.destroy();
    });

    QUnit.test('form view is not broken if save operation fails', async function (assert) {
        assert.expect(5);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<group>' +
                            '<field name="foo"/>' +
                        '</group>' +
                    '</sheet>' +
                '</form>',
            resId: 1,
            mockRPC: function (route, args) {
                assert.step(args.method);
                if (args.method === 'write' && args.args[1].foo === 'incorrect value') {
                    return Promise.reject();
                }
                return this._super.apply(this, arguments);
            },
        });

        await testUtils.form.clickEdit(form);
        await testUtils.fields.editInput(form.$('input[name="foo"]'), "incorrect value");
        await testUtils.form.clickSave(form);

        await testUtils.fields.editInput(form.$('input[name="foo"]'), "correct value");

        await testUtils.form.clickSave(form);

        assert.verifySteps([
            'read', // initial read to render the view
            'write', // write on save (it fails, does not trigger a read)
            'write', // write on save (it works)
            'read' // read on reload
        ]);

        form.destroy();
    });

    QUnit.test('form view is not broken if save failed in readonly mode on field changed', async function (assert) {
        assert.expect(10);

        var failFlag = false;

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form>' +
                    '<header><field name="trululu" widget="statusbar" clickable="true"/></header>' +
                '</form>',
            resId: 1,
            mockRPC: function (route, args) {
                if (args.method === 'write') {
                    assert.step('write');
                    if (failFlag) {
                        return Promise.reject();
                    }
                } else if (args.method === 'read') {
                    assert.step('read');
                }
                return this._super.apply(this, arguments);
            },
        });

        var $selectedState = form.$('.o-statusbar-status button[data-value="4"]');
        assert.ok($selectedState.hasClass('btn-primary') && $selectedState.hasClass('disabled'),
            "selected status should be btn-primary and disabled");

        failFlag = true;
        var $clickableState = form.$('.o-statusbar-status button[data-value="1"]');
        await testUtils.dom.click($clickableState);

        var $lastActiveState = form.$('.o-statusbar-status button[data-value="4"]');
        $selectedState = form.$('.o-statusbar-status button.btn-primary');
        assert.strictEqual($selectedState[0], $lastActiveState[0],
            "selected status is AAA record after save fail");

        failFlag = false;
        $clickableState = form.$('.o-statusbar-status button[data-value="1"]');
        await testUtils.dom.click($clickableState);

        var $lastClickedState = form.$('.o-statusbar-status button[data-value="1"]');
        $selectedState = form.$('.o-statusbar-status button.btn-primary');
        assert.strictEqual($selectedState[0], $lastClickedState[0],
            "last clicked status should be active");

        assert.verifySteps([
            'read',
            'write', // fails
            'read', // must reload when saving fails
            'write', // works
            'read', // must reload when saving works
            'read', // fixme: this read should not be necessary
        ]);

        form.destroy();
    });

    QUnit.test('support password attribute', async function (assert) {
        assert.expect(3);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                        '<field name="foo" password="true"/>' +
                '</form>',
            resId: 1,
        });

        assert.strictEqual(form.$('span[name="foo"]').text(), '***',
            "password should be displayed with stars");
        await testUtils.form.clickEdit(form);
        assert.strictEqual(form.$('input[name="foo"]').val(), 'yop',
            "input value should be the password");
        assert.strictEqual(form.$('input[name="foo"]').prop('type'), 'password',
            "input should be of type password");
        form.destroy();
    });

    QUnit.test('support autocomplete attribute', async function (assert) {
        assert.expect(1);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                        '<field name="displayName" autocomplete="coucou"/>' +
                '</form>',
            resId: 1,
        });

        await testUtils.form.clickEdit(form);
        assert.hasAttrValue(form.$('input[name="displayName"]'), 'autocomplete', 'coucou',
            "attribute autocomplete should be set");
        form.destroy();
    });

    QUnit.test('input autocomplete attribute set to none by default', async function (assert) {
        assert.expect(1);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                        '<field name="displayName"/>' +
                '</form>',
            resId: 1,
        });

        await testUtils.form.clickEdit(form);
        assert.hasAttrValue(form.$('input[name="displayName"]'), 'autocomplete', 'off',
            "attribute autocomplete should be set to none by default");
        form.destroy();
    });

    QUnit.test('context is correctly passed after save & new in FormViewDialog', async function (assert) {
        assert.expect(3);

        var form = await createView({
            View: FormView,
            model: 'partner',
            resId: 4,
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<group>' +
                            '<field name="productIds"/>' +
                        '</group>' +
                    '</sheet>' +
                '</form>',
            archs: {
                'product,false,form':
                    '<form string="Products">' +
                        '<sheet>' +
                            '<group>' +
                                '<field name="partner_type_id" ' +
                                    'context="{\'color\': parent.id}"/>' +
                            '</group>' +
                        '</sheet>' +
                    '</form>',
                'product,false,list': '<tree><field name="displayName"/></tree>'
            },
            mockRPC: function (route, args) {
                if (args.method === 'nameSearch') {
                    assert.strictEqual(args.kwargs.context.color, 4,
                        "should use the correct context");
                }
                return this._super.apply(this, arguments);
            },
        });
        await testUtils.form.clickEdit(form);
        await testUtils.dom.click(form.$('.o-field-x2many-list-row-add a'));
        await testUtils.nextTick();
        assert.strictEqual($('.modal').length, 1,
            "One FormViewDialog should be opened");
        // set a value on the m2o
        await testUtils.fields.many2one.clickOpenDropdown('partner_type_id');
        await testUtils.fields.many2one.clickHighlightedItem('partner_type_id');

        await testUtils.dom.click($('.modal-footer button:eq(1)'));
        await testUtils.nextTick();
        await testUtils.dom.click($('.modal .o-field-many2one input'));
        await testUtils.fields.many2one.clickHighlightedItem('partner_type_id');
        await testUtils.dom.click($('.modal-footer button:first'));
        await testUtils.nextTick();
        form.destroy();
    });

    QUnit.test('render domain field widget without model', async function (assert) {
        assert.expect(3);

        this.data.partner.fields.modelName = { string: "Model name", type: "char" };

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<group>' +
                        '<field name="modelName"/>' +
                        '<field name="displayName" widget="domain" options="{\'model\': \'modelName\'}"/>' +
                    '</group>' +
                '</form>',
            mockRPC: function (route, args) {
                if (args.method === 'search_count') {
                    assert.strictEqual(args.model, 'test',
                        "should search_count on test");
                    if (!args.kwargs.domain) {
                        return Promise.reject({message:{
                            code: 200,
                            data: {},
                            message: "MockServer._getRecords: given domain has to be an array.",
                        }, event: $.Event()});
                    }
                }
                return this._super.apply(this, arguments);
            },
        });

        assert.strictEqual(form.$('.o-field-widget[name="displayName"]').text(), "Select a model to add a filter.",
            "should contain an error message saying the model is missing");
        await testUtils.fields.editInput(form.$('input[name="modelName"]'), "test");
        assert.notStrictEqual(form.$('.o-field-widget[name="displayName"]').text(), "Select a model to add a filter.",
            "should not contain an error message anymore");
        form.destroy();
    });

    QUnit.test('readonly fields are not sent when saving', async function (assert) {
        assert.expect(6);

        // define an onchange on displayName to check that the value of readonly
        // fields is correctly sent for onchanges
        this.data.partner.onchanges = {
            displayName: function () {},
            p: function () {},
        };
        var checkOnchange = false;

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<field name="p">' +
                        '<tree>' +
                            '<field name="displayName"/>' +
                        '</tree>' +
                        '<form string="Partners">' +
                            '<field name="displayName"/>' +
                            '<field name="foo" attrs="{\'readonly\': [[\'displayName\', \'=\', \'readonly\']]}"/>' +
                        '</form>' +
                    '</field>' +
                '</form>',
            mockRPC: function (route, args) {
                if (checkOnchange && args.method === 'onchange') {
                    if (args.args[2] === 'displayName') { // onchange on field displayName
                        assert.strictEqual(args.args[1].foo, 'foo value',
                            "readonly fields value should be sent for onchanges");
                    } else { // onchange on field p
                        assert.deepEqual(args.args[1].p, [
                            [0, args.args[1].p[0][1], {displayName: 'readonly', foo: 'foo value'}]
                        ], "readonly fields value should be sent for onchanges");
                    }
                }
                if (args.method === 'create') {
                    assert.deepEqual(args.args[0], {
                        p: [[0, args.args[0].p[0][1], {displayName: 'readonly'}]]
                    }, "should not have sent the value of the readonly field");
                }
                return this._super.apply(this, arguments);
            },
        });

        await testUtils.dom.click(form.$('.o-field-x2many-list-row-add a'));
        await testUtils.nextTick();
        assert.strictEqual($('.modal input.o-field-widget[name=foo]').length, 1,
        'foo should be editable');
        checkOnchange = true;
        await testUtils.fields.editInput($('.modal .o-field-widget[name=foo]'), 'foo value');
        await testUtils.fields.editInput($('.modal .o-field-widget[name=displayName]'), 'readonly');
        assert.strictEqual($('.modal span.o-field-widget[name=foo]').length, 1,
        'foo should be readonly');
        await testUtils.dom.clickFirst($('.modal-footer .btn-primary'));
        await testUtils.nextTick();
        checkOnchange = false;

        await testUtils.dom.click(form.$('.o-data-row'));
        assert.strictEqual($('.modal .o-field-widget[name=foo]').text(), 'foo value',
        "the edited value should have been kept");
        await testUtils.dom.clickFirst($('.modal-footer .btn-primary'));
        await testUtils.nextTick();

        await testUtils.form.clickSave(form); // save the record
        form.destroy();
    });

    QUnit.test('id is false in evalContext for new records', async function (assert) {
        assert.expect(2);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                        '<field name="id"/>' +
                        '<field name="foo" attrs="{\'readonly\': [[\'id\', \'=\', false]]}"/>' +
                '</form>',
        });

        assert.hasClass(form.$('.o-field-widget[name=foo]'),'o-readonly-modifier',
            "foo should be readonly in 'Create' mode");

        await testUtils.form.clickSave(form);
        await testUtils.form.clickEdit(form);

        assert.doesNotHaveClass(form.$('.o-field-widget[name=foo]'), 'o-readonly-modifier',
            "foo should not be readonly anymore");

        form.destroy();
    });

    QUnit.test('delete a duplicated record', async function (assert) {
        assert.expect(5);

        var newRecordID;
        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                        '<field name="displayName"/>' +
                '</form>',
            resId: 1,
            viewOptions: {hasActionMenus: true},
            mockRPC: function (route, args) {
                var result = this._super.apply(this, arguments);
                if (args.method === 'copy') {
                    return result.then(function (id) {
                        newRecordID = id;
                        return id;
                    });
                }
                if (args.method === 'unlink') {
                    assert.deepEqual(args.args[0], [newRecordID],
                        "should delete the newly created record");
                }
                return result;
            },
        });

        // duplicate record 1
        await testUtils.controlPanel.toggleActionMenu(form);
        await testUtils.controlPanel.toggleMenuItem(form, "Duplicate");

        assert.containsOnce(form, '.o-form-editable',
            "form should be in edit mode");
        assert.strictEqual(form.$('.o-field-widget').val(), 'first record (copy)',
            "duplicated record should have correct name");
        await testUtils.form.clickSave(form); // save duplicated record

        // delete duplicated record
        await testUtils.controlPanel.toggleActionMenu(form);
        await testUtils.controlPanel.toggleMenuItem(form, "Delete");

        assert.strictEqual($('.modal').length, 1, "should have opened a confirm dialog");
        await testUtils.dom.click($('.modal-footer .btn-primary'));

        assert.strictEqual(form.$('.o-field-widget').text(), 'first record',
            "should have come back to previous record");

        form.destroy();
    });

    QUnit.test('display tooltips for buttons', async function (assert) {
        assert.expect(2);

        var initialDebugMode = verp.debug;
        verp.debug = true;

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<header>' +
                        '<button name="some_method" class="oe-highlight" string="Button" type="object"/>' +
                    '</header>' +
                    '<button name="other_method" class="oe-highlight" string="Button2" type="object"/>' +
                '</form>',
        });

        var $button = form.$('.o-form-statusbar button');
        $button.tooltip('show', false);
        $button.trigger($.Event('mouseenter'));

        assert.strictEqual($('.tooltip .oe-tooltip-string').length, 1,
            "should have rendered a tooltip");
        $button.trigger($.Event('mouseleave'));

        var $secondButton = form.$('button[name="other_method"]');
        $secondButton.tooltip('show', false);
        $secondButton.trigger($.Event('mouseenter'));

        assert.strictEqual($('.tooltip .oe-tooltip-string').length, 1,
            "should have rendered a tooltip");
        $secondButton.trigger($.Event('mouseleave'));

        verp.debug = initialDebugMode;
        form.destroy();
    });

    QUnit.test('reload event is handled only once', async function (assert) {
        // In this test, several form controllers are nested (two of them are
        // opened in dialogs). When the users clicks on save in the last
        // opened dialog, a 'reload' event is triggered up to reload the (direct)
        // parent view. If this event isn't stopPropagated by the first controller
        // catching it, it will crash when the other one will try to handle it,
        // as this one doesn't know at all the dataPointID to reload.
        assert.expect(11);

        var arch = '<form>' +
                        '<field name="displayName"/>' +
                        '<field name="trululu"/>' +
                    '</form>';
        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: arch,
            archs: {
                'partner,false,form': arch,
            },
            resId: 2,
            mockRPC: function (route, args) {
                assert.step(args.method);
                if (args.method === 'get_formview_id') {
                    return Promise.resolve(false);
                }
                return this._super.apply(this, arguments);
            },
            viewOptions: {
                mode: 'edit',
            },
        });

        await testUtils.dom.click(form.$('.o-external-button'));
        await testUtils.dom.click($('.modal .o-external-button'));

        await testUtils.fields.editInput($('.modal:nth(1) .o-field-widget[name=displayName]'), 'new name');
        await testUtils.dom.click($('.modal:nth(1) footer .btn-primary').first());

        assert.strictEqual($('.modal .o-field-widget[name=trululu] input').val(), 'new name',
            "record should have been reloaded");
        assert.verifySteps([
            "read", // main record
            "get_formview_id", // id of first form view opened in a dialog
            "load_views", // arch of first form view opened in a dialog
            "read", // first dialog
            "get_formview_id", // id of second form view opened in a dialog
            "load_views", // arch of second form view opened in a dialog
            "read", // second dialog
            "write", // save second dialog
            "read", // reload first dialog
        ]);

        form.destroy();
    });

    QUnit.test('process the context for inline subview', async function (assert) {
        assert.expect(1);

        this.data.partner.records[0].p = [2];

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<field name="p">' +
                        '<tree>' +
                            '<field name="foo"/>' +
                            '<field name="bar" invisible="context.get(\'hide_bar\', false)"/>' +
                        '</tree>' +
                    '</field>' +
                '</form>',
            resId: 1,
            viewOptions: {
                context: {hide_bar: true},
            },
        });
        assert.containsOnce(form, '.o-list-view thead tr th:not(.o-list-record-remove-header)',
            "there should be only one column");
        form.destroy();
    });

    QUnit.test('process the context for subview not inline', async function (assert) {
        assert.expect(1);

        this.data.partner.records[0].p = [2];

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<field name="p"/>' +
                '</form>',
            archs: {
                "partner,false,list": '<tree>' +
                    '<field name="foo"/>' +
                    '<field name="bar" invisible="context.get(\'hide_bar\', false)"/>' +
                '</tree>',
            },
            resId: 1,
            viewOptions: {
                context: {hide_bar: true},
            },
        });
        assert.containsOnce(form, '.o-list-view thead tr th:not(.o-list-record-remove-header)',
            "there should be only one column");
        form.destroy();
    });

    QUnit.test('can toggle column in x2many in sub form view', async function (assert) {
        assert.expect(2);

        this.data.partner.records[2].p = [1,2];
        this.data.partner.fields.foo.sortable = true;
        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<field name="trululu"/>' +
                '</form>',
            resId: 1,
            mockRPC: function (route, args) {
                if (route === '/web/dataset/callKw/partner/get_formview_id') {
                    return Promise.resolve(false);
                }
                return this._super.apply(this, arguments);
            },
            archs: {
                'partner,false,form': '<form string="Partners">' +
                        '<field name="p">' +
                            '<tree>' +
                                '<field name="foo"/>' +
                            '</tree>' +
                        '</field>' +
                    '</form>',
            },
            viewOptions: {mode: 'edit'},
        });
        await testUtils.dom.click(form.$('.o-external-button'));
        assert.strictEqual($('.modal-body .o-form-view .o-list-view .o-data-cell').text(), "yopblip",
            "table has some initial order");

        await testUtils.dom.click($('.modal-body .o-form-view .o-list-view th.o-column-sortable'));
        assert.strictEqual($('.modal-body .o-form-view .o-list-view .o-data-cell').text(), "blipyop",
            "table is now sorted");
        form.destroy();
    });

    QUnit.test('rainbowman attributes correctly passed on button click', async function (assert) {
        assert.expect(1);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<header>' +
                        '<button name="action_won" string="Won" type="object" effect="{\'message\': \'Congrats!\'}"/>' +
                    '</header>' +
                '</form>',
            intercepts: {
                execute_action: function (event) {
                    var effectDescription = vjUtils.py_eval(event.data.actionData.effect);
                    assert.deepEqual(effectDescription, {message: 'Congrats!'}, "should have correct effect description");
                }
            },
        });

        await testUtils.dom.click(form.$('.o-form-statusbar .btn-secondary'));
        form.destroy();
    });

    QUnit.test('basic support for widgets', async function (assert) {
        // This test could be removed as soon as we drop the support of legacy widgets (see test
        // below, which is a duplicate of this one, but with an Owl Component instead).
        assert.expect(1);

        var MyWidget = Widget.extend({
            init: function (parent, dataPoint) {
                this.data = dataPoint.data;
            },
            start: function () {
                this.$el.text(JSON.stringify(this.data));
            },
        });
        widgetRegistry.add('test', MyWidget);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<field name="foo"/>' +
                    '<field name="bar"/>' +
                    '<widget name="test"/>' +
                '</form>',
        });

        assert.strictEqual(form.$('.o_widget').text(), '{"foo":"My little Foo Value","bar":false}',
            "widget should have been instantiated");

        form.destroy();
        delete widgetRegistry.map.test;
    });

    QUnit.test('basic support for widgets (being Owl Components)', async function (assert) {
        assert.expect(1);

        class MyComponent extends owl.Component {
            get value() {
                return JSON.stringify(this.props.record.data);
            }
        }
        MyComponent.template = owl.tags.xml`<div t-esc="value"/>`;
        widgetRegistryOwl.add('test', MyComponent);

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `
            <form>
                <field name="foo"/>
                <field name="bar"/>
                <widget name="test"/>
            </form>`,
        });

        assert.strictEqual(form.$('.o_widget').text(), '{"foo":"My little Foo Value","bar":false}');

        form.destroy();
        delete widgetRegistryOwl.map.test;
    });

    QUnit.test('attach document widget calls action with attachment ids', async function (assert) {
        assert.expect(1);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            mockRPC: function (route, args) {
                if (args.method === 'my_action') {
                    assert.deepEqual(args.kwargs.attachmentIds, [5, 2]);
                    return Promise.resolve();
                }
                return this._super.apply(this, arguments);
            },
            arch: '<form>' +
                    '<widget name="attach_document" action="my_action"/>' +
                '</form>',
        });

        var onFileLoadedEventName = form.$('.o-form-binary-form').attr('target');
        // trigger _onFileLoaded function
        $(window).trigger(onFileLoadedEventName, [{id: 5}, {id:2}]);

        form.destroy();
    });

    QUnit.test('support header button as widgets on form statusbar', async function (assert) {
        assert.expect(2);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<header>' +
                        '<widget name="attach_document" string="Attach document"/>' +
                    '</header>' +
                '</form>',
        });

        assert.containsOnce(form, 'button.o_attachment_button',
            "should have 1 attach_document widget in the statusbar");
        assert.strictEqual(form.$('span.o_attach_document').text().trim(), 'Attach document',
            "widget should have been instantiated");

        form.destroy();
    });

    QUnit.test('basic support for widgets', async function (assert) {
        assert.expect(1);

        var MyWidget = Widget.extend({
            init: function (parent, dataPoint) {
                this.data = dataPoint.data;
            },
            start: function () {
                this.$el.text(this.data.foo + "!");
            },
            updateState: function (dataPoint) {
                this.$el.text(dataPoint.data.foo + "!");
            },
        });
        widgetRegistry.add('test', MyWidget);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<field name="foo"/>' +
                    '<widget name="test"/>' +
                '</form>',
        });

        await testUtils.fields.editInput(form.$('input[name="foo"]'), "I am alive");
        assert.strictEqual(form.$('.o_widget').text(), 'I am alive!',
            "widget should have been updated");

        form.destroy();
        delete widgetRegistry.map.test;
    });

    QUnit.test('bounce edit button in readonly mode', async function (assert) {
        assert.expect(2);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form>' +
                    '<div class="oe-title">' +
                        '<field name="displayName"/>' +
                    '</div>' +
                '</form>',
            resId: 1,
        });

        // in readonly
        await testUtils.dom.click(form.$('div.oe-title'));
        assert.hasClass(form.$('.o-form-button_edit'), 'o-catch-attention');

        // in edit
        await testUtils.form.clickEdit(form);
        await testUtils.dom.click(form.$('[name="displayName"]'));
        // await testUtils.nextTick();
        assert.containsNone(form, 'button.o-catch-attention:visible');

        form.destroy();
    });

    QUnit.test('proper stringification in debug mode tooltip', async function (assert) {
        assert.expect(6);

        var initialDebugMode = verp.debug;
        verp.debug = true;

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<field name="productId" context="{\'lang\': \'en_US\'}" ' +
                            'attrs=\'{"invisible": [["productId", "=", 33]]}\' ' +
                            'widget="many2one" />' +
                    '</sheet>' +
                '</form>',
        });

        var $field = form.$('[name="productId"]');
        $field.tooltip('show', true);
        $field.trigger($.Event('mouseenter'));
        assert.strictEqual($('.oe-tooltip-technical>li[data-item="context"]').length,
            1, 'context should be present for this field');
        assert.strictEqual($('.oe-tooltip-technical>li[data-item="context"]')[0].lastChild.wholeText.trim(),
            "{'lang': 'en_US'}", "context should be properly stringified");

        assert.strictEqual($('.oe-tooltip-technical>li[data-item="modifiers"]').length,
            1, 'modifiers should be present for this field');
        assert.strictEqual($('.oe-tooltip-technical>li[data-item="modifiers"]')[0].lastChild.wholeText.trim(),
            '{"invisible":[["productId","=",33]]}', "modifiers should be properly stringified");

        assert.strictEqual($('.oe-tooltip-technical>li[data-item="widget"]').length,
            1, 'widget should be present for this field');
        assert.strictEqual($('.oe-tooltip-technical>li[data-item="widget"]')[0].lastChild.wholeText.trim(),
            'Many2one (many2one)', "widget description should be correct");

        verp.debug = initialDebugMode;
        form.destroy();
    });

    QUnit.test('autoresize of text fields is done when switching to edit mode', async function (assert) {
        assert.expect(4);

        this.data.partner.fields.text_field = { string: 'Text field', type: 'text' };
        this.data.partner.fields.text_field.default = "some\n\nmulti\n\nline\n\ntext\n";
        this.data.partner.records[0].text_field = "a\nb\nc\nd\ne\nf";

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form>' +
                    '<sheet>' +
                        '<field name="displayName"/>' +
                        '<field name="text_field"/>' +
                    '</sheet>' +
                '</form>',
            resId: 1,
        });

        // switch to edit mode to ensure that autoresize is correctly done
        await testUtils.form.clickEdit(form);
        var height = form.$('.o-field-widget[name=text_field]').height();
        // focus the field to manually trigger autoresize
        form.$('.o-field-widget[name=text_field]').trigger('focus');
        assert.strictEqual(form.$('.o-field-widget[name=text_field]').height(), height,
            "autoresize should have been done automatically at rendering");
        // next assert simply tries to ensure that the textarea isn't stucked to
        // its minimal size, even after being focused
        assert.ok(height > 80, "textarea should have an height of at least 80px");

        // save and create a new record to ensure that autoresize is correctly done
        await testUtils.form.clickSave(form);
        await testUtils.form.clickCreate(form);
        height = form.$('.o-field-widget[name=text_field]').height();
        // focus the field to manually trigger autoresize
        form.$('.o-field-widget[name=text_field]').trigger('focus');
        assert.strictEqual(form.$('.o-field-widget[name=text_field]').height(), height,
            "autoresize should have been done automatically at rendering");
        assert.ok(height > 80, "textarea should have an height of at least 80px");

        form.destroy();
    });

    QUnit.test('autoresize of text fields is done on notebook page show', async function (assert) {
        assert.expect(5);

        this.data.partner.fields.text_field = { string: 'Text field', type: 'text' };
        this.data.partner.fields.text_field.default = "some\n\nmulti\n\nline\n\ntext\n";
        this.data.partner.records[0].text_field = "a\nb\nc\nd\ne\nf";
        this.data.partner.fields.text_field_empty = { string: 'Text field', type: 'text' };

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<notebook>' +
                            '<page string="First Page">' +
                                '<field name="foo"/>' +
                            '</page>' +
                            '<page string="Second Page">' +
                                '<field name="text_field"/>' +
                            '</page>' +
                            '<page string="Third Page">' +
                                '<field name="text_field_empty"/>' +
                            '</page>' +
                        '</notebook>' +
                    '</sheet>' +
                '</form>',
            resId: 1,
        });

        await testUtils.form.clickEdit(form);
        assert.hasClass(form.$('.o-notebook .nav .nav-link:first()'), 'active');

        await testUtils.dom.click(form.$('.o-notebook .nav .nav-link:nth(1)'));
        assert.hasClass(form.$('.o-notebook .nav .nav-link:nth(1)'), 'active');

        var height = form.$('.o-field-widget[name=text_field]').height();
        assert.ok(height > 80, "textarea should have an height of at least 80px");

        await testUtils.dom.click(form.$('.o-notebook .nav .nav-link:nth(2)'));
        assert.hasClass(form.$('.o-notebook .nav .nav-link:nth(2)'), 'active');

        var height = form.$('.o-field-widget[name=text_field_empty]').css('height');
        assert.strictEqual(height, '50px', "empty textarea should have height of 50px");

        form.destroy();
    });

    QUnit.test('check if the view destroys all widgets and instances', async function (assert) {
        assert.expect(2);

        var instanceNumber = 0;
        await testUtils.mock.patch(mixins.ParentedMixin, {
            init: function () {
                instanceNumber++;
                return this._super.apply(this, arguments);
            },
            destroy: function () {
                if (!this.isDestroyed()) {
                    instanceNumber--;
                }
                return this._super.apply(this, arguments);
            }
        });

        var params = {
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<field name="displayName"/>' +
                        '<field name="foo"/>' +
                        '<field name="bar"/>' +
                        '<field name="int_field"/>' +
                        '<field name="qux"/>' +
                        '<field name="trululu"/>' +
                        '<field name="timmy"/>' +
                        '<field name="productId"/>' +
                        '<field name="priority"/>' +
                        '<field name="state"/>' +
                        '<field name="date"/>' +
                        '<field name="datetime"/>' +
                        '<field name="productIds"/>' +
                        '<field name="p">' +
                            '<tree defaultOrder="foo desc">' +
                                '<field name="displayName"/>' +
                                '<field name="foo"/>' +
                            '</tree>' +
                        '</field>' +
                    '</sheet>' +
                '</form>',
            archs: {
                'partner,false,form':
                    '<form string="Partner">' +
                        '<sheet>' +
                            '<group>' +
                                '<field name="foo"/>' +
                            '</group>' +
                        '</sheet>' +
                    '</form>',
                "partner_type,false,list": '<tree><field name="label"/></tree>',
                'product,false,list': '<tree><field name="displayName"/></tree>',

            },
            resId: 1,
        };

        var form = await createView(params);
        assert.ok(instanceNumber > 0);

        form.destroy();
        assert.strictEqual(instanceNumber, 0);

        await testUtils.mock.unpatch(mixins.ParentedMixin);
    });

    QUnit.test('do not change pager when discarding current record', async function (assert) {
        assert.expect(4);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<field name="foo"/>' +
                '</form>',
            viewOptions: {
                ids: [1, 2],
                index: 0,
            },
            resId: 2,
        });

        assert.strictEqual(testUtils.controlPanel.getPagerValue(form), "2",
            'pager should indicate that we are on second record');
        assert.strictEqual(testUtils.controlPanel.getPagerSize(form), "2",
            'pager should indicate that we are on second record');

        await testUtils.form.clickEdit(form);
        await testUtils.form.clickDiscard(form);

        assert.strictEqual(testUtils.controlPanel.getPagerValue(form), "2",
            'pager value should not have changed');
        assert.strictEqual(testUtils.controlPanel.getPagerSize(form), "2",
            'pager limit should not have changed');

        form.destroy();
    });

    QUnit.test('Form view from ordered, grouped list view correct context', async function (assert) {
        assert.expect(10);
        this.data.partner.records[0].timmy = [12];

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form>' +
                    '<field name="foo"/>' +
                    '<field name="timmy"/>' +
                '</form>',
            archs: {
                'partner_type,false,list':
                    '<tree>' +
                        '<field name="label"/>' +
                    '</tree>',
            },
            viewOptions: {
                // Simulates coming from a list view with a groupby and filter
                context: {
                    orderedBy: [{name: 'foo', asc:true}],
                    groupby: ['foo'],
                }
            },
            resId: 1,
            mockRPC: function (route, args) {
                assert.step(args.model + ":" + args.method);
                if (args.method === 'read') {
                    assert.ok(args.kwargs.context, 'context is present');
                    assert.notOk('orderedBy' in args.kwargs.context,
                        'orderedBy not in context');
                    assert.notOk('groupby' in args.kwargs.context,
                        'groupby not in context');
                }
                return this._super.apply(this, arguments);
            }
        });

        assert.verifySteps(['partner_type:load_views', 'partner:read', 'partner_type:read']);

        form.destroy();
    });

    QUnit.test('edition in form view on a "noCache" model', async function (assert) {
        assert.expect(5);

        await testUtils.mock.patch(BasicModel, {
            noCacheModels: BasicModel.prototype.noCacheModels.concat(['partner']),
        });

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form>' +
                    '<sheet>' +
                        '<field name="displayName"/>' +
                    '</sheet>' +
                '</form>',
            resId: 1,
            viewOptions: {
                mode: 'edit',
            },
            mockRPC: function (route, args) {
                if (args.method === 'write') {
                    assert.step('write');
                }
                return this._super.apply(this, arguments);
            },
        });
        core.bus.on('clearCache', form, assert.step.bind(assert, 'clearCache'));

        await testUtils.fields.editInput(form.$('.o-field-widget[name=displayName]'), 'new value');
        await testUtils.form.clickSave(form);

        assert.verifySteps(['write', 'clearCache']);

        form.destroy();
        await testUtils.mock.unpatch(BasicModel);

        assert.verifySteps(['clearCache']); // triggered by the test environment on destroy
    });

    QUnit.test('creation in form view on a "noCache" model', async function (assert) {
        assert.expect(5);

        await testUtils.mock.patch(BasicModel, {
            noCacheModels: BasicModel.prototype.noCacheModels.concat(['partner']),
        });

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form>' +
                    '<sheet>' +
                        '<field name="displayName"/>' +
                    '</sheet>' +
                '</form>',
            mockRPC: function (route, args) {
                if (args.method === 'create') {
                    assert.step('create');
                }
                return this._super.apply(this, arguments);
            },
        });
        core.bus.on('clearCache', form, assert.step.bind(assert, 'clearCache'));

        await testUtils.fields.editInput(form.$('.o-field-widget[name=displayName]'), 'value');
        await testUtils.form.clickSave(form);

        assert.verifySteps(['create', 'clearCache']);

        form.destroy();
        await testUtils.mock.unpatch(BasicModel);

        assert.verifySteps(['clearCache']); // triggered by the test environment on destroy
    });

    QUnit.test('deletion in form view on a "noCache" model', async function (assert) {
        assert.expect(5);

        await testUtils.mock.patch(BasicModel, {
            noCacheModels: BasicModel.prototype.noCacheModels.concat(['partner']),
        });

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form>' +
                    '<sheet>' +
                        '<field name="displayName"/>' +
                    '</sheet>' +
                '</form>',
            mockRPC: function (route, args) {
                if (args.method === 'unlink') {
                    assert.step('unlink');
                }
                return this._super.apply(this, arguments);
            },
            resId: 1,
            viewOptions: {
                hasActionMenus: true,
            },
        });
        core.bus.on('clearCache', form, assert.step.bind(assert, 'clearCache'));

        await testUtils.controlPanel.toggleActionMenu(form);
        await testUtils.controlPanel.toggleMenuItem(form, "Delete");
        await testUtils.dom.click($('.modal-footer .btn-primary'));

        assert.verifySteps(['unlink', 'clearCache']);

        form.destroy();
        await testUtils.mock.unpatch(BasicModel);

        assert.verifySteps(['clearCache']); // triggered by the test environment on destroy
    });

    QUnit.test('reload currencies when writing on records of model res.currency', async function (assert) {
        assert.expect(5);

        this.data['res.currency'] = {
            fields: {},
            records: [{id: 1, displayName: "some currency"}],
        };

        var form = await createView({
            View: FormView,
            model: 'res.currency',
            data: this.data,
            arch: '<form><field name="displayName"/></form>',
            resId: 1,
            viewOptions: {
                mode: 'edit',
            },
            mockRPC: function (route, args) {
                assert.step(args.method);
                return this._super.apply(this, arguments);
            },
            session: {
                reloadCurrencies: function () {
                    assert.step('reload currencies');
                },
            },
        });

        await testUtils.fields.editInput(form.$('.o-field-widget[name=displayName]'), 'new value');
        await testUtils.form.clickSave(form);

        assert.verifySteps([
            'read',
            'write',
            'reload currencies',
            'read',
        ]);

        form.destroy();
    });

    QUnit.test('keep editing after call_button fail', async function (assert) {
        assert.expect(4);

        var values;
        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch:'<form>' +
                    '<button name="post" class="p" string="Raise Error" type="object"/>' +
                    '<field name="p">' +
                        '<tree editable="top">' +
                            '<field name="displayName"/>' +
                            '<field name="productId"/>' +
                        '</tree>' +
                    '</field>' +
                '</form>',
            resId: 1,
            intercepts: {
                execute_action: function (ev) {
                    assert.ok(true, 'the action is correctly executed');
                    ev.data.onFail();
                },
            },
            mockRPC: function (route, args) {
                if (args.method === 'write') {
                    assert.deepEqual(args.args[1].p[0][2], values);
                }
                return this._super.apply(this, arguments);
            },
            viewOptions: {
                mode: 'edit',
            },
        });

        // add a row and partially fill it
        await testUtils.dom.click(form.$('.o-field-x2many-list-row-add a'));
        await testUtils.fields.editInput(form.$('input[name=displayName]'), 'abc');

        // click button which will triggerUp 'execute_action' (this will save)
        values = {
            displayName: 'abc',
            productId: false,
        };
        await testUtils.dom.click(form.$('button.p'));
        // edit the new row again and set a many2one value
        await testUtils.dom.clickLast(form.$('.o-form-view .o-field-one2many .o-data-row .o-data-cell'));
        await testUtils.nextTick();
        await testUtils.fields.many2one.clickOpenDropdown('productId');
        await testUtils.fields.many2one.clickHighlightedItem('productId');

        assert.strictEqual(form.$('.o-field-many2one input').val(), 'xphone',
            "value of the m2o should have been correctly updated");

        values = {
            productId: 37,
        };
        await testUtils.form.clickSave(form);

        form.destroy();
    });

    QUnit.test('asynchronous rendering of a widget tag', async function (assert) {
        assert.expect(1);

        var def1 = testUtils.makeTestPromise();

        var MyWidget = Widget.extend({
            willStart: function() {
                return def1;
            },
        });

        widgetRegistry.add('test', MyWidget);

        createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form>' +
                        '<widget name="test"/>' +
                    '</form>',
        }).then(function(form) {
            assert.containsOnce(form, 'div.o_widget',
                "there should be a div with widget class");
            form.destroy();
            delete widgetRegistry.map.test;
        });

        def1.resolve();
        await testUtils.nextTick();
    });

    QUnit.test('no deadlock when saving with uncommitted changes', async function (assert) {
        // Before saving a record, all field widgets are asked to commit their changes (new values
        // that they wouldn't have sent to the model yet). This test is added alongside a bug fix
        // ensuring that we don't end up in a deadlock when a widget actually has some changes to
        // commit at that moment. By chance, this situation isn't reached when the user clicks on
        // 'Save' (which is the natural way to save a record), because by clicking outside the
        // widget, the 'change' event (this is mainly for InputFields) is triggered, and the widget
        // notifies the model of its new value on its own initiative, before being requested to.
        // In this test, we try to reproduce the deadlock situation by forcing the field widget to
        // commit changes before the save. We thus manually call 'saveRecord', instead of clicking
        // on 'Save'.
        assert.expect(6);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form><field name="foo"/></form>',
            mockRPC: function (route, args) {
                assert.step(args.method);
                return this._super.apply(this, arguments);
            },
                // we set a fieldDebounce to precisely mock the behavior of the webclient: changes are
                // not sent to the model at keystrokes, but when the input is left
            fieldDebounce: 5000,
        });

        await testUtils.fields.editInput(form.$('input[name=foo]'), 'some foo value');
        // manually save the record, to prevent the field widget to notify the model of its new
        // value before being requested to
        form.saveRecord();

        await testUtils.nextTick();

        assert.containsOnce(form, '.o-form-readonly', "form view should be in readonly");
        assert.strictEqual(form.$('.o-form-view').text().trim(), 'some foo value',
            "foo field should have correct value");
        assert.verifySteps(['onchange', 'create', 'read']);

        form.destroy();
    });

    QUnit.test('save record with onchange on one2many with required field', async function (assert) {
        // in this test, we have a one2many with a required field, whose value is
        // set by an onchange on another field ; we manually set the value of that
        // first field, and directly click on Save (before the onchange RPC returns
        // and sets the value of the required field)
        assert.expect(6);

        this.data.partner.fields.foo.default = undefined;
        this.data.partner.onchanges = {
            displayName: function (obj) {
                obj.foo = obj.displayName ? 'foo value' : undefined;
            },
        };

        var onchangeDef;
        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form>' +
                    '<field name="p">' +
                        '<tree editable="top">' +
                            '<field name="displayName"/>' +
                            '<field name="foo" required="1"/>' +
                        '</tree>' +
                    '</field>' +
                '</form>',
            mockRPC: function (route, args) {
                var result = this._super.apply(this, arguments);
                if (args.method === 'onchange') {
                    return Promise.resolve(onchangeDef).then(_.constant(result));
                }
                if (args.method === 'create') {
                    assert.step('create');
                    assert.strictEqual(args.args[0].p[0][2].foo, 'foo value',
                        "should have wait for the onchange to return before saving");
                }
                return result;
            },
        });

        await testUtils.dom.click(form.$('.o-field-x2many-list-row-add a'));

        assert.strictEqual(form.$('.o-field-widget[name=displayName]').val(), '',
            "displayName should be the empty string by default");
        assert.strictEqual(form.$('.o-field-widget[name=foo]').val(), '',
            "foo should be the empty string by default");

        onchangeDef = testUtils.makeTestPromise(); // delay the onchange

        await testUtils.fields.editInput(form.$('.o-field-widget[name=displayName]'), 'some value');

        await testUtils.form.clickSave(form);

        assert.step('resolve');
        onchangeDef.resolve();
        await testUtils.nextTick();

        assert.verifySteps(['resolve', 'create']);

        form.destroy();
    });

    QUnit.test('call canBeRemoved while saving', async function (assert) {
        assert.expect(10);

        this.data.partner.onchanges = {
            foo: function (obj) {
                obj.displayName = obj.foo === 'trigger onchange' ? 'changed' : 'default';
            },
        };

        var onchangeDef;
        var createDef = testUtils.makeTestPromise();
        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form><field name="displayName"/><field name="foo"/></form>',
            mockRPC: function (route, args) {
                var result = this._super.apply(this, arguments);
                if (args.method === 'onchange') {
                    return Promise.resolve(onchangeDef).then(_.constant(result));
                }
                if (args.method === 'create') {
                    return Promise.resolve(createDef).then(_.constant(result));
                }
                return result;
            },
        });

        // edit foo to trigger a delayed onchange
        onchangeDef = testUtils.makeTestPromise();
        await testUtils.fields.editInput(form.$('.o-field-widget[name=foo]'), 'trigger onchange');

        assert.strictEqual(form.$('.o-field-widget[name=displayName]').val(), 'default');

        // save (will wait for the onchange to return), and will be delayed as well
        await testUtils.dom.click(form.$buttons.find('.o-form-button-save'));

        assert.hasClass(form.$('.o-form-view'), 'o-form-editable');
        assert.strictEqual(form.$('.o-field-widget[name=displayName]').val(), 'default');

        // simulate a click on the breadcrumbs to leave the form view
        form.canBeRemoved();
        await testUtils.nextTick();

        assert.hasClass(form.$('.o-form-view'), 'o-form-editable');
        assert.strictEqual(form.$('.o-field-widget[name=displayName]').val(), 'default');

        // unlock the onchange
        onchangeDef.resolve();
        await testUtils.nextTick();
        assert.hasClass(form.$('.o-form-view'), 'o-form-editable');
        assert.strictEqual(form.$('.o-field-widget[name=displayName]').val(), 'changed');

        // unlock the create
        createDef.resolve();
        await testUtils.nextTick();

        assert.hasClass(form.$('.o-form-view'), 'o-form-readonly');
        assert.strictEqual(form.$('.o-field-widget[name=displayName]').text(), 'changed');
        assert.containsNone(document.body, '.modal',
            "should not display the 'Changes will be discarded' dialog");

        form.destroy();
    });

    QUnit.test('call canBeRemoved twice', async function (assert) {
        assert.expect(4);

        let writeCalls = 0;
        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form><field name="displayName"/><field name="foo"/></form>',
            resId: 1,
            viewOptions: {
                mode: 'edit',
            },
            mockRPC(route) {
                if (route === '/web/dataset/callKw/partner/write') {
                    writeCalls += 1;
                }
                return this._super(...arguments);
            },
        });

        assert.containsOnce(form, '.o-form-editable');
        await testUtils.fields.editInput(form.$('.o-field-widget[name=foo]'), 'some value');

        await form.canBeRemoved();
        assert.containsNone(document.body, '.modal');

        await form.canBeRemoved();
        assert.containsNone(document.body, '.modal');

        assert.strictEqual(writeCalls, 1, 'should save once');

        form.destroy();
    });

    QUnit.test('domain returned by onchange is cleared on discard', async function (assert) {
        assert.expect(5);

        this.data.partner.onchanges = {
            foo: function () {},
        };

        var domain = ['id', '=', 1];
        var expectedDomain = domain;
        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form><field name="foo"/><field name="trululu"/></form>',
            mockRPC: function (route, args) {
                if (args.method === 'onchange' && args.args[0][0] === 1) {
                    // onchange returns a domain only on record 1
                    return Promise.resolve({
                        domain: {
                            trululu: domain,
                        },
                    });
                }
                if (args.method === 'nameSearch') {
                    assert.deepEqual(args.kwargs.args, expectedDomain);
                }
                return this._super.apply(this, arguments);
            },
            resId: 1,
            viewOptions: {
                ids: [1, 2],
                mode: 'edit',
            },
        });

        assert.strictEqual(form.$('input[name=foo]').val(), 'yop', "should be on record 1");

        // change foo to trigger the onchange
        await testUtils.fields.editInput(form.$('input[name=foo]'), 'new value');

        // open many2one dropdown to check if the domain is applied
        await testUtils.fields.many2one.clickOpenDropdown('trululu');

        // switch to another record (should ask to discard changes, and reset the domain)
        await testUtils.controlPanel.pagerNext(form);

        assert.containsNone(document.body, '.modal', 'should not open modal');

        assert.strictEqual(form.$('input[name=foo]').val(), 'blip', "should be on record 2");

        // open many2one dropdown to check if the domain is applied
        expectedDomain = [];
        await testUtils.fields.many2one.clickOpenDropdown('trululu');

        form.destroy();
    });

    QUnit.test('discard after a failed save', async function (assert) {
        assert.expect(2);

        serverData.views = {
            'partner,false,form': '<form>' +
                                    '<field name="date" required="true"/>' +
                                    '<field name="foo" required="true"/>' +
                                '</form>',
            'partner,false,kanban': '<kanban><templates><t t-name="kanban-box">' +
                                    '</t></templates></kanban>',
            'partner,false,search': '<search></search>',
        };

        const webClient = await createWebClient({ serverData });
        await doAction(webClient, 1);

        await testUtils.dom.click('.o-control-panel .o-kanban-button-new');
        await legacyExtraNextTick();

        //cannot save because there is a required field
        await testUtils.dom.click('.o-control-panel .o-form-button-save');
        await legacyExtraNextTick();
        await testUtils.dom.click('.o-control-panel .o-form-button_cancel');
        await legacyExtraNextTick();
        assert.containsNone(webClient, '.o-form-view');
        assert.containsOnce(webClient, '.o-kanban-view');
    });

    QUnit.test("one2many create record dialog shouldn't have a 'remove' button", async function (assert) {
        assert.expect(2);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form>' +
                    '<field name="p">' +
                        '<kanban>' +
                            '<templates>' +
                                '<t t-name="kanban-box">' +
                                    '<field name="foo"/>' +
                                '</t>' +
                            '</templates>' +
                        '</kanban>' +
                        '<form>' +
                            '<field name="foo"/>' +
                        '</form>' +
                    '</field>' +
                '</form>',
            resId: 1,
        });

        await testUtils.form.clickCreate(form);
        await testUtils.dom.click(form.$('.o-kanban-button-new'));

        assert.containsOnce(document.body, '.modal');
        assert.strictEqual($('.modal .modal-footer .o-btn-remove').length, 0,
            "shouldn't have a 'remove' button on new records");

        form.destroy();
    });

    QUnit.test('edit a record in readonly and switch to edit before it is actually saved', async function (assert) {
        assert.expect(3);

        const prom = testUtils.makeTestPromise();
        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `<form>
                    <field name="foo"/>
                    <field name="bar" widget="toggle_button"/>
                </form>`,
            mockRPC: function (route, args) {
                const result = this._super.apply(this, arguments);
                if (args.method === 'write') { // delay the write RPC
                    assert.deepEqual(args.args[1], {bar: false});
                    return prom.then(_.constant(result));
                }
                return result;
            },
            resId: 1,
        });

        // edit the record (in readonly) with toogle_button widget (and delay the write RPC)
        await testUtils.dom.click(form.$('.o-field-widget[name=bar]'));

        // switch to edit mode
        await testUtils.form.clickEdit(form);

        assert.hasClass(form.$('.o-form-view'), 'o-form-readonly'); // should wait for the RPC to return

        // make write RPC return
        prom.resolve();
        await testUtils.nextTick();

        assert.hasClass(form.$('.o-form-view'), 'o-form-editable');

        form.destroy();
    });

    QUnit.test('"bare" buttons in template should not trigger button click', async function (assert) {
        assert.expect(3);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                '<button string="Save" class="btn-primary" special="save"/>' +
                '<button class="mybutton">westvleteren</button>' +
              '</form>',
            resId: 2,
            intercepts: {
                execute_action: function () {
                    assert.step('execute_action');
                },
            },
        });
        await testUtils.dom.click(form.$('.o-form-view button.btn-primary'));
        assert.verifySteps(['execute_action']);
        await testUtils.dom.click(form.$('.o-form-view button.mybutton'));
        assert.verifySteps([]);
        form.destroy();
    });

    QUnit.test('form view with inline tree view with optional fields and local storage mock', async function (assert) {
        assert.expect(12);

        var Storage = RamStorage.extend({
            getItem: function (key) {
                assert.step('getItem ' + key);
                return this._super.apply(this, arguments);
            },
            setItem: function (key, value) {
                assert.step('setItem ' + key + ' to ' + value);
                return this._super.apply(this, arguments);
            },
        });

        var RamStorageService = AbstractStorageService.extend({
            storage: new Storage(),
        });

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<field name="qux"/>' +
                    '<field name="p">' +
                        '<tree>' +
                            '<field name="foo"/>' +
                            '<field name="bar" optional="hide"/>' +
                        '</tree>' +
                    '</field>' +
                '</form>',
            services: {
                localStorage: RamStorageService,
            },
            viewId: 27,
        });

        var localStorageKey = 'optionalFields,partner,form,27,p,list,undefined,bar,foo';

        assert.verifySteps(['getItem ' + localStorageKey]);

        assert.containsN(form, 'th', 2,
            "should have 2 th, 1 for selector, 1 for foo column");

        assert.ok(form.$('th:contains(Foo)').is(':visible'),
            "should have a visible foo field");

        assert.notOk(form.$('th:contains(Bar)').is(':visible'),
            "should not have a visible bar field");

        // optional fields
        await testUtils.dom.click(form.$('table .o-optional-columns-dropdown-toggle'));
        assert.containsN(form, 'div.o-optional-columns div.dropdown-item', 1,
            "dropdown have 1 optional field");

        // enable optional field
        await testUtils.dom.click(form.$('div.o-optional-columns div.dropdown-item input'));

        assert.verifySteps([
            'setItem ' + localStorageKey + ' to ["bar"]',
            'getItem ' + localStorageKey,
        ]);

        assert.containsN(form, 'th', 3,
            "should have 3 th, 1 for selector, 2 for columns");

        assert.ok(form.$('th:contains(Foo)').is(':visible'),
            "should have a visible foo field");

        assert.ok(form.$('th:contains(Bar)').is(':visible'),
            "should have a visible bar field");

        form.destroy();
    });

    QUnit.test('form view with tree_view_ref with optional fields and local storage mock', async function (assert) {
        assert.expect(12);

        var Storage = RamStorage.extend({
            getItem: function (key) {
                assert.step('getItem ' + key);
                return this._super.apply(this, arguments);
            },
            setItem: function (key, value) {
                assert.step('setItem ' + key + ' to ' + value);
                return this._super.apply(this, arguments);
            },
        });

        var RamStorageService = AbstractStorageService.extend({
            storage: new Storage(),
        });

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<field name="qux"/>' +
                    '<field name="p" context="{\'tree_view_ref\': \'34\'}"/>' +
                '</form>',
            archs: {
                "partner,nope_not_this_one,list": '<tree>' +
                    '<field name="foo"/>' +
                    '<field name="bar"/>' +
                    '</tree>',
                "partner,34,list": '<tree>' +
                        '<field name="foo" optional="hide"/>' +
                        '<field name="bar"/>' +
                    '</tree>',
            },
            services: {
                localStorage: RamStorageService,
            },
            viewId: 27,
        });

        var localStorageKey = 'optionalFields,partner,form,27,p,list,34,bar,foo';

        assert.verifySteps(['getItem ' + localStorageKey]);

        assert.containsN(form, 'th', 2,
            "should have 2 th, 1 for selector, 1 for foo column");

        assert.notOk(form.$('th:contains(Foo)').is(':visible'),
            "should have a visible foo field");

        assert.ok(form.$('th:contains(Bar)').is(':visible'),
            "should not have a visible bar field");

        // optional fields
        await testUtils.dom.click(form.$('table .o-optional-columns-dropdown-toggle'));
        assert.containsN(form, 'div.o-optional-columns div.dropdown-item', 1,
            "dropdown have 1 optional field");

        // enable optional field
        await testUtils.dom.click(form.$('div.o-optional-columns div.dropdown-item input'));

        assert.verifySteps([
            'setItem ' + localStorageKey + ' to ["foo"]',
            'getItem ' + localStorageKey,
        ]);

        assert.containsN(form, 'th', 3,
            "should have 3 th, 1 for selector, 2 for columns");

        assert.ok(form.$('th:contains(Foo)').is(':visible'),
            "should have a visible foo field");

        assert.ok(form.$('th:contains(Bar)').is(':visible'),
            "should have a visible bar field");

        form.destroy();
    });

    QUnit.test('using tab in an empty required string field should not move to the next field', async function(assert) {
        assert.expect(3);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch:'<form string="Partners">' +
                    '<sheet>' +
                        '<group>' +
                            '<field name="displayName" required="1" />' +
                            '<field name="foo" />' +
                        '</group>' +
                    '</sheet>' +
                '</form>',
        });

        await testUtils.dom.click(form.$('input[name=displayName]'));
        assert.strictEqual(form.$('input[name="displayName"]')[0], document.activeElement,
            "displayName should be focused");
        form.$('input[name="displayName"]').trigger($.Event('keydown', {which: $.ui.keyCode.TAB}));
        assert.strictEqual(form.$('input[name="displayName"]')[0], document.activeElement,
            "displayName should still be focused because it is empty and required");
        assert.hasClass(form.$('input[name="displayName"]'), 'o-field-invalid',
            "displayName should have the o-field-invalid class");
        form.destroy();
    });

    QUnit.test('using tab in an empty required date field should not move to the next field', async function(assert) {
        assert.expect(2);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch:'<form string="Partners">' +
                    '<sheet>' +
                        '<group>' +
                            '<field name="date" required="1" />' +
                            '<field name="foo" />' +
                        '</group>' +
                    '</sheet>' +
                '</form>',
        });

        await testUtils.dom.click(form.$('input[name=date]'));
        assert.strictEqual(form.$('input[name="date"]')[0], document.activeElement,
            "displayName should be focused");
        form.$('input[name="date"]').trigger($.Event('keydown', {which: $.ui.keyCode.TAB}));
        assert.strictEqual(form.$('input[name="date"]')[0], document.activeElement,
            "date should still be focused because it is empty and required");

        form.destroy();
    });

    QUnit.test('Edit button get the focus when pressing TAB from form', async function (assert) {
        assert.expect(1);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form>' +
                    '<div class="oe-title">' +
                        '<field name="displayName"/>' +
                    '</div>' +
                '</form>',
            resId: 1,
        });

        // in edit
        await testUtils.form.clickEdit(form);
        form.$('input[name="displayName"]').focus().trigger($.Event('keydown', {which: $.ui.keyCode.TAB}));
        assert.strictEqual(form.$buttons.find('.btn-primary:visible')[0], document.activeElement,
            "the first primary button (save) should be focused");
        form.destroy();
    });

    QUnit.test('In Edition mode, after navigating to the last field, the default button when pressing TAB is SAVE', async function (assert) {
        assert.expect(1);
        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<field name="state" invisible="1"/>' +
                    '<header>' +
                        '<button name="post" class="btn-primary firstButton" string="Confirm" type="object"/>' +
                        '<button name="post" class="btn-primary secondButton" string="Confirm2" type="object"/>' +
                    '</header>' +
                    '<sheet>' +
                        '<group>' +
                            '<div class="oe-title">' +
                                '<field name="displayName"/>' +
                            '</div>' +
                        '</group>' +
                    '</sheet>' +
                '</form>',
            resId: 2,
            viewOptions: {
                mode: 'edit',
            },
        });

        form.$('input[name="displayName"]').focus().trigger($.Event('keydown', {which: $.ui.keyCode.TAB}));
        assert.strictEqual(form.$buttons.find('.o-form-button-save:visible')[0], document.activeElement,
            "the save should be focused");
        form.destroy();
    });

    QUnit.test('In READ mode, the default button with focus is the first primary button of the form', async function (assert) {
        assert.expect(1);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<field name="state" invisible="1"/>' +
                    '<header>' +
                        '<button name="post" class="btn-primary firstButton" string="Confirm" type="object"/>' +
                        '<button name="post" class="btn-primary secondButton" string="Confirm2" type="object"/>' +
                    '</header>' +
                    '<sheet>' +
                        '<group>' +
                            '<div class="oe-title">' +
                                '<field name="displayName"/>' +
                            '</div>' +
                        '</group>' +
                    '</sheet>' +
                '</form>',
            resId: 2,
        });
        assert.strictEqual(form.$('button.firstButton')[0], document.activeElement,
                        "by default the focus in edit mode should go to the first primary button of the form (not edit)");
        form.destroy();
    });

    QUnit.test('In READ mode, the default button when pressing TAB is EDIT when there is no primary button on the form', async function (assert) {
        assert.expect(1);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<field name="state" invisible="1"/>' +
                    '<header>' +
                        '<button name="post" class="not-primary" string="Confirm" type="object"/>' +
                        '<button name="post" class="not-primary" string="Confirm2" type="object"/>' +
                    '</header>' +
                    '<sheet>' +
                        '<group>' +
                            '<div class="oe-title">' +
                                '<field name="displayName"/>' +
                            '</div>' +
                        '</group>' +
                    '</sheet>' +
                '</form>',
            resId: 2,
        });
        assert.strictEqual(form.$buttons.find('.o-form-button_edit')[0],document.activeElement,
                        "in read mode, when there are no primary buttons on the form, the default button with the focus should be edit");
        form.destroy();
    });

    QUnit.test('In Edition mode, when an attribute is dynamically required (and not required), TAB should navigate to the next field', async function (assert) {
        assert.expect(1);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<group>' +
                            '<field name="foo" attrs="{\'required\': [[\'bar\', \'=\', true]]}"/>' +
                            '<field name="bar"/>' +
                        '</group>' +
                    '</sheet>' +
                '</form>',
            resId: 5,
            viewOptions: {
                mode: 'edit',
            },
        });

        form.$('input[name="foo"]').focus();
        $(document.activeElement).trigger($.Event('keydown', {which: $.ui.keyCode.TAB}));

        assert.strictEqual(form.$('div[name="bar"]>input')[0], document.activeElement, "foo is not required, so hitting TAB on foo should have moved the focus to BAR");
        form.destroy();
    });

    QUnit.test('In Edition mode, when an attribute is dynamically required, TAB should stop on the field if it is required', async function (assert) {
        assert.expect(1);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<sheet>' +
                        '<group>' +
                            '<field name="foo" attrs="{\'required\': [[\'bar\', \'=\', true]]}"/>' +
                            '<field name="bar"/>' +
                        '</group>' +
                    '</sheet>' +
                '</form>',
            resId: 5,
            viewOptions: {
                mode: 'edit',
            },
        });

        await testUtils.dom.click(form.$('div[name="bar"]>input'));
        form.$('input[name="foo"]').focus();
        $(document.activeElement).trigger($.Event('keydown', {which: $.ui.keyCode.TAB}));

        assert.strictEqual(form.$('input[name="foo"]')[0], document.activeElement, "foo is required, so hitting TAB on foo should keep the focus on foo");
        form.destroy();
    });

    QUnit.test('display tooltips for save and discard buttons', async function (assert) {
        assert.expect(1);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<field name="foo" />'+
                '</form>',
        });

        form.$buttons.find('.o-form-buttons_edit').tooltip('show',false);
        assert.strictEqual($('.tooltip .oe-tooltip-string').length, 1,
            "should have rendered a tooltip");
            await testUtils.nextTick();
        form.destroy();
    });
    QUnit.test('if the focus is on the save button, hitting ENTER should save', async function (assert) {
        assert.expect(1);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<field name="foo" />'+
                '</form>',
            viewOptions: {
                mode: 'edit',
            },
            mockRPC: function (route, args) {
                if (args.method === 'create') {
                    assert.ok(true, "should call the /create route");
                }
                return this._super(route, args);
            },
        });

        form.$buttons.find('.o-form-button-save')
                        .focus()
                        .trigger($.Event('keydown', {which: $.ui.keyCode.ENTER}));
        await testUtils.nextTick();
        form.destroy();
    });
    QUnit.test('if the focus is on the discard button, hitting ENTER should save', async function (assert) {
        assert.expect(1);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<field name="foo" />'+
                '</form>',
            viewOptions: {
                mode: 'edit',
            },
            mockRPC: function (route, args) {
                if (args.method === 'create') {
                    assert.ok(true, "should call the /create route");
                }
                return this._super(route, args);
            },
        });

        form.$buttons.find('.o-form-button_cancel')
                        .focus()
                        .trigger($.Event('keydown', {which: $.ui.keyCode.ENTER}));
        await testUtils.nextTick();
        form.destroy();
    });
    QUnit.test('if the focus is on the save button, hitting ESCAPE should discard', async function (assert) {
        assert.expect(0);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<field name="foo" />'+
                '</form>',
            viewOptions: {
                mode: 'edit',
            },
            mockRPC: function (route, args) {
                if (args.method === 'create') {
                    throw new Error('Create should not be called');
                }
                return this._super(route, args);
            },
        });

        form.$buttons.find('.o-form-button-save')
                        .focus()
                        .trigger($.Event('keydown', {which: $.ui.keyCode.ESCAPE}));
        await testUtils.nextTick();
        form.destroy();
    });

    QUnit.test('resequence list lines when discardable lines are present', async function (assert) {
        assert.expect(8);

        var onchangeNum = 0;

        this.data.partner.onchanges = {
            p: function (obj) {
                onchangeNum++;
                obj.foo = obj.p ? obj.p.length.toString() : "0";
            },
        };

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form>' +
                    '<field name="foo"/>' +
                    '<field name="p"/>' +
                '</form>',
            archs: {
                'partner,false,list':
                    '<tree editable="bottom">' +
                        '<field name="int_field" widget="handle"/>' +
                        '<field name="displayName" required="1"/>' +
                    '</tree>',
            },
        });

        assert.strictEqual(onchangeNum, 1, "one onchange happens when form is opened");
        assert.strictEqual(form.$('[name="foo"]').val(), "0", "onchange worked there is 0 line");

        // Add one line
        await testUtils.dom.click(form.$('.o-field-x2many-list-row-add a'));
        form.$('.o-field-one2many input:first').focus();
        await testUtils.nextTick();
        form.$('.o-field-one2many input:first').val('first line').trigger('input');
        await testUtils.nextTick();
        await testUtils.dom.click(form.$('input[name="foo"]'));
        assert.strictEqual(onchangeNum, 2, "one onchange happens when a line is added");
        assert.strictEqual(form.$('[name="foo"]').val(), "1", "onchange worked there is 1 line");

        // Drag and drop second line before first one (with 1 draft and invalid line)
        await testUtils.dom.click(form.$('.o-field-x2many-list-row-add a'));
        await testUtils.dom.dragAndDrop(
            form.$('.ui-sortable-handle').eq(0),
            form.$('.o-data-row').last(),
            {position: 'bottom'}
        );
        assert.strictEqual(onchangeNum, 3, "one onchange happens when lines are resequenced");
        assert.strictEqual(form.$('[name="foo"]').val(), "1", "onchange worked there is 1 line");

        // Add a second line
        await testUtils.dom.click(form.$('.o-field-x2many-list-row-add a'));
        form.$('.o-field-one2many input:first').focus();
        await testUtils.nextTick();
        form.$('.o-field-one2many input:first').val('second line').trigger('input');
        await testUtils.nextTick();
        await testUtils.dom.click(form.$('input[name="foo"]'));
        assert.strictEqual(onchangeNum, 4, "one onchange happens when a line is added");
        assert.strictEqual(form.$('[name="foo"]').val(), "2", "onchange worked there is 2 lines");

        form.destroy();
    });

    QUnit.test('if the focus is on the discard button, hitting ESCAPE should discard', async function (assert) {
        assert.expect(0);

        var form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form string="Partners">' +
                    '<field name="foo" />'+
                '</form>',
            viewOptions: {
                mode: 'edit',
            },
            mockRPC: function (route, args) {
                if (args.method === 'create') {
                    throw new Error('Create should not be called');
                }
                return this._super(route, args);
            },
        });

        form.$buttons.find('.o-form-button_cancel')
                        .focus()
                        .trigger($.Event('keydown', {which: $.ui.keyCode.ESCAPE}));
        await testUtils.nextTick();
        form.destroy();
    });

    QUnit.test('if the focus is on the save button, hitting TAB should not move to the next button', async function (assert) {
        assert.expect(1);
        /*
        this test has only one purpose: to say that it is normal that the focus stays within a button primary even after the TAB key has been pressed.
        It is not possible here to execute the default action of the TAB on a button : https://stackoverflow.com/questions/32428993/why-doesnt-simulating-a-tab-keypress-move-focus-to-the-next-input-field
        so writing a test that will always succeed is not useful.
            */
        assert.ok("Behavior can't be tested");
    });

    QUnit.test('reload company when creating records of model res.company', async function (assert) {
        assert.expect(6);

        var form = await createView({
            View: FormView,
            model: 'res.company',
            data: this.data,
            arch: '<form><field name="label"/></form>',
            mockRPC: function (route, args) {
                assert.step(args.method);
                return this._super.apply(this, arguments);
            },
            intercepts: {
                doAction: function (ev) {
                    assert.step('reload company');
                    assert.strictEqual(ev.data.action, "reloadContext", "company view reloaded");
                },
            },
        });

        await testUtils.fields.editInput(form.$('input[name="label"]'), 'Test Company');
        await testUtils.form.clickSave(form);

        assert.verifySteps([
            'onchange',
            'create',
            'reload company',
            'read',
        ]);

        form.destroy();
    });

    QUnit.test('reload company when writing on records of model res.company', async function (assert) {
        assert.expect(6);
        this.data['res.company'].records = [{
            id: 1, name: "Test Company"
        }];

        var form = await createView({
            View: FormView,
            model: 'res.company',
            data: this.data,
            arch: '<form><field name="label"/></form>',
            resId: 1,
            viewOptions: {
                mode: 'edit',
            },
            mockRPC: function (route, args) {
                assert.step(args.method);
                return this._super.apply(this, arguments);
            },
            intercepts: {
                doAction: function (ev) {
                    assert.step('reload company');
                    assert.strictEqual(ev.data.action, "reloadContext", "company view reloaded");
                },
            },
        });

        await testUtils.fields.editInput(form.$('input[name="label"]'), 'Test Company2');
        await testUtils.form.clickSave(form);

        assert.verifySteps([
            'read',
            'write',
            'reload company',
            'read',
        ]);

        form.destroy();
    });

    QUnit.test('company_dependent field in form view, in multi company group', async function (assert) {
        assert.expect(2);

        this.data.partner.fields.productId.company_dependent = true;
        this.data.partner.fields.productId.help = 'this is a tooltip';
        this.data.partner.fields.foo.company_dependent = true;

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `
                <form>
                    <group>
                        <field name="foo"/>
                        <field name="productId"/>
                    </group>
                </form>`,
            session: {
                display_switch_company_menu: true,
            },
        });

        const $productLabel = form.$('.o-form-label:eq(1)');
        $productLabel.tooltip('show', false);
        await testUtils.dom.triggerMouseEvent($productLabel, 'mouseenter');
        assert.strictEqual($('.tooltip .oe-tooltip-help').text().trim(),
            "this is a tooltip\n\nValues set here are company-specific.");
        await testUtils.dom.triggerMouseEvent($productLabel, 'mouseleave');

        const $fooLabel = form.$('.o-form-label:first');
        $fooLabel.tooltip('show', false);
        await testUtils.dom.triggerMouseEvent($fooLabel, 'mouseenter');
        assert.strictEqual($('.tooltip .oe-tooltip-help').text().trim(),
            "Values set here are company-specific.");
        await testUtils.dom.triggerMouseEvent($fooLabel, 'mouseleave');

        form.destroy();
    });

    QUnit.test('company_dependent field in form view, not in multi company group', async function (assert) {
        assert.expect(1);

        this.data.partner.fields.productId.company_dependent = true;
        this.data.partner.fields.productId.help = 'this is a tooltip';

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `
                <form>
                    <group>
                        <field name="productId"/>
                    </group>
                </form>`,
            session: {
                display_switch_company_menu: false,
            },
        });

        const $productLabel = form.$('.o-form-label');

        $productLabel.tooltip('show', false);
        await testUtils.dom.triggerMouseEvent($productLabel, 'mouseenter');
        assert.strictEqual($('.tooltip .oe-tooltip-help').text().trim(), "this is a tooltip");
        await testUtils.dom.triggerMouseEvent($productLabel, 'mouseleave');

        form.destroy();
    });

    QUnit.test('reload a form view with a pie chart does not crash', async function (assert) {
        assert.expect(3);

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `<form>
                      <widget name="pie_chart" title="qux by product" attrs="{'measure': 'qux', 'groupby': 'productId'}"/>
                  </form>`,
            mockRPC(route, args) {
                if (args.method === "renderPublicAsset") {
                    assert.deepEqual(args.args, ["web.assetsBackendLegacyLazy"]);
                    return Promise.resolve(true);
                }
                return this._super(...arguments);
            }
        });

        assert.containsOnce(form, '.o_widget');

        await form.reload();
        await testUtils.nextTick();

        assert.containsOnce(form, '.o_widget');

        form.destroy();
        delete widgetRegistry.map.test;
    });

    QUnit.test('do not call mounted twice on children', async function (assert) {
        assert.expect(3);

        class CustomFieldComponent extends fieldRegistryOwl.get('boolean') {
            mounted() {
                super.mounted(...arguments);
                assert.step('mounted');
            }
            willUnmount() {
                super.willUnmount(...arguments);
                assert.step('willUnmount');
            }
        }
        fieldRegistryOwl.add('custom', CustomFieldComponent);

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `<form><field name="bar" widget="custom"/></form>`,
        });

        form.destroy();
        delete fieldRegistryOwl.map.custom;

        assert.verifySteps(['mounted', 'willUnmount']);
    });

    QUnit.test('Auto save: save when page changed', async function (assert) {
        assert.expect(10);

        serverData.actions[1] = {
            id: 1,
            name: 'Partner',
            resModel: 'partner',
            type: 'ir.actions.actwindow',
            views: [[false, 'list'], [false, 'form']],
        };

        serverData.views = {
            'partner,false,list': `
                <tree>
                    <field name="label"/>
                </tree>
            `,
            'partner,false,form': `
                <form>
                    <group>
                        <field name="label"/>
                    </group>
                </form>
            `,
            'partner,false,search': '<search></search>',
        };

        const mockRPC = (route, args) => {
            if (args.method === 'write') {
                assert.deepEqual(args.args, [
                    [1],
                    { name: "aaa" },
                ]);
            }
        };

        const webClient = await createWebClient({ serverData , mockRPC });

        await doAction(webClient, 1);

        await testUtils.dom.click($(webClient.el).find('.o-data-row:first'));
        await legacyExtraNextTick();
        assert.strictEqual($(webClient.el).find('.breadcrumb').text(), 'Partnerfirst record');

        await testUtils.dom.click($(webClient.el).find('.o-form-button_edit'));
        await testUtils.fields.editInput($(webClient.el).find('.o-field-widget[name="label"]'), 'aaa');

        await testUtils.controlPanel.pagerNext(webClient);
        await legacyExtraNextTick();
        assert.containsOnce(webClient, '.o-form-editable');
        assert.strictEqual($(webClient.el).find('.breadcrumb').text(), 'Partnersecond record');
        assert.strictEqual($(webClient.el).find('.o-field-widget[name="label"]').val(), 'name');

        await testUtils.dom.click($(webClient.el).find('.o-form-button_cancel'));
        assert.strictEqual($(webClient.el).find('.breadcrumb').text(), 'Partnersecond record');
        assert.strictEqual($(webClient.el).find('.o-field-widget[name="label"]').text(), 'name');

        await testUtils.controlPanel.pagerPrevious(webClient);
        await legacyExtraNextTick();
        assert.containsOnce(webClient, '.o-form-readonly');
        assert.strictEqual($(webClient.el).find('.breadcrumb').text(), 'Partnerfirst record');
        assert.strictEqual($(webClient.el).find('.o-field-widget[name="label"]').text(), 'aaa');
    });

    QUnit.test('Auto save: save when breadcrumb clicked', async function (assert) {
        assert.expect(7);

        serverData.actions[1] = {
            id: 1,
            name: 'Partner',
            resModel: 'partner',
            type: 'ir.actions.actwindow',
            views: [[false, 'list'], [false, 'form']],
        };

        serverData.views = {
            'partner,false,list': `
                <tree>
                    <field name="label"/>
                </tree>
            `,
            'partner,false,form': `
                <form>
                    <group>
                        <field name="label"/>
                    </group>
                </form>
            `,
            'partner,false,search': '<search></search>',
        };

        const mockRPC = (route, args) => {
            if (args.method === 'write') {
                assert.deepEqual(args.args, [
                    [1],
                    { name: "aaa" },
                ]);
            }
        };

        const webClient = await createWebClient({ serverData , mockRPC });

        await doAction(webClient, 1);

        await testUtils.dom.click($(webClient.el).find('.o-data-row:first'));
        await legacyExtraNextTick();
        assert.strictEqual($(webClient.el).find('.breadcrumb').text(), 'Partnerfirst record');

        await testUtils.dom.click($(webClient.el).find('.o-form-button_edit'));
        await testUtils.fields.editInput($(webClient.el).find('.o-field-widget[name="label"]'), 'aaa');

        await testUtils.dom.click($(webClient.el).find('.breadcrumb-item.o_back_button'));
        await legacyExtraNextTick();

        assert.strictEqual($(webClient.el).find('.breadcrumb').text(), 'Partner');
        assert.strictEqual($(webClient.el).find('.o-field-cell[name="label"]:first').text(), 'aaa');

        await testUtils.dom.click($(webClient.el).find('.o-data-row:first'));
        await legacyExtraNextTick();
        assert.containsOnce(webClient, '.o-form-readonly');
        assert.strictEqual($(webClient.el).find('.breadcrumb').text(), 'Partnerfirst record');
        assert.strictEqual($(webClient.el).find('.o-field-widget[name="label"]').text(), 'aaa');
    });

    QUnit.test('Auto save: save when action changed', async function (assert) {
        assert.expect(6);

        serverData.actions[1] = {
            id: 1,
            name: 'Partner',
            resModel: 'partner',
            type: 'ir.actions.actwindow',
            views: [[false, 'list'], [false, 'form']],
        };

        serverData.actions[2] = {
            id: 2,
            name: 'Other action',
            resModel: 'partner',
            type: 'ir.actions.actwindow',
            views: [[false, 'kanban']],
        };

        serverData.views = {
            'partner,false,list': `
                <tree>
                    <field name="label"/>
                </tree>
            `,
            'partner,false,form': `
                <form>
                    <group>
                        <field name="label"/>
                    </group>
                </form>
            `,
            'partner,false,search': '<search></search>',
            'partner,false,kanban': `
                <kanban>
                    <field name="label"/>
                    <templates>
                        <t t-name="kanban-box">
                            <div></div>
                        </t>
                    </templates>
                </kanban>
            `,
        };

        const mockRPC = (route, args) => {
            if (args.method === 'write') {
                assert.deepEqual(args.args, [
                    [1],
                    { name: "aaa" },
                ]);
            }
        };

        const webClient = await createWebClient({ serverData , mockRPC });

        await doAction(webClient, 1);

        await testUtils.dom.click($(webClient.el).find('.o-data-row:first'));
        await legacyExtraNextTick();
        assert.strictEqual($(webClient.el).find('.breadcrumb').text(), 'Partnerfirst record');

        await testUtils.dom.click($(webClient.el).find('.o-form-button_edit'));
        await testUtils.fields.editInput($(webClient.el).find('.o-field-widget[name="label"]'), 'aaa');

        await doAction(webClient, 2, { clearBreadcrumbs: true });

        assert.strictEqual($(webClient.el).find('.breadcrumb').text(), 'Other action');

        await doAction(webClient, 1, { clearBreadcrumbs: true });

        await testUtils.dom.click($(webClient.el).find('.o-data-row:first'));
        await legacyExtraNextTick();
        assert.containsOnce(webClient, '.o-form-readonly');
        assert.strictEqual($(webClient.el).find('.breadcrumb').text(), 'Partnerfirst record');
        assert.strictEqual($(webClient.el).find('.o-field-widget[name="label"]').text(), 'aaa');
    });

    QUnit.test('Auto save: save on closing tab/browser', async function (assert) {
        assert.expect(2);

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `
                <form>
                    <group>
                        <field name="displayName"/>
                    </group>
                </form>`,
            resId: 1,
            mockRPC(route, { args, method, model }) {
                if (method === 'write' && model === 'partner') {
                    assert.deepEqual(args, [
                        [1],
                        { displayName: 'test' },
                    ]);
                }
                return this._super(...arguments);
            },
        });

        await testUtils.form.clickEdit(form);
        assert.notStrictEqual(form.$('.o-field-widget[name="displayName"]').val(), 'test');

        await testUtils.fields.editInput(form.$('.o-field-widget[name="displayName"]'), 'test');
        window.dispatchEvent(new Event("beforeunload"));
        await testUtils.nextTick();

        form.destroy();
    });

    QUnit.test('Auto save: save on closing tab/browser (invalid field)', async function (assert) {
        assert.expect(1);

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `
                <form>
                    <group>
                        <field name="displayName" required="1"/>
                    </group>
                </form>`,
            resId: 1,
            mockRPC(route, { args, method, model }) {
                if (method === 'write' && model === 'partner') {
                    assert.step('save'); // should not be called
                }
                return this._super(...arguments);
            },
        });

        await testUtils.form.clickEdit(form);
        await testUtils.fields.editInput(form.$('.o-field-widget[name="displayName"]'), '');
        window.dispatchEvent(new Event("beforeunload"));
        await testUtils.nextTick();

        assert.verifySteps([], 'should not save because of invalid field');

        form.destroy();
    });

    QUnit.test('Auto save: save on closing tab/browser (not dirty)', async function (assert) {
        assert.expect(1);

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `
                <form>
                    <group>
                        <field name="displayName"/>
                    </group>
                </form>`,
            resId: 1,
            mockRPC(route, { args, method, model }) {
                if (method === 'write' && model === 'partner') {
                    assert.step('save'); // should not be called
                }
                return this._super(...arguments);
            },
        });

        await testUtils.form.clickEdit(form);

        window.dispatchEvent(new Event("beforeunload"));
        await testUtils.nextTick();

        assert.verifySteps([], 'should not save because we do not change anything');

        form.destroy();
    });

    QUnit.test('Auto save: save on closing tab/browser (detached form)', async function (assert) {
        assert.expect(3);

        serverData.actions[1] = {
            id: 1,
            name: 'Partner',
            resModel: 'partner',
            type: 'ir.actions.actwindow',
            views: [[false, 'list'], [false, 'form']],
        };

        serverData.views = {
            'partner,false,list': `
                <tree>
                    <field name="displayName"/>
                </tree>
            `,
            'partner,false,form': `
                <form>
                    <group>
                        <field name="displayName"/>
                    </group>
                </form>
            `,
            'partner,false,search': '<search></search>',
        };

        const mockRPC = (route, args) => {
            if (args.method === 'write') {
                assert.step('save');
            }
        };

        const webClient = await createWebClient({ serverData, mockRPC });

        await doAction(webClient, 1);

        // Click on a row to open a record
        await testUtils.dom.click($(webClient.el).find('.o-data-row:first'));
        await legacyExtraNextTick();
        assert.strictEqual($(webClient.el).find('.breadcrumb').text(), 'Partnerfirst record');

        // Return in the list view to detach the form view
        await testUtils.dom.click($(webClient.el).find('.o_back_button'));
        await legacyExtraNextTick();
        assert.strictEqual($(webClient.el).find('.breadcrumb').text(), 'Partner');

        // Simulate tab/browser close in the list
        window.dispatchEvent(new Event("beforeunload"));
        await testUtils.nextTick();

        // write rpc should not trigger because form view has been detached
        // and list has nothing to save
        assert.verifySteps([]);
    });

    QUnit.test('Auto save: save on closing tab/browser (onchanges)', async function (assert) {
        assert.expect(1);

        this.data.partner.onchanges = {
            displayName: function (obj) {
                obj.name = `copy: ${obj.displayName}`;
            },
        };

        const def = testUtils.makeTestPromise();
        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `
                <form>
                    <group>
                        <field name="displayName"/>
                        <field name="label"/>
                    </group>
                </form>`,
            resId: 1,
            mockRPC(route, { args, method, model }) {
                if (method === 'onchange' && model === 'partner') {
                    return def;
                }
                if (method === 'write' && model === 'partner') {
                    assert.deepEqual(args, [
                        [1],
                        { displayName: 'test' },
                    ]);
                }
                return this._super(...arguments);
            },
        });

        await testUtils.form.clickEdit(form);
        await testUtils.fields.editInput(form.$('.o-field-widget[name="displayName"]'), 'test');

        window.dispatchEvent(new Event("beforeunload"));
        await testUtils.nextTick();

        form.destroy();
    });

    QUnit.test('Auto save: save on closing tab/browser (onchanges 2)', async function (assert) {
        assert.expect(1);

        this.data.partner.onchanges = {
            displayName: function () {},
        };

        const def = testUtils.makeTestPromise();
        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `
                <form>
                    <group>
                        <field name="displayName"/>
                        <field name="label"/>
                    </group>
                </form>`,
            resId: 1,
            mockRPC(route, { args, method }) {
                if (method === 'onchange') {
                    return def;
                }
                if (method === 'write') {
                    assert.deepEqual(args, [
                        [1],
                        { displayName: 'test', name: 'test' },
                    ]);
                }
                return this._super(...arguments);
            },
        });

        await testUtils.form.clickEdit(form);
        await testUtils.fields.editInput(form.$('.o-field-widget[name="displayName"]'), 'test');
        await testUtils.fields.editInput(form.$('.o-field-widget[name="label"]'), 'test');

        window.dispatchEvent(new Event("beforeunload"));
        await testUtils.nextTick();

        form.destroy();
    });

    QUnit.test('Auto save: save on closing tab/browser (pending change)', async function (assert) {
        assert.expect(4);

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            fieldDebounce: 1000,
            arch: `<form><field name="foo"/></form>`,
            resId: 1,
            mockRPC(route, { args, method }) {
                assert.step(method);
                if (method === 'write') {
                    assert.deepEqual(args, [[1], { foo: 'test' }]);
                }
                return this._super(...arguments);
            },
        });

        await testUtils.form.clickEdit(form);

        // edit 'foo' but do not focusout -> the model isn't aware of the change
        // until the 'beforeunload' event is triggered
        form.$('.o-field-widget[name="foo"]').val('test');
        await testUtils.dom.triggerEvent(form.$('.o-field-widget[name="foo"]'), 'input');

        window.dispatchEvent(new Event("beforeunload"));
        await testUtils.nextTick();

        assert.verifySteps(['read', 'write']);

        form.destroy();
    });

    QUnit.test('Auto save: save on closing tab/browser (onchanges + pending change)', async function (assert) {
        assert.expect(5);

        this.data.partner.onchanges = {
            displayName: function (obj) {
                obj.name = `copy: ${obj.displayName}`;
            },
        };

        const def = testUtils.makeTestPromise();
        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            fieldDebounce: 1000,
            arch: `
                <form>
                    <field name="displayName"/>
                    <field name="label"/>
                    <field name="foo"/>
                </form>`,
            resId: 1,
            mockRPC(route, { args, method }) {
                assert.step(method);
                if (method === 'onchange') {
                    return def;
                }
                if (method === 'write') {
                    assert.deepEqual(args, [
                        [1],
                        { displayName: 'test', name: 'test', foo: 'test' },
                    ]);
                }
                return this._super(...arguments);
            },
        });

        await testUtils.form.clickEdit(form);
        // edit 'displayName' and simulate a focusout (trigger the 'change' event)
        // -> notifies the model of the change and performs the onchange
        form.$('.o-field-widget[name="displayName"]').val('test');
        await testUtils.dom.triggerEvent(form.$('.o-field-widget[name="displayName"]'), 'change');

        // edit 'name' and simulate a focusout (trigger the 'change' event)
        // -> waits for the mutex (i.e. the onchange) to notify the model
        form.$('.o-field-widget[name="label"]').val('test');
        await testUtils.dom.triggerEvent(form.$('.o-field-widget[name="label"]'), 'change');

        // edit 'foo' but do not focusout -> the model isn't aware of the change
        // until the 'beforeunload' event is triggered
        form.$('.o-field-widget[name="foo"]').val('test');
        await testUtils.dom.triggerEvent(form.$('.o-field-widget[name="foo"]'), 'input');

        // trigger the 'beforeunload' event -> notifies the model directly and saves
        window.dispatchEvent(new Event("beforeunload"));
        await testUtils.nextTick();

        assert.verifySteps(['read', 'onchange', 'write']);

        form.destroy();
    });

    QUnit.test('Auto save: save on closing tab/browser (onchanges + invalid field)', async function (assert) {
        assert.expect(3);

        this.data.partner.onchanges = {
            displayName: function (obj) {
                obj.name = `copy: ${obj.displayName}`;
            },
        };

        const def = testUtils.makeTestPromise();
        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `
                <form>
                    <group>
                        <field name="displayName"/>
                        <field name="label" required="1"/>
                    </group>
                </form>`,
            resId: 1,
            mockRPC(route, { method }) {
                assert.step(method);
                if (method === 'onchange') {
                    return def;
                }
                if (method === 'write') {
                    throw new Error('Should not save the record');
                }
                return this._super(...arguments);
            },
        });

        await testUtils.form.clickEdit(form);
        await testUtils.fields.editInput(form.$('.o-field-widget[name="displayName"]'), 'test');
        await testUtils.fields.editInput(form.$('.o-field-widget[name="label"]'), '');

        window.dispatchEvent(new Event("beforeunload"));
        await testUtils.nextTick();

        assert.verifySteps(['read', 'onchange']);

        form.destroy();
    });

    QUnit.test('Quick Edition: click on a quick editable field', async function (assert) {
        assert.expect(3);

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `
                <form>
                    <group>
                        <field name="displayName"/>
                    </group>
                </form>`,
            resId: 1,
        });

        assert.containsOnce(form, '.o-form-view.o-form-readonly');

        await testUtils.dom.click(form.$('.o-field-widget[name="displayName"]'));

        assert.containsOnce(form, '.o-form-view.o-form-editable');
        assert.strictEqual(document.activeElement, $('.o-field-widget[name="displayName"]')[0]);

        form.destroy();
    });

    QUnit.test('Quick Edition: click on a non quick editable field', async function (assert) {
        assert.expect(4);

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `
                <form>
                    <group>
                        <field name="priority" widget="priority"/>
                    </group>
                </form>`,
            resId: 1,
        });

        assert.containsOnce(form, '.o-form-view.o-form-readonly');
        assert.containsNone(form, '.o-priority-star[aria-checked="true"]');

        await testUtils.dom.click(form.$('.o-field-widget[name="priority"] a:first'));

        assert.containsOnce(form, '.o-form-view.o-form-readonly');
        assert.containsOnce(form, '.o-priority-star[aria-checked="true"]');

        form.destroy();
    });

    QUnit.test('Quick Edition: Label click', async function (assert) {
        assert.expect(3);

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `
                <form>
                    <group>
                        <field name="foo"/>
                    </group>
                </form>`,
            resId: 1,
        });

        assert.containsOnce(form, '.o-form-view.o-form-readonly');

        await testUtils.dom.click(form.$('.o-form-label:first'));

        assert.containsOnce(form, '.o-form-view.o-form-editable');
        assert.strictEqual(document.activeElement, form.$('input.o-field-widget[name="foo"]')[0]);

        form.destroy();
    });

    QUnit.test('Quick Edition: Label click (duplicated field)', async function (assert) {
        assert.expect(8);

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `
                <form>
                    <group>
                        <div class="o-td-label" invisible="1">
                            <label for="foo" string="A"/>
                        </div>
                        <field name="foo" nolabel="1" invisible="1"/>

                        <div class="o-td-label">
                            <label for="foo" string="B"/>
                        </div>
                        <field name="foo" nolabel="1"/>
                    </group>
                </form>`,
            resId: 1,
        });

        assert.containsOnce(form, '.o-form-view.o-form-readonly');
        assert.containsN(form, '.o-form-label', 2);
        assert.containsOnce(form, '.o-invisible-modifier .o-form-label');

        await testUtils.dom.click(form.$('.o-form-label')[1]);

        assert.containsOnce(form, '.o-form-view.o-form-editable');
        assert.containsN(form, '.o-form-label', 2);
        assert.containsOnce(form, '.o-invisible-modifier .o-form-label');
        assert.containsOnce(form, 'input.o-field-widget[name="foo"]');
        assert.strictEqual(document.activeElement, form.$('input.o-field-widget[name="foo"]')[0]);

        form.destroy();
    });

    QUnit.test('Quick Edition: Checkbox click', async function (assert) {
        assert.expect(11);

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `
                <form>
                    <group>
                        <field name="bar"/>
                    </group>
                </form>`,
            resId: 1,
        });

        assert.containsOnce(form, '.o-form-view.o-form-readonly');
        assert.containsOnce(form, '.o-field-boolean input:checked');
        assert.containsNone(form, '.o-field-boolean input:disabled');

        await testUtils.dom.click(form.$('.o-field-widget[name="bar"]'));
        await testUtils.nextTick(); // wait for quick edit

        assert.containsOnce(form, '.o-form-view.o-form-editable');
        assert.containsNone(form, '.o-field-boolean input:checked');

        await testUtils.form.clickSave(form);

        assert.containsOnce(form, '.o-form-view.o-form-readonly');
        assert.containsNone(form, '.o-field-boolean input:checked');
        assert.containsNone(form, '.o-field-boolean input:disabled');

        await testUtils.dom.click(form.$('.o-field-widget[name="bar"]'));
        await testUtils.nextTick(); // wait for quick edit

        assert.containsOnce(form, '.o-form-view.o-form-editable');
        assert.containsOnce(form, '.o-field-boolean input:checked');
        assert.containsNone(form, '.o-field-boolean input:disabled');

        form.destroy();
    });

    QUnit.test('Quick Edition: Checkbox click on label', async function (assert) {
        assert.expect(8);

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `
                <form>
                    <group>
                        <field name="bar"/>
                    </group>
                </form>`,
            resId: 1,
        });

        assert.containsOnce(form, '.o-form-view.o-form-readonly');
        assert.containsOnce(form, '.o-field-boolean input:checked');

        await testUtils.dom.click(form.$('.o-td-label .o-form-label'));
        await testUtils.nextTick(); // wait for quick edit

        assert.containsOnce(form, '.o-form-view.o-form-editable');
        assert.containsNone(form, '.o-field-boolean input:checked');

        await testUtils.form.clickSave(form);

        assert.containsOnce(form, '.o-form-view.o-form-readonly');
        assert.containsNone(form, '.o-field-boolean input:checked');

        await testUtils.dom.click(form.$('.o-td-label .o-form-label'));
        await testUtils.nextTick(); // wait for quick edit

        assert.containsOnce(form, '.o-form-view.o-form-editable');
        assert.containsOnce(form, '.o-field-boolean input:checked');

        form.destroy();
    });

    QUnit.test('Quick Edition: Readonly one2many list', async function (assert) {
        assert.expect(4);

        this.data.partner.records[0].p.push(2);

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `
                <form>
                    <field name="p" attrs="{'readonly': true}">
                        <tree>
                            <field name="foo"/>
                        </tree>
                    </field>
                </form>`,
            resId: 1,
        });

        assert.containsOnce(form, '.o-form-view.o-form-readonly');
        assert.containsNone(form, '.o-field-x2many-list-row-add',
            'create line should not be displayed');
        assert.containsNone(form, '.o-list-record-remove',
            'remove buttons should not be displayed');

        await testUtils.dom.click(form.$('.o-field-cell:first'));

        assert.containsOnce(form, '.o-form-view.o-form-readonly',
            'should not switch into edit mode');

        form.destroy();
    });

    QUnit.test('Quick Edition: Readonly one2many list (non editable form)', async function (assert) {
        assert.expect(7);

        this.data.partner.records[0].p.push(2);

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `
                <form edit="0">
                    <field name="p">
                        <tree>
                            <field name="foo"/>
                        </tree>
                        <form>
                            <field name="foo"/>
                        </form>
                    </field>
                </form>`,
            resId: 1,
        });

        assert.containsOnce(form, '.o-form-view.o-form-readonly');
        assert.containsNone(document.body, '.modal');

        assert.containsNone(form, '.o-field-x2many-list-row-add a', 'no add button should be displayed');
        assert.containsNone(form, '.o-list-record-remove', 'no remove button should be displayed');

        await testUtils.dom.click(form.$('.o-field-cell:first'));

        assert.containsOnce(form, '.o-form-view.o-form-readonly', 'should not switch into edit mode');
        assert.containsOnce(document.body, '.modal');
        assert.containsOnce(document.body, '.modal span.o-field-widget[name="foo"]');

        form.destroy();
    });

    QUnit.test('Quick Edition: Editable one2many list (click cell: editable)', async function (assert) {
        assert.expect(3);

        this.data.partner.records[0].p.push(2);

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `
                <form>
                    <field name="p">
                        <tree editable="bottom">
                            <field name="foo"/>
                        </tree>
                    </field>
                </form>`,
            resId: 1,
        });

        assert.containsOnce(form, '.o-form-view.o-form-readonly');

        await testUtils.dom.click(form.$('.o-field-cell[name="foo"]'));

        assert.containsOnce(form, '.o-form-view.o-form-editable',
            'should switch into edit mode');
        assert.strictEqual(document.activeElement, form.$('.o-field-cell[name="foo"] input')[0]);

        form.destroy();
    });

    QUnit.test('Quick Edition: Editable one2many list (click cell: not editable)', async function (assert) {
        assert.expect(5);

        this.data.partner.records[0].p.push(2);

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `
                <form>
                    <field name="p">
                        <tree>
                            <field name="foo"/>
                        </tree>
                        <form>
                            <field name="foo"/>
                        </form>
                    </field>
                </form>`,
            resId: 1,
        });

        assert.containsOnce(form, '.o-form-view.o-form-readonly');
        assert.containsNone(document.body, '.modal');

        await testUtils.dom.click(form.$('.o-field-cell[name="foo"]'));

        assert.containsOnce(form, '.o-form-view.o-form-editable',
            'should switch into edit mode');
        assert.containsOnce(document.body, '.modal');
        assert.containsOnce(document.body, '.modal input.o-field-widget[name="foo"]');

        form.destroy();
    });

    QUnit.test('Quick Edition: Editable one2many list (add a line: editable)', async function (assert) {
        assert.expect(4);

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `
                <form>
                    <field name="p">
                        <tree editable="bottom">
                            <field name="foo"/>
                        </tree>
                    </field>
                </form>`,
            resId: 1,
        });

        assert.containsOnce(form, '.o-form-view.o-form-readonly');
        assert.containsOnce(form, '.o-field-x2many-list-row-add',
            'create line should be displayed');

        await testUtils.dom.click(form.$('.o-field-x2many-list-row-add a'));
        await testUtils.nextTick(); // wait for quick edit

        assert.containsOnce(form, '.o-form-view.o-form-editable',
            'should switch into edit mode');
        assert.strictEqual(document.activeElement, form.$('.o-field-cell[name="foo"] input')[0]);

        form.destroy();
    });

    QUnit.test('Quick Edition: Editable one2many list (add a line: not editable)', async function (assert) {
        assert.expect(5);

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `
                <form>
                    <field name="p">
                        <tree>
                            <field name="foo"/>
                        </tree>
                        <form>
                            <field name="foo"/>
                        </form>
                    </field>
                </form>`,
            resId: 1,
        });

        assert.containsOnce(form, '.o-form-view.o-form-readonly');
        assert.containsNone(document.body, '.modal');

        await testUtils.dom.click(form.$('.o-field-x2many-list-row-add a'));
        await testUtils.nextTick(); // wait for quick edit

        assert.containsOnce(form, '.o-form-view.o-form-editable',
            'should switch into edit mode');
        assert.containsOnce(document.body, '.modal');
        assert.containsOnce(document.body, '.modal input.o-field-widget[name="foo"]');

        form.destroy();
    });

    QUnit.test('Quick Edition: Editable one2many list (drop a line: editable)', async function (assert) {
        assert.expect(6);

        this.data.partner.records[0].p = [1, 2];

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `
                <form>
                    <field name="p">
                        <tree editable="bottom">
                            <field name="foo"/>
                        </tree>
                    </field>
                </form>`,
            resId: 1,
        });

        assert.containsOnce(form, '.o-form-view.o-form-readonly');
        assert.containsN(form, '.o-list-record-remove', 2,
            'remove buttons should be displayed');
        assert.strictEqual(form.$('.o-field-cell[name="foo"]').text(), 'yopblip');

        await testUtils.dom.click(form.$('.o-list-record-remove button')[0]);
        await testUtils.nextTick(); // wait for quick edit

        assert.containsOnce(form, '.o-form-view.o-form-editable',
            'should switch into edit mode');
        assert.containsOnce(form, '.o-data-row', 'only one record should remain');
        assert.strictEqual(form.$('.o-field-cell[name="foo"]').text(), 'blip');

        form.destroy();
    });

    QUnit.test('Quick Edition: Editable one2many list (drop a line: not editable)', async function (assert) {
        assert.expect(6);

        this.data.partner.records[0].p = [1, 2];

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `
                <form>
                    <field name="p">
                        <tree>
                            <field name="foo"/>
                        </tree>
                    </field>
                </form>`,
            resId: 1,
        });

        assert.containsOnce(form, '.o-form-view.o-form-readonly');
        assert.containsN(form, '.o-list-record-remove', 2,
            'remove buttons should be displayed');
        assert.strictEqual(form.$('.o-field-cell[name="foo"]').text(), 'yopblip');

        await testUtils.dom.click(form.$('.o-list-record-remove button')[0]);
        await testUtils.nextTick(); // wait for quick edit

        assert.containsOnce(form, '.o-form-view.o-form-editable',
            'should switch into edit mode');
        assert.containsOnce(form, '.o-data-row', 'only one record should remain');
        assert.strictEqual(form.$('.o-field-cell[name="foo"]').text(), 'blip');

        form.destroy();
    });

    QUnit.test('Quick Edition: Date picker', async function (assert) {
        assert.expect(4);

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `
                <form>
                    <field name="date"/>
                </form>`,
            resId: 1,
        });

        assert.containsOnce(form, '.o-form-view.o-form-readonly');

        await testUtils.dom.click(form.$('.o-field-widget[name="date"]'));

        assert.containsOnce(form, '.o-form-view.o-form-editable',
            'should switch into edit mode');
        assert.strictEqual(document.activeElement, form.$('.o-field-widget[name="date"] input')[0]);
        assert.containsOnce(document.body, '.bootstrap-datetimepicker-widget');

        form.destroy();
    });

    QUnit.test('Quick Edition: Many2one', async function (assert) {
        assert.expect(5);

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `
                <form>
                    <field name="trululu"/>
                </form>`,
            resId: 1,
            mockRPC(route, { method }) {
                assert.step(method);
                return this._super(...arguments);
            },
        });

        assert.containsOnce(form, '.o-form-view.o-form-readonly');

        await testUtils.dom.click(form.$('.o-field-widget[name="trululu"]'));

        assert.containsOnce(form, '.o-form-view.o-form-readonly');
        assert.verifySteps(['read', 'get_formview_action'])

        form.destroy();
    });

    QUnit.test('Quick Edition: Many2Many', async function (assert) {
        assert.expect(6);

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `
                <form>
                    <field name="timmy">
                        <tree>
                            <field name="displayName"/>
                        </tree>
                        <form>
                            <field name="displayName"/>
                        </form>
                    </field>
                </form>`,
            archs: {
                'partner_type,false,list': '<tree><field name="displayName"/></tree>',
                'partner_type,false,search': '<search><field name="displayName"/></search>',
            },
            resId: 1,
        });

        assert.containsOnce(form, '.o-form-view.o-form-readonly');
        assert.containsOnce(form, '.o-field-x2many-list-row-add',
            'create line should be displayed');

        await testUtils.dom.click(form.$('.o-field-x2many-list-row-add a'));
        await testUtils.nextTick(); // wait for quick edit

        assert.containsOnce(form, '.o-form-view.o-form-editable',
            'should switch into edit mode');
        assert.containsOnce(document.body, '.modal',
            'should display a dialog');

        assert.containsNone(form, '.o-field-many2many[name="timmy"] .o-data-row');
        await testUtils.dom.click($('.modal .o-list-view .o-data-row')[0]);
        assert.containsOnce(form, '.o-field-many2many[name="timmy"] .o-data-row');

        form.destroy();
    });

    QUnit.test('Quick Edition: Many2Many checkbox', async function (assert) {
        assert.expect(7);

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `
                <form>
                    <field name="timmy" widget="many2many_checkboxes"/>
                </form>`,
            resId: 1,
        });

        assert.containsOnce(form, '.o-form-view.o-form-readonly');
        assert.containsNone(form, 'input[type="checkbox"]:checked');
        assert.containsNone(form, 'input[type="checkbox"]:disabled');

        await testUtils.dom.click(form.$('.o-field-widget[name="timmy"] label:eq(1)'));

        assert.containsOnce(form, '.o-form-view.o-form-editable');
        assert.containsOnce(form, 'input[type="checkbox"]:checked');
        assert.containsOnce(form, 'input[type="checkbox"]:eq(1):checked');
        assert.containsNone(form, 'input[type="checkbox"]:disabled');

        form.destroy();
    });

    QUnit.test('Quick Edition: Many2Many checkbox readonly', async function (assert) {
        assert.expect(6);

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `
                <form>
                    <field name="timmy" widget="many2many_checkboxes"
                        attrs="{'readonly': 1}"/>
                </form>`,
            resId: 1,
        });

        assert.containsOnce(form, '.o-form-view.o-form-readonly');
        assert.containsNone(form, 'input[type="checkbox"]:checked');
        assert.containsNone(form, 'input[type="checkbox"]:not(:disabled)');

        await testUtils.dom.click(form.$('.o-field-widget[name="timmy"] label:eq(1)'));

        assert.containsOnce(form, '.o-form-view.o-form-readonly');
        assert.containsNone(form, 'input[type="checkbox"]:not(:disabled)');
        assert.containsNone(form, 'input[type="checkbox"]:checked');

        form.destroy();
    });

    QUnit.test('Quick Edition: Many2Many checkbox click on label', async function (assert) {
        assert.expect(4);

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `
                <form>
                    <group>
                        <field name="timmy" widget="many2many_checkboxes"/>
                    </group>
                </form>`,
            resId: 1,
        });

        assert.containsOnce(form, '.o-form-view.o-form-readonly');
        assert.containsNone(form, 'input[type="checkbox"]:checked');

        await testUtils.dom.click(form.$('.o-td-label .o-form-label'));

        assert.containsOnce(form, '.o-form-view.o-form-editable');
        assert.containsNone(form, 'input[type="checkbox"]:checked');

        form.destroy();
    });

    QUnit.test('Quick Edition: Many2one radio', async function (assert) {
        assert.expect(6);

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `
                <form>
                    <field name="trululu" widget="radio"/>
                </form>`,
            resId: 1,
        });

        assert.containsOnce(form, '.o-form-view.o-form-readonly');
        assert.containsNone(form, 'input[type="radio"]:eq(1):checked');
        assert.containsNone(form, 'input[type="radio"]:disabled');

        await testUtils.dom.click(form.$('.o-field-widget[name="trululu"] label:eq(1)'));

        assert.containsOnce(form, '.o-form-view.o-form-editable');
        assert.containsOnce(form, 'input[type="radio"]:eq(1):checked');
        assert.containsNone(form, 'input[type="radio"]:disabled');

        form.destroy();
    });

    QUnit.test('Quick Edition: Many2Many radio readonly', async function (assert) {
        assert.expect(6);

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `
                <form>
                    <field name="trululu" widget="radio"
                        attrs="{'readonly': 1}"/>
                </form>`,
            resId: 1,
        });

        assert.containsOnce(form, '.o-form-view.o-form-readonly');
        assert.containsOnce(form, 'input[type="radio"]:eq(2):checked');
        assert.containsNone(form, 'input[type="radio"]:not(:disabled)');

        await testUtils.dom.click(form.$('.o-field-widget[name="trululu"] label:eq(1)'));

        assert.containsOnce(form, '.o-form-view.o-form-readonly');
        assert.containsOnce(form, 'input[type="radio"]:eq(2):checked');
        assert.containsNone(form, 'input[type="radio"]:not(:disabled)');

        form.destroy();
    });

    QUnit.test('Quick Edition: Many2one radio click on label', async function (assert) {
        assert.expect(4);

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `
                <form>
                    <group>
                        <field name="trululu" widget="radio"/>
                    </group>
                </form>`,
            resId: 1,
        });

        assert.containsOnce(form, '.o-form-view.o-form-readonly');
        assert.containsOnce(form, 'input[type="radio"]:eq(2):checked');

        await testUtils.dom.click(form.$('.o-td-label .o-form-label'));

        assert.containsOnce(form, '.o-form-view.o-form-editable');
        assert.containsOnce(form, 'input[type="radio"]:eq(2):checked');

        form.destroy();
    });

    QUnit.test('Quick Edition: Selection radio click on value', async function (assert) {
        assert.expect(5);

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `
                <form>
                    <group>
                        <field name="state" widget="radio"/>
                    </group>
                </form>`,
            resId: 1,
            mockRPC: function (route, args) {
                if (args.model === 'partner' && args.method === 'write') {
                    assert.step('Write');
                }
                return this._super(route, args);
            },
        });

        assert.containsOnce(form, '.o-form-view.o-form-readonly');
        assert.containsOnce(form, 'input[type="radio"]:eq(0):checked');

        // click on the last value
        await testUtils.dom.click(form.$('.o-radio-item .o-form-label:contains(EF)'));

        // should be switched in edit mode
        assert.containsOnce(form, '.o-form-view.o-form-editable');
        assert.containsOnce(form, 'input[type="radio"]:eq(2):checked');

        assert.verifySteps([], "No write RPC done");

        form.destroy();
    });

    QUnit.test('Quick Edition: non-editable form', async function (assert) {
        assert.expect(3);

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `
                <form edit="0">
                    <group>
                        <field name="foo"/>
                    </group>
                </form>`,
            resId: 1,
        });

        assert.containsOnce(form, '.o-form-view.o-form-readonly');
        await testUtils.dom.click(form.$('.o-form-label'));
        assert.containsOnce(form, '.o-form-view.o-form-readonly');

        await testUtils.dom.click(form.$('.o-field-widget'));
        assert.containsOnce(form, '.o-form-view.o-form-readonly');

        form.destroy();
    });

    QUnit.test('Quick Edition: CopyToClipboard click on value', async function (assert) {
        assert.expect(4);

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `
                <form>
                    <group>
                        <field name="foo" widget="CopyClipboardChar"/>
                    </group>
                </form>`,
            resId: 1,
        });

        assert.containsOnce(form, '.o-form-view.o-form-readonly');
        assert.containsOnce(form, '.o-clipboard-button');

        await testUtils.dom.click(form.$('.o-field-copy'));

        assert.containsOnce(form, '.o-form-view.o-form-editable');
        assert.containsNone(form, '.o-clipboard-button');

        form.destroy();
    });

    QUnit.test('Quick Edition: CopyToClipboard click on copy button', async function (assert) {
        assert.expect(4);

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `
                <form>
                    <group>
                        <field name="foo" widget="CopyClipboardChar"/>
                    </group>
                </form>`,
            resId: 1,
        });

        assert.containsOnce(form, '.o-form-view.o-form-readonly');
        assert.containsOnce(form, '.o-clipboard-button');

        await testUtils.dom.click(form.$('.o-field-copy .o-clipboard-button'));

        assert.containsOnce(form, '.o-form-view.o-form-readonly');
        assert.containsOnce(form, '.o-clipboard-button');

        form.destroy();
    });

    QUnit.test('Quick Edition: selecting text of quick editable field', async function (assert) {
        assert.expect(8);

        const MULTI_CLICK_DELAY = 6498651354; // arbitrary large number to identify setTimeout calls
        let quickEditCB;
        let quickEditTimeoutId;
        let nextId = 1;
        const originalSetTimeout = window.setTimeout;
        const originalClearTimeout = window.clearTimeout;
        patchWithCleanup(window, {
            setTimeout(fn, delay) {
                if (delay === MULTI_CLICK_DELAY) {
                    quickEditCB = fn;
                    quickEditTimeoutId = `quick_edit_${nextId++}`;
                    return quickEditTimeoutId;
                } else {
                    return originalSetTimeout(...arguments);
                }
            },
            clearTimeout(id) {
                if (id === quickEditTimeoutId) {
                    quickEditCB = undefined;
                } else {
                    return originalClearTimeout(...arguments);
                }
            },
        });

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `
                <form>
                    <group>
                        <field name="displayName"/>
                    </group>
                </form>`,
            formMultiClickTime: MULTI_CLICK_DELAY,
            resId: 1,
        });

        assert.containsOnce(form, '.o-form-view.o-form-readonly');

        // text selected by holding and dragging doesn't start quick edit
        window.getSelection().removeAllRanges();
        const range = document.createRange();
        await range.selectNode(form.$('.o-field-widget[name="displayName"]')[0]);
        window.getSelection().addRange(range);
        await testUtils.dom.click(form.$('.o-field-widget[name="displayName"]'));
        await testUtils.nextTick();
        assert.strictEqual(quickEditCB, undefined, "no quickEdit callback should have been set");
        assert.containsOnce(form, '.o-form-view.o-form-readonly');

        // double click selecting text doesn't start quick edit
        window.getSelection().removeAllRanges();
        testUtils.dom.click(form.$('.o-field-widget[name="displayName"]'));
        range.selectNode(form.$('.o-field-widget[name="displayName"]')[0]);
        window.getSelection().addRange(range);
        await testUtils.dom.click(form.$('.o-field-widget[name="displayName"]'));
        await testUtils.nextTick();
        assert.strictEqual(quickEditCB, undefined, "no quickEdit callback should have been set");
        assert.containsOnce(form, '.o-form-view.o-form-readonly');

        // quick edit happens after timeout
        window.getSelection().removeAllRanges();
        await testUtils.dom.click(form.$('.o-field-widget[name="displayName"]'));
        await testUtils.nextTick();
        assert.containsOnce(form, '.o-form-view.o-form-readonly');
        assert.ok(quickEditCB, "quickEdit callback should have been set");
        quickEditCB();
        await testUtils.nextTick();
        await legacyExtraNextTick();
        assert.containsOnce(form, '.o-form-view.o-form-editable');

        form.destroy();
    });

    QUnit.test('Quick Edition: do not bounce edit button when click on label', async function (assert) {
        assert.expect(1);

        const MULTI_CLICK_TIME = 50;

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `
                <form>
                    <group>
                        <field name="displayName"/>
                    </group>
                </form>`,
            formMultiClickTime: MULTI_CLICK_TIME,
            resId: 1,
        });

        await testUtils.dom.click(form.$('.o-form-label'));
        assert.containsNone(form, 'button.o-catch-attention:visible');

        form.destroy();
    });

    QUnit.test('Quick Edition: do not bounce edit button when click on field char', async function (assert) {
        assert.expect(1);

        const MULTI_CLICK_TIME = 50;

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `
                <form>
                    <group>
                        <field name="displayName"/>
                    </group>
                </form>`,
            formMultiClickTime: MULTI_CLICK_TIME,
            resId: 1,
        });

        await testUtils.dom.click(form.$('.o-field-widget'));
        assert.containsNone(form, 'button.o-catch-attention:visible');

        form.destroy();
    });

    QUnit.test('Quick Edition: do not bounce edit button when click on field boolean', async function (assert) {
        assert.expect(1);

        const MULTI_CLICK_TIME = 50;

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `
                <form>
                    <group>
                        <field name="bar"/>
                    </group>
                </form>`,
            formMultiClickTime: MULTI_CLICK_TIME,
            resId: 1,
        });

        await testUtils.dom.click(form.$('.o-field-widget'));
        assert.containsNone(form, 'button.o-catch-attention:visible');

        form.destroy();
    });

    QUnit.test("attach callbacks with long processing in __renderView", async function (assert) {
        /**
         * The main use case of this test is discuss, in which the FormRenderer
         * __renderView method is overridden to perform asynchronous tasks (the
         * update of the chatter Component) resulting in a delay between the
         * appending of the new form content into its element and the
         * "onAttachCallback" calls. This is the purpose of "__renderView"
         * which is meant to do all the async work before the content is appended.
         */
        assert.expect(11);

        let testPromise = Promise.resolve();

        const Renderer = FormRenderer.extend({
            onAttachCallback() {
                assert.step("form.onAttachCallback");
                this._super(...arguments);
            },
            async __renderView() {
                const _super = this._super.bind(this);
                await testPromise;
                return _super();
            },
        });

        // Setup custom field widget
        fieldRegistry.add("customwidget", AbstractField.extend({
            className: "custom-widget",
            onAttachCallback() {
                assert.step("widget.onAttachCallback");
            },
        }));

        const form = await createView({
            arch: `<form><field name="bar" widget="customwidget"/></form>`,
            data: this.data,
            model: 'partner',
            resId: 1,
            View: FormView.extend({
                config: Object.assign({}, FormView.prototype.config, { Renderer }),
            }),
        });

        assert.containsOnce(form, ".custom-widget");
        assert.verifySteps([
            "form.onAttachCallback", // Form attached
            "widget.onAttachCallback", // Initial widget attached
        ]);

        const initialWidget = form.$(".custom-widget")[0];
        testPromise = testUtils.makeTestPromise();

        await testUtils.form.clickEdit(form);

        assert.containsOnce(form, ".custom-widget");
        assert.strictEqual(initialWidget, form.$(".custom-widget")[0], "Widgets have yet to be replaced");
        assert.verifySteps([]);

        testPromise.resolve();
        await testUtils.nextTick();

        assert.containsOnce(form, ".custom-widget");
        assert.notStrictEqual(initialWidget, form.$(".custom-widget")[0], "Widgets have been replaced");
        assert.verifySteps([
            "widget.onAttachCallback", // New widget attached
        ]);

        form.destroy();

        delete fieldRegistry.map.customwidget;
    });

    QUnit.test('field "length" with value 0: can apply onchange', async function (assert) {
        assert.expect(1);

        this.data.partner.fields.length = {string: 'Length', type: 'float', default: 0 };
        this.data.partner.fields.foo.default = "foo default";

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: '<form><field name="foo"/><field name="length"/></form>',
        });

        assert.strictEqual(form.$('input[name=foo]').val(), "foo default",
                        "should contain input with initial value");

        form.destroy();
    });

    QUnit.test('field "length" with value 0: readonly fields are not sent when saving', async function (assert) {
        assert.expect(3);

        this.data.partner.fields.length = {string: 'Length', type: 'float', default: 0 };
        this.data.partner.fields.foo.default = "foo default";

        // define an onchange on displayName to check that the value of readonly
        // fields is correctly sent for onchanges
        this.data.partner.onchanges = {
            displayName: function () {},
            p: function () {},
        };

        const form = await createView({
            View: FormView,
            model: 'partner',
            data: this.data,
            arch: `<form string="Partners">
                    <field name="p">
                        <tree>
                            <field name="displayName"/>
                        </tree>
                        <form string="Partners">
                            <field name="length"/>
                            <field name="displayName"/>
                            <field name="foo" attrs="{\'readonly\': [[\'displayName\', \'=\', \'readonly\']]}"/>
                        </form>
                    </field>
                </form>`,
            mockRPC: function (route, args) {
                if (args.method === 'create') {
                    assert.deepEqual(args.args[0], {
                        p: [[0, args.args[0].p[0][1], {length: 0, displayName: 'readonly'}]]
                    }, "should not have sent the value of the readonly field");
                }
                return this._super.apply(this, arguments);
            },
        });

        await testUtils.dom.click(form.$('.o-field-x2many-list-row-add a'));
        assert.containsOnce(document.body, '.modal input.o-field-widget[name=foo]',
            'foo should be editable');
        await testUtils.fields.editInput($('.modal .o-field-widget[name=foo]'), 'foo value');
        await testUtils.fields.editInput($('.modal .o-field-widget[name=displayName]'), 'readonly');
        assert.containsOnce(document.body, '.modal span.o-field-widget[name=foo]',
            'foo should be readonly');
        await testUtils.dom.clickFirst($('.modal-footer .btn-primary'));

        await testUtils.form.clickSave(form); // save the record
        form.destroy();
    });

});

});
