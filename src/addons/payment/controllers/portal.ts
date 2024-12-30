import _ from "lodash";
import { Command, http } from "../../../core";
import { AccessError, UserError, ValidationError } from "../../../core/helper";
import { WebRequest } from "../../../core/http";
import { NotFound } from "../../../core/service";
import { _t, bool, parseFloat, parseInt, pop } from "../../../core/tools";
import { CustomerPortal } from "../../portal";
import { checkAccessToken, generateAccessToken, singularizeReferencePrefix } from "../utils";
import { PaymentPostProcessing } from "./post_processing";

/**
 * This controller contains the foundations for online payments through the portal.

    It allows to complete a full payment flow without the need of going though a document-based flow
    made available by another module's controller.

    Such controllers should extend this one to gain access to the _create_transaction static method
    that implements the creation of a transaction before its processing, or to override specific
    routes and change their behavior globally (e.g. make the /pay route handle sale orders).

    The following routes are exposed:
    - `/payment/pay` allows for arbitrary payments.
    - `/my/paymentMethod` allows the user to create and delete tokens. It's its own `landing_route`
    - `/payment/transaction` is the `transaction_route` for the standard payment flow. It creates a
      draft transaction, and return the processing values necessary for the completion of the
      transaction.
    - `/payment/confirmation` is the `landing_route` for the standard payment flow. It displays the
      payment confirmation page to the user when the transaction is validated.
 */
@http.define()
export class PaymentPortal extends CustomerPortal {
    static _module = module;

