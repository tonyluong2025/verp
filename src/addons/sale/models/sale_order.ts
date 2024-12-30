import _ from "lodash";
import { _Date, _Datetime, api, Field, Fields } from "../../../core";
import { setdefault } from "../../../core/api";
import { AccessError, UserError, ValidationError } from "../../../core/helper";
import { _super, MetaModel, Model } from "../../../core/models";
import { expression } from "../../../core/osv";
import { _f, addDate, bool, dateMin, extend, f, floatIsZero, groupby, htmlKeepUrl, isHtmlEmpty, isInstance, len, parseInt, pop, sorted, update } from "../../../core/tools";
import { stringify } from "../../../core/tools/json";
import { checkRightsOnRecordset } from "../../payment";

@MetaModel.define()
class SaleOrder extends Model {
    static _module = module;
    static _name = "sale.order";
    static _parents = ['portal.mixin', 'mail.thread', 'mail.activity.mixin', 'utm.mixin'];
    static _description = "Sales Order";
    static _order = 'dateOrder desc, id desc';
    static _checkCompanyAuto = true;

    async _defaultValidityDate() {
        if (await (await this.env.items('ir.config.parameter').sudo()).getParam('sale.useQuotationValidityDays')) {
            const days = await (await this.env.company()).quotationValidityDays;
            if (days > 0) {
                return _Date.toString(addDate(new Date(), {days}));
            }
        }
        return false;
    }

    async _getDefaultRequireSignature() {
        return (await this.env.company()).portalConfirmationSign;
    }

    async _getDefaultRequirePayment() {
        return (await this.env.company()).portalConfirmationPay;
    }

    async _computeAmountTotalWithoutDelivery() {
        this.ensureOne();
        return this['amountTotal'];
    }

    /**
     * Compute the total amounts of the SO.
     */
    @api.depends('orderLine.priceTotal')
    async _amountAll() {
        for (const order of this) {
            let amountUntaxed = 0.0,
            amountTax = 0.0;
            for (const line of await order.orderLine) {
                amountUntaxed += await line.priceSubtotal;
                amountTax += await line.priceTax;
            }
            await order.update({
                'amountUntaxed': amountUntaxed,
                'amountTax': amountTax,
                'amountTotal': amountUntaxed + amountTax,
            });
        }
    }

    @api.depends('orderLine.invoiceLines')
    async _getInvoiced() {
        // The invoiceIds are obtained thanks to the invoice lines of the SO
        // lines, and we also search for possible refunds created directly from
        // existing invoices. This is necessary since such a refund is not
        // directly linked to the SO.
        for (const order of this) {
            const invoices = await (await (await (await order.orderLine).invoiceLines).moveId).filtered(async (r) => ['outInvoice', 'outRefund'].includes(await r.moveType));
            await order.set('invoiceIds', invoices);
            await order.set('invoiceCount', len(invoices));
        }
    }

    /**
     * Compute the invoice status of a SO. Possible statuses:
        - no: if the SO is not in status 'sale' or 'done', we consider that there is nothing to
          invoice. This is also the default value if the conditions of no other status is met.
        - to invoice: if any SO line is 'to invoice', the whole SO is 'to invoice'
        - invoiced: if all SO lines are invoiced, the SO is invoiced.
        - upselling: if all SO lines are invoiced or upselling, the status is upselling.
     * @returns 
     */
    @api.depends('state', 'orderLine.invoiceStatus')
    async _getInvoiceStatus() {
        const unconfirmedOrders = await this.filtered(async (so) => !['sale', 'done'].includes(await so.state));
        await unconfirmedOrders.set('invoiceStatus', 'no');
        const confirmedOrders = this.sub(unconfirmedOrders);
        if (confirmedOrders.nok) {
            return;
        }
        const lineInvoiceStatusAll = [];
        for (const d of await this.env.items('sale.order.line').readGroup([
                ['orderId', 'in', confirmedOrders.ids],
                ['isDownpayment', '=', false],
                ['displayType', '=', false],
            ],
            ['orderId', 'invoiceStatus'],
            ['orderId', 'invoiceStatus'], {lazy: false})) {
                lineInvoiceStatusAll.push([d['orderId'][0], d['invoiceStatus']]);
        }
        for (const order of confirmedOrders) {
            const lineInvoiceStatus = lineInvoiceStatusAll.filter(d => d[0] == order.id).map(d => d[1]);
            if (!['sale', 'done'].includes(await order.state)) {
                await order.set('invoiceStatus', 'no');
            }
            else if (lineInvoiceStatus.some(invoiceStatus => invoiceStatus == 'to invoice')) {
                await order.set('invoiceStatus', 'to invoice');
            }
            else if (lineInvoiceStatus.length && lineInvoiceStatus.every(invoiceStatus => invoiceStatus === 'invoiced')) {
                await order.set('invoiceStatus', 'invoiced');
            }
            else if (lineInvoiceStatus.length && lineInvoiceStatus.every(invoiceStatus => ['invoiced', 'upselling'].includes(invoiceStatus))) {
                await order.set('invoiceStatus', 'upselling');
            }
            else {
                await order.set('invoiceStatus', 'no');
            }
        }
    }

    @api.model()
    async getEmptyListHelp(help) {
        const self = await this.withContext({
            emptyListHelpDocumentName: await this._t("sale order"),
        });
        return _super(SaleOrder, self).getEmptyListHelp(help);
    }

    @api.model()
    async _defaultNoteUrl() {
        return (await this.env.company()).getBaseUrl();
    }

    @api.model()
    async _defaultNote() {
        const useInvoiceTerms = await (await this.env.items('ir.config.parameter').sudo()).getParam('account.useInvoiceTerms');
        if (useInvoiceTerms && await (await this.env.company()).termsType === "html") {
            const baseurl = htmlKeepUrl(await this._defaultNoteUrl() + '/terms');
            let context = {'lang': await (await this['partnerId']).lang || (await this.env.user()).lang}
            const note = await this._t('Terms & Conditions: %s', baseurl);
            context = null;
            return note;
        }
        return useInvoiceTerms && (await this.env.company()).invoiceTerms || '';
    }

    @api.model()
    async _getDefaultTeam() {
        return this.env.items('crm.team')._getDefaultTeamId();
    }

    /**
     * Trigger the recompute of the taxes if the fiscal position is changed on the SO.
     * @returns 
     */
    @api.onchange('fiscalPositionId', 'companyId')
    async _computeTaxId() {
        for (const order of this) {
            await (await order.orderLine)._computeTaxId();
        }
    }

