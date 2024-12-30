import { readFile } from "fs/promises";
import { api, Fields } from "../../../core";
import { _super, MetaModel, Model } from "../../../core/models"
import { getResourcePath } from "../../../core/modules";
import { b64encode, bool, len, update } from "../../../core/tools";

@MetaModel.define()
class ResCompany extends Model {
    static _module = module;
    static _parents = "res.company";

    static portalConfirmationSign = Fields.Boolean({string: 'Online Signature', default: true});
    static portalConfirmationPay = Fields.Boolean({string: 'Online Payment'});
    static quotationValidityDays = Fields.Integer({default: 30, string: "Default Quotation Validity (Days)"});

    // sale quotation onboarding
    static saleQuotationOnboardingState = Fields.Selection([['notDone', "Not done"], ['justDone', "Just done"], ['done', "Done"], ['closed', "Closed"]], {string: "State of the sale onboarding panel", default: 'notDone'});
    static saleOnboardingOrderConfirmationState = Fields.Selection([['notDone', "Not done"], ['justDone', "Just done"], ['done', "Done"]], {string: "State of the onboarding confirmation order step", default: 'notDone'});
    static saleOnboardingSampleQuotationState = Fields.Selection([['notDone', "Not done"], ['justDone', "Just done"], ['done', "Done"]], {string: "State of the onboarding sample quotation step", default: 'notDone'});

    static saleOnboardingPaymentMethod = Fields.Selection([
        ['digitalSignature', 'Sign online'],
        ['paypal', 'PayPal'],
        ['stripe', 'Stripe'],
        ['other', 'Pay with another payment acquirer'],
        ['manual', 'Manual Payment'],
    ], {string: "Sale onboarding selected payment method"});

    /**
     * Mark the onboarding panel as closed.
     */
    @api.model()
    async actionCloseSaleQuotationOnboarding() {
        await (await this.env.company()).set('saleQuotationOnboardingState', 'closed');
    }

    /**
     * Called by onboarding panel above the quotation list.
     * @returns 
     */
    @api.model()
    async actionOpenSaleOnboardingPaymentAcquirer() {
        await (await this.env.company()).getChartOfAccountsOrFail();
        const action = await this.env.items("ir.actions.actions")._forXmlid("sale.actionOpenSaleOnboardingPaymentAcquirerWizard");
        return action;
    }

    /**
     * Override of payment to mark the sale onboarding step as done.

        The payment onboarding step of Sales is only marked as done if it was started from Sales.
        This prevents incorrectly marking the step as done if another module's payment onboarding
        step was marked as done.

        :return: None
     * @returns 
     */
    async _markPaymentOnboardingStepAsDone() {
        await _super(ResCompany, this)._markPaymentOnboardingStepAsDone();
        if (await this['saleOnboardingPaymentMethod']) {  // The onboarding step was started from Sales
            await (this as any).setOnboardingStepDone('saleOnboardingOrderConfirmationState');
        }
    }

    /**
     * Get a sample quotation or create one if it does not exist.
     * @returns 
     */
    async _getSampleSalesOrder() {
        // use current user as partner
        const partner = await (await this.env.user()).partnerId;
        const companyId = (await this.env.company()).id;
        // is there already one?
        const sampleSalesOrder = await this.env.items('sale.order').search(
            [['companyId', '=', companyId], ['partnerId', '=', partner.id],
             ['state', '=', 'draft']], {limit: 1});
        if (len(sampleSalesOrder) == 0) {
            const sampleSalesOrder = await this.env.items('sale.order').create({
                'partnerId': partner.id
            });
            // take any existing product or create one
            let product = await this.env.items('product.product').search([], {limit: 1});
            if (len(product) == 0) {
                const defaultImagePath = getResourcePath('product', 'static/img', 'product_product_13_image.png');
                product = await this.env.items('product.product').create({
                    'label': await this._t('Sample Product'),
                    'active': false,
                    'image1920': b64encode(await readFile(defaultImagePath))
                });
                await (await product.productTemplateId).write({'active': false});
            }
            await this.env.items('sale.order.line').create({
                'label': await this._t('Sample Order Line'),
                'productId': product.id,
                'productUomQty': 10,
                'priceUnit': 123,
                'orderId': sampleSalesOrder.id,
                'companyId': (await sampleSalesOrder.companyId).id,
            });
        }
        return sampleSalesOrder;
    }

    /**
     * Onboarding step for sending a sample quotation. Open a window to compose an email,
            with the ediInvoiceTemplate message loaded by default.
     * @returns 
     */
    @api.model()
    async actionOpenSaleOnboardingSampleQuotation() {
        const sampleSalesOrder = await this._getSampleSalesOrder();
        const template = await this.env.ref('sale.emailTemplateEdiSale', false);

        const messageComposer = await (await this.env.items('mail.compose.message').withContext({
            default_useTemplate: bool(template),
            markSoAsSent: true,
            customLayout: 'mail.mailNotificationPaynow',
            proforma: this.env.context['proforma'] ?? false,
            forceEmail: true, 
            mailNotifyAuthor: true
        })).create({
            'resId': sampleSalesOrder.id,
            'templateId': bool(template) && template.id || false,
            'model': 'sale.order',
            'compositionMode': 'comment'
        });

        // Simulate the onchange (like trigger in form the view)
        const updateValues = (await messageComposer._onchangeTemplateId(template.id, 'comment', 'sale.order', sampleSalesOrder.id))['value'];
        await messageComposer.write(updateValues);

        await messageComposer._actionSendMail();

        await (this as any).setOnboardingStepDone('saleOnboardingSampleQuotationState');

        await this.actionCloseSaleQuotationOnboarding();

        const action = await this.env.items("ir.actions.actions")._forXmlid("sale.actionOrders");
        update(action, {
            'views': [[(await this.env.ref('sale.viewOrderForm')).id, 'form']],
            'viewMode': 'form',
            'target': 'main',
        })
        return action;
    }

    /**
     * This method is called on the controller rendering method and ensures that the animations
            are displayed only one time.
     * @returns 
     */
    async getAndUpdateSaleQuotationOnboardingState() {
        const steps = [
            'baseOnboardingCompanyState',
            'accountOnboardingInvoiceLayoutState',
            'saleOnboardingOrderConfirmationState',
            'saleOnboardingSampleQuotationState',
        ];
        return (this as any).getAndUpdateOnbardingState('saleQuotationOnboardingState', steps);
    }

    static _sqlConstraints = [['check_quotation_validity_days', 'CHECK("quotationValidityDays" > 0)', 'Quotation Validity is required and must be greater than 0.']];
}
