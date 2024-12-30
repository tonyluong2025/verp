// // Part of Verp. See LICENSE file for full copyright and licensing details.

import { http } from "../../../core";
import { ValidationError } from "../../../core/helper";
import { WebRequest } from "../../../core/http";
import { urlJoin } from "../../../core/service/middleware/utils";
import { b64encode, hash, isInstance, toText } from "../../../core/tools";
import { checkAccessToken, getCustomerIpAddress, toMinorCurrencyUnits } from "../../payment/utils";
import { CURRENCY_DECIMALS } from "../const";
import { formatPartnerName, includePartnerAddresses } from "../utils";

@http.define()
class AdyenController extends http.Controller {
    static _module = module;

    /**
     * Return public information on the acquirer.

        :param int acquirerId: The acquirer handling the transaction, as a `payment.acquirer` id
        :return: Public information on the acquirer, namely: the state and client key
        :rtype: str
     * @param req 
     * @param res 
     * @param acquirerId 
     * @returns 
     */
    @http.route('/payment/adyen/acquirerInfo', { type: 'json', auth: 'public' })
    async adyenAcquirerInfo(req, res, opts: { acquirerId?: any } = {}) {
        const acquirerSudo = await (await (await req.getEnv()).items('payment.acquirer').sudo()).browse(opts.acquirerId).exists();
        return {
            'state': await acquirerSudo.state,
            'clientKey': await acquirerSudo.adyenClientKey,
        }
    }

    /**
     * Query the available payment methods based on the transaction context.

        :param int acquirerId: The acquirer handling the transaction, as a `payment.acquirer` id
        :param float amount: The transaction amount
        :param int currencyId: The transaction currency, as a `res.currency` id
        :param int partnerId: The partner making the transaction, as a `res.partner` id
        :return: The JSON-formatted content of the response
        :rtype: dict
     * @param req 
     * @param res 
     * @param opts 
     */
    @http.route('/payment/adyen/paymentMethods', { type: 'json', auth: 'public' })
    async adyenPaymentMethods(req, res, opts: { acquirerId?: any, amount?: any, currencyId?: any, partnerId?: any } = {}) {
        const env = await req.getEnv();
        const acquirerSudo = (await env.items('payment.acquirer').sudo()).browse(opts.acquirerId);
        const currency = env.items('res.currency').browse(opts.currencyId);
        const currencyCode = opts.currencyId && await currency.label;
        const convertedAmount = opts.amount && currencyCode && await toMinorCurrencyUnits(
            opts.amount, currency, CURRENCY_DECIMALS[currencyCode]
        );
        const partnerSudo = opts.partnerId && await (await env.items('res.partner').sudo()).browse(opts.partnerId).exists();
        // The lang is taken from the context rather than from the partner because it is not required
        // to be logged in to make a payment, and because the lang is not always set on the partner.
        // Adyen only supports a limited set of languages but, instead of looking for the closest
        // match in https://docs.adyen.com/checkout/components-web/localization-components, we simply
        // provide the lang string as is (after adapting the format) and let Adyen find the best fit.
        const langCode = (req.context['lang'] || 'en-US').replace('-', '_');
        const shopperReference = partnerSudo && `VERP_PARTNER_${partnerSudo.id}`;
        const data = {
            'merchantAccount': await acquirerSudo.adyenMerchantAccount,
            'amount': convertedAmount,
            'countryCode': await (await partnerSudo.countryId).code || null,  // ISO 3166-1 alpha-2 (e.g.: 'BE')
            'shopperLocale': langCode,  // IETF language tag (e.g.: 'fr-BE')
            'shopperReference': shopperReference,
            'channel': 'Web',
        }
        const responseContent = await acquirerSudo._adyenMakeRequest(
            'adyenCheckoutApiUrl',
            '/paymentMethods',
            null,
            data,
            'POST'
        );
        console.info("paymentMethods request response:\n%s", responseContent);
        return responseContent;
    }

