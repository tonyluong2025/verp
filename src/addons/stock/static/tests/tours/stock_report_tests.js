verp.define('stock.reports.setup.tour', function (require) {
    "use strict";

    const tour = require('web_tour.tour');

    tour.register('test_stock_route_diagram_report', {
        test: true,
    }, [
    {
        trigger: '.o-kanban-record',
        extraTrigger:'.breadcrumb',
    },
    {
        trigger: '.nav-item > a:contains("Inventory")',
    },
    {
        trigger: '.btn[id="stock.view_diagram_button"]',
    },
    {
        trigger: 'iframe .o-report-stock-rule',
    },
    ]);
});
