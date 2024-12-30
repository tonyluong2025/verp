import { Fields, _Date, api } from "../../../core";
import { UserError } from "../../../core/helper";
import { MetaModel, TransientModel, _super } from "../../../core/models"
import { _f, bool, floatCompare, floatIsZero, sum } from "../../../core/tools";

@MetaModel.define()
class StockValuationLayerRevaluation extends TransientModel {
    static _module = module;
    static _name = 'stock.valuation.layer.revaluation';
    static _description = "Wizard model to reavaluate a stock inventory for a product";
    static _checkCompanyAuto = true;

    @api.model()
    async defaultGet(defaultFields) {
        const res = await _super(StockValuationLayerRevaluation, this).defaultGet(defaultFields);
        if (res['productId']) {
            const product = this.env.items('product.product').browse(res['productId']);
            if (await (await product.categId).propertyCostMethod === 'standard') {
                throw new UserError(await this._t("You cannot revalue a product with a standard cost method."));
            }
            if (await product.quantitySvl <= 0) {
                throw new UserError(await this._t("You cannot revalue a product with an empty or negative stock."));
            }
            if (!('accountJournalId' in res) && 'accountJournalId' in defaultFields && await (await product.categId).propertyValuation === 'auto') {
                const accounts = await (await product.productTemplateId).getProductAccounts();
                res['accountJournalId'] = accounts['stockJournal'].id;
            }
        }
        return res;
    }

    static companyId = Fields.Many2one('res.company', {string: "Company", readonly: true, required: true});
    static currencyId = Fields.Many2one('res.currency', {string: "Currency", related: 'companyId.currencyId', required: true});

    static productId = Fields.Many2one('product.product', {string: "Related product", required: true, checkCompany: true});
    static propertyValuation = Fields.Selection({related: 'productId.categId.propertyValuation'});
    static productUomName = Fields.Char("Unit of Measure", {related: 'productId.uomId.label'});
    static currentValueSvl = Fields.Float("Current Value", {related: "productId.valueSvl"});
    static currentQuantitySvl = Fields.Float("Current Quantity", {related: "productId.quantitySvl"});

    static addedValue = Fields.Monetary("Added value", {required: true});
    static newValue = Fields.Monetary("New value", {compute: '_computeNewValue'});
    static newValueByQty = Fields.Monetary("New value by quantity", {compute: '_computeNewValue'});
    static reason = Fields.Char("Reason", {help: "Reason of the revaluation"});

    static accountJournalId = Fields.Many2one('account.journal', {string: "Journal", checkCompany: true});
    static accountId = Fields.Many2one('account.account', {string: "Counterpart Account", domain: [['deprecated', '=', false]], checkCompany: true});
    static date = Fields.Date("Accounting Date");

    @api.depends('currentValueSvl', 'currentQuantitySvl', 'addedValue')
    async _computeNewValue() {
        for (const reval of this) {
            await reval.set('newValue', await reval.currentValueSvl + await reval.addedValue);
            if (!floatIsZero(await reval.currentQuantitySvl, {precisionRounding: await (await (await this['productId']).uomId).rounding})) {
                await reval.set('newValueByQty', await reval.newValue / await reval.currentQuantitySvl);
            }
            else {
                await reval.set('newValueByQty', 0.0);
            }
        }
    }

