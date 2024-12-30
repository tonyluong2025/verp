verp.define('point_of_sale.SaleDetailsButton', function(require) {
    'use strict';

    const PosComponent = require('point_of_sale.PosComponent');
    const Registries = require('point_of_sale.Registries');

    class SaleDetailsButton extends PosComponent {
        async onClick() {
            // IMPROVEMENT: Perhaps put this logic in a parent component
            // so that for unit testing, we can check if this simple
            // component correctly triggers an event.
            const saleDetails = await this.rpc({
                model: 'pos.report.saledetails',
                method: 'getSaleDetails',
                args: [false, false, false, [this.env.pos.posSession.id]],
            });
            const report = this.env.qweb.renderToString(
                'SaleDetailsReport',
                Object.assign({}, saleDetails, {
                    date: new Date().toLocaleString(),
                    pos: this.env.pos,
                })
            );
            const printResult = await this.env.pos.proxy.printer.printReceipt(report);
            if (!printResult.successful) {
                await this.showPopup('ErrorPopup', {
                    title: printResult.message.title,
                    body: printResult.message.body,
                });
            }
        }
    }
    SaleDetailsButton.template = 'SaleDetailsButton';

    Registries.Component.add(SaleDetailsButton);

    return SaleDetailsButton;
});
