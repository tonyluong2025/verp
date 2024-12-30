verp.define('point_of_sale.CashMoveButton', function (require) {
    'use strict';

    const PosComponent = require('point_of_sale.PosComponent');
    const Registries = require('point_of_sale.Registries');
    const { _t } = require('web.core');

    const TRANSLATED_CASH_MOVE_TYPE = {
        in: _t('in'),
        out: _t('out'),
    };

    class CashMoveButton extends PosComponent {
        async onClick() {
            const { confirmed, payload } = await this.showPopup('CashMovePopup');
            if (!confirmed) return;
            const { type, amount, reason } = payload;
            const translatedType = TRANSLATED_CASH_MOVE_TYPE[type];
            const formattedAmount = this.env.pos.formatCurrency(amount);
            if (!amount) {
                return this.showNotification(
                    _.str.sprintf(this.env._t('Cash in/out of %s is ignored.'), formattedAmount),
                    3000
                );
            }
            const extras = { formattedAmount, translatedType };
            await this.rpc({
                model: 'pos.session',
                method: 'tryCashInOut',
                args: [[this.env.pos.posSession.id], type, amount, reason, extras],
            });
            if (this.env.pos.proxy.printer) {
                const renderedReceipt = this.env.qweb.renderToString('point_of_sale.CashMoveReceipt', {
                    _receipt: this._getReceiptInfo({ ...payload, translatedType, formattedAmount }),
                });
                const printResult = await this.env.pos.proxy.printer.printReceipt(renderedReceipt);
                if (!printResult.successful) {
                    this.showPopup('ErrorPopup', { title: printResult.message.title, body: printResult.message.body });
                }
            }
            this.showNotification(
                _.str.sprintf(this.env._t('Successfully made a cash %s of %s.'), type, formattedAmount),
                3000
            );
        }
        _getReceiptInfo(payload) {
            const result = { ...payload };
            result.cashier = this.env.pos.getCashier();
            result.company = this.env.pos.company;
            return result;
        }
    }
    CashMoveButton.template = 'point_of_sale.CashMoveButton';

    Registries.Component.add(CashMoveButton);

    return CashMoveButton;
});
