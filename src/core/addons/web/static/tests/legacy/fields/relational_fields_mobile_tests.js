verp.define("web.relational_fields_mobile_tests", function (require) {
"use strict";

const FormView = require("web.FormView");
const testUtils = require("web.testUtils");

QUnit.module("fields", {}, function () {
    QUnit.module("relationalFields", {
        beforeEach() {
            this.data = {
                partner: {
                    fields: {
                        displayName: { string: "Displayed name", type: "char" },
                        p: {string: "one2many field", type: "one2many", relation: "partner", relationField: "trululu"},
                        trululu: {string: "Trululu", type: "many2one", relation: "partner"},
                    },
                    records: [{
                        id: 1,
                        displayName: "first record",
                        p: [2, 4],
                        trululu: 4,
                    }, {
                        id: 2,
                        displayName: "second record",
                        p: [],
                        trululu: 1,
                    }, {
                        id: 4,
                        displayName: "aaa",
                    }],
                },
            };
        },
    }, function () {
        QUnit.module("FieldOne2Many");

        QUnit.test("one2many on mobile: display list if present without kanban view", async function (assert) {
            assert.expect(2);

            const form = await testUtils.createView({
                View: FormView,
                model: "partner",
                data: this.data,
                arch: `
                    <form>
                        <field name="p">
                            <tree>
                                <field name="displayName"/>
                            </tree>
                        </field>
                    </form>
                `,
                resId: 1,
            });

            await testUtils.form.clickEdit(form);
            assert.containsOnce(form, ".o-field-x2many_list",
                "should display one2many's list");
            assert.containsN(form, ".o-field-x2many_list .o-data-row", 2,
                "should display 2 records in one2many's list");

            form.destroy();
        });
    });
});
});
