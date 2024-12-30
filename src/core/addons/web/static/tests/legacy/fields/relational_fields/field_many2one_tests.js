verp.define('web.field_many_to_one_tests', function (require) {
"use strict";

var BasicModel = require('web.BasicModel');
var FormController = require('web.FormController');
var FormView = require('web.FormView');
var ListView = require('web.ListView');
var relationalFields = require('web.relationalFields');
var StandaloneFieldManagerMixin = require('web.StandaloneFieldManagerMixin');
var testUtils = require('web.testUtils');
var Widget = require('web.Widget');

const { legacyExtraNextTick, triggerScroll } = require("@web/../tests/helpers/utils");
const { createWebClient, doAction } = require('@web/../tests/webclient/helpers');
const { browser } = require('@web/core/browser/browser');
const { patchWithCleanup } = require('@web/../tests/helpers/utils');
const cpHelpers = require('@web/../tests/search/helpers');
var createView = testUtils.createView;

QUnit.module('fields', {}, function () {

    QUnit.module('relationalFields', {
        beforeEach: function () {
            this.data = {
                partner: {
                    fields: {
                        displayName: { string: "Displayed name", type: "char" },
                        foo: { string: "Foo", type: "char", default: "My little Foo Value" },
                        bar: { string: "Bar", type: "boolean", default: true },
                        int_field: { string: "int_field", type: "integer", sortable: true },
                        p: { string: "one2many field", type: "one2many", relation: 'partner', relationField: 'trululu' },
                        turtles: { string: "one2many turtle field", type: "one2many", relation: 'turtle', relationField: 'turtle_trululu' },
                        trululu: { string: "Trululu", type: "many2one", relation: 'partner' },
                        timmy: { string: "pokemon", type: "many2many", relation: 'partner_type' },
                        productId: { string: "Product", type: "many2one", relation: 'product' },
                        color: {
                            type: "selection",
                            selection: [['red', "Red"], ['black', "Black"]],
                            default: 'red',
                            string: "Color",
                        },
                        date: { string: "Some Date", type: "date" },
                        datetime: { string: "Datetime Field", type: 'datetime' },
                        userId: { string: "User", type: 'many2one', relation: 'user' },
                        reference: {
                            string: "Reference Field", type: 'reference', selection: [
                                ["product", "Product"], ["partner_type", "Partner Type"], ["partner", "Partner"]]
                        },
                    },
                    records: [{
                        id: 1,
                        displayName: "first record",
                        bar: true,
                        foo: "yop",
                        int_field: 10,
                        p: [],
                        turtles: [2],
                        timmy: [],
                        trululu: 4,
                        userId: 17,
                        reference: 'product,37',
                    }, {
                        id: 2,
                        displayName: "second record",
                        bar: true,
                        foo: "blip",
                        int_field: 9,
                        p: [],
                        timmy: [],
                        trululu: 1,
                        productId: 37,
                        date: "2017-01-25",
                        datetime: "2016-12-12 10:55:05",
                        userId: 17,
                    }, {
                        id: 4,
                        displayName: "aaa",
                        bar: false,
                    }],
                    onchanges: {},
                },
                product: {
                    fields: {
                        name: { string: "Product Name", type: "char" }
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
                        displayName: { string: "Partner Type", type: "char" },
                        name: { string: "Partner Type", type: "char" },
                        color: { string: "Color index", type: "integer" },
                    },
                    records: [
                        { id: 12, displayName: "gold", color: 2 },
                        { id: 14, displayName: "silver", color: 5 },
                    ]
                },
                turtle: {
                    fields: {
                        displayName: { string: "Displayed name", type: "char" },
                        turtle_foo: { string: "Foo", type: "char" },
                        turtle_bar: { string: "Bar", type: "boolean", default: true },
                        turtle_int: { string: "int", type: "integer", sortable: true },
                        turtle_trululu: { string: "Trululu", type: "many2one", relation: 'partner' },
                        turtle_ref: {
                            string: "Reference", type: 'reference', selection: [
                                ["product", "Product"], ["partner", "Partner"]]
                        },
                        productId: { string: "Product", type: "many2one", relation: 'product', required: true },
                        partnerIds: { string: "Partner", type: "many2many", relation: 'partner' },
                    },
                    records: [{
                        id: 1,
                        displayName: "leonardo",
                        turtle_bar: true,
                        turtle_foo: "yop",
                        partnerIds: [],
                    }, {
                        id: 2,
                        displayName: "donatello",
                        turtle_bar: true,
                        turtle_foo: "blip",
                        turtle_int: 9,
                        partnerIds: [2, 4],
                    }, {
                        id: 3,
                        displayName: "raphael",
                        productId: 37,
                        turtle_bar: false,
                        turtle_foo: "kawa",
                        turtle_int: 21,
                        partnerIds: [],
                        turtle_ref: 'product,37',
                    }],
                    onchanges: {},
                },
                user: {
                    fields: {
                        name: { string: "Name", type: "char" },
                        partnerIds: { string: "one2many partners field", type: "one2many", relation: 'partner', relationField: 'userId' },
                    },
                    records: [{
                        id: 17,
                        name: "Aline",
                        partnerIds: [1, 2],
                    }, {
                        id: 19,
                        name: "Christine",
                    }]
                },
            };
        },
    }, function () {
        QUnit.module('FieldMany2One');

        QUnit.test('many2ones in form views', async function (assert) {
            assert.expect(5);
            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form string="Partners">' +
                    '<sheet>' +
                    '<group>' +
                    '<field name="trululu" string="custom label"/>' +
                    '</group>' +
                    '</sheet>' +
                    '</form>',
                archs: {
                    'partner,false,form': '<form string="Partners"><field name="displayName"/></form>',
                },
                resId: 1,
                mockRPC: function (route, args) {
                    if (args.method === 'get_formview_action') {
                        assert.deepEqual(args.args[0], [4], "should call get_formview_action with correct id");
                        return Promise.resolve({
                            resId: 17,
                            type: 'ir.actions.actwindow',
                            target: 'current',
                            resModel: 'res.partner'
                        });
                    }
                    if (args.method === 'get_formview_id') {
                        assert.deepEqual(args.args[0], [4], "should call get_formview_id with correct id");
                        return Promise.resolve(false);
                    }
                    return this._super(route, args);
                },
            });

            testUtils.mock.intercept(form, 'doAction', function (event) {
                assert.strictEqual(event.data.action.resId, 17,
                    "should do a doAction with correct parameters");
            });

            assert.strictEqual(form.$('a.o-form-uri:contains(aaa)').length, 1,
                "should contain a link");
            await testUtils.dom.click(form.$('a.o-form-uri'));

            await testUtils.form.clickEdit(form);

            await testUtils.dom.click(form.$('.o-external-button'));
            assert.strictEqual($('.modal .modal-title').text().trim(), 'Open: custom label',
                "dialog title should display the custom string label");

            // TODO: test that we can edit the record in the dialog, and that
            // the value is correctly updated on close
            form.destroy();
        });

        QUnit.test('editing a many2one, but not changing anything', async function (assert) {
            assert.expect(2);
            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form string="Partners">' +
                    '<sheet>' +
                    '<field name="trululu"/>' +
                    '</sheet>' +
                    '</form>',
                archs: {
                    'partner,false,form': '<form string="Partners"><field name="displayName"/></form>',
                },
                resId: 1,
                mockRPC: function (route, args) {
                    if (args.method === 'get_formview_id') {
                        assert.deepEqual(args.args[0], [4], "should call get_formview_id with correct id");
                        return Promise.resolve(false);
                    }
                    return this._super(route, args);
                },
                viewOptions: {
                    ids: [1, 2],
                },
            });

            await testUtils.form.clickEdit(form);

            // click on the external button (should do an RPC)
            await testUtils.dom.click(form.$('.o-external-button'));
            // save and close modal
            await testUtils.dom.click($('.modal .modal-footer .btn-primary:first'));
            // save form
            await testUtils.form.clickSave(form);
            // click next on pager
            await testUtils.dom.click(form.el.querySelector('.o-pager .o-pager-next'));

            // this checks that the view did not ask for confirmation that the
            // record is dirty
            assert.strictEqual(form.el.querySelector('.o-pager').innerText.trim(), '2 / 2',
                'pager should be at second page');
            form.destroy();
        });

        QUnit.test('context in many2one and default get', async function (assert) {
            assert.expect(1);

            this.data.partner.fields.int_field.default = 14;
            this.data.partner.fields.trululu.default = 2;

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form string="Partners">' +
                    '<field name="int_field"/>' +
                    '<field name="trululu"  context="{\'blip\':int_field}" options=\'{"alwaysReload": true}\'/>' +
                    '</form>',
                mockRPC: function (route, args) {
                    if (args.method === 'name_get') {
                        assert.strictEqual(args.kwargs.context.blip, 14,
                            'context should have been properly sent to the nameget rpc');
                    }
                    return this._super(route, args);
                },
            });
            form.destroy();
        });

        QUnit.test('editing a many2one (with form view opened with external button)', async function (assert) {
            assert.expect(1);
            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form string="Partners">' +
                    '<sheet>' +
                    '<field name="trululu"/>' +
                    '</sheet>' +
                    '</form>',
                archs: {
                    'partner,false,form': '<form string="Partners"><field name="foo"/></form>',
                },
                resId: 1,
                mockRPC: function (route, args) {
                    if (args.method === 'get_formview_id') {
                        return Promise.resolve(false);
                    }
                    return this._super(route, args);
                },
                viewOptions: {
                    ids: [1, 2],
                },
            });

            await testUtils.form.clickEdit(form);

            // click on the external button (should do an RPC)
            await testUtils.dom.click(form.$('.o-external-button'));

            await testUtils.fields.editInput($('.modal input[name="foo"]'), 'brandon');

            // save and close modal
            await testUtils.dom.click($('.modal .modal-footer .btn-primary:first'));
            // save form
            await testUtils.form.clickSave(form);
            // click next on pager
            await testUtils.dom.click(form.el.querySelector('.o-pager .o-pager-next'));

            // this checks that the view did not ask for confirmation that the
            // record is dirty
            assert.strictEqual(form.el.querySelector('.o-pager').innerText.trim(), '2 / 2',
                'pager should be at second page');
            form.destroy();
        });

        QUnit.test('many2ones in form views with show_address', async function (assert) {
            assert.expect(6);
            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form string="Partners">' +
                    '<sheet>' +
                    '<group>' +
                    '<field ' +
                    'name="trululu" ' +
                    'string="custom label" ' +
                    'context="{\'show_address\': 1}" ' +
                    'options="{\'alwaysReload\': true}"' +
                    '/>' +
                    '</group>' +
                    '</sheet>' +
                    '</form>',
                mockRPC: function (route, args) {
                    if (args.method === 'name_get') {
                        return this._super(route, args).then(function (result) {
                            result[0][1] += '\nStreet\nCity ZIP';
                            return result;
                        });
                    }
                    return this._super(route, args);
                },
                resId: 1,
            });

            assert.strictEqual(form.$('a.o-form-uri').html(), '<span>aaa</span><br><span>Street</span><br><span>City ZIP</span>',
                "input should have a multi-line content in readonly due to show_address");
            await testUtils.form.clickEdit(form);

            assert.strictEqual(form.$('input.o-input').val(), 'aaa');
            assert.strictEqual(form.$('.o-field-many2one_extra').html(),
                '<span>Street</span><br><span>City ZIP</span>');

            assert.containsOnce(form, 'button.o-external-button:visible',
                "should have an open record button");

            testUtils.dom.click(form.$('input.o-input'));

            assert.containsOnce(form, 'button.o-external-button:visible',
                "should still have an open record button");
            form.$('input.o-input').trigger('focusout');
            assert.strictEqual($('.modal button:contains(Create and edit)').length, 0,
                "there should not be a quick create modal");

            form.destroy();
        });

        QUnit.test('many2one show_address in edit', async function (assert) {
            assert.expect(6);

            const addresses = {
                "aaa": "\nAAA\nRecord",
                "first record": "\nFirst\nRecord",
                "second record": "\nSecond\nRecord",
            };

            const form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: `
                    <form><sheet><group>
                        <field name="trululu" context="{'show_address': 1}" options="{'alwaysReload': true}"/>
                    </group></sheet></form>
                `,
                mockRPC: function (route, args) {
                    if (args.method === 'name_get') {
                        return this._super(route, args).then(function (result) {
                            result[0][1] += addresses[result[0][1]];
                            return result;
                        });
                    }
                    return this._super(route, args);
                },
                resId: 1,
            });

            await testUtils.form.clickEdit(form);
            assert.strictEqual(form.$('input').val(), 'aaa');
            assert.strictEqual(form.$('.o-field-many2one_extra').html(),
                '<span>AAA</span><br><span>Record</span>');

            await testUtils.fields.editInput(form.$('input'), 'first record');
            await testUtils.fields.many2one.clickHighlightedItem('trululu');

            assert.strictEqual(form.$('input').val(), 'first record');
            assert.strictEqual(form.$('.o-field-many2one_extra').html(),
                '<span>First</span><br><span>Record</span>');

            await testUtils.fields.editInput(form.$('input'), 'second record');
            await testUtils.fields.many2one.clickHighlightedItem('trululu');
            assert.strictEqual(form.$('input').val(), 'second record');
            assert.strictEqual(form.$('.o-field-many2one_extra').html(),
                '<span>Second</span><br><span>Record</span>');

            form.destroy();
        });

        QUnit.test('show_address works in a view embedded in a view of another type', async function (assert) {
            assert.expect(2);

            this.data.turtle.records[1].turtle_trululu = 2;

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form string="Partners">' +
                    '<field name="displayName"/>' +
                    '<field name="turtles"/>' +
                    '</form>',
                resId: 1,
                archs: {
                    "turtle,false,form": '<form string="T">' +
                        '<field name="displayName"/>' +
                        '<field name="turtle_trululu" context="{\'show_address\': 1}" options="{\'alwaysReload\': true}"/>' +
                        '</form>',
                    "turtle,false,list": '<tree>' +
                        '<field name="displayName"/>' +
                        '</tree>',
                },
                mockRPC: function (route, args) {
                    if (args.method === 'name_get') {
                        return this._super(route, args).then(function (result) {
                            if (args.model === 'partner' && args.kwargs.context.show_address) {
                                result[0][1] += '\nrue morgue\nparis 75013';
                            }
                            return result;
                        });
                    }
                    return this._super(route, args);
                },
            });
            // click the turtle field, opens a modal with the turtle form view
            await testUtils.dom.click(form.$('.o-data-row:first td.o-data-cell'));

            assert.strictEqual($('[name="turtle_trululu"] .o-input').val(),
                "second record", "many2one value should be displayed in input");
            assert.strictEqual($('[name="turtle_trululu"] .o-field-many2one_extra').text(),
                "rue morgueparis 75013", "The partner's address should be displayed");
            form.destroy();
        });

        QUnit.test('many2one data is reloaded if there is a context to take into account', async function (assert) {
            assert.expect(2);

            this.data.turtle.records[1].turtle_trululu = 2;

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form string="Partners">' +
                    '<field name="displayName"/>' +
                    '<field name="turtles"/>' +
                    '</form>',
                resId: 1,
                archs: {
                    "turtle,false,form": '<form string="T">' +
                        '<field name="displayName"/>' +
                        '<field name="turtle_trululu" context="{\'show_address\': 1}" options="{\'alwaysReload\': true}"/>' +
                        '</form>',
                    "turtle,false,list": '<tree>' +
                        '<field name="displayName"/>' +
                        '<field name="turtle_trululu"/>' +
                        '</tree>',
                },
                mockRPC: function (route, args) {
                    if (args.method === 'name_get') {
                        return this._super(route, args).then(function (result) {
                            if (args.model === 'partner' && args.kwargs.context.show_address) {
                                result[0][1] += '\nrue morgue\nparis 75013';
                            }
                            return result;
                        });
                    }
                    return this._super(route, args);
                },
            });
            // click the turtle field, opens a modal with the turtle form view
            await testUtils.dom.click(form.$('.o-data-row:first'));

            assert.strictEqual($('.modal [name="turtle_trululu"] .o-input').val(),
                "second record", "many2one value should be displayed in input");
            assert.strictEqual($('.modal [name=turtle_trululu] .o-field-many2one_extra').text(),
                "rue morgueparis 75013", "The partner's address should be displayed");
            form.destroy();
        });

        QUnit.test('many2ones in form views with search more', async function (assert) {
            assert.expect(3);
            this.data.partner.records.push({
                id: 5,
                displayName: "Partner 4",
            }, {
                    id: 6,
                    displayName: "Partner 5",
                }, {
                    id: 7,
                    displayName: "Partner 6",
                }, {
                    id: 8,
                    displayName: "Partner 7",
                }, {
                    id: 9,
                    displayName: "Partner 8",
                }, {
                    id: 10,
                    displayName: "Partner 9",
                });
            this.data.partner.fields.datetime.searchable = true;

            // add custom filter needs this
            patchWithCleanup(browser, {
                setTimeout: (fn) => fn(),
            });

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form string="Partners">' +
                    '<sheet>' +
                    '<group>' +
                    '<field name="trululu"/>' +
                    '</group>' +
                    '</sheet>' +
                    '</form>',
                archs: {
                    'partner,false,list': '<tree><field name="displayName"/></tree>',
                    'partner,false,search': '<search><field name="datetime"/></search>',
                },
                resId: 1,
            });

            await testUtils.form.clickEdit(form);

            await testUtils.fields.many2one.clickOpenDropdown('trululu');
            await testUtils.fields.many2one.clickItem('trululu', 'Search');

            assert.strictEqual($('tr.o-data-row').length, 9, "should display 9 records");

            const modal = document.body.querySelector(".modal");

            await cpHelpers.toggleFilterMenu(modal);
            await cpHelpers.toggleAddCustomFilter(modal);
            assert.strictEqual(modal.querySelector('.o-generator-menu-field').value, 'datetime',
                "datetime field should be selected");
            await cpHelpers.applyFilter(modal);

            assert.strictEqual($('tr.o-data-row').length, 0, "should display 0 records");
            form.destroy();
        });

        QUnit.test('onchanges on many2ones trigger when editing record in form view', async function (assert) {
            assert.expect(10);

            this.data.partner.onchanges.userId = function () { };
            this.data.user.fields.other_field = { string: "Other Field", type: "char" };
            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form string="Partners">' +
                    '<sheet>' +
                    '<group>' +
                    '<field name="userId"/>' +
                    '</group>' +
                    '</sheet>' +
                    '</form>',
                archs: {
                    'user,false,form': '<form string="Users"><field name="other_field"/></form>',
                },
                resId: 1,
                mockRPC: function (route, args) {
                    assert.step(args.method);
                    if (args.method === 'get_formview_id') {
                        return Promise.resolve(false);
                    }
                    if (args.method === 'onchange') {
                        assert.strictEqual(args.args[1].userId, 17,
                            "onchange is triggered with correct userId");
                    }
                    return this._super(route, args);
                },
            });

            // open the many2one in form view and change something
            await testUtils.form.clickEdit(form);
            await testUtils.dom.click(form.$('.o-external-button'));
            await testUtils.fields.editInput($('.modal-body input[name="other_field"]'), 'wood');

            // save the modal and make sure an onchange is triggered
            await testUtils.dom.click($('.modal .modal-footer .btn-primary').first());
            assert.verifySteps(['read', 'get_formview_id', 'load_views', 'read', 'write', 'read', 'onchange']);

            // save the main record, and check that no extra rpcs are done (record
            // is not dirty, only a related record was modified)
            await testUtils.form.clickSave(form);
            assert.verifySteps([]);
            form.destroy();
        });

        QUnit.test("many2one doesn't trigger field_change when being emptied", async function (assert) {
            assert.expect(2);

            const list = await createView({
                arch: `
                    <tree multiEdit="1">
                        <field name="trululu"/>
                    </tree>`,
                data: this.data,
                model: 'partner',
                View: ListView,
            });

            // Select two records
            await testUtils.dom.click(list.$('.o-data-row:eq(0) .o-list-record-selector input'));
            await testUtils.dom.click(list.$('.o-data-row:eq(1) .o-list-record-selector input'));

            await testUtils.dom.click(list.$('.o-data-row:first() .o-data-cell:first()'));

            const $input = list.$('.o-field-widget[name=trululu] input');

            await testUtils.fields.editInput($input, "");
            await testUtils.dom.triggerEvents($input, ['keyup']);

            assert.containsNone(document.body, '.modal',
                "No save should be triggered when removing value");

            await testUtils.fields.many2one.clickHighlightedItem('trululu');

            assert.containsOnce(document.body, '.modal',
                "Saving should be triggered when selecting a value");
            await testUtils.dom.click($('.modal .btn-primary'));

            list.destroy();
        });

        QUnit.test("focus tracking on a many2one in a list", async function (assert) {
            assert.expect(4);

            const list = await createView({
                arch: '<tree editable="top"><field name="trululu"/></tree>',
                archs: {
                    'partner,false,form': '<form string="Partners"><field name="foo"/></form>',
                },
                data: this.data,
                model: 'partner',
                View: ListView,
            });

            // Select two records
            await testUtils.dom.click(list.$('.o-data-row:eq(0) .o-list-record-selector input'));
            await testUtils.dom.click(list.$('.o-data-row:eq(1) .o-list-record-selector input'));

            await testUtils.dom.click(list.$('.o-data-row:first() .o-data-cell:first()'));

            const input = list.$('.o-data-row:first() .o-data-cell:first() input')[0];

            assert.strictEqual(document.activeElement, input, "Input should be focused when activated");

            await testUtils.fields.many2one.createAndEdit('trululu', "ABC");

            // At this point, if the focus is correctly registered by the m2o, there
            // should be only one modal (the "Create" one) and none for saving changes.
            assert.containsOnce(document.body, '.modal', "There should be only one modal");

            await testUtils.dom.click($('.modal .btn:not(.btn-primary)'));

            assert.strictEqual(document.activeElement, input, "Input should be focused after dialog closes");
            assert.strictEqual(input.value, "", "Input should be empty after discard");

            list.destroy();
        });

        QUnit.test('many2one fields with option "noOpen"', async function (assert) {
            assert.expect(3);

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form string="Partners">' +
                    '<sheet>' +
                    '<group>' +
                    '<field name="trululu" options="{&quot;noOpen&quot;: true}" />' +
                    '</group>' +
                    '</sheet>' +
                    '</form>',
                resId: 1,
            });

            assert.containsOnce(form, 'span.o-field-widget[name=trululu]',
                "should be displayed inside a span (sanity check)");
            assert.containsNone(form, 'span.o-form-uri', "should not have an anchor");

            await testUtils.form.clickEdit(form);
            assert.containsNone(form, '.o-field-widget[name=trululu] .o-external-button', "should not have the button to open the record");

            form.destroy();
        });

        QUnit.test('empty many2one field', async function (assert) {
            assert.expect(4);

            const form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: `<form string="Partners">
                        <sheet>
                            <group>
                                <field name="trululu"/>
                            </group>
                        </sheet>
                    </form>`,
                viewOptions: {
                    mode: 'edit',
                },
            });

            const $dropdown = form.$('.o-field-many2one input').autocomplete('widget');
            await testUtils.fields.many2one.clickOpenDropdown('trululu');
            assert.containsNone($dropdown, 'li.o-m2o-dropdown-option',
                'autocomplete should not contains dropdown options');
            assert.containsOnce($dropdown, 'li.o-m2o-start-typing',
                'autocomplete should contains start typing option');

            await testUtils.fields.editAndTrigger(form.$('.o-field-many2one[name="trululu"] input'),
                'abc', 'keydown');
            await testUtils.nextTick();
            assert.containsN($dropdown, 'li.o-m2o-dropdown-option', 2,
                'autocomplete should contains 2 dropdown options');
            assert.containsNone($dropdown, 'li.o-m2o-start-typing',
                'autocomplete should not contains start typing option');

            form.destroy();
        });

        QUnit.test('empty many2one field with node options', async function (assert) {
            assert.expect(2);

            const form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: `<form string="Partners">
                    <sheet>
                        <group>
                            <field name="trululu" options="{'no_create_edit': 1}"/>
                            <field name="productId" options="{'no_create_edit': 1, 'no_quick_create': 1}"/>
                        </group>
                    </sheet>
                </form>`,
                viewOptions: {
                    mode: 'edit',
                },
            });

            const $dropdownTrululu = form.$('.o-field-many2one[name="trululu"] input').autocomplete('widget');
            const $dropdownProduct = form.$('.o-field-many2one[name="productId"] input').autocomplete('widget');
            await testUtils.fields.many2one.clickOpenDropdown('trululu');
            assert.containsOnce($dropdownTrululu, 'li.o-m2o-start-typing',
                'autocomplete should contains start typing option');

            await testUtils.fields.many2one.clickOpenDropdown('productId');
            assert.containsNone($dropdownProduct, 'li.o-m2o-start-typing',
                'autocomplete should contains start typing option');

            form.destroy();
        });

        QUnit.test('many2one in edit mode', async function (assert) {
            assert.expect(17);

            // create 10 partners to have the 'Search More' option in the autocomplete dropdown
            for (var i = 0; i < 10; i++) {
                var id = 20 + i;
                this.data.partner.records.push({ id: id, displayName: "Partner " + id });
            }

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form string="Partners">' +
                    '<sheet>' +
                    '<group>' +
                    '<field name="trululu"/>' +
                    '</group>' +
                    '</sheet>' +
                    '</form>',
                resId: 1,
                archs: {
                    'partner,false,list': '<tree string="Partners"><field name="displayName"/></tree>',
                    'partner,false,search': '<search string="Partners">' +
                        '<field name="displayName" string="Name"/>' +
                        '</search>',
                },
                mockRPC: function (route, args) {
                    if (route === '/web/dataset/callKw/partner/write') {
                        assert.strictEqual(args.args[1].trululu, 20, "should write the correct id");
                    }
                    return this._super.apply(this, arguments);
                },
            });

            // the SelectCreateDialog requests the session, so intercept its custom
            // event to specify a fake session to prevent it from crashing
            testUtils.mock.intercept(form, 'get_session', function (event) {
                event.data.callback({ userContext: {} });
            });

            await testUtils.form.clickEdit(form);

            var $dropdown = form.$('.o-field-many2one input').autocomplete('widget');

            await testUtils.fields.many2one.clickOpenDropdown('trululu');
            assert.ok($dropdown.is(':visible'),
                'clicking on the m2o input should open the dropdown if it is not open yet');
            assert.strictEqual($dropdown.find('li:not(.o-m2o-dropdown-option)').length, 7,
                'autocomplete should contains 8 suggestions');
            assert.strictEqual($dropdown.find('li.o-m2o-dropdown-option').length, 1,
                'autocomplete should contain "Search More"');
            assert.containsNone($dropdown, 'li.o-m2o-start-typing',
                'autocomplete should not contains start typing option if value is available');

            await testUtils.fields.many2one.clickOpenDropdown('trululu');
            assert.ok(!$dropdown.is(':visible'),
                'clicking on the m2o input should close the dropdown if it is open');

            // change the value of the m2o with a suggestion of the dropdown
            await testUtils.fields.many2one.clickOpenDropdown('trululu');
            await testUtils.fields.many2one.clickHighlightedItem('trululu');
            assert.ok(!$dropdown.is(':visible'), 'clicking on a value should close the dropdown');
            assert.strictEqual(form.$('.o-field-many2one input').val(), 'first record',
                'value of the m2o should have been correctly updated');

            // change the value of the m2o with a record in the 'Search More' modal
            await testUtils.fields.many2one.clickOpenDropdown('trululu');
            // click on 'Search More' (mouseenter required by ui-autocomplete)
            await testUtils.fields.many2one.clickItem('trululu', 'Search');
            assert.ok($('.modal .o-list-view').length, "should have opened a list view in a modal");
            assert.ok(!$('.modal .o-list-view .o-list-record-selector').length,
                "there should be no record selector in the list view");
            assert.ok(!$('.modal .modal-footer .o_select_button').length,
                "there should be no 'Select' button in the footer");
            assert.ok($('.modal tbody tr').length > 10, "list should contain more than 10 records");
            const modal = document.body.querySelector(".modal");
            await cpHelpers.editSearch(modal, "P");
            await cpHelpers.validateSearch(modal);
            assert.strictEqual($('.modal tbody tr').length, 10,
                "list should be restricted to records containing a P (10 records)");
            // choose a record
            await testUtils.dom.click($('.modal tbody tr:contains(Partner 20)'));
            assert.ok(!$('.modal').length, "should have closed the modal");
            assert.ok(!$dropdown.is(':visible'), 'should have closed the dropdown');
            assert.strictEqual(form.$('.o-field-many2one input').val(), 'Partner 20',
                'value of the m2o should have been correctly updated');

            // save
            await testUtils.form.clickSave(form);
            assert.strictEqual(form.$('a.o-form-uri').text(), 'Partner 20',
                "should display correct value after save");

            form.destroy();
        });

        QUnit.test('many2one in non edit mode', async function (assert) {
            assert.expect(3);

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form string="Partners">' +
                    '<field name="trululu"/>' +
                    '</form>',
                resId: 1,
            });

            assert.containsOnce(form, 'a.o-form-uri',
                "should display 1 m2o link in form");
            assert.hasAttrValue(form.$('a.o-form-uri'), 'href', "#id=4&model=partner",
                "href should contain id and model");

            // Remove value from many2one and then save, there should not have href with id and model on m2o anchor
            await testUtils.form.clickEdit(form);
            form.$('.o-field-many2one input').val('').trigger('keyup').trigger('focusout');
            await testUtils.form.clickSave(form);

            assert.hasAttrValue(form.$('a.o-form-uri'), 'href', "#",
                "href should have #");

            form.destroy();
        });

        QUnit.test('many2one with co-model whose name field is a many2one', async function (assert) {
            assert.expect(4);

            this.data.product.fields.name = {
                string: 'User Name',
                type: 'many2one',
                relation: 'user',
            };

            const form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form><field name="productId"/></form>',
                archs: {
                    'product,false,form': '<form><field name="label"/></form>',
                },
            });

            await testUtils.fields.many2one.createAndEdit('productId', "ABC");
            assert.containsOnce(document.body, '.modal .o-form-view');

            // quick create 'new value'
            await testUtils.fields.many2one.searchAndClickItem('name', {search: 'new value'});
            assert.strictEqual($('.modal .o-field-many2one input').val(), 'new value');

            await testUtils.dom.click($('.modal .modal-footer .btn-primary')); // save in modal
            assert.containsNone(document.body, '.modal .o-form-view');
            assert.strictEqual(form.$('.o-field-many2one input').val(), 'new value');

            form.destroy();
        });

        QUnit.test('many2one searches with correct value', async function (assert) {
            assert.expect(6);

            var M2O_DELAY = relationalFields.FieldMany2One.prototype.AUTOCOMPLETE_DELAY;
            relationalFields.FieldMany2One.prototype.AUTOCOMPLETE_DELAY = 0;

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form string="Partners">' +
                    '<sheet>' +
                    '<field name="trululu"/>' +
                    '</sheet>' +
                    '</form>',
                resId: 1,
                mockRPC: function (route, args) {
                    if (args.method === 'nameSearch') {
                        assert.step('search: ' + args.kwargs.name);
                    }
                    return this._super.apply(this, arguments);
                },
                viewOptions: {
                    mode: 'edit',
                },
            });

            assert.strictEqual(form.$('.o-field-many2one input').val(), 'aaa',
                "should be initially set to 'aaa'");

            await testUtils.dom.click(form.$('.o-field-many2one input'));
            // unset the many2one -> should search again with ''
            form.$('.o-field-many2one input').val('').trigger('keydown');
            await testUtils.nextTick();
            form.$('.o-field-many2one input').val('p').trigger('keydown').trigger('keyup');
            await testUtils.nextTick();

            // close and re-open the dropdown -> should search with 'p' again
            await testUtils.dom.click(form.$('.o-field-many2one input'));
            await testUtils.dom.click(form.$('.o-field-many2one input'));

            assert.verifySteps(['search: ', 'search: ', 'search: p', 'search: p']);

            relationalFields.FieldMany2One.prototype.AUTOCOMPLETE_DELAY = M2O_DELAY;
            form.destroy();
        });

        QUnit.test('many2one search with trailing and leading spaces', async function (assert) {
            assert.expect(10);

            const form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: `<form><field name="trululu"/></form>`,
                mockRPC: function (route, args) {
                    if (args.method === 'nameSearch') {
                        assert.step('search: ' + args.kwargs.name);
                    }
                    return this._super.apply(this, arguments);
                },
            });

            const $dropdown = form.$('.o-field-many2one input').autocomplete('widget');

            await testUtils.fields.many2one.clickOpenDropdown('trululu');
            assert.isVisible($dropdown);
            assert.containsN($dropdown, 'li:not(.o-m2o-dropdown-option)', 4,
                'autocomplete should contains 4 suggestions');

            // search with leading spaces
            form.$('.o-field-many2one input').val('   first').trigger('keydown').trigger('keyup');
            await testUtils.nextTick();
            assert.containsOnce($dropdown, 'li:not(.o-m2o-dropdown-option)',
                'autocomplete should contains 1 suggestion');

            // search with trailing spaces
            form.$('.o-field-many2one input').val('first  ').trigger('keydown').trigger('keyup');
            await testUtils.nextTick();
            assert.containsOnce($dropdown, 'li:not(.o-m2o-dropdown-option)',
                'autocomplete should contains 1 suggestion');

            // search with leading and trailing spaces
            form.$('.o-field-many2one input').val('   first   ').trigger('keydown').trigger('keyup');
            await testUtils.nextTick();
            assert.containsOnce($dropdown, 'li:not(.o-m2o-dropdown-option)',
                'autocomplete should contains 1 suggestion');

            assert.verifySteps(['search: ', 'search: first', 'search: first', 'search: first']);

            form.destroy();
        });

        QUnit.test('many2one field with option alwaysReload', async function (assert) {
            assert.expect(4);
            var count = 0;
            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form>' +
                    '<field name="trululu" options="{\'alwaysReload\': true}"/>' +
                    '</form>',
                resId: 2,
                mockRPC: function (route, args) {
                    if (args.method === 'name_get') {
                        count++;
                        return Promise.resolve([[1, "first record\nand some address"]]);
                    }
                    return this._super(route, args);
                },
            });

            assert.strictEqual(count, 1, "an extra name_get should have been done");
            assert.ok(form.$('a:contains(and some address)').length,
                "should display additional result");

            await testUtils.form.clickEdit(form);

            assert.strictEqual(form.$('.o-field-widget[name=trululu] input').val(), "first record",
                "actual field value should be displayed to be edited");

            await testUtils.form.clickSave(form);

            assert.ok(form.$('a:contains(and some address)').length,
                "should still display additional result");
            form.destroy();
        });

        QUnit.test('many2one field and list navigation', async function (assert) {
            assert.expect(3);

            var list = await createView({
                View: ListView,
                model: 'partner',
                data: this.data,
                arch: '<tree editable="bottom"><field name="trululu"/></tree>',
            });

            // edit first input, to trigger autocomplete
            await testUtils.dom.click(list.$('.o-data-row .o-data-cell').first());
            await testUtils.fields.editInput(list.$('.o-data-cell input'), '');

            // press keydown, to select first choice
            await testUtils.fields.triggerKeydown(list.$('.o-data-cell input').focus(), 'down');

            // we now check that the dropdown is open (and that the focus did not go
            // to the next line)
            var $dropdown = list.$('.o-field-many2one input').autocomplete('widget');
            assert.ok($dropdown.is(':visible'), "dropdown should be visible");
            assert.hasClass(list.$('.o-data-row:eq(0)'),'o-selected-row',
                'first data row should still be selected');
            assert.doesNotHaveClass(list.$('.o-data-row:eq(1)'), 'o-selected-row',
                'second data row should not be selected');

            list.destroy();
        });

        QUnit.test('standalone many2one field', async function (assert) {
            assert.expect(4);

            var M2O_DELAY = relationalFields.FieldMany2One.prototype.AUTOCOMPLETE_DELAY;
            relationalFields.FieldMany2One.prototype.AUTOCOMPLETE_DELAY = 0;

            var fixture = $('#qunit-fixture');
            var self = this;

            var model = await testUtils.createModel({
                Model: BasicModel,
                data: this.data,
            });
            var record;
            model.makeRecord('coucou', [{
                name: 'partnerId',
                relation: 'partner',
                type: 'many2one',
                value: [1, 'first partner'],
            }]).then(function (recordId) {
                record = model.get(recordId);
            });
            await testUtils.nextTick();
            // create a new widget that uses the StandaloneFieldManagerMixin
            var StandaloneWidget = Widget.extend(StandaloneFieldManagerMixin, {
                init: function (parent) {
                    this._super.apply(this, arguments);
                    StandaloneFieldManagerMixin.init.call(this, parent);
                },
            });
            var parent = new StandaloneWidget(model);
            model.setParent(parent);
            await testUtils.mock.addMockEnvironment(parent, {
                data: self.data,
                mockRPC: function (route, args) {
                    assert.step(args.method);
                    return this._super.apply(this, arguments);
                },
            });

            var relField = new relationalFields.FieldMany2One(parent, 'partnerId', record, {
                mode: 'edit',
                noOpen: true,
            });

            relField.appendTo(fixture);
            await testUtils.nextTick();
            await testUtils.fields.editInput($('input.o-input'), 'xyzzrot');

            await testUtils.fields.many2one.clickItem('partnerId', 'Create');

            assert.containsNone(relField, '.o-external-button',
                "should not have the button to open the record");
            assert.verifySteps(['nameSearch', 'nameCreate']);

            parent.destroy();
            model.destroy();
            relationalFields.FieldMany2One.prototype.AUTOCOMPLETE_DELAY = M2O_DELAY;
        });

        // QUnit.test('onchange on a many2one to a different model', async function (assert) {
        // This test is commented because the mock server does not give the correct response.
        // It should return a couple [id, displayName], but I don't know the logic used
        // by the server, so it's hard to emulate it correctly
        //     assert.expect(2);

        //     this.data.partner.records[0].productId = 41;
        //     this.data.partner.onchanges = {
        //         foo: function(obj) {
        //             obj.productId = 37;
        //         },
        //     };

        //     var form = await createView({
        //         View: FormView,
        //         model: 'partner',
        //         data: this.data,
        //         arch: '<form>' +
        //                 '<field name="foo"/>' +
        //                 '<field name="productId"/>' +
        //             '</form>',
        //         resId: 1,
        //     });
        //     await testUtils.form.clickEdit(form);
        //     assert.strictEqual(form.$('input').eq(1).val(), 'xpad', "initial productId val should be xpad");

        //     testUtils.fields.editInput(form.$('input').eq(0), "let us trigger an onchange");

        //     assert.strictEqual(form.$('input').eq(1).val(), 'xphone', "onchange should have been applied");
        // });

        QUnit.test('form: quick create then save directly', async function (assert) {
            assert.expect(5);

            var prom = testUtils.makeTestPromise();
            var newRecordID;
            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form>' +
                    '<field name="trululu"/>' +
                    '</form>',
                mockRPC: function (route, args) {
                    var result = this._super.apply(this, arguments);
                    if (args.method === 'nameCreate') {
                        assert.step('nameCreate');
                        return prom.then(_.constant(result)).then(function (nameGet) {
                            newRecordID = nameGet[0];
                            return nameGet;
                        });
                    }
                    if (args.method === 'create') {
                        assert.step('create');
                        assert.strictEqual(args.args[0].trululu, newRecordID,
                            "should create with the correct m2o id");
                    }
                    return result;
                },
            });
            await testUtils.fields.many2one.searchAndClickItem('trululu', {search: 'b'});
            await testUtils.form.clickSave(form);

            assert.verifySteps(['nameCreate'],
                "should wait for the nameCreate before creating the record");

            await prom.resolve();
            await testUtils.nextTick();

            assert.verifySteps(['create']);
            form.destroy();
        });

        QUnit.test('form: quick create for field that returns false after nameCreate call', async function (assert) {
            assert.expect(3);
            const form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form><field name="trululu"/></form>',
                mockRPC: function (route, args) {
                    const result = this._super.apply(this, arguments);
                    if (args.method === 'nameCreate') {
                        assert.step('nameCreate');
                        // Resolve the nameCreate call to false. This is possible if
                        // _rec_name for the model of the field is unassigned.
                        return Promise.resolve(false);
                    }
                    return result;
                },
            });
            await testUtils.fields.many2one.searchAndClickItem('trululu', { search: 'beam' });
            assert.verifySteps(['nameCreate'], 'attempt to nameCreate');
            assert.strictEqual(form.$(".o-input-dropdown input").val(), "",
                "the input should contain no text after search and click")
            form.destroy();
        });

        QUnit.test('list: quick create then save directly', async function (assert) {
            assert.expect(8);

            var prom = testUtils.makeTestPromise();
            var newRecordID;
            var list = await createView({
                View: ListView,
                model: 'partner',
                data: this.data,
                arch: '<tree editable="top">' +
                    '<field name="trululu"/>' +
                    '</tree>',
                mockRPC: function (route, args) {
                    var result = this._super.apply(this, arguments);
                    if (args.method === 'nameCreate') {
                        assert.step('nameCreate');
                        return prom.then(_.constant(result)).then(function (nameGet) {
                            newRecordID = nameGet[0];
                            return nameGet;
                        });
                    }
                    if (args.method === 'create') {
                        assert.step('create');
                        assert.strictEqual(args.args[0].trululu, newRecordID,
                            "should create with the correct m2o id");
                    }
                    return result;
                },
            });

            await testUtils.dom.click(list.$buttons.find('.o-list-button-add'));

            await testUtils.fields.many2one.searchAndClickItem('trululu', {search:'b'});
            list.$buttons.find('.o-list-button-add').show();
            testUtils.dom.click(list.$buttons.find('.o-list-button-add'));

            assert.verifySteps(['nameCreate'],
                "should wait for the nameCreate before creating the record");
            assert.containsN(list, '.o-data-row', 4,
                "should wait for the nameCreate before adding the new row");

            await prom.resolve();
            await testUtils.nextTick();

            assert.verifySteps(['create']);
            assert.strictEqual(list.$('.o-data-row:nth(1) .o-data-cell').text(), 'b',
                "created row should have the correct m2o value");
            assert.containsN(list, '.o-data-row', 5, "should have added the fifth row");

            list.destroy();
        });

        QUnit.test('list in form: quick create then save directly', async function (assert) {
            assert.expect(6);

            var prom = testUtils.makeTestPromise();
            var newRecordID;
            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form>' +
                    '<sheet>' +
                    '<field name="p">' +
                    '<tree editable="bottom">' +
                    '<field name="trululu"/>' +
                    '</tree>' +
                    '</field>' +
                    '</sheet>' +
                    '</form>',
                mockRPC: function (route, args) {
                    var result = this._super.apply(this, arguments);
                    if (args.method === 'nameCreate') {
                        assert.step('nameCreate');
                        return prom.then(_.constant(result)).then(function (nameGet) {
                            newRecordID = nameGet[0];
                            return nameGet;
                        });
                    }
                    if (args.method === 'create') {
                        assert.step('create');
                        assert.strictEqual(args.args[0].p[0][2].trululu, newRecordID,
                            "should create with the correct m2o id");
                    }
                    return result;
                },
            });

            await testUtils.dom.click(form.$('.o-field-x2many-list-row-add a'));
            await testUtils.fields.many2one.searchAndClickItem('trululu', {search: 'b'});
            await testUtils.form.clickSave(form);

            assert.verifySteps(['nameCreate'],
                "should wait for the nameCreate before creating the record");

            await prom.resolve();
            await testUtils.nextTick();

            assert.verifySteps(['create']);
            assert.strictEqual(form.$('.o-data-row:first .o-data-cell').text(), 'b',
                "first row should have the correct m2o value");
            form.destroy();
        });

        QUnit.test('list in form: quick create then add a new line directly', async function (assert) {
            // required many2one inside a one2many list: directly after quick creating
            // a new many2one value (before the nameCreate returns), click on add an item:
            // at this moment, the many2one has still no value, and as it is required,
            // the row is discarded if a saveLine is requested. However, it should
            // wait for the nameCreate to return before trying to save the line.
            assert.expect(8);

            this.data.partner.onchanges = {
                trululu: function () { },
            };

            var M2O_DELAY = relationalFields.FieldMany2One.prototype.AUTOCOMPLETE_DELAY;
            relationalFields.FieldMany2One.prototype.AUTOCOMPLETE_DELAY = 0;

            var prom = testUtils.makeTestPromise();
            var newRecordID;
            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form>' +
                    '<sheet>' +
                    '<field name="p">' +
                    '<tree editable="bottom">' +
                    '<field name="trululu" required="1"/>' +
                    '</tree>' +
                    '</field>' +
                    '</sheet>' +
                    '</form>',
                mockRPC: function (route, args) {
                    var result = this._super.apply(this, arguments);
                    if (args.method === 'nameCreate') {
                        return prom.then(_.constant(result)).then(function (nameGet) {
                            newRecordID = nameGet[0];
                            return nameGet;
                        });
                    }
                    if (args.method === 'create') {
                        assert.deepEqual(args.args[0].p[0][2].trululu, newRecordID);
                    }
                    return result;
                },
            });

            await testUtils.dom.click(form.$('.o-field-x2many-list-row-add a'));
            await testUtils.fields.editAndTrigger(form.$('.o-field-many2one input'),
                'b', 'keydown');
            await testUtils.fields.many2one.clickHighlightedItem('trululu');
            await testUtils.dom.click(form.$('.o-field-x2many-list-row-add a'));

            assert.containsOnce(form, '.o-data-row',
                "there should still be only one row");
            assert.hasClass(form.$('.o-data-row'),'o-selected-row',
                "the row should still be in edition");

            await prom.resolve();
            await testUtils.nextTick();

            assert.strictEqual(form.$('.o-data-row:first .o-data-cell').text(), 'b',
                "first row should have the correct m2o value");
            assert.containsN(form, '.o-data-row', 2,
                "there should now be 2 rows");
            assert.hasClass(form.$('.o-data-row:nth(1)'),'o-selected-row',
                "the second row should be in edition");

            await testUtils.form.clickSave(form);

            assert.containsOnce(form, '.o-data-row',
                "there should be 1 row saved (the second one was empty and invalid)");
            assert.strictEqual(form.$('.o-data-row .o-data-cell').text(), 'b',
                "should have the correct m2o value");

            relationalFields.FieldMany2One.prototype.AUTOCOMPLETE_DELAY = M2O_DELAY;
            form.destroy();
        });

        QUnit.test('list in form: create with one2many with many2one', async function (assert) {
            assert.expect(1);

            this.data.partner.fields.p.default = [[0, 0, { displayName: 'new record', p: [] }]];

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form>' +
                    '<sheet>' +
                    '<field name="p">' +
                    '<tree editable="bottom">' +
                    '<field name="displayName"/>' +
                    '<field name="trululu"/>' +
                    '</tree>' +
                    '</field>' +
                    '</sheet>' +
                    '</form>',
                mockRPC: function (route, args) {
                    if (args.method === 'name_get') {
                        throw new Error('Nameget should not be called');
                    }
                    return this._super.apply(this, arguments);
                },
            });

            assert.strictEqual($('td.o-data-cell:first').text(), 'new record',
                "should have created the new record in the o2m with the correct name");

            form.destroy();
        });

        QUnit.test('list in form: create with one2many with many2one (version 2)', async function (assert) {
            // This test simulates the exact same scenario as the previous one,
            // except that the value for the many2one is explicitely set to false,
            // which is stupid, but this happens, so we have to handle it
            assert.expect(1);

            this.data.partner.fields.p.default = [
                [0, 0, { displayName: 'new record', trululu: false, p: [] }]
            ];

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form>' +
                    '<sheet>' +
                    '<field name="p">' +
                    '<tree editable="bottom">' +
                    '<field name="displayName"/>' +
                    '<field name="trululu"/>' +
                    '</tree>' +
                    '</field>' +
                    '</sheet>' +
                    '</form>',
                mockRPC: function (route, args) {
                    if (args.method === 'name_get') {
                        throw new Error('Nameget should not be called');
                    }
                    return this._super.apply(this, arguments);
                },
            });

            assert.strictEqual($('td.o-data-cell:first').text(), 'new record',
                "should have created the new record in the o2m with the correct name");

            form.destroy();
        });

        QUnit.test('item not dropped on discard with empty required field (default_get)', async function (assert) {
            // This test simulates discarding a record that has been created with
            // one of its required field that is empty. When we discard the changes
            // on this empty field, it should not assume that this record should be
            // abandonned, since it has been added (even though it is a new record).
            assert.expect(8);

            this.data.partner.fields.p.default = [
                [0, 0, { displayName: 'new record', trululu: false, p: [] }]
            ];

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form>' +
                    '<sheet>' +
                    '<field name="p">' +
                    '<tree editable="bottom">' +
                    '<field name="displayName"/>' +
                    '<field name="trululu" required="1"/>' +
                    '</tree>' +
                    '</field>' +
                    '</sheet>' +
                    '</form>',
            });

            assert.strictEqual($('tr.o-data-row').length, 1,
                "should have created the new record in the o2m");
            assert.strictEqual($('td.o-data-cell').first().text(), "new record",
                "should have the correct displayed name");

            var requiredElement = $('td.o-data-cell.o-required-modifier');
            assert.strictEqual(requiredElement.length, 1,
                "should have a required field on this record");
            assert.strictEqual(requiredElement.text(), "",
                "should have empty string in the required field on this record");

            testUtils.dom.click(requiredElement);
            // discard by clicking on body
            testUtils.dom.click($('body'));

            assert.strictEqual($('tr.o-data-row').length, 1,
                "should still have the record in the o2m");
            assert.strictEqual($('td.o-data-cell').first().text(), "new record",
                "should still have the correct displayed name");

            // update selector of required field element
            requiredElement = $('td.o-data-cell.o-required-modifier');
            assert.strictEqual(requiredElement.length, 1,
                "should still have the required field on this record");
            assert.strictEqual(requiredElement.text(), "",
                "should still have empty string in the required field on this record");
            form.destroy();
        });

        QUnit.test('list in form: name_get with unique ids (default_get)', async function (assert) {
            assert.expect(1);

            this.data.partner.records[0].displayName = "MyTrululu";
            this.data.partner.fields.p.default = [
                [0, 0, { trululu: 1, p: [] }],
                [0, 0, { trululu: 1, p: [] }]
            ];

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form>' +
                    '<sheet>' +
                    '<field name="p">' +
                    '<tree editable="bottom">' +
                    '<field name="trululu"/>' +
                    '</tree>' +
                    '</field>' +
                    '</sheet>' +
                    '</form>',
                mockRPC: function (route, args) {
                    if (args.method === 'name_get') {
                        throw new Error('should not call name_get');
                    }
                    return this._super.apply(this, arguments);
                },
            });

            assert.strictEqual(form.$('td.o-data-cell').text(), "MyTrululuMyTrululu",
                "both records should have the correct displayName for trululu field");

            form.destroy();
        });

        QUnit.test('list in form: show name of many2one fields in multi-page (default_get)', async function (assert) {
            assert.expect(4);

            this.data.partner.fields.p.default = [
                [0, 0, { displayName: 'record1', trululu: 1, p: [] }],
                [0, 0, { displayName: 'record2', trululu: 2, p: [] }]
            ];

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form>' +
                    '<sheet>' +
                    '<field name="p">' +
                    '<tree editable="bottom" limit="1">' +
                    '<field name="displayName"/>' +
                    '<field name="trululu"/>' +
                    '</tree>' +
                    '</field>' +
                    '</sheet>' +
                    '</form>',
            });

            assert.strictEqual(form.$('td.o-data-cell').first().text(),
                "record1", "should show displayName of 1st record");
            assert.strictEqual(form.$('td.o-data-cell').first().next().text(),
                "first record", "should show displayName of trululu of 1st record");

            await testUtils.dom.click(form.$('button.o-pager-next'));

            assert.strictEqual(form.$('td.o-data-cell').first().text(),
                "record2", "should show displayName of 2nd record");
            assert.strictEqual(form.$('td.o-data-cell').first().next().text(),
                "second record", "should show displayName of trululu of 2nd record");

            form.destroy();
        });

        QUnit.test('list in form: item not dropped on discard with empty required field (onchange in default_get)', async function (assert) {
            // variant of the test "list in form: discard newly added element with
            // empty required field (default_get)", in which the `default_get`
            // performs an `onchange` at the same time. This `onchange` may create
            // some records, which should not be abandoned on discard, similarly
            // to records created directly by `default_get`
            assert.expect(7);

            var M2O_DELAY = relationalFields.FieldMany2One.prototype.AUTOCOMPLETE_DELAY;
            relationalFields.FieldMany2One.prototype.AUTOCOMPLETE_DELAY = 0;

            this.data.partner.fields.productId.default = 37;
            this.data.partner.onchanges = {
                productId: function (obj) {
                    if (obj.productId === 37) {
                        obj.p = [[0, 0, { displayName: "entry", trululu: false }]];
                    }
                },
            };

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form>' +
                    '<field name="productId"/>' +
                    '<field name="p">' +
                    '<tree editable="bottom">' +
                    '<field name="displayName"/>' +
                    '<field name="trululu" required="1"/>' +
                    '</tree>' +
                    '</field>' +
                    '</form>',
            });

            // check that there is a record in the editable list with empty string as required field
            assert.containsOnce(form, '.o-data-row',
                "should have a row in the editable list");
            assert.strictEqual($('td.o-data-cell').first().text(), "entry",
                "should have the correct displayed name");
            var requiredField = $('td.o-data-cell.o-required-modifier');
            assert.strictEqual(requiredField.length, 1,
                "should have a required field on this record");
            assert.strictEqual(requiredField.text(), "",
                "should have empty string in the required field on this record");

            // click on empty required field in editable list record
            testUtils.dom.click(requiredField);
            // click off so that the required field still stay empty
            testUtils.dom.click($('body'));

            // record should not be dropped
            assert.containsOnce(form, '.o-data-row',
                "should not have dropped record in the editable list");
            assert.strictEqual($('td.o-data-cell').first().text(), "entry",
                "should still have the correct displayed name");
            assert.strictEqual($('td.o-data-cell.o-required-modifier').text(), "",
                "should still have empty string in the required field");

            relationalFields.FieldMany2One.prototype.AUTOCOMPLETE_DELAY = M2O_DELAY;
            form.destroy();
        });

        QUnit.test('list in form: item not dropped on discard with empty required field (onchange on list after default_get)', async function (assert) {
            // discarding a record from an `onchange` in a `default_get` should not
            // abandon the record. This should not be the case for following
            // `onchange`, except if an onchange make some changes on the list:
            // in particular, if an onchange make changes on the list such that
            // a record is added, this record should not be dropped on discard
            assert.expect(8);

            var M2O_DELAY = relationalFields.FieldMany2One.prototype.AUTOCOMPLETE_DELAY;
            relationalFields.FieldMany2One.prototype.AUTOCOMPLETE_DELAY = 0;

            this.data.partner.onchanges = {
                productId: function (obj) {
                    if (obj.productId === 37) {
                        obj.p = [[0, 0, { displayName: "entry", trululu: false }]];
                    }
                },
            };

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form>' +
                    '<field name="productId"/>' +
                    '<field name="p">' +
                    '<tree editable="bottom">' +
                    '<field name="displayName"/>' +
                    '<field name="trululu" required="1"/>' +
                    '</tree>' +
                    '</field>' +
                    '</form>',
            });

            // check no record in list
            assert.containsNone(form, '.o-data-row',
                "should have no row in the editable list");

            // select productId to force onchange in editable list
            await testUtils.dom.click(form.$('.o-field-widget[name="productId"] .o-input'));
            await testUtils.dom.click($('.ui-menu-item').first());

            // check that there is a record in the editable list with empty string as required field
            assert.containsOnce(form, '.o-data-row',
                "should have a row in the editable list");
            assert.strictEqual($('td.o-data-cell').first().text(), "entry",
                "should have the correct displayed name");
            var requiredField = $('td.o-data-cell.o-required-modifier');
            assert.strictEqual(requiredField.length, 1,
                "should have a required field on this record");
            assert.strictEqual(requiredField.text(), "",
                "should have empty string in the required field on this record");

            // click on empty required field in editable list record
            await testUtils.dom.click(requiredField);
            // click off so that the required field still stay empty
            await testUtils.dom.click($('body'));

            // record should not be dropped
            assert.containsOnce(form, '.o-data-row',
                "should not have dropped record in the editable list");
            assert.strictEqual($('td.o-data-cell').first().text(), "entry",
                "should still have the correct displayed name");
            assert.strictEqual($('td.o-data-cell.o-required-modifier').text(), "",
                "should still have empty string in the required field");

            relationalFields.FieldMany2One.prototype.AUTOCOMPLETE_DELAY = M2O_DELAY;
            form.destroy();
        });

        QUnit.test('item dropped on discard with empty required field with "Add an item" (invalid on "ADD")', async function (assert) {
            // when a record in a list is added with "Add an item", it should
            // always be dropped on discard if some required field are empty
            // at the record creation.
            assert.expect(6);

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form>' +
                    '<field name="p">' +
                    '<tree editable="bottom">' +
                    '<field name="displayName"/>' +
                    '<field name="trululu" required="1"/>' +
                    '</tree>' +
                    '</field>' +
                    '</form>',
            });

            // Click on "Add an item"
            await testUtils.dom.click(form.$('.o-field-x2many-list-row-add a'));
            var charField = form.$('.o-field-widget.o-field-char[name="displayName"]');
            var requiredField = form.$('.o-field-widget.o-required-modifier[name="trululu"]');
            charField.val("some text");
            assert.strictEqual(charField.length, 1,
                "should have a char field 'displayName' on this record");
            assert.doesNotHaveClass(charField, 'o-required-modifier',
                "the char field should not be required on this record");
            assert.strictEqual(charField.val(), "some text",
                "should have entered text in the char field on this record");
            assert.strictEqual(requiredField.length, 1,
                "should have a required field 'trululu' on this record");
            assert.strictEqual(requiredField.val().trim(), "",
                "should have empty string in the required field on this record");

            // click on empty required field in editable list record
            await testUtils.dom.click(requiredField);
            // click off so that the required field still stay empty
            await testUtils.dom.click($('body'));

            // record should be dropped
            assert.containsNone(form, '.o-data-row',
                "should have dropped record in the editable list");

            form.destroy();
        });

        QUnit.test('item not dropped on discard with empty required field with "Add an item" (invalid on "UPDATE")', async function (assert) {
            // when a record in a list is added with "Add an item", it should
            // be temporarily added to the list when it is valid (e.g. required
            // fields are non-empty). If the record is updated so that the required
            // field is empty, and it is discarded, then the record should not be
            // dropped.
            assert.expect(8);

            var M2O_DELAY = relationalFields.FieldMany2One.prototype.AUTOCOMPLETE_DELAY;
            relationalFields.FieldMany2One.prototype.AUTOCOMPLETE_DELAY = 0;

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form>' +
                    '<field name="p">' +
                    '<tree editable="bottom">' +
                    '<field name="displayName"/>' +
                    '<field name="trululu" required="1"/>' +
                    '</tree>' +
                    '</field>' +
                    '</form>',
            });

            assert.containsNone(form, '.o-data-row',
                "should initially not have any record in the list");

            // Click on "Add an item"
            await testUtils.dom.click(form.$('.o-field-x2many-list-row-add a'));
            assert.containsOnce(form, '.o-data-row',
                "should have a temporary record in the list");

            var $inputEditMode = form.$('.o-field-widget.o-required-modifier[name="trululu"] input');
            assert.strictEqual($inputEditMode.length, 1,
                "should have a required field 'trululu' on this record");
            assert.strictEqual($inputEditMode.val(), "",
                "should have empty string in the required field on this record");

            // add something to required field and leave edit mode of the record
            await testUtils.dom.click($inputEditMode);
            await testUtils.dom.click($('li.ui-menu-item').first());
            await testUtils.dom.click($('body'));

            var $inputReadonlyMode = form.$('.o-data-cell.o-required-modifier');
            assert.containsOnce(form, '.o-data-row',
                "should not have dropped valid record when leaving edit mode");
            assert.strictEqual($inputReadonlyMode.text(), "first record",
                "should have put some content in the required field on this record");

            // remove the required field and leave edit mode of the record
            await testUtils.dom.click($('.o-data-row'));
            assert.containsOnce(form, '.o-data-row',
                "should not have dropped record in the list on discard (invalid on UPDATE)");
            assert.strictEqual($inputReadonlyMode.text(), "first record",
                "should keep previous valid required field content on this record");

            relationalFields.FieldMany2One.prototype.AUTOCOMPLETE_DELAY = M2O_DELAY;
            form.destroy();
        });

        QUnit.test('list in form: default_get with x2many create', async function (assert) {
            assert.expect(3);
            this.data.partner.fields.timmy.default = [
                [0, 0, { displayName: 'brandon is the new timmy', name: 'brandon' }]
            ];
            var displayName = 'brandon is the new timmy';
            this.data.partner.onchanges.timmy = function (obj) {
                obj.int_field = obj.timmy.length;
            };

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form>' +
                    '<sheet>' +
                    '<field name="timmy">' +
                    '<tree editable="bottom">' +
                    '<field name="displayName"/>' +
                    '</tree>' +
                    '</field>' +
                    '<field name="int_field"/>' +
                    '</sheet>' +
                    '</form>',
                mockRPC: function (route, args) {
                    if (args.method === 'create') {
                        assert.deepEqual(args.args[0], {
                            int_field: 2,
                            timmy: [
                                [6, false, []],
                                // LPE TODO 1 taskid-2261084: remove this entire comment including code snippet
                                // when the change in behavior has been thoroughly tested.
                                // We can't distinguish a value coming from a default_get
                                // from one coming from the onchange, and so we can either store and
                                // send it all the time, or never.
                                // [0, args.args[0].timmy[1][1], { displayName: displayName, name: 'brandon' }],
                                [0, args.args[0].timmy[1][1], { displayName: displayName }],
                            ],
                        }, "should send the correct values to create");
                    }
                    return this._super.apply(this, arguments);
                },
            });

            assert.strictEqual($('td.o-data-cell:first').text(), 'brandon is the new timmy',
                "should have created the new record in the m2m with the correct name");
            assert.strictEqual($('input.o-field-integer').val(), '1',
                "should have called and executed the onchange properly");

            // edit the subrecord and save
            displayName = 'new value';
            await testUtils.dom.click(form.$('.o-data-cell'));
            await testUtils.fields.editInput(form.$('.o-data-cell input'), displayName);
            await testUtils.form.clickSave(form);

            form.destroy();
        });

        QUnit.test('list in form: default_get with x2many create and onchange', async function (assert) {
            assert.expect(1);

            this.data.partner.fields.turtles.default = [[6, 0, [2, 3]]];

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form>' +
                    '<sheet>' +
                    '<field name="turtles">' +
                    '<tree editable="bottom">' +
                    '<field name="turtle_foo"/>' +
                    '</tree>' +
                    '</field>' +
                    '<field name="int_field"/>' +
                    '</sheet>' +
                    '</form>',
                mockRPC: function (route, args) {
                    if (args.method === 'create') {
                        assert.deepEqual(args.args[0].turtles, [
                            [4, 2, false],
                            [4, 3, false],
                        ], 'should send proper commands to create method');
                    }
                    return this._super.apply(this, arguments);
                },
            });

            await testUtils.form.clickSave(form);

            form.destroy();
        });

        QUnit.test('list in form: call button in sub view', async function (assert) {
            assert.expect(11);

            this.data.partner.records[0].p = [2];
            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form>' +
                    '<sheet>' +
                    '<field name="p">' +
                    '<tree editable="bottom">' +
                    '<field name="productId"/>' +
                    '</tree>' +
                    '</field>' +
                    '</sheet>' +
                    '</form>',
                resId: 1,
                mockRPC: function (route, args) {
                    if (route === '/web/dataset/callKw/product/get_formview_id') {
                        return Promise.resolve(false);
                    }
                    return this._super.apply(this, arguments);
                },
                intercepts: {
                    execute_action: function (event) {
                        assert.strictEqual(event.data.env.model, 'product',
                            'should call with correct model in env');
                        assert.strictEqual(event.data.env.currentId, 37,
                            'should call with correct currentId in env');
                        assert.deepEqual(event.data.env.resIds, [37],
                            'should call with correct resIds in env');
                        assert.step(event.data.actionData.name);
                    },
                },
                archs: {
                    'product,false,form': '<form string="Partners">' +
                        '<header>' +
                        '<button name="action" type="action" string="Just do it !"/>' +
                        '<button name="object" type="object" string="Just don\'t do it !"/>' +
                        '<field name="displayName"/>' +
                        '</header>' +
                        '</form>',
                },
            });

            await testUtils.form.clickEdit(form);
            await testUtils.dom.click(form.$('td.o-data-cell:first'));
            await testUtils.dom.click(form.$('.o-external-button'));
            await testUtils.dom.click($('button:contains("Just do it !")'));
            assert.verifySteps(['action']);
            await testUtils.dom.click($('button:contains("Just don\'t do it !")'));
            assert.verifySteps([]); // the second button is disabled, it can't be clicked

            await testUtils.dom.click($('.modal .btn-secondary:contains(Discard)'));
            await testUtils.dom.click(form.$('.o-external-button'));
            await testUtils.dom.click($('button:contains("Just don\'t do it !")'));
            assert.verifySteps(['object']);
            form.destroy();
        });

        QUnit.test('X2Many sequence list in modal', async function (assert) {
            assert.expect(5);

            this.data.partner.fields.sequence = { string: 'Sequence', type: 'integer' };
            this.data.partner.records[0].sequence = 1;
            this.data.partner.records[1].sequence = 2;
            this.data.partner.onchanges = {
                sequence: function (obj) {
                    if (obj.id === 2) {
                        obj.sequence = 1;
                        assert.step('onchange sequence');
                    }
                },
            };

            this.data.product.fields.turtle_ids = { string: 'Turtles', type: 'one2many', relation: 'turtle' };
            this.data.product.records[0].turtle_ids = [1];

            this.data.turtle.fields.partner_types_ids = { string: "Partner", type: "one2many", relation: 'partner' };
            this.data.turtle.fields.type_id = { string: "Partner Type", type: "many2one", relation: 'partner_type' };

            this.data.partner_type.fields.partnerIds = { string: "Partner", type: "one2many", relation: 'partner' };
            this.data.partner_type.records[0].partnerIds = [1, 2];

            var form = await createView({
                View: FormView,
                model: 'product',
                data: this.data,
                arch: '<form>' +
                    '<field name="label"/>' +
                    '<field name="turtle_ids" widget="one2many">' +
                    '<tree string="Turtles" editable="bottom">' +
                    '<field name="type_id"/>' +
                    '</tree>' +
                    '</field>' +
                    '</form>',
                archs: {
                    'partner_type,false,form': '<form><field name="partnerIds"/></form>',
                    'partner,false,list': '<tree string="Vendors">' +
                        '<field name="displayName"/>' +
                        '<field name="sequence" widget="handle"/>' +
                        '</tree>',
                },
                resId: 37,
                mockRPC: function (route, args) {
                    if (route === '/web/dataset/callKw/product/read') {
                        return Promise.resolve([{ id: 37, name: 'xphone', displayName: 'leonardo', turtle_ids: [1] }]);
                    }
                    if (route === '/web/dataset/callKw/turtle/read') {
                        return Promise.resolve([{ id: 1, type_id: [12, 'gold'] }]);
                    }
                    if (route === '/web/dataset/callKw/partner_type/get_formview_id') {
                        return Promise.resolve(false);
                    }
                    if (route === '/web/dataset/callKw/partner_type/read') {
                        return Promise.resolve([{ id: 12, partnerIds: [1, 2], displayName: 'gold' }]);
                    }
                    if (route === '/web/dataset/callKw/partner_type/write') {
                        assert.step('partner_type write');
                    }
                    return this._super.apply(this, arguments);
                },
            });

            await testUtils.form.clickEdit(form);
            await testUtils.dom.click(form.$('.o-data-cell'));
            await testUtils.dom.click(form.$('.o-external-button'));

            var $modal = $('.modal');
            assert.equal($modal.length, 1,
                'There should be 1 modal opened');

            var $handles = $modal.find('.ui-sortable-handle');
            assert.equal($handles.length, 2,
                'There should be 2 sequence handlers');

            await testUtils.dom.dragAndDrop($handles.eq(1),
                $modal.find('tbody tr').first(), { position: 'top' });

            // Saving the modal and then the original model
            await testUtils.dom.click($modal.find('.modal-footer .btn-primary'));
            await testUtils.form.clickSave(form);

            assert.verifySteps(['onchange sequence', 'partner_type write']);

            form.destroy();
        });

        QUnit.test('autocompletion in a many2one, in form view with a domain', async function (assert) {
            assert.expect(1);

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form>' +
                    '<field name="productId"/>' +
                    '</form>',
                resId: 1,
                viewOptions: {
                    domain: [['trululu', '=', 4]]
                },
                mockRPC: function (route, args) {
                    if (args.method === 'nameSearch') {
                        assert.deepEqual(args.kwargs.args, [], "should not have a domain");
                    }
                    return this._super(route, args);
                }
            });
            await testUtils.form.clickEdit(form);

            testUtils.dom.click(form.$('.o-field-widget[name=productId] input'));
            form.destroy();
        });

        QUnit.test('autocompletion in a many2one, in form view with a date field', async function (assert) {
            assert.expect(1);

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form>' +
                    '<field name="bar"/>' +
                    '<field name="date"/>' +
                    '<field name="trululu" domain="[(\'bar\',\'=\',true)]"/>' +
                    '</form>',
                resId: 2,
                mockRPC: function (route, args) {
                    if (args.method === 'nameSearch') {
                        assert.deepEqual(args.kwargs.args, [["bar", "=", true]], "should not have a domain");
                    }
                    return this._super(route, args);
                },
            });
            await testUtils.form.clickEdit(form);

            testUtils.dom.click(form.$('.o-field-widget[name=trululu] input'));
            form.destroy();
        });

        QUnit.test('creating record with many2one with option alwaysReload', async function (assert) {
            assert.expect(2);

            this.data.partner.fields.trululu.default = 1;
            this.data.partner.onchanges = {
                trululu: function (obj) {
                    obj.trululu = 2; //[2, "second record"];
                },
            };

            var count = 0;

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form>' +
                    '<field name="trululu" options="{\'alwaysReload\': true}"/>' +
                    '</form>',
                mockRPC: function (route, args) {
                    count++;
                    if (args.method === 'name_get' && args.args[0] === 2) {
                        return Promise.resolve([[2, "hello world\nso much noise"]]);
                    }
                    return this._super(route, args);
                },
            });

            assert.strictEqual(count, 2, "should have done 2 rpcs (onchange and name_get)");
            assert.strictEqual(form.$('.o-field-widget[name=trululu] input').val(), 'hello world',
                "should have taken the correct display name");
            form.destroy();
        });

        QUnit.test('selecting a many2one, then discarding', async function (assert) {
            assert.expect(3);

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form string="Partners">' +
                    '<field name="productId"/>' +
                    '</form>',
                resId: 1,
            });
            assert.strictEqual(form.$('a[name=productId]').text(), '', 'the tag a should be empty');
            await testUtils.form.clickEdit(form);

            await testUtils.fields.many2one.clickOpenDropdown('productId');
            await testUtils.fields.many2one.clickItem('productId','xphone');
            assert.strictEqual(form.$('.o-field-widget[name=productId] input').val(), "xphone", "should have selected xphone");

            await testUtils.form.clickDiscard(form);
            assert.strictEqual(form.$('a[name=productId]').text(), '', 'the tag a should be empty');
            form.destroy();
        });

        QUnit.test('domain and context are correctly used when doing a nameSearch in a m2o', async function (assert) {
            assert.expect(4);

            this.data.partner.records[0].timmy = [12];

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch:
                    '<form string="Partners">' +
                    '<field name="productId" ' +
                    'domain="[[\'foo\', \'=\', \'bar\'], [\'foo\', \'=\', foo]]" ' +
                    'context="{\'hello\': \'world\', \'test\': foo}"/>' +
                    '<field name="foo"/>' +
                    '<field name="trululu" context="{\'timmy\': timmy}" domain="[[\'id\', \'in\', timmy]]"/>' +
                    '<field name="timmy" widget="many2manyTags" invisible="1"/>' +
                    '</form>',
                resId: 1,
                session: { userContext: { hey: "ho" } },
                mockRPC: function (route, args) {
                    if (args.method === 'nameSearch' && args.model === 'product') {
                        assert.deepEqual(
                            args.kwargs.args,
                            [['foo', '=', 'bar'], ['foo', '=', 'yop']],
                            'the field attr domain should have been used for the RPC (and evaluated)');
                        assert.deepEqual(
                            args.kwargs.context,
                            { hey: "ho", hello: "world", test: "yop" },
                            'the field attr context should have been used for the ' +
                            'RPC (evaluated and merged with the session one)');
                        return Promise.resolve([]);
                    }
                    if (args.method === 'nameSearch' && args.model === 'partner') {
                        assert.deepEqual(args.kwargs.args, [['id', 'in', [12]]],
                            'the field attr domain should have been used for the RPC (and evaluated)');
                        assert.deepEqual(args.kwargs.context, { hey: 'ho', timmy: [[6, false, [12]]] },
                            'the field attr context should have been used for the RPC (and evaluated)');
                        return Promise.resolve([]);
                    }
                    return this._super.apply(this, arguments);
                },
            });

            await testUtils.form.clickEdit(form);
            testUtils.dom.click(form.$('.o-field-widget[name=productId] input'));

            testUtils.dom.click(form.$('.o-field-widget[name=trululu] input'));

            form.destroy();
        });

        QUnit.test('quick create on a many2one', async function (assert) {
            assert.expect(2);

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form string="Partners">' +
                    '<sheet>' +
                    '<field name="productId"/>' +
                    '</sheet>' +
                    '</form>',
                mockRPC: function (route, args) {
                    if (route === '/web/dataset/callKw/product/nameCreate') {
                        assert.strictEqual(args.args[0], 'new partner',
                            "should name create a new product");
                    }
                    return this._super.apply(this, arguments);
                },
            });

            await testUtils.dom.triggerEvent(form.$('.o-field-many2one input'),'focus');
            await testUtils.fields.editAndTrigger(form.$('.o-field-many2one input'),
            'new partner', ['keyup', 'blur']);
            await testUtils.dom.click($('.modal .modal-footer .btn-primary').first());
            assert.strictEqual($('.modal .modal-body').text().trim(), "Create new partner as a new Product?");

            form.destroy();
        });

        QUnit.test('failing quick create on a many2one', async function (assert) {
            assert.expect(4);

            const form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form><field name="productId"/></form>',
                archs: {
                    'product,false,form': '<form><field name="label"/></form>',
                },
                mockRPC(route, args) {
                    if (args.method === 'nameCreate') {
                        return Promise.reject();
                    }
                    if (args.method === 'create') {
                        assert.deepEqual(args.args[0], { name: 'xyz' });
                    }
                    return this._super(...arguments);
                },
            });

            await testUtils.fields.many2one.searchAndClickItem('productId', {
                search: 'abcd',
                item: 'Create "abcd"',
            });
            assert.containsOnce(document.body, '.modal .o-form-view');
            assert.strictEqual($('.o-field-widget[name=name]').val(), 'abcd');

            await testUtils.fields.editInput($('.modal .o-field-widget[name=name]'), 'xyz');
            await testUtils.dom.click($('.modal .modal-footer .btn-primary'));
            assert.strictEqual(form.$('.o-field-widget[name=productId] input').val(), 'xyz');

            form.destroy();
        });

        QUnit.test('failing quick create on a many2one inside a one2many', async function (assert) {
            assert.expect(4);

            const form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form><field name="p"/></form>',
                archs: {
                    'partner,false,list': '<tree editable="bottom"><field name="productId"/></tree>',
                    'product,false,form': '<form><field name="label"/></form>',
                },
                mockRPC(route, args) {
                    if (args.method === 'nameCreate') {
                        return Promise.reject();
                    }
                    if (args.method === 'create') {
                        assert.deepEqual(args.args[0], { name: 'xyz' });
                    }
                    return this._super(...arguments);
                },
            });

            await testUtils.dom.click(form.$('.o-field-x2many-list-row-add a'));
            await testUtils.fields.many2one.searchAndClickItem('productId', {
                search: 'abcd',
                item: 'Create "abcd"',
            });
            assert.containsOnce(document.body, '.modal .o-form-view');
            assert.strictEqual($('.o-field-widget[name=name]').val(), 'abcd');

            await testUtils.fields.editInput($('.modal .o-field-widget[name=name]'), 'xyz');
            await testUtils.dom.click($('.modal .modal-footer .btn-primary'));
            assert.strictEqual(form.$('.o-field-widget[name=productId] input').val(), 'xyz');

            form.destroy();
        });

        QUnit.test('slow create on a many2one', async function (assert) {
            assert.expect(11);

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch:
                    '<form>' +
                    '<sheet>' +
                    '<field name="productId" options="{\'quick_create\': false}"/>' +
                    '</sheet>' +
                    '</form>',
                archs: {
                    'product,false,form':
                        '<form>' +
                        '<field name="label"/>' +
                        '</form>',
                },
            });

            // cancel the many2one creation with Discard button
            form.$('.o-field-many2one input').focus().val('new product').trigger('input').trigger('keyup');
            await testUtils.nextTick();
            form.$('.o-field-many2one input').trigger('blur');
            await testUtils.nextTick();
            assert.strictEqual($('.modal').length, 1, "there should be one opened modal");

            await testUtils.dom.click($('.modal .modal-footer .btn:contains(Discard)'));
            assert.strictEqual($('.modal').length, 0, "the modal should be closed");
            assert.strictEqual(form.$('.o-field-many2one input').val(), "",
                'the many2one should not set a value as its creation has been cancelled (with Cancel button)');

            // cancel the many2one creation with Close button
            form.$('.o-field-many2one input').focus().val('new product').trigger('input').trigger('keyup');
            await testUtils.nextTick();
            form.$('.o-field-many2one input').trigger('blur');
            await testUtils.nextTick();
            assert.strictEqual($('.modal').length, 1, "there should be one opened modal");
            await testUtils.dom.click($('.modal .modal-header button'));
            assert.strictEqual(form.$('.o-field-many2one input').val(), "",
                'the many2one should not set a value as its creation has been cancelled (with Close button)');
            assert.strictEqual($('.modal').length, 0, "the modal should be closed");

            // select a new value then cancel the creation of the new one --> restore the previous
            await testUtils.fields.many2one.clickOpenDropdown('productId');
            await testUtils.fields.many2one.clickItem('productId','o');
            assert.strictEqual(form.$('.o-field-many2one input').val(), "xphone", "should have selected xphone");

            form.$('.o-field-many2one input').focus().val('new product').trigger('input').trigger('keyup');
            await testUtils.nextTick();
            form.$('.o-field-many2one input').trigger('blur');
            await testUtils.nextTick();
            assert.strictEqual($('.modal').length, 1, "there should be one opened modal");

            await testUtils.dom.click($('.modal .modal-footer .btn:contains(Discard)'));
            assert.strictEqual(form.$('.o-field-many2one input').val(), "xphone",
                'should have restored the many2one with its previous selected value (xphone)');

            // confirm the many2one creation
            form.$('.o-field-many2one input').focus().val('new product').trigger('input').trigger('keyup');
            await testUtils.nextTick();
            form.$('.o-field-many2one input').trigger('blur');
            await testUtils.nextTick();
            assert.strictEqual($('.modal').length, 1, "there should be one opened modal");

            await testUtils.dom.click($('.modal .modal-footer .btn-primary:contains(Create)'));
            assert.strictEqual($('.modal .o-form-view').length, 1,
                'a new modal should be opened and contain a form view');

            await testUtils.dom.click($('.modal .o-form-button_cancel'));

            form.destroy();
        });

        QUnit.test("select a many2one value by focusing out", async function (assert) {
            assert.expect(3);

            const form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: `<form><field name="productId"/></form>`,
            });

            form.$('.o-field-many2one input').focus().val('xph').trigger('input').trigger('keyup');
            await testUtils.nextTick();
            form.$('.o-field-many2one input').trigger('blur');
            await testUtils.nextTick();

            assert.containsNone(document.body, '.modal');
            assert.strictEqual(form.$('.o-field-many2one input').val(), 'xphone');
            assert.containsOnce(form, '.o-external-button');

            form.destroy();
        });

        QUnit.test('noCreate option on a many2one', async function (assert) {
            assert.expect(2);

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form string="Partners">' +
                    '<sheet>' +
                    '<field name="productId" options="{\'noCreate\': true}"/>' +
                    '</sheet>' +
                    '</form>',
            });

            await testUtils.fields.editInput(form.$('.o-field-many2one input'), 'new partner');
            form.$('.o-field-many2one input').trigger('keyup').trigger('focusout');
            assert.strictEqual($('.modal').length, 0, "should not display the create modal");
            assert.strictEqual(form.$('.o-field-many2one input').val(), "",
                "many2one value should cleared on focusout if many2one is noCreate");
            form.destroy();
        });

        QUnit.test('can_create and canWrite option on a many2one', async function (assert) {
            assert.expect(5);

            this.data.product.options = {
                can_create: "false",
                canWrite: "false",
            };

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form string="Partners">' +
                    '<sheet>' +
                    '<field name="productId" can_create="false" canWrite="false"/>' +
                    '</sheet>' +
                    '</form>',
                archs: {
                    'product,false,form': '<form string="Products"><field name="displayName"/></form>',
                },
                mockRPC: function (route) {
                    if (route === '/web/dataset/callKw/product/get_formview_id') {
                        return Promise.resolve(false);
                    }
                    return this._super.apply(this, arguments);
                },
            });

            await testUtils.dom.click(form.$('.o-field-many2one input'));
            assert.strictEqual($('.ui-autocomplete .o-m2o-dropdown-option:contains(Create)').length, 0,
                "there shouldn't be any option to search and create");

            await testUtils.dom.click($('.ui-autocomplete li:contains(xpad)').mouseenter());
            assert.strictEqual(form.$('.o-field-many2one input').val(), "xpad",
                "the correct record should be selected");
            assert.containsOnce(form, '.o-field-many2one .o-external-button',
                "there should be an external button displayed");

            await testUtils.dom.click(form.$('.o-field-many2one .o-external-button'));
            assert.strictEqual($('.modal .o-form-view.o-form-readonly').length, 1,
                "there should be a readonly form view opened");

            await testUtils.dom.click($('.modal .o-form-button_cancel'));

            await testUtils.fields.editAndTrigger(form.$('.o-field-many2one input'),
                'new product', ['keyup', 'focusout']);
            assert.strictEqual($('.modal').length, 0, "should not display the create modal");
            form.destroy();
        });

        QUnit.test('many2one with can_create=false shows no result item when searched something that doesn\'t exist', async function (assert) {
            assert.expect(2);

            const form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch:
                    `<form string="Partners">
                    <sheet>
                        <field name="productId" can_create="false" canWrite="false"/>
                    </sheet>
                </form>`,
            });

            await testUtils.dom.click(form.$('.o-field-many2one input'));
            await testUtils.fields.editAndTrigger(form.$('.o-field-many2one[name="productId"] input'),
                'abc', 'keydown');
            await testUtils.nextTick();
            assert.strictEqual($('.ui-autocomplete .o-m2o-dropdown-option:contains(Create)').length, 0,
                "there shouldn't be any option to search and create");
            assert.strictEqual($('.ui-autocomplete .ui-menu-item a:contains(No records)').length, 1,
                "there should be option for 'No records'");

            form.destroy();
        });

        QUnit.test('pressing enter in a m2o in an editable list', async function (assert) {
            assert.expect(8);
            var M2O_DELAY = relationalFields.FieldMany2One.prototype.AUTOCOMPLETE_DELAY;
            relationalFields.FieldMany2One.prototype.AUTOCOMPLETE_DELAY = 0;

            var list = await createView({
                View: ListView,
                model: 'partner',
                data: this.data,
                arch: '<tree editable="bottom"><field name="productId"/></tree>',
            });

            await testUtils.dom.click(list.$('td.o-data-cell:first'));
            assert.containsOnce(list, '.o-selected-row',
                "should have a row in edit mode");

            // we now write 'a' and press enter to check that the selection is
            // working, and prevent the navigation
            await testUtils.fields.editInput(list.$('td.o-data-cell input:first'), 'a');
            var $input = list.$('td.o-data-cell input:first');
            var $dropdown = $input.autocomplete('widget');
            assert.ok($dropdown.is(':visible'), "autocomplete dropdown should be visible");

            // we now trigger ENTER to select first choice
            await testUtils.fields.triggerKeydown($input, 'enter');
            assert.strictEqual($input[0], document.activeElement,
                "input should still be focused");

            // we now trigger again ENTER to make sure we can move to next line
            await testUtils.fields.triggerKeydown($input, 'enter');

            assert.notOk(document.contains($input[0]),
                "input should no longer be in dom");
            assert.hasClass(list.$('tr.o-data-row:eq(1)'),'o-selected-row',
                "second row should now be selected");

            // we now write again 'a' in the cell to select xpad. We will now
            // test with the tab key
            await testUtils.fields.editInput(list.$('td.o-data-cell input:first'), 'a');
            var $input = list.$('td.o-data-cell input:first');
            var $dropdown = $input.autocomplete('widget');
            assert.ok($dropdown.is(':visible'), "autocomplete dropdown should be visible");
            await testUtils.fields.triggerKeydown($input, 'tab');

            assert.notOk(document.contains($input[0]),
                "input should no longer be in dom");
            assert.hasClass(list.$('tr.o-data-row:eq(2)'),'o-selected-row',
                "third row should now be selected");
            list.destroy();
            relationalFields.FieldMany2One.prototype.AUTOCOMPLETE_DELAY = M2O_DELAY;
        });

        QUnit.test('pressing ENTER on a \'no_quick_create\' many2one should open a M2ODialog', async function (assert) {
            assert.expect(2);

            var M2O_DELAY = relationalFields.FieldMany2One.prototype.AUTOCOMPLETE_DELAY;
            relationalFields.FieldMany2One.prototype.AUTOCOMPLETE_DELAY = 0;

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form>' +
                    '<field name="trululu" options="{\'no_quick_create\': true}"/>' +
                    '<field name="foo"/>' +
                    '</form>',
                archs: {
                    'partner,false,form': '<form string="Partners"><field name="displayName"/></form>',
                },
            });

            var $input = form.$('.o-field-many2one input');
            await testUtils.fields.editInput($input, "Something that does not exist");
            $('.ui-autocomplete .ui-menu-item a:contains(Create and)').trigger('mouseenter');
            await testUtils.nextTick();
            await testUtils.fields.triggerKey('down', $input, 'enter')
            await testUtils.fields.triggerKey('press', $input, 'enter')
            await testUtils.fields.triggerKey('up', $input, 'enter')
            $input.blur();
            assert.strictEqual($('.modal').length, 1,
                "should have one modal in body");
            // Check that discarding clears $input
            await testUtils.dom.click($('.modal .o-form-button_cancel'));
            assert.strictEqual($input.val(), '',
                "the field should be empty");
            form.destroy();
            relationalFields.FieldMany2One.prototype.AUTOCOMPLETE_DELAY = M2O_DELAY;
        });

        QUnit.test('select a value by pressing TAB on a many2one with onchange', async function (assert) {
            assert.expect(3);

            this.data.partner.onchanges.trululu = function () { };

            var M2O_DELAY = relationalFields.FieldMany2One.prototype.AUTOCOMPLETE_DELAY;
            relationalFields.FieldMany2One.prototype.AUTOCOMPLETE_DELAY = 0;
            var prom = testUtils.makeTestPromise();

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form>' +
                    '<field name="trululu"/>' +
                    '<field name="displayName"/>' +
                    '</form>',
                mockRPC: function (route, args) {
                    var result = this._super.apply(this, arguments);
                    if (args.method === 'onchange') {
                        return prom.then(_.constant(result));
                    }
                    return result;
                },
                resId: 1,
                viewOptions: {
                    mode: 'edit',
                },
            });

            var $input = form.$('.o-field-many2one input');
            await testUtils.fields.editAndTrigger($input, "first", ["keydown", "keyup"]);
            await testUtils.fields.triggerKey('down', $input, 'tab');
            await testUtils.fields.triggerKey('press', $input, 'tab');
            await testUtils.fields.triggerKey('up', $input, 'tab');

            // simulate a focusout (e.g. because the user clicks outside)
            // before the onchange returns
            form.$('.o-field-char').focus();

            assert.strictEqual($('.modal').length, 0,
                "there shouldn't be any modal in body");

            // unlock the onchange
            prom.resolve();
            await testUtils.nextTick();

            assert.strictEqual($input.val(), 'first record',
                "first record should have been selected");
            assert.strictEqual($('.modal').length, 0,
                "there shouldn't be any modal in body");
            relationalFields.FieldMany2One.prototype.AUTOCOMPLETE_DELAY = M2O_DELAY;
            form.destroy();
        });

        QUnit.test('leaving a many2one by pressing tab', async function (assert) {
            assert.expect(3);

            const form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: `<form>
                        <field name="trululu"/>
                        <field name="displayName"/>
                    </form>`,
            });

            const $input = form.$('.o-field-many2one input');
            await testUtils.dom.click($input);
            await testUtils.fields.triggerKeydown($input, 'tab');
            assert.strictEqual($input.val(), '', "no record should have been selected");

            // open autocomplete dropdown and manually select item by UP/DOWN key and press TAB
            await testUtils.dom.click($input);
            await testUtils.fields.triggerKeydown($input, 'down');
            await testUtils.fields.triggerKeydown($input, 'tab');
            assert.strictEqual($input.val(), 'second record', "second record should have been selected");

            // clear many2one and then open autocomplete, write something and press TAB
            await testUtils.fields.editAndTrigger(form.$('.o-field-many2one input'), '', ['keyup', 'blur']);
            await testUtils.dom.triggerEvent($input, 'focus');
            await testUtils.fields.editInput($input, 'se');
            await testUtils.fields.triggerKeydown($input, 'tab');
            assert.strictEqual($input.val(), 'second record', "first record should have been selected");

            form.destroy();
        });

        QUnit.test('leaving an empty many2one by pressing tab (after backspace or delete)', async function (assert) {
            assert.expect(4);

            const form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: `<form>
                        <field name="trululu"/>
                        <field name="displayName"/>
                    </form>`,
                resId: 1,
                viewOptions: {
                    mode: 'edit',
                },
            });

            const $input = form.$('.o-field-many2one input');
            assert.ok($input.val(), "many2one should have value");

            // simulate backspace to remove values and press TAB
            await testUtils.fields.editInput($input, "");
            await testUtils.fields.triggerKeyup($input, 'backspace');
            await testUtils.fields.triggerKeydown($input, 'tab');
            assert.strictEqual($input.val(), '', "no record should have been selected");

            // reset a value
            await testUtils.fields.many2one.clickOpenDropdown('trululu');
            await testUtils.fields.many2one.clickItem('trululu', 'first record');
            assert.ok($input.val(), "many2one should have value");

            // simulate delete to remove values and press TAB
            await testUtils.fields.editInput($input, "");
            await testUtils.fields.triggerKeyup($input, 'delete');
            await testUtils.fields.triggerKeydown($input, 'tab');
            assert.strictEqual($input.val(), '', "no record should have been selected");

            form.destroy();
        });

        QUnit.test('many2one in editable list + onchange, with enter [REQUIRE FOCUS]', async function (assert) {
            assert.expect(6);
            var M2O_DELAY = relationalFields.FieldMany2One.prototype.AUTOCOMPLETE_DELAY;
            relationalFields.FieldMany2One.prototype.AUTOCOMPLETE_DELAY = 0;

            this.data.partner.onchanges.productId = function (obj) {
                obj.int_field = obj.productId || 0;
            };

            var prom = testUtils.makeTestPromise();

            var list = await createView({
                View: ListView,
                model: 'partner',
                data: this.data,
                arch: '<tree editable="bottom"><field name="productId"/><field name="int_field"/></tree>',
                mockRPC: function (route, args) {
                    if (args.method) {
                        assert.step(args.method);
                    }
                    var result = this._super.apply(this, arguments);
                    if (args.method === 'onchange') {
                        return prom.then(_.constant(result));
                    }
                    return result;
                },
            });

            await testUtils.dom.click(list.$('td.o-data-cell:first'));
            await testUtils.fields.editInput(list.$('td.o-data-cell input:first'), 'a');
            var $input = list.$('td.o-data-cell input:first');
            await testUtils.fields.triggerKeydown($input, 'enter');
            await testUtils.fields.triggerKey('up', $input, 'enter');
            prom.resolve();
            await testUtils.nextTick();
            await testUtils.fields.triggerKeydown($input, 'enter');
            assert.strictEqual($('.modal').length, 0, "should not have any modal in DOM");
            assert.verifySteps(['nameSearch', 'onchange', 'write', 'read']);
            list.destroy();
            relationalFields.FieldMany2One.prototype.AUTOCOMPLETE_DELAY = M2O_DELAY;
        });

        QUnit.test('many2one in editable list + onchange, with enter, part 2 [REQUIRE FOCUS]', async function (assert) {
            // this is the same test as the previous one, but the onchange is just
            // resolved slightly later
            assert.expect(6);
            var M2O_DELAY = relationalFields.FieldMany2One.prototype.AUTOCOMPLETE_DELAY;
            relationalFields.FieldMany2One.prototype.AUTOCOMPLETE_DELAY = 0;

            this.data.partner.onchanges.productId = function (obj) {
                obj.int_field = obj.productId || 0;
            };

            var prom = testUtils.makeTestPromise();

            var list = await createView({
                View: ListView,
                model: 'partner',
                data: this.data,
                arch: '<tree editable="bottom"><field name="productId"/><field name="int_field"/></tree>',
                mockRPC: function (route, args) {
                    if (args.method) {
                        assert.step(args.method);
                    }
                    var result = this._super.apply(this, arguments);
                    if (args.method === 'onchange') {
                        return prom.then(_.constant(result));
                    }
                    return result;
                },
            });

            await testUtils.dom.click(list.$('td.o-data-cell:first'));
            await testUtils.fields.editInput(list.$('td.o-data-cell input:first'), 'a');
            var $input = list.$('td.o-data-cell input:first');
            await testUtils.fields.triggerKeydown($input, 'enter');
            await testUtils.fields.triggerKey('up', $input, 'enter');
            await testUtils.fields.triggerKeydown($input, 'enter');
            prom.resolve();
            await testUtils.nextTick();
            assert.strictEqual($('.modal').length, 0, "should not have any modal in DOM");
            assert.verifySteps(['nameSearch', 'onchange', 'write', 'read']);
            list.destroy();
            relationalFields.FieldMany2One.prototype.AUTOCOMPLETE_DELAY = M2O_DELAY;
        });

        QUnit.test('many2one: domain updated by an onchange', async function (assert) {
            assert.expect(2);

            this.data.partner.onchanges = {
                int_field: function () { },
            };

            var domain = [];
            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form>' +
                    '<field name="int_field"/>' +
                    '<field name="trululu"/>' +
                    '</form>',
                resId: 1,
                mockRPC: function (route, args) {
                    if (args.method === 'onchange') {
                        domain = [['id', 'in', [10]]];
                        return Promise.resolve({
                            domain: {
                                trululu: domain,
                                unexisting_field: domain,
                            }
                        });
                    }
                    if (args.method === 'nameSearch') {
                        assert.deepEqual(args.kwargs.args, domain,
                            "sent domain should be correct");
                    }
                    return this._super(route, args);
                },
                viewOptions: {
                    mode: 'edit',
                },
            });

            // trigger a nameSearch (domain should be [])
            await testUtils.dom.click(form.$('.o-field-widget[name=trululu] input'));
            // close the dropdown
            await testUtils.dom.click(form.$('.o-field-widget[name=trululu] input'));
            // trigger an onchange that will update the domain
            await testUtils.fields.editInput(form.$('.o-field-widget[name=int_field]'), 2);
            // trigger a nameSearch (domain should be [['id', 'in', [10]]])
            await testUtils.dom.click(form.$('.o-field-widget[name=trululu] input'));

            form.destroy();
        });

        QUnit.test('many2one in one2many: domain updated by an onchange', async function (assert) {
            assert.expect(3);

            this.data.partner.onchanges = {
                trululu: function () { },
            };

            var domain = [];
            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form>' +
                    '<field name="p">' +
                    '<tree editable="bottom">' +
                    '<field name="foo"/>' +
                    '<field name="trululu"/>' +
                    '</tree>' +
                    '</field>' +
                    '</form>',
                resId: 1,
                mockRPC: function (route, args) {
                    if (args.method === 'onchange') {
                        return Promise.resolve({
                            domain: {
                                trululu: domain,
                            },
                        });
                    }
                    if (args.method === 'nameSearch') {
                        assert.deepEqual(args.kwargs.args, domain,
                            "sent domain should be correct");
                    }
                    return this._super(route, args);
                },
                viewOptions: {
                    mode: 'edit',
                },
            });

            // add a first row with a specific domain for the m2o
            domain = [['id', 'in', [10]]]; // domain for subrecord 1
            await testUtils.dom.click(form.$('.o-field-x2many-list-row-add a'));
            await testUtils.dom.click(form.$('.o-field-widget[name=trululu] input'));
            // add some value to foo field to make record dirty
            await testUtils.fields.editInput(form.$('tr.o-selected-row input[name="foo"]'), 'new value');

            // add a second row with another domain for the m2o
            domain = [['id', 'in', [5]]]; // domain for subrecord 2
            await testUtils.dom.click(form.$('.o-field-x2many-list-row-add a'));
            await testUtils.dom.click(form.$('.o-field-widget[name=trululu] input'));

            // check again the first row to ensure that the domain hasn't change
            domain = [['id', 'in', [10]]]; // domain for subrecord 1 should have been kept
            await testUtils.dom.click(form.$('.o-data-row:first .o-data-cell:eq(1)'));
            await testUtils.dom.click(form.$('.o-field-widget[name=trululu] input'));

            form.destroy();
        });

        QUnit.test('search more in many2one: no text in input', async function (assert) {
            // when the user clicks on 'Search More...' in a many2one dropdown, and there is no text
            // in the input (i.e. no value to search on), we bypass the nameSearch that is meant to
            // return a list of preselected ids to filter on in the list view (opened in a dialog)
            assert.expect(6);

            for (var i = 0; i < 8; i++) {
                this.data.partner.records.push({id: 100 + i, displayName: 'test_' + i});
            }

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form><field name="trululu"/></form>',
                archs: {
                    'partner,false,list': '<list><field name="displayName"/></list>',
                    'partner,false,search': '<search></search>',
                },
                mockRPC: function (route, args) {
                    assert.step(args.method || route);
                    if (route === '/web/dataset/searchRead') {
                        assert.deepEqual(args.domain, [],
                            "should not preselect ids as there as nothing in the m2o input");
                    }
                    return this._super.apply(this, arguments);
                },
            });

            await testUtils.fields.many2one.searchAndClickItem('trululu', {
                item: 'Search More',
                search: '',
            });

            assert.verifySteps([
                'onchange',
                'nameSearch', // to display results in the dropdown
                'load_views', // list view in dialog
                '/web/dataset/searchRead', // to display results in the dialog
            ]);

            form.destroy();
        });

        QUnit.test('search more in many2one: text in input', async function (assert) {
            // when the user clicks on 'Search More...' in a many2one dropdown, and there is some
            // text in the input, we perform a nameSearch to get a (limited) list of preselected
            // ids and we add a dynamic filter (with those ids) to the search view in the dialog, so
            // that the user can remove this filter to bypass the limit
            assert.expect(12);

            for (var i = 0; i < 8; i++) {
                this.data.partner.records.push({id: 100 + i, displayName: 'test_' + i});
            }

            var expectedDomain;
            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form><field name="trululu"/></form>',
                archs: {
                    'partner,false,list': '<list><field name="displayName"/></list>',
                    'partner,false,search': '<search></search>',
                },
                mockRPC: function (route, args) {
                    assert.step(args.method || route);
                    if (route === '/web/dataset/searchRead') {
                        assert.deepEqual(args.domain, expectedDomain);
                    }
                    return this._super.apply(this, arguments);
                },
            });

            expectedDomain = [['id', 'in', [100, 101, 102, 103, 104, 105, 106, 107]]];
            await testUtils.fields.many2one.searchAndClickItem('trululu', {
                item: 'Search More',
                search: 'test',
            });

            assert.containsOnce(document.body, '.modal .o-list-view');
            assert.containsOnce(document.body, '.modal .o-cp-searchview .o-facet-values',
                "should have a special facet for the pre-selected ids");

            // remove the filter on ids
            expectedDomain = [];
            await testUtils.dom.click($('.modal .o-cp-searchview .o-facet-remove'));

            assert.verifySteps([
                'onchange',
                'nameSearch', // empty search, triggered when the user clicks in the input
                'nameSearch', // to display results in the dropdown
                'nameSearch', // to get preselected ids matching the search
                'load_views', // list view in dialog
                '/web/dataset/searchRead', // to display results in the dialog
                '/web/dataset/searchRead', // after removal of dynamic filter
            ]);

            form.destroy();
        });

        QUnit.test('search more in many2one: dropdown click', async function (assert) {
            assert.expect(8);

            for (let i = 0; i < 8; i++) {
                this.data.partner.records.push({id: 100 + i, displayName: 'test_' + i});
            }

            // simulate modal-like element rendered by the field html
            const $fakeDialog = $(`<div>
                <div class="pouet">
                    <div class="modal"></div>
                </div>
            </div>`);
            $('body').append($fakeDialog);

            const form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form><field name="trululu"/></form>',
                archs: {
                    'partner,false,list': '<list><field name="displayName"/></list>',
                    'partner,false,search': '<search></search>',
                },
            });
            await testUtils.fields.many2one.searchAndClickItem('trululu', {
                item: 'Search More',
                search: 'test',
            });

            // dropdown selector
            let filterMenuCss = '.o-search-options > .o-filter-menu';
            let groupByMenuCss = '.o-search-options > .o-group-by-menu';

            await testUtils.dom.click(document.querySelector(`${filterMenuCss} > .dropdown-toggle`));

            assert.hasClass(document.querySelector(filterMenuCss), 'show');
            assert.isVisible(document.querySelector(`${filterMenuCss} > .dropdown-menu`),
                "the filter dropdown menu should be visible");
            assert.doesNotHaveClass(document.querySelector(groupByMenuCss), 'show');
            assert.isNotVisible(document.querySelector(`${groupByMenuCss} > .dropdown-menu`),
                "the Group by dropdown menu should be not visible");

            await testUtils.dom.click(document.querySelector(`${groupByMenuCss} > .dropdown-toggle`));
            assert.hasClass(document.querySelector(groupByMenuCss), 'show');
            assert.isVisible(document.querySelector(`${groupByMenuCss} > .dropdown-menu`),
                "the group by dropdown menu should be visible");
            assert.doesNotHaveClass(document.querySelector(filterMenuCss), 'show');
            assert.isNotVisible(document.querySelector(`${filterMenuCss} > .dropdown-menu`),
                "the filter dropdown menu should be not visible");

            $fakeDialog.remove();
            form.destroy();
        });

        QUnit.test('updating a many2one from a many2many', async function (assert) {
            assert.expect(4);

            this.data.turtle.records[1].turtle_trululu = 1;

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form string="Partners">' +
                    '<group>' +
                    '<field name="turtles">' +
                    '<tree editable="bottom">' +
                    '<field name="displayName"/>' +
                    '<field name="turtle_trululu"/>' +
                    '</tree>' +
                    '</field>' +
                    '</group>' +
                    '</form>',
                resId: 1,
                archs: {
                    'partner,false,form': '<form string="Trululu"><field name="displayName"/></form>',
                },
                mockRPC: function (route, args) {
                    if (args.method === 'get_formview_id') {
                        assert.deepEqual(args.args[0], [1], "should call get_formview_id with correct id");
                        return Promise.resolve(false);
                    }
                    return this._super(route, args);
                },
            });

            // Opening the modal
            await testUtils.form.clickEdit(form);
            await testUtils.dom.click(form.$('.o-data-row td:contains(first record)'));
            await testUtils.dom.click(form.$('.o-external-button'));
            assert.strictEqual($('.modal').length, 1,
                "should have one modal in body");

            // Changing the 'trululu' value
            await testUtils.fields.editInput($('.modal input[name="displayName"]'), 'test');
            await testUtils.dom.click($('.modal button.btn-primary'));

            // Test whether the value has changed
            assert.strictEqual($('.modal').length, 0,
                "the modal should be closed");
            assert.equal(form.$('.o-data-cell:contains(test)').text(), 'test',
                "the partner name should have been updated to 'test'");

            form.destroy();
        });

        QUnit.test('search more in many2one: resequence inside dialog', async function (assert) {
            // when the user clicks on 'Search More...' in a many2one dropdown, resequencing inside
            // the dialog works
            assert.expect(10);

            this.data.partner.fields.sequence = { string: 'Sequence', type: 'integer' };
            for (var i = 0; i < 8; i++) {
                this.data.partner.records.push({id: 100 + i, displayName: 'test_' + i});
            }

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form><field name="trululu"/></form>',
                archs: {
                    'partner,false,list': '<list>' +
                        '<field name="sequence" widget="handle"/>' +
                        '<field name="displayName"/>' +
                    '</list>',
                    'partner,false,search': '<search></search>',
                },
                mockRPC: function (route, args) {
                    assert.step(args.method || route);
                    if (route === '/web/dataset/searchRead') {
                        assert.deepEqual(args.domain, [],
                            "should not preselect ids as there as nothing in the m2o input");
                    }
                    return this._super.apply(this, arguments);
                },
            });

            await testUtils.fields.many2one.searchAndClickItem('trululu', {
                item: 'Search More',
                search: '',
            });

            var $modal = $('.modal');
            assert.equal($modal.length, 1,
                'There should be 1 modal opened');

            var $handles = $modal.find('.ui-sortable-handle');
            assert.equal($handles.length, 11,
                'There should be 11 sequence handlers');

            await testUtils.dom.dragAndDrop($handles.eq(1),
                $modal.find('tbody tr').first(), { position: 'top' });

            assert.verifySteps([
                'onchange',
                'nameSearch', // to display results in the dropdown
                'load_views', // list view in dialog
                '/web/dataset/searchRead', // to display results in the dialog
                '/web/dataset/resequence', // resequencing lines
                'read',
            ]);

            form.destroy();
        });

        QUnit.test('many2one dropdown disappears on scroll', async function (assert) {
            assert.expect(4);

            this.data.partner.records[0].displayName = "Veeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeery Loooooooooooooooooooooooooooooooooooooooooooong Naaaaaaaaaaaaaaaaaaaaaaaaaaaaaaame";

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch:
                    '<form>' +
                        '<div style="height: 2000px;">' +
                            '<field name="trululu"/>' +
                        '</div>' +
                    '</form>',
                resId: 1,
            });

            await testUtils.form.clickEdit(form);

            var $input = form.$('.o-field-many2one input');
            var dropdown = document.querySelector(".dropdown-menu.ui-front");

            await testUtils.dom.click($input);
            assert.isVisible($input.autocomplete('widget'), "dropdown should be opened");

            await triggerScroll(dropdown, { left: 50 }, false);
            assert.strictEqual(dropdown.scrollLeft, 50, "a scroll happened");
            assert.isVisible($input.autocomplete('widget'), "dropdown stays open if the scroll is inside the dropdown");

            await triggerScroll(window, { top: 50 });
            assert.isNotVisible($input.autocomplete('widget'), "dropdown closes if the scroll is outside the dropdown");

            form.destroy();
        });

        QUnit.test('x2many list sorted by many2one', async function (assert) {
            assert.expect(3);

            this.data.partner.records[0].p = [1, 2, 4];
            this.data.partner.fields.trululu.sortable = true;

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form>' +
                    '<field name="p">' +
                    '<tree>' +
                    '<field name="id"/>' +
                    '<field name="trululu"/>' +
                    '</tree>' +
                    '</field>' +
                    '</form>',
                resId: 1,
            });

            assert.strictEqual(form.$('.o-data-row .o-list-number').text(), '124',
                "should have correct order initially");

            await testUtils.dom.click(form.$('.o-list-view thead th:nth(1)'));

            assert.strictEqual(form.$('.o-data-row .o-list-number').text(), '412',
                "should have correct order (ASC)");

            await testUtils.dom.click(form.$('.o-list-view thead th:nth(1)'));

            assert.strictEqual(form.$('.o-data-row .o-list-number').text(), '214',
                "should have correct order (DESC)");

            form.destroy();
        });

        QUnit.test('one2many with extra field from server not in form', async function (assert) {
            assert.expect(6);

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form string="Partners">' +
                        '<field name="p" >' +
                            '<tree>' +
                                '<field name="datetime"/>' +
                                '<field name="displayName"/>' +
                            '</tree>' +
                        '</field>' +
                    '</form>',
                resId: 1,
                archs: {
                    'partner,false,form': '<form>' +
                                            '<field name="displayName"/>' +
                                        '</form>'},
                mockRPC: function(route, args) {
                    if (route === '/web/dataset/callKw/partner/write') {
                        args.args[1].p[0][2].datetime = '2018-04-05 12:00:00';
                    }
                    return this._super.apply(this, arguments);
                }
            });

            await testUtils.form.clickEdit(form);

            var x2mList = form.$('.o-field-x2many_list[name=p]');

            // Add a record in the list
            await testUtils.dom.click(x2mList.find('.o-field-x2many-list-row-add a'));

            var modal = $('.modal-lg');

            var nameInput = modal.find('input.o-input[name=displayName]');
            await testUtils.fields.editInput(nameInput, 'michelangelo');

            // Save the record in the modal (though it is still virtual)
            await testUtils.dom.click(modal.find('.btn-primary').first());

            assert.equal(x2mList.find('.o-data-row').length, 1,
                'There should be 1 records in the x2m list');

            var newlyAdded = x2mList.find('.o-data-row').eq(0);

            assert.equal(newlyAdded.find('.o-data-cell').first().text(), '',
                'The createdAt field should be empty');
            assert.equal(newlyAdded.find('.o-data-cell').eq(1).text(), 'michelangelo',
                'The display name field should have the right value');

            // Save the whole thing
            await testUtils.form.clickSave(form);

            x2mList = form.$('.o-field-x2many_list[name=p]');

            // Redo asserts in RO mode after saving
            assert.equal(x2mList.find('.o-data-row').length, 1,
                'There should be 1 records in the x2m list');

            newlyAdded = x2mList.find('.o-data-row').eq(0);

            assert.equal(newlyAdded.find('.o-data-cell').first().text(), '04/05/2018 12:00:00',
                'The createdAt field should have the right value');
            assert.equal(newlyAdded.find('.o-data-cell').eq(1).text(), 'michelangelo',
                'The display name field should have the right value');

            form.destroy();
        });

        QUnit.test('one2many with extra field from server not in (inline) form', async function (assert) {
            assert.expect(1);

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form string="Partners">' +
                        '<field name="p" >' +
                            '<tree>' +
                                '<field name="datetime"/>' +
                                '<field name="displayName"/>' +
                            '</tree>' +
                            '<form>' +
                                '<field name="displayName"/>' +
                            '</form>' +
                        '</field>' +
                    '</form>',
                resId: 1,
                viewOptions: {
                    mode: 'edit',
                },
            });

            var x2mList = form.$('.o-field-x2many_list[name=p]');

            // Add a record in the list
            await testUtils.dom.click(x2mList.find('.o-field-x2many-list-row-add a'));

            var modal = $('.modal-lg');

            var nameInput = modal.find('input.o-input[name=displayName]');
            await testUtils.fields.editInput(nameInput, 'michelangelo');

            // Save the record in the modal (though it is still virtual)
            await testUtils.dom.click(modal.find('.btn-primary').first());

            assert.equal(x2mList.find('.o-data-row').length, 1,
                'There should be 1 records in the x2m list');

            form.destroy();
        });

        QUnit.test('one2many with extra X2many field from server not in inline form', async function (assert) {
            assert.expect(1);

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form string="Partners">' +
                        '<field name="p" >' +
                            '<tree>' +
                                '<field name="turtles"/>' +
                                '<field name="displayName"/>' +
                            '</tree>' +
                            '<form>' +
                                '<field name="displayName"/>' +
                            '</form>' +
                        '</field>' +
                    '</form>',
                resId: 1,
                viewOptions: {
                    mode: 'edit',
                },
            });

            var x2mList = form.$('.o-field-x2many_list[name=p]');

            // Add a first record in the list
            await testUtils.dom.click(x2mList.find('.o-field-x2many-list-row-add a'));

            // Save & New
            await testUtils.dom.click($('.modal-lg').find('.btn-primary').eq(1));

            // Save & Close
            await testUtils.dom.click($('.modal-lg').find('.btn-primary').eq(0));

            assert.equal(x2mList.find('.o-data-row').length, 2,
                'There should be 2 records in the x2m list');

            form.destroy();
        });

        QUnit.test('one2many invisible depends on parent field', async function (assert) {
            assert.expect(4);

            this.data.partner.records[0].p = [2];
            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch:'<form string="Partners">' +
                        '<sheet>' +
                            '<group>' +
                                '<field name="productId"/>' +
                            '</group>' +
                            '<notebook>' +
                                '<page string="Partner page">' +
                                    '<field name="bar"/>' +
                                    '<field name="p">' +
                                        '<tree>' +
                                            '<field name="foo" attrs="{\'column_invisible\': [(\'parent.productId\', \'!=\', false)]}"/>' +
                                            '<field name="bar" attrs="{\'column_invisible\': [(\'parent.bar\', \'=\', false)]}"/>' +
                                        '</tree>' +
                                    '</field>' +
                                '</page>' +
                            '</notebook>' +
                        '</sheet>' +
                    '</form>',
                resId: 1,
            });
            assert.containsN(form, 'th:not(.o-list-record-remove-header)', 2,
                "should be 2 columns in the one2many");
            await testUtils.form.clickEdit(form);
            await testUtils.dom.click(form.$('.o-field-many2one[name="productId"] input'));
            await testUtils.dom.click($('li.ui-menu-item a:contains(xpad)').trigger('mouseenter'));
            await testUtils.owlCompatibilityExtraNextTick();
            assert.containsOnce(form, 'th:not(.o-list-record-remove-header)',
                "should be 1 column when the productId is set");
            await testUtils.fields.editAndTrigger(form.$('.o-field-many2one[name="productId"] input'),
            '', 'keyup');
            await testUtils.owlCompatibilityExtraNextTick();
            assert.containsN(form, 'th:not(.o-list-record-remove-header)', 2,
                "should be 2 columns in the one2many when productId is not set");
            await testUtils.dom.click(form.$('.o-field-boolean[name="bar"] input'));
            await testUtils.owlCompatibilityExtraNextTick();
            assert.containsOnce(form, 'th:not(.o-list-record-remove-header)',
                "should be 1 column after the value change");
            form.destroy();
        });

        QUnit.test('one2many column visiblity depends on onchange of parent field', async function (assert) {
            assert.expect(3);

            this.data.partner.records[0].p = [2];
            this.data.partner.records[0].bar = false;

            this.data.partner.onchanges.p = function (obj) {
                // set bar to true when line is added
                if (obj.p.length > 1 && obj.p[1][2].foo === 'New line') {
                    obj.bar = true;
                }
            };

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch:'<form>' +
                        '<field name="bar"/>' +
                        '<field name="p">' +
                            '<tree editable="bottom">' +
                                '<field name="foo"/>' +
                                '<field name="int_field" attrs="{\'column_invisible\': [(\'parent.bar\', \'=\', false)]}"/>' +
                            '</tree>' +
                        '</field>' +
                    '</form>',
                resId: 1,
            });

            // bar is false so there should be 1 column
            assert.containsOnce(form, 'th:not(.o-list-record-remove-header)',
                "should be only 1 column ('foo') in the one2many");
            assert.containsOnce(form, '.o-list-view .o-data-row', "should contain one row");

            await testUtils.form.clickEdit(form);

            // add a new o2m record
            await testUtils.dom.click(form.$('.o-field-x2many-list-row-add a'));
            form.$('.o-field-one2many input:first').focus();
            await testUtils.fields.editInput(form.$('.o-field-one2many input:first'), 'New line');
            await testUtils.dom.click(form.$el);

            assert.containsN(form, 'th:not(.o-list-record-remove-header)', 2, "should be 2 columns('foo' + 'int_field')");

            form.destroy();
        });

        QUnit.test('one2many column_invisible on view not inline', async function (assert) {
            assert.expect(4);

            this.data.partner.records[0].p = [2];
            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch:'<form string="Partners">' +
                        '<sheet>' +
                            '<group>' +
                                '<field name="productId"/>' +
                            '</group>' +
                            '<notebook>' +
                                '<page string="Partner page">' +
                                    '<field name="bar"/>' +
                                    '<field name="p"/>' +
                                '</page>' +
                            '</notebook>' +
                        '</sheet>' +
                    '</form>',
                resId: 1,
                archs: {
                    'partner,false,list': '<tree>' +
                        '<field name="foo" attrs="{\'column_invisible\': [(\'parent.productId\', \'!=\', false)]}"/>' +
                        '<field name="bar" attrs="{\'column_invisible\': [(\'parent.bar\', \'=\', false)]}"/>' +
                    '</tree>',
                },
            });
            assert.containsN(form, 'th:not(.o-list-record-remove-header)', 2,
                "should be 2 columns in the one2many");
            await testUtils.form.clickEdit(form);
            await testUtils.dom.click(form.$('.o-field-many2one[name="productId"] input'));
            await testUtils.dom.click($('li.ui-menu-item a:contains(xpad)').trigger('mouseenter'));
            await testUtils.owlCompatibilityExtraNextTick();
            assert.containsOnce(form, 'th:not(.o-list-record-remove-header)',
                "should be 1 column when the productId is set");
            await testUtils.fields.editAndTrigger(form.$('.o-field-many2one[name="productId"] input'),
                '', 'keyup');
            await testUtils.owlCompatibilityExtraNextTick();
            assert.containsN(form, 'th:not(.o-list-record-remove-header)', 2,
                "should be 2 columns in the one2many when productId is not set");
            await testUtils.dom.click(form.$('.o-field-boolean[name="bar"] input'));
            await testUtils.owlCompatibilityExtraNextTick();
            assert.containsOnce(form, 'th:not(.o-list-record-remove-header)',
                "should be 1 column after the value change");
            form.destroy();
        });

        QUnit.test('many2one links form view call', async function (assert) {
            assert.expect(5);

            let serverData = {};
            serverData.models = this.data;
            serverData.models['turtle'].records[1].productId = 37;
            serverData.views= {
                "partner,false,form": '<form string="Partners"> <field name="turtles"/> </form>',
                "partner,false,search": '<search></search>',
                'turtle,false,list':`
                        <tree readonly="1">
                            <field name="productId" widget="many2one"/>
                        </tree>`,
                "product,false,search": '<search></search>',
                "product,false,form": '<form></form>',
            }
            serverData.actions= {
                1: {
                    name: 'Partner',
                    resModel: 'partner',
                    resId: 1,
                    type: 'ir.actions.actwindow',
                    views: [[false, 'form']],
                }
            }

            const webClient = await createWebClient({
                serverData,
                legacyParams: { withLegacyMockServer: true },
                mockRPC: function (route, args){
                     if (args.method === 'get_formview_action'){
                        assert.step('get_formview_action')
                        return {
                            type: "ir.actions.actwindow",
                            resModel: "product",
                            viewType: "form",
                            viewMode: "form",
                            views: [[false, "form"]],
                            target: "current",
                            resId: args[0],
                        };
                     }
                }
            });
            await doAction(webClient, 1);

            assert.containsOnce(webClient, 'a.o-form-uri',
                "should display 1 m2o link in form");

            assert.containsN(webClient, '.breadcrumb-item', 1,
                "Should only contain one breadcrumb at the start");

            await testUtils.dom.click($(webClient.el).find('a.o-form-uri'));

            await legacyExtraNextTick();

            assert.verifySteps(['get_formview_action'])

            assert.containsN(webClient, '.breadcrumb-item', 2,
                "Should contain 2 breadcrumbs after the clicking on the link");

            webClient.destroy();
        });

        QUnit.module('Many2OneAvatar');

        QUnit.test('many2one_avatar widget in form view', async function (assert) {
            assert.expect(17);

            const form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form><field name="userId" widget="many2one_avatar"/></form>',
                resId: 1,
            });

            assert.hasClass(form.$('.o-form-view'), 'o-form-readonly');
            assert.strictEqual(form.$('.o-field-widget[name=userId]').text().trim(), 'Aline');
            assert.containsOnce(form, '.o-m2o-avatar > img[data-src="/web/image/user/17/avatar128"]');

            await testUtils.form.clickEdit(form);

            assert.hasClass(form.$('.o-form-view'), 'o-form-editable');
            assert.containsOnce(form, '.o-input-dropdown');
            assert.strictEqual(form.$('.o-input-dropdown input').val(), 'Aline');
            assert.containsOnce(form, '.o-external-button');
            assert.containsOnce(form, '.o-m2o-avatar > img[data-src="/web/image/user/17/avatar128"]');

            await testUtils.fields.many2one.clickOpenDropdown("userId");
            await testUtils.fields.many2one.clickItem("userId", "Christine");
            assert.containsOnce(form, '.o-m2o-avatar > img[data-src="/web/image/user/19/avatar128"]');
            await testUtils.form.clickSave(form);

            assert.hasClass(form.$('.o-form-view'), 'o-form-readonly');
            assert.strictEqual(form.$('.o-field-widget[name=userId]').text().trim(), 'Christine');
            assert.containsOnce(form, '.o-m2o-avatar > img[data-src="/web/image/user/19/avatar128"]');

            await testUtils.form.clickEdit(form);
            await testUtils.fields.editAndTrigger(form.$('.o-field-many2one[name="userId"] input'),
                '', ['keyup', 'blur']);
            assert.containsNone(form, '.o-m2o-avatar > img');
            assert.containsOnce(form, '.o-m2o-avatar > .o-m2o-avatar-empty');
            await testUtils.form.clickSave(form);

            assert.hasClass(form.$('.o-form-view'), 'o-form-readonly');
            assert.containsNone(form, '.o-m2o-avatar > img');
            assert.containsNone(form, '.o-m2o-avatar > .o-m2o-avatar-empty');

            form.destroy();
        });

        QUnit.test('many2one_avatar widget in form view, with onchange', async function (assert) {
            assert.expect(7);

            this.data.partner.onchanges = {
                int_field: function (obj) {
                    if (obj.int_field === 1) {
                        obj.userId = [19, 'Christine'];
                    } else if (obj.int_field === 2) {
                        obj.userId = false;
                    } else {
                        obj.userId = [17, 'Aline']; // default value
                    }
                },
            };
            const form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: `
                    <form>
                        <field name="int_field"/>
                        <field name="userId" widget="many2one_avatar" readonly="1"/>
                    </form>`,
            });

            assert.hasClass(form.$('.o-form-view'), 'o-form-editable');
            assert.strictEqual(form.$('.o-field-widget[name=userId]').text().trim(), 'Aline');
            assert.containsOnce(form, '.o-m2o-avatar > img[data-src="/web/image/user/17/avatar128"]');

            await testUtils.fields.editInput(form.$('.o-field-widget[name=int_field]'), 1);

            assert.strictEqual(form.$('.o-field-widget[name=userId]').text().trim(), 'Christine');
            assert.containsOnce(form, '.o-m2o-avatar > img[data-src="/web/image/user/19/avatar128"]');

            await testUtils.fields.editInput(form.$('.o-field-widget[name=int_field]'), 2);

            assert.strictEqual(form.$('.o-field-widget[name=userId]').text().trim(), '');
            assert.containsNone(form, '.o-m2o-avatar > img');

            form.destroy();
        });

        QUnit.test('many2one_avatar widget in list view', async function (assert) {
            assert.expect(5);

            this.data.partner.records = [
                { id: 1, userId: 17, },
                { id: 2, userId: 19, },
                { id: 3, userId: 17, },
                { id: 4, userId: false, },
            ];
            const list = await createView({
                View: ListView,
                model: 'partner',
                data: this.data,
                arch: '<tree><field name="userId" widget="many2one_avatar"/></tree>',
            });

            assert.strictEqual(list.$('.o-data-cell span').text(), 'AlineChristineAline');
            assert.containsOnce(list.$('.o-data-cell:nth(0)'), '.o-m2o-avatar >img[data-src="/web/image/user/17/avatar128"]');
            assert.containsOnce(list.$('.o-data-cell:nth(1)'), '.o-m2o-avatar > img[data-src="/web/image/user/19/avatar128"]');
            assert.containsOnce(list.$('.o-data-cell:nth(2)'), '.o-m2o-avatar > img[data-src="/web/image/user/17/avatar128"]');
            assert.containsNone(list.$('.o-data-cell:nth(3)'), '.o-m2o-avatar > img');

            list.destroy();
        });

        QUnit.test('many2one_avatar widget in editable list view', async function (assert) {
            assert.expect(3);

            this.data.partner.records = [
                { id: 1, userId: 17, },
                { id: 2, userId: 19, },
                { id: 3, userId: 17, },
                { id: 4, userId: false, },
            ];
            const list = await createView({
                View: ListView,
                model: 'partner',
                data: this.data,
                arch: '<tree editable="top"><field name="userId" widget="many2one_avatar"/></tree>',
            });

            assert.strictEqual(list.$('.o-data-cell span').text(), 'AlineChristineAline');
            assert.containsOnce(list.$('.o-data-cell:nth(0)'), '.o-m2o-avatar > img[data-src="/web/image/user/17/avatar128"]');

            await testUtils.dom.click(list.$('.o-data-row:first() .o-data-cell:first()'));
            assert.containsOnce(list.$('.o-data-cell:nth(0)'), '.o-m2o-avatar > img[data-src="/web/image/user/17/avatar128"]');

            list.destroy();
        });
    });
});
});
