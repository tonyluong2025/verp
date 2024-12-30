import _, { extend } from "lodash";
import { Fields, _Date, _Datetime, api } from "../../../core";
import { MapKey, UserError, ValidationError, ValueError } from "../../../core/helper";
import { MetaModel, Model, _super } from "../../../core/models"
import { _f, bool, f, floatCompare, floatIsZero, floatRepr, floatRound, pop, sum, update } from "../../../core/tools";
import assert from "assert";

@MetaModel.define()
class ProductTemplate extends Model {
    static _module = module;
    static _name = 'product.template';
    static _parents = 'product.template';

    static costMethod = Fields.Selection({related: "categId.propertyCostMethod", readonly: true});
    static valuation = Fields.Selection({related: "categId.propertyValuation", readonly: true});

    async write(vals) {
        const impactedTemplates = new MapKey<any, any>();
        const moveValsList = []
        let product = this.env.items('product.product');
        let SVL = this.env.items('stock.valuation.layer');

        if ('categId' in vals) {
            // When a change of category implies a change of cost method, we empty out and replenish
            // the stock.
            const newProductCategory = this.env.items('product.category').browse(vals['categId']);

            for (let productTemplate of this) {
                productTemplate = await productTemplate.with_company(await productTemplate.companyId);
                let valuationImpacted = false;
                if (await productTemplate.costMethod != await newProductCategory.propertyCostMethod) {
                    valuationImpacted = true;
                }
                if (await productTemplate.valuation !== await newProductCategory.propertyValuation) {
                    valuationImpacted = true;
                }
                if (valuationImpacted == false) {
                    continue;
                }

                // Empty out the stock with the current cost method.
                const description = await this._t("Due to a change of product category (from %s to %s), the costing method has changed for product template %s: from %s to %s.",
                    await (await productTemplate.categId).displayName, await newProductCategory.displayName,
                    await productTemplate.displayName, await productTemplate.costMethod, await newProductCategory.propertyCostMethod);
                const [outSvlValsList, productsOrigQuantitySvl, products] = await product._svlEmptyStock(description, { productTemplate });
                const outStockValuationLayers = await SVL.create(outSvlValsList);
                if (await productTemplate.valuation === 'auto') {
                    extend(moveValsList, await product._svlEmptyStockAm(outStockValuationLayers));
                }
                impactedTemplates[productTemplate] = [products, description, productsOrigQuantitySvl];
            }
        }

        const res = await _super(ProductTemplate, this).write(vals);

        for (const [productTemplate, [products, description, productsOrigQuantitySvl]] of impactedTemplates.items()) {
            // Replenish the stock with the new cost method.
            const inSvlValsList = await products._svlReplenishStock(description, productsOrigQuantitySvl);
            const inStockValuationLayers = await SVL.create(inSvlValsList);
            if (await productTemplate.valuation === 'auto') {
                extend(moveValsList, await product._svlReplenishStockAm(inStockValuationLayers));
            }
        }
        // Check access right
        if (moveValsList.length && ! await this.env.items('stock.valuation.layer').checkAccessRights('read', false)) {
            throw new UserError(await this._t("The action leads to the creation of a journal entry, for which you don't have the access rights."));
        }
        // Create the account moves.
        if (moveValsList.length) {
            const accountMoves = await (await this.env.items('account.move').sudo()).create(moveValsList);
            await accountMoves._post();
        }
        return res;
    }

    // -------------------------------------------------------------------------
    // Misc.
    // -------------------------------------------------------------------------
    /**
     * Add the stock accounts related to product to the result of super()
        @return: dictionary which contains information regarding stock accounts and super (income+expense accounts)
     * @returns 
     */
    async _getProductAccounts() {
        const accounts = await _super(ProductTemplate, this)._getProductAccounts();
        const res = await (this as any)._getAssetAccounts();
        const categ = await this['categId'];
        update(accounts, {
            'stockInput': res['stockInput'] || await categ.propertyStockAccountInputCategId,
            'stockOutput': res['stockOutput'] || await categ.propertyStockAccountOutputCategId,
            'stockValuation': await categ.propertyStockValuationAccountId || false,
        })
        return accounts;
    }

    /**
     * Add the stock journal related to product to the result of super()
        @return: dictionary which contains all needed information regarding stock accounts and journal and super (income+expense accounts)
     * @param fiscalPos 
     * @returns 
     */
    async getProductAccounts(fiscalPos?: any) {
        const accounts = await _super(ProductTemplate, this).getProductAccounts(fiscalPos);
        const journal = await (await this['categId']).propertyStockJournal;
        update(accounts, {'stockJournal': journal.ok ? journal : false});
        return accounts;
    }
}

@MetaModel.define()
class ProductProduct extends Model {
    static _module = module;
    static _parents = 'product.product';

    static valueSvl = Fields.Float({compute: '_computeValueSvl', computeSudo: true});
    static quantitySvl = Fields.Float({compute: '_computeC', computeSudo: true});
    static stockValuationLayerIds = Fields.One2many('stock.valuation.layer', 'productId');
    static valuation = Fields.Selection({related: "categId.propertyValuation", readonly: true});
    static costMethod = Fields.Selection({related: "categId.propertyCostMethod", readonly: true});

    async write(vals) {
        if ('standardPrice' in vals && ! this.env.context['disableAutoSvl']) {
            await (await this.filtered(async (p) => await p.costMethod !== 'fifo'))._changeStandardPrice(vals['standardPrice']);
        }
        return _super(ProductProduct, this).write(vals);
    }

