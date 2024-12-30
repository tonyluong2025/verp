import { api } from "../../../core";
import { UserError, ValidationError } from "../../../core/helper";
import { WebRequest, httpPost } from "../../../core/http";
import { AbstractModel, MetaModel, _super } from "../../../core/models";

@MetaModel.define()
class Http extends AbstractModel {
    static _module = module;
    static _parents = 'ir.http';

    async sessionInfo(req) {
        const sessionInfo = await _super(Http, this).sessionInfo(req);
        return this._addPublicKeyToSessionInfo(sessionInfo);
    }

    @api.model()
    async getFrontendSessionInfo(req) {
        const frontendSessionInfo = await _super(Http, this).getFrontendSessionInfo(req);
        return this._addPublicKeyToSessionInfo(frontendSessionInfo);
    }

    /**
     * Add the ReCaptcha public key to the given session_info object
     * @param sessionInfo 
     * @returns 
     */
    @api.model()
    async _addPublicKeyToSessionInfo(sessionInfo) {
        const publicKey = await (await this.env.items('ir.config.parameter').sudo()).getParam('recaptchaPublicKey');
        if (publicKey) {
            sessionInfo['recaptchaPublicKey'] = publicKey;
        }
        return sessionInfo;
    }

    /**
     * Verify the recaptcha token for the current request.
            If no recaptcha private key is set the recaptcha verification
            is considered inactive and this method will return true.
     * @param action 
     * @returns 
     */
    @api.model()
    async _verifyRequestRecaptchaToken(req: WebRequest, action) {
        const ipAddr = req.httpRequest.socket.remoteAddress;
        const token = req.params.pop('recaptchaTokenResponse', false);
        const recaptchaResult = await (await req.getEnv()).items('ir.http')._verifyRecaptchaToken(ipAddr, token, action);
        if (['isHuman', 'noSecret'].includes(recaptchaResult)) {
            return true;
        }
        if (recaptchaResult === 'wrongSecret') {
            throw new ValidationError(await this._t("The reCaptcha private key is invalid."));
        }
        else if (recaptchaResult === 'wrongToken') {
            throw new ValidationError(await this._t("The reCaptcha token is invalid."));
        }
        else if (recaptchaResult === 'timeout') {
            throw new UserError(await this._t("Your request has timed out, please retry."));
        }
        else if (recaptchaResult === 'badRequest') {
            throw new UserError(await this._t("The request is invalid or malformed."));
        }
        else {
            return false;
        }
    }

    /**
     * Verify a recaptchaV3 token and returns the result as a string.
            RecaptchaV3 verify DOC: https://developers.google.com/recaptcha/docs/verify

            :return: The result of the call to the google API:
                     is_human: The token is valid and the user trustworthy.
                     is_bot: The user is not trustworthy and most likely a bot.
                     no_secret: No reCaptcha secret set in settings.
                     wrong_action: the action performed to obtain the token does not match the one we are verifying.
                     wrong_token: The token provided is invalid or empty.
                     wrong_secret: The private key provided in settings is invalid.
                     timeout: The request has timout or the token provided is too old.
                     bad_request: The request is invalid or malformed.
            :rtype: str
     * @param req 
     * @param ipAddr 
     * @param token 
     * @param action 
     * @returns 
     */
    @api.model()
    async _verifyRecaptchaToken(req: WebRequest, ipAddr, token, action?: any) {
        const env = await req.getEnv();
        const privateKey = await (await env.items('ir.config.parameter').sudo()).getParam('recaptchaPrivateKey');
        if (! privateKey) {
            return 'noSecret';
        }
        const minScore = await (await env.items('ir.config.parameter').sudo()).getParam('recaptchaMinScore');
        let result, resSuccess, resAction;
        try {
            const postData = JSON.stringify({
                'secret': privateKey,
                'response': token,
                'remoteip': ipAddr,
            });
            const url = new URL('https://www.recaptcha.net/recaptcha/api/siteverify');
            const options = {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData),
                },
            };
            result = await httpPost(postData, url, options);
            resSuccess = result['success'];
            resAction = resSuccess && action && result.body['action'];
        } catch(e) {
            if (e.code == 'ERR_SOCKET_CONNECTION_TIMEOUT') {
                console.error("Trial captcha verification timeout for ip address %s", ipAddr);
                return 'timeout';
            } else {
                console.error("Trial captcha verification bad request response");
                return 'badRequest';
            }
        }
        if (resSuccess) {
            const score = result['score'] ?? false;
            if (score < parseFloat(minScore)) {
                console.warn("Trial captcha verification for ip address %s failed with score %s.", ipAddr, score);
                return 'isBot';
            }
            if (resAction && resAction != action) {
                console.warn("Trial captcha verification for ip address %s failed with action %f, expected: %s.", ipAddr, score, action)
                return 'wrongAction';
            }
            console.info("Trial captcha verification for ip address %s succeeded with score %s.", ipAddr, score);
            return 'isHuman';
        }
        const errors = result['error-codes'] ?? [];
        console.warn("Trial captcha verification for ip address %s failed error codes %s. token was: [%s]", ipAddr, errors, token);
        for (const error of errors) {
            if (['missing-input-secret', 'invalid-input-secret'].includes(error)) {
                return 'wrongSecret';
            }
            if (['missing-input-response', 'invalid-input-response'].includes(error)) {
                return 'wrongToken';
            }
            if (error === 'timeout-or-duplicate') {
                return 'timeout';
            }
            if (error === 'bad-request') {
                return 'badRequest';
            }
        }
        return 'isBot';
    }
}