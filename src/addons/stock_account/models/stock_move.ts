import _ from "lodash";
import { Fields, _Date, api } from "../../../core";
import { DefaultDict2, OrderedSet, UserError, ValueError } from "../../../core/helper";
import { MetaModel, Model, _super } from "../../../core/models"
import { UpCamelCase, bool, f, floatCompare, floatIsZero, isInstance, pop, sum, update } from "../../../core/tools";

@MetaModel.define()
class StockMove extends Model {
    static _module = module;
    static _parents = "stock.move";

    static toRefund = Fields.Boolean({string: "Update quantities on SO/PO", copy: false,
                               help: 'Trigger a decrease of the delivered/received quantity in the associated Sale Order/Purchase Order'});
    static accountMoveIds = Fields.One2many('account.move', 'stockMoveId');
    static stockValuationLayerIds = Fields.One2many('stock.valuation.layer', 'stockMoveId');
    static analyticAccountLineId = Fields.Many2one('account.analytic.line', {copy: false});

    async _filterAngloSaxonMoves(product) {
        return this.filtered(async (m) => (await m.productId).id == product.id);
    }

    async actionGetAccountMoves() {
        this.ensureOne();
        const actionData = await this.env.items('ir.actions.actions')._forXmlid('account.actionMoveJournalLine');
        actionData['domain'] = [['id', 'in', (await this['accountMoveIds']).ids]];
        return actionData;
    }

    async _actionCancel() {
        await (await this['analyticAccountLineId']).unlink();
        return _super(StockMove, this)._actionCancel();
    }

    async _shouldForcePriceUnit() {
        this.ensureOne();
        return false;
    }

    /**
     * Returns the unit price to value this stock move
     * @returns 
     */
    async _getPriceUnit() {
        this.ensureOne();
        const [priceUnit, originReturnedMove] = await this('priceUnit', 'originReturnedMoveId');
        const precision = await this.env.items('decimal.precision').precisionGet('Product Price');
        // If the move is a return, use the original move's price unit.
        if (originReturnedMove.ok && bool(await (await originReturnedMove.sudo()).stockValuationLayerIds)) {
            let layers = await (await originReturnedMove.sudo()).stockValuationLayerIds;
            // dropshipping create additional positive svl to make sure there is no impact on the stock valuation
            // We need to remove them from the computation of the price unit.
            if (await originReturnedMove._isDropshipped() || await originReturnedMove._isDropshippedReturned()) {
                layers = await layers.filtered(async (l) => floatCompare(await l.value, 0, {precisionRounding: await (await (await l.productId).uomId).rounding}) <= 0);
            }
            layers = layers.or(await layers.stockValuationLayerIds);
            const quantity = sum(await layers.mapped("quantity"));
            return sum(await layers.mapped("value")) / (!floatIsZero(quantity, {precisionRounding: await (await layers.uomId).rounding}) ? quantity : 0);
        }
        return !floatIsZero(priceUnit, precision) || await this._shouldForcePriceUnit() ? priceUnit : await (await this['productId']).standardPrice;
    }

    /**
     * Returns a list of `valued_type` as strings. During `action_done`, we'll call
        `_is_[valuedType]'. If the result of this method is truthy, we'll consider the move to be
        valued.

        :returns: a list of `valuedType`
        :rtype: list
     * @returns 
     */
    @api.model()
    async _getValuedTypes() {
        return ['in', 'out', 'dropshipped', 'dropshippedReturned'];
    }

    /**
     * Returns the `stock.move.line` records of `self` considered as incoming. It is done thanks
        to the `_should_be_valued` method of their source and destionation location as well as their
        owner.

        :returns: a subset of `self` containing the incoming records
        :rtype: recordset
     * @returns 
     */
    async _getInMoveLines() {
        this.ensureOne();
        const res = new OrderedSet();
        for (const moveLine of await this['moveLineIds']) {
            if (bool(await moveLine.ownerId) && !(await moveLine.ownerId).eq(await (await moveLine.companyId).partnerId)) {
                continue;
            }
            if (! await (await moveLine.locationId)._shouldBeValued() && await (await moveLine.locationDestId)._shouldBeValued()) {
                res.add(moveLine.id);
            }
        }
        return this.env.items('stock.move.line').browse(res);
    }

