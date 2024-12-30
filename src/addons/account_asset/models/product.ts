import { Fields } from "../../../core";
import { MetaModel, Model, _super } from "../../../core/models";

@MetaModel.define()
class ProductTemplate extends Model {
    static _module = module;
    static _parents = 'product.template';

    static assetCategoryId = Fields.Many2one('account.asset.category', { string: 'Asset Type', companyDependent: true, ondelete: "RESTRICT" });
    static deferredRevenueCategoryId = Fields.Many2one('account.asset.category', { string: 'Deferred Revenue Type', companyDependent: true, ondelete: "RESTRICT" });

    async _getAssetAccounts() {
        const res = await _super(ProductTemplate, this)._getAssetAccounts();
        if ((await this['assetCategoryId']).ok) {
            res['stockInput'] = await this['propertyAccountExpenseId'];
        }
        if ((await this['deferredRevenueCategoryId']).ok) {
            res['stockOutput'] = await this['propertyAccountIncomeId'];
        }
        return res;
    }
}