    async _searchInvoiceIds(operator, value) {
        if (operator === 'in' && bool(value)) {
            const res = await this.env.cr.execute(`
                SELECT array_agg(so.id) AS ids
                    FROM "saleOrder" so
                    JOIN "saleOrderLine" sol ON sol."orderId" = so.id
                    JOIN "saleOrderLineInvoiceRel" "soliRel" ON "soliRel"."orderLineId" = sol.id
                    JOIN "accountMoveLine" aml ON aml.id = "soliRel"."invoiceLineId"
                    JOIN "accountMove" am ON am.id = aml."moveId"
                WHERE
                    am."moveType" in ('outInvoice', 'outRefund') AND
                    am.id IN (%s)
            `, [String(value) || 'NULL']);
            const soIds = res[0]['ids'] || [];
            return [['id', 'in', soIds]];
        }
        else if (operator === '=' && !bool(value)) {
            // special case for [('invoiceIds', '=', False)], i.e. "Invoices is not set"
            // We cannot just search [('orderLine.invoice_lines', '=', False)]
            // because it returns orders with uninvoiced lines, which is not
            // same "Invoices is not set" (some lines may have invoices and some
            // doesn't)
            // A solution is making inverted search first ("orders with invoiced
            // lines") and then invert results ("get all other orders")
            // Domain below returns subset of ('orderLine.invoice_lines', '!=', False)
            const orderIds = await this._search([
                ['orderLine.invoiceLines.moveId.moveType', 'in', ['outInvoice', 'outRefund']]
            ]);
            return [['id', 'not in', orderIds]];
        }
        return ['&', ['orderLine.invoiceLines.moveId.moveType', 'in', ['outInvoice', 'outRefund']], ['orderLine.invoiceLines.moveId', operator, value]];
    }

    static label = Fields.Char({string: 'Order Reference', required: true, copy: false, readonly: true, states: {'draft': [['readonly', false]]}, index: true, default: (self) => self._t('New')});
    static origin = Fields.Char({string: 'Source Document', help: "Reference of the document that generated this sales order request."});
    static clientOrderRef = Fields.Char({string: 'Customer Reference', copy: false});
    static reference = Fields.Char({string: 'Payment Ref.', copy: false,
        help: 'The payment communication of this sale order.'});
    static state = Fields.Selection([
        ['draft', 'Quotation'],
        ['sent', 'Quotation Sent'],
        ['sale', 'Sales Order'],
        ['done', 'Locked'],
        ['cancel', 'Cancelled'],
        ], {string: 'Status', readonly: true, copy: false, index: true, tracking: 3, default: 'draft'});
    static dateOrder = Fields.Datetime({string: 'Order Date', required: true, readonly: true, index: true, states: {'draft': [['readonly', false]], 'sent': [['readonly', false]]}, copy: false, default: () => _Datetime.now(), help: "Creation date of draft/sent orders,\nConfirmation date of confirmed orders."});
    static validityDate = Fields.Date({string: 'Expiration', readonly: true, copy: false, states: {'draft': [['readonly', false]], 'sent': [['readonly', false]]}, default: self => self._defaultValidityDate()});
    static isExpired = Fields.Boolean({compute: '_computeIsExpired', string: "Is expired"});
    static requireSignature = Fields.Boolean('Online Signature', {default: self => self._getDefaultRequireSignature(), readonly: true, states: {'draft': [['readonly', false]], 'sent': [['readonly', false]]},
        help: 'Request a online signature to the customer in order to confirm orders automatically.'});
    static requirePayment = Fields.Boolean('Online Payment', {default: self => self._getDefaultRequirePayment(), readonly: true,
        states: {'draft': [['readonly', false]], 'sent': [['readonly', false]]},
        help: 'Request an online payment to the customer in order to confirm orders automatically.'});
    static createdAt = Fields.Datetime({string: 'Creation Date', readonly: true, index: true, help: "Date on which sales order is created."});

    static userId = Fields.Many2one(
        'res.users', {string: 'Salesperson', index: true, tracking: 2, default: self => self.env.user(),
        domain: async (self) => f("[['groupsId', '=', %s], ['share', '=', false], ['companyIds', '=', companyId]]",
            (await self.env.ref("sales_team.groupSaleSalesman")).id
        )});
    static partnerId = Fields.Many2one(
        'res.partner', {string: 'Customer', readonly: true,
        states: {'draft': [['readonly', false]], 'sent': [['readonly', false]]},
        required: true, changeDefault: true, index: true, tracking: 1,
        domain: "[['type', '!=', 'private'], ['companyId', 'in', [false, companyId]]]"});
    static partnerInvoiceId = Fields.Many2one(
        'res.partner', {string: 'Invoice Address',
        readonly: true, required: true,
        states: {'draft': [['readonly', false]], 'sent': [['readonly', false]], 'sale': [['readonly', false]]},
        domain: "['|', ['companyId', '=', false], ['companyId', '=', companyId]]"});
    static partnerShippingId = Fields.Many2one(
        'res.partner', {string: 'Delivery Address', readonly: true, required: true,
        states: {'draft': [['readonly', false]], 'sent': [['readonly', false]], 'sale': [['readonly', false]]},
        domain: "['|', ['companyId', '=', false], ['companyId', '=', companyId]]"});

    static pricelistId = Fields.Many2one(
        'product.pricelist', {string: 'Pricelist', checkCompany: true,  // Unrequired company
        required: true, readonly: true, states: {'draft': [['readonly', false]], 'sent': [['readonly', false]]},
        domain: "['|', ['companyId', '=', false], ['companyId', '=', companyId]]", tracking: 1,
        help: "If you change the pricelist, only newly added lines will be affected."});
    static currencyId = Fields.Many2one({related: 'pricelistId.currencyId', depends: ["pricelistId"], store: true, ondelete: "RESTRICT"});
    static analyticAccountId = Fields.Many2one(
        'account.analytic.account', {string: 'Analytic Account',
        compute: '_computeAnalyticAccountId', store: true,
        readonly: false, copy: false, checkCompany: true,  // Unrequired company
        states: {'sale': [['readonly', true]], 'done': [['readonly', true]], 'cancel': [['readonly', true]]},
        domain: "['|', ['companyId', '=', false], ['companyId', '=', companyId]]",
        help: "The analytic account related to a sales order."});

    static orderLine = Fields.One2many('sale.order.line', 'orderId', {string: 'Order Lines', states: {'cancel': [['readonly', true]], 'done': [['readonly', true]]}, copy: true, autojoin: true});

    static invoiceCount = Fields.Integer({string: 'Invoice Count', compute: '_getInvoiced'});
    static invoiceIds = Fields.Many2many("account.move", {string: 'Invoices', compute: "_getInvoiced", copy: false, search: "_searchInvoiceIds"});
    static invoiceStatus = Fields.Selection([
        ['upselling', 'Upselling Opportunity'],
        ['invoiced', 'Fully Invoiced'],
        ['to invoice', 'To Invoice'],
        ['no', 'Nothing to Invoice']
        ], {string: 'Invoice Status', compute: '_getInvoiceStatus', store: true});

    static note = Fields.Html('Terms and conditions', {default: self => self._defaultNote()});
    static termsType = Fields.Selection({related: 'companyId.termsType'});

    static amountUntaxed = Fields.Monetary({string: 'Untaxed Amount', store: true, compute: '_amountAll', tracking: 5});
    static taxTotalsJson = Fields.Char({compute: '_computeTaxTotalsJson'});
    static amountTax = Fields.Monetary({string: 'Taxes', store: true, compute: '_amountAll'});
    static amountTotal = Fields.Monetary({string: 'Total', store: true, compute: '_amountAll', tracking: 4});
    static currencyRate = Fields.Float("Currency Rate", {compute: '_computeCurrencyRate', store: true, digits: [12, 6], help: 'The rate of the currency to the currency of rate 1 applicable at the date of the order'});

