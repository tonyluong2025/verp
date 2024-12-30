import { Fields, api } from "../../../core";
import { Environment } from "../../../core/api";
import { UserError } from "../../../core/helper";
import { MetaModel, TransientModel } from "../../../core/models"
import { bool } from "../../../core/tools";

@MetaModel.define()
class PaymentWizard extends TransientModel {
    static _module = module;
    static _name = 'payment.acquirer.onboarding.wizard';
    static _description = 'Payment acquire onboarding wizard';

    static paymentMethod = Fields.Selection([
        ['paypal', "PayPal"],
        ['stripe', "Credit card (via Stripe)"],
        ['other', "Other payment acquirer"],
        ['manual', "Custom payment instructions"],
    ], {string: "Payment Method", default: (self)=> self._getDefaultPaymentAcquirerOnboardingValue('paymentMethod')});
    static paypalUserType = Fields.Selection([
        ['newUser', "I don't have a Paypal account"],
        ['existingUser', 'I have a Paypal account']], {string: "Paypal User Type", default: 'newUser'});
    static paypalEmailAccount = Fields.Char("Email", {default: (self) => self._getDefaultPaymentAcquirerOnboardingValue('paypalEmailAccount')});
    static paypalSellerAccount = Fields.Char("Merchant Account ID");
    static paypalPdtToken = Fields.Char("PDT Identity Token", {default: (self) => self._getDefaultPaymentAcquirerOnboardingValue('paypalPdtToken')});

    static stripeSecretKey = Fields.Char({default: (self) => self._getDefaultPaymentAcquirerOnboardingValue('stripeSecretKey')});
    static stripePublishableKey = Fields.Char({default: (self) => self._getDefaultPaymentAcquirerOnboardingValue('stripePublishableKey')});

    static manualName = Fields.Char("Method", {default: (self) => self._getDefaultPaymentAcquirerOnboardingValue('manualName')});
    static journalName = Fields.Char("Bank Name", {default: (self) => self._getDefaultPaymentAcquirerOnboardingValue('journalName')});
    static accNumber = Fields.Char("Account Number", {default: (self)=> self._getDefaultPaymentAcquirerOnboardingValue('accNumber')});
    static manualPostMsg = Fields.Html("Payment Instructions");
    static dataFetched = Fields.Boolean({store: false});

    @api.onchange('journalName', 'accNumber')
    async _setManualPostMsgValue() {
        await this.set('manualPostMsg', await this._t(
            '<h3>Please make a payment to: </h3><ul><li>Bank: %s</li><li>Account Number: %s</li><li>Account Holder: %s</li></ul>',
            await this['journalName'] || this._t("Bank"),
            await this['accNumber'] || this._t("Account"),
            await (await this.env.company()).label
        ));
    }

    _paymentAcquirerOnboardingCache = {}

    async _getManualPaymentAcquirer(env?: any) {
        if (env == null) {
            env = this.env;
        }
        const moduleId = (await env.ref('base.module_paymentTransfer')).id;
        return env.items('payment.acquirer').search([['moduleId', '=', moduleId],
            ['companyId', '=', (await env.company()).id]], {limit: 1});
    }

    async _getDefaultPaymentAcquirerOnboardingValue(key) {
        if (! await this.env.isAdmin()) {
            throw new UserError(await this._t("Only administrators can access this data."));
        }
        if (await this['dataFetched']) {
            return this._paymentAcquirerOnboardingCache[key] ?? '';
        }
        await this.set('dataFetched', true);

        const company = await this.env.company();
        this._paymentAcquirerOnboardingCache['paymentMethod'] = await company.paymentOnboardingPaymentMethod;

        const installedModules = await (await (await this.env.items('ir.module.module').sudo()).search([
            ['label', 'in', ['paymentPaypal', 'paymentStripe']],
            ['state', '=', 'installed'],
        ])).mapped('label');

        if (installedModules.includes('paymentPaypal')) {
            const acquirer = await this.env.items('payment.acquirer').search(
                [['companyId', '=', company.id], ['label', '=', 'PayPal']], {limit: 1}
            );
            this._paymentAcquirerOnboardingCache['paypalEmailAccount'] = acquirer['paypalEmailAccount'] || await (await this.env.user()).email || '';
            this._paymentAcquirerOnboardingCache['paypalPdtToken'] = acquirer['paypalPdtToken'];
        }

        if (installedModules.includes('paymentStripe')) {
            const acquirer = await this.env.items('payment.acquirer').search(
                [['companyId', '=', company.id], ['label', '=', 'Stripe']], {limit: 1}
            );
            this._paymentAcquirerOnboardingCache['stripeSecretKey'] = acquirer['stripeSecretKey'];
            this._paymentAcquirerOnboardingCache['stripePublishableKey'] = acquirer['stripePublishableKey'];
        }
        const manualPayment = await this._getManualPaymentAcquirer();
        const journal = await manualPayment.journalId;

        this._paymentAcquirerOnboardingCache['manualName'] = manualPayment['label'];
        this._paymentAcquirerOnboardingCache['manualPostMsg'] = manualPayment['pendingMsg'];
        this._paymentAcquirerOnboardingCache['journalName'] = await journal.label !== "Bank" ? await journal.label : "";
        this._paymentAcquirerOnboardingCache['accNumber'] = await journal.bankAccNumber;

        return this._paymentAcquirerOnboardingCache[key] ?? '';
    }

