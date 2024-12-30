import https from "https";
import { DateTime } from "luxon";
import path from "path";
import xpath from 'xpath';
import { Field, _Date, _Datetime, api } from '../../../core';
import { getattr } from "../../../core/api/func";
import { ValueError } from "../../../core/helper/errors";
import { AbstractModel, MetaModel, ModelRecords, _super } from "../../../core/models";
import { getResourcePath } from "../../../core/modules";
import { urlParse } from "../../../core/service/middleware/utils";
import { b64encode, bool, f, getLang, getTimezoneInfo, isDigit, pop, posixToLdml, split, toText } from '../../../core/tools';
import { parseLocale } from '../../../core/tools/locale';
import { escapeHtml, isElement, iterchildren, popAttribute, serializeXml } from "../../../core/tools/xml";
import { readFile } from "fs/promises";
import { stringify } from "../../../core/tools/json";

const REMOTE_CONNECTION_TIMEOUT = 2.5;

/**
 * QWeb object for rendering editor stuff
 */
@MetaModel.define()
class QWeb extends AbstractModel {
    static _module = module;
    static _parents = 'ir.qweb';

    // order and ignore
    _directivesEvalOrder(): string[] {
        const directives: string[] = _super(QWeb, this)._directivesEvalOrder();
        directives.splice(directives.indexOf('call'), 0, 'snippet');
        directives.splice(directives.indexOf('call'), 0, 'snippet-call');
        directives.splice(directives.indexOf('call'), 0, 'install');
        return directives;
    }

    // compile directives

    async _compileNode(el, options: {}={}, indent: number=0) {
        const snippetKey = options['snippet-key'];
        if (snippetKey === options['template'] || options['snippet-sub-call-key'] === options['template']) {
            // Get the path of element to only consider the first node of the
            // snippet template content (ignoring all ancestors t elements which
            // are not t-call ones)
            let nbRealElementsInHierarchy = 0;
            let node = el;
            while (isElement(node) && nbRealElementsInHierarchy < 2) {
                if (node.tagName !== 't' || node.hasAttribute('t-call')) {
                    nbRealElementsInHierarchy += 1;
                }
                node = node.parentNode as Element;
            }
            if (nbRealElementsInHierarchy == 1) {
                // The first node might be a call to a sub template
                const subCall = el.getAttribute('t-call');
                if (subCall) {
                    el.setAttribute('t-options', `{'snippet-key': '${snippetKey}', 'snippet-sub-call-key': '${subCall}'}`);
                }
                // If it already has a data-snippet it is a saved or an inherited snippet.
                // Do not override it.
                else if (!el.hasAttribute('data-snippet')) {
                    el.setAttribute('data-snippet', split(snippetKey, '.', 1).slice(-1)[0]);
                }
            }
        }
        return _super(QWeb, this)._compileNode(el, options, indent);
    }
    
    async _compileDirectiveSnippet(el, options: {}={}, indent: number=0) {
        const key = popAttribute(el, 't-snippet');
        el.setAttribute('t-call', key);
        el.setAttribute('t-options', "{'snippet-key': '" + key + "'}");
        const view = await this.env.items('ir.ui.view').sudo();
        const viewId = await view.getViewId(key);
        const label = await view.browse(viewId).label;
        const thumbnail = popAttribute(el, 't-thumbnail', "oe-thumbnail");
        // Forbid sanitize contains the specific reason:
        // - "true": always forbid
        // - "form": forbid if forms are sanitized
        const forbidSanitize = el.getAttribute('t-forbid-sanitize');
        const div = f('<div name="%s" data-oe-type="snippet" data-oe-thumbnail="%s" data-oe-snippet-id="%s" data-oe-keywords="%s" %s>', 
            escapeHtml(toText(label)),
            escapeHtml(toText(thumbnail)),
            escapeHtml(toText(viewId)),
            escapeHtml((xpath.select1('//keywords', el) as Element).textContent),
            forbidSanitize ? `data-oe-forbid-sanitize="${forbidSanitize}"` : '',
        );
        (this as any)._appendText(div, options);
        const code = await this._compileNode(el, options, indent);
        (this as any)._appendText('</div>', options);
        return code;
    }

