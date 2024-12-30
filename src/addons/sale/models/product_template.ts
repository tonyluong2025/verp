import { _Date, api, Fields } from "../../../core";
import { WARNING_HELP, WARNING_MESSAGE } from "../../../core/addons/base";
import { ValidationError } from "../../../core/helper";
import { _super, MetaModel, Model } from "../../../core/models"
import { bool, f, floatRound, nextAsync, setOptions, sum } from "../../../core/tools";

@MetaModel.define()
class ProductTemplate extends Model {
    static _module = module;
    static _parents = 'product.template';

    static serviceType = Fields.Selection([['manual', 'Manually set quantities on order']], {string: 'Track Service',
        help: "Manually set quantities on order: Invoice based on the manually entered quantity, without creating an analytic account.\n"+
             "Timesheets on contract: Invoice based on the tracked hours on the related timesheet.\n"+
             "Create a task and track hours: Create a task on the sales order validation and track the work hours.",
        default: 'manual'});
    static saleLineWarn = Fields.Selection(WARNING_MESSAGE, {string: 'Sales Order Line', help: WARNING_HELP, required: true, default: "no-message"});
    static saleLineWarnMsg = Fields.Text('Message for Sales Order Line');
    static expensePolicy = Fields.Selection(
        [['no', 'No'], ['cost', 'At cost'], ['salesPrice', 'Sales price']],
        {string: 'Re-Invoice Expenses',
        default: 'no',
        help: "Expenses and vendor bills can be re-invoiced to a customer."+
             "With this option, a validated expense can be re-invoice to a customer at its cost or sales price."});
    static visibleExpensePolicy = Fields.Boolean("Re-Invoice Policy visible", {compute: '_computeVisibleExpensePolicy'});
    static salesCount = Fields.Float({compute: '_computeSalesCount', string: 'Sold'});
    static visibleQtyConfigurator = Fields.Boolean("Quantity visible in configurator", {compute: '_computeVisibleQtyConfigurator'});
    static invoicePolicy = Fields.Selection([
        ['order', 'Ordered quantities'],
        ['delivery', 'Delivered quantities']], {string: 'Invoicing Policy',
        help: 'Ordered Quantity: Invoice quantities ordered by the customer.\n'+
             'Delivered Quantity: Invoice quantities delivered to the customer.',
        default: 'order'});

    async _computeVisibleQtyConfigurator() {
        for (const productTemplate of this) {
            await productTemplate.set('visibleQtyConfigurator', true);
        }
    }

    @api.depends('label')
    async _computeVisibleExpensePolicy() {
        const visibility = await this.userHasGroups('analytic.groupAnalyticAccounting');
        for (const productTemplate of this) {
            await productTemplate.set('visibleExpensePolicy', visibility);
        }
    }

    @api.onchange('saleOk')
    async _changeSaleOk() {
        if (! await this['saleOk']) {
            await this.set('expensePolicy', 'no');
        }
    }

    @api.depends('productVariantIds.salesCount')
    async _computeSalesCount() {
        for (const product of this) {
            await product.set('salesCount', floatRound(
                await (await (await product.withContext({activeTest: false})).productVariantIds).sum(p => p.salesCount),
                {precisionRounding: await (await product.uomId).rounding}
            ));
        }
    }

    /**
     * Ensure the product is not being restricted to a single company while
        having been sold in another one in the past, as this could cause issues.
     * @returns 
     */
    @api.constrains('companyId')
    async _checkSaleProductCompany() {
        const targetCompany = await this['companyId'];
        if (bool(targetCompany)) {  // don't prevent writing `False`, should always work
            const productData = await (await (await this.env.items('product.product').sudo()).withContext({activeTest: false})).searchRead([['productTemplateId', 'in', this.ids]], ['id']);
            const productIds = productData.map(p => p['id']);
            const soLines = await (await this.env.items('sale.order.line').sudo()).searchRead([['productId', 'in', productIds], ['companyId', '!=', targetCompany.id]], ['id', 'productId']);
            const usedProducts = soLines.map(sol => sol['productId'][1]);
            if (bool(soLines)) {
                throw new ValidationError(await this._t('The following products cannot be restricted to the company'+
                                        ' %s because they have already been used in quotations or '+
                                        'sales orders in another company:\n%s\n'+
                                        'You can archive these products and recreate them '+
                                        'with your company restriction instead, or leave them as '+
                                        'shared product.', await targetCompany.label, usedProducts.join(', ')));
            }
        }
    }

    async actionViewSales() {
        const action = await this.env.items("ir.actions.actions")._forXmlid("sale.reportAllChannelsSalesAction");
        action['domain'] = [['productTemplateId', 'in', this.ids]];
        action['context'] = {
            'pivotMeasures': ['productUomQty'],
            'activeId': this._context['activeId'],
            'activeModel': 'sale.report',
            'searchDefault_sales': 1,
            'searchDefault_filterOrderDate': 1,
        }
        return action;
    }

