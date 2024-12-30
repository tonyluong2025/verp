import { _Date, api, Fields } from "../../../core";
import { UserError, ValidationError } from "../../../core/helper";
import { _super, Model } from "../../../core/models"
import { MetaModel } from "../../../core/models"
import { _f, addDate, bool, isHtmlEmpty, len, update } from "../../../core/tools";

@MetaModel.define()
class SaleOrder extends Model {
    static _module = module;
    static _parents = 'sale.order';

    @api.model()
    async defaultGet(fieldsList) {
        const defaultVals = await _super(SaleOrder, this).defaultGet(fieldsList);
        if (fieldsList.includes("saleOrderTemplateId") && ! bool(defaultVals["saleOrderTemplateId"])) {
            const companyId = defaultVals['companyId'] ?? false;
            const company = companyId ? this.env.items("res.company").browse(companyId) : await this.env.company();
            defaultVals['saleOrderTemplateId'] = (await company.saleOrderTemplateId).id;
        }
        return defaultVals;
    }

    static saleOrderTemplateId = Fields.Many2one(
        'sale.order.template', {string: 'Quotation Template',
        readonly: true, checkCompany: true,
        states: {'draft': [['readonly', false]], 'sent': [['readonly', false]]},
        domain: "['|', ['companyId', '=', false], ['companyId', '=', companyId]]"});
    static saleOrderOptionIds = Fields.One2many(
        'sale.order.option', {relationField: 'orderId', string: 'Optional Products Lines',
        copy: true, readonly: true,
        states: {'draft': [['readonly', false]], 'sent': [['readonly', false]]}});

    @api.constrains('companyId', 'saleOrderOptionIds')
    async _checkOptionalProductCompanyId() {
        for (const order of this) {
            const companies = await (await (await order.saleOrderOptionIds).productId).companyId;
            if (companies.ok && companies.ne(await order.companyId)) {
                const badProducts = await (await (await order.saleOrderOptionIds).productId).filtered(async (p) => (await p.companyId).ok && (await p.companyId).ne(await order.companyId));
                throw new ValidationError(_f(await this._t(
                    "Your quotation contains products from company {productCompany} whereas your quotation belongs to company {quoteCompany}. \n Please change the company of your quotation or remove the products from other companies ({badProducts})."),
                    {productCompany: (await companies.mapped('displayName')).join(', '),
                    quoteCompany: await (await order.companyId).displayName,
                    badProducts: (await badProducts.mapped('displayName')).join(', ')}
                ));
            }
        }
    }

    @api.returns('self', value => value.id)
    async copy(defaultValue?: any) {
        const saleOrderTemplate = await this['saleOrderTemplateId'];
        if (saleOrderTemplate.ok && await saleOrderTemplate.numberOfDays > 0) {
            defaultValue = Object.assign({}, defaultValue ?? {});
            defaultValue['validityDate'] = addDate(await _Date.contextToday(self), {days: await saleOrderTemplate.numberOfDays});
        }
        return _super(SaleOrder, this).copy(defaultValue);
    }

    @api.onchange('partnerId')
    async onchangePartnerId() {
        await _super(SaleOrder, this).onchangePartnerId();
        const template = await (await this['saleOrderTemplateId']).withContext({lang: await (await this['partnerId']).lang});
        await this.set('note', ! isHtmlEmpty(await template.note) ? await template.note : await this['note']);
    }

    async _computeLineDataForTemplateChange(line) {
        return {
            'displayType': await line.displayType,
            'label': await line.label,
            'state': 'draft',
        }
    }

    async _computeOptionDataForTemplateChange(option) {
        let price = await (await option.productId).lstPrice;
        let discount = 0;

        const pricelist = await this['pricelistId'];
        if (pricelist.ok) {
            const pricelistPrice = await (await pricelist.withContext({uom: (await option.uomId).id})).getProductPrice(await option.productId, 1, false);

            if (await pricelist.discountPolicy == 'withoutDiscount' && price) {
                discount = Math.max(0, (price - pricelistPrice) * 100 / price);
            }
            else {
                price = pricelistPrice;
            }
        }
        return {
            'productId': (await option.productId).id,
            'label': await option.label,
            'quantity': await option.quantity,
            'uomId': (await option.uomId).id,
            'priceUnit': price,
            'discount': discount
        }
    }

    async updatePrices() {
        this.ensureOne();
        const res = await _super(SaleOrder, this).updatePrices();
        await (await this['saleOrderOptionIds'])._updatePriceAndDiscount();
        return res;
    }

