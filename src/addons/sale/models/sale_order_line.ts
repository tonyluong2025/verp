import _ from "lodash";
import { _Date, _Datetime, api, Fields } from "../../../core";
import { UserError } from "../../../core/helper";
import { _super, MetaModel, Model } from "../../../core/models";
import { expression } from "../../../core/osv";
import { _f, addDate, bool, f, floatCompare, floatIsZero, floatRound, getLang, len, map, some, sum, update } from "../../../core/tools";
import { setdefault } from "../../../core/api";

@MetaModel.define()
class SaleOrderLine extends Model {
    static _module = module;
    static _name = 'sale.order.line';
    static _description = 'Sales Order Line';
    static _order = 'orderId, sequence, id';
    static _checkCompanyAuto = true;

    /**
     * Compute the invoice status of a SO line. Possible statuses:
        - no: if the SO is not in status 'sale' or 'done', we consider that there is nothing to
          invoice. This is also hte default value if the conditions of no other status is met.
        - to invoice: we refer to the quantity to invoice of the line. Refer to method
          `_getToInvoiceQty()` for more information on how this quantity is calculated.
        - upselling: this is possible only for a product invoiced on ordered quantities for which
          we delivered more than expected. The could arise if, for example, a project took more
          time than expected but we decided not to invoice the extra cost to the client. This
          occurs onyl in state 'sale', so that when a SO is set to done, the upselling opportunity
          is removed from the list.
        - invoiced: the quantity invoiced is larger or equal to the quantity ordered.
     */
    @api.depends('state', 'productUomQty', 'qtyDelivered', 'qtyToInvoice', 'qtyInvoiced')
    async _computeInvoiceStatus() {
        const precision = await this.env.items('decimal.precision').precisionGet('Product Unit of Measure');
        for (const line of this) {
            if (!['sale', 'done'].includes(await line.state)) {
                await line.set('invoiceStatus', 'no');
            }
            else if (await line.isDownpayment && await line.untaxedAmountToInvoice == 0) {
                await line.set('invoiceStatus', 'invoiced');
            }
            else if (!floatIsZero(await line.qtyToInvoice, { precisionDigits: precision })) {
                await line.set('invoiceStatus', 'to invoice');
            }
            else if (await line.state === 'sale' && await (await line.productId).invoicePolicy === 'order' &&
                await line.productUomQty >= 0.0 &&
                floatCompare(await line.qtyDelivered, await line.productUomQty, { precisionDigits: precision }) == 1) {
                await line.set('invoiceStatus', 'upselling');
            }
            else if (floatCompare(await line.qtyInvoiced, await line.productUomQty, { precisionDigits: precision }) >= 0) {
                await line.set('invoiceStatus', 'invoiced');
            }
            else {
                await line.set('invoiceStatus', 'no');
            }
        }
    }

    async _expectedDate() {
        this.ensureOne();
        const order = await this['orderId'];
        const orderDate = _Datetime.toDatetime(await order.dateOrder && ['sale', 'done'].includes(await order.state) ? await order.dateOrder : _Datetime.now());
        return addDate(orderDate as Date, { days: await this['customerLead'] || 0.0 });
    }

    /**
     * Compute the amounts of the SO line.
     */
    @api.depends('productUomQty', 'discount', 'priceUnit', 'taxId')
    async _computeAmount() {
        for (const line of this) {
            const price = await line.priceUnit * (1 - (await line.discount || 0.0) / 100.0);
            const taxes = await (await line.taxId).computeAll(price, { currency: await (await line.orderId).currencyId, quantity: await line.productUomQty, product: await line.productId, partner: await (await line.orderId).partnerShippingId });
            await line.update({
                'priceTax': sum((taxes['taxes'] ?? []).map(t => t['amount'] ?? 0.0)),
                'priceTotal': taxes['totalIncluded'],
                'priceSubtotal': taxes['totalExcluded'],
            });
        }
    }

    @api.depends('productId', 'orderId.state', 'qtyInvoiced', 'qtyDelivered')
    async _computeProductUpdatable() {
        for (const line of this) {
            if (['done', 'cancel'].includes(await line.state) || (await line.state == 'sale' && (await line.qtyInvoiced > 0 || await line.qtyDelivered > 0))) {
                await line.set('productUpdatable', false);
            }
            else {
                await line.set('productUpdatable', true);
            }
        }
    }

    /**
     * Compute the quantity to invoice. If the invoice policy is order, the quantity to invoice is
        calculated from the ordered quantity. Otherwise, the quantity delivered is used.
     * @returns 
     */
    // no trigger productId.invoicePolicy to avoid retroactively changing SO
    @api.depends('qtyInvoiced', 'qtyDelivered', 'productUomQty', 'orderId.state')
    async _getToInvoiceQty() {
        for (const line of this) {
            if (['sale', 'done'].includes(await (await line.orderId).state)) {
                if (await (await line.productId).invoicePolicy === 'order') {
                    await line.set('qtyToInvoice', await line.productUomQty - await line.qtyInvoiced);
                }
                else {
                    await line.set('qtyToInvoice', await line.qtyDelivered - await line.qtyInvoiced);
                }
            }
            else {
                await line.set('qtyToInvoice', 0);
            }
        }
    }

    /**
     * Compute the quantity invoiced. If case of a refund, the quantity invoiced is decreased. Note
        that this is the case only if the refund is generated from the SO and that is intentional: if
        a refund made would automatically decrease the invoiced quantity, then there is a risk of reinvoicing
        it automatically, which may not be wanted at all. That's why the refund has to be created from the SO
     * @returns 
     */
    @api.depends('invoiceLines.moveId.state', 'invoiceLines.quantity', 'untaxedAmountToInvoice')
    async _computeQtyInvoiced() {
        for (const line of this) {
            let qtyInvoiced = 0.0;
            for (const invoiceLine of await line._getInvoiceLines()) {
                const move = await invoiceLine.moveId;
                if (await move.state !== 'cancel' || await move.paymentState === 'invoicingLegacy') {
                    if (await move.moveType === 'outInvoice') {
                        qtyInvoiced += await (await invoiceLine.productUomId)._computeQuantity(await invoiceLine.quantity, await line.productUom);
                    }
                    else if (await move.moveType == 'outRefund') {
                        qtyInvoiced -= await (await invoiceLine.productUomId)._computeQuantity(await invoiceLine.quantity, await line.productUom);
                    }
                }
            }
            await line.set('qtyInvoiced', qtyInvoiced);
        }
    }

