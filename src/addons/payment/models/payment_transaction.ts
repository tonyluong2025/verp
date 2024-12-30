import { Fields, _Datetime, api } from "../../../core";
import { Dict, ValidationError } from "../../../core/helper";
import { MetaModel, Model, _super } from "../../../core/models"
import { cleanString } from "../../../core/service/middleware/utils";
import { _f, bool, consteq, escapeRegExp, formatAmount, hmac, len, parseInt, pop, subDate, update, ustr } from "../../../core/tools";
import { encode } from "../../../core/tools/iri";
import { stringify } from "../../../core/tools/json";
import * as paymentUtils from "../utils";

@MetaModel.define()
class PaymentTransaction extends Model {
    static _module = module;
    static _name = 'payment.transaction';
    static _description = 'Payment Transaction';
    static _order = 'id desc';
    static _recName = 'reference';

    @api.model()
    async _langGet() {
        return this.env.items('res.lang').getInstalled();
    }

    static acquirerId = Fields.Many2one({
        string: "Acquirer", comodelName: 'payment.acquirer', readonly: true, required: true});
    static provider = Fields.Selection({related: 'acquirerId.provider'});
    static companyId = Fields.Many2one({  // Indexed to speed-up ORM searches (from irRule or others)
        related: 'acquirerId.companyId', store: true, index: true});
    static reference = Fields.Char({
        string: "Reference", help: "The internal reference of the transaction", readonly: true,
        required: true});  // Already has an index from the UNIQUE SQL constraint
    static acquirerReference = Fields.Char({
        string: "Acquirer Reference", help: "The acquirer reference of the transaction",
        readonly: true});  // This is not the same thing as the acquirer reference of the token
    static amount = Fields.Monetary({
        string: "Amount", currencyField: 'currencyId', readonly: true, required: true});
    static currencyId = Fields.Many2one({
        string: "Currency", comodelName: 'res.currency', readonly: true, required: true});
    static fees = Fields.Monetary({
        string: "Fees", currencyField: 'currencyId',
        help: "The fees amount; set by the system as it depends on the acquirer", readonly: true});
    static tokenId = Fields.Many2one({
        string: "Payment Token", comodelName: 'payment.token', readonly: true,
        domain: '[["acquirerId", "=", "acquirerId"]]', ondelete: 'RESTRICT'});
    static state = Fields.Selection({
        string: "Status",
        selection: [['draft', "Draft"], ['pending', "Pending"], ['authorized', "Authorized"],
                   ['done', "Confirmed"], ['cancel', "Canceled"], ['error', "Error"]],
        default: 'draft', readonly: true, required: true, copy: false, index: true});
    static stateMessage = Fields.Text({
        string: "Message", help: "The complementary information message about the state",
        readonly: true});
    static lastStateChange = Fields.Datetime({
        string: "Last State Change Date", readonly: true, default: () => _Datetime.now()});

    // Fields used for traceability
    static operation = Fields.Selection({  // This should not be trusted if the state is 'draft' or 'pending'
        string: "Operation",
        selection: [
            ['onlineRedirect', "Online payment with redirection"],
            ['onlineDirect', "Online direct payment"],
            ['onlineToken', "Online payment by token"],
            ['validation', "Validation of the payment method"],
            ['offline', "Offline payment by token"],
            ['refund', "Refund"]
        ],
        readonly: true,
        index: true,
    });
    static paymentId = Fields.Many2one({string: "Payment", comodelName: 'account.payment', readonly: true});
    static sourceTransactionId = Fields.Many2one({
        string: "Source Transaction",
        comodelName: 'payment.transaction',
        help: "The source transaction of related refund transactions",
        readonly: true
    });
    static refundsCount = Fields.Integer({string: "Refunds Count", compute: '_computeRefundsCount'});
    static invoiceIds = Fields.Many2many({
        string: "Invoices", comodelName: 'account.move', relation: 'accountInvoiceTransactionRel',
        column1: 'transactionId', column2: 'invoiceId', readonly: true, copy: false,
        domain: [['moveType', 'in', ['outInvoice', 'outRefund', 'inInvoice', 'inRefund']]]});
    static invoicesCount = Fields.Integer({string: "Invoices Count", compute: '_computeInvoicesCount'});

    // Fields used for user redirection & payment post-processing
    static isPostProcessed = Fields.Boolean({
        string: "Is Post-processed", help: "Has the payment been post-processed"});
    static tokenize = Fields.Boolean({
        string: "Create Token",
        help: "Whether a payment token should be created when post-processing the transaction"});
    static landingRoute = Fields.Char({
        string: "Landing Route",
        help: "The route the user is redirected to after the transaction"});
    static callbackModelId = Fields.Many2one({
        string: "Callback Document Model", comodelName: 'ir.model', groups: 'base.groupSystem'});
    static callbackResId = Fields.Integer({string: "Callback Record ID", groups: 'base.groupSystem'});
    static callbackMethod = Fields.Char({string: "Callback Method", groups: 'base.groupSystem'});
    // Hash for additional security on top of the callback fields' group in case a bug exposes a sudo
    static callbackHash = Fields.Char({string: "Callback Hash", groups: 'base.groupSystem'});
    static callbackIsDone = Fields.Boolean({
        string: "Callback Done", help: "Whether the callback has already been executed",
        groups: "base.groupSystem", readonly: true});

