import { Fields, _Date, _Datetime, api, tools } from "../../../core";
import { setdefault } from "../../../core/api";
import { DatabaseError, MapKey, UserError, ValidationError } from "../../../core/helper";
import { AbstractModel, MetaModel, Model, _super } from "../../../core/models";
import { expression } from "../../../core/osv";
import { _f, addDate, b64encode, bool, dateSetTz, extend, floatCompare, floatIsZero, floatRepr, floatRound, groupbyAsync, isInstance, len, someAsync, sorted, sortedAsync, sum, update } from "../../../core/tools";
import { Procurement } from "../../stock";

@MetaModel.define()
class PosOrder extends Model {
    static _module = module;
    static _name = "pos.order";
    static _description = "Point of Sale Orders";
    static _order = "dateOrder desc, label desc, id desc";

    @api.model()
    async _amountLineTax(line, fiscalPositionId) {
        const [order, product, priceUnit, discount, qty] = await line('orderId', 'productId', 'priceUnit', 'discount', 'qty');
        const partner = await order.partnerId;
        let taxes = await (await line.taxIds).filtered(async (t) => (await t.companyId).id == (await order.companyId).id);
        taxes = await fiscalPositionId.mapTax(taxes);
        const price = priceUnit * (1 - (discount || 0.0) / 100.0);
        taxes = (await taxes.computeAll(price, {currency: await (await order.pricelistId).currencyId, quantity: qty, product: product, partner: partner.ok ? partner : false}))['taxes'];
        return sum(taxes.map(tax => tax['amount'] ?? 0.0));
    }

    @api.model()
    async _orderFields(uiOrder) {
        const processLine = this.env.items('pos.order.line');
        return {
            'userId':      uiOrder['userId'] || false,
            'sessionId':   uiOrder['posSessionId'],
            'lines':        uiOrder['lines'] ? await Promise.all(uiOrder['lines'].map(async (l) => processLine._orderLineFields(l, uiOrder['posSessionId']))) : false,
            'posReference': uiOrder['label'],
            'sequenceNumber': uiOrder['sequenceNumber'],
            'partnerId':   uiOrder['partnerId'] || false,
            'dateOrder':   uiOrder['creationDate'].replace('T', ' ').slice(0,19),
            'fiscalPositionId': uiOrder['fiscalPositionId'],
            'pricelistId': uiOrder['pricelistId'],
            'amountPaid':  uiOrder['amountPaid'],
            'amountTotal':  uiOrder['amountTotal'],
            'amountTax':  uiOrder['amountTax'],
            'amountReturn':  uiOrder['amountReturn'],
            'companyId': (await this.env.items('pos.session').browse(uiOrder['posSessionId']).companyId).id,
            'toInvoice': "toInvoice" in uiOrder ? uiOrder['toInvoice'] : false,
            'toShip': "toShip" in uiOrder ? uiOrder['toShip'] : false,
            'isTipped': uiOrder['isTipped'] ?? false,
            'tipAmount': uiOrder['tipAmount'] ?? 0,
        }
    }

    @api.model()
    async _paymentFields(order, uiPaymentline) {
        return {
            'amount': uiPaymentline['amount'] || 0.0,
            'paymentDate': uiPaymentline['label'],
            'paymentMethodId': uiPaymentline['paymentMethodId'],
            'cardType': uiPaymentline['cardType'],
            'cardholderName': uiPaymentline['cardholderName'],
            'transactionId': uiPaymentline['transactionId'],
            'paymentStatus': uiPaymentline['paymentStatus'],
            'ticket': uiPaymentline['ticket'],
            'posOrderId': order.id,
        }
    }

    // This deals with orders that belong to a closed session. In order
    // to recover from this situation we create a new rescue session,
    // making it obvious that something went wrong.
    // A new, separate, rescue session is preferred for every such recovery,
    // to avoid adding unrelated orders to live sessions.
    async _getValidSession(order) {
        const posSession = this.env.items('pos.session');
        const closedSession = posSession.browse(order['posSessionId']);

        console.warn('session %s (ID: %s) was closed but received order %s (total: %s) belonging to it',
                        await closedSession.label,
                        closedSession.id,
                        order['label'],
                        order['amountTotal']);
        const rescueSession = await posSession.search([
            ['state', 'not in', ['closed', 'closingControl']],
            ['rescue', '=', true],
            ['configId', '=', (await closedSession.configId).id],
        ], {limit: 1});
        if (rescueSession.ok) {
            console.warn('reusing recovery session %s for saving order %s', await rescueSession.label, order['label']);
            return rescueSession;
        }

        console.warn('attempting to create recovery session for saving order %s', order['label']);
        const newSession = await posSession.create({
            'configId': (await closedSession.configId).id,
            'label': _f(await this._t('(RESCUE FOR {session})'), {'session': await closedSession.label}),
            'rescue': true, // avoid conflict with live sessions
        });
        // bypass opening (necessary when using cash control)
        await newSession.actionPosSessionOpen();

        return newSession;
    }

    /**
     * This method is here to be overridden in order to add fields that are required for draft orders.
     * @returns 
     */
    async _getFieldsForDraftOrder() {
        return [];
    }

    /**
     * Create or update an pos.order from a given dictionary.

        :param dict order: dictionary representing the order.
        :param bool draft: Indicate that the pos_order is not validated yet.
        :param existingOrder: order to be updated or false.
        :type existingOrder: pos.order.
        :returns: id of created/updated pos.order
        :rtype: int
     * @param order 
     * @param draft 
     * @param existingOrder 
     * @returns 
     */
    @api.model()
    async _processOrder(order, draft, existingOrder) {
        order = order['data'];
        const posSession = this.env.items('pos.session').browse(order['posSessionId']);
        const state = await posSession.state;
        if (state === 'closingControl' || state == 'closed') {
            order['posSessionId'] = (await this._getValidSession(order)).id;
        }

        let posOrder;// = false
        if (! bool(existingOrder)) {
            posOrder = await this.create(await this._orderFields(order));
        }
        else {
            posOrder = existingOrder;
            await (await posOrder.lines).unlink();
            order['userId'] = (await posOrder.userId).id;
            await posOrder.write(await this._orderFields(order));
        }

        posOrder = await posOrder.withCompany(await posOrder.companyId);
        let self = await this.withCompany(await posOrder.companyId);
        await this._processPaymentLines(order, posOrder, posSession, draft);

        if (! draft) {
            try {
                await posOrder.actionPosOrderPaid();
            } catch(e) {
                if (isInstance(e, DatabaseError)) {
                    // do not hide transactional errors, the order(s) won't be saved!
                    throw e;
                } else {
                    console.error('Could not fully process the POS Order: %s', tools.ustr(e));
                }
            }
            await posOrder._createOrderPicking();
            await posOrder._computeTotalCostInRealTime();
        }

        if (await posOrder.toInvoice && await posOrder.state === 'paid') {
            await posOrder._generatePosOrderInvoice();
        }

        return posOrder.id;
    }

    /**
     * Create account.bank.statement.lines from the dictionary given to the parent function.

        If the payment_line is an updated version of an existing one, the existing payment_line will first be
        removed before making a new one.
        :param pos_order: dictionary representing the order.
        :type pos_order: dict.
        :param order: Order object the payment lines should belong to.
        :type order: pos.order
        :param pos_session: PoS session the order was created in.
        :type pos_session: pos.session
        :param draft: Indicate that the pos_order is not validated yet.
        :type draft: bool.
     * @param posOrder 
     * @param order 
     * @param posSession 
     * @param draft 
     */
    async _processPaymentLines(posOrder, order, posSession, draft) {
        const precAcc = await (await (await order.pricelistId).currencyId).decimalPlaces;

        const orderBankStatementLines = await this.env.items('pos.payment').search([['posOrderId', '=', order.id]]);
        await orderBankStatementLines.unlink();
        for (const payments of posOrder['statementIds']) {
            await order.addPayment(await this._paymentFields(order, payments[2]));
        }
        await order.set('amountPaid', sum(await (await order.paymentIds).mapped('amount')));

        if (!draft && !floatIsZero(posOrder['amountReturn'], precAcc)) {
            const cashPaymentMethod = (await (await posSession.paymentMethodIds).filtered('isCashCount')).slice(0,1);
            if (! cashPaymentMethod.ok) {
                throw new UserError(await this._t("No cash statement found for this session. Unable to record returned cash."));
            }
            const returnPaymentVals = {
                'label': await this._t('return'),
                'posOrderId': order.id,
                'amount': -posOrder['amountReturn'],
                'paymentDate': _Datetime.now(),
                'paymentMethodId': cashPaymentMethod.id,
                'isChange': true,
            }
            await order.addPayment(returnPaymentVals);
        }
    }

