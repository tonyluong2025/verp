import assert from "assert";
import { ServerResponse } from "http";
import xpath from "xpath";
import { _Date, http } from "../../../core";
import { AssetsBundle } from "../../../core/addons/base";
import { Dict, UserError, ValidationError, ValueError } from "../../../core/helper";
import { STATIC_CACHE_LONG, WebRequest, WebResponse, httpGet, httpPost } from "../../../core/http";
import { getResourcePath } from "../../../core/modules";
import { BadRequest, NotFound } from "../../../core/service";
import { urlEncode } from "../../../core/service/middleware/utils";
import { _t, b64decode, b64encode, base64ToImage, bool, f, fileClose, fileOpen, fileRead, imageDataUri, imageProcess, isInstance, parseInt, pop, setOptions, slug, unslug, update } from "../../../core/tools";
import { addDate } from "../../../core/tools/date_utils";
import { len, range } from "../../../core/tools/iterable";
import { guessMimetype } from "../../../core/tools/mimetypes";
import { childNodes, escapeHtml, getAttribute, isElement, parseXml, serializeXml } from "../../../core/tools/xml";
import { SUPPORTED_IMAGE_EXTENSIONS, SUPPORTED_IMAGE_MIMETYPES } from "../models";

const DEFAULT_LIBRARY_ENDPOINT = 'https://media-api.theverp.com'

const divergingHistoryRegex = /data-last-history-steps="([0-9,]*?)"/g;

async function ensureNoHistoryDivergence(record, htmlFieldName, incomingHistoryIds) {
    const serverHistoryMatches = (await record[htmlFieldName] || '').matchAll(divergingHistoryRegex);
    // Do not check old documents without data-last-history-steps.
    if (serverHistoryMatches) {
        const serverLastHistoryId = serverHistoryMatches.next().value[1].split(',').slice(-1)[0];
        if (!incomingHistoryIds.includes(serverLastHistoryId)) {
            console.warn('The document was already saved from someone with a different history for model %s, field %s with id %s.', record._name, htmlFieldName, record.id);
            throw new ValidationError(await _t(record.env, 'The document was already saved from someone with a different history for model %s, field %s with id %s.', record._name, htmlFieldName, record.id));
        }
    }
}

export async function handleHistoryDivergence(record, htmlFieldName, vals) {
    // Do not handle history divergence if the field is not in the values.
    if (!(htmlFieldName in vals)) {
        return;
    }
    const incomingHtml: string = vals[htmlFieldName] || '';
    const incomingHistoryMatches = incomingHtml.matchAll(divergingHistoryRegex);
    // When there is no incoming history id, it means that the value does not
    // comes from the verp editor or the collaboration was not activated. In
    // project, it could come from the collaboration pad. In that case, we do not
    // handle history divergences.
    if (incomingHistoryMatches == null) {
        return;
    }
    const incomingHistoryMatche = incomingHistoryMatches.next().value[1];
    const incomingHistoryIds = incomingHistoryMatche.split(',')
    const incomingLastHistoryId = incomingHistoryIds.slice(-1)[0];

    if (bool(await record[htmlFieldName])) {
        await ensureNoHistoryDivergence(record, htmlFieldName, incomingHistoryIds);
    }

    // Save only the latest id.
    const start = incomingHtml.indexOf(incomingHistoryMatche);
    vals[htmlFieldName] = incomingHtml.slice(0, start) + incomingLastHistoryId + incomingHtml.slice(start + incomingHistoryMatche.length);
}

@http.define()
class WebEditor extends http.Controller {
    static _module = module;

