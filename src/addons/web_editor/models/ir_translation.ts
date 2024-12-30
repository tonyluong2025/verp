import assert from "assert";
import { api } from "../../../core";
import { MetaModel, Model, _super } from "../../../core/models";
import { _f, f, htmlTranslate, len, partition, stringPart, xmlTranslate } from "../../../core/tools";
import { parseHtml, serializeHtml, serializeXml } from "../../../core/tools/xml";

function editTranslationMapping(data: {} = {}) {
    data = Object.assign(data, { model: stringPart(data['label'], ',')[0], value: data['value'] || data['src'] });
    return _f('<span data-oe-model="{model}" data-oe-translation-id="{id}" data-oe-translation-state="{state}">{value}</span>', data);
}

@MetaModel.define()
class IrTranslation extends Model {
    static _module = module;
    static _parents = 'ir.translation';

    @api.model()
    async _getTermsMapping(field, records) {
        if (this._context['editTranslations']) {
            await (this as any).insertMissing(field, records);
            return editTranslationMapping;
        }
        return await _super(IrTranslation, this)._getTermsMapping(field, records);
    }

    /**
     * Convert the HTML fragment ``value`` to XML if necessary, and write
        it as the value of translation ``self``.
     * @param value 
     * @returns 
     */
    async saveHtml(value) {
        assert(len(this) == 1 && await this['type'] == 'modelTerms');
        const [mname, fname] = (await this['label']).split(',');
        const field = this.env.models[mname]._fields[fname];
        if (field.translate == xmlTranslate) {
            // wrap value inside a div and parse it as HTML
            const div = f("<div>%s</div>", value);
            const root = parseHtml(div, 'utf-8');
            // root is html > body > div
            // serialize div as XML and discard surrounding tags
            value = serializeXml(root.childNodes[0][0], 'utf-8').slice(5, -6);
        }
        else if (field.translate == htmlTranslate) {
            // wrap value inside a div and parse it as HTML
            const div = f("<div>%s</div>", value);
            const root = parseHtml(div, 'utf-8');
            // root is html > body > div
            // serialize div as HTML and discard surrounding tags
            value = serializeHtml(root[0][0], 'utf-8').slice(5, -6);
        }
        return this.write({ 'value': value });
    }
}
