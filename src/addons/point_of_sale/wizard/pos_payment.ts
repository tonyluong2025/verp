import { Fields, _Datetime } from "../../../core";
import { UserError } from "../../../core/helper";
import { MetaModel, TransientModel } from "../../../core/models"
import { bool, floatIsZero } from "../../../core/tools";

@MetaModel.define()
class PosMakePayment extends TransientModel {
    static _module = module;
    static _name = 'pos.make.payment';
    static _description = 'Point of Sale Make Payment Wizard';

    async _defaultConfig() {
        const activeId = this.env.context['activeId'];
        if (bool(activeId)) {
            return (await this.env.items('pos.order').browse(activeId).sessionId).configId;
        }
        return false;
    }

    async _defaultAmount() {
        const activeId = this.env.context['activeId'];
        if (bool(activeId)) {
            const order = this.env.items('pos.order').browse(activeId);
            return await order.amountTotal - await order.amountPaid;
        }
        return false;
    }

    async _defaultPaymentMethod() {
        const activeId = this.env.context['activeId'];
        if (bool(activeId)) {
            const orderId = this.env.items('pos.order').browse(activeId);
            return (await (await (await orderId.sessionId).paymentMethodIds).sorted(pm=> pm.isCashCount, true)).slice(0,1);
        }
        return false;
    }

    static configId = Fields.Many2one('pos.config', {string: 'Point of Sale Configuration', required: true, default: self => self._defaultConfig()});
    static amount = Fields.Float({digits: 0, required: true, default: self => self._defaultAmount()});
    static paymentMethodId = Fields.Many2one('pos.payment.method', {string: 'Payment Method', required: true, default: self => self._defaultPaymentMethod()});
    static paymentName = Fields.Char({string: 'Payment Reference'});
    static paymentDate = Fields.Datetime({string: 'Payment Date', required: true, default: self => _Datetime.now()});

    /**
     * Check the order:
        if the order is not paid: continue payment,
        if the order is paid print ticket.
     * @returns 
     */
    async check() {
        this.ensureOne();

        const order = this.env.items('pos.order').browse(this.env.context['activeId'] ?? false);
        const paymentMethod = await this['paymentMethodId'];
        if (await paymentMethod.splitTransactions && !(await order.partnerId).ok) {
            throw new UserError(await this._t(
                "Customer is required for %s payment method.",
                await paymentMethod.label
            ));
        }

        const currency = await order.currencyId;

        const initData = await this.readOne();
        if (! floatIsZero(initData['amount'], {precisionRounding: await currency.rounding})) {
            await order.addPayment({
                'posOrderId': order.id,
                'amount': await order._getRoundedAmount(initData['amount']),
                'label': initData['paymentName'],
                'paymentMethodId': initData['paymentMethodId'][0],
            });
        }

        if (await order._isPosOrderPaid()) {
            await order.actionPosOrderPaid();
            await order._createOrderPicking();
            await order._computeTotalCostInRealTime();
            return {'type': 'ir.actions.actwindow.close'}
        }
        return this.launchPayment();
    }

    async launchPayment() {
        return {
            'label': await this._t('Payment'),
            'viewMode': 'form',
            'resModel': 'pos.make.payment',
            'viewId': false,
            'target': 'new',
            'views': false,
            'type': 'ir.actions.actwindow',
            'context': this.env.context,
        }
    }
}