    /**
     * Make a payment request and process the feedback data.

        :param int acquirerId: The acquirer handling the transaction, as a `payment.acquirer` id
        :param str reference: The reference of the transaction
        :param int converted_amount: The amount of the transaction in minor units of the currency
        :param int currencyId: The currency of the transaction, as a `res.currency` id
        :param int partnerId: The partner making the transaction, as a `res.partner` id
        :param dict payment_method: The details of the payment method used for the transaction
        :param str accessToken: The access token used to verify the provided values
        :param dict browser_info: The browser info to pass to Adyen
        :return: The JSON-formatted content of the response
        :rtype: dict
     * @param req 
     * @param res 
     * @param opts 
     */
    @http.route('/payment/adyen/payments', { type: 'json', auth: 'public' })
    async adyenPayments(req, res, opts: { acquirerId?: any, reference?: any, convertedAmount?: any, currencyId?: any, partnerId?: any, paymentMethod?: any, accessToken?: any, browserInfo?: any } = {}) {
        // Check that the transaction details have not been altered. This allows preventing users
        // from validating transactions by paying less than agreed upon.
        if (! await checkAccessToken(opts.accessToken, opts.reference, opts.convertedAmount, opts.partnerId)) {
            throw new ValidationError("Adyen: " + await this._t("Received tampered payment request data."));
        }
        const env = await req.getEnv();
        // Make the payment request to Adyen
        const acquirerSudo = await (await env.items('payment.acquirer').sudo()).browse(opts.acquirerId).exists();
        const txSudo = await (await env.items('payment.transaction').sudo()).search([['reference', '=', opts.reference]]);
        const data = {
            'merchantAccount': await acquirerSudo.adyenMerchantAccount,
            'amount': {
                'value': opts.convertedAmount,
                'currency': await env.items('res.currency').browse(opts.currencyId).label,  // ISO 4217
            },
            'reference': opts.reference,
            'paymentMethod': opts.paymentMethod,
            'shopperReference': await acquirerSudo._adyenComputeShopperReference(opts.partnerId),
            'recurringProcessingModel': 'CardOnFile',  // Most susceptible to trigger a 3DS check
            'shopperIP': await getCustomerIpAddress(req),
            'shopperInteraction': 'Ecommerce',
            'shopperEmail': await txSudo.partnerEmail,
            'shopperName': formatPartnerName(await txSudo.partnerName),
            'telephoneNumber': await txSudo.partnerPhone,
            'storePaymentMethod': await txSudo.tokenize,  // True by default on Adyen side
            'additionalData': {
                'allow3DS2': true
            },
            'channel': 'web',  // Required to support 3DS
            'origin': await acquirerSudo.getBaseUrl(),  // Required to support 3DS
            'browserInfo': opts.browserInfo,  // Required to support 3DS
            'returnUrl': urlJoin(
                await acquirerSudo.getBaseUrl(),
                // Include the reference in the return url to be able to match it after redirection.
                // The key 'merchantReference' is chosen on purpose to be the same as that returned
                // by the /payments endpoint of Adyen.
                `/payment/adyen/return?merchantReference=${opts.reference}`
            ),
            ...await includePartnerAddresses(txSudo),
        }
        const responseContent = await acquirerSudo._adyenMakeRequest(
            'adyenCheckoutApiUrl',
            '/payments',
            null,
            data,
            'POST'
        )

        // Handle the payment request response
        console.info("payment request response:\n%s", responseContent);
        await (await env.items('payment.transaction').sudo())._handleFeedbackData(
            'adyen', Object.assign({}, responseContent, { merchantReference: opts.reference }),  // Match the transaction
        );
        return responseContent;
    }

    /**
     * Submit the details of the additional actions and process the feedback data.

         The additional actions can have been performed both from the inline form or during a
         redirection.

        :param int acquirerId: The acquirer handling the transaction, as a `payment.acquirer` id
        :param str reference: The reference of the transaction
        :param dict payment_details: The details of the additional actions performed for the payment
        :return: The JSON-formatted content of the response
        :rtype: dict
     * @param req 
     * @param res 
     * @param opts 
     * @returns 
     */
    @http.route('/payment/adyen/paymentDetails', { type: 'json', auth: 'public' })
    async adyenPaymentDetails(req, res, opts: { acquirerId?: any, reference?: any, paymentDetails?: any } = {}) {
        // Make the payment details request to Adyen
        const env = await req.getEnv();
        const acquirerSudo = await env.items('payment.acquirer').browse(opts.acquirerId).sudo();
        const responseContent = await acquirerSudo._adyenMakeRequest(
            'adyenCheckoutApiUrl',
            '/payments/details',
            null,
            opts.paymentDetails,
            'POST'
        );

        // Handle the payment details request response
        console.info("payment details request response:\n%s", responseContent);
        await (await env.items('payment.transaction').sudo())._handleFeedbackData(
            'adyen', Object.assign({}, responseContent, { merchantReference: opts.reference }),  // Match the transaction
        );

        return responseContent;
    }