    async _compileDirectiveSnippetCall(el, options: {}={}, indent: number=0) {
        const key = popAttribute(el, 't-snippet-call');
        el.setAttribute('t-call', key);
        el.setAttribute('t-options', "{'snippet-key': '" + key + "'}");
        return this._compileNode(el, options, indent);
    }

    async _compileDirectiveInstall(el, options: {}={}, indent: number=0) { 
        if (await this.userHasGroups('base.groupSystem')) {
            const modul = await this.env.items('ir.module.module').search([['label', '=', el.getAttribute('t-install')]]);
            if (!modul.ok || await modul.state === 'installed') {
                return [];
            }
            const label = el.getAttribute('string') || 'Snippet';
            const thumbnail = popAttribute(el, 't-thumbnail', 'oe-thumbnail');
            const div = f('<div name="%s" data-oe-type="snippet" data-module-id="%s" data-oe-thumbnail="%s"><section/></div>',
                escapeHtml(toText(label)),
                modul.id,
                escapeHtml(toText(thumbnail))
            );
            (this as any)._appendText(div, options);
        }
        return [];
    }

    async _compileDirectiveTag(el, options: {}={}, indent: number=0) {
        if (el.getAttribute('t-placeholder')) {
            el.setAttribute('t-att-placeholder', popAttribute(el, 't-placeholder'));
        }
        return _super(QWeb, this)._compileDirectiveTag(el, options, indent);
    }
}


// QWeb fields
@MetaModel.define()
class FieldConverter extends AbstractModel {
    static _module = module;
    static _name = 'ir.qweb.field';
    static _description = 'Qweb Field';
    static _parents = 'ir.qweb.field';

    @api.model()
    async attributes(record, fieldName, options, values) {
        const attrs = await _super(FieldConverter, this).attributes(record, fieldName, options, values);
        const field = record._fields[fieldName];

        const placeholder = options['placeholder'] || getattr(field, 'placeholder', null);
        if (placeholder) {
            attrs['placeholder'] = placeholder;
        }
        if (options['translate'] && ['char', 'text'].includes(field.type)) {
            const label = f("%s,%s", record._name, fieldName);
            const domain = [['label', '=', label], ['resId', '=', record.id], ['type', '=', 'model'], ['lang', '=', options['lang']]];
            const translation = await record.env.items('ir.translation').search(domain, {limit: 1});
            attrs['data-oe-translation-state'] = translation && await translation.state || 'toTranslate';
        }

        return attrs;
    }

    valueFromString(value) {
        return value;
    }

    @api.model()
    async fromHtml(model, field, element) {
        return this.valueFromString(element.textContent.trim());
    }
}

@MetaModel.define()
class IntegerConverter extends AbstractModel {
    static _module = module;
    static _name = 'ir.qweb.field.integer';
    static _description = 'Qweb Field Integer';
    static _parents = 'ir.qweb.field.integer';

    @api.model()
    async fromHtml(model, field, element) {
        const lang = await (this as any).userLang();
        const value = element.textContent.trim();
        return parseInt(value.replace(await lang.thousandsSep || '', ''));
    }
}

@MetaModel.define()
class FloatConverter extends AbstractModel {
    static _module = module;
    static _name = 'ir.qweb.field.float';
    static _description = 'Qweb Field Float';
    static _parents = 'ir.qweb.field.float';

    @api.model()
    async fromHtml(model, field, element) {
        const lang = await (this as any).userLang();
        const value = element.textContent.trim();
        return parseFloat(value.replace(await lang.thousandsSep || '', '')
                          .replace(await lang.decimalPoint, '.'));
    }
}

@MetaModel.define()
class ManyToOneConverter extends AbstractModel {
    static _module = module;
    static _name = 'ir.qweb.field.many2one';
    static _description = 'Qweb Field Many to One';
    static _parents = 'ir.qweb.field.many2one';

    @api.model()
    async attributes(record, fieldName, options, values) {
        const attrs = await _super(ManyToOneConverter, this).attributes(record, fieldName, options, values);
        if (options['inheritBranding']) {
            const many2one = await record[fieldName];
            if (many2one.ok) {
                attrs['data-oe-many2one-id'] = many2one.id;
                attrs['data-oe-many2one-model'] = many2one._name;
            }
        }
        return attrs;
    }

