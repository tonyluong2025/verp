import assert from "assert";
import { http } from "../../../core"
import { _t, getLang, parseInt } from "../../../core/tools";

const MAPPED_RATES = {
    1: 1,
    5: 3,
    10: 5,
}

@http.define()
class Rating extends http.Controller {
    static _module = module;

    @http.route('/rate/<string:token>/<int:rate>', {type: 'http', auth: "public", website: true})
    async actionOpenRating(req, res, opts: {token?: any, rate?: any}={}) {
        assert([1, 3, 5].includes(opts.rate), "Incorrect rating");
        const env = await req.getEnv();
        const rating = await (await env.items('rating.rating').sudo()).search([['accessToken', '=', opts.token]]);
        if (! rating.ok) {
            return req.notFound(res);
        }
        const rateNames = {
            5: await _t(env, "Satisfied"),
            3: await _t(env, "Okay"),
            1: await _t(env, "Dissatisfied")
        }
        await rating.write({'rating': opts.rate, 'consumed': true});
        const lang = await (await rating.partnerId).lang || await (await getLang(env)).code;
        return (await env.items('ir.ui.view').withContext({lang}))._renderTemplate('rating.ratingExternalPageSubmit', {
            'rating': rating, 'token': opts.token,
            'rateNames': rateNames, 'rate': opts.rate
        });
    }

    @http.route(['/rate/<string:token>/submitFeedback'], {type: "http", auth: "public", methods: ['post', 'get'], website: true})
    async actionSubmitRating(req, res, opts: {token?: any}={}) {
        const env = await req.getEnv();
        const rating = await (await env.items('rating.rating').sudo()).search([['accessToken', '=', opts.token]]);
        if (! rating.ok) {
            return req.notFound(res);
        }
        if (req.httpRequest.method === "POST") {
            const rate = parseInt(opts['rate']);
            assert([1, 3, 5].includes(rate), "Incorrect rating");
            const recordSudo = (await env.items(await rating.resModel).sudo()).browse(await rating.resId);
            await recordSudo.ratingApply(rate, {token: opts.token, feedback: opts['feedback']});
        }
        const lang = await (await rating.partnerId).lang || await (await getLang(env)).code;
        return (await env.items('ir.ui.view').withContext({lang}))._renderTemplate('rating.ratingExternalPageView', {
            'webBaseUrl': await rating.getBaseUrl(),
            'rating': rating,
        });
    }
}
