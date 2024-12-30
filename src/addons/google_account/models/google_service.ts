import assert from "assert";
import { _Datetime, api } from "../../../core";
import { UserError } from "../../../core/helper";
import { httpGet, httpPost } from "../../../core/http";
import { AbstractModel, MetaModel } from "../../../core/models";
import { urlEncode, urlParse } from "../../../core/service/middleware/utils";
import { f, jsonParse, parseInt, setOptions, stringify, toFormat } from "../../../core/tools";
import camelCase from "lodash.camelcase";

export const TIMEOUT = 20;
export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/auth';
export const GOOGLE_TOKEN_ENDPOINT = 'https://accounts.google.com/o/oauth2/token';
export const GOOGLE_API_BASE_URL = 'https://www.googleapis.com';

@MetaModel.define()
class GoogleService extends AbstractModel {
    static _module = module;
    static _name = 'google.service';
    static _description = 'Google Service';

    /**
     * Call Google API to refresh the token, with the given authorization code
     * @param service the name of the google service to actualize
     * @param authorizationCode the code to exchange against the new refresh token
     * @returns the new refresh token
     */
    @api.model()
    async generateRefreshToken(service, authorizationCode) {
        const parameters = await this.env.items('ir.config.parameter').sudo();
        const clientId = await parameters.getParam(camelCase(f('google_%s_client_id', service)));
        const clientSecret = await parameters.getParam(camelCase(f('google_%s_client_secret', service)));
        const redirectUri = await parameters.getParam('googleRedirectUri');

        // Get the Refresh Token From Google And store it in ir.config_parameter
        const headers = {"Content-type": "application/x-www-form-urlencoded"}
        const data = {
            'code': authorizationCode,
            'client_id': clientId,
            'client_secret': clientSecret,
            'redirect_uri': redirectUri,
            'grant_type': "authorization_code"
        }
        let content;
        try {
            const req = await httpGet(GOOGLE_TOKEN_ENDPOINT, {params: data, headers, timeout: TIMEOUT});
            req.raiseForStatus();
            content = jsonParse(req);
        } catch(e) {
            const errorMsg = await this._t("Something went wrong during your token generation. Maybe your Authorization Code is invalid or already expired");
            throw await this.env.items('res.config.settings').getConfigWarning(errorMsg);
        }
        return content['refresh_token'];
    }

    @api.model()
    async _getGoogleTokenUri(service, scope) {
        const sudo = await this.env.items('ir.config.parameter').sudo();
        const getParam = sudo.getParam;
        const encodedParams = urlEncode({
            'scope': scope,
            'redirect_uri': await getParam('googleRedirectUri'),
            'client_id': await getParam(camelCase(f('google_%s_client_id', service))),
            'response_type': 'code',
        });
        return f('%s?%s', GOOGLE_AUTH_ENDPOINT, encodedParams);
    }

    /**
     * This method return the url needed to allow this instance of Verp to access to the scope
            of gmail specified as parameters
     * @param fromUrl 
     * @param service 
     * @param scope 
     */
    @api.model()
    async _getAuthorizeUri(fromUrl, service, scope=false) {
        const state = {
            'd': this.env.cr.dbName,
            's': service,
            'f': fromUrl
        }

        const sudo = await this.env.items('ir.config.parameter').sudo();
        const getParam = sudo.getParam,
        baseUrl = this._context['baseUrl'] || await (await this.env.user()).getBaseUrl(),
        clientId = await getParam(camelCase(f('google_%s_client_id', service)), false);

        const encodedParams = urlEncode({
            'response_type': 'code',
            'client_id': clientId,
            'state': stringify(state),
            'scope': scope || f('%s/auth/%s', GOOGLE_API_BASE_URL, service),  // If no scope is passed, we use service by default to get a default scope
            'redirect_uri': baseUrl + '/google_account/authentication',
            'approval_prompt': 'force',
            'access_type': 'offline'
        });
        return f("%s?%s", GOOGLE_AUTH_ENDPOINT, encodedParams);
    }