    // Duplicated partner values allowing to keep a record of them, should they be later updated
    static partnerId = Fields.Many2one({
        string: "Customer", comodelName: 'res.partner', readonly: true, required: true,
        ondelete: 'RESTRICT'});
    static partnerName = Fields.Char({string: "Partner Name"});
    static partnerLang = Fields.Selection({string: "Language", selection: self => self._langGet()});
    static partnerEmail = Fields.Char({string: "Email"});
    static partnerAddress = Fields.Char({string: "Address"});
    static partnerZip = Fields.Char({string: "Zip"});
    static partnerCity = Fields.Char({string: "City"});
    static partnerStateId = Fields.Many2one({string: "State", comodelName: 'res.country.state'});
    static partnerCountryId = Fields.Many2one({string: "Country", comodelName: 'res.country'});
    static partnerPhone = Fields.Char({string: "Phone"});

    static _sqlConstraints = [
        ['reference_uniq', 'unique(reference)', "Reference must be unique!"],
    ];

    //=== COMPUTE METHODS ===#

    @api.depends('invoiceIds')
    async _computeInvoicesCount() {
        const res = await this.env.cr.execute(
            `
            SELECT "transactionId" AS id, COUNT("invoiceId")::int
            FROM "accountInvoiceTransactionRel"
            WHERE "transactionId" IN (%s)
            GROUP BY "transactionId"
            `,
            [String(this.ids) || 'null']
        );
        const txData = Object.fromEntries(res.map(x => [x['id'], x['count']]));  // {id: count}
        for (const tx of this) {
            await tx.set('invoicesCount', txData[tx.id] ?? 0);
        }
    }

    async _computeRefundsCount() {
        const rgData = await this.env.items('payment.transaction').readGroup(
            [['sourceTransactionId', 'in', this.ids], ['operation', '=', 'refund']],
            ['sourceTransactionId'],
            ['sourceTransactionId'],
        );
        const data = Object.fromEntries(rgData.map(x => [x['sourceTransactionId'][0], x['sourceTransactionId_count']]));
        for (const record of this) {
            await record.set('refundsCount', data[record.id] ?? 0);
        }
    }

    //=== CONSTRAINT METHODS ===#

    /**
     * Check that authorization is supported for a transaction in the 'authorized' state.
     */
    @api.constrains('state')
    async _checkStateAuthorizedSupported() {
        const illegalAuthorizeStateTxs = await this.filtered(
            async (tx) => await tx.state === 'authorized' && ! await (await tx.acquirerId).supportAuthorization
        )
        if (bool(illegalAuthorizeStateTxs)) {
            throw new ValidationError(await this._t(
                "Transaction authorization is not supported by the following payment acquirers: %s",
                (await illegalAuthorizeStateTxs.mapped('acquirerId.label')).join(', '))
            );
        }
    }

    //=== CRUD METHODS ===#

    @api.modelCreateMulti()
    async create(valuesList) {
        for (const values of valuesList) {
            const acquirer = await this.env.items('payment.acquirer').browse(values['acquirerId']);

            if (! values['reference']) {
                values['reference'] = await this._computeReference(await acquirer.provider, values);
            }
            // Duplicate partner values
            const partner = this.env.items('res.partner').browse(values['partnerId']);
            update(values, {
                // Use the parent partner as fallback if the invoicing address has no name.
                'partnerName': await partner.label || await (await partner.parentId).label,
                'partnerLang': await partner.lang,
                'partnerEmail': await partner.email,
                'partnerAddress': await paymentUtils.formatPartnerAddress(
                    await partner.street, await partner.street2
                ),
                'partnerZip': await partner.zip,
                'partnerCity': await partner.city,
                'partnerStateId': (await partner.stateId).id,
                'partnerCountryId': (await partner.countryId).id,
                'partnerPhone': await partner.phone,
            })

            // Compute fees, for validation transactions fees are zero
            if (values['operation'] === 'validation') {
                values['fees'] = 0;
            }
            else {
                const currency = await this.env.items('res.currency').browse(values.get('currencyId')).exists();
                values['fees'] = await acquirer._computeFees(
                    values['amount'] ?? 0, currency, await partner.countryId,
                );
            }

            // Include acquirer-specific create values
            update(values, await this._getSpecificCreateValues(await acquirer.provider, values));

            // Generate the hash for the callback if one has be configured on the tx
            values['callbackHash'] = await this._generateCallbackHash(
                values['callbackModelId'],
                values['callbackResId'],
                values['callbackMethod'],
            );
        }

        const txs = await _super(PaymentTransaction, this).create(valuesList);

        // Monetary fields are rounded with the currency at creation time by the ORM. Sometimes, this
        // can lead to inconsistent string representation of the amounts sent to the providers.
        // E.g., tx.create({amount: 1111.11}) -> tx.amount == 1111.1100000000001
        // To ensure a proper string representation, we invalidate this request's cache values of the
        // `amount` and `fees` fields for the created transactions. This forces the ORM to read the
        // values from the DB where there were stored using `floatRepr`, which produces a result
        // consistent with the format expected by providers.
        // E.g., tx.create({amount: 1111.11}) ; tx.invalidate_cache() -> tx.amount == 1111.11
        txs.invalidateCache(['amount', 'fees']);

        return txs;
    }

    /**
     * Complete the values of the `create` method with acquirer-specific values.

        For an acquirer to add its own create values, it must overwrite this method and return a
        dict of values. Acquirer-specific values take precedence over those of the dict of generic
        create values.

        :param str provider: The provider of the acquirer that handled the transaction
        :param dict values: The original create values
        :return: The dict of acquirer-specific create values
        :rtype: dict
     * @param provider 
     * @param values 
     * @returns 
     */
    @api.model()
    async _getSpecificCreateValues(provider, values) {
        return {}
    }

    //=== ACTION METHODS ===#