    async _getInvoiceLines() {
        this.ensureOne();
        if (this._context['accrualEntryDate']) {
            return (await this['invoiceLines']).filtered(
                async (l) => await (await l.moveId).invoiceDate && await (await l.moveId).invoiceDate <= this._context['accrualEntryDate']
            );
        }
        else {
            return this['invoiceLines'];
        }
    }

    @api.depends('priceUnit', 'discount')
    async _computePriceReduce() {
        for (const line of this) {
            await line.set('priceReduce', await line.priceUnit * (1.0 - await line.discount / 100.0));
        }
    }

    @api.depends('priceTotal', 'productUomQty')
    async _computePriceReduceTaxinc() {
        for (const line of this) {
            await line.set('priceReduceTaxinc', await line.productUomQty ? (await line.priceTotal / await line.productUomQty) : 0.0);
        }
    }

    @api.depends('priceSubtotal', 'productUomQty')
    async _computePriceReduceTaxexcl() {
        for (const line of this) {
            await line.set('priceReduceTaxexcl', await line.productUomQty ? (await line.priceSubtotal / await line.productUomQty) : 0.0);
        }
    }

    async _computeTaxId() {
        for (let line of this) {
            line = await line.withCompany(await line.companyId);
            let fpos = await (await line.orderId).fiscalPositionId;
            fpos = bool(fpos) ? fpos : await (await (await line.orderId).fiscalPositionId).getFiscalPosition((await line.orderPartnerId).id);
            // If companyId is set, always filter taxes by the company
            const taxes = await (await (await line.productId).taxesId).filtered(async (t) => (await t.companyId).eq(await line.env.company()));
            await line.set('taxId', await fpos.mapTax(taxes));
        }
    }

    /**
     * Deduce missing required fields from the onchange
     * @param values 
     * @returns 
     */
    @api.model()
    async _prepareAddMissingFields(values) {
        const res = {}
        const onchangeFields = ['label', 'priceUnit', 'productUom', 'taxId'];
        if (values['orderId'] && values['productId'] && onchangeFields.some(f => !(f in values))) {
            const line = await this.new(values);
            await line.productIdChange();
            for (const field of onchangeFields) {
                if (!(field in values)) {
                    res[field] = await line._fields[field].convertToWrite(await line[field], line);
                }
            }
        }
        return res;
    }

    @api.modelCreateMulti()
    async create(valsList) {
        for (const values of valsList) {
            if (values['displayType'] ?? (await this.defaultGet(['displayType']))['displayType']) {
                update(values, { productId: false, priceUnit: 0, productUomQty: 0, productUom: false, customerLead: 0 });
            }
            update(values, await this._prepareAddMissingFields(values));
        }
        const lines = await _super(SaleOrderLine, this).create(valsList);
        for (const line of lines) {
            const product = await line.productId;
            if (bool(product) && await (await line.orderId).state === 'sale') {
                const msg = await this._t("Extra line with %s", await product.displayName);
                await (await line.orderId).messagePost({ body: msg });
                // create an analytic account if at least an expense product
                if (![false, 'no'].includes(await (await line.productId).expensePolicy) && !bool(await (await line.orderId).analyticAccountId)) {
                    await (await line.orderId)._createAnalyticAccount();
                }
            }
        }
        return lines;
    }

    static _sqlConstraints = [
        ['accountable_required_fields',
            'CHECK("displayType" IS NOT NULL OR ("productId" IS NOT NULL AND "productUom" IS NOT NULL))',
            "Missing required fields on accountable sale order line."],
        ['non_accountable_null_fields',
            'CHECK("displayType" IS NULL OR ("productId" IS NULL AND "priceUnit" = 0 AND "productUomQty" = 0 AND "productUom" IS NULL AND "customerLead" = 0))',
            "Forbidden values on non-accountable sale order line"],
    ];

    async _updateLineQuantity(values) {
        const orders = await this.mapped('orderId');
        for (const order of orders) {
            const orderLines = await this.filtered(async (x) => (await x.orderId).eq(order));
            let msg = "<b>" + await this._t("The ordered quantity has been updated.") + "</b><ul>";
            for (const line of orderLines) {
                msg += f("<li> %s: <br/>", await (await line.productId).displayName);
                msg += _f(await this._t("Ordered Quantity: {oldQty} -> {newQty}"),
                    {
                        oldQty: await line.productUomQty,
                        newQty: values["productUomQty"]
                    }
                ) + "<br/>";
                if (['consu', 'product'].includes(await (await line.productId).type)) {
                    msg += await this._t("Delivered Quantity: %s", await line.qtyDelivered) + "<br/>";
                }
                msg += await this._t("Invoiced Quantity: %s", await line.qtyInvoiced) + "<br/>";
            }
            msg += "</ul>";
            await order.messagePost({ body: msg });
        }
    }

    async write(values) {
        if ('displayType' in values && bool(await this.filtered(async (line) => await line.displayType != values['displayType']))) {
            throw new UserError(await this._t("You cannot change the type of a sale order line. Instead you should delete the current line and create a new line of the proper type."));
        }
        if ('productUomQty' in values) {
            const precision = await this.env.items('decimal.precision').precisionGet('Product Unit of Measure');
            await (await this.filtered(
                async (r) => await r.state === 'sale' && floatCompare(await r.productUomQty, values['productUomQty'], { precisionDigits: precision }) != 0))._updateLineQuantity(values);
        }

        // Prevent writing on a locked SO.
        const protectedFields = await this._getProtectedFields();
        if ((await this.mapped('orderId.state')).includes('done') && protectedFields.some(f => Object.keys(values).includes)) {
            const protectedFieldsModified = _.intersection(protectedFields, Object.keys(values));
            const fields = await this.env.items('ir.model.fields').search([
                ['label', 'in', protectedFieldsModified], ['model', '=', this._name]
            ]);
            throw new UserError(
                await this._t('It is forbidden to modify the following fields in a locked order:\n%s', (await fields.mapped('fieldDescription')).join('\n'))
            )
        }
        return _super(SaleOrderLine, this).write(values);
    }

