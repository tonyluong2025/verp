import { Fields, api } from "../../../core";
import { getattr } from "../../../core/api";
import { UserError, ValidationError } from "../../../core/helper";
import { MetaModel, Model, _super } from "../../../core/models"
import { expression } from "../../../core/osv";
import { bool } from "../../../core/tools";

@MetaModel.define()
class PaymentAcquirer extends Model {
    static _module = module;
    static _name = 'payment.acquirer';
    static _description = 'Payment Acquirer';
    static _order = 'moduleState, state desc, sequence, label';

    _validFieldParameter(field, name) {
        return name == 'requiredIfProvider' || _super(PaymentAcquirer, this)._validFieldParameter(field, name);
    }

    // Configuration fields
    static label = Fields.Char({string: "Name", required: true, translate: true});
    static sequence = Fields.Integer({string: "Sequence", help: "Define the display order"});
    static provider = Fields.Selection({
        string: "Provider", help: "The Payment Service Provider to use with this acquirer",
        selection: [['none', "No Provider Set"]], default: 'none', required: true});
    static state = Fields.Selection({
        string: "State",
        help: "In test mode, a fake payment is processed through a test payment interface.\n"+
             "This mode is advised when setting up the acquirer.",
        selection: [['disabled', "Disabled"], ['enabled', "Enabled"], ['test', "Test Mode"]],
        default: 'disabled', required: true, copy: false});
    static companyId = Fields.Many2one(  // Indexed to speed-up ORM searches (from ir_rule or others)
        {string: "Company", comodelName: 'res.company', default: async (self) => (await self.env.company()).id,
        required: true, index: true});
    static paymentIconIds = Fields.Many2many({
        string: "Supported Payment Icons", comodelName: 'payment.icon'});
    static allowTokenization = Fields.Boolean({
        string: "Allow Saving Payment Methods",
        help: "This controls whether customers can save their payment methods as payment tokens.\n"+
             "A payment token is an anonymous link to the payment method details saved in the\n"+
             "acquirer's database, allowing the customer to reuse it for a next purchase."});
    static captureManually = Fields.Boolean({
        string: "Capture Amount Manually",
        help: "Capture the amount from Verp, when the delivery is completed.\n"+
             "Use this if you want to charge your customers cards only when\n"+
             "you are sure you can ship the goods to them."});
    static redirectFormViewId = Fields.Many2one({
        string: "Redirect Form Template", comodelName: 'ir.ui.view',
        help: "The template rendering a form submitted to redirect the user when making a payment",
        domain: [['type', '=', 'qweb']]});
    static inlineFormViewId = Fields.Many2one({
        string: "Inline Form Template", comodelName: 'ir.ui.view',
        help: "The template rendering the inline payment form when making a direct payment",
        domain: [['type', '=', 'qweb']]});
    static countryIds = Fields.Many2many({
        string: "Countries", comodelName: 'res.country', relation: 'paymentCountryRel',
        column1: 'paymentId', column2: 'countryId',
        help: "The countries for which this payment acquirer is available.\n"+
             "If none is set, it is available for all countries."});
    static journalId = Fields.Many2one({
        string: "Payment Journal", comodelName: 'account.journal',
        compute: '_computeJournalId', inverse: '_inverseJournalId',
        help: "The journal in which the successful transactions are posted",
        domain: "[['type', '=', 'bank'], ['companyId', '=', companyId]]"});

    // Fees fields
    static feesActive = Fields.Boolean({string: "Add Extra Fees"});
    static feesDomFixed = Fields.Float({string: "Fixed domestic fees"});
    static feesDomVar = Fields.Float({string: "Variable domestic fees (in percents)"});
    static feesIntFixed = Fields.Float({string: "Fixed international fees"});
    static feesIntVar = Fields.Float({string: "Variable international fees (in percents)"});

    // Message fields
    static displayAs = Fields.Char({
        string: "Displayed as", help: "Description of the acquirer for customers",
        translate: true});
    static preMsg = Fields.Html({
        string: "Help Message", help: "The message displayed to explain and help the payment process",
        translate: true});
    static pendingMsg = Fields.Html({
        string: "Pending Message",
        help: "The message displayed if the order pending after the payment process",
        default: self => self._t(
            "Your payment has been successfully processed but is waiting for approval."
        ), translate: true});
    static authMsg = Fields.Html({
        string: "Authorize Message", help: "The message displayed if payment is authorized",
        default: self => self._t("Your payment has been authorized."), translate: true});
    static doneMsg = Fields.Html({
        string: "Done Message",
        help: "The message displayed if the order is successfully done after the payment process",
        default: self => self._t("Your payment has been successfully processed. Thank you!"),
        translate: true});
    static cancelMsg = Fields.Html({
        string: "Canceled Message",
        help: "The message displayed if the order is canceled during the payment process",
        default: self => self._t("Your payment has been cancelled."), translate: true});

