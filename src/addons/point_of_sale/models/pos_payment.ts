import { Fields, _Date, _Datetime, api } from "../../../core";
import { ValidationError } from "../../../core/helper";
import { MetaModel, Model } from "../../../core/models"
import { bool, f, floatIsZero, formatLang } from "../../../core/tools";

/**
 * Used to register payments made in a pos.order.

    See `paymentIds` field of pos.order model.
    The main characteristics of pos.payment can be read from
    `paymentMethodId`.
 */
@MetaModel.define()
class PosPayment extends Model {
    static _module = module;
    static _name = "pos.payment";
    static _description = "Point of Sale Payments";
    static _order = "id desc";

    static label = Fields.Char({string: 'Label', readonly: true});
    static posOrderId = Fields.Many2one('pos.order', {string: 'Order', required: true});
    static amount = Fields.Monetary({string: 'Amount', required: true, currencyField: 'currencyId', readonly: true, help: "Total amount of the payment."});
    static paymentMethodId = Fields.Many2one('pos.payment.method', {string: 'Payment Method', required: true});
    static paymentDate = Fields.Datetime({string: 'Date', required: true, readonly: true, default: () => _Datetime.now()});
    static currencyId = Fields.Many2one('res.currency', {string: 'Currency', related: 'posOrderId.currencyId'});
    static currencyRate = Fields.Float({string: 'Conversion Rate', related: 'posOrderId.currencyRate', help: 'Conversion rate from company currency to order currency.'});
    static partnerId = Fields.Many2one('res.partner', {string: 'Customer', related: 'posOrderId.partnerId'});
    static sessionId = Fields.Many2one('pos.session', {string: 'Session', related: 'posOrderId.sessionId', store: true, index: true});
    static companyId = Fields.Many2one('res.company', {string: 'Company', related: 'posOrderId.companyId', store: true})
    static cardType = Fields.Char('Type of card used');
    static cardholderName = Fields.Char('Cardholder Name');
    static transactionId = Fields.Char('Payment Transaction ID');
    static paymentStatus = Fields.Char('Payment Status');
    static ticket = Fields.Char('Payment Receipt Info');
    static isChange = Fields.Boolean({string: 'Is this payment change?', default: false});
    static accountMoveId = Fields.Many2one('account.move');

    async nameGet() {
        const res = [];
        for (const payment of this) {
            if (await payment.label) {
                res.push([payment.id, f('%s %s', await payment.label, await formatLang(this.env, await payment.amount, {currencyObj: await payment.currencyId}))]);
            }
            else {
                res.push([payment.id, await formatLang(this.env, await payment.amount, {currencyObj: await payment.currencyId})]);
            }
        }
        return res;
    }

    @api.constrains('paymentMethodId')
    async _checkPaymentMethodId() {
        for (const payment of this) {
            if (!(await (await (await payment.sessionId).configId).paymentMethodIds).has(await payment.paymentMethodId)) {
                throw new ValidationError(await this._t('The payment method selected is not allowed in the config of the POS session.'));
            }
        }
    }

    async _exportForUi(payment) {
        return {
            'paymentMethodId': (await payment.paymentMethodId).id,
            'amount': await payment.amount,
            'paymentStatus': await payment.paymentStatus,
            'cardType': await payment.cardType,
            'cardholderName': await payment.cardholderName,
            'transactionId': await payment.transactionId,
            'ticket': await payment.ticket,
            'isChange': await payment.isChange,
        }
    }

    async exportForUi() {
        return this.ok ? this.mapped(order => this._exportForUi(order)) : [];
    }

    async _createPaymentMoves() {
        let result = this.env.items('account.move');
        for (const payment of this) {
            let [order, paymentMethod, amount, partner] = await payment('posOrderId', 'paymentMethodId', 'amount', 'partnerId');
            if (await paymentMethod.type === 'payLater' || floatIsZero(amount, {precisionRounding: await (await order.currencyId).rounding})) {
                continue;
            }
            const accountingPartner = await this.env.items("res.partner")._findAccountingPartner(partner);
            let posSession = await order.sessionId;
            const journal = await (await posSession.configId).journalId;
            const paymentMove = await (await this.env.items('account.move').withContext({default_journalId: journal.id})).create({
                'journalId': journal.id,
                'date': await _Date.contextToday(payment),
                'ref': await this._t('Invoice payment for %s (%s) using %s', await order.label, await (await order.accountMove).label, await paymentMethod.label),
                'posPaymentIds': payment.ids,
            });
            result = result.or(paymentMove);
            await payment.write({'accountMoveId': paymentMove.id});
            const amounts = await posSession._updateAmounts({'amount': 0, 'amountConverted': 0}, {'amount': await payment.amount}, await payment.paymentDate);
            const creditLineVals = await posSession._creditAmounts({
                'accountId': (await accountingPartner.propertyAccountReceivableId).id,
                'partnerId': accountingPartner.id,
                'moveId': paymentMove.id,
            }, amounts['amount'], amounts['amountConverted']);
            const debitLineVals = await posSession._debitAmounts({
                'accountId': (await (await posSession.companyId).accountDefaultPosReceivableAccountId).id,
                'moveId': paymentMove.id,
            }, amounts['amount'], amounts['amountConverted']);
            await (await this.env.items('account.move.line').withContext({checkMoveValidity: false})).create([creditLineVals, debitLineVals]);
            await paymentMove._post();
        }
        return result;
    }
}
