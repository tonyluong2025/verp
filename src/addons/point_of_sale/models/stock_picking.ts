import _ from "lodash";
import { Fields, api } from "../../../core";
import { DefaultDict2, Dict, MapDefaultKey, MapKey, UserError, ValidationError } from "../../../core/helper";
import { MetaModel, Model, _super } from "../../../core/models"
import { bool, extend, floatCompare, floatIsZero, groupbyAsync, isInstance, parseInt, range, sortedAsync, sum, update } from "../../../core/tools";

@MetaModel.define()
class StockPicking extends Model {
    static _module = module;
    static _parents = 'stock.picking';

    static posSessionId = Fields.Many2one('pos.session', {index: true});
    static posOrderId = Fields.Many2one('pos.order', {index: true});

    async _preparePickingVals(partner, pickingType, locationId, locationDestId) {
        return {
            'partnerId': bool(partner) ? partner.id : false,
            'userId': false,
            'pickingTypeId': pickingType.id,
            'moveType': 'direct',
            'locationId': locationId,
            'locationDestId': locationDestId,
        }
    }

    /**
     * We'll create some picking based on order_lines
     * @param locationDestId 
     * @param lines 
     * @param pickingType 
     * @param partner 
     * @returns 
     */
    @api.model()
    async _createPickingFromPosOrderLines(locationDestId, lines, pickingType, partner?: any) {
        let pickings = this.env.items('stock.picking');
        const stockableLines = await lines.filtered(async (l) => ['product', 'consu'].includes(await (await l.productId).type) && !floatIsZero(await l.qty, {precisionRounding: await (await (await l.productId).uomId).rounding}));
        if (!bool(stockableLines)) {
            return pickings;
        }
        const positiveLines = await stockableLines.filtered(async (l) => await l.qty > 0);
        const negativeLines = stockableLines.sub(positiveLines);

        if (bool(positiveLines)) {
            const locationId = await (await pickingType.defaultLocationSrcId).id;
            const positivePicking = await this.env.items('stock.picking').create(
                await this._preparePickingVals(partner, pickingType, locationId, locationDestId)
            );

            await positivePicking._createMoveFromPosOrderLines(positiveLines);
            await this.env.items('base').flush();
            try {
                // with self.env.cr.savepoint():
                    await positivePicking._actionDone();
            } catch(e) {
                if (!isInstance(e, UserError, ValidationError)) {
                    throw e;
                }
            }

            pickings = pickings.or(positivePicking);
        }
        if (bool(negativeLines)) {
            let returnPickingType = await pickingType.returnPickingTypeId;
            let returnLocationId;
            if (returnPickingType.ok) {
                returnLocationId = (await returnPickingType.defaultLocationDestId).id;
            }
            else {
                returnPickingType = pickingType;
                returnLocationId = (await pickingType.defaultLocationSrcId).id;
            }

            const negativePicking = await this.env.items('stock.picking').create(
                await this._preparePickingVals(partner, returnPickingType, locationDestId, returnLocationId)
            );
            await negativePicking._createMoveFromPosOrderLines(negativeLines);
            await this.env.items('base').flush();
            try {
                // with self.env.cr.savepoint():
                    await negativePicking._actionDone();
            } catch(e) {
                if (!isInstance(e, UserError, ValidationError)) {
                    throw e;
                }
            }
            pickings = pickings.or(negativePicking);
        }
        return pickings;
    }

    async _prepareStockMoveVals(firstLine, orderLines) {
        return {
            'label': await firstLine.label,
            'productUom': (await (await firstLine.productId).uomId).id,
            'pickingId': this.id,
            'pickingTypeId': (await this['pickingTypeId']).id,
            'productId': (await firstLine.productId).id,
            'productUomQty': Math.abs(sum(await orderLines.mapped('qty'))),
            'state': 'draft',
            'locationId': (await this['locationId']).id,
            'locationDestId': (await this['locationDestId']).id,
            'companyId': (await this['companyId']).id,
        }
    }