    /**
     * Check if the move should be considered as entering the company so that the cost method
        will be able to apply the correct logic.

        :returns: True if the move is entering the company else false
        :rtype: bool
     * @returns 
     */
    async _isIn() {
        this.ensureOne();
        if (bool(await this._getInMoveLines()) && ! await this._isDropshippedReturned()) {
            return true;
        }
        return false;
    }

    /**
     * Returns the `stock.move.line` records of `self` considered as outgoing. It is done thanks
        to the `_should_be_valued` method of their source and destionation location as well as their
        owner.

        :returns: a subset of `self` containing the outgoing records
        :rtype: recordset
     * @returns 
     */
    async _getOutMoveLines() {
        let res = this.env.items('stock.move.line');
        for (const moveLine of await this['moveLineIds']) {
            if (bool(await moveLine.ownerId) && !(await moveLine.ownerId).eq(await (await moveLine.companyId).partnerId)) {
                continue;
            }
            if (await (await moveLine.locationId)._shouldBeValued() && ! await (await moveLine.locationDestId)._shouldBeValued()) {
                res = res.or(moveLine);
            }
        }
        return res;
    }

    /**
     * Check if the move should be considered as leaving the company so that the cost method
        will be able to apply the correct logic.

        :returns: True if the move is leaving the company else false
        :rtype: bool
     * @returns 
     */
    async _isOut() {
        this.ensureOne();
        if (await this._getOutMoveLines() && ! await this._isDropshipped()) {
            return true;
        }
        return false;
    }

    /**
     * Check if the move should be considered as a dropshipping move so that the cost method
        will be able to apply the correct logic.

        :returns: True if the move is a dropshipping one else false
        :rtype: bool
     * @returns 
     */
    async _isDropshipped() {
        this.ensureOne();
        return await (await this['locationId']).usage === 'supplier' && await (await this['locationDestId']).usage === 'customer';
    }

    /**
     * Check if the move should be considered as a returned dropshipping move so that the cost
        method will be able to apply the correct logic.

        :returns: True if the move is a returned dropshipping one else false
        :rtype: bool
     * @returns 
     */
    async _isDropshippedReturned() {
        this.ensureOne();
        return await (await this['locationId']).usage === 'customer' && await (await this['locationDestId']).usage === 'supplier';
    }

    /**
     * When a `stock.valuation.layer` is created from a `stock.move`, we can prepare a dict of
        common vals.

        :returns: the common values when creating a `stock.valuation.layer` from a `stock.move`
        :rtype: dict
     * @returns 
     */
    async _prepareCommonSvlVals() {
        this.ensureOne();
        const [company, product, reference] = await this('companyId', 'productId', 'reference');
        return {
            'stockMoveId': this.id,
            'companyId': company.id,
            'productId': product.id,
            'description': reference && f('%s - %s', reference, await product.label) || await product.label,
        }
    }

    /**
     * Create a `stock.valuation.layer` from `self`.

        :param forced_quantity: under some circunstances, the quantity to value is different than
            the initial demand of the move (Default value = None)
     * @param forcedQuantity 
     * @returns 
     */
    async _createInSvl(forcedQuantity?: any) {
        const svlValsList = [];
        for (let move of this) {
            move = await move.withCompany(await move.companyId);
            const [product] = await move('productId');
            const valuedMoveLines = await move._getInMoveLines();
            let valuedQuantity = 0;
            for (const valuedMoveLine of valuedMoveLines) {
                valuedQuantity += await (await valuedMoveLine.productUomId)._computeQuantity(await valuedMoveLine.qtyDone, await product.uomId);
            }
            let unitCost = Math.abs(await move._getPriceUnit());  // May be negative (i.e. decrease an out move).
            if (await product.costMethod === 'standard') {
                unitCost = await product.standardPrice;
            }
            const svlVals = await product._prepareInSvlVals(forcedQuantity || valuedQuantity, unitCost);
            update(svlVals, await move._prepareCommonSvlVals());
            if (forcedQuantity) {
                svlVals['description'] = f('Correction of %s (modification of past move)', await (await move.pickingId).label || await move.label);
            }
            svlValsList.push(svlVals);
        }
        return (await this.env.items('stock.valuation.layer').sudo()).create(svlValsList);
    }

