import { api, Fields } from "../../../core";
import { UserError, ValidationError } from "../../../core/helper";
import { _super, MetaModel, Model } from "../../../core/models"
import { _f, len, update } from "../../../core/tools";

@MetaModel.define()
class SaleOrderTemplate extends Model {
    static _module = module;
    static _name = "sale.order.template";
    static _description = "Quotation Template";

    async _getDefaultRequireSignature() {
        return (await this.env.company()).portalConfirmationSign;
    }

    async _getDefaultRequirePayment() {
        return (await this.env.company()).portalConfirmationPay;
    }

    static label = Fields.Char('Quotation Template', {required: true});
    static saleOrderTemplateLineIds = Fields.One2many('sale.order.template.line', 'saleOrderTemplateId', {string: 'Lines', copy: true});
    static note = Fields.Html('Terms and conditions', {translate: true});
    static saleOrderTemplateOptionIds = Fields.One2many('sale.order.template.option', 'saleOrderTemplateId', {string: 'Optional Products', copy: true});
    static numberOfDays = Fields.Integer('Quotation Duration',
        {help: 'Number of days for the validity date computation of the quotation'});
    static requireSignature = Fields.Boolean('Online Signature', {default: self => self._getDefaultRequireSignature(), help: 'Request a online signature to the customer in order to confirm orders automatically.'});
    static requirePayment = Fields.Boolean('Online Payment', {default: self => self._getDefaultRequirePayment(), help: 'Request an online payment to the customer in order to confirm orders automatically.'});
    static mailTemplateId = Fields.Many2one(
        'mail.template', {string: 'Confirmation Mail',
        domain: [['model', '=', 'sale.order']],
        help: "This e-mail template will be sent on confirmation. Leave empty to send nothing."});
    static active = Fields.Boolean({default: true, help: "If unchecked, it will allow you to hide the quotation template without removing it."});
    static companyId = Fields.Many2one('res.company', {string: 'Company'});

    @api.constrains('companyId', 'saleOrderTemplateLineIds', 'saleOrderTemplateOptionIds')
    async _checkCompanyId() {
        for (const template of this) {
            const companies = (await template.mapped('saleOrderTemplateLineIds.productId.companyId')).or(await template.mapped('saleOrderTemplateOptionIds.productId.companyId'));
            if (len(companies) > 1) {
                throw new ValidationError(await this._t("Your template cannot contain products from multiple companies."));
            }
            else if (companies.ok && companies.ne(await template.companyId)) {
                throw new ValidationError(_f(await this._t(
                    "Your template contains products from company {productCompany} whereas your template belongs to company {templateCompany}. \n Please change the company of your template or remove the products from other companies."),
                    {productCompany: (await companies.mapped('displayName')).join(', '),
                    templateCompany: await (await template.companyId).displayName}
                ));
            }
        }
    }

    @api.onchange('saleOrderTemplateLineIds', 'saleOrderTemplateOptionIds')
    async _onchangeTemplateLineIds() {
        const companies = (await this.mapped('saleOrderTemplateOptionIds.productId.companyId')).or(await this.mapped('saleOrderTemplateLineIds.productId.companyId'));
        if (companies.ok && !companies.includes(await this['companyId'])) {
            await this.set('companyId', companies[0]);
        }
    }

    @api.modelCreateMulti()
    async create(valsList) {
        const records = await _super(SaleOrderTemplate, this).create(valsList);
        await records._updateProductTranslations();
        return records;
    }

    async write(vals) {
        if ('active' in vals && !vals['active']) {
            const companies = await (await this.env.items('res.company').sudo()).search([['saleOrderTemplateId', 'in', this.ids]]);
            await companies.set('saleOrderTemplateId', null);
        }
        const result = await _super(SaleOrderTemplate, this).write(vals);
        await this._updateProductTranslations();
        return result;
    }

    async _updateProductTranslations() {
        const languages = await this.env.items('res.lang').search([['active', '=', 'true']]);
        for (const lang of languages) {
            for (const line of await this['saleOrderTemplateLineIds']) {
                if (await line.label == await (await line.productId).getProductMultilineDescriptionSale()) {
                    await this.createOrUpdateTranslations({
                        modelName: 'sale.order.template.line,label', 
                        langCode: await lang.code,
                        resId: line.id, 
                        src: await line.label,
                        value: await (await (await line.productId).withContext({lang: await lang.code})).getProductMultilineDescriptionSale()
                    });
                }
            }
            for (const option of await this['saleOrderTemplateOptionIds']) {
                if (await option.label == await (await option.productId).getProductMultilineDescriptionSale()) {
                    await this.createOrUpdateTranslations({
                        modelName: 'sale.order.template.option,label', 
                        langCode: await lang.code,
                        resId: option.id,
                        src: await option.label,
                        value: await (await (await option.productId).withContext({lang: await lang.code})).getProductMultilineDescriptionSale()
                    });
                }
            }
        }
    }