    /**
     * Compute 'valueSvl' and 'quantitySvl'.
     */
    @api.depends('stockValuationLayerIds')
    @api.dependsContext('toDate', 'company')
    async _computeValueSvl() {
        const companyId = (await this.env.company()).id;
        const domain = [
            ['productId', 'in', this.ids],
            ['companyId', '=', companyId],
        ]
        if (this.env.context['toDate']) {
            const toDate = _Datetime.toDatetime(this.env.context['toDate']);
            domain.push(['createdAt', '<=', toDate]);
        }
        const groups = await this.env.items('stock.valuation.layer').readGroup(domain, ['value:sum', 'quantity:sum'], ['productId'], {orderby: 'id'});
        let products = this.browse();
        for (const group of groups) {
            const product = this.browse(group['productId'][0]);
            await product.set('valueSvl', await (await (await this.env.company()).currencyId).round(group['value']));
            await product.set('quantitySvl', group['quantity']);
            products = products.or(product);
        }
        const remaining = this.sub(products);
        await remaining.set('valueSvl', 0);
        await remaining.set('quantitySvl', 0);
    }

    // -------------------------------------------------------------------------
    // Actions
    // -------------------------------------------------------------------------
    async actionRevaluation() {
        this.ensureOne();
        const ctx = Object.assign({}, this._context, {default_product: this.id, default_companyId: (await this.env.company()).id});
        return {
            'label': await this._t("Product Revaluation"),
            'viewMode': 'form',
            'resModel': 'stock.valuation.layer.revaluation',
            'viewId': (await this.env.ref('stock_account.stockValuationLayerRevaluationFormView')).id,
            'type': 'ir.actions.actwindow',
            'context': ctx,
            'target': 'new'
        }
    }

    // -------------------------------------------------------------------------
    // SVL creation helpers
    // -------------------------------------------------------------------------
    /**
     * Prepare the values for a stock valuation layer created by a receipt.

        :param quantity: the quantity to value, expressed in `self.uomId`
        :param unitCost: the unit cost to value `quantity`
        :return: values to use in a call to create
        :rtype: dict
     * @param quantity 
     * @param unitCost 
     * @returns 
     */
    async _prepareInSvlVals(quantity, unitCost) {
        this.ensureOne();
        const companyId = this.env.context['forceCompany'] ?? (await this.env.company()).id;
        const company = this.env.items('res.company').browse(companyId);
        const vals = {
            'productId': this.id,
            'value': await (await company.currencyId).round(unitCost * quantity),
            'unitCost': unitCost,
            'quantity': quantity,
        }
        if (['average', 'fifo'].includes(await this['costMethod'])) {
            vals['remainingQty'] = quantity;
            vals['remainingValue'] = vals['value'];
        }
        return vals;
    }

    /**
     * Prepare the values for a stock valuation layer created by a delivery.

        :param quantity: the quantity to value, expressed in `self.uomId`
        :return: values to use in a call to create
        :rtype: dict
     * @param quantity 
     * @param company 
     * @returns 
     */
    async _prepareOutSvlVals(quantity, company) {
        this.ensureOne()
        if (!bool(company)) {
            const companyId = this.env.context['forceCompany'] ?? (await this.env.company()).id;
            company = this.env.items('res.company').browse(companyId);
        }
        const currency = await company.currencyId;
        const [standardPrice, productTemplate] = await this('standardPrice', 'productTemplateId');
        // Quantity is negative for out valuation layers.
        quantity = -1 * quantity;
        const vals = {
            'productId': this.id,
            'value': await currency.round(quantity * standardPrice),
            'unitCost': standardPrice,
            'quantity': quantity,
        }
        if (['average', 'fifo'].includes(await productTemplate.costMethod)) {
            const [quantitySvl, valueSvl, uom] = await this('quantitySvl', 'valueSvl', 'uomId');
            const fifoVals = await this._runFifo(Math.abs(quantity), company);
            vals['remainingQty'] = fifoVals['remainingQty'];
            // In case of AVCO, fix rounding issue of standard price when needed.
            if (await productTemplate.costMethod === 'average' && !floatIsZero(quantitySvl, {precisionRounding: await uom.rounding})) {
                const roundingError = await currency.round(
                    (standardPrice * quantitySvl - valueSvl) * Math.abs(quantity / quantitySvl)
                );
                if (roundingError) {
                    // If it is bigger than the (smallest number of the currency * quantity) / 2,
                    // then it isn't a rounding error but a stock valuation error, we shouldn't fix it under the hood ...
                    if (Math.abs(roundingError) <= Math.max((Math.abs(quantity) * await currency.rounding) / 2, await currency.rounding)) {
                        vals['value'] += roundingError;
                        vals['roundingAdjustment'] = f('\nRounding Adjustment: %s%s %s',
                            roundingError > 0 ? '+' : '',
                            floatRepr(roundingError, await currency.decimalPlaces),
                            await currency.symbol
                        )
                    }
                }
            }
            if (await productTemplate.costMethod === 'fifo') {
                update(vals, fifoVals);
            }
        }
        return vals;
    }