    /**
     * Create a `stock.valuation.layer` from `self`.

        :param forcedQuantity: under some circunstances, the quantity to value is different than
            the initial demand of the move (Default value = null)
     * @param forcedQuantity 
     * @returns 
     */
    async _createOutSvl(forcedQuantity?: any) {
        const svlValsList = [];
        for (let move of this) {
            move = await move.withCompany(await move.companyId);
            const [product] = await move('productId'); 
            const valuedMoveLines = await move._getOutMoveLines();
            let valuedQuantity = 0;
            for (const valuedMoveLine of valuedMoveLines) {
                valuedQuantity += (await valuedMoveLine.productUomId)._computeQuantity(await valuedMoveLine.qtyDone, await product.uomId);
            }
            if (floatIsZero(forcedQuantity || valuedQuantity, {precisionRounding: await (await product.uomId).rounding})) {
                continue;
            }
            const svlVals = await product._prepareOutSvlVals(forcedQuantity || valuedQuantity, await move.companyId);
            update(svlVals, await move._prepareCommonSvlVals());
            if (forcedQuantity) {
                svlVals['description'] = f('Correction of %s (modification of past move)', await (await move.pickingId).label || await move.label);
            }
            svlVals['description'] += pop(svlVals, 'roundingAdjustment', '');
            svlValsList.push(svlVals);
        }
        return (await this.env.items('stock.valuation.layer').sudo()).create(svlValsList);
    }

    /**
     * Create a `stock.valuation.layer` from `self`.

        :param forced_quantity: under some circunstances, the quantity to value is different than
            the initial demand of the move (Default value = None)
     * @param forcedQuantity 
     * @returns 
     */
    async _createDropshippedSvl(forcedQuantity?: any) {
        const svlValsList = [];
        for (let move of this) {
            move = await move.withCompany(await move.companyId);
            const [valuedMoveLines, product] = await move('moveLineIds', 'productId');
            let valuedQuantity = 0;
            for (const valuedMoveLine of valuedMoveLines) {
                valuedQuantity += await (await valuedMoveLine.productUomId)._computeQuantity(await valuedMoveLine.qtyDone, await product.uomId);
            }
            const quantity = forcedQuantity || valuedQuantity;

            let unitCost = await move._getPriceUnit();
            if (await product.costMethod === 'standard') {
                unitCost = await product.standardPrice
            }
            const commonVals = Object.assign({}, await move._prepareCommonSvlVals(), {remainingQty: 0});

            // create the in if it does not come from a valued location (eg subcontract -> customer)
            if (! await (await move.locationId)._shouldBeValued()) {
                const inVals = {
                    'unitCost': unitCost,
                    'value': unitCost * quantity,
                    'quantity': quantity,
                }
                update(inVals, commonVals);
                svlValsList.push(inVals);
            }
            // create the out if it does not go to a valued location (eg customer -> subcontract)
            if (! await (await move.locationDestId)._shouldBeValued()) {
                const outVals = {
                    'unitCost': unitCost,
                    'value': unitCost * quantity * -1,
                    'quantity': quantity * -1,
                }
                update(outVals, commonVals);
                svlValsList.push(outVals);
            }
        }
        return (await this.env.items('stock.valuation.layer').sudo()).create(svlValsList);
    }

