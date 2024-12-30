import { Fields } from "../../../core";
import { MetaModel, Model } from "../../../core/models"
import { bool, createIndex, extend, floatCompare, floatIsZero, sum } from "../../../core/tools";

/**
 * Stock Valuation Layer
 */
@MetaModel.define()
class StockValuationLayer extends Model {
    static _module = module;
    static _name = 'stock.valuation.layer';
    static _description = 'Stock Valuation Layer';
    static _order = 'createdAt, id';

    static _recName = 'productId';

    static companyId = Fields.Many2one('res.company', {string: 'Company', readonly: true, required: true});
    static productId = Fields.Many2one('product.product', {string: 'Product', readonly: true, required: true, checkCompany: true, autojoin: true});
    static categId = Fields.Many2one('product.category', {related: 'productId.categId'});
    static productTemplateId = Fields.Many2one('product.template', {related: 'productId.productTemplateId'});
    static quantity = Fields.Float('Quantity', {help: 'Quantity', readonly: true, digits: 'Product Unit of Measure'});
    static uomId = Fields.Many2one({related: 'productId.uomId', readonly: true, required: true});
    static currencyId = Fields.Many2one('res.currency', {string: 'Currency', related: 'companyId.currencyId', readonly: true, required: true});
    static unitCost = Fields.Monetary('Unit Value', {readonly: true});
    static value = Fields.Monetary('Total Value', {readonly: true});
    static remainingQty = Fields.Float({readonly: true, digits: 'Product Unit of Measure'});
    static remainingValue = Fields.Monetary('Remaining Value', {readonly: true});
    static description = Fields.Char('Description', {readonly: true});
    static stockValuationLayerId = Fields.Many2one('stock.valuation.layer', {string: 'Linked To', readonly: true, checkCompany: true, index: true});
    static stockValuationLayerIds = Fields.One2many('stock.valuation.layer', 'stockValuationLayerId');
    static stockMoveId = Fields.Many2one('stock.move', {string: 'Stock Move', readonly: true, checkCompany: true, index: true});
    static accountMoveId = Fields.Many2one('account.move', {string: 'Journal Entry', readonly: true, checkCompany: true, index: true});

    async init() {
        await createIndex(
            this._cr, 'stockValuationLayerIndex',
            this.cls._table, ['"productId"', '"remainingQty"', '"stockMoveId"', '"companyId"', '"createdAt"']
        );
    }

    async _validateAccountingEntries() {
        let amVals = [];
        for (const svl of this) {
            if (await (await (await svl.withCompany(svl.companyId)).productId).valuation !== 'auto') {
                continue;
            }
            if (await (await svl.currencyId).isZero(await svl.value)) {
                continue;
            }
            extend(amVals, await (await (await svl.stockMoveId).withCompany(await svl.companyId))._accountEntryMove(await svl.quantity, await svl.description, svl.id, await svl.value));
        }
        if (amVals.length) {
            const accountMoves = await (await this.env.items('account.move').sudo()).create(amVals);
            await accountMoves._post()
        }
        for (const svl of this) {
            // Eventually reconcile together the invoice and valuation accounting entries on the stock interim accounts
            if (await (await svl.companyId).angloSaxonAccounting) {
                await (await (await svl.stockMoveId)._getRelatedInvoices())._stockAccountAngloSaxonReconcileValuation(await svl.productId);
            }
        }
    }

    async _validateAnalyticAccountingEntries() {
        for (const svl of this) {
            await (await svl.stockMoveId)._accountAnalyticEntryMove();
        }
    }

    /**
     * Iterate on the SVL to first skip the qty already valued. Then, keep
        iterating to consume `qty_to_value` and stop
        The method returns the valued quantity and its valuation
     * @param qtyValued 
     * @param qtyToValue 
     * @returns 
     */
    async _consumeSpecificQty(qtyValued, qtyToValue) {
        if (this.nok) {
            return [0, 0];
        }
        const [product, uom] = await this('uomId');
        const rounding = await (await product.uomId).rounding;
        let qtyToTakeOnCandidates = qtyToValue;
        let tmpValue = 0;  // to accumulate the value taken on the candidates
        for (const candidate of this) {
            if (floatIsZero(await candidate.quantity, {precisionRounding: rounding})) {
                continue;
            }
            let candidateQuantity = Math.abs(await candidate.quantity);
            const returnedQty = await (await (await (await candidate.stockMoveId).returnedMoveIds).filtered(async (sm) => await sm.state === 'done')).sum(async (sm) => await (await sm.productUom)._computeQuantity(await sm.quantityDone, uom));
            candidateQuantity -= returnedQty;
            if (floatIsZero(candidateQuantity, {precisionRounding: rounding})) {
                continue;
            }
            if (!floatIsZero(qtyValued, {precisionRounding: rounding})) {
                const qtyIgnored = Math.min(qtyValued, candidateQuantity);
                qtyValued -= qtyIgnored;
                candidateQuantity -= qtyIgnored;
                if (floatIsZero(candidateQuantity, {precisionRounding: rounding})) {
                    continue;
                }
            }
            const qtyTakenOnCandidate = Math.min(qtyToTakeOnCandidates, candidateQuantity);

            qtyToTakeOnCandidates -= qtyTakenOnCandidate;
            tmpValue += qtyTakenOnCandidate * ((await candidate.value + sum(await candidate.stockValuationLayerIds.mapped('value'))) / await candidate.quantity);
            if (floatIsZero(qtyToTakeOnCandidates, {precisionRounding: rounding})) {
                break;
            }
        }
        return [qtyToValue - qtyToTakeOnCandidates, tmpValue];
    }

    /**
     * The method consumes all svl to get the total qty/value. Then it deducts
        the already consumed qty/value. Finally, it tries to consume the `qty_to_value`
        The method returns the valued quantity and its valuation
     * @param qtyValued 
     * @param valued 
     * @param qtyToValue 
     * @returns 
     */
    async _consumeAll(qtyValued, valued, qtyToValue) {
        if (this.nok) {
            return [0, 0];
        }

        const rounding = await (await (await this['productId']).uomId).rounding;
        let qtyTotal = -qtyValued;
        let valueTotal = -valued;
        let newValuedQty = 0;
        let newValuation = 0;

        const uom = await this['uomId'];
        for (const svl of this) {
            if (floatIsZero(await svl.quantity, {precisionRounding: rounding})) {
                continue;
            }
            let relevantQty = Math.abs(await svl.quantity);
            const returnedQty = await (await (await (await svl.stockMoveId).returnedMoveIds).filtered(async (sm) => await sm.state === 'done')).sum(async (sm) => await (await sm.productUom)._computeQuantity(await sm.quantityDone, uom));
            relevantQty -= returnedQty;
            if (floatIsZero(relevantQty, {precisionRounding: rounding})) {
                continue;
            }
            qtyTotal += relevantQty;
            valueTotal += relevantQty * ((await svl.value + sum(await (await svl.stockValuationLayerIds).mapped('value'))) / await svl.quantity)
        }

        if (floatCompare(qtyTotal, 0, {precisionRounding: rounding}) > 0) {
            const unitCost = valueTotal / qtyTotal;
            const newValuedQty = Math.min(qtyTotal, qtyToValue);
            newValuation = unitCost * newValuedQty;
        }

        return [newValuedQty, newValuation];
    }
}