    @api.model()
    async fromHtml(model, field, element) {
        model = this.env.items(element.getAttribute('data-oe-model'));
        const id = parseInt(element.getAttribute('data-oe-id'));
        const m2o = this.env.items(field.comodelName);
        const fieldName = element.getAttribute('data-oe-field');
        const many2oneId = parseInt(element.getAttribute('data-oe-many2one-id'));
        const record = many2oneId && m2o.browse(many2oneId);
        if (record.ok && bool(await record.exists())) {
            // save the new id of the many2one
            await model.browse(id).write({fieldName: many2oneId});
        }
        // not necessary, but might as well be explicit about it
        return null;
    }
}

@MetaModel.define()
class ContactConverter extends AbstractModel {
    static _module = module;
    static _name = 'ir.qweb.field.contact';
    static _description = 'Qweb Field Contact';
    static _parents = 'ir.qweb.field.contact';

    @api.model()
    async attributes(record, fieldName, options, values) {
        const attrs = await _super(ContactConverter, this).attributes(record, fieldName, options, values);
        if (options['inheritBranding']) {
            pop(options, 'templateOptions'); // remove options not specific to this widget
            attrs['data-oe-contact-options'] = stringify(options);
        }
        return attrs;
    }

    // helper to call the rendering of contact field
    @api.model()
    async getRecordToHtml(ids, options?: any) {
        return (this as any).valueToHtml(await this.env.items('res.partner').search([['id', '=', ids[0]]]), options);
    }
}

class DateConverter extends AbstractModel {
    static _module = module;
    static _name = 'ir.qweb.field.date';
    static _description = 'Qweb Field Date';
    static _parents = 'ir.qweb.field.date';

    @api.model()
    async attributes(record, fieldName, options, values) {
        let attrs = await _super(DateConverter, this).attributes(record, fieldName, options, values);
        if (options['inheritBranding']) {
            attrs['data-oe-original'] = await record[fieldName];

            if (record._fields[fieldName].type === 'datetime') {
                attrs = await this.env.items('ir.qweb.field.datetime').attributes(record, fieldName, options, values);
                attrs['data-oe-type'] = 'datetime';
                return attrs;
            }

            let lang = await this.env.items('res.lang')._langGet(await (await this.env.user()).lang);
            lang = bool(lang) ? lang : await getLang(this.env);
            const locale = parseLocale(await lang.code)[0];
            let valueFormat = posixToLdml(await lang.dateFormat, locale);
            let babelFormat = valueFormat;
            if (await record[fieldName]) {
                const date = _Date.toDate(await record[fieldName]);
                valueFormat = toText(DateTime.fromJSDate(date as Date).toFormat(babelFormat, {locale: locale}));
            }

            attrs['data-oe-original-with-format'] = valueFormat;
        }
        return attrs;
    }

    @api.model()
    async fromHtml(model, field, element) {
        const value = element.textContent.trim();
        if (! value) {
            return false;
        }
        let lang = await this.env.items('res.lang')._langGet(await (await this.env.user()).lang);
        lang = lang.ok ? lang : await getLang(this.env);
        const date = DateTime.fromJSDate(value).toFormat(await lang.dateFormat);
        return _Date.toDate(date);
    }
}

@MetaModel.define()
class DateTimeConverter extends AbstractModel {
    static _module = module;
    static _name = 'ir.qweb.field.datetime';
    static _description = 'Qweb Field Datetime';
    static _parents = 'ir.qweb.field.datetime';

