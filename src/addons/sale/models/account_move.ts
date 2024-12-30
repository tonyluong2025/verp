import _ from "lodash";
import { api, Fields } from "../../../core";
import { MapKey, UserError } from "../../../core/helper";
import { _super, MetaModel, Model } from "../../../core/models";
import { bool, isInstance, some, update } from "../../../core/tools";

@MetaModel.define()
class AccountMove extends Model {
    static _module = module;
    static _name = 'account.move';
    static _parents = ['account.move', 'utm.mixin'];

    @api.model()
    async _getInvoiceDefaultSaleTeam() {
        return this.env.items('crm.team')._getDefaultTeamId();
    }

    static teamId = Fields.Many2one(
        'crm.team', {
            string: 'Sales Team', default: self => self._getInvoiceDefaultSaleTeam(),
        ondelete: "SET NULL", tracking: true,
        domain: "['|', ['companyId', '=', false], ['companyId', '=', companyId]]"
    });
    static partnerShippingId = Fields.Many2one(
        'res.partner',
        {
            string: 'Delivery Address',
            readonly: true,
            states: { 'draft': [['readonly', false]] },
            domain: "['|', ['companyId', '=', false], ['companyId', '=', companyId]]",
            help: "Delivery address for current invoice."
        });

    /**
     * Trigger the change of fiscal position when the shipping address is modified.
     */
    @api.onchange('partnerShippingId', 'companyId')
    async _onchangePartnerShippingId() {
        const deliveryPartnerId = await this._getInvoiceDeliveryPartnerId();
        const fiscalPosition = await (await this.env.items('account.fiscal.position').withCompany(await this['companyId'])).getFiscalPosition((await this['partnerId']).id, deliveryPartnerId);

        if (bool(fiscalPosition)) {
            await this.set('fiscalPositionId', fiscalPosition);
        }
    }

    async unlink() {
        const downpaymentLines = await (await this.mapped('lineIds.saleLineIds')).filtered(async (line) => await line.isDownpayment && (await line.invoiceLines).le(await this.mapped('lineIds'))); // <=
        const res = await _super(AccountMove, this).unlink();
        if (bool(downpaymentLines)) {
            await downpaymentLines.unlink();
        }
        return res;
    }

    @api.onchange('partnerId')
    async _onchangePartnerId() {
        // OVERRIDE
        // Recompute 'partnerShippingId' based on 'partnerId'.
        const addr = await (await this['partnerId']).addressGet(['delivery']);
        await this.set('partnerShippingId', addr && addr['delivery']);

        const res = await _super(AccountMove, this)._onchangePartnerId();

        return res;
    }

    @api.onchange('invoiceUserId')
    async onchangeUserId() {
        if (bool(await this['invoiceUserId']) && bool(await (await this['invoiceUserId']).saleTeamId)) {
            await this.set('teamId', this.env.items('crm.team')._getDefaultTeamId((await this['invoiceUserId']).id, [['companyId', '=', (await this['companyId']).id]]));
        }
    }

    async _reverseMoves(defaultValuesList?: any, cancel = false) {
        // OVERRIDE
        if (!bool(defaultValuesList)) {
            defaultValuesList = await this.map(move => { return {} });
        }
        for (const [move, defaultValues] of _.zip([...this], defaultValuesList)) {
            update(defaultValues, {
                'campaignId': (await move.campaignId).id,
                'mediumId': (await move.mediumId).id,
                'sourceId': (await move.sourceId).id,
            });
        }
        return _super(AccountMove, this)._reverseMoves(defaultValuesList, cancel);
    }

    async actionPost() {
        // inherit of the function from account.move to validate a new tax and the priceunit of a downpayment
        const res = await _super(AccountMove, this).actionPost();
        const lineIds = await (await this.mapped('lineIds')).filtered(async (line) => some(await (await line.saleLineIds).mapped('isDownpayment')));
        for (const line of lineIds) {
            try {
                line.sale_line_ids.taxId = line.tax_ids
                line.sale_line_ids.priceUnit = line.priceUnit
            } catch (e) {
                if (!isInstance(e, UserError)) {
                    // a UserError here means the SO was locked, which prevents changing the taxes
                    // just ignore the error - this is a nice to have feature and should not be blocking
                    throw e;
                }
            }
        }
        return res;
    }

    async _post(soft = true) {
        // OVERRIDE
        // Auto-reconcile the invoice with payments coming from transactions.
        // It's useful when you have a "paid" sale order (using a payment transaction) and you invoice it later.
        const posted = await _super(AccountMove, this)._post(soft);

        for (const invoice of await posted.filtered((move) => move.isInvoice())) {
            const payments = await (await invoice.mapped('transactionIds.paymentId')).filtered(async (x) => await x.state === 'posted');
            const moveLines = await (await payments.lineIds).filtered(async (line) => ['receivable', 'payable'].includes(await line.accountInternalType) && ! await line.reconciled);
            for (const line of moveLines) {
                await invoice.jsAssignOutstandingLine(line.id);
            }
        }
        return posted;
    }

    async actionInvoicePaid() {
        // OVERRIDE
        const res = await _super(AccountMove, this).actionInvoicePaid();
        const todo = new MapKey<any, any>(([order, label]) => String([order.id, label]));
        for (const invoice of await this.filtered(move => move.isInvoice())) {
            for (const line of await invoice.invoiceLineIds) {
                for (const saleLine of await line.saleLineIds) {
                    todo.set([await saleLine.orderId, await invoice.label], null);
                }
            }
        }
        for (const [order, label] of todo.keys()) {
            await order.messagePost({ body: await this._t("Invoice %s paid", label) });
        }
        return res;
    }

    async _getInvoiceDeliveryPartnerId() {
        // OVERRIDE
        this.ensureOne();
        const id = (await this['partnerShippingId']).id;
        return bool(id) ? id : await _super(AccountMove, this)._getInvoiceDeliveryPartnerId();
    }

    async _actionInvoiceReadyToBeSent() {
        // OVERRIDE
        // Make sure the send invoice CRON is called when an invoice becomes ready to be sent by mail.
        const res = await _super(AccountMove, this)._actionInvoiceReadyToBeSent();

        const sendInvoiceCron = await this.env.ref('sale.sendInvoiceCron', false);
        if (sendInvoiceCron) {
            await sendInvoiceCron._trigger();
        }

        return res;
    }

    async _isDownpayment() {
        // OVERRIDE
        this.ensureOne();
        const saleLineIds = await (await this['lineIds']).saleLineIds;
        return bool(saleLineIds) && await saleLineIds.every(saleLine => saleLine.isDownpayment) || false;
    }
}