    /**
     * Helper to create the stock valuation layers and the account moves
        after an update of standard price.

        :param new_price: new standard price
     * @param newPrice 
     */
    async _changeStandardPrice(newPrice) {
        // Handle stock valuation layers.

        if (bool(await this.filtered(async (p) => await p.valuation === 'auto')) && ! await this.env.items('stock.valuation.layer').checkAccessRights('read', false)) {
            throw new UserError(await this._t("You cannot update the cost of a product in automated valuation as it leads to the creation of a journal entry, for which you don't have the access rights."));
        }
        const svlValsList = [];
        const company = await this.env.company();
        const currency = await company.currencyId;
        const priceUnitPrec = await this.env.items('decimal.precision').precisionGet('Product Price');
        const roundedNewPrice = floatRound(newPrice, {precisionDigits: priceUnitPrec});
        for (const product of this) {
            const sudo = await product.sudo();
            if (!['standard', 'average'].includes(await product.costMethod)) {
                continue;
            }
            const quantitySvl = await sudo.quantitySvl;
            if (floatCompare(quantitySvl, 0.0, {precisionRounding: await (await product.uomId).rounding}) <= 0) {
                continue;
            }
            const valueSvl = await sudo.valueSvl;
            const value = await currency.round((roundedNewPrice * quantitySvl) - valueSvl);
            if (await currency.isZero(value)) {
                continue;
            }

            const svlVals = {
                'companyId': company.id,
                'productId': product.id,
                'description': await this._t('Product value manually modified (from %s to %s)', await product.standardPrice, roundedNewPrice),
                'value': value,
                'quantity': 0,
            }
            svlValsList.push(svlVals);
        }
        const stockValuationLayers = await (await this.env.items('stock.valuation.layer').sudo()).create(svlValsList);

        // Handle account moves.
        const productAccounts = {}
        for (const product of this) {
            productAccounts[product.id] = await (await product.productTemplateId).getProductAccounts();
        }
        const amValsList = [];
        for (const stockValuationLayer of stockValuationLayers) {
            const [product, value] = await stockValuationLayer('productId', 'value');

            if (await product.type !== 'product' || await product.valuation !== 'auto') {
                continue;
            }

            // Sanity check.
            if (! productAccounts[product.id]['expense']) {
                throw new UserError(await this._t('You must set a counterpart account on your product category.'));
            }
            if (! productAccounts[product.id]['stockValuation']) {
                throw new UserError(await this._t('You don\'t have any stock valuation account defined on your product category. You must define one before processing this operation.'));
            }
            let debitAccountId, creditAccountId;
            if (value < 0) {
                debitAccountId = productAccounts[product.id]['expense'].id;
                creditAccountId = productAccounts[product.id]['stockValuation'].id;
            }
            else {
                debitAccountId = productAccounts[product.id]['stockValuation'].id;
                creditAccountId = productAccounts[product.id]['expense'].id;
            }
            const moveVals = {
                'journalId': productAccounts[product.id]['stockJournal'].id,
                'companyId': company.id,
                'ref': await product.defaultCode,
                'stockValuationLayerIds': [[6, null, [stockValuationLayer.id]]],
                'moveType': 'entry',
                'lineIds': [[0, 0, {
                    'label': _f(await this._t(
                        '{user} changed cost from {previous} to {newPrice} - {product}'), {
                        user: await (await this.env.user()).label,
                        previous: await product.standardPrice,
                        newPrice: newPrice,
                        product: await product.displayName
                    }),
                    'accountId': debitAccountId,
                    'debit': Math.abs(value),
                    'credit': 0,
                    'productId': product.id,
                }], [0, 0, {
                    'label': _f(await this._t(
                        '{user} changed cost from {previous} to {newPrice} - {product}'), {
                        user: await (await this.env.user()).label,
                        previous: await product.standardPrice,
                        newPrice: newPrice,
                        product: await product.displayName
                    }),
                    'accountId': creditAccountId,
                    'debit': 0,
                    'credit': Math.abs(value),
                    'productId': product.id,
                }]],
            }
            amValsList.push(moveVals);
        }
        const accountMoves = await (await this.env.items('account.move').sudo()).create(amValsList);
        if (bool(accountMoves)) {
            accountMoves._post();
        }
    }

    async _runFifo(quantity, company) {
        this.ensureOne();

        // Find back incoming stock valuation layers (called candidates here) to value `quantity`.
        let qtyToTakeOnCandidates = quantity;
        const candidates = await (await this.env.items('stock.valuation.layer').sudo()).search([
            ['productId', '=', this.id],
            ['remainingQty', '>', 0],
            ['companyId', '=', company.id],
        ]);
        const uom = await this['uomId'];
        let newStandardPrice = 0;
        let tmpValue = 0;  // to accumulate the value taken on the candidates
        for (const candidate of candidates) {
            const qtyTakenOnCandidate = Math.min(qtyToTakeOnCandidates, await candidate.remainingQty);
            const candidateUnitCost = await candidate.remainingValue / await candidate.remainingQty;

            newStandardPrice = candidateUnitCost;
            let valueTakenOnCandidate = qtyTakenOnCandidate * candidateUnitCost;
            valueTakenOnCandidate = await (await candidate.currencyId).round(valueTakenOnCandidate);
            const newRemainingValue = await candidate.remainingValue - valueTakenOnCandidate;

            const candidateVals = {
                'remainingQty': await candidate.remainingQty - qtyTakenOnCandidate,
                'remainingValue': newRemainingValue,
            }

            await candidate.write(candidateVals);

            qtyToTakeOnCandidates -= qtyTakenOnCandidate;
            tmpValue += valueTakenOnCandidate;

            if (floatIsZero(qtyToTakeOnCandidates, {precisionRounding: await uom.rounding})) {
                if (floatIsZero(await candidate.remainingQty, {precisionRounding: await uom.rounding})) {
                    const nextCandidates = await candidates.filtered(async (svl) => await svl.remainingQty > 0);
                    newStandardPrice = bool(nextCandidates) && await nextCandidates[0].unitCost || newStandardPrice;
                }
                break;
            }
        }

        // Update the standard price with the price of the last used candidate, if any.
        if (newStandardPrice && await this['costMethod'] === 'fifo') {
            await (await (await (await this.sudo()).withCompany(company.id)).withContext({disableAutoSvl: true})).set('standardPrice', newStandardPrice);
        }

        // If there's still quantity to value but we're out of candidates, we fall in the
        // negative stock use case. We chose to value the out move at the price of the
        // last out and a correction entry will be made once `_fifo_vacuum` is called.
        let vals = {}
        if (floatIsZero(qtyToTakeOnCandidates, {precisionRounding: await uom.rounding})) {
            vals = {
                'value': -tmpValue,
                'unitCost': tmpValue / quantity,
            }
        }
        else {
            assert(qtyToTakeOnCandidates > 0);
            const lastFifoPrice = newStandardPrice || await this['standardPrice'];
            const negativeStockValue = lastFifoPrice * -qtyToTakeOnCandidates;
            tmpValue += Math.abs(negativeStockValue);
            vals = {
                'remainingQty': -qtyToTakeOnCandidates,
                'value': -tmpValue,
                'unitCost': lastFifoPrice,
            }
        }
        return vals;
    }