    async _prepareInvoiceLine(orderLine) {
        const product = await orderLine.productId;
        const label = await product.getProductMultilineDescriptionSale();
        return {
            'productId': product.id,
            'quantity': await this['amountTotal'] >= 0 ? await orderLine.qty : - await orderLine.qty,
            'discount': await orderLine.discount,
            'priceUnit': await orderLine.priceUnit,
            'label': label,
            'taxIds': [[6, 0, (await orderLine.taxIdsAfterFiscalPosition).ids]],
            'productUomId': (await orderLine.productUomId).id,
        }
    }

    async _prepareInvoiceLines() {
        const invoiceLines = [];
        const currency = await this['currencyId'];
        for (const line of await this['lines']) {
            invoiceLines.push([0, null, await this._prepareInvoiceLine(line)]);
            const [order, product, priceUnit, customerNote] = await line('orderId', 'productId', 'priceUnit', 'customerNote'); 
            if (await (await order.pricelistId).discountPolicy === 'withoutDiscount' && floatCompare(priceUnit, await product.lstPrice, {precisionRounding: await currency.rounding}) < 0) {
                invoiceLines.push([0, null, {
                    'label': await this._t('Price discount from %s -> %s',
                              floatRepr(await product.lstPrice, await currency.decimalPlaces),
                              floatRepr(priceUnit, await currency.decimalPlaces)),
                    'displayType': 'lineNote',
                }]);
            }
            if (customerNote) {
                invoiceLines.push([0, null, {
                    'label': customerNote,
                    'displayType': 'lineNote',
                }]);
            }
        }

        return invoiceLines;
    }

    async _getPosAngloSaxonPriceUnit(product, partnerId, quantity) {
        const moves = await (await (await (await this.filtered(async (o) => (await o.partnerId).id == partnerId))
            .mapped('pickingIds.move_lines'))
            ._filterAngloSaxonMoves(product))
            .sorted((x) => x.date);
        const priceUnit = await (await product.withCompany(await this['companyId']))._computeAveragePrice(0, quantity, moves);
        return priceUnit;
    }

    static label = Fields.Char({string: 'Order Ref', required: true, readonly: true, copy: false, default: '/'});
    static dateOrder = Fields.Datetime({string: 'Date', readonly: true, index: true, default: () => _Datetime.now()});
    static userId = Fields.Many2one({
        comodelName: 'res.users', string: 'Responsible',
        help: "Person who uses the cash register. It can be a reliever, a student or an interim employee.",
        default: self => self.env.uid,
        states: {'done': [['readonly', true]], 'invoiced': [['readonly', true]]},
    });
    static amountTax = Fields.Float({string: 'Taxes', digits: 0, readonly: true, required: true});
    static amountTotal = Fields.Float({string: 'Total', digits: 0, readonly: true, required: true});
    static amountPaid = Fields.Float({string: 'Paid', states: {'draft': [['readonly', false]]},
        readonly: true, digits: 0, required: true});
    static amountReturn = Fields.Float({string: 'Returned', digits: 0, required: true, readonly: true});
    static margin = Fields.Monetary({string: "Margin", compute: '_computeMargin'});
    static marginPercent = Fields.Float({string: "Margin (%)", compute: '_computeMargin', digits: [12, 4]});
    static isTotalCostComputed = Fields.Boolean({compute: '_computeIsTotalCostComputed',
        help: "Allows to know if all the total cost of the order lines have already been computed"});
    static lines = Fields.One2many('pos.order.line', 'orderId', {string: 'Order Lines', states: {'draft': [['readonly', false]]}, readonly: true, copy: true});
    static companyId = Fields.Many2one('res.company', {string: 'Company', required: true, readonly: true});
    static pricelistId = Fields.Many2one('product.pricelist', {string: 'Pricelist', required: true, states: {
                                   'draft': [['readonly', false]]}, readonly: true});
    static partnerId = Fields.Many2one('res.partner', {string: 'Customer', changeDefault: true, index: true, states: {'draft': [['readonly', false]], 'paid': [['readonly', false]]}});
    static sequenceNumber = Fields.Integer({string: 'Sequence Number', help: 'A session-unique sequence number for the order', default: 1});

    static sessionId = Fields.Many2one(
        'pos.session', {string: 'Session', required: true, index: true,
        domain: "[['state', '=', 'opened']]", states: {'draft': [['readonly', false]]},
        readonly: true});
    static configId = Fields.Many2one('pos.config', {related: 'sessionId.configId', string: "Point of Sale", readonly: false});
    static currencyId = Fields.Many2one('res.currency', {related: 'configId.currencyId', string: "Currency"});
    static currencyRate = Fields.Float("Currency Rate", {compute: '_computeCurrencyRate', computeSudo: true, store: true, digits: 0, readonly: true,
        help: 'The rate of the currency to the currency of rate applicable at the date of the order'});

    static invoiceGroup = Fields.Boolean({related: "configId.moduleAccount", readonly: false});
    static state = Fields.Selection(
        [['draft', 'New'], ['cancel', 'Cancelled'], ['paid', 'Paid'], ['done', 'Posted'], ['invoiced', 'Invoiced']],
        {string: 'Status', readonly: true, copy: false, default: 'draft', index: true});

    static accountMove = Fields.Many2one('account.move', {string: 'Invoice', readonly: true, copy: false, index: true});
    static pickingIds = Fields.One2many('stock.picking', 'posOrderId');
    static pickingCount = Fields.Integer({compute: '_computePickingCount'});
    static failedPickings = Fields.Boolean({compute: '_computePickingCount'});
    static pickingTypeId = Fields.Many2one('stock.picking.type', {related: 'sessionId.configId.pickingTypeId', string: "Operation Type", readonly: false});
    static procurementGroupId = Fields.Many2one('procurement.group', {string: 'Procurement Group', copy: false});

    static note = Fields.Text({string: 'Internal Notes'});
    static nbPrint = Fields.Integer({string: 'Number of Print', readonly: true, copy: false, default: 0});
    static posReference = Fields.Char({string: 'Receipt Number', readonly: true, copy: false});
    static saleJournal = Fields.Many2one('account.journal', {related: 'sessionId.configId.journalId', string: 'Sales Journal', store: true, readonly: true, ondelete: 'RESTRICT'});
    static fiscalPositionId = Fields.Many2one({
        comodelName: 'account.fiscal.position', string: 'Fiscal Position',
        readonly: true,
        states: {'draft': [['readonly', false]]},
    });
    static paymentIds = Fields.One2many('pos.payment', 'posOrderId', {string: 'Payments', readonly: true});
    static sessionMoveId = Fields.Many2one('account.move', {string: 'Session Journal Entry', related: 'sessionId.moveId', readonly: true, copy: false});
    static toInvoice = Fields.Boolean('To invoice', {copy: false});
    static toShip = Fields.Boolean('To ship');
    static isInvoiced = Fields.Boolean('Is Invoiced', {compute: '_computeIsInvoiced'});
    static isTipped = Fields.Boolean('Is this already tipped?', {readonly: true});
    static tipAmount = Fields.Float({string: 'Tip Amount', digits: 0, readonly: true});
    static refundOrdersCount = Fields.Integer('Number of Refund Orders', {compute: '_computeRefundRelatedFields'});
    static isRefunded = Fields.Boolean({compute: '_computeRefundRelatedFields'});
    static refundedOrderIds = Fields.Many2many('pos.order', {compute: '_computeRefundRelatedFields'});
    static hasRefundableLines = Fields.Boolean('Has Refundable Lines', {compute: '_computeHasRefundableLines'});
    static refundedOrdersCount = Fields.Integer({compute: '_computeRefundRelatedFields'});

    @api.depends('lines.refundOrderlineIds', 'lines.refundedOrderlineId')
    async _computeRefundRelatedFields() {
        for (const order of this) {
            await order.update({
                refundOrdersCount: len(await order.mapped('lines.refundOrderlineIds.orderId')),
                isRefunded: await order.refundOrdersCount > 0,
                refundedOrderIds: await order.mapped('lines.refundedOrderlineId.orderId'),
                refundedOrdersCount: len(await order.refundedOrderIds)
            });
        }
    }

    @api.depends('lines.refundedQty', 'lines.qty')
    async _computeHasRefundableLines() {
        const digits = await this.env.items('decimal.precision').precisionGet('Product Unit of Measure');
        for (const order of this) {
            await order.set('hasRefundableLines', await (await order.lines).some(async (line) => floatCompare(await line.qty, await line.refundedQty, digits) > 0));
        }
    }

