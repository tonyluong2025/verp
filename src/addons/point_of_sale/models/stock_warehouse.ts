import { Fields, api } from "../../../core";
import { MetaModel, Model, _super } from "../../../core/models"
import { update } from "../../../core/tools";

@MetaModel.define()
class Warehouse extends Model {
    static _module = module;
    static _parents = "stock.warehouse";

    static posTypeId = Fields.Many2one('stock.picking.type', {string: "Point of Sale Operation Type"});

    async _getSequenceValues() {
        const sequenceValues = await _super(Warehouse, this)._getSequenceValues();
        update(sequenceValues, {
            'posTypeId': {
                'label': await this['label'] + ' ' + await this._t('Picking POS'),
                'prefix': await this['code'] + '/POS/',
                'padding': 5,
                'companyId': (await this['companyId']).id,
            }
        })
        return sequenceValues;
    }

    async _getPickingTypeUpdateValues() {
        const pickingTypeUpdateValues = await _super(Warehouse, this)._getPickingTypeUpdateValues();
        update(pickingTypeUpdateValues, {
            'posTypeId': {'defaultLocationSrcId': (await this['lotStockId']).id}
        })
        return pickingTypeUpdateValues;
    }

    async _getPickingTypeCreateValues(maxSequence) {
        let pickingTypeCreateValues;
        [pickingTypeCreateValues, maxSequence] = await _super(Warehouse, this)._getPickingTypeCreateValues(maxSequence);
        update(pickingTypeCreateValues, {
            'posTypeId': {
                'label': await this._t('PoS Orders'),
                'code': 'outgoing',
                'defaultLocationSrcId': (await this['lotStockId']).id,
                'defaultLocationDestId': (await this.env.ref('stock.stockLocationCustomers')).id,
                'sequence': maxSequence + 1,
                'sequenceCode': 'POS',
                'companyId': (await this['companyId']).id,
                'showOperations': false,
            }
        })
        return [pickingTypeCreateValues, maxSequence + 2];
    }

    @api.model()
    async _createMissingPosPickingTypes() {
        const warehouses = await this.env.items('stock.warehouse').search([['posTypeId', '=', false]]);
        for (const warehouse of warehouses) {
            const newVals = await warehouse._createOrUpdateSequencesAndPickingTypes();
            await warehouse.write(newVals);
        }
    }
}