verp.define('point_of_sale.tour', function(require) {
"use strict";

const {_t} = require('web.core');
const {Markup} = require('web.utils');
var tour = require('web_tour.tour');

tour.register('pointOfSaleTour', {
    url: "/web",
    rainbowMan: false,
    sequence: 45,
}, [tour.stepUtils.showAppsMenuItem(), {
    trigger: '.o-app[data-menu-xmlid="point_of_sale.menuPointRoot"]',
    content: Markup(_t("Ready to launch your <b>point of sale</b>?")),
    width: 215,
    position: 'right',
    edition: 'community'
}, {
    trigger: '.o-app[data-menu-xmlid="point_of_sale.menuPointRoot"]',
    content: Markup(_t("Ready to launch your <b>point of sale</b>?")),
    width: 215,
    position: 'bottom',
    edition: 'enterprise'
}, {
    trigger: ".o-pos-kanban button.oe-kanban-action-button",
    content: Markup(_t("<p>Ready to have a look at the <b>POS Interface</b>? Let's start our first session.</p>")),
    position: "bottom"
}]);

});
