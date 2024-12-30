import assert from "assert";
import { randomInt } from "crypto";
import { Fields, _Date, api } from "../../../core";
import { MissingError, OrderedDict, ValidationError } from "../../../core/helper";
import { MetaModel, Model } from "../../../core/models";
import { expression } from "../../../core/osv";
import { bool, f, isInstance, len, partition, range, stringPart } from "../../../core/tools";
import { literalEval } from "../../../core/tools/ast";
import { iterchildren, parseXml } from "../../../core/tools/xml";

@MetaModel.define()
class WebsiteSnippetFilter extends Model {
    static _module = module;
    static _name = 'website.snippet.filter';
    static _parents = ['website.published.multi.mixin'];
    static _description = 'Website Snippet Filter';
    static _order = 'label ASC';

    static label = Fields.Char({ required: true, translate: true });
    static actionServerId = Fields.Many2one('ir.actions.server', { string: 'Server Action', ondelete: 'CASCADE' });
    static fieldNames = Fields.Char({ help: "A list of comma-separated field names", required: true });
    static filterId = Fields.Many2one('ir.filters', { string: 'Filter', ondelete: 'CASCADE' });
    static limit = Fields.Integer({ help: 'The limit is the maximum number of records retrieved', required: true });
    static websiteId = Fields.Many2one('website', { string: 'Website', ondelete: 'CASCADE' });
    static modelName = Fields.Char({ string: 'Model name', compute: '_computeModelName' });

    @api.depends('filterId', 'actionServerId')
    async _computeModelName() {
        for (const snippetFilter of this) {
            if (bool(await snippetFilter.filterId)) {
                await snippetFilter.set('modelName', await (await snippetFilter.filterId).modelId);
            }
            else {  // this.actionServerId
                await snippetFilter.set('modelName', await (await (await snippetFilter.actionServerId).modelId).model);
            }
        }
    }

    @api.constrains('actionServerId', 'filterId')
    async _checkDataSourceIsProvided() {
        for (const record of this) {
            if (bool(await record.actionServerId) == bool(await record.filterId)) {
                throw new ValidationError(await this._t("Either action_server_id or filter_id must be provided."));
            }
        }
    }

    /**
     * Limit must be between 1 and 16.
     */
    @api.constrains('limit')
    async _checkLimit() {
        for (const record of this) {
            const limit = await record.limit;
            if (!(0 < limit && limit <= 16)) {
                throw new ValidationError(await this._t("The limit must be between 1 and 16."));
            }
        }
    }


    @api.constrains('fieldNames')
    async _checkFieldNames() {
        for (const record of this) {
            for (const fieldName of (await record.fieldNames).split(",")) {
                if (!fieldName.trim()) {
                    throw new ValidationError(await this._t("Empty field name in %s", await record.fieldNames));
                }
            }
        }
    }

    /**
     * Renders the website dynamic snippet items
     * @param templateKey 
     * @param limit 
     * @param opts 
     * @returns 
     */
    async _render(templateKey, limit, searchDomain?: any, withSample?: boolean) {
        this.ensureOne();
        assert(templateKey.includes('.dynamicFilterTemplate'), await this._t("You can only use template prefixed by dynamicFilterTemplate "));
        if (searchDomain == null) {
            searchDomain = [];
        }

        const [website, modelName] = await this('websiteId', 'modelName');
        if (website.ok && !(await this.env.items('website').getCurrentWebsite()).eq(website)) {
            return '';
        }

        if (templateKey.includes(modelName.replace('.', '_'))) {
            return '';
        }

        let records = await this._prepareValues(limit, searchDomain);
        const isSample = withSample && !bool(records);
        if (isSample) {
            records = await this._prepareSample(limit);
        }
        const view = await (await this.env.items('ir.ui.view').sudo()).withContext({ inheritBranding: false });
        const content = await view._renderTemplate(templateKey, {
            records: records,
            isSample: isSample,
        });
        return Array.from(iterchildren(parseXml(f('<root>%s</root>', String(content))))).map(el => el.toString());
    }