    /**
     * Compensate layer valued at an estimated price with the price of future receipts
        if any. If the estimated price is equals to the real price, no layer is created but
        the original layer is marked as compensated.

        :param company: recordset of `res.company` to limit the execution of the vacuum
     * @param company 
     * @returns 
     */
    async _runFifoVacuum(company?: any) {
        this.ensureOne();
        if (company == null) {
            company = await this.env.company();
        }
        const svlsToVacuum = await (await this.env.items('stock.valuation.layer').sudo()).search([
            ['productId', '=', this.id],
            ['remainingQty', '<', 0],
            ['stockMoveId', '!=', false],
            ['companyId', '=', company.id],
        ], {order: 'createdAt, id'});
        if (!bool(svlsToVacuum)) {
            return;
        }

        const asSvls = [];

        const domain = [
            ['companyId', '=', company.id],
            ['productId', '=', this.id],
            ['remainingQty', '>', 0],
            ['createdAt', '>=', await svlsToVacuum[0].createdAt],
        ]

        let allCandidates = await (await this.env.items('stock.valuation.layer').sudo()).search(domain);
        for (const svlToVacuum of svlsToVacuum) {
            // We don't use search to avoid executing _flush_search and to decrease interaction with DB
            const candidates = await allCandidates.filtered(
                async (r) => await r.createdAt > await svlToVacuum.createdAt
                || await r.createdAt == await svlToVacuum.createdAt
                && r.id > svlToVacuum.id
            );
            if (!bool(candidates)) {
                break;
            }
            let qtyToTakeOnCandidates = Math.abs(await svlToVacuum.remainingQty);
            let qtyTakenOnCandidates = 0;
            let tmpValue = 0;
            for (const candidate of candidates) {
                const qtyTakenOnCandidate = Math.min(await candidate.remainingQty, qtyToTakeOnCandidates);
                qtyTakenOnCandidates += qtyTakenOnCandidate;

                const candidateUnitCost = await candidate.remainingValue / await candidate.remainingQty;
                let valueTakenOnCandidate = qtyTakenOnCandidate * candidateUnitCost;
                valueTakenOnCandidate = await (await candidate.currencyId).round(valueTakenOnCandidate);
                const newRemainingValue = await candidate.remainingValue - valueTakenOnCandidate;

                const candidateVals = {
                    'remainingQty': await candidate.remainingQty - qtyTakenOnCandidate,
                    'remainingValue': newRemainingValue
                }
                await candidate.write(candidateVals);
                if (! (candidate.remaining_qty > 0)) {
                    allCandidates -= candidate;
                }

                qtyToTakeOnCandidates -= qtyTakenOnCandidate;
                tmpValue += valueTakenOnCandidate;
                if (floatIsZero(qtyToTakeOnCandidates, {precisionRounding: await (await this['uomId']).rounding})) {
                    break;
                }
            }
            // Get the estimated value we will correct.
            const remainingValueBeforeVacuum = await svlToVacuum.unitCost * qtyTakenOnCandidates;
            const newRemainingQty = await svlToVacuum.remainingQty + qtyTakenOnCandidates;
            let correctedValue = remainingValueBeforeVacuum - tmpValue;
            await svlToVacuum.write({
                'remainingQty': newRemainingQty,
            })

            // Don't create a layer or an accounting entry if the corrected value is zero.
            if (await (await svlToVacuum.currencyId).isZero(correctedValue)) {
                continue;
            }

            correctedValue = await (await svlToVacuum.currencyId).round(correctedValue);
            const move = await svlToVacuum.stockMoveId;
            const vals = {
                'productId': this.id,
                'value': correctedValue,
                'unitCost': 0,
                'quantity': 0,
                'remainingQty': 0,
                'stockMoveId': move.id,
                'companyId': (await move.companyId).id,
                'description': f('Revaluation of %s (negative inventory)', await (await move.pickingId).label || await move.label),
                'stockValuationLayerId': svlToVacuum.id,
            }
            const vacuumSvl = await (await this.env.items('stock.valuation.layer').sudo()).create(vals);

            if (await this['valuation'] !== 'auto') {
                continue;
            }
            asSvls.push([vacuumSvl, svlToVacuum]);
        }

        // If some negative stock were fixed, we need to recompute the standard price.
        const product = await this.withCompany(company.id);
        if (await product.costMethod === 'average' && !floatIsZero(await product.quantitySvl, {precisionRounding: await (await this['uomId']).rounding})) {
            await (await (await product.sudo()).withContext({disableAutoSvl: true})).write({'standardPrice': await product.valueSvl / await product.quantitySvl});
        }

        await this.env.items('stock.valuation.layer').browse(asSvls.map(x => x[0].id))._validateAccountingEntries();

        for (const [vacuumSvl, svlToVacuum] of asSvls) {
            await this._createFifoVacuumAngloSaxonExpenseEntry(vacuumSvl, svlToVacuum);
        }
    }

