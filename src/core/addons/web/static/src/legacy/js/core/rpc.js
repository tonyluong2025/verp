verp.define('web.rpc', function (require) {
"use strict";

var ajax = require('web.ajax');

const rpc = {
    /**
     * Perform a RPC.  Please note that this is not the preferred way to do a
     * rpc if you are in the context of a widget.  In that case, you should use
     * the this._rpc method.
     *
     * @param {Object} params @see buildQuery for a description
     * @param {Object} options
     * @returns {Promise<any>}
     */
    query: function (params, options) {
        var query = rpc.buildQuery(params);
        return ajax.rpc(query.route, query.params, options);
    },
    /**
     * @param {Object} options
     * @param {any[]} [options.args]
     * @param {Object} [options.context]
     * @param {any[]} [options.domain]
     * @param {string[]} [options.fields]
     * @param {string[]} [options.groupby]
     * @param {Object} [options.kwargs]
     * @param {integer|false} [options.limit]
     * @param {string} [options.method]
     * @param {string} [options.model]
     * @param {integer} [options.offset]
     * @param {string[]} [options.orderby]
     * @param {Object} [options.params]
     * @param {string} [options.route]
     * @returns {Object} with 2 keys: route and params
     */
    buildQuery: function (options) {
        var route;
        var params = options.params || {};
        var orderby;
        if (options.route) {
            route = options.route;
        } else if (options.model && options.method) {
            route = '/web/dataset/callKw/' + options.model + '/' + options.method;
        }
        if (options.method) {
            params.args = options.args || [];
            params.model = options.model;
            params.method = options.method;
            params.kwargs = _.extend(params.kwargs || {}, options.kwargs);
            params.kwargs.context = options.context || params.context || params.kwargs.context;
        }

        if (options.method === 'readGroup' || options.method === 'webReadGroup') {
            if (!(params.args && params.args[0] !== undefined)) {
                params.kwargs.domain = options.domain || params.domain || params.kwargs.domain || [];
            }
            if (!(params.args && params.args[1] !== undefined)) {
                params.kwargs.fields = options.fields || params.fields || params.kwargs.fields || [];
            }
            if (!(params.args && params.args[2] !== undefined)) {
                params.kwargs.groupby = options.groupby || params.groupby || params.kwargs.groupby || [];
            }
            params.kwargs.offset = options.offset || params.offset || params.kwargs.offset;
            params.kwargs.limit = options.limit || params.limit || params.kwargs.limit;
            // In kwargs, we look for "orderby" rather than "orderby" (note the absence of capital B),
            // since the Javascript argument to the actual function is "orderby".
            orderby = options.orderby || params.orderby || params.kwargs.orderby;
            params.kwargs.orderby = orderby ? rpc._serializeSort(orderby) : orderby;
            params.kwargs.lazy = 'lazy' in options ? options.lazy : params.lazy;

            if (options.method === 'webReadGroup') {
                params.kwargs.expand = options.expand || params.expand || params.kwargs.expand;
                params.kwargs.expandLimit = options.expandLimit || params.expandLimit || params.kwargs.expandLimit;
                var expandOrderBy = options.expandOrderby || params.expandOrderby || params.kwargs.expandOrderby;
                params.kwargs.expandOrderby = expandOrderBy ? rpc._serializeSort(expandOrderBy) : expandOrderBy;
            }
        }

        if (options.method === 'searchRead') {
            // call the model method
            params.kwargs.domain = options.domain || params.domain || params.kwargs.domain;
            params.kwargs.fields = options.fields || params.fields || params.kwargs.fields;
            params.kwargs.offset = options.offset || params.offset || params.kwargs.offset;
            params.kwargs.limit = options.limit || params.limit || params.kwargs.limit;
            // In kwargs, we look for "order" rather than "orderby" since the Javascript
            // argument to the actual function is "order".
            orderby = options.orderby || params.orderby || params.kwargs.order;
            params.kwargs.order = orderby ? rpc._serializeSort(orderby) : orderby;
        }

        if (options.route === '/web/dataset/searchRead') {
            // specifically call the controller
            params.model = options.model || params.model;
            params.domain = options.domain || params.domain;
            params.fields = options.fields || params.fields;
            params.limit = options.limit || params.limit;
            params.offset = options.offset || params.offset;
            orderby = options.orderby || params.orderby;
            params.sort = orderby ? rpc._serializeSort(orderby) : orderby;
            params.context = options.context || params.context || {};
        }

        return {
            route: route,
            params: JSON.parse(JSON.stringify(params)),
        };
    },
    /**
     * Helper method, generates a string to describe a ordered by sequence for
     * SQL.
     *
     * For example, [{name: 'foo'}, {name: 'bar', asc: false}] will
     * be converted into 'foo ASC, bar DESC'
     *
     * @param {Object[]} orderby list of objects {name:..., [asc: ...]}
     * @returns {string}
     */
    _serializeSort: function (orderby) {
        return _.map(orderby, function (order) {
            return order.name + (order.asc !== false ? ' ASC' : ' DESC');
        }).join(', ');
    },
};

return rpc;

});
