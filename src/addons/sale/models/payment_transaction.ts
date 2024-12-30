import { api, Fields } from "../../../core";
import { _super, MetaModel, Model } from "../../../core/models"
import { bool, f, len, parseInt, subDate } from "../../../core/tools";

@MetaModel.define()
class PaymentTransaction extends Model {
    static _module = module;
    static _parents = 'payment.transaction';

    static saleOrderIds = Fields.Many2many('sale.order', {relation: 'saleOrderTransactionRel', column1: 'transactionId', column2: 'saleOrderId', string: 'Sales Orders', copy: false, readonly: true});
    static saleOrderIdsNbr = Fields.Integer({compute: '_computeSaleOrderIdsNbr', string: '# of Sales Orders'});

    async _computeSaleOrderReference(order) {
        this.ensureOne();
        if (await (await this['acquirerId']).soReferenceType === 'soName') {
            return order.label;
        }
        else {
            // self.acquirerId.soReferenceType == 'partner'
            const identificationNumber = (await order.partnerId).id;
            return f('%s/%s', 'CUST', String(identificationNumber % 97).padStart(2, '0'));
        }
    }

    @api.depends('saleOrderIds')
    async _computeSaleOrderIdsNbr() {
        for (const trans of this) {
            await trans.set('saleOrderIdsNbr', len(await trans.saleOrderIds));
        }
    }

    /**
     * Override of payment to send the quotations automatically.
     * @param stateMessage 
     */
    async _setPending(stateMessage?: any) {
        await _super(PaymentTransaction, this)._setPending(stateMessage);

        for (const record of this) {
            const salesOrders = await (await record.saleOrderIds).filtered(async (so) => ['draft', 'sent'].includes(so.state));
            await (await (await salesOrders.filtered(async (so) => await so.state === 'draft')).withContext({trackingDisable: true})).write({'state': 'sent'});

            if (await (await record.acquirerId).provider === 'transfer') {
                for (const so of await record.saleOrderIds) {
                    await so.set('reference', await record._computeSaleOrderReference(so));
                }
            }
            // send order confirmation mail
            await salesOrders._sendOrderConfirmationMail();
        }
    }

    async _checkAmountAndConfirmOrder() {
        this.ensureOne();
        for (const order of await (await this['saleOrderIds']).filtered(async (so) => ['draft', 'sent'].includes(await so.state))) {
            if (await (await order.currencyId).compareAmounts(await this['amount'], await order.amountTotal) == 0) {
                await (await order.withContext({sendEmail: true})).actionConfirm();
            }
            else {
                console.warn(
                    '<%s> transaction AMOUNT MISMATCH for order %s (ID %s): expected %s, got %s',
                    await (await this['acquirerId']).provider, await order.label, order.id,
                    await order.amountTotal, await this['amount'],
                );
                await order.messagePost({
                    subject: await this._t("Amount Mismatch (%s)", await (await this['acquirerId']).provider),
                    body: await this._t("The order was not confirmed despite response from the acquirer (%s): order total is %s but acquirer replied with %s.",
                        await (await this['acquirerId']).provider,
                        await order.amountTotal,
                        await this['amount'],
                    )
                });
            }
        }
    }

    /**
     * Override of payment to confirm the quotations automatically.
     * @param stateMessage 
     * @returns 
     */
    async _setAuthorized(stateMessage?: any) {
        await _super(PaymentTransaction, this)._setAuthorized(stateMessage);
        const salesOrders = await (await this.mapped('saleOrderIds')).filtered(async (so) => ['draft', 'sent'].includes(await so.state));
        for (const tx of this) {
            await tx._checkAmountAndConfirmOrder();
        }
        // send order confirmation mail
        await salesOrders._sendOrderConfirmationMail();
    }

    /**
     * Override of payment to log a message on the sales orders linked to the transaction.

        Note: this.ensureOne()

        :param str message: The message to be logged
        :return: None
     * @param message 
     */
    async _logMessageOnLinkedDocuments(message) {
        await _super(PaymentTransaction, this)._logMessageOnLinkedDocuments(message);
        for (const order of await this['saleOrderIds']) {
            await order.messagePost({body: message});
        }
    }

    /**
     * Override of payment to automatically confirm quotations and generate invoices.
     * @returns 
     */
    async _reconcileAfterDone() {
        const draftOrders = await (await this['saleOrderIds']).filtered(async (so) => ['draft', 'sent'].includes(await so.state));
        for (const tx of this) {
            await tx._checkAmountAndConfirmOrder();
        }
        const confirmedSalesOrders = await draftOrders.filtered(async (so) => ['sale', 'done'].includes(await so.state));
        // send order confirmation mail
        await confirmedSalesOrders._sendOrderConfirmationMail();
        // invoice the sale orders if needed
        await this._invoiceSaleOrders();
        const res = await _super(PaymentTransaction, this)._reconcileAfterDone();
        if (await (await this.env.items('ir.config.parameter').sudo()).getParam('sale.automaticInvoice') && await (await this['saleOrderIds']).some(async (so) => ['sale', 'done'].includes(await so.state))) {
            await (await this.filtered(async (t) => await (await t['saleOrderIds']).filtered(async (so) => ['sale', 'done'].includes(await so.state))))._sendInvoice();
        }
        return res;
    }

