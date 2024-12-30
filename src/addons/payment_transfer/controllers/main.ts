import { http } from "../../../core"
import { stringify } from "../../../core/tools/json";

@http.define()
export class TransferController extends http.Controller {
    static _module = module;
    static _acceptUrl = '/payment/transfer/feedback';

    @http.route(TransferController._acceptUrl, {type: 'http', auth: 'public', methods: ['POST'], csrf: false})
    async transferFormFeedback(req, res, opts: {post?: any}={}) {
        console.info("beginning _handleFeedbackData with post data %s", stringify(opts.post));
        await (await (await req.getEnv()).items('payment.transaction').sudo())._handleFeedbackData('transfer', opts.post);
        return req.redirect(res, '/payment/status');
    }
}