    static paymentTermId = Fields.Many2one(
        'account.payment.term', {string: 'Payment Terms', checkCompany: true,  // Unrequired company
        domain: "['|', ['companyId', '=', false], ['companyId', '=', companyId]]"});
    static fiscalPositionId = Fields.Many2one(
        'account.fiscal.position', {string: 'Fiscal Position',
        domain: "[['companyId', '=', companyId]]", checkCompany: true,
        help: "Fiscal positions are used to adapt taxes and accounts for particular customers or sales orders/invoices."+
        "The default value comes from the customer."});
    static taxCountryId = Fields.Many2one({
        comodelName: 'res.country',
        compute: '_computeTaxCountryId',
        // Avoid access error on fiscal position when reading a sale order with company != user.companyIds
        computeSudo: true,
        help: "Technical field to filter the available taxes depending on the fiscal country and fiscal position."});
    static companyId = Fields.Many2one('res.company', {string: 'Company', required: true, index: true, default: self => self.env.company()});
    static teamId = Fields.Many2one(
        'crm.team', {string: 'Sales Team',
        ondelete: "SET NULL", tracking: true,
        changeDefault: true, default: self => self._getDefaultTeam(), checkCompany: true,  // Unrequired company
        domain: "['|', ['companyId', '=', false], ['companyId', '=', companyId]]"});

    static signature = Fields.Image('Signature', {help: 'Signature received through the portal.', copy: false, attachment: true, maxWidth: 1024, maxHeight: 1024});
    static signedBy = Fields.Char('Signed By', {help: 'Name of the person that signed the SO.', copy: false});
    static signedOn = Fields.Datetime('Signed On', {help: 'Date of the signature.', copy: false});

    static commitmentDate = Fields.Datetime('Delivery Date', {copy: false,
                                      states: {'done': [['readonly', true]], 'cancel': [['readonly', true]]},
                                      help: "This is the delivery date promised to the customer. "+
                                           "If set, the delivery order will be scheduled based on "+
                                           "this date rather than product lead times."});
    static expectedDate = Fields.Datetime("Expected Date", {compute: '_computeExpectedDate', store: false,  // Note: can not be stored since depends on today()
        help: "Delivery date you can promise to the customer, computed from the minimum lead time of the order lines."});
    static amountUndiscounted = Fields.Float('Amount Before Discount', {compute: '_computeAmountUndiscounted', digits: 0});

    static typeName = Fields.Char('Type Name', {compute: '_computeTypeName'});

    static transactionIds = Fields.Many2many('payment.transaction', {relation: 'saleOrderTransactionRel', column1:  'saleOrderId', column2: 'transactionId', string: 'Transactions', copy: false, readonly: true});
    static authorizedTransactionIds = Fields.Many2many('payment.transaction', {compute: '_computeAuthorizedTransactionIds',
                                                  string: 'Authorized Transactions', copy: false});
    static showUpdatePricelist = Fields.Boolean({string: 'Has Pricelist Changed',
                                           help: "Technical Field, True if the pricelist was changed;\n"+
                                                " this will then display a recomputation button"});
    static tagIds = Fields.Many2many('crm.tag', {relation: 'saleOrderTagRel', column1: 'orderId', column2: 'tagId', string: 'Tags'});

    static _sqlConstraints = [
        ['date_order_conditional_required', `CHECK( (state IN ('sale', 'done') AND "dateOrder" IS NOT NULL) OR state NOT IN ('sale', 'done') )`, "A confirmed sales order requires a confirmation date."],
    ];

    @api.constrains('companyId', 'orderLine')
    async _checkOrderLineCompanyId() {
        for (const order of this) {
            const companies = await (await (await order.orderLine).productId).companyId;
            if (companies.ok && companies.ne(await order.companyId)) {
                const badProducts = await (await (await order.orderLine).productId).filtered(async (p) => (await p.companyId).ok && (await p.companyId).ne(await order.companyId));
                throw new ValidationError(_f(await this._t(
                    "Your quotation contains products from company {productCompany} whereas your quotation belongs to company {quoteCompany}. \n Please change the company of your quotation or remove the products from other companies ({badProducts})."),
                    {productCompany: (await companies.mapped('displayName')).join(', '),
                    quoteCompany: await (await order.companyId).displayName,
                    badProducts: (await badProducts.mapped('displayName')).join(', ')}
                ));
            }
        }
    }

    @api.depends('pricelistId', 'dateOrder', 'companyId')
    async _computeCurrencyRate() {
        for (const order of this) {
            const [company, currency] = await order('companyId', 'currencyId');
            if (! company.ok) {
                await order.set('currencyRate', await (await currency.withContext({date: await order.dateOrder})).rate || 1.0);
                continue;
            }
            else if ((await company.currencyId).ok && currency.ok) {  // the following crashes if any one is undefined
                await order.set('currencyRate', await this.env.items('res.currency')._getConversionRate(await company.currencyId, currency, company, await order.dateOrder));
            }
            else {
                await order.set('currencyRate', 1.0);
            }
        }
    }

    async _computeAccessUrl() {
        await _super(SaleOrder, this)._computeAccessUrl();
        for (const order of this) {
            await order.set('accessUrl', f('/my/orders/%s', order.id));
        }
    }

    async _computeIsExpired() {
        const today = _Date.today();
        for (const order of this) {
            await order.set('isExpired', await order.state === 'sent' && await order.validityDate && await order.validityDate < today);
        }
    }

    /**
     * For service and consumable, we only take the min dates. This method is extended in saleStock to
            take the pickingPolicy of SO into account.
     */
    @api.depends('orderLine.customerLead', 'dateOrder', 'orderLine.state')
    async _computeExpectedDate() {
        await this.mapped("orderLine");  // Prefetch indication
        for (const order of this) {
            const datesList = [];
            for (const line of await (await order.orderLine).filtered(async (x) => await x.state !== 'cancel' && ! await x._isDelivery() && ! await x.displayType)) {
                const dt = await line._expectedDate();
                datesList.push(dt);
            }
            if (datesList.length) {
                await order.set('expectedDate', _Datetime.toDatetime(dateMin(datesList)));
            }
            else {
                await order.set('expectedDate', false);
            }
        }
    }

    @api.depends('orderLine.taxId', 'orderLine.priceUnit', 'amountTotal', 'amountUntaxed')
    async _computeTaxTotalsJson() {
        async function computeTaxes(orderLine) {
            const price = await orderLine.priceUnit * (1 - (await orderLine.discount || 0.0) / 100.0);
            const order = await orderLine.orderId;
            return (await orderLine.taxId)._origin.computeAll(price, {currency: await order.currencyId, quantity: await orderLine.productUomQty, product: await orderLine.productId, partner: await order.partnerShippingId});
        }

        const accountMove = this.env.items('account.move');
        for (const order of this) {
            const taxLinesData = await accountMove._prepareTaxLinesDataForTotalsFromObject(await order.orderLine, computeTaxes);
            const taxTotals = await accountMove._getTaxTotals(await order.partnerId, taxLinesData, await order.amountTotal, await order.amountUntaxed, await order.currencyId);
            await order.set('taxTotalsJson', stringify(taxTotals));
        }
    }

