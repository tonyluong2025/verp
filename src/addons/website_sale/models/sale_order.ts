import { _Date, _Datetime, api, Fields } from "../../../core";
import { setdefault } from "../../../core/api";
import { UserError } from "../../../core/helper";
import { _super, MetaModel, Model } from "../../../core/models"
import { expression } from "../../../core/osv";
import { bool, extend, len, parseInt, sample, subDate, sum, update } from "../../../core/tools";

@MetaModel.define()
class SaleOrder extends Model {
    static _module = module;
    static _parents = "sale.order";

    static websiteOrderLine = Fields.One2many(
        'sale.order.line',
        {compute: '_computeWebsiteOrderLine',
        string: 'Order Lines displayed on Website',
        help: 'Order Lines to be displayed on the website. They should not be used for computation purpose.',
    });
    static cartQuantity = Fields.Integer({compute: '_computeCartInfo', string: 'Cart Quantity'});
    static onlyServices = Fields.Boolean({compute: '_computeCartInfo', string: 'Only Services'});
    static isAbandonedCart = Fields.Boolean('Abandoned Cart', {compute: '_computeAbandonedCart', search: '_searchAbandonedCart'});
    static cartRecoveryEmailSent = Fields.Boolean('Cart recovery email already sent');
    static websiteId = Fields.Many2one('website', {string: 'Website', readonly: true,
                                 help: 'Website through which this order was placed.'});

    @api.model()
    async _defaultNoteUrl() {
        const websiteId = this._context['websiteId'];
        if (websiteId) {
            return this.env.items('website').browse(websiteId).getBaseUrl();
        }
        return _super(SaleOrder, this)._defaultNoteUrl();
    }

    @api.depends('orderLine')
    async _computeWebsiteOrderLine() {
        for (const order of this) {
            await order.set('websiteOrderLine', await order.orderLine);
        }
    }

    @api.depends('orderLine.productUomQty', 'orderLine.productId')
    async _computeCartInfo() {
        for (const order of this) {
            await order.set('cartQuantity', parseInt(sum(await order.mapped('websiteOrderLine.productUomQty'))));
            await order.set('onlyServices', await (await order.websiteOrderLine).every(async (l) => await (await l.productId).type === 'service'));
        }
    }

    @api.depends('websiteId', 'dateOrder', 'orderLine', 'state', 'partnerId')
    async _computeAbandonedCart() {
        for (const order of this) {
            // a quotation can be considered as an abandonned cart if it is linked to a website,
            // is in the 'draft' state and has an expiration date
            if ((await order.websiteId).ok && await order.state === 'draft' && await order.dateOrder) {
                const publicPartnerId = await (await (await order.websiteId).userId).partnerId;
                // by default the expiration date is 1 hour if not specified on the website configuration
                const abandonedDelay = await (await order.websiteId).cartAbandonedDelay || 1.0;
                const abandonedDatetime = subDate(new Date(), {hours: abandonedDelay});
                await order.set('isAbandonedCart', bool(await order.dateOrder <= abandonedDatetime && (await order.partnerId).ne(publicPartnerId) && await order.orderLine));
            }
            else {
                await order.set('isAbandonedCart', false);
            }
        }
    }

    async _searchAbandonedCart(operator, value) {
        const websiteIds = await this.env.items('website').searchRead({fields: ['id', 'cartAbandonedDelay', 'partnerId']});
        const deadlines = websiteIds.map(websiteId => [
            '&', '&',
            ['websiteId', '=', websiteId['id']],
            ['dateOrder', '<=', _Datetime.toString(subDate(new Date(), {hours: websiteId['cartAbandonedDelay'] || 1.0}))],
            ['partnerId', '!=', websiteId['partnerId'][0]]
        ]);
        let abandonedDomain: any[] = [
            ['state', '=', 'draft'],
            ['orderLine', '!=', false]
        ];
        extend(abandonedDomain, expression.OR(deadlines));
        abandonedDomain = expression.normalizeDomain(abandonedDomain);
        // is_abandoned domain possibilities
        if ((!expression.NEGATIVE_TERM_OPERATORS.includes(operator) && value) || (expression.NEGATIVE_TERM_OPERATORS.includes(operator) && ! value)) {
            return abandonedDomain;
        }
        return expression.distributeNot(['!'].concat(abandonedDomain));  // negative domain
    }