    /**
     * Create if necessary and possible and return the id of the product
        variant matching the given combination for this template.

        Note AWA: Known "exploit" issues with this method:

        - This method could be used by an unauthenticated user to generate a
            lot of useless variants. Unfortunately, after discussing the
            matter with ODO, there's no easy and user-friendly way to block
            that behavior.

            We would have to use captcha/server actions to clean/... that
            are all not user-friendly/overkill mechanisms.

        - This method could be used to try to guess what product variant ids
            are created in the system and what product template ids are
            configured as "dynamic", but that does not seem like a big deal.

        The error messages are identical on purpose to avoid giving too much
        information to a potential attacker:
            - returning 0 when failing
            - returning the variant id whether it already existed or not

        :param productTemplateAttributeValueIds: the combination for which
            to get or create variant
        :type productTemplateAttributeValueIds: json encoded list of id
            of `product.template.attribute.value`

        :return: id of the product variant matching the combination or 0
        :rtype: int
     * @param productTemplateAttributeValueIds 
     * @returns 
     */
    async createProductVariant(productTemplateAttributeValueIds) {
        const combination = this.env.items('product.template.attribute.value')
            .browse(JSON.parse(productTemplateAttributeValueIds));

        return (await (this as any)._createProductVariant(combination, true)).id || 0;
    }

    /**
     * Force values to stay consistent with integrity constraints
     * @returns 
     */
    @api.onchange('type')
    async _onchangeType() {
        const res = await _super(ProductTemplate, this)._onchangeType();
        if (await this['type'] === 'consu') {
            if (! await this['invoicePolicy']) {
                await this.set('invoicePolicy', 'order');
            }
            await this.set('serviceType', 'manual');
        }
        if (bool(this._origin) && await this['salesCount'] > 0) {
            res['warning'] = {
                'title': await this._t("Warning"),
                'message': await this._t("You cannot change the product's type because it is already used in sales orders.")
            }
        }
        return res;
    }

    @api.model()
    async getImportTemplates() {
        const res = await _super(ProductTemplate, this).getImportTemplates();
        if (this.env.context['saleMultiPricelistProductTemplate']) {
            if (await this.userHasGroups('product.groupSalePricelist')) {
                return [{
                    'label': await this._t('Import Template for Products'),
                    'template': '/product/static/xls/product_template.xls'
                }];
            }
        }
        return res;
    }

