import { Fields, api } from "../../../core";
import { UserError } from "../../../core/helper/errors";
import { MetaModel, TransientModel, _super } from "../../../core/models";
import { bool } from "../../../core/tools/bool";

@MetaModel.define()
class StockImmediateTransferLine extends TransientModel {
    static _module = module;
    static _name = 'stock.immediate.transfer.line';
    static _description = 'Immediate Transfer Line';

    static immediateTransferId = Fields.Many2one('stock.immediate.transfer', { string: 'Immediate Transfer', required: true });
    static pickingId = Fields.Many2one('stock.picking', { string: 'Transfer', required: true });
    static toImmediate = Fields.Boolean('To Process');
}

@MetaModel.define()
class StockImmediateTransfer extends TransientModel {
    static _module = module;
    static _name = 'stock.immediate.transfer'
    static _description = 'Immediate Transfer'

    static pickIds = Fields.Many2many('stock.picking', { relation: 'stockPickingTransferRel' });
    static showTransfers = Fields.Boolean();
    static immediateTransferLineIds = Fields.One2many('stock.immediate.transfer.line',
        'immediateTransferId', { string: "Immediate Transfer Lines" });

    @api.model()
    async defaultGet(fields) {
        const res = await _super(StockImmediateTransfer, this).defaultGet(fields);
        if (fields.includes('immediateTransferLineIds') && res['pickIds']) {
            res['immediateTransferLineIds'] = res['pickIds'][0][2].map(pickId => [0, 0, { 'toImmediate': true, 'pickingId': pickId }]);
            // defaultGet returns x2m values as [(6, 0, ids)]
            // because of webclient limitations
        }
        return res;
    }

    async process() {
        let pickingsToDo = this.env.items('stock.picking');
        let pickingsNotToDo = this.env.items('stock.picking');
        for (const line of await this['immediateTransferLineIds']) {
            if (await line.toImmediate === true) {
                pickingsToDo = pickingsToDo.or(await line.pickingId);
            }
            else {
                pickingsNotToDo = pickingsNotToDo.or(await line.pickingId);
            }
        }
        for (const picking of pickingsToDo) {
            // If still in draft => confirm and assign
            if (await picking.state === 'draft') {
                await picking.actionConfirm();
                if (await picking.state !== 'assigned') {
                    await picking.actionAssign();
                    if (await picking.state !== 'assigned') {
                        throw new UserError(await this._t("Could not reserve all requested products. Please use the \'Mark as Todo\' button to handle the reservation manually."));
                    }
                }
            }
            await (await picking.moveLines)._setQuantitiesToReservation();
        }

        let pickingsToValidate = this.env.context['buttonValidatePickingIds'];
        if (bool(pickingsToValidate)) {
            pickingsToValidate = this.env.items('stock.picking').browse(pickingsToValidate);
            pickingsToValidate = pickingsToValidate - pickingsNotToDo;
            return (await pickingsToValidate.withContext({ skipImmediate: true })).buttonValidate();
        }
        return true;
    }
}