    // Feature support fields
    static supportAuthorization = Fields.Boolean({string: "Authorize Mechanism Supported"});
    static supportFeesComputation = Fields.Boolean({string: "Fees Computation Supported"});
    static supportTokenization = Fields.Boolean({string: "Tokenization Supported"});
    static supportRefund = Fields.Selection({
        string: "Type of Refund Supported",
        selection: [['fullOnly', "Full Only"], ['partial', "Partial"]],
    });

    // Kanban view fields
    static description = Fields.Html({
        string: "Description", help: "The description shown in the card in kanban view "});
    static image128 = Fields.Image({string: "Image", maxWidth: 128, maxHeight: 128});
    static color = Fields.Integer({
        string: "Color", help: "The color of the card in kanban view", compute: '_computeColor',
        store: true});

    // Module-related fields
    static moduleId = Fields.Many2one({string: "Corresponding Module", comodelName: 'ir.module.module'});
    static moduleState = Fields.Selection({
        string: "Installation State", related: 'moduleId.state', store: true});  // Stored for sorting
    static moduleToBuy = Fields.Boolean({string: "Verp Enterprise Module", related: 'moduleId.toBuy'});

    // View configuration fields
    static showCredentialsPage = Fields.Boolean({compute: '_computeViewConfigurationFields'});
    static showAllowTokenization = Fields.Boolean({compute: '_computeViewConfigurationFields'});
    static showPaymentIconIds = Fields.Boolean({compute: '_computeViewConfigurationFields'});
    static showPreMsg = Fields.Boolean({compute: '_computeViewConfigurationFields'});
    static showPendingMsg = Fields.Boolean({compute: '_computeViewConfigurationFields'});
    static showAuthMsg = Fields.Boolean({compute: '_computeViewConfigurationFields'});
    static showDoneMsg = Fields.Boolean({compute: '_computeViewConfigurationFields'});
    static showCancelMsg = Fields.Boolean({compute: '_computeViewConfigurationFields'});

    //=== COMPUTE METHODS ===#

    /**
     * Update the color of the kanban card based on the state of the acquirer.
        :return: None
     * @returns 
     */
    @api.depends('state', 'moduleState')
    async _computeColor() {
        for (const acquirer of this) {
            const state = await acquirer.state;
            if (bool(await acquirer.moduleId) && await acquirer.moduleState !== 'installed') {
                await acquirer.set('color', 4);  // blue
            }
            else if (state === 'disabled') {
                await acquirer.set('color', 3);  // yellow
            }
            else if (state === 'test') {
                await acquirer.set('color', 2);  // orange
            }
            else if (state == 'enabled') {
                await acquirer.set('color', 7);  // green
            }
        }
    }

    /**
     * Compute view configuration fields based on the provider.

        By default, all fields are set to `true`.
        For an acquirer to hide generic elements (pages, fields) in a view, it must override this
        method and set their corresponding view configuration field to `false`.

        :return: None
     * @returns 
     */
    @api.depends('provider')
    async _computeViewConfigurationFields() {
        await this.update({
            'showCredentialsPage': true,
            'showAllowTokenization': true,
            'showPaymentIconIds': true,
            'showPreMsg': true,
            'showPendingMsg': true,
            'showAuthMsg': true,
            'showDoneMsg': true,
            'showCancelMsg': true,
        });
    }

    async _computeJournalId() {
        for (const acquirer of this) {
            const paymentMethod = await this.env.items('account.payment.method.line').search([
                ['journalId.companyId', '=', (await acquirer.companyId).id],
                ['code', '=', await acquirer.provider]
            ], {limit: 1});
            if (bool(paymentMethod)) {
                await acquirer.set('journalId', await paymentMethod.journalId);
            }
            else {
                await acquirer.set('journalId', false);
            }
        }
    }

    async _inverseJournalId() {
        for (const acquirer of this) {
            const [journal, company, provider] = await acquirer('journalId', 'companyId', 'provider');
            const paymentMethodLine = await this.env.items('account.payment.method.line').search([
                ['journalId.companyId', '=', company.id],
                ['code', '=', provider]
            ], {limit: 1});
            if (bool(journal)) {
                if (! bool(paymentMethodLine)) {
                    const defaultPaymentMethodId = await acquirer._getDefaultPaymentMethodId();
                    const existingPaymentMethodLine = await this.env.items('account.payment.method.line').search([
                        ['paymentMethodId', '=', defaultPaymentMethodId],
                        ['journalId', '=', journal.id]
                    ], {limit: 1})
                    if (! bool(existingPaymentMethodLine)) {
                        await this.env.items('account.payment.method.line').create({
                            'paymentMethodId': defaultPaymentMethodId,
                            'journalId': journal.id,
                        });
                    }
                }
                else {
                    await paymentMethodLine.set('journalId', journal);
                }
            }
            else if (bool(paymentMethodLine)) {
                await paymentMethodLine.unlink();
            }
        }
    }