    /**
     * Return the action for the views of the invoices linked to the transaction.

        Note: this.ensureOne()

        :return: The action
        :rtype: dict
     */
    async actionViewInvoices() {
        this.ensureOne();

        const action = {
            'label': await this._t("Invoices"),
            'type': 'ir.actions.actwindow',
            'resModel': 'account.move',
            'target': 'current',
        }
        const invoiceIds = (await this['invoiceIds']).ids;
        if (len(invoiceIds) === 1) {
            const invoice = invoiceIds[0];
            action['resId'] = invoice;
            action['viewMode'] = 'form';
            action['views'] = [[(await this.env.ref('account.viewMoveForm')).id, 'form']];
        }
        else {
            action['viewMode'] = 'tree,form';
            action['domain'] = [['id', 'in', invoiceIds]];
        }
        return action;
    }

    /**
     * Return the action for the views of the refund transactions linked to the transaction.

        Note: this.ensureOne()

        :return: The action
        :rtype: dict
     * @returns 
     */
    async actionViewRefunds() {
        this.ensureOne();

        const action = {
            'label': await this._t("Refund"),
            'resModel': 'payment.transaction',
            'type': 'ir.actions.actwindow',
        }
        if (await this['refundsCount'] == 1) {
            const refundTx = (await this.env.items('payment.transaction').search([
                ['sourceTransactionId', '=', this.id],
            ]))[0];
            action['resId'] = refundTx.id;
            action['viewMode'] = 'form';
        }
        else {
            action['viewMode'] = 'tree,form';
            action['domain'] = [['sourceTransactionId', '=', this.id]];
        }
        return action;
    }

    /**
     * Check the state of the transactions and request their capture.
     * @returns 
     */
    async actionCapture() {
        if (await this.some(async (tx) => await tx.state !== 'authorized')) {
            throw new ValidationError(await this._t("Only authorized transactions can be captured."));
        }

        await paymentUtils.checkRightsOnRecordset(this);
        for (const tx of this) {
            // In sudo mode because we need to be able to read on acquirer Fields.
            await (await tx.sudo())._sendCaptureRequest();
        }
    }

    /**
     * Check the state of the transaction and request to have them voided.
     */
    async actionVoid() {
        if (await this.some(async (tx) => await tx.state !== 'authorized')) {
            throw new ValidationError(await this._t("Only authorized transactions can be voided."));
        }

        await paymentUtils.checkRightsOnRecordset(this);
        for (const tx of this) {
            // In sudo mode because we need to be able to read on acquirer Fields.
            await (await tx.sudo())._sendVoidRequest();
        }
    }

    /**
     * Check the state of the transactions and request their refund.

        :param float amountToRefund: The amount to be refunded
        :return: None
     * @param amountToRefund 
     */
    async actionRefund(amountToRefund?: any) {
        if (await this.some(async (tx) => await tx.state !== 'done')) {
            throw new ValidationError(await this._t("Only confirmed transactions can be refunded."));
        }
        for (const tx of this) {
            await tx._sendRefundRequest(amountToRefund);
        }
    }

    //=== BUSINESS METHODS - PAYMENT FLOW ===#

    /**
     * Compute a unique reference for the transaction.

        The reference either corresponds to the prefix if no other transaction with that prefix
        already exists, or follows the pattern `{computed_prefix}{separator}{sequence_number}` where
          - {computed_prefix} is:
            - The provided custom prefix, if any.
            - The computation result of `_compute_reference_prefix` if the custom prefix is not
              filled but the kwargs are.
            - 'tx-{datetime}', if neither the custom prefix nor the kwargs are filled.
          - {separator} is a custom string also used in `_compute_reference_prefix`.
          - {sequence_number} is the next integer in the sequence of references sharing the exact
            same prefix, '1' if there is only one matching reference (hence without sequence number)

        Examples:
          - Given the custom prefix 'example' which has no match with an existing reference, the
            full reference will be 'example'.
          - Given the custom prefix 'example' which matches the existing reference 'example', and
            the custom separator '-', the full reference will be 'example-1'.
          - Given the kwargs {'invoiceIds': [1, 2]}, the custom separator '-' and no custom prefix,
            the full reference will be 'INV1-INV2' (or similar) if no existing reference has the
            same prefix, or 'INV1-INV2-n' if n existing references have the same prefix.

        :param str provider: The provider of the acquirer handling the transaction
        :param str prefix: The custom prefix used to compute the full reference
        :param str separator: The custom separator used to separate the prefix from the suffix, and
                              passed to `_compute_reference_prefix` if it is called
        :param dict kwargs: Optional values passed to `_compute_reference_prefix` if no custom
                            prefix is provided
        :return: The unique reference for the transaction
        :rtype: str
     * @param provider 
     * @param opts 
     * @returns 
     */
    @api.model()
    async _computeReference(provider, opts: {prefix?: string, separator?: string}={}) {
        let prefix = pop(opts, 'prefix');
        let separator = pop(opts, 'separator', '-');
        // Compute the prefix
        if (prefix) {
            // Replace special characters by their ASCII alternative (é -> e ; ä -> a ; ...)
            prefix = Buffer.from(cleanString(Buffer.from(opts.prefix.normalize('NFKD')).toString('ascii'), 'ignore')).toString('utf-8');
        }
        const sudo = await this.sudo();
        if (!prefix) {  // Prefix not provided or voided above, compute it based on the kwargs
            prefix = await sudo._computeReferencePrefix(provider, separator, opts);
        }
        if (!prefix) {  // Prefix not computed from the kwargs, fallback on time-based value
            prefix = await paymentUtils.singularizeReferencePrefix();
        }

        // Compute the sequence number
        let reference = prefix;  // The first reference of a sequence has no sequence number
        if (bool(await sudo.search([['reference', '=', prefix]]))) {  // The reference already has a match
            // We now execute a second search on `payment.transaction` to fetch all the references
            // starting with the given prefix. The load of these two searches is mitigated by the
            // index on `reference`. Although not ideal, this solution allows for quickly knowing
            // whether the sequence for a given prefix is already started or not, usually not. An SQL
            // query wouldn't help either as the selector is arbitrary and doing that would be an
            // open-door to SQL injections.
            const samePrefixReferences = await (await (await sudo.search(
                [['reference', 'like', `${prefix}${separator}%`]]
            )).withContext({prefetchFields: false})).mapped('reference');

            // A final regex search is necessary to figure out the next sequence number. The previous
            // search could not rely on alphabetically sorting the reference to infer the largest
            // sequence number because both the prefix and the separator are arbitrary. A given
            // prefix could happen to be a substring of the reference from a different sequence.
            // For instance, the prefix 'example' is a valid match for the existing references
            // 'example', 'example-1' and 'example-ref', in that order. Trusting the order to infer
            // the sequence number would lead to a collision with 'example-1'.
            const searchPattern = new RegExp(`^${escapeRegExp(prefix)}${separator}(\\d+)$`, 'gm');
            let maxSequenceNumber = 0;  // If no match is found, start the sequence with this reference
            for (const existingReference of samePrefixReferences) {
                const searchResult = existingReference.matchAll(searchPattern).next().value;
                if (searchResult) {  // The reference has the same prefix and is from the same sequence
                    // Find the largest sequence number, if any
                    const currentSequence = parseInt(searchResult[1]);
                    if (currentSequence > maxSequenceNumber) {
                        maxSequenceNumber = currentSequence;
                    }
                }
            }
            // Compute the full reference
            reference = `${prefix}${separator}${maxSequenceNumber + 1}`;
        }
        return reference;
    }