    async createOrUpdateTranslations(opts: {modelName?: any, langCode?: any, resId?: any, src?: any, value?: any}={}) {
        const data = {
            'type': 'model',
            'label': opts.modelName,
            'lang': opts.langCode,
            'resId': opts.resId,
            'src': opts.src,
            'value': opts.value,
            'state': 'inprogress',
        }
        const existingTrans = await this.env.items('ir.translation').search([['label', '=', opts.modelName],
                                                            ['resId', '=', opts.resId],
                                                            ['lang', '=', opts.langCode]]);
        if (! existingTrans.ok) {
            await this.env.items('ir.translation').create(data);
        }
        else {
            await existingTrans.write(data);
        }
    }
}

@MetaModel.define()
class SaleOrderTemplateLine extends Model {
    static _module = module;
    static _name = "sale.order.template.line";
    static _description = "Quotation Template Line";
    static _order = 'saleOrderTemplateId, sequence, id';

    static sequence = Fields.Integer('Sequence', {help: "Gives the sequence order when displaying a list of sale quote lines.",
        default: 10});
    static saleOrderTemplateId = Fields.Many2one(
        'sale.order.template', {string: 'Quotation Template Reference',
        required: true, ondelete: 'CASCADE', index: true});
    static companyId = Fields.Many2one('res.company', {related: 'saleOrderTemplateId.companyId', store: true, index: true});
    static label = Fields.Text('Description', {required: true, translate: true});
    static productId = Fields.Many2one(
        'product.product', {string: 'Product', checkCompany: true,
        domain: [['saleOk', '=', true]]});
    static productUomQty = Fields.Float('Quantity', {required: true, digits: 'Product Unit of Measure', default: 1});
    static productUomId = Fields.Many2one('uom.uom', {string: 'Unit of Measure', domain: "[['categoryId', '=', productUomCategoryId]]"});
    static productUomCategoryId = Fields.Many2one({related: 'productId.uomId.categoryId', readonly: true});

    static displayType = Fields.Selection([
        ['lineSection', "Section"],
        ['lineNote', "Note"]], {default: false, help: "Technical field for UX purpose."});

    @api.onchange('productId')
    async _onchangeProductId() {
        this.ensureOne();
        const product = await this['productId'];
        if (product.ok) {
            await this.set('productUomId', (await product.uomId).id);
            await this.set('label', await product.getProductMultilineDescriptionSale());
        }
    }

    @api.model()
    async create(values) {
        if (values['displayType'] ?? (await this.defaultGet(['displayType']))['displayType']) {
            update(values, {productId: false, productUomQty: 0, productUomId: false});
        }
        return _super(SaleOrderTemplateLine, this).create(values);
    }

    async write(values) {
        if ('displayType' in values && await this.filtered(async (line) => await line.displayType != values['displayType'])) {
            throw new UserError(await this._t("You cannot change the type of a sale quote line. Instead you should delete the current line and create a new line of the proper type."));
        }
        return _super(SaleOrderTemplateLine, this).write(values);
    }

    static _sqlConstraints = [
        ['accountable_product_id_required',
            'CHECK("displayType" IS NOT NULL OR ("productId" IS NOT NULL AND "productUomId" IS NOT NULL))',
            "Missing required product and UoM on accountable sale quote line."],

        ['non_accountable_fields_null',
            'CHECK("displayType" IS NULL OR ("productId" IS NULL AND "productUomQty" = 0 AND "productUomId" IS NULL))',
            "Forbidden product, unit price, quantity, and UoM on non-accountable sale quote line"],
    ];
}

@MetaModel.define()
class SaleOrderTemplateOption extends Model {
    static _module = module;
    static _name = "sale.order.template.option";
    static _description = "Quotation Template Option";
    static _checkCompanyAuto = true;

    static saleOrderTemplateId = Fields.Many2one('sale.order.template', {string: 'Quotation Template Reference', ondelete: 'CASCADE', index: true, required: true});
    static companyId = Fields.Many2one('res.company', {related: 'saleOrderTemplateId.companyId', store: true, index: true});
    static label = Fields.Text('Description', {required: true, translate: true});
    static productId = Fields.Many2one(
        'product.product', {string: 'Product', domain: [['Csale_ok', '=', true]],
        required: true, checkCompany: true});
    static uomId = Fields.Many2one('uom.uom', {string: 'Unit of Measure ', required: true, domain: "[['categoryId', '=', productUomCategoryId]]"});
    static productUomCategoryId = Fields.Many2one({related: 'productId.uomId.categoryId', readonly: true});
    static quantity = Fields.Float('Quantity', {required: true, digits: 'Product Unit of Measure', default: 1});

    @api.onchange('productId')
    async _onchangeProductId() {
        const product = await this['productId'];
        if (!product.ok) {
            return;
        }
        await this.set('uomId', await product.uomId);
        await this.set('label', await product.getProductMultilineDescriptionSale());
    }
}