    /**
     * Display the payment form with optional filtering of payment options.

        The filtering takes place on the basis of provided parameters, if any. If a parameter is
        incorrect or malformed, it is skipped to avoid preventing the user from making the payment.

        In addition to the desired filtering, a second one ensures that none of the following
        rules is broken:
            - Public users are not allowed to save their payment method as a token.
            - Payments made by public users should either *not* be made on behalf of a specific
              partner or have an access token validating the partner, amount and currency.
        We let access rights and security rules do their job for logged in users.

        :param str reference: The custom prefix to compute the full reference
        :param str amount: The amount to pay
        :param str currencyId: The desired currency, as a `res.currency` id
        :param str partnerId: The partner making the payment, as a `res.partner` id
        :param str companyId: The related company, as a `res.company` id
        :param str acquirerId: The desired acquirer, as a `payment.acquirer` id
        :param str accessToken: The access token used to authenticate the partner
        :param str invoiceId: The account move for which a payment id made, as a `account.move` id
        :param dict kwargs: Optional data. This parameter is not used here
        :return: The rendered checkout form
        :rtype: str
        :raise: theveb.exceptions.NotFound if the access token is invalid
     * @param req 
     * @param res 
     * @param opts 
     */
    @http.route('/payment/pay', { type: 'http', methods: ['GET'], auth: 'public', website: true, sitemap: false })
    async paymentPay(req: WebRequest, res, opts: { reference?: any, amount?: any, currencyId?: any, partnerId?: any, companyId?: any, acquirerId?: any, accessToken?: any, invoiceId?: any } = {}) {
        // Cast numeric parameters as int or float and void them if their str value is malformed
        let { currencyId, acquirerId, partnerId, companyId, invoiceId, reference, accessToken } = opts;
        [currencyId, acquirerId, partnerId, companyId, invoiceId] = [currencyId, acquirerId, partnerId, companyId, invoiceId].map(str => this._castAsInt(str));
        let amount = this._castAsFloat(opts.amount);

        const env = await req.getEnv();
        // Raise an HTTP 404 if a partner is provided with an invalid access token
        if (partnerId) {
            if (! await checkAccessToken(env, opts.accessToken, partnerId, amount, currencyId)) {
                throw new NotFound(res);  // Don't leak info about the existence of an id;
            }
        }
        const userSudo = await env.user();
        const loggedIn = ! await userSudo._isPublic();
        // If the user is logged in, take their partner rather than the partner set in the params.
        // This is something that we want, since security rules are based on the partner, and created
        // tokens should not be assigned to the public user. This should have no impact on the
        // transaction itself besides making reconciliation possibly more difficult (e.g. The
        // transaction and invoice partners are different).
        let partnerSudo, partnerIsDifferent = false;
        if (loggedIn) {
            partnerIsDifferent = partnerId && partnerId != (await userSudo.partnerId).id;
            partnerSudo = await userSudo.partnerId;
        }
        else {
            partnerSudo = await (await env.items('res.partner').sudo()).browse(partnerId).exists();
            if (!partnerSudo) {
                return req.redirect(res,
                    // Escape special characters to avoid loosing original params when redirected
                    `/web/login?redirect=${encodeURI(req.httpRequest.url)}`
                );
            }
        }
        // Instantiate transaction values to their default if not set in parameters
        reference = reference || singularizeReferencePrefix('tx');
        amount = amount || 0.0;  // If the amount is invalid, set it to 0 to stop the payment flow
        companyId = companyId || (await partnerSudo.companyId).id || (await userSudo.companyId).id;
        const company = (await env.items('res.company').sudo()).browse(companyId);
        currencyId = currencyId || (await company.currencyId).id;

        // Make sure that the currency exists and is active
        const currency = await env.items('res.currency').browse(currencyId).exists();
        if (!bool(currency) || ! await currency.active) {
            throw new NotFound(res);  // The currency must exist and be active
        }
        // Select all acquirers and tokens that match the constraints
        let acquirersSudo = await (await env.items('payment.acquirer').sudo())._getCompatibleAcquirers(
            companyId, partnerSudo.id, { ...opts, currencyId: currency.id }
        )  // In sudo mode to read the fields of acquirers and partner (if not logged in)
        if (acquirersSudo.ids.includes(acquirerId)) {  // Only keep the desired acquirer if it's suitable
            acquirersSudo = acquirersSudo.browse(acquirerId);
        }
        let paymentTokens = loggedIn ? await env.items('payment.token').search(
            [['acquirerId', 'in', acquirersSudo.ids], ['partnerId', '=', partnerSudo.id]]
        ) : env.items('payment.token');

        // Make sure that the partner's company matches the company passed as parameter.
        if (! await PaymentPortal._canPartnerPayInCompany(partnerSudo, company)) {
            acquirersSudo = await env.items('payment.acquirer').sudo();
            paymentTokens = env.items('payment.token');
        }

        // Compute the fees taken by acquirers supporting the feature
        const feesByAcquirer = new Map();
        for (const acqSudo of (await acquirersSudo.filtered('feesActive'))) {
            feesByAcquirer.set(acqSudo, await acqSudo._computeFees(amount, currency, await partnerSudo.countryId));
        }

        // Generate a new access token in case the partner id or the currency id was updated
        accessToken = generateAccessToken(env, partnerSudo.id, amount, currency.id);

        const renderingContext = {
            'acquirers': acquirersSudo,
            'tokens': paymentTokens,
            'feesByAcquirer': feesByAcquirer,
            'showTokenizeInput': loggedIn,  // Prevent public partner from saving payment methods
            'referencePrefix': reference,
            'amount': amount,
            'currency': currency,
            'partnerId': partnerSudo.id,
            'accessToken': accessToken,
            'transactionRoute': '/payment/transaction',
            'landingRoute': '/payment/confirmation',
            'resCompany': company,  // Display the correct logo in a multi-company environment
            'partnerIsDifferent': partnerIsDifferent,
            'invoiceId': invoiceId,
            ... await this._getCustomRenderingContextValues(env, opts),
        }
        return req.render(res, await this._getPaymentPageTemplateXmlid(opts), renderingContext);
    }

    async _getPaymentPageTemplateXmlid(opts) {
        return 'payment.pay';
    }

