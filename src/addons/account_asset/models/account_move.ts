import { Fields, _Date, api } from "../../../core";
import { UserError, ValidationError } from "../../../core/helper";
import { MetaModel, Model, _super } from "../../../core/models";
import { enumerate, pop, update } from "../../../core/tools";
import { addDate } from "../../../core/tools/date_utils";

@MetaModel.define()
class AccountMove extends Model {
    static _module = module;
    static _parents = 'account.move';

    static assetIds = Fields.One2many('account.asset.asset', 'invoiceId', { string: "Assets", copy: false });

    async buttonDraft() {
        const res = await _super(AccountMove, self).buttonDraft();
        for (const move of this) {
            const assetIds = await move.assetIds;
            if (await assetIds.some(async (assetId) => await assetId.state !== 'draft')) {
                throw new ValidationError(await this._t('You cannot reset to draft for an entry having a posted asset'));
            }
            if (assetIds.ok) {
                await (await assetIds.sudo()).write({ 'active': false });
                for (const asset of assetIds) {
                    await (await asset.sudo()).messagePost({ body: await this._t("Vendor bill cancelled.") });
                }
            }
        }
        return res;
    }

    @api.model()
    async _refundCleanupLines(lines) {
        const result = await _super(AccountMove, this)._refundCleanupLines(lines);
        for (const [i, line] of enumerate(lines)) {
            for (const [name, field] of line._fields) {
                if (name === 'assetCategoryId') {
                    result[i][2][name] = false;
                    break;
                }
            }
        }
        return result;
    }

    async actionCancel() {
        const res = await _super(AccountMove, this).actionCancel();
        const assets = await (await this.env.items('account.asset.asset').sudo()).search(
            [['invoiceId', 'in', this.ids]]);
        if (assets.ok) {
            await (await assets.sudo()).write({ 'active': false });
            for (const asset of assets) {
                await (await asset.sudo()).messagePost({ body: await this._t("Vendor bill cancelled.") });
            }
        }
        return res
    }

    async actionPost() {
        const result = await _super(AccountMove, this).actionPost();
        for (const inv of this) {
            const context = Object.assign({}, this.env.context);
            pop(context, 'defaultType', null);
            for (const mvLine of await (await inv.invoiceLineIds).filtered(async (line) => ['inInvoice', 'outInvoice'].includes(await (await line.moveId).moveType))) {
                await (await mvLine.withContext(context)).assetCreate();
            }
        }
        return result;
    }
}

@MetaModel.define()
class AccountMoveLine extends Model {
    static _module = module;
    static _parents = 'account.move.line';

    static assetCategoryId = Fields.Many2one('account.asset.category', { string: 'Asset Category' });
    static assetStartDate = Fields.Date({ string: 'Asset Start Date', compute: '_getAssetDate', readonly: true, store: true });
    static assetEndDate = Fields.Date({ string: 'Asset End Date', compute: '_getAssetDate', readonly: true, store: true });
    static assetMrr = Fields.Float({ string: 'Monthly Recurring Revenue', compute: '_getAssetDate', readonly: true, store: true });

    @api.model()
    async defaultGet(fields) {
        const res = await _super(AccountMoveLine, this).defaultGet(fields);
        if (this.env.context['createBill'] && !(await this['assetCategoryId']).ok) {
            const [product, move] = await this('productId', 'moveId');
            const moveType = await move.moveType;
            if (product.ok) {
                if (moveType === 'outInvoice') {
                    const deferredRevenueCategoryId = await (await product.productTemplateId).deferredRevenueCategoryId;
                    if (deferredRevenueCategoryId.ok) {
                        await this.set('assetCategoryId', deferredRevenueCategoryId.id);
                    }
                }
                else if (moveType === 'inInvoice') {
                    const assetCategoryId = await (await product.productTemplateId).assetCategoryId;
                    if (assetCategoryId.ok) {
                        await this.set('assetCategoryId', assetCategoryId.id);
                    }
                }
            }
            await this.onchangeAssetCategoryId();
        }
        return res;
    }