    /**
     * Process the data returned by Adyen after redirection.

        The route is flagged with `saveSession=false` to prevent Verp from assigning a new session
        to the user if they are redirected to this route with a POST request. Indeed, as the session
        cookie is created without a `SameSite` attribute, some browsers that don't implement the
        recommended default `SameSite=Lax` behavior will not include the cookie in the redirection
        request from the payment provider to Verp. As the redirection to the '/payment/status' page
        will satisfy any specification of the `SameSite` attribute, the session of the user will be
        retrieved and with it the transaction which will be immediately post-processed.

        :param dict data: Feedback data. May include custom params sent to Adyen in the request to
                          allow matching the transaction when redirected here.
     * @param req 
     * @param res 
     * @param opts 
     * @returns 
     */
    @http.route('/payment/adyen/return', { type: 'http', auth: 'public', csrf: false, saveSession: false })
    async adyenReturnFromRedirect(req, res, opts: { data?: any } = {}) {
        // Retrieve the transaction based on the reference included in the return url
        const txSudo = await (await (await req.getEnv()).items('payment.transaction').sudo())._getTxFromFeedbackData(
            'adyen', opts.data
        )

        // Overwrite the operation to force the flow to 'redirect'. This is necessary because even
        // thought Adyen is implemented as a direct payment provider, it will redirect the user out
        // of Verp in some cases. For instance, when a 3DS1 authentication is required, or for
        // special payment methods that are not handled by the drop-in (e.g. Sofort).
        await txSudo.set('operation', 'onlineRedirect');

        // Query and process the result of the additional actions that have been performed
        console.info("handling redirection from Adyen with data:\n%s", opts.data);
        await this.adyenPaymentDetails(req, res, {
            acquirerId: (await txSudo.acquirerId).id,
            reference: opts.data['merchantReference'],
            paymentDetails: {
                'details': {
                    'redirectResult': opts.data['redirectResult'],
                },
            },
        });

        // Redirect the user to the status page
        return req.redirect(res, '/payment/status');
    }

    /**
     * Process the data sent by Adyen to the webhook based on the event code.

        See https://docs.adyen.com/development-resources/webhooks/understand-notifications for the
        exhaustive list of event codes.

        :return: The '[accepted]' string to acknowledge the notification
        :rtype: str
     */
    @http.route('/payment/adyen/notification', { type: 'json', auth: 'public' })
    async adyenNotification(req: WebRequest, res) {
        const data = JSON.parse(req.httpRequest.body['data']); // Tony must check
        for (const notificationItem of data['notificationItems']) {
            const notificationData = notificationItem['NotificationRequestItem'];

            // Check the source and integrity of the notification
            const receivedSignature = (notificationData['additionalData'] ?? {})['hmacSignature'];
            const PaymentTransaction = (await req.getEnv()).items('payment.transaction');
            let err, acquirerSudo;
            try {
                acquirerSudo = PaymentTransaction.sudo()._get_tx_from_feedback_data(
                    'adyen', notificationData
                ).acquirerId  // Find the acquirer based on the transaction
            } catch (e) {
                err = e;
                if (isInstance(e, ValidationError)) {
                    // Warn rather than log the traceback to avoid noise when a POS payment notification
                    // is received and the corresponding `payment.transaction` record is not found.
                    console.warn("unable to find the transaction; skipping to acknowledge");
                } else {
                    throw e;
                }
            }
            if (!err) {
                if (! await this._verifyNotificationSignature(receivedSignature, notificationData, await acquirerSudo.adyenHmacKey)) {
                    continue;
                }

                // Check whether the event of the notification succeeded and reshape the notification
                // data for parsing
                console.info("notification received:\n%s", notificationData);
                const success = notificationData['success'] === 'true';
                const eventCode = notificationData['eventCode'];
                if (eventCode === 'AUTHORISATION' && success) {
                    notificationData['resultCode'] = 'Authorised';
                }
                else if (eventCode === 'CANCELLATION' && success) {
                    notificationData['resultCode'] = 'Cancelled';
                }
                else if (eventCode === 'REFUND') {
                    notificationData['resultCode'] = success ? 'Authorised' : 'Error';
                }
                else {
                    continue;  // Don't handle unsupported event codes and failed events
                }
                try {
                    // Handle the notification data as a regular feedback
                    await (await PaymentTransaction.sudo())._handleFeedbackData('adyen', notificationData);
                } catch (e) {
                    if (isInstance(e, ValidationError)) {  // Acknowledge the notification to avoid getting spammed
                        console.error("unable to handle the notification data;skipping to acknowledge");
                    } else {
                        throw e;
                    }
                }
            }
        }
        return '[accepted]';  // Acknowledge the notification
    }

