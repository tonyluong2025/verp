import { Fields } from "../../../core";
import { MetaModel, Model } from "../../../core/models"

@MetaModel.define()
class PaymentAcquirer extends Model {
    static _module = module;
    static _parents = 'payment.acquirer';

    static soReferenceType = Fields.Selection({string: 'Communication',
        selection: [
            ['soName', 'Based on Document Reference'],
            ['partner', 'Based on Customer ID']], default: 'soName',
        help: 'You can set here the communication type that will appear on sales orders.'+
             'The communication will be given to the customer when they choose the payment method.'});
}