    /**
     * Gets the data and returns it the right format for render.
     * @param limit 
     * @param searchDomain 
     */
    async _prepareValues(limit?: any, searchDomain?: any) {
        this.ensureOne()

        // TODO adapt in master: the "limit" field is there to prevent loading
        // an arbitrary number of records asked by the client side. It was
        // however set to 6 for a blog post filter, probably thinking it was a
        // default limit and not a max limit. That means that configuring a
        // higher limit via the editor (which allows up to 16) was not working.
        // As a stable fix, this was made to bypass the max limit if it is under
        // 16, and only for newly configured snippets.
        const maxLimit = this.env.context['_bugfixForceMinimumMaxLimitTo16'] ? Math.max(await this['limit'], 16) : await this['limit'];
        limit = limit && Math.min(limit, maxLimit) || maxLimit;

        if (bool(await this['filterId'])) {
            const filterSudo = await (await this['filterId']).sudo();
            let domain = await filterSudo._getEvalDomain();
            const _fields = this.env.models[filterSudo.modelId]._fields;
            if ('websiteId' in _fields) {
                domain = expression.AND([domain, (await this.env.items('website').getCurrentWebsite()).websiteDomain()]);
            }
            if ('companyId' in _fields) {
                const website = await this.env.items('website').getCurrentWebsite();
                domain = expression.AND([domain, [['companyId', 'in', [false, (await website.companyId).id]]]]);
            }
            if ('isPublished' in _fields) {
                domain = expression.AND([domain, [['isPublished', '=', true]]]);
            }
            if (searchDomain) {
                domain = expression.AND([domain, searchDomain]);
            }
            try {
                const records = await (await this.env.items(await filterSudo.modelId).withContext(literalEval(await filterSudo.context))).search(
                    domain,
                    {
                        order: literalEval(await filterSudo.sort).join(',') || null,
                        limit: limit
                    }
                );
                return this._filterRecordsToValues(records);
            } catch (e) {
                if (isInstance(e, MissingError)) {
                    console.warn("The provided domain %s in 'ir.filters' generated a MissingError in '%s'", domain, this._name)
                    return [];
                } else {
                    throw e;
                }
            }
        }

        else if ((await this['actionServerId']).ok) {
            try {
                const res = (await (await (await (await this['actionServerId']).withContext({
                    dynamicFilter: this,
                    limit: limit,
                    searchDomain: searchDomain,
                })).sudo()).run()) || [];
                return res;
            } catch (e) {
                if (isInstance(e, MissingError)) {
                    console.warn("The provided domain %s in 'ir.actions.server' generated a MissingError in '%s'", searchDomain, this._name);
                    return [];
                } else {
                    throw e;
                }
            }
        }
    }

    /**
     * Separates the name and the widget type

        @param model: Model to which the field belongs, without it type is deduced from fieldName
        @param fieldName: Name of the field possibly followed by a colon and a forced field type

        @return Tuple containing the field name and the field type
     * @param model 
     * @param fieldName 
     */
    async _getFieldNameAndType(model, fieldName) {
        let fieldWidget, fieldType;
        [fieldName, , fieldWidget] = stringPart(fieldName, ":");
        if (!fieldWidget) {
            const field = model._fields.get(fieldName);
            if (field) {
                fieldType = field.type;
            }
            else if (fieldName.includes('image')) {
                fieldType = 'image';
            }
            else if (fieldName.includes('price')) {
                fieldType = 'monetary';
            }
            else {
                fieldType = 'text';
            }
        }
        return [fieldName, fieldWidget || fieldType];
    }

    /**
     * Extracts the meta data of each field

        @return OrderedDict containing the widget type for each field name
     * @returns 
     */
    async _getFilterMetaData() {
        const model = this.env.items(await this['modelName']);
        const metaData = new OrderedDict();
        for (let fieldName of (await this['fieldNames']).split(",")) {
            let fieldWidget;
            [fieldName, fieldWidget] = await this._getFieldNameAndType(model, fieldName);
            metaData[fieldName] = fieldWidget;
        }
        return metaData;
    }