    /**
     * Create a `stock.valuation.layer` from `this`.

        :param forcedQuantity: under some circunstances, the quantity to value is different than
            the initial demand of the move (Default value = None)
     * @param forcedQuantity 
     * @returns 
     */
    async _createDropshippedReturnedSvl(forcedQuantity?: any) {
        return this._createDropshippedSvl(forcedQuantity);
    }

    async _actionDone(cancelBackorder: any=false) {
        // Init a dict that will group the moves by valuation type, according to `move._is_valued_type`.
        let valuedMoves = Object.fromEntries((await this._getValuedTypes()).map(valuedType => [valuedType, this.env.items('stock.move')]));
        for (const move of this) {
            if (floatIsZero(await move.quantityDone, {precisionRounding: await (await move.productUom).rounding})) {
                continue;
            }
            for (const valuedType of await this._getValuedTypes()) {
                if (await move[`_is${UpCamelCase(valuedType)}`]()) {
                    valuedMoves[valuedType] = valuedMoves[valuedType].or(move);
                }
            }
        }
        // AVCO application
        await valuedMoves['in'].productPriceUpdateBeforeDone();

        const res = await _super(StockMove, this)._actionDone(cancelBackorder);

        // '_action_done' might have deleted some exploded stock moves
        valuedMoves = {}
        for (const [valueType, moves] of Object.entries(valuedMoves)) {
            valuedMoves[valueType] = await moves.exists();
        }

        // '_actionDone' might have created an extra move to be valued
        for (const move of res.sub(this)) {
            for (const valuedType of await this._getValuedTypes()) {
                if (await move[f('_is%s', UpCamelCase(valuedType))]()) {
                    valuedMoves[valuedType] = valuedMoves[valuedType].or(move);
                }
            }
        }

        let stockValuationLayers = await this.env.items('stock.valuation.layer').sudo();
        // Create the valuation layers in batch by calling `moves._create_valued_type_svl`.
        for (const valuedType of await this._getValuedTypes()) {
            const todoValuedMoves = valuedMoves[valuedType];
            if (bool(todoValuedMoves)) {
                await todoValuedMoves._sanityCheckForValuation();
                stockValuationLayers = stockValuationLayers.or(await todoValuedMoves[`_create${UpCamelCase(valuedType)}Svl`]());
            }
        }

        await stockValuationLayers._validateAccountingEntries();
        await stockValuationLayers._validateAnalyticAccountingEntries();

        await stockValuationLayers._checkCompany();

        // For every in move, run the vacuum for the linked product.
        const productsToVacuum = await valuedMoves['in'].mapped('productId');
        let company = await valuedMoves['in'].mapped('companyId');
        company = bool(company) ? company[0] : await this.env.company();
        for (const productToVacuum of productsToVacuum) {
            await productToVacuum._runFifoVacuum(company);
        }

        return res;
    }

    async _sanityCheckForValuation() {
        for (const move of this) {
            // Apply restrictions on the stock move to be able to make
            // consistent accounting entries.
            if (await move._isIn() && await move._isOut()) {
                throw new UserError(await this._t("The move lines are not in a consistent state: some are entering and other are leaving the company."));
            }
            const companySrc = await move.mapped('moveLineIds.locationId.companyId');
            const companyDst = await move.mapped('moveLineIds.locationDestId.companyId');
            try {
                if (bool(companySrc)) {
                    companySrc.ensureOne();
                }
                if (bool(companyDst)) {
                    companyDst.ensureOne();
                }
            } catch(e) {
                if (isInstance(e, ValueError)) {
                    throw new UserError(await this._t("The move lines are not in a consistent states: they do not share the same origin or destination company."));
                } else {
                    throw e;
                }
            }
            if (bool(companySrc) && bool(companyDst) && companySrc.id != companyDst.id) {
                throw new UserError(await this._t("The move lines are not in a consistent states: they are doing an intercompany in a single step while they should go through the intercompany transit location."));
            }
        }
    }