    @api.depends('transactionIds')
    async _computeAuthorizedTransactionIds() {
        for (const trans of this) {
            await trans.set('authorizedTransactionIds', await (await trans.transactionIds).filtered(async (t) => await t.state === 'authorized'));
        }
    }

    async _computeAmountUndiscounted() {
        for (const order of this) {
            let total = 0.0;
            for (const line of await order.orderLine) {
                const discount = await line.discount;
                total += discount != 100 ? (await line.priceSubtotal * 100)/(100 - discount) : (await line.priceUnit * await line.productUomQty);
            }
            await order.set('amountUndiscounted', total);
        }
    }

    @api.depends('state')
    async _computeTypeName() {
        for (const record of this) {
            await record.set('typeName', ['draft', 'sent', 'cancel'].includes(await record.state) ? await this._t('Quotation') : await this._t('Sales Order'));
        }
    }

    @api.depends('companyId.accountFiscalCountryId', 'fiscalPositionId.countryId', 'fiscalPositionId.foreignVat')
    async _computeTaxCountryId() {
        for (const record of this) {
            if (await (await record.fiscalPositionId).foreignVat) {
                await record.set('taxCountryId', await (await record.fiscalPositionId).countryId);
            }
            else {
                await record.set('taxCountryId', await (await record.companyId).accountFiscalCountryId);
            }
        }
    }

    @api.depends('partnerId', 'dateOrder')
    async _computeAnalyticAccountId() {
        for (const order of this) {
            if (! (await order.analyticAccountId).ok) {
                const defaultAnalyticAccount = await (await order.env.items('account.analytic.default').sudo()).accountGet({
                    partnerId: (await order.partnerId).id, 
                    userId: order.env.uid, 
                    date: await order.dateOrder, 
                    companyId: (await order.companyId).id,
                });
                await order.set('analyticAccountId', await defaultAnalyticAccount.analyticId);
            }
        }
    }

    @api.ondelete(false)
    async _unlinkExceptDraftOrCancel() {
        for (const order of this) {
            if (!['draft', 'cancel'].includes(await order.state)) {
                throw new UserError(await this._t('You can not delete a sent quotation or a confirmed sales order. You must first cancel it.'));
            }
        }
    }

    async validateTaxesOnSalesOrder() {
        // Override for correct taxcloud computation
        // when using coupon and delivery
        return true;
    }

    async _trackSubtype(initValues) {
        this.ensureOne();
        const state = await this['state']
        if ('state' in initValues && state === 'sale') {
            return this.env.ref('sale.mtOrderConfirmed');
        }
        else if ('state' in initValues && state === 'sent') {
            return this.env.ref('sale.mtOrderSent');
        }
        return _super(SaleOrder, this)._trackSubtype(initValues);
    }

    /**
     * Trigger the change of fiscal position when the shipping address is modified.
     * @returns 
     */
    @api.onchange('partnerShippingId', 'partnerId', 'companyId')
    async onchangePartnerShippingId() {
        await this.set('fiscalPositionId', await (await this.env.items('account.fiscal.position').withCompany(await this['companyId'])).getFiscalPosition((await this['partnerId']).id, (await this['partnerShippingId']).id));
        return {};
    }

    /**
     * Update the following fields when the partner is changed:
        - Pricelist
        - Payment terms
        - Invoice address
        - Delivery address
        - Sales Team
     * @returns 
     */
    @api.onchange('partnerId')
    async onchangePartnerId() {
        let partner = await this['partnerId'];
        if (! partner.ok) {
            await this.update({
                'partnerInvoiceId': false,
                'partnerShippingId': false,
                'fiscalPositionId': false,
            });
            return;
        }

        let self = await this.withCompany(await this['companyId']);
        partner = await self['partnerId'];
        const addr = await partner.addressGet(['delivery', 'invoice']);
        const [user, pricelist, paymentTerm] = await partner('userId', 'propertyProductPricelist', 'propertyPaymentTermId');
        const partnerUser = user.ok ? user : await (await partner.commercialPartnerId).userId;
        const values = {
            'pricelistId': pricelist.ok && bool(pricelist.id) ? pricelist.id : false,
            'paymentTermId': paymentTerm.ok && bool(paymentTerm.id) ? paymentTerm.id : false,
            'partnerInvoiceId': addr['invoice'],
            'partnerShippingId': addr['delivery'],
        }
        let userId = partnerUser.id;
        if (! self.env.context['notSelfSaleperson']) {
            userId = bool(userId) ? userId : self.env.context['default_userId'] ?? self.env.uid;
        }
        if (bool(userId) && (await self['userId']).id != userId) {
            values['userId'] = userId;
        }

        if (await (await self.env.items('ir.config.parameter').sudo()).getParam('account.useInvoiceTerms')) {
            if (await self['termsType'] === 'html' && await (await self.env.company()).invoiceTermsHtml) {
                const baseurl = htmlKeepUrl(await self.getBaseUrl() + '/terms');
                let context = {'lang': await partner.lang || await (await self.env.user()).lang}
                values['note'] = await self._t('Terms & Conditions: %s', baseurl);
                context = null;
            }
            else if (! isHtmlEmpty(await (await self.env.company()).invoiceTerms)) {
                values['note'] = await (await (await self.withContext({lang: await partner.lang})).env.company()).invoiceTerms;
            }
        }
        if (! self.env.context['notSelfSaleperson'] || ! (await self['teamId']).ok) {
            const defaultTeam = (self.env.context['default_teamId'] ?? false) || (await partner.teamId).id;
            values['teamId'] = await (await self.env.items('crm.team').withContext(
                {default_teamId: defaultTeam}
            ))._getDefaultTeamId(userId, ['|', ['companyId', '=', (await self['companyId']).id], ['companyId', '=', false]]);
        }
        await self.update(values);
    }

    @api.onchange('userId')
    async onchangeUserId() {
        const user = await this['userId'];
        if (user.ok) {
            const defaultTeam = (this.env.context['default_teamId'] ?? false) || (await this['teamId']).id;
            await this.set('teamId', await (await this.env.items('crm.team').withContext(
                {default_teamId: defaultTeam}
            ))._getDefaultTeamId(user.id));
        }
    }

    @api.onchange('partnerId')
    async _onchangePartnerIdWarning() {
        let partner = await this['partnerId']
        if (! partner.ok) {
            return;
        }

        const saleWarn = await partner.saleWarn;
        // If partner has no warning, check its company
        if (saleWarn === 'no-message' && (await partner.parentId).ok) {
            partner = await partner.parentId;
        }

        if (saleWarn && saleWarn !== 'no-message') {
            // Block if partner only has warning but parent company is blocked
            if (saleWarn !== 'block' && (await partner.parentId).ok && await (await partner.parentId).saleWarn === 'block') {
                partner = await partner.parentId;
            }

            if (await partner.saleWarn === 'block') {
                await this.update({'partnerId': false, 'partnerInvoiceId': false, 'partnerShippingId': false, 'pricelistId': false});
            }
            return {
                'warning': {
                    'title': await this._t("Warning for %s", await partner.label),
                    'message': await partner.saleWarnMsg,
                }
            }
        }
    }