    async _getDefaultPaymentMethodId() {
        this.ensureOne();
        return (await this.env.ref('account.accountPaymentMethodManualIn')).id;
    }

    //=== CONSTRAINT METHODS ===#

    /**
     * Check that variable fees are within realistic boundaries.

        Variable fees values should always be positive and below 100% to respectively avoid negative
        and infinite (division by zero) fees amount.

        :return None
     * @returns 
     */
    @api.constrains('feesDomVar', 'feesIntVar')
    async _checkFeeVarWithinBoundaries() {
        for (const acquirer of this) {
            if ((await acquirer('feesDomVar', 'feesIntVar')).some(fee => !(0 <= fee && fee < 100))) {
                throw new ValidationError(await this._t("Variable fees must always be positive and below 100%."));
            }
        }
    }

    //=== CRUD METHODS ===#

    @api.modelCreateMulti()
    async create(valuesList) {
        const acquirers = await _super(PaymentAcquirer, this).create(valuesList);
        await acquirers._checkRequiredIfProvider();
        return acquirers;
    }

    async write(values) {
        const result = await _super(PaymentAcquirer, this).write(values);
        await this._checkRequiredIfProvider();
        return result;
    }

    /**
     * Check that acquirer-specific required fields have been filled.

        The fields that have the `required_if_provider="<provider>"` attribute are made required
        for all payment.acquirer records with the `provider` field equal to <provider> and with the
        `state` field equal to 'enabled' or 'test'.
        Acquirer-specific views should make the form fields required under the same conditions.

        :return: None
        :raise ValidationError: if an acquirer-specific required field is empty
     * @returns 
     */
    async _checkRequiredIfProvider() {
        const fieldNames = [];
        const enabledAcquirers = await this.filtered(async (acq) => ['enabled', 'test'].includes(await acq.state));
        for (const [name, field] of this._fields) {
            const requiredProvider = getattr(field, 'requiredIfProvider', null);
            if (requiredProvider && await enabledAcquirers.some(async (acquirer) => requiredProvider.eq(await acquirer.provider) && !bool(await acquirer[name]))
            ) {
                const irField = await this.env.items('ir.model.fields')._get(this._name, name);
                fieldNames.push(await irField.fieldDescription);
            }
        }
        if (fieldNames.length) {
            throw new ValidationError(
                await this._t("The following fields must be filled: %s", String(fieldNames))
            );
        }
    }

    /**
     * Prevent the deletion of the payment acquirer if it has an xmlid.
     */
    @api.ondelete(false)
    async _unlinkExceptMasterData() {
        const externalIds = await this.getExternalId();
        for (const acquirer of this) {
            const externalId = externalIds[acquirer.id];
            if (bool(externalId) && ! await externalId.startsWith('__export__')) {
                throw new UserError(
                    await this._t("You cannot delete the payment acquirer %s; archive it instead.", await acquirer.label)
                );
            }
        }
    }

    //=== ACTION METHODS ===#

    /**
     * Install the acquirer's module and reload the page.

        Note: this.ensureOne()

        :return: The action to reload the page
        :rtype: dict
     * @returns 
     */
    async buttonImmediateInstall() {
        const moduleId = await this['moduleId'];
        if (bool(moduleId) && await this['moduleState'] !== 'installed') {
            await moduleId.buttonImmediateInstall();
            return {
                'type': 'ir.actions.client',
                'tag': 'reload',
            }
        }
    }

    //=== BUSINESS METHODS ===#