    /**
     * Compute the reference prefix from the transaction values.

        If the `values` parameter has an entry with 'invoiceIds' as key and a list of (4, id, O) or
        (6, 0, ids) X2M command as value, the prefix is computed based on the invoice name(s).
        Otherwise, an empty string is returned.

        Note: This method should be called in sudo mode to give access to documents (INV, SO, ...).

        :param str provider: The provider of the acquirer handling the transaction
        :param str separator: The custom separator used to separate data references
        :param dict values: The transaction values used to compute the reference prefix. It should
                            have the structure {'invoiceIds': [(X2M command), ...], ...}.
        :return: The computed reference prefix if invoice ids are found, an empty string otherwise
        :rtype: str
     * @param provider 
     * @param separator 
     * @param values 
     * @returns 
     */
    @api.model()
    async _computeReferencePrefix(provider, separator, values:{}={}) {
        const commandList = values['invoiceIds'];
        if (bool(commandList)) {
            // Extract invoice id(s) from the X2M commands
            const invoiceIds = await this._fields['invoiceIds'].convertToCache(commandList, this);
            const invoices = await this.env.items('account.move').browse(invoiceIds).exists();
            if (len(invoices) == len(invoiceIds)) {  // All ids are valid
                return (await invoices.mapped('label')).join(separator);
            }
        }
        return '';
    }

    /**
     * Return the hash for the callback on the transaction.

        :param int callback_model_id: The model on which the callback method is defined, as a
                                      `res.model` id
        :param int callback_res_id: The record on which the callback method must be called, as an id
                                    of the callback model
        :param str callback_method: The name of the callback method
        :return: The callback hash
        :rtype: str
     * @param callbackModelId 
     * @param callbackResId 
     * @param callbackMethod 
     * @returns 
     */
    @api.model()
    async _generateCallbackHash(callbackModelId, callbackResId, callbackMethod) {
        if (bool(callbackModelId) && bool(callbackResId) && bool(callbackMethod)) {
            const modelName = await (await this.env.items('ir.model').sudo()).browse(callbackModelId).model;
            const token = `${modelName}|${callbackResId}|${callbackMethod}`;
            const callbackHash = await hmac(this.env.change({su: true}), 'generateCallbackHash', token);
            return callbackHash;
        }
        return null;
    }

    /**
     * Return a dict of values used to process the transaction.

        The returned dict contains the following entries:
            - txId: The transaction, as a `payment.transaction` id
            - acquirerId: The acquirer handling the transaction, as a `payment.acquirer` id
            - provider: The provider of the acquirer
            - reference: The reference of the transaction
            - amount: The rounded amount of the transaction
            - currencyId: The currency of the transaction, as a res.currency id
            - partnerId: The partner making the transaction, as a res.partner id
            - Additional acquirer-specific entries

        Note: this.ensureOne()

        :return: The dict of processing values
        :rtype: dict
     */
    async _getProcessingValues() {
        this.ensureOne();

        const processingValues = {
            'acquirerId': (await this['acquirerId']).id,
            'provider': await this['provider'],
            'reference': await this['reference'],
            'amount': await this['amount'],
            'currencyId': (await this['currencyId']).id,
            'partnerId': (await this['partnerId']).id,
        }

        // Complete generic processing values with acquirer-specific values
        update(processingValues, await this._getSpecificProcessingValues(processingValues));
        console.info(
            "generic and acquirer-specific processing values for transaction with id %s:\n%s",
            this.id, stringify(processingValues)
        );

        // Render the html form for the redirect flow if available
        if (['onlineRedirect', 'validation'].includes(await this['operation'])) {
            const redirectFormView = await (await this['acquirerId'])._getRedirectFormView(
                await this['operation'] === 'validation'
            );
            if (bool(redirectFormView)) {  // Some acquirer don't need a redirect form
                const renderingValues = this._getSpecificRenderingValues(processingValues);
                console.info(
                    "acquirer-specific rendering values for transaction with id %s:\n%s",
                    this.id, stringify(renderingValues)
                )
                const redirectFormHtml = await redirectFormView._render(renderingValues, 'ir.qweb');
                update(processingValues, {redirectFormHtml});
            }
        }
        return processingValues;
    }