    static orderId = Fields.Many2one('sale.order', { string: 'Order Reference', required: true, ondelete: 'CASCADE', index: true, copy: false });
    static label = Fields.Text({ string: 'Description', required: true });
    static sequence = Fields.Integer({ string: 'Sequence', default: 10 });

    static invoiceLines = Fields.Many2many('account.move.line', { relation: 'saleOrderLineInvoiceRel', column1: 'orderLineId', column2: 'invoiceLineId', string: 'Invoice Lines', copy: false });
    static invoiceStatus = Fields.Selection([
        ['upselling', 'Upselling Opportunity'],
        ['invoiced', 'Fully Invoiced'],
        ['to invoice', 'To Invoice'],
        ['no', 'Nothing to Invoice']
    ], { string: 'Invoice Status', compute: '_computeInvoiceStatus', store: true, default: 'no' });
    static priceUnit = Fields.Float('Unit Price', { required: true, digits: 'Product Price', default: 0.0 });

    static priceSubtotal = Fields.Monetary({ compute: '_computeAmount', string: 'Subtotal', store: true });
    static priceTax = Fields.Float({ compute: '_computeAmount', string: 'Total Tax', store: true });
    static priceTotal = Fields.Monetary({ compute: '_computeAmount', string: 'Total', store: true });

    static priceReduce = Fields.Float({ compute: '_computePriceReduce', string: 'Price Reduce', digits: 'Product Price', store: true });
    static taxId = Fields.Many2many('account.tax', { string: 'Taxes', context: { 'activeTest': false }, checkCompany: true });
    static priceReduceTaxinc = Fields.Monetary({ compute: '_computePriceReduceTaxinc', string: 'Price Reduce Tax inc', store: true });
    static priceReduceTaxexcl = Fields.Monetary({ compute: '_computePriceReduceTaxexcl', string: 'Price Reduce Tax excl', store: true });

    static discount = Fields.Float({ string: 'Discount (%)', digits: 'Discount', default: 0.0 });

    static productId = Fields.Many2one(
        'product.product', {
            string: 'Product', domain: "[['saleOk', '=', true], '|', ['companyId', '=', false], ['companyId', '=', companyId]]",
        changeDefault: true, ondelete: 'RESTRICT', checkCompany: true
    });  // Unrequired company
    static productTemplateId = Fields.Many2one(
        'product.template', {
            string: 'Product Template',
        related: "productId.productTemplateId", domain: [['saleOk', '=', true]]
    });
    static productUpdatable = Fields.Boolean({ compute: '_computeProductUpdatable', string: 'Can Edit Product', default: true });
    static productUomQty = Fields.Float({ string: 'Quantity', digits: 'Product Unit of Measure', required: true, default: 1.0 });
    static productUom = Fields.Many2one('uom.uom', { string: 'Unit of Measure', domain: "[['categoryId', '=', productUomCategoryId]]", ondelete: "RESTRICT" });
    static productUomCategoryId = Fields.Many2one({ related: 'productId.uomId.categoryId' });
    static productUomReadonly = Fields.Boolean({ compute: '_computeProductUomReadonly' });
    static productCustomAttributeValueIds = Fields.One2many('product.attribute.custom.value', 'saleOrderLineId', { string: "Custom Values", copy: true });

    // M2M holding the values of product.attribute with create_variant field set to 'noVariant'
    // It allows keeping track of the extraPrice associated to those attribute values and add them to the SO line description
    static productNoVariantAttributeValueIds = Fields.Many2many('product.template.attribute.value', { string: "Extra Values", ondelete: 'RESTRICT' });

    static qtyDeliveredMethod = Fields.Selection([
        ['manual', 'Manual'],
        ['analytic', 'Analytic From Expenses']
    ], {
        string: "Method to update delivered qty", compute: '_computeQtyDeliveredMethod', store: true,
        help: "According to product configuration, the delivered quantity can be automatically computed by mechanism :\n" +
            "  - Manual: the quantity is set manually on the line\n" +
            "  - Analytic From expenses: the quantity is the quantity sum from posted expenses\n" +
            "  - Timesheet: the quantity is the sum of hours recorded on tasks linked to this sale line\n" +
            "  - Stock Moves: the quantity comes from confirmed pickings\n"
    });
    static qtyDelivered = Fields.Float('Delivered Quantity', { copy: false, compute: '_computeQtyDelivered', inverse: '_inverseQtyDelivered', store: true, digits: 'Product Unit of Measure', default: 0.0 });
    static qtyDeliveredManual = Fields.Float('Delivered Manually', { copy: false, digits: 'Product Unit of Measure', default: 0.0 });
    static qtyToInvoice = Fields.Float({
        compute: '_getToInvoiceQty', string: 'To Invoice Quantity', store: true,
        digits: 'Product Unit of Measure'
    });
    static qtyInvoiced = Fields.Float({
        compute: '_computeQtyInvoiced', string: 'Invoiced Quantity', store: true,
        digits: 'Product Unit of Measure'
    });

    static untaxedAmountInvoiced = Fields.Monetary("Untaxed Invoiced Amount", { compute: '_computeUntaxedAmountInvoiced', store: true });
    static untaxedAmountToInvoice = Fields.Monetary("Untaxed Amount To Invoice", { compute: '_computeUntaxedAmountToInvoice', store: true });

    static salesmanId = Fields.Many2one({ related: 'orderId.userId', store: true, string: 'Salesperson' });
    static currencyId = Fields.Many2one({ related: 'orderId.currencyId', depends: ['orderId.currencyId'], store: true, string: 'Currency' });
    static companyId = Fields.Many2one({ related: 'orderId.companyId', string: 'Company', store: true, index: true });
    static orderPartnerId = Fields.Many2one({ related: 'orderId.partnerId', store: true, string: 'Customer', index: true });
    static analyticTagIds = Fields.Many2many(
        'account.analytic.tag', {
            string: 'Analytic Tags',
        compute: '_computeAnalyticTagIds', store: true, readonly: false,
        domain: "['|', ['companyId', '=', false], ['companyId', '=', companyId]]"
    });
    static analyticLineIds = Fields.One2many('account.analytic.line', 'soLine', { string: "Analytic lines" });
    static isExpense = Fields.Boolean('Is expense', { help: "Is true if the sales order line comes from an expense or a vendor bills" });
    static isDownpayment = Fields.Boolean({
        string: "Is a down payment", help: "Down payments are made when creating invoices from a sales order." +
            " They are not copied when duplicating a sales order."
    })