    /**
     * Revaluate the stock for `self.productId` in `self.companyId`.

        - Change the stardard price with the new valuation by product unit.
        - Create a manual stock valuation layer with the `addedValue` of `self`.
        - Distribute the `addedValue` on the remaining_value of layers still in stock (with a remaining quantity)
        - If the Inventory Valuation of the product category is automated, create
        related account move.
     * @returns 
     */
    async actionValidateRevaluation() {
        this.ensureOne();
        if (await (await this['currencyId']).isZero(await this['addedValue'])) {
            throw new UserError(await this._t("The added value doesn't have any impact on the stock valuation"));
        }
        let [product, company, reason, addedValue, currency, currentValueSvl, currentQuantitySvl, propertyValuation, account, accountJournal] = await this('productId', 'companyId', 'reason', 'addedValue', 'currencyId', 'currentValueSvl',  'currentQuantitySvl', 'propertyValuation', 'accountId', 'accountJournalId');
        product = await product.withCompany(company);
        const propertyCostMethod = await (await product.categId).propertyCostMethod;

        const remainingSvls = await this.env.items('stock.valuation.layer').search([
            ['productId', '=', product.id],
            ['remainingQty', '>', 0],
            ['companyId', '=', company.id],
        ]);

        // Create a manual stock valuation layer
        let description;
        if (reason) {
            description = await this._t("Manual Stock Valuation: %s.", reason);
        }
        else {
            description = await this._t("Manual Stock Valuation: No Reason Given.");
        }
        if (propertyCostMethod === 'average') {
            description += _f(await this._t(
                " Product cost updated from {previous} to {newCost}."), {
                previous: await product.standardPrice,
                newCost: await product.standardPrice + await this['addedValue'] / await this['currentQuantitySvl']
            });
        }
        const revaluationSvlVals = {
            'companyId': company.id,
            'productId': product.id,
            'description': description,
            'value': addedValue,
            'quantity': 0,
        }

        let remainingQty = sum(await remainingSvls.mapped('remainingQty'));
        let remainingValue = addedValue;
        const remainingValueUnitCost = await currency.round(remainingValue / remainingQty);
        const rounding = await (await (await this['product']).uomId).rounding;
        for (const svl of remainingSvls) {
            let takenRemainingValue;
            if (floatIsZero(await svl.remainingQty - remainingQty, {precisionRounding: rounding})) {
                takenRemainingValue = remainingValue;
            }
            else {
                takenRemainingValue = remainingValueUnitCost * await svl.remainingQty;
            }
            if (floatCompare(await svl.remainingValue + takenRemainingValue, 0, {precisionRounding: rounding}) < 0) {
                throw new UserError(await this._t('The value of a stock valuation layer cannot be negative. Landed cost could be use to correct a specific transfer.'));
            }

            await svl.set('remainingValue', await svl.remainingValue + takenRemainingValue);
            remainingValue -= takenRemainingValue;
            remainingQty -= await svl.remainingQty;
        }
        const revaluationSvl = await this.env.items('stock.valuation.layer').create(revaluationSvlVals);

        // Update the stardard price in case of AVCO
        if (['average', 'fifo'].includes(propertyCostMethod)) {
            const pdisableAutoSvl = await product.withContext({disableAutoSvl: true});
            await pdisableAutoSvl.set('standardPrice', await pdisableAutoSvl.standardPrice + addedValue / currentQuantitySvl);
        }
        // If the Inventory Valuation of the product category is automated, create related account move.
        if (propertyValuation !== 'auto') {
            return true;
        }

        const accounts = await (await product.productTemplateId).getProductAccounts();
        let debitAccountId, creditAccountId; 
        if (addedValue < 0) {
            debitAccountId = account.id
            creditAccountId = bool(accounts['stockValuation']) && accounts['stockValuation'].id;
        }
        else {
            debitAccountId = bool(accounts['stockValuation']) && accounts['stockValuation'].id;
            creditAccountId = account.id;
        }

        const moveVals = {
            'journalId': accountJournal.id || accounts['stockJournal'].id,
            'companyId': company.id,
            'ref': await this._t("Revaluation of %s", await product.displayName),
            'stockValuationLayerIds': [[6, null, [revaluationSvl.id]]],
            'date': await this['date'] || _Date.today(),
            'moveType': 'entry',
            'lineIds': [[0, 0, {
                'label': _f(await this._t('{user} changed stock valuation from {previous} to {newValue} - {product}'), {
                    user: await (await this.env.user()).label,
                    previous: currentValueSvl,
                    newValue: currentValueSvl + addedValue,
                    product: await product.displayName,
                }),
                'accountId': debitAccountId,
                'debit': Math.abs(addedValue),
                'credit': 0,
                'productId': product.id,
            }], [0, 0, {
                'label': _f(await this._t('{user} changed stock valuation from {previous} to {newValue} - {product}'), {
                    user: await (await this.env.user()).label,
                    previous: currentValueSvl,
                    newValue: currentValueSvl + addedValue,
                    product: await product.displayName,
                }),
                'accountId': creditAccountId,
                'debit': 0,
                'credit': Math.abs(addedValue),
                'productId': product.id,
            }]],
        }
        const accountMove = await this.env.items('account.move').create(moveVals);
        await accountMove._post();

        return true;
    }
}