    @api.onchange('saleOrderTemplateId')
    async onchangeSaleOrderTemplateId() {
        const saleOrderTemplate = await this['saleOrderTemplateId'];
        if (!saleOrderTemplate.ok) {
            await this.set('requireSignature', await (this as any)._getDefaultRequireSignature());
            await this.set('requirePayment', await (this as any)._getDefaultRequirePayment());
            return;
        }
        const template = await saleOrderTemplate.withContext({lang: await (await this['partnerId']).lang});

        const pricelist = await this['pricelistId'] 
        // --- first, process the list of products from the template
        const orderLines: any[] = [[5, 0, 0]];
        for (const line of await template.saleOrderTemplateLineIds) {
            const data = await this._computeLineDataForTemplateChange(line);
            const product = await line.productId;
            if (product.ok) {
                let price = await product.lstPrice;
                let discount = 0;

                if (pricelist.ok) {
                    const pricelistPrice = await (await pricelist.withContext({uom: (await line.productUomId).id})).getProductPrice(product, 1, false);

                    if (await pricelist.discountPolicy == 'withoutDiscount' && price) {
                        discount = Math.max(0, (price - pricelistPrice) * 100 / price);
                    }
                    else {
                        price = pricelistPrice;
                    }
                }

                update(data, {
                    'priceUnit': price,
                    'discount': discount,
                    'productUomQty': await line.productUomQty,
                    'productId': product.id,
                    'productUom': (await line.productUomId).id,
                    'customerLead': await (this as any)._getCustomerLead(await product.productTemplateId),
                });
            }

            orderLines.push([0, 0, data]);
        }

        // set first line to sequence -99, so a resequence on first page doesn't cause following page
        // lines (that all have sequence 10 by default) to get mixed in the first page
        if (len(orderLines) >= 2) {
            orderLines[1][2]['sequence'] = -99;
        }
        await this.set('orderLine', orderLines);
        await (await this['orderLine'])._computeTaxId();

        // then, process the list of optional products from the template
        const optionLines: any[] = [[5, 0, 0]];
        for (const option of await template.saleOrderTemplateOptionIds) {
            const data = await this._computeOptionDataForTemplateChange(option);
            optionLines.push([0, 0, data]);
        }

        await this.set('saleOrderOptionIds', optionLines);

        if (await template.numberOfDays > 0) {
            await this.set('validityDate', addDate(await _Date.contextToday(this), {days: await template.numberOfDays}));
        }
        await this.set('requireSignature', await template.requireSignature);
        await this.set('requirePayment', await template.requirePayment);

        if (! isHtmlEmpty(await template.note)) {
            await this.set('note', await template.note);
        }
    }

    async actionConfirm() {
        let self: any = this;
        const res = await _super(SaleOrder, self).actionConfirm();
        if (self.env.su) {
            self = await self.withUser(global.SUPERUSER_ID);
        }
        for (const order of self) {
            if ((await order.saleOrderTemplateId).ok && (await (await order.saleOrderTemplateId).mailTemplateId).ok) {
                await (await (await order.saleOrderTemplateId).mailTemplateId).sendMail(order.id);
            }
        }
        return res;
    }

    /**
     * Instead of the classic form view, redirect to the online quote if it exists.
     * @param accessUid 
     * @returns 
     */
    async getAccessAction(accessUid?: any) {
        this.ensureOne();
        let user = accessUid && (await this.env.items('res.users').sudo()).browse(accessUid);
        user = user.ok ? user : await this.env.user();

        if (!(await this['saleOrderTemplateId']).ok || (! await user.share && ! this.env.context['forceWebsite'])) {
            return _super(SaleOrder, this).getAccessAction(accessUid);
        }
        return {
            'type': 'ir.actions.acturl',
            'url': await (this as any).getPortalUrl(),
            'target': 'self',
            'resId': this.id,
        }
    }
}

@MetaModel.define()
class SaleOrderLine extends Model {
    static _module = module;
    static _parents = "sale.order.line";
    static _description = "Sales Order Line";

    static saleOrderOptionIds = Fields.One2many('sale.order.option', 'lineId', {string: 'Optional Products Lines'});

    // Take the description on the order template if the product is present in it
    @api.onchange('productId')
    async productIdChange() {
        const domain = await _super(SaleOrderLine, this).productIdChange();
        if ((await this['productId']).ok && (await (await this['orderId']).saleOrderTemplateId).ok) {
            for (const line of await (await (await this['orderId']).saleOrderTemplateId).saleOrderTemplateLineIds) {
                if ((await line.productId).eq(await this['productId'])) {
                    const lang = await (await (await this['orderId']).partnerId).lang;
                    await this.set('label', await (await line.withContext({lang})).label + await (await this.withContext({lang}))._getSaleOrderLineMultilineDescriptionVariants());
                    break;
                }
            }
        }
        return domain;
    }
}