    /**
     * Call Google API to exchange authorization code against token, with POST request, to
            not be redirected.
     * @param authorizeCode 
     * @param service 
     */
    @api.model()
    async _getGoogleTokens(authorizeCode, service) {
        const sudo = await this.env.items('ir.config.parameter').sudo();
        const getParam = sudo.getParam,
        baseUrl = this._context['baseUrl'] || await (await this.env.user()).getBaseUrl(),
        clientId = await getParam(camelCase(f('google_%s_client_id', service)), false),
        clientSecret = await getParam(camelCase(f('google_%s_client_secret', service)), false);

        const headers = {"content-type": "application/x-www-form-urlencoded"}
        const data = {
            'code': authorizeCode,
            'client_id': clientId,
            'client_secret': clientSecret,
            'grant_type': 'authorization_code',
            'redirect_uri': baseUrl + '/google_account/authentication'
        }
        try {
            const [, response, ] = await this._doRequest(data, GOOGLE_TOKEN_ENDPOINT, {headers, method: 'POST', preuri: ''});
            const accessToken = response['access_token'];
            const refreshToken = response['refresh_token'];
            const ttl = response['expires_in'];
            return [accessToken, refreshToken, ttl];
        } catch(e) {
            const errorMsg = await this._t("Something went wrong during your token generation. Maybe your Authorization Code is invalid");
            throw await this.env.items('res.config.settings').getConfigWarning(errorMsg);
        }
    }

    /**
     * Fetch the access token thanks to the refresh token.
     * @param refreshToken 
     * @param service 
     * @param scope 
     */
    @api.model()
    async _getAccessToken(refreshToken, service, scope) {
        const sudo = await this.env.items('ir.config.parameter').sudo();
        const getParam = sudo.getParam,
        clientId = await getParam(camelCase(f('google_%s_client_id', service)), false),
        clientSecret = await getParam(camelCase(f('google_%s_client_secret', service)), false);

        if (!clientId || !clientSecret) {
            throw new UserError(await this._t('Google %s is not yet configured.', await service.title()));
        }

        if (!refreshToken) {
            throw new UserError(await this._t('The refresh token for authentication is not set.'));
        }

        let res;
        try {
            res = await httpGet(
                GOOGLE_TOKEN_ENDPOINT,
                {params:                 {
                    'client_id': clientId,
                    'client_secret': clientSecret,
                    'refresh_token': refreshToken,
                    'grant_type': 'refresh_token',
                    'scope': scope,
                },
                headers: {'Content-type': 'application/x-www-form-urlencoded'},
                timeout: TIMEOUT},
            );
            res.raiseForStatus();
        } catch(e) {
            throw new UserError(
                await this._t('Something went wrong during the token generation. Please request again an authorization code.')
            );
        }

        const jsonResult = jsonParse(res);

        return [jsonResult['access_token'], jsonResult['expires_in']];
    }

    /**
     * Execute the request to Google API. Return a tuple ('HTTP_CODE', 'HTTP_RESPONSE')
     * @param params dict or already encoded parameters for the request to make
     * @param uri the url to contact
     * @param headers headers of request
     * @param method the method to use to make the request
     * @param preuri pre url to prepend to param uri.
     */
    @api.model()
    async _doRequest(params, uri, opts: {headers?: any, method?: string, preuri?: string, timeout?: number}={}) {
        setOptions(opts, {headers: {}, method: 'POST', preuri: GOOGLE_API_BASE_URL, timeout: TIMEOUT});
        const {headers, method, preuri, timeout} = opts;
        if (params == null) {
            params = {};
        }

        assert([GOOGLE_TOKEN_ENDPOINT, GOOGLE_API_BASE_URL].map(url => urlParse(url).host).includes(urlParse(preuri + uri).host));

        console.debug("Uri: %s - Type : %s - Headers: %s - Params : %s !", uri, method, stringify(headers), stringify(params));

        const askTime = _Datetime.now();
        let response, status;
        try {
            let res;
            if (['GET', 'DELETE'].includes(method.toUpperCase())) {
                res = await httpGet(preuri + uri, {method, params, timeout});
            }
            else if (['POST', 'PATCH', 'PUT'].includes(method.toUpperCase())) {
                res = await httpPost(params, preuri + uri, {method, headers, timeout});
            }
            else {
                throw new Error(await this._t('Method not supported [%s] not in [GET, POST, PUT, PATCH or DELETE]!', method));
            }
            await res.raiseForStatus();
            status = res.statusCode;

            if (parseInt(status) == 204) {  // Page not found, no response
                response = false;
            }
            else {
                response = jsonParse(res);
            }
            let askTime;
            try {
                askTime = toFormat(res.headers['date'] ?? null, "DDD HH:mm:ss z")
            } catch(e) {
                // pass;
            }
        } catch(e) {
            if ([204, 404].includes(e.response.statusCode)) {
                status = e.response.statusCode;
                response = "";
            }
            else {
                console.error("Bad google request : %s !", e.response.content);
                throw e;
            }
        }
        return [status, response, askTime];
    }
}
