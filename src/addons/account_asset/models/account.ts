import { Fields } from "../../../core";
import { MetaModel, Model, _super } from "../../../core/models"

@MetaModel.define()
class AccountMove extends Model {
    static _module = module;
    static _parents = 'account.move';

    static assetDepreciationIds = Fields.One2many('account.asset.depreciation.line', 'moveId', { string: 'Assets Depreciation Lines'});

    async buttonCancel() {
        for (const move of this) {
            for (const line of await move.assetDepreciationIds) {
                await line.set('movePostedCheck', false);
            }
        }
        return _super(AccountMove, this).buttonCancel();
    }

    async actionPost() {
        for (const move of this) {
            for (const depreciationLine of await move.assetDepreciationIds) {
                await depreciationLine.postLinesAndCloseAsset();
            }
        }
        return _super(AccountMove, this).actionPost();
    }
}