    /**
     * Display the form to manage payment methods.

        :param dict kwargs: Optional data. This parameter is not used here
        :return: The rendered manage form
        :rtype: str
     * @param req 
     * @param res 
     * @param opts 
     */
    @http.route('/my/paymentMethod', { type: 'http', methods: ['GET'], auth: 'user', website: true })
    async paymentMethod(req, res, opts: {} = {}) {
        const env = await req.getEnv();
        const partner = await (await env.user()).partnerId;
        const acquirersSudo = await (await env.items('payment.acquirer').sudo())._getCompatibleAcquirers(
            (await env.company()).id, partner.id, { forceTokenization: true, isValidation: true }
        );
        const tokens = (await partner.paymentTokenIds).union(
            await (await (await partner.commercialPartnerId).sudo()).paymentTokenIds
        );  // Show all partner's tokens, regardless of which acquirer is available
        const accessToken = await generateAccessToken(env, partner.id, null, null);
        const renderingContext = {
            'acquirers': acquirersSudo,
            'tokens': tokens,
            'referencePrefix': await singularizeReferencePrefix('validation'),
            'partnerId': partner.id,
            'accessToken': accessToken,
            'transactionRoute': '/payment/transaction',
            'landingRoute': '/my/paymentMethod',
            ...await this._getCustomRenderingContextValues(env, opts),
        }
        return req.render(res, 'payment.paymentMethods', renderingContext)
    }

    /**
     * Return a dict of additional rendering context values.

        :param dict kwargs: Optional data. This parameter is not used here
        :return: The dict of additional rendering context values
        :rtype: dict
     * @param opts 
     * @returns 
     */
    async _getCustomRenderingContextValues(env, opts: any = {}) {
        return {}
    }

    /**
     * Create a draft transaction and return its processing values.

        :param float|None amount: The amount to pay in the given currency.
                                  None if in a payment method validation operation
        :param int|None currencyId: The currency of the transaction, as a `res.currency` id.
                                     None if in a payment method validation operation
        :param int partnerId: The partner making the payment, as a `res.partner` id
        :param str accessToken: The access token used to authenticate the partner
        :param dict kwargs: Locally unused data passed to `_create_transaction`
        :return: The mandatory values for the processing of the transaction
        :rtype: dict
        :raise: ValidationError if the access token is invalid
     * @param req 
     * @param res 
     * @param opts 
     * @returns 
     */
    @http.route('/payment/transaction', { type: 'json', auth: 'public' })
    async paymentTransaction(req, res, opts: { amount?: any, currencyId?: any, partnerId?: any, accessToken?: any } = {}) {
        // Check the access token against the transaction values
        const env = await req.getEnv();
        const amount = opts.amount && parseFloat(opts.amount);  // Cast as float in case the JS stripped the '.0'
        if (! await checkAccessToken(env, opts.accessToken, opts.partnerId, opts.amount, opts.currencyId)) {
            throw new ValidationError(await _t(env, "The access token is invalid."));
        }

        pop(opts, 'customCreateValues', null);  // Don't allow passing arbitrary create values
        const txSudo = await this._createTransaction(env, { ...opts, amount });
        await this._updateLandingRoute(env, txSudo, opts.accessToken)  // Add the required parameters to the route
        return txSudo._getProcessingValues();
    }