    static state = Fields.Selection({
        related: 'orderId.state', string: 'Order Status', copy: false, store: true
    });

    static customerLead = Fields.Float(
        'Lead Time', {
            required: true, default: 0.0,
        help: "Number of days between the order confirmation and the shipping of the products to the customer"
    });

    static displayType = Fields.Selection([
        ['lineSection', "Section"],
        ['lineNote', "Note"]], { default: false, help: "Technical field for UX purpose." });

    static productPackagingId = Fields.Many2one('product.packaging', { string: 'Packaging', default: false, domain: "[['sales', '=', true], ['productId', '=', productId]]", checkCompany: true });
    static productPackagingQty = Fields.Float('Packaging Quantity');

    @api.depends('state')
    async _computeProductUomReadonly() {
        for (const line of this) {
            await line.set('productUomReadonly', bool(line.ids) && ['sale', 'done', 'cancel'].includes(await line.state));
        }
    }

    /**
     * Sale module compute delivered qty for product [['type', 'in', ['consu']], ['serviceType', '=', 'manual']]
                - consu + expensePolicy : analytic (sum of analytic unitAmount)
                - consu + no expensePolicy : manual (set manually on SOL)
                - service (+ serviceType='manual', the only available option) : manual

            This is true when only sale is installed: sale_stock redifine the behavior for 'consu' type,
            and saleTimesheet implements the behavior of 'service' + serviceType=timesheet.
     * @returns 
     */
    @api.depends('isExpense')
    async _computeQtyDeliveredMethod() {
        for (const line of this) {
            if (await line.isExpense) {
                await line.set('qtyDeliveredMethod', 'analytic');
            }
            else {  // service and consu
                await line.set('qtyDeliveredMethod', 'manual');
            }
        }
    }

    /**
     * This method compute the delivered quantity of the SO lines: it covers the case provide by sale module, aka
            expense/vendor bills (sum of unit_amount of AAL), and manual case.
            This method should be overridden to provide other way to automatically compute delivered qty. Overrides should
            take their concerned so lines, compute and set the `qtyDelivered` field, and call super with the remaining
            records.
     */
    @api.depends('qtyDeliveredMethod', 'qtyDeliveredManual', 'analyticLineIds.soLine', 'analyticLineIds.unitAmount', 'analyticLineIds.productUomId')
    async _computeQtyDelivered() {
        // compute for analytic lines
        const linesByAnalytic = await this.filtered(async (sol) => await sol.qtyDeliveredMethod === 'analytic');
        const mapping = await linesByAnalytic._getDeliveredQuantityByAnalytic([['amount', '<=', 0.0]]);
        for (const soLine of linesByAnalytic) {
            await soLine.set('qtyDelivered', mapping[bool(soLine.id) ? soLine.id : soLine._origin.id] ?? 0.0);
        }
        // compute for manual lines
        for (const line of this) {
            if (await line.qtyDeliveredMethod === 'manual') {
                await line.set('qtyDelivered', await line.qtyDeliveredManual || 0.0);
            }
        }
    }

    /**
     * Compute and write the delivered quantity of current SO lines, based on their related
            analytic lines.
            :param additional_domain: domain to restrict AAL to include in computation (required since timesheet is an AAL with a project ...)
     * @param additionalDomain 
     * @returns 
     */
    async _getDeliveredQuantityByAnalytic(additionalDomain) {
        const result = {}

        // avoid recomputation if no SO lines concerned
        if (!this.ok) {
            return result;
        }

        // group analytic lines by product uom and so line
        const domain = expression.AND([[['soLine', 'in', this.ids]], additionalDomain]);
        const data = await this.env.items('account.analytic.line').readGroup(
            domain,
            ['soLine', 'unitAmount', 'productUomId'], ['productUomId', 'soLine'], { lazy: false }
        );

        // convert uom and sum all unit_amount of analytic lines to get the delivered qty of SO lines
        // browse so lines and product uoms here to make them share the same prefetch
        const lines = this.browse(data.map(item => item['soLine'][0]));
        const linesMap = Object.fromEntries(map(lines, line => [line.id, line]));
        const productUomIds = data.filter(item => item['productUomId']).map(item => item['productUomId'][0]);
        const productUomMap = Object.fromEntries(map(this.env.items('uom.uom').browse(productUomIds), uom => [uom.id, uom]));
        for (const item of data) {
            if (!bool(item['productUomId'])) {
                continue;
            }
            const soLineId = item['soLine'][0];
            const soLine = linesMap[soLineId];
            setdefault(result, soLineId, 0.0);
            const uom = productUomMap[item['productUomId'][0]];
            let qty;
            if ((await (await soLine.productUom).categoryId).eq(await uom.categoryId)) {
                qty = await uom._computeQuantity(item['unitAmount'], await soLine.productUom, { roundingMethod: 'HALF-UP' });
            }
            else {
                qty = item['unitAmount'];
            }
            result[soLineId] += qty;
        }
        return result;
    }

    /**
     * When writing on qty_delivered, if the value should be modify manually (`qty_delivered_method` = 'manual' only),
            then we put the value in `qty_delivered_manual`. Otherwise, `qty_delivered_manual` should be False since the
            delivered qty is automatically compute by other mecanisms.
     * @returns 
     */
    @api.onchange('qtyDelivered')
    async _inverseQtyDelivered() {
        for (const line of this) {
            if (await line.qtyDeliveredMethod === 'manual') {
                await line.set('qtyDeliveredManual', await line.qtyDelivered);
            }
            else {
                await line.set('qtyDeliveredManual', 0.0);
            }
        }
    }

