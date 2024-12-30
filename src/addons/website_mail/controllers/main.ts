import { http } from "../../../core"
import { setdefault } from "../../../core/api";
import { bool, setOptions } from "../../../core/tools";

@http.define()
class WebsiteMail extends http.Controller {
    static _module = module;

    @http.route(['/website_mail/follow'], {type: 'json', auth: "public", website: true})
    async websiteMessageSubscribe(req, res, opts: {id?: any, object?: any, messageIsFollower?: string, email?: any}={}) {
        setOptions(opts, {id: 0, messageIsFollower: "on", email: false});
        // TDE FIXME: check this method with new followers
        const resId = parseInt(opts.id);
        const isFollower = opts.messageIsFollower == 'on';
        const env = await req.getEnv();
        const record = await env.items(opts.object).browse(resId).exists();
        if (! bool(record)) {
            return false;
        }

        await record.checkAccessRights('read');
        await record.checkAccessRule('read');

        // search partnerId
        let partnerIds: number[];
        const recordSudo = await record.sudo();
        const user = await env.user();
        if (user.ne(await req.website.userId)) {
            partnerIds = (await user.partnerId).ids;
        }
        else {
            // mail_thread method
            partnerIds = (await (await env.items('mail.thread').sudo())._mailFindPartnerFromEmails([opts.email], {records: recordSudo})).filter(p => bool(p)).map(p => p.id);
            if (! partnerIds.length || !bool(partnerIds[0])) {
                const label = opts.email.split('@')[0];
                partnerIds = (await (await env.items('res.partner').sudo()).create({'label': label, 'email': opts.email})).ids;
            }
        }
        // add or remove follower
        if (isFollower) {
            await recordSudo.messageUnsubscribe(partnerIds);
            return false;
        }
        else {
            // add partner to session
            req.session['partnerId'] = partnerIds[0];
            await recordSudo.messageSubscribe(partnerIds);
            return true;
        }
    }

    /**
     * Given a list of `models` containing a list of resIds, return
            the resIds for which the user is follower and some practical info.

            :param records: dict of models containing record IDS, eg: {
                    'res.model': [1, 2, 3..],
                    'res.model2': [1, 2, 3..],
                    ..
                }

            :returns: [
                    {'is_user': True/False, 'email': 'admin@yourcompany.example.com'},
                    {'res.model': [1, 2], 'res.model2': [1]}
                ]
     * @param req 
     * @param res 
     * @param opts 
     * @returns 
     */
    @http.route(['/website_mail/isFollower'], {type: 'json', auth: "public", website: true})
    async isFollower(req, res, opts: {records?: any}={}) {
        const env = await req.getEnv();
        const user = await env.user();
        let partner;
        const publicUser = await req.website.userId;
        if (user.ne(publicUser)) {
            partner = await user.partnerId;
        }
        else if (req.session.get('partnerId')) {
            partner = (await env.items('res.partner').sudo()).browse(req.session.get('partnerId'));
        }
        const result = {};
        if (bool(partner)) {
            for (const model of Object.keys(opts.records)) {
                const mailFollowersIds = await (await env.items('mail.followers').sudo()).readGroup([
                    ['resModel', '=', model],
                    ['resId', 'in', opts.records[model]],
                    ['partnerId', '=', partner.id]
                ], ['resId', 'followCount:COUNT(id)'], ['resId']);
                // `readGroup` will filter out the ones without count result
                for (const m of mailFollowersIds) {
                    setdefault(res, model, []).push(m['resId']);
                }
            }
        }
        return [{
            'isUser': user.ne(publicUser),
            'email': bool(partner) ? await partner.email : "",
        }, result];
    }
}