    // convert font into picture
    /**
     * This method converts an unicode character to an image (using Font
            Awesome font by default) and is used only for mass mailing because
            custom fonts are not supported in mail.
            :param icon : decimal encoding of unicode character
            :param color : RGB code of the color
            :param bg : RGB code of the background color
            :param size : Pixels in integer
            :param alpha : transparency of the image from 0 to 255
            :param font : font path

            :returns PNG image converted from given font
     * @param req 
     * @param res 
     * @param opts 
     * @returns 
     */
    @http.route([
        '/web_editor/fontToImg/<icon>',
        '/web_editor/fontToImg/<icon>/<color>',
        '/web_editor/fontToImg/<icon>/<color>/<int:size>',
        '/web_editor/fontToImg/<icon>/<color>/<int:width>x<int:height>',
        '/web_editor/fontToImg/<icon>/<color>/<int:size>/<int:alpha>',
        '/web_editor/fontToImg/<icon>/<color>/<int:width>x<int:height>/<int:alpha>',
        '/web_editor/fontToImg/<icon>/<color>/<bg>',
        '/web_editor/fontToImg/<icon>/<color>/<bg>/<int:size>',
        '/web_editor/fontToImg/<icon>/<color>/<bg>/<int:width>x<int:height>',
        '/web_editor/fontToImg/<icon>/<color>/<bg>/<int:width>x<int:height>/<int:alpha>',
    ], { type: 'http', auth: "none" })
    async exportIconToPng(req: WebRequest, res: ServerResponse, opts: { icon?: any, color?: any, bg?: any, size?: number, alpha?: number, font?: string, width?: number, height?: number }) {
        setOptions(opts, { color: '#000', size: 100, alpha: 255, font: '/web/static/lib/fontawesome/fonts/fontawesome-webfont.ttf' });
        // Make sure we have at least size=1
        const size = opts.width ? Math.max(opts.width, opts.height, 1) : opts.size;
        let width = opts.width || size;
        let height = opts.height || size;
        // Make sure we have at least size=1
        width = Math.max(1, Math.min(width, 512));
        height = Math.max(1, Math.min(height, 512));
        // Initialize font
        /*
        with tools.fileOpen(font.lstrip('/'), 'r') as f:
            fontObj = ImageFont.truetype(f, size)

        # if received character is not a number, keep old behaviour (icon is character)
        icon = chr(int(icon)) if icon.isdigit() else icon

        # Background standardization
        if bg is not None and bg.startsWith('rgba'):
            bg = bg.replace('rgba', 'rgb')
            bg = ','.join(bg.split(',')[:-1])+')'

        # Convert the opacity value compatible with PIL Image color (0 to 255)
        # when color specifier is 'rgba'
        if color is not None and color.startsWith('rgba'):
            *rgb, a = color.strip(')').split(',')
            opacity = str(floor(float(a) * 255))
            color = ','.join([*rgb, opacity]) + ')'

        # Determine the dimensions of the icon
        image = Image.new("RGBA", (width, height), color)
        draw = ImageDraw.Draw(image)

        boxw, boxh = draw.textsize(icon, font=fontObj)
        draw.text((0, 0), icon, font=fontObj)
        left, top, right, bottom = image.getbbox()

        # Create an alpha mask
        imagemask = Image.new("L", (boxw, boxh), 0)
        drawmask = ImageDraw.Draw(imagemask)
        drawmask.text((-left, -top), icon, font=fontObj, fill=255)

        # Create a solid color image and apply the mask
        if color.startsWith('rgba'):
            color = color.replace('rgba', 'rgb')
            color = ','.join(color.split(',')[:-1])+')'
        iconimage = Image.new("RGBA", (boxw, boxh), color)
        iconimage.putalpha(imagemask)

        # Create output image
        outimage = Image.new("RGBA", (boxw, height), bg or (0, 0, 0, 0))
        outimage.paste(iconimage, (left, top), iconimage)

        # output image
        output = io.BytesIO()
        outimage.save(output, format="PNG")
        */
        let output;
        const headers = {};
        const date = _Date.today();
        headers['Cache-Control'] = 'public, max-age=604800';
        headers['Access-Control-Allow-Origin'] = '*';
        headers['Access-Control-Allow-Methods'] = 'GET, POST';
        headers['Connection'] = 'close';
        headers['Date'] = date.toISOString();
        headers['Expires'] = addDate(date, { week: 1 }).toISOString();
        return new WebResponse(req, res, output, { mimetype: 'image/png', headers: headers });
    }

    // Update a checklist in the editor on check/uncheck

    @http.route('/web_editor/checklist', { type: 'json', auth: 'user' })
    async updateChecklist(req, res, opts: { resModel?: any, resId?: any, filename?: any, checklistId?: any, checked?: any } = {}) {
        const record = (await req.getEnv()).items(opts.resModel).browse(opts.resId);
        let value = await record[opts.filename] ?? false;
        const htmlElem = parseXml(f("<div>%s</div>", value));
        const checked = bool(opts.checked);

        const li = xpath.select1('.//li[@id="checklistId_' + String(opts.checklistId) + '"]', htmlElem);

        if (!li || ! await this._updateChecklistRecursive(li, checked, { hasChildren: true, hasAncestors: true })) {
            return value;
        }

        value = serializeXml(htmlElem.childNodes.item[0]).slice(5, -6);
        await record.write({ filename: value });

        return value;
    }