@MetaModel.define()
class SaleOrderOption extends Model {
    static _module = module;
    static _name = "sale.order.option";
    static _description = "Sale Options";
    static _order = 'sequence, id';

    static isPresent = Fields.Boolean({string: "Present on Quotation",
                           help: "This field will be checked if the option line's product is "+
                                "already present in the quotation.",
                           compute: "_computeIsPresent", search: "_searchIsPresent"});
    static orderId = Fields.Many2one('sale.order', {string: 'Sales Order Reference', ondelete: 'CASCADE', index: true});
    static lineId = Fields.Many2one('sale.order.line', {ondelete: "SET NULL", copy: false});
    static label = Fields.Text('Description', {required: true});
    static productId = Fields.Many2one('product.product', {string: 'Product', required: true, domain: [['saleOk', '=', true]]});
    static priceUnit = Fields.Float('Unit Price', {required: true, digits: 'Product Price'});
    static discount = Fields.Float('Discount (%)', {digits: 'Discount'});
    static uomId = Fields.Many2one('uom.uom', {string: 'Unit of Measure ', required: true, domain: "[['categoryId', '=', productUomCategoryId]]"});
    static productUomCategoryId = Fields.Many2one({related: 'productId.uomId.categoryId', readonly: true});
    static quantity = Fields.Float('Quantity', {required: true, digits: 'Product Unit of Measure', default: 1});
    static sequence = Fields.Integer('Sequence', {help: "Gives the sequence order when displaying a list of optional products."});

    async _updatePriceAndDiscount() {
        for (const option of this) {
            if (! (await option.productId).ok) {
                continue;
            }
            // To compute the discount a so line is created in cache
            const values = await option._getValuesToAddToOrder();
            const newSol = await option.env.items('sale.order.line').new(values);
            await newSol._onchangeDiscount();
            await option.set('discount', await newSol.discount);
            const order = await option.orderId;
            if ((await order.pricelistId).ok && (await order.partnerId).ok) {
                const product = await (await option.productId).withContext({
                    partner: await order.partnerId,
                    quantity: await option.quantity,
                    date: await order.dateOrder,
                    pricelist: (await order.pricelistId).id,
                    uom: (await option.uomId).id,
                    fiscalPosition: option.env.context['fiscalPosition']
                });
                await option.set('priceUnit', await newSol._getDisplayPrice(product));
            }
        }
    }

    @api.depends('lineId', 'orderId.orderLine', 'productId')
    async _computeIsPresent() {
        // NOTE: this field cannot be stored as the line_id is usually removed
        // through cascade deletion, which means the compute would be false
        for (const option of this) {
            await option.set('isPresent', bool(await (await (await option.orderId).orderLine).filtered(async (l) => (await l.productId).eq(await option.productId))));
        }
    }

    async _searchIsPresent(operator, value) {
        if ((operator === '=' && value === true) || (operator === '!=' && value === false)) {
            return [['lineId', '=', false]];
        }
        return [['lineId', '!=', false]];
    }

    @api.onchange('productId', 'uomId', 'quantity')
    async _onchangeProductId() {
        if (! (await this['productId']).ok) {
            return;
        }
        const product = await (await this['productId']).withContext({
            lang: await (await (await this['orderId']).partnerId).lang,
        });
        await this.set('uomId', (await this['uomId']).ok ? await this['uomId'] : await product.uomId);
        await this.set('label', await product.getProductMultilineDescriptionSale());
        await this._updatePriceAndDiscount();
    }

    async buttonAddToOrder() {
        await this.addOptionToOrder();
    }

    async addOptionToOrder() {
        this.ensureOne();

        const saleOrder = await this['orderId'];

        if (!['draft', 'sent'].includes(await saleOrder.state)) {
            throw new UserError(await this._t('You cannot add options to a confirmed order.'));
        }

        const values = await this._getValuesToAddToOrder();
        const orderLine = await this.env.items('sale.order.line').create(values);
        await orderLine._computeTaxId();

        await this.write({'lineId': orderLine.id});
        if (saleOrder.ok) {
            await saleOrder.addOptionToOrderWithTaxcloud();
        }
    }

    async _getValuesToAddToOrder() {
        this.ensureOne();
        const self: any = this;
        return {
            'orderId': (await self.orderId).id,
            'priceUnit': await self.priceUnit,
            'label': await self.label,
            'productId': (await self.productId).id,
            'productUomQty': await self.quantity,
            'productUom': (await self.uomId).id,
            'discount': await self.discount,
            'companyId': (await (await self.orderId).companyId).id,
        }
    }
}