    /**
     * Return info about a given combination.

        Note: this method does not take into account whether the combination is
        actually possible.

        :param combination: recordset of `product.template.attribute.value`

        :param productId: id of a `product.product`. If no `combination`
            is set, the method will try to load the variant `productId` if
            it exists instead of finding a variant based on the combination.

            If there is no combination, that means we definitely want a
            variant and not something that will have noVariant set.

        :param add_qty: float with the quantity for which to get the info,
            indeed some pricelist rules might depend on it.

        :param pricelist: `product.pricelist` the pricelist to use
            (can be none, eg. from SO if no partner and no pricelist selected)

        :param parentCombination: if no combination and no productId are
            given, it will try to find the first possible combination, taking
            into account parentCombination (if set) for the exclusion rules.

        :param onlyTemplate: boolean, if set to True, get the info for the
            template only: ignore combination and don't try to find variant

        :return: dict with product/combination info:

            - productId: the variant id matching the combination (if it exists)

            - productTemplateId: the current template id

            - displayName: the name of the combination

            - price: the computed price of the combination, take the catalog
                price if no pricelist is given

            - listPrice: the catalog price of the combination, but this is
                not the "real" listPrice, it has priceExtra included (so
                it's actually more closely related to `lstPrice`), and it
                is converted to the pricelist currency (if given)

            - hasDiscountedPrice: True if the pricelist discount policy says
                the price does not include the discount and there is actually a
                discount applied (price < listPrice), else False
     * @param combination 
     * @param productId 
     * @param addQty 
     * @param pricelist 
     * @param parentCombination 
     * @param onlyTemplate 
     */
    async _getCombinationInfo(opts: {combination?: any, productId?: any, addQty?: any, pricelist?: any, parentCombination?: any, onlyTemplate?: any}={}) {
        this.ensureOne();
        // setOptions(opts, {combination: false, productId: false, addQty: 1, pricelist: false, parentCombination: false, onlyTemplate: false});
        let {combination = false, productId = false, addQty = 1, pricelist = false, parentCombination=false, onlyTemplate = false} = opts;
        // get the name before the change of context to benefit from prefetch
        let displayName = await this['displayName'];

        let displayImage = true;
        const quantity = this.env.context['quantity'] ?? addQty;
        const context = Object.assign({}, this.env.context, {quantity, pricelist: bool(pricelist) ? pricelist.id : false});
        let productTemplate = await this.withContext(context);

        combination = bool(combination) ? combination : productTemplate.env.items('product.template.attribute.value');

        if (! bool(productId) && ! bool(combination) && ! onlyTemplate) {
            combination = await productTemplate._getFirstPossibleCombination(parentCombination);
        }
        let product, price, priceExtra, listPrice;
        if (onlyTemplate) {
            product = productTemplate.env.items('product.product');
        }
        else if (bool(productId) && ! bool(combination)) {
            product = productTemplate.env.items('product.product').browse(productId);
        }
        else {
            product = await productTemplate._getVariantForCombination(combination);
        }
        if (bool(product)) {
            // We need to add the priceExtra for the attributes that are not
            // in the variant, typically those of type noVariant, but it is
            // possible that a noVariant attribute is still in a variant if
            // the type of the attribute has been changed after creation.
            const noVariantAttributesPriceExtra = await (await combination.filtered(
                    async (ptav) =>
                        await ptav.priceExtra &&
                        !(await product.productTemplateAttributeValueIds).includes(ptav)
                )).map(ptav => ptav.priceExtra);

            if (bool(noVariantAttributesPriceExtra)) {
                product = await product.withContext({noVariantAttributesPriceExtra});
            }
            const listPrice = (await product.priceCompute('listPrice'))[product.id];
            price = bool(pricelist) ? await product.price : listPrice;
            displayImage = bool(await product.image128);
            displayName = await product.displayName;
            priceExtra = (await product.priceExtra || 0.0 ) + (sum(noVariantAttributesPriceExtra) || 0.0);
        }
        else {
            const currentAttributesPriceExtra = await combination.map(async (v) => await v.priceExtra || 0.0);
            productTemplate = await productTemplate.withContext({currentAttributesPriceExtra});
            priceExtra = sum(currentAttributesPriceExtra);
            listPrice = (await productTemplate.priceCompute('listPrice'))[productTemplate.id];
            price = bool(pricelist) ? await productTemplate.price : listPrice;
            displayImage = bool(await productTemplate.image128);

            const combinationName = await combination._getCombinationName();
            if (combinationName) {
                displayName = f("%s (%s)", displayName, combinationName);
            }
        }
        if (bool(pricelist) && !(await pricelist.currencyId).eq(await productTemplate.currencyId)) {
            listPrice = await (await productTemplate.currencyId)._convert(
                listPrice, await pricelist.currencyId, await productTemplate._getCurrentCompany(pricelist),
                _Date.today()
            );
            priceExtra = await (await productTemplate.currencyId)._convert(
                priceExtra, await pricelist.currencyId, await productTemplate._getCurrentCompany(pricelist),
                _Date.today()
            );
        }
        const priceWithoutDiscount = bool(pricelist) && await pricelist.discountPolicy === 'withoutDiscount' ? listPrice : price;
        const hasDiscountedPrice = await (await (bool(pricelist) ? pricelist : productTemplate).currencyId).compareAmounts(priceWithoutDiscount, price) == 1;

        return {
            'productId': product.id,
            'productTemplateId': productTemplate.id,
            'displayName': displayName,
            'displayImage': displayImage,
            'price': price,
            'listPrice': listPrice,
            'priceExtra': priceExtra,
            'hasDiscountedPrice': hasDiscountedPrice,
        }
    }

    /**
     * Pre-check to `_isAddToCartPossible` to know if product can be sold.
     * @returns 
     */
    async _canBeAddedToCart() {
        return this['saleOk'];
    }

    /**
     * It's possible to add to cart (potentially after configuration) if
        there is at least one possible combination.

        :param parentCombination: the combination from which `self` is an
            optional or accessory product.
        :type parentCombination: recordset `product.template.attribute.value`

        :return: True if it's possible to add to cart, else False
        :rtype: bool
     * @param parentCombination 
     * @returns 
     */
    async _isAddToCartPossible(parentCombination?: any) {
        this.ensureOne();
        if (! await this['active'] || ! await this._canBeAddedToCart()) {
            return false;
        }
        const res = await nextAsync((this as any)._getPossibleCombinations(parentCombination), false);
        return res !== false;
    }

    /**
     * Override: if a pricelist is given, fallback to the company of the
        pricelist if it is set, otherwise use the one from parent method.
     * @param opts 
     * @returns 
     */
    async _getCurrentCompanyFallback(opts) {
        const res = await _super(ProductTemplate, this)._getCurrentCompanyFallback(opts);
        const pricelist = opts['pricelist'];
        const company = bool(pricelist) && await pricelist.companyId;
        return bool(company) ? company : res;
    }
}