    async _createMoveFromPosOrderLines(lines) {
        this.ensureOne();
        const linesByProduct = await groupbyAsync(await sortedAsync(lines, async (l) => (await l.productId).id), async (l) => (await l.productId).id);
        const moveVals = [];
        for (const [dummy, olines] of linesByProduct) {
            const orderLines = this.env.items('pos.order.line').concat(...olines);
            moveVals.push(await this._prepareStockMoveVals(orderLines[0], orderLines));
        }
        const moves = await this.env.items('stock.move').create(moveVals);
        const confirmedMoves = await moves._actionConfirm();
        await confirmedMoves._addMlsRelatedToOrder(lines, true);
        await this._linkOwnerOnReturnPicking(lines);
    }

    /**
     * This method tries to retrieve the owner of the returned product
     * @param lines 
     * @returns 
     */
    async _linkOwnerOnReturnPicking(lines) {
        const pickingIds = await (await (await lines[0].orderId).refundedOrderIds).pickingIds;
        if (bool(pickingIds)) {
            const returnedLinesPicking = pickingIds,
            returnableQtyByProduct = new MapKey(item => String(item));
            for (const moveLine of await returnedLinesPicking.moveLineIds) {
                const [product, owner, qtyDone] = await moveLine('productId', 'ownerId', 'qtyDone');
                returnableQtyByProduct.set([product.id, bool(owner.id) ? owner.id : 0], qtyDone);
            }
            for (const move of await this['moveLineIds']) {
                for (const [keys, val] of returnableQtyByProduct) {
                    if ((await move.productId).id == keys[0] && bool(keys[1]) && val > 0) {
                        await move.write({'ownerId': keys[1]});
                        returnableQtyByProduct.set(keys, val - await move.productUomQty);
                    }
                }
            }
        }
    }

    async _sendConfirmationEmail() {
        // Avoid sending Mail/SMS for POS deliveries
        const pickings = await this.filtered(async (p) => !(await p.pickingTypeId).eq(await (await (await p.pickingTypeId).warehouseId).posTypeId));
        return _super(StockPicking, pickings)._sendConfirmationEmail();
    }

    async _actionDone() {
        const res = await _super(StockPicking, this)._actionDone();
        for (const rec of this) {
            if (await (await rec.pickingTypeId).code !== 'outgoing') {
                continue;
            }
            const posOrder = await rec.posOrderId;
            if (await posOrder.toShip && ! await posOrder.toInvoice) {
                const costPerAccount = new MapDefaultKey(() => 0.0, (items) => String(items.map(i => i.id)));
                for (const line of await posOrder.lines) {
                    const product = await line.productId;
                    if (await product.type !== 'product' || await product.valuation !== 'auto') {
                        continue;
                    }
                    const out = await (await product.categId).propertyStockAccountOutputCategId;
                    const exp = (await product._getProductAccounts())['expense'];
                    costPerAccount.set([out, exp], costPerAccount.get([out, exp]) + await line.totalCost);
                }
                const moveVals = [];
                for (const [[outAcc, expAcc], cost] of costPerAccount) {
                    await moveVals.push({
                        'journalId': (await posOrder.saleJournal).id,
                        'date': await posOrder.dateOrder,
                        'ref': 'posOrder_'+String(posOrder.id),
                        'lineIds': [
                            [0, 0, {
                                'label': await posOrder.label,
                                'accountId': expAcc.id,
                                'debit': cost,
                                'credit': 0.0,
                            }],
                            [0, 0, {
                                'label': posOrder.label,
                                'accountId': outAcc.id,
                                'debit': 0.0,
                                'credit': cost,
                            }],
                        ],
                    });
                }
                const move = await this.env.items('account.move').create(moveVals);
                await move.actionPost();
            }
        }
        return res;
    }
}

@MetaModel.define()
class ProcurementGroup extends Model{
    static _module = module;
    static _parents = 'procurement.group';

    static posOrderId = Fields.Many2one('pos.order', {string: 'POS Order'});
}

@MetaModel.define()
class StockMove extends Model {
    static _module = module;
    static _parents = 'stock.move';

