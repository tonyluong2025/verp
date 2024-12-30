import { api } from "../../../core";
import { hasattr } from "../../../core/api";
import { UserError } from "../../../core/helper";
import { httpGet } from "../../../core/http";
import { _super, AbstractModel, MetaModel } from "../../../core/models"
import { bool, f, getRandom, markup, range, rstrip } from "../../../core/tools";
import { EtherpadLiteClient } from "../etherpad";

const ASCII_UPPERCASE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';

@MetaModel.define()
class PadCommon extends AbstractModel {
    static _module = module;
    static _name = 'pad.common';
    static _description = 'Pad Common';

    _validFieldParameter(field, name) {
        return name === 'padContentField' || _super(PadCommon, this)._validFieldParameter(field, name);
    }

    @api.model()
    async padIsConfigured() {
        return bool(await (await this.env.items('ir.config.parameter').sudo()).getParam('pad.padServer'));
    }

    @api.model()
    async padGenerateUrl() {
        const paramSudo = await this.env.items('ir.config.parameter').sudo(); 
        const pad = {
            "server": await paramSudo.getParam('pad.padServer'),
            "key": await paramSudo.getParam('pad.padKey'),
        }

        // make sure pad server in the form of http://hostname
        if (! pad["server"]) {
            return pad;
        }
        if (!pad["server"].startsWith('http')) {
            pad["server"] = 'http://' + pad["server"];
        }
        pad["server"] = rstrip(pad["server"], '/');
        // generate a salt
        const s = ASCII_UPPERCASE + DIGITS;
        const salt = Array.from(range(10)).map(i => s[getRandom(0, s.length - 1)]).join('');
        // path
        // etherpad hardcodes pad id length limit to 50
        let path = f('-%s-%s', this._name, salt);
        path = f('%s%s', this.env.cr.dbName.replace('_', '-').slice(0, 50 - path.length), path);
        // contruct the url
        const url = f('%s/p/%s', pad["server"], path);

        // if create with content
        if (this.env.context['fieldName'] && this.env.context['model']) {
            const myPad = new EtherpadLiteClient(pad["key"], pad["server"] + '/api');
            try {
                await myPad.createPad(path);
            } catch(e) {
                throw new UserError(await this._t("Pad creation failed, either there is a problem with your pad server URL or with your connection."));
            }
            // get attr on the field model
            const model = this.env.items(this.env.context["model"]);
            const field = model._fields[this.env.context['fieldName']];
            const realField = field.padContentField;

            const resId = this.env.context["objectId"];
            const record = model.browse(resId);
            // get content of the real field
            const realFieldValue = await record[realField] || (this.env.context['record'] ?? {})[realField] || '';
            if (realFieldValue) {
                await myPad.setHtmlFallbackText(path, realFieldValue);
            }
        }
        return {
            "server": pad["server"],
            "path": path,
            "url": url,
        }
    }

    @api.model()
    async padGetContent(url) {
        const paramSudo = await this.env.items('ir.config.parameter').sudo(); 
        const pad = {
            "server": await paramSudo.getParam('pad.padServer'),
            "key": await paramSudo.getParam('pad.padKey'),
        }
        const myPad = new EtherpadLiteClient(pad['key'], (pad['server'] || '') + '/api');
        let content = '';
        if (url) {
            const splitUrl = url.split('/p/');
            const path = splitUrl.length == 2 && splitUrl[1];
            try {
                content = (await myPad.getHtml(path))['html'] ?? '';
            } catch(e) {
                console.warn('Http Error: the credentials might be absent for url: "%s". Falling back.', url);
                let res, err;
                try {
                    res = await httpGet('%s/export/html', url);
                    res.raiseForStatus();
                } catch(e) {
                    err = e;
                    console.warn("No pad found with url '%s'.", url);
                }
                if (!err) {
                    const mo = res.content.match('<body>(.*)</body>');//, re.DOTALL)
                    if (mo) {
                        content = mo[1];
                    }
                }
            }
        }

        return markup(content);
    }

    // reverse engineer protocol to be setHtml without using the api key

    async write(vals) {
        await this._setFieldToPad(vals);
        await this._setPadToField(vals);
        return _super(PadCommon, this).write(vals);
    }

    @api.model()
    async create(vals) {
        // Case of a regular creation: we receive the pad url, so we need to update the
        // corresponding field
        await this._setPadToField(vals);
        const pad = await _super(PadCommon, this).create(vals);

        // Case of a programmatical creation (e.g. copy): we receive the field content, so we need
        // to create the corresponding pad
        if (this.env.context['padNoCreate'] ?? false) {
            return pad;
        }
        for (const [k, field] of this._fields.items()) {
            if (('padContentField' in field) && !(k in vals)) {
                const ctx = {
                    'model': this._name,
                    'fieldName': k,
                    'objectId': pad.id,
                }
                const padInfo = await (await this.withContext(ctx)).padGenerateUrl();
                pad[k] = padInfo['url'];
            }
        }
        return pad;
    }

    async _setFieldToPad(vals) {
        // Update the pad if the `padContentField` is modified
        for (const [k, field] of this._fields.items()) {
            if (('padContentField' in field) && vals[field.padContentField] && bool(await this[k])) {
                const paramSudo = await this.env.items('ir.config.parameter').sudo(); 
                const pad = {
                    "server": await paramSudo.getParam('pad.padServer'),
                    "key": await paramSudo.getParam('pad.padKey'),
                }
                const myPad = new EtherpadLiteClient(pad['key'], (pad['server'] || '') + '/api');
                const path = (await this[k]).split('/p/')[1];
                await myPad.setHtmlFallbackText(path, vals[field.padContentField]);
            }
        }
    }

    async _setPadToField(vals) {
        // Update the `pad_content_field` if the pad is modified
        for (const [k, v] of Object.entries(vals)) {
            const field = this._fields.get(k);
            if ('padContentField' in field) {
                vals[field.padContentField] = await this.padGetContent(v);
            }
        }
    }
}