    /**
     * Warn if the commitment dates is sooner than the expected date
     * @returns 
     */
    @api.onchange('commitmentDate', 'expectedDate')
    async _onchangeCommitmentDate() {
        const [commitmentDate, expectedDate] = await this('commitmentDate', 'expectedDate');
        if (commitmentDate && expectedDate && commitmentDate < expectedDate) {
            return {
                'warning': {
                    'title': await this._t('Requested date is too soon.'),
                    'message': await this._t("The delivery date is sooner than the expected date."+
                                 "You may be unable to honor the delivery date.")
                }
            }
        }
    }

    @api.onchange('pricelistId', 'orderLine')
    async _onchangePricelistId() {
        if (bool(await this['orderLine']) && bool(await this['pricelistId']) && (await this._origin.pricelistId).ne(await this['pricelistId'])) {
            await this.set('showUpdatePricelist', true);
        }
        else {
            await this.set('showUpdatePricelist', false);
        }
    }

    /**
     * Hook to exclude specific lines which should not be updated based on price list recomputation
     * @returns 
     */
    async _getUpdatePricesLines() {
        return (await this['orderLine']).filtered(async (line) => ! await line.displayType);
    }

    async updatePrices() {
        this.ensureOne();
        for (const line of await this._getUpdatePricesLines()) {
            await line.productUomChange();
            await line.set('discount', 0);  // Force 0 as discount for the cases when _onchange_discount directly returns
            await line._onchangeDiscount();
        }
        await this.set('showUpdatePricelist', false);
        await this.messagePost({body: await this._t("Product prices have been recomputed according to pricelist <b>%s<b> ", await (await this['pricelistId']).displayName)});
    }

    @api.model()
    async create(vals) {
        let self: any = this;
        if ('companyId' in vals) {
            self = await self.withCompany(vals['companyId']);
        }
        if ((vals['label'] ?? await this._t('New')) === await this._t('New')) {
            let seqDate;
            if ('dateOrder' in vals) {
                seqDate = await _Datetime.contextTimestamp(self, _Datetime.toDatetime(vals['dateOrder']) as Date);
            }
            vals['label'] = await this.env.items('ir.sequence').nextByCode('sale.order', seqDate) || await this._t('New');
        }
        // Makes sure partnerInvoiceId', 'partnerShippingId' and 'pricelistId' are defined
        if (['partnerInvoiceId', 'partnerShippingId', 'pricelistId'].some(f => !(f in vals))) {
            const partner = this.env.items('res.partner').browse(vals['partnerId']);
            const addr = await partner.addressGet(['delivery', 'invoice']);
            vals['partnerInvoiceId'] = setdefault(vals, 'partnerInvoiceId', addr['invoice']);
            vals['partnerShippingId'] = setdefault(vals, 'partnerShippingId', addr['delivery']);
            vals['pricelistId'] = setdefault(vals, 'pricelistId', (await partner.propertyProductPricelist).id);
        }
        return _super(SaleOrder, self).create(vals);
    }

    async _computeFieldValue(field: Field) {
        let filteredSelf;
        if (field.name === 'invoiceStatus' && ! this.env.context['mailActivityAutomationSkip']) {
            filteredSelf = await this.filtered(async (so) => ((await so.userId).ok ? await so.userId: await (await so.partnerId).userId).ok && await so._origin.invoiceStatus !== 'upselling');
        }
        await _super(SaleOrder, this)._computeFieldValue(field);
        if (field.name !== 'invoiceStatus' || this.env.context['mailActivityAutomationSkip']) {
            return;
        }

        const upsellingOrders = await filteredSelf.filtered(async (so) => await so.invoiceStatus === 'upselling');
        if (! bool(upsellingOrders)) {
            return;
        }

        await upsellingOrders._createUpsellActivity();
    }

    async copyData(defaultValue?: any) {
        if (defaultValue == null) {
            defaultValue = {};
        }
        if (!('orderLine' in defaultValue)) {
            defaultValue['orderLine'] = await (await (await this['orderLine']).filtered(async (l) => ! await l.isDownpayment)).map(async (l) => [0, 0, (await l.copyData())[0]]);
        }
        return _super(SaleOrder, this).copyData(defaultValue);
    }

    async nameGet() {
        if (this._context['saleShowPartnerName']) {
            const res = [];
            for (const order of this) {
                let label = await order.label;
                if (await (await order['partnerId']).label) {
                    label = f('%s - %s', label, await (await order.partnerId).label);
                }
                res.push([order.id, label]);
            }
            return res;
        }
        return _super(SaleOrder, this).nameGet();
    }

    @api.model()
    async _nameSearch(label, args?: any, operator='ilike', opts: {limit?: number, nameGetUid?: any}={}) {
        if (this._context['saleShowPartnerName']) {
            let domain;
            if (operator === 'ilike' && !(label || '').trim()) {
                domain = [];
            }
            else if (['ilike', 'like', '=', '=like', '=ilike'].includes(operator)) {
                domain = expression.AND([
                    args || [],
                    ['|', ['label', operator, label], ['partnerId.label', operator, label]]
                ]);
                return this._search(domain, {limit: opts.limit, accessRightsUid: opts.nameGetUid});
            }
        }
        return _super(SaleOrder, this)._nameSearch(label, args, operator, opts);
    }

    async _createUpsellActivity() {
        this.ok && await (this as any).activityUnlink(['sale.mailActSaleUpsell']);
        for (const order of this) {
            const partner = await order.partnerId;
            const ref = "<a href='#' data-oe-model='%s' data-oe-id='%d'>%s</a>";
            const orderRef = f(ref, order._name, bool(order.id) ? order.id : order._origin.id, await order.label);
            const customerRef = f(ref, partner._name, partner.id, await partner.displayName);
            await order.activity_schedule({
                actTypeXmlid: 'sale.mailActSaleUpsell',
                userId: bool((await order.userId).id) ? (await order.userId).id : (await partner.userId).id,
                note: _f(await this._t("Upsell {order} for customer {customer}"), {order: orderRef, customer: customerRef})
            });
        }
    }

    /**
     * Prepare the dict of values to create the new invoice for a sales order. This method may be
        overridden to implement custom invoice generation (making sure to call super() to establish
        a clean extension chain).
     * @returns 
     */
    async _prepareInvoice() {
        this.ensureOne();
        const self: any = this;
        const journal = await (await this.env.items('account.move').withContext({defaultMoveType: 'outInvoice'}))._getDefaultJournal();
        if (!bool(journal)) {
            throw new UserError(await this._t('Please define an accounting sales journal for the company %s (%s).', await (await self.companyId).label, (await self.companyId).id));
        }
        const invoiceVals = {
            'ref': await self.clientOrderRef || '',
            'moveType': 'outInvoice',
            'narration': await self.note,
            'currencyId': (await (await self.pricelistId).currencyId).id,
            'campaignId': (await self.campaignId).id,
            'mediumId': (await self.mediumId).id,
            'sourceId': (await self.sourceId).id,
            'userId': (await self.userId).id,
            'invoiceUserId': (await self.userId).id,
            'teamId': (await self.teamId).id,
            'partnerId': (await self.partnerInvoiceId).id,
            'partnerShippingId': (await self.partnerShippingId).id,
            'fiscalPositionId': (bool(await self.fiscalPositionId) ? await self.fiscalPositionId : (await (await self.fiscalPositionId).getFiscalPosition((await self.partnerInvoiceId).id))).id,
            'partnerBankId': (await (await (await (await self.companyId).partnerId).bankIds).filtered(async (bank) => [(await self.companyId).id, false].includes((await bank.companyId).id))).slice(0, 1).id,
            'journalId': journal.id,  // company comes from the journal
            'invoiceOrigin': await self.name,
            'invoicePaymentTermId': (await self.paymentTermId).id,
            'paymentReference': await self.reference,
            'transactionIds': [[6, 0, (await self.transactionIds).ids]],
            'invoiceLineIds': [],
            'companyId': (await self.companyId).id,
        }
        return invoiceVals;
    }

