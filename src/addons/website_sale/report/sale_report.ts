import { Fields } from "../../../core";
import { _super, MetaModel, Model } from "../../../core/models"

@MetaModel.define()
class SaleReport extends Model {
    static _module = module;
    static _parents = 'sale.report';

    static websiteId = Fields.Many2one('website', {readonly: true});

    _groupbySale(groupby='') {
        const res = _super(SaleReport, this)._groupbySale(groupby);
        return res + ',s."websiteId"';
    }

    _selectAdditionalFields(fields) {
        fields['websiteId'] = ', s."websiteId" as "websiteId"';
        return _super(SaleReport, this)._selectAdditionalFields(fields);
    }
}