    @api.onchange('productId', 'productUomQty', 'productUom')
    async _onchangeSuggestPackaging() {
        // remove packaging if not match the product
        if ((await (await this['productPackagingId']).productId).ne(await this['productId'])) {
            await this.set('productPackagingId', false);
        }
        // suggest biggest suitable packaging
        if ((await this['productId']).ok && await this['productUomQty'] && await this['productUom']) {
            const productPackaging = await (await (await (await this['productId']).packagingIds).filtered('sales'))._findSuitableProductPackaging(await this['productUomQty'], await this['productUom']);
            await this.set('productPackagingId', productPackaging.ok ? productPackaging : await this['productPackagingId']);
        }
    }

    @api.onchange('productPackagingId')
    async _onchangeProductPackagingId() {
        const [productPackaging, productUomQty, productUom] = await this('productPackagingId', 'productUomQty', 'productUom');
        if (productPackaging.ok && productUomQty) {
            const newqty = await productPackaging._checkQty(productUomQty, productUom, "UP");
            if (floatCompare(newqty, productUomQty, { precisionRounding: await productUom.rounding }) != 0) {
                return {
                    'warning': {
                        'title': await this._t('Warning'),
                        'message': _f(await this._t(
                            "This product is packaged by {packSize} {packName}. You should sell {quantity)} {unit}."), {
                            packSize: (await productPackaging.qty).toFixed(2),
                            packName: await (await (await this['productId']).uomId).label,
                            quantity: newqty.toFixed(2),
                            unit: await productUom.label
                        }),
                    },
                }
            }
        }
    }

    @api.onchange('productPackagingId', 'productUom', 'productUomQty')
    async _onchangeUpdateProductPackagingQty() {
        const productPackaging = await this['productPackagingId'];
        if (!productPackaging.ok) {
            await this.set('productPackagingQty', false);
        }
        else {
            const packagingUom = await productPackaging.productUomId;
            const packagingUomQty = await (await this['productUom'])._computeQuantity(await this['productUomQty'], packagingUom);
            await this.set('productPackagingQty', floatRound(packagingUomQty / await productPackaging.qty, { precisionRounding: packagingUom.rounding }));
        }
    }

    @api.onchange('productPackagingQty')
    async _onchangeProductPackagingQty() {
        const productPackaging = await this['productPackagingId'];
        if (productPackaging.ok) {
            const packagingUom = await productPackaging.productUomId;
            const qtyPerPackaging = await productPackaging.qty;
            const productUomQty = await packagingUom._computeQuantity(await this['productPackagingQty'] * qtyPerPackaging, await this['productUom']);
            if (floatCompare(productUomQty, await this['productUomQty'], { precisionRounding: await (await this['productUom']).rounding }) != 0) {
                await this.set('productUomQty', productUomQty);
            }
        }
    }

    /**
     * Compute the untaxed amount already invoiced from the sale order line, taking the refund attached
            the so line into account. This amount is computed as
                SUM(invLine.priceSubtotal) - SUM(refLine.priceSubtotal)
            where
                `invLine` is a customer invoice line linked to the SO line
                `refLine` is a customer credit note (refund) line linked to the SO line
     */
    @api.depends('invoiceLines', 'invoiceLines.priceTotal', 'invoiceLines.moveId.state', 'invoiceLines.moveId.moveType')
    async _computeUntaxedAmountInvoiced() {
        for (const line of this) {
            let amountInvoiced = 0.0;
            for (const invoiceLine of await line._getInvoiceLines()) {
                const move = await invoiceLine.moveId;
                if (await move.state === 'posted') {
                    const invoiceDate = await move.invoiceDate || _Date.today();
                    if (await move.moveType == 'outInvoice') {
                        amountInvoiced += await (await invoiceLine.currencyId)._convert(await invoiceLine.priceSubtotal, await line.currencyId, await line.companyId, invoiceDate);
                    }
                    else if (await move.moveType === 'outRefund') {
                        amountInvoiced -= await (await invoiceLine.currencyId)._convert(await invoiceLine.priceSubtotal, await line.currencyId, await line.companyId, invoiceDate);
                    }
                }
            }
            await line.set('untaxedAmountInvoiced', amountInvoiced);
        }
    }

    /**
     * Total of remaining amount to invoice on the sale order line (taxes excl.) as
                totalSol - amount already invoiced
            where Total_sol depends on the invoice policy of the product.

            Note: Draft invoice are ignored on purpose, the 'to invoice' amount should
            come only from the SO lines.
     */
    @api.depends('state', 'priceReduce', 'productId', 'untaxedAmountInvoiced', 'qtyDelivered', 'productUomQty')
    async _computeUntaxedAmountToInvoice() {
        for (const line of this) {
            let amountToInvoice = 0.0;
            if (['sale', 'done'].includes(await line.state)) {
                // Note: do not use priceSubtotal field as it returns zero when the ordered quantity is
                // zero. It causes problem for expense line (e.i.: ordered qty = 0, deli qty = 4,
                // priceUnit = 20 ; subtotal is zero), but when you can invoice the line, you see an
                // amount and not zero. Since we compute untaxed amount, we can use directly the price
                // reduce (to include discount) without using `compute_all()` method on taxes.
                let priceSubtotal = 0.0;
                const uomQtyToConsider = await (await line.productId).invoicePolicy === 'delivery' ? await line.qtyDelivered : await line.productUomQty;
                const priceReduce = await line.priceUnit * (1 - (await line.discount || 0.0) / 100.0);
                priceSubtotal = priceReduce * uomQtyToConsider;
                if (len(await (await line.taxId).filtered(tax => tax.priceInclude)) > 0) {
                    // As included taxes are not excluded from the computed subtotal, `compute_all()` method
                    // has to be called to retrieve the subtotal without them.
                    // `price_reduce_taxexcl` cannot be used as it is computed from `priceSubtotal` field. (see upper Note)
                    priceSubtotal = (await (await line.taxId).computeAll(priceReduce, {
                        currency: await (await line.orderId).currencyId,
                        quantity: uomQtyToConsider,
                        product: await line.productId,
                        partner: await (await line.orderId).partnerShippingId
                    }))['totalExcluded'];
                }
                const invLines = await line._getInvoiceLines();
                if (some(await invLines.mapped(async (l) => await l.discount != await line.discount))) {
                    // In case of re-invoicing with different discount we try to calculate manually the
                    // remaining amount to invoice
                    let amount = 0;
                
                    for (const l of invLines) {
                        if (len(await (await l.taxIds).filtered(tax => tax.priceInclude)) > 0) {
                            amount += (await (await l.taxIds).computeAll(await (await l.currencyId)._convert(await l.priceUnit, await line.currencyId, await line.companyId, await l.date || _Date.today(), {round: false}) * await l.quantity))['totalExcluded'];
                        }
                        else {
                            amount += await (await l.currencyId)._convert(await l.priceUnit, await line.currencyId, await line.companyId, await l.date || _Date.today(), {round: false}) * await l.quantity;
                        }
                    }
                    amountToInvoice = Math.max(priceSubtotal - amount, 0);
                }
                else {
                    amountToInvoice = priceSubtotal - await line.untaxedAmountInvoiced;
                }
            }
            await line.set('untaxedAmountToInvoice', amountToInvoice);
        }
    }