    /**
     * Find the cart line matching the given parameters.

        If a productId is given, the line will match the product only if the
        line also has the same special attributes: `noVariant` attributes and
        `is_custom` values.
     * @param productId 
     * @param lineId 
     * @returns 
     */
    async _cartFindProductLine(productId?: any, opts: {lineId?: any}={}) {
        this.ensureOne();
        const product = this.env.items('product.product').browse(productId);

        // split lines with the same product if it has untracked attributes
        if (product.ok && (await (await product.productTemplateId).hasDynamicAttributes() || await (await product.productTemplateId)._hasNoVariantAttributes()) && !opts.lineId && ! (opts['forceSearch'] ?? false)) {
            return this.env.items('sale.order.line');
        }

        let domain = [['orderId', '=', this.id], ['productId', '=', productId]];
        if (opts.lineId) {
            domain = domain.concat([['id', '=', opts.lineId]]);;
        }
        else {
            domain = domain.concat([['productCustomAttributeValueIds', '=', false]]);
        }

        return (await this.env.items('sale.order.line').sudo()).search(domain);
    }

    async _websiteProductIdChange(opts: {req?: any, orderId?: any, productId?: any, qty?: number}={}) {
        const qty = opts.qty ?? 0;
        const order = (await this.sudo()).browse(opts.orderId);
        const productContext = Object.assign({}, this.env.context);
        setdefault(productContext, 'lang', await (await order.partnerId).lang);
        update(productContext, {
            'partner': await order.partnerId,
            'quantity': qty,
            'date': await order.dateOrder,
            'pricelist': (await order.pricelistId).id,
        });
        const product = (await (await this.env.items('product.product').withContext(productContext)).withCompany((await order.companyId).id)).browse(opts.productId);
        let discount = 0;
        let pu, currency;
        if (await (await order.pricelistId).discountPolicy === 'withoutDiscount') {
            // This part is pretty much a copy-paste of the method '_onchange_discount' of
            // 'sale.order.line'.
            let [price, ruleId] = await (await (await order.pricelistId).withContext(productContext)).getProductPriceRule(product, qty || 1.0, await order.partnerId);
            [pu, currency] = await (await (await opts.req.getEnv()).items('sale.order.line').withContext(productContext))._getRealPriceCurrency(product, ruleId, qty, await product.uomId, (await order.pricelistId).id);
            if ((await order.pricelistId).ok && (await order.partnerId).ok) {
                const orderLine = await order._cartFindProductLine(product.id);
                if (bool(orderLine)) {
                    price = await product._getTaxIncludedUnitPrice(
                        await this['companyId'],
                        await order.currencyId,
                        await order.dateOrder,
                        'sale',
                        {fiscalPosition: await order.fiscalPositionId,
                        productPriceUnit: price,
                        productCurrency: await order.currencyId
                    });
                    pu = await product._getTaxIncludedUnitPrice(
                        await this['companyId'],
                        await order.currencyId,
                        await order.dateOrder,
                        'sale',
                        {fiscalPosition: await order.fiscalPositionId,
                        productPriceUnit: pu,
                        productCurrency: await order.currencyId
                    });
                }
            }
            if (pu != 0) {
                if ((await (await order.pricelistId).currencyId).ne(currency)) {
                    // we need new_list_price in the same currency as price, which is in the SO's pricelist's currency
                    const date = await order.dateOrder || _Date.today();
                    pu = await currency._convert(pu, await (await order.pricelistId).currencyId, await order.companyId, date);
                }
                discount = (pu - price) / pu * 100;
                if (discount < 0) {
                    // In case the discount is negative, we don't want to show it to the customer,
                    // but we still want to use the price defined on the pricelist
                    discount = 0;
                    pu = price;
                }
            }
            else {
                // In case the priceUnit equal 0 and therefore not able to calculate the discount,
                // we fallback on the price defined on the pricelist.
                pu = price;
            }
        }
        else {
            pu = await product.price;
            if ((await order.pricelistId).ok && (await order.partnerId).ok) {
                const orderLine = await order._cartFindProductLine(product.id, {forceSearch: true});
                if (bool(orderLine)) {
                    pu = await product._getTaxIncludedUnitPrice(
                        await this['companyId'],
                        await order.currencyId,
                        await order.dateOrder,
                        'sale',
                        {fiscalPosition: await order.fiscalPositionId,
                        productPriceUnit: await product.price,
                        productCurrency: await order.currencyId
                    });
                }
            }
        }

        return {
            'productId': opts.productId,
            'productUomQty': qty,
            'orderId': opts.orderId,
            'productUom': (await product.uomId).id,
            'priceUnit': pu,
            'discount': discount,
        }
    }