    /**
     * Return a dict of acquirer-specific values used to process the transaction.

        For an acquirer to add its own processing values, it must overwrite this method and return a
        dict of acquirer-specific values based on the generic values returned by this method.
        Acquirer-specific values take precedence over those of the dict of generic processing
        values.

        :param dict processing_values: The generic processing values of the transaction
        :return: The dict of acquirer-specific processing values
        :rtype: dict
     */
    async _getSpecificProcessingValues(processingValues) {
        return {}
    }

    /**
     * Return a dict of acquirer-specific values used to render the redirect form.

        For an acquirer to add its own rendering values, it must overwrite this method and return a
        dict of acquirer-specific values based on the processing values (acquirer-specific
        processing values included).

        :param dict processing_values: The processing values of the transaction
        :return: The dict of acquirer-specific rendering values
        :rtype: dict
     * @param processingValues 
     * @returns 
     */
    async _getSpecificRenderingValues(processingValues) {
        return {}
    }

    /**
     * Request the provider of the acquirer handling the transaction to execute the payment.

        For an acquirer to support tokenization, it must override this method and call it to log the
        'sent' message, then request a money transfer to its provider.

        Note: self.ensure_one()

        :return: None
     */
    async _sendPaymentRequest(req) {
        this.ensureOne();
        await this._logSentMessage();
    }

    /**
     * Request the provider of the acquirer handling the transaction to refund it.

        For an acquirer to support refunds, it must override this method and request a refund
        to its provider.

        Note: this.ensureOne()

        :param float amount_to_refund: The amount to be refunded
        :param bool create_refund_transaction: Whether a refund transaction should be created
        :return: The refund transaction if any
        :rtype: recordset of `payment.transaction`
     * @param amountToRefund 
     * @param createRefundTransaction 
     * @returns 
     */
    async _sendRefundRequest(amountToRefund?: any, createRefundTransaction=true) {
        this.ensureOne();

        if (createRefundTransaction) {
            const refundTx = await this._createRefundTransaction(amountToRefund);
            await refundTx._logSentMessage();
            return refundTx;
        }
        else {
            return this.env.items('payment.transaction');
        }
    }

    /**
     * Request the provider of the acquirer handling the transaction to capture it.

        For an acquirer to support authorization, it must override this method and request a capture
        to its provider.

        Note: self.ensure_one()

        :return: void
     */
    async _sendCaptureRequest() {
        this.ensureOne();
    }

    /**
     * Request the provider of the acquirer handling the transaction to void it.

        For an acquirer to support authorization, it must override this method and request the
        transaction to be voided to its provider.

        Note: this.ensureOne()

        :return: void
     */
    async _sendVoidRequest() {
        this.ensureOne();
    }

    /**
     * Create a new transaction with operation 'refund' and link it to the current transaction.

        :param float amount_to_refund: The strictly positive amount to refund, in the same currency
                                       as the source transaction
        :return: The refund transaction
        :rtype: recordset of `payment.transaction`
     * @param amountToRefund 
     * @param customCreateValues 
     * @returns 
     */
    async _createRefundTransaction(amountToRefund?: any, customCreateValues:{}={}) {
        this.ensureOne();

        return this.create({
            'acquirerId': (await this['acquirerId']).id,
            'reference': await this._computeReference(await this['provider'], {prefix: `R-${await this['reference']}`}),
            'amount': -(amountToRefund || await this['amount']),
            'currencyId': (await this['currencyId']).id,
            'tokenId': (await this['tokenId']).id,
            'operation': 'refund',
            'sourceTransactionId': this.id,
            'partnerId': (await this['partnerId']).id,
            ...customCreateValues,
        });
    }

    /**
     * Match the transaction with the feedback data, update its state and return it.

        :param str provider: The provider of the acquirer that handled the transaction
        :param dict data: The feedback data sent by the provider
        :return: The transaction
        :rtype: recordset of `payment.transaction`
     * @param provider 
     * @param data 
     * @returns 
     */
    @api.model()
    async _handleFeedbackData(provider, data) {
        const tx = await this._getTxFromFeedbackData(provider, data);
        await tx._processFeedbackData(data);
        await tx._executeCallback();
        return tx;
    }

    /**
     * Find the transaction based on the feedback data.

        For an acquirer to handle transaction post-processing, it must overwrite this method and
        return the transaction matching the data.

        :param str provider: The provider of the acquirer that handled the transaction
        :param dict data: The feedback data sent by the acquirer
        :return: The transaction if found
        :rtype: recordset of `payment.transaction`
     * @param provider 
     * @param data 
     * @returns 
     */
    @api.model()
    async _getTxFromFeedbackData(provider, data) {
        return this;
    }

    /**
     * Update the transaction state and the acquirer reference based on the feedback data.

        For an acquirer to handle transaction post-processing, it must overwrite this method and
        process the feedback data.

        Note: this.ensureOne()

        :param dict data: The feedback data sent by the acquirer
        :return: void
     * @param data 
     */
    async _processFeedbackData(data) {
        this.ensureOne();
    }

    /**
     * Update the transactions' state to 'pending'.

        :param str state_message: The reason for which the transaction is set in 'pending' state
        :return: void
     * @param stateMessage 
     */
    async _setPending(stateMessage?: any) {
        const allowedStates = ['draft'];
        const targetState = 'pending';
        const txsToProcess = await this._updateState(allowedStates, targetState, stateMessage);
        await txsToProcess._logReceivedMessage();
    }