    async _getNewPickingValues() {
        const vals = await _super(StockMove, this)._getNewPickingValues();
        vals['posSessionId'] = (await this.mapped('groupId.posOrderId.sessionId')).id
        vals['posOrderId'] = (await this.mapped('groupId.posOrderId')).id
        return vals;
    }

    async _keyAssignPicking() {
        const keys = await _super(StockMove, this)._keyAssignPicking();
        return keys.concat([await (await this['groupId']).posOrderId]);
    }

    @api.model()
    async _prepareLinesDataDict(orderLines) {
        const linesData = new DefaultDict2(() => new Dict());
        for (const [productId, olines] of await groupbyAsync(await sortedAsync(orderLines, async (l) => (await l.productId).id), async (l) => (await l.productId).id)) {
            update(linesData[productId], {'orderLines': this.env.items('pos.order.line').concat(...olines)});
        }
        return linesData;
    }

    async _completeDoneQties(setQuantityDoneOnMove=false) {
        await (this as any)._actionAssign();
        for (const moveLine of await this['moveLineIds']) {
            await moveLine.set('qtyDone', await moveLine.productUomQty);
        }
        const mlsVals = [],
        movesToSet = new Set();
        for (const move of this) {
            const [productUomQty, quantityDone] = await move('productUomQty', 'quantityDone');
            if (floatCompare(productUomQty, quantityDone, {precisionRounding: await (await move.productUom).rounding}) > 0) {
                const remainingQty = productUomQty - quantityDone;
                mlsVals.push(Object.assign({}, await move._prepareMoveLineVals(), {qtyDone: remainingQty}));
                movesToSet.add(move.id);
            }
        }
        await this.env.items('stock.move.line').create(mlsVals);
        if (setQuantityDoneOnMove) {
            for (const move of this.env.items('stock.move').browse(movesToSet)) {
                await move.set('quantityDone', await move.productUomQty);
            }
        }
    }

    /**
     * Search for existing lots and create missing ones.

            :param lines: pos order lines with pack lot ids.
            :type lines: pos.order.line recordset.

            :return stock.product.lot recordset.
     * @param lines 
     * @returns 
     */
    async _createProductionLotsForPosOrder(lines) {
        let validLots = this.env.items('stock.production.lot'),
        moves = await this.filtered(async (m) => (await m.pickingTypeId).useExistingLots);
        // Already called in self._action_confirm() but just to be safe when coming from _launch_stock_rule_from_pos_order_lines.
        await this._checkCompany();
        if (moves.ok) {
            let movesProductIds = new Set((await moves.mapped('productId')).ids);
            const lots = await (await lines.packLotIds).filtered(async (l) => await l.lotName && movesProductIds.has((await l.productId).id));
            const lotsData = new Set<string>(await lots.mapped(async (l) => [(await l.productId).id, await l.lotName].join(',')));
            const existingLots = await this.env.items('stock.production.lot').search([
                ['companyId', '=', (await (await moves[0].pickingTypeId).companyId).id],
                ['productId', 'in', (await lines.productId).ids],
                ['label', 'in', await lots.mapped('lotName')],
            ]);
            //The previous search may return (productId.id, lotName) combinations that have no matching in lines.packLotIds.
            for (const lot of existingLots) {
                const key = [(await lot.productId).id, await lot.label].join(',');
                if (lotsData.has(key)) {
                    validLots = validLots.or(lot);
                    lotsData.delete(key);
                }
            }
            moves = await moves.filtered(async (m) => await (await m.pickingTypeId).useCreateLots);
            if (moves.ok) {
                movesProductIds = new Set((await moves.mapped('productId')).ids);
                const missingLotValues = [];
                const company = await this['companyId']
                for (const [lotProductId, lotName] of Array.from(lotsData).map(l => l.split(',')).filter(l => movesProductIds.has(parseInt(l[0])))) {
                    missingLotValues.push({'companyId': company.id, 'productId': parseInt(lotProductId), 'label': lotName});
                }
                validLots = validLots.or(await this.env.items('stock.production.lot').create(missingLotValues));
            }
        }
        return validLots;
    }

