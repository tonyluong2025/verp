verp.define('account_asset.widgetTests', function (require) {
"use strict";

var FormView = require('web.FormView');
var testUtils = require('web.testUtils');

var createView = testUtils.createView;

QUnit.module('fields', {}, function () {

QUnit.module('omAccountAsset', {
    beforeEach: function () {
        this.data = {
            asset: {
                fields: {
                    displayName: { string: "Displayed name", type: "char" },
                    lineIds: {
                        string: "Lines",
                        type: "one2many",
                        relation: 'line',
                        relationField: 'assetId',
                    },
                },
                records: [{
                    id: 1,
                    displayName: "asset name",
                    lineIds: [1, 2, 3, 4],
                }],
            },
            line: {
                fields: {
                    moveCheck: {string: "Move Check", type: 'boolean'},
                    movePostedCheck: {string: "Move Posted Check", type: 'boolean'},
                    assetId: {string: "Asset", type: 'many2one', relation: 'asset'},
                },
                records: [{
                    id: 1,
                    moveCheck: true,
                    movePostedCheck: true,
                }, {
                    id: 2,
                    moveCheck: false,
                    movePostedCheck: true,
                }, {
                    id: 3,
                    moveCheck: true,
                    movePostedCheck: false,
                }, {
                    id: 4,
                    moveCheck: false,
                    movePostedCheck: false,
                }],
            },
        };
    }
});

QUnit.test('basic rendering', function (assert) {
    assert.expect(18);

    var form = createView({
        View: FormView,
        model: 'asset',
        data: this.data,
        arch: '<form string="Asset">' +
                '<sheet>' +
                    '<field name="displayName"/>' +
                    '<field name="lineIds">' +
                        '<tree>' +
                            '<field name="moveCheck" widget="deprecLinesToggler"/>' +
                            '<field name="movePostedCheck" invisible="1"/>' +
                        '</tree>' +
                    '</field>' +
                '</sheet>' +
            '</form>',
        resId: 1,
    });

    // check the header
    assert.strictEqual(form.$('thead th').text(), "", "toggler column should have no title");

    // check the classnames
    assert.ok(form.$('.o-deprec-lines-toggler_cell:nth(0) button').hasClass('o-is-posted'),
        "first line toggler should have classname 'o-is-posted'");
    assert.ok(!form.$('.o-deprec-lines-toggler_cell:nth(0) button').hasClass('o-unposted'),
        "first line toggler should not have classname 'o-unposted'");

    assert.ok(form.$('.o-deprec-lines-toggler_cell:nth(1) button').hasClass('o-is-posted'),
        "second line toggler should have classname 'o-is-posted'");
    assert.ok(!form.$('.o-deprec-lines-toggler_cell:nth(1) button').hasClass('o-unposted'),
        "second line toggler should not have classname 'o-unposted'");

    assert.ok(!form.$('.o-deprec-lines-toggler_cell:nth(2) button').hasClass('o-is-posted'),
        "third line toggler should not have classname 'o-is-posted'");
    assert.ok(form.$('.o-deprec-lines-toggler_cell:nth(2) button').hasClass('o-unposted'),
        "third line toggler should have classname 'o-unposted'");

    assert.ok(!form.$('.o-deprec-lines-toggler_cell:nth(3) button').hasClass('o-is-posted'),
        "fourth line toggler should not have classname 'o-is-posted'");
    assert.ok(!form.$('.o-deprec-lines-toggler_cell:nth(3) button').hasClass('o-unposted'),
        "fourth line toggler should not have classname 'o-unposted'");

    // check the titles
    assert.strictEqual(form.$('.o-deprec-lines-toggler_cell:nth(0) button').attr('title'),
        'Posted', "first line toggler should have correct title");
    assert.strictEqual(form.$('.o-deprec-lines-toggler_cell:nth(1) button').attr('title'),
        'Posted', "second line toggler should have correct title");
    assert.strictEqual(form.$('.o-deprec-lines-toggler_cell:nth(2) button').attr('title'),
        'Accounting entries waiting for manual verification',
        "third line toggler should have correct title");
    assert.strictEqual(form.$('.o-deprec-lines-toggler_cell:nth(3) button').attr('title'),
        'Unposted', "fourth line toggler should have correct title");

    // check disabled property
    assert.ok(form.$('.o-deprec-lines-toggler_cell:nth(0) button').attr('disabled'),
        "first line toggle should be disabled");
    assert.ok(form.$('.o-deprec-lines-toggler_cell:nth(1) button').attr('disabled'),
        "second line toggle should be disabled");
    assert.ok(form.$('.o-deprec-lines-toggler_cell:nth(2) button').attr('disabled'),
        "third line toggle should be disabled");
    assert.ok(!form.$('.o-deprec-lines-toggler_cell:nth(3) button').attr('disabled'),
        "fourth line toggle should not be disabled");

    // check the visibility: the widget should always be visible, regardless its value
    assert.strictEqual(form.$('.o-deprec-lines-toggler:visible').length, 4,
        "all togglers should be visible");

    form.destroy();
});

QUnit.test('click events are correctly triggered', function (assert) {
    assert.expect(2);

    var form = createView({
        View: FormView,
        model: 'asset',
        data: this.data,
        arch: '<form string="Asset">' +
                '<sheet>' +
                    '<field name="displayName"/>' +
                    '<field name="lineIds">' +
                        '<tree>' +
                            '<field name="move_check" widget="deprec_lines_toggler"/>' +
                            '<field name="move_posted_check" invisible="1"/>' +
                        '</tree>' +
                    '</field>' +
                '</sheet>' +
            '</form>',
        resId: 1,
        intercepts: {
            execute_action: function (event) {
                var data = event.data;
                assert.strictEqual(data.env.model, 'line', "should have correct model");
                assert.strictEqual(data.action_data.name, 'create_move',
                    "should call correct method");
            },
        }
    });

    // click on last row toggler
    form.$('.o-deprec-lines-toggler_cell:nth(3) button').click();

    form.destroy();
});

});

});
