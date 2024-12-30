import { MetaModel, TransientModel } from "../../../core/models"

@MetaModel.define()
class PaymentWizard extends TransientModel {
    static _module = module;
    static _parents = 'payment.acquirer.onboarding.wizard';
    static _name = 'website.sale.payment.acquirer.onboarding.wizard';
    static _description = 'Website Payment acquire onboarding wizard';

    /**
     * Override.
     * @returns 
     */
    async _setPaymentAcquirerOnboardingStepDone() {
        await (await (await this.env.company()).sudo()).setOnboardingStepDone('paymentAcquirerOnboardingState');
    }

    /**
     * Override of payment to set the dashboard as start menu of the payment onboarding.
     * @returns 
     */
    async _startStripeOnboarding() {
        const menuId = (await this.env.ref('website.menuWebsiteDashboard')).id;
        return (await this.env.company())._runPaymentOnboardingStep(menuId);
    }
}
