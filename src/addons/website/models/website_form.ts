import { Fields, api } from "../../../core";
import { MAGIC_COLUMNS, MetaModel, Model } from "../../../core/models";
import { bool, quoteList } from "../../../core/tools";

@MetaModel.define()
class WebsiteFormConfig extends Model {
    static _module = module;
    static _parents = 'website';

    async _websiteFormLastRecord() {
        const req = this.env.req;
        if (req && req.session.formBuilderModelModel) {
            return (await req.getEnv()).items(req.session.formBuilderModelModel).browse(req.session.formBuilderId);
        }
        return false;
    }
}

@MetaModel.define()
class WebsiteFormModel extends Model {
    static _module = module;
    static _name = 'ir.model';
    static _description = 'Models';
    static _parents = 'ir.model';

    static websiteFormAccess = Fields.Boolean('Allowed to use in forms', { help: 'Enable the form builder feature for this model.' });
    static websiteFormDefaultFieldId = Fields.Many2one('ir.model.fields', { string: 'Field for custom form data', domain: "[['model', '=', model], ['ttype', '=', 'text']]", help: "Specify the field which will contain meta and custom form fields datas." });
    static websiteFormLabel = Fields.Char("Label for form action", { help: "Form action label. Ex: crm.lead could be 'Send an e-mail' and project.issue could be 'Create an Issue'." });
    static websiteFormKey = Fields.Char({ help: 'Used in FormBuilder Registry' });

    /**
     * Restriction of "authorized fields" (fields which can be used in the
        form builders) to fields which have actually been opted into form
        builders and are writable. By default no field is writable by the
        form builder.
     * @returns 
     */
    async _getFormWritableFields() {
        const included = new Set();
        for (const field of await (await this.env.items('ir.model.fields').sudo()).search([
            ['modelId', '=', this.id],
            ['websiteFormBlacklisted', '=', false]
        ])) {
            included.add(await field.label);
        }
        const res = {}
        for (const [k, v] of Object.entries(await this.getAuthorizedFields(await this['model']))) {
            if (included.has(k)) {
                res[k] = v;
            }
        }
        return res;
    }

    /**
     * Return the fields of the given model name as a mapping like method `fieldsGet`.
     * @param modelName 
     */
    @api.model()
    async getAuthorizedFields(modelName) {
        const model = this.env.items(modelName);
        const fieldsGet = await model.fieldsGet();

        for (const val of Object.values(model.cls._inherits)) {
            fieldsGet.pop(val, null);
        }

        // Unrequire fields with default values
        const fieldsGetKeys = Object.keys(fieldsGet);
        const defaultValues = await (await model.withUser(global.SUPERUSER_ID)).defaultGet(fieldsGetKeys);
        for (const field of fieldsGetKeys.filter(f => f in defaultValues)) {
            fieldsGet[field]['required'] = false;
        }

        // Remove readonly and magic fields
        // Remove string domains which are supposed to be evaluated
        // (e.g. "[['productId', '=', productId]]")
        const MAGIC_FIELDS = MAGIC_COLUMNS.concat(model.cls.CONCURRENCY_CHECK_FIELD);
        for (const field of fieldsGetKeys) {
            if ('domain' in fieldsGet[field] && typeof (fieldsGet[field]['domain']) === 'string') {
                delete fieldsGet[field]['domain'];
            }
            if (fieldsGet[field]['readonly'] || MAGIC_FIELDS.includes(field) || fieldsGet[field]['type'] == 'many2oneReference') {
                delete fieldsGet[field];
            }
        }

        return fieldsGet;
    }

    @api.model()
    async getCompatibleFormModels() {
        if (! await (await this.env.user()).hasGroup('website.groupWebsitePublisher')) {
            return [];
        }
        return (await this.sudo()).searchRead([['websiteFormAccess', '=', true]],
            ['id', 'model', 'label', 'websiteFormLabel', 'websiteFormKey'],
        );
    }
}

/**
 * fields configuration for form builder
 */
@MetaModel.define()
class WebsiteFormModelFields extends Model {
    static _module = module;
    static _name = 'ir.model.fields';
    static _description = 'Fields';
    static _parents = 'ir.model.fields';

    async init() {
        // set all existing unset websiteFormBlacklisted fields to ``true``
        //  (so that we can use it as a whitelist rather than a blacklist)
        await this._cr.execute('UPDATE "irModelFields" \
                            SET "websiteFormBlacklisted"=true \
                            WHERE "websiteFormBlacklisted" IS NULL');
        // add an SQL-level default value on websiteFormBlacklisted to that
        // pure-SQL ir.model.field creations (e.g. in _reflect) generate
        // the right default value for a whitelist (aka fields should be
        // blacklisted by default)
        await this._cr.execute('ALTER TABLE "irModelFields" \
                            ALTER COLUMN "websiteFormBlacklisted" SET DEFAULT true');
    }

    /**
     * :param str model: name of the model on which to whitelist fields
        :param list(str) fields: list of fields to whitelist on the model
        :return: nothing of import
     * @param self 
     * @param model 
     * @param fields 
     */
    @api.model()
    async formbuilderWhitelist(model, fields) {
        // postgres does *not* like ``in [EMPTY TUPLE]`` queries
        if (!bool(fields)) {
            return false;
        }

        // only allow users who can change the website structure
        if (! await this.env.items('res.users').hasGroup('website.groupWebsiteDesigner')) {
            return false;
        }

        // the ORM only allows writing on custom fields and will trigger a
        // registry reload once that's happened. We want to be able to
        // whitelist non-custom fields and the registry reload absolutely
        // isn't desirable, so go with a method and raw SQL
        await this.env.cr.execute(
            `UPDATE "irModelFields"
            SET "websiteFormBlacklisted"=false
            WHERE model='%s' AND label in (%s)`, [model, quoteList(fields)]);
        return true;
    }

    static websiteFormBlacklisted = Fields.Boolean(
        'Blacklisted in web forms', {
            default: true, index: true, // required=true,
        help: 'Blacklist this field for web forms'
    });
}