    async productPriceUpdateBeforeDone(forcedQty?: any) {
        const tmplDict = new DefaultDict2(() => 0.0);
        // adapt standard price on incomming moves if the product cost_method is 'average'
        const stdPriceUpdate = {}
        for (const move of await this.filtered(async (move) => await move._isIn() && await (await move.withCompany(await move.companyId).productId).costMethod === 'average')) {
            const [product, company] = await move('productId', 'companyId');
            const keyId = String([product.id, company.id]);
            const productTotQtyAvailable = await (await product.sudo()).withCompany(company).quantitySvl + tmplDict[product.id];
            const rounding = await (await product.uomId).rounding;

            const valuedMoveLines = await move._getInMoveLines();
            let qtyDone = 0;
            for (const valuedMoveLine of valuedMoveLines) {
                qtyDone += await (await valuedMoveLine.productUomId)._computeQuantity(await valuedMoveLine.qtyDone, await product.uomId);
            }

            let newStdPrice;
            let qty = forcedQty || qtyDone;
            if (floatIsZero(productTotQtyAvailable, {precisionRounding: rounding})) {
                newStdPrice = await move._getPriceUnit();
            }
            else if (floatIsZero(productTotQtyAvailable + await move.productQty, {precisionRounding: rounding}) || 
                    floatIsZero(productTotQtyAvailable + qty, {precisionRounding: rounding})) {
                newStdPrice = await move._getPriceUnit();
            }
            else {
                // Get the standard price
                const amountUnit = stdPriceUpdate[keyId] || await (await product.withCompany(company)).standardPrice;
                newStdPrice = ((amountUnit * productTotQtyAvailable) + (await move._getPriceUnit() * qty)) / (productTotQtyAvailable + qty);
            }

            tmplDict[product.id] += qtyDone;
            // Write the standard price, as SUPERUSER_ID because a warehouse manager may not have the right to write on products
            await (await (await (await product.withCompany(company.id)).withContext({disableAutoSvl: true})).sudo()).write({'standardPrice': newStdPrice});
            stdPriceUpdate[keyId] = newStdPrice;
        }

        // adapt standard price on incomming moves if the product cost_method is 'fifo'
        for (const move of await this.filtered(async (move) =>
                                  await (await (await move.withCompany(await move.companyId)).productId).costMethod == 'fifo'
                                  && floatIsZero(await (await (await move.productId).sudo()).quantitySvl, {precisionRounding: await (await (await move.productId).uomId).rounding}))) {
            await (await (await (await move.productId).withCompany(await move.companyId)).sudo()).write({'standardPrice': await move._getPriceUnit()});
        }
    }

    /**
     * Return the accounts and journal to use to post Journal Entries for
        the real-time valuation of the quant.
     * @returns 
     */
    async _getAccountingDataForValuation() {
        this.ensureOne();
        let self = await this.withCompany(await this['companyId']);
        const accountsData = await (await (await self.productId).productTemplateId).getProductAccounts();

        const accSrc = await self._getSrcAccount(accountsData);
        const accDest = await self._getDestAccount(accountsData);

        let accValuation = accountsData['stockValuation'] ?? false;
        if (accValuation) {
            accValuation = accValuation.id;
        }
        if (! (accountsData['stockJournal'] ?? false)) {
            throw new UserError(await this._t('You don\'t have any stock journal defined on your product category, check if you have installed a chart of accounts.'));
        }
        if (! bool(accSrc)) {
            throw new UserError(await this._t('Cannot find a stock input account for the product %s. You must define one on the product category, or on the location, before processing this operation.', await (await this['productId']).displayName));
        }
        if (! bool(accDest)) {
            throw new UserError(await this._t('Cannot find a stock output account for the product %s. You must define one on the product category, or on the location, before processing this operation.', await (await this['productId']).displayName));
        }
        if (! bool(accValuation)) {
            throw new UserError(await this._t('You don\'t have any stock valuation account defined on your product category. You must define one before processing this operation.'));
        }
        const journalId = accountsData['stockJournal'].id
        return [journalId, accSrc, accDest, accValuation];
    }

