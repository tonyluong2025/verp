import { Fields } from "../../../core";
import { _super, MetaModel, Model } from "../../../core/models"

@MetaModel.define()
class PaymentAcquirer extends Model {
    static _module = module;
    static _parents = "payment.acquirer";

    static websiteId = Fields.Many2one(
        "website",
        {domain: "['|', ['companyId', '=', false], ['companyId', '=', companyId]]",
        ondelete: "RESTRICT"}
    );

    async getBaseUrl() {
        const req= this.env.req;
        // Give priority to url_root to handle multi-website cases
        if (req && req.httpRequest.urlRoot) {
            return req.httpRequest.urlRoot;
        }
        return _super(PaymentAcquirer, this).getBaseUrl();
    }
}
