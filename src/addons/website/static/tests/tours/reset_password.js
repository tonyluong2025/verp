verp.define('website.tour_reset_password', function (require) {
'use strict';

var tour = require('web_tour.tour');
require('web.domReady');

tour.register('website_reset_password', {
    test: true,
}, [
    {
        content: "fill new password",
        trigger: '.oe-reset-password-form input[name="password"]',
        run: "text adminadmin"
    },
    {
        content: "fill confirm password",
        trigger: '.oe-reset-password-form input[name="confirm_password"]',
        run: "text adminadmin"
    },
    {
        content: "submit reset password form",
        trigger: '.oe-reset-password-form button[type="submit"]',
    },
    {
        content: "check that we're logged in",
        trigger: '.oe-topbar-name:contains("The King")',
        run: function () {}
    },
]);
});