    async _getSrcAccount(accountsData) {
        let id = (await (await this['locationId']).valuationOutAccountId).id
        return bool(id) ? id : accountsData['stockInput'].id;
    }

    async _getDestAccount(accountsData) {
        let id = (await (await this['locationDestId']).valuationInAccountId).id;
        return bool(id) ? id : accountsData['stockOutput'].id;
    }

    /**
     * Generate the account.move.line values to post to track the stock valuation difference due to the
        processing of the given quant.
     * @param qty 
     * @param cost 
     * @param creditAccountId 
     * @param debitAccountId 
     * @param description 
     * @returns 
     */
    async _prepareAccountMoveLine(qty, cost, creditAccountId, debitAccountId, description) {
        this.ensureOne();

        // the standardPrice of the product may be in another decimal precision, or not compatible with the coinage of
        // the company currency... so we need to use round() before creating the accounting entries.
        const debitValue = await (await (await this['companyId']).currencyId).round(cost);
        const creditValue = debitValue

        const valuationPartnerId = await this._getPartnerIdForValuationLines();
        const res = Object.values(await this._generateValuationLinesData(valuationPartnerId, qty, debitValue, creditValue, debitAccountId, creditAccountId, description)).map(lineVals => [0, 0, lineVals]);

        return res;
    }

    async _prepareAnalyticLine() {
        this.ensureOne();
        if (! await this._getAnalyticAccount()) {
            return false;
        }
        const [state] = await this('state');
        if (['cancel', 'draft'].includes(state)) {
            return false;
        }

        const [quantityDone, product, productUom, stockValuationLayerIds, analyticAccountLine] = await this('quantityDone', 'productId', 'productUom', 'stockValuationLayerIds', 'analyticAccountLineId');
        let [amount, unitAmount] = [0, 0];
        if (state !== 'done') {
            const unitAmount = await productUom._computeQuantity(quantityDone, await product.uomId);
            // Falsy in FIFO but since it's an estimation we don't require exact correct cost. Otherwise
            // we would have to recompute all the analytic estimation at each out.
            amount = - unitAmount * await product.standardPrice;
        }
        else if (await product.valuation === 'auto') {
            const accountsData = await (await product.productTemplateId).getProductAccounts();
            const accountValuation = accountsData['stockValuation'] ?? false;
            const lineIds = await (await stockValuationLayerIds.accountMoveId).lineIds;
            const analyticLineVals = await (await lineIds.filtered(async (l) => (await l.accountId).eq(accountValuation)))._prepareAnalyticLine();
            amount = - sum(analyticLineVals.map(vals => vals['amount']));
            unitAmount = - sum(analyticLineVals.map(vals => vals['unitAmount']));
        }
        else if (sum(await stockValuationLayerIds.mapped('quantity'))) {
            amount = sum(await stockValuationLayerIds.mapped('value'));
            unitAmount = - sum(await stockValuationLayerIds.mapped('quantity'));
        }
        if (analyticAccountLine.ok) {
            if (amount == 0 && unitAmount == 0) {
                await analyticAccountLine.unlink();
                return false;
            }
            await analyticAccountLine.update({unitAmount, amount});
            return false;
        }
        else if (amount) {
            return this._generateAnalyticLinesData(unitAmount, amount);
        }
    }

    async _generateAnalyticLinesData(unitAmount, amount) {
        this.ensureOne();
        const account = await this._getAnalyticAccount();
        return {
            'label': await this['label'],
            'amount': amount,
            'accountId': account.id,
            'unitAmount': unitAmount,
            'productId': (await this['productId']).id,
            'productUomId': (await (await this['productId']).uomId).id,
            'companyId': (await this['companyId']).id,
            'ref': this.cls._description,
            'category': 'other',
        }
    }

