/* global Benchmark */
verp.define('web.form_benchmarks', function (require) {
    "use strict";

    const FormView = require('web.FormView');
    const testUtils = require('web.testUtils');

    const { createView } = testUtils;

    QUnit.module('Form View', {
        beforeEach: function () {
            this.data = {
                foo: {
                    fields: {
                        foo: {string: "Foo", type: "char"},
                        many2many: { string: "bar", type: "many2many", relation: 'bar'},
                    },
                    records: [
                        { id: 1, foo: "bar", many2many: []},
                    ],
                    onchanges: {}
                },
                bar: {
                    fields: {
                        char: {string: "char", type: "char"},
                        many2many: { string: "pokemon", type: "many2many", relation: 'pokemon'},
                    },
                    records: [],
                    onchanges: {}
                },
                pokemon: {
                    fields: {
                        name: {string: "Name", type: "char"},
                    },
                    records: [],
                    onchanges: {}
                },
            };
            this.arch = null;
            this.run = function (assert, viewParams, cb) {
                const data = this.data;
                const arch = this.arch;
                return new Promise(resolve => {
                    new Benchmark.Suite({})
                        .add('form', {
                            defer: true,
                            fn: async (deferred) => {
                                const form = await createView(Object.assign({
                                    View: FormView,
                                    model: 'foo',
                                    data,
                                    arch,
                                }, viewParams));
                                if (cb) {
                                    await cb(form);
                                }
                                form.destroy();
                                deferred.resolve();
                            },
                        })
                        .on('cycle', event => {
                            assert.ok(true, String(event.target));
                        })
                        .on('complete', resolve)
                        .run({ async: true });
                });
            };
        }
    }, function () {
        QUnit.test('x2many with 250 rows, 2 fields (with many2manyTags, and modifiers), onchanges, and edition', function (assert) {
            assert.expect(1);

            this.data.foo.onchanges.many2many = function (obj) {
                obj.many2many = [5].concat(obj.many2many);
            };
            for (let i = 2; i < 500; i++) {
                this.data.bar.records.push({
                    id: i,
                    char: "automated data",
                });
                this.data.foo.records[0].many2many.push(i);
            }
            this.arch = `
                <form>
                    <field name="many2many">
                        <tree editable="top" limit="250">
                            <field name="char"/>
                            <field name="many2many" widget="many2manyTags" attrs="{'readonly': [('char', '==', 'toto')]}"/>
                        </tree>
                    </field>
                </form>`;
            return this.run(assert, { resId: 1 }, async form => {
                await testUtils.form.clickEdit(form);
                await testUtils.dom.click(form.$('.o-data-cell:first'));
                await testUtils.fields.editInput(form.$('input:first'), "tralala");
            });
        });

        QUnit.test('form view with 100 fields, half of them being invisible', function (assert) {
            assert.expect(1);

            this.arch = `
                <form>
                    ${[...Array(100)].map((_, i) => '<field name="foo"' + (i % 2 ? ' invisible="1"' : '') + '/>').join('')}
                </form>`;
            return this.run(assert);
        });
    });
});
