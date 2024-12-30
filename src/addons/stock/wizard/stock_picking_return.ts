import { Fields, _Datetime, api } from "../../../core";
import { UserError } from "../../../core/helper";
import { MetaModel, TransientModel, _super } from "../../../core/models";
import { bool, floatRound, len, sum, update } from "../../../core/tools";

@MetaModel.define()
class ReturnPickingLine extends TransientModel {
    static _module = module;
    static _name = "stock.return.picking.line";
    static _recName = 'productId';
    static _description = 'Return Picking Line';

    static productId = Fields.Many2one('product.product', { string: "Product", required: true, domain: "[['id', '=', productId]]" });
    static quantity = Fields.Float("Quantity", { digits: 'Product Unit of Measure', required: true });
    static uomId = Fields.Many2one('uom.uom', { string: 'Unit of Measure', related: 'productId.uomId' });
    static wizardId = Fields.Many2one('stock.return.picking', { string: "Wizard" });
    static moveId = Fields.Many2one('stock.move', { string: "Move" });
}

@MetaModel.define()
class ReturnPicking extends TransientModel {
    static _module = module;
    static _name = 'stock.return.picking';
    static _description = 'Return Picking';

    @api.model()
    async defaultGet(fields) {
        const res = await _super(ReturnPicking, this).defaultGet(fields);
        if (this.env.context['activeId'] && this.env.context['activeModel'] === 'stock.picking') {
            if (len(this.env.context['activeIds']) > 1) {
                throw new UserError(await this._t("You may only return one picking at a time."));
            }
            const picking = this.env.items('stock.picking').browse(this.env.context['activeId']);
            if (bool(await picking.exists())) {
                update(res, { 'pickingId': picking.id });
            }
        }
        return res;
    }

    static pickingId = Fields.Many2one('stock.picking');
    static productReturnMoves = Fields.One2many('stock.return.picking.line', 'wizardId', { string: 'Moves' });
    static moveDestExists = Fields.Boolean('Chained Move Exists', { readonly: true });
    static originalLocationId = Fields.Many2one('stock.location');
    static parentLocationId = Fields.Many2one('stock.location');
    static companyId = Fields.Many2one({ related: 'pickingId.companyId' });
    static locationId = Fields.Many2one('stock.location', { string: 'Return Location', domain: "['|', ['id', '=', originalLocationId], '|', '&', ['returnLocation', '=', true], ['companyId', '=', false], '&', ['returnLocation', '=', true], ['companyId', '=', companyId]]" });

    @api.onchange('pickingId')
    async _onchangePickingId() {
        let moveDestExists = false;
        const productReturnMoves = [[5,]];
        const [pickingId] = await this('pickingId');
        if (pickingId.ok && await pickingId.state !== 'done') {
            throw new UserError(await this._t("You may only return Done pickings."));
        }
        // In case we want to set specific default values (e.g. 'to_refund'), we must fetch the
        // default values for creation.
        const lineFields = this.env.models['stock.return.picking.line']._fields.keys();
        const productReturnMovesDataTmpl = await this.env.items('stock.return.picking.line').defaultGet(lineFields);
        for (const move of await pickingId.moveLines) {
            if (await move.state === 'cancel') {
                continue;
            }
            if (await move.scrapped) {
                continue;
            }
            if ((await move.moveDestIds).ok) {
                moveDestExists = true;
            }
            const productReturnMovesData = Object.assign({}, productReturnMovesDataTmpl);
            productReturnMovesData.push(await this._prepareStockReturnPickingLineValsFromMove(move));
            productReturnMoves.push([0, 0, productReturnMovesData]);
        }
        if (pickingId.ok && !len(productReturnMoves)) {
            throw new UserError(await this._t("No products to return (only lines in Done state and not fully returned yet can be returned)."));
        }
        if (pickingId.ok) {
            let [locationId, pickingTypeId] = await pickingId('locationId', 'pickingTypeId');
            const warehouseId = await pickingTypeId.warehouseId;
            // const promises = [
                await this.set('productReturnMoves', productReturnMoves),
                await this.set('moveDestExists', moveDestExists),
                await this.set('parentLocationId', warehouseId.ok && bool((await warehouseId.viewLocationId).id) && (await warehouseId.viewLocationId).id || (await locationId.locationId).id),
                await this.set('originalLocationId', locationId.id)
            // ];
            const defaultLocationDestId = await (await pickingTypeId.returnPickingTypeId).defaultLocationDestId;
            if (await defaultLocationDestId.returnLocation) {
                locationId = defaultLocationDestId;
            }
            await this.set('locationId', locationId.id);
            // await Promise.all(promises);
        }
    }

    @api.model()
    async _prepareStockReturnPickingLineValsFromMove(stockMove) {
        let [quantity, productId] = await stockMove('productQty', 'productId');
        for (const move of await stockMove.moveDestIds) {
            const [originReturnedMoveId, state] = await move('originReturnedMoveId', 'state');
            if (!originReturnedMoveId.ok || !originReturnedMoveId.eq(stockMove)) {
                continue;
            }
            if (['partiallyAvailable', 'assigned'].includes(state)) {
                quantity -= sum(await (await move.moveLineIds).mapped('productQty'));
            }
            else if (['done'].includes(state)) {
                quantity -= await move.productQty;
            }
        }
        const uomId = await productId.uomId;
        quantity = floatRound(quantity, { precisionRounding: uomId.rounding });
        return {
            'productId': productId.id,
            'quantity': quantity,
            'moveId': stockMove.id,
            'uomId': uomId.id,
        }
    }