    async actionQuotationSent() {
        if (bool(await this.filtered(async (so) => await so.state !== 'draft'))) {
            throw new UserError(await this._t('Only draft orders can be marked as sent directly.'));
        }
        for (const order of this) {
            await order.messageSubscribe((await order.partnerId).ids);
        }
        await this.write({'state': 'sent'});
    }

    async actionViewInvoice() {
        const self: any = this;
        const invoices = await self.mapped('invoiceIds');
        let action = await self.env.items("ir.actions.actions")._forXmlid("account.actionMoveOutInvoiceType");
        if (len(invoices) > 1) {
            action['domain'] = [['id', 'in', invoices.ids]];
        }
        else if (len(invoices) == 1) {
            const formView = [[(await self.env.ref('account.view_move_form')).id, 'form']];
            if ('views' in action) {
                action['views'] = formView.concat(action['views'].filter(([,view]) => view != 'form'));
            }
            else {
                action['views'] = formView;
            }
            action['resId'] = invoices.id;
        }
        else {
            action = {'type': 'ir.actions.actwindow.close'}
        }

        const context = {
            'default_moveType': 'outInvoice',
        }
        if (len(self) == 1) {
            let paymentTermId = (await self.paymentTermId).id;
            paymentTermId = bool(paymentTermId) ? paymentTermId: (await (await self.partnerId).propertyPaymentTermId).id;
            paymentTermId = bool(paymentTermId) ? paymentTermId: (await this.env.items('account.move').defaultGet(['invoicePaymentTermId']))['invoicePaymentTermId'];
            update(context, {
                'default_partnerId': (await self.partnerId).id,
                'default_partnerShippingId': (await self.partnerShippingId).id,
                'default_invoicePaymentTermId': paymentTermId,
                'default_invoiceOrigin': await self.label,
            });
        }
        action['context'] = context;
        return action;
    }

    async _getInvoiceGroupingKeys() {
        return ['companyId', 'partnerId', 'currencyId'];
    }

    @api.model()
    async _nothingToInvoiceError() {
        return new UserError(await this._t(
            "There is nothing to invoice!\n\n"+
            "Reason(s) of this behavior could be:\n"+
            "- You should deliver your products before invoicing them.\n"+
            "- You should modify the invoicing policy of your product: Open the product, go to the "+
            "\"Sales\" tab and modify invoicing policy from \"delivered quantities\" to \"ordered "+
            "quantities\". For Services, you should modify the Service Invoicing Policy to "+
            "'Prepaid'."
        ));
    }

    /**
     * Return the invoiceable lines for order `self`.
     * @param final 
     * @returns 
     */
    async _getInvoiceableLines(final=false) {
        const downPaymentLineIds = [];
        const invoiceableLineIds = [];
        let pendingSection;
        const precision = await this.env.items('decimal.precision').precisionGet('Product Unit of Measure');

        for (const line of await this['orderLine']) {
            const [displayType, qtyToInvoice] = await line('displayType', 'qtyToInvoice');
            if (displayType === 'lineSection') {
                // Only invoice the section if one of its lines is invoiceable
                pendingSection = line;
                continue;
            }
            if (displayType !== 'lineNote' && floatIsZero(qtyToInvoice, {precisionDigits: precision})) {
                continue;
            }
            if (qtyToInvoice > 0 || (qtyToInvoice < 0 && final) || displayType === 'lineNote') {
                if (await line.isDownpayment) {
                    // Keep down payment lines separately, to put them together
                    // at the end of the invoice, in a specific dedicated section.
                    downPaymentLineIds.push(line.id);
                    continue;
                }
                if (bool(pendingSection)) {
                    invoiceableLineIds.push(pendingSection.id);
                    pendingSection = null;
                }
                invoiceableLineIds.push(line.id);
            }
        }
        return this.env.items('sale.order.line').browse(invoiceableLineIds.concat(downPaymentLineIds));
    }