    @api.depends('accountMove')
    async _computeIsInvoiced() {
        for (const order of this) {
            await order.set('isInvoiced', bool(await order.accountMove));
        }
    }

    @api.depends('pickingIds', 'pickingIds.state')
    async _computePickingCount() {
        for (const order of this) {
            await order.set('pickingCount', len(await order.pickingIds));
            await order.set('failedPickings', bool(await (await order.pickingIds).filtered(async (p) => await p.state !== 'done')));
        }
    }

    @api.depends('dateOrder', 'companyId', 'currencyId', 'companyId.currencyId')
    async _computeCurrencyRate() {
        for (const order of this) {
            await order.set('currencyRate', await  this.env.items('res.currency')._getConversionRate(await (await order.companyId).currencyId, await order.currencyId, await order.companyId, await order.dateOrder));
        }
    }

    @api.depends('lines.isTotalCostComputed')
    async _computeIsTotalCostComputed() {
        for (const order of this) {
            await order.set('isTotalCostComputed', ! (await (await order.lines).mapped('isTotalCostComputed')).includes(false));
        }
    }

    /**
     * Compute the total cost of the order when it's processed by the server. It will compute the total cost of all the lines
        if it's possible. If a margin of one of the order's lines cannot be computed (because of session_id.updateStockAtClosing),
        then the margin of said order is not computed (it will be computed when closing the session).
     */
    async _computeTotalCostInRealTime() {
        for (const order of this) {
            let [lines, pickingIds] = await order('lines', 'pickingIds');
            if (! await order._shouldCreatePickingRealTime()) {
                const storableFifoAvcoLines = await lines.filtered(l => l._isProductStorableFifoAvco());
                lines = lines.sub(storableFifoAvcoLines);
            }
            const stockMoves = await pickingIds.moveLines;
            await lines._computeTotalCost(stockMoves);
        }
    }

    /**
     * Compute the margin at the end of the session. This method should be called to compute the remaining lines margin
        containing a storable product with a fifo/avco cost method and then compute the order margin
     * @param stockMoves 
     */
    async _computeTotalCostAtSessionClosing(stockMoves) {
        for (const order of this) {
            const storableFifoAvcoLines = await (await order.lines).filtered(l => l._isProductStorableFifoAvco());
            await storableFifoAvcoLines._computeTotalCost(stockMoves);
        }
    }

    @api.depends('lines.margin', 'isTotalCostComputed')
    async _computeMargin() {
        for (const order of this) {
            const [isTotalCostComputed, lines, currency] = await order('isTotalCostComputed', 'lines', 'currencyId');
            if (isTotalCostComputed) {
                await order.set('margin', sum(await lines.mapped('margin')));
                const amountUntaxed = await currency.round(await lines.sum(line => line.priceSubtotal));
                await order.set('marginPercent', ! floatIsZero(amountUntaxed, {precisionRounding: await currency.rounding}) && await order.margin / amountUntaxed || 0);
            }
            else {
                await order.set('margin', 0);
                await order.set('marginPercent', 0);
            }
        }
    }

    @api.onchange('paymentIds', 'lines')
    async _onchangeAmountAll() {
        for (const order of this) {
            const pricelist = await order.pricelistId;
            if (!bool(await pricelist.currencyId)) {
                throw new UserError(await this._t("You can't: create a pos order from the backend interface, or unset the pricelist, or create a pos.order in a test with Form tool, or edit the form view in studio if no PoS order exist"));
            }
            const currency = await pricelist.currencyId;
            const [paymentIds, lines, fiscalPositionId] = await order('paymentIds', 'lines', 'fiscalPositionId'); 
            await order.set('amountPaid', sum(await paymentIds.map(payment => payment.amount)));
            await order.set('amountReturn', sum(await paymentIds.map(async (payment) => await payment.amount < 0 && await payment.amount || 0)));
            await order.set('amountTax', await currency.round(sum(await lines.map((line) => this._amountLineTax(line, fiscalPositionId)))));
            const amountUntaxed = await currency.round(sum(await lines.map(line => line.priceSubtotal)))
            await order.set('amountTotal', await order.amountTax + amountUntaxed);
        }
    }

    /**
     *  Does essentially the same thing as `_onchangeAmountAll` but only for actually existing records
        It is intended as a helper method , not as a business one
        Practical to be used for migrations

     * @returns 
     */
    async _computeBatchAmountAll() {
        const amounts = Object.fromEntries(this.ids.map(id => {return [id, {'paid': 0, 'return': 0, 'taxed': 0, 'taxes': 0}]}));
        const payment = this.env.items('pos.payment');
        for (const order of await payment.readGroup([['posOrderId', 'in', this.ids]], ['posOrderId', 'amount'], ['posOrderId'])) {
            amounts[order['posOrderId'][0]]['paid'] = order['amount'];
        }
        for (const order of await payment.readGroup(['&', ['posOrderId', 'in', this.ids], ['amount', '<', 0]], ['posOrderId', 'amount'], ['posOrderId'])) {
            amounts[order['posOrderId'][0]]['return'] = order['amount'];
        }
        for (const order of await this.env.items('pos.order.line').readGroup([['orderId', 'in', this.ids]], ['orderId', 'priceSubtotal', 'priceSubtotalIncl'], ['orderId'])) {
            amounts[order['orderId'][0]]['taxed'] = order['priceSubtotalIncl'];
            amounts[order['orderId'][0]]['taxes'] = order['priceSubtotalIncl'] - order['priceSubtotal'];
        }

        for (const order of this) {
            const currency = await (await order.pricelistId).currencyId;
            await order.write({
                'amountPaid': amounts[order.id]['paid'],
                'amountReturn': amounts[order.id]['return'],
                'amountTax': await currency.round(amounts[order.id]['taxes']),
                'amountTotal': await currency.round(amounts[order.id]['taxed'])
            });
        }
    }

    @api.onchange('partnerId')
    async _onchangePartnerId() {
        const partner = await this['partnerId'];
        if (bool(partner)) {
            await this.set('pricelistId', (await partner.propertyProductPricelist).id);
        }
    }

    @api.ondelete(false)
    async _unlinkExceptDraftOrCancel() {
        for (const posOrder of await this.filtered(async (posOrder) => !['draft', 'cancel'].includes(await posOrder.state))) {
            throw new UserError(await this._t('In order to delete a sale, it must be new or cancelled.'));
        }
    }

    @api.model()
    async create(values) {
        const session = this.env.items('pos.session').browse(values['sessionId']);
        values = await this._completeValuesFromSession(session, values);
        return _super(PosOrder, this).create(values);
    }

    @api.model()
    async _completeValuesFromSession(session, values) {
        if (values['state'] && values['state'] === 'paid') {
            values['label'] = await this._computeOrderName();
        }
        const config = await session.configId;
        setdefault(values, 'pricelistId', (await config.pricelistId).id);
        setdefault(values, 'fiscalPositionId', (await config.defaultFiscalPositionId).id);
        setdefault(values, 'companyId', (await config.companyId).id);
        return values;
    }

    async write(vals) {
        for (const order of this) {
            if (vals['state'] && vals['state'] === 'paid' && await order.label === '/') {
                vals['label'] = await this._computeOrderName();
            }
        }
        return _super(PosOrder, this).write(vals);
    }

    async _computeOrderName() {
        const [refundedOrderIds, session] = await this('refundedOrderIds', 'sessionId');
        if (len(refundedOrderIds) != 0) {
            return (await refundedOrderIds.mapped('label')).join(',') + await this._t(' REFUND');
        }
        else {
            return (await (await session.configId).sequenceId)._next();
        }
    }

    async actionStockPicking() {
        this.ensureOne();
        const action = this.env.items('ir.actions.actions')._forXmlid('stock.actionPickingTreeReady');
        action['displayName'] = await this._t('Pickings');
        action['context'] = {}
        action['domain'] = [['id', 'in', (await this['pickingIds']).ids]];
        return action;
    }

    async actionViewInvoice() {
        return {
            'label': await this._t('Customer Invoice'),
            'viewMode': 'form',
            'viewId': (await this.env.ref('account.viewMoveForm')).id,
            'resModel': 'account.move',
            'context': "{'moveType':'outInvoice'}",
            'type': 'ir.actions.actwindow',
            'resId': (await this['accountMove']).id,
        }
    }

    async actionViewRefundOrders() {
        return {
            'label': await this._t('Refund Orders'),
            'viewMode': 'tree,form',
            'resModel': 'pos.order',
            'type': 'ir.actions.actwindow',
            'domain': [['id', 'in', (await this.mapped('lines.refundOrderlineIds.orderId')).ids]],
        }
    }

