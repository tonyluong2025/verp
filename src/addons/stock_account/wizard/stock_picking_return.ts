import { Fields, api } from "../../../core";
import { MetaModel, TransientModel, _super } from "../../../core/models"
import { bool, update } from "../../../core/tools";

@MetaModel.define()
class StockReturnPicking extends TransientModel {
    static _module = module;
    static _parents = "stock.return.picking";

    @api.model()
    async defaultGet(defaultFields) {
        const res = await _super(StockReturnPicking, this).defaultGet(defaultFields);
        for (const [i, k, vals] of res.get('productReturnMoves', [])) {
            update(vals, {'toRefund': true});
        }
        return res;
    }

    async _createReturns() {
        const [newPickingId, pickTypeId] = await _super(StockReturnPicking, this)._createReturns();
        const newPicking = this.env.items('stock.picking').browse([newPickingId]);
        for (const move of await newPicking.moveLines) {
            const returnPickingLine = (await (await this['productReturnMoves']).filtered(async (r) => (await r.moveId).eq(await move.originReturnedMoveId))).slice(0,1);
            if (bool(returnPickingLine) && await returnPickingLine.toRefund) {
                await move.set('toRefund', true);
            }
        }
        return [newPickingId, pickTypeId];
    }
}

@MetaModel.define()
class StockReturnPickingLine extends TransientModel {
    static _module = module;
    static _parents = "stock.return.picking.line";

    static toRefund = Fields.Boolean({string: "Update quantities on SO/PO", default: true,
        help: 'Trigger a decrease of the delivered/received quantity in the associated Sale Order/Purchase Order'});
}