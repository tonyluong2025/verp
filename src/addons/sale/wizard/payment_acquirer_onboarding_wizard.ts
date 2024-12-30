import { Fields } from "../../../core";
import { _super, MetaModel, TransientModel } from "../../../core/models"

/**
 * Override for the sale quotation onboarding panel.
 */
@MetaModel.define()
class PaymentWizard extends TransientModel {
    static _module = module;
    static _parents = 'payment.acquirer.onboarding.wizard';
    static _name = 'sale.payment.acquirer.onboarding.wizard';
    static _description = 'Sale Payment acquire onboarding wizard';

    async _getDefaultPaymentMethod() {
        return await (await this.env.company()).saleOnboardingPaymentMethod || 'digitalSignature';
    }

    static paymentMethod = Fields.Selection({selectionAdd: [
        ['digitalSignature', "Electronic signature"],
        ['stripe', "Credit & Debit card (via Stripe)"],
        ['paypal', "PayPal"],
        ['other', "Other payment acquirer"],
        ['manual', "Custom payment instructions"],
    ], default: self => self._getDefaultPaymentMethod()});

    /**
     * Override.
     */
    async _setPaymentAcquirerOnboardingStepDone() {
        await (await (await this.env.company()).sudo()).setOnboardingStepDone('saleOnboardingOrderConfirmationState');
    }

    async addPaymentMethods(opts) {
        const company = await this.env.company();
        await company.set('saleOnboardingPaymentMethod', await this['paymentMethod']);
        if (await this['paymentMethod'] === 'digitalSignature') {
            await company.set('portalConfirmationSign', true);
        }
        if (['paypal', 'stripe', 'other', 'manual'].includes(this['paymentMethod'])) {
            await company.set('portalConfirmationPay', true);
        }

        return _super(PaymentWizard, this).addPaymentMethods(opts);
    }

    /**
     * Override of payment to set the sale menu as start menu of the payment onboarding.
     * @returns 
     */
    async _startStripeOnboarding() {
        const menuId = (await this.env.ref('sale.saleMenuRoot')).id
        return (await this.env.company())._runPaymentOnboardingStep(menuId);
    }
}