    /**
     * Create a draft transaction based on the payment context and return it.

        :param int paymentOptionId: The payment option handling the transaction, as a
                                      `payment.acquirer` id or a `payment.token` id
        :param str referencePrefix: The custom prefix to compute the full reference
        :param float|None amount: The amount to pay in the given currency.
                                  None if in a payment method validation operation
        :param int|None currencyId: The currency of the transaction, as a `res.currency` id.
                                     None if in a payment method validation operation
        :param int partnerId: The partner making the payment, as a `res.partner` id
        :param str flow: The online payment flow of the transaction: 'redirect', 'direct' or 'token'
        :param bool tokenization_requested: Whether the user requested that a token is created
        :param str landingRoute: The route the user is redirected to after the transaction
        :param bool isValidation: Whether the operation is a validation
        :param int invoiceId: The account move for which a payment id made, as an `account.move` id
        :param dict customCreateValues: Additional create values overwriting the default ones
        :param dict kwargs: Locally unused data passed to `_is_tokenization_required` and
                            `_computeReference`
        :return: The sudoed transaction that was created
        :rtype: recordset of `payment.transaction`
        :raise: UserError if the flow is invalid
     * @param opts 
     */
    async _createTransaction(req, opts: {
        paymentOptionId?: any, referencePrefix?: any, amount?: any, currencyId?: any, partnerId?: any, flow?: any,
        tokenizationRequested?: any, landingRoute?: any, isValidation?: boolean, invoiceId?: any,
        customCreateValues?: any
    } = {}) {
        let { paymentOptionId, referencePrefix, amount, currencyId, partnerId, flow, tokenizationRequested, landingRoute, isValidation, invoiceId, customCreateValues } = opts;
        const env = await req.getEnv();
        // Prepare create values
        let tokenId, acquirerSudo, tokenize;
        if (['redirect', 'direct'].includes(flow)) {  // Direct payment or payment with redirection
            acquirerSudo = (await env.items('payment.acquirer').sudo()).browse(paymentOptionId);
            const tokenizationRequiredOrRequested = await acquirerSudo._isTokenizationRequired({ provider: await acquirerSudo.provider, ...opts }) || tokenizationRequested;
            tokenize = bool(
                // Don't tokenize if the user tried to force it through the browser's developer tools
                await acquirerSudo.allowTokenization
                // Token is only created if required by the flow or requested by the user
                && tokenizationRequiredOrRequested
            );
        }
        else if (flow === 'token') {  // Payment by token
            const tokenSudo = (await env.items('payment.token').sudo()).browse(paymentOptionId);

            // Prevent from paying with a token that doesn't belong to the current partner (either
            // the current user's partner if logged in, or the partner on behalf of whom the payment
            // is being made).
            const partnerSudo = (await env.items('res.partner').sudo()).browse(partnerId);
            if (!(await partnerSudo.commercialPartnerId).eq(await (await tokenSudo.partnerId).commercialPartnerId)) {
                throw new AccessError(await _t(env, "You do not have access to this payment token."));
            }

            acquirerSudo = await tokenSudo.acquirerId;
            tokenId = paymentOptionId;
            tokenize = false;
        }
        else {
            throw new UserError(
                await _t(env, "The payment should either be direct, with redirection, or made by a token.")
            );
        }

        if (bool(invoiceId)) {
            if (customCreateValues == null) {
                customCreateValues = {};
            }
            customCreateValues['invoiceIds'] = [Command.set([parseInt(invoiceId)])];
        }

        const reference = await env.items('payment.transaction')._computeReference(
            acquirerSudo.provider,
            {
                prefix: referencePrefix,
                ...(customCreateValues ?? {}),
                ...opts
            }
        )
        if (isValidation) {  // Acquirers determine the amount and currency in validation operations
            amount = await acquirerSudo._getValidationAmount();
            currencyId = (await acquirerSudo._getValidationCurrency()).id;
        }

        // Create the transaction
        const txSudo = await (await env.items('payment.transaction').sudo()).create({
            'acquirerId': acquirerSudo.id,
            'reference': reference,
            'amount': amount,
            'currencyId': currencyId,
            'partnerId': partnerId,
            'tokenId': tokenId,
            'operation': !isValidation ? `online${_.upperFirst(flow)}` : 'validation',
            'tokenize': tokenize,
            'landingRoute': landingRoute,
            ...(customCreateValues ?? {}),
        });  // In sudo mode to allow writing on callback fields

        if (flow === 'token') {
            await txSudo._sendPaymentRequest();  // Payments by token process transactions immediately
        }
        else {
            await txSudo._logSentMessage();
        }
        // Monitor the transaction to make it available in the portal
        PaymentPostProcessing.monitorTransactions(req, txSudo);

        return txSudo;
    }

    /**
     * Add the mandatory parameters to the route and recompute the access token if needed.

        The generic landing route requires the tx id and access token to be provided since there is
        no document to rely on. The access token is recomputed in case we are dealing with a
        validation transaction (acquirer-specific amount and currency).

        :param recordset txSudo: The transaction whose landing routes to update, as a
                                  `payment.transaction` record.
        :param str accessToken: The access token used to authenticate the partner
        :return: None
     * @param txSudo 
     * @param accessToken 
     */
    async _updateLandingRoute(env, txSudo, accessToken) {
        if (await txSudo.operation === 'validation') {
            accessToken = await generateAccessToken(
                env, (await txSudo.partnerId).id, await txSudo.amount, (await txSudo.currencyId).id
            );
        }
        await txSudo.set('landingRoute', `${await txSudo.landingRoute} \
                                ?txId=${txSudo.id}&accessToken=${accessToken}`);
    }

