import { api, Fields } from "../../../core";
import { _super, MetaModel, TransientModel } from "../../../core/models"

@MetaModel.define()
class ResConfigSettings extends TransientModel {
    static _module = module;
    static _parents = 'res.config.settings';

    static groupAutoDoneSetting = Fields.Boolean("Lock Confirmed Sales", {impliedGroup: 'sale.groupAutoDoneSetting'});
    static moduleSaleMargin = Fields.Boolean("Margins");
    static quotationValidityDays = Fields.Integer({related: 'companyId.quotationValidityDays', string: "Default Quotation Validity (Days)", readonly: false});
    static useQuotationValidityDays = Fields.Boolean("Default Quotation Validity", {configParameter: 'sale.useQuotationValidityDays'});
    static groupWarningSale = Fields.Boolean("Sale Order Warnings", {impliedGroup: 'sale.groupWarningSale'});
    static portalConfirmationSign = Fields.Boolean({related: 'companyId.portalConfirmationSign', string: 'Online Signature', readonly: false});
    static portalConfirmationPay = Fields.Boolean({related: 'companyId.portalConfirmationPay', string: 'Online Payment', readonly: false});
    static groupSaleDeliveryAddress = Fields.Boolean("Customer Addresses", {impliedGroup: 'sale.groupDeliveryInvoiceAddress'});
    static groupProformaSales = Fields.Boolean({string: "Pro-Forma Invoice", impliedGroup: 'sale.groupProformaSales',
        help: "Allows you to send pro-forma invoice."});
    static defaultInvoicePolicy = Fields.Selection([
        ['order', 'Invoice what is ordered'],
        ['delivery', 'Invoice what is delivered']
        ], {string: 'Invoicing Policy',
        default: 'order',
        defaultModel: 'product.template'});
    static depositDefaultProductId = Fields.Many2one(
        'product.product',
        {string: 'Deposit Product',
        domain: "[['type', '=', 'service']]",
        configParameter: 'sale.defaultDepositProductId',
        help: 'Default product used for payment advances'});

    static authSignupUninvited = Fields.Selection([
        ['b2b', 'On invitation'],
        ['b2c', 'Free sign up'],
    ], {string: 'Customer Account', default: 'b2b', configParameter: 'auth_signup.invitationScope'});

    static moduleDelivery = Fields.Boolean("Delivery Methods");
    static moduleDeliveryDhl = Fields.Boolean("DHL Express Connector");
    static moduleDeliveryFedex = Fields.Boolean("FedEx Connector");
    static moduleDeliveryUps = Fields.Boolean("UPS Connector");
    static moduleDeliveryUsps = Fields.Boolean("USPS Connector");
    static moduleDeliveryEms = Fields.Boolean("Ems Connector");
    static moduleDeliveryEasypost = Fields.Boolean("Easypost Connector");

    static moduleProductEmailTemplate = Fields.Boolean("Specific Email");
    static moduleSaleCoupon = Fields.Boolean("Coupons & Promotions");
    static moduleSaleAmazon = Fields.Boolean("Amazon Sync");

    static automaticInvoice = Fields.Boolean({
        string: "Automatic Invoice",
        help: "The invoice is generated automatically and available in the customer portal when the "+
             "transaction is confirmed by the payment acquirer.\nThe invoice is marked as paid and "+
             "the payment is registered in the payment journal defined in the configuration of the "+
             "payment acquirer.\nThis mode is advised if you issue the final invoice at the order "+
             "and not after the delivery.",
        configParameter: 'sale.automaticInvoice',
    });
    static invoiceMailTemplateId = Fields.Many2one({
        comodelName: 'mail.template',
        string: 'Invoice Email Template',
        domain: "[['model', '=', 'account.move']]",
        configParameter: 'sale.defaultInvoiceEmailTemplate',
        default: self => self.env.ref('account.emailTemplateEdiInvoice', false)
    });
    static confirmationMailTemplateId = Fields.Many2one({
        comodelName: 'mail.template',
        string: 'Confirmation Email Template',
        domain: "[['model', '=', 'sale.order']]",
        configParameter: 'sale.defaultConfirmationTemplate',
        help: "Email sent to the customer once the order is paid."
    });

    async setValues() {
        await _super(ResConfigSettings, this).setValues();
        if (await this['defaultInvoicePolicy'] !== 'order') {
            await this.env.items('ir.config.parameter').setParam('sale.automaticInvoice', false);
        }
        const sendInvoiceCron = await this.env.ref('sale.sendInvoiceCron', false);
        if (sendInvoiceCron) {
            await sendInvoiceCron.set('active', await this['automaticInvoice']);
        }
    }

    @api.onchange('useQuotationValidityDays')
    async _onchangeUseQuotationValidityDays() {
        if (await this['quotationValidityDays'] <= 0) {
            await this.set('quotationValidityDays', (await this.env.items('res.company').defaultGet(['quotationValidityDays']))['quotationValidityDays']);
        }
    }

    @api.onchange('quotationValidityDays')
    async _onchangeQuotationValidityDays() {
        if (await this['quotationValidityDays'] <= 0) {
            await this.set('quotationValidityDays', (await this.env.items('res.company').defaultGet(['quotationValidityDays']))['quotationValidityDays']);
            return {
                'warning': {'title': "Warning", 'message': "Quotation Validity is required and must be greater than 0."},
            }
        }
    }
}