    /**
     *  When product is delivered and invoiced while you don't have units in stock anymore, there are chances of that
        product getting undervalued/overvalued. So, we should nevertheless take into account the fact that the product has
        already been delivered and invoiced to the customer by posting the value difference in the expense account also.
        Consider the below case where product is getting undervalued:

        You bought 8 units @ 10$ -> You have a stock valuation of 8 units, unit cost 10.
        Then you deliver 10 units of the product.
        You assumed the missing 2 should go out at a value of 10$ but you are not sure yet as it hasn't been bought in Verp yet.
        Afterwards, you buy missing 2 units of the same product at 12$ instead of expected 10$.
        In case the product has been undervalued when delivered without stock, the vacuum entry is the following one (this entry already takes place):

        Account                         | Debit   | Credit
        ===================================================
        Stock Valuation                 | 0.00     | 4.00
        Stock Interim (Delivered)       | 4.00     | 0.00

        So, on delivering product with different price, We should create additional journal items like:
        Account                         | Debit    | Credit
        ===================================================
        Stock Interim (Delivered)       | 0.00     | 4.00
        Expenses Revaluation            | 4.00     | 0.00
     * @param vacuumSvl 
     * @param svlToVacuum 
     * @returns 
     */
    async _createFifoVacuumAngloSaxonExpenseEntry(vacuumSvl, svlToVacuum) {
        if (! await (await vacuumSvl.companyId).angloSaxonAccounting || ! await (await svlToVacuum.stockMoveId)._isOut()) {
            return false;
        }
        let accountMove = await this.env.items('account.move').sudo();
        const accountMoveLines = await (await svlToVacuum.accountMoveId).lineIds;
        // Find related customer invoice where product is delivered while you don't have units in stock anymore
        const reconciledLineIds = _.difference(await accountMoveLines._reconciledLines(), accountMoveLines.ids);
        accountMove = await accountMove.search([['lineIds','in', reconciledLineIds]], {limit: 1});
        // If delivered quantity is not invoiced then no need to create this entry
        if (! bool(accountMove)) {
            return false;
        }
        const accounts = await (await (await svlToVacuum.productId).productTemplateId).getProductAccounts(await accountMove.fiscalPositionId);
        if (! accounts['stockOutput'] || ! accounts['expense']) {
            return false;
        }
        const description = f("Expenses %s", await vacuumSvl.description);
        const moveLines = await (await vacuumSvl.stockMoveId)._prepareAccountMoveLine(
            await vacuumSvl.quantity, await vacuumSvl.value * -1,
            accounts['stockOutput'].id, accounts['expense'].id,
            description);
        const newAccountMove = await (await accountMove.sudo()).create({
            'journalId': accounts['stockJournal'].id,
            'lineIds': moveLines,
            'date': this._context['forcePeriodDate'] ?? await _Date.contextToday(this),
            'ref': description,
            'stockMoveId': (await vacuumSvl.stockMoveId).id,
            'moveType': 'entry',
        })
        await newAccountMove._post();
        let toReconcileAccountMoveLines = await (await (await vacuumSvl.accountMoveId).lineIds).filtered(async (l) => ! bool(await l.reconciled) && (await l.accountId).eq(accounts['stockOutput']) && await (await l.accountId).reconcile);
        toReconcileAccountMoveLines = toReconcileAccountMoveLines.add(await (await newAccountMove.lineIds).filtered(async (l) => ! bool(await l.reconciled) && (await l.accountId).eq(accounts['stock_output']) && await (await l.accountId).reconcile));
        return toReconcileAccountMoveLines.reconcile();
    }

    @api.model()
    async _svlEmptyStock(description, productCategory?: any, productTemplate?: any) {
        const impactedProductIds = [];
        let impactedProducts = this.env.items('product.product');
        const productsOrigQuantitySvl = {}

        // get the impacted products
        const domain = [['type', '=', 'product']];
        if (productCategory != null) {
            extend(domain, [['categId', '=', productCategory.id]]);
        }
        else if (productTemplate != null) {
            extend(domain, [['productTemplateId', '=', productTemplate.id]]);
        }
        else {
            throw new ValueError();
        }
        const products = await this.env.items('product.product').searchRead(domain, ['quantitySvl']);
        for (const product of products) {
            impactedProductIds.push(product['id']);
            productsOrigQuantitySvl[product['id']] = product['quantitySvl'];
        }
        impactedProducts = impactedProducts.or(this.env.items('product.product').browse(impactedProductIds));

        const company = await this.env.company();
        // empty out the stock for the impacted products
        const emptyStockSvlList = []
        for (const product of impactedProducts) {
            const [quantitySvl, valueSvl, uom] = await product('quantitySvl', 'valueSvl', 'uomId');
            // FIXME sle: why not use products_orig_quantity_svl here?
            if (floatIsZero(quantitySvl, {precisionRounding: await uom.rounding})) {
                // FIXME: create an empty layer to track the change?
                continue;
            }
            let svslVals
            if (floatCompare(quantitySvl, 0, {precisionRounding: await uom.rounding}) > 0) {
                svslVals = await product._prepareOutSvlVals(quantitySvl, company);
            }
            else {
                svslVals = await product._prepareInSvlVals(Math.abs(quantitySvl), valueSvl / quantitySvl);
            }
            svslVals['description'] = description + pop(svslVals, 'roundingAdjustment', '');
            svslVals['companyId'] = company.id;
            emptyStockSvlList.push(svslVals);
        }
        return [emptyStockSvlList, productsOrigQuantitySvl, impactedProducts];
    }

