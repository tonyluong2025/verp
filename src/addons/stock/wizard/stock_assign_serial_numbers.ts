import { Fields, api } from "../../../core";
import { ValidationError } from "../../../core/helper/errors";
import { MetaModel, TransientModel } from "../../../core/models";
import { bool, len } from "../../../core/tools";

@MetaModel.define()
class StockAssignSerialNumbers extends TransientModel {
    static _module = module;
    static _name = 'stock.assign.serial';
    static _description = 'Stock Assign Serial Numbers';

    async _defaultNextSerialCount() {
        const move = this.env.items('stock.move').browse(this.env.context['default_moveId']);
        if (bool(move.exists())) {
            const filteredMoveLines = await (await move.moveLineIds).filtered(async (l)=> ! l.lotName && ! bool(l.lotId));
            return len(filteredMoveLines);
        }
    }

    static productId = Fields.Many2one('product.product', {string: 'Product', related: 'moveId.productId'});
    static moveId = Fields.Many2one('stock.move');
    static nextSerialNumber = Fields.Char('First SN', {required: true});
    static nextSerialCount = Fields.Integer('Number of SN', {default: self => self._defaultNextSerialCount(), required: true});

    @api.constrains('nextSerialCount')
    async _checkNextSerialCount() {
        for (const wizard of this) {
            if (await wizard.nextSerialCount < 1) {
                throw new ValidationError(await this._t("The number of Serial Numbers to generate must greater than zero."));
            }
        }
    }

    async generateSerialNumbers() {
        this.ensureOne();
        const [moveId, nextSerialNumber, nextSerialCount] = await this('moveId', 'nextSerialNumber', 'nextSerialCount');
        await moveId.set('nextSerial', nextSerialNumber || "");
        return moveId._generateSerialNumbers(nextSerialCount);
    }
}