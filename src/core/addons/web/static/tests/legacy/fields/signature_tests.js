verp.define('web.signature_field_tests', function (require) {
"use strict";

var ajax = require('web.ajax');
var core = require('web.core');
var FormView = require('web.FormView');
var testUtils = require('web.testUtils');

var createView = testUtils.createView;

QUnit.module('fields', {}, function () {

QUnit.module('signature', {
    beforeEach: function () {
        this.data = {
            partner: {
                fields: {
                    displayName: {string: "Name", type: "char" },
                    productId: {string: "Product Name", type: "many2one", relation: 'product'},
                    sign: {string: "Signature", type: "binary"},
                },
                records: [{
                    id: 1,
                    displayName: "Pop's Chock'lit",
                    productId: 7,
                }],
                onchanges: {},
            },
            product: {
                fields: {
                    name: {string: "Product Name", type: "char"}
                },
                records: [{
                    id: 7,
                    displayName: "Veggie Burger",
                }]
            },
        };
    }
}, function () {

    QUnit.module('Signature Field', {
        before: function () {
            return ajax.loadXML('/web/static/src/legacy/xml/name_and_signature.xml', core.qweb);
        },
    });

    QUnit.test('Set simple field in "fullName" node option', async function (assert) {
        assert.expect(3);

        var form = await createView({
            View: FormView,
            model: 'partner',
            resId: 1,
            data: this.data,
            arch: '<form>' +
                    '<field name="displayName"/>' +
                    '<field name="sign" widget="signature" options="{\'fullName\': \'displayName\'}" />' +
                '</form>',
            mockRPC: function (route, args) {
                if (route === '/web/sign/getFonts/') {
                    return Promise.resolve();
                }
                return this._super(route, args);
            },
        });

        await testUtils.form.clickEdit(form);

        assert.containsOnce(form, 'div[name=sign] div.o-signature svg',
            "should have a valid signature widget");
        // Click on the widget to open signature modal
        await testUtils.dom.click(form.$('div[name=sign] div.o-signature'));
        assert.strictEqual($('.modal .modal-body a.o-web-sign-auto-button').length, 1,
            'should open a modal with "Auto" button');
        assert.strictEqual($('.modal .modal-body .o-web-sign-name-input').val(), "Pop's Chock'lit",
            'Correct Value should be set in the input for auto drawing the signature');

        form.destroy();
    });

    QUnit.test('Set m2o field in "fullName" node option', async function (assert) {
        assert.expect(3);

        var form = await createView({
            View: FormView,
            model: 'partner',
            resId: 1,
            data: this.data,
            arch: '<form>' +
                    '<field name="productId"/>' +
                    '<field name="sign" widget="signature" options="{\'fullName\': \'productId\'}" />' +
                '</form>',
            mockRPC: function (route, args) {
                if (route === '/web/sign/getFonts/') {
                    return Promise.resolve();
                }
                return this._super(route, args);
            },
        });

        await testUtils.form.clickEdit(form);

        assert.containsOnce(form, 'div[name=sign] div.o-signature svg',
            "should have a valid signature widget");
        // Click on the widget to open signature modal
        await testUtils.dom.click(form.$('div[name=sign] div.o-signature'));
        assert.strictEqual($('.modal .modal-body a.o-web-sign-auto-button').length, 1,
            'should open a modal with "Auto" button');
        assert.strictEqual($('.modal .modal-body .o-web-sign-name-input').val(), "Veggie Burger",
            'Correct Value should be set in the input for auto drawing the signature');

        form.destroy();
    });

    QUnit.module('Signature Widget');

    QUnit.test('Signature widget renders a Sign button', async function (assert) {
        assert.expect(3);

        const form = await createView({
            View: FormView,
            model: 'partner',
            resId: 1,
            data: this.data,
            arch: '<form>' +
                    '<header>' +
                        '<widget name="signature" string="Sign"/>' +
                    '</header>' +
                '</form>',
            mockRPC: function (route, args) {
                if (route === '/web/sign/getFonts/') {
                    return Promise.resolve();
                }
                return this._super(route, args);
            },
        });

        assert.containsOnce(form, 'button.o_sign_button.o_widget',
            "Should have a signature widget button");
        assert.strictEqual($('.modal-dialog').length, 0,
            "Should not have any modal");
        // Clicks on the sign button to open the sign modal.
        await testUtils.dom.click(form.$('span.o-sign-label'));
        assert.strictEqual($('.modal-dialog').length, 1,
            "Should have one modal opened");

        form.destroy();
    });

    QUnit.test('Signature widget: fullName option', async function (assert) {
        assert.expect(2);

        const form = await createView({
            View: FormView,
            model: 'partner',
            resId: 1,
            data: this.data,
            arch: '<form>' +
                    '<header>' +
                        '<widget name="signature" string="Sign" fullName="displayName"/>' +
                    '</header>' +
                    '<field name="displayName"/>' +
                '</form>',
            mockRPC: function (route, args) {
                if (route === '/web/sign/getFonts/') {
                    return Promise.resolve();
                }
                return this._super(route, args);
            },
        });

        // Clicks on the sign button to open the sign modal.
        await testUtils.dom.click(form.$('span.o-sign-label'));
        assert.strictEqual($('.modal .modal-body a.o-web-sign-auto-button').length, 1,
            "Should open a modal with \"Auto\" button");
        assert.strictEqual($('.modal .modal-body .o-web-sign-name-input').val(), "Pop's Chock'lit",
            "Correct Value should be set in the input for auto drawing the signature");

        form.destroy();
    });

    QUnit.test('Signature widget: highlight option', async function (assert) {
        assert.expect(3);

        const form = await createView({
            View: FormView,
            model: 'partner',
            resId: 1,
            data: this.data,
            arch: '<form>' +
                    '<header>' +
                        '<widget name="signature" string="Sign" highlight="1"/>' +
                    '</header>' +
                '</form>',
            mockRPC: function (route, args) {
                if (route === '/web/sign/getFonts/') {
                    return Promise.resolve();
                }
                return this._super(route, args);
            },
        });

        assert.hasClass(form.$('button.o_sign_button.o_widget'), 'btn-primary',
            "The button must have the 'btn-primary' class as \"highlight=1\"");
        // Clicks on the sign button to open the sign modal.
        await testUtils.dom.click(form.$('span.o-sign-label'));
        assert.isNotVisible($('.modal .modal-body a.o-web-sign-auto-button'),
            "\"Auto\" button must be invisible");
        assert.strictEqual($('.modal .modal-body .o-web-sign-name-input').val(), '',
            "No value should be set in the input for auto drawing the signature");

        form.destroy();
    });
});
});
});
