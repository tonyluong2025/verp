verp.define('iap/static/tests/helpers/mock_server.js', function (require) {
"use strict";

const MockServer = require('web.MockServer');

MockServer.include({
    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * @override
     */
    async _performRpc(route, args) {
        if (args.model === 'iap.account' && args.method === 'getCreditsUrl') {
            const serviceName = args.args[0] || args.kwargs.serviceName;
            const baseUrl = args.args[1] || args.kwargs.baseUrl;
            const credit = args.args[2] !== undefined ? args.args[2] : args.kwargs.credit;
            const trial = args.args[3] !== undefined ? args.args[3] : args.kwargs.trial;
            return this._mockIapAccountGetCreditsUrl(serviceName, baseUrl, credit, trial);
        }
        return this._super(...arguments);
    },

    //--------------------------------------------------------------------------
    // Private Mocked Routes
    //--------------------------------------------------------------------------

    /**
     * Simulates `get_credits_url` on `iap.account`.
     *
     * @private
     * @param {string} service_name
     * @param {string} [baseUrl='']
     * @param {number} [credit=0]
     * @param {boolean} [trial=false]
     * @returns {string}
     */
    _mockIapAccountGetCreditsUrl(serviceName, baseUrl = '', credit = 0, trial = false) {
        // This mock could be improved, in particular by returning an URL that
        // is actually mocked here and including all params, but it is not done
        // due to URL not being used in any test at the time of this comment.
        return baseUrl + '/random/url?serviceName=' + serviceName;
    },
});

});