    /**
     * Select and return the acquirers matching the criteria.

        The base criteria are that acquirers must not be disabled, be in the company that is
        provided, and support the country of the partner if it exists.

        :param int companyId: The company to which acquirers must belong, as a `res.company` id
        :param int partnerId: The partner making the payment, as a `res.partner` id
        :param int currencyId: The payment currency if known beforehand, as a `res.currency` id
        :param bool forceTokenization: Whether only acquirers allowing tokenization can be matched
        :param bool isValidation: Whether the operation is a validation
        :param dict kwargs: Optional data. This parameter is not used here
        :return: The compatible acquirers
        :rtype: recordset of `payment.acquirer`
     * @param companyId 
     * @param partnerId 
     * @param opts 
     * @returns 
     */
    @api.model()
    async _getCompatibleAcquirers(
        companyId: number, partnerId: number, opts: {currencyId?: number, forceTokenization?: boolean,
        isValidation?: boolean}={}
    ) {
        // Compute the base domain for compatible acquirers
        let domain = ['&', ['state', 'in', ['enabled', 'test']], ['companyId', '=', companyId]];

        // Handle partner country
        const partner = this.env.items('res.partner').browse(partnerId);
        if (bool(await partner.countryId)) {  // The partner country must either not be set or be supported
            domain = expression.AND([
                domain,
                ['|', ['countryIds', '=', false], ['countryIds', 'in', [(await partner.countryId).id]]]
            ]);
        }

        // Handle tokenization support requirements
        if (opts.forceTokenization || await this._isTokenizationRequired(opts)) {
            domain = expression.AND([domain, [['allowTokenization', '=', true]]]);
        }
        const compatibleAcquirers = await this.env.items('payment.acquirer').search(domain);
        return compatibleAcquirers;
    }

    /**
     * Return whether tokenizing the transaction is required given its context.

        For a module to make the tokenization required based on the transaction context, it must
        override this method and return whether it is required.

        :param str provider: The provider of the acquirer handling the transaction
        :param dict kwargs: The transaction context. This parameter is not used here
        :return: Whether tokenizing the transaction is required
        :rtype: bool
     * @param opts 
     * @returns 
     */
    @api.model()
    async _isTokenizationRequired(opts: {}={}) {
        return false;
    }

    /**
     * Return whether the inline form should be instantiated if it exists.

        For an acquirer to handle both direct payments and payment with redirection, it should
        override this method and return whether the inline form should be instantiated (i.e. if the
        payment should be direct) based on the operation (online payment or validation).

        :param bool is_validation: Whether the operation is a validation
        :return: Whether the inline form should be instantiated
        :rtype: bool
     * @param isValidation 
     * @returns 
     */
    async _shouldBuildInlineForm(isValidation=false) {
        return true;
    }

    /**
     * Compute the transaction fees.

        The computation is based on the generic fields `feesDomFixed`, `feesDomVar`,
        `feesIntFixed` and `feesIntVar` and is done according to the following formula:

        `fees = (amount * variable / 100.0 + fixed) / (1 - variable / 100.0)` where the value
        of `fixed` and `variable` is taken either from the domestic (dom) or international (int)
        field depending on whether the country matches the company's country.

        For an acquirer to base the computation on different variables, or to use a different
        formula, it must override this method and return the resulting fees as a float.

        :param float amount: The amount to pay for the transaction
        :param recordset currency: The currency of the transaction, as a `res.currency` record
        :param recordset country: The customer country, as a `res.country` record
        :return: The computed fees
        :rtype: float
     * @param amount 
     * @param currency 
     * @param country 
     */
    async _computeFees(amount, currency, country) {
        this.ensureOne();

        let fees = 0.0;
        if (await this['feesActive']) {
            let fixed, variable;
            if (country.eq(await (await this['companyId']).countryId)) {
                fixed = await this['feesDomFixed'];
                variable = await this['feesDomVar'];
            }
            else {
                fixed = await this['feesIntFixed'];
                variable = await this['feesIntVar'];
            }
            fees = (amount * variable / 100.0 + fixed) / (1 - variable / 100.0);
        }
        return fees;
    }

    /**
     * Get the amount to transfer in a payment method validation operation.

        For an acquirer to support tokenization, it must override this method and return the amount
        to be transferred in a payment method validation operation *if the validation amount is not
        null*.

        Note: this.ensureOne()

        :return: The validation amount
        :rtype: float
     * @returns 
     */
    async _getValidationAmount() {
        this.ensureOne();
        return 0.0;
    }

    /**
     * Get the currency of the transfer in a payment method validation operation.

        For an acquirer to support tokenization, it must override this method and return the
        currency to be used in a payment method validation operation *if the validation amount is
        not null*.

        Note: self.ensure_one()

        :return: The validation currency
        :rtype: recordset of `res.currency`
     * @returns 
     */
    async _getValidationCurrency() {
        this.ensureOne();
        const currency = await (await this['journalId']).currencyId;
        return bool(currency) ? currency : await (await this['companyId']).currencyId;
    }

    /**
     * Return the view of the template used to render the redirect form.

        For an acquirer to return a different view depending on whether the operation is a
        validation, it must override this method and return the appropriate view.

        Note: this.ensureOne()

        :param bool is_validation: Whether the operation is a validation
        :return: The redirect form template
        :rtype: record of `ir.ui.view`
     * @param isValidation 
     * @returns 
     */
    async _getRedirectFormView(isValidation=false) {
        this.ensureOne();
        return this['redirectFormViewId'];
    }
}