    async actionViewRefundedOrders() {
        return {
            'label': await this._t('Refunded Orders'),
            'viewMode': 'tree,form',
            'resModel': 'pos.order',
            'type': 'ir.actions.actwindow',
            'domain': [['id', 'in', (await this['refundedOrderIds']).ids]],
        }
    }

    async _isPosOrderPaid() {
        return floatIsZero(await this._getRoundedAmount(await this['amountTotal']) - await this['amountPaid'], {precisionRounding: await (await this['currencyId']).rounding});
    }

    async _getRoundedAmount(amount) {
        const [config, currency] = await this('configId', 'currencyId');
        if (await config.cashRounding) {
            amount = floatRound(amount, {precisionRounding: await (await config.roundingMethod).rounding, roundingMethod: await (await config.roundingMethod).roundingMethod});
        }
        return currency.ok ? currency.round(amount) : amount;
    }

    async _getPartnerBankId() {
        let bankPartnerId = false;
        const hasPayLater = await someAsync(await (await this['paymentIds']).mapped('paymentMethodId'), async (pm) => !bool(await pm.journalId));
        if (hasPayLater) {
            const [partner, company, amountTotal] = await this('partnerId', 'companyId', 'amountTotal');
            if (await this['amountTotal'] <= 0) {
                const bankIds = await partner.bankIds;
                if (bool(bankIds)) {
                    bankPartnerId = bankIds[0].id;
                }
            }
            else if (amountTotal >= 0) {
                const bankIds = await (await company.partnerId).bankIds;
                if (bool(bankIds)) {
                    bankPartnerId = bankIds[0].id;
                }
            }
        }
        return bankPartnerId;
    }

    async _createInvoice(moveVals) {
        this.ensureOne();
        const [label, config] = await this('label', 'companyId', 'configId');
        const newMove = await (await (await (await this.env.items('account.move').sudo()).withCompany(await this['company'])).withContext({default_moveType: moveVals['moveType']})).create(moveVals);
        const message = await this._t("This invoice has been created from the point of sale session: <a href=# data-oe-model=pos.order data-oe-id=%d>%s</a>", this.id, label);
        await newMove.messagePost({body: message});
        if (await config.cashRounding) {
            const [amountPaid, amountTotal] = await this('amountPaid', 'amountTotal');
            const roundingApplied = floatRound(amountPaid - amountTotal,
                                           {precisionRounding: await (await newMove.currencyId).rounding});
            const roundingLine = await (await newMove.lineIds).filtered(line => line.isRoundingLine);
            let roundingLineDifference;
            if (bool(roundingLine) && await roundingLine.debit > 0) {
                roundingLineDifference = await roundingLine.debit + roundingApplied;
            }
            else if (bool(roundingLine) && await roundingLine.credit > 0) {
                roundingLineDifference = - await roundingLine.credit + roundingApplied;
            }
            else {
                roundingLineDifference = roundingApplied;
            }
            const [company, currency] = await newMove('companyId', 'currencyId');
            if (roundingApplied) {
                let accountId;
                if (roundingApplied > 0.0) {
                    accountId = (await (await newMove.invoiceCashRoundingId).lossAccountId).id;
                }
                else {
                    accountId = (await (await newMove.invoiceCashRoundingId).profitAccountId).id;
                }
                if (bool(roundingLine)) {
                    if (roundingLineDifference) {
                        await (await roundingLine.withContext({checkMoveValidity: false})).write({
                            'debit': roundingApplied < 0.0 && -roundingApplied || 0.0,
                            'credit': roundingApplied > 0.0 && roundingApplied || 0.0,
                            'accountId': accountId,
                            'priceUnit': roundingApplied,
                        });
                    }
                }
                else {
                    this.env.items('account.move.line').withContext({checkMoveValidity: false}).create({
                        'debit': roundingApplied < 0.0 && -roundingApplied || 0.0,
                        'credit': roundingApplied > 0.0 && roundingApplied || 0.0,
                        'quantity': 1.0,
                        'amountCurrency': roundingApplied,
                        'partnerId': (await newMove.partnerId).id,
                        'moveId': newMove.id,
                        'currencyId': !currency.eq(await company.currencyId) ? currency : false,
                        'companyId': company.id,
                        'companyCurrencyId': (await company.currencyId).id,
                        'isRoundingLine': true,
                        'sequence': 9999,
                        'label': (await newMove.invoiceCashRoundingId).label,
                        'accountId': accountId,
                    });
                }
            }
            else {
                if (bool(roundingLine)) {
                    await (await roundingLine.withContext({checkMoveValidity: false})).unlink();
                }
            }
            if (roundingLineDifference) {
                const existingTermsLine = await (await newMove.lineIds).filtered(
                    async (line) => ['receivable', 'payable'].includes(await (await (await line.accountId).userTypeId).type));
                let existingTermsLineNewVal;
                if (await existingTermsLine.debit > 0) {
                    existingTermsLineNewVal = floatRound(
                        await existingTermsLine.debit + roundingLineDifference,
                        {precisionRounding: await currency.rounding});
                }
                else {
                    existingTermsLineNewVal = floatRound(
                        - await existingTermsLine.credit + roundingLineDifference,
                        {precisionRounding: await currency.rounding});
                }
                await existingTermsLine.write({
                    'debit': existingTermsLineNewVal > 0.0 && existingTermsLineNewVal || 0.0,
                    'credit': existingTermsLineNewVal < 0.0 && -existingTermsLineNewVal || 0.0,
                });

                await newMove._recomputePaymentTermsLines();
            }
        }
        return newMove;
    }

    async actionPosOrderPaid() {
        this.ensureOne();

        // TODO: add support for mix of cash and non-cash payments when both cashRounding and onlyRoundCashMethod are true
        const [config, currency, paymentIds, amountTotal, amountPaid] = await this('configId', 'currencyId', 'paymentIds','amountTotal', 'amountPaid');
        const [roundingMethod, cashRounding] = await config('roundingMethod', 'cashRounding');
        let total;
        if (! cashRounding 
           || await config.onlyRoundCashMethod
           && ! await paymentIds.some(async (p) => (await p.paymentMethodId).isCashCount)) {
            total = amountTotal;
        }
        else {
            total = floatRound(amountTotal, {precisionRounding: await roundingMethod.rounding, roundingMethod: await roundingMethod.roundingMethod});
        }
        const isPaid = floatIsZero(total - amountPaid, {precisionRounding: await currency.rounding});

        if (! isPaid && ! cashRounding) {
            throw new UserError(await this._t("Order %s is not fully paid.", await this['label']));
        }
        else if (! isPaid && cashRounding) {
            let maxDiff;
            if (await roundingMethod.roundingMethod === "HALF-UP") {
                maxDiff = await currency.round(await roundingMethod.rounding / 2);
            }
            else {
                maxDiff = await currency.round(await roundingMethod.rounding);
            }
            const diff = await currency.round(amountTotal - amountPaid);
            if (! Math.abs(diff) <= maxDiff) {
                throw new UserError(await this._t("Order %s is not fully paid.", await this['label']));
            }
        }
        await this.write({'state': 'paid'});

        return true;
    }

    async _prepareInvoiceVals() {
        this.ensureOne();
        const timezone = this._context['tz'] || await (await this.env.user()).tz || 'UTC';
        const [label, session, pricelist, amountTotal, partner, user, dateOrder, fiscalPosition, refundedOrderIds, note] = await this('label', 'sessionId', 'pricelistId', 'amountTotal', 'partnerId', 'userId', 'dateOrder', 'fiscalPositionId', 'refundedOrderIds', 'note');
        const config = await session.configId;
        const vals = {
            'invoiceOrigin': label,
            'journalId': (await config.invoiceJournalId).id,
            'moveType': amountTotal >= 0 ? 'outInvoice' : 'outRefund',
            'ref': label,
            'partnerId': partner.id,
            'partnerBankId': await this._getPartnerBankId(),
            // considering partner's sale pricelist's currency
            'currencyId': (await pricelist.currencyId).id,
            'invoiceUserId': user.id,
            'invoiceDate': _Date.today(dateSetTz(dateOrder, timezone)),
            'fiscalPositionId': fiscalPosition.id,
            'invoiceLineIds': await this._prepareInvoiceLines(),
            'invoicePaymentTermId': (await partner.propertyPaymentTermId).id || false,
            'invoiceCashRoundingId': await config.cashRounding && (! await config.onlyRoundCashMethod || await (await this['paymentIds']).some(async (p) => (await p.paymentMethodId).isCashCount)) ? 
            (await config.roundingMethod).id : false
        }
        const accountMove = await refundedOrderIds.accountMove;
        if (bool(accountMove)) {
            vals['ref'] = await this._t('Reversal of: %s', await accountMove.label)
            vals['reversedEntryId'] = accountMove.id
        }
        if (note) {
            update(vals, {'narration': note});
        }
        return vals;
    }