    _updateChecklistRecursive(li, checked, opts: { hasChildren?: any, hasAncestors?: any } = {}) {
        if (!getAttribute(li, 'id', '').includes('checklistId')) {
            return false;
        }

        let classname = li.getAttribute('class') || '';
        if (classname.includes('o-checked') == checked) {
            return false;
        }

        // check / uncheck
        if (checked) {
            classname = f('%s o-checked', classname);
        }
        else {
            classname = classname.replace(/\s?o-checked\s?/, '');
        }
        li.setAttrbute('class', classname);

        // propagate to children
        if (opts.hasChildren) {
            const node = li.nextSibling;
            let ul;
            if (node != null) {
                if (node.tagName === 'ul') {
                    ul = node;
                }
                const children = childNodes(node, isElement);
                if (node.tagName === 'li' && children.length == 1 && children[0].tagName === 'ul') {
                    ul = children[0];
                }
            }
            if (ul != null) {
                for (const child of childNodes(ul, isElement)) {
                    if (child.tagName === 'li') {
                        this._updateChecklistRecursive(child, checked, { hasChildren: true });
                    }
                }
            }
        }
        // propagate to hasAncestors
        if (opts.hasAncestors) {
            let allSelected = true;
            let ul = li.parentNode;
            if (ul.tagName === 'li') {
                ul = ul.parentNode;
            }

            for (const child of childNodes(ul, isElement)) {
                if (child.tagName === 'li' && getAttribute(child, 'id', '').includes('checklistId') && !child.getAttribute(child, 'class', '').includes('o-checked')) {
                    allSelected = false;
                }
            }

            let node = ul.previousSibling;
            if (node == null) {
                node = ul.parentNode.previousSibling;
            }
            if (node != null && node.tagName === 'li') {
                this._updateChecklistRecursive(node, allSelected, { hasAncestors: true });
            }
        }
        return true;
    }

    @http.route('/web_editor/attachment/addData', { type: 'json', auth: 'user', methods: ['POST'], website: true })
    async addData(req, res, opts: { label?: any, data?: any, isImage?: any, quality?: any, width?: any, height?: any, resId?: any, resModel?: any } = {}) {
        setOptions(opts, { quality: 0, width: 0, height: 0, resModel: 'ir.ui.view' });
        if (opts.isImage) {
            const formatErrorMsg = await _t(await req.getEnv(), "Uploaded image's format is not supported. Try with: %s", SUPPORTED_IMAGE_EXTENSIONS.join(', '));
            try {
                opts.data = await imageProcess(opts.data, { size: [opts.width, opts.height], quality: opts.quality, verifyResolution: true });
                const mimetype = guessMimetype(b64decode(opts.data));
                if (!SUPPORTED_IMAGE_MIMETYPES.includes(mimetype)) {
                    return { 'error': formatErrorMsg };
                }
            } catch (e) {
                if (isInstance(e, UserError)) {
                    // considered as an image by the browser file input, but not
                    // recognized as such by PIL, eg .webp
                    return { 'error': formatErrorMsg }
                }
                else if (isInstance(e, ValueError)) {
                    return { 'error': e.message }
                }
                throw e;
            }
        }
        await this._cleanContext(req);
        const attachment = await this._attachmentCreate(req, opts);
        return attachment._getMediaInfo();
    }

    @http.route('/web_editor/attachment/addUrl', { type: 'json', auth: 'user', methods: ['POST'], website: true })
    async addUrl(req, res, opts: { url?: any, resId?: any, resModel?: any } = {}) {
        opts.resModel = opts.resModel ?? 'ir.ui.view';
        this._cleanContext(req);
        const attachment = await this._attachmentCreate(opts);
        return attachment._getMediaInfo();
    }

    /**
     * Removes a web-based image attachment if it is used by no view (template)

        Returns a dict mapping attachments which would not be removed (if any)
        mapped to the views preventing their removal
     * @param req 
     * @param res 
     * @param opts 
     * @returns 
     */
    @http.route('/web_editor/attachment/remove', { type: 'json', auth: 'user', website: true })
    async remove(req, res, opts: { ids?: any } = {}) {
        this._cleanContext(req);
        const env = await req.getEnv();
        let attachmentsToRemove = env.items('ir.attachment');
        let attachments = attachmentsToRemove;
        let views = env.items('ir.ui.view');

        // views blocking removal of the attachment
        const removalBlockedBy = {}

        for (const attachment of attachments.browse(opts.ids)) {
            // in-document URLs are html-escaped, a straight search will not
            // find them
            const url = escapeHtml(await attachment.localUrl);
            const view = views.search([
                "|",
                ['archDb', 'like', f('"%s"', url)],
                ['archDb', 'like', f("'%s'", url)]
            ]);

            if (view.ok) {
                removalBlockedBy[attachment.id] = await view.read(['label']);
            }
            else {
                attachmentsToRemove = attachmentsToRemove.add(attachment);
            }
        }
        if (attachmentsToRemove.ok) {
            await attachmentsToRemove.unlink();
        }
        return removalBlockedBy;
    }