    /**
     * Create the invoice associated to the SO.
        :param grouped: if True, invoices are grouped by SO id. If False, invoices are grouped by
                        (partnerInvoiceId, currency)
        :param final: if True, refunds will be generated if necessary
        :returns: list of created invoices
     * @param grouped 
     * @param final 
     * @param date 
     * @returns 
     */
    async _createInvoices(grouped=false, final=false, date?: any) {
        if (! await this.env.items('account.move').checkAccessRights('create', false)) {
            try {
                await this.checkAccessRights('write');
                await this.checkAccessRule('write');
            } catch(e) {
                if (isInstance(e, AccessError)) {
                    return this.env.items('account.move');
                } 
                else {
                    throw e;
                } 
            }
        }
        // 1) Create invoices.
        let invoiceValsList = [];
        let invoiceItemSequence = 0; // Incremental sequencing to keep the lines order on the invoice.
        for (let order of this) {
            order = await order.withCompany(await order.companyId);
            let currentSectionVals;
            const downPayments = order.env.items('sale.order.line');

            const invoiceVals = await order._prepareInvoice();
            const invoiceableLines = await order._getInvoiceableLines(final);

            if (! await invoiceableLines.some(async (line) => ! await line.displayType)) {
                continue;
            }

            let invoiceLineVals = [];
            let downPaymentSectionAdded = false;
            for (const line of invoiceableLines) {
                if (! downPaymentSectionAdded && await line.isDownpayment) {
                    // Create a dedicated section for the down payments
                    // (put at the end of the invoiceableLines)
                    invoiceLineVals.push(
                        [0, 0, await order._prepareDownPaymentSectionLine(invoiceItemSequence)],
                    );
                    downPaymentSectionAdded = true;
                    invoiceItemSequence += 1;
                }
                invoiceLineVals.push(
                    [0, 0, await line._prepareInvoiceLine(invoiceItemSequence)],
                );
                invoiceItemSequence += 1;
            }

            extend(invoiceVals['invoiceLineIds'], invoiceLineVals);
            invoiceValsList.push(invoiceVals);
        }

        if (! invoiceValsList.length) {
            throw await this._nothingToInvoiceError();
        }

        // 2) Manage 'grouped' parameter: group by (partnerId, currencyId).
        if (! grouped) {
            const newInvoiceValsList = [];
            const invoiceGroupingKeys = await this._getInvoiceGroupingKeys();
            invoiceValsList = sorted(
                invoiceValsList,
                x => invoiceGroupingKeys.map(groupingKey => x[groupingKey])
            );
            for (const [groupingKeys, invoices] of groupby(invoiceValsList, x => invoiceGroupingKeys.map(groupingKey => x[groupingKey]))) {
                const origins = new Set(),
                paymentRefs = new Set(),
                refs = new Set();
                let refInvoiceVals;
                for (const invoiceVals of invoices) {
                    if (! bool(refInvoiceVals)) {
                        refInvoiceVals = invoiceVals;
                    }
                    else {
                        extend(refInvoiceVals['invoiceLineIds'], invoiceVals['invoiceLineIds']);
                    }
                    origins.add(invoiceVals['invoiceOrigin']);
                    paymentRefs.add(invoiceVals['paymentReference']);
                    refs.add(invoiceVals['ref']);
                }
                update(refInvoiceVals, {
                    'ref': Array.from(refs).join(', ').slice(0, 2000),
                    'invoiceOrigin': Array.from(origins).join(', '),
                    'paymentReference': len(paymentRefs) == 1 && Array.from(paymentRefs).pop() || false,
                });
                newInvoiceValsList.push(refInvoiceVals);
            }
            invoiceValsList = newInvoiceValsList;
        }
        // 3) Create invoices.

        // As part of the invoice creation, we make sure the sequence of multiple SO do not interfere
        // in a single invoice. Example:
        // SO 1:
        // - Section A (sequence: 10)
        // - Product A (sequence: 11)
        // SO 2:
        // - Section B (sequence: 10)
        // - Product B (sequence: 11)
        //
        // If SO 1 & 2 are grouped in the same invoice, the result will be:
        // - Section A (sequence: 10)
        // - Section B (sequence: 10)
        // - Product A (sequence: 11)
        // - Product B (sequence: 11)
        //
        // Resequencing should be safe, however we resequence only if there are less invoices than
        // orders, meaning a grouping might have been done. This could also mean that only a part
        // of the selected SO are invoiceable, but resequencing in this case shouldn't be an issue.
        if (len(invoiceValsList) < len(this)) {
            const SaleOrderLine = this.env.items('sale.order.line');
            for (const invoice of invoiceValsList) {
                let sequence = 1;
                for (const line of invoice['invoiceLineIds']) {
                    line[2]['sequence'] = await SaleOrderLine._getInvoiceLineSequence(sequence, line[2]['sequence']);
                    sequence += 1;
                }
            }
        }
        // Manage the creation of invoices in sudo because a salesperson must be able to generate an invoice from a
        // sale order without "billing" access rights. However, he should not be able to create an invoice from scratch.
        const moves = await (await (await this.env.items('account.move').sudo()).withContext({default_moveType: 'outInvoice'})).create(invoiceValsList);

        // 4) Some moves might actually be refunds: convert them if the total amount is negative
        // We do this after the moves have been created since we need taxes, etc. to know if the total
        // is actually negative or not
        if (final) {
            await (await (await moves.sudo()).filtered(async (m) => await m.amountTotal < 0)).actionSwitchInvoiceIntoRefundCreditNote();
        }
        for (const move of moves) {
            await move.messagePostWithView('mail.messageOriginLink', {
                values: {'self': move, 'origin': await (await move.lineIds).mapped('saleLineIds.orderId')},
                subtypeId: (await this.env.ref('mail.mtNote')).id
            });
        }
        return moves;
    }

    async actionDraft() {
        const orders = await this.filtered(async (s) => ['cancel', 'sent'].includes(await s.state));
        return orders.write({
            'state': 'draft',
            'signature': false,
            'signedBy': false,
            'signedOn': false,
        });
    }

    async actionCancel() {
        const cancelWarning = await this._showCancelWizard();
        if (cancelWarning) {
            return {
                'label': await this._t('Cancel Sales Order'),
                'viewMode': 'form',
                'resModel': 'sale.order.cancel',
                'viewId': (await this.env.ref('sale.saleOrderCancelViewForm')).id,
                'type': 'ir.actions.actwindow',
                'context': {'default_orderId': this.id},
                'target': 'new'
            }
        }
        return this._actionCancel();
    }

    async _actionCancel() {
        const inv = await (await this['invoiceIds']).filtered(async (inv) => await inv.state === 'draft');
        await inv.buttonCancel();
        return this.write({'state': 'cancel', 'showUpdatePricelist': false});
    }

    async _showCancelWizard() {
        for (const order of this) {
            if (bool(await (await order.invoiceIds).filtered(async (inv) => await inv.state === 'draft')) && !order._context['disableCancelWarning']) {
                return true;
            }
        }
        return false;
    }

    async _findMailTemplate(forceConfirmationTemplate=false) {
        this.ensureOne();
        let templateId = false;

        if (forceConfirmationTemplate || (await this['state'] === 'sale' && ! (this.env.context['proforma'] ?? false))) {
            templateId = parseInt(await (await this.env.items('ir.config.parameter').sudo()).getParam('sale.defaultConfirmationTemplate'));
            templateId = (await this.env.items('mail.template').search([['id', '=', templateId]])).id;
            if (!templateId) {
                templateId = await this.env.items('ir.model.data')._xmlidToResId('sale.mailTemplateSaleConfirmation', false);
            }
        }
        if (!templateId) {
            templateId = await this.env.items('ir.model.data')._xmlidToResId('sale.emailTemplateEdiSale', false);
        }

        return templateId;
    }

    /**
     * Opens a wizard to compose an email, with relevant mail template loaded by default
     * @returns 
     */
    async actionQuotationSend() {
        this.ensureOne();
        const self: any = this;
        const templateId = await self._findMailTemplate();
        let lang = self.env.context['lang'];
        const template = this.env.items('mail.template').browse(templateId);
        if (await template.lang) {
            lang = (await template._renderLang(self.ids))[self.id];
        }
        const ctx = {
            'default_model': 'sale.order',
            'default_resId': self.ids[0],
            'default_useTemplate': bool(templateId),
            'default_templateId': templateId,
            'default_compositionMode': 'comment',
            'markSoAsSent': true,
            'customLayout': "mail.mailNotificationPaynow",
            'proforma': self.env.context['proforma'] ?? false,
            'forceEmail': true,
            'modelDescription': await (await self.withContext({lang})).typeName,
        }
        return {
            'type': 'ir.actions.actwindow',
            'viewMode': 'form',
            'resModel': 'mail.compose.message',
            'views': [[false, 'form']],
            'viewId': false,
            'target': 'new',
            'context': ctx,
        }
    }

    @api.returns('mail.message', (value) => value.id)
    async messagePost(opts: {}={}) {
        if (this.env.context['markSoAsSent']) {
            await (await (await this.filtered(async (o) => await o.state === 'draft')).withContext({trackingDisable: true})).write({'state': 'sent'});
        }
        return _super(SaleOrder, await this.withContext({mailPostAutofollow: this.env.context['mailPostAutofollow'] ?? true})).messagePost(opts);
    }

    /**
     * No phone or mobile field is available on sale model. Instead SMS will
        fallback on partner-based computation using ``_sms_get_partner_fields``.
     * @returns 
     */
    async _smsGetNumberFields() {
        return [];
    }

    async _smsGetPartnerFields() {
        return ['partnerId'];
    }

