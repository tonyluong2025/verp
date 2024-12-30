verp.define('web.ReportService', function (require) {
"use strict";

/**
 * This file defines the service for the report generation in Verp.
 */

var AbstractService = require('web.AbstractService');
var core = require('web.core');

var ReportService = AbstractService.extend({
    dependencies: ['ajax'],

    /**
     * Checks the state of the installation of htmltoPdf on the server.
     * Implements an internal cache to do the request only once.
     *
     * @returns {Promise} resolved with the state of htmltoPdf on the server
     *   (possible values are 'ok', 'broken', 'install', 'upgrade', 'workers').
     */
    checkHtmltoPdf: function () {
        if (!this.htmltoPdfState) {
            this.htmltoPdfState = this._rpc({
                route:'/report/checkHtmltoPdf'
            });
        }
        return this.htmltoPdfState;
    },
});

core.serviceRegistry.add('report', ReportService);

return ReportService;

});