    /**
     * Add or set product quantity, addQty can be negative
     * @param productId 
     * @param lineId 
     * @param addQty 
     * @param setQty 
     */
    async _cartUpdate(opts: {req?: any, productId?: any, lineId?: any, addQty?: number, setQty?: number}={}) {
        this.ensureOne();
        const productContext = Object.assign({}, this.env.context);
        setdefault(productContext, 'lang', await (await (await this.sudo()).partnerId).lang);
        const saleOrderLineSudo = await (await this.env.items('sale.order.line').sudo()).withContext(productContext);
        // change lang to get correct name of attributes/values
        const productWithContext = await this.env.items('product.product').withContext(productContext);
        let product = await productWithContext.browse(parseInt(opts.productId)).exists();

        if (! bool(product) || (! opts.lineId && ! await product._isAddToCartAllowed())) {
            throw new UserError(await this._t("The given product does not exist therefore it cannot be added to cart."));
        }
        let addQty = opts.addQty ?? 0;
        let setQty = opts.setQty ?? 0;
        try {
            if (addQty) {
                addQty = parseInt(addQty);
            }
        } catch(e) {
            // except ValueError:
            addQty = 1;
        }
        try {
            if (setQty) {
                setQty = parseInt(setQty);
            }
        } catch(e) {
            // except ValueError:
            setQty = 0;
        }
        let quantity = 0;
        let orderLine: any = false;
        if (await this['state'] !== 'draft') {
            opts.req.session['saleOrderId'] = null;
            throw new UserError(await this._t('It is forbidden to modify a sales order which is not in draft status.'));
        }
        if (opts.lineId) {
            orderLine = (await this._cartFindProductLine(opts.productId, opts)).slice(0, 1);
        }
        // Create line if no line with productId can be located
        if (!bool(orderLine)) {
            const noVariantAttributeValues = opts['noVariantAttributeValues'] || [];
            const receivedNoVariantValues = product.env.items('product.template.attribute.value').browse(noVariantAttributeValues.map(ptav => parseInt(ptav['value'])));
            const receivedCombination = (await product.productTemplateAttributeValueIds).or(receivedNoVariantValues);
            const productTemplate = await product.productTemplateId;

            // handle all cases where incorrect or incomplete data are received
            const combination = await productTemplate._getClosestPossibleCombination(receivedCombination);

            // get or create (if dynamic) the correct variant
            product = await productTemplate._createProductVariant(combination);

            if (!bool(product)) {
                throw new UserError(await this._t("The given combination does not exist therefore it cannot be added to cart."));
            }

            const productId = product.id;

            const values = await this._websiteProductIdChange({...opts, orderId: this.id, productId, qty: 1});

            // add noVariant attributes that were not received
            for (const ptav of await combination.filtered(async (ptav) => await (await ptav.attributeId).createVariant == 'noVariant' && !receivedNoVariantValues.includes(ptav))) {
                noVariantAttributeValues.push({'value': ptav.id});
            }

            // save noVariant attributes values
            if (noVariantAttributeValues.length) {
                values['productNoVariantAttributeValueIds'] = [
                    [6, 0, noVariantAttributeValues.map(attr => parseInt(attr['value']))]
                ];
            }

            // add is_custom attribute values that were not received
            const customValues = opts['productCustomAttributeValues'] || [];
            const receivedCustomValues = product.env.items('product.template.attribute.value').browse(customValues.map(ptav => parseInt(ptav['customProductTemplateAttributeValueId'])));

            for (const ptav of await combination.filtered(async (ptav) => await ptav.isCustom && !receivedCustomValues.includes(ptav))) {
                customValues.push({
                    'customProductTemplateAttributeValueId': ptav.id,
                    'customValue': '',
                });
            }

            // save isCustom attributes values
            if (customValues.length) {
                values['productCustomAttributeValueIds'] = customValues.map(customValue => [0, 0, {
                    'customProductTemplateAttributeValueId': customValue['customProductTemplateAttributeValueId'],
                    'customValue': customValue['customValue']
                }]);
            }

            // create the line
            orderLine = await saleOrderLineSudo.create(values);

            try {
                await orderLine._computeTaxId();
            } catch(e) {
            // except ValidationError as e:
                // The validation may occur in backend (eg: taxcloud) but should fail silently in frontend
                console.debug("ValidationError occurs during tax compute. %s", e);
            }
            if (addQty) {
                addQty -= 1;
            }
        }
        // compute new quantity
        if (setQty) {
            quantity = setQty;
        }
        else if (addQty != null) {
            quantity = await orderLine.productUomQty + (addQty || 0);
        }
        // Remove zero of negative lines
        if (quantity <= 0) {
            const linkedLine = await orderLine.linkedLineId;
            await orderLine.unlink();
            if (linkedLine.ok) {
                // update description of the parent
                const linkedProduct = productWithContext.browse((await linkedLine.productId).id);
                await linkedLine.set('label', await linkedLine.getSaleOrderLineMultilineDescriptionSale(linkedProduct));
            }
        }
        else {
            // update line
            const noVariantAttributesPriceExtra = await (await orderLine.productNoVariantAttributeValueIds).map(ptav => ptav.priceExtra);
            const values = await (await this.withContext({noVariantAttributesPriceExtra: Array.from(noVariantAttributesPriceExtra)}))._websiteProductIdChange({...opts, orderId: this.id, qty: quantity});
            const order = (await this.sudo()).browse(this.id);
            if (await (await this['pricelistId']).discountPolicy == 'with_discount' && ! this.env.context['fixedPrice']) {
                update(productContext, {
                    'partner': await order.partnerId,
                    'quantity': quantity,
                    'date': await order.dateOrder,
                    'pricelist': (await order.pricelistId).id,
                });
            }
            const productWithContext = await (await this.env.items('product.product').withContext(productContext)).withCompany((await order.companyId).id);
            product = productWithContext.browse(opts.productId);

            await orderLine.write(values);

            // link a product to the sales order
            if (opts['linkedLineId']) {
                const linkedLine = saleOrderLineSudo.browse(opts['linkedLineId']);
                await orderLine.write({
                    'linkedLineId': linkedLine.id,
                });
                const linkedProduct = productWithContext.browse((await linkedLine.productId).id);
                await linkedLine.set('label', await linkedLine.getSaleOrderLineMultilineDescriptionSale(linkedProduct));
            }
            // Generate the description with everything. This is done after
            // creating because the following related fields have to be set:
            // - productNoVariantAttributeValueIds
            // - productCustomAttributeValueIds
            // - linkedLineId
            await orderLine.set('label', await orderLine.getSaleOrderLineMultilineDescriptionSale(product));
        }
        const optionLines = await (await this['orderLine']).filtered(async (l) => (await l.linkedLineId).id == orderLine.id);

        return {'lineId': orderLine.id, 'quantity': quantity, 'optionIds': Array.from(new Set(optionLines.ids))}
    }