    async actionPosOrderInvoice() {
        await this.write({'toInvoice': true});
        const res = await this._generatePosOrderInvoice();
        if (await (await this['companyId']).angloSaxonAccounting && await (await this['sessionId']).updateStockAtClosing && ! await this['toShip']) {
            await this._createOrderPicking();
        }
        return res;
    }

    async _generatePosOrderInvoice() {
        let moves = this.env.items('account.move');

        for (const order of this) {
            // Force company for all SUPERUSER_ID action
            if (bool(await order.accountMove)) {
                moves = moves.add(await order.accountMove);
                continue;
            }

            if (! bool(await order.partnerId)) {
                throw new UserError(await this._t('Please provide a partner for the sale.'));
            }
            const moveVals = await order._prepareInvoiceVals();
            const newMove = await order._createInvoice(moveVals);

            await order.write({'accountMove': newMove.id, 'state': 'invoiced'});
            await (await (await newMove.sudo()).withCompany(await order.companyId))._post();
            moves = moves.add(newMove);
            await order._applyInvoicePayments();
        }

        if (! moves.ok) {
            return {}
        }

        return {
            'label': await this._t('Customer Invoice'),
            'viewMode': 'form',
            'viewId': (await this.env.ref('account.viewMoveForm')).id,
            'resModel': 'account.move',
            'context': "{'moveType':'outInvoice'}",
            'type': 'ir.actions.actwindow',
            'nodestroy': true,
            'target': 'current',
            'resId': moves && moves.ids[0] || false,
        }
    }

    // this method is unused, and so is the state 'cancel'
    async actionPosOrderCancel() {
        return this.write({'state': 'cancel'});
    }

    async _applyInvoicePayments() {
        const receivableAccount = await (await this.env.items("res.partner")._findAccountingPartner(await this['partnerId'])).propertyAccountReceivableId;
        const paymentMoves = await (await (await (await this['paymentIds']).sudo()).withCompany(await this['companyId']))._createPaymentMoves();
        if (await receivableAccount.reconcile) {
            const invoiceReceivables = await (await (await this['accountMove']).lineIds).filtered(async (line) => (await line.accountId).eq(receivableAccount) && ! await line.reconciled);
            if (bool(invoiceReceivables)) {
                const paymentReceivables = await (await paymentMoves.mapped('lineIds')).filtered(async (line) => (await line.accountId).eq(receivableAccount) && bool(await line.partnerId));
                await (await (await (await invoiceReceivables.or(paymentReceivables).sorted(l => l.amountCurrency)).sudo()).withCompany(await this['companyId'])).reconcile();
            }
        }
    }

    /**
     * Create and update Orders from the frontend PoS application.

        Create new orders and update orders that are in draft status. If an order already exists with a status
        diferent from 'draft'it will be discareded, otherwise it will be saved to the database. If saved with
        'draft' status the order can be overwritten later by this function.

        :param orders: dictionary with the orders to be created.
        :type orders: dict.
        :param draft: Indicate if the orders are ment to be finalised or temporarily saved.
        :type draft: bool.
        :Returns: list -- list of db-ids for the created and updated orders.
     * @param orders 
     * @param draft 
     * @returns 
     */
    @api.model()
    async createFromUi(orders, draft=false) {
        const orderIds = [];
        for (const order of orders) {
            let existingOrder;
            if ('serverId' in order['data']) {
                existingOrder = await this.env.items('pos.order').search(['|', ['id', '=', order['data']['serverId']], ['posReference', '=', order['data']['label']]], {limit: 1});
            }
            if ((bool(existingOrder) && await existingOrder.state === 'draft') || !bool(existingOrder)) {
                orderIds.push(await this._processOrder(order, draft, existingOrder));
            }
        }
        return this.env.items('pos.order').searchRead([['id', 'in', orderIds]], ['id', 'posReference']);
    }

    async _shouldCreatePickingRealTime() {
        return ! await (await this['sessionId']).updateStockAtClosing || (await (await this['companyId']).angloSaxonAccounting && await this['toInvoice']);
    }

    async _createOrderPicking() {
        this.ensureOne();
        if (await this['toShip']) {
            await (await this['lines'])._launchStockRuleFromPosOrderLines();
        }
        else {
            if (await this._shouldCreatePickingRealTime()) {
                const [config, partner] = await this('configId', 'partnerId');
                const pickingType = await config.pickingTypeId;
                let destinationId;
                if (await partner.propertyStockCustomer) {
                    destinationId = await partner.propertyStockCustomer.id;
                }
                else if (!bool(pickingType) || !bool(await pickingType.defaultLocationDestId)) {
                    destinationId = (await this.env.items('stock.warehouse')._getPartnerLocations())[0].id;
                }
                else {
                    destinationId = (await pickingType.defaultLocationDestId).id;
                }
                const pickings = await this.env.items('stock.picking')._createPickingFromPosOrderLines(destinationId, await this['lines'], pickingType, partner);
                await pickings.write({'posSessionId': (await this['sessionId']).id, 'posOrderId': this.id, 'origin': await this['label']});
            }
        }
    }

    /**
     * Create a new payment for the order
     * @param data 
     */
    async addPayment(data) {
        this.ensureOne();
        await this.env.items('pos.payment').create(data);
        await this.set('amountPaid', sum(await (await this['paymentIds']).mapped('amount')));
    }

    async _prepareRefundValues(currentSession) {
        this.ensureOne();
        return {
            'label': await this['label'] + await this._t(' REFUND'),
            'sessionId': currentSession.id,
            'dateOrder': _Datetime.now(),
            'posReference': await this['posReference'],
            'lines': false,
            'amountTax': - await this['amountTax'],
            'amountTotal': - await this['amountTotal'],
            'amountPaid': 0,
            'isTotalCostComputed': false
        }
    }

    async _prepareMailValues(label, client, ticket) {
        const message = await this._t("<p>Dear %s,<br/>Here is your electronic ticket for the %s. </p>", client['label'], label);

        const user = await this.env.user();
        return {
            'subject': await this._t('Receipt %s', label),
            'bodyHtml': message,
            'authorId': (await user.partnerId).id,
            'email_from': await (await this.env.company()).email || await user.emailFormatted,
            'emailTo': client['email'],
            'attachmentIds': await this._addMailAttachment(label, ticket),
        }
    }

    /**
     * Create a copy of order  for refund order
     * @returns 
     */
    async refund() {
        let refundOrders = this.env.items('pos.order');
        for (const order of this) {
            // When a refund is performed, we are creating it in a session having the same config as the original
            // order. It can be the same session, or if it has been closed the new one that has been opened.
            const currentSession = await (await (await order.sessionId).configId).currentSessionId;
            if (! bool(currentSession)) {
                throw new UserError(await this._t('To return product(s), you need to open a session in the POS %s', await (await (await order.sessionId).configId).displayName));
            }
            const refundOrder = await order.copy(
                await order._prepareRefundValues(currentSession)
            );
            for (const line of await order.lines) {
                let posOrderLineLot = this.env.items('pos.pack.operation.lot');
                for (const packLot of await line.packLotIds) {
                    posOrderLineLot = posOrderLineLot.add(await packLot.copy());
                }
                await line.copy(await line._prepareRefundData(refundOrder, posOrderLineLot));
            }
            refundOrders = refundOrders.or(refundOrder);
        }

        return {
            'label': await this._t('Return Products'),
            'viewMode': 'form',
            'resModel': 'pos.order',
            'resId': refundOrders.ids[0],
            'viewId': false,
            'context': this.env.context,
            'type': 'ir.actions.actwindow',
            'target': 'current',
        }
    }

    async _addMailAttachment(label, ticket) {
        const filename = 'Receipt-' + label + '.jpg';
        const receipt = await this.env.items('ir.attachment').create({
            'label': filename,
            'type': 'binary',
            'datas': ticket,
            'resModel': 'pos.order',
            'resId': this.ids[0],
            'mimetype': 'image/jpeg',
        })
        const attachment = [[4, receipt.id]];

        if (bool(await this.mapped('accountMove'))) {
            const report = await (await this.env.ref('account.accountInvoices'))._renderQwebPdf((await this['accountMove']).ids[0]);
            const filename = label + '.pdf';
            const invoice = await this.env.items('ir.attachment').create({
                'label': filename,
                'type': 'binary',
                'datas': b64encode(report[0]),
                'resModel': 'pos.order',
                'resId': this.ids[0],
                'mimetype': 'application/x-pdf'
            });
            extend(attachment, [[4, invoice.id]]);
        }
        return attachment;
    }

