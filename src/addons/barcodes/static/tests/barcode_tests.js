verp.define('barcodes.tests', function (require) {
"use strict";

var barcodeEvents = require('barcodes.BarcodeEvents');

var AbstractField = require('web.AbstractField');
var fieldRegistry = require('web.field_registry');
var FormController = require('web.FormController');
var FormView = require('web.FormView');
var testUtils = require('web.testUtils');

var createView = testUtils.createView;
var triggerKeypressEvent = testUtils.dom.triggerKeypressEvent;

QUnit.module('Barcodes', {
    beforeEach: function () {
        this.data = {
            order: {
                fields: {
                    _barcode_scanned: {string: 'Barcode scanned', type: 'char'},
                    lineIds: {string: 'Order lines', type: 'one2many', relation: 'orderLine'},
                },
                records: [
                    {id: 1, lineIds: [1, 2]},
                ],
            },
            orderLine: {
                fields: {
                    productId: {string: 'Product', type: 'many2one', relation: 'product'},
                    product_barcode: {string: 'Product Barcode', type: 'char'},
                    quantity: {string: 'Quantity', type: 'integer'},
                },
                records: [
                    {id: 1, productId: 1, quantity: 0, product_barcode: '1234567890'},
                    {id: 2, productId: 2, quantity: 0, product_barcode: '0987654321'},
                ],
            },
            product: {
                fields: {
                    name: {string : "Product name", type: "char"},
                    int_field: {string : "Integer", type: "integer"},
                    barcode: {string: "Barcode", type: "char"},
                },
                records: [
                    {id: 1, name: "Large Cabinet", barcode: '1234567890'},
                    {id: 2, name: "Cabinet with Doors", barcode: '0987654321'},
                ],
            },
        };
    }
});

QUnit.test('Button with barcodeTrigger', async function (assert) {
    assert.expect(2);

    var form = await createView({
        View: FormView,
        model: 'product',
        data: this.data,
        arch: '<form>' +
                '<header>' +
                    '<button name="do_something" string="Validate" type="object" barcodeTrigger="doit"/>' +
                    '<button name="do_something_else" string="Validate" type="object" invisible="1" barcodeTrigger="dothat"/>' +
                '</header>' +
            '</form>',
        resId: 2,
        services: {
            notification: {
                notify: function (params) {
                    assert.step(params.type);
                }
            },
        },
        intercepts: {
            execute_action: function (event) {
                assert.strictEqual(event.data.actionData.name, 'do_something',
                    "do_something method call verified");
            },
        },
    });

    // O-BTN.doit
    _.each(['O','-','B','T','N','.','d','o','i','t','Enter'], triggerKeypressEvent);
    // O-BTN.dothat (should not call execute_action as the button isn't visible)
    _.each(['O','-','B','T','N','.','d','o','t','h','a','t','Enter'], triggerKeypressEvent);
    await testUtils.nextTick();
    assert.verifySteps([], "no warning should be displayed");

    form.destroy();
});

QUnit.test('Two buttons with same barcodeTrigger and the same string and action', async function (assert) {
    assert.expect(2);

    var form = await createView({
        View: FormView,
        model: 'product',
        data: this.data,
        arch: '<form>' +
                '<header>' +
                    '<button name="do_something" string="Validate" type="object" invisible="0" barcodeTrigger="doit"/>' +
                    '<button name="do_something" string="Validate" type="object" invisible="1" barcodeTrigger="doit"/>' +
                '</header>' +
            '</form>',
        resId: 2,

        services: {
            notification: {
                notify: function (params) {
                    assert.step(params.type);
                }
            },
        },
        intercepts: {
            execute_action: function (event) {
                assert.strictEqual(event.data.actionData.name, 'do_something',
                    "do_something method call verified");
            },
        },
    });

    // O-BTN.doit should call execute_action as the first button is visible
    _.each(['O','-','B','T','N','.','d','o','i','t','Enter'], triggerKeypressEvent);
    await testUtils.nextTick();
    assert.verifySteps([], "no warning should be displayed");

    form.destroy();
});

QUnit.test('edit, save and cancel buttons', async function (assert) {
    assert.expect(6);

    var form = await createView({
        View: FormView,
        model: 'product',
        data: this.data,
        arch: '<form><field name="displayName"/></form>',
        mockRPC: function (route, args) {
            if (args.method === 'write') {
                assert.step('save');
            }
            return this._super.apply(this, arguments);
        },
        resId: 1,
    });

    // O-CMD.EDIT
    _.each(["O","-","C","M","D",".","E","D","I","T","Enter"], triggerKeypressEvent);
    await testUtils.nextTick();
    assert.containsOnce(form, ".o-form-editable",
        "should have switched to 'edit' mode");
    // dummy change to check that it actually saves
    await testUtils.fields.editInput(form.$('.o-field-widget'), 'test');
    // O-CMD.SAVE
    _.each(["O","-","C","M","D",".","S","A","V","E","Enter"], triggerKeypressEvent);
    await testUtils.nextTick();
    assert.containsOnce(form, ".o-form-readonly",
        "should have switched to 'readonly' mode");
    assert.verifySteps(['save'], 'should have saved');

    // O-CMD.EDIT
    _.each(["O","-","C","M","D",".","E","D","I","T","Enter"], triggerKeypressEvent);
    await testUtils.nextTick();
    // dummy change to check that it correctly discards
    await testUtils.fields.editInput(form.$('.o-field-widget'), 'test');
    // O-CMD.CANCEL
    _.each(["O","-","C","M","D",".","D","I","S","C","A","R","D","Enter"], triggerKeypressEvent);
    await testUtils.nextTick();
    assert.containsOnce(form, ".o-form-readonly",
        "should have switched to 'readonly' mode");
    assert.verifySteps([], 'should not have saved');

    form.destroy();
});

QUnit.test('pager buttons', async function (assert) {
    assert.expect(5);

    var form = await createView({
        View: FormView,
        model: 'product',
        data: this.data,
        arch: '<form><field name="displayName"/></form>',
        resId: 1,
        viewOptions: {
            ids: [1, 2],
            index: 0,
        },
    });

    assert.strictEqual(form.$('.o-field-widget').text(), 'Large Cabinet');
    // O-CMD.PAGER-NEXT
    _.each(["O","-","C","M","D",".","N","E","X","T","Enter"], triggerKeypressEvent);
    await testUtils.nextTick();
    assert.strictEqual(form.$('.o-field-widget').text(), 'Cabinet with Doors');
    // O-CMD.PAGER-PREV
    _.each(["O","-","C","M","D",".","P","R","E","V","Enter"], triggerKeypressEvent);
    await testUtils.nextTick();
    assert.strictEqual(form.$('.o-field-widget').text(), 'Large Cabinet');
    // O-CMD.PAGER-LAST
    _.each(["O","-","C","M","D",".","P","A","G","E","R","-","L","A","S","T","Enter"], triggerKeypressEvent);
    await testUtils.nextTick();
    assert.strictEqual(form.$('.o-field-widget').text(), 'Cabinet with Doors');
    // O-CMD.PAGER-FIRST
    _.each(["O","-","C","M","D",".","P","A","G","E","R","-","F","I","R","S","T","Enter"], triggerKeypressEvent);
    await testUtils.nextTick();
    assert.strictEqual(form.$('.o-field-widget').text(), 'Large Cabinet');

    form.destroy();
});

QUnit.test('do no update form twice after a command barcode scanned', async function (assert) {
    assert.expect(7);

    var delay = barcodeEvents.BarcodeEvents.maxTimeBetweenKeysInMs;
    barcodeEvents.BarcodeEvents.maxTimeBetweenKeysInMs = 0;
    testUtils.mock.patch(FormController, {
        update: function () {
            assert.step('update');
            return this._super.apply(this, arguments);
        },
    });

    var form = await createView({
        View: FormView,
        model: 'product',
        data: this.data,
        arch: '<form>' +
                    '<field name="displayName"/>' +
                    '<field name="int_field" widget="field_float_scannable"/>' +
                '</form>',
        mockRPC: function (route, args) {
            if (args.method === 'read') {
                assert.step('read');
            }
            return this._super.apply(this, arguments);
        },
        resId: 1,
        viewOptions: {
            ids: [1, 2],
            index: 0,
        },
    });

    assert.verifySteps(['read'], "update should not have been called yet");

    // switch to next record
    _.each(["O","-","C","M","D",".","N","E","X","T","Enter"], triggerKeypressEvent);
    await testUtils.nextTick();
    // a first update is done to reload the data (thus followed by a read), but
    // update shouldn't be called afterwards
    assert.verifySteps(['update', 'read']);

    _.each(['5','4','3','9','8','2','6','7','1','2','5','2','Enter'], triggerKeypressEvent);
    await testUtils.nextTick();
    // a real barcode has been scanned -> an update should be requested (with
    // option reload='false', so it isn't followed by a read)
    assert.verifySteps(['update']);

    form.destroy();
    barcodeEvents.BarcodeEvents.maxTimeBetweenKeysInMs = delay;
    testUtils.mock.unpatch(FormController);
});

QUnit.test('widget field_float_scannable', async function (assert) {
    var done = assert.async();
    assert.expect(11);

    var delay = barcodeEvents.BarcodeEvents.maxTimeBetweenKeysInMs;
    barcodeEvents.BarcodeEvents.maxTimeBetweenKeysInMs = 0;

    this.data.product.records[0].int_field = 4;
    this.data.product.onchanges = {
        int_field: function () {},
    };

    var form = await createView({
        View: FormView,
        model: 'product',
        data: this.data,
        arch: '<form>' +
                    '<field name="displayName"/>' +
                    '<field name="int_field" widget="field_float_scannable"/>' +
                '</form>',
        mockRPC: function (route, args) {
            if (args.method === 'onchange') {
                assert.step('onchange');
                assert.strictEqual(args.args[1].int_field, 426,
                    "should send correct value for int_field");
            }
            return this._super.apply(this, arguments);
        },
        fieldDebounce: 1000,
        resId: 1,
    });

    assert.strictEqual(form.$('.o-field-widget[name=int_field]').text(), '4',
        "should display the correct value in readonly");

    await testUtils.form.clickEdit(form);

    assert.strictEqual(form.$('.o-field-widget[name=int_field]').val(), '4',
        "should display the correct value in edit");

    // simulates keypress events in the input to replace 0.00 by 26 (should not trigger onchanges)
    form.$('.o-field-widget[name=int_field]').focus();
    assert.strictEqual(form.$('.o-field-widget[name=int_field]').get(0), document.activeElement,
        "int field should be focused");
    form.$('.o-field-widget[name=int_field]').trigger({type: 'keypress', which: 50, keyCode: 50}); // 2
    await testUtils.nextTick();
    assert.strictEqual(form.$('.o-field-widget[name=int_field]').get(0), document.activeElement,
        "int field should still be focused");
    form.$('.o-field-widget[name=int_field]').trigger({type: 'keypress', which: 54, keyCode: 54}); // 6
    await testUtils.nextTick();
    assert.strictEqual(form.$('.o-field-widget[name=int_field]').get(0), document.activeElement,
        "int field should still be focused");

    setTimeout(async function () {
        assert.strictEqual(form.$('.o-field-widget[name=int_field]').val(), '426',
            "should display the correct value in edit");
        assert.strictEqual(form.$('.o-field-widget[name=int_field]').get(0), document.activeElement,
        "int field should still be focused");

        assert.verifySteps([], 'should not have done any onchange RPC');

        form.$('.o-field-widget[name=int_field]').trigger('change'); // should trigger the onchange
        await testUtils.nextTick();

        assert.verifySteps(['onchange'], 'should have done the onchange RPC');

        form.destroy();
        barcodeEvents.BarcodeEvents.maxTimeBetweenKeysInMs = delay;
        done();
    });
});

QUnit.test('widget barcode_handler', async function (assert) {
    assert.expect(4);

    var delay = barcodeEvents.BarcodeEvents.maxTimeBetweenKeysInMs;
    barcodeEvents.BarcodeEvents.maxTimeBetweenKeysInMs = 0;

    this.data.product.fields.barcodeScanned = {string : "Scanned barcode", type: "char"};
    this.data.product.onchanges = {
        barcodeScanned: function (obj) {
            // simulate an onchange that increment the int_field value
            // at each barcode scanned
            obj.int_field = obj.int_field + 1;
        },
    };

    var form = await createView({
        View: FormView,
        model: 'product',
        data: this.data,
        arch: '<form>' +
                    '<field name="displayName"/>' +
                    '<field name="int_field"/>' +
                    '<field name="barcodeScanned" widget="barcode_handler"/>' +
                '</form>',
        mockRPC: function (route, args) {
            if (args.method === 'onchange') {
                assert.step('onchange');
            }
            return this._super.apply(this, arguments);
        },
        resId: 1,
        viewOptions: {
            mode: 'edit',
        },
    });

    assert.strictEqual(form.$('.o-field-widget[name=int_field]').val(), '0',
        "initial value should be correct");

    _.each(['5','4','3','9','8','2','6','7','1','2','5','2','Enter'], triggerKeypressEvent);
    await testUtils.nextTick();
    assert.strictEqual(form.$('.o-field-widget[name=int_field]').val(), '1',
        "value should have been incremented");

    assert.verifySteps(['onchange'], "an onchange should have been done");

    form.destroy();
    barcodeEvents.BarcodeEvents.maxTimeBetweenKeysInMs = delay;
});

QUnit.test('specification of widget barcode_handler', async function (assert) {
    assert.expect(5);

    var delay = barcodeEvents.BarcodeEvents.maxTimeBetweenKeysInMs;
    barcodeEvents.BarcodeEvents.maxTimeBetweenKeysInMs = 0;

    // Define a specific barcode_handler widget for this test case
    var TestBarcodeHandler = AbstractField.extend({
        init: function () {
            this._super.apply(this, arguments);

            this.triggerUp('activeBarcode', {
                name: 'test',
                fieldName: 'lineIds',
                quantity: 'quantity',
                commands: {
                    barcode: '_barcodeAddX2MQuantity',
                }
            });
        },
    });
    fieldRegistry.add('test_barcode_handler', TestBarcodeHandler);

    var form = await createView({
        View: FormView,
        model: 'order',
        data: this.data,
        arch: '<form>' +
                    '<field name="_barcode_scanned" widget="test_barcode_handler"/>' +
                    '<field name="lineIds">' +
                        '<tree>' +
                            '<field name="productId"/>' +
                            '<field name="product_barcode" invisible="1"/>' +
                            '<field name="quantity"/>' +
                        '</tree>' +
                    '</field>' +
                '</form>',
        mockRPC: function (route, args) {
            if (args.method === 'onchange') {
                assert.notOK(true, "should not do any onchange RPC");
            }
            if (args.method === 'write') {
                assert.deepEqual(args.args[1].lineIds, [
                    [1, 1, {quantity: 2}], [1, 2, {quantity: 1}],
                ], "should have generated the correct commands");
            }
            return this._super.apply(this, arguments);
        },
        resId: 1,
        viewOptions: {
            mode: 'edit',
        },
    });

    assert.containsN(form, '.o-data-row', 2,
        "one2many should contain 2 rows");

    // scan twice product 1
    _.each(['1','2','3','4','5','6','7','8','9','0','Enter'], triggerKeypressEvent);
    await testUtils.nextTick();
    assert.strictEqual(form.$('.o-data-row:first .o-data-cell:nth(1)').text(), '1',
        "quantity of line one should have been incremented");
    _.each(['1','2','3','4','5','6','7','8','9','0','Enter'], triggerKeypressEvent);
    await testUtils.nextTick();
    assert.strictEqual(form.$('.o-data-row:first .o-data-cell:nth(1)').text(), '2',
        "quantity of line one should have been incremented");

    // scan once product 2
    _.each(['0','9','8','7','6','5','4','3','2','1','Enter'], triggerKeypressEvent);
    await testUtils.nextTick();
    assert.strictEqual(form.$('.o-data-row:nth(1) .o-data-cell:nth(1)').text(), '1',
        "quantity of line one should have been incremented");

    await testUtils.form.clickSave(form);

    form.destroy();
    barcodeEvents.BarcodeEvents.maxTimeBetweenKeysInMs = delay;
    delete fieldRegistry.map.test_barcode_handler;
});

QUnit.test('specification of widget barcode_handler with keypress and notifyChange', async function (assert) {
    assert.expect(6);
    var done = assert.async();

    var delay = barcodeEvents.BarcodeEvents.maxTimeBetweenKeysInMs;
    barcodeEvents.BarcodeEvents.maxTimeBetweenKeysInMs = 0;

    this.data.order.onchanges = {
        _barcode_scanned: function () {},
    };

    // Define a specific barcode_handler widget for this test case
    var TestBarcodeHandler = AbstractField.extend({
        init: function () {
            this._super.apply(this, arguments);

            this.triggerUp('activeBarcode', {
                name: 'test',
                fieldName: 'lineIds',
                notifyChange: false,
                setQuantityWithKeypress: true,
                quantity: 'quantity',
                commands: {
                    barcode: '_barcodeAddX2MQuantity',
                }
            });
        },
    });
    fieldRegistry.add('test_barcode_handler', TestBarcodeHandler);

    var form = await createView({
        View: FormView,
        model: 'order',
        data: this.data,
        arch: '<form>' +
                    '<field name="_barcode_scanned" widget="test_barcode_handler"/>' +
                    '<field name="lineIds">' +
                        '<tree>' +
                            '<field name="productId"/>' +
                            '<field name="product_barcode" invisible="1"/>' +
                            '<field name="quantity"/>' +
                        '</tree>' +
                    '</field>' +
                '</form>',
        mockRPC: function (route, args) {
            assert.step(args.method);
            return this._super.apply(this, arguments);
        },
        resId: 1,
        viewOptions: {
            mode: 'edit',
        },
    });
    _.each(['1','2','3','4','5','6','7','8','9','0','Enter'], triggerKeypressEvent);
    await testUtils.nextTick();
    // Quantity listener should open a dialog.
    triggerKeypressEvent('5');
    await testUtils.nextTick();

    setTimeout(async function () {
        var keycode = $.ui.keyCode.ENTER;

        assert.strictEqual($('.modal .modal-body').length, 1, 'should open a modal with a quantity as input');
        assert.strictEqual($('.modal .modal-body .o_set_qty_input').val(), '5', 'the quantity by default in the modal shoud be 5');

        $('.modal .modal-body .o_set_qty_input').val('7');
        await testUtils.nextTick();

        $('.modal .modal-body .o_set_qty_input').trigger($.Event('keypress', {which: keycode, keyCode: keycode}));
        await testUtils.nextTick();
        assert.strictEqual(form.$('.o-data-row .o-data-cell:nth(1)').text(), '7',
            "quantity checked should be 7");

        assert.verifySteps(['read', 'read']);

        form.destroy();
        barcodeEvents.BarcodeEvents.maxTimeBetweenKeysInMs = delay;
        delete fieldRegistry.map.test_barcode_handler;
        done();
    });
});
QUnit.test('barcodeScanned only trigger error for active view', async function (assert) {
    assert.expect(2);

    this.data.orderLine.fields._barcode_scanned = {string: 'Barcode scanned', type: 'char'};

    var form = await createView({
        View: FormView,
        model: 'order',
        data: this.data,
        arch: '<form>' +
                    '<field name="_barcode_scanned" widget="barcode_handler"/>' +
                    '<field name="lineIds">' +
                        '<tree>' +
                            '<field name="productId"/>' +
                            '<field name="product_barcode" invisible="1"/>' +
                            '<field name="quantity"/>' +
                        '</tree>' +
                    '</field>' +
                '</form>',
        archs: {
            "orderLine,false,form":
                '<form string="order line">' +
                    '<field name="_barcode_scanned" widget="barcode_handler"/>' +
                    '<field name="productId"/>' +
                '</form>',
        },
        resId: 1,
        services: {
            notification: {
                notify: function (params) {
                    assert.step(params.type);
                }
            },
        },
        viewOptions: {
            mode: 'edit',
        },
    });

    await testUtils.dom.click(form.$('.o-data-row:first'));

    // We do not trigger on the body since modal and
    // form view are both inside it.
    function modalTriggerKeypressEvent(char) {
        var keycode;
        if (char === "Enter") {
            keycode = $.ui.keyCode.ENTER;
        } else {
            keycode = char.charCodeAt(0);
        }
        return $('.modal').trigger($.Event('keypress', {which: keycode, keyCode: keycode}));
    }
    _.each(['O','-','B','T','N','.','c','a','n','c','e','l','Enter'], modalTriggerKeypressEvent);
    await testUtils.nextTick();
    assert.verifySteps(['danger'], "only one event should be triggered");
    form.destroy();
});
});