    async _prepareMoveDefaultValues(returnLine, newPicking) {
        const [productId, quantity, moveId] = await returnLine('productId', 'quantity', 'moveId');
        let lotId = (await this['locationId']).id;
        lotId = bool(lotId) ? lotId : (await moveId.locationId).id;
        const vals = {
            'productId': productId.id,
            'productUomQty': quantity,
            'productUom': (await productId.uomId).id,
            'pickingId': newPicking.id,
            'state': 'draft',
            'date': _Datetime.now(),
            'locationId': (await moveId.locationDestId).id,
            'locationDestId': lotId,
            'pickingTypeId': (await newPicking.pickingTypeId).id,
            'warehouseId': (await (await (await this['pickingId']).pickingTypeId).warehouseId).id,
            'originReturnedMoveId': moveId.id,
            'procureMethod': 'makeToStock',
        }
        return vals;
    }

    async _preparePickingDefaultValues() {
        const [pickingId, locationId] = await this('pickingId', 'locationId');
        const [pickingTypeId, locationDestId, label] = await pickingId('pickingTypeId', 'locationDestId', 'label');
        const pickId = (await pickingTypeId.returnPickingTypeId).id;

        return {
            'moveLines': [],
            'pickingTypeId': bool(pickId) ? pickId : pickingTypeId.id,
            'state': 'draft',
            'origin': await this._t("Return of %s", label),
            'locationId': locationDestId.id,
            'locationDestId': locationId.id
        }
    }

    async _createReturns() {
        const [productReturnMoves, pickingId] = await this('productReturnMoves', 'pickingId');
        // TODO sle: the unreserve of the next moves could be less brutal
        for (const returnMove of await productReturnMoves.mapped('moveId')) {
            await (await returnMove.moveDestIds.filtered(async (m) => !['done', 'cancel'].includes(await m.state)))._doUnreserve();
        }
        // create new picking for returned products
        const newPicking = await pickingId.copy(await this._preparePickingDefaultValues());
        const pickingTypeId = (await newPicking.pickingTypeId).id;
        await newPicking.messagePostWithView('mail.messageOriginLink', {
            values: { 'self': newPicking, 'origin': pickingId },
            subtypeId: (await this.env.ref('mail.mtNote')).id
        });
        let returnedLines = 0;
        for (const returnLine of productReturnMoves) {
            const [moveId, quantity] = await returnLine('moveId', 'quantity');
            if (!moveId.ok) {
                throw new UserError(await this._t("You have manually created product lines, please delete them to proceed."));
            }
            // TODO sle: floatIsZero?
            if (quantity) {
                returnedLines += 1
                let vals: {} = await this._prepareMoveDefaultValues(returnLine, newPicking);
                const row = await moveId.copy(vals);
                vals = {};
                /*
                # +--------------------------------------------------------------------------------------------------------+
                # |       picking_pick     <--Move Orig--    picking_pack     --Move Dest-->   picking_ship
                # |              | returned_move_ids              ↑                                  | returned_move_ids
                # |              ↓                                | returnLine.moveId              ↓
                # |       return pick(Add as dest)          return toLink                    return ship(Add as orig)
                # +--------------------------------------------------------------------------------------------------------+
                */
                const [moveDestIds, moveOrigIds] = await moveId('moveDestIds', 'moveOrigIds');
                let moveOrigToLink = await moveDestIds.mapped('returnedMoveIds');
                // link to original move
                moveOrigToLink = moveOrigToLink.or(moveId);
                // link to siblings of original move, if any
                moveOrigToLink = moveOrigToLink.or(await (await (await (await moveId
                    .mapped('moveDestIds')).filtered(async (m) => !['cancel'].includes(await m.state)))
                    .mapped('moveOrigIds')).filtered(async (m) => !['cancel'].includes(await m.state)));
                let moveDestToLink = await moveOrigIds.mapped('returnedMoveIds');
                // link to children of originally returned moves, if any. Note that the use of
                // 'returnLine.moveId.move_orig_ids.returned_move_ids.move_orig_ids.move_dest_ids'
                // instead of 'returnLine.moveId.move_orig_ids.move_dest_ids' prevents linking a
                // return directly to the destination moves of its parents. However, the return of
                // the return will be linked to the destination moves.
                moveDestToLink = moveDestToLink.or(await (await (await (await (await (await moveOrigIds.mapped('returnedMoveIds'))
                    .mapped('moveOrigIds')).filtered(async (m) => !['cancel'].includes(await m.state)))
                    .mapped('moveDestIds')).filtered(async (m) => !['cancel'].includes(await m.state))));
                vals['moveOrigIds'] = await moveOrigToLink.map(m => [4, m.id]);
                vals['moveDestIds'] = await moveDestToLink.map(m => [4, m.id]);
                await row.write(vals);
            }
        }
        if (!returnedLines) {
            throw new UserError(await this._t("Please specify at least one non-zero quantity."));
        }

        await newPicking.actionConfirm();
        await newPicking.actionAssign();
        return [newPicking.id, pickingTypeId];
    }

    async createReturns() {
        let newPickingId, pickTypeId;
        for (const wizard of this) {
            [newPickingId, pickTypeId] = await wizard._createReturns();
        }
        // Override the context to disable all the potential filters that could have been set previously
        const ctx = Object.assign({}, this.env.context);
        update(ctx, {
            'default_partnerId': (await (await this['pickingId']).partnerId).id,
            'searchDefault_pickingTypeId': pickTypeId,
            'searchDefault_draft': false,
            'searchDefault_assigned': false,
            'searchDefault_confirmed': false,
            'searchDefault_ready': false,
            'searchDefault_planningIssues': false,
            'searchDefault_available': false,
        })
        return {
            'label': await this._t('Returned Picking'),
            'viewMode': 'form,tree,calendar',
            'resModel': 'stock.picking',
            'resId': newPickingId,
            'type': 'ir.actions.actwindow',
            'context': ctx,
        }
    }
}