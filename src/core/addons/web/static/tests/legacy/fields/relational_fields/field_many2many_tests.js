verp.define('web.field_many_to_many_tests', function (require) {
"use strict";

var FormView = require('web.FormView');
var testUtils = require('web.testUtils');

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
                        int_field: { string: "int_field", type: "integer", sortable: true },
                        turtles: { string: "one2many turtle field", type: "one2many", relation: 'turtle', relationField: 'turtle_trululu' },
                        timmy: { string: "pokemon", type: "many2many", relation: 'partner_type' },
                        color: {
                            type: "selection",
                            selection: [['red', "Red"], ['black', "Black"]],
                            default: 'red',
                            string: "Color",
                        },
                        userId: { string: "User", type: 'many2one', relation: 'user' },
                        reference: {
                            string: "Reference Field", type: 'reference', selection: [
                                ["product", "Product"], ["partner_type", "Partner Type"], ["partner", "Partner"]]
                        },
                    },
                    records: [{
                        id: 1,
                        displayName: "first record",
                        foo: "yop",
                        int_field: 10,
                        turtles: [2],
                        timmy: [],
                        userId: 17,
                        reference: 'product,37',
                    }, {
                        id: 2,
                        displayName: "second record",
                        foo: "blip",
                        int_field: 9,
                        timmy: [],
                        userId: 17,
                    }, {
                        id: 4,
                        displayName: "aaa",
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
                        partnerIds: { string: "Partner", type: "many2many", relation: 'partner' },
                    },
                    records: [{
                        id: 1,
                        displayName: "leonardo",
                        turtle_foo: "yop",
                        partnerIds: [],
                    }, {
                        id: 2,
                        displayName: "donatello",
                        turtle_foo: "blip",
                        partnerIds: [2, 4],
                    }, {
                        id: 3,
                        displayName: "raphael",
                        turtle_foo: "kawa",
                        partnerIds: [],
                    }],
                    onchanges: {},
                },
                user: {
                    fields: {
                        name: { string: "Name", type: "char" },
                    },
                    records: [{
                        id: 17,
                        name: "Aline",
                    }, {
                        id: 19,
                        name: "Christine",
                    }]
                },
            };
        },
    }, function () {
        QUnit.module('FieldMany2Many');

        QUnit.test('many2many kanban: edition', async function (assert) {
            assert.expect(33);

            this.data.partner.records[0].timmy = [12, 14];
            this.data.partner_type.records.push({ id: 15, displayName: "red", color: 6 });
            this.data.partner_type.records.push({ id: 18, displayName: "yellow", color: 4 });
            this.data.partner_type.records.push({ id: 21, displayName: "blue", color: 1 });

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form string="Partners">' +
                    '<field name="timmy">' +
                    '<kanban>' +
                    '<field name="displayName"/>' +
                    '<templates>' +
                    '<t t-name="kanban-box">' +
                    '<div class="oe-kanban-global-click">' +
                    '<a t-if="!readOnlyMode" type="delete" class="fa fa-times float-right delete_icon"/>' +
                    '<span><t t-esc="record.displayName.value"/></span>' +
                    '</div>' +
                    '</t>' +
                    '</templates>' +
                    '</kanban>' +
                    '<form string="Partners">' +
                    '<field name="displayName"/>' +
                    '</form>' +
                    '</field>' +
                    '</form>',
                archs: {
                    'partner_type,false,form': '<form string="Types"><field name="displayName"/></form>',
                    'partner_type,false,list': '<tree string="Types"><field name="displayName"/></tree>',
                    'partner_type,false,search': '<search string="Types">' +
                        '<field name="label" string="Name"/>' +
                        '</search>',
                },
                resId: 1,
                mockRPC: function (route, args) {
                    if (route === '/web/dataset/callKw/partner_type/write') {
                        assert.strictEqual(args.args[1].displayName, "new name", "should write 'new_name'");
                    }
                    if (route === '/web/dataset/callKw/partner_type/create') {
                        assert.strictEqual(args.args[0].displayName, "A new type", "should create 'A new type'");
                    }
                    if (route === '/web/dataset/callKw/partner/write') {
                        var commands = args.args[1].timmy;
                        assert.strictEqual(commands.length, 1, "should have generated one command");
                        assert.strictEqual(commands[0][0], 6, "generated command should be REPLACE WITH");
                        // get the created type's id
                        var createdType = _.findWhere(this.data.partner_type.records, {
                            displayName: "A new type"
                        });
                        var ids = _.sortBy([12, 15, 18].concat(createdType.id), _.identity.bind(_));
                        assert.ok(_.isEqual(_.sortBy(commands[0][2], _.identity.bind(_)), ids),
                            "new value should be " + ids);
                    }
                    return this._super.apply(this, arguments);
                },
            });

            // the SelectCreateDialog requests the session, so intercept its custom
            // event to specify a fake session to prevent it from crashing
            testUtils.mock.intercept(form, 'get_session', function (event) {
                event.data.callback({ userContext: {} });
            });

            assert.ok(!form.$('.o-kanban-view .delete_icon').length,
                'delete icon should not be visible in readonly');
            assert.ok(!form.$('.o-field-many2many .o-kanban-button-new').length,
                '"Add" button should not be visible in readonly');

            await testUtils.form.clickEdit(form);

            assert.strictEqual(form.$('.o-kanban-record:not(.o-kanban-ghost)').length, 2,
                'should contain 2 records');
            assert.strictEqual(form.$('.o-kanban-record:first() span').text(), 'gold',
                'displayName of subrecord should be the one in DB');
            assert.ok(form.$('.o-kanban-view .delete_icon').length,
                'delete icon should be visible in edit');
            assert.ok(form.$('.o-field-many2many .o-kanban-button-new').length,
                '"Add" button should be visible in edit');
            assert.strictEqual(form.$('.o-field-many2many .o-kanban-button-new').text().trim(), "Add",
                'Create button should have "Add" label');

            // edit existing subrecord
            await testUtils.dom.click(form.$('.oe-kanban-global-click:first()'));

            await testUtils.fields.editInput($('.modal .o-form-view input'), 'new name');
            await testUtils.dom.click($('.modal .modal-footer .btn-primary'));
            assert.strictEqual(form.$('.o-kanban-record:first() span').text(), 'new name',
                'value of subrecord should have been updated');

            // add subrecords
            // -> single select
            await testUtils.dom.click(form.$('.o-field-many2many .o-kanban-button-new'));
            assert.ok($('.modal .o-list-view').length, "should have opened a list view in a modal");
            assert.strictEqual($('.modal .o-list-view tbody .o-list-record-selector').length, 3,
                "list view should contain 3 records");
            await testUtils.dom.click($('.modal .o-list-view tbody tr:contains(red)'));
            assert.ok(!$('.modal .o-list-view').length, "should have closed the modal");
            assert.strictEqual(form.$('.o-kanban-record:not(.o-kanban-ghost)').length, 3,
                'kanban should now contain 3 records');
            assert.ok(form.$('.o-kanban-record:contains(red)').length,
                'record "red" should be in the kanban');

            // -> multiple select
            await testUtils.dom.click(form.$('.o-field-many2many .o-kanban-button-new'));
            assert.ok($('.modal .o_select_button').prop('disabled'), "select button should be disabled");
            assert.strictEqual($('.modal .o-list-view tbody .o-list-record-selector').length, 2,
                "list view should contain 2 records");
            await testUtils.dom.click($('.modal .o-list-view thead .o-list-record-selector input'));
            await testUtils.dom.click($('.modal .o_select_button'));
            assert.ok(!$('.modal .o_select_button').prop('disabled'), "select button should be enabled");
            assert.ok(!$('.modal .o-list-view').length, "should have closed the modal");
            assert.strictEqual(form.$('.o-kanban-record:not(.o-kanban-ghost)').length, 5,
                'kanban should now contain 5 records');
            // -> created record
            await testUtils.dom.click(form.$('.o-field-many2many .o-kanban-button-new'));
            await testUtils.dom.click($('.modal .modal-footer .btn-primary:nth(1)'));
            assert.ok($('.modal .o-form-view.o-form-editable').length,
                "should have opened a form view in edit mode, in a modal");
            await testUtils.fields.editInput($('.modal .o-form-view input'), 'A new type');
            await testUtils.dom.click($('.modal:nth(1) footer .btn-primary:first()'));
            assert.ok(!$('.modal').length, "should have closed both modals");
            assert.strictEqual(form.$('.o-kanban-record:not(.o-kanban-ghost)').length, 6,
                'kanban should now contain 6 records');
            assert.ok(form.$('.o-kanban-record:contains(A new type)').length,
                'the newly created type should be in the kanban');

            // delete subrecords
            await testUtils.dom.click(form.$('.o-kanban-record:contains(silver)'));
            assert.strictEqual($('.modal .modal-footer .o-btn-remove').length, 1,
                'There should be a modal having Remove Button');
            await testUtils.dom.click($('.modal .modal-footer .o-btn-remove'));
            assert.containsNone($('.o_modal'), "modal should have been closed");
            assert.strictEqual(form.$('.o-kanban-record:not(.o-kanban-ghost)').length, 5,
                'should contain 5 records');
            assert.ok(!form.$('.o-kanban-record:contains(silver)').length,
                'the removed record should not be in kanban anymore');

            await testUtils.dom.click(form.$('.o-kanban-record:contains(blue) .delete_icon'));
            assert.strictEqual(form.$('.o-kanban-record:not(.o-kanban-ghost)').length, 4,
                'should contain 4 records');
            assert.ok(!form.$('.o-kanban-record:contains(blue)').length,
                'the removed record should not be in kanban anymore');

            // save the record
            await testUtils.form.clickSave(form);
            form.destroy();
        });

        QUnit.test('many2many kanban(editable): properly handle add-label node attribute', async function (assert) {
            assert.expect(1);

            this.data.partner.records[0].timmy = [12];

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form string="Partners">' +
                    '<field name="timmy" add-label="Add timmy" mode="kanban">' +
                    '<kanban>' +
                    '<templates>' +
                    '<t t-name="kanban-box">' +
                    '<div class="oe-kanban-details">' +
                    '<field name="displayName"/>' +
                    '</div>' +
                    '</t>' +
                    '</templates>' +
                    '</kanban>' +
                    '</field>' +
                    '</form>',
                resId: 1,
            });

            await testUtils.form.clickEdit(form);
            assert.strictEqual(form.$('.o-field-many2many[name="timmy"] .o-kanban-button-new').text().trim(),
                "Add timmy", "In M2M Kanban, Add button should have 'Add timmy' label");

            form.destroy();
        });

        QUnit.test('many2many kanban: create action disabled', async function (assert) {
            assert.expect(4);

            this.data.partner.records[0].timmy = [12, 14];

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form string="Partners">' +
                    '<field name="timmy">' +
                    '<kanban create="0">' +
                    '<field name="displayName"/>' +
                    '<templates>' +
                    '<t t-name="kanban-box">' +
                    '<div class="oe-kanban-global-click">' +
                    '<a t-if="!readOnlyMode" type="delete" class="fa fa-times float-right delete_icon"/>' +
                    '<span><t t-esc="record.displayName.value"/></span>' +
                    '</div>' +
                    '</t>' +
                    '</templates>' +
                    '</kanban>' +
                    '</field>' +
                    '</form>',
                archs: {
                    'partner_type,false,list': '<tree><field name="label"/></tree>',
                    'partner_type,false,search': '<search>' +
                        '<field name="displayName" string="Name"/>' +
                        '</search>',
                },
                resId: 1,
                session: { userContext: {} },
            });

            assert.ok(!form.$('.o-kanban-button-new').length,
                '"Add" button should not be available in readonly');

            await testUtils.form.clickEdit(form);

            assert.ok(form.$('.o-kanban-button-new').length,
                '"Add" button should be available in edit');
            assert.ok(form.$('.o-kanban-view .delete_icon').length,
                'delete icon should be visible in edit');

            await testUtils.dom.click(form.$('.o-kanban-button-new'));
            assert.strictEqual($('.modal .modal-footer .btn-primary').length, 1, // only button 'Select'
                '"Create" button should not be available in the modal');

            form.destroy();
        });

        QUnit.test('many2many kanban: conditional create/delete actions', async function (assert) {
            assert.expect(6);

            this.data.partner.records[0].timmy = [12, 14];

            const form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: `
                    <form>
                        <field name="color"/>
                        <field name="timmy" options="{'create': [('color', '=', 'red')], 'delete': [('color', '=', 'red')]}">
                            <kanban>
                                <field name="displayName"/>
                                <templates>
                                    <t t-name="kanban-box">
                                        <div class="oe-kanban-global-click">
                                            <span><t t-esc="record.displayName.value"/></span>
                                        </div>
                                    </t>
                                </templates>
                            </kanban>
                        </field>
                    </form>`,
                archs: {
                    'partner_type,false,form': '<form><field name="label"/></form>',
                    'partner_type,false,list': '<tree><field name="label"/></tree>',
                    'partner_type,false,search': '<search/>',
                },
                resId: 1,
                viewOptions: {
                    mode: 'edit',
                },
            });

            // color is red
            assert.containsOnce(form, '.o-kanban-button-new', '"Add" button should be available');

            await testUtils.dom.click(form.$('.o-kanban-record:contains(silver)'));
            assert.containsOnce(document.body, '.modal .modal-footer .o-btn-remove',
                'remove button should be visible in modal');
            await testUtils.dom.click($('.modal .modal-footer .o-form-button_cancel'));

            await testUtils.dom.click(form.$('.o-kanban-button-new'));
            assert.containsN(document.body, '.modal .modal-footer button', 3,
                'there should be 3 buttons available in the modal');
            await testUtils.dom.click($('.modal .modal-footer .o-form-button_cancel'));

            // set color to black
            await testUtils.fields.editSelect(form.$('select[name="color"]'), '"black"');
            assert.containsOnce(form, '.o-kanban-button-new',
                '"Add" button should still be available even after color field changed');

            await testUtils.dom.click(form.$('.o-kanban-button-new'));
            // only select and cancel button should be available, create
            // button should be removed based on color field condition
            assert.containsN(document.body, '.modal .modal-footer button', 2,
                '"Create" button should not be available in the modal after color field changed');
            await testUtils.dom.click($('.modal .modal-footer .o-form-button_cancel'));

            await testUtils.dom.click(form.$('.o-kanban-record:contains(silver)'));
            assert.containsNone(document.body, '.modal .modal-footer .o-btn-remove',
                'remove button should be visible in modal');

            form.destroy();
        });

        QUnit.test('many2many list (non editable): edition', async function (assert) {
            assert.expect(29);

            this.data.partner.records[0].timmy = [12, 14];
            this.data.partner_type.records.push({ id: 15, displayName: "bronze", color: 6 });
            this.data.partner_type.fields.float_field = { string: 'Float', type: 'float' };
            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form string="Partners">' +
                    '<field name="timmy">' +
                    '<tree>' +
                    '<field name="displayName"/><field name="float_field"/>' +
                    '</tree>' +
                    '<form string="Partners">' +
                    '<field name="displayName"/>' +
                    '</form>' +
                    '</field>' +
                    '</form>',
                archs: {
                    'partner_type,false,list': '<tree><field name="displayName"/></tree>',
                    'partner_type,false,search': '<search><field name="displayName"/></search>',
                },
                resId: 1,
                mockRPC: function (route, args) {
                    if (args.method !== 'load_views') {
                        assert.step(_.last(route.split('/')));
                    }
                    if (args.method === 'write' && args.model === 'partner') {
                        assert.deepEqual(args.args[1].timmy, [
                            [6, false, [12, 15]],
                        ]);
                    }
                    return this._super.apply(this, arguments);
                },
            });
            assert.containsNone(form.$('.o-list-record-remove'),
                'delete icon should not be visible in readonly');
            assert.containsOnce(form, '.o-field-x2many-list-row-add',
                '"Add an item" should be visible in readonly');

            await testUtils.form.clickEdit(form);

            assert.containsN(form, '.o-list-view td.o-list-number', 2,
                'should contain 2 records');
            assert.strictEqual(form.$('.o-list-view tbody td:first()').text(), 'gold',
                'displayName of first subrecord should be the one in DB');
            assert.ok(form.$('.o-list-record-remove').length,
                'delete icon should be visible in edit');
            assert.ok(form.$('.o-field-x2many-list-row-add').length,
                '"Add an item" should be visible in edit');

            // edit existing subrecord
            await testUtils.dom.click(form.$('.o-list-view tbody tr:first()'));

            assert.containsNone($('.modal .modal-footer .o-btn-remove'),
                'there should not be a "Remove" button in the modal footer');

            await testUtils.fields.editInput($('.modal .o-form-view input'), 'new name');
            await testUtils.dom.click($('.modal .modal-footer .btn-primary'));
            assert.strictEqual(form.$('.o-list-view tbody td:first()').text(), 'new name',
                'value of subrecord should have been updated');

            // add new subrecords
            await testUtils.dom.click(form.$('.o-field-x2many-list-row-add a'));
            assert.containsNone($('.modal .modal-footer .o-btn-remove'),
                'there should not be a "Remove" button in the modal footer');
            assert.strictEqual($('.modal .o-list-view').length, 1,
                "a modal should be open");
            assert.strictEqual($('.modal .o-list-view .o-data-row').length, 1,
                "the list should contain one row");
            await testUtils.dom.click($('.modal .o-list-view .o-data-row'));
            assert.strictEqual($('.modal .o-list-view').length, 0,
                "the modal should be closed");
            assert.containsN(form, '.o-list-view td.o-list-number', 3,
                'should contain 3 subrecords');

            // remove subrecords
            await testUtils.dom.click(form.$('.o-list-record-remove:nth(1)'));
            assert.containsN(form, '.o-list-view td.o-list-number', 2,
                'should contain 2 subrecords');
            assert.strictEqual(form.$('.o-list-view .o-data-row td:first').text(), 'new name',
                'the updated row still has the correct values');

            // save
            await testUtils.form.clickSave(form);
            assert.containsN(form, '.o-list-view td.o-list-number', 2,
                'should contain 2 subrecords');
            assert.strictEqual(form.$('.o-list-view .o-data-row td:first').text(),
                'new name', 'the updated row still has the correct values');

            assert.verifySteps([
                'read', // main record
                'read', // relational field
                'read', // relational record in dialog
                'write', // save relational record from dialog
                'read', // relational field (updated)
                'searchRead', // list view in dialog
                'read', // relational field (updated)
                'write', // save main record
                'read', // main record
                'read', // relational field
            ]);

            form.destroy();
        });

        QUnit.test('many2many list (editable): edition', async function (assert) {
            assert.expect(31);

            this.data.partner.records[0].timmy = [12, 14];
            this.data.partner_type.records.push({ id: 15, displayName: "bronze", color: 6 });
            this.data.partner_type.fields.float_field = { string: 'Float', type: 'float' };
            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form string="Partners">' +
                    '<field name="timmy">' +
                    '<tree editable="top">' +
                    '<field name="displayName"/><field name="float_field"/>' +
                    '</tree>' +
                    '</field>' +
                    '</form>',
                archs: {
                    'partner_type,false,list': '<tree><field name="displayName"/></tree>',
                    'partner_type,false,search': '<search><field name="displayName"/></search>',
                },
                mockRPC: function (route, args) {
                    if (args.method !== 'load_views') {
                        assert.step(_.last(route.split('/')));
                    }
                    if (args.method === 'write') {
                        assert.deepEqual(args.args[1].timmy, [
                            [6, false, [12, 15]],
                            [1, 12, { displayName: 'new name' }],
                        ]);
                    }
                    return this._super.apply(this, arguments);
                },
                resId: 1,
            });

            assert.ok(form.$('.o-list-record-remove').length,
                'delete icon should be visible in readonly');
            assert.ok(form.$('.o-field-x2many-list-row-add').length,
                '"Add an item" should be visible in readonly');

            await testUtils.form.clickEdit(form);

            assert.containsN(form, '.o-list-view td.o-list-number', 2,
                'should contain 2 records');
            assert.strictEqual(form.$('.o-list-view tbody td:first()').text(), 'gold',
                'displayName of first subrecord should be the one in DB');
            assert.ok(form.$('.o-list-record-remove').length,
                'delete icon should be visible in edit');
            assert.hasClass(form.$('td.o-list-record-remove button').first(),'fa fa-times',
                "should have X icons to remove (unlink) records");
            assert.ok(form.$('.o-field-x2many-list-row-add').length,
                '"Add an item" should not visible in edit');

            // edit existing subrecord
            await testUtils.dom.click(form.$('.o-list-view tbody td:first()'));
            assert.ok(!$('.modal').length,
                'in edit, clicking on a subrecord should not open a dialog');
            assert.hasClass(form.$('.o-list-view tbody tr:first()'),'o-selected-row',
                'first row should be in edition');
            await testUtils.fields.editInput(form.$('.o-list-view input:first()'), 'new name');
            assert.hasClass(form.$('.o-list-view .o-data-row:first'),'o-selected-row',
                'first row should still be in edition');
            assert.strictEqual(form.$('.o-list-view input[name=displayName]').get(0),
                document.activeElement, 'edited field should still have the focus');
            await testUtils.dom.click(form.$el);
            assert.doesNotHaveClass(form.$('.o-list-view tbody tr:first'), 'o-selected-row',
                'first row should not be in edition anymore');
            assert.strictEqual(form.$('.o-list-view tbody td:first()').text(), 'new name',
                'value of subrecord should have been updated');
            assert.verifySteps(['read', 'read']);

            // add new subrecords
            await testUtils.dom.click(form.$('.o-field-x2many-list-row-add a'));
            assert.strictEqual($('.modal .o-list-view').length, 1,
                "a modal should be open");
            assert.strictEqual($('.modal .o-list-view .o-data-row').length, 1,
                "the list should contain one row");
            await testUtils.dom.click($('.modal .o-list-view .o-data-row'));
            assert.strictEqual($('.modal .o-list-view').length, 0,
                "the modal should be closed");
            assert.containsN(form, '.o-list-view td.o-list-number', 3,
                'should contain 3 subrecords');

            // remove subrecords
            await testUtils.dom.click(form.$('.o-list-record-remove:nth(1)'));
            assert.containsN(form, '.o-list-view td.o-list-number', 2,
                'should contain 2 subrecord');
            assert.strictEqual(form.$('.o-list-view tbody .o-data-row td:first').text(),
                'new name', 'the updated row still has the correct values');

            // save
            await testUtils.form.clickSave(form);
            assert.containsN(form, '.o-list-view td.o-list-number', 2,
                'should contain 2 subrecords');
            assert.strictEqual(form.$('.o-list-view .o-data-row td:first').text(),
                'new name', 'the updated row still has the correct values');

            assert.verifySteps([
                'searchRead', // list view in dialog
                'read', // relational field (updated)
                'write', // save main record
                'read', // main record
                'read', // relational field
            ]);

            form.destroy();
        });

        QUnit.test('many2many: create & delete attributes (both true)', async function (assert) {
            assert.expect(2);

            this.data.partner.records[0].timmy = [12, 14];

            const form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form string="Partners">' +
                    '<field name="timmy">' +
                    '<tree create="true" delete="true">' +
                    '<field name="color"/>' +
                    '</tree>' +
                    '</field>' +
                    '</form>',
                resId: 1,
            });

            await testUtils.form.clickEdit(form);

            assert.containsOnce(form, '.o-field-x2many-list-row-add', "should have the 'Add an item' link");
            assert.containsN(form, '.o-list-record-remove', 2, "should have the 'Add an item' link");

            form.destroy();
        });

        QUnit.test('many2many: create & delete attributes (both false)', async function (assert) {
            assert.expect(2);

            this.data.partner.records[0].timmy = [12, 14];

            const form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form string="Partners">' +
                    '<field name="timmy">' +
                    '<tree create="false" delete="false">' +
                    '<field name="color"/>' +
                    '</tree>' +
                    '</field>' +
                    '</form>',
                resId: 1,
            });

            await testUtils.form.clickEdit(form);

            assert.containsOnce(form, '.o-field-x2many-list-row-add', "should have the 'Add an item' link");
            assert.containsN(form, '.o-list-record-remove', 2, "each record should have the 'Remove Item' link");

            form.destroy();
        });

        QUnit.test('many2many list: create action disabled', async function (assert) {
            assert.expect(2);
            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form string="Partners">' +
                    '<field name="timmy">' +
                    '<tree create="0">' +
                    '<field name="label"/>' +
                    '</tree>' +
                    '</field>' +
                    '</form>',
                resId: 1,
            });

            assert.containsOnce(form, '.o-field-x2many-list-row-add',
                '"Add an item" link should be available in readonly');

            await testUtils.form.clickEdit(form);

            assert.containsOnce(form, '.o-field-x2many-list-row-add',
                '"Add an item" link should be available in edit');

            form.destroy();
        });

        QUnit.test('fieldmany2many list comodel not writable', async function (assert) {
            /**
             * Many2Many List should behave as the m2m_tags
             * that is, the relation can be altered even if the comodel itself is not CRUD-able
             * This can happen when someone has read access alone on the comodel
             * and full CRUD on the current model
             */
            assert.expect(12);

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch:`<form string="Partners">
                        <field name="timmy" widget="many2many" can_create="false" canWrite="false"/>
                    </form>`,
                archs:{
                    'partner_type,false,list': `<tree create="false" delete="false" edit="false">
                                                    <field name="displayName"/>
                                                </tree>`,
                    'partner_type,false,search': '<search><field name="displayName"/></search>',
                },
                mockRPC: function (route, args) {
                    if (route === '/web/dataset/callKw/partner/create') {
                        assert.deepEqual(args.args[0], {timmy: [[6, false, [12]]]});
                    }
                    if (route === '/web/dataset/callKw/partner/write') {
                        assert.deepEqual(args.args[1], {timmy: [[6, false, []]]});
                    }
                    return this._super.apply(this, arguments);
                }
            });

            assert.containsOnce(form, '.o-field-many2many .o-field-x2many-list-row-add');
            await testUtils.dom.click(form.$('.o-field-many2many .o-field-x2many-list-row-add a'));
            assert.containsOnce(document.body, '.modal');

            assert.containsN($('.modal-footer'), 'button', 2);
            assert.containsOnce($('.modal-footer'), 'button.o_select_button');
            assert.containsOnce($('.modal-footer'), 'button.o-form-button_cancel');

            await testUtils.dom.click($('.modal .o-list-view .o-data-cell:first()'));
            assert.containsNone(document.body, '.modal');

            assert.containsOnce(form, '.o-field-many2many .o-data-row');
            assert.equal($('.o-field-many2many .o-data-row').text(), 'gold');
            assert.containsOnce(form, '.o-field-many2many .o-field-x2many-list-row-add');

            await testUtils.form.clickSave(form);
            await testUtils.form.clickEdit(form);

            assert.containsOnce(form, '.o-field-many2many .o-data-row .o-list-record-remove');
            await testUtils.dom.click(form.$('.o-field-many2many .o-data-row .o-list-record-remove'));
            await testUtils.form.clickSave(form);

            form.destroy();
        });

        QUnit.test('many2many list: conditional create/delete actions', async function (assert) {
            assert.expect(6);

            this.data.partner.records[0].timmy = [12, 14];

            const form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: `
                    <form>
                        <field name="color"/>
                        <field name="timmy" options="{'create': [('color', '=', 'red')], 'delete': [('color', '=', 'red')]}">
                            <tree>
                                <field name="label"/>
                            </tree>
                        </field>
                    </form>`,
                archs: {
                    'partner_type,false,list': '<tree><field name="label"/></tree>',
                    'partner_type,false,search': '<search/>',
                },
                resId: 1,
                viewOptions: {
                    mode: 'edit',
                },
            });

            // color is red -> create and delete actions are available
            assert.containsOnce(form, '.o-field-x2many-list-row-add',
                "should have the 'Add an item' link");
            assert.containsN(form, '.o-list-record-remove', 2,
                "should have two remove icons");

            await testUtils.dom.click(form.$('.o-field-x2many-list-row-add a'));

            assert.containsN(document.body, '.modal .modal-footer button', 3,
                'there should be 3 buttons available in the modal');

            await testUtils.dom.click($('.modal .modal-footer .o-form-button_cancel'));

            // set color to black -> create and delete actions are no longer available
            await testUtils.fields.editSelect(form.$('select[name="color"]'), '"black"');

            // add a line and remove icon should still be there as they don't create/delete records,
            // but rather add/remove links
            assert.containsOnce(form, '.o-field-x2many-list-row-add',
                '"Add a line" button should still be available even after color field changed');
            assert.containsN(form, '.o-list-record-remove', 2,
                "should still have remove icon even after color field changed");

            await testUtils.dom.click(form.$('.o-field-x2many-list-row-add a'));
            assert.containsN(document.body, '.modal .modal-footer button', 2,
                '"Create" button should not be available in the modal after color field changed');

            form.destroy();
        });

        QUnit.test('many2many field with link/unlink options (list)', async function (assert) {
            assert.expect(5);

            this.data.partner.records[0].timmy = [12, 14];

            const form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: `
                    <form>
                        <field name="color"/>
                        <field name="timmy" options="{'link': [('color', '=', 'red')], 'unlink': [('color', '=', 'red')]}">
                            <tree>
                                <field name="label"/>
                            </tree>
                        </field>
                    </form>`,
                archs: {
                    'partner_type,false,list': '<tree><field name="label"/></tree>',
                    'partner_type,false,search': '<search/>',
                },
                resId: 1,
                viewOptions: {
                    mode: 'edit',
                },
            });

            // color is red -> link and unlink actions are available
            assert.containsOnce(form, '.o-field-x2many-list-row-add',
                "should have the 'Add an item' link");
            assert.containsN(form, '.o-list-record-remove', 2,
                "should have two remove icons");

            await testUtils.dom.click(form.$('.o-field-x2many-list-row-add a'));

            assert.containsN(document.body, '.modal .modal-footer button', 3,
                'there should be 3 buttons available in the modal (Create action is available)');

            await testUtils.dom.click($('.modal .modal-footer .o-form-button_cancel'));

            // set color to black -> link and unlink actions are no longer available
            await testUtils.fields.editSelect(form.$('select[name="color"]'), '"black"');

            assert.containsNone(form, '.o-field-x2many-list-row-add',
                '"Add a line" should no longer be available after color field changed');
            assert.containsNone(form, '.o-list-record-remove',
                "should no longer have remove icon after color field changed");

            form.destroy();
        });

        QUnit.test('many2many field with link/unlink options (list, create="0")', async function (assert) {
            assert.expect(5);

            this.data.partner.records[0].timmy = [12, 14];

            const form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: `
                    <form>
                        <field name="color"/>
                        <field name="timmy" options="{'link': [('color', '=', 'red')], 'unlink': [('color', '=', 'red')]}">
                            <tree create="0">
                                <field name="label"/>
                            </tree>
                        </field>
                    </form>`,
                archs: {
                    'partner_type,false,list': '<tree><field name="label"/></tree>',
                    'partner_type,false,search': '<search/>',
                },
                resId: 1,
                viewOptions: {
                    mode: 'edit',
                },
            });

            // color is red -> link and unlink actions are available
            assert.containsOnce(form, '.o-field-x2many-list-row-add',
                "should have the 'Add an item' link");
            assert.containsN(form, '.o-list-record-remove', 2,
                "should have two remove icons");

            await testUtils.dom.click(form.$('.o-field-x2many-list-row-add a'));

            assert.containsN(document.body, '.modal .modal-footer button', 2,
                'there should be 2 buttons available in the modal (Create action is not available)');

            await testUtils.dom.click($('.modal .modal-footer .o-form-button_cancel'));

            // set color to black -> link and unlink actions are no longer available
            await testUtils.fields.editSelect(form.$('select[name="color"]'), '"black"');

            assert.containsNone(form, '.o-field-x2many-list-row-add',
                '"Add a line" should no longer be available after color field changed');
            assert.containsNone(form, '.o-list-record-remove',
                "should no longer have remove icon after color field changed");

            form.destroy();
        });

        QUnit.test('many2many field with link option (kanban)', async function (assert) {
            assert.expect(3);

            this.data.partner.records[0].timmy = [12, 14];

            const form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: `
                    <form>
                        <field name="color"/>
                        <field name="timmy" options="{'link': [('color', '=', 'red')]}">
                            <kanban>
                                <templates>
                                    <t t-name="kanban-box">
                                        <div><field name="label"/></div>
                                    </t>
                                </templates>
                            </kanban>
                        </field>
                    </form>`,
                archs: {
                    'partner_type,false,list': '<tree><field name="label"/></tree>',
                    'partner_type,false,search': '<search/>',
                },
                resId: 1,
                viewOptions: {
                    mode: 'edit',
                },
            });

            // color is red -> link and unlink actions are available
            assert.containsOnce(form, '.o-kanban-button-new', "should have the 'Add' button");

            await testUtils.dom.click(form.$('.o-kanban-button-new'));

            assert.containsN(document.body, '.modal .modal-footer button', 3,
                'there should be 3 buttons available in the modal (Create action is available');

            await testUtils.dom.click($('.modal .modal-footer .o-form-button_cancel'));

            // set color to black -> link and unlink actions are no longer available
            await testUtils.fields.editSelect(form.$('select[name="color"]'), '"black"');

            assert.containsNone(form, '.o-kanban-button-new',
                '"Add" should no longer be available after color field changed');

            form.destroy();
        });

        QUnit.test('many2many field with link option (kanban, create="0")', async function (assert) {
            assert.expect(3);

            this.data.partner.records[0].timmy = [12, 14];

            const form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: `
                    <form>
                        <field name="color"/>
                        <field name="timmy" options="{'link': [('color', '=', 'red')]}">
                            <kanban create="0">
                                <templates>
                                    <t t-name="kanban-box">
                                        <div><field name="label"/></div>
                                    </t>
                                </templates>
                            </kanban>
                        </field>
                    </form>`,
                archs: {
                    'partner_type,false,list': '<tree><field name="label"/></tree>',
                    'partner_type,false,search': '<search/>',
                },
                resId: 1,
                viewOptions: {
                    mode: 'edit',
                },
            });

            // color is red -> link and unlink actions are available
            assert.containsOnce(form, '.o-kanban-button-new', "should have the 'Add' button");

            await testUtils.dom.click(form.$('.o-kanban-button-new'));

            assert.containsN(document.body, '.modal .modal-footer button', 2,
                'there should be 2 buttons available in the modal (Create action is not available');

            await testUtils.dom.click($('.modal .modal-footer .o-form-button_cancel'));

            // set color to black -> link and unlink actions are no longer available
            await testUtils.fields.editSelect(form.$('select[name="color"]'), '"black"');

            assert.containsNone(form, '.o-kanban-button-new',
                '"Add" should no longer be available after color field changed');

            form.destroy();
        });

        QUnit.test('many2many list: list of id as default value', async function (assert) {
            assert.expect(1);

            this.data.partner.fields.turtles.default = [2, 3];
            this.data.partner.fields.turtles.type = "many2many";

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form string="Partners">' +
                    '<field name="turtles">' +
                    '<tree>' +
                    '<field name="turtle_foo"/>' +
                    '</tree>' +
                    '</field>' +
                    '</form>',
            });

            assert.strictEqual(form.$('td.o-data-cell').text(), "blipkawa",
                "should have loaded default data");

            form.destroy();
        });

        QUnit.test('many2many checkboxes with default values', async function (assert) {
            assert.expect(7);

            this.data.partner.fields.turtles.default = [3];
            this.data.partner.fields.turtles.type = "many2many";

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form string="Partners">' +
                    '<field name="turtles" widget="many2many_checkboxes">' +
                    '</field>' +
                    '</form>',
                mockRPC: function (route, args) {
                    if (args.method === 'create') {
                        assert.deepEqual(args.args[0].turtles, [[6, false, [1]]],
                            "correct values should have been sent to create");
                    }
                    return this._super.apply(this, arguments);
                }
            });

            assert.notOk(form.$('.o-form-view .custom-checkbox input').eq(0).prop('checked'),
                "first checkbox should not be checked");
            assert.notOk(form.$('.o-form-view .custom-checkbox input').eq(1).prop('checked'),
                "second checkbox should not be checked");
            assert.ok(form.$('.o-form-view .custom-checkbox input').eq(2).prop('checked'),
                "third checkbox should be checked");

            await testUtils.dom.click(form.$('.o-form-view .custom-checkbox input:checked'));
            await testUtils.dom.click(form.$('.o-form-view .custom-checkbox input').first());
            await testUtils.dom.click(form.$('.o-form-view .custom-checkbox input').first());
            await testUtils.dom.click(form.$('.o-form-view .custom-checkbox input').first());

            assert.ok(form.$('.o-form-view .custom-checkbox input').eq(0).prop('checked'),
                "first checkbox should be checked");
            assert.notOk(form.$('.o-form-view .custom-checkbox input').eq(1).prop('checked'),
                "second checkbox should not be checked");
            assert.notOk(form.$('.o-form-view .custom-checkbox input').eq(2).prop('checked'),
                "third checkbox should not be checked");

            await testUtils.form.clickSave(form);

            form.destroy();
        });

        QUnit.test('many2many list with x2many: add a record', async function (assert) {
            assert.expect(18);

            this.data.partner_type.fields.m2m = {
                string: "M2M", type: "many2many", relation: 'turtle',
            };
            this.data.partner_type.records[0].m2m = [1, 2];
            this.data.partner_type.records[1].m2m = [2, 3];

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form string="Partners">' +
                    '<field name="timmy"/>' +
                    '</form>',
                resId: 1,
                archs: {
                    'partner_type,false,list': '<tree>' +
                        '<field name="displayName"/>' +
                        '<field name="m2m" widget="many2manyTags"/>' +
                        '</tree>',
                    'partner_type,false,search': '<search>' +
                        '<field name="displayName" string="Name"/>' +
                        '</search>',
                },
                mockRPC: function (route, args) {
                    if (args.method !== 'load_views') {
                        assert.step(_.last(route.split('/')) + ' on ' + args.model);
                    }
                    if (args.model === 'turtle') {
                        assert.step(JSON.stringify(args.args[0])); // the read ids
                    }
                    return this._super.apply(this, arguments);
                },
                viewOptions: {
                    mode: 'edit',
                },
            });

            await testUtils.dom.click(form.$('.o-field-x2many-list-row-add a'));
            await testUtils.dom.click($('.modal .o-data-row:first'));

            assert.containsOnce(form, '.o-data-row',
                "the record should have been added to the relation");
            assert.strictEqual(form.$('.o-data-row:first .o-badge-text').text(), 'leonardodonatello',
                "inner m2m should have been fetched and correctly displayed");

            await testUtils.dom.click(form.$('.o-field-x2many-list-row-add a'));
            await testUtils.dom.click($('.modal .o-data-row:first'));

            assert.containsN(form, '.o-data-row', 2,
                "the second record should have been added to the relation");
            assert.strictEqual(form.$('.o-data-row:nth(1) .o-badge-text').text(), 'donatelloraphael',
                "inner m2m should have been fetched and correctly displayed");

            assert.verifySteps([
                'read on partner',
                'searchRead on partner_type',
                'read on turtle',
                '[1,2,3]',
                'read on partner_type',
                'read on turtle',
                '[1,2]',
                'searchRead on partner_type',
                'read on turtle',
                '[2,3]',
                'read on partner_type',
                'read on turtle',
                '[2,3]',
            ]);

            form.destroy();
        });

        QUnit.test('many2many with a domain', async function (assert) {
            // The domain specified on the field should not be replaced by the potential
            // domain the user writes in the dialog, they should rather be concatenated
            assert.expect(2);

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form string="Partners">' +
                    '<field name="timmy" domain="[[\'displayName\', \'=\', \'gold\']]"/>' +
                    '</form>',
                resId: 1,
                archs: {
                    'partner_type,false,list': '<tree>' +
                        '<field name="displayName"/>' +
                        '</tree>',
                    'partner_type,false,search': '<search>' +
                        '<field name="displayName" string="Name"/>' +
                        '</search>',
                },
                viewOptions: {
                    mode: 'edit',
                },
            });

            await testUtils.dom.click(form.$('.o-field-x2many-list-row-add a'));
            assert.strictEqual($('.modal .o-data-row').length, 1,
                "should contain only one row (gold)");

            const modal = document.body.querySelector(".modal");
            await cpHelpers.editSearch(modal, 's');
            await cpHelpers.validateSearch(modal);

            assert.strictEqual($('.modal .o-data-row').length, 0, "should contain no row");

            form.destroy();
        });

        QUnit.test('many2many list with onchange and edition of a record', async function (assert) {
            assert.expect(8);

            this.data.partner.fields.turtles.type = "many2many";
            this.data.partner.onchanges.turtles = function () { };
            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form string="Partners">' +
                    '<field name="turtles">' +
                    '<tree>' +
                    '<field name="turtle_foo"/>' +
                    '</tree>' +
                    '</field>' +
                    '</form>',
                resId: 1,
                archs: {
                    'turtle,false,form': '<form string="Turtle Power"><field name="turtle_bar"/></form>',
                },
                mockRPC: function (route, args) {
                    assert.step(args.method);
                    return this._super.apply(this, arguments);
                },
            });

            await testUtils.form.clickEdit(form);
            await testUtils.dom.click(form.$('td.o-data-cell:first'));

            await testUtils.dom.click($('.modal-body input[type="checkbox"]'));
            await testUtils.dom.click($('.modal .modal-footer .btn-primary').first());

            // there is nothing left to save -> should not do a 'write' RPC
            await testUtils.form.clickSave(form);

            assert.verifySteps([
                'read', // read initial record (on partner)
                'read', // read many2many turtles
                'load_views', // load arch of turtles form view
                'read', // read missing field when opening record in modal form view
                'write', // when saving the modal
                'onchange', // onchange should be triggered on partner
                'read', // reload many2many
            ]);

            form.destroy();
        });

        QUnit.test('onchange with 40+ commands for a many2many', async function (assert) {
            // this test ensures that the basic_model correctly handles more LINK_TO
            // commands than the limit of the dataPoint (40 for x2many kanban)
            assert.expect(24);

            // create a lot of partner_types that will be linked by the onchange
            var commands = [[5]];
            for (var i = 0; i < 45; i++) {
                var id = 100 + i;
                this.data.partner_type.records.push({ id: id, displayName: "type " + id });
                commands.push([4, id]);
            }
            this.data.partner.onchanges = {
                foo: function (obj) {
                    obj.timmy = commands;
                },
            };

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form string="Partners">' +
                    '<field name="foo"/>' +
                    '<field name="timmy">' +
                    '<kanban>' +
                    '<field name="displayName"/>' +
                    '<templates>' +
                    '<t t-name="kanban-box">' +
                    '<div><t t-esc="record.displayName.value"/></div>' +
                    '</t>' +
                    '</templates>' +
                    '</kanban>' +
                    '</field>' +
                    '</form>',
                resId: 1,
                mockRPC: function (route, args) {
                    assert.step(args.method);
                    if (args.method === 'write') {
                        assert.strictEqual(args.args[1].timmy[0][0], 6,
                            "should send a command 6");
                        assert.strictEqual(args.args[1].timmy[0][2].length, 45,
                            "should replace with 45 ids");
                    }
                    return this._super.apply(this, arguments);
                },
                viewOptions: {
                    mode: 'edit',
                },
            });

            assert.verifySteps(['read']);

            await testUtils.fields.editInput(form.$('.o-field-widget[name=foo]'), 'trigger onchange');

            assert.verifySteps(['onchange', 'read']);
            assert.strictEqual(form.$('.o-x2m-control-panel .o-pager-counter').text().trim(),
                '1-40 / 45', "pager should be correct");
            assert.strictEqual(form.$('.o-kanban-record:not(".o-kanban-ghost")').length, 40,
                'there should be 40 records displayed on page 1');

            await testUtils.dom.click(form.$('.o-field-widget[name=timmy] .o-pager-next'));
            assert.verifySteps(['read']);
            assert.strictEqual(form.$('.o-x2m-control-panel .o-pager-counter').text().trim(),
                '41-45 / 45', "pager should be correct");
            assert.strictEqual(form.$('.o-kanban-record:not(".o-kanban-ghost")').length, 5,
                'there should be 5 records displayed on page 2');

            await testUtils.form.clickSave(form);

            assert.strictEqual(form.$('.o-x2m-control-panel .o-pager-counter').text().trim(),
                '1-40 / 45', "pager should be correct");
            assert.strictEqual(form.$('.o-kanban-record:not(".o-kanban-ghost")').length, 40,
                'there should be 40 records displayed on page 1');

            await testUtils.dom.click(form.$('.o-field-widget[name=timmy] .o-pager-next'));
            assert.strictEqual(form.$('.o-x2m-control-panel .o-pager-counter').text().trim(),
                '41-45 / 45', "pager should be correct");
            assert.strictEqual(form.$('.o-kanban-record:not(".o-kanban-ghost")').length, 5,
                'there should be 5 records displayed on page 2');

            await testUtils.dom.click(form.$('.o-field-widget[name=timmy] .o-pager-next'));
            assert.strictEqual(form.$('.o-x2m-control-panel .o-pager-counter').text().trim(),
                '1-40 / 45', "pager should be correct");
            assert.strictEqual(form.$('.o-kanban-record:not(".o-kanban-ghost")').length, 40,
                'there should be 40 records displayed on page 1');

            assert.verifySteps(['write', 'read', 'read', 'read']);
            form.destroy();
        });

        QUnit.test('default_get, onchange, onchange on m2m', async function (assert) {
            assert.expect(1);

            this.data.partner.onchanges.int_field = function (obj) {
                if (obj.int_field === 2) {
                    assert.deepEqual(obj.timmy, [
                        [6, false, [12]],
                        [1, 12, { displayName: 'gold' }]
                    ]);
                }
                obj.timmy = [
                    [5],
                    [1, 12, { displayName: 'gold' }]
                ];
            };

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form>' +
                    '<sheet>' +
                    '<field name="timmy">' +
                    '<tree>' +
                    '<field name="displayName"/>' +
                    '</tree>' +
                    '</field>' +
                    '<field name="int_field"/>' +
                    '</sheet>' +
                    '</form>',
            });

            await testUtils.fields.editInput(form.$('.o-field-widget[name=int_field]'), 2);
            form.destroy();
        });

        QUnit.test('widget many2manyTags', async function (assert) {
            assert.expect(1);
            this.data.turtle.records[0].partnerIds = [2];

            var form = await createView({
                View: FormView,
                model: 'turtle',
                data: this.data,
                arch: '<form string="Turtles">' +
                    '<sheet>' +
                    '<field name="displayName"/>' +
                    '<field name="partnerIds" widget="many2manyTags"/>' +
                    '</sheet>' +
                    '</form>',
                resId: 1,
            });

            assert.deepEqual(
                form.$('.o-field-many2manytags.o-field-widget .badge .o-badge-text').attr('title'),
                'second record', 'the title should be filled in'
            );

            form.destroy();
        });

        QUnit.test('many2many tags widget: select multiple records', async function (assert) {
            assert.expect(5);
            for (var i = 1; i <= 10; i++) {
                this.data.partner_type.records.push({ id: 100 + i, displayName: "Partner" + i});
            }
            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form string="Partners">' +
                    '<field name="displayName"/>' +
                    '<field name="timmy" widget="many2manyTags"/>' +
                    '</form>',
                resId: 1,
                archs: {
                    'partner_type,false,list': '<tree><field name="displayName"/></tree>',
                    'partner_type,false,search': '<search><field name="displayName"/></search>',
                },
            });
            await testUtils.form.clickEdit(form);
            await testUtils.fields.many2one.clickOpenDropdown('timmy');
            await testUtils.fields.many2one.clickItem('timmy','Search More');
            assert.ok($('.modal .o-list-view'), "should have open the modal");

            // + 1 for the select all
            assert.containsN($(document),'.modal .o-list-view .o-list-record-selector input', this.data.partner_type.records.length + 1,
                "Should have record selector checkboxes to select multiple records");
            //multiple select tag
            await testUtils.dom.click($('.modal .o-list-view thead .o-list-record-selector input'));
            assert.ok(!$('.modal .o_select_button').prop('disabled'), "select button should be enabled");
            await testUtils.dom.click($('.o_select_button'));
            assert.containsNone($(document),'.modal .o-list-view', "should have closed the modal");
            assert.containsN(form, '.o-field-many2manytags[name="timmy"] .badge', this.data.partner_type.records.length,
                "many2many tag should now contain 12 records");
            form.destroy();
        });

        QUnit.test("many2many tags widget: select multiple records doesn't show already added tags", async function (assert) {
            assert.expect(5);
            for (var i = 1; i <= 10; i++) {
                this.data.partner_type.records.push({ id: 100 + i, displayName: "Partner" + i});
            }
            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form string="Partners">' +
                    '<field name="displayName"/>' +
                    '<field name="timmy" widget="many2manyTags"/>' +
                    '</form>',
                resId: 1,
                archs: {
                    'partner_type,false,list': '<tree><field name="displayName"/></tree>',
                    'partner_type,false,search': '<search><field name="displayName"/></search>',
                },
            });
            await testUtils.form.clickEdit(form);


            await testUtils.fields.many2one.clickOpenDropdown('timmy');
            await testUtils.fields.many2one.clickItem('timmy','Partner1');

            await testUtils.fields.many2one.clickOpenDropdown('timmy');
            await testUtils.fields.many2one.clickItem('timmy','Search More');
            assert.ok($('.modal .o-list-view'), "should have open the modal");

            // -1 for the one that is already on the form & +1 for the select all,
            assert.containsN($(document), '.modal .o-list-view .o-list-record-selector input', this.data.partner_type.records.length - 1 + 1,
                "Should have record selector checkboxes to select multiple records");
            //multiple select tag
            await testUtils.dom.click($('.modal .o-list-view thead .o-list-record-selector input'));
            assert.ok(!$('.modal .o_select_button').prop('disabled'), "select button should be enabled");
            await testUtils.dom.click($('.o_select_button'));
            assert.containsNone($(document),'.modal .o-list-view', "should have closed the modal");
            assert.containsN(form, '.o-field-many2manytags[name="timmy"] .badge', this.data.partner_type.records.length,
                "many2many tag should now contain 12 records");
            form.destroy();
        });

        QUnit.test("many2many tags widget: save&new in edit mode doesn't close edit window", async function (assert) {
          assert.expect(5);
          for (var i = 1; i <= 10; i++) {
              this.data.partner_type.records.push({ id: 100 + i, displayName: "Partner" + i});
          }
          var form = await createView({
              View: FormView,
              model: 'partner',
              data: this.data,
              arch: '<form string="Partners">' +
                  '<field name="displayName"/>' +
                  '<field name="timmy" widget="many2manyTags"/>' +
                  '</form>',
              resId: 1,
              archs: {
                  'partner_type,false,list': '<tree><field name="displayName"/></tree>',
                  'partner_type,false,search': '<search><field name="displayName"/></search>',
                  'partner_type,false,form': '<form><field name="displayName"/></form>'
              },
          });
          await testUtils.form.clickEdit(form);

          await testUtils.fields.many2one.createAndEdit('timmy',"Ralts");
          assert.containsOnce($(document), '.modal .o-form-view', "should have opened the modal");

          // Create multiple records with save & new
          await testUtils.fields.editInput($('.modal input:first'), 'Ralts');
          await testUtils.dom.click($('.modal .btn-primary:nth-child(2)'));
          assert.containsOnce($(document), '.modal .o-form-view', "modal should still be open");
          assert.equal($('.modal input:first')[0].value, '', "input should be empty")

          // Create another record and click save & close
          await testUtils.fields.editInput($('.modal input:first'), 'Pikachu');
          await testUtils.dom.click($('.modal .btn-primary:first'));
          assert.containsNone($(document),'.modal .o-list-view', "should have closed the modal");
          assert.containsN(form, '.o-field-many2manytags[name="timmy"] .badge', 2, "many2many tag should now contain 2 records");

          form.destroy();
        });

        QUnit.test("many2many tags widget: make tag name input field blank on Save&New", async function (assert) {
            assert.expect(4);

            let onchangeCalls = 0;
            const form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form><field name="timmy" widget="many2manyTags"/></form>',
                archs: {
                    'partner_type,false,form': '<form><field name="label"/></form>'
                },
                resId: 1,
                mockRPC: function (route, args) {
                    if (args.method === 'onchange') {
                        if (onchangeCalls === 0) {
                            assert.deepEqual(args.kwargs.context, { default_label: 'hello' },
                                "context should have default_label with 'hello' as value");
                        }
                        if (onchangeCalls === 1) {
                            assert.deepEqual(args.kwargs.context, {},
                                "context should have default_label with false as value");
                        }
                        onchangeCalls++;
                    }
                    return this._super.apply(this, arguments);
                },
            });

            await testUtils.form.clickEdit(form);

            await testUtils.fields.editInput($('.o-field-widget input'), 'hello');
            await testUtils.fields.many2one.clickItem('timmy', 'Create and Edit');
            assert.strictEqual(document.querySelector('.modal .o-form-view input').value, "hello",
                "should contain the 'hello' in the tag name input field");

            // Create record with save & new
            await testUtils.dom.click(document.querySelector('.modal .btn-primary:nth-child(2)'));
            assert.strictEqual(document.querySelector('.modal .o-form-view input').value, "",
                "should display the blank value in the tag name input field");

            form.destroy();
        });

        QUnit.test('many2many list add *many* records, remove, re-add', async function (assert) {
            assert.expect(5);

            this.data.partner.fields.timmy.domain = [['color', '=', 2]];
            this.data.partner.fields.timmy.onchange = true;
            this.data.partner_type.fields.productIds = { string: "Product", type: "many2many", relation: 'product' };

            for (var i = 0; i < 50; i++) {
                var new_record_partner_type = { id: 100 + i, displayName: "batch" + i, color: 2 };
                this.data.partner_type.records.push(new_record_partner_type);
            }

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form string="Partners">' +
                    '<field name="timmy" widget="many2many">' +
                    '<tree>' +
                    '<field name="displayName"/>' +
                    '<field name="productIds" widget="many2manyTags"/>' +
                    '</tree>' +
                    '</field>' +
                    '</form>',
                resId: 1,
                archs: {
                    'partner_type,false,list': '<tree><field name="displayName"/></tree>',
                    'partner_type,false,search': '<search><field name="displayName"/><field name="color"/></search>',
                },
                mockRPC: function (route, args) {
                    if (args.method === 'get_formview_id') {
                        assert.deepEqual(args.args[0], [1], "should call get_formview_id with correct id");
                        return Promise.resolve(false);
                    }
                    return this._super(route, args);
                },
            });

            // First round: add 51 records in batch
            await testUtils.dom.click(form.$buttons.find('.btn.btn-primary.o-form-button_edit'));
            await testUtils.dom.click(form.$('.o-field-x2many-list-row-add a'));

            var $modal = $('.modal-lg');

            assert.equal($modal.length, 1,
                'There should be one modal');

            await testUtils.dom.click($modal.find('thead input[type=checkbox]'));

            await testUtils.dom.click($modal.find('.btn.btn-primary.o_select_button'));

            assert.strictEqual(form.$('.o-data-row').length, 51,
                'We should have added all the records present in the search view to the m2m field'); // the 50 in batch + 'gold'

            await testUtils.dom.click(form.$buttons.find('.btn.btn-primary.o-form-button-save'));

            // Secound round: remove one record
            await testUtils.dom.click(form.$buttons.find('.btn.btn-primary.o-form-button_edit'));
            var trash_buttons = form.$('.o-field-many2many.o-field-widget.o-field-x2many.o-field-x2many_list .o-list-record-remove');

            await testUtils.dom.click(trash_buttons.first());

            var pager_limit = form.$('.o-field-many2many.o-field-widget.o-field-x2many.o-field-x2many_list .o-pager-limit');
            assert.equal(pager_limit.text(), '50',
                'We should have 50 records in the m2m field');

            // Third round: re-add 1 records
            await testUtils.dom.click(form.$('.o-field-x2many-list-row-add a'));

            $modal = $('.modal-lg');

            assert.equal($modal.length, 1,
                'There should be one modal');

            await testUtils.dom.click($modal.find('thead input[type=checkbox]'));

            await testUtils.dom.click($modal.find('.btn.btn-primary.o_select_button'));

            assert.strictEqual(form.$('.o-data-row').length, 51,
                'We should have 51 records in the m2m field');

            form.destroy();
        });

        QUnit.test('many2manyTags widget: conditional create/delete actions', async function (assert) {
            assert.expect(10);

            this.data.turtle.records[0].partnerIds = [2];
            for (var i = 1; i <= 10; i++) {
                this.data.partner.records.push({ id: 100 + i, displayName: "Partner" + i });
            }

            const form = await createView({
                View: FormView,
                model: 'turtle',
                data: this.data,
                arch: `
                    <form>
                        <field name="displayName"/>
                        <field name="turtle_bar"/>
                        <field name="partnerIds" options="{'create': [('turtle_bar', '=', true)], 'delete': [('turtle_bar', '=', true)]}" widget="many2manyTags"/>
                    </form>`,
                archs: {
                    'partner,false,list': '<tree><field name="label"/></tree>',
                    'partner,false,search': '<search/>',
                },
                resId: 1,
                viewOptions: {
                    mode: 'edit',
                },
            });

            // turtle_bar is true -> create and delete actions are available
            assert.containsOnce(form, '.o-field-many2manytags.o-field-widget .badge .o-delete',
                'X icon on badges should not be available');

            await testUtils.fields.many2one.clickOpenDropdown('partnerIds');

            const $dropdown1 = form.$('.o-field-many2one input').autocomplete('widget');
            assert.containsOnce($dropdown1, 'li.o-m2o-start-typing:contains(Start typing...)',
                'autocomplete should contain Start typing...');

            await testUtils.fields.many2one.clickItem('partnerIds', 'Search More');

            assert.containsN(document.body, '.modal .modal-footer button', 3,
                'there should be 3 buttons (Select, Create and Cancel) available in the modal footer');

            await testUtils.dom.click($('.modal .modal-footer .o-form-button_cancel'));

            // type something that doesn't exist
            await testUtils.fields.editAndTrigger(form.$('.o-field-many2one input'),
                'Something that does not exist', 'keydown');
            // await testUtils.nextTick();
            assert.containsN(form.$('.o-field-many2one input').autocomplete('widget'), 'li.o-m2o-dropdown-option', 2,
                'autocomplete should contain Create and Create and Edit... options');

            // set turtle_bar false -> create and delete actions are no longer available
            await testUtils.dom.click(form.$('.o-field-widget[name="turtle_bar"] input').first());

            // remove icon should still be there as it doesn't delete records but rather remove links
            assert.containsOnce(form, '.o-field-many2manytags.o-field-widget .badge .o-delete',
                'X icon on badge should still be there even after turtle_bar is not checked');

            await testUtils.fields.many2one.clickOpenDropdown('partnerIds');
            const $dropdown2 = form.$('.o-field-many2one input').autocomplete('widget');

            // only Search More option should be available
            assert.containsOnce($dropdown2, 'li.o-m2o-dropdown-option',
                'autocomplete should contain only one option');
            assert.containsOnce($dropdown2, 'li.o-m2o-dropdown-option:contains(Search More)',
                'autocomplete option should be Search More');

            await testUtils.fields.many2one.clickItem('partnerIds', 'Search More');

            assert.containsN(document.body, '.modal .modal-footer button', 2,
                'there should be 2 buttons (Select and Cancel) available in the modal footer');

            await testUtils.dom.click($('.modal .modal-footer .o-form-button_cancel'));

            // type something that doesn't exist
            await testUtils.fields.editAndTrigger(form.$('.o-field-many2one input'),
                'Something that does not exist', 'keyup');
            // await testUtils.nextTick();

            // only Search More option should be available
            assert.containsOnce($dropdown2, 'li.o-m2o-dropdown-option',
                'autocomplete should contain only one option');
            assert.containsOnce($dropdown2, 'li.o-m2o-dropdown-option:contains(Search More)',
                'autocomplete option should be Search More');

            form.destroy();
        });

        QUnit.test('failing many2one quick create in a many2manyTags', async function (assert) {
            assert.expect(5);

            var form = await createView({
                View: FormView,
                model: 'partner',
                data: this.data,
                arch: '<form><field name="timmy" widget="many2manyTags"/></form>',
                mockRPC(route, args) {
                    if (args.method === 'nameCreate') {
                        return Promise.reject();
                    }
                    if (args.method === 'create') {
                        assert.deepEqual(args.args[0], {
                            color: 8,
                            name: 'new partner',
                        });
                    }
                    return this._super.apply(this, arguments);
                },
                archs: {
                    'partner_type,false,form': `
                        <form>
                            <field name="label"/>
                            <field name="color"/>
                        </form>`,
                },
            });

            assert.containsNone(form, '.o-field-many2manytags .badge');

            // try to quick create a record
            await testUtils.dom.triggerEvent(form.$('.o-field-many2one input'), 'focus');
            await testUtils.fields.many2one.searchAndClickItem('timmy', {
                search: 'new partner',
                item: 'Create'
            });

            // as the quick create failed, a dialog should be open to 'slow create' the record
            assert.containsOnce(document.body, '.modal .o-form-view');
            assert.strictEqual($('.modal .o-field-widget[name=name]').val(), 'new partner');

            await testUtils.fields.editInput($('.modal .o-field-widget[name=color]'), 8);
            await testUtils.modal.clickButton('Save & Close');

            assert.containsOnce(form, '.o-field-many2manytags .badge');

            form.destroy();
        });
    });
});
});
