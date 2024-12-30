import { isNumber } from 'util';
import * as http from '../../../core/http';
import { NotFound, Timeout } from '../../../core/service';
import { urlEncode } from '../../../core/service/middleware/utils';
import { b64decode, b64encode, imageProcess, isAlpha, isInstance, parseInt } from '../../../core/tools';
import { STATUS_CODES } from 'http';
import { ConnectionError } from '../../iap';
import { guessExtension, guessMimetype } from '../../../core/tools/mimetypes';

@http.define()
class WebUnsplash extends http.Controller {
    static _module = module;

    async _getAccessKey(req, res) {
        const env = await req.getEnv();
        if (await (await env.user())._hasUnsplashKeyRights('read')) {
            return (await env.items('ir.config.parameter').sudo()).getParam('unsplash.accessKey');
        }
        throw new NotFound(res);
    }

    /**
     * Notifies Unsplash from an image download. (API requirement)
        This method won't return anything. This endpoint should just be
        pinged with a simple GET request for Unsplash to increment the image
        view counter.
     * @param req 
     * @param res 
     * @param url the download_url of the image to be notified
     * @returns 
     */
    async _notifyDownload(req, res, url) {
        try {
            if (!url.startsWith('https://api.unsplash.com/photos/') && !(await req.getEnv()).registry.inTestMode()) {
                throw new Error(await this._t("ERROR: Unknown Unsplash notify URL!"));
            }
            const accessKey = await this._getAccessKey(req, res);
            await http.httpGet(url, {params: urlEncode({'client_id': accessKey})});
        } catch(e) {
            console.error("Unsplash download notification failed: " + e);
        }
    }

    // ------------------------------------------------------
    // add unsplash image url
    // ------------------------------------------------------
    /**
        unsplashurls = {
            image_id1: {
                url: image_url,
                download_url: download_url,
            },
            image_id2: {
                url: image_url,
                download_url: download_url,
            },
            .....
        }
     * @param req 
     * @param res 
     * @param opts 
     * @returns 
     */
    @http.route('/web_unsplash/attachment/add', {type: 'json', auth: 'user', methods: ['POST']})
    async saveUnsplashUrl(req, res, opts: {unsplashurls?: any}={}) {
        /**
         * Keeps only alphanumeric characters, hyphens and spaces from a string.
            The string will also be truncated to 1024 characters max.
            @param s the string to be filtered
            @returns the sanitized string
         */
        function slugify(s) {
            return s.filter(c => isAlpha(c) || '- '.includes(c)).join('').slice(0, 1024);
        }

        if (!opts.unsplashurls) {
            return [];
        }

        const env = await req.getEnv();
        const uploads = [];
        let attachments = env.items('ir.attachment');

        let query = opts['query'] ?? '';
        query = slugify(query);
        let resId;
        const resModel = opts['resModel'] ?? 'ir.ui.view';
        if (resModel !== 'ir.ui.view' && opts['resId']) {
            resId = parseInt(opts['resId']);
        }

        for (const [key, value] of Object.entries(opts.unsplashurls)) {
            const url = value['url'];
            let imageBase64;
            try {
                if (!['https://images.unsplash.com/', 'https://plus.unsplash.com/'].some(l => url.startsWith(l)) && !env.registry.inTestMode()) {
                    console.error("ERROR: Unknown Unsplash URL!: " + url);
                    throw new Error(await this._t("ERROR: Unknown Unsplash URL!"));
                }
                const result = await http.httpGet(url);
                if (result.statusCode != STATUS_CODES.OK) {
                    continue;
                }

                // get mime-type of image url because unsplash url dosn't contains mime-types in url
                imageBase64 = b64encode(result.content);
            } catch(e) {
                if (isInstance(e, ConnectionError)) {
                    console.error("Connection Error: " + e);
                    continue;
                } 
                else if (isInstance(e, Timeout)) {
                    console.error("Timeout: " + e);
                    continue;
                }
                else {
                    throw e;
                }
            }

            imageBase64 = await imageProcess(imageBase64, {verifyResolution: true});
            const mimetype = guessMimetype(b64decode(imageBase64));
            // append image extension in name
            query += guessExtension(mimetype) || '';

            // /unsplash/5gR788gfd/lion
            const urlFrags = ['unsplash', key, query];

            const attachment = await attachments.create({
                'label': urlFrags.join('_'),
                'url': '/' + urlFrags.join('/'),
                'mimetype': mimetype,
                'datas': imageBase64,
                'isPublic': resModel == 'ir.ui.view',
                'resId': resId,
                'resModel': resModel,
                'description': value['description'],
            });
            await attachment.generateAccessToken();
            uploads.push(await attachment._getMediaInfo());

            // Notifies Unsplash from an image download. (API requirement)
            await this._notifyDownload(req, res, value['download_url']);
        }

        return uploads;
    }

    @http.route("/web_unsplash/fetchImages", {type: 'json', auth: "user"})
    async fetchUnsplashImages(req, res, post:{}={}) {
        const accessKey = await this._getAccessKey(req, res);
        const appId = await this.getUnsplashAppId(req, res, post);
        if (!accessKey || !appId) {
            return {'error': 'keyNotFound'}
        }
        post['client_id'] = accessKey;
        const result = await http.httpGet('https://api.unsplash.com/search/photos/', {params: urlEncode(post)});
        if (result.statusCode == STATUS_CODES.OK) {
            return result.json();
        }
        else {
            return {'error': result.statusCode}
        }
    }

    @http.route("/web_unsplash/getAppId", {type: 'json', auth: "public"})
    async getUnsplashAppId(req, res, post: {}={}) {
        return (await (await req.getEnv()).items('ir.config.parameter').sudo()).getParam('unsplash.appId');
    }

    @http.route("/web_unsplash/saveUnsplash", {type: 'json', auth: "user"})
    async saveUnsplash(req, res, post:{}={}) {
        const env = await req.getEnv();
        if (await (await env.user())._hasUnsplashKeyRights('write')) {
            const sudo = await env.items('ir.config.parameter').sudo();
            await sudo.setParam('unsplash.appId', post['appId']);
            await sudo.setParam('unsplash.accessKey', post['key']);
            return true;
        }
        throw new NotFound(res);
    }
}
