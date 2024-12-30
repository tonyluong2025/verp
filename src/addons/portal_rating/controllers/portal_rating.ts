import { http } from "../../../core"
import { _t, parseInt } from "../../../core/tools";

@http.define()
class PortalRating extends http.Controller {
    static _module = module;

    @http.route(['/website/rating/comment'], {type: 'json', auth: "user", methods: ['POST'], website: true})
    async publishRatingComment(req, res, opts: {ratingId?: any, publisherComment?: any}={}) {
        const env = await req.getEnv();
        const rating = await env.items('rating.rating').search([['id', '=', parseInt(opts.ratingId)]]);
        if (! rating.ok) {
            return {'error': await _t(env, 'Invalid rating')};
        }
        await rating.write({'publisherComment': opts.publisherComment});
        // return to the front-end the created/updated publisher comment
        return (await rating.read(['publisherComment', 'publisherId', 'publisherDatetime']))[0];
    }
}