    async _sendInvoice() {
        const defaultTemplate = await (await this.env.items('ir.config.parameter').sudo()).getParam('sale.defaultInvoiceEmailTemplate');
        if (! defaultTemplate) {
            return;
        }

        const templateId = parseInt(defaultTemplate);
        const template = this.env.items('mail.template').browse(templateId);
        for (let trans of this) {
            trans = await (await trans.withCompany(await (await trans.acquirerId).companyId)).withContext(
                {companyId: (await (await trans.acquirerId).companyId).id}
            );
            const invoiceToSend = await (await trans.invoiceIds).filtered(
                async (i) => ! await i.isMoveSent && await i.state === 'posted' && await i._isReadyToBeSent()
            );
            await invoiceToSend.set('isMoveSent', true); // Mark invoice as sent
            for (const invoice of invoiceToSend) {
                const lang = (await template._renderLang(invoice.ids))[invoice.id];
                const modelDesc = await (await invoice.withContext({lang})).typeName;
                await (await (await invoice.withContext({modelDescription: modelDesc})).withUser(
                    global.SUPERUSER_ID
                )).messagePostWithTemplate(templateId, {emailLayoutXmlid: 'mail.mailNotificationPaynow'});
            }
        }
    }

    /**
     * Cron to send invoice that where not ready to be send directly after posting
     */
    async _cronSendInvoice() {
        if (! await (await this.env.items('ir.config.parameter').sudo()).getParam('sale.automaticInvoice')) {
            return;
        }

        // No need to retrieve old transactions
        const retryLimitDate = subDate(new Date(), {days: 2});
        // Retrieve all transactions matching the criteria for post-processing
        await (await this.search([
            ['state', '=', 'done'],
            ['isPostProcessed', '=', true],
            ['invoiceIds', 'in', await this.env.items('account.move')._search([
                ['isMoveSent', '=', false],
                ['state', '=', 'posted'],
            ])],
            ['saleOrderIds.state', 'in', ['sale', 'done']],
            ['lastStateChange', '>=', retryLimitDate],
        ]))._sendInvoice();
    }

    async _invoiceSaleOrders() {
        if (await (await this.env.items('ir.config.parameter').sudo()).getParam('sale.automaticInvoice')) {
            for (let trans of await this.filtered(t => t.saleOrderIds)) {
                trans = await (await trans.withCompany(await (await trans.acquirerId).companyId))
                    .withContext({companyId: (await (await trans.acquirerId).companyId).id});
                const confirmedOrders = await (await trans.saleOrderIds).filtered(async (so) => ['sale', 'done'].includes(await so.state));
                if (bool(confirmedOrders)) {
                    await confirmedOrders._forceLinesToInvoicePolicyOrder();
                    const invoices = await confirmedOrders._createInvoices();
                    // Setup access token in advance to avoid serialization failure between
                    // edi postprocessing of invoice and displaying the sale order on the portal
                    for (const invoice of invoices) {
                        await invoice._portalEnsureToken();
                    }
                    await trans.set('invoiceIds', [[6, 0, invoices.ids]]);
                }
            }
        }
    }

    /**
     * Override of payment to compute the reference prefix based on Sales-specific values.

        If the `values` parameter has an entry with 'sale_order_ids' as key and a list of (4, id, O)
        or (6, 0, ids) X2M command as value, the prefix is computed based on the sales order name(s)
        Otherwise, the computation is delegated to the super method.

        :param str provider: The provider of the acquirer handling the transaction
        :param str separator: The custom separator used to separate data references
        :param dict values: The transaction values used to compute the reference prefix. It should
                            have the structure {'saleOrderIds': [(X2M command), ...], ...}.
        :return: The computed reference prefix if order ids are found, the one of `super` otherwise
        :rtype: str
     * @param provider 
     * @param separator 
     * @param values 
     * @returns 
     */
    @api.model()
    async _computeReferencePrefix(provider, separator, values: {}={}) {
        const commandList = values['saleOrderIds'];
        if (bool(commandList)) {
            // Extract sales order id(s) from the X2M commands
            const orderIds = await this._fields['saleOrderIds'].convertToCache(commandList, this);
            const orders = await this.env.items('sale.order').browse(orderIds).exists();
            if (len(orders) == len(orderIds)) {  // All ids are valid
                return (await orders.mapped('label')).join(separator);
            }
        }
        return _super(PaymentTransaction, this)._computeReferencePrefix(provider, separator, values);
    }

    async actionViewSalesOrders() {
        const action = {
            'label': await this._t('Sales Order(s)'),
            'type': 'ir.actions.actwindow',
            'resModel': 'sale.order',
            'target': 'current',
        }
        const saleOrderIds = (await this['saleOrderIds']).ids;
        if (len(saleOrderIds) == 1) {
            action['resId'] = saleOrderIds[0];
            action['viewMode'] = 'form';
        }
        else {
            action['viewMode'] = 'tree,form';
            action['domain'] = [['id', 'in', saleOrderIds]];
        }
        return action;
    }
}