    /**
     * Update the transactions' state to 'authorized'.

        :param str state_message: The reason for which the transaction is set in 'authorized' state
        :return: void
     * @param stateMessage 
     * @returns 
     */
    async _setAuthorized(stateMessage?: any) {
        const allowedStates = ['draft', 'pending'];
        const targetState = 'authorized';
        const txsToProcess = await this._updateState(allowedStates, targetState, stateMessage);
        await txsToProcess._logReceivedMessage();
    }

    /**
     * Update the transactions' state to 'done'.

        :return: void
     * @param stateMessage 
     */
    async _setDone(stateMessage?: any) {
        const allowedStates = ['draft', 'pending', 'authorized', 'error', 'cancel'];  // 'cancel' for Payulatam
        const targetState = 'done';
        const txsToProcess = await this._updateState(allowedStates, targetState, stateMessage);
        await txsToProcess._logReceivedMessage();
    }

    /**
     * Update the transactions' state to 'cancel'.

        :param str state_message: The reason for which the transaction is set in 'cancel' state
        :return: void
     * @param stateMessage 
     * @returns 
     */
    async _setCanceled(stateMessage?: any) {
        const allowedStates = ['draft', 'pending', 'authorized'];
        const targetState = 'cancel';
        const txsToProcess = await this._updateState(allowedStates, targetState, stateMessage);
        // Cancel the existing payments
        await (await txsToProcess.mapped('paymentId')).actionCancel();
        await txsToProcess._logReceivedMessage();
    }

    /**
     * Update the transactions' state to 'error'.

        :param str state_message: The reason for which the transaction is set in 'error' state
        :return: void
     * @param stateMessage 
     */
    async _setError(stateMessage) {
        const allowedStates = ['draft', 'pending', 'authorized'];
        const targetState = 'error';
        const txsToProcess = await this._updateState(allowedStates, targetState, stateMessage);
        await txsToProcess._logReceivedMessage();
    }

    /**
     * Update the transactions' state to the target state if the current state allows it.

        If the current state is the same as the target state, the transaction is skipped.

        :param <string>[] allowedStates: The allowed source states for the target state
        :param string targetState: The target state
        :param string stateMessage: The message to set as `state_message`
        :return: The recordset of transactions whose state was correctly updated
        :rtype: recordset of `payment.transaction`
     * @param allowedStates 
     * @param targetState 
     * @param stateMessage 
     * @returns 
     */
    async _updateState(allowedStates, targetState, stateMessage) {

        /**
         * Classify the transactions according to their current state.

            For each transaction of the current recordset, if:
                - The state is an allowed state: the transaction is flagged as 'to process'.
                - The state is equal to the target state: the transaction is flagged as 'processed'.
                - The state matches none of above: the transaction is flagged as 'in wrong state'.

            :param recordset _transactions: The transactions to classify, as a `payment.transaction`
                                            recordset
            :return: A 3-items tuple of recordsets of classified transactions, in this order:
                     transactions 'to process', 'processed', and 'in wrong state'
            :rtype: tuple(recordset)
         * @param transactions 
         * @returns 
         */
        async function _classifyByState(transactions) {
            const txsToProcess = await transactions.filtered(async (tx) => allowedStates.includes(await tx.state));
            const txsAlreadyProcessed = await transactions.filtered(async (tx) => await tx.state === targetState);
            const txsWrongState = transactions.sub(txsToProcess).sub(txsAlreadyProcessed);

            return [txsToProcess, txsAlreadyProcessed, txsWrongState];
        }

        const [txsToProcess, txsAlreadyProcessed, txsWrongState] = await _classifyByState(this);
        for (const tx of txsAlreadyProcessed) {
            console.info(
                "tried to write tx state with same value (ref: %s, state: %s)",
                await tx.reference, await tx.state
            );
        }
        for (const tx of txsWrongState) {
            const loggingValues = {
                'reference': await tx.reference,
                'txState': await tx.state,
                'targetState': targetState,
                'allowedStates': allowedStates,
            }
            console.warn(
                _f("tried to write tx state with illegal value (ref: %(reference)s, previous state "+
                "{txState}, target state: {targetState}, expected previous state to be in: "+
                "{allowedStates})", loggingValues)
            );
        }
        await txsToProcess.write({
            'state': targetState,
            'stateMessage': stateMessage,
            'lastStateChange': _Datetime.now(),
        })
        return txsToProcess;
    }

    /**
     * Execute the callbacks defined on the transactions.

        Callbacks that have already been executed are silently ignored. This case can happen when a
        transaction is first authorized before being confirmed, for instance. In this case, both
        status updates try to execute the callback.

        Only successful callbacks are marked as done. This allows callbacks to reschedule themselves
        should the conditions not be met in the present call.

        :return: void
     * @returns 
     */
    async _executeCallback() {
        for (const tx of await this.filtered(async (t) => ! await (await t.sudo()).callbackIsDone)) {
            // Only use sudo to check, not to execute
            const txSudo = await tx.sudo();
            const modelSudo = await txSudo.callbackModelId;
            const resId = await txSudo.callbackResId;
            const method = await txSudo.callbackMethod;
            const callbackHash = await txSudo.callbackHash;
            if (! (bool(modelSudo) && bool(resId) && method)) {
                continue;  // Skip transactions with unset (or not properly defined) callbacks
            }

            const validCallbackHash = await this._generateCallbackHash(modelSudo.id, resId, method);
            if (! consteq(ustr(validCallbackHash), callbackHash)) {
                console.warn("invalid callback signature for transaction with id %s", tx.id);
                continue;  // Ignore tampered callbacks
            }

            const record = await this.env.items(await modelSudo.model).browse(resId).exists();
            if (!bool(record)) {
                const loggingValues = {
                    'model': await modelSudo.model,
                    'recordId': resId,
                    'txId': tx.id,
                }
                console.warn(
                    _f("invalid callback record {model}.{recordId} for transaction with id "+
                    "{txId}", loggingValues)
                );
                continue  // Ignore invalidated callbacks
            }
            const success = await record[method](tx);  // Execute the callback
            await txSudo.set('callbackIsDone', success || success == null);  // Missing returns are successful
        }
    }