    @api.depends('productId', 'orderId.dateOrder', 'orderId.partnerId')
    async _computeAnalyticTagIds() {
        for (const line of this) {
            if (! await line.displayType && await line.state === 'draft') {
                const defaultAnalyticAccount = await (await line.env.items('account.analytic.default').sudo()).accountGet({
                    productId: (await line.productId).id,
                    partnerId: (await (await line.orderId).partnerId).id,
                    userId: this.env.uid,
                    date: await (await line.orderId).dateOrder,
                    companyId: (await line.companyId).id,
                });
                await line.set('analyticTagIds', await defaultAnalyticAccount.analyticTagIds);
            }
        }
    }

    async computeUomQty(newQty, stockMove, rounding=true) {
        return await (await this['productUom'])._computeQuantity(newQty, await stockMove.productUom, rounding);
    }

    /**
     * Method intended to be overridden in third-party module if we want to prevent the resequencing
        of invoice lines.

        :param int newValue:   the new line sequence
        :param int oldValue:   the old line sequence

        :return:          the sequence of the SO line, by default the new one.
     * @param newValue 
     * @param oldValue 
     * @returns 
     */
    async _getInvoiceLineSequence(newValue=0, oldValue=0) {
        return newValue || oldValue;
    }

    /**
     * Prepare the dict of values to create the new invoice line for a sales order line.

        :param qty: float quantity to invoice
        :param options: any parameter that should be added to the returned invoice line
     * @param options 
     * @returns 
     */
    async _prepareInvoiceLine(options) {
        this.ensureOne();
        const self: any = this;
        const displayType = await self.displayType;
        const res = {
            'displayType': displayType,
            'sequence': await self.sequence,
            'label': await self.label,
            'productId': (await self.productId).id,
            'productUomId': (await self.productUom).id,
            'quantity': await self.qtyToInvoice,
            'discount': await self.discount,
            'priceUnit': await self.priceUnit,
            'taxIds': [[6, 0, (await self.taxId).ids]],
            'saleLineIds': [[4, self.id]],
        }
        if ((await (await self.orderId).analyticAccountId).ok && !displayType) {
            res['analyticAccountId'] = (await (await self.orderId).analyticAccountId).id;
        }
        if ((await self.analyticTagIds).ok && !displayType) {
            res['analyticTagIds'] = [[6, 0, (await self.analyticTagIds).ids]];
        }
        if (bool(options)) {
            update(res, options);
        }
        if (displayType) {
            res['accountId'] = false;
        }
        return res;
    }

    /**
     * Prepare specific key for moves or other components that will be created from a stock rule
        comming from a sale order line. This method could be override in order to add other custom key that could
        be used in move/po creation.
     */
    async _prepareProcurementValues(groupId=false) {
        return {}
    }

    async _getDisplayPrice(product) {
        // TO DO: move me in master/saas-16 on sale.order
        // awa: don't know if it's still the case since we need the "product_no_variant_attribute_value_ids" field now
        // to be able to compute the full price

        // it is possible that a noVariant attribute is still in a variant if
        // the type of the attribute has been changed after creation.
        const noVariantAttributesPriceExtra = await (await (await this['productNoVariantAttributeValueIds']).filtered(
            async (ptav) =>
                await ptav.priceExtra &&
                !(await product.productTemplateAttributeValueIds).includes(ptav)
        )).map(ptav => ptav.priceExtra);
        
        if (bool(noVariantAttributesPriceExtra)) {
            product = await product.withContext({noVariantAttributesPriceExtra});
        }

        const order = await this['orderId'];
        const pricelist = await order.pricelistId;
        if (await pricelist.discountPolicy === 'withDiscount') {
            return (await product.withContext({pricelist: pricelist.id, uom: (await this['productUom']).id})).price;
        }
        const productContext = Object.assign({}, this.env.context, {partnerId: (await order.partnerId).id, date: await order.dateOrder, uom: (await this['productUom']).id});

        const [finalPrice, ruleId] = await (await pricelist.withContext(productContext)).getProductPriceRule(product.ok ? product : await this['productId'], await this['productUomQty'] || 1.0, await order.partnerId);
        let [basePrice, currency] = await (await this.withContext(productContext))._getRealPriceCurrency(product, ruleId, await this['productUomQty'], await this['productUom'], pricelist.id);
        if (currency.ne(await pricelist.currencyId)) {
            basePrice = await currency._convert(basePrice, await pricelist.currencyId, (await order.companyId).ok ? await order.companyId : await this.env.company(), await order.dateOrder || _Date.today());
        }
        // negative discounts (= surcharge) are included in the display price
        return Math.max(basePrice, finalPrice);
    }

    @api.onchange('productId')
    async productIdChange() {
        const product = await this['productId'];
        if (!product.ok) {
            return;
        }

        if (! await this['productUom'] || ((await product.uomId).id != (await this['productUom']).id)) {
            await this.update({
                'productUom': await product.uomId,
                'productUomQty': await this['productUomQty'] || 1.0
            });
        }

        await this._updateDescription();
        await this._updateTaxes();

        if (product.ok && await product.saleLineWarn !== 'no-message') {
            if (await product.saleLineWarn === 'block') {
                await this.set('productId', false);
            }
            return {
                'warning': {
                    'title': await this._t("Warning for %s", await product.label),
                    'message': await product.saleLineWarnMsg,
                }
            }
        }
    }