    /**
     * Suggest accessories based on 'Accessory Products' of products in cart
     * @returns 
     */
    async _cartAccessories() {
        for (const order of this) {
            const products = await (await order.websiteOrderLine).mapped('productId');
            let accessoryProducts = this.env.items('product.product');
            for (const line of await (await order.websiteOrderLine).filtered(l => l.productId)) {
                const combination = (await (await line.productId).productTemplateAttributeValueIds).add(await line.productNoVariantAttributeValueIds);
                accessoryProducts = accessoryProducts.or(await (await (await (await line.productId).productTemplateId)._getWebsiteAccessoryProduct()).filtered(async (product) =>
                    !products.includes(product) &&
                    await product._isVariantPossible(combination) &&
                    ((await product.companyId).eq(await line.companyId) || !(await product.companyId).ok)
                ));
            }

            return sample([...accessoryProducts], len(accessoryProducts));
        }
    }

    async actionRecoveryEmailSend() {
        for (const order of this) {
            await order._portalEnsureToken();
        }
        const composerFormViewId = (await this.env.ref('mail.emailComposeMessageWizardForm')).id;

        const templateId = (await this._getCartRecoveryTemplate()).id;

        return {
            'type': 'ir.actions.actwindow',
            'viewMode': 'form',
            'resModel': 'mail.compose.message',
            'viewId': composerFormViewId,
            'target': 'new',
            'context': {
                'default_compositionMode': len(this.ids) > 1 ? 'massMail' : 'comment',
                'default_resId': this.ids[0],
                'default_model': 'sale.order',
                'default_useTemplate': bool(templateId),
                'default_templateId': templateId,
                'websiteSaleSendRecoveryEmail': true,
                'activeIds': this.ids,
            },
        }
    }

