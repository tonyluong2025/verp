import { Fields, api } from "../../../core";
import { Dict, UserError } from "../../../core/helper";
import { MetaModel, TransientModel, _super } from "../../../core/models";
import { bool } from "../../../core/tools";

@MetaModel.define()
class AssetModify extends TransientModel {
    static _module = module;
    static _name = 'asset.modify';
    static _description = 'Modify Asset';

    static label = Fields.Text({string: 'Reason', required: true});
    static methodNumber = Fields.Integer({string: 'Number of Depreciations', required: true});
    static methodPeriod = Fields.Integer({string: 'Period Length'});
    static methodEnd = Fields.Date({string: 'Ending date'});
    static assetMethodTime = Fields.Char({compute: '_getAssetMethodTime', string: 'Asset Method Time', readonly: true});

    async _getAssetMethodTime() {
        if (this.env.context['activeId']) {
            const asset = this.env.items('account.asset.asset').browse(this.env.context['activeId']);
            await this.set('assetMethodTime', await asset.methodTime);
        }
    }

    @api.model()
    async defaultGet(fields) {
        const res = await _super(AssetModify, this).defaultGet(fields);
        const assetId = this.env.context['activeId'];
        const asset = this.env.items('account.asset.asset').browse(assetId);
        if (fields.includes('label')) {
            res.update({'label': await asset.label})
        }
        if (fields.includes('methodNumber') && await asset.methodTime === 'number') {
            res.update({'methodNumber': await asset.methodNumber});
        }
        if (fields.includes('methodPeriod')) {
            res.update({'methodPeriod': await asset.methodPeriod});
        }
        if (fields.includes('methodEnd') && await asset.methodTime === 'end') {
            res.update({'methodEnd': await asset.methodEnd});
        }
        if (this.env.context['activeId']) {
            const activeAsset = this.env.items('account.asset.asset').browse(this.env.context['activeId']);
            res['assetMethodTime'] = await activeAsset.methodTime;
        }
        return res;
    }

    /**
     * Modifies the duration of asset for calculating depreciation
        and maintains the history of old values, in the chatter.
     * @returns 
     */
    async modify() {
        const assetId = this.env.context['activeId'] || false;
        const asset = this.env.items('account.asset.asset').browse(assetId);
        const fieldNames = ['methodNumber', 'methodPeriod', 'methodEnd'];
        const oldValues = await asset.getDict(fieldNames);
        const assetVals = Dict.from(oldValues);
        if (assetVals['methodNumber'] <= await asset.entryCount) {
            throw new UserError(await this._t('The number of depreciations must be greater than the number of posted or draft entries to allow for complete depreciation of the asset.'));
        }
        await asset.write(assetVals);
        await asset.computeDepreciationBoard();
        const trackedFields = await this.env.items('account.asset.asset').fieldsGet(fieldNames);
        const [changes, trackingValueIds] = await asset._mailTrack(trackedFields, oldValues);
        if (bool(changes)) {
            await asset.messagePost({subject: await this._t('Depreciation board modified'), body: await this['label'], trackingValueIds: trackingValueIds});
        }
        return {'type': 'ir.actions.actwindow.close'};
    }
}