    //=== BUSINESS METHODS - POST-PROCESSING ===#

    /**
     * Return a dict of values used to display the status of the transaction.

        For an acquirer to handle transaction status display, it must override this method and
        return a dict of values. Acquirer-specific values take precedence over those of the dict of
        generic post-processing values.

        The returned dict contains the following entries:
            - provider: The provider of the acquirer
            - reference: The reference of the transaction
            - amount: The rounded amount of the transaction
            - currencyId: The currency of the transaction, as a res.currency id
            - state: The transaction state: draft, pending, authorized, done, cancel or error
            - stateMessage: The information message about the state
            - isPostProcessed: Whether the transaction has already been post-processed
            - landingRoute: The route the user is redirected to after the transaction
            - Additional acquirer-specific entries

        Note: self.ensure_one()

        :return: The dict of processing values
        :rtype: dict
     * @returns 
     */
    async _getPostProcessingValues() {
        this.ensureOne();

        const postProcessingValues = {
            'provider': await this['provider'],
            'reference': await this['reference'],
            'amount': await this['amount'],
            'currencyCode': await (await this['currencyId']).label,
            'state': await this['state'],
            'stateMessage': await this['stateMessage'],
            'isPostProcessed': await this['isPostProcessed'],
            'landingRoute': await this['landingRoute'],
        }
        console.debug(
            "post-processing values for acquirer with id %s:\n%s",
            (await this['acquirerId']).id, stringify(postProcessingValues)
        );  // DEBUG level because this can get spammy with transactions in non-final states
        return postProcessingValues;
    }

    /**
     * Trigger the final post-processing tasks and mark the transactions as post-processed.
        :return: void
     */
    async _finalizePostProcessing() {
        await this._reconcileAfterDone();
        await this._logReceivedMessage();  // 2nd call to link the created account.payment in the chatter
        await this.set('isPostProcessed', true);
    }

    /**
     * Finalize the post-processing of recently done transactions not handled by the client.

        :return: void
     */
    async _cronFinalizePostProcessing() {
        let txsToPostProcess = this;
        if (! txsToPostProcess.ok) {
            // Let the client post-process transactions so that they remain available in the portal
            const now = new Date()
            const clientHandlingLimitDate = subDate(now, {minutes: 10});
            // Don't try forever to post-process a transaction that doesn't go through. Set the limit
            // to 4 days because some providers (PayPal) need that much for the payment verification.
            const retryLimitDate = subDate(now, {days: 4});
            // Retrieve all transactions matching the criteria for post-processing
            const txsToPostProcess = await this.search([
                ['state', '=', 'done'],
                ['isPostProcessed', '=', false],
                '|', ['lastStateChange', '<=', clientHandlingLimitDate],
                     ['operation', '=', 'refund'],
                ['lastStateChange', '>=', retryLimitDate],
            ]);
        }
        for (const tx of txsToPostProcess) {
            try {
                await tx._finalizePostProcessing();
                await this.env.cr.commit();
            } catch(e) {
                console.error(
                    "encountered an error while post-processing transaction with id %s:\n%s",
                    tx.id, e
                )
                await this.env.cr.rollback();
            }
        }
    }

    /**
     * Post relevant fiscal documents and create missing payments.

        As there is nothing to reconcile for validation transactions, no payment is created for
        them. This is also true for validations with a validity check (transfer of a small amount
        with immediate refund) because validation amounts are not included in payouts.

        :return: void
     */
    async _reconcileAfterDone() {
        // Validate invoices automatically once the transaction is confirmed
        await (await (await this['invoiceIds']).filtered(async (inv) => await inv.state === 'draft')).actionPost();

        // Create and post missing payments for transactions requiring reconciliation
        for (const tx of await this.filtered(async (t) => await t.operation !== 'validation' && !bool(await t.paymentId))) {
            await tx._createPayment();
        }
    }

    /**
     * Create an `account.payment` record for the current transaction.

        If the transaction is linked to some invoices, their reconciliation is done automatically.

        Note: this.ensureOne()

        :param dict extraCreateValues: Optional extra create values
        :return: The created payment
        :rtype: recordset of `account.payment`
     * @param extraCreateValues 
     */
    async _createPayment(extraCreateValues) {
        this.ensureOne();

        const paymentMethodLine = await (await (await (await this['acquirerId']).journalId).inboundPaymentMethodLineIds)
            .filtered(async (l) => await l.code == await this['provider']);
        const paymentValues = {
            'amount': Math.abs(await this['amount']),  // A tx may have a negative amount, but a payment must >= 0
            'paymentType': await this['amount'] > 0 ? 'inbound' : 'outbound',
            'currencyId': (await this['currencyId']).id,
            'partnerId': (await (await this['partnerId']).commercialPartnerId).id,
            'partnerType': 'customer',
            'journalId': (await (await this['acquirerId']).journalId).id,
            'companyId': (await (await this['acquirerId']).companyId).id,
            'paymentMethodLineId': paymentMethodLine.id,
            'paymentTokenId': (await this['tokenId']).id,
            'paymentTransactionId': this.id,
            'ref': await this['reference'],
            ...extraCreateValues,
        }
        const payment = await this.env.items('account.payment').create(paymentValues);
        await payment.actionPost();

        // Track the payment to make a one2one.
        await this.set('paymentId', payment);

        const invoiceIds = await this['invoiceIds'];
        if (bool(invoiceIds)) {
            await (await invoiceIds.filtered(async (inv) => await inv.state === 'draft')).actionPost();

            await (await (await payment.lineIds).add(await invoiceIds.lineIds).filtered(
                async (line) => (await line.accountId).eq(await payment.destinationAccountId)
                && !bool(await line.reconciled)
            )).reconcile();
        }
        return payment;
    }

