import { http } from "../../../core"
import { WebRequest } from "../../../core/http";
import { BadRequest } from "../../../core/service";
import { f, jsonParse, strip } from "../../../core/tools";

@http.define()
class GoogleAuth extends http.Controller {
    static _module = module;

    /**
     * This route/function is called by Google when user Accept/Refuse the consent of Google
     * @param req 
     * @param res 
     * @param opts 
     * @returns 
     */
    @http.route('/google_account/authentication', {type: 'http', auth: "public"})
    async oauth2callback(req: WebRequest, res, opts: {}={}) {
        const state = jsonParse(opts['state'] ?? '{}'),
        dbName = state['d'],
        service = state['s'],
        urlReturn = state['f'],
        baseUrl = strip(req.urlRoot, '/');
        if (!dbName || !service || (opts['code'] && !urlReturn)) {
            throw new BadRequest();
        }

        if (opts['code']) {
            const env = await req.getEnv();
            const [accessToken, refreshToken, ttl] = await (await env.items('google.service').withContext({baseUrl}))._getGoogleTokens(opts['code'], service);
            // LUL TODO only defined in google_calendar
            await (await (await env.user()).googleCalAccountId)._setAuthTokens(accessToken, refreshToken, ttl);
            return req.redirect(res, urlReturn);
        }
        else if (opts['error']) {
            return req.redirect(res, f("%s%s%s", urlReturn, "?error=", opts['error']));
        }
        else {
            return req.redirect(res, f("%s%s", urlReturn, "?error=UnknownError"));
        }
    }
}