    async _svlReplenishStock(description, productsOrigQuantitySvl) {
        const refillStockSvlList = [];
        const company = await this.env.company();
        for (const product of this) {
            const quantitySvl = productsOrigQuantitySvl[product.id];
            if (quantitySvl) {
                let svlVals;
                if (floatCompare(quantitySvl, 0, {precisionRounding: await (await product.uomId).rounding}) > 0) {
                    svlVals = await product._prepareInSvlVals(quantitySvl, await product.standardPrice);
                }
                else {
                    svlVals = await product._prepareOutSvlVals(Math.abs(quantitySvl), company);
                }
                svlVals['description'] = description;
                svlVals['companyId'] = company.id;
                refillStockSvlList.push(svlVals);
            }
        }
        return refillStockSvlList;
    }

    @api.model()
    async _svlEmptyStockAm(stockValuationLayers) {
        const moveValsList = [];
        const productAccounts = {};
        for (const product of await stockValuationLayers.mapped('productId')) {
            productAccounts[product.id] = await (await product.productTemplateId).getProductAccounts();
        }
        const company = await this.env.company();
        for (const outStockValuationLayer of stockValuationLayers) {
            const product = await outStockValuationLayer.productId;
            const stockInputAccount = productAccounts[product.id]['stockInput'];
            if (!bool(stockInputAccount)) {
                throw new UserError(await this._t('You don\'t have any stock input account defined on your product category. You must define one before processing this operation.'));
            }
            if (! productAccounts[product.id]['stockValuation']) {
                throw new UserError(await this._t('You don\'t have any stock valuation account defined on your product category. You must define one before processing this operation.'));
            }

            const debitAccountId = stockInputAccount.id;
            const creditAccountId = productAccounts[product.id]['stockValuation'].id;
            const value = await outStockValuationLayer.value;
            const moveVals = {
                'journalId': productAccounts[product.id]['stockJournal'].id,
                'companyId': company.id,
                'ref': await product.defaultCode,
                'stockValuationLayerIds': [[6, null, [outStockValuationLayer.id]]],
                'lineIds': [[0, 0, {
                    'label': await outStockValuationLayer.description,
                    'accountId': debitAccountId,
                    'debit': Math.abs(value),
                    'credit': 0,
                    'productId': product.id,
                }], [0, 0, {
                    'label': await outStockValuationLayer.description,
                    'accountId': creditAccountId,
                    'debit': 0,
                    'credit': Math.abs(value),
                    'productId': product.id,
                }]],
                'moveType': 'entry',
            }
            moveValsList.push(moveVals);
        }
        return moveValsList;
    }

    async _svlReplenishStockAm(stockValuationLayers) {
        const moveValsList = [];
        const productAccounts = {};
        for (const product of await stockValuationLayers.mapped('productId')) {
            productAccounts[product.id] = await (await product.productTemplateId).getProductAccounts();
        }
        for (const outStockValuationLayer of stockValuationLayers) {
            const product = await outStockValuationLayer.productId;
            if (! productAccounts[product.id]['stockInput']) {
                throw new UserError(await this._t('You don\'t have any input valuation account defined on your product category. You must define one before processing this operation.'));
            }
            if (! productAccounts[product.id]['stockValuation']) {
                throw new UserError(await this._t('You don\'t have any stock valuation account defined on your product category. You must define one before processing this operation.'));
            }

            const debitAccountId = productAccounts[product.id]['stockValuation'].id;
            const creditAccountId = productAccounts[product.id]['stockInput'].id;
            const value = await outStockValuationLayer.value;
            const moveVals = {
                'journalId': productAccounts[product.id]['stockJournal'].id,
                'companyId': (await this.env.company()).id,
                'ref': await product.defaultCode,
                'stockValuationLayerIds': [[6, null, [outStockValuationLayer.id]]],
                'lineIds': [[0, 0, {
                    'label': await outStockValuationLayer.description,
                    'accountId': debitAccountId,
                    'debit': Math.abs(value),
                    'credit': 0,
                    'productId': product.id,
                }], [0, 0, {
                    'label': await outStockValuationLayer.description,
                    'accountId': creditAccountId,
                    'debit': 0,
                    'credit': Math.abs(value),
                    'productId': product.id,
                }]],
                'moveType': 'entry',
            }
            moveValsList.push(moveVals);
        }
        return moveValsList;
    }

    // -------------------------------------------------------------------------
    // Anglo saxon helpers
    // -------------------------------------------------------------------------
    async _stockAccountGetAngloSaxonPriceUnit(uom: any=false) {
        const [price, uomId] = await this('standardPrice', 'uomId')
        if (! this.ok || !bool(uom) || uomId.id == uom.id) {
            return price || 0.0;
        }
        return uomId._computePrice(price, uom);
    }