    /**
     * Generates sample data and returns it the right format for render.

        @param length: Number of sample records to generate

        @return Array of objets with a value associated to each name in fieldNames
     * @param length 
     * @returns 
     */
    async _prepareSample(length = 6) {
        if (!length) {
            return [];
        }
        const records = await this._prepareSampleRecords(length);
        return this._filterRecordsToValues(records, true);
    }

    /**
     * Generates sample records.

        @param length: Number of sample records to generate

        @return List of of sample records
     * @param length 
     * @returns 
     */
    async _prepareSampleRecords(length) {
        if (!length) {
            return [];
        }

        const sample = [];
        const model = this.env.items(await this['modelName']);
        const sampleData = await this._getHardcodedSample(model);
        if (bool(sampleData)) {
            for (const index of range(0, length)) {
                const singleSampleData = Object.assign({}, sampleData[f(index, len(sampleData))]);
                this._fillSample(singleSampleData, index);
                sample.push(await model.new(singleSampleData));
            }
        }
        return sample;
    }

    /**
     * Fills the missing fields of a sample

        @param sample: Data structure to fill with values for each name in fieldNames
        @param index: Index of the sample within the dataset
     * @param sample 
     * @param index 
     */
    async _fillSample(sample, index) {
        const metaData = await this._getFilterMetaData();
        const model = this.env.models[await this['modelName']];
        for (const [fieldName, fieldWidget] of Object.entries(metaData)) {
            if (!(fieldName in sample) && fieldName in model._fields) {
                if (['image', 'binary'].includes(fieldWidget)) {
                    sample[fieldName] = null;
                }
                else if (fieldWidget == 'monetary') {
                    sample[fieldName] = randomInt(100, 10000) / 10.0;
                }
                else if (['integer', 'float'].includes(fieldWidget)) {
                    sample[fieldName] = index;
                }
                else {
                    sample[fieldName] = await this._t('Sample %s', index + 1);
                }
            }
        }
        return sample;
    }

    /**
     * Returns a hard-coded sample

        @param model: Model of the currently rendered view

        @return Sample data records with field values
     * @param model 
     * @returns 
     */
    async _getHardcodedSample(model) {
        return [{}];
    }

    /**
     * Extract the fields from the data source 'records' and put them into a dictionary of values

        @param records: Model records returned by the filter
        @param isSample: true if conversion if for sample records

        @return List of dict associating the field value to each field name
     * @param records 
     * @param isSample 
     */
    async _filterRecordsToValues(records, isSample = false) {
        this.ensureOne();
        const metaData = await this._getFilterMetaData();

        const values = [];
        const model = this.env.items(await this['modelName']);
        const website = this.env.items('website');
        for (const record of records) {
            const data = {};
            for (const [fieldName, fieldWidget] of Object.entries(metaData)) {
                const field = model._fields.get(fieldName);
                if (field && ['binary', 'image'].includes(field.type)) {
                    if (isSample) {
                        data[fieldName] = fieldName in record ? Buffer.from(await record[fieldName]).toString('utf8') : '/web/image';
                    }
                    else {
                        data[fieldName] = await website.imageUrl(record, fieldName);
                    }
                }
                else if (fieldWidget === 'monetary') {
                    let modelCurrency;
                    if (field && field.type === 'monetary') {
                        modelCurrency = await record[await field.getCurrencyField(record)];
                    }
                    else if ('currencyId' in model._fields) {
                        modelCurrency = await record['currencyId'];
                    }
                    if (bool(modelCurrency)) {
                        const websiteCurrency = await this._getWebsiteCurrency();
                        data[fieldName] = await modelCurrency._convert(
                            record[fieldName],
                            websiteCurrency,
                            await (await website.getCurrentWebsite()).companyId,
                            _Date.today()
                        );
                    }
                    else {
                        data[fieldName] = await record[fieldName];
                    }
                }
                else {
                    data[fieldName] = await record[fieldName];
                }
            }

            data['callToActionUrl'] = 'websiteUrl' in record._fields && await record['websiteUrl'];
            data['_record'] = record;
            values.push(data);
        }
        return values;
    }

    @api.model()
    async _getWebsiteCurrency() {
        const company = await (await this.env.items('website').getCurrentWebsite()).companyId;
        return company.currencyId;
    }
}