    /**
     * This route is used to determine the original of an attachment so that
        it can be used as a base to modify it again (crop/optimization/filters).
     * @param req 
     * @param res 
     * @param opts 
     */
    @http.route('/web_editor/getImageInfo', { type: 'json', auth: 'user', website: true })
    async getImageInfo(req, res, opts: { src?: any } = {}) {
        const src = opts.src || '';
        const idMatch = src.match(/^\/web\/image\/([^\/?]+)/);
        const env = await req.getEnv();
        let attachment;
        if (idMatch) {
            const urlSegment = idMatch[1];
            const numberMatch = urlSegment.match(/^(\d+)/);
            if (urlSegment.includes('.')) { // xml-id
                attachment = await env.items('ir.http')._xmlidToObj(req, env, urlSegment);
            }
            else if (numberMatch) { // numeric id
                attachment = env.items('ir.attachment').browse(parseInt(numberMatch[1]));
            }
        }
        else {
            // Find attachment by url. There can be multiple matches because of default
            // snippet images referencing the same image in /static/, so we limit to 1
            attachment = await env.items('ir.attachment').search([
                '|', ['url', '=like', src], ['url', '=like', f('%s?%', src)],
                ['mimetype', 'in', SUPPORTED_IMAGE_MIMETYPES],
            ], { limit: 1 });
        }
        if (!bool(attachment)) {
            return {
                'attachment': false,
                'original': false,
            }
        }
        return {
            'attachment': await attachment.readOne(['id']),
            'original': await ((await attachment.originalId).ok ? await attachment.originalId : attachment).readOne(['id', 'imageSrc', 'mimetype']),
        }
    }

    /**
     * Create and return a new attachment.
     * @param opts 
     */
    async _attachmentCreate(req, opts: { label?: any, data?: any, url?: any, resId?: any, resModel?: any } = {}) {
        setOptions(opts, { label: '', resModel: 'ir.ui.view' });
        if (opts.label.toLowerCase().endsWith('.bmp')) {
            // Avoid mismatch between content type and mimetype, see commit msg
            opts.label = opts.label.slice(0, -4);
        }
        if (!opts.label && opts.url) {
            opts.label = opts.url.split("/").pop();
        }
        if (opts.resModel !== 'ir.ui.view' && opts.resId) {
            opts.resId = parseInt(opts.resId);
        }
        else {
            opts.resId = false;
        }
        const attachmentData = {
            'label': opts.label,
            'isPublic': opts.resModel === 'ir.ui.view',
            'resId': opts.resId,
            'resModel': opts.resModel,
        }

        if (opts.data) {
            attachmentData['datas'] = opts.data;
        }
        else if (opts.url) {
            update(attachmentData, {
                'type': 'url',
                'url': opts.url,
            });
        }
        else {
            throw new UserError(await _t(await req.getEnv(), "You need to specify either data or url to create an attachment."));
        }

        const attachment = await (await req.getEnv()).items('ir.attachment').create(attachmentData);
        return attachment;
    }

    async _cleanContext(req) {
        // avoid allowedCompanyIds which may erroneously restrict based on website
        const context = structuredClone(req.context);
        pop(context, 'allowedCompanyIds', null);
        req.context = context;
    }

    /**
     * Transmit the resources the assets editor needs to work.

        Params:
            key (str): the key of the view the resources are related to

            getViews (bool, default=true):
                true if the views must be fetched

            getScss (bool, default=true):
                true if the style must be fetched

            getJs (bool, default=true):
                true if the javascript must be fetched

            bundles (bool, default=false):
                true if the bundles views must be fetched

            bundlesRestriction (list, default=[]):
                Names of the bundles in which to look for scss files
                (if empty, search in all of them)

            onlyUserCustomFiles (bool, default=true):
                true if only user custom files must be fetched

        Returns:
            dict: views, scss, js
     * @param req 
     * @param res 
     * @param opts 
     * @returns 
     */
    @http.route("/web_editor/getAssetsEditorResources", { type: "json", auth: "user", website: true })
    async getAssetsEditorResources(req, res, opts: { key?: any, getViews?: any, getScss?: any, getJs?: any, bundles?: any, bundlesRestriction?: any, onlyUserCustomFiles?: any } = {}) {
        setOptions(opts, { getViews: true, getScss: true, getJs: true, bundles: false, bundlesRestriction: [], onlyUserCustomFiles: true });
        // Related views must be fetched if the user wants the views and/or the style
        let views = await (await req.getEnv()).items("ir.ui.view").getRelatedViews(opts.key, opts.bundles);
        views = await views.read(['label', 'id', 'key', 'xmlid', 'arch', 'active', 'inheritId']);

        let scssFilesDataByBundle = [];
        let jsFilesDataByBundle = [];

        if (opts.getScss) {
            scssFilesDataByBundle = await this._loadResources(req, 'scss', views, opts.bundlesRestriction, opts.onlyUserCustomFiles);
        }
        if (opts.getJs) {
            jsFilesDataByBundle = await this._loadResources(req, 'js', views, opts.bundlesRestriction, opts.onlyUserCustomFiles);
        }
        return {
            'views': opts.getViews && views || [],
            'scss': opts.getScss && scssFilesDataByBundle || [],
            'js': opts.getJs && jsFilesDataByBundle || [],
        }
    }