    @api.depends('assetCategoryId', 'moveId.invoiceDate')
    async _getAssetDate() {
        for (const rec of this) {
            await rec.update({
                assetMrr: 0,
                assetStartDate: false,
                assetEndDate: false
            });
            const cat = await rec.assetCategoryId;
            if (cat.ok) {
                const [methodNumber, methodPeriod] = await cat('methodNumber', 'methodPeriod');
                if (methodNumber == 0 || methodPeriod == 0) {
                    throw new UserError(await this._t('The number of depreciations or the period length of your asset category cannot be 0.'));
                }
                const months = methodNumber * methodPeriod;
                const move = await rec.moveId;
                if (['outInvoice', 'outRefund'].includes(await move.moveType)) {
                    const priceSubtotal = await (await rec.currencyId)._convert(
                        await rec.priceSubtotal,
                        await rec.companyCurrencyId,
                        await rec.companyId,
                        await move.invoiceDate || await _Date.contextToday(rec));

                    await rec.set('assetMrr', priceSubtotal / months);
                }
                const invoiceDate = await move.invoiceDate;
                if (invoiceDate) {
                    const startDate = invoiceDate;
                    startDate.setDate(1);
                    const endDate = addDate(startDate, { months: months, days: -1 });
                    await rec.update({
                        assetStartDate: startDate,
                        assetEndDate: endDate
                    });
                }
            }
        }
    }

    async assetCreate() {
        const [assetCategory, currency] = await this('assetCategoryId', 'currencyId');
        if (assetCategory.ok) {
            const [label, move] = await this('label', 'moveId');
            const priceSubtotal = await currency._convert(
                await this['priceSubtotal'],
                await this['companyCurrencyId'],
                await this['companyId'],
                await move.invoiceDate || await _Date.contextToday(this));
            const vals = {
                'label': label,
                'code': label || false,
                'categoryId': assetCategory.id,
                'value': priceSubtotal,
                'partnerId': (await move.partnerId).id,
                'companyId': (await move.companyId).id,
                'currencyId': (await move.companyCurrencyId).id,
                'date': await move.invoiceDate || await move.date,
                'invoiceId': move.id,
            }
            const changedVals = await this.env.items('account.asset.asset').onchangeCategoryIdValues(vals['categoryId']);
            update(vals, changedVals['value']);
            const asset = await this.env.items('account.asset.asset').create(vals);
            if (await assetCategory.openAsset) {
                if (await asset.dateFirstDepreciation === 'manual') {
                    await asset.set('firstDepreciationManualDate', await asset.date);
                }
                await asset.validate();
            }
        }
        return true;
    }

    @api.onchange('assetCategoryId')
    async onchangeAssetCategoryId() {
        const [move, assetCategory] = await this('moveId', 'assetCategoryId');
        const moveType = await move.moveType;
        if (assetCategory.ok && ['outInvoice', 'inInvoice'].includes(moveType)) {
            await this.set('accountId', (await assetCategory.accountAssetId).id);
        }
    }

    @api.onchange('productUomId')
    async _onchangeUomId() {
        const result = await _super(AccountMoveLine, this)._onchangeUomId();
        await this.onchangeAssetCategoryId();
        return result;
    }

    @api.onchange('productId')
    async _onchangeProductId() {
        const vals = await _super(AccountMoveLine, this)._onchangeProductId();
        for (const rec of this) {
            const [product, move] = await rec('productId', 'moveId');
            const moveType = await move.moveType;
            if (product.ok) {
                if (moveType === 'outInvoice') {
                    await rec.set('assetCategoryId', (await (await product.productTemplateId).deferredRevenueCategoryId).id);
                }
                else if (moveType === 'inInvoice') {
                    await rec.set('assetCategoryId', (await (await product.productTemplateId).assetCategoryId).id);
                }
            }
        }
        return vals;
    }

    async getInvoiceLineAccount(type, product, fpos, company) {
        let result = await (await product.assetCategoryId).accountAssetId;
        return result.ok ? result : _super(AccountMoveLine, this).getInvoiceLineAccount(type, product, fpos, company);
    }
}