    async actionReceiptToCustomer(label, client, ticket) {
        if (!this.ok) {
            return false;
        }
        if (! client['email']) {
            return false;
        }

        const mail = await (await this.env.items('mail.mail').sudo()).create(await this._prepareMailValues(label, client, ticket));
        await mail.send();
    }

    /**
     * Remove orders from the frontend PoS application

        Remove orders from the server by id.
        :param serverIds: list of the id's of orders to remove from the server.
        :type serverIds: list.
        :returns: list -- list of db-ids for the removed orders.
     * @param serverIds 
     * @returns 
     */
    @api.model()
    async removeFromUi(serverIds) {
        const orders = await this.search([['id', 'in', serverIds], ['state', '=', 'draft']]);
        await orders.write({'state': 'cancel'});
        // TODO Looks like delete cascade is a better solution.
        await (await (await orders.mapped('paymentIds')).sudo()).unlink();
        await (await orders.sudo()).unlink();
        return orders.ids;
    }

    /**
     * Search for 'paid' orders that satisfy the given domain, limit and offset.
     * @param configId 
     * @param domain 
     * @param limit 
     * @param offset 
     * @returns 
     */
    @api.model()
    async searchPaidOrderIds(configId, domain, limit, offset) {
        const defaultDomain = ['&', ['configId', '=', configId], '!', '|', ['state', '=', 'draft'], ['state', '=', 'cancelled']];
        const realDomain = expression.AND([domain, defaultDomain]);
        const ids = (await this.search(expression.AND([domain, defaultDomain]), {limit, offset})).ids;
        const totalCount = await this.searchCount(realDomain);
        return {'ids': ids, 'totalCount': totalCount}
    }

    async _exportForUi(order) {
        const timezone = this._context['tz'] || await (await this.env.user()).tz || 'UTC';
        return {
            'lines': await (await (await order.lines).exportForUi()).map(line => [0, 0, line]),
            'statementIds': await (await (await order.paymentIds).exportForUi()).map(payment => [0, 0, payment]),
            'label': await order.posReference,
            'uid': (await order.posReference).match(/([0-9]|-){14}/g, )[0],
            'amountPaid': await order.amountPaid,
            'amountTotal': await order.amountTotal,
            'amountTax': await order.amountTax,
            'amountReturn': await order.amountReturn,
            'posSessionId': (await order.sessionId).id,
            'isSessionClosed': (await order.sessionId).state == 'closed',
            'pricelistId': (await order.pricelistId).id,
            'partnerId': (await order.partnerId).id,
            'userId': (await order.userId).id,
            'sequenceNumber': await order.sequenceNumber,
            'creationDate': dateSetTz(await order.dateOrder, timezone).toISOString(),
            'fiscalPositionId': (await order.fiscalPositionId).id,
            'toInvoice': await order.toInvoice,
            'toShip': await order.toShip,
            'state': await order.state,
            'accountMove': (await order.accountMove).id,
            'id': order.id,
            'isTipped': await order.isTipped,
            'tipAmount': await order.tipAmount,
        }
    }

    /**
     * This function is here to be overriden
     * @returns 
     */
    _getFieldsForOrderLine() {
        return [];
    }

    /**
     * This function is here to be overriden
     * @param orderLine 
     * @returns 
     */
    async _prepareOrderLine(orderLine) {
        return orderLine;
    }

    /**
     * Returns a list of dict with each item having similar signature as the return of
            `exportAsJSON` of models.Order. This is useful for back-and-forth communication
            between the pos frontend and backend.
     * @returns 
     */
    async exportForUi() {
        return this.ok ? this.mapped(order => this._exportForUi(order)) : [];
    }
}

@MetaModel.define()
class PosOrderLine extends Model {
    static _module = module;
    static _name = "pos.order.line";
    static _description = "Point of Sale Order Lines";
    static _recName = "productId";

    async _orderLineFields(line, sessionId?: any) {
        if (bool(line) && !('label' in line[2])) {
            const session = sessionId ? this.env.items('pos.session').browse(sessionId).exists() : null;
            const sequenceLineId = await (await session.configId).sequenceLineId;
            if (bool(session) && bool(sequenceLineId)) {
                // set name based on the sequence specified on the config
                line[2]['label'] = await sequenceLineId._next();
            }
            else {
                // fallback on any pos.order.line sequence
                line[2]['label'] = await this.env.items('ir.sequence').nextByCode('pos.order.line');
            }
        }
        if (bool(line) && !('taxIds' in line[2])) {
            const product = this.env.items('product.product').browse(line[2]['productId']);
            line[2]['taxIds'] = [[6, 0, await (await product.taxesId).map(x => x.id)]];
        }
        // Clean up fields sent by the JS
        line = [
            line[0], line[1], Object.fromEntries(Object.entries(line[2]).filter(([k]) => k in this.env.items('pos.order.line')._fields))
        ]
        return line;
    }

    static companyId = Fields.Many2one('res.company', {string: 'Company', related: "orderId.companyId", store: true});
    static label = Fields.Char({string: 'Line No', required: true, copy: false});
    static notice = Fields.Char({string: 'Discount Notice'});
    static productId = Fields.Many2one('product.product', {string: 'Product', domain: [['saleOk', '=', true]], required: true, changeDefault: true});
    static priceUnit = Fields.Float({string: 'Unit Price', digits: 0});
    static qty = Fields.Float('Quantity', {digits: 'Product Unit of Measure', default: 1});
    static priceSubtotal = Fields.Float({string: 'Subtotal w/o Tax', digits: 0,
        readonly: true, required: true});
    static priceSubtotalIncl = Fields.Float({string: 'Subtotal', digits: 0,
        readonly: true, required: true});
    static margin = Fields.Monetary({string: "Margin", compute: '_computeMargin'});
    static marginPercent = Fields.Float({string: "Margin (%)", compute: '_computeMargin', digits: [12, 4]});
    static totalCost = Fields.Float({string: 'Total cost', digits: 'Product Price', readonly: true});
    static isTotalCostComputed = Fields.Boolean({help: "Allows to know if the total cost has already been computed or not"});
    static discount = Fields.Float({string: 'Discount (%)', digits: 0, default: 0.0});
    static orderId = Fields.Many2one('pos.order', {string: 'Order Ref', ondelete: 'CASCADE', required: true, index: true});
    static taxIds = Fields.Many2many('account.tax', {string: 'Taxes', readonly: true});
    static taxIdsAfterFiscalPosition = Fields.Many2many('account.tax', {compute: '_getTaxIdsAfterFiscalPosition', string: 'Taxes to Apply'});
    static packLotIds = Fields.One2many('pos.pack.operation.lot', 'posOrderLineId', {string: 'Lot/serial Number'});
    static productUomId = Fields.Many2one('uom.uom', {string: 'Product UoM', related: 'productId.uomId'});
    static currencyId = Fields.Many2one('res.currency', {related: 'orderId.currencyId'});
    static fullProductName = Fields.Char('Full Product Name');
    static customerNote = Fields.Char('Customer Note', {help: 'This is a note destined to the customer'});
    static refundOrderlineIds = Fields.One2many('pos.order.line', 'refundedOrderlineId', {string: 'Refund Order Lines', help: 'Orderlines in this field are the lines that refunded this orderline.'});
    static refundedOrderlineId = Fields.Many2one('pos.order.line', {string: 'Refunded Order Line', help: 'If this orderline is a refund, then the refunded orderline is specified in this field.'});
    static refundedQty = Fields.Float('Refunded Quantity', {compute: '_computeRefundQty', help: 'Number of items refunded in this orderline.'});

    @api.depends('refundOrderlineIds')
    async _computeRefundQty() {
        for (const orderline of this) {
            await orderline.set('refundedQty', -sum(await orderline.mapped('refundOrderlineIds.qty')));
        }
    }

    /**
     * This prepares data for refund order line. Inheritance may inject more data here

        @param refund_order: the pre-created refund order
        @type refund_order: pos.order

        @param PosOrderLineLot: the pre-created Pack operation Lot
        @type PosOrderLineLot: pos.pack.operation.lot

        @return: dictionary of data which is for creating a refund order line from the original line
        @rtype: dict
     * @param refundOrder 
     * @param PosOrderLineLot 
     * @returns 
     */
    async _prepareRefundData(refundOrder, posOrderLineLot) {
        this.ensureOne();
        return {
            'label': await this['label'] + await this._t(' REFUND'),
            'qty': - (await this['qty'] - await this['refundedQty']),
            'orderId': refundOrder.id,
            'priceSubtotal': - await this['priceSubtotal'],
            'priceSubtotalIncl': - await this['priceSubtotalIncl'],
            'packLotIds': posOrderLineLot,
            'isTotalCostComputed': false,
            'refundedOrderlineId': this.id,
        }
    }