    @api.model()
    async attributes(record, fieldName, options, values) {
        const attrs = await _super(DateTime, this).attributes(record, fieldName, options, values);

        if (options['inheritBranding']) {
            let value = await record[fieldName];
            const user = await this.env.user();
            let lang = await this.env.items('res.lang')._langGet(await user.lang);
            lang = lang.ok ? lang : await getLang(this.env);
            const locale = parseLocale(await lang.code)[0];
            let babelFormat = posixToLdml(f('%s %s', await lang.dateFormat, await lang.timeFormat), locale);
            let valueFormat = babelFormat;
            const tz = record.env.context['tz'] || await user.tz;
            if (typeof(value) === 'string') {
                value = _Datetime.toDatetime(value);
            }
            if (value) {
                // convert from UTC (server timezone) to user timezone
                value = await _Datetime.contextTimestamp(await this.withContext({tz: tz}), value);
                valueFormat = toText(DateTime.fromJSDate(value).toFormat(babelFormat, {locale: locale}));
                value = _Datetime.toString(value);
            }

            attrs['data-oe-original'] = value;
            attrs['data-oe-original-with-format'] = valueFormat;
            attrs['data-oe-original-tz'] = tz;
        }
        return attrs;
    }

    @api.model()
    async fromHtml(model, field, element) {
        let value = element.textContent.trim();
        if (!value) {
            return false;
        }
        // parse from string to datetime
        const user = await this.env.user();
        let lang = await this.env.items('res.lang')._langGet(await user.lang);
        lang = lang.ok ? lang : await getLang(this.env);
        let dt: any = DateTime.fromJSDate(value).toFormat(f('%s %s', await lang.dateFormat, await lang.timeFormat));

        // convert back from user's timezone to UTC
        const tzName = element.getAttribute('data-oe-original-tz') || this.env.context['tz'] || await user.tz;
        if (tzName) {
            try {
                const userTz = getTimezoneInfo(tzName).timeZone;

                dt = DateTime.fromJSDate(dt, {zone: userTz}).toJSDate();
            } catch(e) {
                console.warn(`Failed to convert the value for a field of the model%s back from the user's timezone (%s) to UTC`, model, tzName, {excInfo: true});
            }
        }

        // format back to string
        return _Datetime.toString(dt);
    }
}

@MetaModel.define()
class TextConverter extends AbstractModel {
    static _module = module;
    static _name = 'ir.qweb.field.text';
    static _description = 'Qweb Field Text';
    static _parents = 'ir.qweb.field.text';

    @api.model()
    async fromHtml(model, field, element) {
        return htmlToText(element);
    }
}

@MetaModel.define()
class SelectionConverter extends AbstractModel {
    static _module = module;
    static _name = 'ir.qweb.field.selection';
    static _description = 'Qweb Field Selection';
    static _parents = 'ir.qweb.field.selection';

    @api.model()
    async fromHtml(model: ModelRecords, field: Field, element) {
        const value = element.textContent.trim();
        const selection = (await field.getDescription(this.env))['selection'];
        for (let [k, v] of Object.entries<any>(selection)) {
            if (typeof(v) === 'string') {
                v = String(v);
            }
            if (value == v) {
                return k;
            }
        }

        throw new ValueError(f("No value found for label %s in selection %s", value, selection));
    }
}

@MetaModel.define()
class HTMLConverter extends AbstractModel {
    static _module = module;
    static _name = 'ir.qweb.field.html';
    static _description = 'Qweb Field HTML';
    static _parents = 'ir.qweb.field.html';

    @api.model()
    async attributes(record, fieldName, options, values?: any) {
        const attrs = await _super(HTMLConverter, this).attributes(record, fieldName, options, values);
        if (options['inheritBranding']) {
            const field = record._fields[fieldName];
            if (field.sanitize) {
                attrs['data-oe-sanitize'] = field.sanitizeForm ? 1 : 'allowForm';
            }
        }
        return attrs;
    }

    @api.model()
    async fromHtml(model, field, element) {
        const content = [];
        if (element.textContent.trim()) {
            content.push(element.textContent.trim());
        }
        for (const child of iterchildren(element, isElement)) {
            content.push(serializeXml(child));
        }
        return content.join('\n');
    }
}

/**
 * Widget options:

    ``class``
        set as attribute on the generated <img> tag
 */
@MetaModel.define()
class ImageConverter extends AbstractModel {
    static _module = module;
    static _name = 'ir.qweb.field.image';
    static _description = 'Qweb Field Image';
    static _parents = 'ir.qweb.field.image';

