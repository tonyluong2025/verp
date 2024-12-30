import { Fields } from "../../../core";
import { MetaModel, Model, _super } from "../../../core/models"
import { bool } from "../../../core/tools";

@MetaModel.define()
class AccountMove extends Model {
    static _module = module;
    static _parents = 'account.move';

    static posOrderIds = Fields.One2many('pos.order', 'accountMove');
    static posPaymentIds = Fields.One2many('pos.payment', 'accountMoveId');

    async _stockAccountGetLastStepStockMoves() {
        let stockMoves = await _super(AccountMove, this)._stockAccountGetLastStepStockMoves();
        for (const invoice of await this.filtered(async (x) => await x.moveType === 'outInvoice')) {
            stockMoves = stockMoves.add(await (await (await invoice.sudo()).mapped('posOrderIds.pickingIds.moveLines')).filtered(async (x) => await x.state === 'done' && await (await x.locationDestId).usage === 'customer'));
        }
        for (const invoice of await this.filtered(async (x) => await x.moveType === 'outRefund')) {
            stockMoves = stockMoves.add(await (await (await invoice.sudo()).mapped('posOrderIds.pickingIds.moveLines')).filtered(async (x) => await x.state === 'done' && await (await x.locationId).usage === 'customer'));
        }
        return stockMoves;
    }

    async _getInvoicedLotValues() {
        this.ensureOne();

        const lotValues = await _super(AccountMove, this)._getInvoicedLotValues();

        if (await this['state'] === 'draft') {
            return lotValues;
        }

        // user may not have access to POS orders, but it's ok if they have
        // access to the invoice
        for (const order of await (await this.sudo()).posOrderIds) {
            for (const line of await order.lines) {
                const lots = await line.packLotIds;
                for (const lot of lots) {
                    const [product, productUom, lotName] = await lot('productId', 'productUomId', 'lotName');
                    lotValues.push({
                        'productName': await product.label,
                        'quantity': await product.tracking === 'lot' ? await line.qty : 1.0,
                        'uomName': await productUom.label,
                        'lotName': lotName,
                    });
                }
            }
        }
        return lotValues;
    }

    /**
     * Add pos_payment_name field in the reconciled vals to be able to show the payment method in the invoice.
     * @param partial 
     * @param amount 
     * @param counterpartLine 
     * @returns 
     */
    async _getReconciledVals(partial, amount, counterpartLine) {
        const result = await _super(AccountMove, this)._getReconciledVals(partial, amount, counterpartLine);
        const posPaymentIds = await (await (await counterpartLine.moveId).sudo()).posPaymentIds;
        if (bool(posPaymentIds)) {
            result['posPaymentName'] = await (await posPaymentIds.paymentMethodId).label;
        }
        return result;
    }
}

@MetaModel.define()
class AccountMoveLine extends Model {
    static _module = module;
    static _parents = 'account.move.line';

    async _stockAccountGetAngloSaxonPriceUnit() {
        this.ensureOne();
        const [product, move] = await this('productId', 'moveId');
        if (! bool(product)) {
            return this['priceUnit'];
        }
        let priceUnit = await _super(AccountMoveLine, this)._stockAccountGetAngloSaxonPriceUnit();
        const order = await move.posOrderIds;
        if (bool(order)) {
            priceUnit = await order._getPosAngloSaxonPriceUnit(product, (await move.partnerId).id, await this['quantity']);
        }
        return priceUnit;
    }
}