    /**
     * Check that the signature computed from the payload matches the received one.

        See https://docs.adyen.com/development-resources/webhooks/verify-hmac-signatures

        :param str received_signature: The signature sent with the notification
        :param dict payload: The notification payload
        :param str hmacKey: The HMAC key of the acquirer handling the transaction
        :return: Whether the signatures match
        :rtype: str
     * @param receivedSignature 
     * @param payload 
     * @param hmacKey 
     */
    async _verifyNotificationSignature(receivedSignature, payload, hmacKey) {
        /**
         * Recursively generate a flat representation of a dict.

            :param Object value: The value to flatten. A dict or an already flat value
            :param str pathBase: They base path for keys of _value, including preceding separators
            :param str separator: The string to use as a separator in the key path
         * @param value 
         * @param pathBase 
         * @param separator 
         */
        function* _flattenDict(value, pathBase = '', separator = '.') {
            if (typeof value === 'object') {  // The inner value is a dict, flatten it
                pathBase = !pathBase ? pathBase : pathBase + separator;
                for (const key of Object.keys(value)) {
                    for (const val of _flattenDict(value[key], pathBase + key)) {
                        yield val;
                    }
                }
            }
            else {  // The inner value cannot be flattened, yield it
                yield [pathBase, value];
            }
        }

        /**
         * Escape payload values that are using illegal symbols and cast them to string.

            String values containing `\\` or `:` are prefixed with `\\`.
            Empty values (`null`) are replaced by an empty string.

            :param Object value: The value to escape
            :return: The escaped value
            :rtype: string
         * @param value 
         * @returns 
         */
        function _toEscapedString(value) {
            if (typeof value === 'string') {
                return value.replace('\\', '\\\\').replace(':', '\\:');
            }
            else if (value == null) {
                return '';
            }
            else {
                return String(value);
            }
        }

        if (!receivedSignature) {
            console.warn("ignored notification with missing signature");
            return false;
        }

        // Compute the signature from the payload
        const signatureKeys = [
            'pspReference', 'originalReference', 'merchantAccountCode', 'merchantReference',
            'amount.value', 'amount.currency', 'eventCode', 'success'
        ]
        // Flatten the payload to allow accessing inner dicts naively
        const flattenedPayload = Object.fromEntries(_flattenDict(payload));
        // Build the list of signature values as per the list of required signature keys
        const signatureValues = signatureKeys.map(key => flattenedPayload[key]);
        // Escape values using forbidden symbols
        const escapedValues = signatureValues.map(value => _toEscapedString(value));
        // Concatenate values together with ':' as delimiter
        const signingString = escapedValues.join(':');
        // Convert the HMAC key to the binary representation
        const binaryHmacKey = Buffer.from(Buffer.from(hmacKey, 'ascii').toString('hex'));
        // Calculate the HMAC with the binary representation of the signing string with SHA-256
        const binaryHmac = hash(binaryHmacKey, signingString, 'sha256');
        // Calculate the signature by encoding the result with Base64
        const expectedSignature = b64encode(binaryHmac);

        // Compare signatures
        if (receivedSignature != toText(expectedSignature)) {
            console.warn("ignored event with invalid signature");
            return false;
        }

        return true;
    }
}