    localUrlRe = new RegExp('^/(?<module>[^]]+)/static/(?<rest>.+)$', 'g');

    @api.model()
    async fromHtml(model, field, element) {
        const img = xpath.select1('//img', element) as Element;
        if (img == null) {
            return false;
        }
        const url = img.getAttribute('src');

        const urlObject = urlParse(url);
        if (urlObject.pathname.startsWith('/web/image')) {
            const fragments = urlObject.pathname.split('/');
            const query = urlObject.searchQuery;
            const urlId = fragments[3].split('-')[0];
            let oid;
            // ir.attachment image urls: /web/image/<id>[-<checksum>][/...]
            if (isDigit(urlId)) {
                model = 'ir.attachment';
                oid = urlId;
                field = 'datas';
            }
            // url of binary field on model: /web/image/<model>/<id>/<field>[/...]
            else {
                model = query.get('model', fragments[3]);
                oid = query.get('id', fragments[4]);
                field = query.get('field', fragments[5]);
            }
            const item = this.env.items(model).browse(parseInt(oid));
            return item[field];
        }

        if (this.localUrlRe.test(urlObject.pathname)) {
            return this.loadLocalUrl(url);
        }

        return this.loadRemoteUrl(url);
    }

    async loadLocalUrl(url) {
        const matches = urlParse(url).pathname.matchAll(this.localUrlRe);
        const group = matches ? matches.next().value.group : {};
        const rest = group['rest'];
        if (path.sep !== '/') {
            rest.replace(path.sep, '/');
        }

        const p = getResourcePath(group['module'], 'static', ...rest.split('/'));

        if (! p) {
            return null;
        }
        try {
            const buf = readFile(p);
            const res = b64encode(buf);
            return res;                
        } catch(e) {
            console.error("Failed to load local image %r", url);
            return null;
        }
    }

    async loadRemoteUrl(url) {
        try {
            // should probably remove remote URLs entirely:
            // * in fields, downloading them without blowing up the server is a
            //   challenge
            // * in views, may trigger mixed content warnings if HTTPS CMS
            //   linking to HTTP images
            // implement drag & drop image upload to mitigate?
            let result;
            await new Promise(( resolve, reject ) => {
                https.get(url, (res) => {
                    if (res.statusCode !== 200) {
                        console.error(`Did not get an OK from the server. Code: ${res.statusCode}`);
                        res.resume();
                        return;
                    }

                    let data = '';
                    res.on('data', (chunk) => {
                        data += chunk;
                    });
                    
                    res.on('close', () => {
                        result = b64encode(data);
                    });
                });
        
            });
            return result;
        } catch(e) {
            console.warn("Failed to load remote image %r", url, {excInfo: true});
            return null;
        }
    }
}

@MetaModel.define()
class MonetaryConverter extends AbstractModel {
    static _module = module;
    static _name = 'ir.qweb.field.monetary';
    static _parents = 'ir.qweb.field.monetary';

    @api.model()
    async fromHtml(model, field, element) {
        const lang = (this as any).userLang();

        const value = xpath.select1('span', element) as Element;

        return parseFloat(value.textContent.trim().replace(await lang.thousandsSep || '', '')
                          .replace(await lang.decimalPoint, '.'));
    }
}

@MetaModel.define()
class DurationConverter extends AbstractModel {
    static _module = module;
    static _name = 'ir.qweb.field.duration';
    static _description = 'Qweb Field Duration';
    static _parents = 'ir.qweb.field.duration';

    @api.model()
    async attributes(record, fieldName, options, values) {
        const attrs = await _super(DurationConverter, this).attributes(record, fieldName, options, values);
        if (options['inheritBranding']) {
            attrs['data-oe-original'] = await record[fieldName];
        }
        return attrs;
    }

    @api.model()
    async fromHtml(model, field, element) {
        const value = element.textContent.trim();

        // non-localized value
        return parseFloat(value);
    }
}

@MetaModel.define()
class RelativeDatetimeConverter extends AbstractModel {
    static _module = module;
    static _name = 'ir.qweb.field.relative';
    static _description = 'Qweb Field Relative';
    static _parents = 'ir.qweb.field.relative';