    async _loadResources(req, fileType, views, bundlesRestriction, onlyUserCustomFiles) {
        const env = await req.getEnv();
        const assetsUtils = env.items('webeditor.assets');

        let filesDataByBundle = [];
        let resourcesTypeInfo = { 'tCallAssetsAttribute': 't-js', 'mimetype': 'text/javascript' }
        if (fileType === 'scss') {
            resourcesTypeInfo = { 'tCallAssetsAttribute': 't-css', 'mimetype': 'text/scss' }
        }

        // Compile regex outside of the loop
        // This will used to exclude library scss files from the result
        const excludedUrlMatcher = new RegExp("^(.+/lib/.+)|(.+import_bootstrap.+\.scss)$", 'g');

        // First check the t-call-assets used in the related views
        const urlInfos = new Dict();
        for (const v of views) {
            for (const assetCallNode of xpath.select('//t[@t-call-assets]', parseXml(await v["arch"]))) {
                const attr = getAttribute(assetCallNode, resourcesTypeInfo['tCallAssetsAttribute']);
                if (attr && !bool(JSON.parse(attr.toLowerCase()))) {
                    continue;
                }
                const assetName = getAttribute(assetCallNode, "t-call-assets");

                // Loop through bundle files to search for file info
                const filesData = [];
                for (const fileInfo of (await env.items("ir.qweb")._getAssetContent(assetName))[0]) {
                    if (fileInfo["atype"] !== resourcesTypeInfo['mimetype']) {
                        continue;
                    }
                    const url = fileInfo["url"];

                    // Exclude library files (see regex above)
                    if (url.match(excludedUrlMatcher)) {
                        continue;
                    }

                    // Check if the file is customized and get bundle/path info
                    const fileData = assetsUtils.getAssetInfo(url);
                    if (!fileData) {
                        continue;
                    }

                    // Save info according to the filter (arch will be fetched later)
                    urlInfos[url] = fileData;

                    if (url.includes('/user_custom_')
                        || fileData['customized']
                        || fileType === 'scss' && !onlyUserCustomFiles) {
                        filesData.push(url);
                    }
                }

                // scss data is returned sorted by bundle, with the bundles
                // names and xmlids
                if (len(filesData)) {
                    filesDataByBundle.push([assetName, filesData]);
                }
            }
        }

        // Filter bundles/files:
        // - A file which appears in multiple bundles only appears in the
        //   first one (the first in the DOM)
        // - Only keep bundles with files which appears in the asked bundles
        //   and only keep those files
        for (const i of range(0, filesDataByBundle.length)) {
            const bundle1 = filesDataByBundle[i];
            for (const j of range(0, filesDataByBundle.length)) {
                const bundle2 = filesDataByBundle[j];
                // In unwanted bundles, keep only the files which are in wanted bundles too (web._helpers)
                if (!bundlesRestriction.includes(bundle1[0]) && bundlesRestriction.includes(bundle2[0])) {
                    bundle1[1] = bundle1[1].filter(item1 => bundle2[1].includes(item1));
                }
            }
        }
        for (const i of range(0, filesDataByBundle.length)) {
            const bundle1 = filesDataByBundle[i];
            for (const j of range(i + 1, filesDataByBundle.length)) {
                const bundle2 = filesDataByBundle[j];
                // In every bundle, keep only the files which were not found
                // in previous bundles
                bundle2[1] = bundle2[1].filter(item2 => !bundle1[1].includes(item2));
            }
        }

        // Only keep bundles which still have files and that were requested
        filesDataByBundle = filesDataByBundle.filter(data => (len(data[1]) > 0 && (!bundlesRestriction || bundlesRestriction.includes(data[0]))));

        // Fetch the arch of each kept file, in each bundle
        let urls = [];
        for (const bundleData of filesDataByBundle) {
            urls = urls.concat(bundleData[1]);
        }
        const customAttachments = await assetsUtils.getAllCustomAttachments(urls);

        for (const bundleData of filesDataByBundle) {
            for (const i of range(0, len(bundleData[1]))) {
                const url = bundleData[1][i];
                const urlInfo = urlInfos[url];

                const content = await assetsUtils.getAssetContent(url, urlInfo, customAttachments);

                bundleData[1][i] = {
                    'url': f("/%s/%s", urlInfo["module"], urlInfo["resourcePath"]),
                    'arch': content,
                    'customized': urlInfo["customized"],
                }
            }
        }
        return filesDataByBundle;
    }

