import { Fields } from "../../../core";
import { MetaModel, Model, _super } from "../../../core/models";
import { bool, floatIsZero } from "../../../core/tools";

@MetaModel.define()
class AccountMove extends Model {
    static _module = module;
    static _parents = 'account.move';

    static stockMoveId = Fields.Many2one('stock.move', { string: 'Stock Move', index: true });
    static stockValuationLayerIds = Fields.One2many('stock.valuation.layer', 'accountMoveId', { string: 'Stock Valuation Layer' });

    // -------------------------------------------------------------------------
    // OVERRIDE METHODS
    // -------------------------------------------------------------------------

    async _getLinesOnchangeCurrency() {
        // OVERRIDE
        return (await this['lineIds']).filtered(async (l) => ! await l.isAngloSaxonLine);
    }

    async _reverseMoveVals(defaultValues, cancel = true) {
        // OVERRIDE
        // Don't keep anglo-saxon lines if not cancelling an existing invoice.
        const moveVals = await _super(AccountMove, this)._reverseMoveVals(defaultValues, cancel);
        if (!cancel) {
            moveVals['lineIds'] = moveVals['lineIds'].filter(vals => !vals[2]['isAngloSaxonLine']);
        }
        return moveVals;
    }

    async copyData(defaultValue?: any) {
        // OVERRIDE
        // Don't keep anglo-saxon lines when copying a journal entry.
        const res = await _super(AccountMove, this).copyData(defaultValue);

        if (!this._context['moveReverseCancel']) {
            for (const copyVals of res) {
                if ('lineIds' in copyVals) {
                    copyVals['lineIds'] = copyVals['lineIds'].filter(lineVals => lineVals[0] != 0 || !lineVals[2]['isAngloSaxonLine']);
                }
            }
        }
        return res;
    }

    async _post(soft = true) {
        // OVERRIDE

        // Don't change anything on moves used to cancel another ones.
        if (this._context['moveReverseCancel']) {
            return _super(AccountMove, this)._post(soft);
        }

        // Create additional COGS lines for customer invoices.
        await this.env.items('account.move.line').create(await this._stockAccountPrepareAngloSaxonOutLinesVals());

        // Post entries.
        const posted = await _super(AccountMove, this)._post(soft);

        // Reconcile COGS lines in case of anglo-saxon accounting with perpetual valuation.
        await posted._stockAccountAngloSaxonReconcileValuation();
        return posted;
    }

    async buttonDraft() {
        const res = await _super(AccountMove, this).buttonDraft();

        // Unlink the COGS lines generated during the 'post' method.
        await (await (await this.mapped('lineIds')).filtered(line => line.isAngloSaxonLine)).unlink();
        return res;
    }

    async buttonCancel() {
        // OVERRIDE
        const res = await _super(AccountMove, this).buttonCancel();

        // Unlink the COGS lines generated during the 'post' method.
        // In most cases it shouldn't be necessary since they should be unlinked with 'button_draft'.
        // However, since it can be called in RPC, better be safe.
        await (await (await this.mapped('lineIds')).filtered(line => line.isAngloSaxonLine)).unlink();
        return res;
    }

    // -------------------------------------------------------------------------
    // COGS METHODS
    // -------------------------------------------------------------------------

    /**
     * Prepare values used to create the journal items (account.move.line) corresponding to the Cost of Good Sold
        lines (COGS) for customer invoices.

        Example:

        Buy a product having a cost of 9 being a storable product and having a perpetual valuation in FIFO.
        Sell this product at a price of 10. The customer invoice's journal entries looks like:

        Account                                     | Debit | Credit
        ---------------------------------------------------------------
        200000 Product Sales                        |       | 10.0
        ---------------------------------------------------------------
        101200 Account Receivable                   | 10.0  |
        ---------------------------------------------------------------

        This method computes values used to make two additional journal items:

        ---------------------------------------------------------------
        220000 Expenses                             | 9.0   |
        ---------------------------------------------------------------
        101130 Stock Interim Account (Delivered)    |       | 9.0
        ---------------------------------------------------------------

        Note: COGS are only generated for customer invoices except refund made to cancel an invoice.

        :return: A list of dictionary to be passed to env['account.move.line'].create.
     */
    async _stockAccountPrepareAngloSaxonOutLinesVals() {
        const linesValsList = [];
        const priceUnitPrec = await this.env.items('decimal.precision').precisionGet('Product Price');
        for (let move of this) {
            // Make the loop multi-company safe when accessing models like product.product
            move = await move.withCompany(await move.companyId);

            if (! await move.isSaleDocument(true) || ! await (await move.companyId).angloSaxonAccounting) {
                continue;
            }

            for (const line of await move.invoiceLineIds) {
                // Filter out lines being not eligible for COGS.
                if (! await line._eligibleForCogs()) {
                    continue;
                }

                // Retrieve accounts needed to generate the COGS.
                const accounts = await (await (await line.productId).productTemplateId).getProductAccounts(await move.fiscalPositionId);
                let debitInterimAccount = accounts['stockOutput'];
                const creditExpenseAccount = accounts['expense'] || await (await move.journalId).defaultAccountId;
                if (!bool(debitInterimAccount) || !bool(creditExpenseAccount)) {
                    continue;
                }

                // Compute accounting fields.
                const sign = await move.moveType == 'outRefund' ? -1 : 1;
                const priceUnit = await line._stockAccountGetAngloSaxonPriceUnit();
                const balance = sign * (await line.quantity) * priceUnit;

                if (await (await move.currency_idC).isZero(balance) || floatIsZero(priceUnit, { precisionDigits: priceUnitPrec })) {
                    continue;
                }

                // Add interim account line.
                linesValsList.push({
                    'label': (await line.label).slice(0, 64),
                    'moveId': move.id,
                    'partnerId': (await move.commercialPartnerId).id,
                    'productId': (await line.productId).id,
                    'productUomId': (await line.productUomId).id,
                    'quantity': await line.quantity,
                    'priceUnit': priceUnit,
                    'debit': balance < 0.0 && -balance || 0.0,
                    'credit': balance > 0.0 && balance || 0.0,
                    'accountId': debitInterimAccount.id,
                    'excludeFromInvoiceTab': true,
                    'isAngloSaxonLine': true,
                });

                // Add expense account line.
                linesValsList.push({
                    'label': (await line.label).slice(0, 64),
                    'moveId': move.id,
                    'partnerId': (await move.commercialPartnerId).id,
                    'productId': (await line.productId).id,
                    'productUomId': (await line.productUomId).id,
                    'quantity': await line.quantity,
                    'priceUnit': -priceUnit,
                    'debit': balance > 0.0 && balance || 0.0,
                    'credit': balance < 0.0 && -balance || 0.0,
                    'accountId': creditExpenseAccount.id,
                    'analyticAccountId': (await line.analyticAccountId).id,
                    'analyticTagIds': [[6, 0, (await line.analyticTagIds).ids]],
                    'excludeFromInvoiceTab': true,
                    'isAngloSaxonLine': true,
                })
            }
        }
        return linesValsList;
    }