    async _updateDescription() {
        let product = await this['productId'];
        if (! product.ok) {
            return;
        }

        const validValues = await (await (await product.productTemplateId).validProductTemplateAttributeLineIds).productTemplateValueIds;
        // remove the is_custom values that don't belong to this template
        for (const pacv of await this['productCustomAttributeValueIds']) {
            if (!validValues.includes(await pacv.customProductTemplateAttributeValueId)) {
                await this.set('productCustomAttributeValueIds', (await this['productCustomAttributeValueIds']).sub(pacv));
            }
        }

        // remove the noVariant attributes that don't belong to this template
        for (const ptav of await this['productNoVariantAttributeValueIds']) {
            if (!validValues.includes(ptav._origin)) {
                await this.set('productNoVariantAttributeValueIds', (await this['productNoVariantAttributeValueIds']).sub(ptav));
            }
        }

        const lang = await (await getLang(this.env, await (await (await this['orderId']).partnerId).lang)).code;
        product = await (await this['productId']).withContext({lang});
        await this.update({
            'label': await (await this.withContext({lang})).getSaleOrderLineMultilineDescriptionSale(product)
        });
    }

    async _updateTaxes() {
        let product = await this['productId'];
        if (! product.ok) {
            return;
        }

        await this._computeTaxId();

        const order = await this['orderId'];
        if ((await order.pricelistId).ok && (await order.partnerId).ok) {
            product = await product.withContext({
                partner: await order.partnerId,
                quantity: await this['productUomQty'],
                date: await order.dateOrder,
                pricelist: (await order.pricelistId).id,
                uom: (await this['productUom']).id
            });
            await this.update({
                'priceUnit': await product._getTaxIncludedUnitPrice(
                    await this['companyId'],
                    await order.currencyId,
                    await order.dateOrder,
                    'sale',
                    {fiscalPosition: await order.fiscalPositionId,
                    productPriceUnit: await this._getDisplayPrice(product),
                    productCurrency: await order.currencyId}
                )
            })
        }
    }

    @api.onchange('productUom', 'productUomQty')
    async productUomChange() {
        let [productUom, product] = await this('productUom', 'productId');
        if (! productUom.ok || ! product.ok) {
            await this.set('priceUnit', 0.0);
            return;
        }
        const [order, company] = await this('orderId', 'companyId');
        if ((await order.pricelistId).ok && (await order.partnerId).ok) {
            product = await product.withContext({
                lang: await (await order.partnerId).lang,
                partner: await order.partnerId,
                quantity: await this['productUomQty'],
                date: await order.dateOrder,
                pricelist: (await order.pricelistId).id,
                uom: productUom.id,
                fiscalPosition: this.env.context['fiscalPosition']
            });
            await this.set('priceUnit', await product._getTaxIncludedUnitPrice(
                company.ok ? company : await order.companyId,
                await order.currencyId,
                await order.dateOrder,
                'sale',
                {fiscalPosition: await order.fiscalPositionId,
                productPriceUnit: await this._getDisplayPrice(product),
                productCurrency: await order.currencyId}
            ));
        }
    }

    async nameGet() {
        const result = [];
        for (const soLine of await this.sudo()) {
            let name = f('%s - %s', await (await soLine.orderId).label, await soLine.label && (await soLine.label).split('\n')[0] || await (await soLine.productId).label);
            if (await (await soLine.orderPartnerId).ref) {
                name = f('%s (%s)', name, await (await soLine.orderPartnerId.ref));
            }
            result.push([soLine.id, name]);
        }
        return result;
    }

    @api.model()
    async _nameSearch(name, args?: any, operator = 'ilike', { limit = 100, nameGetUid = false } = {}) {
        if (['ilike', 'like', '=', '=like', '=ilike'].includes(operator)) {
            args = expression.AND([
                args || [],
                ['|', ['orderId.label', operator, name], ['label', operator, name]]
            ]);
            return this._search(args, {limit, accessRightsUid: nameGetUid});
        }
        return _super(SaleOrderLine, this)._nameSearch(name, args, operator, {limit, nameGetUid});
    }

    /**
     * Check wether a line can be deleted or not.

        Lines cannot be deleted if the order is confirmed; downpayment
        lines who have not yet been invoiced bypass that exception.
        Also, allow deleting UX lines (notes/sections).
        :rtype: recordset sale.order.line
        :returns: set of lines that cannot be deleted
     * @returns 
     */
    async _checkLineUnlink() {
        return this.filtered(async (line) => ['sale', 'done'].includes(await line.state) && (bool(await line.invoiceLines) || ! await line.isDownpayment) && ! await line.displayType);
    }

    @api.ondelete(false)
    async _unlinkExceptConfirmed() {
        if (await this._checkLineUnlink()) {
            throw new UserError(await this._t('You can not remove an order line once the sales order is confirmed.\nYou should rather set the quantity to 0.'));
        }
    }

