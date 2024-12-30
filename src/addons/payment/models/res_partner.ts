import { Fields, api } from "../../../core";
import { MetaModel, Model } from "../../../core/models";

@MetaModel.define()
class ResPartner extends Model {
    static _module = module;
    static _parents = 'res.partner';

    static paymentTokenIds = Fields.One2many({
        string: "Payment Tokens", comodelName: 'payment.token', relationField: 'partnerId'});
    static paymentTokenCount = Fields.Integer({
        string: "Payment Token Count", compute: '_computePaymentTokenCount'});

    @api.depends('paymentTokenIds')
    async _computePaymentTokenCount() {
        const paymentsData = await this.env.items('payment.token').readGroup(
            [['partnerId', 'in', this.ids]], ['partnerId'], ['partnerId']
        );
        const partnersData = Object.fromEntries(paymentsData.map(paymentData => [paymentData['partnerId'][0], paymentData['partnerIdCount']]));
        for (const partner of this) {
            await partner.set('paymentTokenCount', partnersData[partner.id] ?? 0);
        }
    }
}