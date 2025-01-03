verp.define('web.domain_selector_tests', function (require) {
"use strict";

var DomainSelector = require("web.DomainSelector");
var Widget = require("web.Widget");
var testUtils = require("web.testUtils");
const { createWebClient, doAction } = require('@web/../tests/webclient/helpers');

QUnit.module('widgets', {}, function () {

QUnit.module('DomainSelector', {
    beforeEach: function () {
        this.data = {
            partner: {
                fields: {
                    foo: {string: "Foo", type: "char", searchable: true},
                    bar: {string: "Bar", type: "boolean", searchable: true},
                    nice_datetime: {string: "Datetime", type: "datetime", searchable: true},
                    productId: {string: "Product", type: "many2one", relation: "product", searchable: true},
                },
                records: [{
                    id: 1,
                    foo: "yop",
                    bar: true,
                    productId: 37,
                }, {
                    id: 2,
                    foo: "blip",
                    bar: true,
                    productId: false,
                }, {
                    id: 4,
                    foo: "abc",
                    bar: false,
                    productId: 41,
                }],
                onchanges: {},
            },
            product: {
                fields: {
                    name: {string: "Product Name", type: "char", searchable: true}
                },
                records: [{
                    id: 37,
                    displayName: "xphone",
                }, {
                    id: 41,
                    displayName: "xpad",
                }]
            },
        };
    },
}, function () {

    QUnit.test("creating a domain from scratch", async function (assert) {
        assert.expect(12);

        var $target = $("#qunit-fixture");

        // Create the domain selector and its mock environment
        var domainSelector = new DomainSelector(null, "partner", [], {
            readonly: false,
            debugMode: true,
        });
        await testUtils.mock.addMockEnvironment(domainSelector, {data: this.data});
        await domainSelector.appendTo($target);

        // As we gave an empty domain, there should be a visible button to add
        // the first domain part
        var $domainAddFirstNodeButton = domainSelector.$(".o-domain-add-first-node-button:visible");
        assert.strictEqual($domainAddFirstNodeButton.length, 1,
            "there should be a button to create first domain element");

        // Clicking on the button should add a visible field selector in the
        // widget so that the user can change the field chain
        await testUtils.dom.click($domainAddFirstNodeButton);
        var $fieldSelector = domainSelector.$(".o-field-selector:visible");
        assert.strictEqual($fieldSelector.length, 1,
            "there should be a field selector");

        // Focusing the field selector input should open a field selector popover
        $fieldSelector.trigger('focusin');
        await testUtils.nextTick();
        var $fieldSelectorPopover = $fieldSelector.find(".o-field-selector-popover:visible");
        assert.strictEqual($fieldSelectorPopover.length, 1,
            "field selector popover should be visible");

        // The field selector popover should contain the list of "partner"
        // fields. "Bar" should be among them.
        var $lis = $fieldSelectorPopover.find("li");
        var $barLi = $();
        $lis.each(function () {
            var $li = $(this);
            if ($li.html().indexOf("Bar") >= 0) {
                $barLi = $li;
            }
        });
        assert.strictEqual($barLi.length, 1,
            "field selector popover should contain the 'Bar' field");

        // Clicking the "Bar" field should change the internal domain and this
        // should be displayed in the debug textarea
        await testUtils.dom.click($barLi);
        assert.containsOnce(domainSelector, "textarea.o-domain-debug-input");
        assert.strictEqual(
            domainSelector.$(".o-domain-debug-input").val(),
            '[["bar","=",true]]',
            "the domain input should contain a domain with 'bar'"
        );

        // There should be a "+" button to add a domain part; clicking on it
        // should add the default "['id', '=', 1]" domain
        var $plus = domainSelector.$(".fa-plus-circle");
        assert.strictEqual($plus.length, 1, "there should be a '+' button");
        await testUtils.dom.click($plus);
        assert.strictEqual(
            domainSelector.$(".o-domain-debug-input").val(),
            '["&",["bar","=",true],["id","=",1]]',
            "the domain input should contain a domain with 'bar' and 'id'");

        // There should be two "..." buttons to add a domain group; clicking on
        // the first one, should add this group with defaults "['id', '=', 1]"
        // domains and the "|" operator
        var $dots = domainSelector.$(".fa-ellipsis-h");
        assert.strictEqual($dots.length, 2, "there should be two '...' buttons");
        await testUtils.dom.click($dots.first());
        assert.strictEqual(
            domainSelector.$(".o-domain-debug-input").val(),
            '["&","&",["bar","=",true],"|",["id","=",1],["id","=",1],["id","=",1]]',
            "the domain input should contain a domain with 'bar', 'id' and a subgroup"
        );

        // There should be five "-" buttons to remove domain part; clicking on
        // the two last ones, should leave a domain with only the "bar" and
        // "foo" fields, with the initial "&" operator
        var $minus = domainSelector.$(".o-domain-delete-node-button");
        assert.strictEqual($minus.length, 5, "there should be five 'x' buttons");
        await testUtils.dom.click($minus.last());
        await testUtils.dom.click(domainSelector.$(".o-domain-delete-node-button").last());
        assert.strictEqual(
            domainSelector.$(".o-domain-debug-input").val(),
            '["&",["bar","=",true],["id","=",1]]',
            "the domain input should contain a domain with 'bar' and 'id'"
        );
        domainSelector.destroy();
    });

    QUnit.test("building a domain with a datetime", async function (assert) {
        assert.expect(2);

        var $target = $("#qunit-fixture");

        // Create the domain selector and its mock environment
        var domainSelector = new DomainSelector(null, "partner", [["nice_datetime", "=", "2017-03-27 15:42:00"]], {
            readonly: false,
        });
        await testUtils.mock.addMockEnvironment(domainSelector, {data: this.data});
        await domainSelector.appendTo($target);

        // Check that there is a datepicker to choose the date
        var $datepicker = domainSelector.$(".o-datepicker:visible");
        assert.strictEqual($datepicker.length, 1,
            "there should be a datepicker");

        var val = $datepicker.find('input').val();
        await testUtils.dom.openDatepicker($datepicker);
        await testUtils.dom.clickFirst($('.bootstrap-datetimepicker-widget :not(.today)[data-action="selectDay"]'));
        assert.notEqual(domainSelector.$(".o-datepicker:visible input").val(), val,
            "datepicker value should have changed");
        await testUtils.dom.click($('.bootstrap-datetimepicker-widget a[data-action=close]'));

        domainSelector.destroy();
    });

    QUnit.test("building a domain with a m2o without following the relation", async function (assert) {
        assert.expect(1);

        var $target = $("#qunit-fixture");

        // Create the domain selector and its mock environment
        var domainSelector = new DomainSelector(null, "partner", [["productId", "ilike", 1]], {
            debugMode: true,
            readonly: false,
        });
        await testUtils.mock.addMockEnvironment(domainSelector, {data: this.data});
        await domainSelector.appendTo($target);

        await testUtils.fields.editAndTrigger(domainSelector.$('.o-domain-leaf-value-input'),
            'pad', ['input', 'change']);
        assert.strictEqual(domainSelector.$('.o-domain-debug-input').val(), '[["productId","ilike","pad"]]',
            "string should have been allowed as m2o value");

        domainSelector.destroy();
    });

    QUnit.test("editing a domain with `parent` key", async function (assert) {
        assert.expect(1);

        var $target = $("#qunit-fixture");

        // Create the domain selector and its mock environment
        var domainSelector = new DomainSelector(null, "product", "[['name','=',parent.foo]]", {
            debugMode: true,
            readonly: false,
        });
        await testUtils.mock.addMockEnvironment(domainSelector, {data: this.data});
        await domainSelector.appendTo($target);

        assert.strictEqual(domainSelector.$el.text(), "This domain is not supported.",
            "an error message should be displayed because of the `parent` key");

        domainSelector.destroy();
    });

    QUnit.test("creating a domain with a default option", async function (assert) {
        assert.expect(1);

        var $target = $("#qunit-fixture");

        // Create the domain selector and its mock environment
        var domainSelector = new DomainSelector(null, "partner", [], {
            readonly: false,
            debugMode: true,
            default: [["foo","=","kikou"]],
        });
        await testUtils.mock.addMockEnvironment(domainSelector, {data: this.data});
        await domainSelector.appendTo($target);

        // Clicking on the button should add a visible field selector in the
        // widget so that the user can change the field chain
        await testUtils.dom.click(domainSelector.$(".o-domain-add-first-node-button:visible"));

        assert.strictEqual(
            domainSelector.$(".o-domain-debug-input").val(),
            '[["foo","=","kikou"]]',
            "the domain input should contain the default domain");

        domainSelector.destroy();
    });

    QUnit.test("inline domain editor in modal", async function (assert) {
        assert.expect(1);

        const serverData = {
            actions: {
                5: {
                    id: 5,
                    name: "Partner Form",
                    resModel: "partner",
                    target: "new",
                    type: "ir.actions.actwindow",
                    views: [["view_ref", "form"]],
                },
            },
            models: this.data,
            views: {
                "partner,view_ref,form": `
                    <form>
                        <field name="foo" string="Domain" widget="domain" options="{'model': 'partner'}"/>
                    </form>
                `,
            },
        };

        const webClient = await createWebClient({ serverData });
        await doAction(webClient, 5);
        assert.strictEqual(document.querySelector('div[name="foo"]').closest('.modal-body').style.overflow,
            'visible', "modal should have visible overflow if there is inline domain field widget");
    });

    QUnit.test("edit a domain with the debug textarea", async function (assert) {
        assert.expect(5);

        const $target = $("#qunit-fixture");
        let newValue;

        // Create the domain selector and its mock environment
        const Parent = Widget.extend({
            customEvents: {
                domainChanged: (e) => {
                    assert.deepEqual(e.data.domain, newValue);
                    assert.ok(e.data.debug);
                },
            },
        });
        const parent = new Parent(null);
        const domainSelector = new DomainSelector(parent, "partner", [["productId", "ilike", 1]], {
            debugMode: true,
            readonly: false,
        });
        await testUtils.mock.addMockEnvironment(domainSelector, {data: this.data});
        await domainSelector.appendTo($target);

        assert.containsOnce(domainSelector, ".o-domain-node", "should have a single domain node");
        newValue = `
[
    ['productId', 'ilike', 1],
    ['id', '=', 0]
]`;
        await testUtils.fields.editAndTrigger(domainSelector.$('.o-domain-debug-input'), newValue, ["change"]);
        assert.strictEqual(domainSelector.$('.o-domain-debug-input').val(), newValue,
            "the domain should not have been formatted");
        assert.containsOnce(domainSelector, ".o-domain-node", "should still have a single domain node");

        domainSelector.destroy();
    });
});
});
});