    //=== BUSINESS METHODS - LOGGING ===#

    /**
     * Log in the chatter of relevant documents that the transactions have been initiated.

        :return: void
     * @returns 
     */
    async _logSentMessage() {
        for (const tx of this) {
            const message = await tx._getSentMessage();
            await tx._logMessageOnLinkedDocuments(message);
        }
    }

    /**
     * Log in the chatter of relevant documents that the transactions have been received.

        A transaction is 'received' when a response is received from the provider of the acquirer
        handling the transaction.

        :return: void
     * @returns 
     */
    async _logReceivedMessage() {
        for (const tx of this) {
            const message = await tx._getReceivedMessage();
            await tx._logMessageOnLinkedDocuments(message);
        }
    }

    /**
     * Log a message on the payment and the invoices linked to the transaction.

        For a module to implement payments and link documents to a transaction, it must override
        this method and call super, then log the message on documents linked to the transaction.

        Note: this.ensureOne()

        :param str message: The message to be logged
        :return: None
     * @param message 
     * @returns 
     */
    async _logMessageOnLinkedDocuments(message) {
        this.ensureOne();
        const sourceTransaction = await this['sourceTransactionId'];
        const payment = await sourceTransaction.paymentId;
        if (bool(payment)) {
            await payment.messagePost({body: message});
            for (const invoice of await sourceTransaction.invoiceIds) {
                await invoice.messagePost({body: message});
            }
        }
        for (const invoice of await this['invoiceIds']) {
            await invoice.messagePost({body: message});
        }
    }

    //=== BUSINESS METHODS - GETTERS ===#

    /**
     * Return the message stating that the transaction has been requested.

        Note: this.ensureOne()

        :return: The 'transaction sent' message
        :rtype: str
     */
    async _getSentMessage() {
        this.ensureOne();

        // Choose the message based on the payment flow
        let message;
        if (['onlineRedirect', 'onlineDirect'].includes(await this['operation'])) {
            message = _f(await this._t(
                "A transaction with reference {ref} has been initiated ({acqName})."),
                {ref: await this['reference'], acqName: await (await this['acquirerId']).label}
            );
        }
        else if (await this['operation'] === 'refund') {
            const formattedAmount = await formatAmount(this.env, -await this['amount'], await this['currencyId']);
            message = _f(await this._t(
                "A refund request of {amount} has been sent. The payment will be created soon. "+
                "Refund transaction reference: {ref} ({acqName})."),
                {amount: formattedAmount, ref: await this['reference'], acqName: await (await this['acquirerId']).label}
            );
        }
        else {  // 'online_token'
            message = _f(await this._t(
                "A transaction with reference {ref} has been initiated using the payment method "+
                "{tokenName} ({acqName})."),
                {ref: await this['reference'], tokenName: await (await this['tokenId']).label, acqName: (await this['acquirerId']).label}
            );
        }
        return message;
    }

    /**
     * Return the message stating that the transaction has been received by the provider.

        Note: this.ensureOne()
     * @returns 
     */
    async _getReceivedMessage() {
        this.ensureOne();

        const formattedAmount = await formatAmount(this.env, await this['amount'], await this['currencyId']);
        const [state, acquirer, reference] = await this('state', 'acquirerId', 'reference');
        const label = await acquirer.label;
        let message;
        if (state === 'pending') {
            message = _f(await this._t(
                "The transaction with reference {ref} for {amount} is pending ({acqName})."),
                {ref: await this['reference'], amount: formattedAmount, acqName: label}
            );
        }
        else if (state === 'authorized') {
            message = _f(await this._t(
                "The transaction with reference {ref} for {amount} has been authorized "+
                "({acqName})."), {ref: reference, amount: formattedAmount,
                acqName: label}
            );
        }
        else if (state === 'done') {
            message = _f(await this._t(
                "The transaction with reference {ref} for {amount} has been confirmed "+
                "({acqName})."), {ref: reference, amount: formattedAmount,
                acqName: label}
            );
            const payment = await this['paymentId'];
            if (bool(await this['paymentId'])) {
                message += "<br />" + await this._t(
                    "The related payment is posted: %s",
                    await payment._getPaymentChatterLink()
                );
            }
        }
        else if (state === 'error') {
            message = _f(await this._t(
                "The transaction with reference {ref} for {amount} encountered an error"+
                " ({acqName})."),
                {ref: reference, amount: formattedAmount, acqName: label}
            )
            const stateMessage = await this['stateMessage'];
            if (stateMessage) {
                message += "<br />" + await this._t("Error: %s", stateMessage);
            }
        }
        else {
            message = _f(await this._t(
                "The transaction with reference {ref} for {amount} is canceled ({acqName})."),
                {ref: reference, amount: formattedAmount, acqName: label}
            );
            const stateMessage = await this['stateMessage'];
            if (stateMessage) {
                message += "<br />" + await this._t("Reason: %s", stateMessage);
            }
        }
        return message;
    }

    /**
     * Return the last transaction of the recordset.

        :return: The last transaction of the recordset, sorted by id
        :rtype: recordset of `payment.transaction`
     * @returns 
     */
    async _getLast() {
        return (await (await this.filtered(async (t) => await t.state !== 'draft')).sorted()).slice(0, 1);
    }
}
