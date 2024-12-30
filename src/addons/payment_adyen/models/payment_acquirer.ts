import { api, Fields, http } from "../../../core";
import { ValidationError } from "../../../core/helper";
import { _super, MetaModel, Model } from "../../../core/models"
import { _f, f, lstrip, rstrip } from "../../../core/tools";
import { API_ENDPOINT_VERSIONS } from "../const";

@MetaModel.define()
class PaymentAcquirer extends Model {
    static _module = module;
    static _parents = 'payment.acquirer';

    static provider = Fields.Selection({
        selectionAdd: [['adyen', "Adyen"]], ondelete: {'adyen': 'SET DEFAULT'}});
    static adyenMerchantAccount = Fields.Char({
        string: "Merchant Account",
        help: "The code of the merchant account to use with this acquirer",
        provider: 'adyen', groups: 'base.groupSystem'});
    static adyenApiKey = Fields.Char({
        string: "API Key", help: "The API key of the webservice user", provider: 'adyen',
        groups: 'base.groupSystem'});
    static adyenClientKey = Fields.Char({
        string: "Client Key", help: "The client key of the webservice user",
        provider: 'adyen'});
    static adyenHmacKey = Fields.Char({
        string: "HMAC Key", help: "The HMAC key of the webhook", provider: 'adyen',
        groups: 'base.groupSystem'});
    static adyenCheckoutApiUrl = Fields.Char({
        string: "Checkout API URL", help: "The base URL for the Checkout API endpoints",
        provider: 'adyen'});
    static adyenRecurringApiUrl = Fields.Char({
        string: "Recurring API URL", help: "The base URL for the Recurring API endpoints",
        provider: 'adyen'});

    //=== CRUD METHODS ===#

    @api.modelCreateMulti()
    async create(valuesList) {
        for (const values of valuesList) {
            await this._adyenTrimApiUrls(values);
        }
        return _super(PaymentAcquirer, this).create(valuesList);
    }

    async write(values) {
        await this._adyenTrimApiUrls(values);
        return _super(PaymentAcquirer, this).write(values);
    }

    /**
     * Remove the version and the endpoint from the url of Adyen API fields.

        :param dict values: The create or write values
        :return: void
     * @param values 
     */
    @api.model()
    async _adyenTrimApiUrls(values) {
        for (const fieldName of ['adyenCheckoutApiUrl', 'adyenRecurringApiUrl']) {
            if (values[fieldName]) {  // Test the value in case we're duplicating an acquirer
                values[fieldName] = values[fieldName].replace(/[vV]\d+(\/.*)?/, '');
            }
        }
    }

    //=== BUSINESS METHODS ===#

    /**
     * Make a request to Adyen API at the specified endpoint.

        Note: this.ensureOne()

        :param str urlFieldName: The name of the field holding the base URL for the request
        :param str endpoint: The endpoint to be reached by the request
        :param str endpointParam: A variable required by some endpoints which are interpolated with
                                   it if provided. For example, the acquirer reference of the source
                                   transaction for the '/payments/{}/refunds' endpoint.
        :param dict payload: The payload of the request
        :param str method: The HTTP method of the request
        :return: The JSON-formatted content of the response
        :rtype: dict
        :raise: ValidationError if an HTTP error occurs
     * @param urlFieldName 
     * @param endpoint 
     * @param endpointParam 
     * @param payload 
     * @param method 
     * @returns 
     */
    async _adyenMakeRequest(urlFieldName, endpoint, endpointParam?: any, payload?: any, method='POST') {
        /**
         * Build an API URL by appending the version and endpoint to a base URL.

            The final URL follows this pattern: `<_base>/V<_version>/<_endpoint>`.

            :param str baseUrl: The base of the url prefixed with `https://`
            :param int version: The version of the endpoint
            :param str endpoint: The endpoint of the URL.
            :return: The final URL
            :rtype: str
         * @param baseUrl 
         * @param version 
         * @param endpoint 
         * @returns 
         */
        function _buildUrl(baseUrl, version, endpoint) {
            const base = rstrip(baseUrl, '/');  // Remove potential trailing slash
            endpoint = lstrip(endpoint, '/');  // Remove potential leading slash
            return `${base}/V${version}/${endpoint}`;
        }

        this.ensureOne();

        const baseUrl = await this[urlFieldName];  // Restrict request URL to the stored API URL fields
        const version = API_ENDPOINT_VERSIONS[endpoint];
        endpoint = !endpointParam ? endpoint : _f(endpoint, endpointParam);
        const url = _buildUrl(baseUrl, version, endpoint);
        const headers = {'X-API-Key': await this['adyenApiKey']};
        let response;
        try {
            response = await http.httpPost(payload, url, {method, headers, timeout: 60});
            response.raiseForStatus();
        } catch(e) {
            if (e.statusCode === 408) {
                console.error("unable to reach endpoint at %s", url);
                throw new ValidationError("Adyen: " + await this._t("Could not establish the connection to the API."));
            }
            else {
                console.error(
                    "invalid API request at %s with data %s: %s", url, payload, e.massage
                );
                throw new ValidationError("Adyen: " + await this._t("The communication with the API failed."));
            }
        }
        return response.body;
    }

    /**
     * Compute a unique reference of the partner for Adyen.

        This is used for the `shopperReference` field in communications with Adyen and stored in the
        `adyenShopperReference` field on `payment.token` if the payment method is tokenized.

        :param recordset partnerId: The partner making the transaction, as a `res.partner` id
        :return: The unique reference for the partner
        :rtype: str
     * @param partnerId 
     * @returns 
     */
    async _adyenComputeShopperReference(partnerId) {
        return `VERP_PARTNER_${partnerId}`;
    }

    async _getDefaultPaymentMethodId() {
        this.ensureOne();
        if (await this['provider'] !== 'adyen') {
            return _super(PaymentAcquirer, this)._getDefaultPaymentMethodId();
        }
        return (await this.env.ref('payment_adyen.paymentMethodAdyen')).id;
    }
}
