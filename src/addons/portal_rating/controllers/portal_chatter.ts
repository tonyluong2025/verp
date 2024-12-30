import { http } from "../../../core";
import { pop, setOptions, update } from "../../../core/tools";
import * as mail from "../../portal/controllers/";

@http.define()
class PortalChatter extends mail.PortalChatter {
    static _module = module;

    _portalPostFilterParams() {
        let fields = super._portalPostFilterParams();
        return fields.concat(['ratingValue', 'ratingFeedback']);
    }

    async _portalRatingStats(req, res, opts: {resModel?: any, resId?: any}={}) {
        // get the rating statistics for the record
        if (opts['ratingInclude']) {
            const record = (await req.getEnv()).items(opts.resModel).browse(opts.resId);
            if (typeof record['ratingGetStats'] === 'function') {
                return {'ratingStats': await (await record.sudo()).ratingGetStats()};
            }
        }
        return {};
    }

    @http.route()
    async portalChatterPost(req, res, opts: {resModel?: any, resId?: any, message?: any, attachmentIds?: any, attachmentTokens?: any}={}) {
        setOptions(opts, {attachmentIds: '', attachmentTokens: ''});
        if (opts['ratingValue']) {
            opts['ratingFeedback'] = pop(opts, 'ratingFeedback', opts.message);
        }
        return super.portalChatterPost(req, res, opts);
    }

    @http.route()
    async portalChatterInit(req, res, opts: {resModel?: any, resId?: any, domain?: any, limit?: any}={}) {
        setOptions(opts, {domain: false, limit: false});
        const result = await super.portalChatterInit(req, res, opts);
        update(result, await this._portalRatingStats(req, res, opts));
        return result;
    }

    @http.route()
    async portalMessageFetch(req, res, opts: {resModel?: any, resId?: any, domain?: any, limit?: any, offset?: any}={}) {
        setOptions(opts, {domain: false, limit: false, offset: false});
        // add 'rating_include' in context, to fetch them in portal_message_format
        if (opts['ratingInclude']) {
            const context = Object.assign({}, req.context);
            context['ratingInclude'] = true;
            req.context = context;
        }
        const result = await super.portalMessageFetch(req, res, opts);
        update(result, await this._portalRatingStats(req, res, opts));
        return result;
    }
}