    @api.model()
    async create(values) {
        if (values['orderId'] && ! values['label']) {
            // set name based on the sequence specified on the config
            const config = await (await this.env.items('pos.order').browse(values['orderId']).sessionId).configId;
            if (bool(await config.sequenceLineId)) {
                values['label'] = await (await config.sequenceLineId)._next();
            }
        }
        if (! values['label']) {
            // fallback on any pos.order sequence
            values['label'] = await this.env.items('ir.sequence').nextByCode('pos.order.line');
        }
        return _super(PosOrderLine, this).create(values);
    }

    async write(values) {
        if (values['packLotLineIds']) {
            for (const pl of values['packLotIds']) {
                if (pl[2]['serverId']) {
                    pl[2]['id'] = pl[2]['serverId'];
                    delete pl[2]['serverId'];
                }
            }
        }
        return _super(PosOrderLine, this).write(values);
    }

    @api.onchange('priceUnit', 'taxIds', 'qty', 'discount', 'productId')
    async _onchangeAmountLineAll() {
        for (const line of this) {
            const res = await line._computeAmountLineAll();
            await line.update(res);
        }
    }

    async _computeAmountLineAll() {
        this.ensureOne();
        const order = await this['orderId'];
        const fpos = await order.fiscalPositionId;
        const taxIdsAfterFiscalPosition = await fpos.mapTax(await this['taxIds']);
        const price = await this['priceUnit'] * (1 - (await this['discount'] || 0.0) / 100.0);
        const taxes = await taxIdsAfterFiscalPosition.computeAll(price, {currency: await (await order.pricelistId).currencyId, quntity: await this['qty'], product: await this['productId'], partner: await order.partnerId});
        return {
            'priceSubtotalIncl': taxes['totalIncluded'],
            'priceSubtotal': taxes['totalExcluded'],
        }
    }

    @api.onchange('productId')
    async _onchangeProductId() {
        const product = await this['productId'];
        if (product.ok) {
            const order = await this['orderId'];
            const pricelist = await order.pricelistId;
            if (! bool(pricelist)) {
                throw new UserError(
                    await this._t('You have to select a pricelist in the sale form !\n'+
                      'Please set one before choosing a product.'));
            }
            const price = await pricelist.getProductPrice(product, await this['qty'] || 1.0, await order.partnerId);
            const [company] = await this('companyId');
            await this.set('taxIds', await (await product.taxesId).filtered(async (r) => !company.ok || (await r.companyId).eq(company)));
            const taxIdsAfterFiscalPosition = await (await order.fiscalPositionId).mapTax(await this['taxIds']);
            await this.set('priceUnit', await this.env.items('account.tax')._fixTaxIncludedPriceCompany(price, await this['taxIds'], taxIdsAfterFiscalPosition, company));
            await this._onchangeQty();
        }
    }

    @api.onchange('qty', 'discount', 'priceUnit', 'taxIds')
    async _onchangeQty() {
        const product = await this['productId']; 
        if (product.ok) {
            const pricelist = await (await this['orderId']).pricelistId; 
            if (!pricelist.ok) {
                throw new UserError(await this._t('You have to select a pricelist in the sale form.'));
            }
            const [discount, priceUnit, taxIds, qty] = await this('discount', 'priceUnit', 'taxIds', 'qty');
            const price = priceUnit * (1 - discount || 0.0) / 100.0;
            await this.set('priceSubtotal', price * qty); 
            await this.set('priceSubtotalIncl', price * qty);
            if (taxIds.ok) {
                const taxes = await taxIds.computeAll(price, {currency: await pricelist.currencyId, quntity: qty, product: product, partner: false});
                await this.set('priceSubtotal', taxes['totalExcluded']);
                await this.set('priceSubtotalIncl', taxes['totalIncluded']);
            }
        }
    }

    @api.depends('orderId', 'orderId.fiscalPositionId')
    async _getTaxIdsAfterFiscalPosition() {
        for (const line of this) {
            await line.set('taxIdsAfterFiscalPosition', await (await (await line.orderId).fiscalPositionId).mapTax(await line.taxIds));
        }
    }

    async _exportForUi(orderline) {
        return {
            'qty': await orderline.qty,
            'priceUnit': await orderline.priceUnit,
            'priceSubtotal': await orderline.priceSubtotal,
            'priceSubtotalIncl': await orderline.priceSubtotalIncl,
            'productId': (await orderline.productId).id,
            'discount': await orderline.discount,
            'taxIds': [[6, false, await (await orderline.taxIds).mapped(tax => tax.id)]],
            'id': orderline.id,
            'packLotIds': (await (await orderline.packLotIds).exportForUi()).map(lot => [0, 0, lot]),
            'customerNote': await orderline.customerNote,
            'refundedQty': await orderline.refundedQty,
            'refundedOrderlineId': await orderline.refundedOrderlineId,
        }
    }

    async exportForUi() {
        return this.ok ? this.mapped(order => this._exportForUi(order)) : [];
    }

    async _getProcurementGroup() {
        return (await this['orderId']).procurementGroupId;
    }

    async _prepareProcurementGroupVals() {
        const order = await this['orderId'];
        return {
            'label': await order.label,
            'moveType': await (await order.configId).pickingPolicy,
            'posOrderId': order.id,
            'partnerId': (await order.partnerId).id,
        }
    }

    /**
     * Prepare specific key for moves or other components that will be created from a stock rule
        comming from a sale order line. This method could be override in order to add other custom key that could
        be used in move/po creation.
     * @param groupId 
     * @returns 
     */
    async _prepareProcurementValues(groupId?: any) {
        this.ensureOne();
        const [order, fullProductName] = await this('orderId', 'fullProductName');
        // Use the delivery date if there is else use dateOrder and lead time
        const [dateDeadline, config] = await order('dateOrder', 'configId');
        const values = {
            'groupId': groupId,
            'datePlanned': dateDeadline,
            'dateDeadline': dateDeadline,
            'route_ids': await config.routeId,
            'warehouseId': (await config.warehouseId).ok ? await config.warehouseId : false,
            'partnerId': (await order.partnerId).id,
            'productDescriptionVariants': fullProductName,
            'companyId': await order.companyId,
        }
        return values;
    }

    async _launchStockRuleFromPosOrderLines() {
        const procurements = [];
        for (let line of this) {
            line = await line.withCompany(await line.companyId);
            if (!['consu','product'].includes(await (await line.productId).type)) {
                continue;
            }

            let groupId = await line._getProcurementGroup();
            if (! bool(groupId)) {
                groupId = await this.env.items('procurement.group').create(await line._prepareProcurementGroupVals());
                await (await line.orderId).set('procurementGroupId', groupId);
            }

            const values = await line._prepareProcurementValues(groupId);
            const [productQty, order] = await line('qty', 'orderId');

            const procurementUom = await (await line.productId).uomId;
            procurements.push(Procurement(
                await line.productId, productQty, procurementUom,
                await (await order.partnerId).propertyStockCustomer,
                await line.label, await order.label, await order.companyId, values)
            );
        }
        if (procurements.length) {
            await this.env.items('procurement.group').run(procurements);
        }

        // This next block is currently needed only because the scheduler trigger is done by picking confirmation rather than stock.move confirmation
        const orders = await this.mapped('orderId');
        for (const order of orders) {
            const pickingsToConfirm = await order.pickingIds;
            if (bool(pickingsToConfirm)) {
                // Trigger the Scheduler for Pickings
                await pickingsToConfirm.actionConfirm();
                const trackedLines = await (await order.lines).filtered(async (l) => await (await l.productId).tracking !== 'none');
                const linesByTrackedProduct = await groupbyAsync(await sortedAsync(trackedLines, async (l) => (await l.productId).id), async (l) => (await l.productId).id);
                for (let [productId, lines] of linesByTrackedProduct) {
                    lines = this.env.items('pos.order.line').concat(...lines);
                    const moves = await (await pickingsToConfirm.moveLines).filtered(async (m) => (await m.productId).id == productId);
                    await (await moves.moveLineIds).unlink();
                    await moves._addMlsRelatedToOrder(lines, false);
                    await moves._recomputeState();
                }
            }
        }
        return true;
    }

