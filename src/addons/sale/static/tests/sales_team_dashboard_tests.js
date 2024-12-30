verp.define('sale.dashboard_tests', function (require) {
"use strict";

var KanbanView = require('web.KanbanView');
var testUtils = require('web.testUtils');

var createView = testUtils.createView;

QUnit.module('Sales Team Dashboard', {
    beforeEach: function () {
        this.data = {
            'crm.team': {
                fields: {
                    foo: {string: "Foo", type: 'char'},
                    invoicedTarget: {string: "Invoiced_target", type: 'integer'},
                },
                records: [
                    {id: 1, foo: "yop"},
                ],
            },
        };
    }
});

QUnit.test('edit target with several o-kanban-primary-bottom divs [REQUIRE FOCUS]', async function (assert) {
    assert.expect(6);

    var kanban = await createView({
        View: KanbanView,
        model: 'crm.team',
        data: this.data,
        arch: '<kanban>' +
                '<templates>' +
                    '<t t-name="kanban-box">' +
                        '<div class="container o_kanban_card_content">' +
                            '<field name="invoicedTarget" />' +
                            '<a href="#" class="sales_team_target_definition o-inline-link">' +
                                'Click to define a target</a>' +
                            '<div class="col-12 o-kanban-primary-bottom"/>' +
                            '<div class="col-12 o-kanban-primary-bottom bottom_block"/>' +
                        '</div>' +
                    '</t>' +
                '</templates>' +
              '</kanban>',
        mockRPC: function (route, args) {
            if (args.method === 'write') {
                assert.strictEqual(args.args[1].invoicedTarget, 123,
                    "new value is correctly saved");
            }
            if (args.method === 'read') { // Read happens after the write
                assert.deepEqual(args.args[1], ['invoicedTarget', 'displayName'],
                    'the read (after write) should ask for invoicedTarget');
            }
            return this._super.apply(this, arguments);
        },
    });

    assert.containsOnce(kanban, '.o_kanban_view .sales_team_target_definition',
        "should have classname 'sales_team_target_definition'");
    assert.containsN(kanban, '.o-kanban-primary-bottom', 2,
        "should have two divs with classname 'o-kanban-primary-bottom'");

    await testUtils.dom.click(kanban.$('a.sales_team_target_definition'));
    assert.containsOnce(kanban, '.o-kanban-primary-bottom:last input',
        "should have rendered an input in the last o-kanban-primary-bottom div");

    kanban.$('.o-kanban-primary-bottom:last input').focus();
    kanban.$('.o-kanban-primary-bottom:last input').val('123');
    kanban.$('.o-kanban-primary-bottom:last input').trigger('blur');
    await testUtils.nextTick();
    assert.strictEqual(kanban.$('.o_kanban_record').text(), "123Click to define a target",
        'The kanban record should display the updated target value');

    kanban.destroy();
});

QUnit.test('edit target supports push Enter', async function (assert) {
    assert.expect(3);

    var kanban = await createView({
        View: KanbanView,
        model: 'crm.team',
        data: this.data,
        arch: '<kanban>' +
                '<templates>' +
                    '<t t-name="kanban-box">' +
                        '<div class="container o_kanban_card_content">' +
                            '<field name="invoicedTarget" />' +
                            '<a href="#" class="sales_team_target_definition o-inline-link">' +
                                'Click to define a target</a>' +
                            '<div class="col-12 o-kanban-primary-bottom"/>' +
                            '<div class="col-12 o-kanban-primary-bottom bottom_block"/>' +
                        '</div>' +
                    '</t>' +
                '</templates>' +
              '</kanban>',
        mockRPC: function (route, args) {
            if (args.method === 'write') {
                assert.strictEqual(args.args[1].invoicedTarget, 123,
                    "new value is correctly saved");
            }
            if (args.method === 'read') { // Read happens after the write
                assert.deepEqual(args.args[1], ['invoicedTarget', 'displayName'],
                    'the read (after write) should ask for invoicedTarget');
            }
            return this._super.apply(this, arguments);
        },
    });

    await testUtils.dom.click(kanban.$('a.sales_team_target_definition'));

    kanban.$('.o-kanban-primary-bottom:last input').focus();
    kanban.$('.o-kanban-primary-bottom:last input').val('123');
    kanban.$('.o-kanban-primary-bottom:last input').trigger($.Event('keydown', {which: $.ui.keyCode.ENTER, keyCode: $.ui.keyCode.ENTER}));
    await testUtils.nextTick();
    assert.strictEqual(kanban.$('.o_kanban_record').text(), "123Click to define a target",
        'The kanban record should display the updated target value');

    kanban.destroy();
});

});