    /**
     * Go over the valuation layers of `stock_moves` to value `qtyToInvoice` while taking
        care of ignoring `qty_invoiced`. If `qtyToInvoice` is greater than what's possible to
        value with the valuation layers, use the product's standard price.

        :param qty_invoiced: quantity already invoiced
        :param qtyToInvoice: quantity to invoice
        :param stock_moves: recordset of `stock.move`
        :returns: the anglo saxon price unit
        :rtype: float
     */
    async _computeAveragePrice(qtyInvoiced, qtyToInvoice, stockMoves) {
        this.ensureOne();
        if (! qtyToInvoice) {
            return 0;
        }

        // if True, consider the incoming moves
        const isReturned = this.env.context['isReturned'] ?? false;

        const candidates = await (await (await (await stockMoves.sudo())
            .filtered(async (m) => isReturned == bool((await m.originReturnedMoveId).ok && sum(await (await m.stockValuationLayerIds).mapped('quantity')) >= 0)))
            .mapped('stockValuationLayerIds'))
            .sorted();

        const valueInvoiced = this.env.context['valueInvoiced'] ?? 0;
        let qtyValued, valuation;
        if ('valueInvoiced' in this.env.context) {
            [qtyValued, valuation] = await candidates._consumeAll(qtyInvoiced, valueInvoiced, qtyToInvoice);
        }
        else {
            [qtyValued, valuation] = await candidates._consumeSpecificQty(qtyInvoiced, qtyToInvoice);
        }

        // If there's still quantity to invoice but we're out of candidates, we chose the standard
        // price to estimate the anglo saxon price unit.
        let missing = qtyToInvoice - qtyValued;
        const uom = await this['uomId'];
        for (const sml of await stockMoves.moveLineIds) {
            if (! bool(await sml.ownerId) || (await sml.ownerId).eq(await (await sml.companyId).partnerId)) {
                continue;
            }
            missing -= await (await sml.productUomId)._computeQuantity(await sml.qtyDone, uom, {roundingMethod: 'HALF-UP'});
        }
        if (floatCompare(missing, 0, {precisionRounding: await uom.rounding}) > 0) {
            valuation += await this['standardPrice'] * missing;
        }

        return valuation / qtyToInvoice;
    }
}

@MetaModel.define()
class ProductCategory extends Model {
    static _module = module;
    static _parents = 'product.category';

    static propertyValuation = Fields.Selection([
        ['manual', 'Manual'],
        ['auto', 'Automated']], {string: 'Inventory Valuation',
        companyDependent: true, copy: true, required: true,
        help: "Manual: The accounting entries to value the inventory are not posted automatically. \
        Automated: An accounting entry is automatically created to value the inventory when a product enters or leaves the company."});
    static propertyCostMethod = Fields.Selection([
        ['standard', 'Standard Price'],
        ['fifo', 'First In First Out (FIFO)'],
        ['average', 'Average Cost (AVCO)']], {string: "Costing Method",
        companyDependent: true, copy: true, required: true,
        help: "Standard Price: The products are valued at their standard cost defined on the product. \
        Average Cost (AVCO): The products are valued at weighted average cost. \
        First In First Out (FIFO): The products are valued supposing those that enter the company first will also leave it first."});
    static propertyStockJournal = Fields.Many2one(
        'account.journal', {string: 'Stock Journal', companyDependent: true,
        domain: "[['companyId', '=', allowedCompanyIds[0]]]", checkCompany: true,
        help: "When doing automated inventory valuation, this is the Accounting Journal in which entries will be automatically posted when stock moves are processed."});
    static propertyStockAccountInputCategId = Fields.Many2one(
        'account.account', {string: 'Stock Input Account', companyDependent: true,
        domain: "[['companyId', '=', allowedCompanyIds[0]], ['deprecated', '=', false]]", checkCompany: true,
        help: "Counterpart journal items for all incoming stock moves will be posted in this account, unless there is a specific valuation account set on the source location. This is the default value for all products in this category. It can also directly be set on each product."});
    static propertyStockAccountOutputCategId = Fields.Many2one(
        'account.account', {string: 'Stock Output Account', companyDependent: true,
        domain: "[['companyId', '=', allowedCompanyIds[0]], ['deprecated', '=', false]]", checkCompany: true,
        help: "When doing automated inventory valuation, counterpart journal items for all outgoing stock moves will be posted in this account, unless there is a specific valuation account set on the destination location. This is the default value for all products in this category. It can also directly be set on each product."});
    static propertyStockValuationAccountId = Fields.Many2one(
        'account.account', {string: 'Stock Valuation Account', companyDependent: true,
        domain: "[['companyId', '=', allowedCompanyIds[0]], ['deprecated', '=', false]]", checkCompany: true,
        help: "When automated inventory valuation is enabled on a product, this account will hold the current value of the products."});

    @api.constrains('propertyStockValuationAccountId', 'propertyStockAccountOutputCategId', 'propertyStockAccountInputCategId')
    async _checkValuationAccouts() {
        // Prevent to set the valuation account as the input or output account.
        for (const category of this) {
            const valuationAccount = await category.propertyStockValuationAccountId;
            const inputAndOutputAccounts = (await category.propertyStockAccountInputCategId).or(await category.propertyStockAccountOutputCategId);
            if (bool(valuationAccount) && inputAndOutputAccounts.includes(valuationAccount)) {
                throw new ValidationError(await this._t('The Stock Input and/or Output accounts cannot be the same as the Stock Valuation account.'));
            }
        }
    }

    @api.onchange('propertyCostMethod')
    async onchangePropertyCost() {
        if (! bool(this._origin)) {
            // don't display the warning when creating a product category
            return;
        }
        return {
            'warning': {
                'title': await this._t("Warning"),
                'message': await this._t("Changing your cost method is an important change that will impact your inventory valuation. Are you sure you want to make that change?"),
            }
        }
    }

