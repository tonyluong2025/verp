import { api, Fields } from "../../../core";
import { UserError } from "../../../core/helper";
import { MetaModel, TransientModel } from "../../../core/models";
import { bool, f, len, parseInt, toFormat } from "../../../core/tools";

@MetaModel.define()
class SaleAdvancePaymentInv extends TransientModel {
    static _module = module;
    static _name = "sale.advance.payment.inv";
    static _description = "Sales Advance Payment Invoice";

    @api.model()
    async _count() {
        return len(this._context['activeIds'] ?? []);
    }

    @api.model()
    async _defaultProductId() {
        const productId = await (await this.env.items('ir.config.parameter').sudo()).getParam('sale.defaultDepositProductId');
        return this.env.items('product.product').browse(parseInt(productId)).exists();
    }

    @api.model()
    async _defaultDepositAccountId() {
        return (await (await this._defaultProductId())._getProductAccounts())['income'];
    }

    @api.model()
    async _defaultDepositTaxesId() {
        return (await this._defaultProductId()).taxesId;
    }

    @api.model()
    async _defaultHasDownPayment() {
        if (this._context['activeModel'] === 'sale.order' && (this._context['activeId'] ?? false)) {
            const saleOrder = this.env.items('sale.order').browse(this._context['activeId']);
            return (await saleOrder.orderLine).filtered(
                line => line.isDownpayment
            );
        }

        return false;
    }

    @api.model()
    async _defaultCurrencyId() {
        if (this._context['activeModel'] === 'sale.order' && (this._context['activeId'] ?? false)) {
            const saleOrder = this.env.items('sale.order').browse(this._context['activeId']);
            return saleOrder.currencyId;
        }
    }

    static advancePaymentMethod = Fields.Selection([
        ['delivered', 'Regular invoice'],
        ['percentage', 'Down payment (percentage)'],
        ['fixed', 'Down payment (fixed amount)']
    ], {
        string: 'Create Invoice', default: 'delivered', required: true,
        help: "A standard invoice is issued with all the order lines ready for invoicing," +
            "according to their invoicing policy (based on ordered or delivered quantity)."
    });
    static deductDownPayments = Fields.Boolean('Deduct down payments', { default: true });
    static hasDownPayments = Fields.Boolean('Has down payments', { default: self => self._defaultHasDownPayment(), readonly: true });
    static productId = Fields.Many2one('product.product', { string: 'Down Payment Product', domain: [['type', '=', 'service']], default: self => self._defaultProductId() });
    static count = Fields.Integer({ default: self => self._count(), string: 'Order Count' });
    static amount = Fields.Float('Down Payment Amount', { digits: 'Account', help: "The percentage of amount to be invoiced in advance, taxes excluded." });
    static currencyId = Fields.Many2one('res.currency', { string: 'Currency', default: self => self._defaultCurrencyId() });
    static fixedAmount = Fields.Monetary('Down Payment Amount (Fixed)', { help: "The fixed amount to be invoiced in advance, taxes excluded." });
    static depositAccountId = Fields.Many2one("account.account", { string: "Income Account", domain: [['deprecated', '=', false]], help: "Account used for deposits", default: self => self._defaultDepositAccountId() });
    static depositTaxesId = Fields.Many2many("account.tax", { string: "Customer Taxes", help: "Taxes used for deposits", default: self => self._defaultDepositTaxesId() });

    @api.onchange('advancePaymentMethod')
    async onchangeAdvancePaymentMethod() {
        if (await this['advancePaymentMethod'] === 'percentage') {
            const amount = (await this.defaultGet(['amount']))['amount'];
            return { 'value': { 'amount': amount } }
        }
        return {}
    }

    async _prepareInvoiceValues(order, label, amount, soLine) {
        const invoiceVals = {
            'ref': await order.clientOrderRef,
            'moveType': 'outInvoice',
            'invoiceOrigin': await order.label,
            'invoiceUserId': (await order.userId).id,
            'narration': await order.note,
            'partnerId': (await order.partnerInvoiceId).id,
            'fiscalPositionId': (await order.fiscalPositionId).ok ? (await order.fiscalPositionId).id : (await (await order.fiscalPositionId).getFiscalPosition((await order.partnerId).id)).id,
            'partnerShippingId': (await order.partnerShippingId).id,
            'currencyId': (await (await order.pricelistId).currencyId).id,
            'paymentReference': await order.reference,
            'invoicePaymentTermId': (await order.paymentTermId).id,
            'partnerBankId': (await (await (await order.companyId).partnerId).bankIds).slice(0, 1).id,
            'teamId': (await order.teamId).id,
            'campaignId': (await order.campaignId).id,
            'mediumId': (await order.mediumId).id,
            'sourceId': (await order.sourceId).id,
            'invoiceLineIds': [[0, 0, {
                'label': label,
                'priceUnit': amount,
                'quantity': 1.0,
                'productId': (await this['productId']).id,
                'productUomId': (await soLine.productUom).id,
                'taxIds': [[6, 0, (await soLine.taxId).ids]],
                'saleLineIds': [[6, 0, [soLine.id]]],
                'analyticTagIds': [[6, 0, (await soLine.analyticTagIds).ids]],
                'analyticAccountId': !await soLine.displayType && bool((await order.analyticAccountId).id) ? (await order.analyticAccountId).id : false,
            }]],
        }

        return invoiceVals;
    }

