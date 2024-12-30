import { Fields } from "../../../core";
import { MetaModel, Model } from "../../../core/models"

@MetaModel.define()
class PaymentIcon extends Model {
    static _module = module;
    static _name = 'payment.icon';
    static _description = 'Payment Icon';
    static _order = 'sequence, label';

    static label = Fields.Char({string: "Label"});
    static acquirerIds = Fields.Many2many({
        string: "Acquirers", comodelName: 'payment.acquirer',
        help: "The list of acquirers supporting this payment icon"});
    static image = Fields.Image({
        string: "Image", maxWidth: 64, maxHeight: 64,
        help: "This field holds the image used for this payment icon, limited to 64x64 px"});
    static imagePaymentForm = Fields.Image({
        string: "Image displayed on the payment form", related: 'image', store: true, maxWidth: 45,
        maxHeight: 30});
    static sequence = Fields.Integer('Sequence', {default: 1});
}