    /**
     * To be overridden for customer invoices and vendor bills in order to
        return the stock moves related to the invoices in self.
     * @returns 
     */
    async _stockAccountGetLastStepStockMoves() {
        return this.env.items('stock.move');
    }

    /**
     * Reconciles the entries made in the interim accounts in anglosaxon accounting,
        reconciling stock valuation move lines with the invoice's.
     * @param product 
     */
    async _stockAccountAngloSaxonReconcileValuation(product?: any) {
        for (const move of this) {
            if (! await move.isInvoice()) {
                continue;
            }
            if (! await (await move.companyId).angloSaxonAccounting) {
                continue;
            }

            let stockMoves = await move._stockAccountGetLastStepStockMoves();

            if (!bool(stockMoves)) {
                continue;
            }

            const products = bool(product) ? product : await move.mapped('invoiceLineIds.productId');
            for (const prod of products) {
                if (await prod.valuation !== 'auto') {
                    continue;
                }

                // We first get the invoices move lines (taking the invoice and the previous ones into account)...
                const productAccounts = await (await prod.productTemplateId)._getProductAccounts();
                let productInterimAccount;
                if (await move.isSaleDocument()) {
                    productInterimAccount = productAccounts['stockOutput'];
                }
                else {
                    productInterimAccount = productAccounts['stockInput'];
                }

                if (await productInterimAccount.reconcile) {
                    // Search for anglo-saxon lines linked to the product in the journal entry.
                    let productAccountMoves = await (await move.lineIds).filtered(
                        async (line) => (await line.productId).eq(prod) && (await line.accountId).eq(productInterimAccount) && !bool(await line.reconciled)
                    );

                    // Search for anglo-saxon lines linked to the product in the stock moves.
                    const productStockMoves = await stockMoves._filterByProduct(prod);
                    productAccountMoves = productAccountMoves.concat(await (productStockMoves.mapped('accountMoveIds.lineIds'))
                        .filtered(async (line) => (await line.accountId).eq(productInterimAccount) && ! await line.reconciled)
                    );
                    // Reconcile.
                    await productAccountMoves.reconcile();
                }
            }
        }
    }

    async _getInvoicedLotValues() {
        return [];
    }
}

@MetaModel.define()
class AccountMoveLine extends Model {
    static _module = module;
    static _parents = 'account.move.line';

    static isAngloSaxonLine = Fields.Boolean({ help: "Technical field used to retrieve the anglo-saxon lines." });

    async _getComputedAccount() {
        // OVERRIDE to use the stock input account by default on vendor bills when dealing
        // with anglo-saxon accounting.
        this.ensureOne();
        let self = await this.withCompany(await (await (await this['moveId']).journalId).companyId);
        if (self._canUseStockAccounts()
            && await (await (await self.moveId).companyId).angloSaxonAccounting
            && await (await self.moveId).isPurchaseDocument()) {
            const fiscalPosition = await (await self.moveId).fiscalPositionId;
            const accounts = await (await (await self.productId).productTemplateId).getProductAccounts(fiscalPosition);
            if (accounts['stockInput']) {
                return accounts['stockInput'];
            }
        }
        return _super(AccountMoveLine, self)._getComputedAccount();
    }

    async _eligibleForCogs() {
        this.ensureOne();
        const product = await this['productId'];
        return await product.type === 'product' && await product.valuation === 'auto';
    }

    async _canUseStockAccounts() {
        const product = await this['productId'];
        return await product.type === 'product' && await (await product.categId).propertyValuation === 'auto';
    }

    async _stockAccountGetAngloSaxonPriceUnit() {
        this.ensureOne();
        const product = await this['productId'];
        if (!product.ok) {
            return this['priceUnit'];
        }
        let originalLine = await (await (await this['moveId']).reversedEntryId.lineIds).filtered(async (l) => await l.isAngloSaxonLine
            && (await l.productId).eq(product)
            && (await l.productUomId).eq(await this['productUomId'])
            && await l.priceUnit >= 0
        );
        originalLine = bool(originalLine) && originalLine[0];
        return originalLine.ok ? await originalLine.priceUnit : await (await product.withCompany(await this['companyId']))._stockAccountGetAngloSaxonPriceUnit(await this['productUomId']);
    }
}