    async _generateValuationLinesData(partnerId, qty, debitValue, creditValue, debitAccountId, creditAccountId, description) {
        // This method returns a dictionary to provide an easy extension hook to modify the valuation lines (see purchase for an example)
        this.ensureOne();
        const [label, product] = await this('label', 'productId');
        const debitLineVals = {
            'label': description,
            'productId': product.id,
            'quantity': qty,
            'productUomId': (await product.uomId).id,
            'ref': description,
            'partnerId': partnerId,
            'debit': debitValue > 0 ? debitValue : 0,
            'credit': debitValue < 0 ? -debitValue : 0,
            'accountId': debitAccountId,
        }

        const creditLineVals = {
            'label': description,
            'productId': product.id,
            'quantity': qty,
            'productUomId': (await product.uomId).id,
            'ref': description,
            'partnerId': partnerId,
            'credit': creditValue > 0 ? creditValue : 0,
            'debit': creditValue < 0 ? -creditValue : 0,
            'accountId': creditAccountId,
        }

        const rslt = {'creditLineVals': creditLineVals, 'debitLineVals': debitLineVals}
        if (creditValue != debitValue) {
            // for supplier returns of product in average costing method, in anglo saxon mode
            const diffAmount = debitValue - creditValue;
            let priceDiffAccount = await product.propertyAccountCreditorPriceDifference

            if (! bool(priceDiffAccount)) {
                priceDiffAccount = await (await product.categId).propertyAccountCreditorPriceDifferenceCateg;
            }
            if (! bool(priceDiffAccount)) {
                throw new UserError(await this._t('Configuration error. Please configure the price difference account on the product or its category to process this operation.'));
            }
            rslt['priceDiffLineVals'] = {
                'label': label,
                'productId': product.id,
                'quantity': qty,
                'productUomId': (await product.uomId).id,
                'ref': description,
                'partnerId': partnerId,
                'credit': diffAmount > 0 && diffAmount || 0,
                'debit': diffAmount < 0 && -diffAmount || 0,
                'accountId': priceDiffAccount.id,
            }
        }
        return rslt;
    }

    async _getPartnerIdForValuationLines() {
        const partner = await (await this['pickingId']).partnerId;
        const res = partner.ok && this.env.items('res.partner')._findAccountingPartner(partner.id);
        return bool(res) ? res : false;
    }

    async _prepareMoveSplitVals(uomQty) {
        const vals = await _super(StockMove, this)._prepareMoveSplitVals(uomQty);
        vals['toRefund'] = await this['toRefund'];
        return vals;
    }

    async _prepareAccountMoveVals(creditAccountId, debitAccountId, journalId, qty, description, svlId, cost) {
        this.ensureOne();

        const moveLines = await this._prepareAccountMoveLine(qty, cost, creditAccountId, debitAccountId, description);
        const date = this._context['forcePeriodDate'] || await _Date.contextToday(this);
        return {
            'journalId': journalId,
            'lineIds': moveLines,
            'date': date,
            'ref': description,
            'stockMoveId': this.id,
            'stockValuationLayerIds': [[6, null, [svlId]]],
            'moveType': 'entry',
        }
    }

    async _accountAnalyticEntryMove() {
        const analyticLinesVals = [];
        const movesToLink = [];
        for (const move of this) {
            const analyticLineVals = await move._prepareAnalyticLine();
            if (! bool(analyticLineVals)) {
                continue;
            }
            movesToLink.push(move.id);
            analyticLinesVals.push(analyticLineVals);
        }
        const analyticLines = await (await this.env.items('account.analytic.line').sudo()).create(analyticLinesVals);
        for (const [moveId, analyticLine] of _.zip([...movesToLink], [...analyticLines])) {
            await this.env.items('stock.move').browse(moveId).set('analyticAccountLineId', analyticLine);
        }
    }