    async _getAdvanceDetails(order) {
        let label, amount;
        let context = { 'lang': await (await order.partnerId).lang }
        if (await this['advancePaymentMethod'] === 'percentage') {
            const advanceProductTaxes = await (await (await this['productId']).taxesId).filtered(async (tax) => (await tax.companyId).eq(await order.companyId));
            if ((await (await (await order.fiscalPositionId).mapTax(advanceProductTaxes)).mapped('priceInclude').every(i => i))) {
                amount = await order.amountTotal * await this['amount'] / 100;
            }
            else {
                amount = await order.amountUntaxed * await this['amount'] / 100;
            }
            label = f(await this._t("Down payment of %s%", await this['amount']));
        }
        else {
            amount = await this['fixedAmount'];
            label = await this._t('Down Payment');
        }
        context = null;

        return [amount, label];
    }

    async _createInvoice(order, soLine, amount) {
        if ((await this['advancePaymentMethod'] === 'percentage' && await this['amount'] <= 0.00) || (await this['advancePaymentMethod'] == 'fixed' && await this['fixedAmount'] <= 0.00)) {
            throw new UserError(await this._t('The value of the down payment amount must be positive.'));
        }
        let label;
        [amount, label] = await this._getAdvanceDetails(order);

        const invoiceVals = await this._prepareInvoiceValues(order, label, amount, soLine);

        if (bool(await order.fiscalPositionId)) {
            invoiceVals['fiscalPositionId'] = (await order.fiscalPositionId).id
        }

        const invoice = await (await (await (await this.env.items('account.move').withCompany(await order.companyId))
            .sudo()).create(invoiceVals)).withUser(this.env.uid);
        await invoice.messagePostWithView('mail.messageOriginLink',
            {
                values: { 'self': invoice, 'origin': order },
                subtypeId: (await this.env.ref('mail.mtNote')).id
            });
        return invoice;
    }

    async _prepareSoLine(order, analyticTagIds, taxIds, amount) {
        let context = { 'lang': await (await order.partnerId).lang }
        const soValues = {
            'label': f(await this._t('Down Payment: %s'), toFormat(new Date(), 'MM yyyy'),),
            'priceUnit': amount,
            'productUomQty': 0.0,
            'orderId': order.id,
            'discount': 0.0,
            'productUom': (await (await this['productId']).uomId).id,
            'productId': (await this['productId']).id,
            'analyticTagIds': analyticTagIds,
            'taxId': [[6, 0, taxIds]],
            'isDownpayment': true,
            'sequence': bool(await order.orderLine) && await (await order.orderLine)[-1].sequence + 1 || 10,
        }
        context = undefined;
        return soValues;
    }

    async createInvoices() {
        const saleOrders = this.env.items('sale.order').browse(this._context['activeIds'] ?? []);

        if (await this['advancePaymentMethod'] === 'delivered') {
            await saleOrders._createInvoices(false, await this['deductDownPayments']);
        }
        else {
            // Create deposit product if necessary
            if (!(await this['productId']).ok) {
                const vals = this._prepareDepositProduct();
                await this.set('productId', this.env.items('product.product').create(vals));
                await (await this.env.items('ir.config.parameter').sudo()).setParam('sale.defaultDepositProductId', (await this['productId']).id);
            }
            const product = await this['productId'];
            const saleLineObj = this.env.items('sale.order.line');
            for (const order of saleOrders) {
                const [amount, label] = await this._getAdvanceDetails(order);

                if (await product.invoicePolicy !== 'order') {
                    throw new UserError(await this._t('The product used to invoice a down payment should have an invoice policy set to "Ordered quantities". Please update your deposit product to be able to create a deposit invoice.'));
                }
                if (await product.type !== 'service') {
                    throw new UserError(await this._t("The product used to invoice a down payment should be of type 'Service'. Please use another product or update this product."));
                }
                const taxes = await (await product.taxesId).filtered(async (r) => !(await order.companyId).ok || (await r.companyId).eq(await order.companyId));
                const taxIds = (await (await order.fiscalPositionId).mapTax(taxes)).ids;
                let analyticTagIds = [];
                for (const line of await order.orderLine) {
                    analyticTagIds = (await line.analyticTagIds).map(analyticTag => [4, analyticTag.id, null]);
                }
                const soLineValues = await this._prepareSoLine(order, analyticTagIds, taxIds, amount);
                const soLine = await saleLineObj.create(soLineValues);
                await this._createInvoice(order, soLine, amount);
            }
        }
        if (this._context['openInvoices'] ?? false) {
            return saleOrders.actionViewInvoice();
        }
        return { 'type': 'ir.actions.actwindow.close' }
    }

    async _prepareDepositProduct() {
        return {
            'label': await this._t('Down payment'),
            'type': 'service',
            'invoicePolicy': 'order',
            'propertyAccountIncomeId': (await this['depositAccountId']).id,
            'taxesId': [[6, 0, (await this['depositTaxesId']).ids]],
            'companyId': false,
        }
    }
}