    async _addMlsRelatedToOrder(relatedOrderLines, areQtiesDone=true) {
        const linesData = await this._prepareLinesDataDict(relatedOrderLines);
        const qtyFname = areQtiesDone ? 'qtyDone' : 'productUomQty';
        // Moves with productId not in related_order_lines. This can happend e.g. when productId has a phantom-type bom.
        const movesToAssign = await this.filtered(async (m) => !linesData.has((await m.productId).id) || await (await m.productId).tracking === 'none' || (! await (await m.pickingTypeId).useExistingLots && ! await (await m.pickingTypeId).useCreateLots));
        await movesToAssign._completeDoneQties(true);
        const movesRemaining = this.sub(movesToAssign),
        existingLots = await movesRemaining._createProductionLotsForPosOrder(relatedOrderLines),
        moveLinesToCreate = [],
        mlsQties = [];
        if (areQtiesDone) {
            for (const move of movesRemaining) {
                for (const line of linesData[(await move.productId).id]['orderLines']) {
                    let sumOfLots = 0;
                    for (const lot of await (await line.packLotIds).filtered(l => l.lotName)) {
                        const product = await line.productId;
                        let qty;
                        if (await product.tracking === 'serial') {
                            qty = 1;
                        }
                        else {
                            qty = Math.abs(await line.qty);
                        }
                        const mlVals = Object.assign({}, await move._prepareMoveLineVals());
                        if (bool(existingLots)) {
                            const existingLot = await existingLots.filteredDomain([['productId', '=', product.id], ['label', '=', await lot.lotName]]);
                            let quant = this.env.items('stock.quant');
                            if (bool(existingLot)) {
                                quant = await quant.search(
                                    [['lotId', '=', existingLot.id], ['quantity', '>', '0.0'], ['locationId', 'childOf', (await move.locationId).id]],
                                    {order: 'id desc', limit: 1}
                                );
                            }
                            const [location, owner] = await quant('locationId', 'ownerId');
                            update(mlVals, {
                                'lotId': existingLot.id,
                                'locationId': bool(location.id) ? location.id : (await move.locationId).id,
                                'ownerId': bool(owner.id) ? owner.id : false,
                            });
                        }
                        else {
                            update(mlVals, {'lotName': await lot.lotName});
                        }
                        moveLinesToCreate.push(mlVals);
                        mlsQties.push(qty);
                        sumOfLots += qty;
                    }
                    if (Math.abs(await line.qty) != sumOfLots) {
                        const differenceQty = Math.abs(await line.qty) - sumOfLots;
                        const mlVals = await move._prepareMoveLineVals();
                        if (await (await line.productId).tracking === 'serial') {
                            extend(moveLinesToCreate, Array.from(range(parseInt(differenceQty))).map(i => mlVals));
                            extend(mlsQties, _.fill(Array(parseInt(differenceQty)), 1));
                        }
                        else {
                            moveLinesToCreate.push(mlVals);
                            mlsQties.push(differenceQty);
                        }
                    }
                }
            }
            const moveLines = await this.env.items('stock.move.line').create(moveLinesToCreate);
            for (const [moveLine, qty] of _.zip([...moveLines], mlsQties)) {
                await moveLine.write({[qtyFname]: qty});
            }
        }
        else {
            for (const move of movesRemaining) {
                for (const line of linesData[(await move.productId).id]['orderLines']) {
                    const product = await line.productId;
                    for (const lot of await (await line.packLotIds).filtered(l => l.lotName)) {
                        let qty;
                        if (await product.tracking === 'serial') {
                            qty = 1;
                        }
                        else {
                            qty = Math.abs(await line.qty);
                        }
                        if (bool(existingLots)) {
                            const existingLot = await existingLots.filteredDomain([['productId', '=', product.id], ['label', '=', await lot.lotName]]);
                            if (bool(existingLot)) {
                                const availableQuantity = await move._getAvailableQuantity(await move.locationId, {lotId: existingLot, strict: true});
                                if (!floatIsZero(availableQuantity, {precisionRounding: await (await product.uomId).rounding})) {
                                    await move._updateReservedQuantity(qty, Math.min(qty, availableQuantity), await move.locationId, existingLot);
                                    continue;
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}