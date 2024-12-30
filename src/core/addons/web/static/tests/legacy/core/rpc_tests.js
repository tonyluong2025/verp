verp.define('web.rpc_tests', function (require) {
"use strict";

var rpc = require('web.rpc');

QUnit.module('core', {}, function () {

    QUnit.module('RPC Builder');

    QUnit.test('basic rpc (route)', function (assert) {
        assert.expect(1);

        var query = rpc.buildQuery({
            route: '/my/route',
        });
        assert.strictEqual(query.route, '/my/route', "should have the proper route");
    });

    QUnit.test('rpc on route with parameters', function (assert) {
        assert.expect(1);

        var query = rpc.buildQuery({
            route: '/my/route',
            params: {hey: 'there', model: 'test'},
        });

        assert.deepEqual(query.params, {hey: 'there', model: 'test'},
                    "should transfer the proper parameters");
    });

    QUnit.test('basic rpc, with no context', function (assert) {
        assert.expect(1);

        var query = rpc.buildQuery({
            model: 'partner',
            method: 'test',
            kwargs: {},
        });
        assert.notOk(query.params.kwargs.context,
            "does not automatically add a context");
    });

    QUnit.test('basic rpc, with context', function (assert) {
        assert.expect(1);

        var query = rpc.buildQuery({
            model: 'partner',
            method: 'test',
            context: {a: 1},
        });

        assert.deepEqual(query.params.kwargs.context, {a: 1},
            "properly transfer the context");
    });

    QUnit.test('basic rpc, with context, part 2', function (assert) {
        assert.expect(1);

        var query = rpc.buildQuery({
            model: 'partner',
            method: 'test',
            kwargs: {context: {a: 1}},
        });

        assert.deepEqual(query.params.kwargs.context, {a: 1},
            "properly transfer the context");

    });

    QUnit.test('basic rpc (method of model)', function (assert) {
        assert.expect(3);

        var query = rpc.buildQuery({
            model: 'partner',
            method: 'test',
            kwargs: {context: {a: 1}},
        });

        assert.strictEqual(query.route, '/web/dataset/callKw/partner/test',
            "should call the proper route");
        assert.strictEqual(query.params.model, 'partner',
            "should correctly specify the model");
        assert.strictEqual(query.params.method, 'test',
            "should correctly specify the method");
    });

    QUnit.test('rpc with args and kwargs', function (assert) {
        assert.expect(4);
        var query = rpc.buildQuery({
            model: 'partner',
            method: 'test',
            args: ['arg1', 2],
            kwargs: {k: 78},
        });

        assert.strictEqual(query.route, '/web/dataset/callKw/partner/test',
            "should call the proper route");
        assert.strictEqual(query.params.args[0], 'arg1',
            "should call with correct args");
        assert.strictEqual(query.params.args[1], 2,
            "should call with correct args");
        assert.strictEqual(query.params.kwargs.k, 78,
            "should call with correct kargs");
    });

    QUnit.test('searchRead controller', function (assert) {
        assert.expect(1);
        var query = rpc.buildQuery({
            route: '/web/dataset/searchRead',
            model: 'partner',
            domain: ['a', '=', 1],
            fields: ['name'],
            limit: 32,
            offset: 2,
            orderby: [{name: 'yop', asc: true}, {name: 'aa', asc: false}],
        });
        assert.deepEqual(query.params, {
            context: {},
            domain: ['a', '=', 1],
            fields: ['name'],
            limit: 32,
            offset: 2,
            model: 'partner',
            sort: 'yop ASC, aa DESC',
        }, "should have correct args");
    });

    QUnit.test('searchRead method', function (assert) {
        assert.expect(1);
        var query = rpc.buildQuery({
            model: 'partner',
            method: 'searchRead',
            domain: ['a', '=', 1],
            fields: ['name'],
            limit: 32,
            offset: 2,
            orderby: [{name: 'yop', asc: true}, {name: 'aa', asc: false}],
        });
        assert.deepEqual(query.params, {
            args: [],
            kwargs: {
                domain: ['a', '=', 1],
                fields: ['name'],
                offset: 2,
                limit: 32,
                order: 'yop ASC, aa DESC'
            },
            method: 'searchRead',
            model: 'partner'
        }, "should have correct kwargs");
    });

    QUnit.test('searchRead with args', function (assert) {
        assert.expect(1);
        var query = rpc.buildQuery({
            model: 'partner',
            method: 'searchRead',
            args: [
                ['a', '=', 1],
                ['name'],
                2,
                32,
                'yop ASC, aa DESC',
            ]
        });
        assert.deepEqual(query.params, {
            args: [['a', '=', 1], ['name'], 2, 32, 'yop ASC, aa DESC'],
            kwargs: {},
            method: 'searchRead',
            model: 'partner'
        }, "should have correct args");
    });

    QUnit.test('readGroup', function (assert) {
        assert.expect(2);

        var query = rpc.buildQuery({
            model: 'partner',
            method: 'readGroup',
            domain: ['a', '=', 1],
            fields: ['name'],
            groupBy: ['productId'],
            context: {abc: 'def'},
            lazy: true,
        });

        assert.deepEqual(query.params, {
            args: [],
            kwargs: {
                context: {abc: 'def'},
                domain: ['a', '=', 1],
                fields: ['name'],
                groupby: ['productId'],
                lazy: true,
            },
            method: 'readGroup',
            model: 'partner',
        }, "should have correct args");
        assert.equal(query.route, '/web/dataset/callKw/partner/readGroup',
            "should call correct route");
    });

    QUnit.test('readGroup with kwargs', function (assert) {
        assert.expect(1);

        var query = rpc.buildQuery({
            model: 'partner',
            method: 'readGroup',
            domain: ['a', '=', 1],
            fields: ['name'],
            groupBy: ['productId'],
            lazy: false,
            kwargs: {context: {abc: 'def'}}
        });

        assert.deepEqual(query.params, {
            args: [],
            kwargs: {
                context: {abc: 'def'},
                domain: ['a', '=', 1],
                fields: ['name'],
                groupby: ['productId'],
                lazy: false,
            },
            method: 'readGroup',
            model: 'partner',
        }, "should have correct args");
    });

    QUnit.test('readGroup with no domain, nor fields', function (assert) {
        assert.expect(7);
        var query = rpc.buildQuery({
            model: 'partner',
            method: 'readGroup',
        });

        assert.deepEqual(query.params.kwargs.domain, [], "should have [] as default domain");
        assert.deepEqual(query.params.kwargs.fields, [], "should have false as default fields");
        assert.deepEqual(query.params.kwargs.groupby, [], "should have false as default groupby");
        assert.deepEqual(query.params.kwargs.offset, undefined, "should not enforce a default value for offst");
        assert.deepEqual(query.params.kwargs.limit, undefined, "should not enforce a default value for limit");
        assert.deepEqual(query.params.kwargs.orderby, undefined, "should not enforce a default value for orderby");
        assert.deepEqual(query.params.kwargs.lazy, undefined, "should not enforce a default value for lazy");
    });

    QUnit.test('readGroup with args and kwargs', function (assert) {
        assert.expect(9);
        var query = rpc.buildQuery({
            model: 'partner',
            method: 'readGroup',
            kwargs: {
                domain: ['name', '=', 'saucisse'],
                fields: ['categoryId'],
                groupby: ['countryId'],
            },
        });

        assert.deepEqual(query.params.kwargs.domain, ['name', '=', 'saucisse'], "should have ['name', '=', 'saucisse'] categoryId as default domain");
        assert.deepEqual(query.params.kwargs.fields, ['categoryId'], "should have categoryId as default fields");
        assert.deepEqual(query.params.kwargs.groupby, ['countryId'], "should have countryId as default groupby");

        var query = rpc.buildQuery({
            model: 'partner',
            method: 'readGroup',
            args: [['name', '=', 'saucisse']],
            kwargs: {
                fields: ['categoryId'],
                groupby: ['countryId'],
            },
        });

        assert.deepEqual(query.params.kwargs.domain, undefined, "should not enforce a default value for domain");
        assert.deepEqual(query.params.kwargs.fields, ['categoryId'], "should have categoryId as default fields");
        assert.deepEqual(query.params.kwargs.groupby, ['countryId'], "should have countryId as default groupby");

        var query = rpc.buildQuery({
            model: 'partner',
            method: 'readGroup',
            args: [['name', '=', 'saucisse'], ['categoryId'], ['countryId']],
        });

        assert.deepEqual(query.params.kwargs.domain, undefined, "should not enforce a default value for domain");
        assert.deepEqual(query.params.kwargs.fields, undefined, "should not enforce a default value for  fields");
        assert.deepEqual(query.params.kwargs.groupby, undefined, "should not enforce a default value for  groupby");
    });

    QUnit.test('searchRead with no domain, nor fields', function (assert) {
        assert.expect(5);
        var query = rpc.buildQuery({
            model: 'partner',
            method: 'searchRead',
        });

        assert.deepEqual(query.params.kwargs.domain, undefined, "should not enforce a default value for domain");
        assert.deepEqual(query.params.kwargs.fields, undefined, "should not enforce a default value for fields");
        assert.deepEqual(query.params.kwargs.offset, undefined, "should not enforce a default value for offset");
        assert.deepEqual(query.params.kwargs.limit, undefined, "should not enforce a default value for limit");
        assert.deepEqual(query.params.kwargs.order, undefined, "should not enforce a default value for orderby");
    });

    QUnit.test('searchRead controller with no domain, nor fields', function (assert) {
        assert.expect(5);
        var query = rpc.buildQuery({
            model: 'partner',
            route: '/web/dataset/searchRead',
        });

        assert.deepEqual(query.params.domain, undefined, "should not enforce a default value for domain");
        assert.deepEqual(query.params.fields, undefined, "should not enforce a default value for fields");
        assert.deepEqual(query.params.offset, undefined, "should not enforce a default value for groupby");
        assert.deepEqual(query.params.limit, undefined, "should not enforce a default value for limit");
        assert.deepEqual(query.params.sort, undefined, "should not enforce a default value for order");
    });
});

});
