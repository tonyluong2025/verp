verp.define('web.kanban_model_tests', function (require) {
"use strict";

var KanbanModel = require('web.KanbanModel');
var testUtils = require('web.testUtils');

var createModel = testUtils.createModel;

QUnit.module('Views', {
    beforeEach: function () {
        this.data = {
            partner: {
                fields: {
                    active: {string: "Active", type: "boolean", default: true},
                    displayName: {string: "STRING", type: 'char'},
                    foo: {string: "Foo", type: 'char'},
                    bar: {string: "Bar", type: 'integer'},
                    qux: {string: "Qux", type: 'many2one', relation: 'partner'},
                    productId: {string: "Favorite product", type: 'many2one', relation: 'product'},
                    productIds: {string: "Favorite products", type: 'one2many', relation: 'product'},
                    category: {string: "Category M2M", type: 'many2many', relation: 'partner_type'},
                },
                records: [
                    {id: 1, foo: 'blip', bar: 1, productId: 37, category: [12], displayName: "first partner"},
                    {id: 2, foo: 'gnap', bar: 2, productId: 41, displayName: "second partner"},
                ],
                onchanges: {},
            },
            product: {
                fields: {
                    name: {string: "Product Name", type: "char"}
                },
                records: [
                    {id: 37, displayName: "xphone"},
                    {id: 41, displayName: "xpad"}
                ]
            },
            partner_type: {
                fields: {
                    displayName: {string: "Partner Type", type: "char"}
                },
                records: [
                    {id: 12, displayName: "gold"},
                    {id: 14, displayName: "silver"},
                    {id: 15, displayName: "bronze"}
                ]
            },
        };

        // add related fields to category.
        this.data.partner.fields.category.relatedFields =
            $.extend(true, {}, this.data.partner_type.fields);
        this.params = {
            fields: this.data.partner.fields,
            limit: 40,
            modelName: 'partner',
            openGroupByDefault: true,
            viewType: 'kanban',
        };
    },
}, function () {

    QUnit.module('KanbanModel');

    QUnit.test('load grouped + add a new group', async function (assert) {
        var done = assert.async();
        assert.expect(22);

        var calledRoutes = {};
        var model = await createModel({
            Model: KanbanModel,
            data: this.data,
            mockRPC: function (route) {
                if (!(route in calledRoutes)) {
                    calledRoutes[route] = 1;
                } else {
                    calledRoutes[route]++;
                }
                return this._super.apply(this, arguments);
            },
        });

        var params = _.extend(this.params, {
            groupedBy: ['productId'],
            fieldNames: ['foo'],
        });

        model.load(params).then(async function (resultID) {
            // various checks on the load result
            var state = model.get(resultID);
            assert.ok(_.isEqual(state.groupedBy, ['productId']), 'should be grouped by "productId"');
            assert.strictEqual(state.data.length, 2, 'should have found 2 groups');
            assert.strictEqual(state.count, 2, 'both groups contain one record');
            var xphoneGroup = _.findWhere(state.data, {resId: 37});
            assert.strictEqual(xphoneGroup.model, 'partner', 'group should have correct model');
            assert.ok(xphoneGroup, 'should have a group for resId 37');
            assert.ok(xphoneGroup.isOpen, '"xphone" group should be open');
            assert.strictEqual(xphoneGroup.value, 'xphone', 'group 37 should be "xphone"');
            assert.strictEqual(xphoneGroup.count, 1, '"xphone" group should have one record');
            assert.strictEqual(xphoneGroup.data.length, 1, 'should have fetched the records in the group');
            assert.ok(_.isEqual(xphoneGroup.domain[0], ['productId', '=', 37]),
                'domain should be correct');
            assert.strictEqual(xphoneGroup.limit, 40, 'limit in a group should be 40');

            // add a new group
            await model.createGroup('xpod', resultID);
            state = model.get(resultID);
            assert.strictEqual(state.data.length, 3, 'should now have 3 groups');
            assert.strictEqual(state.count, 2, 'there are still 2 records');
            var xpodGroup = _.findWhere(state.data, {value: 'xpod'});
            assert.strictEqual(xpodGroup.model, 'partner', 'new group should have correct model');
            assert.ok(xpodGroup, 'should have an "xpod" group');
            assert.ok(xpodGroup.isOpen, 'new group should be open');
            assert.strictEqual(xpodGroup.count, 0, 'new group should contain no record');
            assert.ok(_.isEqual(xpodGroup.domain[0], ['productId', '=', xpodGroup.resId]),
                'new group should have correct domain');

            // check the rpcs done
            assert.strictEqual(Object.keys(calledRoutes).length, 3, 'three different routes have been called');
            var nbReadGroups = calledRoutes['/web/dataset/callKw/partner/webReadGroup'];
            var nbSearchRead = calledRoutes['/web/dataset/searchRead'];
            var nbNameCreate = calledRoutes['/web/dataset/callKw/product/nameCreate'];
            assert.strictEqual(nbReadGroups, 1, 'should have done 1 readGroup');
            assert.strictEqual(nbSearchRead, 2, 'should have done 2 searchRead');
            assert.strictEqual(nbNameCreate, 1, 'should have done 1 nameCreate');
            model.destroy();
            done();
        });
    });

    QUnit.test('archive/restore a column', async function (assert) {
        var done = assert.async();
        assert.expect(4);

        var model = await createModel({
            Model: KanbanModel,
            data: this.data,
            mockRPC: function (route, args) {
                if (route === '/web/dataset/callKw/partner/actionArchive') {
                    this.data.partner.records[0].active = false;
                    return Promise.resolve();
                }
                return this._super.apply(this, arguments);
            },
        });

        var params = _.extend(this.params, {
            groupedBy: ['productId'],
            fieldNames: ['foo'],
        });

        model.load(params).then(async function (resultID) {
            var state = model.get(resultID);
            var xphoneGroup = _.findWhere(state.data, {resId: 37});
            var xpadGroup = _.findWhere(state.data, {resId: 41});
            assert.strictEqual(xphoneGroup.count, 1, 'xphone group has one record');
            assert.strictEqual(xpadGroup.count, 1, 'xpad group has one record');

            // archive the column 'xphone'
            var recordIDs = xphoneGroup.data.map(record => record.resId);
            await model.actionArchive(recordIDs, xphoneGroup.id);
            state = model.get(resultID);
            xphoneGroup = _.findWhere(state.data, {resId: 37});
            assert.strictEqual(xphoneGroup.count, 0, 'xphone group has no record anymore');
            xpadGroup = _.findWhere(state.data, {resId: 41});
            assert.strictEqual(xpadGroup.count, 1, 'xpad group still has one record');
            model.destroy();
            done();
        });
    });

    QUnit.test('kanban model does not allow nested groups', async function (assert) {
        var done = assert.async();
        assert.expect(2);

        var model = await createModel({
            Model: KanbanModel,
            data: this.data,
            mockRPC: function (route, args) {
                if (args.method === 'webReadGroup') {
                    assert.deepEqual(args.kwargs.groupby, ['productId'],
                        "the second level of groupBy should have been removed");
                }
                return this._super.apply(this, arguments);
            },
        });

        var params = _.extend(this.params, {
            groupedBy: ['productId', 'qux'],
            fieldNames: ['foo'],
        });

        model.load(params).then(function (resultID) {
            var state = model.get(resultID);

            assert.deepEqual(state.groupedBy, ['productId'],
                "the second level of groupBy should have been removed");

            model.destroy();
            done();
        });
    });

    QUnit.test('resequence columns and records', async function (assert) {
        var done = assert.async();
        assert.expect(8);

        this.data.product.fields.sequence = {string: "Sequence", type: "integer"};
        this.data.partner.fields.sequence = {string: "Sequence", type: "integer"};
        this.data.partner.records.push({id: 3, foo: 'aaa', productId: 37});

        var nbReseq = 0;
        var model = await createModel({
            Model: KanbanModel,
            data: this.data,
            mockRPC: function (route, args) {
                if (route === '/web/dataset/resequence') {
                    nbReseq++;
                    if (nbReseq === 1) { // resequencing columns
                        assert.deepEqual(args.ids, [41, 37],
                            "ids should be correct");
                        assert.strictEqual(args.model, 'product',
                            "model should be correct");
                    } else if (nbReseq === 2) { // resequencing records
                        assert.deepEqual(args.ids, [3, 1],
                            "ids should be correct");
                        assert.strictEqual(args.model, 'partner',
                            "model should be correct");
                    }
                }
                return this._super.apply(this, arguments);
            },
        });
        var params = _.extend(this.params, {
            groupedBy: ['productId'],
            fieldNames: ['foo'],
        });

        model.load(params)
            .then(function (stateID) {
                var state = model.get(stateID);
                assert.strictEqual(state.data[0].resId, 37,
                    "first group should be resId 37");

                // resequence columns
                return model.resequence('product', [41, 37], stateID);
            })
            .then(function (stateID) {
                var state = model.get(stateID);
                assert.strictEqual(state.data[0].resId, 41,
                    "first group should be resId 41 after resequencing");
                assert.strictEqual(state.data[1].data[0].resId, 1,
                    "first record should be resId 1");

                // resequence records
                return model.resequence('partner', [3, 1], state.data[1].id);
            })
            .then(function (groupID) {
                var group = model.get(groupID);
                assert.strictEqual(group.data[0].resId, 3,
                    "first record should be resId 3 after resequencing");

                model.destroy();
                done();
            });
    });

    QUnit.test('add record to group', async function (assert) {
        var done = assert.async();
        assert.expect(8);

        var self = this;
        var model = await createModel({
            Model: KanbanModel,
            data: this.data,
        });
        var params = _.extend(this.params, {
            groupedBy: ['productId'],
            fieldNames: ['foo'],
        });

        model.load(params).then(function (stateID) {
            self.data.partner.records.push({id: 3, foo: 'new record', productId: 37});

            var state = model.get(stateID);
            assert.deepEqual(state.resIds, [1, 2],
                "state should have the correct resIds");
            assert.strictEqual(state.count, 2,
                "state should have the correct count");
            assert.strictEqual(state.data[0].count, 1,
                "first group should contain one record");

            return model.addRecordToGroup(state.data[0].id, 3).then(function () {
                var state = model.get(stateID);
                assert.deepEqual(state.resIds, [3, 1, 2],
                    "state should have the correct resIds");
                assert.strictEqual(state.count, 3,
                    "state should have the correct count");
                assert.deepEqual(state.data[0].resIds, [3, 1],
                    "new record's id should have been added to the resIds");
                assert.strictEqual(state.data[0].count, 2,
                    "first group should now contain two records");
                assert.strictEqual(state.data[0].data[0].data.foo, 'new record',
                    "new record should have been fetched");
            });
        }).then(function() {
            model.destroy();
            done();
        })

    });

    QUnit.test('call get (raw: true) before loading x2many data', async function (assert) {
        // Sometimes, get can be called on a datapoint that is currently being
        // reloaded, and thus in a partially updated state (e.g. in a kanban
        // view, the user interacts with the searchView, and before the view is
        // fully reloaded, it clicks on CREATE). Ideally, this shouldn't happen,
        // but with the sync API of get, we can't change that easily. So at most,
        // we can ensure that it doesn't crash. Moreover, sensitive functions
        // requesting the state for more precise information that, e.g., the
        // count, can do that in the mutex to ensure that the state isn't
        // currently being reloaded.
        // In this test, we have a grouped kanban view with a one2many, whose
        // relational data is loaded in batch, once for all groups. We call get
        // when the searchRead for the first group has returned, but not the
        // second (and thus, the read of the one2many hasn't started yet).
        // Note: this test can be removed as soon as search_reads are performed
        // alongside readGroup.
        var done = assert.async();
        assert.expect(2);

        this.data.partner.records[1].productIds = [37, 41];
        this.params.fieldsInfo = {
            kanban: {
                productIds: {
                    fieldsInfo: {
                        default: { displayName: {}, color: {} },
                    },
                    relatedFields: this.data.product.fields,
                    viewType: 'default',
                },
            },
        };
        this.params.viewType = 'kanban';
        this.params.groupedBy = ['foo'];

        var block;
        var def = testUtils.makeTestPromise();
        var model = await createModel({
            Model: KanbanModel,
            data: this.data,
            mockRPC: function (route) {
                var result = this._super.apply(this, arguments);
                if (route === '/web/dataset/searchRead' && block) {
                    block = false;
                    return Promise.all([def]).then(_.constant(result));
                }
                return result;
            },
        });

        model.load(this.params).then(function (handle) {
            block = true;
            model.reload(handle, {});

            var state = model.get(handle, {raw: true});
            assert.strictEqual(state.count, 2);

            def.resolve();

            state = model.get(handle, {raw: true});
            assert.strictEqual(state.count, 2);
        }).then(function() {
            model.destroy();
            done();
        });
    });
});

});
