import { api } from "../../../core";
import { MetaModel, Model, _super } from "../../../core/models"
import { floatCompare, floatIsZero } from "../../../core/tools";

@MetaModel.define()
class StockMoveLine extends Model {
    static _module = module;
    static _parents = 'stock.move.line';

    // -------------------------------------------------------------------------
    // CRUD
    // -------------------------------------------------------------------------
    @api.modelCreateMulti()
    async create(valsList) {
        const analyticMoveToRecompute = new Set();
        const moveLines = await _super(StockMoveLine, this).create(valsList);
        for (const moveLine of moveLines) {
            const move = await moveLine.moveId;
            analyticMoveToRecompute.add(move.id);
            if (await moveLine.state != 'done') {
                continue;
            }
            const rounding = await (await (await move.productId).uomId).rounding;
            const diff = await (await move.productUom)._computeQuantity(await moveLine.qtyDone, await (await move.productId).uomId);
            if (floatIsZero(diff, {precisionRounding: rounding})) {
                continue;
            }
            await this._createCorrectionSvl(move, diff);
        }
        if (analyticMoveToRecompute.size) {
            await this.env.items('stock.move').browse(analyticMoveToRecompute)._accountAnalyticEntryMove();
        }
        return moveLines;
    }

    async write(vals) {
        const analyticMoveToRecompute = new Set();
        if ('qtyDone' in vals || 'moveId' in vals) {
            for (const moveLine of this) {
                const moveId = vals['moveId'] ? vals['moveId'] : (await moveLine.moveId).id;
                analyticMoveToRecompute.add(moveId);
            }
        }
        if ('qtyDone' in vals) {
            for (const moveLine of this) {
                if (await moveLine.state !== 'done') {
                    continue;
                }
                const move = await moveLine.moveId;
                if (floatCompare(vals['qty_done'], await moveLine.qtyDone, {precisionRounding: await (await move.productUom).rounding}) == 0) {
                    continue;
                }
                const rounding = await (await (move.productId).uomId).rounding;
                const diff = await (await move.productUom)._computeQuantity(vals['qtyDone'] - await moveLine.qtyDone, await (await move.productId).uomId, {roundingMethod: 'HALF-UP'});
                if (floatIsZero(diff, {precisionRounding: rounding})) {
                    continue;
                }
                await (this as any)._createCorrectionSvl(move, diff);
            }
        }
        const res = await _super(StockMoveLine, this).write(vals);
        if (analyticMoveToRecompute.size) {
            await this.env.items('stock.move').browse(analyticMoveToRecompute)._accountAnalyticEntryMove();
        }
        return res;
    }

    // -------------------------------------------------------------------------
    // SVL creation helpers
    // -------------------------------------------------------------------------
    @api.model()
    async _createCorrectionSvl(move, diff) {
        let stockValuationLayers = this.env.items('stock.valuation.layer');
        if (await move._isIn() && diff > 0 || await move._isOut() && diff < 0) {
            await move.productPriceUpdateBeforeDone(diff);
            stockValuationLayers = stockValuationLayers.or(await move._createInSvl(Math.abs(diff)));
            if (['average', 'fifo'].includes(await (await move.productId).costMethod)) {
                await (await move.productId)._runFifoVacuum(await move.companyId);
            }
        }
        else if (move._isIn() && diff < 0 || await move._isOut() && diff > 0) {
            stockValuationLayers = stockValuationLayers.or(await move._createOutSvl(Math.abs(diff)));
        }
        else if (await move._isDropshipped() && diff > 0 || await move._isDropshippedReturned() && diff < 0) {
            stockValuationLayers = stockValuationLayers.or(await move._createDropshippedSvl(Math.abs(diff)));
        }
        else if (await move._isDropshipped() && diff < 0 || await move._isDropshippedReturned() && diff > 0) {
            stockValuationLayers = stockValuationLayers.or(await move._createDropshippedReturnedSvl(Math.abs(diff)));
        }
        await stockValuationLayers._validateAccountingEntries();
    }    
}