    /**
     * Save a given modification of a scss/js file.

        Params:
            url (str):
                the original url of the scss/js file which has to be modified

            bundle (str):
                the name of the bundle in which the scss/js file addition can
                be found

            content (str): the new content of the scss/js file

            fileType (str): 'scss' or 'js'
     * @param req 
     * @param res 
     * @param opts 
     */
    @http.route("/web_editor/saveAsset", { type: "json", auth: "user", website: true })
    async saveAsset(req, res, opts: { url?: any, bundle?: any, content?: any, fileType?: any } = {}) {
        await (await req.getEnv()).items('webeditor.assets').saveAsset(opts.url, opts.bundle, opts.content, opts.fileType)
    }

    /**
     * The resetAsset route is in charge of reverting all the changes that
        were done to a scss/js file.

        Params:
            url (str):
                the original URL of the scss/js file to reset

            bundle (str):
                the name of the bundle in which the scss/js file addition can
                be found
     * @param req 
     * @param res 
     * @param opts 
     */
    @http.route("/web_editor/resetAsset", { type: "json", auth: "user", website: true })
    async resetAsset(req, res, opts: { url?: any, bundle?: any } = {}) {
        await (await req.getEnv()).items('webeditor.assets').resetAsset(opts.url, opts.bundle);
    }

    @http.route("/web_editor/publicRenderTemplate", { type: "json", auth: "public", website: true })
    async publicRenderTemplate(req: WebRequest, res: ServerResponse, opts: { args?: any, kwargs?: {} } = {}) {
        const lenArgs = len(opts.args);
        assert(lenArgs >= 1 && lenArgs <= 2, 'Need a xmlID and potential rendering values to render a template');

        const trustedValueKeys = ['debug',];

        const xmlid = opts.args[0];
        const View = (await req.getEnv()).items('ir.ui.view');
        let values = lenArgs > 1 && opts.args[1] || {};
        values = Object.fromEntries(Object.entries(values)
            .filter(([k, v]) => trustedValueKeys.includes(k))
            .map(([k, v]) => [k, values[k]]));

        return View.renderPublicAsset(xmlid, values); // This url make closing cr !?
    }

    /**
     * Creates a modified copy of an attachment and returns its imageSrc to be
          inserted into the DOM.
     * @param req 
     * @param res 
     * @param opts 
     * @returns 
     */
    @http.route('/web_editor/modifyImage/<model("ir.attachment"):attachment>', { type: "json", auth: "user", website: true })
    async modifyImage(req, res, opts: { attachment?: any, resModel?: any, resId?: any, label?: any, data?: any, originalId?: any, mimetype?: any } = {}) {
        const fields = {
            'originalId': opts.attachment.id,
            'datas': opts.data,
            'type': 'binary',
            'resModel': opts.resModel || 'ir.ui.view',
            'mimetype': opts.mimetype || await opts.attachment.mimetype,
        }
        if (fields['resModel'] === 'ir.ui.view') {
            fields['resId'] = 0;
        }
        else if (opts.resId) {
            fields['resId'] = opts.resId;
        }
        if (opts.label) {
            fields['label'] = opts.label;
        }
        const attachment = await opts.attachment.copy(fields);
        const url = await attachment.url;
        if (url) {
            // Don't keep url if modifying static attachment because static images
            // are only served from disk and don't fallback to attachments.
            if (/^\/\w+\/static\//.test(url)) {
                await attachment.set('url', null);
            }
            // Uniquify url by adding a path segment with the id before the name.
            // This allows us to keep the unsplash url format so it still reacts
            // to the unsplash beacon.
            else {
                const urlFragments: any[] = url.split('/');
                urlFragments.splice(urlFragments.length - 1, 0, String(attachment.id));
                await attachment.set('url', urlFragments.join('/'));
            }
        }
        if (await attachment.isPublic) {
            return attachment.imageSrc;
        }
        await attachment.generateAccessToken();
        return f('%s?accessToken=%s', await attachment.imageSrc, await attachment.accessToken);
    }

    async _getShapeSvg(module, ...segments) {
        const shapePath = getResourcePath(module, 'static', ...segments);
        if (!shapePath) {
            throw new NotFound();
        }
        const fd = fileOpen(shapePath, 'r', ['.svg',]).fd;
        const data = fileRead(fd);
        fileClose(fd);
        return data as string;
    }