    /**
     * Retrieve the price before applying the pricelist
            :param obj product: object of current product record
            :parem float qty: total quentity of product
            :param tuple price_and_rule: tuple(price, suitable_rule) coming from pricelist computation
            :param obj uom: unit of measure of current order line
            :param integer pricelistId: pricelist id of sales order
     * @param product 
     * @param ruleId 
     * @param qty 
     * @param uom 
     * @param pricelistId 
     */
    async _getRealPriceCurrency(product, ruleId, qty, uom, pricelistId) {
        const PricelistItem = this.env.items('product.pricelist.item');
        let fieldName = 'lstPrice';
        let currencyId;
        let productCurrency = await product.currencyId;
        if (bool(ruleId)) {
            let pricelistItem = PricelistItem.browse(ruleId);
            if (await (await pricelistItem.pricelistId).discountPolicy === 'withoutDiscount') {
                while (await pricelistItem.base === 'pricelist' && bool(await pricelistItem.basePricelistId) && await (await pricelistItem.basePricelistId).discountPolicy === 'withoutDiscount') {
                    [, ruleId] = await (await (await pricelistItem.basePricelistId).withContext({uom: uom.id})).getProductPriceRule(product, qty, await (await this['orderId']).partnerId);
                    pricelistItem = PricelistItem.browse(ruleId);
                }
            }

            if (await pricelistItem.base === 'standardPrice') {
                fieldName = 'standardPrice';
                productCurrency = await product.costCurrencyId;
            }
            else if (await pricelistItem.base === 'pricelist' && (await pricelistItem.basePricelistId).ok) {
                fieldName = 'price';
                product = await product.withContext({pricelist: (await pricelistItem.basePricelistId).id});
                productCurrency = await (await pricelistItem.basePricelistId).currencyId;
            }
            currencyId = await (await pricelistItem.pricelistId).currencyId;
        }

        let curFactor;
        if (! bool(currencyId)) {
            currencyId = productCurrency;
            curFactor = 1.0;
        }
        else {
            if (currencyId.id == productCurrency.id) {
                curFactor = 1.0;
            }
            else {
                const company = await this['companyId'];
                curFactor = await currencyId._getConversionRate(productCurrency, currencyId, company.ok ? company : await this.env.company(), await (await this['orderId']).dateOrder || _Date.today());
            }
        }
        
        const productUom = this.env.context['uom'] || (await product.uomId).id;
        let uomFactor;
        if (bool(uom) && uom.id != productUom) {
            // the unit price is in a different uom
            uomFactor = await uom._computePrice(1.0, await product.uomId);
        }
        else {
            uomFactor = 1.0;
        }
        return [await product[fieldName] * uomFactor * curFactor, currencyId];
    }

    async _getProtectedFields() {
        return [
            'productId', 'label', 'priceUnit', 'productUom', 'productUomQty',
            'taxId', 'analyticTagIds'
        ]
    }

    async _onchangeProductIdSetCustomerLead() {
        // pass
    }

    @api.onchange('productId', 'priceUnit', 'productUom', 'productUomQty', 'taxId')
    async _onchangeDiscount() {
        const self: any = this;
        let [order, product] = await self('orderId', 'productId');
        if (!(product.ok && (await self.productUom).ok &&
                (await order.partnerId).ok && (await order.pricelistId).ok &&
                await (await order.pricelistId).discountPolicy === 'withoutDiscount' &&
                await (await self.env.user()).hasGroup('product.groupDiscountPerSoLine'))) {
            return;
        }

        const pricelist = await order.pricelistId;
        await self.set('discount', 0.0);
        const newProduct = await product.withContext({
            lang: await (await order.partnerId).lang,
            partner: await order.partnerId,
            quantity: await self.productUomQty,
            date: await order.dateOrder,
            pricelist: pricelist.id,
            uom: (await self.productUom).id,
            fiscalPosition: self.env.context['fiscalPosition']
        });

        const productContext = Object.assign({}, self.env.context, {partnerId: (await order.partnerId).id, date: await order.dateOrder, uom: (await self.productUom).id});

        const [price, ruleId] = await (await pricelist.withContext(productContext)).getProductPriceRule(product, await self.productUomQty || 1.0, await order.partnerId);
        let [newListPrice, currency] = await (await self.withContext(productContext))._getRealPriceCurrency(product, ruleId, await self.productUomQty, await self.productUom, pricelist.id);

        if (newListPrice !== 0) {
            if ((await pricelist.currencyId).ne(currency)) {
                // we need new_list_price in the same currency as price, which is in the SO's pricelist's currency
                newListPrice = await currency._convert(
                    newListPrice, await pricelist.currencyId,
                    bool(await order.companyId) ? await order.companyId : await self.env.company(), await order.dateOrder || _Date.today());
            }
            const discount = (newListPrice - price) / newListPrice * 100;
            if ((discount > 0 && newListPrice > 0) || (discount < 0 && newListPrice < 0)) {
                await self.set('discount', discount);
            }
        }
    }

    async _isDelivery() {
        this.ensureOne();
        return false;
    }

    /**
     * Compute a default multiline description for this sales order line.

        In most cases the product description is enough but sometimes we need to append information that only
        exists on the sale order line itself.
        e.g:
        - custom attributes and attributes that don't create variants, both introduced by the "product configurator"
        - in event_sale we need to know specifically the sales order line as well as the product to generate the name:
          the product is not sufficient because we also need to know the event_id and the event_ticket_id (both which belong to the sale order line).
     */
    async getSaleOrderLineMultilineDescriptionSale(product) {
        return await product.getProductMultilineDescriptionSale() + await this._getSaleOrderLineMultilineDescriptionVariants();
    }

    /**
     * When using noVariant attributes or is_custom values, the product
        itself is not sufficient to create the description: we need to add
        information about those special attributes and values.

        :return: the description related to special variant attributes/values
        :rtype: string
     * @returns 
     */
    async _getSaleOrderLineMultilineDescriptionVariants() {
        const [productCustomAttributeValueIds, productNoVariantAttributeValueIds] = await this('productCustomAttributeValueIds', 'productNoVariantAttributeValueIds'); 
        if (! productCustomAttributeValueIds.ok && ! productNoVariantAttributeValueIds.ok) {
            return "";
        }

        let name = "\n";

        const customPtavs = await productCustomAttributeValueIds.customProductTemplateAttributeValueId;
        const noVariantPtavs = productNoVariantAttributeValueIds._origin;

        // display the noVariant attributes, except those that are also
        // displayed by a custom (avoid duplicate description)
        for (const ptav of noVariantPtavs.sub(customPtavs)) {
            name += "\n" + await ptav.displayName;
        }

        // Sort the values according to _order settings, because it doesn't work for virtual records in onchange
        const customValues = await productCustomAttributeValueIds.sorted(async (r) => [(await r.customProductTemplateAttributeValueId).id, r.id]);
        // display the is_custom values
        for (const pacv of customValues) {
            name += "\n" + await pacv.displayName;
        }
        return name;
    }

    async _isNotSellableLine() {
        // True if the line is a computed line (reward, delivery, ...) that user cannot add manually
        return false;
    }
}