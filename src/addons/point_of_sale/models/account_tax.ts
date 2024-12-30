import _ from "lodash";
import { MetaModel, Model, _super } from "../../../core/models"
import { map, splitEvery, sum } from "../../../core/tools";
import { UserError } from "../../../core/helper";

@MetaModel.define()
class AccountTax extends Model {
    static _module = module;
    static _parents = 'account.tax';

    async write(vals) {
        const forbiddenFields = [
            'amountType', 'amount', 'typeTaxUse', 'taxGroupId', 'priceInclude',
            'includeBaseAmount', 'isBaseAffected',
        ];
        if (_.intersection(forbiddenFields, Object.keys(vals)).length) {
            const lineObj = this.env.items('pos.order.line');
            const lines = await (await lineObj.sudo()).search([
                ['orderId.sessionId.state', '!=', 'closed']
            ]);
            const selfIds = this.ids;
            for (const linesChunk of map(splitEvery(100000, lines.ids), (ids) => lineObj.browse(ids))) {
                for (const ts of await linesChunk.read(['taxIds'])) {
                    for (const tid of ts['taxIds']) {
                        if (selfIds.includes(tid)) {
                            throw new UserError(await this._t(
                                'It is forbidden to modify a tax used in a POS order not posted. You must close the POS sessions before modifying the tax.'
                            ));
                        }
                    }
                }
                linesChunk.invalidateCache(['taxIds'], linesChunk.ids);
            }
        }
        return _super(AccountTax, this).write(vals);
    }

    async getRealTaxAmount() {
        const taxList = [];
        for (const tax of this) {
            const taxRepartitionLines = await (await tax.invoiceRepartitionLineIds).filtered(async (x) => await x.repartitionType === 'tax');
            const totalFactor = sum(await taxRepartitionLines.mapped('factor'));
            const realAmount = await tax.amount * totalFactor;
            taxList.push({'id': tax.id, 'amount': realAmount});
        }
        return taxList;
    }
}