    async _updateSvgColors(req, options, svg) {
        const userColors = [];
        const svgOptions = {};
        const defaultPalette = {
            '1': '#3AADAA',
            '2': '#7C6576',
            '3': '#F6F6F6',
            '4': '#FFFFFF',
            '5': '#383E45',
        }
        let bundleCss: string;
        const regexHex = /#[0-9A-F]{6,8}/;
        const regexRgba = /rgba?\(\d{1,3},\d{1,3},\d{1,3}(?:,[0-9.]{1,4})?\)/;
        for (const [key, value] of Object.entries<string>(options)) {
            const colorMatch = key.match(/^c([1-5])$/);
            if (colorMatch) {
                let cssColorValue = value;
                // Check that color is hex or rgb(a) to prevent arbitrary injection
                if (!new RegExp(f('(?i)^%s$|^%s$', regexHex.source, regexRgba.source)).test(cssColorValue.replace(' ', ''))) {
                    if (/^o-color-([1-5])$/.test(cssColorValue)) {
                        if (!bundleCss) {
                            const bundle = 'web.assetsFrontend';
                            const [files] = await (await req.getEnv()).items("ir.qweb")._getAssetContent(bundle);
                            const asset = await AssetsBundle.new(bundle, files);
                            bundleCss = await (await asset.css()).indexContent;
                        }
                        const colorSearch = bundleCss.match(f('(?i)--%s:\s+(%s|%s)', cssColorValue, regexHex.source, regexRgba.source));
                        if (!colorSearch) {
                            throw new BadRequest();
                        }
                        cssColorValue = colorSearch[1];
                    }
                    else {
                        throw new BadRequest();
                    }
                }
                userColors.push([escapeHtml(cssColorValue), colorMatch[1]]);
            }
            else {
                svgOptions[key] = value;
            }
        }

        const colorMapping = Object.fromEntries(userColors.map(([color, paletteNumber]) => [defaultPalette[paletteNumber], color]));
        // create a case-insensitive regex to match all the colors to replace, eg: '(?i)(#3AADAA)|(#7C6576)'
        const regex = new RegExp(f('(?i)%s', Object.keys(colorMapping).map(color => f('(%s)', color)).join('|')));

        function subber(match: string) {
            const key = match.toUpperCase();
            return key in colorMapping ? colorMapping[key] : key;
        }
        return [svg.replace(regex, subber), svgOptions];
    }

    /**
     * Returns a color-customized svg (background shape or illustration).
     * @param req 
     * @param res 
     * @param opts 
     */
    @http.route(['/web_editor/shape/<module>/<path:filename>'], { type: 'http', auth: "public", website: true })
    async shape(req, res, opts: { module?: any, filename?: any } = {}) {
        let svg, options;
        if (opts.module === 'illustration') {
            const attachment = (await (await req.getEnv()).items('ir.attachment').sudo()).browse(unslug(opts.filename)[1]);
            if (!bool(await attachment.exists())
                || await attachment.type != 'binary'
                || ! await attachment.isPublic
                || !(await attachment.url).startsWith(req.httpRequest.pathname)) {
                throw new NotFound(res);
            }
            svg = b64decode(await attachment.datas).toString('utf-8');
        }
        else {
            svg = await this._getShapeSvg(module, 'shapes', opts.filename);
        }
        [svg, options] = await this._updateSvgColors(req, opts, svg);
        const flipValue = options.get('flip', false);
        if (flipValue === 'x') {
            svg = svg.replace('<svg ', '<svg style="transform: scaleX(-1);" ');
        }
        else if (flipValue === 'y') {
            svg = svg.replace('<svg ', '<svg style="transform: scaleY(-1)" ');
        }
        else if (flipValue === 'xy') {
            svg = svg.replace('<svg ', '<svg style="transform: scale(-1)" ');
        }

        return req.makeResponse(res, svg, [
            ['Content-type', 'image/svg+xml'],
            ['Cache-control', f('Max-Age=%s', STATIC_CACHE_LONG)],
        ]);
    }

    @http.route(['/web_editor/imageShape/<string:imgKey>/<module>/<path:filename>'], { type: 'http', auth: "public", website: true })
    async imageShape(req, res, opts: { module?: any, filename?: any, imgKey?: any }) {
        const env = await req.getEnv();
        let svg = await this._getShapeSvg(module, 'image_shapes', opts.filename);
        let [, , imageBase64] = await env.items('ir.http').binaryContent(req, {
            xmlid: opts.imgKey, model: 'ir.attachment', field: 'datas', defaultMimetype: 'image/png'
        });
        if (!imageBase64) {
            imageBase64 = b64encode(await env.items('ir.http')._placeholder());
        }
        const image = base64ToImage(imageBase64);
        const metadata = await image.metadata();
        const [width, height] = [String(metadata.width), String(metadata.height)];
        const root: Element = parseXml(svg);
        root.setAttribute('width', width);
        root.setAttribute('height', height);
        // Update default color palette on shape SVG.
        [svg,] = await this._updateSvgColors(req, opts, Buffer.from(serializeXml(root, 'utf-8', true)).toString('utf-8'));
        // Add image in base64 inside the shape.
        const uri = imageDataUri(imageBase64);
        svg = svg.replace('<image xlink:href="', f('<image xlink:href="%s', uri));

        return req.makeResponse(res, svg, [
            ['Content-type', 'image/svg+xml'],
            ['Cache-control', f('Max-Age=%s', http.STATIC_CACHE_LONG)],
        ])
    }