    async write(vals) {
        const impactedCategories = new MapKey<any, any>();
        const moveValsList = [];
        const product = this.env.items('product.product');
        const SVL = this.env.items('stock.valuation.layer');

        if ('propertyCostMethod' in vals || 'propertyValuation' in vals) {
            // When the cost method or the valuation are changed on a product category, we empty
            // out and replenish the stock for each impacted products.
            const newCostMethod = vals['propertyCostMethod'];
            const newValuation = vals['propertyValuation'];

            for (const productCategory of this) {
                const propertyStockFields = ['propertyStockAccountInputCategId', 'propertyStockAccountOutputCategId', 'propertyStockValuationAccountId'];
                if ('propertyValuation' in vals && vals['propertyValuation'] === 'manual' && await productCategory.propertyValuation !== 'manual') {
                    for (const stockProperty of propertyStockFields) {
                        vals[stockProperty] = false;
                    }
                }
                else if ('propertyValuation' in vals && vals['propertyValuation'] === 'auto' && await productCategory.propertyValuation !== 'auto') {
                    const company = await this.env.company();
                    for (const stockProperty of propertyStockFields) {
                        vals[stockProperty] = (vals[stockProperty] ?? false) || await company[stockProperty];
                    }
                }
                else if (await productCategory.propertyValuation === 'manual') {
                    for (const stockProperty of propertyStockFields) {
                        if (stockProperty in vals) {
                            pop(vals, stockProperty);
                        }
                    }
                }
                else {
                    for (const stockProperty of propertyStockFields) {
                        if (stockProperty in vals && vals[stockProperty] == false) {
                            pop(vals, stockProperty);
                        }
                    }
                }
                let valuationImpacted = false;
                if (newCostMethod && newCostMethod != await productCategory.propertyCostMethod) {
                    valuationImpacted = true;
                }
                if (newValuation && newValuation != await productCategory.propertyValuation) {
                    valuationImpacted = true;
                }
                if (valuationImpacted == false) {
                    continue;
                }

                // Empty out the stock with the current cost method.
                let description;
                if (newCostMethod) {
                    description = await this._t("Costing method change for product category %s: from %s to %s.",
                        await productCategory.displayName, await productCategory.propertyCostMethod, newCostMethod);
                }
                else {
                    description = await this._t("Valuation method change for product category %s: from %s to %s.",
                        await productCategory.displayName, await productCategory.propertyValuation, newValuation);
                }
                const [outSvlValsList, productsOrigQuantitySvl, products] = await product._svlEmptyStock(description, {productCategory});
                const outStockValuationLayers = await (await SVL.sudo()).create(outSvlValsList);
                if (await productCategory.propertyValuation === 'auto') {
                    extend(moveValsList, await product._svlEmptyStockAm(outStockValuationLayers));
                }
                impactedCategories[productCategory] = [products, description, productsOrigQuantitySvl];
            }
        }
        const res = await _super(ProductCategory, this).write(vals);

        for (const [productCategory, [products, description, productsOrigQuantitySvl]] of impactedCategories.items()) {
            // Replenish the stock with the new cost method.
            const inSvlValsList = await products._svlReplenishStock(description, productsOrigQuantitySvl);
            const inStockValuationLayers = await (await SVL.sudo()).create(inSvlValsList);
            if (await productCategory.propertyValuation === 'auto') {
                extend(moveValsList, await product._svlReplenishStockAm(inStockValuationLayers));
            }
        }

        // Check access right
        if (moveValsList.length && ! await this.env.items('stock.valuation.layer').checkAccessRights('read', false)) {
            throw new UserError(await this._t("The action leads to the creation of a journal entry, for which you don't have the access rights."));
        }
        // Create the account moves.
        if (moveValsList.length) {
            const accountMoves = await (await this.env.items('account.move').sudo()).create(moveValsList);
            await accountMoves._post();
        }
        return res;
    }

    @api.model()
    async create(vals) {
        if (!('propertyValuation' in vals) || vals['propertyValuation'] === 'manual') {
            vals['propertyStockAccountInputCategId'] = false;
            vals['propertyStockAccountOutputCategId'] = false;
            vals['propertyStockValuationAccountId'] = false;
        }
        if ('propertyValuation' in vals && vals['propertyValuation'] === 'auto') {
            const company = await this.env.company();
            vals['propertyStockAccountInputCategId'] = (vals['propertyStockAccountInputCategId'] ?? false) || await company.propertyStockAccountInputCategId;
            vals['propertyStockAccountOutputCategId'] = (vals['propertyStockAccountOutputCategId'] ?? false) || await company.propertyStockAccountOutputCategId;
            vals['property_stock_valuation_account_id'] = (vals['propertyStockValuationAccountId'] ?? false) || await company.propertyStockValuationAccountId;
        }
        return _super(ProductCategory, this).create(vals);
    }

    @api.onchange('propertyValuation')
    async onchangePropertyValuation() {
        // Remove or set the account stock properties if necessary
        const propertyValuation = await this['propertyValuation'];
        if (propertyValuation === 'manual') {
            await this.update({
                propertyStockAccountInputCategId: false,
                propertyStockAccountOutputCategId: false,
                propertyStockValuationAccountId: false
            });
        }
        if (propertyValuation === 'auto') {
            const company = await this.env.company();
            await this.update({
                propertyStockAccountInputCategId: await company.propertyStockAccountInputCategId,
                propertyStockAccountOutputCategId: await company.propertyStockAccountOutputCategId,
                propertyStockValuationAccountId: await company.propertyStockValuationAccountId
            });
        }
    }
}