    async _sendOrderConfirmationMail() {
        let self: any = this;
        if (this.env.su) {
            // sending mail in sudo was meant for it being sent from superuser
            self = await self.withUser(global.SUPERUSER_ID);
        }
        for (const order of this) {
            const templateId = await order._findMailTemplate({forceConfirmationTemplate: true});
            if (bool(templateId)) {
                await (await order.withContext({forceSend: true})).messagePostWithTemplate(templateId, {compositionMode: 'comment', emailLayoutXmlid: "mail.mailNotificationPaynow"});
            }
        }
    }

    async actionDone() {
        for (const order of this) {
            const tx = await (await (await order.sudo()).transactionIds)._getLast();
            if (bool(tx) && await tx.state === 'pending' && await (await tx.acquirerId).provider === 'transfer') {
                await tx._setDone();
                await tx.write({'isPostProcessed': true});
            }
        }
        return this.write({'state': 'done'});
    }

    async actionUnlock() {
        await this.write({'state': 'sale'});
    }

    /**
     * Implementation of additionnal mecanism of Sales Order confirmation.
            This method should be extended when the confirmation should generated
            other documents. In this method, the SO are in 'sale' state (not yet 'done').
     * @returns 
     */
    async _actionConfirm() {
        // create an analytic account if at least an expense product
        for (const order of this) {
            if ((await (await order.orderLine).mapped('productId.expensePolicy')).some(expensePolicy => ![false, 'no'].includes(expensePolicy))) {
                if (! bool(order.analyticAccountId)) {
                    await order._create_analytic_account();
                }
            }
        }

        return true;
    }

    async _prepareConfirmationValues() {
        return {
            'state': 'sale',
            'dateOrder': _Datetime.now()
        }
    }

    async actionConfirm() {
        if (_.intersection(await this._getForbiddenStateConfirm(), await this.mapped('state')).length) {
            throw new UserError(await this._t(
                'It is not allowed to confirm an order in the following states: %s',
                (await this._getForbiddenStateConfirm()).join(', ')
            ));
        }

        for (const order of await this.filtered(async (order) => !(await order.messagePartnerIds).includes(await order.partnerId))) {
            await order.messageSubscribe([(await order.partnerId).id]);
        }
        await this.write(await this._prepareConfirmationValues());

        // Context key 'default_name' is sometimes propagated up to here.
        // We don't need it and it creates issues in the creation of linked records.
        const context = Object.assign({}, this._context);
        pop(context, 'default_label', null);

        await (await this.withContext(context))._actionConfirm();
        if (await (await this.env.user()).hasGroup('sale.groupAutoDoneSetting')) {
            await this.actionDone();
        }
        return true;
    }

    async _getForbiddenStateConfirm() {
        return ['done', 'cancel']
    }

    /**
     * Prepare method for analytic account data

        :param prefix: The prefix of the to-be-created analytic account name
        :type prefix: string
        :return: dictionary of value for new analytic account creation
     * @param prefix 
     * @returns 
     */
    async _prepareAnalyticAccountData(prefix?: any) {
        let label = await this['label'];
        if (prefix) {
            label = prefix + ": " + label;
        }
        return {
            'label': label,
            'code': await this['clientOrderRef'],
            'companyId': (await this['companyId']).id,
            'partnerId': (await this['partnerId']).id
        }
    }

    async _createAnalyticAccount(prefix?: any) {
        for (const order of this) {
            const analytic = await this.env.items('account.analytic.account').create(await order._prepareAnalyticAccountData(prefix));
            await order.set('analyticAccountId', analytic);
        }
    }

    async hasToBeSigned(includeDraft=false) {
        return (await this['state'] === 'sent' || (await this['state'] === 'draft' && includeDraft)) && ! await this['isExpired'] && await this['requireSignature'] && ! await this['signature'];
    }

    async hasToBePaid(includeDraft=false) {
        const transaction = await this.getPortalLastTransaction();
        return (await this['state'] === 'sent' || (await this['state'] === 'draft' && includeDraft)) && ! await this['isExpired'] && await this['requirePayment'] && await transaction.state !== 'done' && await this['amountTotal'];
    }

    /**
     * Give access button to users and portal customer as portal is integrated
        in sale. Customer and portal group have probably no right to see
        the document so they don't have the access button.
     * @param msgVals 
     * @returns 
     */
    async _notifyGetGroups(msgVals?: any) {
        const groups = await _super(SaleOrder, this)._notifyGetGroups(msgVals);

        this.ensureOne();
        if (!['draft', 'cancel'].includes(await this['state'])) {
            for (const [groupName, groupMethod, groupData] of groups) {
                if (!['customer', 'portal'].includes(groupName)){
                    groupData['hasButtonAccess'] = true;
                }
            }
        }

        return groups;
    }

    async previewSaleOrder() {
        this.ensureOne();
        return {
            'type': 'ir.actions.acturl',
            'target': 'self',
            'url': await (this as any).getPortalUrl(),
        }
    }

    async _forceLinesToInvoicePolicyOrder() {
        for (const line of await this['orderLine']) {
            if (['sale', 'done'].includes(await this['state'])) {
                await line.set('qtyToInvoice', await line.productUomQty - await line.qtyInvoiced);
            }
            else {
                await line.set('qtyToInvoice', 0);
            }
        }
    }

    /**
     * Capture all transactions linked to this sale order.
     * @returns 
     */
    async paymentActionCapture() {
        await checkRightsOnRecordset(this);
        // In sudo mode because we need to be able to read on acquirer Fields.
        await (await (await this['authorizedTransactionIds']).sudo()).actionCapture();
    }

    /**
     * Void all transactions linked to this sale order.
     * @returns 
     */
    async paymentActionVoid() {
        await checkRightsOnRecordset(this);
        // In sudo mode because we need to be able to read on acquirer Fields.
        await (await (await this['authorizedTransactionIds']).sudo()).actionVoid();
    }
    
    async getPortalLastTransaction() {
        this.ensureOne();
        return (await this['transactionIds'])._getLast();
    }

    @api.model()
    async _getCustomerLead(productTemplateId) {
        return false;
    }

    async _getReportBaseFilename() {
        this.ensureOne();
        return f('%s %s', await this['typeName'], await this['label']);
    }

    /**
     * Return the action used to display orders when returning from customer portal.
     * @returns 
     */
    async _getPortalReturnAction() {
        this.ensureOne();
        return this.env.ref('sale.action_quotations_with_onboarding');
    }

    /**
     * Prepare the dict of values to create a new down payment section for a sales order line.

        :param optional_values: any parameter that should be added to the returned down payment section
     * @param options 
     * @returns 
     */
    @api.model()
    async _prepareDownPaymentSectionLine(options) {
        let context = {'lang': await (await this['partnerId']).lang}
        const downPaymentsSectionLine = {
            'displayType': 'lineSection',
            'label': await this._t('Down Payments'),
            'productId': false,
            'productUomId': false,
            'quantity': 0,
            'discount': 0,
            'priceUnit': 0,
            'accountId': false
        }
        context = null;
        if (bool(options)) {
            update(downPaymentsSectionLine, options);
        }
        return downPaymentsSectionLine;
    }
    
    async addOptionToOrderWithTaxcloud() {
        this.ensureOne();
    }
}