    @http.route(['/web_editor/mediaLibrarySearch'], { type: 'json', auth: "user", website: true })
    async mediaLibrarySearch(req, res, opts: {} = {}) {
        const icp = await (await req.getEnv()).items('ir.config.parameter').sudo();
        const endpoint = await icp.getParam('web_editor.mediaLibraryEndpoint', DEFAULT_LIBRARY_ENDPOINT);
        opts['dbuuid'] = await icp.getParam('database.uuid');
        const response = await httpPost(opts, f('%s/media-library/1/search', endpoint));
        if (response.statusCode === 'ok' && response.headers['content-type'] === 'application/json') {
            return response.body;
        }
        else {
            return { 'error': response.statusCode };
        }
    }

    /**
     * Saves images from the media library as new attachments, making them
        dynamic SVGs if needed.
            media = {
                <media_id>: {
                    'query': 'space separated search terms',
                    'isDynamicSvg': true/false,
                    'dynamicColors': maps color names to their color,
                }, ...
            }
     * @param req 
     * @param res 
     * @param opts 
     * @returns 
     */
    @http.route('/web_editor/saveLibraryMedia', { type: 'json', auth: 'user', methods: ['POST'] })
    async saveLibraryMedia(req, res, opts: { media?: any } = {}) {
        const env = await req.getEnv();
        const attachments = [];
        const icp = await env.items('ir.config.parameter').sudo();
        const libraryEndpoint = await icp.getParam('web_editor.mediaLibraryEndpoint', DEFAULT_LIBRARY_ENDPOINT);

        const mediaIds = Object.keys(opts.media).join(',');
        const params = {
            'dbuuid': await icp.getParam('database.uuid'),
            'mediaIds': mediaIds,
        }
        const response = await httpPost(params, f('%s/media-library/1/download_urls', libraryEndpoint));
        if (response.statusCode !== 'ok') {
            throw new Error(await _t(await req.getEnv(), "ERROR: couldn't get download urls from media library."));
        }
        for (const [id, url] of Object.entries<string>(response.body)) {
            const responseUrl = await httpGet(url);
            const label = [opts.media[id]['query'], url.split('/').slice(-1)[0]].join('_');
            // Need to bypass security check to write image with mimetype image/svg+xml
            // ok because svgs come from whitelisted origin
            const context = { 'binaryFieldRealUser': (await env.items('res.users').sudo()).browse([global.SUPERUSER_ID]) };
            const attachment = await (await (await env.items('ir.attachment').sudo()).withContext(context)).create({
                'label': label,
                'mimetype': responseUrl.headers['content-type'],
                'datas': b64encode(responseUrl.body),
                'isPublic': true,
                'resModel': 'ir.ui.view',
                'resId': 0,
            });
            if (opts.media[id]['isDynamicSvg']) {
                const colorParams = urlEncode(opts.media[id]['dynamicColors']);
                await attachment.set('url', f('/web_editor/shape/illustration/%s?%s', slug([attachment.id, await attachment.seoName || await attachment.displayName]), colorParams));
            }
            attachments.push(await attachment._getMediaInfo());
        }
        return attachments;
    }

    @http.route("/web_editor/getIceServers", { type: 'json', auth: "user" })
    async getIceServers(req: WebRequest, res) {
        return (await req.getEnv()).items('mail.ice.server')._getIceServers();
    }

    @http.route("/web_editor/busBroadcast", { type: "json", auth: "user" })
    async busBroadcast(req: WebRequest, res, opts: { modelName?: any, fieldName?: any, resId?: any, busData?: any } = {}) {
        const env = await req.getEnv();
        const document = env.items(opts.modelName).browse([opts.resId]);

        await document.checkAccessRights('read');
        await document.checkFieldAccessRights('read', [opts.fieldName]);
        await document.checkAccessRule('read');
        await document.checkAccessRights('write');
        await document.checkFieldAccessRights('write', [opts.fieldName]);
        await document.checkAccessRule('write');

        const channel = [req.db, 'editorCollaboration', opts.modelName, opts.fieldName, parseInt(opts.resId)];
        await env.items('bus.bus')._sendone(channel, opts.busData);
    }
}