    /**
     * Return the cart recovery template record for a set of orders.
        If they all belong to the same website, we return the website-specific template;
        otherwise we return the default template.
        If the default is not found, the empty ['mail.template'] is returned.
     * @returns 
     */
    async _getCartRecoveryTemplate() {
        const websites = await this.mapped('websiteId');
        let template = len(websites) == 1 ? await websites.cartRecoveryMailTemplateId : false;
        template = bool(template) ? template : await this.env.ref('website_sale.mailTemplateSaleCartRecovery', false);
        return bool(template) ? template : this.env.items('mail.template');
    }

    /**
     * Send the cart recovery email on the current recordset,
        making sure that the portal token exists to avoid broken links, and marking the email as sent.
        Similar method to action_recovery_email_send, made to be called in automated actions.
        Contrary to the former, it will use the website-specific template for each order.
     * @returns 
     */
    async _cartRecoveryEmailSend() {
        let sentOrders = this.env.items('sale.order');
        for (const order of this) {
            const template = await order._getCartRecoveryTemplate();
            if (bool(template)) {
                await order._portalEnsureToken();
                await template.sendMail(order.id);
                sentOrders = sentOrders.or(order);
            }
        }
        await sentOrders.write({'cartRecoveryEmailSent': true});
    }

    async actionConfirm() {
        const res = await _super(SaleOrder, this).actionConfirm();
        for (const order of this) {
            if (! (await order.transactionIds).ok && ! await order.amountTotal && this._context['sendEmail']) {
                await order._sendOrderConfirmationMail();
            }
        }
        return res;
    }
}

@MetaModel.define()
class SaleOrderLine extends Model {
    static _module = module;
    static _parents = "sale.order.line";

    static nameShort = Fields.Char({compute: "_computeNameShort"});

    static linkedLineId = Fields.Many2one('sale.order.line', {string: 'Linked Order Line', domain: "[['orderId', '=', orderId]]", ondelete: 'CASCADE', copy: false, index: true});
    static optionLineIds = Fields.One2many('sale.order.line', 'linkedLineId', {string: 'Options Linked'});

    async getSaleOrderLineMultilineDescriptionSale(product) {
        let description = await _super(SaleOrderLine, this).getSaleOrderLineMultilineDescriptionSale(product);
        if ((await this['linkedLineId']).ok) {
            description += "\n" + await this._t("Option for: %s", await (await (await this['linkedLineId']).productId).displayName);
        }
        if ((await this['optionLineIds']).ok) {
            description += "\n" + (await (await this['optionLineIds']).map(async (optLine) => this._t("Option: %s", await (await optLine.productId).displayName))).join('\n');
        }
        return description;
    }

    /**
     * Compute a short name for this sale order line, to be used on the website where we don't have much space.
            To keep it short, instead of using the first line of the description, we take the product name without the internal reference.
     * @returns 
     */
    @api.depends('productId.displayName')
    async _computeNameShort() {
        for (const record of this) {
            await record.set('nameShort', await (await (await record.productId).withContext({displayDefaultCode: false})).displayName);
        }
    }

    async getDescriptionFollowingLines() {
        return (await this['label']).split('\n').slice(1);
    }
}