    async _isProductStorableFifoAvco() {
        this.ensureOne();
        const product = await this['productId']
        return await product.type === 'product' && ['fifo', 'average'].includes(await product.costMethod);
    }

    /**
     *  Compute the total cost of the order lines.
        :param stock_moves: recordset of `stock.move`, used for fifo/avco lines

     * @param stockMoves 
     */
    async _computeTotalCost(stockMoves) {
        for (const line of await this.filtered(async (l) => ! await l.isTotalCostComputed)) {
            const [product, qty] = await line('productId', 'qty');
            let productCost;
            if (await line._isProductStorableFifoAvco() && bool(stockMoves)) {
                productCost = await product._computeAveragePrice(0, qty, await this._getStockMovesToConsider(stockMoves, product));
            }
            else {
                productCost = await product.standardPrice;
            }
            await line.set('totalCost', qty * await (await product.costCurrencyId)._convert(
                productCost,
                await line.currencyId,
                (await line.companyId).ok ? await line.companyId : await this.env.company(),
                await (await line.orderId).dateOrder || _Date.today(),
                false,
            ));
            await line.set('isTotalCostComputed', true);
        }
    }

    async _getStockMovesToConsider(stockMoves, product) {
        return stockMoves.filtered(async (ml) => (await ml.productId).id == product.id);
    }

    @api.depends('priceSubtotal', 'totalCost')
    async _computeMargin() {
        for (const line of this) {
            const priceSubtotal = await line.priceSubtotal; 
            await line.set('margin', priceSubtotal - await line.totalCost);
            await line.set('marginPercent', !floatIsZero(priceSubtotal, {precisionRounding: await (await line.currencyId).rounding}) && await line.margin / priceSubtotal || 0);
        }
    }
}

@MetaModel.define()
class PosOrderLineLot extends Model {
    static _module = module;
    static _name = "pos.pack.operation.lot";
    static _description = "Specify product lot/serial number in pos order line";
    static _recName = "lotName";

    static posOrderLineId = Fields.Many2one('pos.order.line');
    static orderId = Fields.Many2one('pos.order', {related: "posOrderLineId.orderId", readonly: false});
    static lotName = Fields.Char('Lot Name');
    static productId = Fields.Many2one('product.product', {related: 'posOrderLineId.productId', readonly: false});

    async _exportForUi(lot) {
        return {
            'lotName': await lot.lotName,
        }
    }

    async exportForUi() {
        return this.ok ? this.mapped(lot => this._exportForUi(lot)) : [];
    }
}

@MetaModel.define()
class ReportSaleDetails extends AbstractModel {
    static _module = module;
    static _name = 'pos.report.saledetails';
    static _description = 'Point of Sale Details';

    /**
     * Serialise the orders of the requested time period, configs and sessions.

        :param dateStart: The dateTime to start, default today 00:00:00.
        :type dateStart: str.
        :param dateStop: The dateTime to stop, default dateStart + 23:59:59.
        :type dateStop: str.
        :param configIds: Pos Config id's to include.
        :type configIds: list of numbers.
        :param sessionIds: Pos Config id's to include.
        :type sessionIds: list of numbers.

        :returns: dict -- Serialised sales.
     * @param dateStart 
     * @param dateStop 
     * @param configIds 
     * @param sessionIds 
     */
    @api.model()
    async getSaleDetails(dateStart: any=false, dateStop: any=false, configIds: any=false, sessionIds: any=false) {
        let domain = [['state', 'in', ['paid','invoiced','done']]];

        if (bool(sessionIds)) {
            domain = expression.AND([domain, [['sessionId', 'in', sessionIds]]]);
        }
        else {
            if (dateStart) {
                dateStart = _Datetime.toDatetime(dateStart);
            }
            else {
                // start by default today 00:00:00
                const userTz = this.env.context['tz'] || await (await this.env.user()).tz || 'UTC';
                const today = dateSetTz(_Datetime.toDatetime(await _Date.contextToday(this)) as Date, userTz);
                dateStart = today;//.astimezone(pytz.timezone('UTC'))
            }
            if (dateStop) {
                dateStop = _Datetime.toDatetime(dateStop);
                // avoid a date_stop smaller than dateStart
                if (dateStop < dateStart) {
                    dateStop = addDate(dateStart, {days: 1, seconds: -1});
                }
            }
            else {
                // stop by default today 23:59:59
                dateStop = addDate(dateStart, {days: 1, seconds: -1});
            }

            domain = expression.AND([domain,
                [['dateOrder', '>=', dateStart.toISOString()]],
                ['dateOrder', '<=', dateStop.toISOString()]
            ]);

            if (bool(configIds)) {
                domain = expression.AND([domain, [['configId', 'in', configIds]]]);
            }
        }
        const orders = await this.env.items('pos.order').search(domain);

        const userCurrency = await (await this.env.company()).currencyId;

        let total = 0.0;
        const productsSold = new MapKey<any, any>(([product, priceUnit, discount]) => [product.id, priceUnit, discount].join(':'));
        const taxes = {}
        for (const order of orders) {
            const [pricelist] = await order('pricelistId');
            if (!userCurrency.eq(await pricelist.currencyId)) {
                total += await (await pricelist.currencyId)._convert(
                    await order.amountTotal, userCurrency, await order.companyId, await order.dateOrder || _Date.today());
            }
            else {
                total += await order.amountTotal;
            }
            const currency = await (await order.sessionId).currencyId;

            for (const line of await order.lines) {
                const [product, priceUnit, discount, taxIdsAfterFiscalPosition, qty, order] = await line('productId', 'priceUnit', 'discount', 'taxIdsAfterFiscalPosition', 'qty', 'orderId');
                const partner = await order.partnerId;
                const key = [product, priceUnit, discount];
                productsSold.setdefault(key, 0.0);
                productsSold.set(key, productsSold.get(key) + qty);
                if (bool(taxIdsAfterFiscalPosition)) {
                    const lineTaxes = await (await taxIdsAfterFiscalPosition.sudo()).computeAll(priceUnit * (1-(discount || 0.0)/100.0), {currency, quantity: qty, product, partner: partner.ok ? partner : false});
                    for (const tax of lineTaxes['taxes']) {
                        setdefault(taxes, tax['id'], {'label': tax['label'], 'taxAmount':0.0, 'baseAmount':0.0});
                        taxes[tax['id']]['taxAmount'] += tax['amount'];
                        taxes[tax['id']]['baseAmount'] += tax['base'];
                    }
                }
                else {
                    setdefault(taxes, '0', {'label': await this._t('No Taxes'), 'taxAmount':0.0, 'baseAmount':0.0});
                    taxes[0]['baseAmount'] += await line.priceSubtotalIncl;
                }
            }
        }

        const paymentIds = (await this.env.items("pos.payment").search([['posOrderId', 'in', orders.ids]])).ids;
        let payments = !bool(paymentIds) ? [] :
            await this.env.cr.execute(`
                SELECT method.label, sum(amount) total
                FROM "posPayment" AS payment,
                     "posPaymentMethod" AS method
                WHERE payment."paymentMethodId" = method.id
                    AND payment.id IN (%s)
                GROUP BY method.label
            `, [String(paymentIds)]);

        const products = await Promise.all(Array.from(productsSold.items()).map(async ([[product, priceUnit, discount], qty]) => { return {
            'productId': product.id,
            'productName': product.label,
            'code': await product.defaultCode,
            'quantity': qty,
            'priceUnit': priceUnit,
            'discount': discount,
            'uom': await (await product.uomId).label
        }}));

        return {
            'currencyPrecision': await userCurrency.decimalPlaces,
            'totalPaid': await userCurrency.round(total),
            'payments': payments,
            'companyName': await (await this.env.company()).label,
            'taxes': Object.values(taxes),
            'products': sorted(products, l => l['productName'])
        }
    }

    @api.model()
    async _getReportValues(docids, data?: any) {
        data = Object.assign({}, data);
        const configs = this.env.items('pos.config').browse(data['configIds']);
        update(data, await this.getSaleDetails(data['dateStart'], data['dateStop'], configs.ids));
        return data;
    }
}

@MetaModel.define()
class AccountCashRounding extends Model {
    static _module = module;
    static _parents = 'account.cash.rounding';

    @api.constrains('rounding', 'roundingMethod', 'strategy')
    async _checkSessionState() {
        const openSession = await this.env.items('pos.session').search([['configId.roundingMethod', 'in', this.ids], ['state', '!=', 'closed']], {limit: 1});
        if (bool(openSession)) {
            throw new ValidationError(
                await this._t("You are not allowed to change the cash rounding configuration while a pos session using it is already opened."));
        }
    }
}