    /**
     * Display the payment confirmation page with the appropriate status message to the user.

        :param str tx_id: The transaction to confirm, as a `payment.transaction` id
        :param str accessToken: The access token used to verify the user
        :param dict kwargs: Optional data. This parameter is not used here
        :raise: theveb.exceptions.NotFound if the access token is invalid
     * @param req 
     * @param res 
     * @param opts 
     */
    @http.route('/payment/confirmation', { type: 'http', methods: ['GET'], auth: 'public', website: true })
    async paymentConfirm(req: WebRequest, res, opts: { txId?: any, accessToken?: any } = {}) {
        const txId = this._castAsInt(opts.txId)
        if (txId) {
            const txSudo = await ((await req.getEnv()).items('payment.transaction').sudo()).browse(txId);

            const env = await req.getEnv();
            // Raise an HTTP 404 if the access token is invalid
            if (! await checkAccessToken(
                env, opts.accessToken, (await txSudo.partnerId).id, await txSudo.amount, (await txSudo.currencyId).id
            )) {
                throw new NotFound(res);  // Don't leak info about existence of an id
            }
            // Fetch the appropriate status message configured on the acquirer
            let status, message;
            const [state, acquirer] = await txSudo('state', 'acquirerId');
            if (state === 'draft') {
                status = 'info';
                message = await txSudo.stateMessage || _t(env, "This payment has not been processed yet.");
            }
            else if (state === 'pending') {
                status = 'warning';
                message = await acquirer.pendingMsg;
            }
            else if (['authorized', 'done'].includes(state)) {
                status = 'success';
                message = await acquirer.doneMsg;
            }
            else if (state === 'cancel') {
                status = 'danger';
                message = await acquirer.cancelMsg;
            }
            else {
                status = 'danger';
                message = await txSudo.stateMessage || _t(env, "An error occurred during the processing of this payment.");
            }

            // Display the payment confirmation page to the user
            PaymentPostProcessing.removeTransactions(req, txSudo);
            const renderValues = {
                'tx': txSudo,
                'status': status,
                'message': message
            }
            return req.render(res, 'payment.confirm', renderValues);
        }
        else {
            // Display the portal homepage to the user
            return req.redirect(res, '/my/home');
        }
    }

    /**
     * Check that a user has write access on a token and archive the token if so.

        :param int token_id: The token to archive, as a `payment.token` id
        :return: None
     * @param req 
     * @param res 
     * @param opts 
     * @returns 
     */
    @http.route('/payment/archiveToken', { type: 'json', auth: 'user' })
    async archiveToken(req, res, opts: { tokenId?: any } = {}) {
        const env = await req.getEnv();
        const partnerSudo = await (await env.user()).partnerId;
        const tokenSudo = await (await env.items('payment.token').sudo()).search([
            ['id', '=', opts.tokenId],
            // Check that the user owns the token before letting them archive anything
            ['partnerId', 'in', [partnerSudo.id, (await partnerSudo.commercialPartnerId).id]]
        ]);
        if (bool(tokenSudo)) {
            await tokenSudo.set('active', false);
        }
    }

    /**
     * Cast a string as an `int` and return it.

        If the conversion fails, `None` is returned instead.

        :param str strValue: The value to cast as an `int`
        :return: The casted value, possibly replaced by None if incompatible
        :rtype: int|None
     */
    _castAsInt(strValue) {
        try {
            return parseInt(strValue);
        } catch (e) {
            return null;
        }
    }
    /**
     * Cast a string as a `float` and return it.

        If the conversion fails, `None` is returned instead.

        :param str strValue: The value to cast as a `float`
        :return: The casted value, possibly replaced by None if incompatible
        :rtype: float|None
     */
    _castAsFloat(strValue) {
        try {
            return parseFloat(strValue);
        } catch (e) {
            return null;
        }
    }

    /**
     * Return whether the provided partner can pay in the provided company.

        The payment is allowed either if the partner's company is not set or if the companies match.

        :param recordset partner: The partner on behalf on which the payment is made, as a
                                  `res.partner` record.
        :param recordset documentCompany: The company of the document being paid, as a
                                           `res.company` record.
        :return: Whether the payment is allowed.
        :rtype: str
     * @param partner 
     * @param documentCompany 
     * @returns 
     */
    static async _canPartnerPayInCompany(partner, documentCompany) {
        return !bool(await partner.companyId) || (await partner.companyId).eq(documentCompany);
    }
}