    async _installModule(moduleName) {
        const module = await (await this.env.items('ir.module.module').sudo()).search([['label', '=', moduleName]]);
        if (!['installed', 'to install', 'to upgrade'].includes(await module.state)) {
            await module.buttonImmediateInstall();
        }
    }

    async _onSavePaymentAcquirer() {
        await this._installModule('accountPayment');
    }

    /**
     * Install required payment acquiers, configure them and mark the
            onboarding step as done.
     * @returns 
     */
    async addPaymentMethods() {
        const paymentMethod = await this['paymentMethod'];
        if (paymentMethod === 'stripe' && ! await this['stripePublishableKey']) {
            await (await this.env.company()).set('paymentOnboardingPaymentMethod', paymentMethod);
            return this._startStripeOnboarding();
        }

        if (paymentMethod === 'paypal') {
            await this._installModule('paymentPaypal');
        }
        if (paymentMethod === 'stripe') {
            await this._installModule('paymentStripe');
        }
        if (['paypal', 'stripe', 'manual', 'other'].includes(paymentMethod)) {
            await this._onSavePaymentAcquirer();
            const company = await this.env.company();
            await company.set('paymentOnboardingPaymentMethod', paymentMethod);

            // create a new env including the freshly installed module(s)

            const newEnv = await Environment.new(this.env.cr, this.env.uid, this.env.context);
            if (paymentMethod === 'paypal') {
                const acquirer = await newEnv.items('payment.acquirer').search(
                    [['label', '=', 'PayPal'], ['companyId', '=', company.id]], {limit: 1}
                );
                if (!bool(acquirer)) {
                    const baseAcquirer = await this.env.ref('payment.paymentAcquirerPaypal');
                    // Use sudo to access payment acquirer record that can be in different company.
                    const acquirer = await (await baseAcquirer.sudo()).copy(
                        {'companyId': company.id}
                    );
                    await acquirer.set('companyId', company.id);
                }
                const defaultJournal = await newEnv.items('account.journal').search(
                    [['type', '=', 'bank'], ['companyId', '=', (await newEnv.company()).id]], {limit: 1}
                );
                await acquirer.write({
                    'paypalEmailAccount': await this['paypalEmailAccount'],
                    'paypalSellerAccount': await this['paypalSellerAccount'],
                    'paypalPdtToken': await this['paypalPdtToken'],
                    'state': 'enabled',
                    'journalId': bool(await acquirer.journalId) ? await acquirer.journalId : defaultJournal
                });
            }
            if (paymentMethod === 'stripe') {
                await (await newEnv.items('payment.acquirer').search(
                    [['label', '=', 'Stripe'], ['companyId', '=', company.id]], {limit: 1}
                )).write({
                    'stripeSecretKey': await this['stripeSecretKey'],
                    'stripePublishableKey': await this['stripePublishableKey'],
                    'state': 'enabled',
                });
            }
            if (paymentMethod === 'manual') {
                const manualAcquirer = await this._getManualPaymentAcquirer(newEnv);
                if (! bool(manualAcquirer)) {
                    throw new UserError(await this._t(
                        'No manual payment method could be found for this company. '+
                        'Please create one from the Payment Acquirer menu.'
                    ));
                }
                await manualAcquirer.set('label', await this['manualName']);
                await manualAcquirer.set('pendingMsg', await this['manualPostMsg']);
                await manualAcquirer.set('state', 'enabled');

                const journal = await manualAcquirer.journalId;
                if (bool(journal)) {
                    await journal.set('label', await this['journalName']);
                    await journal.set('bankAccNumber', await this['accNumber']);
                }
            }
            // delete wizard data immediately to get rid of residual credentials
            await (await this.sudo()).unlink();
        }
        // the user clicked `apply` and not cancel so we can assume this step is done.
        await this._setPaymentAcquirerOnboardingStepDone();
        return {'type': 'ir.actions.actwindow.close'}
    }

    async _setPaymentAcquirerOnboardingStepDone() {
        await (await (await this.env.company()).sudo()).setOnboardingStepDone('paymentAcquirerOnboardingState');
    }

    async actionOnboardingOtherPaymentAcquirer() {
        await this._setPaymentAcquirerOnboardingStepDone();
        return this.env.items("ir.actions.actions")._forXmlid("payment.actionPaymentAcquirer");
    }

    /**
     * Start Stripe Connect onboarding.
     * @returns 
     */
    async _startStripeOnboarding() {
        const menuId = (await this.env.ref('payment.paymentAcquirerMenu')).id;
        return (await this.env.company())._runPaymentOnboardingStep(menuId);
    }
}