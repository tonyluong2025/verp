verp.define('portal.tour', function (require) {
'use strict';

var tour = require("web_tour.tour");

tour.register('portalLoadHomepage', {
    test: true,
    url: '/my',
},
    [
        {
            content: "Check portal is loaded",
            trigger: 'a[href*="/my/account"]:contains("Edit"):first',
        },
        {
            content: "Load my account details",
            trigger: 'input[value="Joel Willis"]'
        }
    ]
);

});
