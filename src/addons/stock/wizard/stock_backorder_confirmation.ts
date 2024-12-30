import { api } from "../../../core";
import { Fields } from "../../../core/fields";
import { MetaModel, TransientModel, _super } from "../../../core/models";
import { floatCompare } from "../../../core/tools/float_utils";
import { bool } from "../../../core/tools/bool";

@MetaModel.define()
class StockBackorderConfirmationLine extends TransientModel {
    static _module = module;
    static _name = 'stock.backorder.confirmation.line';
    static _description = 'Backorder Confirmation Line';

    static backorderConfirmationId = Fields.Many2one('stock.backorder.confirmation', { string: 'Immediate Transfer' });
    static pickingId = Fields.Many2one('stock.picking', { string: 'Transfer' });
    static toBackorder = Fields.Boolean('To Backorder');
}

@MetaModel.define()
class StockBackorderConfirmation extends TransientModel {
    static _module = module;
    static _name = 'stock.backorder.confirmation';
    static _description = 'Backorder Confirmation';

    static pickIds = Fields.Many2many('stock.picking', { relation: 'stockPickingBackorderRel' });
    static showTransfers = Fields.Boolean();
    static backorderConfirmationLineIds = Fields.One2many('stock.backorder.confirmation.line', 'backorderConfirmationId', { string: "Backorder Confirmation Lines" });

    @api.model()
    async defaultGet(fields) {
        const res = await _super(StockBackorderConfirmation, this).defaultGet(fields);
        if (fields.includes('backorderConfirmationLineIds') && bool(res['pickIds'])) {
            res['backorderConfirmationLineIds'] = res['pickIds'][0][2].map(pickId => [0, 0, { 'toBackorder': true, 'pickingId': pickId }]);
            // defaultGet returns x2m values as [(6, 0, ids)]
            // because of webclient limitations
        }
        return res;
    }

    async _checkLessQuantitiesThanExpected(pickings) {
        for (const pickId of pickings) {
            const movesToLog = new Map();
            for (const move of await pickId.moveLines) {
                if (floatCompare(await move.productUomQty, await move.quantityDone, { precisionRounding: await (await move.productUom).rounding }) > 0) {
                    movesToLog.set(move, [await move.quantityDone, await move.productUomQty]);
                }
            }
            if (movesToLog.size) {
                await pickId._logLessQuantitiesThanExpected(movesToLog);
            }
        }
    }

    async process() {
        let pickingsToDo = this.env.items('stock.picking');
        let pickingsNotToDo = this.env.items('stock.picking');
        for (const line of await this['backorderConfirmationLineIds']) {
            if (await line.toBackorder === true) {
                pickingsToDo = pickingsToDo.or(await line.pickingId);
            }
            else {
                pickingsNotToDo = pickingsNotToDo.or(await line.pickingId);
            }
        }

        let pickingsToValidate = this.env.context['buttonValidatePickingIds'];
        if (bool(pickingsToValidate)) {
            pickingsToValidate = await this.env.items('stock.picking').browse(pickingsToValidate).withContext({ skipBackorder: true });
            if (bool(pickingsNotToDo)) {
                await this._checkLessQuantitiesThanExpected(pickingsNotToDo);
                pickingsToValidate = await pickingsToValidate.withContext({ pickingIdsNotToBackorder: pickingsNotToDo.ids });
            }
            return pickingsToValidate.buttonValidate();
        }
        return true;
    }

    async processCancelBackorder() {
        const pickingsToValidateIds = this.env.context['buttonValidatePickingIds'];
        if (bool(pickingsToValidateIds)) {
            const pickingsToValidate = this.env.items('stock.picking').browse(pickingsToValidateIds);
            await this._checkLessQuantitiesThanExpected(pickingsToValidate);
            return (await pickingsToValidate
                .withContext({ skipBackorder: true, pickingIdsNotToBackorder: (await this['pickIds']).ids }))
                .buttonValidate();
        }
        return true;
    }
}