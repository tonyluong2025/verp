import { Fields, _Date } from "../../../core";
import { MetaModel, TransientModel } from "../../../core/models";

@MetaModel.define()
class AssetDepreciationConfirmationWizard extends TransientModel {
    static _module = module;
    static _name = "asset.depreciation.confirmation.wizard";
    static _description = "asset.depreciation.confirmation.wizard";

    static date = Fields.Date('Account Date', {required: true,
                       help: "Choose the period for which you want to automatically post the depreciation lines of running assets", default: self => _Date.contextToday(self)});

    async assetCompute() {
        this.ensureOne();
        const context = this._context;
        const createdMoveIds = await this.env.items('account.asset.asset').computeGeneratedEntries(await this['date'], context['assetType']);

        return {
            'label': context['assetType'] == 'purchase' ? await this._t('Created Asset Moves') : await this._t('Created Revenue Moves'),
            'viewType': 'form',
            'viewMode': 'tree,form',
            'resModel': 'account.move',
            'viewId': false,
            'domain': "[['id','in',[" + createdMoveIds.map(id => String(id)).join(',') + "]]]",
            'type': 'ir.actions.actwindow',
        }
    }
}