    // get formatting from ir.qweb.field.relative but edition/save from datetime
}

@MetaModel.define()
class QwebView extends AbstractModel {
    static _module = module;
    static _name = 'ir.qweb.field.qweb';
    static _description = 'Qweb Field qweb';
    static _parents = 'ir.qweb.field.qweb';
}

/**
 * Converts HTML content with HTML-specified line breaks (br, p, div, ...)
    in roughly equivalent textual content.

    Used to replace and fixup the roundtripping of text and m2o: when using
    libxml 2.8.0 (but not 2.9.1) and parsing HTML with lxml.html.fromstring
    whitespace text nodes (text nodes composed *solely* of whitespace) are
    stripped out with no recourse, and fundamentally relying on newlines
    being in the text (e.g. inserted during user edition) is probably poor form
    anyway.

    -> this utility function collapses whitespace sequences and replaces
       nodes by roughly corresponding linebreaks
       * p are pre-and post-fixed by 2 newlines
       * br are replaced by a single newline
       * block-level elements not already mentioned are pre- and post-fixed by
         a single newline

    ought be somewhat similar (but much less high-tech) to aaronsw's html2text.
    the latter produces full-blown markdown, our text -> html converter only
    replaces newlines by <br> elements at this point so we're reverting that,
    and a few more newline-ish elements in case the user tried to add
    newlines/paragraphs into the text field

    :param element: lxml.html content
    :returns: corresponding pure-text output
 * @param element 
 * @returns 
 */
function htmlToText(element) {
    // output is a list of str | int. Integers are padding requests (in minimum
    // number of newlines). When multiple padding requests, fold them into the
    // biggest one
    const output = [];
    _wrap(element, output);

    // remove any leading or tailing whitespace, replace sequences of
    // (whitespace)\n(whitespace) by a single newline, where (whitespace) is a
    // non-newline whitespace in this case
    return Array.from(_realizePadding(output)).join('').trim().replace(/[ \t\r\f]*\n[ \t\r\f]*/, '\n');
}

const _PADDED_BLOCK = new Set('p h1 h2 h3 h4 h5 h6'.split(' '));
// https://developer.mozilla.org/en-US/docs/HTML/Block-level_elements minus p
const _MISC_BLOCK = new Set('address article aside audio blockquote canvas dd dl div figcaption figure footer form header hgroup hr ol output pre section tfoot ul video'.split(' '));

/**
 * Collapses sequences of whitespace characters in ``text`` to a single
    space
 * @param text 
 * @returns 
 */
function _collapseWhitespace(text) {
    return text.replace(/\s+/, ' ');
}

/**
 * Fold and convert padding requests: integers in the output sequence are
    requests for at least n newlines of padding. Runs thereof can be collapsed
    into the largest requests and converted to newlines.
 * @param it 
 */
function* _realizePadding(it) {
    let padding = 0;
    for (const item of it) {
        if (typeof(item) == 'number') {
            padding = Math.max(padding, item);
            continue;
        }

        if (padding) {
            yield '\n'.repeat(padding);
            padding = 0;
        }
        yield item
    }
    // leftover padding irrelevant as the output will be stripped
}

/**
 * Recursively extracts text from ``element`` (via _elementToText), and
wraps it all in ``wrapper``. Extracted text is added to ``output``

:type wrapper: basestring | int
    * @param element 
    * @param output 
    * @param wrapper 
    */
function _wrap(element, output: string[], wrapper: any='') {
    output.push(wrapper);
    if (element.textContent) {
        output.push(_collapseWhitespace(element.textContent));
    }
    for (const child of iterchildren(element)) {
        _elementToText(child, output);
    }
    output.push(wrapper);
}

function _elementToText(e, output: string[]) {
    if (e.tagName === 'br') {
        output.push('\n');
    }
    else if (_PADDED_BLOCK.has(e.tagName)) {
        _wrap(e, output, 2);
    }
    else if (_MISC_BLOCK.has(e.tagName)) {
        _wrap(e, output, 1);
    }
    else {
        // inline
        _wrap(e, output);
    }
    if (e.nextSibling) {
        output.push(_collapseWhitespace(e.nextSibling));
    }
}