    /**
     * Accounting Valuation Entries
     * @param qty 
     * @param description 
     * @param svlId 
     * @param cost 
     * @returns 
     */
    async _accountEntryMove(qty, description, svlId, cost) {
        this.ensureOne();
        const [company, product, restrictPartner] = await this('companyId', 'productId', 'restrictPartnerId');
        const amVals = [];
        if (await product.type !== 'product') {
            // no stock valuation for consumable products
            return amVals;
        }
        if (restrictPartner.ok && !restrictPartner.eq(await company.partnerId)) {
            // if the move isn't owned by the company, we don't make any valuation
            return amVals;
        }

        const companyFrom = await this._isOut() && await this.mapped('moveLineIds.locationId.companyId') || false;
        const companyTo = await this._isIn() && await this.mapped('moveLineIds.locationDestId.companyId') || false;

        const [journalId, accSrc, accDest, accValuation] = await this._getAccountingDataForValuation();
        // Create Journal Entry for products arriving in the company; in case of routes making the link between several
        // warehouse of the same company, the transit location belongs to this company, so we don't need to create accounting entries
        if (await this._isIn()) {
            if (await this._isReturned('in')) {
                amVals.push(await (await this.withCompany(companyTo))._prepareAccountMoveVals(accDest, accValuation, journalId, qty, description, svlId, cost));
            }
            else {
                amVals.push(await (await this.withCompany(companyTo))._prepareAccountMoveVals(accSrc, accValuation, journalId, qty, description, svlId, cost));
            }
        }
        // Create Journal Entry for products leaving the company
        if (await this._isOut()) {
            cost = -1 * cost
            if (await this._isReturned('out')) {
                amVals.push(await (await this.withCompany(companyFrom))._prepareAccountMoveVals(accValuation, accSrc, journalId, qty, description, svlId, cost));
            }
            else {
                amVals.push(await (await this.withCompany(companyFrom))._prepareAccountMoveVals(accValuation, accDest, journalId, qty, description, svlId, cost));
            }
        }
        if (await company.angloSaxonAccounting) {
            // Creates an account entry from stockInput to stockOutput on a dropship move. 
            if (await this._isDropshipped()) {
                if (cost > 0) {
                    amVals.push(await (await this.withCompany(company))._prepareAccountMoveVals(accSrc, accValuation, journalId, qty, description, svlId, cost));
                }
                else {
                    cost = -1 * cost;
                    amVals.push(await (await this.withCompany(company))._prepareAccountMoveVals(accValuation, accDest, journalId, qty, description, svlId, cost));
                }
            }
            else if (await this._isDropshippedReturned()) {
                if (cost > 0 && await (await this['locationDestId'])._shouldBeValued()) {
                    amVals.push(await (await this.withCompany(company))._prepareAccountMoveVals(accValuation, accSrc, journalId, qty, description, svlId, cost));
                }
                else if (cost > 0) {
                    amVals.push(await (await this.withCompany(company))._prepareAccountMoveVals(accDest, accValuation, journalId, qty, description, svlId, cost));
                }
                else {
                    cost = -1 * cost;
                    amVals.push(await (await this.withCompany(company))._prepareAccountMoveVals(accValuation, accSrc, journalId, qty, description, svlId, cost));
                }
            }
        }
        return amVals;
    }

    async _getAnalyticAccount(): Promise<any> {
        return false;
    }

    /**
     * This method is overrided in both purchase and sale_stock modules to adapt
        to the way they mix stock moves with invoices.
     * @returns 
     */
    async _getRelatedInvoices() {  // To be overridden in purchase and sale_stock
        return this.env.items('account.move');
    }

    async _isReturned(valuedType) {
        this.ensureOne();
        const [location, locationDest] = await this('locationId', 'locationDestId');
        if (valuedType === 'in') {
            return location.ok && await location.usage === 'customer';   // goods returned from customer;
        }
        if (valuedType === 'out') {
            return locationDest.ok && await locationDest.usage == 'supplier';   // goods returned to supplier
        }
    }
}