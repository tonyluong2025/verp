import { Fields, api } from "../../../core";
import { Environment } from "../../../core/api";
import { MetaModel, Model, _super } from "../../../core/models"
import { bool } from "../../../core/tools";

@MetaModel.define()
class ResCompany extends Model {
    static _module = module;
    static _parents = 'res.company';

    static paymentAcquirerOnboardingState = Fields.Selection({
        string: "State of the onboarding payment acquirer step",
        selection: [['notDone', "Not done"], ['justDone', "Just done"], ['done', "Done"]],
        default: 'notDone'});
    static paymentOnboardingPaymentMethod = Fields.Selection({
        string: "Selected onboarding payment method",
        selection: [
            ['paypal', "PayPal"],
            ['stripe', "Stripe"],
            ['manual', "Manual"],
            ['other', "Other"],
        ]});

    /**
     * 
     * @returns Called by onboarding panel above the customer invoice list.
     */
    @api.model()
    async actionOpenPaymentOnboardingPaymentAcquirer() {
        // TODO remove me in master.
        //  This action is never used anywhere because the onboarding step's method is overridden in
        //  website_sale to call actionOpenWebsiteSaleOnboardingPaymentAcquirer instead.
        // Fail if there are no existing accounts
        (await this.env.company()).getChartOfAccountsOrFail();

        const action = await this.env.items('ir.actions.actions')._forXmlid(
            'payment.actionOpenPaymentOnboardingPaymentAcquirerWizard'
        );
        return action;
    }

    /**
     * Install the suggested payment modules and configure the acquirers.

        It's checked that the current company has a Chart of Account.

        :param int menuId: The menu from which the user started the onboarding step, as an
                            `ir.ui.menu` id
        :return: The action returned by `action_stripe_connect_account`
        :rtype: dict
     * @param menuId 
     */
    async _runPaymentOnboardingStep(menuId) {
        await (await this.env.company()).getChartOfAccountsOrFail();

        await this._installModules(['payment_stripe', 'account_payment']);

        // Create a new env including the freshly installed module(s)
        const newEnv = await Environment.new(this.env.cr, this.env.uid, this.env.context);

        // Configure Stripe
        const defaultJournal = await newEnv.items('account.journal').search(
            [['type', '=', 'bank'], ['companyId', '=', (await newEnv.company()).id]], {limit: 1}
        );

        const companyId = (await this.env.company()).id;
        const stripeAcquirer = await newEnv.items('payment.acquirer').search(
            [['companyId', '=', companyId], ['label', '=', 'Stripe']], {limit: 1}
        );
        if (! bool(stripeAcquirer)) {
            const baseAcquirer = await this.env.ref('payment.paymentAcquirerStripe');
            // Use sudo to access payment acquirer record that can be in different company.
            const stripeAcquirer = await (await baseAcquirer.sudo()).copy({'companyId': (await this.env.company()).id});
            await stripeAcquirer.set('companyId', companyId);
        }
        const journal = await stripeAcquirer.journalId;
        if (!bool(journal)) {
            await stripeAcquirer.set('journalId', defaultJournal);
        }
        return stripeAcquirer.actionStripeConnectAccount(menuId);
    }

    async _installModules(moduleNames) {
        const modulesSudo = await (await this.env.items('ir.module.module').sudo()).search([['label', 'in', moduleNames]]);
        const states = ['installed', 'to install', 'to upgrade'];
        await (await modulesSudo.filtered(async (m)=> !states.includes(await m.state))).buttonImmediateInstall();
    }

    /**
     * Mark the payment onboarding step as done.

        :return: None
     * @returns 
     */
    async _markPaymentOnboardingStepAsDone() {
        await (this as any).setOnboardingStepDone('paymentAcquirerOnboardingState');
    }

    /**
     * Override of account.
     * @returns 
     */
    getAccountInvoiceOnboardingStepsStatesNames() {
        const steps = _super(ResCompany, this).getAccountInvoiceOnboardingStepsStatesNames();
        return steps.concat(['paymentAcquirerOnboardingState']);
    }
}