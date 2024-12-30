verp.define('web_kanban_gauge.gauge_tests', function (require) {
"use strict";

var KanbanView = require('web.KanbanView');
var testUtils = require('web.testUtils');

var createView = testUtils.createView;

QUnit.module('fields', {}, function () {

QUnit.module('basicFields', {
    beforeEach: function () {
        this.data = {
            partner: {
                fields: {
                    intField: {string: "intField", type: "integer", sortable: true},
                },
                records: [
                    {id: 1, intField: 10},
                    {id: 2, intField: 4},
                ]
            },
        };
    }
}, function () {

    QUnit.module('gauge widget');

    QUnit.test('basic rendering', async function (assert) {
        assert.expect(1);

        var kanban = await createView({
            View: KanbanView,
            model: 'partner',
            data: this.data,
            arch: '<kanban><templates><t t-name="kanban-box">' +
                    '<div><field name="intField" widget="gauge"/></div>' +
                '</t></templates></kanban>',
        });

        assert.containsOnce(kanban, '.o-kanban-record:first .oe-gauge canvas',
            "should render the gauge widget");

        kanban.destroy();
    });

});
});
});
