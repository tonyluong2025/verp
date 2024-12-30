import { Fields } from "../../../core";
import { MetaModel, Model } from "../../../core/models"

@MetaModel.define()
class BarcodeRule extends Model {
    static _module = module;
    static _parents = 'barcode.rule';

    static type = Fields.Selection({selectionAdd: [
        ['weight', 'Weighted Product'],
        ['price', 'Priced Product'],
        ['discount', 'Discounted Product'],
        ['client', 'Client'],
        ['cashier', 'Cashier']
    ], ondelete: {
        'weight': 'SET DEFAULT',
        'price': 'SET DEFAULT',
        'discount': 'SET DEFAULT',
        'client': 'SET DEFAULT',
        'cashier': 'SET DEFAULT',
    }});
}